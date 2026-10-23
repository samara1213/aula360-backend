import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import {
  ENROLLMENT_STATUSES,
  type EnrollmentStatus,
} from '../../enrollments/entities/enrollment.entity';
import { EvaluationCourseDto, EvaluationPeriodDto } from './evaluation.dto';
import { GradingScaleDto } from './score.dto';

export class CourseGradebookQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Periodo del año del curso' })
  @IsUUID()
  periodId: string;
}

export class StudentGradebookQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Un periodo (excluye academicYearId)',
  })
  @IsOptional()
  @IsUUID()
  periodId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Todo el año, con la nota anual (excluye periodId). Sin ninguno: el año activo más reciente en que está matriculado.',
  })
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class GradebookSubjectDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

/** Nota de una materia en un periodo. */
export class SubjectPeriodGradeDto {
  @ApiProperty({ example: 4, description: 'Evaluaciones del periodo' })
  evaluationCount: number;

  @ApiProperty({ example: 3, description: 'Evaluaciones con nota' })
  scoredCount: number;

  @ApiProperty({
    example: 80,
    description: 'Suma de porcentajes de las evaluaciones',
  })
  allocatedPercentage: number;

  @ApiProperty({
    example: 3.2,
    description: 'Suma de nota × porcentaje / 100 de las notas registradas',
  })
  accumulated: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: null,
    description:
      'Definitiva: solo si los porcentajes suman 100 y están todas las notas',
  })
  final: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'final >= nota mínima aprobatoria; null sin definitiva',
  })
  passed: boolean | null;
}

export class CourseSubjectGradeDto extends SubjectPeriodGradeDto {
  @ApiProperty({ description: 'UUID de la asignatura', format: 'uuid' })
  subjectId: string;
}

export class GradebookStudentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
}

export class CourseGradebookRowDto {
  @ApiProperty({ type: GradebookStudentDto })
  student: GradebookStudentDto;

  @ApiProperty({ enum: ENROLLMENT_STATUSES, example: 'ENROLLED' })
  enrollmentStatus: EnrollmentStatus;

  @ApiProperty({ type: [CourseSubjectGradeDto] })
  subjects: CourseSubjectGradeDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Promedio de las definitivas del periodo; null sin ninguna',
  })
  average: number | null;
}

export class CourseGradebookDto {
  @ApiProperty({ type: EvaluationCourseDto })
  course: EvaluationCourseDto;

  @ApiProperty({ type: EvaluationPeriodDto })
  period: EvaluationPeriodDto;

  @ApiProperty({ type: GradingScaleDto })
  scale: GradingScaleDto;

  @ApiProperty({
    type: [GradebookSubjectDto],
    description: 'Materias visibles (al docente, solo las suyas)',
  })
  subjects: GradebookSubjectDto[];

  @ApiProperty({ type: [CourseGradebookRowDto] })
  students: CourseGradebookRowDto[];
}

export class StudentEvaluationScoreDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Título de la evaluación' })
  title: string;

  @ApiProperty({ example: 20 })
  percentage: number;

  @ApiProperty({ example: '2026-03-10' })
  evaluationDate: string;

  @ApiProperty({ type: Number, nullable: true, example: 4.5 })
  score: number | null;
}

export class StudentPeriodGradeDto extends SubjectPeriodGradeDto {
  @ApiProperty({ description: 'UUID del periodo', format: 'uuid' })
  periodId: string;

  @ApiProperty({ type: [StudentEvaluationScoreDto] })
  evaluations: StudentEvaluationScoreDto[];
}

export class StudentSubjectGradesDto extends GradebookSubjectDto {
  @ApiProperty({ type: [StudentPeriodGradeDto] })
  periods: StudentPeriodGradeDto[];

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Solo por año: promedio simple de las definitivas de todos los periodos; null si falta alguna',
  })
  yearFinal?: number | null;

  @ApiPropertyOptional({
    description:
      'Solo por año: si la nota anual aprueba; null si falta alguna definitiva',
    type: Boolean,
    nullable: true,
  })
  yearPassed?: boolean | null;
}

export class PeriodAverageDto {
  @ApiProperty({ description: 'UUID del periodo', format: 'uuid' })
  periodId: string;

  @ApiProperty({
    description:
      'Promedio de las definitivas del periodo; null si no hay ninguna',
    type: Number,
    nullable: true,
  })
  average: number | null;
}

export class GradebookYearDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 2026 })
  year: number;

  @ApiProperty()
  isActive: boolean;
}

export class StudentGradebookDto {
  @ApiProperty({ type: GradebookStudentDto })
  student: GradebookStudentDto;

  @ApiProperty({ enum: ENROLLMENT_STATUSES, example: 'ENROLLED' })
  enrollmentStatus: EnrollmentStatus;

  @ApiProperty({ type: EvaluationCourseDto })
  course: EvaluationCourseDto;

  @ApiProperty({ type: GradebookYearDto })
  academicYear: GradebookYearDto;

  @ApiProperty({ type: GradingScaleDto })
  scale: GradingScaleDto;

  @ApiProperty({ type: [EvaluationPeriodDto] })
  periods: EvaluationPeriodDto[];

  @ApiProperty({
    type: [StudentSubjectGradesDto],
    description: 'Materias visibles (al docente, solo las suyas)',
  })
  subjects: StudentSubjectGradesDto[];

  @ApiProperty({ type: [PeriodAverageDto] })
  periodAverages: PeriodAverageDto[];

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Solo por año: promedio de las notas anuales',
  })
  yearAverage?: number | null;
}
