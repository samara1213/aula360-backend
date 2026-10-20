import { DataSource } from 'typeorm';
import { createTestApp, TestContext } from './utils/create-test-app';

/**
 * Supabase expone el esquema public por su API REST con la clave anon: toda
 * tabla debe tener RLS (sin políticas = se deniega todo). Una migración que
 * cree una tabla y lo olvide hace fallar esta prueba (hallazgo A1, fase 10a).
 * Además, anon y authenticated no tienen permisos (segunda barrera, fase 11e).
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

  // Migración RevokeSupabaseApiGrants: ningún permiso en tablas ni secuencias,
  // y lo que cree postgres después nace cerrado.
  it('anon y authenticated no tienen permisos en public, ni por defecto', async () => {
    const roles = await dataSource.query<{ rolname: string }[]>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
    );
    if (!roles.length) return; // Postgres sin Supabase: no hay API REST.

    // Privilegios efectivos (también los heredados de PUBLIC) sobre tablas,
    // vistas, vistas materializadas, tablas foráneas y secuencias.
    const relations = await dataSource.query<{ name: string }[]>(
      `SELECT r.rolname || ' ' || c.relname AS name
         FROM pg_class c
         CROSS JOIN pg_roles r
        WHERE c.relnamespace = 'public'::regnamespace
          AND r.rolname IN ('anon', 'authenticated')
          AND (
            (c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(
              r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
            OR (c.relkind = 'S' AND has_sequence_privilege(r.oid, c.oid, 'USAGE, SELECT, UPDATE'))
          )`,
    );
    expect(relations.map((r) => r.name)).toEqual([]);

    // Funciones propias de public (las de extensiones como citext quedan fuera).
    const functions = await dataSource.query<{ name: string }[]>(
      `SELECT r.rolname || ' ' || p.proname AS name
         FROM pg_proc p
         CROSS JOIN pg_roles r
        WHERE p.pronamespace = 'public'::regnamespace
          AND r.rolname IN ('anon', 'authenticated')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.classid = 'pg_proc'::regclass
                             AND d.objid = p.oid AND d.deptype = 'e')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')`,
    );
    expect(functions.map((f) => f.name)).toEqual([]);

    // Lo que cree postgres después nace cerrado: ni anon ni authenticated en
    // public, y sin EXECUTE para PUBLIC en las funciones (global).
    const defaults = await dataSource.query<
      { schema: string | null; type: string; acl: string }[]
    >(
      `SELECT nullif(defaclnamespace, 0)::regnamespace::text AS schema,
              defaclobjtype AS type, defaclacl::text AS acl
         FROM pg_default_acl
        WHERE defaclrole = 'postgres'::regrole
          AND defaclnamespace IN (0, 'public'::regnamespace)`,
    );
    for (const { acl } of defaults.filter((d) => d.schema === 'public')) {
      expect(acl).not.toMatch(/\b(anon|authenticated)=/);
    }
    const globalFunctions = defaults.find(
      (d) => d.schema === null && d.type === 'f',
    );
    expect(globalFunctions?.acl).toBeDefined();
    expect(globalFunctions?.acl).not.toMatch(/[{,]=X/);
  });
});
