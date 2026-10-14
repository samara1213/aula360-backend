import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { InstitutionEntity } from '../../institutions/entities/institution.entity';

@Entity('subjects')
@Unique('subjects_institution_id_name_key', ['institutionId', 'name'])
export class SubjectEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'subjects_pkey' })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'subjects_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
