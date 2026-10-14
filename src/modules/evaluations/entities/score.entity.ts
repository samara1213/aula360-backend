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
import { StudentEntity } from '../../users/entities/student.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { decimalTransformer } from '../../../database/transformers/decimal.transformer';
import { EvaluationEntity } from './evaluation.entity';

/** El rango de la nota se valida en el service con la escala de la institución. */
@Entity('scores')
@Unique('scores_evaluation_id_student_id_key', ['evaluationId', 'studentId'])
@Index('idx_scores_student', ['studentId'])
@Check('chk_scores_non_negative', 'score >= 0')
export class ScoreEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'scores_pkey' })
  id: string;

  @Column({ name: 'evaluation_id', type: 'uuid' })
  evaluationId: string;

  @ManyToOne(() => EvaluationEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'evaluation_id',
    foreignKeyConstraintName: 'scores_evaluation_id_fkey',
  })
  evaluation: EvaluationEntity;

  @Column({ name: 'student_id', type: 'uuid' })
  studentId: string;

  @ManyToOne(() => StudentEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'student_id',
    foreignKeyConstraintName: 'scores_student_id_fkey',
  })
  student: StudentEntity;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: decimalTransformer,
  })
  score: number;

  /** Usuario que registró o cambió la nota. */
  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'updated_by',
    foreignKeyConstraintName: 'scores_updated_by_fkey',
  })
  updatedByUser: UserEntity | null;

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
