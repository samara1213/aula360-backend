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
import { CourseEntity } from '../../academic/entities/course.entity';
import { PeriodEntity } from '../../academic/entities/period.entity';
import { StudentEntity } from '../../users/entities/student.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { ReportCardTemplateEntity } from './report-card-template.entity';
import { decimalTransformer } from '../../../database/transformers/decimal.transformer';

/** pdf_path es la ruta en Supabase Storage; se accede con URL firmada. */
@Entity('report_cards')
@Unique('report_cards_student_id_period_id_key', ['studentId', 'periodId'])
@Index('idx_report_cards_period_course', ['periodId', 'courseId'])
@Index('idx_report_cards_course', ['courseId'])
@Index('idx_report_cards_template', ['templateId'])
@Index('idx_report_cards_generated_by', ['generatedBy'])
@Check('chk_report_cards_average', 'final_average >= 0')
export class ReportCardEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'report_cards_pkey',
  })
  id: string;

  @Column({ name: 'student_id', type: 'uuid' })
  studentId: string;

  @ManyToOne(() => StudentEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'student_id',
    foreignKeyConstraintName: 'report_cards_student_id_fkey',
  })
  student: StudentEntity;

  @Column({ name: 'period_id', type: 'uuid' })
  periodId: string;

  @ManyToOne(() => PeriodEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'period_id',
    foreignKeyConstraintName: 'report_cards_period_id_fkey',
  })
  period: PeriodEntity;

  @Column({ name: 'course_id', type: 'uuid' })
  courseId: string;

  @ManyToOne(() => CourseEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'course_id',
    foreignKeyConstraintName: 'report_cards_course_id_fkey',
  })
  course: CourseEntity;

  @Column({
    name: 'final_average',
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: decimalTransformer,
  })
  finalAverage: number;

  @Column({ name: 'pdf_path', type: 'varchar', length: 500, nullable: true })
  pdfPath: string | null;

  /** Plantilla con la que se generó; null = la plantilla del sistema. */
  @Column({ name: 'template_id', type: 'uuid', nullable: true })
  templateId: string | null;

  @ManyToOne(() => ReportCardTemplateEntity, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'template_id',
    foreignKeyConstraintName: 'report_cards_template_id_fkey',
  })
  template: ReportCardTemplateEntity | null;

  /** Desde cuándo sus notas cambiaron; null = vigente (hay que regenerarlo). */
  @Column({ name: 'outdated_at', type: 'timestamptz', nullable: true })
  outdatedAt: Date | null;

  @Column({ name: 'generated_by', type: 'uuid', nullable: true })
  generatedBy: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'generated_by',
    foreignKeyConstraintName: 'report_cards_generated_by_fkey',
  })
  generatedByUser: UserEntity | null;

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
