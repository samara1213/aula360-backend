import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
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
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { CreateRoleDto } from './dto/create-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import {
  RoleDetailDto,
  RolePermissionDto,
  RoleResponseDto,
} from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { MenuOptionEntity } from './entities/menu-option.entity';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { RoleEntity } from './entities/role.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';
import {
  MenuPermission,
  PermissionsReader,
} from './permissions-reader.service';
import { ASSIGNMENT_PERMISSION } from './role-assignments.service';

/** Slug de menú que controla la gestión de roles. */
export const ROLE_PERMISSION = 'security.roles';

/**
 * Permisos que nadie se puede quitar de un rol que tiene asignado: sin ellos
 * la institución podría quedar sin quien gestione roles y usuarios.
 */
const SELF_MANAGEMENT_SLUGS = [ROLE_PERMISSION, ASSIGNMENT_PERMISSION];

/**
 * global: roles del sistema (institution_id NULL), solo el SUPER_ADMIN.
 * institution: roles visibles en la institución activa (globales en solo
 * lectura + los propios). La institución sale siempre del token.
 */
export type RoleScope =
  | { kind: 'global' }
  | { kind: 'institution'; user: AuthUser; institutionId: string };

type WriteAction = Exclude<PermissionAction, 'view'>;

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(RoleMenuPermissionEntity)
    private readonly rolePermissions: Repository<RoleMenuPermissionEntity>,
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(
    scope: RoleScope,
    query: SearchQueryDto,
  ): Promise<Paginated<RoleResponseDto>> {
    const qb = this.roles.createQueryBuilder('r');
    if (scope.kind === 'global') {
      qb.where('r.institution_id IS NULL');
    } else {
      qb.where(
        '(r.institution_id IS NULL OR r.institution_id = :institutionId)',
        { institutionId: scope.institutionId },
      );
    }
    if (query.search) {
      qb.andWhere('r.name ILIKE :pattern', {
        pattern: containsPattern(query.search),
      });
    }
    // Primero los globales, luego los propios; dentro, por nombre.
    qb.orderBy('r.institution_id IS NULL', 'DESC')
      .addOrderBy('r.name', 'ASC')
      .addOrderBy('r.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => RoleResponseDto.from(row)),
      total,
      query,
    );
  }

  async findOne(scope: RoleScope, id: string): Promise<RoleDetailDto> {
    const role = await this.getVisibleOrFail(this.roles, scope, id);
    return this.toDetail(this.rolePermissions, role);
  }

  async create(scope: RoleScope, dto: CreateRoleDto): Promise<RoleDetailDto> {
    if (scope.kind === 'institution') {
      await this.requireInstitutionWide(scope, 'create');
    }
    const role = await this.save(
      this.roles,
      this.roles.create({
        institutionId:
          scope.kind === 'institution' ? scope.institutionId : null,
        name: dto.name,
        description: dto.description ?? null,
      }),
    );
    return { ...RoleResponseDto.from(role), permissions: [] };
  }

  async update(
    scope: RoleScope,
    id: string,
    dto: UpdateRoleDto,
  ): Promise<RoleDetailDto> {
    rejectNullFields(dto, ['name']);
    return this.dataSource.transaction(async (manager) => {
      const role = await this.getWritableOrFail(manager, scope, id, 'update');
      if (dto.name !== undefined) role.name = dto.name;
      if (dto.description !== undefined) role.description = dto.description;
      const repo = manager.getRepository(RoleEntity);
      return this.toDetail(
        manager.getRepository(RoleMenuPermissionEntity),
        await this.save(repo, role),
      );
    });
  }

  /** Reemplaza todos los permisos del rol en una transacción. */
  async replacePermissions(
    scope: RoleScope,
    id: string,
    dto: ReplaceRolePermissionsDto,
  ): Promise<RoleDetailDto> {
    const requested: MenuPermission[] = dto.permissions.map((p) => ({
      menuOptionId: p.menuOptionId,
      canCreate: p.canCreate ?? false,
      canUpdate: p.canUpdate ?? false,
      canDelete: p.canDelete ?? false,
    }));
    const menuIds = requested.map((p) => p.menuOptionId);
    if (new Set(menuIds).size !== menuIds.length) {
      throw new BadRequestException(
        'Una opción de menú aparece más de una vez',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const role = await this.getWritableOrFail(manager, scope, id, 'update');
      if (menuIds.length) {
        const found = await manager
          .getRepository(MenuOptionEntity)
          .countBy({ id: In(menuIds) });
        if (found !== menuIds.length) {
          throw new NotFoundException('Opción de menú no encontrada');
        }
      }
      // Lo que se otorga también debe estar dentro de los permisos de quien actúa.
      await this.assertWithinCeiling(scope, requested);
      await this.assertKeepsSelfManagement(manager, scope, role, requested);

      const permRepo = manager.getRepository(RoleMenuPermissionEntity);
      await permRepo.delete({ roleId: role.id });
      if (requested.length) {
        await permRepo.insert(
          requested.map((p) => ({ ...p, roleId: role.id })),
        );
      }
      return this.toDetail(permRepo, role);
    });
  }

  /** Borra el rol (y sus permisos en cascada) solo si nadie lo tiene asignado. */
  async remove(scope: RoleScope, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const role = await this.getWritableOrFail(manager, scope, id, 'delete');
      const assigned = await manager
        .getRepository(UserInstitutionRoleEntity)
        .existsBy({ roleId: role.id });
      if (assigned) throw this.assignedConflict();
      try {
        await manager.getRepository(RoleEntity).delete({ id: role.id });
      } catch (error) {
        if (this.pgCode(error) === '23503') throw this.assignedConflict();
        throw error;
      }
    });
  }

  /**
   * Rol visible y modificable desde este alcance, bloqueado para la transacción.
   * Desde una institución: los globales son de solo lectura (403), el que
   * actúa no puede estar limitado a una sede y no puede tocar un rol con
   * permisos que él no tiene.
   */
  private async getWritableOrFail(
    manager: EntityManager,
    scope: RoleScope,
    id: string,
    action: WriteAction,
  ): Promise<RoleEntity> {
    const repo = manager.getRepository(RoleEntity);
    const role = await this.getVisibleOrFail(repo, scope, id, true);
    if (scope.kind === 'institution') {
      if (role.institutionId === null) {
        throw new ForbiddenException(
          'Los roles globales solo los gestiona el SUPER_ADMIN',
        );
      }
      await this.requireInstitutionWide(scope, action);
      const current = await manager
        .getRepository(RoleMenuPermissionEntity)
        .find({ where: { roleId: role.id } });
      await this.assertWithinCeiling(scope, current);
    }
    return role;
  }

  /**
   * Si quien actúa tiene asignado este rol, no puede quitarle (ni reducirle)
   * los permisos de gestión de roles y usuarios que hoy le da. El SUPER_ADMIN
   * está exento: siempre puede recuperar una institución.
   */
  private async assertKeepsSelfManagement(
    manager: EntityManager,
    scope: RoleScope,
    role: RoleEntity,
    requested: readonly MenuPermission[],
  ): Promise<void> {
    if (scope.kind !== 'institution' || scope.user.userType === 'SUPER_ADMIN') {
      return;
    }
    const holdsRole = await manager
      .getRepository(UserInstitutionRoleEntity)
      .existsBy({
        userId: scope.user.userId,
        institutionId: scope.institutionId,
        roleId: role.id,
      });
    if (!holdsRole) return;

    const current = await manager
      .getRepository(RoleMenuPermissionEntity)
      .createQueryBuilder('p')
      .innerJoin('p.menuOption', 'm')
      .where('p.role_id = :roleId', { roleId: role.id })
      .andWhere('m.slug IN (:...slugs)', { slugs: SELF_MANAGEMENT_SLUGS })
      .getMany();
    const byMenu = new Map(requested.map((p) => [p.menuOptionId, p]));
    const loses = current.some((held) => {
      const next = byMenu.get(held.menuOptionId);
      return (
        !next ||
        (held.canCreate && !next.canCreate) ||
        (held.canUpdate && !next.canUpdate) ||
        (held.canDelete && !next.canDelete)
      );
    });
    if (loses) {
      throw new ConflictException(
        'No puede quitar a un rol que usted tiene asignado los permisos para gestionar roles y usuarios',
      );
    }
  }

  /** Otra institución o fuera del alcance = 404 (no se revela que existe). */
  private async getVisibleOrFail(
    repo: Repository<RoleEntity>,
    scope: RoleScope,
    id: string,
    lock = false,
  ): Promise<RoleEntity> {
    // La institución va en la misma consulta que bloquea: nunca se bloquea
    // un rol de otra institución (V4 de la fase 11c).
    const role = await repo.findOne({
      where:
        scope.kind === 'institution'
          ? [
              { id, institutionId: IsNull() },
              { id, institutionId: scope.institutionId },
            ]
          : { id, institutionId: IsNull() },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!role) throw new NotFoundException('Rol no encontrado');
    return role;
  }

  private requireInstitutionWide(
    scope: Extract<RoleScope, { kind: 'institution' }>,
    action: WriteAction,
  ): Promise<void> {
    return this.permissions.requireInstitutionWide(
      scope.user,
      scope.institutionId,
      ROLE_PERMISSION,
      action,
      'Su acceso está limitado a una sede: no puede gestionar roles',
    );
  }

  /** Un rol se puede asignar en toda la institución: el techo es el de toda la institución. */
  private async assertWithinCeiling(
    scope: RoleScope,
    perms: readonly MenuPermission[],
  ): Promise<void> {
    if (scope.kind === 'institution') {
      await this.permissions.assertWithinCeiling(
        scope.user,
        scope.institutionId,
        perms,
        'institution',
      );
    }
  }

  private async toDetail(
    permRepo: Repository<RoleMenuPermissionEntity>,
    role: RoleEntity,
  ): Promise<RoleDetailDto> {
    const rows = await permRepo
      .createQueryBuilder('p')
      .innerJoinAndSelect('p.menuOption', 'm')
      .where('p.role_id = :roleId', { roleId: role.id })
      .orderBy('m.slug', 'ASC')
      .getMany();
    const permissions: RolePermissionDto[] = rows.map((p) => ({
      menuOptionId: p.menuOptionId,
      slug: p.menuOption.slug,
      name: p.menuOption.name,
      canCreate: p.canCreate,
      canUpdate: p.canUpdate,
      canDelete: p.canDelete,
    }));
    return { ...RoleResponseDto.from(role), permissions };
  }

  private assignedConflict(): ConflictException {
    return new ConflictException(
      'El rol está asignado a usuarios: quite las asignaciones antes de borrarlo',
    );
  }

  private pgCode(error: unknown): string | undefined {
    return error instanceof QueryFailedError
      ? (error as QueryFailedError & { code?: string }).code
      : undefined;
  }

  private async save(
    repo: Repository<RoleEntity>,
    role: RoleEntity,
  ): Promise<RoleEntity> {
    try {
      return await repo.save(role);
    } catch (error) {
      if (this.pgCode(error) === '23505') {
        throw new ConflictException('Ya existe un rol con ese nombre');
      }
      throw error;
    }
  }
}
