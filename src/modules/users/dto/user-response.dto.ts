import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import {
  AssignmentCampusDto,
  AssignmentRoleDto,
} from '../../security/dto/role-assignment-response.dto';
import { UserInstitutionRoleEntity } from '../../security/entities/user-institution-role.entity';
import type { UserType } from '../entities/user.entity';
import { UserEntity } from '../entities/user.entity';

export class UserAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: AssignmentRoleDto })
  role: AssignmentRoleDto;

  @ApiProperty({
    type: AssignmentCampusDto,
    nullable: true,
    description: 'null = toda la institución',
  })
  campus: AssignmentCampusDto | null;
}

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  userType: UserType;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null si está oculto (SUPER_ADMIN visto por otro usuario)',
  })
  documentType: string | null;

  @ApiProperty({ type: String, nullable: true })
  documentNumber: string | null;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({
    description: 'El email está verificado (si no, no recibe recuperación)',
  })
  emailVerified: boolean;

  @ApiProperty({
    description: 'Hay un email nuevo pendiente de que su dueño lo confirme',
  })
  hasPendingEmail: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'El email pendiente; solo lo ve un SUPER_ADMIN (null para los demás)',
  })
  pendingEmail: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone: string | null;

  @ApiProperty({
    description: 'Tiene avatar (se pide con GET /users/:id/avatar)',
  })
  hasAvatar: boolean;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ description: 'Debe cambiar la contraseña temporal' })
  mustChangePassword: boolean;

  @ApiProperty({ type: Date, nullable: true })
  lastLoginAt: Date | null;

  @ApiProperty({
    type: [UserAssignmentDto],
    description:
      'Sus asignaciones en esta institución (las que usted puede ver)',
  })
  assignments: UserAssignmentDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  /**
   * Nunca incluye passwordHash. Los datos de identificación y contacto de un
   * SUPER_ADMIN solo los ve otro SUPER_ADMIN. Requiere role y campus cargados
   * en las asignaciones.
   */
  static from(
    user: UserEntity,
    assignments: UserInstitutionRoleEntity[],
    viewerIsSuperAdmin: boolean,
    pendingEmail: string | null = null,
  ): UserResponseDto {
    const hidden = user.userType === 'SUPER_ADMIN' && !viewerIsSuperAdmin;
    return {
      id: user.id,
      userType: user.userType,
      documentType: hidden ? null : user.documentType,
      documentNumber: hidden ? null : user.documentNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      email: hidden ? null : user.email,
      emailVerified: hidden ? false : user.emailVerifiedAt !== null,
      hasPendingEmail: !hidden && pendingEmail !== null,
      pendingEmail: viewerIsSuperAdmin ? pendingEmail : null,
      phone: hidden ? null : user.phone,
      hasAvatar: user.avatarPath !== null,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      assignments: assignments.map((a) => ({
        id: a.id,
        role: {
          id: a.role.id,
          name: a.role.name,
          isGlobal: a.role.institutionId === null,
        },
        campus: a.campus
          ? {
              id: a.campus.id,
              name: a.campus.name,
              isActive: a.campus.isActive,
            }
          : null,
      })),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}

export class CreatedUserResponseDto extends UserResponseDto {
  @ApiProperty({
    description:
      'Contraseña temporal. Se muestra UNA sola vez; el usuario debe cambiarla al entrar.',
  })
  temporaryPassword: string;
}

export class TemporaryPasswordResponseDto {
  @ApiProperty({
    description:
      'Contraseña temporal nueva. Se muestra UNA sola vez; sus sesiones se cerraron.',
  })
  temporaryPassword: string;
}

export class UserPageDto {
  @ApiProperty({ type: [UserResponseDto] })
  data: UserResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
