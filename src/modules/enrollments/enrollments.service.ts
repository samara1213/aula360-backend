import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { containsPattern } from '../../common/dto/list-query.dto';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { mapIntegrityError } from '../academic/academic.shared';
import { CoursesService } from '../academic/courses.service';
import { CourseEntity } from '../academic/entities/course.entity';
import {
  lockCourseReportCards,
  markReportCardsOutdated,
} from '../reports/report-card-locks';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import { StudentEntity } from '../users/entities/student.entity';
import { UserEntity } from '../users/entities/user.entity';
import {
  CreateEnrollmentDto,
  EnrollmentQueryDto,
  EnrollmentResponseDto,
  UpdateEnrollmentDto,
} from './dto/enrollment.dto';
import {
  EnrollmentEntity,
  EnrollmentStatus,
} from './entities/enrollment.entity';

export const ENROLLMENTS_PERMISSION = 'academic.enrollments';

const DUPLICATE = 'El estudiante ya tiene matrícula en ese año lectivo';

/** Cambios de estado permitidos (GRADUATED es definitivo). */
const TRANSITIONS: Record<EnrollmentStatus, readonly EnrollmentStatus[]> = {
  ENROLLED: ['SUSPENDED', 'DROPPED', 'GRADUATED'],
  SUSPENDED: ['ENROLLED', 'DROPPED'],
  DROPPED: ['ENROLLED'],
  GRADUATED: [],
};

/** Matrícula vigente: la que impide cambiar la sede del estudiante. */
const CURRENT_STATUSES: readonly EnrollmentStatus[] = ['ENROLLED', 'SUSPENDED'];

/**
 * Matrículas de la institución activa. El año de la matrícula es siempre el
 * del curso; una matrícula por estudiante y año. Para matricular (o cambiar
 * de curso, o reintegrar) el año debe estar activo, el estudiante activo y
 * su sede debe ser la del curso. No se borran: se retiran (DROPPED).
 * Alcance por sede: la del curso (y el estudiante debe estar en esas sedes;
 * si no, 404). Bloqueos (hallazgo M1 de la fase 8a), siempre en este orden:
 * cursos y su año (FOR SHARE, por id), matrícula (FOR UPDATE), usuario del
 * estudiante (FOR SHARE) y perfil (FOR UPDATE), como en /students.
 * Un cambio de curso toma además el bloqueo compartido de los boletines de
 * ambos cursos y marca como desactualizados los del estudiante en ese año
 * (hallazgo M2 de la fase 10b). El estado no sale en el boletín: no marca.
 * Las observaciones solo van en el detalle (texto libre sobre menores).
 */
@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly courses: CoursesService,
  ) {}

  async findAll(
    user: AuthUser,
    query: EnrollmentQueryDto,
  ): Promise<Paginated<EnrollmentResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'view');
    const qb = this.baseQuery(
      this.dataSource.manager,
      institutionId,
      campusScope,
    );
    if (query.courseId) {
      qb.andWhere('e.course_id = :courseId', { courseId: query.courseId });
    }
    if (query.academicYearId) {
      qb.andWhere('e.academic_year_id = :academicYearId', {
        academicYearId: query.academicYearId,
      });
    }
    if (query.studentId) {
      qb.andWhere('e.student_id = :studentId', { studentId: query.studentId });
    }
    if (query.status) {
      qb.andWhere('e.status = :status', { status: query.status });
    }
    if (query.search) {
      qb.andWhere(
        `(u.first_name ILIKE :pattern OR u.last_name ILIKE :pattern OR (u.first_name || ' ' || u.last_name) ILIKE :pattern OR s.student_code ILIKE :pattern)`,
        { pattern: containsPattern(query.search) },
      );
    }
    qb.orderBy('y.year', 'DESC')
      .addOrderBy('c.name', 'ASC')
      .addOrderBy('u.lastName', 'ASC')
      .addOrderBy('u.firstName', 'ASC')
      .addOrderBy('e.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => EnrollmentResponseDto.from(row, false)),
      total,
      query,
    );
  }

  async findOne(user: AuthUser, id: string): Promise<EnrollmentResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'view');
    return EnrollmentResponseDto.from(
      await this.getVisible(
        this.dataSource.manager,
        institutionId,
        campusScope,
        id,
      ),
    );
  }

  async create(
    user: AuthUser,
    dto: CreateEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'create');
    return this.dataSource.transaction(async (manager) => {
      const course = await this.courses.lockForUse(
        manager,
        institutionId,
        campusScope,
        dto.courseId,
      );
      const student = await this.lockStudent(
        manager,
        institutionId,
        campusScope,
        dto.studentId,
      );
      this.assertCanEnroll(course, student);
      let id: string;
      try {
        const result = await manager.getRepository(EnrollmentEntity).insert({
          studentId: student.id,
          courseId: course.id,
          academicYearId: course.academicYearId,
          status: 'ENROLLED',
          observations: dto.observations ?? null,
        });
        id = (result.identifiers[0] as { id: string }).id;
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE });
      }
      return EnrollmentResponseDto.from(
        await this.getVisible(manager, institutionId, null, id),
      );
    });
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    if (dto.status === null || dto.courseId === null) {
      throw new BadRequestException('status y courseId no pueden ser nulos');
    }
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'update');
    const { result, outdated } = await this.dataSource.transaction(
      async (manager) => {
        const found = await this.getVisible(
          manager,
          institutionId,
          campusScope,
          id,
        );
        // Cursos (actual y destino) primero, en orden por id: dos cambios
        // cruzados nunca se esperan en ciclo.
        const targetCourseId = dto.courseId ?? found.courseId;
        const locked = new Map<string, CourseEntity>();
        for (const courseId of [
          ...new Set([found.courseId, targetCourseId]),
        ].sort()) {
          locked.set(
            courseId,
            await this.courses.lockForUse(
              manager,
              institutionId,
              campusScope,
              courseId,
            ),
          );
        }
        const enrollment = await this.getVisible(
          manager,
          institutionId,
          campusScope,
          id,
          true,
        );
        if (enrollment.courseId !== found.courseId) {
          // Otro cambio de curso terminó entre la lectura y el bloqueo.
          throw new ConflictException(
            'Conflicto de concurrencia, intente de nuevo',
          );
        }
        const student = await this.lockStudent(
          manager,
          institutionId,
          campusScope,
          enrollment.studentId,
        );

        const from = enrollment.status;
        const to = dto.status ?? from;
        if (to !== from && !TRANSITIONS[from].includes(to)) {
          throw new ConflictException(
            `No se puede pasar una matrícula de ${from} a ${to}`,
          );
        }

        const course = locked.get(targetCourseId) as CourseEntity;
        const courseChanged = targetCourseId !== enrollment.courseId;
        if (courseChanged) {
          if (!CURRENT_STATUSES.includes(to)) {
            throw new ConflictException(
              'Solo se cambia de curso una matrícula vigente',
            );
          }
          if (course.academicYearId !== enrollment.academicYearId) {
            throw new BadRequestException(
              'Solo se cambia a un curso del mismo año lectivo',
            );
          }
        }
        // Cambiar de curso o reintegrar equivale a matricular de nuevo.
        if (courseChanged || (from === 'DROPPED' && to === 'ENROLLED')) {
          this.assertCanEnroll(course, student);
        }

        const changes: Partial<EnrollmentEntity> = {};
        if (to !== from) changes.status = to;
        if (courseChanged) changes.courseId = course.id;
        if (dto.observations !== undefined) {
          changes.observations = dto.observations;
        }
        if (courseChanged) {
          await lockCourseReportCards(manager, [
            enrollment.courseId,
            course.id,
          ]);
        }
        if (Object.keys(changes).length) {
          await manager
            .getRepository(EnrollmentEntity)
            .update({ id: enrollment.id }, changes);
        }
        const outdatedIds = courseChanged
          ? await markReportCardsOutdated(manager, {
              studentIds: [enrollment.studentId],
              academicYearId: enrollment.academicYearId,
            })
          : [];
        return {
          result: EnrollmentResponseDto.from(
            await this.getVisible(manager, institutionId, null, enrollment.id),
          ),
          outdated: outdatedIds.length
            ? {
                audit: 'report-cards.outdated',
                reason: 'enrollment.course-changed',
                actorId: user.userId,
                institutionId,
                enrollmentId: enrollment.id,
                fromCourseId: enrollment.courseId,
                toCourseId: course.id,
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

  /** La sede se valida antes que el estado: no se revela el estado de otros. */
  private assertCanEnroll(course: CourseEntity, student: StudentEntity): void {
    if (!course.academicYear.isActive) {
      throw new BadRequestException('El año lectivo del curso está inactivo');
    }
    if (!student.campusId) {
      throw new BadRequestException(
        'El estudiante no tiene sede: asígnela primero',
      );
    }
    if (student.campusId !== course.campusId) {
      throw new BadRequestException(
        'El curso es de otra sede: cambie primero la sede del estudiante',
      );
    }
    if (!student.user.isActive) {
      throw new BadRequestException('El estudiante está inactivo');
    }
  }

  /**
   * Estudiante de la institución y, para quien está limitado a sedes, de esas
   * sedes (si no, 404 igual que uno inexistente). Bloquea su usuario (FOR
   * SHARE: no se desactiva mientras tanto) y luego el perfil (FOR UPDATE: se
   * serializa con el cambio de sede), en el mismo orden que /students.
   */
  private async lockStudent(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    id: string,
  ): Promise<StudentEntity> {
    const repo = manager.getRepository(StudentEntity);
    const inScope = (s: StudentEntity | null): s is StudentEntity =>
      s !== null &&
      (!campusScope ||
        (s.campusId !== null && campusScope.includes(s.campusId)));
    const found = await repo.findOneBy({ id, institutionId });
    if (!inScope(found)) {
      throw new NotFoundException('Estudiante no encontrado');
    }
    const user = await manager.getRepository(UserEntity).findOneOrFail({
      select: { id: true, isActive: true },
      where: { id: found.userId },
      lock: { mode: 'pessimistic_read' },
    });
    const student = await repo.findOne({
      where: { id, institutionId },
      lock: { mode: 'pessimistic_write' },
    });
    // Releído con el bloqueo: su sede pudo cambiar entre tanto.
    if (!inScope(student)) {
      throw new NotFoundException('Estudiante no encontrado');
    }
    student.user = user;
    return student;
  }

  private async getVisible(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    id: string,
    lock = false,
  ): Promise<EnrollmentEntity> {
    const qb = this.baseQuery(manager, institutionId, campusScope).andWhere(
      'e.id = :id',
      { id },
    );
    if (lock) qb.setLock('pessimistic_write', undefined, ['e']);
    const row = await qb.getOne();
    if (!row) throw new NotFoundException('Matrícula no encontrada');
    return row;
  }

  /** Matrículas cuyo curso (y estudiante) son de la institución, en sus sedes. */
  private baseQuery(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
  ): SelectQueryBuilder<EnrollmentEntity> {
    const qb = manager
      .getRepository(EnrollmentEntity)
      .createQueryBuilder('e')
      .innerJoinAndSelect('e.course', 'c')
      .innerJoinAndSelect('c.grade', 'g')
      .innerJoinAndSelect('c.campus', 'cp')
      .innerJoinAndSelect('e.academicYear', 'y')
      .innerJoinAndSelect('e.student', 's')
      .innerJoinAndSelect('s.user', 'u')
      .where('g.institution_id = :institutionId', { institutionId })
      .andWhere('s.institution_id = :institutionId');
    if (campusScope) {
      qb.andWhere(
        campusScope.length ? 'c.campus_id IN (:...campusScope)' : 'false',
        { campusScope },
      );
    }
    return qb;
  }

  private campusScope(
    user: AuthUser,
    institutionId: string,
    action: PermissionAction,
  ): Promise<CampusScope> {
    return this.permissions.campusScope(
      user.userId,
      institutionId,
      ENROLLMENTS_PERMISSION,
      action,
    );
  }
}
