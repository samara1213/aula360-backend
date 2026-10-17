import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import { CampusEntity } from '../institutions/entities/campus.entity';
import { PermissionsReader } from '../security/permissions-reader.service';
import { CoursesService } from './courses.service';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { CourseEntity } from './entities/course.entity';
import { GradeEntity } from './entities/grade.entity';
import { TeacherSubjectCourseEntity } from './entities/teacher-subject-course.entity';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

const course = (): CourseEntity =>
  ({
    id: 'c-1',
    name: '601',
    gradeId: 'g-1',
    campusId: 'campus-1',
    academicYearId: 'y-1',
    createdAt: new Date(),
    grade: { id: 'g-1', name: 'Sexto' },
    campus: { id: 'campus-1', name: 'Sede 1', isActive: true },
    academicYear: { id: 'y-1', year: 2026, isActive: true },
  }) as CourseEntity;

describe('CoursesService', () => {
  let service: CoursesService;

  const courseQb = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const courseRepo = {
    createQueryBuilder: jest.fn(() => courseQb),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const campusRepo = { findOne: jest.fn() };
  const yearRepo = { findOne: jest.fn() };
  const gradeRepo = { findOne: jest.fn() };
  const loadRepo = { existsBy: jest.fn() };
  const enrollmentRepo = { existsBy: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [CourseEntity, courseRepo],
    [CampusEntity, campusRepo],
    [AcademicYearEntity, yearRepo],
    [GradeEntity, gradeRepo],
    [TeacherSubjectCourseEntity, loadRepo],
    [EnrollmentEntity, enrollmentRepo],
  ]);
  const manager = { getRepository: jest.fn((e: unknown) => repos.get(e)) };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { campusScope: jest.fn() };

  const dto = {
    name: '601',
    gradeId: 'g-1',
    campusId: 'campus-1',
    academicYearId: 'y-1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.campusScope.mockResolvedValue(null);
    courseQb.getOne.mockResolvedValue(course());
    courseRepo.insert.mockResolvedValue({ identifiers: [{ id: 'c-1' }] });
    campusRepo.findOne.mockResolvedValue({ id: 'campus-1', isActive: true });
    yearRepo.findOne.mockResolvedValue({ id: 'y-1', isActive: true });
    gradeRepo.findOne.mockResolvedValue({ id: 'g-1' });
    loadRepo.existsBy.mockResolvedValue(false);
    enrollmentRepo.existsBy.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CoursesService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(CoursesService);
  });

  describe('create', () => {
    it('sede, año y grado de la institución activa, leídos FOR SHARE', async () => {
      await service.create(admin, dto);
      for (const repo of [campusRepo, yearRepo, gradeRepo]) {
        const [options] = repo.findOne.mock.calls[0] as [
          { where: { institutionId: string }; lock: unknown },
        ];
        expect(options.where.institutionId).toBe('inst-A');
        expect(options.lock).toEqual({ mode: 'pessimistic_read' });
      }
      expect(courseRepo.insert).toHaveBeenCalled();
    });

    it('sede fuera de su alcance: 404 sin consultar la sede', async () => {
      permissions.campusScope.mockResolvedValue(['campus-2']);
      await expect(service.create(admin, dto)).rejects.toThrow(
        NotFoundException,
      );
      expect(campusRepo.findOne).not.toHaveBeenCalled();
    });

    it('sede inactiva o año inactivo: 400', async () => {
      campusRepo.findOne.mockResolvedValue({ id: 'campus-1', isActive: false });
      await expect(service.create(admin, dto)).rejects.toThrow(
        BadRequestException,
      );
      campusRepo.findOne.mockResolvedValue({ id: 'campus-1', isActive: true });
      yearRepo.findOne.mockResolvedValue({ id: 'y-1', isActive: false });
      await expect(service.create(admin, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(courseRepo.insert).not.toHaveBeenCalled();
    });

    it('lista filtrando por la institución del grado y por sus sedes', async () => {
      permissions.campusScope.mockResolvedValue(['campus-1']);
      await service.findOne(admin, 'c-1');
      expect(courseQb.where).toHaveBeenCalledWith(
        'g.institution_id = :institutionId',
        { institutionId: 'inst-A' },
      );
      expect(courseQb.andWhere).toHaveBeenCalledWith(
        'c.campus_id IN (:...campusScope)',
        { campusScope: ['campus-1'] },
      );
    });
  });

  describe('update', () => {
    it('solo el nombre: no revisa carga ni matrículas', async () => {
      await service.update(admin, 'c-1', { name: '601A' });
      expect(courseQb.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
        undefined,
        ['c'],
      );
      expect(loadRepo.existsBy).not.toHaveBeenCalled();
      expect(courseRepo.update).toHaveBeenCalled();
    });

    it('mover con carga académica o matrículas: 409', async () => {
      enrollmentRepo.existsBy.mockResolvedValue(true);
      await expect(
        service.update(admin, 'c-1', { campusId: 'campus-2' }),
      ).rejects.toThrow(ConflictException);
      expect(courseRepo.update).not.toHaveBeenCalled();
    });

    it('mover sin uso: valida la nueva sede como en el alta', async () => {
      await service.update(admin, 'c-1', { campusId: 'campus-2' });
      expect(campusRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'campus-2', institutionId: 'inst-A' },
        }),
      );
    });
  });
});
