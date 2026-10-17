import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { EvaluationResponseDto } from './evaluation.dto';

/** Filas por lote: más que un curso grande, menos que un abuso. */
export const MAX_SCORES_BATCH = 200;

export class ScoreEntryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  studentId: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4.5,
    description:
      'Nota con hasta 2 decimales, dentro de la escala de la institución; null quita la nota',
  })
  @ValidateIf((o: ScoreEntryDto) => o.score !== null)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  score: number | null;
}

export class UpsertScoresDto {
  @ApiProperty({
    type: [ScoreEntryDto],
    description: `De 1 a ${MAX_SCORES_BATCH} filas, sin estudiantes repetidos. Si una fila es inválida no se guarda ninguna.`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SCORES_BATCH)
  @ValidateNested({ each: true })
  @Type(() => ScoreEntryDto)
  scores: ScoreEntryDto[];
}

export class GradingScaleDto {
  @ApiProperty({ example: 1 })
  min: number;

  @ApiProperty({ example: 5 })
  max: number;

  @ApiProperty({ example: 3 })
  passingScore: number;
}

export class ScoreStudentDto {
  @ApiProperty({ format: 'uuid' })
  studentId: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({
    nullable: true,
    example: 'ENROLLED',
    description:
      'Estado de su matrícula en el curso; null si ya no está matriculado en él pero conserva la nota',
  })
  enrollmentStatus: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 4.5 })
  score: number | null;

  @ApiProperty({ enum: ['GRADED', 'PENDING'] })
  status: 'GRADED' | 'PENDING';

  @ApiProperty({ type: Date, nullable: true })
  updatedAt: Date | null;
}

export class EvaluationScoresDto {
  @ApiProperty({ type: EvaluationResponseDto })
  evaluation: EvaluationResponseDto;

  @ApiProperty({ type: GradingScaleDto })
  scale: GradingScaleDto;

  @ApiProperty({
    type: [ScoreStudentDto],
    description:
      'Estudiantes matriculados en el curso (cualquier estado) y quienes ya tienen nota',
  })
  students: ScoreStudentDto[];
}
