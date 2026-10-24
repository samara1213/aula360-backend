import 'dotenv/config';

/**
 * Base de datos de las e2e. E2E_DB_MODE es obligatorio (sin valor por defecto):
 * - "shared": usa DATABASE_URL (BD de desarrollo/pruebas con el seed). Sin
 *   TRUNCATE: cada prueba borra solo lo que creó y al inicio/fin se barren
 *   restos de corridas anteriores (usuarios e instituciones con prefijo E2E).
 * - "isolated": usa DATABASE_URL_TEST (obligatoria y distinta de DATABASE_URL),
 *   por ejemplo un Postgres local (ver el README). DB_SSL_TEST, si está, reemplaza
 *   a DB_SSL (el Postgres local no usa SSL).
 * Nunca corre si el .env es de producción.
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error('Las e2e no se ejecutan con NODE_ENV=production.');
}

/**
 * La misma base aunque el texto difiera (otro usuario, sslmode, barra final o
 * mayúsculas en el host). Puertos distintos del mismo host también cuentan
 * como la misma: en Supabase, 5432 (directa) y 6543 (pooler) son la misma base.
 */
function sameDatabase(a: string, b: string | undefined): boolean {
  if (!b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    const name = (u: URL) => decodeURIComponent(u.pathname.replace(/\/+$/, ''));
    return (
      x.hostname.toLowerCase() === y.hostname.toLowerCase() &&
      name(x) === name(y)
    );
  } catch {
    return a === b;
  }
}

const mode = process.env.E2E_DB_MODE?.trim();

if (mode === 'isolated') {
  const testUrl = process.env.DATABASE_URL_TEST?.trim();
  if (!testUrl) {
    throw new Error('E2E_DB_MODE=isolated requiere DATABASE_URL_TEST.');
  }
  if (sameDatabase(testUrl, process.env.DATABASE_URL?.trim())) {
    throw new Error(
      'DATABASE_URL_TEST no puede apuntar a la misma base que DATABASE_URL.',
    );
  }
  process.env.DATABASE_URL = testUrl;
  const testSsl = process.env.DB_SSL_TEST?.trim();
  if (testSsl) {
    if (testSsl !== 'true' && testSsl !== 'false') {
      throw new Error('DB_SSL_TEST debe ser true o false.');
    }
    process.env.DB_SSL = testSsl;
  }
} else if (mode !== 'shared') {
  throw new Error(
    'Defina E2E_DB_MODE en .env: "shared" (BD de pruebas actual) o "isolated" (DATABASE_URL_TEST).',
  );
}

process.env.NODE_ENV = 'test';
// Los límites de peticiones se desactivan en e2e; la prueba de rate limiting los reactiva.
process.env.THROTTLE_DISABLED = 'true';
