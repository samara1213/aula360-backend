import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Texto opcional: '' o null dejan el campo en NULL. */
const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateCampusDto {
  @ApiProperty({ example: 'Sede Principal', maxLength: 255 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Calle 10 # 5-20',
    maxLength: 255,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Bogotá',
    maxLength: 100,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(100)
  city?: string | null;
}
