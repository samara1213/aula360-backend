import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PermissionsReader } from '../security/permissions-reader.service';
import { TeacherEntity } from '../users/entities/teacher.entity';
import { UserEntity } from '../users/entities/user.entity';
import { CoursesService } from './courses.service';
import { SubjectEntity } from './entities/subject.entity';
import { TeacherSubjectCourseEntity } from './entities/teacher-subject-course.entity';
import { TeacherAssignmentsService } from './teacher-assignments.service';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

const course = (isActive = true) => ({
  id: 'c-1',
  name: '601',
  campusId: 'campus-1',
  academicYearId: 'y-1',
  academicYear: { id: 'y-1', year: 2026, isActive },
  grade: { id: 'g-1', name: 'Sexto' },
  campus: { id: 'campus-1', name: 'Sede 1', isActive: true },
});

const assignment = (isActive = true) => ({
  id: 'a-1',
  isActive,
  courseId: 'c-1',
  subjectId: 'sub-1',
  teacherId: 't-1',
  createdAt: new Date(),
  deactivatedAt: null,
  course: course(),
  subject: { id: 'sub-1', name: 'Matemáticas' },
  teacher: {
    id: 't-1',
    userId: 'u-1',
    user: { firstName: 'A', lastName: 'B' },
  },
});

describe('TeacherAssignmentsService', () => {
  let service: TeacherAssignmentsService;

  const qb = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const tscRepo = {
    createQueryBuilder: jest.fn(() => qb),
    existsBy: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  };
  const subjectRepo = { findOne: jest.fn() };
  const teacherRepo = { findOneBy: jest.fn() };
  const userRepo = { findOne: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [TeacherSubjectCourseEntity, tscRepo],
    [SubjectEntity, subjectRepo],
    [TeacherEntity, teacherRepo],
    [UserEntity, userRepo],
  ]);
  const manager = {
    getRepository: jest.fn((e: unknown) => repos.get(e)),
    query: jest.fn(),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { campusScope: jest.fn() };
  const courses = { lockForUse: jest.fn() };

  const dto = { courseId: 'c-1', subjectId: 'sub-1', teacherId: 't-2' };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.campusScope.mockResolvedValue(null);
    courses.lockForUse.mockResolvedValue(course());
    subjectRepo.findOne.mockResolvedValue({ id: 'sub-1' });
    teacherRepo.findOneBy.mockResolvedValue({ id: 't-2', userId: 'u-2' });
    userRepo.findOne.mockResolvedValue({ id: 'u-2', isActive: true });
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('UPDATE report_cards') ? [[], 0] : [{ allowed: true }],
      ),
    );
    tscRepo.existsBy.mockResolvedValue(false);
    tscRepo.insert.mockResolvedValue({ identifiers: [{ id: 'a-2' }] });
    qb.getOne.mockResolvedValue(assignment());
    const moduleRef = await Test.createTestingModule({
      providers: [
        TeacherAssignmentsService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
        { provide: CoursesService, useValue: courses },
      ],
    }).compile();
    service = moduleRef.get(TeacherAssignmentsService);
  });

  describe('create', () => {
    it('bloquea primero el curso (M1) y valida al docente', async () => {
      await service.create(admin, dto);
      expect(courses.lockForUse).toHaveBeenCalledWith(
        manager,
        'inst-A',
        null,
        'c-1',
      );
      expect(teacherRepo.findOneBy).toHaveBeenCalledWith({
        id: 't-2',
        institutionId: 'inst-A',
      });
      expect(userRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
      );
      // Rol TEACHER en la sede del curso o en toda la institución.
      expect(manager.query).toHaveBeenCalledWith(expect.any(String), [
        'u-2',
        'inst-A',
        ['campus-1'],
      ]);
      expect(tscRepo.insert).toHaveBeenCalled();
    });

    it('ya hay un docente activo: 409', async () => {
      tscRepo.existsBy.mockResolvedValue(true);
      await expect(service.create(admin, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it.each([
      [
        'año inactivo',
        () => courses.lockForUse.mockResolvedValue(course(false)),
      ],
      [
        'docente inactivo',
        () => userRepo.findOne.mockResolvedValue({ isActive: false }),
      ],
      [
        'sin rol TEACHER en la sede',
        () => manager.query.mockResolvedValue([{ allowed: false }]),
      ],
    ])('400: %s', async (_c, arrange) => {
      arrange();
      await expect(service.create(admin, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(tscRepo.insert).not.toHaveBeenCalled();
    });

    it('docente o materia de otra institución: 404', async () => {
      teacherRepo.findOneBy.mockResolvedValue(null);
      await expect(service.create(admin, dto)).rejects.toThrow(
        NotFoundException,
      );
      teacherRepo.findOneBy.mockResolvedValue({ id: 't-2', userId: 'u-2' });
      subjectRepo.findOne.mockResolvedValue(null);
      await expect(service.create(admin, dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('administrador de sede: docente sin rol TEACHER en sus sedes = 404', async () => {
    permissions.campusScope.mockResolvedValue(['campus-1']);
    manager.query.mockResolvedValue([{ allowed: false }]);
    await expect(service.create(admin, dto)).rejects.toThrow(NotFoundException);
    expect(manager.query).toHaveBeenCalledWith(expect.any(String), [
      'u-2',
      'inst-A',
      ['campus-1'],
    ]);
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  describe('replace', () => {
    it('desactiva la actual (con fecha) y crea la nueva', async () => {
      await service.replace(admin, 'a-1', { teacherId: 't-2' });
      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write', undefined, [
        't',
      ]);
      expect(tscRepo.update).toHaveBeenCalledWith(
        { id: 'a-1' },
        expect.objectContaining({ isActive: false }),
      );
      expect(tscRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          courseId: 'c-1',
          subjectId: 'sub-1',
          teacherId: 't-2',
          isActive: true,
        }),
      );
    });

    it('mismo docente: 400; asignación inactiva: 409', async () => {
      await expect(
        service.replace(admin, 'a-1', { teacherId: 't-1' }),
      ).rejects.toThrow(BadRequestException);
      qb.getOne.mockResolvedValue(assignment(false));
      await expect(
        service.replace(admin, 'a-1', { teacherId: 't-2' }),
      ).rejects.toThrow(ConflictException);
      expect(tscRepo.update).not.toHaveBeenCalled();
    });
  });

  it('mi carga: sin el rol TEACHER vigente, lista vacía', async () => {
    const reposByDs = { findOneBy: jest.fn().mockResolvedValue({ id: 't-1' }) };
    Object.assign(dataSource, {
      getRepository: jest.fn(() => reposByDs),
      query: jest.fn().mockResolvedValue([{ allowed: false }]),
    });
    await expect(service.findMine(admin)).resolves.toEqual([]);
    expect(qb.getOne).not.toHaveBeenCalled();
  });

  it('mi carga: sin perfil de docente, lista vacía', async () => {
    const reposByDs = { findOneBy: jest.fn().mockResolvedValue(null) };
    Object.assign(dataSource, { getRepository: jest.fn(() => reposByDs) });
    await expect(service.findMine(admin)).resolves.toEqual([]);
  });
});
