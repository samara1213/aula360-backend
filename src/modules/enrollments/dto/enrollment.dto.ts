import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  PaginationMetaDto,
  SearchQueryDto,
} from '../../../common/dto/list-query.dto';
import { CourseGradeDto, CourseYearDto } from '../../academic/dto/course.dto';
import { AssignmentCampusDto } from '../../security/dto/role-assignment-response.dto';
import {
  ENROLLMENT_STATUSES,
  EnrollmentEntity,
  EnrollmentStatus,
} from '../entities/enrollment.entity';

const OBSERVATIONS_NOTE =
  'Texto libre sobre un menor: no registrar datos de salud, disciplinarios ni otros datos sensibles.';

/** Texto opcional: '' o null dejan el campo en NULL. */
const trimOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateEnrollmentDto {
  @ApiProperty({ format: 'uuid', description: 'Id del perfil de estudiante' })
  @IsUUID()
  studentId: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Curso de la sede del estudiante; el año de la matrícula es el del curso',
  })
  @IsUUID()
  courseId: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 2000,
    description: OBSERVATIONS_NOTE,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  observations?: string | null;
}

export class UpdateEnrollmentDto {
  @ApiPropertyOptional({
    enum: ENROLLMENT_STATUSES,
    description:
      'ENROLLED ↔ SUSPENDED; ENROLLED o SUSPENDED → DROPPED; ENROLLED → GRADUATED; DROPPED → ENROLLED (reintegro). GRADUATED es definitivo.',
  })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES)
  status?: EnrollmentStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Cambio de curso: del mismo año lectivo y de la sede del estudiante (matrícula vigente o en el mismo PATCH del reintegro)',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 2000,
    description: OBSERVATIONS_NOTE,
  })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  observations?: string | null;
}

export class EnrollmentQueryDto extends SearchQueryDto {
  @ApiPropertyOptional({
    description: 'Solo las matrículas de este curso',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    description: 'Solo las matrículas de este año lectivo',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({
    description: 'Solo las matrículas de este estudiante',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({
    description: 'Solo las matrículas con este estado',
    enum: ENROLLMENT_STATUSES,
  })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES)
  status?: EnrollmentStatus;
}

/** Estudiante de la matrícula: solo nombres y código (dato mínimo). */
export class EnrollmentStudentDto {
  @ApiProperty({ format: 'uuid', description: 'Id del perfil de estudiante' })
  id: string;

  @ApiProperty({
    description: 'Código del estudiante en la institución',
    type: String,
    nullable: true,
  })
  studentCode: string | null;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
}

export class EnrollmentCourseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: CourseGradeDto })
  grade: CourseGradeDto;

  @ApiProperty({ type: AssignmentCampusDto })
  campus: AssignmentCampusDto;
}

export class EnrollmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Estado de la matrícula',
    enum: ENROLLMENT_STATUSES,
  })
  status: EnrollmentStatus;

  @ApiProperty({ description: 'Fecha de matrícula' })
  enrollmentDate: Date;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Solo en el detalle (no en listados). Texto libre sobre un menor: no registrar datos de salud, disciplinarios ni otros datos sensibles.',
  })
  observations?: string | null;

  @ApiProperty({ type: EnrollmentStudentDto })
  student: EnrollmentStudentDto;

  @ApiProperty({ type: EnrollmentCourseDto })
  course: EnrollmentCourseDto;

  @ApiProperty({ type: CourseYearDto })
  academicYear: CourseYearDto;

  /**
   * Requiere student.user, course (grade, campus) y academicYear cargados.
   * withObservations: false en listados.
   */
  static from(
    row: EnrollmentEntity,
    withObservations = true,
  ): EnrollmentResponseDto {
    return {
      id: row.id,
      status: row.status,
      enrollmentDate: row.enrollmentDate,
      ...(withObservations ? { observations: row.observations } : {}),
      student: {
        id: row.student.id,
        studentCode: row.student.studentCode,
        firstName: row.student.user.firstName,
        lastName: row.student.user.lastName,
      },
      course: {
        id: row.course.id,
        name: row.course.name,
        grade: { id: row.course.grade.id, name: row.course.grade.name },
        campus: {
          id: row.course.campus.id,
          name: row.course.campus.name,
          isActive: row.course.campus.isActive,
        },
      },
      academicYear: {
        id: row.academicYear.id,
        year: row.academicYear.year,
        isActive: row.academicYear.isActive,
      },
    };
  }
}

export class EnrollmentPageDto {
  @ApiProperty({ type: [EnrollmentResponseDto] })
  data: EnrollmentResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
