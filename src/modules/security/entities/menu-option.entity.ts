import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/** Jerarquía Padre -> Hijo -> Nieto (máximo 3 niveles, se valida en el service). */
@Entity('menu_options')
@Unique('menu_options_slug_key', ['slug'])
@Index('idx_menu_options_parent', ['parentId'])
@Check('chk_menu_not_self_parent', 'parent_id IS NULL OR parent_id <> id')
export class MenuOptionEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'menu_options_pkey',
  })
  id: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => MenuOptionEntity, (option) => option.children, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'parent_id',
    foreignKeyConstraintName: 'menu_options_parent_id_fkey',
  })
  parent: MenuOptionEntity | null;

  @OneToMany(() => MenuOptionEntity, (option) => option.parent)
  children: MenuOptionEntity[];

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Clave de permiso usada por @RequirePermission. */
  @Column({ type: 'varchar', length: 255 })
  slug: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  icon: string | null;

  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
