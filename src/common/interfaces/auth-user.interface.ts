import { UserType } from '../../modules/users/entities/user.entity';

/** Usuario autenticado que JwtAuthGuard deja en req.user. */
export interface AuthUser {
  userId: string;
  /** Institución activa (null si aún no eligió o es SUPER_ADMIN sin institución). */
  institutionId: string | null;
  userType: UserType;
  mustChangePassword: boolean;
  /** Sesión (id del refresh token): al revocarla, el access token deja de valer. */
  sessionId: string;
}

/** Payload del access token. Mínimo: sin datos personales. */
export interface AccessTokenPayload {
  sub: string;
  institutionId: string | null;
  /** Id de la sesión (refresh_tokens.id). */
  sid: string;
}
