import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { ACTIVE_ASSIGNMENT_CONDITION } from './active-assignment';
import { activeMenuCondition } from './active-menu';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';
import { PermissionsReader } from './permissions-reader.service';

const admin: AuthUser = {
  userId: 'user-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

function qbMock() {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
}

describe('PermissionsReader', () => {
  let reader: PermissionsReader;
  const scopeQb = qbMock();
  const permQb = qbMock();

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionsReader,
        {
          provide: getRepositoryToken(UserInstitutionRoleEntity),
          useValue: { createQueryBuilder: () => scopeQb },
        },
        {
          provide: getRepositoryToken(RoleMenuPermissionEntity),
          useValue: { createQueryBuilder: () => permQb },
        },
      ],
    }).compile();
    reader = moduleRef.get(PermissionsReader);
  });

  describe('effective', () => {
    it('suma los roles vigentes del usuario en la institución', async () => {
      permQb.getRawMany.mockResolvedValue([
        {
          menuOptionId: 'm1',
          canCreate: true,
          canUpdate: false,
          canDelete: false,
        },
      ]);
      const result = await reader.effective('user-1', 'inst-A');
      expect(result.get('m1')).toEqual({
        canCreate: true,
        canUpdate: false,
        canDelete: false,
      });
      expect(permQb.addSelect).toHaveBeenCalledWith(
        'bool_or(p.can_create)',
        'canCreate',
      );
      expect(permQb.andWhere).toHaveBeenCalledWith(ACTIVE_ASSIGNMENT_CONDITION);
      expect(permQb.groupBy).toHaveBeenCalledWith('p.menu_option_id');
    });
  });

  describe('assertWithinCeiling', () => {
    const requested = (flags: Partial<Record<string, boolean>> = {}) => [
      {
        menuOptionId: 'm1',
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        ...flags,
      },
    ];

    it('permite otorgar lo que tiene', async () => {
      permQb.getRawMany.mockResolvedValue([
        {
          menuOptionId: 'm1',
          canCreate: true,
          canUpdate: false,
          canDelete: false,
        },
      ]);
      await expect(
        reader.assertWithinCeiling(
          admin,
          'inst-A',
          requested({ canCreate: true }),
          'institution',
        ),
      ).resolves.toBeUndefined();
    });

    it('403 si otorga una acción que no tiene', async () => {
      permQb.getRawMany.mockResolvedValue([
        {
          menuOptionId: 'm1',
          canCreate: true,
          canUpdate: false,
          canDelete: false,
        },
      ]);
      await expect(
        reader.assertWithinCeiling(
          admin,
          'inst-A',
          requested({ canDelete: true }),
          'institution',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403 si otorga una opción que no puede ver', async () => {
      permQb.getRawMany.mockResolvedValue([]);
      await expect(
        reader.assertWithinCeiling(admin, 'inst-A', requested(), 'institution'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('el SUPER_ADMIN está exento', async () => {
      await reader.assertWithinCeiling(
        { ...admin, userType: 'SUPER_ADMIN' },
        'inst-A',
        requested({ canDelete: true }),
        'institution',
      );
      expect(permQb.getRawMany).not.toHaveBeenCalled();
    });

    it('para toda la institución solo cuenta asignaciones sin sede', async () => {
      permQb.getRawMany.mockResolvedValue([]);
      await expect(
        reader.assertWithinCeiling(admin, 'inst-A', requested(), 'institution'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(permQb.andWhere).toHaveBeenCalledWith('uir.campus_id IS NULL');
    });

    it('para una sede cuenta las de toda la institución y las de esa sede', async () => {
      permQb.getRawMany.mockResolvedValue([
        {
          menuOptionId: 'm1',
          canCreate: false,
          canUpdate: false,
          canDelete: false,
        },
      ]);
      await reader.assertWithinCeiling(admin, 'inst-A', requested(), 'c1');
      expect(permQb.andWhere).toHaveBeenCalledWith(
        '(uir.campus_id IS NULL OR uir.campus_id = :targetCampus)',
        { targetCampus: 'c1' },
      );
    });
  });

  describe('dentro de una transacción (M2 de la fase 11e)', () => {
    it('campusScope y effective usan el manager recibido, no otra conexión', async () => {
      const txScopeQb = qbMock();
      const txPermQb = qbMock();
      txScopeQb.getRawMany.mockResolvedValue([{ campusId: null }]);
      txPermQb.getRawMany.mockResolvedValue([]);
      const manager = {
        getRepository: jest.fn((entity: unknown) => ({
          createQueryBuilder: () =>
            entity === UserInstitutionRoleEntity ? txScopeQb : txPermQb,
        })),
      };
      await expect(
        reader.campusScope('user-1', 'inst-A', 'academic.courses', 'view', {
          manager: manager as never,
        }),
      ).resolves.toBeNull();
      await reader.effective(
        'user-1',
        'inst-A',
        'institution',
        manager as never,
      );
      expect(manager.getRepository).toHaveBeenCalledWith(
        UserInstitutionRoleEntity,
      );
      expect(manager.getRepository).toHaveBeenCalledWith(
        RoleMenuPermissionEntity,
      );
      expect(scopeQb.getRawMany).not.toHaveBeenCalled();
      expect(permQb.getRawMany).not.toHaveBeenCalled();
    });
  });

  describe('campusScope', () => {
    it('null si alguna asignación con el permiso es de toda la institución', async () => {
      scopeQb.getRawMany.mockResolvedValue([
        { campusId: 'c1' },
        { campusId: null },
      ]);
      await expect(
        reader.campusScope('user-1', 'inst-A', 'security.users', 'view'),
      ).resolves.toBeNull();
    });

    it('lista de sedes si todas están limitadas; exige la acción y el menú activo', async () => {
      scopeQb.getRawMany.mockResolvedValue([{ campusId: 'c1' }]);
      await expect(
        reader.campusScope('user-1', 'inst-A', 'security.users', 'create'),
      ).resolves.toEqual(['c1']);
      expect(scopeQb.innerJoin).toHaveBeenCalledWith(
        'p.menuOption',
        'm',
        `m.slug = :slug AND ${activeMenuCondition('m')}`,
        { slug: 'security.users' },
      );
      expect(scopeQb.andWhere).toHaveBeenCalledWith('p.can_create = true');
    });

    it('requireInstitutionWide responde 403 con alcance por sede', async () => {
      scopeQb.getRawMany.mockResolvedValue([{ campusId: 'c1' }]);
      await expect(
        reader.requireInstitutionWide(
          admin,
          'inst-A',
          'security.roles',
          'update',
          'limitado',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
