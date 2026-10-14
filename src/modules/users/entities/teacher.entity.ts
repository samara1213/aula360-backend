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
import { InstitutionEntity } from '../../institutions/entities/institution.entity';
import { UserEntity } from './user.entity';

@Entity('teachers')
@Unique('teachers_user_id_institution_id_key', ['userId', 'institutionId'])
@Index('idx_teachers_institution', ['institutionId'])
export class TeacherEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'teachers_pkey' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'teachers_user_id_fkey',
  })
  user: UserEntity;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'teachers_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({
    name: 'academic_degree',
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  academicDegree: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  specialty: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
