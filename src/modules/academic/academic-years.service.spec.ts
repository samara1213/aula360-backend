import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PermissionsReader } from '../security/permissions-reader.service';
import { AcademicYearsService } from './academic-years.service';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { CourseEntity } from './entities/course.entity';
import { PeriodEntity } from './entities/period.entity';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

describe('AcademicYearsService', () => {
  let service: AcademicYearsService;

  const yearRepo = {
    findOne: jest.fn(),
    save: jest.fn((v: unknown) => Promise.resolve(v)),
    delete: jest.fn(),
  };
  const periodRepo = { existsBy: jest.fn() };
  const courseRepo = { existsBy: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [AcademicYearEntity, yearRepo],
    [PeriodEntity, periodRepo],
    [CourseEntity, courseRepo],
  ]);
  const manager = { getRepository: jest.fn((e: unknown) => repos.get(e)) };
  const dataSource = {
    manager,
    getRepository: jest.fn((e: unknown) => repos.get(e)),
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { requireInstitutionWide: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.requireInstitutionWide.mockResolvedValue(undefined);
    yearRepo.findOne.mockResolvedValue({
      id: 'y-1',
      institutionId: 'inst-A',
      year: 2026,
      isActive: true,
      createdAt: new Date(),
    });
    periodRepo.existsBy.mockResolvedValue(false);
    courseRepo.existsBy.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AcademicYearsService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(AcademicYearsService);
  });

  it('editar bloquea el año de la institución activa (FOR UPDATE)', async () => {
    await service.update(admin, 'y-1', { isActive: false });
    expect(yearRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'y-1', institutionId: 'inst-A' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(yearRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
  });

  it('cambiar el número con periodos o cursos: 409', async () => {
    periodRepo.existsBy.mockResolvedValue(true);
    await expect(service.update(admin, 'y-1', { year: 2027 })).rejects.toThrow(
      ConflictException,
    );
    expect(yearRepo.save).not.toHaveBeenCalled();
  });

  it('cambiar el número sin periodos ni cursos: se guarda', async () => {
    await service.update(admin, 'y-1', { year: 2027 });
    expect(yearRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ year: 2027 }),
    );
  });

  it('otra institución: 404', async () => {
    yearRepo.findOne.mockResolvedValue(null);
    await expect(service.findOne(admin, 'y-B')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('limitado a sedes: 403 antes de buscar', async () => {
    permissions.requireInstitutionWide.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(
      service.update(admin, 'y-1', { isActive: false }),
    ).rejects.toThrow(ForbiddenException);
    expect(yearRepo.findOne).not.toHaveBeenCalled();
  });

  it('borrar en uso (FK RESTRICT): 409', async () => {
    yearRepo.delete.mockRejectedValue(
      Object.assign(new QueryFailedError('SQL', [], new Error('x')), {
        code: '23503',
      }),
    );
    await expect(service.remove(admin, 'y-1')).rejects.toThrow(
      ConflictException,
    );
  });
});
