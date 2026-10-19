import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token recibido por correo' })
  @IsString()
  @Matches(/^[a-f0-9]{96}$/, { message: 'Token inválido' })
  token: string;
}

export class ChangeOwnEmailDto {
  @ApiProperty({
    example: 'nuevo@colegio.edu.co',
    description: 'Queda pendiente hasta confirmarlo con el enlace',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ description: 'Contraseña actual' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  currentPassword: string;
}
