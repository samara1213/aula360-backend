import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { PENDING_PASSWORD_EXTENSION } from '../swagger/enrich-document';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';

/**
 * Ruta accesible aunque el usuario tenga must_change_password = true
 * (por ejemplo /auth/me y /auth/change-password). El resto responde 403.
 */
export const AllowPendingPasswordChange = () =>
  applyDecorators(
    SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true),
    ApiExtension(PENDING_PASSWORD_EXTENSION, true),
  );
