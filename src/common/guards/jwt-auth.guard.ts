import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { accessCookieName, readCookie } from '../../modules/auth/auth-cookies';
import { RefreshTokenEntity } from '../../modules/auth/entities/refresh-token.entity';
import { TokenService } from '../../modules/auth/token.service';
import { UserInstitutionRoleEntity } from '../../modules/security/entities/user-institution-role.entity';
import { UserEntity } from '../../modules/users/entities/user.entity';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../decorators/allow-pending-password-change.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  AccessTokenPayload,
  AuthUser,
} from '../interfaces/auth-user.interface';
import { ACTIVE_ASSIGNMENT_CONDITION } from '../../modules/security/active-assignment';
import { PasswordChangeRequiredException } from '../constants/error-codes';

/**
 * Guard global: exige un access token válido en la cookie, que el usuario siga
 * activo y que conserve acceso a la institución activa del token.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(UserInstitutionRoleEntity)
    private readonly memberships: Repository<UserInstitutionRoleEntity>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = readCookie(req, accessCookieName(this.tokens.secureCookies));
    if (!token) throw new UnauthorizedException();

    let payload: AccessTokenPayload;
    try {
      payload = await this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException();
    }

    if (typeof payload.sid !== 'string') throw new UnauthorizedException();

    // Usuario activo y sesión vigente (no revocada por logout, cambio o
    // restablecimiento de contraseña) en una sola consulta.
    const user = await this.users
      .createQueryBuilder('u')
      .select(['u.id', 'u.userType', 'u.mustChangePassword'])
      .innerJoin(
        RefreshTokenEntity,
        'rt',
        'rt.id = :sid AND rt.user_id = u.id AND rt.revoked_at IS NULL AND rt.expires_at > now()',
        { sid: payload.sid },
      )
      .where('u.id = :id AND u.is_active = true', { id: payload.sub })
      .getOne();
    if (!user) throw new UnauthorizedException();

    const institutionId = payload.institutionId ?? null;
    if (institutionId && !(await this.hasMembership(user.id, institutionId))) {
      throw new UnauthorizedException();
    }

    if (
      user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(
        ALLOW_PENDING_PASSWORD_CHANGE_KEY,
        targets,
      )
    ) {
      throw new PasswordChangeRequiredException();
    }

    req.user = {
      userId: user.id,
      institutionId,
      userType: user.userType,
      mustChangePassword: user.mustChangePassword,
      sessionId: payload.sid,
    };
    return true;
  }

  /** El usuario sigue vinculado a la institución (con una sede activa si es por sede) y esta sigue activa. */
  private hasMembership(
    userId: string,
    institutionId: string,
  ): Promise<boolean> {
    return this.memberships
      .createQueryBuilder('uir')
      .innerJoin('uir.institution', 'i', 'i.is_active = true')
      .where('uir.user_id = :userId AND uir.institution_id = :institutionId', {
        userId,
        institutionId,
      })
      .andWhere(ACTIVE_ASSIGNMENT_CONDITION)
      .getExists();
  }
}
