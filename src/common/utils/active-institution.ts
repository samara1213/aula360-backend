import { ForbiddenException } from '@nestjs/common';
import { AuthUser } from '../interfaces/auth-user.interface';

/**
 * Institución activa del usuario (siempre la del token, nunca la del cliente).
 * PermissionsGuard ya la exige en rutas con @RequirePermission; esto es la defensa en el service.
 */
export function activeInstitutionId(user: AuthUser): string {
  if (!user.institutionId) {
    throw new ForbiddenException('Debe seleccionar una institución');
  }
  return user.institutionId;
}
