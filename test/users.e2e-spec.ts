import { randomBytes, randomUUID } from 'crypto';
import * as request from 'supertest';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { RoleEntity } from '../src/modules/security/entities/role.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const suffix = () => randomBytes(4).toString('hex');

/** Datos de un usuario nuevo con los prefijos que barre la limpieza de e2e. */
function newUserBody(extra: Record<string, unknown> = {}) {
  const s = suffix();
  return {
    userType: 'TEACHER',
    documentType: 'cc',
    documentNumber: `E2E${s}`,
    firstName: 'Nuevo',
    lastName: `E2E ${s}`,
    email: `e2e-${s}@test.aula360.local`,
    ...extra,
  };
}

describe('Usuarios (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let adminAUser: UserEntity;
  let campusAdminAUser: UserEntity; // INSTITUTION_ADMIN limitado a campusA1
  let teacherA1User: UserEntity; // TEACHER en campusA1
  let teacherA2User: UserEntity; // TEACHER en campusA2
  let teacherBothUser: UserEntity; // TEACHER en campusA1 y campusA2
  let sharedUser: UserEntity; // TEACHER en A (campusA1) y en B
  let noAvatarUser: UserEntity;

  let superAdmin: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent;
  let teacherA1: Agent;
  let managerA: Agent; // rol propio con solo security y security.users

  let globalRoles: Record<string, string>;
  let roleB: RoleEntity;

  const server = () => ctx.app.getHttpServer();

  async function loginAs(
    identifier: string | null,
    password = TEST_PASSWORD,
  ): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password })
      .expect(200);
    return agent;
  }

  async function createVia(
    agent: Agent,
    body: Record<string, unknown>,
    url = '/api/users',
  ) {
    const res = await agent.post(url).send(body);
    if (res.status === 201) ctx.data.trackUser(res.body.id as string);
    return res;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data, dataSource } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');
    campusA2 = await data.createCampus(institutionA.id, 'Sede A2');

    const roles = await dataSource
      .getRepository(RoleEntity)
      .createQueryBuilder('r')
      .where('r.institution_id IS NULL')
      .getMany();
    globalRoles = Object.fromEntries(roles.map((r) => [r.name, r.id]));
    roleB = await data.createInstitutionRole(institutionB.id, ['people']);

    const superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
    adminAUser = await data.createUser();
    await data.assignGlobalRole(adminAUser.id, institutionA.id);
    const adminBUser = await data.createUser();
    await data.assignGlobalRole(adminBUser.id, institutionB.id);
    campusAdminAUser = await data.createUser();
    await data.assignGlobalRole(
      campusAdminAUser.id,
      institutionA.id,
      'INSTITUTION_ADMIN',
      campusA1.id,
    );
    const managerUser = await data.createUser();
    const managerRole = await data.createInstitutionRole(institutionA.id, [
      'security',
      'security.users',
    ]);
    await ctx.dataSource.query(
      'INSERT INTO user_institution_roles (user_id, institution_id, role_id) VALUES ($1, $2, $3)',
      [managerUser.id, institutionA.id, managerRole.id],
    );

    teacherA1User = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(
      teacherA1User.id,
      institutionA.id,
      'TEACHER',
      campusA1.id,
    );
    teacherA2User = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(
      teacherA2User.id,
      institutionA.id,
      'TEACHER',
      campusA2.id,
    );
    teacherBothUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(
      teacherBothUser.id,
      institutionA.id,
      'TEACHER',
      campusA1.id,
    );
    await data.assignGlobalRole(
      teacherBothUser.id,
      institutionA.id,
      'TEACHER',
      campusA2.id,
    );
    sharedUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(
      sharedUser.id,
      institutionA.id,
      'TEACHER',
      campusA1.id,
    );
    await data.assignGlobalRole(sharedUser.id, institutionB.id, 'TEACHER');
    noAvatarUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(noAvatarUser.id, institutionA.id, 'TEACHER');

    superAdmin = await loginAs(superUser.email);
    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminAUser.email);
    teacherA1 = await loginAs(teacherA1User.email);
    managerA = await loginAs(managerUser.email);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('POST /users', () => {
    it('crea el usuario con contraseña temporal (una sola vez) y debe cambiarla al entrar', async () => {
      const body = newUserBody({ campusId: campusA1.id });
      const res = await createVia(adminA, {
        ...body,
        roleId: globalRoles.TEACHER,
      });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        documentType: 'CC',
        documentNumber: body.documentNumber,
        userType: 'TEACHER',
        mustChangePassword: true,
        isActive: true,
        assignments: [
          {
            role: { id: globalRoles.TEACHER, name: 'TEACHER' },
            campus: { id: campusA1.id },
          },
        ],
      });
      expect(res.body).not.toHaveProperty('passwordHash');
      const temporaryPassword = res.body.temporaryPassword as string;
      expect(temporaryPassword).toHaveLength(14);

      // Entra con la temporal; mientras no la cambie, solo puede cambiarla.
      const fresh = await loginAs(body.email, temporaryPassword);
      const me = await fresh.get('/api/auth/me').expect(200);
      expect(me.body.user.mustChangePassword).toBe(true);
      expect(me.body.activeInstitutionId).toBe(institutionA.id);
      await fresh.get('/api/menu-options/my-menu').expect(403);

      // El detalle posterior no vuelve a mostrar la contraseña.
      const detail = await adminA
        .get(`/api/users/${res.body.id as string}`)
        .expect(200);
      expect(detail.body).not.toHaveProperty('temporaryPassword');
    });

    it('documento o email repetido: 409 genérico', async () => {
      const dupDocument = await createVia(
        adminA,
        newUserBody({
          documentNumber: teacherA1User.documentNumber,
          roleId: globalRoles.TEACHER,
        }),
      );
      expect(dupDocument.status).toBe(409);
      const dupEmail = await createVia(
        adminA,
        newUserBody({
          email: teacherA1User.email!.toUpperCase(),
          roleId: globalRoles.TEACHER,
        }),
      );
      expect(dupEmail.status).toBe(409);
      expect(dupEmail.body.message).toBe(dupDocument.body.message);
    });

    it('sin permiso (docente): 403', async () => {
      const res = await createVia(
        teacherA1,
        newUserBody({ roleId: globalRoles.TEACHER }),
      );
      expect(res.status).toBe(403);
    });

    it('no se puede crear un SUPER_ADMIN ni enviar campos extra: 400', async () => {
      const superType = await createVia(
        adminA,
        newUserBody({ userType: 'SUPER_ADMIN', roleId: globalRoles.TEACHER }),
      );
      expect(superType.status).toBe(400);
      const extra = await createVia(
        adminA,
        newUserBody({ roleId: globalRoles.TEACHER, isActive: false }),
      );
      expect(extra.status).toBe(400);
    });

    it('rol de otra institución: 404', async () => {
      const res = await createVia(adminA, newUserBody({ roleId: roleB.id }));
      expect(res.status).toBe(404);
    });

    it('no puede dar un rol con más permisos de los que tiene: 403 y no queda el usuario', async () => {
      const body = newUserBody({ roleId: globalRoles.INSTITUTION_ADMIN });
      const res = await createVia(managerA, body);
      expect(res.status).toBe(403);
      const exists = await ctx.dataSource
        .getRepository(UserEntity)
        .existsBy({ documentNumber: body.documentNumber });
      expect(exists).toBe(false);
    });

    it('administrador de sede: solo en su sede', async () => {
      const noCampus = await createVia(
        campusAdminA,
        newUserBody({ roleId: globalRoles.TEACHER }),
      );
      expect(noCampus.status).toBe(403);
      const otherCampus = await createVia(
        campusAdminA,
        newUserBody({ roleId: globalRoles.TEACHER, campusId: campusA2.id }),
      );
      expect(otherCampus.status).toBe(404);
      const ownCampus = await createVia(
        campusAdminA,
        newUserBody({ roleId: globalRoles.TEACHER, campusId: campusA1.id }),
      );
      expect(ownCampus.status).toBe(201);
    });

    it('administrador de sede no puede crear INSTITUTION_ADMIN: 403', async () => {
      const res = await createVia(
        campusAdminA,
        newUserBody({
          userType: 'INSTITUTION_ADMIN',
          roleId: globalRoles.TEACHER,
          campusId: campusA1.id,
        }),
      );
      expect(res.status).toBe(403);
    });

    it('sin oráculo: rol inexistente con documento repetido da 404, no 409', async () => {
      const res = await createVia(
        managerA,
        newUserBody({
          documentNumber: teacherA1User.documentNumber,
          roleId: randomUUID(),
        }),
      );
      expect(res.status).toBe(404);
    });

    it('origen no permitido: 403', async () => {
      const res = await adminA
        .post('/api/users')
        .set('Origin', 'https://evil.example')
        .send(newUserBody({ roleId: globalRoles.TEACHER }));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /users', () => {
    it('lista solo usuarios de la institución activa, sin datos sensibles', async () => {
      const res = await adminA.get('/api/users?limit=100').expect(200);
      const ids = (res.body.data as { id: string }[]).map((u) => u.id);
      expect(ids).toEqual(
        expect.arrayContaining([teacherA1User.id, sharedUser.id]),
      );
      const shared = (
        res.body.data as {
          id: string;
          assignments: { role: { name: string } }[];
        }[]
      ).find((u) => u.id === sharedUser.id)!;
      // Solo sus asignaciones en A, no la de B.
      expect(shared.assignments).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toMatch(
        /passwordHash|password_hash/,
      );
    });

    it('usuario de otra institución: no aparece y su detalle da 404', async () => {
      const res = await adminB.get('/api/users?limit=100').expect(200);
      const ids = (res.body.data as { id: string }[]).map((u) => u.id);
      expect(ids).not.toContain(teacherA1User.id);
      expect(ids).toContain(sharedUser.id);
      await adminB.get(`/api/users/${teacherA1User.id}`).expect(404);
    });

    it('busca por documento y filtra por sede', async () => {
      const bySearch = await adminA
        .get(`/api/users?search=${teacherA2User.documentNumber}`)
        .expect(200);
      expect(bySearch.body.data).toHaveLength(1);
      expect(bySearch.body.data[0].id).toBe(teacherA2User.id);

      const byCampus = await adminA
        .get(`/api/users?campusId=${campusA2.id}&limit=100`)
        .expect(200);
      const ids = (byCampus.body.data as { id: string }[]).map((u) => u.id);
      expect(ids).toContain(teacherA2User.id);
      expect(ids).not.toContain(teacherA1User.id);
    });

    it('administrador de sede: solo ve usuarios de su sede', async () => {
      const res = await campusAdminA.get('/api/users?limit=100').expect(200);
      const ids = (res.body.data as { id: string }[]).map((u) => u.id);
      expect(ids).toContain(teacherA1User.id);
      expect(ids).not.toContain(teacherA2User.id);
      expect(ids).not.toContain(adminAUser.id);
      await campusAdminA.get(`/api/users/${teacherA2User.id}`).expect(404);
      // De un usuario en dos sedes solo ve la asignación de la suya.
      const both = await campusAdminA
        .get(`/api/users/${teacherBothUser.id}`)
        .expect(200);
      expect(both.body.assignments).toHaveLength(1);
    });

    it('sin permiso (docente): 403', async () => {
      await teacherA1.get('/api/users').expect(403);
    });

    it('las rutas propias siguen funcionando (/users/me/avatar no es /users/:id)', async () => {
      await adminA.get('/api/users/me/avatar').expect(404);
    });
  });

  describe('PATCH /users/:id', () => {
    it('edita nombres de un usuario que también está en otra institución', async () => {
      const res = await adminA
        .patch(`/api/users/${sharedUser.id}`)
        .send({ firstName: 'Compartido' })
        .expect(200);
      expect(res.body.firstName).toBe('Compartido');
    });

    it('email de un usuario de varias instituciones: 403 (exclusividad)', async () => {
      await adminA
        .patch(`/api/users/${sharedUser.id}`)
        .send({ email: `e2e-${suffix()}@test.aula360.local` })
        .expect(403);
    });

    it('el SUPER_ADMIN sí puede cambiar ese email', async () => {
      const email = `e2e-${suffix()}@test.aula360.local`;
      const res = await superAdmin
        .patch(`/api/institutions/${institutionA.id}/users/${sharedUser.id}`)
        .send({ email })
        .expect(200);
      expect(res.body.email).toBe(email);
    });

    it('email de un usuario exclusivo: también 403 (solo SUPER_ADMIN, hasta que exista la verificación)', async () => {
      await adminA
        .patch(`/api/users/${teacherA2User.id}`)
        .send({ email: `e2e-${suffix()}@test.aula360.local` })
        .expect(403);
    });

    it('documento de un usuario exclusivo: 200', async () => {
      const documentNumber = `E2E${suffix()}`;
      const res = await adminA
        .patch(`/api/users/${teacherA2User.id}`)
        .send({ documentNumber })
        .expect(200);
      expect(res.body.documentNumber).toBe(documentNumber);
      teacherA2User.documentNumber = documentNumber;
    });

    it('techo: un rol con menos permisos no gestiona al administrador (403 genérico)', async () => {
      const res = await managerA
        .patch(`/api/users/${adminAUser.id}`)
        .send({ firstName: 'X' })
        .expect(403);
      expect(res.body.message).toBe(
        'No tiene permiso para gestionar a este usuario',
      );
      await managerA
        .patch(`/api/users/${adminAUser.id}/status`)
        .send({ isActive: false })
        .expect(403);
      await managerA
        .post(`/api/users/${adminAUser.id}/temporary-password`)
        .expect(403);
    });

    it('origen no permitido: 403', async () => {
      await adminA
        .patch(`/api/users/${teacherA1User.id}`)
        .set('Origin', 'https://evil.example')
        .send({ firstName: 'X' })
        .expect(403);
    });

    it('administrador de sede: un usuario que también está en otra sede es "no exclusivo"', async () => {
      await campusAdminA
        .patch(`/api/users/${teacherBothUser.id}`)
        .send({ documentNumber: `E2E${suffix()}` })
        .expect(403);
    });

    it('otra institución: 404', async () => {
      await adminB
        .patch(`/api/users/${teacherA1User.id}`)
        .send({ firstName: 'X' })
        .expect(404);
    });

    it('null en un campo obligatorio: 400', async () => {
      await adminA
        .patch(`/api/users/${teacherA1User.id}`)
        .send({ lastName: null })
        .expect(400);
    });
  });

  describe('PATCH /users/:id/status', () => {
    it('desactivar cierra la sesión del usuario al instante; reactivar permite entrar de nuevo', async () => {
      const victim = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(victim.id, institutionA.id, 'TEACHER');
      const session = await loginAs(victim.email);
      await session.get('/api/auth/me').expect(200);

      const off = await adminA
        .patch(`/api/users/${victim.id}/status`)
        .send({ isActive: false })
        .expect(200);
      expect(off.body.isActive).toBe(false);
      await session.get('/api/auth/me').expect(401);
      await request(server())
        .post('/api/auth/login')
        .send({ identifier: victim.email, password: TEST_PASSWORD })
        .expect(401);

      await adminA
        .patch(`/api/users/${victim.id}/status`)
        .send({ isActive: true })
        .expect(200);
      await loginAs(victim.email);
    });

    it('no puede desactivarse a sí mismo: 403', async () => {
      await adminA
        .patch(`/api/users/${adminAUser.id}/status`)
        .send({ isActive: false })
        .expect(403);
    });

    it('usuario de varias instituciones: 403', async () => {
      await adminA
        .patch(`/api/users/${sharedUser.id}/status`)
        .send({ isActive: false })
        .expect(403);
    });

    it('administrador de sede no puede tocar al administrador general (no lo ve): 404', async () => {
      await campusAdminA
        .patch(`/api/users/${adminAUser.id}/status`)
        .send({ isActive: false })
        .expect(404);
    });

    it('otra institución: 404', async () => {
      await adminB
        .patch(`/api/users/${teacherA1User.id}/status`)
        .send({ isActive: false })
        .expect(404);
    });
  });

  describe('POST /users/:id/temporary-password', () => {
    it('genera una temporal nueva, invalida la anterior y cierra sesiones', async () => {
      const target = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(target.id, institutionA.id, 'TEACHER');
      const session = await loginAs(target.email);

      const res = await adminA
        .post(`/api/users/${target.id}/temporary-password`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const temporaryPassword = res.body.temporaryPassword as string;

      await session.get('/api/auth/me').expect(401);
      await request(server())
        .post('/api/auth/login')
        .send({ identifier: target.email, password: TEST_PASSWORD })
        .expect(401);
      const fresh = await loginAs(target.email, temporaryPassword);
      const me = await fresh.get('/api/auth/me').expect(200);
      expect(me.body.user.mustChangePassword).toBe(true);
    });

    it('usuario de varias instituciones: 403; otra institución: 404', async () => {
      await adminA
        .post(`/api/users/${sharedUser.id}/temporary-password`)
        .expect(403);
      await adminB
        .post(`/api/users/${teacherA1User.id}/temporary-password`)
        .expect(404);
    });
  });

  describe('GET /users/:id/avatar', () => {
    it('URL firmada del avatar de un usuario de la institución', async () => {
      const path = await ctx.storage.upload(
        'avatars',
        `users/${teacherA1User.id}`,
        {
          buffer: Buffer.from('img'),
          mimeType: 'image/png',
          extension: 'png',
        },
      );
      await ctx.dataSource
        .getRepository(UserEntity)
        .update({ id: teacherA1User.id }, { avatarPath: path });

      const res = await adminA
        .get(`/api/users/${teacherA1User.id}/avatar`)
        .expect(200);
      expect(res.body).toMatchObject({ avatarPath: path, expiresIn: 120 });
      expect(res.body.url).toContain(path);
    });

    it('otra institución, otra sede o sin avatar: 404', async () => {
      await adminB.get(`/api/users/${teacherA1User.id}/avatar`).expect(404);
      await campusAdminA
        .get(`/api/users/${teacherA2User.id}/avatar`)
        .expect(404);
      await adminA.get(`/api/users/${noAvatarUser.id}/avatar`).expect(404);
    });

    it('sin permiso (docente): 403', async () => {
      await teacherA1.get(`/api/users/${noAvatarUser.id}/avatar`).expect(403);
    });
  });

  describe('SUPER_ADMIN visto desde una institución', () => {
    let hiddenSuper: UserEntity;

    beforeAll(async () => {
      hiddenSuper = await ctx.data.createUser({ userType: 'SUPER_ADMIN' });
      await ctx.data.assignGlobalRole(hiddenSuper.id, institutionA.id);
    });

    it('no aparece en el listado ni en la búsqueda', async () => {
      const list = await adminA.get('/api/users?limit=100').expect(200);
      const ids = (list.body.data as { id: string }[]).map((u) => u.id);
      expect(ids).not.toContain(hiddenSuper.id);
      const search = await adminA
        .get(`/api/users?search=${hiddenSuper.documentNumber}`)
        .expect(200);
      expect(search.body.data).toHaveLength(0);
    });

    it('detalle, avatar, edición, estado y contraseña temporal: 404', async () => {
      await adminA.get(`/api/users/${hiddenSuper.id}`).expect(404);
      await adminA.get(`/api/users/${hiddenSuper.id}/avatar`).expect(404);
      await adminA
        .patch(`/api/users/${hiddenSuper.id}`)
        .send({ firstName: 'X' })
        .expect(404);
      await adminA
        .patch(`/api/users/${hiddenSuper.id}/status`)
        .send({ isActive: false })
        .expect(404);
      await adminA
        .post(`/api/users/${hiddenSuper.id}/temporary-password`)
        .expect(404);
    });

    it('otro SUPER_ADMIN sí lo ve', async () => {
      await superAdmin
        .get(`/api/institutions/${institutionA.id}/users/${hiddenSuper.id}`)
        .expect(200);
    });
  });

  describe('administrador de sede sobre un usuario exclusivo de su sede', () => {
    it('puede generar su contraseña temporal y desactivarlo', async () => {
      const target = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(
        target.id,
        institutionA.id,
        'TEACHER',
        campusA1.id,
      );
      await campusAdminA
        .post(`/api/users/${target.id}/temporary-password`)
        .expect(200);
      await campusAdminA
        .patch(`/api/users/${target.id}/status`)
        .send({ isActive: false })
        .expect(200);
    });

    it('sobre un usuario en dos sedes: 403', async () => {
      await campusAdminA
        .post(`/api/users/${teacherBothUser.id}/temporary-password`)
        .expect(403);
      await campusAdminA
        .patch(`/api/users/${teacherBothUser.id}/status`)
        .send({ isActive: false })
        .expect(403);
    });
  });

  describe('enlaces de recuperación y límite de peticiones', () => {
    it('la contraseña temporal invalida los enlaces de recuperación pendientes', async () => {
      const target = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(target.id, institutionA.id, 'TEACHER');
      const token = await ctx.data.createResetToken(target.id);
      await adminA
        .post(`/api/users/${target.id}/temporary-password`)
        .expect(200);
      await request(server())
        .post('/api/auth/reset-password')
        .send({ token, newPassword: 'Nueva*Clave2026' })
        .expect(400);
    });

    it('el SUPER_ADMIN cambia el email e invalida los enlaces pendientes', async () => {
      const target = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(target.id, institutionA.id, 'TEACHER');
      const token = await ctx.data.createResetToken(target.id);
      await superAdmin
        .patch(`/api/institutions/${institutionA.id}/users/${target.id}`)
        .send({ email: `e2e-${suffix()}@test.aula360.local` })
        .expect(200);
      await request(server())
        .post('/api/auth/reset-password')
        .send({ token, newPassword: 'Nueva*Clave2026' })
        .expect(400);
    });

    it('rate limiting: 10 por minuto por usuario en acciones sensibles (429)', async () => {
      const actorUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(actorUser.id, institutionA.id);
      const actor = await loginAs(actorUser.email);
      process.env.THROTTLE_DISABLED = 'false';
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
          const res = await actor
            .patch(`/api/users/${noAvatarUser.id}/status`)
            .send({ isActive: true });
          statuses.push(res.status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
        expect(statuses[10]).toBe(429);
      } finally {
        process.env.THROTTLE_DISABLED = 'true';
      }
    });
  });

  describe('/institutions/:institutionId/users (SUPER_ADMIN)', () => {
    it('gestiona a un usuario de varias instituciones (sin exclusividad)', async () => {
      const shared = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(shared.id, institutionA.id, 'TEACHER');
      await ctx.data.assignGlobalRole(shared.id, institutionB.id, 'TEACHER');
      const base = `/api/institutions/${institutionA.id}/users/${shared.id}`;
      await superAdmin.post(`${base}/temporary-password`).expect(200);
      await superAdmin
        .patch(`${base}/status`)
        .send({ isActive: false })
        .expect(200);
    });

    it('usuario que no está en esa institución: 404', async () => {
      await superAdmin
        .get(`/api/institutions/${institutionB.id}/users/${teacherA1User.id}`)
        .expect(404);
    });

    it('crea el primer administrador de una institución', async () => {
      const res = await createVia(
        superAdmin,
        newUserBody({
          userType: 'INSTITUTION_ADMIN',
          roleId: globalRoles.INSTITUTION_ADMIN,
        }),
        `/api/institutions/${institutionB.id}/users`,
      );
      expect(res.status).toBe(201);
      expect(res.body.assignments[0].role.name).toBe('INSTITUTION_ADMIN');

      const list = await superAdmin
        .get(`/api/institutions/${institutionB.id}/users?limit=100`)
        .expect(200);
      const ids = (list.body.data as { id: string }[]).map((u) => u.id);
      expect(ids).toContain(res.body.id);
    });

    it('un administrador de institución no puede usarlo: 403', async () => {
      const res = await createVia(
        adminA,
        newUserBody({ roleId: globalRoles.TEACHER }),
        `/api/institutions/${institutionB.id}/users`,
      );
      expect(res.status).toBe(403);
    });

    it('institución inexistente: 404', async () => {
      await superAdmin
        .get(`/api/institutions/${randomUUID()}/users`)
        .expect(404);
      const res = await createVia(
        superAdmin,
        newUserBody({ roleId: globalRoles.TEACHER }),
        `/api/institutions/${randomUUID()}/users`,
      );
      expect(res.status).toBe(404);
    });
  });
});
