import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PaginationMetaDto } from '../../../common/dto/list-query.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateGradeDto {
  @ApiProperty({ example: 'Sexto', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

export class UpdateGradeDto extends PartialType(CreateGradeDto) {}

export class CreateSubjectDto {
  @ApiProperty({ example: 'Matemáticas', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;
}

export class UpdateSubjectDto extends PartialType(CreateSubjectDto) {}

/** Grado o materia: un nombre único por institución. */
export class CatalogItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  institutionId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  createdAt: Date;

  static from(entity: {
    id: string;
    institutionId: string;
    name: string;
    createdAt: Date;
  }): CatalogItemResponseDto {
    return {
      id: entity.id,
      institutionId: entity.institutionId,
      name: entity.name,
      createdAt: entity.createdAt,
    };
  }
}

export class CatalogPageDto {
  @ApiProperty({ type: [CatalogItemResponseDto] })
  data: CatalogItemResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
