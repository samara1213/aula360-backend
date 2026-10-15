import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';
import { InstitutionEntity } from '../entities/institution.entity';

export class InstitutionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nit: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Ruta del logo en Storage (se gestiona en la fase de archivos)',
  })
  logoPath: string | null;

  @ApiProperty({ example: 1 })
  gradingScaleMin: number;

  @ApiProperty({ example: 5 })
  gradingScaleMax: number;

  @ApiProperty({ example: 3 })
  passingScore: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  static from(entity: InstitutionEntity): InstitutionResponseDto {
    return {
      id: entity.id,
      nit: entity.nit,
      name: entity.name,
      logoPath: entity.logoPath,
      gradingScaleMin: entity.gradingScaleMin,
      gradingScaleMax: entity.gradingScaleMax,
      passingScore: entity.passingScore,
      isActive: entity.isActive,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export class InstitutionPageDto {
  @ApiProperty({ type: [InstitutionResponseDto] })
  data: InstitutionResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
