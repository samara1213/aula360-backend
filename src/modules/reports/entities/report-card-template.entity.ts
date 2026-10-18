import {
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
import { InstitutionEntity } from '../../institutions/entities/institution.entity';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * Plantilla HTML (Handlebars) del boletín de una institución. El archivo está
 * en el bucket privado report-templates; aquí solo su ruta. No se modifica:
 * para cambiar el diseño se sube otra. Como máximo una activa por
 * institución (índice único parcial).
 */
@Entity('report_card_templates')
@Unique('report_card_templates_institution_id_content_sha256_key', [
  'institutionId',
  'contentSha256',
])
@Index('idx_report_card_templates_institution', ['institutionId'])
@Index('uq_report_card_templates_active', ['institutionId'], {
  unique: true,
  where: 'is_active',
})
@Index('idx_report_card_templates_created_by', ['createdBy'])
export class ReportCardTemplateEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'report_card_templates_pkey',
  })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'report_card_templates_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'storage_path', type: 'varchar', length: 500 })
  storagePath: string;

  @Column({ name: 'content_sha256', type: 'char', length: 64 })
  contentSha256: string;

  @Column({ name: 'is_active', type: 'boolean', default: false })
  isActive: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'created_by',
    foreignKeyConstraintName: 'report_card_templates_created_by_fkey',
  })
  createdByUser: UserEntity | null;

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
