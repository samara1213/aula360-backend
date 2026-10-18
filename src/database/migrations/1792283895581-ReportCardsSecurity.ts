import { MigrationInterface, QueryRunner } from 'typeorm';

const NEW_TABLES = ['performance_levels', 'report_card_templates'];

/**
 * Hallazgos A1 y B4 de la fase 10a (aprobados por el usuario):
 * - RLS en las tablas creadas por ReportCardsPhase10: InitialSchema solo lo
 *   activó en las que existían entonces, y Supabase expone "public" por su
 *   API REST con la clave anon. Sin políticas = se deniega todo a anon y
 *   authenticated; el backend conecta como postgres y no se ve afectado.
 *   Además se les quitan los permisos a esos roles (segunda barrera).
 * - Una plantilla con el mismo contenido no se repite en una institución.
 * No toca datos.
 */
export class ReportCardsSecurity1792283895581 implements MigrationInterface {
  name = 'ReportCardsSecurity1792283895581';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of NEW_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
    }
    // Los roles anon y authenticated solo existen en Supabase.
    await queryRunner.query(`
      DO $$
      DECLARE r TEXT;
      BEGIN
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.performance_levels, public.report_card_templates FROM %I', r);
          END IF;
        END LOOP;
      END $$`);
    await queryRunner.query(
      `ALTER TABLE "report_card_templates" ADD CONSTRAINT "report_card_templates_institution_id_content_sha256_key" UNIQUE ("institution_id", "content_sha256")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "report_card_templates" DROP CONSTRAINT "report_card_templates_institution_id_content_sha256_key"`,
    );
    // Los permisos revocados no se restauran: sin RLS quedarían expuestas.
    for (const table of NEW_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
      );
    }
  }
}
