import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { PasswordResetTokenEntity } from '../src/modules/auth/entities/password-reset-token.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { RoleEntity } from '../src/modules/security/entities/role.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const suffix = () => randomBytes(4).toString('hex');
const newEmail = () => `e2e-${suffix()}@test.aula360.local`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Verificación del email (e2e, tarea 2.11.6)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let adminA: Agent;
  let adminB: Agent;
  let teacherRoleId: string;

  const server = () => ctx.app.getHttpServer();

  async function loginAs(identifier: string, password = TEST_PASSWORD) {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password })
      .expect(200);
    return agent;
  }

  const verify = (token: string | null) =>
    request(server()).post('/api/auth/verify-email').send({ token });

  /** Docente de la institución A creado directamente (email verificado). */
  async function teacherOfA(emailVerified = true): Promise<UserEntity> {
    const user = await ctx.data.createUser({
      userType: 'TEACHER',
      emailVerified,
    });
    await ctx.data.assignGlobalRole(user.id, institutionA.id, 'TEACHER');
    return user;
  }

  /** Tokens de recuperación sin usar del usuario (forgot-password corre en segundo plano). */
  async function resetTokensAfterForgot(
    user: { id: string; email: string },
    expected: number,
  ) {
    await request(server())
      .post('/api/auth/forgot-password')
      .send({ email: user.email })
      .expect(200);
    const count = () =>
      ctx.dataSource
        .getRepository(PasswordResetTokenEntity)
        .countBy({ userId: user.id, usedAt: IsNull() });
    // Si no se espera ninguno, se da un margen fijo; si no, se espera hasta 5 s.
    if (expected === 0) {
      await pause(1000);
      return count();
    }
    let n = await count();
    for (let i = 0; i < 50 && n < expected; i++) {
      await pause(100);
      n = await count();
    }
    return n;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    const adminAUser = await data.createUser();
    await data.assignGlobalRole(adminAUser.id, institutionA.id);
    const adminBUser = await data.createUser();
    await data.assignGlobalRole(adminBUser.id, institutionB.id);
    adminA = await loginAs(adminAUser.email!);
    adminB = await loginAs(adminBUser.email!);
    teacherRoleId = (
      await ctx.dataSource
        .getRepository(RoleEntity)
        .findOneByOrFail({ name: 'TEACHER', institutionId: IsNull() })
    ).id;
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  it('un usuario creado queda sin verificar: sin recuperación hasta abrir el enlace', async () => {
    const s = suffix();
    const email = `e2e-${s}@test.aula360.local`;
    const res = await adminA
      .post('/api/users')
      .send({
        userType: 'TEACHER',
        documentType: 'CC',
        documentNumber: `E2E${s}`,
        firstName: 'Nuevo',
        lastName: `E2E ${s}`,
        email,
        roleId: teacherRoleId,
      })
      .expect(201);
    ctx.data.trackUser(res.body.id as string);
    expect(res.body).toMatchObject({
      emailVerified: false,
      pendingEmail: null,
    });

    // Un solo correo: contraseña temporal y enlace de verificación.
    const [welcome] = await ctx.mail.waitFor(email);
    expect(welcome.text).toContain(res.body.temporaryPassword as string);
    const token = ctx.mail.verifyToken(email);
    expect(token).not.toBeNull();

    const user = { id: res.body.id as string, email };
    expect(await resetTokensAfterForgot(user, 0)).toBe(0);

    await verify(token).expect(204);
    const me = await (
      await loginAs(email, res.body.temporaryPassword as string)
    )
      .get('/api/auth/me')
      .expect(200);
    expect(me.body.user).toMatchObject({
      emailVerified: true,
      pendingEmail: null,
    });
    expect(await resetTokensAfterForgot(user, 1)).toBe(1);
    // El enlace es de un solo uso.
    await verify(token).expect(400);
  });

  it('cambio pedido por un administrador: no se aplica hasta confirmar y se avisa al anterior', async () => {
    const target = await teacherOfA();
    const email = newEmail();
    const res = await adminA
      .patch(`/api/users/${target.id}`)
      .send({ email })
      .expect(200);
    expect(res.body).toMatchObject({
      email: target.email,
      hasPendingEmail: true,
      pendingEmail: null,
    });

    await ctx.mail.waitFor(email);
    const [warning] = await ctx.mail.waitFor(target.email!);
    expect(warning.subject).toMatch(/Cambio de correo/);
    expect(warning.text).not.toContain(email);
    expect(warning.text).not.toMatch(/verify-email#token=/);

    // Mientras tanto el email pendiente no sirve para entrar.
    await request(server())
      .post('/api/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD })
      .expect(401);
    await loginAs(target.email!);

    await verify(ctx.mail.verifyToken(email)).expect(204);
    await loginAs(email);
    await request(server())
      .post('/api/auth/login')
      .send({ identifier: target.email, password: TEST_PASSWORD })
      .expect(401);
    const after = await adminA.get(`/api/users/${target.id}`).expect(200);
    expect(after.body).toMatchObject({
      email,
      emailVerified: true,
      pendingEmail: null,
    });
  });

  it('un administrador de otra institución no pide cambios: 404', async () => {
    const target = await teacherOfA();
    await adminB
      .patch(`/api/users/${target.id}`)
      .send({ email: newEmail() })
      .expect(404);
  });

  it('PUT /users/me/email exige la contraseña actual y deja el cambio pendiente', async () => {
    const user = await teacherOfA();
    const agent = await loginAs(user.email!);
    const email = newEmail();
    await agent
      .put('/api/users/me/email')
      .send({ email, currentPassword: 'Incorrecta*2026' })
      .expect(400);
    await agent
      .put('/api/users/me/email')
      .send({ email, currentPassword: TEST_PASSWORD, extra: 1 })
      .expect(400);
    await agent
      .put('/api/users/me/email')
      .send({ email, currentPassword: TEST_PASSWORD })
      .expect(204);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      email: user.email,
      pendingEmail: email,
    });
    await ctx.mail.waitFor(email);
    await verify(ctx.mail.verifyToken(email)).expect(204);
  });

  it('correo de otro usuario: 409 al pedirlo y 409 si otro lo toma antes de confirmar', async () => {
    const target = await teacherOfA();
    const other = await teacherOfA();
    await adminA
      .patch(`/api/users/${target.id}`)
      .send({ email: other.email!.toUpperCase() })
      .expect(409);

    const email = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email }).expect(200);
    await ctx.mail.waitFor(email);
    // Otro usuario se queda con ese correo antes de que se confirme.
    await ctx.dataSource.query('UPDATE users SET email = $1 WHERE id = $2', [
      email,
      other.id,
    ]);
    await verify(ctx.mail.verifyToken(email)).expect(409);
  });

  it('enlace inventado, vencido o reemplazado: 400', async () => {
    await verify('a'.repeat(96)).expect(400);
    await verify('no-es-un-token').expect(400);

    const target = await teacherOfA();
    const first = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email: first });
    await ctx.mail.waitFor(first);
    const firstToken = ctx.mail.verifyToken(first);
    // Un cambio nuevo inutiliza el enlace anterior.
    const second = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email: second });
    await ctx.mail.waitFor(second);
    await verify(firstToken).expect(400);

    await ctx.dataSource.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND used_at IS NULL`,
      [target.id],
    );
    await verify(ctx.mail.verifyToken(second)).expect(400);
  });

  it('quitar el email se aplica ya y cancela el cambio pendiente', async () => {
    const target = await teacherOfA();
    const email = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email });
    await ctx.mail.waitFor(email);
    const res = await adminA
      .patch(`/api/users/${target.id}`)
      .send({ email: null })
      .expect(200);
    expect(res.body).toMatchObject({
      email: null,
      emailVerified: false,
      pendingEmail: null,
    });
    await verify(ctx.mail.verifyToken(email)).expect(400);
  });

  it('reenviar: respeta la espera de 2 minutos y reenvía el email sin verificar', async () => {
    const user = await teacherOfA(false);
    const agent = await loginAs(user.email!);
    await agent.post('/api/auth/verify-email/resend').expect(204);
    await ctx.mail.waitFor(user.email!);
    // Inmediato: no envía otro.
    await agent.post('/api/auth/verify-email/resend').expect(204);
    await pause(300);
    expect(ctx.mail.to(user.email!)).toHaveLength(1);

    await ctx.dataSource.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '3 minutes'
        WHERE user_id = $1`,
      [user.id],
    );
    await agent.post('/api/auth/verify-email/resend').expect(204);
    await ctx.mail.waitFor(user.email!, 2);
    await verify(ctx.mail.verifyToken(user.email!)).expect(204);

    // Ya verificado y sin cambios pendientes: no envía nada.
    await ctx.dataSource.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '3 minutes'
        WHERE user_id = $1`,
      [user.id],
    );
    await agent.post('/api/auth/verify-email/resend').expect(204);
    await pause(300);
    expect(ctx.mail.to(user.email!)).toHaveLength(2);
  });

  it('el reenvío exige sesión', async () => {
    await request(server()).post('/api/auth/verify-email/resend').expect(401);
  });

  it('límites: verify-email y me/email, 5 por minuto (429)', async () => {
    const user = await teacherOfA();
    const agent = await loginAs(user.email!);
    process.env.THROTTLE_DISABLED = 'false';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await verify('b'.repeat(96))).status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
      expect(statuses[5]).toBe(429);

      const own: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await agent
          .put('/api/users/me/email')
          .send({ email: newEmail(), currentPassword: 'Incorrecta*2026' });
        own.push(res.status);
      }
      expect(own[5]).toBe(429);
    } finally {
      process.env.THROTTLE_DISABLED = 'true';
    }
  });

  it('A1: si el usuario pasa a otra institución, el enlace que pidió el administrador ya no sirve', async () => {
    const target = await teacherOfA();
    const email = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email }).expect(200);
    await ctx.mail.waitFor(email);
    // Ahora también es docente de B: el administrador de A ya no es exclusivo.
    await ctx.data.assignGlobalRole(target.id, institutionB.id, 'TEACHER');
    await verify(ctx.mail.verifyToken(email)).expect(400);
    const row = await ctx.dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: target.id });
    expect(row.email).toBe(target.email);
  });

  it('A1: si quien lo pidió se desactivó, el enlace ya no sirve', async () => {
    const requesterUser = await ctx.data.createUser();
    await ctx.data.assignGlobalRole(requesterUser.id, institutionA.id);
    const requester = await loginAs(requesterUser.email!);
    const target = await teacherOfA();
    const email = newEmail();
    await requester
      .patch(`/api/users/${target.id}`)
      .send({ email })
      .expect(200);
    await ctx.mail.waitFor(email);
    await ctx.dataSource.query(
      'UPDATE users SET is_active = false WHERE id = $1',
      [requesterUser.id],
    );
    await verify(ctx.mail.verifyToken(email)).expect(400);
  });

  it('M1: quitar un email verificado avisa a ese correo', async () => {
    const target = await teacherOfA();
    await adminA
      .patch(`/api/users/${target.id}`)
      .send({ email: null })
      .expect(200);
    const [notice] = await ctx.mail.waitFor(target.email!);
    expect(notice.subject).toMatch(/Se quitó el correo/);
  });

  it('M2: desactivar al usuario cancela el cambio pendiente', async () => {
    const target = await teacherOfA();
    const email = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email }).expect(200);
    await ctx.mail.waitFor(email);
    await adminA
      .patch(`/api/users/${target.id}/status`)
      .send({ isActive: false })
      .expect(200);
    await adminA
      .patch(`/api/users/${target.id}/status`)
      .send({ isActive: true })
      .expect(200);
    await verify(ctx.mail.verifyToken(email)).expect(400);
  });

  it('B3: poner el email actual anula un cambio pendiente', async () => {
    const target = await teacherOfA();
    const email = newEmail();
    await adminA.patch(`/api/users/${target.id}`).send({ email }).expect(200);
    await ctx.mail.waitFor(email);
    const res = await adminA
      .patch(`/api/users/${target.id}`)
      .send({ email: target.email })
      .expect(200);
    expect(res.body.hasPendingEmail).toBe(false);
    await verify(ctx.mail.verifyToken(email)).expect(400);
  });

  it('B2: me/email cuenta por usuario, no por IP', async () => {
    const first = await loginAs((await teacherOfA()).email!);
    const second = await loginAs((await teacherOfA()).email!);
    process.env.THROTTLE_DISABLED = 'false';
    try {
      for (let i = 0; i < 5; i++) {
        await first
          .put('/api/users/me/email')
          .send({ email: newEmail(), currentPassword: 'Incorrecta*2026' });
      }
      await first
        .put('/api/users/me/email')
        .send({ email: newEmail(), currentPassword: 'Incorrecta*2026' })
        .expect(429);
      // Otro usuario desde la misma IP no queda bloqueado.
      await second
        .put('/api/users/me/email')
        .send({ email: newEmail(), currentPassword: 'Incorrecta*2026' })
        .expect(400);
    } finally {
      process.env.THROTTLE_DISABLED = 'true';
    }
  });
});
