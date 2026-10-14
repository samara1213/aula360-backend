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

@Entity('academic_years')
@Unique('academic_years_institution_id_year_key', ['institutionId', 'year'])
export class AcademicYearEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'academic_years_pkey',
  })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'academic_years_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ type: 'int' })
  year: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
