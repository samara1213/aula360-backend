import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { InstitutionEntity } from './institution.entity';

@Entity('campuses')
@Unique('campuses_institution_id_name_key', ['institutionId', 'name'])
export class CampusEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'campuses_pkey' })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'campuses_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;
}
