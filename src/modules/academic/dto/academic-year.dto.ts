import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { AcademicYearEntity } from '../entities/academic-year.entity';

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateAcademicYearDto {
  @ApiProperty({ example: 2026, minimum: MIN_YEAR, maximum: MAX_YEAR })
  @IsInt()
  @Min(MIN_YEAR)
  @Max(MAX_YEAR)
  year: number;
}

export class UpdateAcademicYearDto {
  @ApiPropertyOptional({
    example: 2026,
    minimum: MIN_YEAR,
    maximum: MAX_YEAR,
    description: 'Solo si el año aún no tiene periodos ni cursos',
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_YEAR)
  @Max(MAX_YEAR)
  year?: number;

  @ApiPropertyOptional({
    description:
      'Activo: se pueden crear cursos (y matrículas) en él. Puede haber varios activos.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AcademicYearQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filtrar por estado activo/inactivo' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class AcademicYearResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  institutionId: string;

  @ApiProperty({ example: 2026 })
  year: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  static from(entity: AcademicYearEntity): AcademicYearResponseDto {
    return {
      id: entity.id,
      institutionId: entity.institutionId,
      year: entity.year,
      isActive: entity.isActive,
      createdAt: entity.createdAt,
    };
  }
}

export class AcademicYearPageDto {
  @ApiProperty({ type: [AcademicYearResponseDto] })
  data: AcademicYearResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
