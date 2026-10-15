import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { RoleMenuPermissionEntity } from '../../modules/security/entities/role-menu-permission.entity';
import { UserInstitutionRoleEntity } from '../../modules/security/entities/user-institution-role.entity';
import {
  PERMISSION_KEY,
  PermissionAction,
  RequiredPermission,
  SUPER_ADMIN_ONLY_KEY,
} from '../decorators/require-permission.decorator';
import { AuthUser } from '../interfaces/auth-user.interface';
import { ACTIVE_ASSIGNMENT_CONDITION } from '../../modules/security/active-assignment';
import { activeMenuCondition } from '../../modules/security/active-menu';

/** Mapeo fijo acción -> columna (nunca se interpola texto del usuario). */
export const ACTION_COLUMN: Record<
  Exclude<PermissionAction, 'view'>,
  string
> = {
  create: 'can_create',
  update: 'can_update',
  delete: 'can_delete',
};

/**
 * Guard global de autorización. Se ejecuta después de JwtAuthGuard.
 * - @SuperAdminOnly(): exige user_type SUPER_ADMIN.
 * - @RequirePermission(slug, acción): exige el permiso en algún rol del usuario
 *   dentro de la institución activa (rol + institución, no solo rol). La opción
 *   de menú y sus ancestros deben estar activos. Con allowSuperAdmin, el
 *   SUPER_ADMIN pasa sin institución (solo catálogos globales).
 * El menú solo controla lo que se ve; la autorización real está aquí.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(RoleMenuPermissionEntity)
    private readonly permissions: Repository<RoleMenuPermissionEntity>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const superAdminOnly = this.reflector.getAllAndOverride<boolean>(
      SUPER_ADMIN_ONLY_KEY,
      targets,
    );
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      PERMISSION_KEY,
      targets,
    );
    if (!superAdminOnly && !required) return true;

    const user = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>().user;
    if (!user) throw new ForbiddenException();

    if (superAdminOnly) {
      if (user.userType !== 'SUPER_ADMIN') throw new ForbiddenException();
      if (!required) return true;
    }

    if (required.allowSuperAdmin && user.userType === 'SUPER_ADMIN') {
      return true;
    }

    if (!user.institutionId || !(await this.isAllowed(user, required))) {
      throw new ForbiddenException('No tiene permiso para esta acción');
    }
    return true;
  }

  private isAllowed(
    { userId, institutionId }: AuthUser,
    { slug, action }: RequiredPermission,
  ): Promise<boolean> {
    const qb = this.permissions
      .createQueryBuilder('p')
      .innerJoin('p.menuOption', 'm')
      .innerJoin(UserInstitutionRoleEntity, 'uir', 'uir.role_id = p.role_id')
      // Defensa adicional: solo roles globales o de la misma institución de la asignación.
      .innerJoin(
        'p.role',
        'r',
        'r.institution_id IS NULL OR r.institution_id = uir.institution_id',
      )
      .where('uir.user_id = :userId AND uir.institution_id = :institutionId', {
        userId,
        institutionId,
      })
      .andWhere(ACTIVE_ASSIGNMENT_CONDITION)
      .andWhere('m.slug = :slug', { slug })
      .andWhere(activeMenuCondition('m'));
    if (action !== 'view') {
      qb.andWhere(`p.${ACTION_COLUMN[action]} = true`);
    }
    return qb.getExists();
  }
}
