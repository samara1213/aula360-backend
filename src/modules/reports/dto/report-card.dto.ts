import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { ReportCardEntity } from '../entities/report-card.entity';

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class GenerateReportCardDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  studentId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Periodo del año en que está matriculado',
  })
  @IsUUID()
  periodId: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Generarlo aunque falten definitivas (salen como pendientes y el promedio es parcial)',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ReportCardQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  periodId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({
    description: 'Solo desactualizados (true) o solo vigentes (false)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  outdated?: boolean;
}

class ReportCardStudentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
}

class ReportCardRefDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

export class ReportCardResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: ReportCardStudentDto })
  student: ReportCardStudentDto;

  @ApiProperty({ type: ReportCardRefDto })
  course: ReportCardRefDto;

  @ApiProperty({ type: ReportCardRefDto })
  period: ReportCardRefDto;

  @ApiProperty({
    example: 3.92,
    description: 'Promedio de las definitivas (parcial si se forzó)',
  })
  finalAverage: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Plantilla usada; null = la del sistema',
  })
  templateId: string | null;

  @ApiProperty({
    description:
      'Sus notas cambiaron después de generarlo: hay que regenerarlo',
  })
  outdated: boolean;

  @ApiProperty({ type: Date, nullable: true })
  outdatedAt: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  generatedBy: string | null;

  @ApiProperty({ description: 'Fecha de la última generación' })
  generatedAt: Date;

  static from(row: ReportCardEntity): ReportCardResponseDto {
    return {
      id: row.id,
      student: {
        id: row.student.id,
        firstName: row.student.user.firstName,
        lastName: row.student.user.lastName,
      },
      course: { id: row.course.id, name: row.course.name },
      period: { id: row.period.id, name: row.period.name },
      finalAverage: row.finalAverage,
      templateId: row.templateId,
      outdated: row.outdatedAt !== null,
      outdatedAt: row.outdatedAt,
      generatedBy: row.generatedBy,
      generatedAt: row.updatedAt,
    };
  }
}

/** Para el propio estudiante: sin quién lo generó ni la plantilla (B4). */
export class OwnReportCardDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: ReportCardRefDto })
  course: ReportCardRefDto;

  @ApiProperty({ type: ReportCardRefDto })
  period: ReportCardRefDto;

  @ApiProperty({ example: 3.92 })
  finalAverage: number;

  @ApiProperty({
    description: 'Sus notas cambiaron después de generarlo',
  })
  outdated: boolean;

  @ApiProperty({ description: 'Fecha de la última generación' })
  generatedAt: Date;

  static from(row: ReportCardEntity): OwnReportCardDto {
    return {
      id: row.id,
      course: { id: row.course.id, name: row.course.name },
      period: { id: row.period.id, name: row.period.name },
      finalAverage: row.finalAverage,
      outdated: row.outdatedAt !== null,
      generatedAt: row.updatedAt,
    };
  }
}

export class ReportCardPageDto {
  @ApiProperty({ type: [ReportCardResponseDto] })
  data: ReportCardResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}

export class ReportCardDownloadDto {
  @ApiProperty({ description: 'URL firmada del PDF' })
  url: string;

  @ApiProperty({ example: 120, description: 'Segundos de validez de la URL' })
  expiresIn: number;
}
