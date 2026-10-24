import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entrega A de los pendientes de la fase 3 (aprobada por el usuario,
 * opción 1 de la revisión de seguridad): invitaciones para sumar a una
 * institución, como docente o estudiante, a quien ya tiene cuenta en otra.
 * La persona la acepta o la rechaza con su sesión; hasta entonces la
 * institución que invita no ve sus datos (A1 de la revisión).
 * - Una sola invitación pendiente por institución y persona (índice único
 *   parcial). Vence a los 14 días (expires_at); al aceptarla se crean el rol
 *   y el perfil. No guarda datos del perfil: la institución los completa
 *   después de que acepte.
 * - RLS sin políticas y sin permisos para anon y authenticated (las tablas
 *   nuevas ya nacen cerradas desde RevokeSupabaseApiGrants; se repite por si
 *   acaso). El backend conecta como postgres.
 * El down borra la tabla (las invitaciones pendientes se pierden).
 */
export class InstitutionInvitations1792720000000 implements MigrationInterface {
  name = 'InstitutionInvitations1792720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "institution_invitations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "institution_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "profile_type" varchar(20) NOT NULL,
        "campus_id" uuid,
        "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "invited_by" uuid,
        "expires_at" timestamptz NOT NULL,
        "responded_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "institution_invitations_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "institution_invitations_profile_type_check"
          CHECK ("profile_type" IN ('TEACHER', 'STUDENT')),
        CONSTRAINT "institution_invitations_status_check"
          CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
        CONSTRAINT "institution_invitations_institution_id_fkey" FOREIGN KEY ("institution_id")
          REFERENCES "institutions"("id") ON DELETE CASCADE,
        CONSTRAINT "institution_invitations_user_id_fkey" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "institution_invitations_campus_id_fkey" FOREIGN KEY ("campus_id")
          REFERENCES "campuses"("id") ON DELETE CASCADE,
        CONSTRAINT "institution_invitations_invited_by_fkey" FOREIGN KEY ("invited_by")
          REFERENCES "users"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_institution_invitations_pending" ON "institution_invitations" ("institution_id", "user_id") WHERE "status" = 'PENDING'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_institution_invitations_institution" ON "institution_invitations" ("institution_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_institution_invitations_user" ON "institution_invitations" ("user_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_institution_invitations_campus" ON "institution_invitations" ("campus_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_institution_invitations_invited_by" ON "institution_invitations" ("invited_by")`,
    );
    await queryRunner.query(
      `ALTER TABLE "institution_invitations" ENABLE ROW LEVEL SECURITY`,
    );
    // Los roles anon y authenticated solo existen en Supabase.
    await queryRunner.query(`
      DO $$
      DECLARE r TEXT;
      BEGIN
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.institution_invitations FROM %I', r);
          END IF;
        END LOOP;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "institution_invitations"`);
  }
}
