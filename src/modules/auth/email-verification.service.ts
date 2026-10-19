import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { escapeHtml } from '../../common/utils/escape-html';
import { MailService } from '../mail/mail.service';
import { UserEntity } from '../users/entities/user.entity';
import { EmailVerificationTokenEntity } from './entities/email-verification-token.entity';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { TokenService } from './token.service';

/** Vigencia del enlace de verificación. */
export const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Un reenvío cada 2 minutos como máximo (como la recuperación). */
const RESEND_COOLDOWN_MS = 2 * 60 * 1000;
/** Mismo mensaje que al crear: no dice si coincidió el documento o el email. */
export const EMAIL_TAKEN = 'Ya existe un usuario con ese documento o email';
const INVALID_LINK = 'Enlace inválido o vencido';

/** Cambio pedido: se notifica después del commit con notify. */
export interface EmailChangeNotice {
  kind: 'change';
  userId: string;
  firstName: string;
  newEmail: string;
  /** Solo si estaba verificado: se le avisa del cambio. */
  previousEmail: string | null;
  rawToken: string;
}

/** Email verificado que un administrador quitó: se le avisa (M1 de la fase 11b). */
export interface EmailRemovedNotice {
  kind: 'removed';
  email: string;
  firstName: string;
}

export type EmailNotice = EmailChangeNotice | EmailRemovedNotice;

/** Cambio pedido por otra persona, que se vuelve a validar al confirmarlo. */
export interface ThirdPartyChange {
  targetId: string;
  requesterId: string;
  institutionId: string;
}

/**
 * Vuelve a aplicar las reglas de gestión al confirmar (hallazgo A1 de la fase
 * 11b): lanza si quien pidió el cambio ya no puede gestionar al usuario. La
 * registra el módulo de usuarios (evita la dependencia circular).
 */
export type ThirdPartyChangeGuard = (
  manager: EntityManager,
  change: ThirdPartyChange,
) => Promise<void>;

/** `ana@colegio.edu.co` -> `a***@colegio.edu.co`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, Math.min(1, at))}***${email.slice(at)}`;
}

/**
 * Verificación del email (tarea 2.11.6, hallazgo M2 de la fase 7a). Un email
 * nuevo nunca reemplaza al actual hasta que su dueño abre el enlace: así un
 * administrador no puede poner un correo suyo y tomar la cuenta con
 * forgot-password, que solo envía a correos verificados.
 *
 * Todo cambio del email (pedir, quitar, confirmar) inutiliza los enlaces
 * anteriores: un enlace viejo nunca devuelve un correo que ya se reemplazó.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private changeGuard: ThirdPartyChangeGuard | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Lo llama el módulo de usuarios al arrancar. */
  setChangeGuard(guard: ThirdPartyChangeGuard): void {
    this.changeGuard = guard;
  }

  /**
   * Crea el enlace para ese email e inutiliza los anteriores del usuario.
   * Devuelve el token en claro (solo se guarda su hash). Si lo pide otra
   * persona, institutionId es donde actuó (se revalida al confirmar).
   */
  async issue(
    manager: EntityManager,
    userId: string,
    email: string,
    requestedBy: string | null,
    institutionId: string | null = null,
  ): Promise<string> {
    await this.cancelPending(manager, userId);
    const rawToken = this.tokens.generateOpaqueToken();
    await manager.getRepository(EmailVerificationTokenEntity).insert({
      userId,
      email,
      tokenHash: this.tokens.hashToken(rawToken),
      expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
      requestedBy,
      institutionId,
    });
    return rawToken;
  }

  /**
   * Inutiliza los enlaces vigentes del usuario (cancela un cambio pendiente).
   * Devuelve cuántos había.
   */
  async cancelPending(
    manager: EntityManager,
    userId: string,
    institutionId?: string,
  ): Promise<number> {
    const result = await manager
      .getRepository(EmailVerificationTokenEntity)
      .update(
        {
          userId,
          usedAt: IsNull(),
          // Solo los pedidos desde esa institución (usuario compartido).
          ...(institutionId ? { institutionId } : {}),
        },
        { usedAt: new Date() },
      );
    return result.affected ?? 0;
  }

  /**
   * Dentro de la transacción del llamador, con el usuario ya bloqueado: pide
   * el cambio a newEmail sin tocar users.email. 409 si otro usuario ya lo usa.
   */
  async requestChange(
    manager: EntityManager,
    user: UserEntity,
    newEmail: string,
    requestedBy: string,
    institutionId: string | null,
  ): Promise<EmailChangeNotice> {
    const taken = await manager
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .where('u.email = :email AND u.id <> :id', {
        email: newEmail,
        id: user.id,
      })
      .getExists();
    if (taken) throw new ConflictException(EMAIL_TAKEN);
    const rawToken = await this.issue(
      manager,
      user.id,
      newEmail,
      requestedBy,
      institutionId,
    );
    return {
      kind: 'change',
      userId: user.id,
      firstName: user.firstName,
      newEmail,
      previousEmail: user.emailVerifiedAt ? user.email : null,
      rawToken,
    };
  }

  /** Después del commit: los correos del aviso. Nunca lanza. */
  notify(notice: EmailNotice | null): void {
    if (!notice) return;
    if (notice.kind === 'change') {
      this.notifyChange(notice);
      return;
    }
    this.deliver({
      to: notice.email,
      subject: 'Aula360 - Se quitó el correo de tu cuenta',
      text: `Hola ${notice.firstName}. Un administrador quitó este correo de tu cuenta de Aula360: ya no recibirás enlaces de recuperación aquí. Si no lo esperabas, contacta al administrador de tu institución.`,
      html: `<p>Hola ${escapeHtml(notice.firstName)}.</p><p>Un administrador quitó este correo de tu cuenta de Aula360: ya no recibirás enlaces de recuperación aquí.</p><p>Si no lo esperabas, contacta al administrador de tu institución.</p>`,
    });
  }

  /** Enlace al correo nuevo y aviso al anterior. */
  private notifyChange(notice: EmailChangeNotice): void {
    this.sendLink(notice.newEmail, notice.firstName, notice.rawToken, 'change');
    if (notice.previousEmail) {
      const masked = escapeHtml(maskEmail(notice.newEmail));
      this.deliver({
        to: notice.previousEmail,
        subject: 'Aula360 - Cambio de correo solicitado',
        text: `Hola ${notice.firstName}. Se solicitó cambiar el correo de tu cuenta de Aula360 a ${maskEmail(notice.newEmail)}. El cambio solo se aplica cuando se confirme desde ese correo. Si no fuiste tú, contacta al administrador de tu institución.`,
        html: `<p>Hola ${escapeHtml(notice.firstName)}.</p><p>Se solicitó cambiar el correo de tu cuenta de Aula360 a <strong>${masked}</strong>. El cambio solo se aplica cuando se confirme desde ese correo.</p><p>Si no fuiste tú, contacta al administrador de tu institución.</p>`,
      });
    }
  }

  /** Texto del enlace para el correo de bienvenida (contraseña temporal). */
  link(rawToken: string): string {
    // El token va en el fragmento (#): el navegador no lo envía al servidor ni en el Referer.
    return `${this.config.getOrThrow<string>('FRONTEND_URL')}/verify-email#token=${rawToken}`;
  }

  /**
   * El propio usuario pide cambiar su correo. Exige la contraseña actual: una
   * sesión robada no basta para llevarse la cuenta.
   */
  async requestOwnChange(
    userId: string,
    newEmail: string,
    currentPassword: string,
  ): Promise<void> {
    const notice = await this.dataSource.transaction(async (manager) => {
      const user = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.id = :id AND u.is_active = true', { id: userId })
        .setLock('pessimistic_write')
        .getOne();
      if (!user) throw new UnauthorizedException();
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new BadRequestException('La contraseña actual no es correcta');
      }
      if (sameEmail(user.email, newEmail)) {
        await this.cancelPending(manager, user.id);
        return null;
      }
      return this.requestChange(manager, user, newEmail, userId, null);
    });
    if (notice) {
      this.audit('user.email-change-requested', userId, userId);
      this.notify(notice);
    }
  }

  /**
   * Confirma con el enlace: el email del token pasa a ser el de la cuenta y
   * queda verificado. Los enlaces de recuperación (enviados al correo
   * anterior) dejan de servir.
   */
  async confirm(rawToken: string): Promise<void> {
    const tokenHash = this.tokens.hashToken(rawToken);
    const valid =
      't.token_hash = :tokenHash AND t.used_at IS NULL AND t.expires_at > CURRENT_TIMESTAMP';
    const userId = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EmailVerificationTokenEntity);
      // Primero el usuario y después el token, en el mismo orden que los
      // pedidos (B6 de la fase 11b); el token se relee ya bloqueado.
      const found = await repo
        .createQueryBuilder('t')
        .where(valid, { tokenHash })
        .getOne();
      const user = found
        ? await manager.getRepository(UserEntity).findOne({
            where: { id: found.userId, isActive: true },
            lock: { mode: 'pessimistic_write' },
          })
        : null;
      const token = user
        ? await repo
            .createQueryBuilder('t')
            .where(valid, { tokenHash })
            .setLock('pessimistic_write')
            .getOne()
        : null;
      if (!token || !user) throw new BadRequestException(INVALID_LINK);
      await this.assertStillAllowed(manager, token);

      await repo.update(token.id, { usedAt: new Date() });
      const changed = !sameEmail(user.email, token.email);
      try {
        await manager.getRepository(UserEntity).update(user.id, {
          email: token.email,
          emailVerifiedAt: new Date(),
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ConflictException(EMAIL_TAKEN);
        }
        throw error;
      }
      if (changed) {
        await manager
          .getRepository(PasswordResetTokenEntity)
          .update(
            { userId: user.id, usedAt: IsNull() },
            { usedAt: new Date() },
          );
      }
      return user.id;
    });
    this.audit('user.email-verified', userId, null);
  }

  /**
   * Un cambio pedido por otra persona solo se aplica si sigue pudiendo
   * gestionar al usuario (exclusividad, techo, permiso y que siga activa):
   * si no, el enlace no sirve (hallazgo A1 de la fase 11b).
   */
  private async assertStillAllowed(
    manager: EntityManager,
    token: EmailVerificationTokenEntity,
  ): Promise<void> {
    if (!token.requestedBy || token.requestedBy === token.userId) return;
    if (!token.institutionId || !this.changeGuard) {
      throw new BadRequestException(INVALID_LINK);
    }
    try {
      await this.changeGuard(manager, {
        targetId: token.userId,
        requesterId: token.requestedBy,
        institutionId: token.institutionId,
      });
    } catch (error) {
      if (error instanceof HttpException) {
        this.audit('user.email-change-rejected', token.userId, null);
        throw new BadRequestException(INVALID_LINK);
      }
      throw error;
    }
  }

  /**
   * Reenvía el enlace del cambio pendiente o, si no hay, del email actual sin
   * verificar. Silencioso si no hay nada que verificar o si es muy pronto.
   * Un cambio pedido por otra persona no se reenvía (no se alarga su plazo,
   * hallazgo A1 de la fase 11b): hay que pedirlo de nuevo.
   */
  async resend(userId: string): Promise<void> {
    const pending = await this.dataSource.transaction(async (manager) => {
      const user = await manager.getRepository(UserEntity).findOne({
        where: { id: userId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) return null;
      const repo = manager.getRepository(EmailVerificationTokenEntity);
      const latest = await repo
        .createQueryBuilder('t')
        .where('t.user_id = :userId', { userId })
        .orderBy('t.created_at', 'DESC')
        .getOne();
      if (
        latest &&
        latest.createdAt.getTime() > Date.now() - RESEND_COOLDOWN_MS
      ) {
        return null;
      }
      const ownPending =
        latest &&
        !latest.usedAt &&
        latest.expiresAt > new Date() &&
        latest.requestedBy === user.id;
      const target = ownPending
        ? latest.email
        : !user.emailVerifiedAt
          ? user.email
          : null;
      if (!target) return null;
      const rawToken = await this.issue(manager, user.id, target, user.id);
      return { email: target, firstName: user.firstName, rawToken };
    });
    if (pending) {
      this.sendLink(
        pending.email,
        pending.firstName,
        pending.rawToken,
        'verify',
      );
    }
  }

  /** Cambio pendiente de cada usuario (token vigente con otro email). */
  async pendingEmails(
    manager: EntityManager,
    userIds: string[],
    institutionId?: string,
  ): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    // Con institutionId (quien mira no es SUPER_ADMIN) solo cuentan los
    // cambios del propio usuario o pedidos desde esa institución: un cambio
    // que pidió otra institución no se le muestra (V5 de la fase 11c).
    const rows = await manager.query<{ user_id: string; email: string }[]>(
      `SELECT t.user_id, t.email
         FROM email_verification_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.user_id = ANY($1::uuid[])
          AND t.used_at IS NULL AND t.expires_at > CURRENT_TIMESTAMP
          AND t.email IS DISTINCT FROM u.email
          AND ($2::uuid IS NULL OR t.requested_by = t.user_id OR t.institution_id = $2::uuid)`,
      [userIds, institutionId ?? null],
    );
    return new Map(rows.map((r) => [r.user_id, r.email]));
  }

  private sendLink(
    to: string,
    firstName: string,
    rawToken: string,
    reason: 'change' | 'verify',
  ): void {
    const link = this.link(rawToken);
    const intro =
      reason === 'change'
        ? 'se solicitó usar este correo en tu cuenta de Aula360'
        : 'confirma el correo de tu cuenta de Aula360';
    this.deliver({
      to,
      subject: 'Aula360 - Confirma tu correo',
      text: `Hola ${firstName}, ${intro}. Para confirmarlo entra a: ${link}\nEl enlace vence en 24 horas. Si no lo solicitaste, ignora este correo.`,
      html: `<p>Hola ${escapeHtml(firstName)}, ${intro}.</p><p>Para confirmarlo entra a: <a href="${link}">confirmar correo</a></p><p>El enlace vence en 24 horas. Si no lo solicitaste, ignora este correo.</p>`,
    });
  }

  private deliver(message: Parameters<MailService['send']>[0]): void {
    this.mail
      .send(message)
      .catch((error: unknown) =>
        this.logger.error(
          `No se pudo enviar el correo de verificación: ${(error as { code?: string }).code ?? 'Error'}`,
        ),
      );
  }

  /** Auditoría sin el email (es dato personal). */
  private audit(action: string, userId: string, actorId: string | null): void {
    this.logger.log(
      JSON.stringify({ audit: action, targetUserId: userId, actorId }),
    );
  }
}

/** Comparación como la de citext: sin distinguir mayúsculas. */
export function sameEmail(a: string | null, b: string | null): boolean {
  return (a?.toLowerCase() ?? null) === (b?.toLowerCase() ?? null);
}
