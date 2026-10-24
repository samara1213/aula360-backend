import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { UserType } from '../entities/user.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Tipos que un administrador puede crear (el SUPER_ADMIN solo lo crea el seed). */
export const CREATABLE_USER_TYPES = [
  'INSTITUTION_ADMIN',
  'TEACHER',
  'STUDENT',
] as const satisfies readonly UserType[];

/** Datos personales del usuario (compartidos con los perfiles de la fase 7b). */
export class UserPersonalDataDto {
  @ApiProperty({ example: 'CC', maxLength: 20, description: 'CC, TI, CE...' })
  @Transform(trimUpper)
  @IsString()
  @Matches(/^[A-Z]{1,20}$/, { message: 'documentType solo admite letras' })
  documentType: string;

  @ApiProperty({
    example: '0000000000',
    maxLength: 50,
    description: 'Número de documento',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[0-9A-Za-z-]+$/, {
    message: 'documentNumber solo admite números, letras y guiones',
  })
  documentNumber: string;

  @ApiProperty({ example: 'Ana María', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty({ example: 'Pérez Gómez', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ana.perez@ejemplo.test',
    description: 'Opcional (muchos estudiantes no tienen correo)',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+57 300 000 0000',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[0-9+() -]+$/, {
    message: 'phone solo admite números, espacios y + ( ) -',
  })
  phone?: string | null;
}

/** Lo único que se crea por POST /users (B3 de la 3c). */
export const USERS_ENDPOINT_TYPES = ['INSTITUTION_ADMIN'] as const;

/**
 * POST /users solo crea personal administrativo: los docentes y estudiantes
 * se crean con su perfil (POST /teachers y POST /students), que reutilizan
 * este DTO internamente con su propio userType.
 */
export class CreateUserDto extends UserPersonalDataDto {
  @ApiProperty({
    description:
      'Tipo de usuario a crear. Docentes y estudiantes: POST /teachers y POST /students',
    enum: USERS_ENDPOINT_TYPES,
  })
  @IsIn(USERS_ENDPOINT_TYPES, {
    message:
      'Por aquí solo se crea personal administrativo: los docentes y estudiantes se crean desde Personas',
  })
  userType: (typeof CREATABLE_USER_TYPES)[number];

  @ApiProperty({
    format: 'uuid',
    description: 'Rol global o de la institución (primera asignación)',
  })
  @IsUUID()
  roleId: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede activa de la institución (null = toda la institución)',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  campusId?: string | null;
}
