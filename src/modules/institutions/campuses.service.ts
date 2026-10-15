import {
  ConflictException,
  ForbiddenException,
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
import { ACTION_COLUMN } from '../../common/guards/permissions.guard';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { ACTIVE_ASSIGNMENT_CONDITION } from '../security/active-assignment';
import { RoleMenuPermissionEntity } from '../security/entities/role-menu-permission.entity';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { CampusResponseDto } from './dto/campus-response.dto';
import { CreateCampusDto } from './dto/create-campus.dto';
import { UpdateCampusDto } from './dto/update-campus.dto';
import { CampusEntity } from './entities/campus.entity';

/** Slug de menú que controla las sedes (permiso de @RequirePermission). */
export const CAMPUS_PERMISSION = 'institution.campuses';

/** null = alcance en toda la institución; lista = solo esas sedes. */
type CampusScope = string[] | null;

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
    @InjectRepository(UserInstitutionRoleEntity)
    private readonly memberships: Repository<UserInstitutionRoleEntity>,
  ) {}

  async findAll(
    user: AuthUser,
    query: ListQueryDto,
  ): Promise<Paginated<CampusResponseDto>> {
    const institutionId = activeInstitutionId(user);
    const scope = await this.campusScope(user.userId, institutionId, 'view');

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
    const scope = await this.campusScope(user.userId, institutionId, 'view');
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

  /**
   * Alcance según las asignaciones vigentes (sede activa) cuyo rol (global o de
   * esta institución) tiene el permiso y la acción pedidos. Así, un rol sin el permiso pero sin sede no
   * amplía el alcance de otro rol que sí lo tiene pero está limitado a una sede.
   */
  private async campusScope(
    userId: string,
    institutionId: string,
    action: PermissionAction,
  ): Promise<CampusScope> {
    const qb = this.memberships
      .createQueryBuilder('uir')
      .select('DISTINCT uir.campus_id', 'campusId')
      .innerJoin(
        'uir.role',
        'r',
        'r.institution_id IS NULL OR r.institution_id = uir.institution_id',
      )
      .innerJoin(RoleMenuPermissionEntity, 'p', 'p.role_id = uir.role_id')
      .innerJoin('p.menuOption', 'm', 'm.slug = :slug AND m.is_active = true', {
        slug: CAMPUS_PERMISSION,
      })
      .where('uir.user_id = :userId AND uir.institution_id = :institutionId', {
        userId,
        institutionId,
      })
      .andWhere(ACTIVE_ASSIGNMENT_CONDITION);
    if (action !== 'view') {
      qb.andWhere(`p.${ACTION_COLUMN[action]} = true`);
    }
    const rows = await qb.getRawMany<{ campusId: string | null }>();
    if (rows.some((r) => r.campusId === null)) return null;
    return rows.map((r) => r.campusId as string);
  }

  private async requireInstitutionWideScope(
    user: AuthUser,
    action: Exclude<PermissionAction, 'view'>,
  ): Promise<string> {
    const institutionId = activeInstitutionId(user);
    if (await this.campusScope(user.userId, institutionId, action)) {
      throw new ForbiddenException(
        'Su acceso está limitado a una sede: no puede gestionar sedes',
      );
    }
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
