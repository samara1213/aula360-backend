import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 10 (boletines), aprobada por el usuario:
 * - performance_levels: niveles de desempeño por institución (Decreto 1290),
 *   con los de la escala nacional en las instituciones con escala 1-5.
 * - report_card_templates: plantillas HTML por institución (el archivo va en
 *   el bucket privado report-templates; aquí solo la ruta).
 * - report_cards: plantilla usada, quién lo generó y desde cuándo está
 *   desactualizado (sus notas cambiaron después de generarlo).
 * Solo agrega tablas, columnas e índices: no toca datos existentes.
 */
export class ReportCardsPhase101792281455415 implements MigrationInterface {
  name = 'ReportCardsPhase101792281455415';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "performance_levels" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "institution_id" uuid NOT NULL,
        "name" varchar(50) NOT NULL,
        "min_score" numeric(4,2) NOT NULL,
        "max_score" numeric(4,2) NOT NULL,
        "display_order" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "performance_levels_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "performance_levels_institution_id_name_key" UNIQUE ("institution_id", "name"),
        CONSTRAINT "chk_performance_levels_range" CHECK (min_score <= max_score),
        CONSTRAINT "performance_levels_institution_id_fkey" FOREIGN KEY ("institution_id")
          REFERENCES "institutions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_performance_levels_institution" ON "performance_levels" ("institution_id")`,
    );
    // Escala nacional (MEN) para las instituciones con escala 1.00-5.00.
    await queryRunner.query(`
      INSERT INTO "performance_levels" ("institution_id", "name", "min_score", "max_score", "display_order")
      SELECT i.id, l.name, l.min_score, l.max_score, l.display_order
        FROM "institutions" i
       CROSS JOIN (VALUES
         ('Bajo', 1.00, 2.99, 1),
         ('Básico', 3.00, 3.99, 2),
         ('Alto', 4.00, 4.59, 3),
         ('Superior', 4.60, 5.00, 4)
       ) AS l(name, min_score, max_score, display_order)
       WHERE i.grading_scale_min = 1.00 AND i.grading_scale_max = 5.00`);

    await queryRunner.query(`
      CREATE TABLE "report_card_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "institution_id" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text,
        "storage_path" varchar(500) NOT NULL,
        "content_sha256" char(64) NOT NULL,
        "is_active" boolean NOT NULL DEFAULT false,
        "created_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "report_card_templates_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "report_card_templates_institution_id_fkey" FOREIGN KEY ("institution_id")
          REFERENCES "institutions"("id") ON DELETE RESTRICT,
        CONSTRAINT "report_card_templates_created_by_fkey" FOREIGN KEY ("created_by")
          REFERENCES "users"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_report_card_templates_institution" ON "report_card_templates" ("institution_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_report_card_templates_active" ON "report_card_templates" ("institution_id") WHERE is_active`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_report_card_templates_created_by" ON "report_card_templates" ("created_by")`,
    );

    await queryRunner.query(`
      ALTER TABLE "report_cards"
        ADD COLUMN "template_id" uuid,
        ADD COLUMN "outdated_at" timestamptz,
        ADD COLUMN "generated_by" uuid,
        ADD CONSTRAINT "report_cards_template_id_fkey" FOREIGN KEY ("template_id")
          REFERENCES "report_card_templates"("id") ON DELETE RESTRICT,
        ADD CONSTRAINT "report_cards_generated_by_fkey" FOREIGN KEY ("generated_by")
          REFERENCES "users"("id") ON DELETE SET NULL`);
    await queryRunner.query(
      `CREATE INDEX "idx_report_cards_template" ON "report_cards" ("template_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_report_cards_generated_by" ON "report_cards" ("generated_by")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_report_cards_generated_by"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_report_cards_template"`);
    await queryRunner.query(`
      ALTER TABLE "report_cards"
        DROP CONSTRAINT "report_cards_generated_by_fkey",
        DROP CONSTRAINT "report_cards_template_id_fkey",
        DROP COLUMN "generated_by",
        DROP COLUMN "outdated_at",
        DROP COLUMN "template_id"`);
    await queryRunner.query(`DROP TABLE "report_card_templates"`);
    await queryRunner.query(`DROP TABLE "performance_levels"`);
  }
}
