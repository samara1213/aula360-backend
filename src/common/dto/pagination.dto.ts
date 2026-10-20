import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const MAX_PAGE_SIZE = 100;
/** Tope de página: evita OFFSET enormes. */
export const MAX_PAGE = 10_000;

export class PaginationDto {
  @ApiPropertyOptional({
    description: 'Página, desde 1',
    default: 1,
    minimum: 1,
    maximum: MAX_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Elementos por página',
    default: 20,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = 20;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

export function paginate<T>(
  data: T[],
  total: number,
  { page, limit }: PaginationDto,
): Paginated<T> {
  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** skip/take para TypeORM a partir del DTO. */
export function toSkipTake({ page, limit }: PaginationDto): {
  skip: number;
  take: number;
} {
  return { skip: (page - 1) * limit, take: limit };
}
