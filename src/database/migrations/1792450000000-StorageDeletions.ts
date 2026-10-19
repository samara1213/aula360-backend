import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tarea 2.11.5 (hallazgo B1 de la fase 6, aprobada por el usuario): borrados
 * pendientes de Storage. Se anotan en la misma transacción que deja de usar
 * la ruta y un proceso periódico los reintenta, así un fallo de Supabase ya no
 * deja archivos huérfanos. Sin FK: la ruta ya no apunta a ninguna fila.
 *
 * Como toda tabla de public (hallazgo A1 de la fase 11a): RLS sin políticas
 * y sin permisos para anon y authenticated, porque Supabase la expone por su
 * API REST. El backend conecta como postgres y no se ve afectado.
 *
 * Además quita idx_report_card_templates_institution: el UNIQUE
 * (institution_id, content_sha256) empieza por institution_id y ya lo cubre.
 * No borra datos; el down lo vuelve a crear.
 *
 * El down borra la tabla con sus borrados pendientes: esos archivos quedan
 * huérfanos hasta que yarn storage:sweep los encuentre.
 */
export class StorageDeletions1792450000000 implements MigrationInterface {
  name = 'StorageDeletions1792450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "storage_deletions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "bucket" varchar(50) NOT NULL,
        "path" varchar(500) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "last_error" varchar(100),
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "storage_deletions_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "storage_deletions_bucket_path_key" UNIQUE ("bucket", "path"),
        CONSTRAINT "chk_storage_deletions_bucket"
          CHECK (bucket IN ('avatars', 'logos', 'report-cards', 'report-templates')),
        CONSTRAINT "chk_storage_deletions_attempts" CHECK (attempts >= 0)
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_storage_deletions_next_attempt" ON "storage_deletions" ("next_attempt_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_deletions" ENABLE ROW LEVEL SECURITY`,
    );
    // Los roles anon y authenticated solo existen en Supabase.
    await queryRunner.query(`
      DO $$
      DECLARE r TEXT;
      BEGIN
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.storage_deletions FROM %I', r);
          END IF;
        END LOOP;
      END $$`);
    await queryRunner.query(
      `DROP INDEX "idx_report_card_templates_institution"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_report_card_templates_institution" ON "report_card_templates" ("institution_id")`,
    );
    await queryRunner.query(`DROP TABLE "storage_deletions"`);
  }
}
