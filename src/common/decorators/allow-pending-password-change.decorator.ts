import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';

/**
 * Ruta accesible aunque el usuario tenga must_change_password = true
 * (por ejemplo /auth/me y /auth/change-password). El resto responde 403.
 */
export const AllowPendingPasswordChange = () =>
  SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
