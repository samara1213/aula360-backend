import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { BucketName } from './storage.constants';
import { StorageService } from './storage.service';
import { pathsInUse, STORAGE_USAGE } from './storage-usage';

/** Cada cuánto corre el proceso de reintentos. */
const INTERVAL_MS = 5 * 60_000;
/** Filas que toma cada ronda; varias rondas por pasada como máximo. */
const BATCH_SIZE = 50;
const MAX_ROUNDS = 10;
/** Espera tras el intento n: 5 min · 2^(n-1), con tope de 24 h. */
const BASE_DELAY_SECONDS = 5 * 60;
const MAX_DELAY_SECONDS = 24 * 60 * 60;
/** Después de estos intentos la fila se conserva para revisarla a mano. */
export const MAX_ATTEMPTS = 10;
/** Fallos seguidos que cortan la pasada: Storage está caído (M4). */
const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * Un archivo descartado se borra pasado este tiempo, cuando la transacción
 * dudosa ya terminó (hallazgo M2 de la fase 11a).
 */
export const DISCARD_DELAY_SECONDS = 10 * 60;

interface ClaimedRow {
  id: string;
  bucket: BucketName;
  path: string;
  attempts: number;
}

/** Código corto del error (nunca el mensaje: puede traer detalles internos). */
function errorCode(error: unknown): string {
  const { status, statusCode, name } = (error ?? {}) as {
    status?: number;
    statusCode?: string;
    name?: string;
  };
  const code = status ?? statusCode;
  return (code ? `http_${code}` : name || 'Error').slice(0, 100);
}

/**
 * Borrados de Storage que no se pierden (tarea 2.11.5). Quien deja de usar
 * una ruta la anota con `schedule` dentro de su transacción y, después del
 * commit, llama a `flush`: el caso normal borra enseguida. Si Supabase falla,
 * la fila queda y el proceso periódico la reintenta con espera creciente.
 * Nunca borra un archivo que alguna fila todavía usa.
 */
@Injectable()
export class StorageDeletionsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StorageDeletionsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // En e2e las pruebas llaman a processDue directamente.
    if (
      this.config.get<string>('NODE_ENV') === 'test' ||
      this.config.get<boolean>('STORAGE_DELETIONS_DISABLED')
    ) {
      return;
    }
    this.timer = setInterval(() => void this.processDue(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Anota el borrado dentro de la transacción que deja de usar la ruta. */
  async schedule(
    manager: EntityManager,
    bucket: BucketName,
    path: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO storage_deletions (bucket, path) VALUES ($1, $2)
       ON CONFLICT (bucket, path) DO NOTHING`,
      [bucket, path],
    );
  }

  /** Después del commit: intenta el borrado ya. Nunca lanza. */
  async flush(bucket: BucketName, path: string): Promise<void> {
    try {
      await this.run(
        await this.claim('AND bucket = $4 AND path = $5', [bucket, path]),
      );
    } catch (error) {
      // La fila sigue anotada: el proceso periódico la reintentará.
      this.logger.warn(
        `Borrado de ${bucket}/${path} aplazado: ${errorCode(error)}`,
      );
    }
  }

  /**
   * Un archivo recién subido cuya transacción falló: se anota en una
   * transacción propia para dentro de unos minutos, sin intentarlo ya. Si el
   * COMMIT sigue en curso cuando se pierde la respuesta (hallazgo M2 de la
   * fase 11a), la fila todavía no se ve; cuando el proceso lo tome, ya se
   * verá y el archivo no se borrará (hallazgo B3 de la fase 10b). Sin base no
   * se anota: el barrido de huérfanos lo encontrará.
   */
  async discard(bucket: BucketName, path: string): Promise<void> {
    try {
      await this.dataSource.manager.query(
        `INSERT INTO storage_deletions (bucket, path, next_attempt_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP + $3 * interval '1 second')
         ON CONFLICT (bucket, path) DO NOTHING`,
        [bucket, path, DISCARD_DELAY_SECONDS],
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo anotar el borrado de ${bucket}/${path}: ${errorCode(error)}`,
      );
    }
  }

  /**
   * Reintenta los borrados que ya tocan. Devuelve cuántos se resolvieron. Si
   * algo falla, no sigue con otra ronda: Storage probablemente está caído y
   * se gastarían intentos sin necesidad (hallazgo M4 de la fase 11a).
   */
  async processDue(): Promise<{ deleted: number; failed: number }> {
    const total = { deleted: 0, failed: 0 };
    if (this.running) return total;
    this.running = true;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const rows = await this.claim('', []);
        const { deleted, failed } = await this.run(rows);
        total.deleted += deleted;
        total.failed += failed;
        if (failed > 0 || rows.length < BATCH_SIZE) break;
      }
      await this.reportExhausted();
    } catch (error) {
      this.logger.error(
        `Fallo el proceso de borrados pendientes: ${errorCode(error)}`,
      );
    } finally {
      this.running = false;
    }
    return total;
  }

  /** Aviso en cada pasada mientras queden filas sin intentos (B3). */
  private async reportExhausted(): Promise<void> {
    const [{ count }] = await this.dataSource.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM storage_deletions WHERE attempts >= $1`,
      [MAX_ATTEMPTS],
    );
    if (count > 0) {
      this.logger.error(
        `${count} borrados de Storage agotaron sus intentos: revisar storage_deletions`,
      );
    }
  }

  /**
   * Toma las filas que tocan y empuja su próximo intento antes de llamar a
   * Supabase: sin bloqueos ni conexiones ocupadas mientras se espera la red,
   * y otra instancia no las toma (SKIP LOCKED). Si el proceso se cae, la fila
   * vuelve cuando vence la espera.
   */
  private async claim(
    filter: string,
    params: unknown[],
  ): Promise<ClaimedRow[]> {
    return this.dataSource.query<ClaimedRow[]>(
      `WITH claimed AS (
         UPDATE storage_deletions d
            SET attempts = d.attempts + 1,
                next_attempt_at = CURRENT_TIMESTAMP
                  + LEAST($1 * power(2, d.attempts), $2) * interval '1 second',
                updated_at = CURRENT_TIMESTAMP
          WHERE d.id IN (
                SELECT id FROM storage_deletions
                 WHERE next_attempt_at <= CURRENT_TIMESTAMP
                   AND attempts < $3 ${filter}
                 ORDER BY next_attempt_at
                 LIMIT ${BATCH_SIZE}
                   FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.bucket, d.path, d.attempts)
       SELECT * FROM claimed`,
      [BASE_DELAY_SECONDS, MAX_DELAY_SECONDS, MAX_ATTEMPTS, ...params],
    );
  }

  private async run(
    rows: ClaimedRow[],
  ): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    // Solo rutas con la forma que genera el backend, en un bucket conocido
    // (hallazgos M1 y B1 de la fase 11a): una fila metida a mano o por un
    // error nunca borra otra cosa.
    const valid = rows.filter((r) =>
      STORAGE_USAGE[r.bucket]?.pattern.test(r.path),
    );
    for (const row of rows) {
      if (valid.includes(row)) continue;
      this.logger.error(`Borrado pendiente con ruta inválida: ${row.id}`);
      await this.fail(row, 'invalid_path');
    }
    const inUse = new Map<BucketName, Set<string>>();
    for (const bucket of new Set(valid.map((r) => r.bucket))) {
      const paths = valid.filter((r) => r.bucket === bucket).map((r) => r.path);
      inUse.set(bucket, await pathsInUse(this.dataSource, bucket, paths));
    }
    let consecutiveFailures = 0;
    for (const [index, row] of valid.entries()) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Storage no responde: las demás no gastan este intento.
        await this.release(valid.slice(index));
        break;
      }
      if (inUse.get(row.bucket)?.has(row.path)) {
        this.logger.warn(`No se borra ${row.bucket}/${row.path}: está en uso`);
        await this.forget(row.id);
        continue;
      }
      try {
        await this.storage.remove(row.bucket, row.path);
      } catch (error) {
        failed++;
        consecutiveFailures++;
        this.logger.warn(
          `Borrado de ${row.bucket}/${row.path} aplazado (intento ${row.attempts}): ${errorCode(error)}`,
        );
        await this.fail(row, errorCode(error));
        continue;
      }
      consecutiveFailures = 0;
      await this.forget(row.id);
      deleted++;
    }
    return { deleted, failed };
  }

  private async fail(row: ClaimedRow, code: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE storage_deletions SET last_error = $2 WHERE id = $1`,
      [row.id, code],
    );
    if (row.attempts >= MAX_ATTEMPTS) {
      this.logger.error(
        `No se pudo borrar ${row.bucket}/${row.path} tras ${row.attempts} intentos: revisar a mano`,
      );
    }
  }

  /** Devuelve el intento a filas tomadas que no se llegaron a intentar. */
  private async release(rows: ClaimedRow[]): Promise<void> {
    await this.dataSource.query(
      `UPDATE storage_deletions SET attempts = attempts - 1
        WHERE id = ANY($1::uuid[]) AND attempts > 0`,
      [rows.map((r) => r.id)],
    );
  }

  private async forget(id: string): Promise<void> {
    await this.dataSource.query(`DELETE FROM storage_deletions WHERE id = $1`, [
      id,
    ]);
  }
}
