import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { CourseEntity } from '../academic/entities/course.entity';
import { PeriodEntity } from '../academic/entities/period.entity';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import { EvaluationAccessService } from '../evaluations/evaluation-access.service';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { UserEntity } from '../users/entities/user.entity';
import { ReportTemplatesService } from './report-templates.service';
import { StorageService } from '../../storage/storage.service';
import { MAX_BATCH_STUDENTS, ReportCardsService } from './report-cards.service';

describe('ReportCardsService: PDF recién subido tras un error (B3)', () => {
  const existsBy = jest.fn();
  const storage = { removeQuietly: jest.fn() };
  const service = new ReportCardsService(
    { getRepository: () => ({ existsBy }) } as unknown as DataSource,
    null as never,
    null as never,
    null as never,
    null as never,
    storage as unknown as StorageService,
  );
  const discard = (path: string) =>
    (
      service as unknown as { discardUpload: (p: string) => Promise<void> }
    ).discardUpload(path);

  beforeEach(() => jest.clearAllMocks());

  it('lo borra si ningún boletín lo usa', async () => {
    existsBy.mockResolvedValue(false);
    await discard('i/report-cards/a.pdf');
    expect(existsBy).toHaveBeenCalledWith({ pdfPath: 'i/report-cards/a.pdf' });
    expect(storage.removeQuietly).toHaveBeenCalledWith(
      'report-cards',
      'i/report-cards/a.pdf',
    );
  });

  it('no lo borra si el COMMIT sí quedó (la fila lo usa) ni si no hay base', async () => {
    existsBy.mockResolvedValueOnce(true);
    await discard('i/report-cards/b.pdf');
    existsBy.mockRejectedValueOnce(new Error('sin conexión'));
    await discard('i/report-cards/c.pdf');
    expect(storage.removeQuietly).not.toHaveBeenCalled();
  });
});

describe('ReportCardsService.generateBatch', () => {
  const user: AuthUser = {
    userId: 'u-1',
    institutionId: 'inst-A',
    userType: 'INSTITUTION_ADMIN',
    mustChangePassword: false,
    sessionId: 'sid',
  };
  const admin = {
    institutionId: 'inst-A',
    userId: 'u-1',
    adminScope: null,
    teacherScope: [],
    teacherId: null,
  };
  const qb = (result: unknown) => {
    const q: Record<string, jest.Mock> = {};
    for (const m of [
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ]) {
      q[m] = jest.fn(() => q);
    }
    q.getOne = jest.fn().mockResolvedValue(result);
    q.getMany = jest.fn().mockResolvedValue(result);
    return q;
  };
  let enrollments: { studentId: string }[];
  const userExists = jest.fn();
  const repos = () =>
    new Map<unknown, unknown>([
      [
        CourseEntity,
        {
          createQueryBuilder: () =>
            qb({ id: 'c-1', campusId: 'campus-1', academicYearId: 'y-1' }),
        },
      ],
      [
        PeriodEntity,
        { createQueryBuilder: () => qb({ id: 'p-1', academicYearId: 'y-1' }) },
      ],
      [EnrollmentEntity, { createQueryBuilder: () => qb(enrollments) }],
      [InstitutionEntity, { findOneByOrFail: jest.fn().mockResolvedValue({}) }],
      [UserEntity, { existsBy: userExists }],
    ]);
  const access = { resolve: jest.fn(), isAdminOf: jest.fn() };
  const templates = { requiredLogoDataUri: jest.fn().mockResolvedValue(null) };
  let service: ReportCardsService;
  let generateFor: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    const map = repos();
    const getRepository = (e: unknown) => map.get(e);
    service = new ReportCardsService(
      { manager: { getRepository }, getRepository } as unknown as DataSource,
      access as unknown as EvaluationAccessService,
      null as never,
      templates as unknown as ReportTemplatesService,
      null as never,
      null as never,
    );
    generateFor = jest
      .spyOn(
        service as unknown as { generateFor: () => Promise<unknown> },
        'generateFor',
      )
      .mockResolvedValue({});
    access.resolve.mockResolvedValue(admin);
    access.isAdminOf.mockReturnValue(true);
    userExists.mockResolvedValue(true);
  });

  const run = () =>
    service.generateBatch(user, { courseId: 'c-1', periodId: 'p-1' });

  it(`más de ${MAX_BATCH_STUDENTS} matriculados: 400 sin generar nada (M2)`, async () => {
    enrollments = Array.from({ length: MAX_BATCH_STUDENTS + 1 }, (_, i) => ({
      studentId: `s-${i}`,
    }));
    await expect(run()).rejects.toThrow(BadRequestException);
    expect(generateFor).not.toHaveBeenCalled();
  });

  it('de a 2 y, si pierde la administración de la sede, corta el lote (M5)', async () => {
    enrollments = ['s-1', 's-2', 's-3', 's-4', 's-5'].map((studentId) => ({
      studentId,
    }));
    // Inicio, primer grupo y segundo grupo administra; el tercero ya no.
    access.isAdminOf
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const result = await run();
    expect(generateFor).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      total: 5,
      generated: 4,
      skipped: [],
      failed: [{ studentId: 's-5' }],
    });
  });

  it('usuario desactivado a mitad del lote: no sigue', async () => {
    enrollments = ['s-1', 's-2', 's-3'].map((studentId) => ({ studentId }));
    userExists.mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = await run();
    expect(generateFor).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([{ studentId: 's-3' }]);
  });

  it('un rechazo que no es Error no rompe el resumen (B2)', async () => {
    enrollments = [{ studentId: 's-1' }, { studentId: 's-2' }];
    generateFor.mockRejectedValueOnce(undefined);
    const result = await run();
    expect(result).toMatchObject({
      generated: 1,
      failed: [{ studentId: 's-1' }],
    });
  });
});
