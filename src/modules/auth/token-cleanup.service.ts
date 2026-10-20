import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/** Cada cuánto corre la purga; la primera pasada, poco después de arrancar. */
const INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;
/**
 * Días que se conserva un token después de vencer. Se cuenta desde
 * expires_at, así que cubre también los usados o revocados sea cual sea el
 * TTL (REFRESH_TOKEN_TTL_DAYS admite hasta 30). Mientras
 * se conserva, presentar un refresh revocado sigue cerrando todas las
 * sesiones del usuario (detección de reuso).
 */
export const RETENTION_DAYS = 30;
/** Filas por DELETE y rondas por tabla en cada pasada (sin bloqueos largos). */
export const BATCH_SIZE = 1000;
export const MAX_ROUNDS = 20;

/** Tablas fijas (nunca un valor externo en el SQL). */
export const TOKEN_TABLES = [
  'refresh_tokens',
  'password_reset_tokens',
  'email_verification_tokens',
] as const;

type TokenTable = (typeof TOKEN_TABLES)[number];

/** Código corto del error (nunca el mensaje: puede traer detalles internos). */
function errorCode(error: unknown): string {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  // Solo texto o número: un code de otro tipo no puede hacer lanzar al catch (B2).
  const value = [code, name].find(
    (v) => (typeof v === 'string' && v) || typeof v === 'number',
  ) as string | number | undefined;
  return String(value ?? 'Error').slice(0, 100);
}

/**
 * Purga de tokens vencidos (tarea 2.11.15): sin ella, refresh_tokens,
 * password_reset_tokens y email_verification_tokens crecen sin límite.
 * Borrar es idempotente: si corren varias instancias, no se pisan.
 */
@Injectable()
export class TokenCleanupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TokenCleanupService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // En e2e las pruebas llaman a purgeExpired directamente.
    if (
      this.config.get<string>('NODE_ENV') === 'test' ||
      this.config.get<boolean>('TOKEN_CLEANUP_DISABLED')
    ) {
      return;
    }
    // La primera pasada no espera 6 horas: con despliegues frecuentes nunca
    // llegaría a correr.
    const first = setTimeout(
      () => void this.purgeExpired(),
      FIRST_RUN_DELAY_MS,
    );
    const interval = setInterval(() => void this.purgeExpired(), INTERVAL_MS);
    first.unref();
    interval.unref();
    this.timers = [first, interval];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
  }

  /** Borra los tokens vencidos hace más de RETENTION_DAYS. Nunca lanza. */
  async purgeExpired(): Promise<Record<TokenTable, number> | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const deleted = {} as Record<TokenTable, number>;
      for (const table of TOKEN_TABLES) {
        deleted[table] = await this.purgeTable(table);
      }
      const total = Object.values(deleted).reduce((a, b) => a + b, 0);
      if (total > 0) {
        this.logger.log(
          `Tokens vencidos borrados: ${TOKEN_TABLES.map((t) => `${t}=${deleted[t]}`).join(', ')}`,
        );
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Falló la purga de tokens vencidos: ${errorCode(error)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * SKIP LOCKED: la purga nunca espera ni bloquea a una transacción de
   * autenticación que tenga filas del usuario (revocar todas sus sesiones),
   * ni a otra instancia purgando (B1 de la revisión de la tarea 2.11.15).
   */
  private async purgeTable(table: TokenTable): Promise<number> {
    let total = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const [{ count }] = await this.dataSource.query<{ count: number }[]>(
        `WITH deleted AS (
           DELETE FROM ${table}
            WHERE id IN (
                  SELECT id FROM ${table}
                   WHERE expires_at < CURRENT_TIMESTAMP - $1 * interval '1 day'
                   LIMIT ${BATCH_SIZE}
                     FOR UPDATE SKIP LOCKED)
           RETURNING 1)
         SELECT count(*)::int AS count FROM deleted`,
        [RETENTION_DAYS],
      );
      total += count;
      if (count < BATCH_SIZE) break;
    }
    return total;
  }
}
