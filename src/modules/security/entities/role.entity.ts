import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { InstitutionEntity } from '../../institutions/entities/institution.entity';

/** institution_id NULL = rol global del sistema. */
@Entity('roles')
@Index('uq_roles_institution_name', ['institutionId', 'name'], {
  unique: true,
  where: 'institution_id IS NOT NULL',
})
@Index('uq_roles_global_name', ['name'], {
  unique: true,
  where: 'institution_id IS NULL',
})
@Index('idx_roles_institution', ['institutionId'])
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'roles_pkey' })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid', nullable: true })
  institutionId: string | null;

  @ManyToOne(() => InstitutionEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'roles_institution_id_fkey',
  })
  institution: InstitutionEntity | null;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
