import 'dotenv/config';

/**
 * Base de datos de las e2e. E2E_DB_MODE es obligatorio (sin valor por defecto):
 * - "shared": usa DATABASE_URL (BD de desarrollo/pruebas con el seed). Sin
 *   TRUNCATE: cada prueba borra solo lo que creó y al inicio/fin se barren
 *   restos de corridas anteriores (usuarios e instituciones con prefijo E2E).
 * - "isolated": usa DATABASE_URL_TEST (obligatoria y distinta de DATABASE_URL).
 * Nunca corre si el .env es de producción.
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error('Las e2e no se ejecutan con NODE_ENV=production.');
}

const mode = process.env.E2E_DB_MODE?.trim();

if (mode === 'isolated') {
  const testUrl = process.env.DATABASE_URL_TEST?.trim();
  if (!testUrl) {
    throw new Error('E2E_DB_MODE=isolated requiere DATABASE_URL_TEST.');
  }
  if (testUrl === process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL.');
  }
  process.env.DATABASE_URL = testUrl;
} else if (mode !== 'shared') {
  throw new Error(
    'Defina E2E_DB_MODE en .env: "shared" (BD de pruebas actual) o "isolated" (DATABASE_URL_TEST).',
  );
}

process.env.NODE_ENV = 'test';
// Los límites de peticiones se desactivan en e2e; la prueba de rate limiting los reactiva.
process.env.THROTTLE_DISABLED = 'true';
