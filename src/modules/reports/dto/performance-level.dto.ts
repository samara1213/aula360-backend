import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { GradingScaleDto } from '../../evaluations/dto/score.dto';
import { PerformanceLevelEntity } from '../entities/performance-level.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PerformanceLevelInputDto {
  @ApiProperty({ example: 'Superior', maxLength: 50 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @ApiProperty({ example: 4.6 })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99.99)
  minScore: number;

  @ApiProperty({ example: 5 })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99.99)
  maxScore: number;
}

export class ReplacePerformanceLevelsDto {
  @ApiProperty({
    type: [PerformanceLevelInputDto],
    description:
      'De 1 a 10 niveles que cubran toda la escala de la institución, sin huecos ni cruces (pasos de 0.01)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PerformanceLevelInputDto)
  levels: PerformanceLevelInputDto[];
}

export class PerformanceLevelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Superior' })
  name: string;

  @ApiProperty({ example: 4.6 })
  minScore: number;

  @ApiProperty({ example: 5 })
  maxScore: number;

  @ApiProperty({ example: 4 })
  displayOrder: number;

  static from(row: PerformanceLevelEntity): PerformanceLevelDto {
    return {
      id: row.id,
      name: row.name,
      minScore: row.minScore,
      maxScore: row.maxScore,
      displayOrder: row.displayOrder,
    };
  }
}

export class PerformanceLevelsResponseDto {
  @ApiProperty({ type: GradingScaleDto })
  scale: GradingScaleDto;

  @ApiProperty({
    type: [PerformanceLevelDto],
    description: 'Ordenados de menor a mayor; vacío si no se han configurado',
  })
  levels: PerformanceLevelDto[];
}
