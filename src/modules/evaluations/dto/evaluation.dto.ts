import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  AssignmentSubjectDto,
  AssignmentTeacherDto,
} from '../../academic/dto/teacher-assignment.dto';
import { EvaluationEntity } from '../entities/evaluation.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE =
  'evaluationDate debe ser una fecha válida con formato YYYY-MM-DD';

export class CreateEvaluationDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Carga académica (docente + materia + curso), activa',
  })
  @IsUUID()
  teacherAssignmentId: string;

  @ApiProperty({ format: 'uuid', description: 'Periodo del año del curso' })
  @IsUUID()
  periodId: string;

  @ApiProperty({ example: 'Taller 1', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    example: 20,
    description:
      'Porcentaje (mayor que 0, hasta 100, 2 decimales). La suma por materia, curso y periodo no puede superar 100.',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100)
  percentage: number;

  @ApiProperty({ example: '2026-03-10', description: 'Dentro del periodo' })
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsDateString({ strict: true }, { message: DATE_MESSAGE })
  evaluationDate: string;
}

export class UpdateEvaluationDto {
  @ApiPropertyOptional({
    description: 'Título de la evaluación',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    description: 'Se vuelve a validar la suma de porcentajes',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100)
  percentage?: number;

  @ApiPropertyOptional({ example: '2026-03-10' })
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsDateString({ strict: true }, { message: DATE_MESSAGE })
  evaluationDate?: string;
}

export class EvaluationQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Solo las evaluaciones de esta carga docente',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  teacherAssignmentId?: string;

  @ApiPropertyOptional({
    description: 'Solo las evaluaciones de este periodo',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  periodId?: string;

  @ApiPropertyOptional({
    description: 'Solo las evaluaciones de este curso',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    description: 'Solo las evaluaciones de esta asignatura',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  subjectId?: string;
}

export class EvaluationPeriodDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: '2026-02-01' })
  startDate: string;

  @ApiProperty({ example: '2026-04-10' })
  endDate: string;
}

export class EvaluationCourseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

export class EvaluationAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ type: EvaluationCourseDto })
  course: EvaluationCourseDto;

  @ApiProperty({ type: AssignmentSubjectDto })
  subject: AssignmentSubjectDto;

  @ApiProperty({ type: AssignmentTeacherDto })
  teacher: AssignmentTeacherDto;
}

export class EvaluationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Título de la evaluación' })
  title: string;

  @ApiProperty({ example: 20 })
  percentage: number;

  @ApiProperty({ example: '2026-03-10' })
  evaluationDate: string;

  @ApiProperty({ type: EvaluationPeriodDto })
  period: EvaluationPeriodDto;

  @ApiProperty({ type: EvaluationAssignmentDto })
  teacherAssignment: EvaluationAssignmentDto;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional({
    example: 60,
    description:
      'Solo en el detalle: suma de porcentajes de la materia en el curso y el periodo (todas las cargas, incluida la del docente anterior)',
  })
  allocatedPercentage?: number;

  /** Requiere period y teacherSubjectCourse (course, subject, teacher.user). */
  static from(
    row: EvaluationEntity,
    allocatedPercentage?: number,
  ): EvaluationResponseDto {
    const t = row.teacherSubjectCourse;
    return {
      id: row.id,
      title: row.title,
      percentage: row.percentage,
      evaluationDate: row.evaluationDate,
      period: {
        id: row.period.id,
        name: row.period.name,
        startDate: row.period.startDate,
        endDate: row.period.endDate,
      },
      teacherAssignment: {
        id: t.id,
        isActive: t.isActive,
        course: { id: t.course.id, name: t.course.name },
        subject: { id: t.subject.id, name: t.subject.name },
        teacher: {
          id: t.teacher.id,
          userId: t.teacher.userId,
          firstName: t.teacher.user.firstName,
          lastName: t.teacher.user.lastName,
        },
      },
      createdAt: row.createdAt,
      ...(allocatedPercentage !== undefined ? { allocatedPercentage } : {}),
    };
  }
}

export class EvaluationPageDto {
  @ApiProperty({ type: [EvaluationResponseDto] })
  data: EvaluationResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
