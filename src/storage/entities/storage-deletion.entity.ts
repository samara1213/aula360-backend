import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Archivo de Storage pendiente de borrar (tarea 2.11.5). Se anota en la misma
 * transacción que deja de usar la ruta; StorageDeletionsService lo borra
 * enseguida y, si Supabase falla, lo reintenta con espera creciente.
 */
@Entity('storage_deletions')
@Unique('storage_deletions_bucket_path_key', ['bucket', 'path'])
@Check(
  'chk_storage_deletions_bucket',
  `bucket IN ('avatars', 'logos', 'report-cards', 'report-templates')`,
)
@Check('chk_storage_deletions_attempts', 'attempts >= 0')
@Index('idx_storage_deletions_next_attempt', ['nextAttemptAt'])
export class StorageDeletionEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'storage_deletions_pkey',
  })
  id: string;

  @Column({ type: 'varchar', length: 50 })
  bucket: string;

  @Column({ type: 'varchar', length: 500 })
  path: string;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({
    name: 'next_attempt_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  nextAttemptAt: Date;

  /** Solo el código o el estado del error, nunca el mensaje. */
  @Column({ name: 'last_error', type: 'varchar', length: 100, nullable: true })
  lastError: string | null;

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
