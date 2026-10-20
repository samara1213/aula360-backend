import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PeriodEntity } from '../entities/period.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'debe ser una fecha válida con formato YYYY-MM-DD';

export class CreatePeriodDto {
  @ApiProperty({ example: 'Primer periodo', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: '2026-02-02',
    description: 'Debe estar dentro del año lectivo',
  })
  @Matches(DATE_ONLY, { message: `startDate ${DATE_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `startDate ${DATE_MESSAGE}` })
  startDate: string;

  @ApiProperty({
    example: '2026-04-10',
    description:
      'Mayor o igual que startDate y, a más tardar, el 31 de diciembre del año siguiente al año lectivo (calendario B)',
  })
  @Matches(DATE_ONLY, { message: `endDate ${DATE_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `endDate ${DATE_MESSAGE}` })
  endDate: string;
}

export class UpdatePeriodDto {
  @ApiPropertyOptional({ example: 'Primer periodo', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: '2026-02-02' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: `startDate ${DATE_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `startDate ${DATE_MESSAGE}` })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-04-10' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: `endDate ${DATE_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `endDate ${DATE_MESSAGE}` })
  endDate?: string;
}

export class PeriodResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'UUID del año lectivo', format: 'uuid' })
  academicYearId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: '2026-02-02' })
  startDate: string;

  @ApiProperty({ example: '2026-04-10' })
  endDate: string;

  @ApiProperty()
  createdAt: Date;

  static from(entity: PeriodEntity): PeriodResponseDto {
    return {
      id: entity.id,
      academicYearId: entity.academicYearId,
      name: entity.name,
      startDate: entity.startDate,
      endDate: entity.endDate,
      createdAt: entity.createdAt,
    };
  }
}
