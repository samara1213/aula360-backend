import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  PaginationMetaDto,
  SearchQueryDto,
} from '../../../common/dto/list-query.dto';
import { AssignmentCampusDto } from '../../security/dto/role-assignment-response.dto';
import { CourseEntity } from '../entities/course.entity';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateCourseDto {
  @ApiProperty({ example: '601', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'UUID del grado', format: 'uuid' })
  @IsUUID()
  gradeId: string;

  @ApiProperty({ format: 'uuid', description: 'Sede activa de la institución' })
  @IsUUID()
  campusId: string;

  @ApiProperty({ format: 'uuid', description: 'Año lectivo activo' })
  @IsUUID()
  academicYearId: string;
}

/** Grado, sede y año solo cambian si el curso no tiene carga académica ni matrículas. */
export class UpdateCourseDto extends PartialType(CreateCourseDto) {}

export class CourseQueryDto extends SearchQueryDto {
  @ApiPropertyOptional({
    description: 'Solo los cursos de este año lectivo',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({
    description: 'Solo los cursos de este grado',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  gradeId?: string;

  @ApiPropertyOptional({
    description: 'Solo los cursos de esta sede',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  campusId?: string;
}

export class CourseGradeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

export class CourseYearDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 2026 })
  year: number;

  @ApiProperty()
  isActive: boolean;
}

export class CourseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: CourseGradeDto })
  grade: CourseGradeDto;

  @ApiProperty({ type: AssignmentCampusDto })
  campus: AssignmentCampusDto;

  @ApiProperty({ type: CourseYearDto })
  academicYear: CourseYearDto;

  @ApiProperty()
  createdAt: Date;

  /** Requiere grade, campus y academicYear cargados. */
  static from(course: CourseEntity): CourseResponseDto {
    return {
      id: course.id,
      name: course.name,
      grade: { id: course.grade.id, name: course.grade.name },
      campus: {
        id: course.campus.id,
        name: course.campus.name,
        isActive: course.campus.isActive,
      },
      academicYear: {
        id: course.academicYear.id,
        year: course.academicYear.year,
        isActive: course.academicYear.isActive,
      },
      createdAt: course.createdAt,
    };
  }
}

export class CoursePageDto {
  @ApiProperty({ type: [CourseResponseDto] })
  data: CourseResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
