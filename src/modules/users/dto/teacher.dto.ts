import {
  ApiPropertyOptional,
  IntersectionType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';
import { UserPersonalDataDto } from './create-user.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class TeacherProfileFieldsDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Licenciado en Matemáticas',
    maxLength: 150,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  academicDegree?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Álgebra',
    maxLength: 150,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  specialty?: string | null;
}

/** Alta del docente: crea el usuario TEACHER, su rol TEACHER y el perfil. */
export class CreateTeacherDto extends IntersectionType(
  UserPersonalDataDto,
  TeacherProfileFieldsDto,
) {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Sede donde trabaja (null = toda la institución). Obligatoria si su acceso está limitado a sedes.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  campusId?: string | null;
}

/** Datos personales (mismas reglas que PATCH /users/:id) y del perfil. */
export class UpdateTeacherDto extends IntersectionType(
  PartialType(UserPersonalDataDto),
  TeacherProfileFieldsDto,
) {}

/** search: nombres, documento o email. */
export class TeacherQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Asignados a esta sede' })
  @IsOptional()
  @IsUUID()
  campusId?: string;
}
