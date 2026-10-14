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
import { InstitutionEntity } from '../../institutions/entities/institution.entity';
import { UserEntity } from './user.entity';

@Entity('students')
@Unique('students_user_id_institution_id_key', ['userId', 'institutionId'])
@Unique('students_institution_id_student_code_key', [
  'institutionId',
  'studentCode',
])
@Index('idx_students_institution', ['institutionId'])
@Index('idx_students_campus', ['campusId'])
export class StudentEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'students_pkey' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'students_user_id_fkey',
  })
  user: UserEntity;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'students_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ name: 'campus_id', type: 'uuid', nullable: true })
  campusId: string | null;

  @ManyToOne(() => CampusEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'campus_id',
    foreignKeyConstraintName: 'students_campus_id_fkey',
  })
  campus: CampusEntity | null;

  @Column({ name: 'student_code', type: 'varchar', length: 50, nullable: true })
  studentCode: string | null;

  @Column({
    name: 'guardian_name',
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  guardianName: string | null;

  @Column({
    name: 'guardian_phone',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  guardianPhone: string | null;

  @Column({
    name: 'guardian_email',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  guardianEmail: string | null;

  /** Dato sensible de menores (Ley 1581 de 2012): no se selecciona por defecto. */
  @Column({
    name: 'blood_type',
    type: 'varchar',
    length: 10,
    nullable: true,
    select: false,
  })
  bloodType: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
