import { HttpStatus } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid';
  }
}

/**
 * Protección CSRF complementaria a SameSite=Lax: en métodos que modifican datos,
 * si la petición trae Origin (o, en su defecto, Referer) y no está en la lista
 * permitida, se rechaza con 403. Peticiones sin ninguna de las dos cabeceras
 * (clientes que no son navegador) pasan: sin cookies del navegador no hay CSRF.
 *
 * Es un middleware Express (app.use), por eso responde directamente con el mismo
 * formato que AllExceptionsFilter.
 */
export function originCheckMiddleware(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin =
      originOf(req.headers.origin) ?? originOf(req.headers.referer);
    if (origin && !allowed.has(origin)) {
      res.status(HttpStatus.FORBIDDEN).json({
        statusCode: HttpStatus.FORBIDDEN,
        message: 'Origen no permitido',
        error: HttpStatus[HttpStatus.FORBIDDEN],
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next();
  };
}
