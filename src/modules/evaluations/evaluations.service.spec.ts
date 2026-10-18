import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { schoolToday } from '../../common/utils/school-date';
import { PeriodEntity } from '../academic/entities/period.entity';
import { TeacherSubjectCourseEntity } from '../academic/entities/teacher-subject-course.entity';
import { EvaluationResponseDto } from './dto/evaluation.dto';
import { EvaluationEntity } from './entities/evaluation.entity';
import {
  EvaluationAccessService,
  EvaluationActor,
} from './evaluation-access.service';
import { EvaluationsService } from './evaluations.service';

const user: AuthUser = {
  userId: 'u-1',
  institutionId: 'inst-A',
  userType: 'TEACHER',
  mustChangePassword: false,
  sessionId: 'sid',
};

const today = schoolToday();
const shift = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe('EvaluationsService', () => {
  let service: EvaluationsService;

  const tsc = (isActive = true, yearActive = true) => ({
    id: 'tsc-1',
    isActive,
    courseId: 'c-1',
    subjectId: 'sub-1',
    course: {
      id: 'c-1',
      campusId: 'campus-1',
      academicYearId: 'y-1',
      academicYear: { isActive: yearActive },
    },
  });
  const period = (endDate = shift(10)) => ({
    id: 'p-1',
    academicYearId: 'y-1',
    startDate: shift(-10),
    endDate,
  });

  const tscQb = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const periodQb = { ...tscQb, getOne: jest.fn() };
  const evalQb = { ...tscQb, getOne: jest.fn() };
  const evalRepo = {
    createQueryBuilder: jest.fn(() => evalQb),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const repos = new Map<unknown, unknown>([
    [TeacherSubjectCourseEntity, { createQueryBuilder: jest.fn(() => tscQb) }],
    [PeriodEntity, { createQueryBuilder: jest.fn(() => periodQb) }],
    [EvaluationEntity, evalRepo],
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
  const teacher: EvaluationActor = {
    institutionId: 'inst-A',
    userId: 'u-1',
    adminScope: [],
    teacherScope: null,
    teacherId: 't-1',
  };
  const access = {
    resolve: jest.fn(),
    isAdminOf: jest.fn(),
    visibility: jest.fn(() => ({ sql: 'true', params: {} })),
  };

  const dto = {
    teacherAssignmentId: 'tsc-1',
    periodId: 'p-1',
    title: 'Taller',
    percentage: 20,
    evaluationDate: today,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    access.resolve.mockResolvedValue(teacher);
    access.isAdminOf.mockReturnValue(false);
    tscQb.getOne.mockResolvedValue(tsc());
    periodQb.getOne.mockResolvedValue(period());
    evalRepo.insert.mockResolvedValue({ identifiers: [{ id: 'e-1' }] });
    evalQb.getOne.mockResolvedValue(null);
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('pg_advisory_xact_lock')
          ? []
          : sql.includes('UPDATE report_cards')
            ? [[{ id: 'rc-1' }], 1]
            : [{ used: '40', exceeds: false }],
      ),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        EvaluationsService,
        { provide: DataSource, useValue: dataSource },
        { provide: EvaluationAccessService, useValue: access },
      ],
    }).compile();
    service = moduleRef.get(EvaluationsService);
  });

  /** Crea; la lectura final (evaluación creada) no importa aquí. */
  const create = (extra: Record<string, unknown> = {}) =>
    service.create(user, { ...dto, ...extra }).catch((error: unknown) => {
      if (
        error instanceof NotFoundException &&
        evalRepo.insert.mock.calls.length
      ) {
        return 'created';
      }
      throw error;
    });

  it('bloquea (curso, materia, periodo) y valida la suma con NUMERIC', async () => {
    await expect(create()).resolves.toBe('created');
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['evaluations:c-1:sub-1:p-1'],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('$4::numeric > 100'),
      ['c-1', 'sub-1', 'p-1', '20', null],
    );
  });

  it('la suma superaría 100: 409 sin insertar', async () => {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('pg_advisory_xact_lock')
          ? []
          : [{ used: '90', exceeds: true }],
      ),
    );
    await expect(create()).rejects.toThrow(ConflictException);
    expect(evalRepo.insert).not.toHaveBeenCalled();
  });

  it('carga inactiva: 409 (solo se consulta)', async () => {
    tscQb.getOne.mockResolvedValue(tsc(false));
    await expect(create()).rejects.toThrow(ConflictException);
  });

  it('carga no visible (de otro docente u otra sede): 404', async () => {
    tscQb.getOne.mockResolvedValue(null);
    await expect(create()).rejects.toThrow(NotFoundException);
    expect(evalRepo.insert).not.toHaveBeenCalled();
  });

  it('periodo terminado: el docente no (403), el administrador sí', async () => {
    periodQb.getOne.mockResolvedValue(period(shift(-1)));
    await expect(create({ evaluationDate: shift(-5) })).rejects.toThrow(
      ForbiddenException,
    );
    access.isAdminOf.mockReturnValue(true);
    await expect(create({ evaluationDate: shift(-5) })).resolves.toBe(
      'created',
    );
  });

  it('año lectivo inactivo: el docente no (403), el administrador sí', async () => {
    tscQb.getOne.mockResolvedValue(tsc(true, false));
    await expect(create()).rejects.toThrow(ForbiddenException);
    access.isAdminOf.mockReturnValue(true);
    await expect(create()).resolves.toBe('created');
  });

  it('resuelve quién actúa dentro de la transacción', async () => {
    await create();
    expect(access.resolve).toHaveBeenCalledWith(
      user,
      'evaluations.evaluations',
      'create',
      manager,
    );
  });

  it('fecha fuera del periodo o periodo de otro año: 400', async () => {
    await expect(create({ evaluationDate: shift(11) })).rejects.toThrow(
      BadRequestException,
    );
    periodQb.getOne.mockResolvedValue({ ...period(), academicYearId: 'y-2' });
    await expect(create()).rejects.toThrow(BadRequestException);
  });

  describe('update y boletines (fase 10b)', () => {
    const stored = {
      id: 'e-1',
      teacherSubjectCourseId: 'tsc-1',
      periodId: 'p-1',
      title: 'Taller',
      percentage: 20,
      evaluationDate: today,
    };
    const run = async (changes: Record<string, unknown>) => {
      jest
        .spyOn(service, 'getVisible')
        .mockResolvedValue(stored as unknown as EvaluationEntity);
      jest
        .spyOn(EvaluationResponseDto, 'from')
        .mockReturnValue({} as EvaluationResponseDto);
      const log = jest
        .spyOn(
          (service as unknown as { logger: { log: (m: string) => void } })
            .logger,
          'log',
        )
        .mockImplementation(() => undefined);
      await service.update(user, 'e-1', changes);
      return {
        calls: manager.query.mock.calls as [string, unknown[]][],
        log,
      };
    };

    it('cambiar el porcentaje: bloqueo compartido y todos los boletines del curso y periodo desactualizados', async () => {
      const { calls, log } = await run({ percentage: 30 });
      const lock = calls.find(([sql]) =>
        sql.includes('pg_advisory_xact_lock_shared'),
      );
      expect(lock?.[1]).toEqual(['report-cards:c-1:p-1']);
      const mark = calls.find(([sql]) => sql.includes('UPDATE report_cards'));
      expect(mark?.[1]).toEqual(['c-1', 'p-1']);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        audit: 'report-cards.outdated',
        reason: 'evaluation.percentage-changed',
        reportCardIds: ['rc-1'],
      });
    });

    it('solo el título o la fecha (o el mismo porcentaje): no toca los boletines', async () => {
      const { calls, log } = await run({ title: 'Otro', percentage: 20 });
      expect(
        calls.some(
          ([sql]) =>
            sql.includes('UPDATE report_cards') ||
            sql.includes('pg_advisory_xact_lock_shared'),
        ),
      ).toBe(false);
      expect(log).not.toHaveBeenCalled();
    });
  });
});
