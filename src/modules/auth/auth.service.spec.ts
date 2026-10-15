import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { DataSource, Repository } from 'typeorm';
import { MailService } from '../mail/mail.service';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { UserEntity } from '../users/entities/user.entity';
import { AuthService, INVALID_CREDENTIALS } from './auth.service';
import { PasswordResetTokenEntity } from './entities/password-reset-token.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { TokenService } from './token.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn().mockResolvedValue('hash-falso'),
}));
const compare = bcrypt.compare as jest.Mock;

function membershipsQb(rows: { id: string; name: string; role: string }[]) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
}

function usersQb(found: Partial<UserEntity>[]) {
  return {
    addSelect: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(found),
  };
}

const activeUser = {
  id: 'u1',
  userType: 'INSTITUTION_ADMIN',
  firstName: 'Ana',
  lastName: 'Pérez',
  email: 'ana@colegio.co',
  avatarPath: null,
  passwordHash: '$2b$12$hash',
  isActive: true,
  mustChangePassword: false,
} as unknown as UserEntity;

function setup({
  users = [activeUser] as Partial<UserEntity>[],
  memberships = [{ id: 'inst-1', name: 'Colegio', role: 'INSTITUTION_ADMIN' }],
} = {}) {
  const usersRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(usersQb(users)),
    update: jest.fn(),
    findOne: jest.fn().mockResolvedValue(users[0] ?? null),
  };
  const membershipsRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(membershipsQb(memberships)),
  };
  const refreshRepo = {
    insert: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn(),
  };
  const tokens = {
    refreshTtlMs: 7 * 86_400_000,
    generateOpaqueToken: jest.fn().mockReturnValue('raw-refresh'),
    hashToken: jest.fn((t: string) => `sha(${t})`),
    signAccessToken: jest.fn().mockResolvedValue('jwt'),
    verifyAccessToken: jest.fn(),
  };
  const resetRepo = {
    exists: jest.fn().mockResolvedValue(false),
    update: jest.fn(),
    insert: jest.fn(),
    findOne: jest.fn(),
  };
  // Dentro de las transacciones se usan los mismos repositorios simulados.
  const repos = new Map<unknown, unknown>([
    [UserEntity, usersRepo],
    [RefreshTokenEntity, refreshRepo],
    [PasswordResetTokenEntity, resetRepo],
  ]);
  const manager = { getRepository: jest.fn((e: unknown) => repos.get(e)) };
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
  };
  const mail = { send: jest.fn().mockResolvedValue(undefined) };
  const config = { getOrThrow: jest.fn().mockReturnValue('http://front') };
  const service = new AuthService(
    dataSource as unknown as DataSource,
    tokens as unknown as TokenService,
    mail as unknown as MailService,
    config as unknown as ConfigService,
    usersRepo as unknown as Repository<UserEntity>,
    membershipsRepo as unknown as Repository<UserInstitutionRoleEntity>,
    refreshRepo as unknown as Repository<RefreshTokenEntity>,
  );
  return { service, usersRepo, refreshRepo, resetRepo, tokens, mail };
}

/** Espera a que terminen las promesas pendientes (trabajo en segundo plano). */
const flush = () => new Promise((r) => setImmediate(r));

describe('AuthService', () => {
  beforeEach(() => compare.mockReset());

  describe('login', () => {
    it('emite tokens, guarda solo el hash del refresh y fija la única institución', async () => {
      compare.mockResolvedValue(true);
      const { service, refreshRepo, usersRepo, tokens } = setup();

      const result = await service.login({
        identifier: 'ana@colegio.co',
        password: 'x',
      });

      expect(result.tokens).toEqual({
        accessToken: 'jwt',
        refreshToken: 'raw-refresh',
      });
      expect(refreshRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          tokenHash: 'sha(raw-refresh)',
        }),
      );
      // El access token queda ligado a la sesión (id del refresh token).
      const [{ id: sessionId }] = refreshRepo.insert.mock.calls[0] as [
        { id: string },
      ];
      expect(tokens.signAccessToken).toHaveBeenCalledWith({
        sub: 'u1',
        institutionId: 'inst-1',
        sid: sessionId,
      });
      expect(result.session.activeInstitutionId).toBe('inst-1');
      expect(JSON.stringify(result.session)).not.toContain('hash');
      expect(usersRepo.update).toHaveBeenCalledWith('u1', {
        lastLoginAt: expect.any(Date) as Date,
      });
    });

    it('con varias instituciones deja la activa en null', async () => {
      compare.mockResolvedValue(true);
      const { service } = setup({
        memberships: [
          { id: 'a', name: 'A', role: 'TEACHER' },
          { id: 'b', name: 'B', role: 'TEACHER' },
        ],
      });
      const { session } = await service.login({
        identifier: 'ana@colegio.co',
        password: 'x',
      });
      expect(session.activeInstitutionId).toBeNull();
      expect(session.institutions).toHaveLength(2);
    });

    it('si el usuario no existe igual ejecuta bcrypt.compare y responde genérico', async () => {
      compare.mockResolvedValue(false);
      const { service, refreshRepo } = setup({ users: [] });
      await expect(
        service.login({ identifier: 'nadie@x.co', password: 'x' }),
      ).rejects.toThrow(new UnauthorizedException(INVALID_CREDENTIALS));
      expect(compare).toHaveBeenCalledTimes(1);
      expect(refreshRepo.insert).not.toHaveBeenCalled();
    });

    it('rechaza un usuario inactivo con el mismo mensaje', async () => {
      compare.mockResolvedValue(true);
      const { service } = setup({
        users: [{ ...activeUser, isActive: false }],
      });
      await expect(
        service.login({ identifier: 'ana@colegio.co', password: 'x' }),
      ).rejects.toThrow(INVALID_CREDENTIALS);
    });

    it('si el documento es ambiguo (varios usuarios) responde genérico', async () => {
      compare.mockResolvedValue(true);
      const { service } = setup({
        users: [activeUser, { ...activeUser, id: 'u2' }],
      });
      await expect(
        service.login({ identifier: '12345', password: 'x' }),
      ).rejects.toThrow(INVALID_CREDENTIALS);
    });
  });

  describe('refresh', () => {
    it('reutilizar un token revocado revoca todos los del usuario', async () => {
      const { service, refreshRepo } = setup();
      refreshRepo.findOne.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(service.refresh('raw', undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(refreshRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1' }),
        { revokedAt: expect.any(Date) as Date },
      );
    });

    it('rechaza un token vencido sin emitir uno nuevo', async () => {
      const { service, refreshRepo } = setup();
      refreshRepo.findOne.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1),
      });
      await expect(service.refresh('raw', undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(refreshRepo.insert).not.toHaveBeenCalled();
    });

    it('si la revocación atómica no afecta filas (carrera) lo trata como reutilización', async () => {
      const { service, refreshRepo } = setup();
      refreshRepo.findOne.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      refreshRepo.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.refresh('raw', undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(refreshRepo.insert).not.toHaveBeenCalled();
    });

    it('descarta la institución del token anterior si ya no pertenece a ella', async () => {
      const { service, refreshRepo, tokens } = setup({
        memberships: [
          { id: 'a', name: 'A', role: 'TEACHER' },
          { id: 'b', name: 'B', role: 'TEACHER' },
        ],
      });
      refreshRepo.findOne.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      tokens.verifyAccessToken.mockResolvedValue({
        sub: 'u1',
        institutionId: 'otra',
      });

      await service.refresh('raw', 'old-jwt');
      expect(tokens.signAccessToken).toHaveBeenCalledWith({
        sub: 'u1',
        institutionId: null,
        sid: expect.any(String) as string,
      });
    });

    it('rechaza si el usuario quedó inactivo, sin emitir tokens', async () => {
      const { service, refreshRepo, usersRepo } = setup();
      refreshRepo.findOne.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.refresh('raw', undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(refreshRepo.insert).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revoca solo la sesión del refresh token recibido', async () => {
      const { service, refreshRepo } = setup();
      await service.logout('raw');
      expect(refreshRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: 'sha(raw)' }),
        { revokedAt: expect.any(Date) as Date },
      );
    });

    it('sin cookie no hace nada', async () => {
      const { service, refreshRepo } = setup();
      await service.logout(undefined);
      expect(refreshRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    const authUser = { userId: 'u1', institutionId: 'inst-1', sessionId: 's1' };

    function withLockedUser(usersRepo: ReturnType<typeof setup>['usersRepo']) {
      usersRepo.createQueryBuilder.mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(activeUser),
      });
    }

    it('rechaza si la nueva es igual a la actual', async () => {
      const { service } = setup();
      await expect(
        service.changePassword(authUser as never, {
          currentPassword: 'Igual*2026xx',
          newPassword: 'Igual*2026xx',
        }),
      ).rejects.toThrow('distinta');
    });

    it('rechaza si la contraseña actual no coincide', async () => {
      compare.mockResolvedValue(false);
      const { service, usersRepo, refreshRepo } = setup();
      withLockedUser(usersRepo);
      await expect(
        service.changePassword(authUser as never, {
          currentPassword: 'Mala*2026xx',
          newPassword: 'Nueva*2026xx',
        }),
      ).rejects.toThrow('actual no es correcta');
      expect(refreshRepo.delete).not.toHaveBeenCalled();
    });

    it('actualiza el hash, cierra todas las sesiones y emite tokens nuevos', async () => {
      compare.mockResolvedValue(true);
      const { service, usersRepo, refreshRepo } = setup();
      withLockedUser(usersRepo);
      const tokens = await service.changePassword(authUser as never, {
        currentPassword: 'Vieja*2026xx',
        newPassword: 'Nueva*2026xx',
      });
      expect(usersRepo.update).toHaveBeenCalledWith('u1', {
        passwordHash: 'hash-falso',
        mustChangePassword: false,
      });
      // Las sesiones anteriores se eliminan antes de crear la nueva.
      expect(refreshRepo.delete).toHaveBeenCalledWith({ userId: 'u1' });
      expect(refreshRepo.delete.mock.invocationCallOrder[0]).toBeLessThan(
        refreshRepo.insert.mock.invocationCallOrder[0],
      );
      expect(tokens.refreshToken).toBe('raw-refresh');
    });
  });

  describe('forgotPassword', () => {
    it('responde sin esperar y no envía nada si el email no existe', async () => {
      const { service, usersRepo, mail } = setup();
      usersRepo.findOne.mockResolvedValue(null);
      expect(service.forgotPassword('nadie@x.co')).toBeUndefined();
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('crea un token (solo su hash) y envía el enlace con el token en el fragmento', async () => {
      const { service, resetRepo, mail } = setup();
      service.forgotPassword('ana@colegio.co');
      await flush();
      expect(resetRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          tokenHash: 'sha(raw-refresh)',
        }),
      );
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'ana@colegio.co',
          text: expect.stringContaining(
            'http://front/reset-password#token=raw-refresh',
          ) as string,
        }),
      );
    });

    it('no envía otro correo si hay una solicitud reciente (cooldown)', async () => {
      const { service, resetRepo, mail } = setup();
      resetRepo.exists.mockResolvedValue(true);
      service.forgotPassword('ana@colegio.co');
      await flush();
      expect(resetRepo.insert).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('rechaza un token inexistente, usado o vencido', async () => {
      const { service, resetRepo, usersRepo } = setup();
      resetRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resetPassword({ token: 'x', newPassword: 'Nueva*2026xx' }),
      ).rejects.toThrow('Token inválido o vencido');
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it('marca el token como usado, cambia la contraseña y cierra las sesiones', async () => {
      const { service, resetRepo, usersRepo, refreshRepo } = setup();
      resetRepo.findOne.mockResolvedValue({ id: 'r1', userId: 'u1' });
      await service.resetPassword({ token: 'x', newPassword: 'Nueva*2026xx' });
      expect(resetRepo.update).toHaveBeenCalledWith('r1', {
        usedAt: expect.any(Date) as Date,
      });
      expect(usersRepo.update).toHaveBeenCalledWith('u1', {
        passwordHash: 'hash-falso',
        mustChangePassword: false,
      });
      expect(refreshRepo.delete).toHaveBeenCalledWith({ userId: 'u1' });
    });
  });
});
