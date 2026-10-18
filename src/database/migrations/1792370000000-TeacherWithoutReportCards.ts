import { MigrationInterface, QueryRunner } from 'typeorm';

const SLUGS = ['reports', 'reports.report-cards'];

/**
 * Hallazgo M1 de la fase 10b (aprobado por el usuario): el rol global
 * TEACHER deja de ver los boletines, que traen todas las materias (en el
 * cuadro de notas el docente solo ve las suyas). El seed solo inserta lo que
 * falta, así que se quita aquí. Solo datos: dos permisos del rol global
 * TEACHER; los roles propios de cada institución no se tocan. El down los
 * restituye como estaban (solo ver).
 */
export class TeacherWithoutReportCards1792370000000 implements MigrationInterface {
  name = 'TeacherWithoutReportCards1792370000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM role_menu_permissions rmp
        USING roles r, menu_options m
        WHERE rmp.role_id = r.id AND rmp.menu_option_id = m.id
          AND r.name = 'TEACHER' AND r.institution_id IS NULL
          AND m.slug = ANY($1::text[])`,
      [SLUGS],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO role_menu_permissions (role_id, menu_option_id)
       SELECT r.id, m.id FROM roles r, menu_options m
        WHERE r.name = 'TEACHER' AND r.institution_id IS NULL
          AND m.slug = ANY($1::text[])
       ON CONFLICT (role_id, menu_option_id) DO NOTHING`,
      [SLUGS],
    );
  }
}
