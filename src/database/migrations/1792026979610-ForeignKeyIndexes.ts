import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índices en claves foráneas que no tenían (PostgreSQL no los crea solo) y
 * eliminación de dos índices redundantes, ya cubiertos por un UNIQUE que
 * empieza por la misma columna. Detectado con las consultas de la skill
 * postgres-performance-integrity.
 *
 * Índices normales (no CONCURRENTLY): las tablas están vacías al aplicarla.
 * Con datos en producción habría que usar CONCURRENTLY y `transaction = false`.
 */
export class ForeignKeyIndexes1792026979610 implements MigrationInterface {
  name = 'ForeignKeyIndexes1792026979610';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_enrollments_academic_year" ON "enrollments" ("academic_year_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_report_cards_course" ON "report_cards" ("course_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_uir_campus" ON "user_institution_roles" ("campus_id")`,
    );
    // Cubierto por campuses_institution_id_name_key (institution_id, name).
    await queryRunner.query(`DROP INDEX "public"."idx_campuses_institution"`);
    // Cubierto por students_institution_id_student_code_key (institution_id, student_code).
    await queryRunner.query(`DROP INDEX "public"."idx_students_institution"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_students_institution" ON "students" ("institution_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_campuses_institution" ON "campuses" ("institution_id")`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_uir_campus"`);
    await queryRunner.query(`DROP INDEX "public"."idx_report_cards_course"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_enrollments_academic_year"`,
    );
  }
}
