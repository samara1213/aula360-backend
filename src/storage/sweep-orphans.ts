import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { BucketName, BUCKETS } from './storage.constants';
import {
  pathsInUse,
  sampleUsedPaths,
  SqlRunner,
  STORAGE_USAGE,
} from './storage-usage';

/** Un archivo con menos de esto puede ser una subida en curso: no se toca. */
export const GRACE_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
/** Carpetas bajo la raíz del bucket (las rutas del backend usan dos). */
const MAX_DEPTH = 3;
/**
 * Con más huérfanos que esta fracción de lo revisado (y más de
 * MIN_SUSPICIOUS), --apply se niega salvo con --force: lo normal es que casi
 * nada sea huérfano, y muchos indican base y Storage de entornos distintos
 * (hallazgo M3 de la fase 11a).
 */
export const MAX_ORPHAN_RATIO = 0.2;
const MIN_SUSPICIOUS = 10;
/** Rutas en uso que se buscan en Storage como control positivo. */
const CONTROL_SAMPLE = 20;

/** Error propio del barrido: su mensaje sí se puede mostrar. */
export class SweepAbort extends Error {}

/** Lo mínimo de la API de Storage que usa el barrido. */
export interface ObjectLister {
  list(
    bucket: BucketName,
    prefix: string,
    offset: number,
    limit: number,
  ): Promise<{ name: string; id: string | null; created_at?: string | null }[]>;
}

export interface SweepReport {
  bucket: BucketName;
  /** Archivos encontrados. */
  scanned: number;
  /** Con forma desconocida (no los creó el backend): nunca se borran. */
  ignored: number;
  /** Más nuevos que el margen. */
  recent: number;
  /** Ninguna fila los usa. */
  orphans: string[];
  /** Anotados en storage_deletions (solo con apply). */
  queued: number;
  /**
   * Control positivo: de las rutas que la base usa (muestra), cuántas se
   * encontraron en Storage.
   */
  control: { sampled: number; found: number };
}

async function* walk(
  lister: ObjectLister,
  bucket: BucketName,
  prefix: string,
  depth: number,
): AsyncGenerator<{ path: string; createdAt: string | null | undefined }> {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await lister.list(bucket, prefix, offset, PAGE_SIZE);
    for (const item of page) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id !== null) {
        yield { path, createdAt: item.created_at };
      } else if (depth < MAX_DEPTH) {
        yield* walk(lister, bucket, path, depth + 1);
      }
    }
    if (page.length < PAGE_SIZE) return;
  }
}

/**
 * Busca archivos que ninguna fila usa (huérfanos de antes de la tarea 2.11.5
 * o de un proceso que se cayó entre la subida y el commit). Por defecto solo
 * informa; con apply los anota en storage_deletions y el backend los borra
 * (con la misma comprobación de uso justo antes de borrar). Antes de anotar
 * nada comprueba que la base y el Storage sean del mismo entorno: las rutas
 * en uso deben existir y los huérfanos no pueden ser demasiados (salvo force).
 */
export async function sweepOrphans(
  lister: ObjectLister,
  db: SqlRunner,
  options: { apply: boolean; force?: boolean; now?: Date },
): Promise<SweepReport[]> {
  const cutoff = (options.now ?? new Date()).getTime() - GRACE_MS;
  const reports: SweepReport[] = [];
  for (const bucket of Object.keys(BUCKETS) as BucketName[]) {
    const report: SweepReport = {
      bucket,
      scanned: 0,
      ignored: 0,
      recent: 0,
      orphans: [],
      queued: 0,
      control: { sampled: 0, found: 0 },
    };
    const seen = new Set<string>();
    let candidates: string[] = [];
    const check = async () => {
      const used = await pathsInUse(db, bucket, candidates);
      report.orphans.push(...candidates.filter((p) => !used.has(p)));
      candidates = [];
    };
    for await (const file of walk(lister, bucket, '', 0)) {
      report.scanned++;
      seen.add(file.path);
      if (!STORAGE_USAGE[bucket].pattern.test(file.path)) {
        report.ignored++;
        continue;
      }
      const created = file.createdAt ? Date.parse(file.createdAt) : NaN;
      if (!(created < cutoff)) {
        report.recent++; // sin fecha también: mejor no tocarlo
        continue;
      }
      candidates.push(file.path);
      if (candidates.length >= PAGE_SIZE) await check();
    }
    await check();
    const sample = await sampleUsedPaths(db, bucket, CONTROL_SAMPLE);
    report.control = {
      sampled: sample.length,
      found: sample.filter((p) => seen.has(p)).length,
    };
    reports.push(report);
  }
  if (!options.apply) return reports;

  const mismatched = reports.filter(
    (r) => r.control.sampled > 0 && r.control.found === 0,
  );
  if (mismatched.length) {
    throw new SweepAbort(
      `Ninguna ruta en uso existe en Storage (${mismatched.map((r) => r.bucket).join(', ')}): ` +
        '¿la base y el Storage son del mismo entorno? No se anotó nada.',
    );
  }
  const suspicious = reports.filter(
    (r) =>
      r.orphans.length > MIN_SUSPICIOUS &&
      r.orphans.length > (r.scanned - r.ignored) * MAX_ORPHAN_RATIO,
  );
  if (suspicious.length && !options.force) {
    throw new SweepAbort(
      `Demasiados huérfanos en ${suspicious.map((r) => r.bucket).join(', ')}: ` +
        'revise el informe y repita con --force si es correcto. No se anotó nada.',
    );
  }
  for (const report of reports) {
    if (!report.orphans.length) continue;
    const rows = await db.query<{ id: string }[]>(
      `INSERT INTO storage_deletions (bucket, path)
       SELECT $1, p FROM unnest($2::text[]) AS p
       ON CONFLICT (bucket, path) DO NOTHING
       RETURNING id`,
      [report.bucket, report.orphans],
    );
    report.queued = rows.length;
  }
  return reports;
}

/** Host de una URL, para mostrar a qué entorno apunta (sin credenciales). */
function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '(sin configurar)';
  } catch {
    return '(inválida)';
  }
}

/**
 * Uso: yarn storage:sweep (solo informa) o yarn storage:sweep --apply (anota
 * los huérfanos para que el backend los borre; --force si son muchos). Lee
 * DATABASE_URL, SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de .env.
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new SweepAbort(
      'Configure SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en .env',
    );
  }
  console.log(`Base: ${hostOf(process.env.DATABASE_URL)}`);
  console.log(`Storage: ${hostOf(url)}`);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const lister: ObjectLister = {
    async list(bucket, prefix, offset, limit) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) {
        throw new SweepAbort(`No se pudo listar ${bucket}/${prefix}`);
      }
      return data;
    },
  };
  const { default: dataSource } = await import('../database/data-source');
  await dataSource.initialize();
  try {
    const reports = await sweepOrphans(lister, dataSource, { apply, force });
    for (const r of reports) {
      console.log(
        `${r.bucket}: ${r.scanned} archivos, ${r.orphans.length} huérfanos, ` +
          `${r.recent} recientes, ${r.ignored} ignorados, ` +
          `control ${r.control.found}/${r.control.sampled}` +
          (apply ? `, ${r.queued} anotados` : ''),
      );
      for (const path of r.orphans) console.log(`  ${r.bucket}/${path}`);
    }
    if (!apply) console.log('Solo informe: use --apply para borrarlos.');
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Solo los mensajes propios: los de pg pueden traer host y usuario (B5).
    const { code, name } = error as { code?: string; name?: string };
    console.error(
      'storage:sweep fallido:',
      error instanceof SweepAbort ? error.message : (code ?? name ?? 'Error'),
    );
    process.exit(1);
  });
}
