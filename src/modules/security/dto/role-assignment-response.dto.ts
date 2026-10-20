import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import type { UserType } from '../../users/entities/user.entity';
import { UserInstitutionRoleEntity } from '../entities/user-institution-role.entity';

export class AssignmentUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null si está oculto (SUPER_ADMIN visto por otro usuario)',
  })
  documentType: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null si está oculto (SUPER_ADMIN visto por otro usuario)',
  })
  documentNumber: string | null;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ description: 'Tipo de usuario' })
  userType: UserType;
}

export class AssignmentRoleDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'true si es un rol global del sistema' })
  isGlobal: boolean;
}

export class AssignmentCampusDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  isActive: boolean;
}

export class RoleAssignmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  institutionId: string;

  @ApiProperty({ type: AssignmentUserDto })
  user: AssignmentUserDto;

  @ApiProperty({ type: AssignmentRoleDto })
  role: AssignmentRoleDto;

  @ApiProperty({
    type: AssignmentCampusDto,
    nullable: true,
    description: 'null = toda la institución',
  })
  campus: AssignmentCampusDto | null;

  @ApiProperty()
  createdAt: Date;

  /**
   * Requiere user, role y campus cargados. Los datos de contacto de un
   * SUPER_ADMIN solo los ve otro SUPER_ADMIN.
   */
  static from(
    entity: UserInstitutionRoleEntity,
    viewerIsSuperAdmin: boolean,
  ): RoleAssignmentResponseDto {
    const { user, role, campus } = entity;
    const hidden = user.userType === 'SUPER_ADMIN' && !viewerIsSuperAdmin;
    return {
      id: entity.id,
      institutionId: entity.institutionId,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        documentType: hidden ? null : user.documentType,
        documentNumber: hidden ? null : user.documentNumber,
        email: hidden ? null : user.email,
        userType: user.userType,
      },
      role: {
        id: role.id,
        name: role.name,
        isGlobal: role.institutionId === null,
      },
      campus: campus
        ? { id: campus.id, name: campus.name, isActive: campus.isActive }
        : null,
      createdAt: entity.createdAt,
    };
  }
}

export class RoleAssignmentPageDto {
  @ApiProperty({ type: [RoleAssignmentResponseDto] })
  data: RoleAssignmentResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
