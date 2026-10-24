import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CampusEntity } from '../../institutions/entities/campus.entity';
import { InstitutionEntity } from '../../institutions/entities/institution.entity';
import { UserEntity } from './user.entity';

export const INVITATION_PROFILES = ['TEACHER', 'STUDENT'] as const;
export type InvitationProfile = (typeof INVITATION_PROFILES)[number];

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * Invitación para sumar a la institución, como docente o estudiante, a quien
 * ya tiene cuenta en otra. La persona la acepta o la rechaza con su sesión;
 * al aceptarla se crean su rol y su perfil. Una pendiente por institución y
 * persona (índice único parcial uq_institution_invitations_pending).
 */
@Entity('institution_invitations')
@Index('idx_institution_invitations_institution', ['institutionId', 'status'])
@Index('idx_institution_invitations_user', ['userId', 'status'])
@Index('idx_institution_invitations_campus', ['campusId'])
@Index('idx_institution_invitations_invited_by', ['invitedBy'])
@Index('uq_institution_invitations_pending', ['institutionId', 'userId'], {
  unique: true,
  where: `"status" = 'PENDING'`,
})
export class InstitutionInvitationEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'institution_invitations_pkey',
  })
  id: string;

  @Column({ name: 'institution_id', type: 'uuid' })
  institutionId: string;

  @ManyToOne(() => InstitutionEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'institution_id',
    foreignKeyConstraintName: 'institution_invitations_institution_id_fkey',
  })
  institution: InstitutionEntity;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'institution_invitations_user_id_fkey',
  })
  user: UserEntity;

  @Column({ name: 'profile_type', type: 'varchar', length: 20 })
  profileType: InvitationProfile;

  /** Sede propuesta (null = toda la institución o sin sede). */
  @Column({ name: 'campus_id', type: 'uuid', nullable: true })
  campusId: string | null;

  // CASCADE: sin la sede, la invitación no se vuelve de toda la institución.
  @ManyToOne(() => CampusEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'campus_id',
    foreignKeyConstraintName: 'institution_invitations_campus_id_fkey',
  })
  campus: CampusEntity | null;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: InvitationStatus;

  @Column({ name: 'invited_by', type: 'uuid', nullable: true })
  invitedBy: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'invited_by',
    foreignKeyConstraintName: 'institution_invitations_invited_by_fkey',
  })
  invitedByUser: UserEntity | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

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
