/** Límite global: 100 peticiones por minuto por IP. */
export const DEFAULT_THROTTLE = { ttl: 60_000, limit: 100 };

/**
 * Límite estricto para login y recuperación de contraseña.
 * Uso: @Throttle(STRICT_AUTH_THROTTLE)
 */
export const STRICT_AUTH_THROTTLE = { default: { ttl: 60_000, limit: 5 } };

/**
 * Límite para subir o quitar archivos: 10 por minuto por usuario (por IP si
 * aún no hay sesión). Por usuario para no bloquear a todo un colegio detrás
 * de la misma IP. Uso: @Throttle(UPLOAD_THROTTLE)
 */
export const UPLOAD_THROTTLE = {
  default: {
    ttl: 60_000,
    limit: 10,
    getTracker: (req: Record<string, unknown>): string => {
      const user = req.user as { userId?: string } | undefined;
      return user?.userId ? `user:${user.userId}` : `ip:${String(req.ip)}`;
    },
  },
};
