import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { schoolToday } from '../../common/utils/school-date';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { ScoreEntity } from './entities/score.entity';
import {
  EvaluationAccessService,
  EvaluationActor,
} from './evaluation-access.service';
import { EvaluationsService } from './evaluations.service';
import { average2 } from './gradebook.service';
import { ScoresService } from './scores.service';

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

describe('average2', () => {
  it('promedio exacto en centésimas, redondeado a 2 decimales', () => {
    expect(average2([])).toBeNull();
    expect(average2([3.33, 3.33, 3.34])).toBe(3.33);
    expect(average2([4.1, 4.2])).toBe(4.15);
    expect(average2([3.33, 3.34])).toBe(3.34); // 3.335 -> mitad hacia arriba
    expect(average2([0.1, 0.2])).toBe(0.15);
  });
});

describe('ScoresService', () => {
  const actor = (admin: boolean): EvaluationActor => ({
    institutionId: 'inst-A',
    userId: 'u-1',
    adminScope: admin ? null : [],
    teacherScope: null,
    teacherId: 't-1',
  });
  const tsc = (yearActive = true, isActive = true, teacherId = 't-1') => ({
    id: 'tsc-1',
    courseId: 'c-1',
    isActive,
    teacherId,
    course: { campusId: 'campus-1', academicYear: { isActive: yearActive } },
  });
  const period = (startDate = shift(-10), endDate = shift(10)) => ({
    id: 'p-1',
    startDate,
    endDate,
  });
  const evaluation = {
    id: 'e-1',
    teacherSubjectCourseId: 'tsc-1',
    periodId: 'p-1',
    title: 'Taller',
    percentage: 20,
    evaluationDate: today,
    createdAt: new Date(),
    period: period(),
    teacherSubjectCourse: {
      id: 'tsc-1',
      courseId: 'c-1',
      isActive: true,
      course: { id: 'c-1', name: '601' },
      subject: { id: 'sub-1', name: 'Matemáticas' },
      teacher: {
        id: 't-1',
        userId: 'u-1',
        user: { firstName: 'A', lastName: 'B' },
      },
    },
  };

  let service: ScoresService;
  let enrollments: { studentId: string; status: string }[];
  let scores: { studentId: string; score: number }[];
  const manager = {
    query: jest.fn(),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === InstitutionEntity) {
        return {
          findOneOrFail: jest.fn().mockResolvedValue({
            id: 'inst-A',
            gradingScaleMin: 1,
            gradingScaleMax: 5,
            passingScore: 3,
          }),
        };
      }
      if (entity === EnrollmentEntity) {
        return { find: jest.fn(() => Promise.resolve(enrollments)) };
      }
      if (entity === ScoreEntity) {
        return { find: jest.fn(() => Promise.resolve(scores)) };
      }
      throw new Error('repositorio inesperado');
    }),
  };
  const access = {
    resolve: jest.fn(),
    isAdminOf: jest.fn((a: EvaluationActor) => a.adminScope === null),
  };
  const evaluations = {
    getVisible: jest.fn().mockResolvedValue(evaluation),
    lockAssignment: jest.fn(),
    lockPeriod: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    enrollments = [
      { studentId: 's-1', status: 'ENROLLED' },
      { studentId: 's-2', status: 'DROPPED' },
    ];
    scores = [
      { studentId: 's-1', score: 3.5 },
      { studentId: 's-2', score: 2 },
    ];
    access.resolve.mockResolvedValue(actor(false));
    evaluations.lockAssignment.mockResolvedValue(tsc());
    evaluations.lockPeriod.mockResolvedValue(period());
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.startsWith('INSERT')
          ? [{ student_id: 's-1', score: '4.00' }]
          : sql.trimStart().startsWith('DELETE')
            ? [[{ student_id: 's-2' }], 1]
            : [],
      ),
    );
    const dataSource = {
      manager,
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    };
    service = new ScoresService(
      dataSource as unknown as DataSource,
      access as unknown as EvaluationAccessService,
      evaluations as unknown as EvaluationsService,
    );
  });

  const upsert = (rows: { studentId: string; score: number | null }[]) =>
    service.upsert(user, 'e-1', { scores: rows });

  const spyLog = () =>
    jest
      .spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

  it('upsert con updated_by, borrado de las notas en null y bloqueos', async () => {
    access.resolve.mockResolvedValue(actor(true));
    await upsert([
      { studentId: 's-1', score: 4.5 },
      { studentId: 's-2', score: null },
    ]);
    const calls = manager.query.mock.calls as [string, unknown[]][];
    const insert = calls.find(([sql]) => sql.startsWith('INSERT'));
    expect(insert?.[1]).toEqual(['e-1', 'u-1', ['s-1'], ['4.5']]);
    const del = calls.find(([sql]) => sql.trimStart().startsWith('DELETE'));
    expect(del?.[1]).toEqual(['e-1', ['s-2']]);
    expect(evaluations.getVisible).toHaveBeenCalledWith(
      manager,
      expect.anything(),
      'e-1',
      'no-key-update',
    );
    expect(evaluations.lockAssignment).toHaveBeenCalledWith(
      manager,
      expect.anything(),
      'tsc-1',
      { allowInactive: true },
    );
  });

  it('todo o nada: 400 con el error de cada fila y sin escribir', async () => {
    const error = await upsert([
      { studentId: 's-1', score: 5.01 },
      { studentId: 's-2', score: 4 },
      { studentId: 's-3', score: null },
      { studentId: 's-1', score: 3 },
      { studentId: 's-2', score: null },
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const message = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(message.message).toEqual([
      'scores[0] (s-1): la nota debe estar entre 1 y 5',
      'scores[1] (s-2): el estudiante no tiene matrícula vigente en el curso',
      'scores[2] (s-3): el estudiante no tiene nota ni matrícula vigente en el curso',
      'scores[3] (s-1): el estudiante está repetido en el lote',
      'scores[4] (s-2): el estudiante está repetido en el lote',
    ]);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('el docente no quita la nota de un retirado (400); el administrador sí', async () => {
    const error = await upsert([{ studentId: 's-2', score: null }]).catch(
      (e: unknown) => e,
    );
    expect(
      ((error as BadRequestException).getResponse() as { message: string[] })
        .message,
    ).toEqual([
      'scores[0] (s-2): el estudiante ya no tiene matrícula vigente: solo un administrador puede quitar su nota',
    ]);
    access.resolve.mockResolvedValue(actor(true));
    await expect(
      upsert([{ studentId: 's-2', score: null }]),
    ).resolves.toBeDefined();
  });

  it.each([
    ['periodo futuro', period(shift(1), shift(10)), true],
    ['periodo terminado', period(shift(-10), shift(-1)), true],
    ['año inactivo', period(), false],
  ])('docente con %s: 403', async (_c, p, yearActive) => {
    evaluations.lockPeriod.mockResolvedValue(p);
    evaluations.lockAssignment.mockResolvedValue(tsc(yearActive));
    await expect(upsert([{ studentId: 's-1', score: 4 }])).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('carga inactiva: el docente no (409), el administrador corrige con auditoría', async () => {
    evaluations.lockAssignment.mockResolvedValue(tsc(true, false));
    await expect(upsert([{ studentId: 's-1', score: 4 }])).rejects.toThrow(
      ConflictException,
    );
    access.resolve.mockResolvedValue(actor(true));
    const log = spyLog();
    await upsert([{ studentId: 's-1', score: 4 }]);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      reason: 'inactive-assignment',
    });
  });

  it('el docente califica el primer y el último día del periodo', async () => {
    evaluations.lockPeriod.mockResolvedValue(period(today, today));
    await expect(
      upsert([{ studentId: 's-1', score: 4 }]),
    ).resolves.toBeDefined();
  });

  it('el administrador corrige un periodo terminado: auditoría con el valor anterior y el nuevo', async () => {
    access.resolve.mockResolvedValue(actor(true));
    evaluations.lockPeriod.mockResolvedValue(period(shift(-10), shift(-1)));
    const log = spyLog();
    await upsert([
      { studentId: 's-1', score: 4 },
      { studentId: 's-2', score: null },
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      audit: 'scores.changed',
      reason: 'period-ended',
      actorId: 'u-1',
      institutionId: 'inst-A',
      evaluationId: 'e-1',
      teacherAssignmentId: 'tsc-1',
      periodId: 'p-1',
      changes: [
        { studentId: 's-1', old: 3.5, new: 4 },
        { studentId: 's-2', old: 2, new: null },
      ],
    });
  });

  it('el administrador en la carga de otro docente, en plazo: auditado', async () => {
    access.resolve.mockResolvedValue(actor(true));
    evaluations.lockAssignment.mockResolvedValue(tsc(true, true, 't-other'));
    const log = spyLog();
    await upsert([{ studentId: 's-1', score: 4 }]);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      reason: 'not-own-assignment',
    });
  });

  it('sin auditoría: el docente de la carga en plazo, o si nada cambió', async () => {
    const log = spyLog();
    await upsert([{ studentId: 's-1', score: 4 }]);
    access.resolve.mockResolvedValue(actor(true));
    evaluations.lockPeriod.mockResolvedValue(period(shift(-10), shift(-1)));
    manager.query.mockResolvedValue([]);
    await upsert([{ studentId: 's-1', score: 3.5 }]);
    expect(log).not.toHaveBeenCalled();
  });
});
