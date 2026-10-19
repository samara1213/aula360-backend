import { BucketName } from '../../src/storage/storage.constants';
import { StorageDeletionsService } from '../../src/storage/storage-deletions.service';
import { TestContext } from './create-test-app';

export interface PendingDeletion {
  attempts: number;
  last_error: string | null;
  /** Segundos hasta el próximo intento. */
  wait: number;
}

/** La fila de storage_deletions de esa ruta, o null. */
export async function pendingDeletion(
  ctx: TestContext,
  bucket: BucketName,
  path: string,
): Promise<PendingDeletion | null> {
  const [row] = await ctx.dataSource.query<PendingDeletion[]>(
    `SELECT attempts, last_error,
            round(extract(epoch FROM next_attempt_at - CURRENT_TIMESTAMP))::int AS wait
       FROM storage_deletions WHERE bucket = $1 AND path = $2`,
    [bucket, path],
  );
  return row ?? null;
}

/**
 * Adelanta el próximo intento y reintenta solo esa ruta. No se usa
 * processDue: la base de pruebas es compartida y tomaría filas ajenas.
 * flush pasa por la misma toma (claim) y el mismo borrado que el proceso.
 */
export async function retryDeletion(
  ctx: TestContext,
  bucket: BucketName,
  path: string,
): Promise<void> {
  await ctx.dataSource.query(
    `UPDATE storage_deletions SET next_attempt_at = CURRENT_TIMESTAMP
      WHERE bucket = $1 AND path = $2`,
    [bucket, path],
  );
  await ctx.app.get(StorageDeletionsService).flush(bucket, path);
}
