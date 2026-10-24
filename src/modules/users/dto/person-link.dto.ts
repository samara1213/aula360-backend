import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { AssignmentCampusDto } from '../../security/dto/role-assignment-response.dto';
import {
  INVITATION_PROFILES,
  type InvitationProfile,
} from '../entities/institution-invitation.entity';
import { UserPersonalDataDto } from './create-user.dto';

/**
 * Documento de una persona que ya tiene cuenta (en otra institución), para
 * invitarla a la institución activa. Coincidencia exacta de tipo y número.
 */
export class PersonDocumentDto extends PickType(UserPersonalDataDto, [
  'documentType',
  'documentNumber',
] as const) {}

/** Lo justo para confirmar que es la persona: nombre e inicial del apellido. */
export class LinkCandidateResponseDto {
  @ApiProperty({ example: 'Carlos P.' })
  displayName: string;
}

/**
 * Invitar como docente o estudiante a quien ya tiene cuenta. Solo la sede:
 * los datos de su ficha se completan después de que acepte.
 */
export class CreateInvitationDto extends PersonDocumentDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Sede propuesta (null = toda la institución para un docente, sin sede para un estudiante). Obligatoria si su acceso está limitado a sedes.',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  campusId?: string | null;
}

/** Invitación pendiente, vista desde la institución que invita. */
export class InvitationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'Carlos P.',
    description: 'Nombre e inicial del apellido: nada más hasta que acepte',
  })
  displayName: string;

  @ApiProperty({
    enum: INVITATION_PROFILES,
    description: 'Como qué entra a la institución: docente o estudiante',
  })
  profileType: InvitationProfile;

  @ApiProperty({ type: AssignmentCampusDto, nullable: true })
  campus: AssignmentCampusDto | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    description: 'Vence a los 14 días de enviada (ISO 8601)',
  })
  expiresAt: Date;
}

export class InvitationInstitutionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

/** Invitación pendiente, vista por la persona invitada. */
export class MyInvitationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: InvitationInstitutionDto })
  institution: InvitationInstitutionDto;

  @ApiProperty({
    enum: INVITATION_PROFILES,
    description: 'Como qué entra a la institución: docente o estudiante',
  })
  profileType: InvitationProfile;

  @ApiProperty({ type: AssignmentCampusDto, nullable: true })
  campus: AssignmentCampusDto | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    description: 'Vence a los 14 días de enviada (ISO 8601)',
  })
  expiresAt: Date;
}

/** Al aceptar: la institución a la que ya puede entrar. */
export class AcceptedInvitationDto {
  @ApiProperty({ format: 'uuid' })
  institutionId: string;
}
