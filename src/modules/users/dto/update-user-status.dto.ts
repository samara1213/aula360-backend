import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateUserStatusDto {
  @ApiProperty({
    description: 'false = desactivar (cierra todas sus sesiones)',
  })
  @IsBoolean()
  isActive: boolean;
}
