import { DataSource } from 'typeorm';
import { createTestApp, TestContext } from './utils/create-test-app';

/**
 * Supabase expone el esquema public por su API REST con la clave anon: toda
 * tabla debe tener RLS (sin políticas = se deniega todo). Una migración que
 * cree una tabla y lo olvide hace fallar esta prueba (hallazgo A1, fase 10a).
 */
describe('Base de datos (e2e)', () => {
  let ctx: TestContext;
  let dataSource: DataSource;

  beforeAll(async () => {
    ctx = await createTestApp();
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('todas las tablas de public tienen RLS', async () => {
    const rows = await dataSource.query<{ relname: string }[]>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind IN ('r', 'p') AND NOT relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('anon y authenticated no tienen permisos sobre las tablas de la fase 10', async () => {
    const rows = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('performance_levels', 'report_card_templates')
          AND grantee IN ('anon', 'authenticated')`,
    );
    expect(rows).toEqual([]);
  });
});
