import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SwitchInstitutionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  institutionId: string;
}
