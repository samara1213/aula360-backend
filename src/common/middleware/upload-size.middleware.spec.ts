import { Request, Response } from 'express';
import { uploadSizeMiddleware } from './upload-size.middleware';

function run(contentType: string, contentLength?: string) {
  const middleware = uploadSizeMiddleware(1000);
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const next = jest.fn();
  const headers: Record<string, string> = { 'content-type': contentType };
  if (contentLength !== undefined) headers['content-length'] = contentLength;
  middleware(
    {
      headers,
      originalUrl: '/api/x',
      is: (type: string) => (contentType.startsWith(type) ? type : false),
    } as unknown as Request,
    { status, setHeader } as unknown as Response,
    next,
  );
  return { next, status, setHeader };
}

describe('uploadSizeMiddleware', () => {
  it('deja pasar lo que no es multipart', () => {
    expect(run('application/json', '5000').next).toHaveBeenCalled();
  });

  it('deja pasar una subida dentro del límite', () => {
    expect(
      run('multipart/form-data; boundary=x', '1000').next,
    ).toHaveBeenCalled();
  });

  it('413 y cierra la conexión si Content-Length supera el límite', () => {
    const { next, status, setHeader } = run(
      'multipart/form-data; boundary=x',
      '1001',
    );
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(413);
    expect(setHeader).toHaveBeenCalledWith('Connection', 'close');
  });

  it('411 si no hay Content-Length o no es un número', () => {
    expect(run('multipart/form-data; boundary=x').status).toHaveBeenCalledWith(
      411,
    );
    expect(
      run('multipart/form-data; boundary=x', 'abc').status,
    ).toHaveBeenCalledWith(411);
  });
});
