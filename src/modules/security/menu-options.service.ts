import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { CreateMenuOptionDto } from './dto/create-menu-option.dto';
import {
  MenuOptionResponseDto,
  MenuOptionTreeNodeDto,
  MyMenuNodeDto,
} from './dto/menu-option-response.dto';
import { UpdateMenuOptionDto } from './dto/update-menu-option.dto';
import { MenuOptionEntity } from './entities/menu-option.entity';
import {
  ancestorIds,
  buildTree,
  depthOf,
  MAX_MENU_DEPTH,
  subtreeHeight,
} from './menu-tree';
import { PermissionsReader } from './permissions-reader.service';

/** Slug de menú que controla la gestión de menús. */
export const MENU_PERMISSION = 'security.menu-options';

/** Clave del bloqueo de transacción que serializa los cambios de jerarquía. */
const MENU_TREE_LOCK = 'aula360.menu_options';

const ORDER = { displayOrder: 'ASC', name: 'ASC', id: 'ASC' } as const;

/**
 * Menú global (igual para todas las instituciones). Solo el SUPER_ADMIN lo
 * modifica; nunca se borra (desactivación lógica) y el slug no cambia.
 * Los cambios de jerarquía corren en transacción con un bloqueo, para que dos
 * movimientos simultáneos no creen un ciclo ni pasen de 3 niveles.
 */
@Injectable()
export class MenuOptionsService {
  constructor(
    @InjectRepository(MenuOptionEntity)
    private readonly menus: Repository<MenuOptionEntity>,
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  /** Árbol completo, incluidas las opciones inactivas. */
  async tree(): Promise<MenuOptionTreeNodeDto[]> {
    const options = await this.menus.find({ order: ORDER });
    return buildTree(options, (option) => ({
      ...MenuOptionResponseDto.from(option),
      children: [],
    }));
  }

  async findOne(id: string): Promise<MenuOptionResponseDto> {
    return MenuOptionResponseDto.from(await this.getOrFail(this.menus, id));
  }

  async create(dto: CreateMenuOptionDto): Promise<MenuOptionResponseDto> {
    return this.inTreeLock(async (repo) => {
      const parentId = dto.parentId ?? null;
      if (parentId) {
        const parentOf = await this.loadParents(repo);
        if (!parentOf.has(parentId)) {
          throw new NotFoundException('Opción padre no encontrada');
        }
        this.assertMaxDepth(depthOf(parentId, parentOf) + 1);
      }
      const entity = repo.create({
        parentId,
        name: dto.name,
        slug: dto.slug,
        icon: dto.icon ?? null,
        displayOrder: dto.displayOrder ?? 0,
      });
      return MenuOptionResponseDto.from(await this.save(repo, entity));
    });
  }

  async update(
    id: string,
    dto: UpdateMenuOptionDto,
  ): Promise<MenuOptionResponseDto> {
    rejectNullFields(dto, ['name', 'displayOrder']);
    return this.inTreeLock(async (repo) => {
      const entity = await this.getOrFail(repo, id);
      if (dto.parentId !== undefined && dto.parentId !== entity.parentId) {
        await this.assertCanMove(repo, id, dto.parentId);
        entity.parentId = dto.parentId;
      }
      if (dto.name !== undefined) entity.name = dto.name;
      if (dto.icon !== undefined) entity.icon = dto.icon;
      if (dto.displayOrder !== undefined)
        entity.displayOrder = dto.displayOrder;
      return MenuOptionResponseDto.from(await this.save(repo, entity));
    });
  }

  /** Desactivar una opción oculta su rama y le quita efecto a sus permisos. */
  async setActive(
    id: string,
    isActive: boolean,
  ): Promise<MenuOptionResponseDto> {
    const entity = await this.getOrFail(this.menus, id);
    if (entity.isActive !== isActive) {
      entity.isActive = isActive;
      await this.menus.save(entity);
    }
    return MenuOptionResponseDto.from(entity);
  }

  /**
   * Menú del usuario en la institución activa: opciones permitidas por sus
   * roles vigentes (permisos sumados) más sus ancestros, sin ramas inactivas.
   * Sin institución activa (p. ej. SUPER_ADMIN) devuelve un árbol vacío.
   * institutionWide: lo mismo contando solo las asignaciones sin sede, para que
   * el frontend no ofrezca acciones que exigen toda la institución.
   */
  async myMenu(user: AuthUser): Promise<MyMenuNodeDto[]> {
    if (!user.institutionId) return [];
    const [options, granted, wide] = await Promise.all([
      this.menus.find({ order: ORDER }),
      this.permissions.effective(user.userId, user.institutionId),
      this.permissions.effective(
        user.userId,
        user.institutionId,
        'institution',
      ),
    ]);
    const byId = new Map(options.map((option) => [option.id, option]));
    const parentOf = new Map(options.map((o) => [o.id, o.parentId]));

    const included = new Set<string>();
    for (const menuOptionId of granted.keys()) {
      const option = byId.get(menuOptionId);
      if (!option) continue;
      const branch = [menuOptionId, ...ancestorIds(menuOptionId, parentOf)];
      if (branch.every((id) => byId.get(id)?.isActive)) {
        branch.forEach((id) => included.add(id));
      }
    }

    return buildTree(
      options.filter((option) => included.has(option.id)),
      (option) => {
        const perms = granted.get(option.id);
        const widePerms = wide.get(option.id);
        return {
          id: option.id,
          name: option.name,
          slug: option.slug,
          icon: option.icon,
          displayOrder: option.displayOrder,
          permissions: {
            view: perms !== undefined,
            create: perms?.canCreate ?? false,
            update: perms?.canUpdate ?? false,
            delete: perms?.canDelete ?? false,
          },
          institutionWide: {
            view: widePerms !== undefined,
            create: widePerms?.canCreate ?? false,
            update: widePerms?.canUpdate ?? false,
            delete: widePerms?.canDelete ?? false,
          },
          children: [],
        };
      },
    );
  }

  /** Sin ciclos (no puede colgar de sí misma ni de su rama) y máximo 3 niveles. */
  private async assertCanMove(
    repo: Repository<MenuOptionEntity>,
    id: string,
    newParentId: string | null,
  ): Promise<void> {
    const parentOf = await this.loadParents(repo);
    let parentDepth = 0;
    if (newParentId !== null) {
      if (!parentOf.has(newParentId)) {
        throw new NotFoundException('Opción padre no encontrada');
      }
      if (
        newParentId === id ||
        ancestorIds(newParentId, parentOf).includes(id)
      ) {
        throw new BadRequestException(
          'Una opción no puede quedar dentro de sí misma ni de su rama',
        );
      }
      parentDepth = depthOf(newParentId, parentOf);
    }
    this.assertMaxDepth(parentDepth + subtreeHeight(id, parentOf));
  }

  private assertMaxDepth(depth: number): void {
    if (depth > MAX_MENU_DEPTH) {
      throw new BadRequestException(
        `El menú admite como máximo ${MAX_MENU_DEPTH} niveles`,
      );
    }
  }

  private async loadParents(
    repo: Repository<MenuOptionEntity>,
  ): Promise<Map<string, string | null>> {
    const rows = await repo.find({ select: { id: true, parentId: true } });
    return new Map(rows.map((row) => [row.id, row.parentId]));
  }

  private inTreeLock<T>(
    work: (repo: Repository<MenuOptionEntity>) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        MENU_TREE_LOCK,
      ]);
      return work(manager.getRepository(MenuOptionEntity));
    });
  }

  private async getOrFail(
    repo: Repository<MenuOptionEntity>,
    id: string,
  ): Promise<MenuOptionEntity> {
    const entity = await repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException('Opción de menú no encontrada');
    return entity;
  }

  private async save(
    repo: Repository<MenuOptionEntity>,
    entity: MenuOptionEntity,
  ): Promise<MenuOptionEntity> {
    try {
      return await repo.save(entity);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        throw new ConflictException('Ya existe una opción con ese slug');
      }
      throw error;
    }
  }
}
