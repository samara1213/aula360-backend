import { buildDataSourceOptions } from './typeorm.config';

describe('buildDataSourceOptions', () => {
  const base = { url: 'postgresql://u:p@localhost:5432/db', ssl: false };

  it('pasa el tope del pool y la espera máxima a pg', () => {
    const options = buildDataSourceOptions({
      ...base,
      pool: { max: 15, connectionTimeoutMs: 5000 },
    });
    expect(options.extra).toEqual({ max: 15, connectionTimeoutMillis: 5000 });
  });

  it('sin pool (CLI de migraciones) usa los valores de pg', () => {
    expect(buildDataSourceOptions(base).extra).toBeUndefined();
  });

  it('nunca sincroniza el esquema ni corre migraciones al arrancar', () => {
    const options = buildDataSourceOptions(base);
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
  });
});
