import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { TeacherSubjectCourseEntity } from '../entities/teacher-subject-course.entity';
import { CourseResponseDto } from './course.dto';

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateTeacherAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  courseId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectId: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Id del perfil de docente (con el rol TEACHER en la sede del curso o en toda la institución)',
  })
  @IsUUID()
  teacherId: string;
}

export class ReplaceTeacherDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Id del perfil del docente nuevo',
  })
  @IsUUID()
  teacherId: string;
}

export class TeacherAssignmentQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiPropertyOptional({
    description: 'Solo activas (true) o solo historial (false)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}

export class AssignmentSubjectDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

/** Docente de la carga: solo nombres (nunca documento ni contacto). */
export class AssignmentTeacherDto {
  @ApiProperty({ format: 'uuid', description: 'Id del perfil de docente' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
}

export class TeacherAssignmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description:
      'false cuando el docente fue reemplazado o la asignación terminó',
  })
  isActive: boolean;

  @ApiProperty({ type: CourseResponseDto })
  course: CourseResponseDto;

  @ApiProperty({ type: AssignmentSubjectDto })
  subject: AssignmentSubjectDto;

  @ApiProperty({ type: AssignmentTeacherDto })
  teacher: AssignmentTeacherDto;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  deactivatedAt: Date | null;

  /** Requiere course (con grade, campus y academicYear), subject y teacher.user. */
  static from(row: TeacherSubjectCourseEntity): TeacherAssignmentResponseDto {
    return {
      id: row.id,
      isActive: row.isActive,
      course: CourseResponseDto.from(row.course),
      subject: { id: row.subject.id, name: row.subject.name },
      teacher: {
        id: row.teacher.id,
        userId: row.teacher.userId,
        firstName: row.teacher.user.firstName,
        lastName: row.teacher.user.lastName,
      },
      createdAt: row.createdAt,
      deactivatedAt: row.deactivatedAt,
    };
  }
}

export class TeacherAssignmentPageDto {
  @ApiProperty({ type: [TeacherAssignmentResponseDto] })
  data: TeacherAssignmentResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
