import dataSource from '../data-source';
import { readSuperAdminFromEnv, runSeed } from './seed';

/** Uso: yarn seed (el SUPER_ADMIN se crea solo si SEED_SUPERADMIN_* está en .env). */
async function main() {
  const superAdmin = readSuperAdminFromEnv(process.env);
  if (!superAdmin) {
    console.warn(
      'Aviso: SEED_SUPERADMIN_* sin configurar; se omite la creación del SUPER_ADMIN.',
    );
  }
  await dataSource.initialize();
  try {
    const summary = await runSeed(dataSource, superAdmin);
    console.log('Seed completado:', summary);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: Error) => {
  console.error('Seed fallido:', error.message);
  process.exit(1);
});
