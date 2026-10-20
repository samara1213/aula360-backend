import { ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { createHash } from 'crypto';

/** Límite global: 100 peticiones por minuto por IP. */
export const DEFAULT_THROTTLE = { ttl: 60_000, limit: 100 };

const ACCOUNT_THROTTLE_KEY = 'accountThrottle';

/**
 * Login: además del límite por IP, 10 intentos cada 15 minutos por cuenta
 * (el identificador normalizado, guardado como hash), para que un ataque
 * repartido entre muchas IP no pruebe contraseñas sin freno (M3 de la fase
 * 11e). Solo cuenta en las rutas marcadas con @AccountThrottle().
 */
export const LOGIN_ACCOUNT_THROTTLE: ThrottlerOptions = {
  name: 'login-account',
  ttl: 15 * 60_000,
  limit: 10,
  getTracker: (req: Record<string, unknown>) => {
    const identifier = (req.body as { identifier?: unknown } | undefined)
      ?.identifier;
    const normalized =
      typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
    return `login:${createHash('sha256').update(normalized).digest('hex')}`;
  },
  // Este skipIf reemplaza al del módulo: repite el apagado de las e2e.
  skipIf: (context: ExecutionContext) =>
    process.env.THROTTLE_DISABLED === 'true' ||
    !Reflect.getMetadata(ACCOUNT_THROTTLE_KEY, context.getHandler()),
};

/** Aplica LOGIN_ACCOUNT_THROTTLE a la ruta. */
export const AccountThrottle = () => SetMetadata(ACCOUNT_THROTTLE_KEY, true);

/**
 * Límite estricto para login y recuperación de contraseña.
 * Uso: @Throttle(STRICT_AUTH_THROTTLE)
 */
export const STRICT_AUTH_THROTTLE = { default: { ttl: 60_000, limit: 5 } };

/**
 * Cuenta por usuario (por IP si aún no hay sesión), para no bloquear a todo un
 * colegio detrás de la misma IP.
 */
const perUserTracker = (req: Record<string, unknown>): string => {
  const user = req.user as { userId?: string } | undefined;
  return user?.userId ? `user:${user.userId}` : `ip:${String(req.ip)}`;
};

/**
 * Rutas con sesión que comprueban la contraseña actual (cambiar contraseña o
 * email): 5 por minuto por usuario. Con una sesión robada no se prueba la
 * contraseña desde muchas IP, y un colegio detrás de una sola IP no comparte
 * el límite (B2 de la fase 11b).
 * Uso: @Throttle(CURRENT_PASSWORD_THROTTLE)
 */
export const CURRENT_PASSWORD_THROTTLE = {
  default: { ttl: 60_000, limit: 5, getTracker: perUserTracker },
};

/**
 * Límite para subir o quitar archivos: 10 por minuto por usuario.
 * Uso: @Throttle(UPLOAD_THROTTLE)
 */
export const UPLOAD_THROTTLE = {
  default: { ttl: 60_000, limit: 10, getTracker: perUserTracker },
};

/**
 * Acciones administrativas sensibles (contraseñas temporales, activar o
 * desactivar usuarios): 10 por minuto por usuario.
 * Uso: @Throttle(SENSITIVE_ACTION_THROTTLE)
 */
export const SENSITIVE_ACTION_THROTTLE = {
  default: { ttl: 60_000, limit: 10, getTracker: perUserTracker },
};

/**
 * Listados de personas (docentes, estudiantes): 60 por minuto por usuario.
 * Frena la descarga masiva del padrón paginando.
 * Uso: @Throttle(PEOPLE_LIST_THROTTLE)
 */
export const PEOPLE_LIST_THROTTLE = {
  default: { ttl: 60_000, limit: 60, getTracker: perUserTracker },
};

/**
 * Registro de notas en lote: 30 por minuto por usuario.
 * Uso: @Throttle(SCORES_WRITE_THROTTLE)
 */
export const SCORES_WRITE_THROTTLE = {
  default: { ttl: 60_000, limit: 30, getTracker: perUserTracker },
};

/**
 * Generar un boletín (imprime un PDF con Chromium): 10 por minuto por usuario.
 * Uso: @Throttle(REPORT_CARD_GENERATE_THROTTLE)
 */
export const REPORT_CARD_GENERATE_THROTTLE = {
  default: { ttl: 60_000, limit: 10, getTracker: perUserTracker },
};

/**
 * Generación masiva de boletines (un curso entero): 3 por minuto por usuario.
 * Lo que de verdad la limita es que solo corre una por institución a la vez.
 * Uso: @Throttle(REPORT_CARD_BATCH_THROTTLE)
 */
export const REPORT_CARD_BATCH_THROTTLE = {
  default: { ttl: 60_000, limit: 3, getTracker: perUserTracker },
};
