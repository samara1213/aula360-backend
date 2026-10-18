import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { schoolToday } from '../../common/utils/school-date';
import { PeriodEntity } from '../academic/entities/period.entity';
import { TeacherSubjectCourseEntity } from '../academic/entities/teacher-subject-course.entity';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import {
  lockReportCards,
  markReportCardsOutdated,
} from '../reports/report-card-locks';
import { EvaluationResponseDto } from './dto/evaluation.dto';
import {
  EvaluationScoresDto,
  GradingScaleDto,
  ScoreStudentDto,
  UpsertScoresDto,
} from './dto/score.dto';
import { EvaluationEntity } from './entities/evaluation.entity';
import { ScoreEntity } from './entities/score.entity';
import {
  EvaluationAccessService,
  EvaluationActor,
} from './evaluation-access.service';
import { EvaluationsService } from './evaluations.service';

export const SCORES_PERMISSION = 'evaluations.scores';

/**
 * Por qué una escritura queda en la auditoría: quien actúa no es el docente
 * de la carga, o es una corrección fuera de plazo (solo el administrador).
 */
type AuditReason =
  | 'inactive-assignment'
  | 'year-inactive'
  | 'period-ended'
  | 'not-own-assignment';

export function toScale(institution: InstitutionEntity): GradingScaleDto {
  return {
    min: institution.gradingScaleMin,
    max: institution.gradingScaleMax,
    passingScore: institution.passingScore,
  };
}

/**
 * Notas de una evaluación (mismo acceso que las evaluaciones, con el permiso
 * evaluations.scores):
 * - El docente registra y edita en su carga activa solo mientras el periodo
 *   está en curso (inicio <= hoy <= fin, fecha de Colombia) y el año está
 *   activo, y solo quita notas de estudiantes con matrícula vigente.
 * - El administrador de la sede del curso, siempre: también en periodos
 *   terminados, años inactivos y cargas inactivas (docente reemplazado), y
 *   notas de estudiantes que ya no están matriculados.
 * - Toda escritura de alguien que no es el docente de la carga, o fuera de
 *   plazo, queda en una línea de auditoría (después del commit) con el valor
 *   anterior y el nuevo de cada nota que cambió (hallazgo M2 de la fase 9b),
 *   además de updated_by.
 * - El lote es todo o nada: si una fila es inválida se responde 400 con el
 *   error de cada fila. Una nota exige matrícula ENROLLED en el curso y estar
 *   dentro de la escala de la institución; null quita la nota.
 * - Bloqueos en el orden de las evaluaciones: usuario que actúa, evaluación
 *   (FOR NO KEY UPDATE), carga y su año, periodo (FOR SHARE); luego la
 *   bloqueo compartido de los boletines del curso y el periodo, la
 *   institución (FOR SHARE: su escala no cambia mientras tanto) y las
 *   matrículas (FOR SHARE).
 * - Los boletines vigentes de los estudiantes cuya nota cambió quedan
 *   desactualizados (outdated_at), también en la auditoría (fase 10b).
 */
@Injectable()
export class ScoresService {
  private readonly logger = new Logger(ScoresService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: EvaluationAccessService,
    private readonly evaluations: EvaluationsService,
  ) {}

  async list(
    user: AuthUser,
    evaluationId: string,
  ): Promise<EvaluationScoresDto> {
    const actor = await this.access.resolve(user, SCORES_PERMISSION, 'view');
    const manager = this.dataSource.manager;
    const evaluation = await this.evaluations.getVisible(
      manager,
      actor,
      evaluationId,
    );
    const institution = await manager
      .getRepository(InstitutionEntity)
      .findOneByOrFail({ id: actor.institutionId });
    return this.toDto(manager, institution, evaluation);
  }

  async upsert(
    user: AuthUser,
    evaluationId: string,
    dto: UpsertScoresDto,
  ): Promise<EvaluationScoresDto> {
    const { result, audit, outdated } = await this.dataSource.transaction(
      async (manager) => {
        const actor = await this.access.resolve(
          user,
          SCORES_PERMISSION,
          'update',
          manager,
        );
        const evaluation = await this.evaluations.getVisible(
          manager,
          actor,
          evaluationId,
          'no-key-update',
        );
        const tsc = await this.evaluations.lockAssignment(
          manager,
          actor,
          evaluation.teacherSubjectCourseId,
          { allowInactive: true },
        );
        const period = await this.evaluations.lockPeriod(
          manager,
          actor,
          evaluation.periodId,
        );
        const isAdmin = this.access.isAdminOf(actor, tsc.course.campusId);
        const reason = this.assertCanGrade(actor, isAdmin, tsc, period);
        await lockReportCards(manager, tsc.courseId, period.id, 'shared');
        const institution = await manager
          .getRepository(InstitutionEntity)
          .findOneOrFail({
            where: { id: actor.institutionId },
            lock: { mode: 'pessimistic_read' },
          });

        const ids = dto.scores.map((row) => row.studentId);
        const enrollments = await manager.getRepository(EnrollmentEntity).find({
          select: { id: true, studentId: true, status: true },
          where: { courseId: tsc.courseId, studentId: In(ids) },
          lock: { mode: 'pessimistic_read' },
        });
        const statusOf = new Map(
          enrollments.map((e) => [e.studentId, e.status]),
        );
        const previous = new Map(
          (
            await manager.getRepository(ScoreEntity).find({
              select: { id: true, studentId: true, score: true },
              where: { evaluationId: evaluation.id, studentId: In(ids) },
            })
          ).map((s) => [s.studentId, s.score]),
        );
        this.assertRows(dto, statusOf, previous, institution, isAdmin);

        const toSet = dto.scores.filter((row) => row.score !== null);
        const toRemove = dto.scores
          .filter((row) => row.score === null)
          .map((row) => row.studentId);
        const changed = toSet.length
          ? await manager.query<{ student_id: string; score: string }[]>(
              `INSERT INTO scores (evaluation_id, student_id, score, updated_by)
               SELECT $1, x.student_id, x.score, $2
                 FROM unnest($3::uuid[], $4::numeric[]) AS x(student_id, score)
               ON CONFLICT (evaluation_id, student_id) DO UPDATE
                  SET score = EXCLUDED.score,
                      updated_by = EXCLUDED.updated_by,
                      updated_at = CURRENT_TIMESTAMP
                WHERE scores.score IS DISTINCT FROM EXCLUDED.score
               RETURNING student_id, score::text AS score`,
              [
                evaluation.id,
                actor.userId,
                toSet.map((row) => row.studentId),
                toSet.map((row) => String(row.score)),
              ],
            )
          : [];
        const removed = toRemove.length
          ? (
              await manager.query<[{ student_id: string }[], number]>(
                `DELETE FROM scores
                  WHERE evaluation_id = $1 AND student_id = ANY($2::uuid[])
                RETURNING student_id`,
                [evaluation.id, toRemove],
              )
            )[0]
          : [];

        const changes = [
          ...changed.map((r) => ({
            studentId: r.student_id,
            old: previous.get(r.student_id) ?? null,
            new: Number(r.score),
          })),
          ...removed.map((r) => ({
            studentId: r.student_id,
            old: previous.get(r.student_id) ?? null,
            new: null,
          })),
        ];
        // Por (estudiante, periodo), sin filtrar por curso: también el
        // boletín de antes de un cambio de curso (hallazgo M2 de la fase 10b).
        const outdatedIds = await markReportCardsOutdated(manager, {
          periodId: period.id,
          studentIds: changes.map((c) => c.studentId),
        });
        return {
          result: await this.toDto(manager, institution, evaluation),
          outdated: outdatedIds.length
            ? {
                audit: 'report-cards.outdated',
                reason: 'scores.changed',
                actorId: actor.userId,
                institutionId: actor.institutionId,
                evaluationId: evaluation.id,
                courseId: tsc.courseId,
                periodId: period.id,
                reportCardIds: outdatedIds,
              }
            : null,
          audit:
            reason && changes.length
              ? {
                  audit: 'scores.changed',
                  reason,
                  actorId: actor.userId,
                  institutionId: actor.institutionId,
                  evaluationId: evaluation.id,
                  teacherAssignmentId: tsc.id,
                  periodId: period.id,
                  changes,
                }
              : null,
        };
      },
    );
    // Después del commit: solo lo que de verdad cambió.
    if (audit) this.logger.log(JSON.stringify(audit));
    if (outdated) this.logger.log(JSON.stringify(outdated));
    return result;
  }

  /**
   * El administrador de la sede del curso siempre; el docente, solo en su
   * carga activa con el periodo en curso. Devuelve el motivo de auditoría
   * (null si es el docente de la carga en plazo).
   */
  private assertCanGrade(
    actor: EvaluationActor,
    isAdmin: boolean,
    tsc: TeacherSubjectCourseEntity,
    period: PeriodEntity,
  ): AuditReason | null {
    const yearActive = tsc.course.academicYear.isActive;
    const today = schoolToday();
    if (isAdmin) {
      if (!tsc.isActive) return 'inactive-assignment';
      if (!yearActive) return 'year-inactive';
      if (today > period.endDate) return 'period-ended';
      return actor.teacherId === tsc.teacherId ? null : 'not-own-assignment';
    }
    if (!tsc.isActive) {
      throw new ConflictException(
        'La carga académica no está activa: solo un administrador puede corregir sus notas',
      );
    }
    if (!yearActive) {
      throw new ForbiddenException(
        'El año lectivo está inactivo: solo un administrador puede modificar sus notas',
      );
    }
    if (today < period.startDate) {
      throw new ForbiddenException(
        'El periodo aún no ha empezado: las notas se registran mientras está en curso',
      );
    }
    if (today > period.endDate) {
      throw new ForbiddenException(
        'El periodo ya terminó: solo un administrador puede corregir sus notas',
      );
    }
    return null;
  }

  /**
   * Todo o nada: 400 con el error de cada fila inválida. Quitar la nota de
   * quien ya no está matriculado: solo el administrador (hallazgo B5).
   */
  private assertRows(
    dto: UpsertScoresDto,
    statusOf: Map<string, string>,
    previous: Map<string, number>,
    institution: InstitutionEntity,
    isAdmin: boolean,
  ): void {
    const { gradingScaleMin: min, gradingScaleMax: max } = institution;
    const seen = new Set<string>();
    const errors: string[] = [];
    dto.scores.forEach(({ studentId, score }, index) => {
      const fail = (message: string) =>
        errors.push(`scores[${index}] (${studentId}): ${message}`);
      if (seen.has(studentId)) {
        return fail('el estudiante está repetido en el lote');
      }
      seen.add(studentId);
      const enrolled = statusOf.get(studentId) === 'ENROLLED';
      if (score === null) {
        if (enrolled) return;
        if (!previous.has(studentId)) {
          return fail(
            'el estudiante no tiene nota ni matrícula vigente en el curso',
          );
        }
        if (!isAdmin) {
          fail(
            'el estudiante ya no tiene matrícula vigente: solo un administrador puede quitar su nota',
          );
        }
        return;
      }
      if (!enrolled) {
        return fail('el estudiante no tiene matrícula vigente en el curso');
      }
      if (score < min || score > max) {
        fail(`la nota debe estar entre ${min} y ${max}`);
      }
    });
    if (errors.length) throw new BadRequestException(errors);
  }

  /** Matriculados en el curso (cualquier estado) y quienes ya tienen nota. */
  private async toDto(
    manager: EntityManager,
    institution: InstitutionEntity,
    evaluation: EvaluationEntity,
  ): Promise<EvaluationScoresDto> {
    const rows = await manager.query<
      {
        studentId: string;
        firstName: string;
        lastName: string;
        enrollmentStatus: string | null;
        score: string | null;
        updatedAt: Date | null;
      }[]
    >(
      `SELECT st.id AS "studentId", u.first_name AS "firstName",
              u.last_name AS "lastName", en.status AS "enrollmentStatus",
              s.score::text AS score, s.updated_at AS "updatedAt"
         FROM students st
         JOIN users u ON u.id = st.user_id
         LEFT JOIN enrollments en
           ON en.student_id = st.id AND en.course_id = $1
         LEFT JOIN scores s
           ON s.student_id = st.id AND s.evaluation_id = $2
        WHERE st.institution_id = $3
          AND (en.id IS NOT NULL OR s.id IS NOT NULL)
        ORDER BY u.last_name, u.first_name, st.id`,
      [evaluation.teacherSubjectCourse.courseId, evaluation.id, institution.id],
    );
    const students: ScoreStudentDto[] = rows.map((row) => ({
      studentId: row.studentId,
      firstName: row.firstName,
      lastName: row.lastName,
      enrollmentStatus: row.enrollmentStatus,
      score: row.score === null ? null : Number(row.score),
      status: row.score === null ? 'PENDING' : 'GRADED',
      updatedAt: row.updatedAt,
    }));
    return {
      evaluation: EvaluationResponseDto.from(evaluation),
      scale: toScale(institution),
      students,
    };
  }
}
