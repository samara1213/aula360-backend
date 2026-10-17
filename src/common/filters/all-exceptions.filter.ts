import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

/** Códigos de error de Postgres que se traducen a respuestas HTTP. */
const PG_ERRORS: Record<string, { status: HttpStatus; message: string }> = {
  '23505': { status: HttpStatus.CONFLICT, message: 'El recurso ya existe' },
  '23503': {
    status: HttpStatus.CONFLICT,
    message: 'El recurso está relacionado con otros datos',
  },
  '23502': {
    status: HttpStatus.BAD_REQUEST,
    message: 'Falta un dato obligatorio',
  },
  '23514': {
    status: HttpStatus.BAD_REQUEST,
    message: 'Los datos no cumplen las reglas',
  },
  '22P02': {
    status: HttpStatus.BAD_REQUEST,
    message: 'Formato de dato inválido',
  },
  // Transacciones concurrentes que se bloquean entre sí: el cliente puede reintentar.
  '40P01': {
    status: HttpStatus.CONFLICT,
    message: 'Conflicto de concurrencia, intente de nuevo',
  },
  '40001': {
    status: HttpStatus.CONFLICT,
    message: 'Conflicto de concurrencia, intente de nuevo',
  },
};

/** Status 4xx de errores que no son HttpException (p. ej. body-parser), o null. */
function clientErrorStatus(exception: unknown): number | null {
  if (!exception || typeof exception !== 'object') return null;
  const { status, statusCode } = exception as {
    status?: unknown;
    statusCode?: unknown;
  };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 500
    ? value
    : null;
}

/**
 * Filtro global: respuestas con forma uniforme y sin detalles internos.
 * Los errores no controlados se registran en el log y se responden como 500 genérico.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Error interno del servidor';

    const clientStatus = clientErrorStatus(exception);

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ??
            exception.message);
      if (status >= 500) {
        this.logger.error(`HttpException ${status}`, exception.stack);
      }
    } else if (clientStatus) {
      // Errores de body-parser (JSON mal formado, cuerpo demasiado grande, etc.).
      status = clientStatus;
      message = 'Solicitud inválida';
    } else if (exception instanceof QueryFailedError) {
      const code = (exception as QueryFailedError & { code?: string }).code;
      const mapped = code ? PG_ERRORS[code] : undefined;
      if (mapped) {
        status = mapped.status;
        message = mapped.message;
      } else {
        this.logger.error(
          `Error de base de datos (${code ?? 'sin código'})`,
          exception.stack,
        );
      }
    } else {
      this.logger.error(
        'Error no controlado',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({
      statusCode: status,
      message,
      error: HttpStatus[status] ?? 'Error',
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
