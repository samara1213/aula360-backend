import { randomBytes, randomUUID } from 'crypto';
import * as request from 'supertest';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

/** NIT con el prefijo que reconoce la limpieza de la fábrica de datos. */
const e2eNit = () => `E2E-${randomBytes(5).toString('hex')}`;

describe('Instituciones y sedes (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;
  let campusB: CampusEntity;

  let superAdmin: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let teacherA: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1

  const server = () => ctx.app.getHttpServer();

  async function loginAs(user: UserEntity): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier: user.email, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');
    campusA2 = await data.createCampus(institutionA.id, 'Sede A2');
    campusB = await data.createCampus(institutionB.id, 'Sede B');

    const superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
    const adminAUser = await data.createUser();
    await data.assignGlobalRole(adminAUser.id, institutionA.id);
    const adminBUser = await data.createUser();
    await data.assignGlobalRole(adminBUser.id, institutionB.id);
    const teacherUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(teacherUser.id, institutionA.id, 'TEACHER');
    const campusAdminUser = await data.createUser();
    await data.assignGlobalRole(
      campusAdminUser.id,
      institutionA.id,
      'INSTITUTION_ADMIN',
      campusA1.id,
    );

    superAdmin = await loginAs(superUser);
    adminA = await loginAs(adminAUser);
    adminB = await loginAs(adminBUser);
    teacherA = await loginAs(teacherUser);
    campusAdminA = await loginAs(campusAdminUser);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('/api/institutions', () => {
    it('401 sin sesión', async () => {
      await request(server()).get('/api/institutions').expect(401);
    });

    it('SUPER_ADMIN lista con búsqueda y paginación', async () => {
      const res = await superAdmin
        .get('/api/institutions')
        .query({ search: institutionA.nit, limit: 5 })
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: institutionA.id,
        nit: institutionA.nit,
        gradingScaleMin: 1,
        gradingScaleMax: 5,
        passingScore: 3,
        isActive: true,
      });
      expect(res.body.meta).toMatchObject({ page: 1, limit: 5, total: 1 });
    });

    it('400 con parámetros de consulta inválidos', async () => {
      await superAdmin
        .get('/api/institutions')
        .query({ limit: 500, isActive: 'quizas' })
        .expect(400);
    });

    it('un administrador de institución no puede listar, crear ni editar instituciones (403)', async () => {
      await adminA.get('/api/institutions').expect(403);
      await adminA
        .post('/api/institutions')
        .send({ nit: e2eNit(), name: 'X' })
        .expect(403);
      await adminA
        .patch(`/api/institutions/${institutionA.id}`)
        .send({ name: 'Hackeada' })
        .expect(403);
      await adminA
        .patch(`/api/institutions/${institutionB.id}/deactivate`)
        .expect(403);
    });

    it('SUPER_ADMIN crea, consulta, edita, desactiva y reactiva', async () => {
      const nit = e2eNit();
      const created = await superAdmin
        .post('/api/institutions')
        .send({
          nit,
          name: '  Colegio Nuevo  ',
          gradingScaleMin: 0,
          gradingScaleMax: 10,
          passingScore: 6,
        })
        .expect(201);
      ctx.data.trackInstitution(created.body.id as string);
      expect(created.body).toMatchObject({
        nit,
        name: 'Colegio Nuevo',
        gradingScaleMin: 0,
        gradingScaleMax: 10,
        passingScore: 6,
        isActive: true,
        logoPath: null,
      });

      const id = created.body.id as string;
      await superAdmin.get(`/api/institutions/${id}`).expect(200);

      const updated = await superAdmin
        .patch(`/api/institutions/${id}`)
        .send({ name: 'Colegio Renombrado', passingScore: 7 })
        .expect(200);
      expect(updated.body).toMatchObject({
        name: 'Colegio Renombrado',
        passingScore: 7,
      });

      const off = await superAdmin
        .patch(`/api/institutions/${id}/deactivate`)
        .expect(200);
      expect(off.body.isActive).toBe(false);
      const row = await ctx.dataSource
        .getRepository(InstitutionEntity)
        .findOneBy({ id });
      expect(row?.isActive).toBe(false); // lógico: la fila sigue existiendo

      const on = await superAdmin
        .patch(`/api/institutions/${id}/activate`)
        .expect(200);
      expect(on.body.isActive).toBe(true);
    });

    it('409 con NIT duplicado', async () => {
      await superAdmin
        .post('/api/institutions')
        .send({ nit: institutionA.nit, name: 'Duplicada' })
        .expect(409);
    });

    it('400 con escala incoherente, campos extra o null en obligatorios', async () => {
      await superAdmin
        .post('/api/institutions')
        .send({ nit: e2eNit(), name: 'X', passingScore: 9 })
        .expect(400);
      await superAdmin
        .post('/api/institutions')
        .send({ nit: e2eNit(), name: 'X', isActive: false })
        .expect(400);
      await superAdmin
        .post('/api/institutions')
        .send({ nit: 'NIT CON ESPACIOS', name: 'X' })
        .expect(400);
      await superAdmin
        .patch(`/api/institutions/${institutionA.id}`)
        .send({ name: null })
        .expect(400);
      await superAdmin
        .patch(`/api/institutions/${institutionA.id}`)
        .send({ gradingScaleMin: 4.123 })
        .expect(400);
    });

    it('404 si no existe y 400 si el id no es UUID', async () => {
      await superAdmin.get(`/api/institutions/${randomUUID()}`).expect(404);
      await superAdmin.get('/api/institutions/no-es-uuid').expect(400);
    });

    it('al desactivar una institución sus usuarios pierden el acceso a ella', async () => {
      const temp = await ctx.data.createInstitution('Colegio Temporal');
      const tempAdminUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(tempAdminUser.id, temp.id);
      const tempAdmin = await loginAs(tempAdminUser);
      await tempAdmin.get('/api/campuses').expect(200);

      await superAdmin
        .patch(`/api/institutions/${temp.id}/deactivate`)
        .expect(200);
      await tempAdmin.get('/api/campuses').expect(401);
    });
  });

  describe('GET /api/institutions/current', () => {
    it('devuelve la institución activa del administrador', async () => {
      const res = await adminA.get('/api/institutions/current').expect(200);
      expect(res.body.id).toBe(institutionA.id);
    });

    it('403 sin permiso o sin institución activa', async () => {
      await teacherA.get('/api/institutions/current').expect(403);
      await superAdmin.get('/api/institutions/current').expect(403);
    });
  });

  describe('/api/campuses', () => {
    it('401 sin sesión', async () => {
      await request(server()).get('/api/campuses').expect(401);
    });

    it('lista solo las sedes de la institución activa', async () => {
      const res = await adminA.get('/api/campuses').expect(200);
      const ids = (res.body.data as { id: string }[]).map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([campusA1.id, campusA2.id]));
      expect(ids).not.toContain(campusB.id);
    });

    it('crea la sede en la institución del token y rechaza institutionId en el body', async () => {
      const res = await adminA
        .post('/api/campuses')
        .send({ name: 'Sede Norte', city: 'Bogotá', address: '' })
        .expect(201);
      expect(res.body).toMatchObject({
        institutionId: institutionA.id,
        name: 'Sede Norte',
        city: 'Bogotá',
        address: null,
        isActive: true,
      });

      await adminA
        .post('/api/campuses')
        .send({ name: 'Sede Sur', institutionId: institutionB.id })
        .expect(400);
    });

    it('409 con nombre repetido en la misma institución', async () => {
      await adminA
        .post('/api/campuses')
        .send({ name: campusA1.name })
        .expect(409);
    });

    it('permite el mismo nombre en otra institución', async () => {
      await adminB
        .post('/api/campuses')
        .send({ name: campusA1.name })
        .expect(201);
    });

    it('edita, desactiva y reactiva una sede', async () => {
      const updated = await adminA
        .patch(`/api/campuses/${campusA2.id}`)
        .send({ city: 'Medellín' })
        .expect(200);
      expect(updated.body).toMatchObject({
        name: campusA2.name,
        city: 'Medellín',
      });

      const off = await adminA
        .patch(`/api/campuses/${campusA2.id}/deactivate`)
        .expect(200);
      expect(off.body.isActive).toBe(false);

      const inactive = await adminA
        .get('/api/campuses')
        .query({ isActive: 'false' })
        .expect(200);
      expect((inactive.body.data as { id: string }[]).map((c) => c.id)).toEqual(
        [campusA2.id],
      );

      await adminA.patch(`/api/campuses/${campusA2.id}/activate`).expect(200);
    });

    it('usuario de otra institución no puede ver, editar ni desactivar (404)', async () => {
      await adminB.get(`/api/campuses/${campusA1.id}`).expect(404);
      await adminB
        .patch(`/api/campuses/${campusA1.id}`)
        .send({ name: 'Robada' })
        .expect(404);
      await adminB.patch(`/api/campuses/${campusA1.id}/deactivate`).expect(404);

      const row = await ctx.dataSource
        .getRepository(CampusEntity)
        .findOneBy({ id: campusA1.id });
      expect(row).toMatchObject({ name: campusA1.name, isActive: true });
    });

    it('404 si no existe y 400 si el id no es UUID', async () => {
      await adminA.get(`/api/campuses/${randomUUID()}`).expect(404);
      await adminA.get('/api/campuses/abc').expect(400);
    });

    it('403 sin permiso (docente) o sin institución activa (SUPER_ADMIN)', async () => {
      await teacherA.get('/api/campuses').expect(403);
      await teacherA.post('/api/campuses').send({ name: 'X' }).expect(403);
      await superAdmin.get('/api/campuses').expect(403);
    });

    it('un rol sin permiso y sin sede no amplía el alcance de un rol limitado a una sede', async () => {
      // Rol propio con permiso total sobre sedes, asignado solo en campusA1,
      // más TEACHER sin sede (que no tiene el permiso de sedes).
      const coordinatorRole = await ctx.data.createInstitutionRole(
        institutionA.id,
        ['institution', 'institution.campuses'],
      );
      const coordinatorUser = await ctx.data.createUser({
        userType: 'TEACHER',
      });
      await ctx.dataSource.query(
        'INSERT INTO user_institution_roles (user_id, institution_id, role_id, campus_id) VALUES ($1, $2, $3, $4)',
        [coordinatorUser.id, institutionA.id, coordinatorRole.id, campusA1.id],
      );
      await ctx.data.assignGlobalRole(
        coordinatorUser.id,
        institutionA.id,
        'TEACHER',
      );
      const coordinator = await loginAs(coordinatorUser);

      const res = await coordinator.get('/api/campuses').expect(200);
      expect((res.body.data as { id: string }[]).map((c) => c.id)).toEqual([
        campusA1.id,
      ]);
      await coordinator.get(`/api/campuses/${campusA2.id}`).expect(404);
      await coordinator
        .post('/api/campuses')
        .send({ name: 'Sede Escalada' })
        .expect(403);
      await coordinator
        .patch(`/api/campuses/${campusA2.id}/deactivate`)
        .expect(403);
    });

    it('al desactivar una sede, quien estaba limitado a ella pierde el acceso', async () => {
      const campus = await ctx.data.createCampus(
        institutionA.id,
        'Sede Cerrable',
      );
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(
        user.id,
        institutionA.id,
        'INSTITUTION_ADMIN',
        campus.id,
      );
      const limited = await loginAs(user);
      await limited.get('/api/campuses').expect(200);

      await adminA.patch(`/api/campuses/${campus.id}/deactivate`).expect(200);
      // La sesión vigente deja de valer para esa institución...
      await limited.get('/api/campuses').expect(401);
      // ...y un login nuevo ya no la ofrece.
      const relogin = await request(server())
        .post('/api/auth/login')
        .send({ identifier: user.email, password: TEST_PASSWORD })
        .expect(200);
      expect(relogin.body.institutions).toEqual([]);
      expect(relogin.body.activeInstitutionId).toBeNull();

      // Al reactivarla recupera el acceso.
      await adminA.patch(`/api/campuses/${campus.id}/activate`).expect(200);
      const back = await loginAs(user);
      await back.get('/api/campuses').expect(200);
    });

    it('el administrador de toda la institución conserva el acceso aunque se desactive una sede', async () => {
      const campus = await ctx.data.createCampus(
        institutionA.id,
        'Sede Temporal',
      );
      await adminA.patch(`/api/campuses/${campus.id}/deactivate`).expect(200);
      await adminA.get(`/api/campuses/${campus.id}`).expect(200);
    });

    it('un usuario limitado a una sede solo ve esa sede y no puede gestionar sedes', async () => {
      const res = await campusAdminA.get('/api/campuses').expect(200);
      expect((res.body.data as { id: string }[]).map((c) => c.id)).toEqual([
        campusA1.id,
      ]);
      await campusAdminA.get(`/api/campuses/${campusA1.id}`).expect(200);
      await campusAdminA.get(`/api/campuses/${campusA2.id}`).expect(404);
      await campusAdminA
        .post('/api/campuses')
        .send({ name: 'Sede Intrusa' })
        .expect(403);
      await campusAdminA
        .patch(`/api/campuses/${campusA1.id}/deactivate`)
        .expect(403);
    });
  });
});
