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

export const USER_TYPES = [
  'SUPER_ADMIN',
  'INSTITUTION_ADMIN',
  'TEACHER',
  'STUDENT',
] as const;
export type UserType = (typeof USER_TYPES)[number];

@Entity('users')
@Unique('users_email_key', ['email'])
@Unique('uq_users_document', ['documentType', 'documentNumber'])
@Index('idx_users_document_number', ['documentNumber'])
@Check(
  'users_user_type_check',
  `user_type IN ('SUPER_ADMIN', 'INSTITUTION_ADMIN', 'TEACHER', 'STUDENT')`,
)
export class UserEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'users_pkey' })
  id: string;

  @Column({ name: 'user_type', type: 'varchar', length: 50 })
  userType: UserType;

  @Column({ name: 'document_type', type: 'varchar', length: 20 })
  documentType: string;

  @Column({ name: 'document_number', type: 'varchar', length: 50 })
  documentNumber: string;

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName: string;

  @Column({ type: 'citext', nullable: true })
  email: string | null;

  /** Nunca se devuelve: se pide explícitamente con addSelect cuando hace falta. */
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    select: false,
  })
  passwordHash: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string | null;

  @Column({ name: 'avatar_path', type: 'varchar', length: 500, nullable: true })
  avatarPath: string | null;

  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword: boolean;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

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
