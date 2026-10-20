import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class RolePermissionInputDto {
  @ApiProperty({
    description:
      'UUID de la opción de menú (activa). Tenerla en la lista da permiso de ver',
    format: 'uuid',
  })
  @IsUUID()
  menuOptionId: string;

  @ApiPropertyOptional({ description: 'Puede crear', default: false })
  @IsOptional()
  @IsBoolean()
  canCreate?: boolean;

  @ApiPropertyOptional({ description: 'Puede editar', default: false })
  @IsOptional()
  @IsBoolean()
  canUpdate?: boolean;

  @ApiPropertyOptional({
    description: 'Puede borrar o desactivar',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  canDelete?: boolean;
}

/** Reemplaza todos los permisos del rol (la lista vacía los quita todos). */
export class ReplaceRolePermissionsDto {
  @ApiProperty({
    type: [RolePermissionInputDto],
    description: 'Cada opción incluida se puede ver; can_* habilitan el resto',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RolePermissionInputDto)
  permissions: RolePermissionInputDto[];
}
