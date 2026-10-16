import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/** search: nombres, documento o email. */
export class UserQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Con este rol' })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Asignados a esta sede' })
  @IsOptional()
  @IsUUID()
  campusId?: string;
}
