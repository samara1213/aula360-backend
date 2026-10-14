import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { decimalTransformer } from '../../../database/transformers/decimal.transformer';

@Entity('institutions')
@Unique('institutions_nit_key', ['nit'])
@Check(
  'chk_institutions_scale',
  'grading_scale_min < grading_scale_max AND passing_score BETWEEN grading_scale_min AND grading_scale_max',
)
export class InstitutionEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'institutions_pkey',
  })
  id: string;

  @Column({ type: 'varchar', length: 50 })
  nit: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ name: 'logo_path', type: 'varchar', length: 500, nullable: true })
  logoPath: string | null;

  @Column({
    name: 'grading_scale_min',
    type: 'decimal',
    precision: 4,
    scale: 2,
    default: () => '1.00',
    transformer: decimalTransformer,
  })
  gradingScaleMin: number;

  @Column({
    name: 'grading_scale_max',
    type: 'decimal',
    precision: 4,
    scale: 2,
    default: () => '5.00',
    transformer: decimalTransformer,
  })
  gradingScaleMax: number;

  @Column({
    name: 'passing_score',
    type: 'decimal',
    precision: 4,
    scale: 2,
    default: () => '3.00',
    transformer: decimalTransformer,
  })
  passingScore: number;

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
