import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { CampusEntity } from '../../institutions/entities/campus.entity';
import { AcademicYearEntity } from './academic-year.entity';
import { GradeEntity } from './grade.entity';

/** La institución del curso se obtiene por grade.institution_id. */
@Entity('courses')
@Unique('courses_grade_id_campus_id_academic_year_id_name_key', [
  'gradeId',
  'campusId',
  'academicYearId',
  'name',
])
@Index('idx_courses_campus', ['campusId'])
@Index('idx_courses_year', ['academicYearId'])
export class CourseEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'courses_pkey' })
  id: string;

  @Column({ name: 'grade_id', type: 'uuid' })
  gradeId: string;

  @ManyToOne(() => GradeEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'grade_id',
    foreignKeyConstraintName: 'courses_grade_id_fkey',
  })
  grade: GradeEntity;

  @Column({ name: 'campus_id', type: 'uuid' })
  campusId: string;

  @ManyToOne(() => CampusEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'campus_id',
    foreignKeyConstraintName: 'courses_campus_id_fkey',
  })
  campus: CampusEntity;

  @Column({ name: 'academic_year_id', type: 'uuid' })
  academicYearId: string;

  @ManyToOne(() => AcademicYearEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'academic_year_id',
    foreignKeyConstraintName: 'courses_academic_year_id_fkey',
  })
  academicYear: AcademicYearEntity;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
