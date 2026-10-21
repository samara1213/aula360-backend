import { ExecutionContext } from '@nestjs/common';
import { AuthController } from '../../modules/auth/auth.controller';
import { LOGIN_ACCOUNT_THROTTLE, REFRESH_TOKEN_THROTTLE } from './throttle';

/** El método del controller (con su metadata), sin separarlo del prototipo. */
const handler = (name: keyof AuthController) =>
  Object.getOwnPropertyDescriptor(AuthController.prototype, name)!
    .value as () => unknown;

function contextFor(handler: () => unknown): ExecutionContext {
  return { getHandler: () => handler } as unknown as ExecutionContext;
}

describe('LOGIN_ACCOUNT_THROTTLE (M3 de la fase 11e)', () => {
  const tracker = (identifier: unknown) =>
    (LOGIN_ACCOUNT_THROTTLE.getTracker as (r: object) => string)({
      body: { identifier },
    });
  const skip = (handler: () => unknown) =>
    (LOGIN_ACCOUNT_THROTTLE.skipIf as (c: ExecutionContext) => boolean)(
      contextFor(handler),
    );
  const previous = process.env.THROTTLE_DISABLED;

  afterEach(() => {
    process.env.THROTTLE_DISABLED = previous;
  });

  it('cuenta por identificador normalizado y sin guardarlo en claro', () => {
    const key = tracker('  Ana@Ejemplo.TEST ');
    expect(key).toBe(tracker('ana@ejemplo.test'));
    expect(key).not.toContain('ana');
    expect(key).not.toBe(tracker('otra@ejemplo.test'));
  });

  it('solo aplica al login', () => {
    process.env.THROTTLE_DISABLED = 'false';
    expect(skip(handler('login'))).toBe(false);
    expect(skip(handler('forgotPassword'))).toBe(true);
  });

  it('respeta THROTTLE_DISABLED de las e2e', () => {
    process.env.THROTTLE_DISABLED = 'true';
    expect(skip(handler('login'))).toBe(true);
  });
});

describe('REFRESH_TOKEN_THROTTLE (M4 de la fase 3a)', () => {
  const tracker = (req: object) =>
    (REFRESH_TOKEN_THROTTLE.getTracker as (r: object) => string)(req);
  const skip = (handler: () => unknown) =>
    (REFRESH_TOKEN_THROTTLE.skipIf as (c: ExecutionContext) => boolean)(
      contextFor(handler),
    );
  const previous = process.env.THROTTLE_DISABLED;

  afterEach(() => {
    process.env.THROTTLE_DISABLED = previous;
  });

  it('cuenta por refresh token (hash), no por IP', () => {
    const a = tracker({ ip: '1.1.1.1', cookies: { refresh_token: 'tok-a' } });
    expect(a).toBe(
      tracker({ ip: '2.2.2.2', cookies: { refresh_token: 'tok-a' } }),
    );
    expect(a).not.toContain('tok-a');
    expect(a).not.toBe(
      tracker({ ip: '1.1.1.1', cookies: { refresh_token: 'tok-b' } }),
    );
    expect(
      tracker({
        ip: '1.1.1.1',
        cookies: { '__Secure-refresh_token': 'tok-a' },
      }),
    ).toBe(a);
  });

  it('sin cookie cuenta por IP', () => {
    expect(tracker({ ip: '1.1.1.1', cookies: {} })).toBe('ip:1.1.1.1');
  });

  it('solo aplica a la renovación', () => {
    process.env.THROTTLE_DISABLED = 'false';
    expect(skip(handler('refresh'))).toBe(false);
    expect(skip(handler('login'))).toBe(true);
  });
});
