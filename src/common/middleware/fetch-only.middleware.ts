import { HttpStatus } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

export const FETCH_ONLY_MESSAGE = 'Solo se puede pedir desde la aplicación';

/**
 * Rutas que la aplicación solo pide con fetch (Fetch Metadata): rechaza con 403
 * lo que el navegador marca como de otro sitio, una navegación (un enlace o una
 * redirección, que con SameSite=Lax lleva las cookies) o una carga como recurso
 * (<img>, <iframe>...). Así nadie hace trabajar al servidor en nombre del
 * usuario desde otra página ni desde otro subdominio del mismo sitio. Sin las
 * cabeceras (clientes que no son navegador, navegadores antiguos) pasa.
 *
 * Es middleware (no guard) para correr antes del límite de peticiones: un
 * rechazo no gasta el cupo del usuario. B1 de la 3f-2 y de la 3g-1.
 */
export function fetchOnlyMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const site = req.headers['sec-fetch-site'];
    const mode = req.headers['sec-fetch-mode'];
    const dest = req.headers['sec-fetch-dest'];
    const rejected =
      site === 'cross-site' ||
      mode === 'navigate' ||
      (dest !== undefined && dest !== 'empty');
    if (!rejected) return next();
    res.status(HttpStatus.FORBIDDEN).json({
      statusCode: HttpStatus.FORBIDDEN,
      message: FETCH_ONLY_MESSAGE,
      error: HttpStatus[HttpStatus.FORBIDDEN],
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    });
  };
}
