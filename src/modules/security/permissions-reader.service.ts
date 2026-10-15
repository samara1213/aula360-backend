import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { ACTION_COLUMN } from '../../common/guards/permissions.guard';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { ACTIVE_ASSIGNMENT_CONDITION } from './active-assignment';
import { activeMenuCondition } from './active-menu';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';

/** null = alcance en toda la institución; lista = solo esas sedes. */
export type CampusScope = string[] | null;

export interface PermissionFlags {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/**
 * Alcance en el que se evalúan los permisos: 'institution' = solo asignaciones
 * de toda la institución; un id de sede = las de toda la institución más las
 * de esa sede; undefined = todas las vigentes.
 */
export type PermissionTarget = string;

/** Permiso sobre una opción de menú (la fila existente implica "ver"). */
export interface MenuPermission extends PermissionFlags {
  menuOptionId: string;
}

/**
 * Consultas de solo lectura sobre los permisos efectivos de un usuario en una
 * institución: suma de todos sus roles vigentes (asignación de toda la
 * institución o de sede activa; rol global o de esa misma institución).
 */
@Injectable()
export class PermissionsReader {
  constructor(
    @InjectRepository(UserInstitutionRoleEntity)
    private readonly memberships: Repository<UserInstitutionRoleEntity>,
    @InjectRepository(RoleMenuPermissionEntity)
    private readonly permissions: Repository<RoleMenuPermissionEntity>,
  ) {}

  /** Permisos efectivos por menu_option_id (sin filtrar menús inactivos). */
  async effective(
    userId: string,
    institutionId: string,
    target?: PermissionTarget,
  ): Promise<Map<string, PermissionFlags>> {
    const qb = this.permissions
      .createQueryBuilder('p')
      .select('p.menu_option_id', 'menuOptionId')
      .addSelect('bool_or(p.can_create)', 'canCreate')
      .addSelect('bool_or(p.can_update)', 'canUpdate')
      .addSelect('bool_or(p.can_delete)', 'canDelete')
      .innerJoin(UserInstitutionRoleEntity, 'uir', 'uir.role_id = p.role_id')
      .innerJoin(
        'p.role',
        'r',
        'r.institution_id IS NULL OR r.institution_id = uir.institution_id',
      )
      .where('uir.user_id = :userId AND uir.institution_id = :institutionId', {
        userId,
        institutionId,
      })
      .andWhere(ACTIVE_ASSIGNMENT_CONDITION);
    if (target === 'institution') {
      qb.andWhere('uir.campus_id IS NULL');
    } else if (target !== undefined) {
      qb.andWhere('(uir.campus_id IS NULL OR uir.campus_id = :targetCampus)', {
        targetCampus: target,
      });
    }
    const rows = await qb
      .groupBy('p.menu_option_id')
      .getRawMany<MenuPermission>();
    return new Map(
      rows.map(({ menuOptionId, canCreate, canUpdate, canDelete }) => [
        menuOptionId,
        { canCreate, canUpdate, canDelete },
      ]),
    );
  }

  /**
   * Regla "no se puede dar más de lo que se tiene": cada permiso pedido debe
   * estar entre los permisos efectivos de quien actúa EN EL ALCANCE DE DESTINO
   * (un permiso que solo tiene en una sede no sirve para otorgarlo en toda la
   * institución ni en otra sede). El SUPER_ADMIN está exento.
   */
  async assertWithinCeiling(
    actor: AuthUser,
    institutionId: string,
    requested: readonly MenuPermission[],
    target: PermissionTarget,
  ): Promise<void> {
    if (actor.userType === 'SUPER_ADMIN' || requested.length === 0) return;
    const own = await this.effective(actor.userId, institutionId, target);
    const exceeds = requested.some((perm) => {
      const held = own.get(perm.menuOptionId);
      return (
        !held ||
        (perm.canCreate && !held.canCreate) ||
        (perm.canUpdate && !held.canUpdate) ||
        (perm.canDelete && !held.canDelete)
      );
    });
    if (exceeds) {
      throw new ForbiddenException(
        'No puede otorgar ni gestionar permisos que usted no tiene',
      );
    }
  }

  /**
   * Alcance por sede según las asignaciones vigentes cuyo rol tiene el permiso
   * y la acción pedidos. Así, un rol sin el permiso pero sin sede no amplía el
   * alcance de otro rol que sí lo tiene pero está limitado a una sede.
   */
  async campusScope(
    userId: string,
    institutionId: string,
    slug: string,
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
      .innerJoin(
        'p.menuOption',
        'm',
        `m.slug = :slug AND ${activeMenuCondition('m')}`,
        { slug },
      )
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

  /** 403 si el permiso del usuario para esa acción está limitado a sedes. */
  async requireInstitutionWide(
    user: AuthUser,
    institutionId: string,
    slug: string,
    action: Exclude<PermissionAction, 'view'>,
    message: string,
  ): Promise<void> {
    if (await this.campusScope(user.userId, institutionId, slug, action)) {
      throw new ForbiddenException(message);
    }
  }
}
