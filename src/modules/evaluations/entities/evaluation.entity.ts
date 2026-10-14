import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PeriodEntity } from '../../academic/entities/period.entity';
import { TeacherSubjectCourseEntity } from '../../academic/entities/teacher-subject-course.entity';
import { decimalTransformer } from '../../../database/transformers/decimal.transformer';

/** La suma de porcentajes por materia, curso y periodo (<= 100) se valida en el service. */
@Entity('evaluations')
@Index('idx_evaluations_tsc', ['teacherSubjectCourseId'])
@Index('idx_evaluations_period', ['periodId'])
@Check('chk_evaluations_percentage', 'percentage > 0 AND percentage <= 100')
export class EvaluationEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'evaluations_pkey',
  })
  id: string;

  @Column({ name: 'teacher_subject_course_id', type: 'uuid' })
  teacherSubjectCourseId: string;

  @ManyToOne(() => TeacherSubjectCourseEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'teacher_subject_course_id',
    foreignKeyConstraintName: 'evaluations_teacher_subject_course_id_fkey',
  })
  teacherSubjectCourse: TeacherSubjectCourseEntity;

  @Column({ name: 'period_id', type: 'uuid' })
  periodId: string;

  @ManyToOne(() => PeriodEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'period_id',
    foreignKeyConstraintName: 'evaluations_period_id_fkey',
  })
  period: PeriodEntity;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  /** Ej: 20.00 representa el 20%. */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: decimalTransformer,
  })
  percentage: number;

  @Column({ name: 'evaluation_date', type: 'date' })
  evaluationDate: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
