import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from './pagination.dto';

/** Convierte 'true'/'false' del query string a boolean (otro valor falla en @IsBoolean). */
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Paginación + búsqueda por texto + filtro por estado (is_active). */
export class ListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Texto a buscar', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filtrar por estado activo/inactivo' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

/** Patrón ILIKE "contiene", escapando los comodines del texto del usuario. */
export function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  totalPages: number;
}
