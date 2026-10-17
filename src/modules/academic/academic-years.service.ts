import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { PermissionsReader } from '../security/permissions-reader.service';
import {
  mapIntegrityError,
  requireInstitutionWideWrite,
} from './academic.shared';
import {
  AcademicYearQueryDto,
  AcademicYearResponseDto,
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { CourseEntity } from './entities/course.entity';
import { PeriodEntity } from './entities/period.entity';

export const ACADEMIC_YEARS_PERMISSION = 'academic.years';

const DUPLICATE = 'Ya existe ese año lectivo en la institución';
const IN_USE =
  'El año lectivo tiene periodos, cursos o matrículas: no se puede borrar';

/**
 * Años lectivos de la institución activa. "Activo" = se pueden crear cursos
 * (y matrículas) en él; puede haber varios activos (preparar el siguiente).
 * Son de toda la institución: quien está limitado a sedes solo los consulta.
 */
@Injectable()
export class AcademicYearsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(
    user: AuthUser,
    query: AcademicYearQueryDto,
  ): Promise<Paginated<AcademicYearResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const qb = this.dataSource
      .getRepository(AcademicYearEntity)
      .createQueryBuilder('y')
      .where('y.institution_id = :institutionId', { institutionId })
      .orderBy('y.year', 'DESC')
      .addOrderBy('y.id', 'ASC');
    if (query.isActive !== undefined) {
      qb.andWhere('y.is_active = :isActive', { isActive: query.isActive });
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => AcademicYearResponseDto.from(row)),
      total,
      query,
    );
  }

  async findOne(user: AuthUser, id: string): Promise<AcademicYearResponseDto> {
    const institutionId = activeInstitutionId(user);
    return AcademicYearResponseDto.from(
      await this.getOrFail(this.dataSource.manager, institutionId, id),
    );
  }

  async create(
    user: AuthUser,
    dto: CreateAcademicYearDto,
  ): Promise<AcademicYearResponseDto> {
    const institutionId = await this.writeScope(user, 'create');
    const repo = this.dataSource.getRepository(AcademicYearEntity);
    try {
      const saved = await repo.save(
        repo.create({ institutionId, year: dto.year }),
      );
      return AcademicYearResponseDto.from(saved);
    } catch (error) {
      throw mapIntegrityError(error, { duplicate: DUPLICATE });
    }
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateAcademicYearDto,
  ): Promise<AcademicYearResponseDto> {
    rejectNullFields(dto, ['year', 'isActive']);
    const institutionId = await this.writeScope(user, 'update');
    return this.dataSource.transaction(async (manager) => {
      // FOR UPDATE: se serializa con el alta de periodos y cursos del año.
      const year = await this.getOrFail(manager, institutionId, id, true);
      if (dto.year !== undefined && dto.year !== year.year) {
        // Las fechas de sus periodos (y sus cursos) dependen del número.
        const [hasPeriods, hasCourses] = await Promise.all([
          manager
            .getRepository(PeriodEntity)
            .existsBy({ academicYearId: year.id }),
          manager
            .getRepository(CourseEntity)
            .existsBy({ academicYearId: year.id }),
        ]);
        if (hasPeriods || hasCourses) {
          throw new ConflictException(
            'El año lectivo ya tiene periodos o cursos: no se puede cambiar el número',
          );
        }
        year.year = dto.year;
      }
      if (dto.isActive !== undefined) year.isActive = dto.isActive;
      try {
        return AcademicYearResponseDto.from(
          await manager.getRepository(AcademicYearEntity).save(year),
        );
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE });
      }
    });
  }

  /** Solo si nada lo usa (periodos, cursos, matrículas): 409 si no. */
  async remove(user: AuthUser, id: string): Promise<void> {
    const institutionId = await this.writeScope(user, 'delete');
    await this.dataSource.transaction(async (manager) => {
      const year = await this.getOrFail(manager, institutionId, id, true);
      try {
        await manager.getRepository(AcademicYearEntity).delete({ id: year.id });
      } catch (error) {
        throw mapIntegrityError(error, {
          duplicate: DUPLICATE,
          inUse: IN_USE,
        });
      }
    });
  }

  /** Por id E institución en la misma consulta: otra institución = 404. */
  private async getOrFail(
    manager: EntityManager,
    institutionId: string,
    id: string,
    lock = false,
  ): Promise<AcademicYearEntity> {
    const year = await manager.getRepository(AcademicYearEntity).findOne({
      where: { id, institutionId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!year) throw new NotFoundException('Año lectivo no encontrado');
    return year;
  }

  private writeScope(
    user: AuthUser,
    action: 'create' | 'update' | 'delete',
  ): Promise<string> {
    return requireInstitutionWideWrite(
      this.permissions,
      user,
      ACADEMIC_YEARS_PERMISSION,
      action,
    );
  }
}
