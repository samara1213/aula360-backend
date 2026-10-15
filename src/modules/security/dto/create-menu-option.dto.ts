import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Segmentos en minúsculas separados por puntos: "academic.courses". */
export const MENU_SLUG_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

export class CreateMenuOptionDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Opción padre (null o ausente = raíz)',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  parentId?: string | null;

  @ApiProperty({ example: 'Cursos', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: 'academic.courses',
    maxLength: 255,
    description:
      'Clave de permiso (@RequirePermission). No se puede cambiar después.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  @Matches(MENU_SLUG_PATTERN, {
    message:
      'slug debe tener segmentos en minúsculas, números o guiones separados por puntos',
  })
  slug: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'school',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(100)
  icon?: string | null;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  displayOrder?: number;
}
