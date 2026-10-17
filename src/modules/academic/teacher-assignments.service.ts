import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import { hasActiveTeacherRole } from '../security/teacher-role';
import { TeacherEntity } from '../users/entities/teacher.entity';
import { UserEntity } from '../users/entities/user.entity';
import { mapIntegrityError } from './academic.shared';
import { CoursesService } from './courses.service';
import {
  CreateTeacherAssignmentDto,
  ReplaceTeacherDto,
  TeacherAssignmentQueryDto,
  TeacherAssignmentResponseDto,
} from './dto/teacher-assignment.dto';
import { CourseEntity } from './entities/course.entity';
import { SubjectEntity } from './entities/subject.entity';
import { TeacherSubjectCourseEntity } from './entities/teacher-subject-course.entity';

export const TEACHER_ASSIGNMENTS_PERMISSION = 'academic.teacher-assignments';

const ACTIVE_EXISTS =
  'La materia ya tiene un docente activo en el curso: use el reemplazo';

/**
 * Carga académica (docente + materia + curso) de la institución activa. Un
 * solo docente activo por materia y curso; el reemplazo desactiva la
 * asignación anterior (historial, con su fecha) y crea una nueva en la misma
 * transacción. Alcance por sede: la del curso.
 * Toda alta o reemplazo bloquea primero el curso (FOR SHARE, hallazgo M1 de
 * la fase 8a). El docente debe estar activo y tener el rol TEACHER en la sede
 * del curso o en toda la institución; el año lectivo del curso, activo.
 */
@Injectable()
export class TeacherAssignmentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly courses: CoursesService,
  ) {}

  async findAll(
    user: AuthUser,
    query: TeacherAssignmentQueryDto,
  ): Promise<Paginated<TeacherAssignmentResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'view');
    const qb = this.baseQuery(
      this.dataSource.manager,
      institutionId,
      campusScope,
    );
    if (query.courseId) {
      qb.andWhere('t.course_id = :courseId', { courseId: query.courseId });
    }
    if (query.subjectId) {
      qb.andWhere('t.subject_id = :subjectId', { subjectId: query.subjectId });
    }
    if (query.teacherId) {
      qb.andWhere('t.teacher_id = :teacherId', { teacherId: query.teacherId });
    }
    if (query.academicYearId) {
      qb.andWhere('c.academic_year_id = :academicYearId', {
        academicYearId: query.academicYearId,
      });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('t.is_active = :isActive', { isActive: query.isActive });
    }
    this.order(qb);
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => TeacherAssignmentResponseDto.from(row)),
      total,
      query,
    );
  }

  /**
   * La carga activa del propio docente en la institución activa, de años
   * activos. No exige permiso de menú (el rol TEACHER no lo tiene): su perfil
   * de docente y el rol TEACHER vigente (sin él, lista vacía).
   */
  async findMine(user: AuthUser): Promise<TeacherAssignmentResponseDto[]> {
    const institutionId = activeInstitutionId(user);
    const teacher = await this.dataSource
      .getRepository(TeacherEntity)
      .findOneBy({ userId: user.userId, institutionId });
    if (
      !teacher ||
      !(await hasActiveTeacherRole(this.dataSource, user.userId, institutionId))
    ) {
      return [];
    }
    const qb = this.baseQuery(this.dataSource.manager, institutionId, null)
      .andWhere('t.teacher_id = :teacherId', { teacherId: teacher.id })
      .andWhere('t.is_active = true')
      .andWhere('y.is_active = true');
    this.order(qb);
    return (await qb.getMany()).map((row) =>
      TeacherAssignmentResponseDto.from(row),
    );
  }

  async findOne(
    user: AuthUser,
    id: string,
  ): Promise<TeacherAssignmentResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'view');
    return TeacherAssignmentResponseDto.from(
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
    dto: CreateTeacherAssignmentDto,
  ): Promise<TeacherAssignmentResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'create');
    return this.dataSource.transaction(async (manager) => {
      const course = await this.courses.lockForUse(
        manager,
        institutionId,
        campusScope,
        dto.courseId,
      );
      this.assertActiveYear(course);
      const subject = await manager.getRepository(SubjectEntity).findOne({
        where: { id: dto.subjectId, institutionId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!subject) throw new NotFoundException('Materia no encontrada');
      await this.assertTeacherCanTeach(
        manager,
        institutionId,
        campusScope,
        dto.teacherId,
        course,
      );

      const active = await manager
        .getRepository(TeacherSubjectCourseEntity)
        .existsBy({
          courseId: course.id,
          subjectId: subject.id,
          isActive: true,
        });
      if (active) throw new ConflictException(ACTIVE_EXISTS);
      const id = await this.insert(manager, {
        courseId: course.id,
        subjectId: subject.id,
        teacherId: dto.teacherId,
      });
      return TeacherAssignmentResponseDto.from(
        await this.getVisible(manager, institutionId, null, id),
      );
    });
  }

  /** Reemplaza al docente: la asignación actual queda en el historial. */
  async replace(
    user: AuthUser,
    id: string,
    dto: ReplaceTeacherDto,
  ): Promise<TeacherAssignmentResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'update');
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockAssignment(
        manager,
        institutionId,
        campusScope,
        id,
      );
      if (!current.isActive) {
        throw new ConflictException(
          'La asignación ya no está activa: no se puede reemplazar',
        );
      }
      if (current.teacherId === dto.teacherId) {
        throw new BadRequestException('El docente nuevo es el mismo actual');
      }
      this.assertActiveYear(current.course);
      await this.assertTeacherCanTeach(
        manager,
        institutionId,
        campusScope,
        dto.teacherId,
        current.course,
      );
      const repo = manager.getRepository(TeacherSubjectCourseEntity);
      await repo.update(
        { id: current.id },
        { isActive: false, deactivatedAt: () => 'CURRENT_TIMESTAMP' },
      );
      const newId = await this.insert(manager, {
        courseId: current.courseId,
        subjectId: current.subjectId,
        teacherId: dto.teacherId,
      });
      return TeacherAssignmentResponseDto.from(
        await this.getVisible(manager, institutionId, null, newId),
      );
    });
  }

  /** Termina la asignación sin reemplazo (queda en el historial). */
  async deactivate(
    user: AuthUser,
    id: string,
  ): Promise<TeacherAssignmentResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'update');
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockAssignment(
        manager,
        institutionId,
        campusScope,
        id,
      );
      if (current.isActive) {
        await manager
          .getRepository(TeacherSubjectCourseEntity)
          .update(
            { id: current.id },
            { isActive: false, deactivatedAt: () => 'CURRENT_TIMESTAMP' },
          );
      }
      return TeacherAssignmentResponseDto.from(
        await this.getVisible(manager, institutionId, null, current.id),
      );
    });
  }

  /** Solo para corregir errores: 409 si ya tiene evaluaciones. */
  async remove(user: AuthUser, id: string): Promise<void> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'delete');
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockAssignment(
        manager,
        institutionId,
        campusScope,
        id,
      );
      try {
        await manager
          .getRepository(TeacherSubjectCourseEntity)
          .delete({ id: current.id });
      } catch (error) {
        throw mapIntegrityError(error, {
          duplicate: ACTIVE_EXISTS,
          inUse: 'La asignación tiene evaluaciones: no se puede borrar',
        });
      }
    });
  }

  /**
   * Docente de la institución, con usuario activo y el rol TEACHER (global)
   * en toda la institución o en la sede del curso, en sede activa. Para quien
   * está limitado a sedes, un docente sin el rol TEACHER en ellas (ni en toda
   * la institución) responde 404, igual que uno inexistente. El usuario se
   * lee FOR SHARE: se serializa con la gestión de usuarios y de roles (que lo
   * bloquean FOR UPDATE).
   */
  private async assertTeacherCanTeach(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    teacherId: string,
    course: CourseEntity,
  ): Promise<void> {
    const teacher = await manager
      .getRepository(TeacherEntity)
      .findOneBy({ id: teacherId, institutionId });
    if (
      !teacher ||
      (campusScope &&
        !(await hasActiveTeacherRole(
          manager,
          teacher.userId,
          institutionId,
          campusScope,
        )))
    ) {
      throw new NotFoundException('Docente no encontrado');
    }
    const teacherUser = await manager.getRepository(UserEntity).findOne({
      select: { id: true, isActive: true },
      where: { id: teacher.userId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!teacherUser?.isActive) {
      throw new BadRequestException('El docente está inactivo');
    }
    if (
      !(await hasActiveTeacherRole(manager, teacher.userId, institutionId, [
        course.campusId,
      ]))
    ) {
      throw new BadRequestException(
        'El docente no tiene el rol TEACHER en la sede del curso',
      );
    }
  }

  private assertActiveYear(course: CourseEntity): void {
    if (!course.academicYear.isActive) {
      throw new BadRequestException('El año lectivo del curso está inactivo');
    }
  }

  /**
   * Bloquea el curso (FOR SHARE, mismo orden que el alta) y luego la
   * asignación (FOR UPDATE), ambos dentro del alcance de quien actúa.
   */
  private async lockAssignment(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    id: string,
  ): Promise<TeacherSubjectCourseEntity> {
    const found = await this.getVisible(
      manager,
      institutionId,
      campusScope,
      id,
    );
    await this.courses.lockForUse(
      manager,
      institutionId,
      campusScope,
      found.courseId,
    );
    return this.getVisible(manager, institutionId, campusScope, id, true);
  }

  private async insert(
    manager: EntityManager,
    values: Pick<
      TeacherSubjectCourseEntity,
      'courseId' | 'subjectId' | 'teacherId'
    >,
  ): Promise<string> {
    try {
      const result = await manager
        .getRepository(TeacherSubjectCourseEntity)
        .insert({ ...values, isActive: true });
      return (result.identifiers[0] as { id: string }).id;
    } catch (error) {
      // Índice único parcial (curso, materia) WHERE is_active.
      throw mapIntegrityError(error, { duplicate: ACTIVE_EXISTS });
    }
  }

  private async getVisible(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    id: string,
    lock = false,
  ): Promise<TeacherSubjectCourseEntity> {
    const qb = this.baseQuery(manager, institutionId, campusScope).andWhere(
      't.id = :id',
      { id },
    );
    if (lock) qb.setLock('pessimistic_write', undefined, ['t']);
    const row = await qb.getOne();
    if (!row) throw new NotFoundException('Asignación no encontrada');
    return row;
  }

  /** Carga cuyo curso es de la institución (y de sus sedes, si aplica). */
  private baseQuery(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
  ): SelectQueryBuilder<TeacherSubjectCourseEntity> {
    const qb = manager
      .getRepository(TeacherSubjectCourseEntity)
      .createQueryBuilder('t')
      .innerJoinAndSelect('t.course', 'c')
      .innerJoinAndSelect('c.grade', 'g')
      .innerJoinAndSelect('c.campus', 'cp')
      .innerJoinAndSelect('c.academicYear', 'y')
      .innerJoinAndSelect('t.subject', 'sub')
      .innerJoinAndSelect('t.teacher', 'te')
      .innerJoinAndSelect('te.user', 'u')
      .where('g.institution_id = :institutionId', { institutionId });
    if (campusScope) {
      qb.andWhere(
        campusScope.length ? 'c.campus_id IN (:...campusScope)' : 'false',
        { campusScope },
      );
    }
    return qb;
  }

  private order(qb: SelectQueryBuilder<TeacherSubjectCourseEntity>): void {
    qb.orderBy('y.year', 'DESC')
      .addOrderBy('c.name', 'ASC')
      .addOrderBy('sub.name', 'ASC')
      .addOrderBy('t.createdAt', 'DESC')
      .addOrderBy('t.id', 'ASC');
  }

  private campusScope(
    user: AuthUser,
    institutionId: string,
    action: PermissionAction,
  ): Promise<CampusScope> {
    return this.permissions.campusScope(
      user.userId,
      institutionId,
      TEACHER_ASSIGNMENTS_PERMISSION,
      action,
    );
  }
}
