import {
  BadRequestException,
  ConflictException,
  Injectable,
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
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { EnrollmentEntity } from '../enrollments/entities/enrollment.entity';
import { CampusEntity } from '../institutions/entities/campus.entity';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import { mapIntegrityError } from './academic.shared';
import {
  CourseQueryDto,
  CourseResponseDto,
  CreateCourseDto,
  UpdateCourseDto,
} from './dto/course.dto';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { CourseEntity } from './entities/course.entity';
import { GradeEntity } from './entities/grade.entity';
import { TeacherSubjectCourseEntity } from './entities/teacher-subject-course.entity';

export const COURSES_PERMISSION = 'academic.courses';

const DUPLICATE =
  'Ya existe un curso con ese nombre para ese grado, sede y año lectivo';
const IN_USE =
  'El curso tiene carga académica o matrículas: no se puede borrar';

/**
 * Cursos (grado + sede + año lectivo) de la institución activa. La
 * institución del curso es la de su grado; la sede y el año también deben ser
 * de ella, y estar activos para crear o mover el curso. Alcance por sede:
 * quien está limitado a sedes solo ve y gestiona los cursos de esas sedes.
 * Grado, sede y año no cambian si el curso ya tiene carga académica o
 * matrículas (bloqueo FOR UPDATE del curso; la fase 8b bloquea el curso al
 * crear carga y matrículas).
 */
@Injectable()
export class CoursesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(
    user: AuthUser,
    query: CourseQueryDto,
  ): Promise<Paginated<CourseResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'view');
    const qb = this.baseQuery(
      this.dataSource.manager,
      institutionId,
      campusScope,
    );
    if (query.academicYearId) {
      qb.andWhere('c.academic_year_id = :academicYearId', {
        academicYearId: query.academicYearId,
      });
    }
    if (query.gradeId) {
      qb.andWhere('c.grade_id = :gradeId', { gradeId: query.gradeId });
    }
    if (query.campusId) {
      qb.andWhere('c.campus_id = :campusId', { campusId: query.campusId });
    }
    if (query.search) {
      qb.andWhere('c.name ILIKE :pattern', {
        pattern: containsPattern(query.search),
      });
    }
    qb.orderBy('y.year', 'DESC')
      .addOrderBy('g.name', 'ASC')
      .addOrderBy('c.name', 'ASC')
      .addOrderBy('c.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => CourseResponseDto.from(row)),
      total,
      query,
    );
  }

  async findOne(user: AuthUser, id: string): Promise<CourseResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'view');
    return CourseResponseDto.from(
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
    dto: CreateCourseDto,
  ): Promise<CourseResponseDto> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'create');
    return this.dataSource.transaction(async (manager) => {
      await this.validateRefs(manager, institutionId, campusScope, dto);
      const repo = manager.getRepository(CourseEntity);
      let id: string;
      try {
        const result = await repo.insert({
          name: dto.name,
          gradeId: dto.gradeId,
          campusId: dto.campusId,
          academicYearId: dto.academicYearId,
        });
        id = (result.identifiers[0] as { id: string }).id;
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE });
      }
      return CourseResponseDto.from(
        await this.getVisible(manager, institutionId, null, id),
      );
    });
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateCourseDto,
  ): Promise<CourseResponseDto> {
    rejectNullFields(dto, ['name', 'gradeId', 'campusId', 'academicYearId']);
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'update');
    return this.dataSource.transaction(async (manager) => {
      const course = await this.getVisible(
        manager,
        institutionId,
        campusScope,
        id,
        true,
      );
      const target = {
        name: dto.name ?? course.name,
        gradeId: dto.gradeId ?? course.gradeId,
        campusId: dto.campusId ?? course.campusId,
        academicYearId: dto.academicYearId ?? course.academicYearId,
      };
      const moved =
        target.gradeId !== course.gradeId ||
        target.campusId !== course.campusId ||
        target.academicYearId !== course.academicYearId;
      if (moved) {
        await this.assertNotInUse(manager, course.id);
        await this.validateRefs(manager, institutionId, campusScope, target);
      }
      try {
        await manager
          .getRepository(CourseEntity)
          .update({ id: course.id }, target);
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE });
      }
      return CourseResponseDto.from(
        await this.getVisible(manager, institutionId, null, course.id),
      );
    });
  }

  /** Solo si no tiene carga académica, matrículas ni boletines: 409 si no. */
  async remove(user: AuthUser, id: string): Promise<void> {
    const institutionId = activeInstitutionId(user);
    const campusScope = await this.campusScope(user, institutionId, 'delete');
    await this.dataSource.transaction(async (manager) => {
      const course = await this.getVisible(
        manager,
        institutionId,
        campusScope,
        id,
        true,
      );
      try {
        await manager.getRepository(CourseEntity).delete({ id: course.id });
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE, inUse: IN_USE });
      }
    });
  }

  /**
   * Grado, sede y año de la institución. La sede (dentro de su alcance) y el
   * año deben estar activos; se leen FOR SHARE para que no se desactiven ni
   * cambien mientras se crea o mueve el curso.
   */
  private async validateRefs(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    refs: { gradeId: string; campusId: string; academicYearId: string },
  ): Promise<void> {
    // Una sede fuera de su alcance responde igual que una inexistente.
    if (campusScope && !campusScope.includes(refs.campusId)) {
      throw new NotFoundException('Sede no encontrada');
    }
    const campus = await manager.getRepository(CampusEntity).findOne({
      where: { id: refs.campusId, institutionId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!campus) throw new NotFoundException('Sede no encontrada');
    if (!campus.isActive)
      throw new BadRequestException('La sede está inactiva');

    const year = await manager.getRepository(AcademicYearEntity).findOne({
      where: { id: refs.academicYearId, institutionId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!year) throw new NotFoundException('Año lectivo no encontrado');
    if (!year.isActive) {
      throw new BadRequestException('El año lectivo está inactivo');
    }

    const grade = await manager.getRepository(GradeEntity).findOne({
      where: { id: refs.gradeId, institutionId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!grade) throw new NotFoundException('Grado no encontrado');
  }

  private async assertNotInUse(
    manager: EntityManager,
    courseId: string,
  ): Promise<void> {
    const [hasLoad, hasEnrollments] = await Promise.all([
      manager.getRepository(TeacherSubjectCourseEntity).existsBy({ courseId }),
      manager.getRepository(EnrollmentEntity).existsBy({ courseId }),
    ]);
    if (hasLoad || hasEnrollments) {
      throw new ConflictException(
        'El curso ya tiene carga académica o matrículas: no se puede cambiar su grado, sede ni año',
      );
    }
  }

  private async getVisible(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
    id: string,
    lock = false,
  ): Promise<CourseEntity> {
    const qb = this.baseQuery(manager, institutionId, campusScope).andWhere(
      'c.id = :id',
      { id },
    );
    if (lock) qb.setLock('pessimistic_write', undefined, ['c']);
    const course = await qb.getOne();
    if (!course) throw new NotFoundException('Curso no encontrado');
    return course;
  }

  /** Cursos cuyo grado es de la institución (y de sus sedes, si aplica). */
  private baseQuery(
    manager: EntityManager,
    institutionId: string,
    campusScope: CampusScope,
  ): SelectQueryBuilder<CourseEntity> {
    const qb = manager
      .getRepository(CourseEntity)
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.grade', 'g')
      .innerJoinAndSelect('c.campus', 'cp')
      .innerJoinAndSelect('c.academicYear', 'y')
      .where('g.institution_id = :institutionId', { institutionId });
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
      COURSES_PERMISSION,
      action,
    );
  }
}
