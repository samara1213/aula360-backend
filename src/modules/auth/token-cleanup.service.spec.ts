import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  BATCH_SIZE,
  MAX_ROUNDS,
  RETENTION_DAYS,
  TOKEN_TABLES,
  TokenCleanupService,
} from './token-cleanup.service';

describe('TokenCleanupService', () => {
  /** Filas que borra cada DELETE, por tabla, en orden. */
  let counts: Record<string, number[]>;
  const calls: { sql: string; params: unknown[] }[] = [];
  const dataSource = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const table = TOKEN_TABLES.find((t) => sql.includes(`DELETE FROM ${t}`));
      return Promise.resolve([{ count: counts[table!]?.shift() ?? 0 }]);
    }),
  };
  const config = { get: jest.fn() };
  let service: TokenCleanupService;

  beforeEach(() => {
    counts = {};
    calls.length = 0;
    dataSource.query.mockClear();
    config.get.mockReset();
    service = new TokenCleanupService(
      dataSource as unknown as DataSource,
      config as unknown as ConfigService,
    );
  });

  it('borra en las tres tablas los vencidos hace más de 30 días', async () => {
    counts = { refresh_tokens: [3], email_verification_tokens: [1] };
    const log = jest.spyOn(service['logger'], 'log').mockImplementation();

    const result = await service.purgeExpired();

    expect(result).toEqual({
      refresh_tokens: 3,
      password_reset_tokens: 0,
      email_verification_tokens: 1,
    });
    expect(calls).toHaveLength(3);
    for (const [i, table] of TOKEN_TABLES.entries()) {
      expect(calls[i].sql).toContain(`DELETE FROM ${table}`);
      expect(calls[i].sql).toContain(
        `expires_at < CURRENT_TIMESTAMP - $1 * interval '1 day'`,
      );
      expect(calls[i].sql).toContain(`LIMIT ${BATCH_SIZE}`);
      expect(calls[i].sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(calls[i].params).toEqual([RETENTION_DAYS]);
    }
    expect(RETENTION_DAYS).toBe(30);
    expect(log).toHaveBeenCalledWith(
      'Tokens vencidos borrados: refresh_tokens=3, password_reset_tokens=0, email_verification_tokens=1',
    );
  });

  it('sin nada que borrar no escribe en el log', async () => {
    const log = jest.spyOn(service['logger'], 'log').mockImplementation();
    await service.purgeExpired();
    expect(log).not.toHaveBeenCalled();
  });

  it('repite el lote mientras venga lleno, con tope de rondas', async () => {
    counts = {
      refresh_tokens: [BATCH_SIZE, BATCH_SIZE, 5],
      password_reset_tokens: Array<number>(MAX_ROUNDS + 5).fill(BATCH_SIZE),
    };
    jest.spyOn(service['logger'], 'log').mockImplementation();

    const result = await service.purgeExpired();

    expect(result?.refresh_tokens).toBe(2 * BATCH_SIZE + 5);
    expect(result?.password_reset_tokens).toBe(MAX_ROUNDS * BATCH_SIZE);
    const resets = calls.filter((c) =>
      c.sql.includes('DELETE FROM password_reset_tokens'),
    );
    expect(resets).toHaveLength(MAX_ROUNDS);
  });

  it('un error no se propaga y solo registra el código', async () => {
    const failure = Object.assign(new Error('detalle interno user@x.co'), {
      code: '57014',
    });
    dataSource.query.mockRejectedValueOnce(failure);
    const error = jest.spyOn(service['logger'], 'error').mockImplementation();

    await expect(service.purgeExpired()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      'Falló la purga de tokens vencidos: 57014',
    );
    // Libera la bandera: la siguiente pasada corre.
    await expect(service.purgeExpired()).resolves.not.toBeNull();
  });

  it('un error con code no textual tampoco se propaga', async () => {
    dataSource.query.mockRejectedValueOnce({ code: 42 });
    const error = jest.spyOn(service['logger'], 'error').mockImplementation();

    await expect(service.purgeExpired()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith('Falló la purga de tokens vencidos: 42');

    dataSource.query.mockRejectedValueOnce({ code: { x: 1 } });
    await expect(service.purgeExpired()).resolves.toBeNull();
    expect(error).toHaveBeenLastCalledWith(
      'Falló la purga de tokens vencidos: Error',
    );
  });

  it('no cruza dos pasadas', async () => {
    let release!: () => void;
    dataSource.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ count: 0 }]);
        }),
    );
    const first = service.purgeExpired();
    await expect(service.purgeExpired()).resolves.toBeNull();
    release();
    await expect(first).resolves.not.toBeNull();
  });

  it('no arranca el proceso periódico en test ni si está desactivado', () => {
    const interval = jest.spyOn(global, 'setInterval');
    const timeout = jest.spyOn(global, 'setTimeout');
    config.get.mockImplementation((k: string) =>
      k === 'NODE_ENV' ? 'test' : undefined,
    );
    service.onApplicationBootstrap();
    config.get.mockImplementation((k: string) =>
      k === 'NODE_ENV' ? 'production' : k === 'TOKEN_CLEANUP_DISABLED',
    );
    service.onApplicationBootstrap();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();

    config.get.mockImplementation((k: string) =>
      k === 'NODE_ENV' ? 'production' : false,
    );
    service.onApplicationBootstrap();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(interval).toHaveBeenCalledWith(
      expect.any(Function),
      6 * 60 * 60_000,
    );
    service.onModuleDestroy();
    expect(service['timers']).toEqual([]);
    interval.mockRestore();
    timeout.mockRestore();
  });
});
