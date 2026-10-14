import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { StrongPassword } from './password-fields';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token recibido por correo' })
  @IsString()
  @Matches(/^[a-f0-9]{96}$/, { message: 'Token inválido' })
  token: string;

  @StrongPassword()
  newPassword: string;
}
