import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { CampusEntity } from '../entities/campus.entity';

export class CampusResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  institutionId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'Dirección', type: String, nullable: true })
  address: string | null;

  @ApiProperty({ description: 'Ciudad', type: String, nullable: true })
  city: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static from(entity: CampusEntity): CampusResponseDto {
    return {
      id: entity.id,
      institutionId: entity.institutionId,
      name: entity.name,
      address: entity.address,
      city: entity.city,
      isActive: entity.isActive,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export class CampusPageDto {
  @ApiProperty({ type: [CampusResponseDto] })
  data: CampusResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
