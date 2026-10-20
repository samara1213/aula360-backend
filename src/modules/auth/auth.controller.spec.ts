import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { TokenService } from './token.service';

describe('AuthController.refresh', () => {
  const auth = { refresh: jest.fn() };
  const tokens = { secureCookies: false, refreshTtlMs: 60_000 };
  const controller = new AuthController(
    auth as unknown as AuthService,
    tokens as unknown as TokenService,
    {} as EmailVerificationService,
  );
  const req = { cookies: {} } as Request;
  const res = { clearCookie: jest.fn(), cookie: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('una sesión inválida (401) borra las cookies', async () => {
    auth.refresh.mockRejectedValue(new UnauthorizedException());
    await expect(
      controller.refresh(req, res as unknown as Response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
  });

  it('un fallo del servidor no cierra la sesión (M2 de la fase 11e)', async () => {
    auth.refresh.mockRejectedValue(new ServiceUnavailableException());
    await expect(
      controller.refresh(req, res as unknown as Response),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
});
