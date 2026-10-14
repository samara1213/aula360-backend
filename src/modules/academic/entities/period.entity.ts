import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { AcademicYearEntity } from './academic-year.entity';

@Entity('periods')
@Unique('periods_academic_year_id_name_key', ['academicYearId', 'name'])
@Check('chk_periods_dates', 'end_date >= start_date')
export class PeriodEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'periods_pkey' })
  id: string;

  @Column({ name: 'academic_year_id', type: 'uuid' })
  academicYearId: string;

  @ManyToOne(() => AcademicYearEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'academic_year_id',
    foreignKeyConstraintName: 'periods_academic_year_id_fkey',
  })
  academicYear: AcademicYearEntity;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Formato 'YYYY-MM-DD' (DATE sin zona horaria). */
  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
