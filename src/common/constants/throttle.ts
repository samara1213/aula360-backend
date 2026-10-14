/** Límite global: 100 peticiones por minuto por IP. */
export const DEFAULT_THROTTLE = { ttl: 60_000, limit: 100 };

/**
 * Límite estricto para login y recuperación de contraseña.
 * Uso: @Throttle(STRICT_AUTH_THROTTLE)
 */
export const STRICT_AUTH_THROTTLE = { default: { ttl: 60_000, limit: 5 } };
