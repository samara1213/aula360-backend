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
import { UserEntity } from '../../users/entities/user.entity';

/**
 * Enlace para verificar un email (el actual o uno nuevo). Solo el hash del
 * token; un solo uso (used_at) y con expiración. Un token vigente cuyo email
 * difiere de users.email es un cambio pendiente.
 */
@Entity('email_verification_tokens')
@Unique('email_verification_tokens_token_hash_key', ['tokenHash'])
@Index('idx_email_verification_tokens_user', ['userId'])
@Index('idx_email_verification_tokens_requested_by', ['requestedBy'])
@Index('idx_email_verification_tokens_institution', ['institutionId'])
export class EmailVerificationTokenEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'email_verification_tokens_pkey',
  })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'email_verification_tokens_user_id_fkey',
  })
  user: UserEntity;

  @Column({ type: 'citext' })
  email: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 255, select: false })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  /** Quien pidió el cambio (el propio usuario o un administrador). */
  @Column({ name: 'requested_by', type: 'uuid', nullable: true })
  requestedBy: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'requested_by',
    foreignKeyConstraintName: 'email_verification_tokens_requested_by_fkey',
  })
  requestedByUser: UserEntity | null;

  /** Institución donde actuó quien lo pidió (null si lo pidió el usuario). */
  @Column({ name: 'institution_id', type: 'uuid', nullable: true })
  institutionId: string | null;

  @ManyToOne(() => InstitutionEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'email_verification_tokens_institution_id_fkey',
  })
  institution: InstitutionEntity | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
