import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter } from './all-exceptions.filter';

function createHost() {
  const json = jest.fn<void, [{ message: string | string[] }]>();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/test' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function pgError(code: string): QueryFailedError {
  const driverError = Object.assign(new Error('detalle interno de postgres'), {
    code,
  });
  return new QueryFailedError('SELECT 1', [], driverError);
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  beforeAll(() =>
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  );
  afterAll(() => jest.restoreAllMocks());

  it('respeta el status y mensaje de las HttpException', () => {
    const { host, status, json } = createHost();
    filter.catch(new NotFoundException('Subject not found'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Subject not found',
        path: '/api/test',
      }),
    );
  });

  it('conserva la lista de errores de validación', () => {
    const { host, json } = createHost();
    filter.catch(new BadRequestException(['name must be a string']), host);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: ['name must be a string'] }),
    );
  });

  it.each([
    ['23505', 409],
    ['23503', 409],
    ['23514', 400],
    ['22P02', 400],
  ])(
    'traduce el error de Postgres %s a HTTP %i sin filtrar detalles',
    (code, expected) => {
      const { host, status, json } = createHost();
      filter.catch(pgError(code), host);
      expect(status).toHaveBeenCalledWith(expected);
      const body = json.mock.calls[0][0];
      expect(JSON.stringify(body)).not.toContain('detalle interno');
    },
  );

  it('responde 500 genérico ante errores no controlados', () => {
    const { host, status, json } = createHost();
    filter.catch(new Error('secreto: conexión a 10.0.0.1 falló'), host);
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe('Error interno del servidor');
    expect(JSON.stringify(body)).not.toContain('secreto');
  });

  it('errores 4xx de body-parser responden genérico y sin detalles', () => {
    const { host, status, json } = createHost();
    const parserError = Object.assign(
      new SyntaxError('Unexpected token } in JSON at position 12'),
      { status: 400, type: 'entity.parse.failed' },
    );
    filter.catch(parserError, host);
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe('Solicitud inválida');
    expect(JSON.stringify(body)).not.toContain('Unexpected token');
  });

  it('registra en el log las HttpException 5xx', () => {
    const spy = jest.spyOn(Logger.prototype, 'error');
    spy.mockClear();
    const { host, status } = createHost();
    filter.catch(new ServiceUnavailableException(), host);
    expect(status).toHaveBeenCalledWith(503);
    expect(spy).toHaveBeenCalled();
  });
});
