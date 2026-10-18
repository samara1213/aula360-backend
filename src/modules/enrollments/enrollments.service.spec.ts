import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { CoursesService } from '../academic/courses.service';
import { PermissionsReader } from '../security/permissions-reader.service';
import { StudentEntity } from '../users/entities/student.entity';
import { UserEntity } from '../users/entities/user.entity';
import { EnrollmentsService } from './enrollments.service';
import {
  EnrollmentEntity,
  EnrollmentStatus,
} from './entities/enrollment.entity';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

const course = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  name: '601',
  campusId: 'campus-1',
  academicYearId: 'y-1',
  academicYear: { id: 'y-1', year: 2026, isActive: true },
  grade: { id: 'g-1', name: 'Sexto' },
  campus: { id: 'campus-1', name: 'Sede 1', isActive: true },
  ...overrides,
});

const enrollment = (status: EnrollmentStatus = 'ENROLLED') => ({
  id: 'e-1',
  status,
  courseId: 'c-1',
  studentId: 's-1',
  academicYearId: 'y-1',
  enrollmentDate: new Date(),
  observations: null,
  course: course(),
  academicYear: { id: 'y-1', year: 2026, isActive: true },
  student: {
    id: 's-1',
    studentCode: null,
    user: { firstName: 'A', lastName: 'B' },
  },
});

describe('EnrollmentsService', () => {
  let service: EnrollmentsService;

  const qb = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const enrollmentRepo = {
    createQueryBuilder: jest.fn(() => qb),
    insert: jest.fn(),
    update: jest.fn(),
  };
  const studentRepo = { findOneBy: jest.fn(), findOne: jest.fn() };
  const userRepo = { findOneOrFail: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [EnrollmentEntity, enrollmentRepo],
    [StudentEntity, studentRepo],
    [UserEntity, userRepo],
  ]);
  const manager = {
    getRepository: jest.fn((e: unknown) => repos.get(e)),
    // Bloqueos y marca de boletines (fase 10b).
    query: jest.fn((sql: string) =>
      Promise.resolve(sql.includes('UPDATE report_cards') ? [[], 0] : []),
    ),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { campusScope: jest.fn() };
  const courses = { lockForUse: jest.fn() };

  const student = (overrides: Record<string, unknown> = {}) => ({
    id: 's-1',
    userId: 'u-1',
    campusId: 'campus-1',
    ...overrides,
  });
  /** El perfil (sin y con bloqueo) y su usuario. */
  const givenStudent = (
    overrides: Record<string, unknown> = {},
    isActive = true,
  ) => {
    studentRepo.findOneBy.mockResolvedValue(student(overrides));
    studentRepo.findOne.mockResolvedValue(student(overrides));
    userRepo.findOneOrFail.mockResolvedValue({ id: 'u-1', isActive });
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.campusScope.mockResolvedValue(null);
    courses.lockForUse.mockResolvedValue(course());
    qb.getOne.mockResolvedValue(enrollment());
    givenStudent();
    enrollmentRepo.insert.mockResolvedValue({ identifiers: [{ id: 'e-1' }] });
    const moduleRef = await Test.createTestingModule({
      providers: [
        EnrollmentsService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
        { provide: CoursesService, useValue: courses },
      ],
    }).compile();
    service = moduleRef.get(EnrollmentsService);
  });

  describe('create', () => {
    it('bloquea curso, usuario (FOR SHARE) y perfil (FOR UPDATE), y toma el año del curso', async () => {
      await service.create(admin, { studentId: 's-1', courseId: 'c-1' });
      expect(courses.lockForUse).toHaveBeenCalledWith(
        manager,
        'inst-A',
        null,
        'c-1',
      );
      expect(userRepo.findOneOrFail).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
      );
      expect(studentRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(enrollmentRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          academicYearId: 'y-1',
          status: 'ENROLLED',
        }),
      );
    });

    it.each<
      [string, ReturnType<typeof course>, Record<string, unknown>, boolean]
    >([
      ['año inactivo', course({ academicYear: { isActive: false } }), {}, true],
      ['estudiante inactivo', course(), {}, false],
      ['estudiante sin sede', course(), { campusId: null }, true],
      ['estudiante de otra sede', course(), { campusId: 'campus-2' }, true],
    ])('400: %s', async (_c, c, overrides, isActive) => {
      courses.lockForUse.mockResolvedValue(c);
      givenStudent(overrides, isActive);
      await expect(
        service.create(admin, { studentId: 's-1', courseId: 'c-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(enrollmentRepo.insert).not.toHaveBeenCalled();
    });

    it('estudiante fuera de las sedes de quien actúa: 404 (no revela su estado)', async () => {
      permissions.campusScope.mockResolvedValue(['campus-1']);
      givenStudent({ campusId: 'campus-2' }, false);
      await expect(
        service.create(admin, { studentId: 's-1', courseId: 'c-1' }),
      ).rejects.toThrow(NotFoundException);
      expect(userRepo.findOneOrFail).not.toHaveBeenCalled();
    });

    it('estudiante de otra institución: 404', async () => {
      studentRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.create(admin, { studentId: 's-B', courseId: 'c-1' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update: estados', () => {
    it.each<[EnrollmentStatus, EnrollmentStatus, boolean]>([
      ['ENROLLED', 'SUSPENDED', true],
      ['ENROLLED', 'DROPPED', true],
      ['ENROLLED', 'GRADUATED', true],
      ['SUSPENDED', 'ENROLLED', true],
      ['SUSPENDED', 'DROPPED', true],
      ['SUSPENDED', 'GRADUATED', false],
      ['DROPPED', 'ENROLLED', true],
      ['DROPPED', 'SUSPENDED', false],
      ['GRADUATED', 'ENROLLED', false],
      ['GRADUATED', 'DROPPED', false],
    ])('%s → %s: %s', async (from, to, allowed) => {
      qb.getOne.mockResolvedValue(enrollment(from));
      const call = service.update(admin, 'e-1', { status: to });
      if (allowed) {
        await call;
        expect(enrollmentRepo.update).toHaveBeenCalledWith(
          { id: 'e-1' },
          { status: to },
        );
      } else {
        await expect(call).rejects.toThrow(ConflictException);
        expect(enrollmentRepo.update).not.toHaveBeenCalled();
      }
    });

    it('reintegro a un curso de otra sede: 400', async () => {
      qb.getOne.mockResolvedValue(enrollment('DROPPED'));
      givenStudent({ campusId: 'campus-2' });
      await expect(
        service.update(admin, 'e-1', { status: 'ENROLLED' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update: cambio de curso', () => {
    /** lockForUse según el id pedido. */
    const coursesById = (...list: ReturnType<typeof course>[]) =>
      courses.lockForUse.mockImplementation(
        (_m: unknown, _i: string, _s: unknown, id: string) =>
          Promise.resolve(list.find((c) => c.id === id)),
      );

    it('bloquea ambos cursos en orden por id', async () => {
      coursesById(course({ id: 'c-1' }), course({ id: 'c-0' }));
      await service.update(admin, 'e-1', { courseId: 'c-0' });
      expect(
        courses.lockForUse.mock.calls.map((call: unknown[]) => call[3]),
      ).toEqual(['c-0', 'c-1']);
    });

    it('a un curso de otro año: 400', async () => {
      coursesById(course(), course({ id: 'c-2', academicYearId: 'y-2' }));
      await expect(
        service.update(admin, 'e-1', { courseId: 'c-2' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('una matrícula retirada no cambia de curso sin reintegro: 409', async () => {
      qb.getOne.mockResolvedValue(enrollment('DROPPED'));
      await expect(
        service.update(admin, 'e-1', { courseId: 'c-2' }),
      ).rejects.toThrow(ConflictException);
    });

    it('mismo año y sede: cambia el curso', async () => {
      coursesById(course(), course({ id: 'c-2' }));
      await service.update(admin, 'e-1', { courseId: 'c-2' });
      expect(enrollmentRepo.update).toHaveBeenCalledWith(
        { id: 'e-1' },
        { courseId: 'c-2' },
      );
    });
  });
});
