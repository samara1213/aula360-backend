import { ExecutionContext } from '@nestjs/common';
import { AuthController } from '../../modules/auth/auth.controller';
import { LOGIN_ACCOUNT_THROTTLE } from './throttle';

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
