import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { USER_TYPES, UserType } from '../../users/entities/user.entity';

export class SessionUserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: USER_TYPES })
  userType: UserType;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  email: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
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
  @ApiProperty()
  message: string;
}
