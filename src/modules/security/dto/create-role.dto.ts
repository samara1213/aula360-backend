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

const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateRoleDto {
  @ApiProperty({ example: 'Coordinador académico', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'Descripción del rol',
    type: String,
    nullable: true,
    maxLength: 1000,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}
