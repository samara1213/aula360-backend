import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PasswordResetTokenEntity } from '../auth/entities/password-reset-token.entity';
import { RefreshTokenEntity } from '../auth/entities/refresh-token.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { MailService } from '../mail/mail.service';
import { RoleMenuPermissionEntity } from '../security/entities/role-menu-permission.entity';
import { RoleEntity } from '../security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { PermissionsReader } from '../security/permissions-reader.service';
import { RoleAssignmentsService } from '../security/role-assignments.service';
import { StudentEntity } from './entities/student.entity';
import { TeacherEntity } from './entities/teacher.entity';
import { UserEntity } from './entities/user.entity';
import { ManagedUsersService, UsersScope } from './managed-users.service';
import { UsersService } from './users.service';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hash') }));

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};
const institution: UsersScope = {
  kind: 'institution',
  user: admin,
  institutionId: 'inst-A',
};
const system: UsersScope = {
  kind: 'system',
  user: { ...admin, userType: 'SUPER_ADMIN', institutionId: null },
  institutionId: 'inst-A',
};

const target = (overrides: Partial<UserEntity> = {}): UserEntity =>
  ({
    id: 'user-1',
    userType: 'TEACHER',
    documentType: 'CC',
    documentNumber: '123',
    firstName: 'Ana',
    lastName: 'Pérez',
    email: 'ana@colegio.co',
    phone: null,
    avatarPath: null,
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as UserEntity;

describe('ManagedUsersService', () => {
  let service: ManagedUsersService;

  /** Query builder de membersQuery (usuarios visibles). */
  const membersQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  /** Query builder de assertExclusive (asignaciones fuera del alcance). */
  const outsideQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getExists: jest.fn(),
  };
  const userRepo = {
    createQueryBuilder: jest.fn(() => membersQb),
    insert: jest.fn(),
    update: jest.fn(),
    findOneByOrFail: jest.fn(),
  };
  const assignmentRepo = {
    find: jest.fn(),
    createQueryBuilder: jest.fn(() => outsideQb),
  };
  const permRepo = { find: jest.fn().mockResolvedValue([]) };
  const refreshRepo = { delete: jest.fn() };
  const resetRepo = { update: jest.fn() };
  const institutionRepo = { existsBy: jest.fn() };
  /** Perfiles de docente o estudiante en otra institución (exclusividad, B5). */
  const profileQb = {
    where: jest.fn().mockReturnThis(),
    getExists: jest.fn(),
  };
  const profileRepo = { createQueryBuilder: jest.fn(() => profileQb) };
  const roleRepo = { find: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [UserEntity, userRepo],
    [UserInstitutionRoleEntity, assignmentRepo],
    [RoleMenuPermissionEntity, permRepo],
    [RefreshTokenEntity, refreshRepo],
    [PasswordResetTokenEntity, resetRepo],
    [InstitutionEntity, institutionRepo],
    [RoleEntity, roleRepo],
    [TeacherEntity, profileRepo],
    [StudentEntity, profileRepo],
  ]);
  const manager = { getRepository: jest.fn((e: unknown) => repos.get(e)) };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = {
    campusScope: jest.fn(),
    assertWithinCeiling: jest.fn(),
  };
  const assignments = {
    validateAssignment: jest.fn(),
    insertAssignment: jest.fn(),
  };
  const mail = { send: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.campusScope.mockResolvedValue(null);
    permissions.assertWithinCeiling.mockResolvedValue(undefined);
    membersQb.getOne.mockResolvedValue(target());
    outsideQb.getExists.mockResolvedValue(false);
    profileQb.getExists.mockResolvedValue(false);
    assignmentRepo.find.mockResolvedValue([
      { roleId: 'role-1', campusId: null },
    ]);
    institutionRepo.existsBy.mockResolvedValue(true);
    userRepo.insert.mockResolvedValue({ identifiers: [{ id: 'user-1' }] });
    userRepo.findOneByOrFail.mockResolvedValue(target());
    assignments.validateAssignment.mockResolvedValue({
      role: { id: 'role-1' },
      campusScope: null,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        ManagedUsersService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
        { provide: RoleAssignmentsService, useValue: assignments },
        { provide: UsersService, useValue: { getAvatar: jest.fn() } },
        { provide: MailService, useValue: mail },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => 'http://localhost:5173' },
        },
      ],
    }).compile();
    service = moduleRef.get(ManagedUsersService);
  });

  describe('create', () => {
    const dto = {
      userType: 'TEACHER' as const,
      documentType: 'CC',
      documentNumber: '123',
      firstName: 'Ana',
      lastName: 'Pérez',
      email: 'ana@colegio.co',
      roleId: 'role-1',
    };

    it('crea el usuario con contraseña temporal y su primera asignación en la misma transacción', async () => {
      const result = await service.create(institution, dto);

      expect(userRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          passwordHash: 'hash',
          mustChangePassword: true,
          isActive: true,
        }),
      );
      expect(assignments.insertAssignment).toHaveBeenCalledWith(
        manager,
        institution,
        { userId: 'user-1', roleId: 'role-1', campusId: null },
        { newUser: true },
      );
      expect(result.temporaryPassword).toHaveLength(14);
      expect(result).not.toHaveProperty('passwordHash');
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ana@colegio.co' }),
      );
    });

    it('responde 409 genérico si el documento o el email ya existen', async () => {
      userRepo.insert.mockRejectedValue(
        Object.assign(new QueryFailedError('INSERT', [], new Error('dup')), {
          code: '23505',
        }),
      );
      await expect(service.create(institution, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(assignments.insertAssignment).not.toHaveBeenCalled();
    });

    it('valida rol, sede y techo ANTES de insertar (sin oráculo de 409)', async () => {
      assignments.validateAssignment.mockRejectedValue(
        new NotFoundException('Rol no encontrado'),
      );
      await expect(service.create(institution, dto)).rejects.toThrow(
        NotFoundException,
      );
      expect(userRepo.insert).not.toHaveBeenCalled();
    });

    it('con alcance por sede no puede crear INSTITUTION_ADMIN', async () => {
      assignments.validateAssignment.mockResolvedValue({
        role: { id: 'role-1' },
        campusScope: ['campus-1'],
      });
      await expect(
        service.create(institution, {
          ...dto,
          userType: 'INSTITUTION_ADMIN',
          campusId: 'campus-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(userRepo.insert).not.toHaveBeenCalled();
    });

    it('sin email no envía correo', async () => {
      userRepo.findOneByOrFail.mockResolvedValue(target({ email: null }));
      await service.create(institution, { ...dto, email: null });
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('reglas de gestión', () => {
    it('404 si el usuario no pertenece a la institución (o a sus sedes)', async () => {
      membersQb.getOne.mockResolvedValue(null);
      await expect(
        service.setStatus(institution, 'user-x', { isActive: false }),
      ).rejects.toThrow(NotFoundException);
    });

    it('nadie se gestiona a sí mismo', async () => {
      membersQb.getOne.mockResolvedValue(target({ id: 'admin-1' }));
      await expect(
        service.setStatus(institution, 'admin-1', { isActive: false }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('un SUPER_ADMIN no es visible desde una institución (404)', async () => {
      await service.findOne(institution, 'user-1');
      expect(membersQb.andWhere).toHaveBeenCalledWith(
        `u.user_type <> 'SUPER_ADMIN'`,
      );
      // Defensa adicional si llegara a cargarse.
      membersQb.getOne.mockResolvedValue(target({ userType: 'SUPER_ADMIN' }));
      await expect(
        service.update(institution, 'user-1', { firstName: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('el techo responde 403 con un mensaje genérico', async () => {
      assignmentRepo.find.mockResolvedValue([
        { roleId: 'role-1', campusId: 'campus-9' },
      ]);
      permissions.assertWithinCeiling.mockRejectedValue(
        new ForbiddenException('detalle interno'),
      );
      await expect(
        service.update(institution, 'user-1', { firstName: 'X' }),
      ).rejects.toThrow('No tiene permiso para gestionar a este usuario');
    });

    it('evalúa el techo con cada rol del usuario en su alcance', async () => {
      assignmentRepo.find.mockResolvedValue([
        { roleId: 'role-1', campusId: null },
        { roleId: 'role-2', campusId: 'campus-1' },
      ]);
      await service.update(institution, 'user-1', { firstName: 'X' });
      // Sus roles quedan bloqueados (FOR SHARE) mientras se evalúa el techo.
      expect(roleRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
      );
      expect(permissions.assertWithinCeiling).toHaveBeenCalledWith(
        admin,
        'inst-A',
        [],
        'institution',
      );
      expect(permissions.assertWithinCeiling).toHaveBeenCalledWith(
        admin,
        'inst-A',
        [],
        'campus-1',
      );
    });

    it('cambiar nombres no exige exclusividad', async () => {
      outsideQb.getExists.mockResolvedValue(true);
      await service.update(institution, 'user-1', { firstName: 'X' });
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 'user-1' },
        { firstName: 'X' },
      );
    });

    it('cambiar el documento de un usuario de varias instituciones: 403 genérico', async () => {
      outsideQb.getExists.mockResolvedValue(true);
      await expect(
        service.update(institution, 'user-1', { documentNumber: '999' }),
      ).rejects.toThrow('Este cambio solo lo puede hacer un SUPER_ADMIN');
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('el email solo lo cambia un SUPER_ADMIN, aunque el usuario sea exclusivo', async () => {
      await expect(
        service.update(institution, 'user-1', { email: 'otro@colegio.co' }),
      ).rejects.toThrow(ForbiddenException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('con alcance por sede, la exclusividad también exige sus sedes', async () => {
      permissions.campusScope.mockResolvedValue(['campus-1']);
      await service.setStatus(institution, 'user-1', { isActive: false });
      expect(outsideQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('uir.campus_id NOT IN (:...campusScope)'),
        { institutionId: 'inst-A', campusScope: ['campus-1'] },
      );
    });

    it('un perfil de docente o estudiante en otra institución también rompe la exclusividad', async () => {
      profileQb.getExists.mockResolvedValue(true);
      await expect(
        service.setStatus(institution, 'user-1', { isActive: false }),
      ).rejects.toThrow('Este cambio solo lo puede hacer un SUPER_ADMIN');
      expect(profileQb.where).toHaveBeenCalledWith(
        'p.user_id = :userId AND p.institution_id <> :institutionId',
        { userId: 'user-1', institutionId: 'inst-A' },
      );
    });

    it('el alcance por sede se calcula con el permiso del alcance (perfiles)', async () => {
      await service.findOne(
        { ...institution, permission: 'people.students' },
        'user-1',
      );
      expect(permissions.campusScope).toHaveBeenCalledWith(
        'admin-1',
        'inst-A',
        'people.students',
        'view',
      );
    });

    it('sin asignaciones en la institución: 404 (nunca se gestiona sin techo)', async () => {
      assignmentRepo.find.mockResolvedValue([]);
      await expect(
        service.setStatus(institution, 'user-1', { isActive: false }),
      ).rejects.toThrow(NotFoundException);
      expect(permissions.assertWithinCeiling).not.toHaveBeenCalled();
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('el SUPER_ADMIN no está sujeto a exclusividad ni al techo', async () => {
      outsideQb.getExists.mockResolvedValue(true);
      await service.update(system, 'user-1', { email: 'otro@colegio.co' });
      expect(outsideQb.getExists).not.toHaveBeenCalled();
      expect(permissions.assertWithinCeiling).not.toHaveBeenCalled();
    });

    it('cambiar el email invalida los enlaces de recuperación pendientes', async () => {
      await service.update(system, 'user-1', { email: 'otro@colegio.co' });
      expect(resetRepo.update).toHaveBeenCalled();
    });

    it('rechaza null en columnas obligatorias', async () => {
      await expect(
        service.update(institution, 'user-1', { firstName: null as never }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('setStatus', () => {
    it('desactivar cierra todas sus sesiones', async () => {
      await service.setStatus(institution, 'user-1', { isActive: false });
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 'user-1' },
        { isActive: false },
      );
      expect(refreshRepo.delete).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('sin cambio de estado no escribe', async () => {
      await service.setStatus(institution, 'user-1', { isActive: true });
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('resetTemporaryPassword', () => {
    it('cambia la contraseña, obliga a cambiarla y cierra sesiones', async () => {
      const { temporaryPassword } = await service.resetTemporaryPassword(
        institution,
        'user-1',
      );
      expect(temporaryPassword).toHaveLength(14);
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 'user-1' },
        { passwordHash: 'hash', mustChangePassword: true },
      );
      expect(refreshRepo.delete).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(resetRepo.update).toHaveBeenCalled();
    });

    it('un usuario inactivo: 400', async () => {
      membersQb.getOne.mockResolvedValue(target({ isActive: false }));
      await expect(
        service.resetTemporaryPassword(institution, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('system: 404 si la institución no existe', async () => {
    institutionRepo.existsBy.mockResolvedValue(false);
    await expect(service.findOne(system, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
