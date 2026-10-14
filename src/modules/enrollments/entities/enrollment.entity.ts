import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { AcademicYearEntity } from '../../academic/entities/academic-year.entity';
import { CourseEntity } from '../../academic/entities/course.entity';
import { StudentEntity } from '../../users/entities/student.entity';

export const ENROLLMENT_STATUSES = [
  'ENROLLED',
  'DROPPED',
  'GRADUATED',
  'SUSPENDED',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** academic_year_id debe coincidir con courses.academic_year_id (se valida en el service). */
@Entity('enrollments')
@Unique('enrollments_student_id_academic_year_id_key', [
  'studentId',
  'academicYearId',
])
@Index('idx_enrollments_course', ['courseId'])
@Check(
  'enrollments_status_check',
  `status IN ('ENROLLED', 'DROPPED', 'GRADUATED', 'SUSPENDED')`,
)
export class EnrollmentEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'enrollments_pkey',
  })
  id: string;

  @Column({ name: 'student_id', type: 'uuid' })
  studentId: string;

  @ManyToOne(() => StudentEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'student_id',
    foreignKeyConstraintName: 'enrollments_student_id_fkey',
  })
  student: StudentEntity;

  @Column({ name: 'course_id', type: 'uuid' })
  courseId: string;

  @ManyToOne(() => CourseEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'course_id',
    foreignKeyConstraintName: 'enrollments_course_id_fkey',
  })
  course: CourseEntity;

  @Column({ name: 'academic_year_id', type: 'uuid' })
  academicYearId: string;

  @ManyToOne(() => AcademicYearEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'academic_year_id',
    foreignKeyConstraintName: 'enrollments_academic_year_id_fkey',
  })
  academicYear: AcademicYearEntity;

  @Column({
    name: 'enrollment_date',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  enrollmentDate: Date;

  @Column({ type: 'varchar', length: 50, default: 'ENROLLED' })
  status: EnrollmentStatus;

  @Column({ type: 'text', nullable: true })
  observations: string | null;
}
