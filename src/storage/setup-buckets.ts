import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { BucketConfig, BUCKETS } from './storage.constants';

/** Lo mínimo de la API de buckets de Supabase que usa el script. */
export interface BucketApi {
  getBucket(id: string): Promise<{
    data: {
      public: boolean;
      file_size_limit?: number | null;
      allowed_mime_types?: string[] | null;
    } | null;
    error: { message: string } | null;
  }>;
  createBucket(
    id: string,
    options: BucketConfig,
  ): Promise<{ error: { message: string } | null }>;
  updateBucket(
    id: string,
    options: BucketConfig,
  ): Promise<{ error: { message: string } | null }>;
}

type Outcome = 'creado' | 'actualizado' | 'sin cambios';

function sameConfig(
  current: NonNullable<Awaited<ReturnType<BucketApi['getBucket']>>['data']>,
  wanted: BucketConfig,
): boolean {
  const mimes = [...(current.allowed_mime_types ?? [])].sort().join(',');
  return (
    current.public === wanted.public &&
    current.file_size_limit === wanted.fileSizeLimit &&
    mimes === [...wanted.allowedMimeTypes].sort().join(',')
  );
}

/**
 * Crea los buckets que falten y ajusta la configuración (visibilidad, tamaño y
 * tipos) de los existentes. Se puede repetir; nunca borra buckets ni archivos.
 */
export async function setupBuckets(
  api: BucketApi,
): Promise<Record<string, Outcome>> {
  const result: Record<string, Outcome> = {};
  for (const [id, config] of Object.entries(BUCKETS)) {
    const { data } = await api.getBucket(id);
    if (!data) {
      const { error } = await api.createBucket(id, config);
      if (error) throw new Error(`No se pudo crear ${id}: ${error.message}`);
      result[id] = 'creado';
    } else if (!sameConfig(data, config)) {
      const { error } = await api.updateBucket(id, config);
      if (error) {
        throw new Error(`No se pudo actualizar ${id}: ${error.message}`);
      }
      result[id] = 'actualizado';
    } else {
      result[id] = 'sin cambios';
    }
  }
  return result;
}

/** Uso: yarn storage:setup (lee SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de .env). */
async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      'Configure SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env',
    );
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  console.log('Buckets:', await setupBuckets(client.storage));
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error('storage:setup fallido:', error.message);
    process.exit(1);
  });
}
