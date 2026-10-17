import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { AcademicYearEntity } from '../academic/entities/academic-year.entity';
import { CourseEntity } from '../academic/entities/course.entity';
import { PeriodEntity } from '../academic/entities/period.entity';
import { TeacherSubjectCourseEntity } from '../academic/entities/teacher-subject-course.entity';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { StudentEntity } from '../users/entities/student.entity';
import {
  CourseGradebookDto,
  GradebookSubjectDto,
  StudentEvaluationScoreDto,
  StudentGradebookDto,
  StudentGradebookQueryDto,
  StudentSubjectGradesDto,
  SubjectPeriodGradeDto,
} from './dto/gradebook.dto';
import {
  EvaluationAccessService,
  EvaluationActor,
} from './evaluation-access.service';
import { SCORES_PERMISSION, toScale } from './scores.service';

/**
 * Promedio simple de notas con 2 decimales, exacto (en centésimas enteras) y
 * redondeado a 2 decimales (mitad hacia arriba). null si no hay ninguna.
 */
export function average2(values: number[]): number | null {
  if (!values.length) return null;
  const cents = values.reduce((sum, v) => sum + Math.round(v * 100), 0);
  return Math.round(cents / values.length) / 100;
}

interface GradeRow {
  studentId: string;
  subjectId: string;
  periodId: string;
  evaluationCount: number;
  scoredCount: number;
  allocated: string;
  accumulated: string;
  final: string | null;
}

const EMPTY_GRADE = {
  evaluationCount: 0,
  scoredCount: 0,
  allocatedPercentage: 0,
  accumulated: 0,
  final: null,
  passed: null,
};

const periodDto = (p: PeriodEntity) => ({
  id: p.id,
  name: p.name,
  startDate: p.startDate,
  endDate: p.endDate,
});

/**
 * Cuadro de notas y promedios (permiso evaluations.scores, consulta):
 * - Acumulado = suma de nota × porcentaje / 100 de las notas registradas.
 * - Definitiva del periodo: solo si los porcentajes de la materia suman 100
 *   y están todas las notas; aprueba si >= passing_score de la institución.
 * - Todo en NUMERIC en SQL; la definitiva se redondea a 2 decimales y los
 *   promedios (del periodo y anual, simples) se calculan sobre esas
 *   definitivas, que son las que ve el estudiante.
 * - Nota anual de la materia: promedio de sus definitivas de todos los
 *   periodos del año; null si falta alguna.
 * - Visibilidad como en las evaluaciones: el administrador de la sede del
 *   curso ve todas las materias; el docente, solo las de su carga activa
 *   (reemplazado, consulta sus notas en /evaluations/:id/scores).
 */
@Injectable()
export class GradebookService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: EvaluationAccessService,
  ) {}

  async course(
    user: AuthUser,
    courseId: string,
    periodId: string,
  ): Promise<CourseGradebookDto> {
    const actor = await this.access.resolve(user, SCORES_PERMISSION, 'view');
    const manager = this.dataSource.manager;
    const course = await this.findCourse(
      manager,
      actor.institutionId,
      courseId,
    );
    const subjects = await this.visibleSubjects(manager, actor, course.id);
    if (!subjects.length && !this.access.isAdminOf(actor, course.campusId)) {
      throw new NotFoundException('Curso no encontrado');
    }
    const period = await this.findPeriod(
      manager,
      actor.institutionId,
      periodId,
    );
    if (period.academicYearId !== course.academicYearId) {
      throw new BadRequestException(
        'El periodo no es del año lectivo del curso',
      );
    }
    const enrollments = await manager
      .getRepository(EnrollmentEntity)
      .createQueryBuilder('e')
      .innerJoinAndSelect('e.student', 's')
      .innerJoinAndSelect('s.user', 'u')
      .where('e.course_id = :courseId', { courseId: course.id })
      .orderBy('u.lastName', 'ASC')
      .addOrderBy('u.firstName', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .getMany();
    const institution = await this.institution(manager, actor.institutionId);
    const grades = await this.grades(
      manager,
      course.id,
      subjects.map((s) => s.id),
      [period.id],
      enrollments.map((e) => e.studentId),
      institution.passingScore,
    );
    return {
      course: { id: course.id, name: course.name },
      period: periodDto(period),
      scale: toScale(institution),
      subjects,
      students: enrollments.map((e) => {
        const subjectGrades = subjects.map((subject) => ({
          subjectId: subject.id,
          ...grades.get(e.studentId, subject.id, period.id),
        }));
        return {
          student: {
            id: e.student.id,
            firstName: e.student.user.firstName,
            lastName: e.student.user.lastName,
          },
          enrollmentStatus: e.status,
          subjects: subjectGrades,
          average: average2(finals(subjectGrades)),
        };
      }),
    };
  }

  /**
   * Notas de un estudiante: lo ve el administrador de su sede o un docente
   * con carga en algún curso donde está matriculado (si no, 404).
   */
  async student(
    user: AuthUser,
    studentId: string,
    query: StudentGradebookQueryDto,
  ): Promise<StudentGradebookDto> {
    const actor = await this.access.resolve(user, SCORES_PERMISSION, 'view');
    const manager = this.dataSource.manager;
    const student = await manager.getRepository(StudentEntity).findOne({
      where: { id: studentId, institutionId: actor.institutionId },
      relations: { user: true },
    });
    if (!student || !(await this.canSeeStudent(manager, actor, student))) {
      throw new NotFoundException('Estudiante no encontrado');
    }
    return this.studentGradebook(manager, actor, student, query, false);
  }

  /** Las notas propias del estudiante, en la institución activa. */
  async mine(
    user: AuthUser,
    query: StudentGradebookQueryDto,
  ): Promise<StudentGradebookDto> {
    const institutionId = activeInstitutionId(user);
    const manager = this.dataSource.manager;
    const student = await manager.getRepository(StudentEntity).findOne({
      where: { userId: user.userId, institutionId },
      relations: { user: true },
    });
    if (!student) {
      throw new NotFoundException(
        'No tiene perfil de estudiante en esta institución',
      );
    }
    return this.studentGradebook(manager, null, student, query, true);
  }

  /** actor null = el propio estudiante: todas las materias de su curso. */
  private async studentGradebook(
    manager: EntityManager,
    actor: EvaluationActor | null,
    student: StudentEntity,
    query: StudentGradebookQueryDto,
    own: boolean,
  ): Promise<StudentGradebookDto> {
    const { institutionId } = student;
    if (query.periodId && query.academicYearId) {
      throw new BadRequestException('Use periodId o academicYearId, no ambos');
    }
    let year: AcademicYearEntity | null;
    let periods: PeriodEntity[];
    const yearRepo = manager.getRepository(AcademicYearEntity);
    if (query.periodId) {
      const period = await this.findPeriod(
        manager,
        institutionId,
        query.periodId,
      );
      year = await yearRepo.findOneByOrFail({ id: period.academicYearId });
      periods = [period];
    } else {
      year = query.academicYearId
        ? await yearRepo.findOneBy({
            id: query.academicYearId,
            institutionId,
          })
        : await this.latestActiveYear(manager, student.id);
      if (!year) {
        throw new NotFoundException(
          query.academicYearId
            ? 'Año lectivo no encontrado'
            : 'Sin matrícula en un año lectivo activo',
        );
      }
      periods = await manager.getRepository(PeriodEntity).find({
        where: { academicYearId: year.id },
        order: { startDate: 'ASC', id: 'ASC' },
      });
    }
    const enrollment = await manager.getRepository(EnrollmentEntity).findOne({
      where: { studentId: student.id, academicYearId: year.id },
      relations: { course: true },
    });
    if (!enrollment) {
      throw new NotFoundException(
        own
          ? 'Sin matrícula en ese año lectivo'
          : 'El estudiante no tiene matrícula en ese año lectivo',
      );
    }
    const course = enrollment.course;
    const subjects = actor
      ? await this.visibleSubjects(manager, actor, course.id)
      : await this.courseSubjects(manager, course.id);
    if (
      actor &&
      !subjects.length &&
      !this.access.isAdminOf(actor, course.campusId)
    ) {
      throw new NotFoundException('Estudiante no encontrado');
    }
    const institution = await this.institution(manager, institutionId);
    const periodIds = periods.map((p) => p.id);
    const subjectIds = subjects.map((s) => s.id);
    const grades = await this.grades(
      manager,
      course.id,
      subjectIds,
      periodIds,
      [student.id],
      institution.passingScore,
    );
    const evaluations = await this.evaluationScores(
      manager,
      course.id,
      subjectIds,
      periodIds,
      student.id,
    );
    const byYear = !query.periodId;
    const passing = institution.passingScore;
    const subjectRows = subjects.map((subject): StudentSubjectGradesDto => {
      const rows = periods.map((p) => ({
        periodId: p.id,
        ...grades.get(student.id, subject.id, p.id),
        evaluations: evaluations.get(`${subject.id}:${p.id}`) ?? [],
      }));
      if (!byYear) return { ...subject, periods: rows };
      const values = finals(rows);
      const yearFinal =
        periods.length && values.length === periods.length
          ? average2(values)
          : null;
      return {
        ...subject,
        periods: rows,
        yearFinal,
        yearPassed: yearFinal === null ? null : yearFinal >= passing,
      };
    });
    return {
      student: {
        id: student.id,
        firstName: student.user.firstName,
        lastName: student.user.lastName,
      },
      enrollmentStatus: enrollment.status,
      course: { id: course.id, name: course.name },
      academicYear: { id: year.id, year: year.year, isActive: year.isActive },
      scale: toScale(institution),
      periods: periods.map(periodDto),
      subjects: subjectRows,
      periodAverages: periods.map((p, i) => ({
        periodId: p.id,
        average: average2(finals(subjectRows.map((s) => s.periods[i]))),
      })),
      ...(byYear
        ? {
            yearAverage: average2(
              subjectRows
                .map((s) => s.yearFinal)
                .filter((v): v is number => v !== null && v !== undefined),
            ),
          }
        : {}),
    };
  }

  /**
   * Notas por (estudiante, materia, periodo), en NUMERIC. Cada estudiante
   * cuenta en todas las evaluaciones de la materia en el curso (de todas sus
   * cargas, también la del docente anterior).
   */
  private async grades(
    manager: EntityManager,
    courseId: string,
    subjectIds: string[],
    periodIds: string[],
    studentIds: string[],
    passingScore: number,
  ) {
    const rows =
      subjectIds.length && periodIds.length && studentIds.length
        ? await manager.query<GradeRow[]>(
            `WITH ev AS (
               SELECT e.id, e.period_id, t.subject_id, e.percentage
                 FROM evaluations e
                 JOIN teacher_subject_courses t
                   ON t.id = e.teacher_subject_course_id
                WHERE t.course_id = $1
                  AND t.subject_id = ANY($2::uuid[])
                  AND e.period_id = ANY($3::uuid[])
             )
             SELECT st.student_id AS "studentId", ev.subject_id AS "subjectId",
                    ev.period_id AS "periodId",
                    COUNT(*)::int AS "evaluationCount",
                    COUNT(s.id)::int AS "scoredCount",
                    SUM(ev.percentage)::text AS allocated,
                    ROUND(COALESCE(SUM(s.score * ev.percentage / 100), 0), 2)::text
                      AS accumulated,
                    CASE WHEN SUM(ev.percentage) = 100 AND COUNT(s.id) = COUNT(*)
                         THEN ROUND(SUM(s.score * ev.percentage / 100), 2)::text
                    END AS final
               FROM unnest($4::uuid[]) AS st(student_id)
              CROSS JOIN ev
               LEFT JOIN scores s
                 ON s.evaluation_id = ev.id AND s.student_id = st.student_id
              GROUP BY st.student_id, ev.subject_id, ev.period_id`,
            [courseId, subjectIds, periodIds, studentIds],
          )
        : [];
    const map = new Map<string, SubjectPeriodGradeDto>();
    for (const row of rows) {
      const final = row.final === null ? null : Number(row.final);
      map.set(`${row.studentId}:${row.subjectId}:${row.periodId}`, {
        evaluationCount: row.evaluationCount,
        scoredCount: row.scoredCount,
        allocatedPercentage: Number(row.allocated),
        accumulated: Number(row.accumulated),
        final,
        passed: final === null ? null : final >= passingScore,
      });
    }
    return {
      get: (
        studentId: string,
        subjectId: string,
        periodId: string,
      ): SubjectPeriodGradeDto =>
        map.get(`${studentId}:${subjectId}:${periodId}`) ?? { ...EMPTY_GRADE },
    };
  }

  /** Evaluaciones con la nota del estudiante, por "materia:periodo". */
  private async evaluationScores(
    manager: EntityManager,
    courseId: string,
    subjectIds: string[],
    periodIds: string[],
    studentId: string,
  ): Promise<Map<string, StudentEvaluationScoreDto[]>> {
    const map = new Map<string, StudentEvaluationScoreDto[]>();
    if (!subjectIds.length || !periodIds.length) return map;
    const rows = await manager.query<
      {
        id: string;
        title: string;
        percentage: string;
        evaluationDate: string;
        periodId: string;
        subjectId: string;
        score: string | null;
      }[]
    >(
      `SELECT e.id, e.title, e.percentage::text AS percentage,
              e.evaluation_date::text AS "evaluationDate",
              e.period_id AS "periodId", t.subject_id AS "subjectId",
              s.score::text AS score
         FROM evaluations e
         JOIN teacher_subject_courses t ON t.id = e.teacher_subject_course_id
         LEFT JOIN scores s ON s.evaluation_id = e.id AND s.student_id = $4
        WHERE t.course_id = $1
          AND t.subject_id = ANY($2::uuid[])
          AND e.period_id = ANY($3::uuid[])
        ORDER BY e.evaluation_date, e.title, e.id`,
      [courseId, subjectIds, periodIds, studentId],
    );
    for (const row of rows) {
      const key = `${row.subjectId}:${row.periodId}`;
      const list = map.get(key) ?? [];
      list.push({
        id: row.id,
        title: row.title,
        percentage: Number(row.percentage),
        evaluationDate: row.evaluationDate,
        score: row.score === null ? null : Number(row.score),
      });
      map.set(key, list);
    }
    return map;
  }

  /**
   * Primer filtro, antes de revelar nada de sus matrículas: administra la
   * sede del estudiante o la de alguno de sus cursos, o tiene carga activa
   * en alguno de sus cursos. La matrícula consultada se vuelve a comprobar
   * por la sede de su curso (hallazgo B2 de la fase 9b).
   */
  private async canSeeStudent(
    manager: EntityManager,
    actor: EvaluationActor,
    student: StudentEntity,
  ): Promise<boolean> {
    if (actor.adminScope === null) return true;
    if (student.campusId && actor.adminScope.includes(student.campusId)) {
      return true;
    }
    const { sql, params } = this.access.visibility(actor, { activeOnly: true });
    const count = await manager
      .getRepository(EnrollmentEntity)
      .createQueryBuilder('en')
      .innerJoin('en.course', 'c')
      .leftJoin(TeacherSubjectCourseEntity, 't', 't.course_id = c.id')
      .where('en.student_id = :studentId', { studentId: student.id })
      .andWhere(sql, params)
      .getCount();
    return count > 0;
  }

  /**
   * Materias del curso visibles para quien actúa (ver visibility()): al
   * docente, solo las de sus cargas activas (hallazgo M1 de la fase 9b).
   */
  private async visibleSubjects(
    manager: EntityManager,
    actor: EvaluationActor,
    courseId: string,
  ): Promise<GradebookSubjectDto[]> {
    const { sql, params } = this.access.visibility(actor, { activeOnly: true });
    return this.subjectsQuery(manager, courseId)
      .andWhere(sql, params)
      .getRawMany();
  }

  private courseSubjects(
    manager: EntityManager,
    courseId: string,
  ): Promise<GradebookSubjectDto[]> {
    return this.subjectsQuery(manager, courseId).getRawMany();
  }

  /** Materias con carga (activa o no) en el curso, sin repetir. */
  private subjectsQuery(manager: EntityManager, courseId: string) {
    return manager
      .getRepository(TeacherSubjectCourseEntity)
      .createQueryBuilder('t')
      .innerJoin('t.course', 'c')
      .innerJoin('t.subject', 'sub')
      .select('sub.id', 'id')
      .addSelect('sub.name', 'name')
      .distinct(true)
      .where('t.course_id = :courseId', { courseId })
      .orderBy('sub.name', 'ASC')
      .addOrderBy('sub.id', 'ASC');
  }

  private async latestActiveYear(
    manager: EntityManager,
    studentId: string,
  ): Promise<AcademicYearEntity | null> {
    return manager
      .getRepository(AcademicYearEntity)
      .createQueryBuilder('y')
      .innerJoin(EnrollmentEntity, 'en', 'en.academic_year_id = y.id')
      .where('en.student_id = :studentId AND y.is_active = true', {
        studentId,
      })
      .orderBy('y.year', 'DESC')
      .getOne();
  }

  private async findCourse(
    manager: EntityManager,
    institutionId: string,
    id: string,
  ): Promise<CourseEntity> {
    const course = await manager
      .getRepository(CourseEntity)
      .createQueryBuilder('c')
      .innerJoin('c.grade', 'g')
      .where('c.id = :id AND g.institution_id = :institutionId', {
        id,
        institutionId,
      })
      .getOne();
    if (!course) throw new NotFoundException('Curso no encontrado');
    return course;
  }

  private async findPeriod(
    manager: EntityManager,
    institutionId: string,
    id: string,
  ): Promise<PeriodEntity> {
    const period = await manager
      .getRepository(PeriodEntity)
      .createQueryBuilder('p')
      .innerJoin(
        AcademicYearEntity,
        'y',
        'y.id = p.academic_year_id AND y.institution_id = :institutionId',
        { institutionId },
      )
      .where('p.id = :id', { id })
      .getOne();
    if (!period) throw new NotFoundException('Periodo no encontrado');
    return period;
  }

  private institution(
    manager: EntityManager,
    id: string,
  ): Promise<InstitutionEntity> {
    return manager.getRepository(InstitutionEntity).findOneByOrFail({ id });
  }
}

function finals(rows: { final: number | null }[]): number[] {
  return rows.map((r) => r.final).filter((v): v is number => v !== null);
}
