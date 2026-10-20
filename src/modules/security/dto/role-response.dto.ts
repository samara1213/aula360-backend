import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { RoleEntity } from '../entities/role.entity';

export class RoleResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = rol global del sistema',
  })
  institutionId: string | null;

  @ApiProperty({
    description:
      'true si es un rol global del sistema (solo lo modifica el SUPER_ADMIN)',
  })
  isGlobal: boolean;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description: 'Descripción del rol',
    type: String,
    nullable: true,
  })
  description: string | null;

  @ApiProperty()
  createdAt: Date;

  static from(entity: RoleEntity): RoleResponseDto {
    return {
      id: entity.id,
      institutionId: entity.institutionId,
      isGlobal: entity.institutionId === null,
      name: entity.name,
      description: entity.description,
      createdAt: entity.createdAt,
    };
  }
}

export class RolePermissionDto {
  @ApiProperty({ description: 'UUID de la opción de menú', format: 'uuid' })
  menuOptionId: string;

  @ApiProperty({ description: 'Slug de la opción de menú' })
  slug: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'Puede crear' })
  canCreate: boolean;

  @ApiProperty({ description: 'Puede editar' })
  canUpdate: boolean;

  @ApiProperty({ description: 'Puede borrar o desactivar' })
  canDelete: boolean;
}

export class RoleDetailDto extends RoleResponseDto {
  @ApiProperty({ type: [RolePermissionDto] })
  permissions: RolePermissionDto[];
}

export class RolePageDto {
  @ApiProperty({ type: [RoleResponseDto] })
  data: RoleResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
