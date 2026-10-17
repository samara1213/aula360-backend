import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget } from 'typeorm';
import {
  containsPattern,
  SearchQueryDto,
} from '../../common/dto/list-query.dto';
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
import { CatalogItemResponseDto } from './dto/catalog.dto';
import { GradeEntity } from './entities/grade.entity';
import { SubjectEntity } from './entities/subject.entity';

type CatalogEntity = GradeEntity | SubjectEntity;

interface CatalogConfig {
  entity: EntityTarget<CatalogEntity>;
  permission: string;
  notFound: string;
  duplicate: string;
  inUse: string;
}

/**
 * Catálogos de la institución activa con solo un nombre único (grados y
 * materias). Son de toda la institución: quien está limitado a sedes solo
 * los consulta. Se borran solo si nada los usa (409 si no). Editar y borrar
 * bloquean la fila (FOR UPDATE): una edición nunca revive un registro borrado.
 */
abstract class CatalogService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly config: CatalogConfig,
  ) {}

  async findAll(
    user: AuthUser,
    query: SearchQueryDto,
  ): Promise<Paginated<CatalogItemResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const qb = this.repo()
      .createQueryBuilder('x')
      .where('x.institution_id = :institutionId', { institutionId })
      .orderBy('x.name', 'ASC')
      .addOrderBy('x.id', 'ASC');
    if (query.search) {
      qb.andWhere('x.name ILIKE :pattern', {
        pattern: containsPattern(query.search),
      });
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => CatalogItemResponseDto.from(row)),
      total,
      query,
    );
  }

  async findOne(user: AuthUser, id: string): Promise<CatalogItemResponseDto> {
    const institutionId = activeInstitutionId(user);
    return CatalogItemResponseDto.from(
      await this.getOrFail(this.dataSource.manager, institutionId, id),
    );
  }

  async create(
    user: AuthUser,
    dto: { name: string },
  ): Promise<CatalogItemResponseDto> {
    const institutionId = await this.writeScope(user, 'create');
    const repo = this.repo();
    return CatalogItemResponseDto.from(
      await this.save(repo.create({ institutionId, name: dto.name })),
    );
  }

  async update(
    user: AuthUser,
    id: string,
    dto: { name?: string },
  ): Promise<CatalogItemResponseDto> {
    rejectNullFields(dto, ['name']);
    const institutionId = await this.writeScope(user, 'update');
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.getOrFail(manager, institutionId, id, true);
      if (dto.name !== undefined && dto.name !== entity.name) {
        try {
          await manager
            .getRepository(this.config.entity)
            .update({ id: entity.id }, { name: dto.name });
        } catch (error) {
          throw mapIntegrityError(error, { duplicate: this.config.duplicate });
        }
        entity.name = dto.name;
      }
      return CatalogItemResponseDto.from(entity);
    });
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const institutionId = await this.writeScope(user, 'delete');
    await this.dataSource.transaction(async (manager) => {
      const entity = await this.getOrFail(manager, institutionId, id, true);
      try {
        await manager
          .getRepository(this.config.entity)
          .delete({ id: entity.id });
      } catch (error) {
        throw mapIntegrityError(error, {
          duplicate: this.config.duplicate,
          inUse: this.config.inUse,
        });
      }
    });
  }

  private repo() {
    return this.dataSource.getRepository(this.config.entity);
  }

  /** Por id E institución en la misma consulta: otra institución = 404. */
  private async getOrFail(
    manager: EntityManager,
    institutionId: string,
    id: string,
    lock = false,
  ): Promise<CatalogEntity> {
    const entity = await manager.getRepository(this.config.entity).findOne({
      where: { id, institutionId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!entity) throw new NotFoundException(this.config.notFound);
    return entity;
  }

  private async save(entity: CatalogEntity): Promise<CatalogEntity> {
    try {
      return await this.repo().save(entity);
    } catch (error) {
      throw mapIntegrityError(error, { duplicate: this.config.duplicate });
    }
  }

  private writeScope(
    user: AuthUser,
    action: 'create' | 'update' | 'delete',
  ): Promise<string> {
    return requireInstitutionWideWrite(
      this.permissions,
      user,
      this.config.permission,
      action,
    );
  }
}

export const GRADES_PERMISSION = 'academic.grades';
export const SUBJECTS_PERMISSION = 'academic.subjects';

@Injectable()
export class GradesService extends CatalogService {
  constructor(dataSource: DataSource, permissions: PermissionsReader) {
    super(dataSource, permissions, {
      entity: GradeEntity,
      permission: GRADES_PERMISSION,
      notFound: 'Grado no encontrado',
      duplicate: 'Ya existe un grado con ese nombre en la institución',
      inUse: 'El grado tiene cursos: no se puede borrar',
    });
  }
}

@Injectable()
export class SubjectsService extends CatalogService {
  constructor(dataSource: DataSource, permissions: PermissionsReader) {
    super(dataSource, permissions, {
      entity: SubjectEntity,
      permission: SUBJECTS_PERMISSION,
      notFound: 'Materia no encontrada',
      duplicate: 'Ya existe una materia con ese nombre en la institución',
      inUse: 'La materia tiene carga académica: no se puede borrar',
    });
  }
}
