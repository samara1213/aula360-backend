import { SqlRunner } from './storage-usage';
import {
  GRACE_MS,
  ObjectLister,
  SweepAbort,
  sweepOrphans,
} from './sweep-orphans';

const INST = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const F1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('sweepOrphans', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const old = new Date(now.getTime() - GRACE_MS - 1000).toISOString();
  const fresh = new Date(now.getTime() - 60_000).toISOString();

  /** Árbol de carpetas por bucket: carpeta -> entradas. */
  const tree: Record<
    string,
    Record<string, { name: string; id: string | null; created_at?: string }[]>
  > = {
    logos: {
      '': [{ name: INST, id: null }],
      [INST]: [{ name: 'logos', id: null }],
      [`${INST}/logos`]: [
        { name: `${F1}.png`, id: 'x', created_at: old }, // en uso
        { name: `${F2}.png`, id: 'x', created_at: old }, // huérfano
        { name: `${F3}.png`, id: 'x', created_at: fresh }, // reciente
      ],
    },
    avatars: {
      '': [
        { name: 'users', id: null },
        { name: '.emptyFolderPlaceholder', id: 'x', created_at: old },
      ],
      users: [{ name: USER, id: null }],
      [`users/${USER}`]: [{ name: `${F1}.webp`, id: 'x', created_at: old }],
    },
  };
  const lister: ObjectLister = {
    list: (bucket, prefix, offset, limit) =>
      Promise.resolve(
        (tree[bucket]?.[prefix] ?? []).slice(offset, offset + limit),
      ),
  };
  const inUse = [`${INST}/logos/${F1}.png`];
  /** Rutas que devuelve la muestra del control positivo, por tabla. */
  let sample: Record<string, string[]>;
  const db = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('IS NOT NULL')) {
        const table = /FROM (\w+)/.exec(sql)![1];
        return Promise.resolve((sample[table] ?? []).map((path) => ({ path })));
      }
      if (sql.includes('SELECT DISTINCT')) {
        return Promise.resolve(
          inUse
            .filter((p) => (params[0] as string[]).includes(p))
            .map((path) => ({ path })),
        );
      }
      return Promise.resolve(
        (params[1] as string[]).map((_, i) => ({ id: `q${i}` })),
      );
    }),
  };

  const runner = db as unknown as SqlRunner;

  beforeEach(() => {
    jest.clearAllMocks();
    sample = { institutions: inUse };
  });

  it('solo informa por defecto: huérfanos viejos, sin tocar recientes ni ajenos', async () => {
    const reports = await sweepOrphans(lister, runner, { apply: false, now });
    const logos = reports.find((r) => r.bucket === 'logos');
    expect(logos).toMatchObject({
      scanned: 3,
      recent: 1,
      ignored: 0,
      orphans: [`${INST}/logos/${F2}.png`],
      queued: 0,
    });
    const avatars = reports.find((r) => r.bucket === 'avatars');
    expect(avatars).toMatchObject({
      scanned: 2,
      ignored: 1, // .emptyFolderPlaceholder no lo creó el backend
      orphans: [`users/${USER}/${F1}.webp`],
    });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    );
  });

  it('con apply anota los huérfanos para que el backend los borre', async () => {
    const reports = await sweepOrphans(lister, runner, { apply: true, now });
    expect(reports.find((r) => r.bucket === 'logos')?.queued).toBe(1);
    const insert = db.query.mock.calls.find(
      ([sql, params]) => sql.includes('INSERT') && params[0] === 'logos',
    );
    expect(insert?.[0]).toContain('ON CONFLICT (bucket, path) DO NOTHING');
    expect(insert?.[1]).toEqual(['logos', [`${INST}/logos/${F2}.png`]]);
  });

  it('informa el control positivo: rutas en uso encontradas en Storage', async () => {
    const reports = await sweepOrphans(lister, runner, { apply: false, now });
    expect(reports.find((r) => r.bucket === 'logos')?.control).toEqual({
      sampled: 1,
      found: 1,
    });
  });

  it('con apply se niega si las rutas en uso no existen en Storage (otro entorno)', async () => {
    sample = { institutions: inUse, users: [`users/${USER}/${F2}.png`] };
    await expect(
      sweepOrphans(lister, runner, { apply: true, force: true, now }),
    ).rejects.toThrow(SweepAbort);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    );
  });

  it('con apply se niega si hay demasiados huérfanos, salvo con force', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `${F3.slice(0, -2)}${String(i).padStart(2, '0')}.png`,
      id: 'x',
      created_at: old,
    }));
    const crowded: ObjectLister = {
      list: (bucket, prefix, offset, limit) =>
        Promise.resolve(
          (bucket === 'logos' && prefix === `${INST}/logos`
            ? [...tree.logos[prefix], ...many]
            : (tree[bucket]?.[prefix] ?? [])
          ).slice(offset, offset + limit),
        ),
    };
    await expect(
      sweepOrphans(crowded, runner, { apply: true, now }),
    ).rejects.toThrow(/Demasiados huérfanos en logos/);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(
      false,
    );
    const reports = await sweepOrphans(crowded, runner, {
      apply: true,
      force: true,
      now,
    });
    expect(reports.find((r) => r.bucket === 'logos')?.queued).toBe(13);
  });

  it('compara cada bucket con su columna', async () => {
    await sweepOrphans(lister, runner, { apply: false, now });
    const sql = db.query.mock.calls.map(([s]) => s).join('\n');
    expect(sql).toContain('FROM institutions');
    expect(sql).toContain('FROM users');
  });
});
