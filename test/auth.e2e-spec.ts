import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { PasswordResetTokenEntity } from '../src/modules/auth/entities/password-reset-token.entity';
import { TokenCleanupService } from '../src/modules/auth/token-cleanup.service';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import {
  createTestApp,
  findCookie,
  TestContext,
} from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

const NEW_PASSWORD = 'Cambiada*E2e2026';

describe('Auth (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let otherInstitution: InstitutionEntity;
  let admin: UserEntity; // solo en A
  let multi: UserEntity; // en A y B

  const server = () => ctx.app.getHttpServer();

  /** "access_token=..." de una respuesta de login, para reutilizarlo en otra petición. */
  function accessCookie(headers: Record<string, unknown>): string {
    return findCookie(headers, 'access_token')!.split(';')[0];
  }

  async function loginAgent(identifier: string, password = TEST_PASSWORD) {
    const agent = request.agent(server());
    const res = await agent
      .post('/api/auth/login')
      .send({ identifier, password });
    return { agent, res };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    institutionA = await ctx.data.createInstitution('Colegio A');
    institutionB = await ctx.data.createInstitution('Colegio B');
    otherInstitution = await ctx.data.createInstitution('Colegio Ajeno');

    admin = await ctx.data.createUser();
    await ctx.data.assignGlobalRole(admin.id, institutionA.id);

    multi = await ctx.data.createUser({ userType: 'TEACHER' });
    await ctx.data.assignGlobalRole(multi.id, institutionA.id, 'TEACHER');
    await ctx.data.assignGlobalRole(multi.id, institutionB.id, 'TEACHER');
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('POST /api/auth/login', () => {
    it('inicia sesión con email, fija cookies httpOnly y no expone datos sensibles', async () => {
      const res = await request(server())
        .post('/api/auth/login')
        .send({ identifier: admin.email, password: TEST_PASSWORD })
        .expect(200);

      const access = findCookie(res.headers, 'access_token');
      const refresh = findCookie(res.headers, 'refresh_token');
      expect(access).toMatch(/HttpOnly/i);
      expect(access).toMatch(/SameSite=Lax/i);
      expect(access).toMatch(/Path=\//);
      expect(refresh).toMatch(/HttpOnly/i);
      expect(refresh).toMatch(/Path=\/api\/auth/);

      expect(res.body.activeInstitutionId).toBe(institutionA.id);
      expect(res.body.institutions).toEqual([
        {
          id: institutionA.id,
          name: institutionA.name,
          roles: ['INSTITUTION_ADMIN'],
        },
      ]);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toMatch(/passwordHash|password_hash|token/i);
      // Sin la ruta interna del avatar en Storage (B6 de la fase 11e).
      expect(res.body.user.hasAvatar).toBe(false);
      expect(res.body.user).not.toHaveProperty('avatarPath');
    });

    it('acepta el email sin distinguir mayúsculas', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({
          identifier: admin.email!.toUpperCase(),
          password: TEST_PASSWORD,
        })
        .expect(200);
    });

    it('inicia sesión con número de documento', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({ identifier: admin.documentNumber, password: TEST_PASSWORD })
        .expect(200);
    });

    it('responde igual con contraseña incorrecta, usuario inexistente o inactivo', async () => {
      const inactive = await ctx.data.createUser({ isActive: false });
      const attempts = [
        { identifier: admin.email, password: 'Incorrecta*123' },
        {
          identifier: 'no-existe-e2e@test.aula360.local',
          password: TEST_PASSWORD,
        },
        { identifier: inactive.email, password: TEST_PASSWORD },
      ];
      const bodies = await Promise.all(
        attempts.map((body) =>
          request(server()).post('/api/auth/login').send(body).expect(401),
        ),
      );
      const messages = bodies.map((r) => r.body.message);
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('Credenciales inválidas');
      bodies.forEach((r) =>
        expect(findCookie(r.headers, 'access_token')).toBeUndefined(),
      );
    });

    it('rechaza campos extra o faltantes (400)', async () => {
      await request(server())
        .post('/api/auth/login')
        .send({
          identifier: admin.email,
          password: TEST_PASSWORD,
          isAdmin: true,
        })
        .expect(400);
      await request(server())
        .post('/api/auth/login')
        .send({ identifier: admin.email })
        .expect(400);
    });

    it('un formulario HTML (urlencoded) responde 415 (B4 de la fase 11e)', async () => {
      const res = await request(server())
        .post('/api/auth/login')
        .type('form')
        .send({ identifier: admin.email, password: TEST_PASSWORD })
        .expect(415);
      expect(res.body).toMatchObject({ statusCode: 415, message: 'Use JSON' });
      expect(findCookie(res.headers, 'access_token')).toBeUndefined();
    });

    it('con varias instituciones no fija una activa', async () => {
      const { res } = await loginAgent(multi.email!);
      expect(res.status).toBe(200);
      expect(res.body.activeInstitutionId).toBeNull();
      expect(
        res.body.institutions.map((i: { id: string }) => i.id).sort(),
      ).toEqual([institutionA.id, institutionB.id].sort());
    });
  });

  describe('GET /api/auth/me', () => {
    it('sin sesión responde 401', async () => {
      await request(server()).get('/api/auth/me').expect(401);
    });

    it('con un token alterado responde 401', async () => {
      await request(server())
        .get('/api/auth/me')
        .set('Cookie', 'access_token=eyJhbGciOiJIUzI1NiJ9.e30.firma-falsa')
        .expect(401);
    });

    it('devuelve el usuario y la institución activa', async () => {
      const { agent } = await loginAgent(admin.email!);
      const res = await agent.get('/api/auth/me').expect(200);
      expect(res.body.user).toMatchObject({
        id: admin.id,
        userType: 'INSTITUTION_ADMIN',
      });
      expect(res.body.activeInstitutionId).toBe(institutionA.id);
    });

    it('un usuario desactivado pierde el acceso aunque tenga token', async () => {
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(user.id, institutionA.id);
      const { agent } = await loginAgent(user.email!);
      await ctx.dataSource
        .getRepository(UserEntity)
        .update(user.id, { isActive: false });
      await agent.get('/api/auth/me').expect(401);
    });
  });

  describe('POST /api/auth/switch-institution', () => {
    it('cambia a otra institución del usuario', async () => {
      const { agent } = await loginAgent(multi.email!);
      const res = await agent
        .post('/api/auth/switch-institution')
        .send({ institutionId: institutionB.id })
        .expect(200);
      expect(res.body.activeInstitutionId).toBe(institutionB.id);
      const me = await agent.get('/api/auth/me').expect(200);
      expect(me.body.activeInstitutionId).toBe(institutionB.id);
    });

    it('usuario de otra institución no puede activarla (404)', async () => {
      const { agent } = await loginAgent(admin.email!);
      await agent
        .post('/api/auth/switch-institution')
        .send({ institutionId: otherInstitution.id })
        .expect(404);
      const me = await agent.get('/api/auth/me').expect(200);
      expect(me.body.activeInstitutionId).toBe(institutionA.id);
    });

    it('valida el formato del id (400)', async () => {
      const { agent } = await loginAgent(admin.email!);
      await agent
        .post('/api/auth/switch-institution')
        .send({ institutionId: 'no-es-uuid' })
        .expect(400);
    });
  });

  describe('POST /api/auth/refresh-token', () => {
    it('rota el refresh token y conserva la institución activa', async () => {
      const { agent } = await loginAgent(multi.email!);
      await agent
        .post('/api/auth/switch-institution')
        .send({ institutionId: institutionB.id })
        .expect(200);

      const res = await agent.post('/api/auth/refresh-token').expect(204);
      expect(findCookie(res.headers, 'refresh_token')).toBeDefined();
      const me = await agent.get('/api/auth/me').expect(200);
      expect(me.body.activeInstitutionId).toBe(institutionB.id);
    });

    it('reutilizar un refresh token revocado cierra todas las sesiones', async () => {
      const { res: loginRes } = await loginAgent(admin.email!);
      const oldRefresh = findCookie(loginRes.headers, 'refresh_token')!.split(
        ';',
      )[0];

      const rotated = await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', oldRefresh)
        .expect(204);
      const newRefresh = findCookie(rotated.headers, 'refresh_token')!.split(
        ';',
      )[0];

      await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', oldRefresh)
        .expect(401);
      // El token nuevo también quedó revocado por la reutilización.
      await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', newRefresh)
        .expect(401);
      expect(await ctx.data.activeRefreshTokens(admin.id)).toBe(0);
    });

    it('sin cookie responde 401', async () => {
      await request(server()).post('/api/auth/refresh-token').expect(401);
    });
  });

  describe('purga de tokens vencidos (TokenCleanupService)', () => {
    /** Inserta un token con vencimiento relativo (días; negativo = vencido). */
    async function insertToken(
      table: string,
      userId: string,
      days: number,
      extra: Record<string, string> = {},
    ): Promise<string> {
      const columns = [
        'user_id',
        'token_hash',
        'expires_at',
        ...Object.keys(extra),
      ];
      const values = [
        userId,
        randomBytes(32).toString('hex'),
        days,
        ...Object.values(extra),
      ];
      const placeholders = values.map((_, i) =>
        i === 2 ? `CURRENT_TIMESTAMP + $3 * interval '1 day'` : `$${i + 1}`,
      );
      const [{ id }] = await ctx.dataSource.query<{ id: string }[]>(
        `INSERT INTO ${table} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')}) RETURNING id`,
        values,
      );
      return id;
    }

    async function exists(table: string, id: string): Promise<boolean> {
      const rows = await ctx.dataSource.query<unknown[]>(
        `SELECT 1 FROM ${table} WHERE id = $1`,
        [id],
      );
      return rows.length > 0;
    }

    it('borra solo lo vencido hace más de 30 días y conserva la detección de reuso', async () => {
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(user.id, institutionA.id);
      const email = { email: user.email! };

      const old = {
        refresh_tokens: await insertToken('refresh_tokens', user.id, -31),
        password_reset_tokens: await insertToken(
          'password_reset_tokens',
          user.id,
          -31,
        ),
        email_verification_tokens: await insertToken(
          'email_verification_tokens',
          user.id,
          -31,
          email,
        ),
      };
      const kept = {
        refresh_tokens: await insertToken('refresh_tokens', user.id, -29),
        password_reset_tokens: await insertToken(
          'password_reset_tokens',
          user.id,
          -1,
        ),
        email_verification_tokens: await insertToken(
          'email_verification_tokens',
          user.id,
          1,
          email,
        ),
      };

      // Refresh rotado (revocado) que venció hace 29 días: se conserva.
      const { res: loginRes } = await loginAgent(user.email!);
      const revoked = findCookie(loginRes.headers, 'refresh_token')!.split(
        ';',
      )[0];
      await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', revoked)
        .expect(204);
      await ctx.dataSource.query(
        `UPDATE refresh_tokens
            SET expires_at = CURRENT_TIMESTAMP - interval '29 days'
          WHERE user_id = $1 AND revoked_at IS NOT NULL`,
        [user.id],
      );

      // La purga es global: en la base compartida también borra tokens
      // vencidos hace más de 30 días de otros usuarios. Ninguna e2e debe
      // depender de tokens así (I5 de la revisión de la tarea 2.11.15).
      const result = await ctx.app.get(TokenCleanupService).purgeExpired();
      expect(result).not.toBeNull();

      for (const [table, id] of Object.entries(old)) {
        expect(await exists(table, id)).toBe(false);
      }
      for (const [table, id] of Object.entries(kept)) {
        expect(await exists(table, id)).toBe(true);
      }

      // El revocado sigue en la tabla: presentarlo cierra todas las sesiones
      // (la rotada y el insertado sin revocar que venció hace 29 días).
      expect(await ctx.data.activeRefreshTokens(user.id)).toBe(2);
      await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', revoked)
        .expect(401);
      expect(await ctx.data.activeRefreshTokens(user.id)).toBe(0);
    });

    it('no espera filas bloqueadas por otra transacción (SKIP LOCKED)', async () => {
      const user = await ctx.data.createUser();
      const locked = await insertToken('refresh_tokens', user.id, -31);
      const free = await insertToken('refresh_tokens', user.id, -31);

      // Otra transacción retiene la fila, como al revocar todas las sesiones.
      const runner = ctx.dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(
          `SELECT id FROM refresh_tokens WHERE id = $1 FOR UPDATE`,
          [locked],
        );
        const result = await ctx.app.get(TokenCleanupService).purgeExpired();
        expect(result).not.toBeNull();
        expect(await exists('refresh_tokens', free)).toBe(false);
        expect(await exists('refresh_tokens', locked)).toBe(true);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }

      // La pasada siguiente la borra.
      await ctx.app.get(TokenCleanupService).purgeExpired();
      expect(await exists('refresh_tokens', locked)).toBe(false);
    }, 15_000);
  });

  describe('POST /api/auth/logout', () => {
    it('revoca el refresh token y limpia las cookies', async () => {
      const { agent, res: loginRes } = await loginAgent(admin.email!);
      const refresh = findCookie(loginRes.headers, 'refresh_token')!.split(
        ';',
      )[0];

      const res = await agent.post('/api/auth/logout').expect(204);
      expect(findCookie(res.headers, 'access_token')).toMatch(
        /Expires=Thu, 01 Jan 1970/,
      );

      await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', refresh)
        .expect(401);
    });

    it('el access token de la sesión cerrada deja de valer de inmediato', async () => {
      const { agent, res: loginRes } = await loginAgent(admin.email!);
      const access = accessCookie(loginRes.headers);
      await agent.post('/api/auth/logout').expect(204);
      await request(server())
        .get('/api/auth/me')
        .set('Cookie', access)
        .expect(401);
    });

    it('cerrar una sesión no afecta las demás del mismo usuario', async () => {
      const first = await loginAgent(admin.email!);
      const second = await loginAgent(admin.email!);
      await first.agent.post('/api/auth/logout').expect(204);
      await second.agent.get('/api/auth/me').expect(200);
    });
  });

  describe('contraseña temporal (must_change_password)', () => {
    it('solo permite /me y /change-password hasta cambiarla', async () => {
      const user = await ctx.data.createUser({ mustChangePassword: true });
      await ctx.data.assignGlobalRole(user.id, institutionA.id);
      const { agent, res } = await loginAgent(user.email!);
      expect(res.body.user.mustChangePassword).toBe(true);

      await agent.get('/api/auth/me').expect(200);
      await agent
        .post('/api/auth/switch-institution')
        .send({ institutionId: institutionA.id })
        .expect(403);

      await agent
        .post('/api/auth/change-password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      await agent
        .post('/api/auth/switch-institution')
        .send({ institutionId: institutionA.id })
        .expect(200);
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('rechaza la contraseña actual incorrecta y una nueva débil', async () => {
      const { agent } = await loginAgent(admin.email!);
      await agent
        .post('/api/auth/change-password')
        .send({ currentPassword: 'Incorrecta*123', newPassword: NEW_PASSWORD })
        .expect(400);
      await agent
        .post('/api/auth/change-password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'debil' })
        .expect(400);
    });

    it('cierra las demás sesiones', async () => {
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(user.id, institutionA.id);
      const other = await loginAgent(user.email!);
      const otherRefresh = findCookie(
        other.res.headers,
        'refresh_token',
      )!.split(';')[0];

      const { agent } = await loginAgent(user.email!);
      await agent
        .post('/api/auth/change-password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      await request(server())
        .post('/api/auth/refresh-token')
        .set('Cookie', otherRefresh)
        .expect(401);
      // El access token de la otra sesión también deja de valer, sin esperar a que venza.
      await request(server())
        .get('/api/auth/me')
        .set('Cookie', accessCookie(other.res.headers))
        .expect(401);
      // El intento del otro dispositivo no se toma como robo: la sesión actual sigue viva.
      await agent.get('/api/auth/me').expect(200);
      await agent.post('/api/auth/refresh-token').expect(204);
      await loginAgent(user.email!, NEW_PASSWORD).then(({ res }) =>
        expect(res.status).toBe(200),
      );
    });
  });

  describe('recuperación de contraseña', () => {
    it('forgot-password responde igual exista o no el correo', async () => {
      const known = await request(server())
        .post('/api/auth/forgot-password')
        .send({ email: admin.email })
        .expect(200);
      const unknown = await request(server())
        .post('/api/auth/forgot-password')
        .send({ email: 'nadie-e2e@test.aula360.local' })
        .expect(200);
      expect(known.body).toEqual(unknown.body);
    });

    it('forgot-password crea el token en segundo plano (solo su hash) y respeta el cooldown', async () => {
      const user = await ctx.data.createUser();
      const repo = ctx.dataSource.getRepository(PasswordResetTokenEntity);
      const pending = () =>
        repo.find({
          select: { id: true, tokenHash: true },
          where: { userId: user.id, usedAt: IsNull() },
        });

      await request(server())
        .post('/api/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      let tokens = await pending();
      for (let i = 0; i < 50 && tokens.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        tokens = await pending();
      }
      expect(tokens).toHaveLength(1);
      expect(tokens[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

      // Una segunda solicitud inmediata no genera otro enlace.
      await request(server())
        .post('/api/auth/forgot-password')
        .send({ email: user.email })
        .expect(200);
      await new Promise((r) => setTimeout(r, 1000));
      const after = await pending();
      expect(after.map((t) => t.id)).toEqual([tokens[0].id]);
    });

    it('reset-password cambia la contraseña y el token es de un solo uso', async () => {
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(user.id, institutionA.id);
      const token = await ctx.data.createResetToken(user.id);

      await request(server())
        .post('/api/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(204);
      await request(server())
        .post('/api/auth/reset-password')
        .send({ token, newPassword: 'Otra*Clave2026' })
        .expect(400);

      const { res } = await loginAgent(user.email!, NEW_PASSWORD);
      expect(res.status).toBe(200);
    });

    it('reset-password cierra las sesiones abiertas (refresh y access)', async () => {
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(user.id, institutionA.id);
      const { agent } = await loginAgent(user.email!);
      const token = await ctx.data.createResetToken(user.id);

      await request(server())
        .post('/api/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(204);

      await agent.get('/api/auth/me').expect(401);
      await agent.post('/api/auth/refresh-token').expect(401);
      expect(await ctx.data.activeRefreshTokens(user.id)).toBe(0);
    });

    it('rechaza un token vencido', async () => {
      const user = await ctx.data.createUser();
      const token = await ctx.data.createResetToken(user.id, { expired: true });
      await request(server())
        .post('/api/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(400);
    });
  });

  describe('protecciones', () => {
    it('JSON mal formado responde 400 genérico, sin detalles del parser', async () => {
      const res = await request(server())
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"identifier": "x", ')
        .expect(400);
      expect(res.body.message).toBe('Solicitud inválida');
      expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|JSON at/);
    });

    it('CSRF: rechaza métodos que modifican datos desde otro origen (403)', async () => {
      await request(server())
        .post('/api/auth/login')
        .set('Origin', 'https://sitio-malicioso.com')
        .send({ identifier: admin.email, password: TEST_PASSWORD })
        .expect(403);
      await request(server())
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ identifier: admin.email, password: TEST_PASSWORD })
        .expect(200);
    });

    it('rate limiting: el login se bloquea tras 5 intentos por minuto (429)', async () => {
      process.env.THROTTLE_DISABLED = 'false';
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
          const res = await request(server())
            .post('/api/auth/login')
            .send({ identifier: 'rate-e2e@test.aula360.local', password: 'x' });
          statuses.push(res.status);
        }
        expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
        expect(statuses[5]).toBe(429);
      } finally {
        process.env.THROTTLE_DISABLED = 'true';
      }
    });
  });
});
