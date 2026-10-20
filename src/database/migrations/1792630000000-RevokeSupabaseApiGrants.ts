import { MigrationInterface, QueryRunner } from 'typeorm';

/** Tablas del esquema inicial que tenían los permisos por defecto de Supabase. */
const INITIAL_TABLES = [
  'academic_years',
  'campuses',
  'courses',
  'enrollments',
  'evaluations',
  'grades',
  'institutions',
  'menu_options',
  'migrations',
  'password_reset_tokens',
  'periods',
  'refresh_tokens',
  'report_cards',
  'role_menu_permissions',
  'roles',
  'scores',
  'students',
  'subjects',
  'teacher_subject_courses',
  'teachers',
  'user_institution_roles',
  'users',
];

/** Ejecuta la sentencia para anon y authenticated (solo existen en Supabase). */
function forApiRoles(statement: string): string {
  return `
    DO $$
    DECLARE r TEXT;
    BEGIN
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('${statement}', r);
        END IF;
      END LOOP;
    END $$`;
}

/**
 * Tarea 2.11.3 (fase 11e, aprobada por el usuario): segunda barrera además de
 * RLS. Supabase da a anon y authenticated todos los permisos sobre las tablas
 * de public (incluido TRUNCATE, que RLS no frena) y los mismos por defecto
 * para las tablas nuevas. El backend conecta como postgres y no usa la API
 * REST de Supabase, así que se revocan todos y las tablas futuras nacen
 * cerradas (las migraciones ya no tienen que revocarlos una por una).
 * Las funciones que cree postgres tampoco se pueden ejecutar por defecto
 * (PUBLIC), para que una función nueva no quede expuesta por /rest/v1/rpc.
 * No toca a service_role ni los privilegios por defecto de supabase_admin.
 * El down devuelve los permisos que había.
 */
export class RevokeSupabaseApiGrants1792630000000 implements MigrationInterface {
  name = 'RevokeSupabaseApiGrants1792630000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      forApiRoles('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I'),
    );
    await queryRunner.query(
      forApiRoles('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I'),
    );
    for (const objects of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
      await queryRunner.query(
        forApiRoles(
          `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ${objects} FROM %I`,
        ),
      );
    }
    // EXECUTE de las funciones nuevas se da a PUBLIC (no a anon): es un
    // privilegio por defecto global, que no se quita con IN SCHEMA (B2 de la
    // revisión de la fase 11e).
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,
    );
    const tables = INITIAL_TABLES.map((t) => `public.${t}`).join(', ');
    await queryRunner.query(forApiRoles(`GRANT ALL ON TABLE ${tables} TO %I`));
    await queryRunner.query(
      forApiRoles('GRANT ALL ON SEQUENCE public.migrations_id_seq TO %I'),
    );
    for (const objects of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
      await queryRunner.query(
        forApiRoles(
          `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON ${objects} TO %I`,
        ),
      );
    }
  }
}
