import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { UserEntity } from '../users/entities/user.entity';
import {
  EMAIL_TOKEN_TTL_MS,
  EmailVerificationService,
  maskEmail,
  sameEmail,
} from './email-verification.service';
import { EmailVerificationTokenEntity } from './entities/email-verification-token.entity';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { TokenService } from './token.service';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));
const compare = bcrypt.compare as jest.Mock;

const flush = () => new Promise((r) => setImmediate(r));

describe('maskEmail y sameEmail', () => {
  it('enmascara la parte local', () => {
    expect(maskEmail('ana.perez@colegio.edu.co')).toBe('a***@colegio.edu.co');
  });

  it('compara sin distinguir mayúsculas', () => {
    expect(sameEmail('Ana@X.co', 'ana@x.co')).toBe(true);
    expect(sameEmail(null, null)).toBe(true);
    expect(sameEmail('a@x.co', null)).toBe(false);
  });
});

describe('EmailVerificationService', () => {
  const user = (o: Partial<UserEntity> = {}) =>
    ({
      id: 'u1',
      firstName: 'Ana',
      email: 'ana@colegio.co',
      emailVerifiedAt: new Date(),
      passwordHash: 'hash',
      isActive: true,
      ...o,
    }) as UserEntity;

  /** Query builder encadenable que devuelve lo indicado. */
  const qb = (result: { one?: unknown; exists?: boolean } = {}) => {
    const b: Record<string, jest.Mock> = {};
    for (const m of ['where', 'addSelect', 'setLock', 'orderBy']) {
      b[m] = jest.fn(() => b);
    }
    b.getOne = jest.fn().mockResolvedValue(result.one ?? null);
    b.getExists = jest.fn().mockResolvedValue(result.exists ?? false);
    return b;
  };

  let tokenRepo: Record<string, jest.Mock>;
  let userRepo: Record<string, jest.Mock>;
  let resetRepo: { update: jest.Mock };
  let manager: EntityManager;
  let service: EmailVerificationService;
  const mail = { send: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mail.send.mockResolvedValue(undefined);
    tokenRepo = {
      insert: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => qb()),
    };
    userRepo = {
      update: jest.fn(),
      findOne: jest.fn().mockResolvedValue(user()),
      createQueryBuilder: jest.fn(() => qb()),
    };
    resetRepo = { update: jest.fn() };
    const repos = new Map<unknown, unknown>([
      [EmailVerificationTokenEntity, tokenRepo],
      [UserEntity, userRepo],
      [PasswordResetTokenEntity, resetRepo],
    ]);
    manager = {
      getRepository: jest.fn((e: unknown) => repos.get(e)),
    } as unknown as EntityManager;
    const dataSource = {
      manager,
      transaction: jest.fn((cb: (m: EntityManager) => unknown) => cb(manager)),
    };
    const tokens = {
      generateOpaqueToken: () => 'raw',
      hashToken: (t: string) => `sha(${t})`,
    };
    service = new EmailVerificationService(
      dataSource as unknown as DataSource,
      tokens as unknown as TokenService,
      mail as unknown as MailService,
      { getOrThrow: () => 'http://front' } as unknown as ConfigService,
    );
  });

  it('issue guarda solo el hash, con vencimiento de 24 h, e inutiliza los anteriores', async () => {
    const before = Date.now();
    await expect(
      service.issue(manager, 'u1', 'nuevo@x.co', 'admin-1'),
    ).resolves.toBe('raw');
    expect(tokenRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      expect.objectContaining({ usedAt: expect.any(Date) as Date }),
    );
    const row = (tokenRepo.insert.mock.calls as unknown[][])[0][0] as {
      tokenHash: string;
      expiresAt: Date;
      requestedBy: string;
    };
    expect(row).toMatchObject({
      tokenHash: 'sha(raw)',
      requestedBy: 'admin-1',
    });
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + EMAIL_TOKEN_TTL_MS,
    );
  });

  it('requestChange: 409 genérico si otro usuario ya usa el correo', async () => {
    userRepo.createQueryBuilder.mockReturnValue(qb({ exists: true }));
    await expect(
      service.requestChange(manager, user(), 'otro@x.co', 'admin-1', 'inst-1'),
    ).rejects.toThrow(ConflictException);
    expect(tokenRepo.insert).not.toHaveBeenCalled();
  });

  it('requestChange: solo avisa al correo anterior si estaba verificado', async () => {
    const verified = await service.requestChange(
      manager,
      user(),
      'nuevo@x.co',
      'admin-1',
      'inst-1',
    );
    expect(tokenRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: 'admin-1',
        institutionId: 'inst-1',
      }),
    );
    expect(verified.previousEmail).toBe('ana@colegio.co');
    const unverified = await service.requestChange(
      manager,
      user({ emailVerifiedAt: null }),
      'nuevo@x.co',
      'admin-1',
      'inst-1',
    );
    expect(unverified.previousEmail).toBeNull();
  });

  it('notify (cambio): enlace al nuevo con el token en el fragmento y aviso enmascarado al anterior', async () => {
    service.notify({
      kind: 'change',
      userId: 'u1',
      firstName: 'Ana',
      newEmail: 'nuevo@x.co',
      previousEmail: 'ana@colegio.co',
      rawToken: 'raw',
    });
    await flush();
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'nuevo@x.co',
        text: expect.stringContaining(
          'http://front/verify-email#token=raw',
        ) as string,
      }),
    );
    const warning = (mail.send.mock.calls as unknown[][]).find(
      ([m]) => (m as { to: string }).to === 'ana@colegio.co',
    )?.[0] as { text: string };
    expect(warning.text).toContain('n***@x.co');
    expect(warning.text).not.toContain('nuevo@x.co');
    expect(warning.text).not.toContain('raw');
  });

  it('requestOwnChange exige la contraseña actual', async () => {
    userRepo.createQueryBuilder.mockReturnValue(qb({ one: user() }));
    compare.mockResolvedValue(false);
    await expect(
      service.requestOwnChange('u1', 'nuevo@x.co', 'mala'),
    ).rejects.toThrow(BadRequestException);
    expect(tokenRepo.insert).not.toHaveBeenCalled();

    userRepo.createQueryBuilder.mockReturnValue(qb({ one: null }));
    await expect(
      service.requestOwnChange('u1', 'nuevo@x.co', 'x'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('confirm: token inválido, vencido o de un usuario inactivo responde 400', async () => {
    await expect(service.confirm('raw')).rejects.toThrow(BadRequestException);
    tokenRepo.createQueryBuilder.mockReturnValue(
      qb({ one: { id: 't1', userId: 'u1', email: 'nuevo@x.co' } }),
    );
    userRepo.findOne.mockResolvedValue(null);
    await expect(service.confirm('raw')).rejects.toThrow(BadRequestException);
    expect(userRepo.update).not.toHaveBeenCalled();
  });

  it('confirm aplica el correo nuevo, lo verifica e invalida la recuperación', async () => {
    tokenRepo.createQueryBuilder.mockReturnValue(
      qb({ one: { id: 't1', userId: 'u1', email: 'nuevo@x.co' } }),
    );
    await service.confirm('raw');
    expect(tokenRepo.update).toHaveBeenCalledWith('t1', {
      usedAt: expect.any(Date) as Date,
    });
    expect(userRepo.update).toHaveBeenCalledWith('u1', {
      email: 'nuevo@x.co',
      emailVerifiedAt: expect.any(Date) as Date,
    });
    expect(resetRepo.update).toHaveBeenCalled();
  });

  it('confirm del mismo correo solo lo verifica (la recuperación sigue)', async () => {
    tokenRepo.createQueryBuilder.mockReturnValue(
      qb({ one: { id: 't1', userId: 'u1', email: 'ANA@colegio.co' } }),
    );
    await service.confirm('raw');
    expect(resetRepo.update).not.toHaveBeenCalled();
  });

  it('confirm: 409 si otro usuario tomó el correo antes', async () => {
    tokenRepo.createQueryBuilder.mockReturnValue(
      qb({ one: { id: 't1', userId: 'u1', email: 'nuevo@x.co' } }),
    );
    userRepo.update.mockRejectedValue(
      Object.assign(new Error('dup'), { code: '23505' }),
    );
    await expect(service.confirm('raw')).rejects.toThrow(ConflictException);
  });

  it('resend respeta la espera de 2 minutos', async () => {
    tokenRepo.createQueryBuilder.mockReturnValue(
      qb({
        one: {
          email: 'nuevo@x.co',
          createdAt: new Date(),
          usedAt: null,
          expiresAt: new Date(Date.now() + 1000),
        },
      }),
    );
    await service.resend('u1');
    expect(tokenRepo.insert).not.toHaveBeenCalled();
  });

  it('resend: reenvía el cambio pendiente o el email sin verificar; si no hay, nada', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    tokenRepo.createQueryBuilder.mockReturnValue(
      qb({
        one: {
          email: 'nuevo@x.co',
          createdAt: old,
          usedAt: null,
          expiresAt: new Date(Date.now() + 1000),
          requestedBy: 'u1',
        },
      }),
    );
    await service.resend('u1');
    expect(tokenRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'nuevo@x.co', requestedBy: 'u1' }),
    );

    tokenRepo.insert.mockClear();
    tokenRepo.createQueryBuilder.mockReturnValue(qb());
    userRepo.findOne.mockResolvedValue(user({ emailVerifiedAt: null }));
    await service.resend('u1');
    expect(tokenRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@colegio.co' }),
    );

    tokenRepo.insert.mockClear();
    userRepo.findOne.mockResolvedValue(user());
    await service.resend('u1');
    expect(tokenRepo.insert).not.toHaveBeenCalled();
  });

  it('notify (quitado): avisa al correo quitado', async () => {
    service.notify({
      kind: 'removed',
      email: 'ana@colegio.co',
      firstName: 'Ana',
    });
    await flush();
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@colegio.co',
        subject: 'Aula360 - Se quitó el correo de tu cuenta',
      }),
    );
  });

  describe('cambio pedido por otra persona (A1)', () => {
    const thirdParty = {
      id: 't1',
      userId: 'u1',
      email: 'nuevo@x.co',
      requestedBy: 'admin-1',
      institutionId: 'inst-1',
    };

    beforeEach(() => {
      tokenRepo.createQueryBuilder.mockReturnValue(qb({ one: thirdParty }));
    });

    it('sin la validación registrada, el enlace no sirve', async () => {
      await expect(service.confirm('raw')).rejects.toThrow(BadRequestException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('si quien lo pidió ya no puede gestionar al usuario: 400 y no cambia', async () => {
      const guard = jest.fn().mockRejectedValue(new ForbiddenException());
      service.setChangeGuard(guard);
      await expect(service.confirm('raw')).rejects.toThrow(BadRequestException);
      expect(guard).toHaveBeenCalledWith(manager, {
        targetId: 'u1',
        requesterId: 'admin-1',
        institutionId: 'inst-1',
      });
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('si todavía puede, se aplica', async () => {
      service.setChangeGuard(jest.fn().mockResolvedValue(undefined));
      await service.confirm('raw');
      expect(userRepo.update).toHaveBeenCalledWith('u1', {
        email: 'nuevo@x.co',
        emailVerifiedAt: expect.any(Date) as Date,
      });
    });

    it('un error que no es de reglas (p. ej. la base) no se disfraza de 400', async () => {
      service.setChangeGuard(jest.fn().mockRejectedValue(new Error('db')));
      await expect(service.confirm('raw')).rejects.toThrow('db');
    });

    it('lo pedido por el propio usuario no pasa por la validación', async () => {
      const guard = jest.fn();
      service.setChangeGuard(guard);
      tokenRepo.createQueryBuilder.mockReturnValue(
        qb({ one: { ...thirdParty, requestedBy: 'u1', institutionId: null } }),
      );
      await service.confirm('raw');
      expect(guard).not.toHaveBeenCalled();
    });

    it('resend no reemite un cambio pedido por otra persona (no alarga su plazo)', async () => {
      tokenRepo.createQueryBuilder.mockReturnValue(
        qb({
          one: {
            ...thirdParty,
            createdAt: new Date(Date.now() - 10 * 60_000),
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      );
      await service.resend('u1');
      expect(tokenRepo.insert).not.toHaveBeenCalled();
    });
  });
});
