import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'crypto';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { BCRYPT_COST } from '../../common/validators/password-policy';
import { MailService } from '../mail/mail.service';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { UserEntity } from '../users/entities/user.entity';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  InstitutionMembershipDto,
  SessionResponseDto,
} from './dto/session-response.dto';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { TokenService } from './token.service';
import { EmailVerificationService } from './email-verification.service';
import { escapeHtml } from '../../common/utils/escape-html';
import { ACTIVE_ASSIGNMENT_CONDITION } from '../security/active-assignment';

export const INVALID_CREDENTIALS = 'Credenciales inválidas';
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Evita llenar de correos a una víctima: un enlace nuevo cada 2 minutos como máximo. */
const RESET_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  session: SessionResponseDto;
  tokens: IssuedTokens;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private dummyHash?: Promise<string>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly emailVerification: EmailVerificationService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(UserInstitutionRoleEntity)
    private readonly memberships: Repository<UserInstitutionRoleEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
  ) {}

  /** El hash falso se calcula al arrancar: la primera petición no tarda distinto. */
  onModuleInit(): void {
    void this.getDummyHash();
  }

  // ---------------------------------------------------------------- login

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.findUserForLogin(dto);
    // Si no existe, se compara igual contra un hash falso: mismo tiempo de respuesta.
    const hash = user?.passwordHash ?? (await this.getDummyHash());
    const valid = await bcrypt.compare(dto.password, hash);
    if (!user || !valid || !user.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const institutions = await this.getMemberships(user.id);
    const activeInstitutionId =
      institutions.length === 1 ? institutions[0].id : null;

    // La sesión se crea con el usuario bloqueado y solo si la contraseña no
    // cambió (ni se desactivó) mientras se comparaba: así un login con la
    // contraseña vieja no sobrevive a un reinicio hecho en paralelo.
    const tokens = await this.dataSource.transaction(async (manager) => {
      const locked = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.id = :id AND u.is_active = true', { id: user.id })
        .setLock('pessimistic_write')
        .getOne();
      if (!locked || locked.passwordHash !== user.passwordHash) {
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }
      const issued = await this.issueTokens(
        manager,
        user.id,
        activeInstitutionId,
      );
      await manager
        .getRepository(UserEntity)
        .update(user.id, { lastLoginAt: new Date() });
      return issued;
    });

    return {
      tokens,
      session: await this.toSession(user, activeInstitutionId, institutions),
    };
  }

  /** Busca por email (si tiene @) o por número de documento. Ambigüedad = no encontrado. */
  private async findUserForLogin(dto: LoginDto): Promise<UserEntity | null> {
    const qb = this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .take(2);
    if (dto.identifier.includes('@')) {
      qb.where('u.email = :email', { email: dto.identifier });
    } else {
      qb.where('u.document_number = :number', { number: dto.identifier });
      if (dto.documentType) {
        qb.andWhere('u.document_type = :type', { type: dto.documentType });
      }
    }
    const found = await qb.getMany();
    return found.length === 1 ? found[0] : null;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash(
      randomBytes(32).toString('hex'),
      BCRYPT_COST,
    );
    return this.dummyHash;
  }

  // ---------------------------------------------------------- sesión / me

  async getSession(user: AuthUser): Promise<SessionResponseDto> {
    const entity = await this.users.findOne({ where: { id: user.userId } });
    if (!entity) throw new UnauthorizedException();
    const institutions = await this.getMemberships(user.userId);
    return await this.toSession(entity, user.institutionId, institutions);
  }

  /** Reemite el access token (misma sesión) con otra institución tras verificar el vínculo. */
  async switchInstitution(
    user: AuthUser,
    institutionId: string,
  ): Promise<{ session: SessionResponseDto; accessToken: string }> {
    const institutions = await this.getMemberships(user.userId);
    // 404 y no 403: no se revela si la institución existe.
    if (!institutions.some((i) => i.id === institutionId)) {
      throw new NotFoundException('Institución no encontrada');
    }
    const entity = await this.users.findOne({ where: { id: user.userId } });
    if (!entity) throw new UnauthorizedException();
    const accessToken = await this.tokens.signAccessToken({
      sub: user.userId,
      institutionId,
      sid: user.sessionId,
    });
    return {
      accessToken,
      session: await this.toSession(entity, institutionId, institutions),
    };
  }

  // ------------------------------------------------------ refresh / logout

  /**
   * Rotación: el refresh token usado queda revocado y se emite uno nuevo.
   * Si llega uno ya revocado (posible robo), se revocan todos los del usuario.
   * La institución activa se toma del access token anterior (aunque esté vencido)
   * y se vuelve a verificar.
   *
   * Se ejecuta en una transacción que bloquea la fila del usuario, igual que el
   * cambio y el restablecimiento de contraseña: así un refresh concurrente no
   * puede dejar viva una sesión después de "cerrar todas las sesiones".
   */
  async refresh(
    rawRefreshToken: string | undefined,
    rawAccessToken: string | undefined,
  ): Promise<IssuedTokens> {
    if (!rawRefreshToken) throw new UnauthorizedException();

    const stored = await this.refreshTokens.findOne({
      where: { tokenHash: this.tokens.hashToken(rawRefreshToken) },
    });
    if (!stored) throw new UnauthorizedException();

    if (stored.revokedAt) return this.handleReuse(stored.userId);
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException();
    }

    const tokens = await this.dataSource.transaction(async (manager) => {
      const user = await this.lockActiveUser(manager, stored.userId);
      if (!user) return 'inactive' as const;

      // Revocación atómica: si otra petición ya lo usó (o se cerraron todas las
      // sesiones), no afecta filas y se trata como reutilización.
      const result = await manager
        .getRepository(RefreshTokenEntity)
        .update(
          { id: stored.id, revokedAt: IsNull() },
          { revokedAt: new Date() },
        );
      if (!result.affected) return 'reused' as const;

      const institutionId = await this.resolveInstitutionOnRefresh(
        manager,
        user.id,
        rawAccessToken,
      );
      return this.issueTokens(manager, user.id, institutionId);
    });

    if (tokens === 'reused') return this.handleReuse(stored.userId);
    if (tokens === 'inactive') throw new UnauthorizedException();
    return tokens;
  }

  private async handleReuse(userId: string): Promise<never> {
    await this.revokeAllRefreshTokens(this.dataSource.manager, userId);
    this.logger.warn(`Reutilización de refresh token (usuario ${userId})`);
    throw new UnauthorizedException();
  }

  private async resolveInstitutionOnRefresh(
    manager: EntityManager,
    userId: string,
    rawAccessToken: string | undefined,
  ): Promise<string | null> {
    const institutions = await this.getMemberships(userId, manager);
    if (rawAccessToken) {
      try {
        const previous = await this.tokens.verifyAccessToken(rawAccessToken, {
          ignoreExpiration: true,
        });
        if (
          previous.sub === userId &&
          previous.institutionId &&
          institutions.some((i) => i.id === previous.institutionId)
        ) {
          return previous.institutionId;
        }
      } catch {
        // Token alterado o de otro secreto: se ignora.
      }
    }
    return institutions.length === 1 ? institutions[0].id : null;
  }

  /** Revoca la sesión: su access token deja de valer de inmediato (el guard verifica el sid). */
  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    await this.refreshTokens.update(
      {
        tokenHash: this.tokens.hashToken(rawRefreshToken),
        revokedAt: IsNull(),
      },
      { revokedAt: new Date() },
    );
  }

  // ---------------------------------------------------------- contraseñas

  /**
   * Cambia la contraseña, limpia must_change_password y cierra todas las sesiones
   * (sus access tokens dejan de valer). La sesión actual recibe tokens nuevos.
   */
  async changePassword(
    user: AuthUser,
    dto: ChangePasswordDto,
  ): Promise<IssuedTokens> {
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'La nueva contraseña debe ser distinta de la actual',
      );
    }
    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_COST);

    return this.dataSource.transaction(async (manager) => {
      const entity = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.id = :id AND u.is_active = true', { id: user.userId })
        .setLock('pessimistic_write')
        .getOne();
      if (!entity) throw new UnauthorizedException();

      if (!(await bcrypt.compare(dto.currentPassword, entity.passwordHash))) {
        throw new BadRequestException('La contraseña actual no es correcta');
      }

      await manager.getRepository(UserEntity).update(entity.id, {
        passwordHash: newHash,
        mustChangePassword: false,
      });
      await this.endAllSessions(manager, entity.id);
      return this.issueTokens(manager, entity.id, user.institutionId);
    });
  }

  /**
   * Responde de inmediato y siempre igual: todo el trabajo que depende de si el
   * email existe corre en segundo plano, para que ni el mensaje ni el tiempo de
   * respuesta lo delaten. Solo a correos verificados (tarea 2.11.6): si no, un
   * administrador podría poner un correo suyo y tomar la cuenta.
   */
  forgotPassword(email: string): void {
    // Solo el código: el mensaje de SMTP puede traer la dirección (B5 de la fase 11e).
    this.processForgotPassword(email).catch((error: unknown) =>
      this.logger.error(
        `Error en la recuperación de contraseña: ${(error as { code?: string }).code ?? (error as Error).name}`,
      ),
    );
  }

  private async processForgotPassword(email: string): Promise<void> {
    const user = await this.users.findOne({
      where: { email, isActive: true, emailVerifiedAt: Not(IsNull()) },
    });
    if (!user?.email) return;

    const rawToken = this.tokens.generateOpaqueToken();
    const created = await this.dataSource.transaction(async (manager) => {
      // Si el email cambió en paralelo (p. ej. lo editó un administrador),
      // no se crea el token: el enlace nunca va a un correo que ya no es suyo.
      const locked = await this.lockActiveUser(manager, user.id);
      if (
        !locked?.email ||
        locked.email !== user.email ||
        !locked.emailVerifiedAt
      ) {
        return false;
      }
      const repo = manager.getRepository(PasswordResetTokenEntity);
      const recent = await repo.exists({
        where: {
          userId: user.id,
          usedAt: IsNull(),
          createdAt: MoreThan(new Date(Date.now() - RESET_REQUEST_COOLDOWN_MS)),
        },
      });
      if (recent) return false;

      // Un solo token vigente por usuario: los anteriores quedan inutilizados.
      await repo.update(
        { userId: user.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );
      await repo.insert({
        userId: user.id,
        tokenHash: this.tokens.hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });
      return true;
    });
    if (!created) return;

    // El token va en el fragmento (#): el navegador no lo envía al servidor ni en el Referer.
    const link = `${this.config.getOrThrow<string>('FRONTEND_URL')}/reset-password#token=${rawToken}`;
    await this.mail.send({
      to: user.email,
      subject: 'Aula360 - Recuperación de contraseña',
      text: `Hola ${user.firstName}. Para restablecer tu contraseña entra a: ${link}\nEl enlace vence en 30 minutos. Si no lo solicitaste, ignora este correo.`,
      html: `<p>Hola ${escapeHtml(user.firstName)}.</p><p>Para restablecer tu contraseña entra a: <a href="${link}">restablecer contraseña</a></p><p>El enlace vence en 30 minutos. Si no lo solicitaste, ignora este correo.</p>`,
    });
  }

  /** Token de un solo uso y con vencimiento; al usarlo se cierran todas las sesiones. */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = this.tokens.hashToken(dto.token);
    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_COST);

    await this.dataSource.transaction(async (manager) => {
      const tokenRepo = manager.getRepository(PasswordResetTokenEntity);
      const token = await tokenRepo.findOne({
        where: { tokenHash, usedAt: IsNull(), expiresAt: MoreThan(new Date()) },
        lock: { mode: 'pessimistic_write' },
      });
      const user = token
        ? await this.lockActiveUser(manager, token.userId)
        : null;
      if (!token || !user) {
        throw new BadRequestException('Token inválido o vencido');
      }

      await tokenRepo.update(token.id, { usedAt: new Date() });
      await manager
        .getRepository(UserEntity)
        .update(user.id, { passwordHash: newHash, mustChangePassword: false });
      await this.endAllSessions(manager, user.id);
    });
  }

  // -------------------------------------------------------------- helpers

  /** SELECT ... FOR UPDATE sobre el usuario: serializa refresh y cambios de contraseña. */
  private lockActiveUser(
    manager: EntityManager,
    userId: string,
  ): Promise<UserEntity | null> {
    return manager.getRepository(UserEntity).findOne({
      where: { id: userId, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /** Crea la sesión (refresh token) y un access token ligado a ella por su id (sid). */
  private async issueTokens(
    manager: EntityManager,
    userId: string,
    institutionId: string | null,
  ): Promise<IssuedTokens> {
    const sessionId = randomUUID();
    const refreshToken = this.tokens.generateOpaqueToken();
    await manager.getRepository(RefreshTokenEntity).insert({
      id: sessionId,
      userId,
      tokenHash: this.tokens.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs),
    });
    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      institutionId,
      sid: sessionId,
    });
    return { accessToken, refreshToken };
  }

  /**
   * Cierra todas las sesiones al cambiar o restablecer la contraseña. Se eliminan
   * en vez de revocarse: si otro dispositivo presenta después su refresh token, no
   * existe (401) y no se confunde con una reutilización, que cerraría también la
   * sesión nueva del usuario.
   */
  private async endAllSessions(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.getRepository(RefreshTokenEntity).delete({ userId });
  }

  private async revokeAllRefreshTokens(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager
      .getRepository(RefreshTokenEntity)
      .update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /**
   * Instituciones activas del usuario con los nombres de sus roles en cada una.
   * Dentro de una transacción, con su manager (sin pedir otra conexión).
   */
  private async getMemberships(
    userId: string,
    manager?: EntityManager,
  ): Promise<InstitutionMembershipDto[]> {
    const repo = manager
      ? manager.getRepository(UserInstitutionRoleEntity)
      : this.memberships;
    const rows = await repo
      .createQueryBuilder('uir')
      .innerJoin('uir.institution', 'i', 'i.is_active = true')
      .innerJoin('uir.role', 'r')
      .select(['i.id AS id', 'i.name AS name', 'r.name AS role'])
      .where('uir.user_id = :userId', { userId })
      .andWhere(ACTIVE_ASSIGNMENT_CONDITION)
      .orderBy('i.name', 'ASC')
      .addOrderBy('r.name', 'ASC')
      .getRawMany<{ id: string; name: string; role: string }>();

    const byId = new Map<string, InstitutionMembershipDto>();
    for (const row of rows) {
      const entry = byId.get(row.id) ?? {
        id: row.id,
        name: row.name,
        roles: [],
      };
      if (!entry.roles.includes(row.role)) entry.roles.push(row.role);
      byId.set(row.id, entry);
    }
    return [...byId.values()];
  }

  private async toSession(
    user: UserEntity,
    activeInstitutionId: string | null,
    institutions: InstitutionMembershipDto[],
  ): Promise<SessionResponseDto> {
    const pending = await this.emailVerification.pendingEmails(
      this.dataSource.manager,
      [user.id],
    );
    return {
      user: {
        id: user.id,
        userType: user.userType,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        pendingEmail: pending.get(user.id) ?? null,
        hasAvatar: user.avatarPath !== null,
        mustChangePassword: user.mustChangePassword,
      },
      activeInstitutionId,
      institutions,
    };
  }
}
