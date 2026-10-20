import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ReportCardTemplateEntity } from '../entities/report-card-template.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Campos de texto del multipart (el archivo va en `file`). */
export class CreateReportTemplateDto {
  @ApiProperty({ example: 'Boletín 2026', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ReportTemplateResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description: 'Descripción de la plantilla',
    type: String,
    nullable: true,
  })
  description: string | null;

  @ApiProperty({
    description: 'La que usan los boletines nuevos de la institución',
  })
  isActive: boolean;

  @ApiProperty({ description: 'SHA-256 del archivo HTML' })
  contentSha256: string;

  @ApiProperty({
    description: 'UUID del usuario que la subió; null si ya no existe',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  createdBy: string | null;

  @ApiProperty()
  createdAt: Date;

  static from(row: ReportCardTemplateEntity): ReportTemplateResponseDto {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      contentSha256: row.contentSha256,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }
}
