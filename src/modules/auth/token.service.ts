import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { AccessTokenPayload } from '../../common/interfaces/auth-user.interface';

/** Firma/verificación del access token y generación de tokens aleatorios. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  get accessTtlSeconds(): number {
    return Number(this.config.get('JWT_ACCESS_EXPIRES_IN') ?? 900);
  }

  get refreshTtlMs(): number {
    return Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 7) * 86_400_000;
  }

  get secureCookies(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.accessTtlSeconds,
      algorithm: 'HS256',
    });
  }

  /** Verifica firma y expiración. Lanza si el token no es válido. */
  verifyAccessToken(
    token: string,
    { ignoreExpiration = false } = {},
  ): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithms: ['HS256'],
      ignoreExpiration,
    });
  }

  /** Token aleatorio de alta entropía (refresh y recuperación de contraseña). */
  generateOpaqueToken(): string {
    return randomBytes(48).toString('hex');
  }

  /** SHA-256 basta para tokens aleatorios; bcrypt es para contraseñas. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
