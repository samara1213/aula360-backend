import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TeacherEntity } from '../../users/entities/teacher.entity';
import { CourseEntity } from './course.entity';
import { SubjectEntity } from './subject.entity';

/**
 * Carga académica. Un solo docente activo por materia y curso; al reemplazarlo,
 * la asignación anterior queda con is_active = false (historial).
 */
@Entity('teacher_subject_courses')
@Index('uq_tsc_active_course_subject', ['courseId', 'subjectId'], {
  unique: true,
  where: 'is_active',
})
@Index('idx_tsc_course', ['courseId'])
@Index('idx_tsc_subject', ['subjectId'])
@Index('idx_tsc_teacher', ['teacherId'])
export class TeacherSubjectCourseEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'teacher_subject_courses_pkey',
  })
  id: string;

  @Column({ name: 'course_id', type: 'uuid' })
  courseId: string;

  @ManyToOne(() => CourseEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'course_id',
    foreignKeyConstraintName: 'teacher_subject_courses_course_id_fkey',
  })
  course: CourseEntity;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @ManyToOne(() => SubjectEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'subject_id',
    foreignKeyConstraintName: 'teacher_subject_courses_subject_id_fkey',
  })
  subject: SubjectEntity;

  @Column({ name: 'teacher_id', type: 'uuid' })
  teacherId: string;

  @ManyToOne(() => TeacherEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'teacher_id',
    foreignKeyConstraintName: 'teacher_subject_courses_teacher_id_fkey',
  })
  teacher: TeacherEntity;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @Column({ name: 'deactivated_at', type: 'timestamptz', nullable: true })
  deactivatedAt: Date | null;
}
