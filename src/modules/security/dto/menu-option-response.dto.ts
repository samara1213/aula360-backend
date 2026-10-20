import { ApiProperty } from '@nestjs/swagger';
import { MenuOptionEntity } from '../entities/menu-option.entity';

export class MenuOptionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'UUID de la opción padre; null en la raíz',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  parentId: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description: 'Identificador estable de la opción (no cambia)',
  })
  slug: string;

  @ApiProperty({
    description: 'Nombre del ícono, o null',
    type: String,
    nullable: true,
  })
  icon: string | null;

  @ApiProperty({ description: 'Orden entre hermanos (ascendente)' })
  displayOrder: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  static from(entity: MenuOptionEntity): MenuOptionResponseDto {
    return {
      id: entity.id,
      parentId: entity.parentId,
      name: entity.name,
      slug: entity.slug,
      icon: entity.icon,
      displayOrder: entity.displayOrder,
      isActive: entity.isActive,
      createdAt: entity.createdAt,
    };
  }
}

/** Nodo del árbol completo de menús (incluye las opciones inactivas). */
export class MenuOptionTreeNodeDto extends MenuOptionResponseDto {
  @ApiProperty({ type: () => [MenuOptionTreeNodeDto] })
  children: MenuOptionTreeNodeDto[];
}

export class MenuNodePermissionsDto {
  @ApiProperty({
    description: 'false = solo agrupa opciones permitidas (padre o abuelo)',
  })
  view: boolean;

  @ApiProperty({ description: 'Puede crear en esta opción' })
  create: boolean;

  @ApiProperty({ description: 'Puede editar en esta opción' })
  update: boolean;

  @ApiProperty({ description: 'Puede borrar o desactivar en esta opción' })
  delete: boolean;
}

/** Nodo del menú del usuario: solo lo que puede ver y sus ancestros. */
export class MyMenuNodeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    description:
      'Identificador estable de la opción (lo usa el frontend para la ruta)',
  })
  slug: string;

  @ApiProperty({
    description: 'Nombre del ícono, o null',
    type: String,
    nullable: true,
  })
  icon: string | null;

  @ApiProperty({ description: 'Orden entre hermanos (ascendente)' })
  displayOrder: number;

  @ApiProperty({ type: MenuNodePermissionsDto })
  permissions: MenuNodePermissionsDto;

  @ApiProperty({ type: () => [MyMenuNodeDto] })
  children: MyMenuNodeDto[];
}
