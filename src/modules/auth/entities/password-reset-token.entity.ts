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
import { UserEntity } from '../../users/entities/user.entity';

/** Solo el hash del token; un solo uso (used_at) y con expiración. */
@Entity('password_reset_tokens')
@Unique('password_reset_tokens_token_hash_key', ['tokenHash'])
@Index('idx_password_reset_tokens_user', ['userId'])
export class PasswordResetTokenEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'password_reset_tokens_pkey',
  })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'password_reset_tokens_user_id_fkey',
  })
  user: UserEntity;

  @Column({ name: 'token_hash', type: 'varchar', length: 255, select: false })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
