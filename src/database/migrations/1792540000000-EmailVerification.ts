import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tarea 2.11.6 (hallazgo M2 de la fase 7a, aprobada por el usuario):
 * verificación del email.
 * - users.email_verified_at: null = sin verificar. Solo los SUPER_ADMIN
 *   existentes quedan verificados (su correo lo puso el operador); los demás
 *   lo confirman con el enlace que piden en /auth/verify-email/resend.
 * - email_verification_tokens: como password_reset_tokens (solo el hash, un
 *   solo uso, vence). El token vigente cuyo email difiere del actual es el
 *   cambio pendiente: users.email no cambia hasta confirmarlo. Si lo pidió
 *   otra persona, institution_id guarda dónde actuó: al confirmar se vuelven
 *   a aplicar las reglas de gestión (hallazgo A1 de la fase 11b).
 * - RLS sin políticas y sin permisos para anon y authenticated (Supabase la
 *   expone por su API REST); el backend conecta como postgres.
 * El down borra la columna y la tabla (los enlaces pendientes dejan de servir).
 */
export class EmailVerification1792540000000 implements MigrationInterface {
  name = 'EmailVerification1792540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamptz`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "email_verified_at" = CURRENT_TIMESTAMP
        WHERE user_type = 'SUPER_ADMIN' AND email IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "email_verification_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "email" citext NOT NULL,
        "token_hash" varchar(255) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "used_at" timestamptz,
        "requested_by" uuid,
        "institution_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "email_verification_tokens_token_hash_key" UNIQUE ("token_hash"),
        CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "email_verification_tokens_requested_by_fkey" FOREIGN KEY ("requested_by")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "email_verification_tokens_institution_id_fkey" FOREIGN KEY ("institution_id")
          REFERENCES "institutions"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_email_verification_tokens_user" ON "email_verification_tokens" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_verification_tokens_requested_by" ON "email_verification_tokens" ("requested_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_verification_tokens_institution" ON "email_verification_tokens" ("institution_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    // Los roles anon y authenticated solo existen en Supabase.
    await queryRunner.query(`
      DO $$
      DECLARE r TEXT;
      BEGIN
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.email_verification_tokens FROM %I', r);
          END IF;
        END LOOP;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_verification_tokens"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "email_verified_at"`,
    );
  }
}
