import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { decimalTransformer } from '../../../database/transformers/decimal.transformer';
import { InstitutionEntity } from '../../institutions/entities/institution.entity';

/**
 * Niveles de desempeño de una institución (Decreto 1290: Superior, Alto,
 * Básico, Bajo). Que cubran toda la escala sin huecos ni cruces lo valida el
 * service.
 */
@Entity('performance_levels')
@Unique('performance_levels_institution_id_name_key', ['institutionId', 'name'])
@Index('idx_performance_levels_institution', ['institutionId'])
@Check('chk_performance_levels_range', 'min_score <= max_score')
export class PerformanceLevelEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'performance_levels_pkey',
  })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'performance_levels_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ type: 'varchar', length: 50 })
  name: string;

  @Column({
    name: 'min_score',
    type: 'decimal',
    precision: 4,
    scale: 2,
    transformer: decimalTransformer,
  })
  minScore: number;

  @Column({
    name: 'max_score',
    type: 'decimal',
    precision: 4,
    scale: 2,
    transformer: decimalTransformer,
  })
  maxScore: number;

  @Column({ name: 'display_order', type: 'int' })
  displayOrder: number;

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
