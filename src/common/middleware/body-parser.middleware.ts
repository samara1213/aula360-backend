import { HttpStatus } from '@nestjs/common';
import * as express from 'express';
import { NextFunction, Request, RequestHandler, Response } from 'express';

/** Status 4xx de un error de body-parser (JSON mal formado, cuerpo muy grande...), o null. */
function clientErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : null;
}

/**
 * Parsers de cuerpo registrados por la app (Nest no añade los suyos si ya existen)
 * seguidos de un manejador de errores: los errores de body-parser ocurren antes de
 * Nest, así que AllExceptionsFilter no los ve y Nest respondería con el mensaje
 * interno del parser. Aquí se responden con un mensaje genérico y el mismo formato.
 */
export function bodyParserMiddlewares(): [
  RequestHandler,
  RequestHandler,
  express.ErrorRequestHandler,
] {
  return [
    express.json(),
    express.urlencoded({ extended: true }),
    (err: unknown, req: Request, res: Response, next: NextFunction): void => {
      const status = clientErrorStatus(err);
      if (!status) return next(err);
      res.status(status).json({
        statusCode: status,
        message: 'Solicitud inválida',
        error: HttpStatus[status] ?? 'Error',
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
      });
    },
  ];
}
