import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES } from './entities';

interface DbParams {
  url: string;
  ssl: boolean;
  /** CA de Supabase (PEM). Si se indica, se verifica el certificado del servidor. */
  ca?: string;
}

/** Con CA se verifica el certificado (obligatorio en producción); sin CA solo cifra. */
function sslOptions(ssl: boolean, ca?: string) {
  if (!ssl) return false;
  // Las variables de entorno suelen traer el PEM en una línea con "\n" literales.
  const pem = ca?.trim().replace(/\\n/g, '\n');
  return pem
    ? { ca: pem, rejectUnauthorized: true }
    : { rejectUnauthorized: false };
}

/**
 * Opciones comunes para la app y el CLI de migraciones.
 * synchronize siempre en false: el esquema solo cambia con migraciones.
 * Se conecta con el rol "postgres" de Supabase (se salta RLS).
 */
export function buildDataSourceOptions({
  url,
  ssl,
  ca,
}: DbParams): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    ssl: sslOptions(ssl, ca),
    entities: ALL_ENTITIES,
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'migrations',
    uuidExtension: 'uuid-ossp',
    synchronize: false,
    migrationsRun: false,
    logging: ['error'],
  };
}
