import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'permission';
export const SUPER_ADMIN_ONLY_KEY = 'superAdminOnly';

export type PermissionAction = 'view' | 'create' | 'update' | 'delete';

export interface RequiredPermission {
  slug: string;
  action: PermissionAction;
  /** El SUPER_ADMIN pasa aunque no tenga institución activa (catálogos globales). */
  allowSuperAdmin?: boolean;
}

/**
 * Exige un permiso del rol del usuario en la institución activa
 * (role_menu_permissions). La fila existente permite "view".
 */
export const RequirePermission = (
  slug: string,
  action: PermissionAction,
  options: { allowSuperAdmin?: boolean } = {},
) =>
  SetMetadata(PERMISSION_KEY, {
    slug,
    action,
    ...options,
  } satisfies RequiredPermission);

/** Solo usuarios con user_type = SUPER_ADMIN (gestión de instituciones). */
export const SuperAdminOnly = () => SetMetadata(SUPER_ADMIN_ONLY_KEY, true);
