import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { MenuOptionEntity } from './menu-option.entity';
import { RoleEntity } from './role.entity';

/** La fila existente permite "ver"; can_create / can_update / can_delete el resto. */
@Entity('role_menu_permissions')
@Unique('role_menu_permissions_role_id_menu_option_id_key', [
  'roleId',
  'menuOptionId',
])
@Index('idx_rmp_menu_option', ['menuOptionId'])
export class RoleMenuPermissionEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'role_menu_permissions_pkey',
  })
  id: string;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId: string;

  @ManyToOne(() => RoleEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'role_menu_permissions_role_id_fkey',
  })
  role: RoleEntity;

  @Column({ name: 'menu_option_id', type: 'uuid' })
  menuOptionId: string;

  @ManyToOne(() => MenuOptionEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'menu_option_id',
    foreignKeyConstraintName: 'role_menu_permissions_menu_option_id_fkey',
  })
  menuOption: MenuOptionEntity;

  @Column({ name: 'can_create', type: 'boolean', default: false })
  canCreate: boolean;

  @Column({ name: 'can_update', type: 'boolean', default: false })
  canUpdate: boolean;

  @Column({ name: 'can_delete', type: 'boolean', default: false })
  canDelete: boolean;
}
