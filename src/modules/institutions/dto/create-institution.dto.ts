import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Columnas DECIMAL(4,2): de 0 a 99.99 con máximo 2 decimales. */
const SCALE_VALUE = { maxDecimalPlaces: 2, allowNaN: false } as const;

export class CreateInstitutionDto {
  @ApiProperty({ example: '000000000-0', maxLength: 50 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[0-9A-Za-z.-]+$/, {
    message: 'nit solo admite números, letras, puntos y guiones',
  })
  nit: string;

  @ApiProperty({ example: 'Colegio San José', maxLength: 255 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsNumber(SCALE_VALUE)
  @Min(0)
  @Max(99.99)
  gradingScaleMin?: number;

  @ApiPropertyOptional({ example: 5, default: 5 })
  @IsOptional()
  @IsNumber(SCALE_VALUE)
  @Min(0)
  @Max(99.99)
  gradingScaleMax?: number;

  @ApiPropertyOptional({
    example: 3,
    default: 3,
    description: 'Nota mínima aprobatoria (entre el mínimo y el máximo)',
  })
  @IsOptional()
  @IsNumber(SCALE_VALUE)
  @Min(0)
  @Max(99.99)
  passingScore?: number;
}
