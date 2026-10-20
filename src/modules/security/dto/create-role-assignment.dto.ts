import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class CreateRoleAssignmentDto {
  @ApiProperty({ description: 'UUID del usuario', format: 'uuid' })
  @IsUUID()
  userId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Rol global o de la institución',
  })
  @IsUUID()
  roleId: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede activa de la institución (null = toda la institución)',
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  campusId?: string | null;
}
