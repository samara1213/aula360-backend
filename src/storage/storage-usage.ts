import { BucketName } from './storage.constants';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Dónde guarda la base la ruta de cada bucket y qué forma tienen las rutas que
 * genera el backend. Un archivo que ninguna fila usa es huérfano; uno con otra
 * forma no lo creó el backend y nunca se borra.
 */
export const STORAGE_USAGE: Record<
  BucketName,
  { table: string; column: string; pattern: RegExp }
> = {
  avatars: {
    table: 'users',
    column: 'avatar_path',
    pattern: new RegExp(`^users/${UUID}/${UUID}\\.[a-z0-9]+$`),
  },
  logos: {
    table: 'institutions',
    column: 'logo_path',
    pattern: new RegExp(`^${UUID}/logos/${UUID}\\.[a-z0-9]+$`),
  },
  'report-cards': {
    table: 'report_cards',
    column: 'pdf_path',
    pattern: new RegExp(`^${UUID}/report-cards/${UUID}\\.pdf$`),
  },
  'report-templates': {
    table: 'report_card_templates',
    column: 'storage_path',
    pattern: new RegExp(`^${UUID}/report-templates/${UUID}\\.html$`),
  },
};

/** Ejecuta SQL con parámetros (EntityManager, DataSource o QueryRunner). */
export interface SqlRunner {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
}

/** De estas rutas del bucket, las que alguna fila todavía usa. */
export async function pathsInUse(
  db: SqlRunner,
  bucket: BucketName,
  paths: string[],
): Promise<Set<string>> {
  if (!paths.length) return new Set();
  // Tabla y columna salen de la constante, nunca del cliente.
  const { table, column } = STORAGE_USAGE[bucket];
  const rows = await db.query<{ path: string }[]>(
    `SELECT DISTINCT ${column} AS path FROM ${table}
      WHERE ${column} = ANY($1::text[])`,
    [paths],
  );
  return new Set(rows.map((r) => r.path));
}

/** Algunas rutas que la base usa en ese bucket (control positivo del barrido). */
export async function sampleUsedPaths(
  db: SqlRunner,
  bucket: BucketName,
  limit: number,
): Promise<string[]> {
  const { table, column } = STORAGE_USAGE[bucket];
  const rows = await db.query<{ path: string }[]>(
    `SELECT ${column} AS path FROM ${table}
      WHERE ${column} IS NOT NULL LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.path);
}
