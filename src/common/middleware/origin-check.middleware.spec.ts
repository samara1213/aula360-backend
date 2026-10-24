import { Request, Response } from 'express';
import { originCheckMiddleware } from './origin-check.middleware';

function run(method: string, headers: Record<string, string>, path = '/api/x') {
  const middleware = originCheckMiddleware(['http://localhost:5173'], {
    exemptPaths: ['/api/csp-reports'],
  });
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const next = jest.fn();
  middleware(
    { method, headers, path, originalUrl: path } as unknown as Request,
    { status } as unknown as Response,
    next,
  );
  return { next, status };
}

describe('originCheckMiddleware', () => {
  it('deja pasar métodos seguros desde cualquier origen', () => {
    expect(run('GET', { origin: 'https://evil.com' }).next).toHaveBeenCalled();
  });

  it('deja pasar POST desde un origen permitido', () => {
    expect(
      run('POST', { origin: 'http://localhost:5173' }).next,
    ).toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rechaza %s desde un origen no permitido',
    (method) => {
      const { next, status } = run(method, { origin: 'https://evil.com' });
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(403);
    },
  );

  it('usa el Referer si no hay Origin', () => {
    const { status } = run('POST', { referer: 'https://evil.com/form' });
    expect(status).toHaveBeenCalledWith(403);
    expect(
      run('POST', { referer: 'http://localhost:5173/login' }).next,
    ).toHaveBeenCalled();
  });

  it('rechaza un Origin malformado', () => {
    expect(run('POST', { origin: 'null' }).status).toHaveBeenCalledWith(403);
  });

  it('las rutas exentas (informes de la CSP) pasan con cualquier Origin; las demás no', () => {
    for (const origin of ['null', 'https://evil.com']) {
      expect(
        run('POST', { origin }, '/api/csp-reports').next,
      ).toHaveBeenCalled();
    }
    expect(
      run('POST', { origin: 'https://evil.com' }, '/api/csp-reports/x').status,
    ).toHaveBeenCalledWith(403);
  });

  it('deja pasar peticiones sin Origin ni Referer (clientes que no son navegador)', () => {
    expect(run('POST', {}).next).toHaveBeenCalled();
  });
});
