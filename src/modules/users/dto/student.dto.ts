import {
  ApiPropertyOptional,
  IntersectionType,
  PartialType,
} from '@nestjs/swagger';
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
import { ListQueryDto } from '../../../common/dto/list-query.dto';
import { UserPersonalDataDto } from './create-user.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export const BLOOD_TYPES = [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
] as const;

export class StudentProfileFieldsDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-0153',
    maxLength: 50,
    description: 'Código del estudiante (único en la institución)',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[0-9A-Za-z-]+$/, {
    message: 'studentCode solo admite números, letras y guiones',
  })
  studentCode?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Marta Gómez',
    maxLength: 150,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  guardianName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+57 300 765 4321',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[0-9+() -]+$/, {
    message: 'guardianPhone solo admite números, espacios y + ( ) -',
  })
  guardianPhone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'marta.gomez@correo.com',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsEmail()
  @MaxLength(255)
  guardianEmail?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: BLOOD_TYPES,
    description:
      'Dato sensible (Ley 1581 de 2012): solo lo ve quien puede editar al estudiante',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trimUpper)
  @IsIn(BLOOD_TYPES)
  bloodType?: string | null;
}

const CAMPUS_DESCRIPTION =
  'Sede del estudiante (null = sin sede). Obligatoria si su acceso está limitado a sedes.';

/** Alta del estudiante: crea el usuario STUDENT, su rol STUDENT en la sede y el perfil. */
export class CreateStudentDto extends IntersectionType(
  UserPersonalDataDto,
  StudentProfileFieldsDto,
) {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: CAMPUS_DESCRIPTION,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  campusId?: string | null;
}

/**
 * Datos personales (mismas reglas que PATCH /users/:id), del perfil y la sede
 * (cambiarla mueve también su rol STUDENT a la sede nueva).
 */
export class UpdateStudentDto extends IntersectionType(
  PartialType(UserPersonalDataDto),
  StudentProfileFieldsDto,
) {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: CAMPUS_DESCRIPTION,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  campusId?: string | null;
}

/** search: nombres, documento o código. */
export class StudentQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'De esta sede' })
  @IsOptional()
  @IsUUID()
  campusId?: string;
}
