import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { CampusEntity } from '../institutions/entities/campus.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { UserEntity } from '../users/entities/user.entity';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { RoleEntity } from './entities/role.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';
import { PermissionsReader } from './permissions-reader.service';
import {
  AssignmentScope,
  RoleAssignmentsService,
} from './role-assignments.service';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};
const institution: AssignmentScope = {
  kind: 'institution',
  user: admin,
  institutionId: 'inst-A',
};
const system: AssignmentScope = {
  kind: 'system',
  user: { ...admin, userType: 'SUPER_ADMIN', institutionId: null },
  institutionId: 'inst-A',
};
const dto = { userId: 'target-1', roleId: 'role-1' };

describe('RoleAssignmentsService', () => {
  let service: RoleAssignmentsService;

  const userRepo = { findOne: jest.fn(), findOneOrFail: jest.fn() };
  const roleRepo = { findOne: jest.fn() };
  const campusRepo = { findOne: jest.fn() };
  const institutionRepo = { existsBy: jest.fn() };
  const permRepo = { find: jest.fn().mockResolvedValue([]) };
  const assignmentRepo = {
    existsBy: jest.fn(),
    insert: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
  };
  const repos = new Map<unknown, unknown>([
    [UserEntity, userRepo],
    [RoleEntity, roleRepo],
    [CampusEntity, campusRepo],
    [InstitutionEntity, institutionRepo],
    [RoleMenuPermissionEntity, permRepo],
    [UserInstitutionRoleEntity, assignmentRepo],
  ]);
  const manager = { getRepository: jest.fn((e: unknown) => repos.get(e)) };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const created = {
    id: 'uir-1',
    institutionId: 'inst-A',
    createdAt: new Date(),
    user: { id: 'target-1', userType: 'TEACHER' },
    role: { id: 'role-1', name: 'R', institutionId: null },
    campus: null,
  };
  const listQb = {
    innerJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getOneOrFail: jest.fn().mockResolvedValue(created),
  };
  const permissions = {
    campusScope: jest.fn(),
    assertWithinCeiling: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    userRepo.findOne.mockResolvedValue({ id: 'target-1', userType: 'TEACHER' });
    userRepo.findOneOrFail.mockResolvedValue({
      id: 'target-1',
      userType: 'TEACHER',
    });
    assignmentRepo.existsBy.mockResolvedValue(true);
    roleRepo.findOne.mockResolvedValue({ id: 'role-1', institutionId: null });
    institutionRepo.existsBy.mockResolvedValue(true);
    assignmentRepo.insert.mockResolvedValue({ identifiers: [{ id: 'uir-1' }] });
    permissions.campusScope.mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoleAssignmentsService,
        {
          provide: getRepositoryToken(UserInstitutionRoleEntity),
          useValue: { ...assignmentRepo, createQueryBuilder: () => listQb },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(RoleAssignmentsService);
  });

  describe('create', () => {
    it('asigna en la institución del token aplicando el techo del rol', async () => {
      const result = await service.create(institution, dto);
      expect(assignmentRepo.insert).toHaveBeenCalledWith({
        userId: 'target-1',
        institutionId: 'inst-A',
        roleId: 'role-1',
        campusId: null,
      });
      expect(permissions.assertWithinCeiling).toHaveBeenCalled();
      expect(result.id).toBe('uir-1');
    });

    it('404 si el usuario no pertenece ya a la institución', async () => {
      assignmentRepo.existsBy.mockResolvedValue(false);
      await expect(service.create(institution, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(assignmentRepo.insert).not.toHaveBeenCalled();
    });

    it('insertAssignment con newUser no exige pertenencia previa, pero sí el techo', async () => {
      assignmentRepo.existsBy.mockResolvedValue(false);
      const id = await service.insertAssignment(
        manager as never,
        institution,
        dto,
        { newUser: true },
      );
      expect(id).toBe('uir-1');
      expect(assignmentRepo.existsBy).not.toHaveBeenCalled();
      expect(userRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(permissions.assertWithinCeiling).toHaveBeenCalled();
    });

    it('el SUPER_ADMIN vincula a cualquier usuario activo, sin techo', async () => {
      assignmentRepo.existsBy.mockResolvedValue(false);
      await service.create(system, dto);
      expect(assignmentRepo.insert).toHaveBeenCalled();
      expect(permissions.assertWithinCeiling).not.toHaveBeenCalled();
    });

    it('404 si la institución no existe (SUPER_ADMIN)', async () => {
      institutionRepo.existsBy.mockResolvedValue(false);
      await expect(service.create(system, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('403 si el destino es SUPER_ADMIN y quien actúa no', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'target-1',
        userType: 'SUPER_ADMIN',
      });
      await expect(service.create(institution, dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('404 si el rol es de otra institución', async () => {
      roleRepo.findOne.mockResolvedValue({
        id: 'role-1',
        institutionId: 'inst-B',
      });
      await expect(service.create(institution, dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404 si la sede es de otra institución y 400 si está inactiva', async () => {
      campusRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(institution, { ...dto, campusId: 'c-B' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(campusRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'c-B', institutionId: 'inst-A' },
      });
      campusRepo.findOne.mockResolvedValueOnce({ id: 'c1', isActive: false });
      await expect(
        service.create(institution, { ...dto, campusId: 'c1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('403 si su alcance es por sede y asigna en toda la institución', async () => {
      permissions.campusScope.mockResolvedValue(['c1']);
      await expect(service.create(institution, dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('403 al asignarse roles a sí mismo', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'admin-1',
        userType: 'INSTITUTION_ADMIN',
      });
      await expect(
        service.create(institution, { ...dto, userId: 'admin-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(assignmentRepo.insert).not.toHaveBeenCalled();
    });

    it('con alcance por sede: sede ajena = 404 sin consultarla', async () => {
      permissions.campusScope.mockResolvedValue(['c1']);
      await expect(
        service.create(institution, { ...dto, campusId: 'c2' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(campusRepo.findOne).not.toHaveBeenCalled();
    });

    it('con alcance por sede: el usuario debe pertenecer a una de sus sedes y el techo es el de esa sede', async () => {
      permissions.campusScope.mockResolvedValue(['c1']);
      campusRepo.findOne.mockResolvedValueOnce({ id: 'c1', isActive: true });
      await service.create(institution, { ...dto, campusId: 'c1' });
      expect(assignmentRepo.existsBy).toHaveBeenCalledWith({
        userId: 'target-1',
        institutionId: 'inst-A',
        campusId: In(['c1']),
      });
      expect(permissions.assertWithinCeiling).toHaveBeenCalledWith(
        admin,
        'inst-A',
        [],
        'c1',
      );
    });

    it('sin sede el techo es el de toda la institución', async () => {
      await service.create(institution, dto);
      expect(permissions.assertWithinCeiling).toHaveBeenCalledWith(
        admin,
        'inst-A',
        [],
        'institution',
      );
    });

    it('409 si la asignación ya existe', async () => {
      assignmentRepo.insert.mockRejectedValueOnce(
        Object.assign(new QueryFailedError('INSERT', [], new Error('dup')), {
          code: '23505',
        }),
      );
      await expect(service.create(institution, dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('remove', () => {
    const assignment = {
      id: 'uir-1',
      userId: 'target-1',
      roleId: 'role-1',
      campusId: null,
      user: { userType: 'TEACHER' },
    };

    it('busca por id e institución (otra institución = 404)', async () => {
      assignmentRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(institution, 'uir-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(assignmentRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'uir-B', institutionId: 'inst-A' },
        }),
      );
    });

    it('403 al quitarse sus propias asignaciones', async () => {
      assignmentRepo.findOne.mockResolvedValue({
        ...assignment,
        userId: 'admin-1',
      });
      await expect(service.remove(institution, 'uir-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(assignmentRepo.delete).not.toHaveBeenCalled();
    });

    it('404 si la asignación está fuera de su alcance por sede', async () => {
      assignmentRepo.findOne.mockResolvedValue(assignment);
      permissions.campusScope.mockResolvedValue(['c1']);
      await expect(service.remove(institution, 'uir-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('quita la asignación aplicando el techo del rol, con el usuario bloqueado', async () => {
      assignmentRepo.findOne.mockResolvedValue(assignment);
      await service.remove(institution, 'uir-1');
      expect(userRepo.findOneOrFail).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(permissions.assertWithinCeiling).toHaveBeenCalled();
      expect(assignmentRepo.delete).toHaveBeenCalledWith({ id: 'uir-1' });
    });
  });

  describe('findAll', () => {
    it('filtra por la institución y por su alcance de sedes', async () => {
      permissions.campusScope.mockResolvedValue(['c1']);
      await service.findAll(institution, { page: 1, limit: 20 });
      expect(listQb.where).toHaveBeenCalledWith(
        'uir.institution_id = :institutionId',
        { institutionId: 'inst-A' },
      );
      expect(listQb.andWhere).toHaveBeenCalledWith(
        'uir.campus_id IN (:...campusScope)',
        { campusScope: ['c1'] },
      );
    });
  });
});
