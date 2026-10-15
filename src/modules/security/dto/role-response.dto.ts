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

  @ApiProperty()
  isGlobal: boolean;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
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
  @ApiProperty({ format: 'uuid' })
  menuOptionId: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  canCreate: boolean;

  @ApiProperty()
  canUpdate: boolean;

  @ApiProperty()
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
