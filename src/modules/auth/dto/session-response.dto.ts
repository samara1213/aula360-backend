import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { USER_TYPES, UserType } from '../../users/entities/user.entity';

export class SessionUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description:
      'Tipo de usuario: SUPER_ADMIN, INSTITUTION_ADMIN, TEACHER o STUDENT',
    enum: USER_TYPES,
  })
  userType: UserType;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({
    description: 'El email está verificado (si no, no recibe recuperación)',
  })
  emailVerified: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Email nuevo pendiente de confirmar con el enlace',
  })
  pendingEmail: string | null;

  @ApiPropertyOptional({
    description:
      'null si no tiene avatar; la imagen se pide con GET /api/users/me/avatar',
    type: String,
    nullable: true,
  })
  avatarPath: string | null;

  @ApiProperty({ description: 'Debe cambiar la contraseña antes de continuar' })
  mustChangePassword: boolean;
}

export class InstitutionMembershipDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: [String], example: ['INSTITUTION_ADMIN'] })
  roles: string[];
}

export class SessionResponseDto {
  @ApiProperty({ type: SessionUserDto })
  user: SessionUserDto;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Institución activa. null si tiene varias y debe elegir con /auth/switch-institution',
  })
  activeInstitutionId: string | null;

  @ApiProperty({ type: [InstitutionMembershipDto] })
  institutions: InstitutionMembershipDto[];
}

export class MessageResponseDto {
  @ApiProperty({ description: 'Mensaje para el usuario' })
  message: string;
}
