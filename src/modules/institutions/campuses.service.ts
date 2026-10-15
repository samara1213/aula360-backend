import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { containsPattern, ListQueryDto } from '../../common/dto/list-query.dto';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { PermissionsReader } from '../security/permissions-reader.service';
import { CampusResponseDto } from './dto/campus-response.dto';
import { CreateCampusDto } from './dto/create-campus.dto';
import { UpdateCampusDto } from './dto/update-campus.dto';
import { CampusEntity } from './entities/campus.entity';

/** Slug de menú que controla las sedes (permiso de @RequirePermission). */
export const CAMPUS_PERMISSION = 'institution.campuses';

/**
 * Sedes de la institución activa del usuario. Toda consulta filtra por
 * institution_id del token; un id de otra institución responde 404.
 * El alcance por sede se calcula solo con las asignaciones cuyo rol otorga el
 * permiso pedido: si todas tienen campus_id, solo ve esas sedes y no puede
 * crear, editar ni activar/desactivar.
 */
@Injectable()
export class CampusesService {
  constructor(
    @InjectRepository(CampusEntity)
    private readonly campuses: Repository<CampusEntity>,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(
    user: AuthUser,
    query: ListQueryDto,
  ): Promise<Paginated<CampusResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const scope = await this.permissions.campusScope(
      user.userId,
      institutionId,
      CAMPUS_PERMISSION,
      'view',
    );

    const qb = this.campuses
      .createQueryBuilder('c')
      .where('c.institution_id = :institutionId', { institutionId })
      .orderBy('c.name', 'ASC')
      .addOrderBy('c.id', 'ASC');
    if (scope) {
      // Sin asignaciones (no debería pasar: JwtAuthGuard exige vínculo) no ve nada.
      qb.andWhere(scope.length ? 'c.id IN (:...scope)' : 'false', { scope });
    }
    if (query.search) {
      qb.andWhere('(c.name ILIKE :pattern OR c.city ILIKE :pattern)', {
        pattern: containsPattern(query.search),
      });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('c.is_active = :isActive', { isActive: query.isActive });
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => CampusResponseDto.from(row)),
      total,
      query,
    );
  }

  async findOne(user: AuthUser, id: string): Promise<CampusResponseDto> {
    const institutionId = activeInstitutionId(user);
    const scope = await this.permissions.campusScope(
      user.userId,
      institutionId,
      CAMPUS_PERMISSION,
      'view',
    );
    if (scope && !scope.includes(id)) throw this.notFound();
    return CampusResponseDto.from(await this.getOrFail(institutionId, id));
  }

  async create(
    user: AuthUser,
    dto: CreateCampusDto,
  ): Promise<CampusResponseDto> {
    const institutionId = await this.requireInstitutionWideScope(
      user,
      'create',
    );
    const entity = this.campuses.create({
      institutionId,
      name: dto.name,
      address: dto.address ?? null,
      city: dto.city ?? null,
    });
    return CampusResponseDto.from(await this.save(entity));
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateCampusDto,
  ): Promise<CampusResponseDto> {
    rejectNullFields(dto, ['name']);
    const institutionId = await this.requireInstitutionWideScope(
      user,
      'update',
    );
    const entity = await this.getOrFail(institutionId, id);
    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.address !== undefined) entity.address = dto.address;
    if (dto.city !== undefined) entity.city = dto.city;
    return CampusResponseDto.from(await this.save(entity));
  }

  /** Activa o desactiva (lógico, permiso 'delete' en ambos sentidos): nunca se borra. */
  async setActive(
    user: AuthUser,
    id: string,
    isActive: boolean,
  ): Promise<CampusResponseDto> {
    const institutionId = await this.requireInstitutionWideScope(
      user,
      'delete',
    );
    const entity = await this.getOrFail(institutionId, id);
    if (entity.isActive !== isActive) {
      entity.isActive = isActive;
      await this.campuses.save(entity);
    }
    return CampusResponseDto.from(entity);
  }

  /** Busca por id Y institución en la misma consulta: otra institución = 404. */
  private async getOrFail(
    institutionId: string,
    id: string,
  ): Promise<CampusEntity> {
    const entity = await this.campuses.findOne({
      where: { id, institutionId },
    });
    if (!entity) throw this.notFound();
    return entity;
  }

  private async requireInstitutionWideScope(
    user: AuthUser,
    action: Exclude<PermissionAction, 'view'>,
  ): Promise<string> {
    const institutionId = activeInstitutionId(user);
    await this.permissions.requireInstitutionWide(
      user,
      institutionId,
      CAMPUS_PERMISSION,
      action,
      'Su acceso está limitado a una sede: no puede gestionar sedes',
    );
    return institutionId;
  }

  private notFound(): NotFoundException {
    return new NotFoundException('Sede no encontrada');
  }

  private async save(entity: CampusEntity): Promise<CampusEntity> {
    try {
      return await this.campuses.save(entity);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        throw new ConflictException(
          'Ya existe una sede con ese nombre en la institución',
        );
      }
      throw error;
    }
  }
}
