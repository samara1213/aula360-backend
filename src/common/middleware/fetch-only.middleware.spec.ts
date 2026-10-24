import { Request, Response } from 'express';
import { fetchOnlyMiddleware } from './fetch-only.middleware';

function run(headers: Record<string, string>) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const next = jest.fn();
  fetchOnlyMiddleware()(
    { headers, originalUrl: '/api/x' } as unknown as Request,
    { status } as unknown as Response,
    next,
  );
  return { next, status };
}

describe('fetchOnlyMiddleware', () => {
  it('deja pasar el fetch de la aplicación', () => {
    const { next } = run({
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    });
    expect(next).toHaveBeenCalled();
  });

  it('deja pasar sin cabeceras (clientes que no son navegador)', () => {
    expect(run({}).next).toHaveBeenCalled();
  });

  it.each([
    [
      'otro sitio',
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
    ],
    [
      'una navegación desde otro subdominio',
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
    ],
    [
      'una navegación del mismo origen',
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
    ],
    [
      'una carga como imagen',
      {
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
      },
    ],
  ])('rechaza con 403 %s', (_name, headers) => {
    const { next, status } = run(headers);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
