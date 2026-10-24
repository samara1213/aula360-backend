import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { RoleEntity } from '../security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { PermissionsReader } from '../security/permissions-reader.service';
import { RoleAssignmentsService } from '../security/role-assignments.service';
import { StudentEntity } from './entities/student.entity';
import { UserEntity } from './entities/user.entity';
import { ManagedUsersService, UsersScope } from './managed-users.service';
import { StudentsService } from './students.service';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};
const scope: UsersScope = {
  kind: 'institution',
  user: admin,
  institutionId: 'inst-A',
  permission: 'people.students',
};

const student = (overrides: Partial<StudentEntity> = {}): StudentEntity =>
  ({
    id: 'stu-1',
    userId: 'user-1',
    institutionId: 'inst-A',
    campusId: 'campus-1',
    studentCode: 'C-1',
    guardianName: 'Marta',
    guardianPhone: null,
    guardianEmail: null,
    createdAt: new Date(),
    campus: { id: 'campus-1', name: 'Sede 1', isActive: true },
    user: {
      id: 'user-1',
      documentType: 'TI',
      documentNumber: '1',
      firstName: 'Ana',
      lastName: 'Pérez',
      email: null,
      phone: null,
      isActive: true,
      mustChangePassword: false,
      avatarPath: null,
    },
    ...overrides,
  }) as StudentEntity;

describe('StudentsService', () => {
  let service: StudentsService;

  const studentQb = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
    getOneOrFail: jest.fn(),
    getManyAndCount: jest.fn(),
  };
  const studentRepo = {
    createQueryBuilder: jest.fn(() => studentQb),
    insert: jest.fn(),
    update: jest.fn(),
  };
  const uirQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const uirRepo = { createQueryBuilder: jest.fn(() => uirQb) };
  const roleRepo = { findOne: jest.fn() };
  const userRepo = { findOneOrFail: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [StudentEntity, studentRepo],
    [UserInstitutionRoleEntity, uirRepo],
    [RoleEntity, roleRepo],
    [UserEntity, userRepo],
  ]);
  const manager = {
    getRepository: jest.fn((e: unknown) => repos.get(e)),
    query: jest.fn(),
  };
  const teacherRepo = { findOneBy: jest.fn() };
  const dataSource = {
    manager,
    query: jest.fn(),
    getRepository: jest.fn(() => teacherRepo),
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { campusScope: jest.fn() };
  const users = {
    newTemporaryPassword: jest
      .fn()
      .mockResolvedValue({ password: 'Temp*Clave2026', hash: 'hash' }),
    insertUserWithAssignment: jest.fn(),
    afterCreate: jest.fn(),
    applyPersonalChanges: jest.fn(),
    sharedElsewhere: jest.fn().mockResolvedValue(false),
    notifyEmailChange: jest.fn(),
  };
  const assignments = { validateAssignment: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.campusScope.mockResolvedValue(null);
    studentQb.getOne.mockResolvedValue(student());
    studentQb.getOneOrFail.mockResolvedValue({ bloodType: 'O+' });
    roleRepo.findOne.mockResolvedValue({ id: 'role-student' });
    uirQb.execute.mockResolvedValue({ affected: 1 });
    // Sin matrícula vigente; quien consulta no es docente.
    manager.query.mockResolvedValue([{ enrolled: false }]);
    dataSource.query.mockResolvedValue([{ allowed: false }]);
    teacherRepo.findOneBy.mockResolvedValue({ id: 'teacher-1' });
    studentQb.getManyAndCount.mockResolvedValue([[student()], 1]);
    userRepo.findOneOrFail.mockResolvedValue({ id: 'user-1' });
    users.insertUserWithAssignment.mockResolvedValue('user-1');
    studentRepo.insert.mockResolvedValue({ identifiers: [{ id: 'stu-1' }] });
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudentsService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
        { provide: ManagedUsersService, useValue: users },
        { provide: RoleAssignmentsService, useValue: assignments },
      ],
    }).compile();
    service = moduleRef.get(StudentsService);
  });

  /** Solo puede ver (p. ej. un docente): sin permiso de editar en ninguna sede. */
  const viewOnly = () =>
    permissions.campusScope.mockImplementation(
      (_u: string, _i: string, _s: string, action: string) =>
        Promise.resolve(action === 'update' ? [] : null),
    );

  describe('dato mínimo para quien solo puede ver (Ley 1581)', () => {
    it('listado: sin documento ni contacto', async () => {
      viewOnly();
      const res = await service.findAll(scope, { page: 1, limit: 20 });
      expect(Object.keys(res.data[0].user).sort()).toEqual(
        ['firstName', 'hasAvatar', 'id', 'isActive', 'lastName'].sort(),
      );
    });

    it('listado: con documento y contacto para quien puede editar', async () => {
      const res = await service.findAll(scope, { page: 1, limit: 20 });
      expect(res.data[0].user).toHaveProperty('documentNumber', '1');
    });

    it('detalle: sin documento, contacto ni acudiente', async () => {
      viewOnly();
      const res = await service.findOne(scope, 'stu-1');
      expect(res).not.toHaveProperty('guardianName');
      expect(res).not.toHaveProperty('guardianPhone');
      expect(res.user).not.toHaveProperty('documentNumber');
      expect(res.user).not.toHaveProperty('email');
    });

    it('búsqueda: por documento solo entre los que puede editar', async () => {
      viewOnly();
      await service.findAll(scope, { page: 1, limit: 20, search: '1234' });
      const call = studentQb.andWhere.mock.calls.find(
        ([sql]: [string]) =>
          typeof sql === 'string' && sql.includes('first_name ILIKE'),
      ) as [string];
      expect(call[0]).not.toContain('u.document_number');
    });

    /** Rol TEACHER vigente; sus otros roles le dan `other` (null = toda la institución). */
    const teacherWith = (other: string[] | null) => {
      dataSource.query.mockResolvedValue([{ allowed: true }]);
      permissions.campusScope.mockImplementation(
        (
          _u: string,
          _i: string,
          _s: string,
          action: string,
          opts?: { excludeGlobalRole?: string },
        ) =>
          Promise.resolve(
            opts?.excludeGlobalRole ? other : action === 'update' ? [] : null,
          ),
      );
    };

    it('docente: solo matrículas vigentes de años activos en cursos con su carga', async () => {
      teacherWith([]);
      await service.findAll(scope, { page: 1, limit: 20 });
      const [sql, params] = studentQb.andWhere.mock.calls.find(
        ([q]: [unknown]) => typeof q === 'string' && q.includes('ownTeacherId'),
      ) as [string, Record<string, unknown>];
      expect(sql).toContain("te.status IN ('ENROLLED', 'SUSPENDED')");
      expect(sql).toContain('ty.is_active');
      expect(sql).toContain('tsc.is_active');
      expect(params).toEqual({ otherView: [], ownTeacherId: 'teacher-1' });
      expect(permissions.campusScope).toHaveBeenCalledWith(
        'admin-1',
        'inst-A',
        'people.students',
        'view',
        { excludeGlobalRole: 'TEACHER' },
      );
    });

    it('docente con otro rol limitado a una sede: esa sede o sus cursos', async () => {
      teacherWith(['campus-9']);
      await service.findAll(scope, { page: 1, limit: 20 });
      expect(studentQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('s.campus_id IN (:...otherView) OR EXISTS'),
        { otherView: ['campus-9'], ownTeacherId: 'teacher-1' },
      );
    });

    it('docente cuyo otro rol cubre toda la institución: sin restricción', async () => {
      teacherWith(null);
      await service.findAll(scope, { page: 1, limit: 20 });
      expect(teacherRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('rol TEACHER sin perfil de docente: no ve a ninguno', async () => {
      teacherWith([]);
      teacherRepo.findOneBy.mockResolvedValue(null);
      await service.findOne(scope, 'stu-1');
      expect(studentQb.andWhere).toHaveBeenCalledWith('(false OR false)', {
        otherView: [],
        ownTeacherId: null,
      });
    });

    it('sin el rol TEACHER: sin restricción', async () => {
      viewOnly();
      await service.findAll(scope, { page: 1, limit: 20 });
      expect(teacherRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('filtro por curso: solo cursos de la institución, de sus sedes y suyos', async () => {
      teacherWith([]);
      await service.findAll(scope, {
        page: 1,
        limit: 20,
        courseId: 'course-1',
      });
      const [sql, params] = studentQb.andWhere.mock.calls.find(
        ([q]: [unknown]) => typeof q === 'string' && q.includes('ce.course_id'),
      ) as [string, Record<string, unknown>];
      expect(sql).toContain('cg.institution_id = :institutionId');
      expect(sql).toContain('ct.teacher_id = :ownTeacherId');
      expect(params).toMatchObject({
        courseId: 'course-1',
        institutionId: 'inst-A',
      });
    });

    it('solo estudiantes que conservan asignaciones en la institución', async () => {
      await service.findOne(scope, 'stu-1');
      expect(studentQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS (SELECT 1 FROM user_institution_roles'),
      );
    });
  });

  describe('findOne: tipo de sangre (dato sensible)', () => {
    it('lo incluye para quien puede editar en toda la institución', async () => {
      const res = await service.findOne(scope, 'stu-1');
      expect(res.bloodType).toBe('O+');
    });

    it('lo incluye si puede editar en la sede del estudiante', async () => {
      permissions.campusScope.mockImplementation(
        (_u: string, _i: string, _s: string, action: string) =>
          Promise.resolve(action === 'update' ? ['campus-1'] : null),
      );
      const res = await service.findOne(scope, 'stu-1');
      expect(res.bloodType).toBe('O+');
    });

    it('no lo incluye (ni la clave) para quien solo puede ver', async () => {
      viewOnly();
      const res = await service.findOne(scope, 'stu-1');
      expect(res).not.toHaveProperty('bloodType');
      expect(studentQb.addSelect).not.toHaveBeenCalled();
    });

    it('404 si no es visible', async () => {
      studentQb.getOne.mockResolvedValue(null);
      await expect(service.findOne(scope, 'stu-x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    const dto = {
      documentType: 'TI',
      documentNumber: '1',
      firstName: 'Ana',
      lastName: 'Pérez',
      campusId: 'campus-1',
      studentCode: 'C-1',
    };

    it('crea usuario STUDENT con el rol STUDENT en su sede, y el perfil', async () => {
      const res = await service.create(scope, dto);
      expect(users.insertUserWithAssignment).toHaveBeenCalledWith(
        manager,
        scope,
        expect.objectContaining({
          userType: 'STUDENT',
          roleId: 'role-student',
          campusId: 'campus-1',
        }),
        'hash',
      );
      expect(studentRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          institutionId: 'inst-A',
          campusId: 'campus-1',
          studentCode: 'C-1',
        }),
      );
      expect(res.temporaryPassword).toBe('Temp*Clave2026');
    });

    it('quien puede crear pero no ver recibe igual la contraseña temporal', async () => {
      permissions.campusScope.mockImplementation(
        (_u: string, _i: string, _s: string, action: string) =>
          Promise.resolve(action === 'view' ? [] : null),
      );
      const res = await service.create(scope, dto);
      expect(res.temporaryPassword).toBe('Temp*Clave2026');
      expect(res.bloodType).toBe('O+');
    });

    it('código repetido en la institución: 409', async () => {
      studentRepo.insert.mockRejectedValue(
        Object.assign(new QueryFailedError('INSERT', [], new Error('dup')), {
          driverError: {
            constraint: 'students_institution_id_student_code_key',
          },
        }),
      );
      await expect(service.create(scope, dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('aplica siempre las reglas de gestión del usuario (bloqueado)', async () => {
      await service.update(scope, 'stu-1', { guardianName: 'Luis' });
      expect(userRepo.findOneOrFail).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      // Relee el perfil con FOR UPDATE ya con el usuario bloqueado.
      expect(studentQb.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
        undefined,
        ['s'],
      );
      expect(users.applyPersonalChanges).toHaveBeenCalled();
      expect(studentRepo.update).toHaveBeenCalledWith(
        { id: 'stu-1' },
        { guardianName: 'Luis' },
      );
    });

    it('cambiar de sede valida la sede nueva y mueve su rol STUDENT', async () => {
      await service.update(scope, 'stu-1', { campusId: 'campus-2' });
      expect(assignments.validateAssignment).toHaveBeenCalledWith(
        manager,
        scope,
        'role-student',
        'campus-2',
      );
      expect(uirQb.set).toHaveBeenCalledWith({ campusId: 'campus-2' });
      expect(uirQb.where).toHaveBeenCalledWith(
        expect.stringContaining('campus_id IS NOT DISTINCT FROM :previous'),
        expect.objectContaining({
          previous: 'campus-1',
          roleId: 'role-student',
        }),
      );
      expect(studentRepo.update).toHaveBeenCalledWith(
        { id: 'stu-1' },
        { campusId: 'campus-2' },
      );
    });

    it('si su rol STUDENT no está en la sede del perfil: 409 y no cambia la sede', async () => {
      uirQb.execute.mockResolvedValue({ affected: 0 });
      await expect(
        service.update(scope, 'stu-1', { campusId: 'campus-2' }),
      ).rejects.toThrow(ConflictException);
      expect(studentRepo.update).not.toHaveBeenCalled();
    });

    it('con matrícula vigente en un año activo no cambia de sede (409)', async () => {
      manager.query.mockResolvedValue([{ enrolled: true }]);
      await expect(
        service.update(scope, 'stu-1', { campusId: 'campus-2' }),
      ).rejects.toThrow(ConflictException);
      expect(uirQb.execute).not.toHaveBeenCalled();
      expect(studentRepo.update).not.toHaveBeenCalled();
    });

    it('sede nueva fuera de su alcance: no mueve nada', async () => {
      assignments.validateAssignment.mockRejectedValue(
        new NotFoundException('Sede no encontrada'),
      );
      await expect(
        service.update(scope, 'stu-1', { campusId: 'campus-9' }),
      ).rejects.toThrow(NotFoundException);
      expect(uirQb.execute).not.toHaveBeenCalled();
      expect(studentRepo.update).not.toHaveBeenCalled();
    });
  });
});
