import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class RoleAssignmentQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Solo las asignaciones de este usuario',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Solo las asignaciones de este rol',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({
    description: 'Solo las asignaciones de esta sede',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  campusId?: string;
}
