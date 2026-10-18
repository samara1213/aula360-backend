/** Límite global: 100 peticiones por minuto por IP. */
export const DEFAULT_THROTTLE = { ttl: 60_000, limit: 100 };

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
