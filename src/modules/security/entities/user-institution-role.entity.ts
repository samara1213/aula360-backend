import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CampusEntity } from '../../institutions/entities/campus.entity';
import { InstitutionEntity } from '../../institutions/entities/institution.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { RoleEntity } from './role.entity';

/** Si campus_id tiene valor, el alcance del usuario se limita a esa sede. */
@Entity('user_institution_roles')
@Index(
  'uq_uir_with_campus',
  ['userId', 'institutionId', 'roleId', 'campusId'],
  {
    unique: true,
    where: 'campus_id IS NOT NULL',
  },
)
@Index('uq_uir_without_campus', ['userId', 'institutionId', 'roleId'], {
  unique: true,
  where: 'campus_id IS NULL',
})
@Index('idx_uir_user', ['userId'])
@Index('idx_uir_institution', ['institutionId'])
@Index('idx_uir_role', ['roleId'])
@Index('idx_uir_campus', ['campusId'])
export class UserInstitutionRoleEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'user_institution_roles_pkey',
  })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'user_institution_roles_user_id_fkey',
  })
  user: UserEntity;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'user_institution_roles_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ name: 'campus_id', type: 'uuid', nullable: true })
  campusId: string | null;

  @ManyToOne(() => CampusEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'campus_id',
    foreignKeyConstraintName: 'user_institution_roles_campus_id_fkey',
  })
  campus: CampusEntity | null;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId: string;

  @ManyToOne(() => RoleEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'role_id',
    foreignKeyConstraintName: 'user_institution_roles_role_id_fkey',
  })
  role: RoleEntity;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
