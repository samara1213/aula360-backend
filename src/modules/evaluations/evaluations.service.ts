import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { schoolToday } from '../../common/utils/school-date';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { mapIntegrityError } from '../academic/academic.shared';
import { AcademicYearEntity } from '../academic/entities/academic-year.entity';
import { PeriodEntity } from '../academic/entities/period.entity';
import { TeacherSubjectCourseEntity } from '../academic/entities/teacher-subject-course.entity';
import {
  lockReportCards,
  markReportCardsOutdated,
} from '../reports/report-card-locks';
import {
  CreateEvaluationDto,
  EvaluationQueryDto,
  EvaluationResponseDto,
  UpdateEvaluationDto,
} from './dto/evaluation.dto';
import { EvaluationEntity } from './entities/evaluation.entity';
import {
  EvaluationAccessService,
  EvaluationActor,
} from './evaluation-access.service';

export const EVALUATIONS_PERMISSION = 'evaluations.evaluations';

/**
 * Evaluaciones de la carga académica en la institución activa.
 * - El docente actúa solo sobre su propia carga, en las sedes donde su rol
 *   TEACHER le da la acción, con el año lectivo activo y mientras el periodo
 *   no haya terminado (puede planear periodos futuros).
 * - El administrador (ver EvaluationAccessService) actúa en los cursos de
 *   sus sedes, también en periodos terminados o años inactivos.
 * - Bloqueos, siempre en este orden: usuario que actúa (FOR SHARE),
 *   evaluación (FOR NO KEY UPDATE; FOR UPDATE solo al borrarla), carga y su
 *   año, periodo (FOR SHARE), y el bloqueo por (curso, materia, periodo).
 *   Las notas (fase 9b) siguen el mismo orden. FOR NO KEY UPDATE no choca
 *   con el FOR KEY SHARE de las claves foráneas: borrar la carga o el
 *   periodo a la vez no forma un deadlock (hallazgo M3 de la fase 9b).
 * - Solo en cargas activas; en las inactivas (docente reemplazado) solo se
 *   consultan. La fecha va dentro del periodo, que es del año del curso.
 * - La suma de porcentajes por materia, curso y periodo (todas las cargas,
 *   también la del docente anterior) no supera 100; se serializa con un
 *   bloqueo exclusivo por (curso, materia, periodo) en la transacción.
 * - Una evaluación con notas no se borra (409).
 * - Cambiar el porcentaje cambia las notas del periodo: toma el bloqueo
 *   compartido de los boletines del curso y el periodo y los marca como
 *   desactualizados (fase 10b). Crear o borrar no: una evaluación nueva o
 *   sin notas no cambia ninguna definitiva ni acumulado.
 * - getVisible, lockAssignment y lockPeriod los usa también ScoresService.
 */
@Injectable()
export class EvaluationsService {
  private readonly logger = new Logger(EvaluationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: EvaluationAccessService,
  ) {}

  async findAll(
    user: AuthUser,
    query: EvaluationQueryDto,
  ): Promise<Paginated<EvaluationResponseDto>> {
    const actor = await this.access.resolve(
      user,
      EVALUATIONS_PERMISSION,
      'view',
    );
    const qb = this.baseQuery(this.dataSource.manager, actor);
    if (query.teacherAssignmentId) {
      qb.andWhere('e.teacher_subject_course_id = :tscId', {
        tscId: query.teacherAssignmentId,
      });
    }
    if (query.periodId) {
      qb.andWhere('e.period_id = :periodId', { periodId: query.periodId });
    }
    if (query.courseId) {
      qb.andWhere('t.course_id = :courseId', { courseId: query.courseId });
    }
    if (query.subjectId) {
      qb.andWhere('t.subject_id = :subjectId', { subjectId: query.subjectId });
    }
    qb.orderBy('p.startDate', 'ASC')
      .addOrderBy('e.evaluationDate', 'ASC')
      .addOrderBy('e.title', 'ASC')
      .addOrderBy('e.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => EvaluationResponseDto.from(row)),
      total,
      query,
    );
  }

  async findOne(user: AuthUser, id: string): Promise<EvaluationResponseDto> {
    const actor = await this.access.resolve(
      user,
      EVALUATIONS_PERMISSION,
      'view',
    );
    const manager = this.dataSource.manager;
    const row = await this.getVisible(manager, actor, id);
    return EvaluationResponseDto.from(
      row,
      await this.allocated(manager, row.teacherSubjectCourse, row.periodId),
    );
  }

  async create(
    user: AuthUser,
    dto: CreateEvaluationDto,
  ): Promise<EvaluationResponseDto> {
    return this.dataSource.transaction(async (manager) => {
      const actor = await this.access.resolve(
        user,
        EVALUATIONS_PERMISSION,
        'create',
        manager,
      );
      const tsc = await this.lockAssignment(
        manager,
        actor,
        dto.teacherAssignmentId,
      );
      const period = await this.lockPeriod(manager, actor, dto.periodId);
      if (period.academicYearId !== tsc.course.academicYearId) {
        throw new BadRequestException(
          'El periodo no es del año lectivo del curso',
        );
      }
      this.assertCanWrite(actor, tsc, period);
      this.assertDateInPeriod(dto.evaluationDate, period);
      await this.assertPercentage(manager, tsc, period.id, dto.percentage);
      const result = await manager.getRepository(EvaluationEntity).insert({
        teacherSubjectCourseId: tsc.id,
        periodId: period.id,
        title: dto.title,
        percentage: dto.percentage,
        evaluationDate: dto.evaluationDate,
      });
      const id = (result.identifiers[0] as { id: string }).id;
      const created = await this.getVisible(manager, actor, id);
      return EvaluationResponseDto.from(
        created,
        await this.allocated(manager, tsc, period.id),
      );
    });
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateEvaluationDto,
  ): Promise<EvaluationResponseDto> {
    rejectNullFields(dto, ['title', 'percentage', 'evaluationDate']);
    const { result, outdated } = await this.dataSource.transaction(
      async (manager) => {
        const actor = await this.access.resolve(
          user,
          EVALUATIONS_PERMISSION,
          'update',
          manager,
        );
        const evaluation = await this.getVisible(
          manager,
          actor,
          id,
          'no-key-update',
        );
        const tsc = await this.lockAssignment(
          manager,
          actor,
          evaluation.teacherSubjectCourseId,
        );
        const period = await this.lockPeriod(
          manager,
          actor,
          evaluation.periodId,
        );
        this.assertCanWrite(actor, tsc, period);
        const evaluationDate = dto.evaluationDate ?? evaluation.evaluationDate;
        this.assertDateInPeriod(evaluationDate, period);
        const percentageChanged =
          dto.percentage !== undefined &&
          dto.percentage !== evaluation.percentage;
        let outdatedIds: string[] = [];
        if (percentageChanged) {
          await this.assertPercentage(
            manager,
            tsc,
            period.id,
            dto.percentage!,
            evaluation.id,
          );
          await lockReportCards(manager, tsc.courseId, period.id, 'shared');
          outdatedIds = await markReportCardsOutdated(manager, {
            courseId: tsc.courseId,
            periodId: period.id,
          });
        }
        await manager.getRepository(EvaluationEntity).update(
          { id: evaluation.id },
          {
            title: dto.title ?? evaluation.title,
            percentage: dto.percentage ?? evaluation.percentage,
            evaluationDate,
          },
        );
        const updated = await this.getVisible(manager, actor, evaluation.id);
        return {
          result: EvaluationResponseDto.from(
            updated,
            await this.allocated(manager, tsc, period.id),
          ),
          outdated: outdatedIds.length
            ? {
                audit: 'report-cards.outdated',
                reason: 'evaluation.percentage-changed',
                actorId: actor.userId,
                institutionId: actor.institutionId,
                evaluationId: evaluation.id,
                courseId: tsc.courseId,
                periodId: period.id,
                reportCardIds: outdatedIds,
              }
            : null,
        };
      },
    );
    // Después del commit.
    if (outdated) this.logger.log(JSON.stringify(outdated));
    return result;
  }

  /** Solo sin notas registradas (409 si las tiene). */
  async remove(user: AuthUser, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const actor = await this.access.resolve(
        user,
        EVALUATIONS_PERMISSION,
        'delete',
        manager,
      );
      const evaluation = await this.getVisible(manager, actor, id, 'update');
      const tsc = await this.lockAssignment(
        manager,
        actor,
        evaluation.teacherSubjectCourseId,
      );
      const period = await this.lockPeriod(manager, actor, evaluation.periodId);
      this.assertCanWrite(actor, tsc, period);
      try {
        await manager
          .getRepository(EvaluationEntity)
          .delete({ id: evaluation.id });
      } catch (error) {
        throw mapIntegrityError(error, {
          duplicate: 'Conflicto al borrar la evaluación',
          inUse: 'La evaluación tiene notas registradas: no se puede borrar',
        });
      }
    });
  }

  /**
   * El docente: solo su carga y con el periodo sin terminar (fecha de
   * Colombia). El administrador de la sede del curso: siempre.
   */
  private assertCanWrite(
    actor: EvaluationActor,
    tsc: TeacherSubjectCourseEntity,
    period: PeriodEntity,
  ): void {
    if (this.access.isAdminOf(actor, tsc.course.campusId)) return;
    if (!tsc.course.academicYear.isActive) {
      throw new ForbiddenException(
        'El año lectivo está inactivo: solo un administrador puede modificar sus evaluaciones',
      );
    }
    if (schoolToday() > period.endDate) {
      throw new ForbiddenException(
        'El periodo ya terminó: solo un administrador puede modificar sus evaluaciones',
      );
    }
  }

  private assertDateInPeriod(date: string, period: PeriodEntity): void {
    // Fechas 'YYYY-MM-DD': el orden de texto es el cronológico.
    if (date < period.startDate || date > period.endDate) {
      throw new BadRequestException(
        `La fecha de la evaluación debe estar dentro del periodo (${period.startDate} a ${period.endDate})`,
      );
    }
  }

  /**
   * Suma de porcentajes de la materia en el curso y el periodo (todas sus
   * cargas) + el nuevo <= 100, con aritmética NUMERIC (exacta). El bloqueo
   * exclusivo por (curso, materia, periodo) dura hasta el fin de la
   * transacción: dos altas simultáneas no pueden pasar de 100.
   */
  private async assertPercentage(
    manager: EntityManager,
    tsc: TeacherSubjectCourseEntity,
    periodId: string,
    percentage: number,
    excludeId: string | null = null,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`evaluations:${tsc.courseId}:${tsc.subjectId}:${periodId}`],
    );
    const [row] = await manager.query<{ used: string; exceeds: boolean }[]>(
      `SELECT COALESCE(SUM(e.percentage), 0)::text AS used,
              COALESCE(SUM(e.percentage), 0) + $4::numeric > 100 AS exceeds
         FROM evaluations e
         JOIN teacher_subject_courses t ON t.id = e.teacher_subject_course_id
        WHERE t.course_id = $1 AND t.subject_id = $2 AND e.period_id = $3
          AND ($5::uuid IS NULL OR e.id <> $5::uuid)`,
      [tsc.courseId, tsc.subjectId, periodId, String(percentage), excludeId],
    );
    if (row.exceeds) {
      throw new ConflictException(
        `La suma de porcentajes de la materia en el periodo superaría 100 (ya asignado: ${Number(row.used)}%)`,
      );
    }
  }

  private async allocated(
    manager: EntityManager,
    tsc: Pick<TeacherSubjectCourseEntity, 'courseId' | 'subjectId'>,
    periodId: string,
  ): Promise<number> {
    const [row] = await manager.query<{ used: string }[]>(
      `SELECT COALESCE(SUM(e.percentage), 0)::text AS used
         FROM evaluations e
         JOIN teacher_subject_courses t ON t.id = e.teacher_subject_course_id
        WHERE t.course_id = $1 AND t.subject_id = $2 AND e.period_id = $3`,
      [tsc.courseId, tsc.subjectId, periodId],
    );
    return Number(row.used);
  }

  /**
   * Carga visible para quien actúa (institución + sede que administra o su
   * propia carga), leída FOR SHARE junto con su año: no se reemplaza ni
   * termina, ni el año se desactiva, mientras tanto (hallazgo B3 de la fase
   * 9b). Debe estar activa (en las inactivas solo se consulta), salvo con
   * allowInactive: quien llama decide (las notas, solo el administrador).
   */
  async lockAssignment(
    manager: EntityManager,
    actor: EvaluationActor,
    id: string,
    { allowInactive = false }: { allowInactive?: boolean } = {},
  ): Promise<TeacherSubjectCourseEntity> {
    const { sql, params } = this.access.visibility(actor);
    const tsc = await manager
      .getRepository(TeacherSubjectCourseEntity)
      .createQueryBuilder('t')
      .innerJoinAndSelect('t.course', 'c')
      .innerJoinAndSelect('c.academicYear', 'y')
      .innerJoin('c.grade', 'g')
      .where('t.id = :id AND g.institution_id = :institutionId', {
        id,
        institutionId: actor.institutionId,
      })
      .andWhere(sql, params)
      .setLock('pessimistic_read', undefined, ['t', 'y'])
      .getOne();
    if (!tsc) throw new NotFoundException('Carga académica no encontrada');
    if (!tsc.isActive && !allowInactive) {
      throw new ConflictException(
        'La carga académica no está activa: sus evaluaciones solo se consultan',
      );
    }
    return tsc;
  }

  /** Periodo de la institución, FOR SHARE: sus fechas no cambian mientras tanto. */
  async lockPeriod(
    manager: EntityManager,
    actor: EvaluationActor,
    id: string,
  ): Promise<PeriodEntity> {
    const period = await manager
      .getRepository(PeriodEntity)
      .createQueryBuilder('p')
      .innerJoin(
        AcademicYearEntity,
        'y',
        'y.id = p.academic_year_id AND y.institution_id = :institutionId',
        { institutionId: actor.institutionId },
      )
      .where('p.id = :id', { id })
      .setLock('pessimistic_read', undefined, ['p'])
      .getOne();
    if (!period) throw new NotFoundException('Periodo no encontrado');
    return period;
  }

  async getVisible(
    manager: EntityManager,
    actor: EvaluationActor,
    id: string,
    lock: false | 'update' | 'no-key-update' = false,
  ): Promise<EvaluationEntity> {
    const qb = this.baseQuery(manager, actor).andWhere('e.id = :id', { id });
    if (lock) {
      qb.setLock(
        lock === 'update' ? 'pessimistic_write' : 'for_no_key_update',
        undefined,
        ['e'],
      );
    }
    const row = await qb.getOne();
    if (!row) throw new NotFoundException('Evaluación no encontrada');
    return row;
  }

  /** Evaluaciones de la institución visibles para quien actúa. */
  private baseQuery(
    manager: EntityManager,
    actor: EvaluationActor,
  ): SelectQueryBuilder<EvaluationEntity> {
    const { sql, params } = this.access.visibility(actor);
    return manager
      .getRepository(EvaluationEntity)
      .createQueryBuilder('e')
      .innerJoinAndSelect('e.period', 'p')
      .innerJoinAndSelect('e.teacherSubjectCourse', 't')
      .innerJoinAndSelect('t.course', 'c')
      .innerJoin('c.grade', 'g')
      .innerJoinAndSelect('t.subject', 'sub')
      .innerJoinAndSelect('t.teacher', 'te')
      .innerJoinAndSelect('te.user', 'u')
      .where('g.institution_id = :institutionId', {
        institutionId: actor.institutionId,
      })
      .andWhere(sql, params);
  }
}
