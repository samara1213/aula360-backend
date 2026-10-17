import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { PermissionsReader } from '../security/permissions-reader.service';
import {
  mapIntegrityError,
  requireInstitutionWideWrite,
} from './academic.shared';
import {
  CreatePeriodDto,
  PeriodResponseDto,
  UpdatePeriodDto,
} from './dto/period.dto';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { PeriodEntity } from './entities/period.entity';

export const PERIODS_PERMISSION = 'academic.periods';

const DUPLICATE = 'Ya existe un periodo con ese nombre en el año lectivo';
const IN_USE = 'El periodo tiene evaluaciones o boletines: no se puede borrar';

/**
 * Periodos de un año lectivo de la institución activa. Reglas: fin >= inicio;
 * empieza dentro del año lectivo y termina a más tardar el 31 de diciembre
 * del año siguiente (calendario B); nombre único en el año; sin solaparse
 * con otros periodos del año. Las escrituras bloquean la fila del año
 * (FOR UPDATE): dos altas simultáneas no pueden solaparse. Editar y borrar
 * bloquean además el periodo: una edición nunca revive un periodo borrado.
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  /** Todos los periodos del año (pocos por año: sin paginación), por fecha. */
  async findByYear(
    user: AuthUser,
    academicYearId: string,
  ): Promise<PeriodResponseDto[]> {
    const institutionId = activeInstitutionId(user);
    const manager = this.dataSource.manager;
    await this.getYearOrFail(manager, institutionId, academicYearId);
    const rows = await manager.getRepository(PeriodEntity).find({
      where: { academicYearId },
      order: { startDate: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => PeriodResponseDto.from(row));
  }

  async findOne(user: AuthUser, id: string): Promise<PeriodResponseDto> {
    const institutionId = activeInstitutionId(user);
    return PeriodResponseDto.from(
      await this.getOrFail(this.dataSource.manager, institutionId, id),
    );
  }

  async create(
    user: AuthUser,
    academicYearId: string,
    dto: CreatePeriodDto,
  ): Promise<PeriodResponseDto> {
    const institutionId = await this.writeScope(user, 'create');
    return this.dataSource.transaction(async (manager) => {
      const year = await this.getYearOrFail(
        manager,
        institutionId,
        academicYearId,
        true,
      );
      await this.validateDates(manager, year, dto.startDate, dto.endDate);
      const repo = manager.getRepository(PeriodEntity);
      try {
        return PeriodResponseDto.from(
          await repo.save(
            repo.create({
              academicYearId: year.id,
              name: dto.name,
              startDate: dto.startDate,
              endDate: dto.endDate,
            }),
          ),
        );
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE });
      }
    });
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdatePeriodDto,
  ): Promise<PeriodResponseDto> {
    rejectNullFields(dto, ['name', 'startDate', 'endDate']);
    const institutionId = await this.writeScope(user, 'update');
    return this.dataSource.transaction(async (manager) => {
      const found = await this.getOrFail(manager, institutionId, id);
      const year = await this.getYearOrFail(
        manager,
        institutionId,
        found.academicYearId,
        true,
      );
      // Releído (FOR UPDATE) con el año bloqueado.
      const period = await this.getOrFail(manager, institutionId, id, true);
      const startDate = dto.startDate ?? period.startDate;
      const endDate = dto.endDate ?? period.endDate;
      if (dto.startDate !== undefined || dto.endDate !== undefined) {
        await this.validateDates(manager, year, startDate, endDate, period.id);
      }
      const changes = {
        name: dto.name ?? period.name,
        startDate,
        endDate,
      };
      try {
        await manager
          .getRepository(PeriodEntity)
          .update({ id: period.id }, changes);
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE });
      }
      return PeriodResponseDto.from({ ...period, ...changes });
    });
  }

  /** Solo si nada lo usa (evaluaciones, boletines): 409 si no. */
  async remove(user: AuthUser, id: string): Promise<void> {
    const institutionId = await this.writeScope(user, 'delete');
    await this.dataSource.transaction(async (manager) => {
      // Mismo orden de bloqueo que crear y editar: año y luego periodo.
      const found = await this.getOrFail(manager, institutionId, id);
      await this.getYearOrFail(
        manager,
        institutionId,
        found.academicYearId,
        true,
      );
      const period = await this.getOrFail(manager, institutionId, id, true);
      try {
        await manager.getRepository(PeriodEntity).delete({ id: period.id });
      } catch (error) {
        throw mapIntegrityError(error, { duplicate: DUPLICATE, inUse: IN_USE });
      }
    });
  }

  private async validateDates(
    manager: EntityManager,
    year: AcademicYearEntity,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<void> {
    // Fechas 'YYYY-MM-DD': el orden de texto es el orden cronológico.
    if (endDate < startDate) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la de inicio',
      );
    }
    if (Number(startDate.slice(0, 4)) !== year.year) {
      throw new BadRequestException(
        `El periodo debe empezar dentro del año lectivo ${year.year}`,
      );
    }
    const lastDay = `${year.year + 1}-12-31`;
    if (endDate > lastDay) {
      throw new BadRequestException(
        `El periodo debe terminar a más tardar el ${lastDay}`,
      );
    }
    const qb = manager
      .getRepository(PeriodEntity)
      .createQueryBuilder('p')
      .where('p.academic_year_id = :yearId', { yearId: year.id })
      .andWhere('p.start_date <= :endDate AND p.end_date >= :startDate', {
        startDate,
        endDate,
      });
    if (excludeId) qb.andWhere('p.id <> :excludeId', { excludeId });
    if (await qb.getExists()) {
      throw new ConflictException(
        'Las fechas se cruzan con otro periodo del año lectivo',
      );
    }
  }

  /** Periodo de un año de la institución (otra institución = 404). */
  private async getOrFail(
    manager: EntityManager,
    institutionId: string,
    id: string,
    lock = false,
  ): Promise<PeriodEntity> {
    const qb = manager
      .getRepository(PeriodEntity)
      .createQueryBuilder('p')
      .innerJoin(
        AcademicYearEntity,
        'y',
        'y.id = p.academic_year_id AND y.institution_id = :institutionId',
        { institutionId },
      )
      .where('p.id = :id', { id });
    if (lock) qb.setLock('pessimistic_write', undefined, ['p']);
    const period = await qb.getOne();
    if (!period) throw new NotFoundException('Periodo no encontrado');
    return period;
  }

  private async getYearOrFail(
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
      PERIODS_PERMISSION,
      action,
    );
  }
}
