import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

/**
 * Códigos estables para que el frontend reconozca errores sin comparar el
 * texto del mensaje (que puede cambiar o traducirse). Viajan en el campo
 * `code` de la respuesta de error (AllExceptionsFilter).
 */
export const ERROR_CODES = {
  /** La contraseña es temporal: solo se permite cambiarla (403). */
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /**
   * El refresh token se acaba de rotar (otra pestaña renovó a la vez): no es
   * robo, las cookies nuevas ya están en el navegador (401, sin borrarlas).
   */
  REFRESH_TOKEN_ROTATED: 'REFRESH_TOKEN_ROTATED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class PasswordChangeRequiredException extends ForbiddenException {
  constructor() {
    super({
      message: 'Debe cambiar la contraseña',
      code: ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
    });
  }
}

export class RefreshTokenRotatedException extends UnauthorizedException {
  constructor() {
    super({
      message: 'La sesión ya se renovó',
      code: ERROR_CODES.REFRESH_TOKEN_ROTATED,
    });
  }
}
