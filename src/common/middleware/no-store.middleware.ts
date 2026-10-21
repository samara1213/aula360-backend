import { NextFunction, Request, Response } from 'express';

/**
 * Cache-Control: no-store en todas las respuestas de la API: traen datos
 * personales (también de menores) y URLs firmadas, y no deben quedar en la
 * caché de disco de un equipo compartido (B6 de la fase 3a). Una ruta puede
 * fijar otro valor con @Header, que se aplica después.
 */
export function noStoreMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
