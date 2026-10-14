import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, ValidateBy } from 'class-validator';
import {
  isStrongPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
} from '../../../common/validators/password-policy';

/**
 * Nueva contraseña con la política del sistema. El máximo se cuenta en bytes
 * UTF-8 (no en caracteres), porque bcrypt trunca en silencio a 72 bytes.
 */
export const StrongPassword = () =>
  applyDecorators(
    ApiProperty({
      description: PASSWORD_POLICY_MESSAGE,
      example: 'Nueva*Clave2026',
      minLength: PASSWORD_MIN_LENGTH,
      maxLength: PASSWORD_MAX_LENGTH,
    }),
    IsString(),
    ValidateBy({
      name: 'strongPassword',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isStrongPassword(value),
        defaultMessage: () => PASSWORD_POLICY_MESSAGE,
      },
    }),
  );
