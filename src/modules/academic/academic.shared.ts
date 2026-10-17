import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { PermissionsReader } from '../security/permissions-reader.service';

/** Código de error de PostgreSQL de un QueryFailedError (o undefined). */
export function pgCode(error: unknown): string | undefined {
  return error instanceof QueryFailedError
    ? (error as QueryFailedError & { code?: string }).code
    : undefined;
}

/**
 * Traduce las violaciones de integridad a 409: 23505 (único repetido) y
 * 23503 (clave foránea RESTRICT: el registro está en uso o lo usado ya no existe).
 */
export function mapIntegrityError(
  error: unknown,
  messages: { duplicate: string; inUse?: string },
): unknown {
  const code = pgCode(error);
  if (code === '23505') return new ConflictException(messages.duplicate);
  if (code === '23503' && messages.inUse) {
    return new ConflictException(messages.inUse);
  }
  return error;
}

/**
 * Años, periodos, grados y materias son de toda la institución: quien está
 * limitado a sedes puede verlos, pero no crearlos, editarlos ni borrarlos.
 */
export async function requireInstitutionWideWrite(
  permissions: PermissionsReader,
  user: AuthUser,
  slug: string,
  action: Exclude<PermissionAction, 'view'>,
): Promise<string> {
  const institutionId = activeInstitutionId(user);
  await permissions.requireInstitutionWide(
    user,
    institutionId,
    slug,
    action,
    'Su acceso está limitado a sedes: esto se gestiona para toda la institución',
  );
  return institutionId;
}
