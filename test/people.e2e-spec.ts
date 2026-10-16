import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { RoleEntity } from '../src/modules/security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../src/modules/security/entities/user-institution-role.entity';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const suffix = () => randomBytes(4).toString('hex');

/** Persona nueva con los prefijos que barre la limpieza de e2e. */
function person(extra: Record<string, unknown> = {}) {
  const s = suffix();
  return {
    documentType: 'TI',
    documentNumber: `E2E${s}`,
    firstName: 'Persona',
    lastName: `E2E ${s}`,
    email: `e2e-${s}@test.aula360.local`,
    ...extra,
  };
}

describe('Docentes y estudiantes (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1
  let teacherA: Agent; // rol TEACHER: ve estudiantes, no docentes

  let studentRoleId: string;
  let teacherRoleId: string;
  let adminRoleId: string;

  /** Asignación directa en BD (para preparar estados que la API no permite). */
  async function assign(
    userId: string,
    institutionId: string,
    roleId: string,
    campusId: string | null = null,
  ) {
    await ctx.dataSource
      .getRepository(UserInstitutionRoleEntity)
      .insert({ userId, institutionId, roleId, campusId });
  }

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

  /** POST que registra el usuario creado para borrarlo al final. */
  async function create(agent: Agent, url: string, body: object) {
    const res = await agent.post(url).send(body);
    if (res.status === 201) {
      ctx.data.trackUser((res.body as { user: { id: string } }).user.id);
    }
    return res;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');
    campusA2 = await data.createCampus(institutionA.id, 'Sede A2');

    const adminAUser = await data.createUser();
    await data.assignGlobalRole(adminAUser.id, institutionA.id);
    const adminBUser = await data.createUser();
    await data.assignGlobalRole(adminBUser.id, institutionB.id);
    const campusAdminUser = await data.createUser();
    await data.assignGlobalRole(
      campusAdminUser.id,
      institutionA.id,
      'INSTITUTION_ADMIN',
      campusA1.id,
    );
    const teacherUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(teacherUser.id, institutionA.id, 'TEACHER');

    studentRoleId = (
      await ctx.dataSource
        .getRepository(RoleEntity)
        .findOneOrFail({ where: { name: 'STUDENT', institutionId: IsNull() } })
    ).id;

    const globalRole = async (name: string) =>
      (
        await ctx.dataSource
          .getRepository(RoleEntity)
          .findOneOrFail({ where: { name, institutionId: IsNull() } })
      ).id;
    teacherRoleId = await globalRole('TEACHER');
    adminRoleId = await globalRole('INSTITUTION_ADMIN');

    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminUser.email);
    teacherA = await loginAs(teacherUser.email);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('/teachers', () => {
    let teacherA1Id: string; // perfil en campusA1
    let teacherA2Id: string; // perfil en campusA2

    it('crea usuario TEACHER, su rol TEACHER en la sede y el perfil', async () => {
      const body = person({
        documentType: 'CC',
        campusId: campusA1.id,
        academicDegree: 'Licenciado en Matemáticas',
      });
      const res = await create(adminA, '/api/teachers', body);
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        institutionId: institutionA.id,
        academicDegree: 'Licenciado en Matemáticas',
        specialty: null,
        user: {
          documentNumber: body.documentNumber,
          mustChangePassword: true,
          isActive: true,
        },
      });
      expect(res.body.temporaryPassword).toHaveLength(14);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
      teacherA1Id = res.body.id as string;

      const user = await ctx.dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: res.body.user.id as string });
      expect(user.userType).toBe('TEACHER');
      const assignments = await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .find({ where: { userId: user.id }, relations: { role: true } });
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        institutionId: institutionA.id,
        campusId: campusA1.id,
        role: { name: 'TEACHER' },
      });

      // Entra con la temporal y debe cambiarla.
      const fresh = await loginAs(
        body.email,
        res.body.temporaryPassword as string,
      );
      const me = await fresh.get('/api/auth/me').expect(200);
      expect(me.body.user.mustChangePassword).toBe(true);
    });

    it('documento repetido: 409', async () => {
      const first = person();
      await create(adminA, '/api/teachers', first);
      const dup = await create(
        adminA,
        '/api/teachers',
        person({ documentNumber: first.documentNumber }),
      );
      expect(dup.status).toBe(409);
    });

    it('administrador de sede: solo en su sede', async () => {
      const noCampus = await create(campusAdminA, '/api/teachers', person());
      expect(noCampus.status).toBe(403);
      const otherCampus = await create(
        campusAdminA,
        '/api/teachers',
        person({ campusId: campusA2.id }),
      );
      expect(otherCampus.status).toBe(404);
      const ownCampus = await create(
        campusAdminA,
        '/api/teachers',
        person({ campusId: campusA1.id }),
      );
      expect(ownCampus.status).toBe(201);

      const inA2 = await create(
        adminA,
        '/api/teachers',
        person({ campusId: campusA2.id }),
      );
      teacherA2Id = inA2.body.id as string;
      await campusAdminA.get(`/api/teachers/${teacherA2Id}`).expect(404);
      await campusAdminA.get(`/api/teachers/${teacherA1Id}`).expect(200);
      const list = await campusAdminA
        .get('/api/teachers?limit=100')
        .expect(200);
      const ids = (list.body.data as { id: string }[]).map((t) => t.id);
      expect(ids).toContain(teacherA1Id);
      expect(ids).not.toContain(teacherA2Id);
    });

    it('lista y filtra por sede en la institución activa', async () => {
      const res = await adminA
        .get(`/api/teachers?campusId=${campusA2.id}&limit=100`)
        .expect(200);
      const ids = (res.body.data as { id: string }[]).map((t) => t.id);
      expect(ids).toContain(teacherA2Id);
      expect(ids).not.toContain(teacherA1Id);
    });

    it('otra institución: no aparece y su detalle y edición dan 404', async () => {
      const list = await adminB.get('/api/teachers?limit=100').expect(200);
      const ids = (list.body.data as { id: string }[]).map((t) => t.id);
      expect(ids).not.toContain(teacherA1Id);
      await adminB.get(`/api/teachers/${teacherA1Id}`).expect(404);
      await adminB
        .patch(`/api/teachers/${teacherA1Id}`)
        .send({ specialty: 'X' })
        .expect(404);
    });

    it('edita el perfil y los nombres; el email solo un SUPER_ADMIN', async () => {
      const res = await adminA
        .patch(`/api/teachers/${teacherA1Id}`)
        .send({ specialty: 'Álgebra', firstName: 'Carlos' })
        .expect(200);
      expect(res.body).toMatchObject({
        specialty: 'Álgebra',
        user: { firstName: 'Carlos' },
      });
      await adminA
        .patch(`/api/teachers/${teacherA1Id}`)
        .send({ email: `e2e-${suffix()}@test.aula360.local` })
        .expect(403);
    });

    it('el rol TEACHER no gestiona docentes: 403', async () => {
      await teacherA.get('/api/teachers').expect(403);
      const res = await create(teacherA, '/api/teachers', person());
      expect(res.status).toBe(403);
    });
  });

  describe('/students', () => {
    let studentA1Id: string;
    let studentA1UserId: string;
    let studentA2Id: string;
    let code: string;

    it('crea usuario STUDENT, su rol STUDENT en su sede y el perfil (sin email)', async () => {
      code = `E2E-${suffix()}`;
      const res = await create(
        adminA,
        '/api/students',
        person({
          email: null,
          campusId: campusA1.id,
          studentCode: code,
          guardianName: 'Marta Gómez',
          bloodType: 'o+',
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        studentCode: code,
        campus: { id: campusA1.id },
        guardianName: 'Marta Gómez',
        bloodType: 'O+', // el administrador puede editarlo: lo ve
        user: { email: null, mustChangePassword: true },
      });
      expect(res.body.temporaryPassword).toHaveLength(14);
      studentA1Id = res.body.id as string;
      studentA1UserId = res.body.user.id as string;

      const assignments = await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .findBy({ userId: studentA1UserId });
      expect(assignments).toEqual([
        expect.objectContaining({
          roleId: studentRoleId,
          campusId: campusA1.id,
        }),
      ]);

      const inA2 = await create(
        adminA,
        '/api/students',
        person({ campusId: campusA2.id }),
      );
      studentA2Id = inA2.body.id as string;
    });

    it('código repetido en la institución: 409; en otra institución sí se puede', async () => {
      const dup = await create(
        adminA,
        '/api/students',
        person({ studentCode: code }),
      );
      expect(dup.status).toBe(409);
      expect(dup.body.message).toMatch(/código/);
      const inB = await create(
        adminB,
        '/api/students',
        person({ studentCode: code }),
      );
      expect(inB.status).toBe(201);
    });

    it('listado sin datos del acudiente ni tipo de sangre', async () => {
      const res = await adminA.get('/api/students?limit=100').expect(200);
      const row = (res.body.data as { id: string }[]).find(
        (s) => s.id === studentA1Id,
      );
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('bloodType');
      expect(row).not.toHaveProperty('guardianName');
      expect(JSON.stringify(res.body)).not.toMatch(/bloodType|blood_type/);
    });

    it('busca por código', async () => {
      const res = await adminA.get(`/api/students?search=${code}`).expect(200);
      expect((res.body.data as { id: string }[]).map((s) => s.id)).toEqual([
        studentA1Id,
      ]);
    });

    it('el docente (solo ver) recibe el dato mínimo y no los crea', async () => {
      const list = await teacherA.get('/api/students?limit=100').expect(200);
      const row = (
        list.body.data as { id: string; user: Record<string, unknown> }[]
      ).find((s) => s.id === studentA1Id);
      expect(row).toBeDefined();
      expect(Object.keys(row!.user).sort()).toEqual(
        ['firstName', 'hasAvatar', 'id', 'isActive', 'lastName'].sort(),
      );
      const detail = await teacherA
        .get(`/api/students/${studentA1Id}`)
        .expect(200);
      expect(detail.body).toMatchObject({ studentCode: code });
      for (const key of [
        'bloodType',
        'guardianName',
        'guardianPhone',
        'guardianEmail',
      ]) {
        expect(detail.body).not.toHaveProperty(key);
      }
      expect(detail.body.user).not.toHaveProperty('documentNumber');
      expect(detail.body.user).not.toHaveProperty('email');
      expect(detail.body.user).not.toHaveProperty('phone');
      // No puede buscar por documento (sí por código).
      const doc = await adminA.get(`/api/students/${studentA1Id}`).expect(200);
      const byDoc = await teacherA
        .get(`/api/students?search=${doc.body.user.documentNumber as string}`)
        .expect(200);
      expect(byDoc.body.data).toEqual([]);
      const byCode = await teacherA
        .get(`/api/students?search=${code}`)
        .expect(200);
      expect(byCode.body.data).toHaveLength(1);
      const res = await create(teacherA, '/api/students', person());
      expect(res.status).toBe(403);
      await teacherA
        .patch(`/api/students/${studentA1Id}`)
        .send({ guardianName: 'X' })
        .expect(403);
    });

    it('administrador de sede: solo los de su sede', async () => {
      await campusAdminA.get(`/api/students/${studentA1Id}`).expect(200);
      await campusAdminA.get(`/api/students/${studentA2Id}`).expect(404);
      await campusAdminA
        .patch(`/api/students/${studentA2Id}`)
        .send({ guardianName: 'X' })
        .expect(404);
      // No puede mover a un estudiante suyo a una sede fuera de su alcance.
      await campusAdminA
        .patch(`/api/students/${studentA1Id}`)
        .send({ campusId: campusA2.id })
        .expect(404);
      await campusAdminA
        .patch(`/api/students/${studentA1Id}`)
        .send({ campusId: null })
        .expect(403);
    });

    it('otra institución: 404', async () => {
      await adminB.get(`/api/students/${studentA1Id}`).expect(404);
      await adminB
        .patch(`/api/students/${studentA1Id}`)
        .send({ guardianName: 'X' })
        .expect(404);
    });

    it('cambiar de sede mueve también su rol STUDENT', async () => {
      const res = await adminA
        .patch(`/api/students/${studentA1Id}`)
        .send({ campusId: campusA2.id, guardianPhone: '+57 300 000 0000' })
        .expect(200);
      expect(res.body).toMatchObject({
        campus: { id: campusA2.id },
        guardianPhone: '+57 300 000 0000',
      });
      const assignments = await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .findBy({ userId: studentA1UserId });
      expect(assignments).toEqual([
        expect.objectContaining({ campusId: campusA2.id }),
      ]);
      // Ya no es de la sede del administrador de sede.
      await campusAdminA.get(`/api/students/${studentA1Id}`).expect(404);
    });

    it('tipo de sangre inválido: 400', async () => {
      await adminA
        .patch(`/api/students/${studentA1Id}`)
        .send({ bloodType: 'Z+' })
        .expect(400);
    });

    it('estudiante sin sede: el administrador de sede no lo ve', async () => {
      const created = await create(adminA, '/api/students', person());
      expect(created.status).toBe(201);
      expect(created.body.campus).toBeNull();
      await campusAdminA.get(`/api/students/${created.body.id}`).expect(404);
    });

    it('su rol STUDENT solo se gestiona desde /students (409 en /role-assignments)', async () => {
      const created = await create(
        adminA,
        '/api/students',
        person({ campusId: campusA1.id }),
      );
      const userId = created.body.user.id as string;
      const [assignment] = await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .findBy({ userId });
      await adminA.delete(`/api/role-assignments/${assignment.id}`).expect(409);
      await adminA
        .post('/api/role-assignments')
        .send({ userId, roleId: studentRoleId, campusId: campusA2.id })
        .expect(409);
    });

    it('si su rol STUDENT no está en la sede del perfil, no cambia de sede (409)', async () => {
      const created = await create(
        adminA,
        '/api/students',
        person({ campusId: campusA1.id }),
      );
      const userId = created.body.user.id as string;
      // Estado inconsistente preparado en BD: el rol quedó en otra sede.
      await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .update({ userId }, { campusId: campusA2.id });
      await adminA
        .patch(`/api/students/${created.body.id}`)
        .send({ campusId: campusA2.id })
        .expect(409);
      const profile = await ctx.dataSource
        .getRepository(StudentEntity)
        .findOneByOrFail({ id: created.body.id as string });
      expect(profile.campusId).toBe(campusA1.id);
    });

    it('un perfil en otra institución rompe la exclusividad (403)', async () => {
      const created = await create(
        adminA,
        '/api/students',
        person({ campusId: campusA1.id }),
      );
      const userId = created.body.user.id as string;
      await ctx.dataSource.getRepository(StudentEntity).insert({
        userId,
        institutionId: institutionB.id,
      });
      await adminA
        .patch(`/api/users/${userId}/status`)
        .send({ isActive: false })
        .expect(403);
    });
  });

  describe('reglas de gestión a través de los perfiles', () => {
    // Rol propio: los permisos del rol TEACHER más gestionar docentes (toda la
    // institución); no alcanza a los de un INSTITUTION_ADMIN.
    let limitedActor: Agent;
    let limitedActorUserId: string;

    beforeAll(async () => {
      const teacherSlugs = (
        await ctx.dataSource.query<{ slug: string }[]>(
          'SELECT mo.slug FROM role_menu_permissions p JOIN menu_options mo ON mo.id = p.menu_option_id WHERE p.role_id = $1',
          [teacherRoleId],
        )
      ).map((r) => r.slug);
      const role = await ctx.data.createInstitutionRole(institutionA.id, [
        ...new Set([...teacherSlugs, 'people', 'people.teachers']),
      ]);
      const actorUser = await ctx.data.createUser({ userType: 'TEACHER' });
      limitedActorUserId = actorUser.id;
      await assign(actorUser.id, institutionA.id, role.id);
      limitedActor = await loginAs(actorUser.email);
    });

    it('techo: no edita a un docente que además es administrador (403)', async () => {
      const created = await create(adminA, '/api/teachers', person());
      await assign(
        created.body.user.id as string,
        institutionA.id,
        adminRoleId,
      );
      await limitedActor
        .patch(`/api/teachers/${created.body.id}`)
        .send({ specialty: 'X' })
        .expect(403);
      // Uno sin roles adicionales sí.
      const plain = await create(adminA, '/api/teachers', person());
      await limitedActor
        .patch(`/api/teachers/${plain.body.id}`)
        .send({ specialty: 'Física' })
        .expect(200);
    });

    it('nadie se gestiona a sí mismo por su perfil (403)', async () => {
      const [profile] = (
        await ctx.dataSource.getRepository(TeacherEntity).insert({
          userId: limitedActorUserId,
          institutionId: institutionA.id,
        })
      ).identifiers as { id: string }[];
      await limitedActor
        .patch(`/api/teachers/${profile.id}`)
        .send({ firstName: 'Yo' })
        .expect(403);
    });

    it('perfil de alguien sin asignaciones en la institución: 404', async () => {
      const created = await create(adminA, '/api/teachers', person());
      await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .delete({ userId: created.body.user.id as string });
      await adminA.get(`/api/teachers/${created.body.id}`).expect(404);
      await adminA
        .patch(`/api/teachers/${created.body.id}`)
        .send({ firstName: 'X' })
        .expect(404);
      const list = await adminA.get('/api/teachers?limit=100').expect(200);
      expect(
        (list.body.data as { id: string }[]).map((t) => t.id),
      ).not.toContain(created.body.id);
    });

    it('documento de alguien que también está en otra institución: 403', async () => {
      const created = await create(adminA, '/api/teachers', person());
      await assign(
        created.body.user.id as string,
        institutionB.id,
        teacherRoleId,
      );
      await adminA
        .patch(`/api/teachers/${created.body.id}`)
        .send({ documentNumber: `E2E${suffix()}` })
        .expect(403);
    });

    it('administrador de sede: un docente de otra sede no se vuelve visible por otro rol en la suya', async () => {
      const created = await create(
        adminA,
        '/api/teachers',
        person({ campusId: campusA2.id }),
      );
      await assign(
        created.body.user.id as string,
        institutionA.id,
        studentRoleId,
        campusA1.id,
      );
      await campusAdminA.get(`/api/teachers/${created.body.id}`).expect(404);
    });

    it('rate limiting en los listados: 60 por minuto por usuario (429)', async () => {
      const actorUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(actorUser.id, institutionA.id);
      const actor = await loginAs(actorUser.email);
      process.env.THROTTLE_DISABLED = 'false';
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 61; i++) {
          statuses.push((await actor.get('/api/students?limit=1')).status);
        }
        expect(statuses.slice(0, 60).every((st) => st === 200)).toBe(true);
        expect(statuses[60]).toBe(429);
      } finally {
        process.env.THROTTLE_DISABLED = 'true';
      }
    }, 120_000);
  });

  it('el perfil queda ligado a la institución activa, no a un id del cliente', async () => {
    const res = await adminA
      .post('/api/teachers')
      .send({ ...person(), institutionId: institutionB.id });
    expect(res.status).toBe(400);
    const count = await ctx.dataSource
      .getRepository(TeacherEntity)
      .countBy({ institutionId: institutionB.id });
    expect(count).toBe(0);
  });
});
