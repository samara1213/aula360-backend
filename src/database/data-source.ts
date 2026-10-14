import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './typeorm.config';

/** DataSource para el CLI de TypeORM (migration:run / revert / generate). */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL no está definida');
}

export default new DataSource(
  buildDataSourceOptions({
    url,
    ssl: process.env.DB_SSL !== 'false',
    ca: process.env.DB_SSL_CA,
  }),
);
