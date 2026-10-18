import {
  ConflictException,
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
import { activeInstitutionId } from '../../common/utils/active-institution';
import { schoolToday } from '../../common/utils/school-date';
import { SIGNED_URL_TTL_SECONDS } from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import { AcademicYearEntity } from '../academic/entities/academic-year.entity';
import { CourseEntity } from '../academic/entities/course.entity';
import { PeriodEntity } from '../academic/entities/period.entity';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import {
  EvaluationAccessService,
  EvaluationActor,
} from '../evaluations/evaluation-access.service';
import { average2, GradebookService } from '../evaluations/gradebook.service';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { StudentEntity } from '../users/entities/student.entity';
import {
  GenerateReportCardDto,
  OwnReportCardDto,
  ReportCardDownloadDto,
  ReportCardQueryDto,
  ReportCardResponseDto,
} from './dto/report-card.dto';
import { PerformanceLevelEntity } from './entities/performance-level.entity';
import { ReportCardTemplateEntity } from './entities/report-card-template.entity';
import { ReportCardEntity } from './entities/report-card.entity';
import { levelFor } from './performance-levels.rules';
import { lockReportCards } from './report-card-locks';
import { ReportCardTemplateData } from './report-template.engine';
import { PdfRendererService } from './pdf-renderer.service';
import { ReportTemplatesService } from './report-templates.service';

export const REPORT_CARDS_PERMISSION = 'reports.report-cards';
const BUCKET = 'report-cards';

/** Lo que muestra un boletín, leído de la base (sin logo ni fecha). */
interface Snapshot {
  institutionId: string;
  student: StudentEntity;
  course: CourseEntity;
  period: PeriodEntity;
  data: Omit<ReportCardTemplateData, 'generatedAt'>;
  pending: string[];
  finalAverage: number | null;
}

/**
 * Boletines por estudiante y periodo (permiso reports.report-cards).
 * - Genera y consulta el administrador de la sede del curso (ver
 *   EvaluationAccessService); el estudiante, los suyos; a cualquier otro,
 *   404. El docente no: el boletín trae todas las materias y en el cuadro de
 *   notas solo ve las suyas (hallazgo M1 de la fase 10b).
 * - Los datos son los del cuadro de notas (GradebookService), con el nivel de
 *   desempeño y el docente activo de cada materia. Sin ninguna definitiva,
 *   409; con materias pendientes, 409 salvo force (promedio parcial).
 * - El PDF se imprime sin transacción ni bloqueos (no ocupa una conexión
 *   mientras espera a Chromium) y se sube con nombre UUID. Luego, en una
 *   transacción corta con el bloqueo exclusivo del curso y el periodo (las
 *   notas y los porcentajes toman el compartido), se vuelven a leer los
 *   datos y la plantilla activa (FOR SHARE): si algo cambió, 409 y el PDF
 *   se borra; si no, upsert por (estudiante, periodo) y outdated_at = null.
 *   El PDF anterior se borra después del commit.
 * - Quedan desactualizados (outdated_at) al cambiar notas, porcentajes, las
 *   materias del curso, el curso de la matrícula o los niveles de desempeño
 *   (ver report-card-locks.ts). La escala no cambia con notas registradas.
 *   No marcan, porque no cambian notas ni resultados: el nombre o el logo de
 *   la institución, el nombre o el documento del estudiante y el docente
 *   impreso (hallazgo B7 de la fase 10b); basta regenerar.
 * - Descarga con URL firmada de corta vida; generar y descargar quedan en la
 *   auditoría (log JSON).
 */
@Injectable()
export class ReportCardsService {
  private readonly logger = new Logger(ReportCardsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: EvaluationAccessService,
    private readonly gradebook: GradebookService,
    private readonly templates: ReportTemplatesService,
    private readonly renderer: PdfRendererService,
    private readonly storage: StorageService,
  ) {}

  async generate(
    user: AuthUser,
    dto: GenerateReportCardDto,
  ): Promise<ReportCardResponseDto> {
    const force = dto.force ?? false;
    const actor = await this.access.resolve(
      user,
      REPORT_CARDS_PERMISSION,
      'create',
    );
    const manager = this.dataSource.manager;
    const first = await this.snapshot(manager, actor, dto, false);
    this.assertComplete(first, force);
    const template = await this.templates.resolveActive(
      manager,
      actor.institutionId,
    );
    const institution = await manager
      .getRepository(InstitutionEntity)
      .findOneByOrFail({ id: actor.institutionId });
    const html = template.render({
      ...first.data,
      institution: {
        ...first.data.institution,
        logoDataUri: await this.templates.logoDataUri(institution),
      },
      generatedAt: schoolToday(),
    });
    const pdf = await this.renderer.render(html);
    const pdfPath = await this.storage.upload(
      BUCKET,
      `${actor.institutionId}/report-cards`,
      { buffer: pdf, mimeType: 'application/pdf', extension: 'pdf' },
    );

    let saved: { card: ReportCardEntity; previousPath: string | null };
    try {
      saved = await this.dataSource.transaction(async (tx) => {
        const locked = await this.access.resolve(
          user,
          REPORT_CARDS_PERMISSION,
          'create',
          tx,
        );
        const current = await this.snapshot(tx, locked, dto, true);
        if (fingerprint(current) !== fingerprint(first)) {
          throw new ConflictException(
            'Las notas cambiaron mientras se generaba el boletín: intente de nuevo',
          );
        }
        const active = await tx
          .getRepository(ReportCardTemplateEntity)
          .findOne({
            select: { id: true },
            where: { institutionId: locked.institutionId, isActive: true },
            lock: { mode: 'pessimistic_read' },
          });
        if ((active?.id ?? null) !== template.templateId) {
          throw new ConflictException(
            'La plantilla activa cambió mientras se generaba el boletín: intente de nuevo',
          );
        }
        return this.save(tx, current, pdfPath, template.templateId, user);
      });
    } catch (error) {
      await this.discardUpload(pdfPath);
      throw error;
    }
    if (saved.previousPath) {
      await this.storage.removeQuietly(BUCKET, saved.previousPath);
    }
    this.logger.log(
      JSON.stringify({
        audit: 'report-card.generated',
        actorId: user.userId,
        institutionId: actor.institutionId,
        reportCardId: saved.card.id,
        studentId: first.student.id,
        courseId: first.course.id,
        periodId: first.period.id,
        templateId: template.templateId,
        pendingSubjects: first.pending.length,
        regenerated: saved.previousPath !== null,
      }),
    );
    return ReportCardResponseDto.from(saved.card);
  }

  /**
   * Borra el PDF recién subido si la fila no lo usa: si el COMMIT se
   * confirmó pero la respuesta se perdió, el archivo sí está guardado
   * (hallazgo B3 de la fase 10b).
   */
  private async discardUpload(pdfPath: string): Promise<void> {
    try {
      const used = await this.dataSource
        .getRepository(ReportCardEntity)
        .existsBy({ pdfPath });
      if (used) return;
    } catch {
      return; // Sin base no se sabe: mejor un archivo huérfano que un boletín roto.
    }
    await this.storage.removeQuietly(BUCKET, pdfPath);
  }

  async findAll(
    user: AuthUser,
    query: ReportCardQueryDto,
  ): Promise<Paginated<ReportCardResponseDto>> {
    const actor = await this.access.resolve(
      user,
      REPORT_CARDS_PERMISSION,
      'view',
    );
    const { sql, params } = this.access.adminCourseVisibility(actor);
    const qb = this.baseQuery(this.dataSource.manager, actor.institutionId)
      .andWhere(sql, params)
      .orderBy('p.startDate', 'DESC')
      .addOrderBy('c.name', 'ASC')
      .addOrderBy('u.lastName', 'ASC')
      .addOrderBy('u.firstName', 'ASC')
      .addOrderBy('r.id', 'ASC');
    if (query.courseId) {
      qb.andWhere('r.course_id = :courseId', { courseId: query.courseId });
    }
    if (query.periodId) {
      qb.andWhere('r.period_id = :periodId', { periodId: query.periodId });
    }
    if (query.studentId) {
      qb.andWhere('r.student_id = :studentId', { studentId: query.studentId });
    }
    if (query.outdated !== undefined) {
      qb.andWhere(
        query.outdated ? 'r.outdated_at IS NOT NULL' : 'r.outdated_at IS NULL',
      );
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => ReportCardResponseDto.from(row)),
      total,
      query,
    );
  }

  /** Los boletines propios del estudiante, en la institución activa. */
  async mine(user: AuthUser): Promise<OwnReportCardDto[]> {
    const institutionId = activeInstitutionId(user);
    const manager = this.dataSource.manager;
    const student = await this.ownStudent(manager, user, institutionId);
    if (!student) {
      throw new NotFoundException(
        'No tiene perfil de estudiante en esta institución',
      );
    }
    const rows = await this.baseQuery(manager, institutionId)
      .andWhere('r.student_id = :studentId', { studentId: student.id })
      .orderBy('p.startDate', 'DESC')
      .addOrderBy('r.id', 'ASC')
      .getMany();
    return rows.map((row) => OwnReportCardDto.from(row));
  }

  /** URL firmada del PDF: el propio estudiante o el administrador. */
  async download(user: AuthUser, id: string): Promise<ReportCardDownloadDto> {
    const institutionId = activeInstitutionId(user);
    const manager = this.dataSource.manager;
    const student = await this.ownStudent(manager, user, institutionId);
    let card = student
      ? await this.baseQuery(manager, institutionId)
          .andWhere('r.id = :id AND r.student_id = :studentId', {
            id,
            studentId: student.id,
          })
          .getOne()
      : null;
    const own = card !== null;
    if (!card) {
      const actor = await this.access.resolve(
        user,
        REPORT_CARDS_PERMISSION,
        'view',
      );
      const { sql, params } = this.access.adminCourseVisibility(actor);
      card = await this.baseQuery(manager, institutionId)
        .andWhere('r.id = :id', { id })
        .andWhere(sql, params)
        .getOne();
    }
    if (!card?.pdfPath) throw new NotFoundException('Boletín no encontrado');
    const url = await this.storage.createSignedUrl(
      BUCKET,
      card.pdfPath,
      SIGNED_URL_TTL_SECONDS,
    );
    this.logger.log(
      JSON.stringify({
        audit: 'report-card.downloaded',
        actorId: user.userId,
        institutionId,
        reportCardId: card.id,
        studentId: card.studentId,
        own,
      }),
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /**
   * Lee lo que mostrará el boletín. Con locked (dentro de la transacción):
   * el periodo FOR SHARE, el bloqueo exclusivo del curso y el periodo, y la
   * institución FOR SHARE (la escala y los niveles no cambian mientras
   * tanto), antes de leer las notas. La matrícula no se bloquea (formaría un
   * ciclo con las matrículas): se relee tras el bloqueo, que el cambio de
   * curso también toma (compartido), y si cambió, 409. 404 sin oráculo si el estudiante no
   * existe, no tiene matrícula en el año del periodo o su curso no es de una
   * sede que administra.
   */
  private async snapshot(
    manager: EntityManager,
    actor: EvaluationActor,
    dto: GenerateReportCardDto,
    locked: boolean,
  ): Promise<Snapshot> {
    const notFound = () =>
      new NotFoundException(
        'Estudiante no encontrado o sin matrícula en el año del periodo',
      );
    const { institutionId } = actor;
    const periodQuery = manager
      .getRepository(PeriodEntity)
      .createQueryBuilder('p')
      .innerJoin(
        AcademicYearEntity,
        'y',
        'y.id = p.academic_year_id AND y.institution_id = :institutionId',
        { institutionId },
      )
      .where('p.id = :id', { id: dto.periodId });
    if (locked) periodQuery.setLock('pessimistic_read', undefined, ['p']);
    const period = await periodQuery.getOne();
    if (!period) throw new NotFoundException('Periodo no encontrado');
    const student = await manager.getRepository(StudentEntity).findOne({
      where: { id: dto.studentId, institutionId },
      relations: { user: true },
    });
    if (!student) throw notFound();
    const enrollment = await manager.getRepository(EnrollmentEntity).findOneBy({
      studentId: student.id,
      academicYearId: period.academicYearId,
    });
    if (!enrollment) throw notFound();
    const course = await manager
      .getRepository(CourseEntity)
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.grade', 'g')
      .innerJoinAndSelect('c.campus', 'cp')
      .innerJoinAndSelect('c.academicYear', 'y')
      .where('c.id = :id', { id: enrollment.courseId })
      .getOneOrFail();
    if (!this.access.isAdminOf(actor, course.campusId)) throw notFound();
    if (locked) {
      await lockReportCards(manager, course.id, period.id, 'exclusive');
      const again = await manager
        .getRepository(EnrollmentEntity)
        .findOneBy({ id: enrollment.id });
      if (again?.courseId !== course.id) {
        throw new ConflictException(
          'La matrícula cambió mientras se generaba el boletín: intente de nuevo',
        );
      }
    }

    const institution = await manager
      .getRepository(InstitutionEntity)
      .findOneOrFail({
        where: { id: institutionId },
        ...(locked ? { lock: { mode: 'pessimistic_read' as const } } : {}),
      });
    const levels = await manager.getRepository(PerformanceLevelEntity).find({
      where: { institutionId },
      order: { minScore: 'ASC' },
    });
    const grades = await this.gradebook.periodGrades(
      manager,
      course.id,
      student.id,
      period.id,
      institution.passingScore,
    );
    const teachers = await this.activeTeachers(manager, course.id);
    const levelRefs = levels.map((l) => ({
      name: l.name,
      minScore: l.minScore,
      maxScore: l.maxScore,
    }));
    const subjects = grades.map((g) => ({
      name: g.name,
      teacher: teachers.get(g.id) ?? null,
      final: g.final,
      accumulated: g.accumulated,
      pending: g.final === null,
      level: levelFor(levelRefs, g.final),
      passed: g.passed,
    }));
    const finalAverage = average2(
      subjects.map((s) => s.final).filter((v): v is number => v !== null),
    );
    const pending = subjects.filter((s) => s.pending).map((s) => s.name);
    return {
      institutionId,
      student,
      course,
      period,
      pending,
      finalAverage,
      data: {
        institution: {
          name: institution.name,
          nit: institution.nit,
          logoDataUri: null,
        },
        campus: { name: course.campus.name },
        academicYear: { year: course.academicYear.year },
        period: {
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate,
        },
        course: { name: course.name, grade: course.grade.name },
        student: {
          firstName: student.user.firstName,
          lastName: student.user.lastName,
          documentType: student.user.documentType,
          documentNumber: student.user.documentNumber,
        },
        subjects,
        average: finalAverage,
        averageLevel: levelFor(levelRefs, finalAverage),
        averagePartial: pending.length > 0,
        scale: {
          min: institution.gradingScaleMin,
          max: institution.gradingScaleMax,
          passingScore: institution.passingScore,
        },
        levels: levelRefs,
      },
    };
  }

  /** Sin ninguna definitiva, siempre 409; con pendientes, 409 salvo force. */
  private assertComplete(snapshot: Snapshot, force: boolean): void {
    if (snapshot.finalAverage === null) {
      throw new ConflictException(
        'El estudiante no tiene ninguna definitiva en el periodo: no se puede generar el boletín',
      );
    }
    if (snapshot.pending.length && !force) {
      throw new ConflictException(
        `Faltan definitivas en: ${snapshot.pending.join(', ')}. Use force para generarlo con esas materias pendientes`,
      );
    }
  }

  /** Upsert por (estudiante, periodo); devuelve la ruta del PDF anterior. */
  private async save(
    manager: EntityManager,
    snapshot: Snapshot,
    pdfPath: string,
    templateId: string | null,
    user: AuthUser,
  ): Promise<{ card: ReportCardEntity; previousPath: string | null }> {
    const repo = manager.getRepository(ReportCardEntity);
    const previous = await repo.findOne({
      select: { id: true, pdfPath: true },
      where: { studentId: snapshot.student.id, periodId: snapshot.period.id },
      lock: { mode: 'pessimistic_write' },
    });
    const [{ id }] = await manager.query<{ id: string }[]>(
      `INSERT INTO report_cards (student_id, period_id, course_id, final_average,
                                 pdf_path, template_id, generated_by, outdated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (student_id, period_id) DO UPDATE
          SET course_id = EXCLUDED.course_id,
              final_average = EXCLUDED.final_average,
              pdf_path = EXCLUDED.pdf_path,
              template_id = EXCLUDED.template_id,
              generated_by = EXCLUDED.generated_by,
              outdated_at = NULL,
              updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        snapshot.student.id,
        snapshot.period.id,
        snapshot.course.id,
        String(snapshot.finalAverage),
        pdfPath,
        templateId,
        user.userId,
      ],
    );
    const card = await this.baseQuery(manager, snapshot.institutionId)
      .andWhere('r.id = :id', { id })
      .getOneOrFail();
    return { card, previousPath: previous?.pdfPath ?? null };
  }

  /** Docente de la carga activa de cada materia del curso. */
  private async activeTeachers(
    manager: EntityManager,
    courseId: string,
  ): Promise<Map<string, string>> {
    const rows = await manager.query<{ subjectId: string; name: string }[]>(
      `SELECT DISTINCT ON (t.subject_id) t.subject_id AS "subjectId",
              u.first_name || ' ' || u.last_name AS name
         FROM teacher_subject_courses t
         JOIN teachers te ON te.id = t.teacher_id
         JOIN users u ON u.id = te.user_id
        WHERE t.course_id = $1 AND t.is_active = true
        ORDER BY t.subject_id, t.created_at DESC, t.id`,
      [courseId],
    );
    return new Map(rows.map((row) => [row.subjectId, row.name]));
  }

  private ownStudent(
    manager: EntityManager,
    user: AuthUser,
    institutionId: string,
  ): Promise<StudentEntity | null> {
    return manager
      .getRepository(StudentEntity)
      .findOneBy({ userId: user.userId, institutionId });
  }

  /** Boletines de la institución (por la del curso), con sus datos básicos. */
  private baseQuery(
    manager: EntityManager,
    institutionId: string,
  ): SelectQueryBuilder<ReportCardEntity> {
    return manager
      .getRepository(ReportCardEntity)
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.student', 's')
      .innerJoinAndSelect('s.user', 'u')
      .innerJoinAndSelect('r.course', 'c')
      .innerJoin('c.grade', 'g')
      .innerJoinAndSelect('r.period', 'p')
      .where('g.institution_id = :institutionId', { institutionId });
  }
}

/** Lo que importa comparar entre la lectura previa y la de la transacción. */
function fingerprint(snapshot: Snapshot): string {
  return JSON.stringify({
    courseId: snapshot.course.id,
    finalAverage: snapshot.finalAverage,
    data: snapshot.data,
  });
}
