import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { AssignmentCampusDto } from '../../security/dto/role-assignment-response.dto';
import { StudentEntity } from '../entities/student.entity';
import { TeacherEntity } from '../entities/teacher.entity';
import { UserEntity } from '../entities/user.entity';

const CONTACT_NOTE = 'Solo aparece si usted puede editar a este estudiante';

/** Datos del usuario dentro de un perfil (nunca passwordHash). */
export class ProfileUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  documentType: string;

  @ApiProperty()
  documentNumber: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ description: 'El email está verificado' })
  emailVerified: boolean;

  @ApiProperty({ type: String, nullable: true })
  phone: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ description: 'Debe cambiar la contraseña temporal' })
  mustChangePassword: boolean;

  @ApiProperty({ description: 'Tiene avatar (GET /users/:id/avatar)' })
  hasAvatar: boolean;

  static from(user: UserEntity): ProfileUserDto {
    return {
      id: user.id,
      documentType: user.documentType,
      documentNumber: user.documentNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      phone: user.phone,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      hasAvatar: user.avatarPath !== null,
    };
  }
}

export class TeacherResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Id del perfil de docente' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  institutionId: string;

  @ApiProperty({ type: String, nullable: true })
  academicDegree: string | null;

  @ApiProperty({ type: String, nullable: true })
  specialty: string | null;

  @ApiProperty({ type: ProfileUserDto })
  user: ProfileUserDto;

  @ApiProperty()
  createdAt: Date;

  /** Requiere user cargado. */
  static from(teacher: TeacherEntity): TeacherResponseDto {
    return {
      id: teacher.id,
      institutionId: teacher.institutionId,
      academicDegree: teacher.academicDegree,
      specialty: teacher.specialty,
      user: ProfileUserDto.from(teacher.user),
      createdAt: teacher.createdAt,
    };
  }
}

export class CreatedTeacherResponseDto extends TeacherResponseDto {
  @ApiProperty({
    description:
      'Contraseña temporal. Se muestra UNA sola vez; debe cambiarla al entrar.',
  })
  temporaryPassword: string;
}

export class TeacherPageDto {
  @ApiProperty({ type: [TeacherResponseDto] })
  data: TeacherResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}

/**
 * Datos mínimos del usuario de un estudiante, para quien solo puede verlo
 * (p. ej. un docente): sin documento ni datos de contacto (Ley 1581, dato
 * mínimo necesario de menores).
 */
export class StudentUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ description: 'Tiene avatar (GET /users/:id/avatar)' })
  hasAvatar: boolean;

  @ApiPropertyOptional({ description: CONTACT_NOTE })
  documentType?: string;

  @ApiPropertyOptional({ description: CONTACT_NOTE })
  documentNumber?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: CONTACT_NOTE,
  })
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: CONTACT_NOTE,
  })
  phone?: string | null;

  @ApiPropertyOptional({ description: CONTACT_NOTE })
  mustChangePassword?: boolean;

  /** full: quien puede editar a este estudiante ve también documento y contacto. */
  static from(user: UserEntity, full: boolean): StudentUserDto {
    if (full) return ProfileUserDto.from(user);
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
      hasAvatar: user.avatarPath !== null,
    };
  }
}

/** Estudiante en listados: sin datos del acudiente ni datos sensibles. */
export class StudentSummaryDto {
  @ApiProperty({ format: 'uuid', description: 'Id del perfil de estudiante' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  institutionId: string;

  @ApiProperty({ type: String, nullable: true })
  studentCode: string | null;

  @ApiProperty({ type: AssignmentCampusDto, nullable: true })
  campus: AssignmentCampusDto | null;

  @ApiProperty({ type: StudentUserDto })
  user: StudentUserDto;

  @ApiProperty()
  createdAt: Date;

  /** Requiere user y campus cargados. full: puede editar a este estudiante. */
  static from(student: StudentEntity, full: boolean): StudentSummaryDto {
    return {
      id: student.id,
      institutionId: student.institutionId,
      studentCode: student.studentCode,
      campus: student.campus
        ? {
            id: student.campus.id,
            name: student.campus.name,
            isActive: student.campus.isActive,
          }
        : null,
      user: StudentUserDto.from(student.user, full),
      createdAt: student.createdAt,
    };
  }
}

export class StudentResponseDto extends StudentSummaryDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: CONTACT_NOTE,
  })
  guardianName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: CONTACT_NOTE,
  })
  guardianPhone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: CONTACT_NOTE,
  })
  guardianEmail?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Dato sensible (Ley 1581): solo aparece si usted puede editar a este estudiante',
  })
  bloodType?: string | null;

  /**
   * sensitive: undefined = quien solo puede ver (sin documento, contacto,
   * acudiente ni tipo de sangre); si no, el tipo de sangre ya leído.
   */
  static fromDetail(
    student: StudentEntity,
    sensitive: { bloodType: string | null } | undefined,
  ): StudentResponseDto {
    const summary = StudentSummaryDto.from(student, sensitive !== undefined);
    if (!sensitive) return summary;
    return {
      ...summary,
      guardianName: student.guardianName,
      guardianPhone: student.guardianPhone,
      guardianEmail: student.guardianEmail,
      bloodType: sensitive.bloodType,
    };
  }
}

export class CreatedStudentResponseDto extends StudentResponseDto {
  @ApiProperty({
    description:
      'Contraseña temporal. Se muestra UNA sola vez; debe cambiarla al entrar.',
  })
  temporaryPassword: string;
}

export class StudentPageDto {
  @ApiProperty({ type: [StudentSummaryDto] })
  data: StudentSummaryDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
