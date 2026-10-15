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
import { decimalTransformer } from '../../../database/transformers/decimal.transformer';

/** pdf_path es la ruta en Supabase Storage; se accede con URL firmada. */
@Entity('report_cards')
@Unique('report_cards_student_id_period_id_key', ['studentId', 'periodId'])
@Index('idx_report_cards_period_course', ['periodId', 'courseId'])
@Index('idx_report_cards_course', ['courseId'])
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
