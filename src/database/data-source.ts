import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './typeorm.config';

/** DataSource para el CLI de TypeORM (migration:run / revert / generate). */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL no está definida');
}
// El CLI no pasa por la validación del entorno: en producción exige SSL con
// el certificado del servidor verificado (B3 de la fase 11e).
if (
  process.env.NODE_ENV === 'production' &&
  (process.env.DB_SSL === 'false' || !process.env.DB_SSL_CA?.trim())
) {
  throw new Error(
    'En producción las migraciones exigen SSL y DB_SSL_CA (verificar el servidor)',
  );
}

export default new DataSource(
  buildDataSourceOptions({
    url,
    ssl: process.env.DB_SSL !== 'false',
    ca: process.env.DB_SSL_CA,
  }),
);
