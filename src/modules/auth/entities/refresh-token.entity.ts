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

/** Solo se guarda el hash SHA-256 del token; permite rotación y revocación. */
@Entity('refresh_tokens')
@Unique('refresh_tokens_token_hash_key', ['tokenHash'])
@Index('idx_refresh_tokens_user', ['userId'])
export class RefreshTokenEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'refresh_tokens_pkey',
  })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'refresh_tokens_user_id_fkey',
  })
  user: UserEntity;

  @Column({ name: 'token_hash', type: 'varchar', length: 255, select: false })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;
}
