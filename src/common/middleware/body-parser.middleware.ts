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

/** Mismo formato que AllExceptionsFilter (estos middlewares corren antes de Nest). */
function sendError(
  req: Request,
  res: Response,
  status: number,
  message: string,
): void {
  res.status(status).json({
    statusCode: status,
    message,
    error: HttpStatus[status] ?? 'Error',
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
}

/**
 * La API solo recibe JSON (y multipart en las subidas, con Multer): un
 * formulario HTML de otro sitio responde 415 sin llegar a los handlers (B4 de
 * la fase 11e). Se llama urlencodedParser a propósito: Nest no registra su
 * propio parser de formularios si ya hay un middleware con ese nombre.
 */
function urlencodedParser(req: Request, res: Response, next: NextFunction) {
  if (req.is('application/x-www-form-urlencoded')) {
    sendError(req, res, HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'Use JSON');
    return;
  }
  next();
}

/**
 * Cuerpo de los informes de la CSP (sus tipos no son application/json):
 * solo en su ruta y con un tope propio; uno más grande responde 413 con el
 * manejador de errores de bodyParserMiddlewares.
 */
export function cspReportParser(
  types: string[],
  limit: number,
): RequestHandler {
  return express.json({ type: types, limit });
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
    urlencodedParser,
    (err: unknown, req: Request, res: Response, next: NextFunction): void => {
      const status = clientErrorStatus(err);
      if (!status) return next(err);
      sendError(req, res, status, 'Solicitud inválida');
    },
  ];
}
