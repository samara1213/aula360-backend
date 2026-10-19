import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { MenuOptionEntity } from './entities/menu-option.entity';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { RoleEntity } from './entities/role.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';
import { PermissionsReader } from './permissions-reader.service';
import { RoleScope, RolesService } from './roles.service';

const admin: AuthUser = {
  userId: 'user-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};
const institution: RoleScope = {
  kind: 'institution',
  user: admin,
  institutionId: 'inst-A',
};
const global: RoleScope = { kind: 'global' };

function role(overrides: Partial<RoleEntity> = {}): RoleEntity {
  return {
    id: 'role-1',
    institutionId: 'inst-A',
    name: 'Coordinador',
    description: null,
    createdAt: new Date(),
    ...overrides,
  } as RoleEntity;
}

const M1 = '11111111-1111-4111-8111-111111111111';

type RoleWhere = { id: string; institutionId?: string | FindOperator<unknown> };

/** Como la base: el rol solo vuelve si cumple alguna condición del where. */
function matches(where: RoleWhere | RoleWhere[], row: RoleEntity | null) {
  if (!row) return false;
  return [where]
    .flat()
    .some(
      (c) =>
        c.id === row.id &&
        (c.institutionId instanceof FindOperator
          ? row.institutionId === null
          : c.institutionId === undefined ||
            c.institutionId === row.institutionId),
    );
}

describe('RolesService', () => {
  let service: RolesService;
  let current: RoleEntity | null;

  const permQb = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const roleRepo = {
    findOne: jest.fn(({ where }: { where: RoleWhere | RoleWhere[] }) =>
      Promise.resolve(matches(where, current) ? current : null),
    ),
    create: jest.fn((v: Partial<RoleEntity>) => ({ ...v, id: 'new' })),
    save: jest.fn((v: RoleEntity) => Promise.resolve(v)),
    delete: jest.fn(),
  };
  const permRepo = {
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
    insert: jest.fn(),
    createQueryBuilder: jest.fn(() => permQb),
  };
  const menuRepo = { countBy: jest.fn() };
  const assignmentRepo = { existsBy: jest.fn().mockResolvedValue(false) };
  const repos = new Map<unknown, unknown>([
    [RoleEntity, roleRepo],
    [RoleMenuPermissionEntity, permRepo],
    [MenuOptionEntity, menuRepo],
    [UserInstitutionRoleEntity, assignmentRepo],
  ]);
  const manager = { getRepository: jest.fn((e: unknown) => repos.get(e)) };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = {
    requireInstitutionWide: jest.fn(),
    assertWithinCeiling: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    current = role();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepo },
        {
          provide: getRepositoryToken(RoleMenuPermissionEntity),
          useValue: permRepo,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(RolesService);
  });

  describe('findOne', () => {
    it('404 si el rol es de otra institución', async () => {
      current = role({ institutionId: 'inst-B' });
      await expect(
        service.findOne(institution, 'role-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un rol global se ve desde la institución', async () => {
      current = role({ institutionId: null });
      const result = await service.findOne(institution, 'role-1');
      expect(result.isGlobal).toBe(true);
    });

    it('desde /global-roles un rol de institución no existe', async () => {
      await expect(service.findOne(global, 'role-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('crea en la institución del token y exige alcance de toda la institución', async () => {
      const result = await service.create(institution, { name: 'Nuevo' });
      expect(roleRepo.create).toHaveBeenCalledWith({
        institutionId: 'inst-A',
        name: 'Nuevo',
        description: null,
      });
      expect(permissions.requireInstitutionWide).toHaveBeenCalledWith(
        admin,
        'inst-A',
        'security.roles',
        'create',
        expect.any(String),
      );
      expect(result.permissions).toEqual([]);
    });

    it('el SUPER_ADMIN crea roles globales', async () => {
      await service.create(global, { name: 'Global' });
      expect(roleRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ institutionId: null }),
      );
    });
  });

  describe('escritura', () => {
    it('403 al modificar un rol global desde una institución', async () => {
      current = role({ institutionId: null });
      await expect(
        service.update(institution, 'role-1', { name: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(roleRepo.save).not.toHaveBeenCalled();
    });

    it('aplica el techo a los permisos actuales del rol antes de editarlo', async () => {
      const held = [{ menuOptionId: M1, canCreate: true }];
      permRepo.find.mockResolvedValueOnce(held);
      await service.update(institution, 'role-1', { name: 'X' });
      expect(permissions.assertWithinCeiling).toHaveBeenCalledWith(
        admin,
        'inst-A',
        held,
        'institution',
      );
    });
  });

  describe('replacePermissions', () => {
    it('reemplaza los permisos dentro del techo', async () => {
      menuRepo.countBy.mockResolvedValue(1);
      await service.replacePermissions(institution, 'role-1', {
        permissions: [{ menuOptionId: M1, canUpdate: true }],
      });
      const granted = [
        {
          menuOptionId: M1,
          canCreate: false,
          canUpdate: true,
          canDelete: false,
        },
      ];
      expect(permissions.assertWithinCeiling).toHaveBeenLastCalledWith(
        admin,
        'inst-A',
        granted,
        'institution',
      );
      expect(permRepo.delete).toHaveBeenCalledWith({ roleId: 'role-1' });
      expect(permRepo.insert).toHaveBeenCalledWith([
        { ...granted[0], roleId: 'role-1' },
      ]);
    });

    it('no guarda nada si excede el techo', async () => {
      menuRepo.countBy.mockResolvedValue(1);
      permissions.assertWithinCeiling
        .mockResolvedValueOnce(undefined) // permisos actuales del rol
        .mockRejectedValueOnce(new ForbiddenException());
      await expect(
        service.replacePermissions(institution, 'role-1', {
          permissions: [{ menuOptionId: M1, canDelete: true }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(permRepo.delete).not.toHaveBeenCalled();
    });

    it('400 si una opción se repite', async () => {
      await expect(
        service.replacePermissions(institution, 'role-1', {
          permissions: [{ menuOptionId: M1 }, { menuOptionId: M1 }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 si una opción de menú no existe', async () => {
      menuRepo.countBy.mockResolvedValue(0);
      await expect(
        service.replacePermissions(institution, 'role-1', {
          permissions: [{ menuOptionId: M1 }],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('en roles globales el SUPER_ADMIN no tiene techo', async () => {
      current = role({ institutionId: null });
      menuRepo.countBy.mockResolvedValue(1);
      await service.replacePermissions(global, 'role-1', {
        permissions: [{ menuOptionId: M1, canDelete: true }],
      });
      expect(permissions.assertWithinCeiling).not.toHaveBeenCalled();
    });
  });

  describe('replacePermissions sobre un rol propio (B4)', () => {
    const managed = {
      menuOptionId: M1,
      canCreate: true,
      canUpdate: true,
      canDelete: false,
    };

    beforeEach(() => {
      menuRepo.countBy.mockResolvedValue(1);
      // Quien actúa tiene este rol, que hoy le da gestión de roles.
      assignmentRepo.existsBy.mockResolvedValueOnce(true);
      permQb.getMany.mockResolvedValueOnce([managed]);
    });

    it('409 si se quita el permiso de gestión', async () => {
      await expect(
        service.replacePermissions(institution, 'role-1', { permissions: [] }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(permRepo.delete).not.toHaveBeenCalled();
    });

    it('409 si se reduce una acción de gestión', async () => {
      await expect(
        service.replacePermissions(institution, 'role-1', {
          permissions: [{ menuOptionId: M1, canCreate: true }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('permite cambiar lo demás si conserva la gestión', async () => {
      await service.replacePermissions(institution, 'role-1', {
        permissions: [{ menuOptionId: M1, canCreate: true, canUpdate: true }],
      });
      expect(assignmentRepo.existsBy).toHaveBeenCalledWith({
        userId: 'user-1',
        institutionId: 'inst-A',
        roleId: 'role-1',
      });
      expect(permQb.andWhere).toHaveBeenCalledWith('m.slug IN (:...slugs)', {
        slugs: ['security.roles', 'security.users'],
      });
      expect(permRepo.insert).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('409 si el rol tiene asignaciones', async () => {
      assignmentRepo.existsBy.mockResolvedValueOnce(true);
      await expect(
        service.remove(institution, 'role-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(roleRepo.delete).not.toHaveBeenCalled();
    });

    it('borra un rol sin asignaciones', async () => {
      await service.remove(institution, 'role-1');
      expect(roleRepo.delete).toHaveBeenCalledWith({ id: 'role-1' });
    });
  });
});
