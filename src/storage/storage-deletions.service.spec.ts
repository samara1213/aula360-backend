import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import {
  DISCARD_DELAY_SECONDS,
  MAX_ATTEMPTS,
  StorageDeletionsService,
} from './storage-deletions.service';
import { StorageService } from './storage.service';

const INST = '11111111-1111-4111-8111-111111111111';
const id = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const LOGO = `${INST}/logos/${id(1)}.png`;
const AVATAR = `users/${id(2)}/${id(3)}.png`;
const PDF = `${INST}/report-cards/${id(4)}.pdf`;

type Row = { id: string; bucket: string; path: string; attempts: number };

describe('StorageDeletionsService', () => {
  let claimed: Row[][];
  let used: string[];
  let exhausted: number;
  const calls: { sql: string; params: unknown[] }[] = [];
  const dataSource = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('WITH claimed')) {
        return Promise.resolve(claimed.shift() ?? []);
      }
      if (sql.includes('SELECT DISTINCT')) {
        const paths = params[0] as string[];
        return Promise.resolve(
          used.filter((p) => paths.includes(p)).map((path) => ({ path })),
        );
      }
      if (sql.includes('count(*)')) {
        return Promise.resolve([{ count: exhausted }]);
      }
      return Promise.resolve([]);
    }),
    manager: { query: jest.fn() },
  };
  const storage = { remove: jest.fn() };
  const config = { get: jest.fn() };
  let service: StorageDeletionsService;

  const executed = (fragment: string) =>
    calls.filter((c) => c.sql.includes(fragment));
  const row = (n: number, bucket: string, path: string, attempts = 1): Row => ({
    id: `d${n}`,
    bucket,
    path,
    attempts,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    claimed = [];
    used = [];
    exhausted = 0;
    storage.remove.mockResolvedValue(undefined);
    config.get.mockReturnValue(undefined);
    service = new StorageDeletionsService(
      dataSource as unknown as DataSource,
      storage as unknown as StorageService,
      config as unknown as ConfigService,
    );
  });

  it('schedule anota en la transacción recibida, sin duplicar', async () => {
    const manager = { query: jest.fn() };
    await service.schedule(manager as unknown as EntityManager, 'logos', LOGO);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (bucket, path) DO NOTHING'),
      ['logos', LOGO],
    );
  });

  it('flush borra ya y quita la fila', async () => {
    claimed = [[row(1, 'logos', LOGO)]];
    await service.flush('logos', LOGO);
    // Solo toma esa ruta.
    expect(executed('WITH claimed')[0].params.slice(3)).toEqual([
      'logos',
      LOGO,
    ]);
    expect(storage.remove).toHaveBeenCalledWith('logos', LOGO);
    expect(executed('DELETE FROM storage_deletions')[0].params).toEqual(['d1']);
  });

  it('si Storage falla, la fila queda con el código del error (nunca el mensaje)', async () => {
    claimed = [[row(1, 'avatars', AVATAR)]];
    storage.remove.mockRejectedValue(
      Object.assign(new Error('detalle interno'), { status: 503 }),
    );
    await expect(service.flush('avatars', AVATAR)).resolves.toBeUndefined();
    expect(executed('DELETE FROM storage_deletions')).toHaveLength(0);
    expect(executed('SET last_error')[0].params).toEqual(['d1', 'http_503']);
  });

  it('flush nunca lanza aunque la base falle', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('sin conexión'));
    await expect(service.flush('logos', LOGO)).resolves.toBeUndefined();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('no borra un archivo que una fila todavía usa: solo quita la anotación', async () => {
    claimed = [[row(1, 'report-cards', PDF)]];
    used = [PDF];
    await service.flush('report-cards', PDF);
    expect(executed('SELECT DISTINCT')[0].sql).toContain('report_cards');
    expect(storage.remove).not.toHaveBeenCalled();
    expect(executed('DELETE FROM storage_deletions')[0].params).toEqual(['d1']);
  });

  it('nunca borra una ruta con otra forma ni de un bucket desconocido (M1, B1)', async () => {
    claimed = [
      [
        row(1, 'logos', 'otra/cosa.png'),
        row(2, 'avatars', `${INST}/logos/${id(1)}.png`), // ruta de otro bucket
        row(3, 'desconocido', LOGO),
        row(4, 'logos', LOGO),
      ],
    ];
    await service.processDue();
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith('logos', LOGO);
    expect(executed('SET last_error').map((c) => c.params)).toEqual([
      ['d1', 'invalid_path'],
      ['d2', 'invalid_path'],
      ['d3', 'invalid_path'],
    ]);
  });

  it('discard anota con espera y no borra en el acto (M2)', async () => {
    await service.discard('logos', LOGO);
    expect(dataSource.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO storage_deletions'),
      ['logos', LOGO, DISCARD_DELAY_SECONDS],
    );
    expect(storage.remove).not.toHaveBeenCalled();
    expect(executed('WITH claimed')).toHaveLength(0);
  });

  it('discard sin base no lanza', async () => {
    dataSource.manager.query.mockRejectedValueOnce(new Error('sin conexión'));
    await expect(service.discard('logos', LOGO)).resolves.toBeUndefined();
  });

  it('processDue toma solo filas con intentos disponibles y con espera de 5 min a 24 h', async () => {
    claimed = [
      [row(1, 'logos', LOGO, 2), row(2, 'avatars', AVATAR, MAX_ATTEMPTS)],
    ];
    storage.remove
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('red'));
    await expect(service.processDue()).resolves.toEqual({
      deleted: 1,
      failed: 1,
    });
    const claim = executed('WITH claimed')[0];
    expect(claim.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim.params).toEqual([300, 86400, MAX_ATTEMPTS]);
    expect(executed('SET last_error')[0].params).toEqual(['d2', 'Error']);
  });

  it('con 5 fallos seguidos corta la pasada y devuelve el intento a las demás (M4)', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(i, 'logos', `${INST}/logos/${id(100 + i)}.png`),
    );
    claimed = [rows, rows];
    storage.remove.mockRejectedValue(new Error('caído'));
    await expect(service.processDue()).resolves.toEqual({
      deleted: 0,
      failed: 5,
    });
    // Una sola ronda aunque la tanda estaba llena.
    expect(executed('WITH claimed')).toHaveLength(1);
    const release = executed('attempts = attempts - 1')[0];
    expect(release.params[0]).toEqual(rows.slice(5).map((r) => r.id));
  });

  it('avisa en cada pasada si hay filas que agotaron los intentos (B3)', async () => {
    const error = jest.spyOn(service['logger'], 'error').mockImplementation();
    exhausted = 2;
    await service.processDue();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('2 borrados de Storage agotaron sus intentos'),
    );
  });

  it('no arranca el proceso periódico en test ni si está desactivado', () => {
    const spy = jest.spyOn(global, 'setInterval');
    config.get.mockImplementation((k: string) =>
      k === 'NODE_ENV' ? 'test' : undefined,
    );
    service.onApplicationBootstrap();
    config.get.mockImplementation((k: string) =>
      k === 'NODE_ENV' ? 'production' : k === 'STORAGE_DELETIONS_DISABLED',
    );
    service.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();

    config.get.mockImplementation((k: string) =>
      k === 'NODE_ENV' ? 'production' : false,
    );
    service.onApplicationBootstrap();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    service.onModuleDestroy();
    spy.mockRestore();
  });
});
