import { HttpStatus } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * Rechaza las subidas (multipart/form-data) demasiado grandes antes de leer el
 * cuerpo. Multer corta al pasar del límite, pero sigue leyendo el resto del
 * cuerpo; aquí se responde con la conexión cerrada sin leerlo:
 * - Content-Length mayor que el máximo: 413.
 * - Sin Content-Length (envío por trozos): 411; los navegadores siempre lo envían.
 *
 * Es una barrera adicional: en producción también conviene limitar el cuerpo
 * en el proxy inverso.
 */
export function uploadSizeMiddleware(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.is('multipart/form-data')) return next();
    const raw = req.headers['content-length'];
    const length = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(length) && length <= maxBytes) return next();

    const status = Number.isFinite(length)
      ? HttpStatus.PAYLOAD_TOO_LARGE
      : HttpStatus.LENGTH_REQUIRED;
    res.setHeader('Connection', 'close');
    res.status(status).json({
      statusCode: status,
      message:
        status === HttpStatus.PAYLOAD_TOO_LARGE
          ? 'El archivo supera el tamaño máximo'
          : 'Falta la cabecera Content-Length',
      error: HttpStatus[status],
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    });
  };
}
