import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { schoolToday } from '../src/common/utils/school-date';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const suffix = () => randomBytes(4).toString('hex');

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Fechas relativas a hoy (Colombia), válidas en cualquier día del año:
 * - año lectivo "actual" = año calendario anterior al de hoy, con un periodo
 *   terminado (feb-mar) y uno en curso (dic del año lectivo hasta después de
 *   hoy, permitido por el calendario B);
 * - año lectivo "futuro" = año siguiente al de hoy.
 */
const today = schoolToday();
const currentYear = Number(today.slice(0, 4)) - 1;
const futureYear = Number(today.slice(0, 4)) + 1;
const lastAllowed = `${currentYear + 1}-12-31`;
const current = {
  start: `${currentYear}-12-01`,
  end: addDays(today, 30) > lastAllowed ? lastAllowed : addDays(today, 30),
};
const past = { start: `${currentYear}-02-01`, end: `${currentYear}-03-01` };
const future = { start: `${futureYear}-02-01`, end: `${futureYear}-03-01` };

describe('Evaluaciones (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1
  let teacher1: Agent;
  let teacher2: Agent;
  let teacher1Id: string;
  let teacher2Id: string;

  let currentPeriod: string;
  let pastPeriod: string;
  let futurePeriod: string;
  let gradeId: string;
  let math: string;
  let courseA1: string;
  let courseA2: string;
  let tsc1: string; // courseA1 / math / teacher1
  let tsc2: string; // courseA2 / math / teacher2
  let tscFuture: string; // curso del año futuro / math / teacher1
  let futureYearId: string;
  let courseFuture: string;

  const server = () => ctx.app.getHttpServer();

  async function loginAs(identifier: string | null): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  async function post(agent: Agent, url: string, body: object, status: number) {
    const res = await agent.post(url).send(body);
    expect({
      url,
      status: res.status,
      body: res.body as unknown,
    }).toMatchObject({
      status,
    });
    return res.body as { id: string } & Record<string, unknown>;
  }

  async function createTeacher(campuses: (string | null)[] = [null]) {
    const user = await ctx.data.createUser({ userType: 'TEACHER' });
    for (const campusId of campuses) {
      await ctx.data.assignGlobalRole(
        user.id,
        institutionA.id,
        'TEACHER',
        campusId,
      );
    }
    const profile = await ctx.dataSource
      .getRepository(TeacherEntity)
      .save({ userId: user.id, institutionId: institutionA.id });
    return { user, id: profile.id };
  }

  const evaluation = (extra: Record<string, unknown> = {}) => ({
    teacherAssignmentId: tsc1,
    periodId: currentPeriod,
    title: `Taller ${suffix()}`,
    percentage: 10,
    evaluationDate: today,
    ...extra,
  });

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
    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminUser.email);

    const t1 = await createTeacher();
    const t2 = await createTeacher();
    teacher1Id = t1.id;
    teacher2Id = t2.id;
    teacher1 = await loginAs(t1.user.email);
    teacher2 = await loginAs(t2.user.email);

    const yearId = (
      await post(adminA, '/api/academic-years', { year: currentYear }, 201)
    ).id;
    futureYearId = (
      await post(adminA, '/api/academic-years', { year: futureYear }, 201)
    ).id;
    const period = async (y: string, name: string, p: typeof current) =>
      (
        await post(
          adminA,
          `/api/academic-years/${y}/periods`,
          { name, startDate: p.start, endDate: p.end },
          201,
        )
      ).id;
    pastPeriod = await period(yearId, 'Terminado', past);
    currentPeriod = await period(yearId, 'En curso', current);
    futurePeriod = await period(futureYearId, 'Futuro', future);

    gradeId = (await post(adminA, '/api/grades', { name: 'Sexto' }, 201)).id;
    math = (await post(adminA, '/api/subjects', { name: 'Matemáticas' }, 201))
      .id;
    const course = async (campusId: string, y: string) =>
      (
        await post(
          adminA,
          '/api/courses',
          { name: `60${suffix()}`, gradeId, campusId, academicYearId: y },
          201,
        )
      ).id;
    courseA1 = await course(campusA1.id, yearId);
    courseA2 = await course(campusA2.id, yearId);
    courseFuture = await course(campusA1.id, futureYearId);
    const load = async (
      courseId: string,
      teacherId: string,
      subjectId = math,
    ) =>
      (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId, subjectId, teacherId },
          201,
        )
      ).id;
    tsc1 = await load(courseA1, teacher1Id);
    tsc2 = await load(courseA2, teacher2Id);
    tscFuture = await load(courseFuture, teacher1Id);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('suma de porcentajes', () => {
    it('el docente crea en su carga; la suma por materia, curso y periodo no pasa de 100', async () => {
      const first = await post(
        teacher1,
        '/api/evaluations',
        evaluation({ percentage: 40 }),
        201,
      );
      expect(first).toMatchObject({
        percentage: 40,
        evaluationDate: today,
        allocatedPercentage: 40,
        period: { id: currentPeriod },
        teacherAssignment: {
          id: tsc1,
          isActive: true,
          course: { id: courseA1 },
          subject: { id: math },
          teacher: { id: teacher1Id },
        },
      });
      expect(JSON.stringify(first)).not.toMatch(/documentNumber|email/);
      const second = await post(
        teacher1,
        '/api/evaluations',
        evaluation({ percentage: 59.99 }),
        201,
      );
      expect(second.allocatedPercentage).toBe(99.99);
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({ percentage: 0.02 }),
        409,
      );
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({ percentage: 0.01 }),
        201,
      );
    });

    it('altas simultáneas que juntas pasan de 100: una 201 y otra 409', async () => {
      const subject = (
        await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201)
      ).id;
      const tsc = (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId: courseA1, subjectId: subject, teacherId: teacher1Id },
          201,
        )
      ).id;
      const statuses = (
        await Promise.all(
          [1, 2].map(() =>
            teacher1
              .post('/api/evaluations')
              .send(evaluation({ teacherAssignmentId: tsc, percentage: 60 })),
          ),
        )
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('validaciones', () => {
    it.each([
      ['porcentaje 0', { percentage: 0 }],
      ['porcentaje con 3 decimales', { percentage: 10.001 }],
      ['porcentaje mayor que 100', { percentage: 101 }],
      ['fecha fuera del periodo', { evaluationDate: addDays(current.end, 1) }],
      ['fecha inexistente', { evaluationDate: `${currentYear}-02-30` }],
      ['periodo de otro año', { periodId: 'FUTURE' }],
      ['campos extra', { institutionId: 'x' }],
    ])('400: %s', async (_c, extra) => {
      const body = evaluation(extra);
      if (body.periodId === 'FUTURE') body.periodId = futurePeriod;
      await post(adminA, '/api/evaluations', body, 400);
    });
  });

  describe('docente', () => {
    it('no actúa sobre la carga de otro docente (404)', async () => {
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc2 }),
        404,
      );
      const list = await teacher1.get('/api/evaluations?limit=100').expect(200);
      const assignments = new Set(
        (list.body.data as { teacherAssignment: { id: string } }[]).map(
          (e) => e.teacherAssignment.id,
        ),
      );
      expect(assignments.has(tsc2)).toBe(false);
    });

    it('periodo terminado: el docente no (403), el administrador sí', async () => {
      const body = evaluation({
        periodId: pastPeriod,
        evaluationDate: past.start,
      });
      await post(teacher1, '/api/evaluations', body, 403);
      const created = await post(adminA, '/api/evaluations', body, 201);
      await teacher1
        .patch(`/api/evaluations/${created.id}`)
        .send({ title: 'X' })
        .expect(403);
      await teacher1.delete(`/api/evaluations/${created.id}`).expect(403);
    });

    it('periodo futuro: el docente puede planearlo', async () => {
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({
          teacherAssignmentId: tscFuture,
          periodId: futurePeriod,
          evaluationDate: future.start,
        }),
        201,
      );
    });

    it('sin el rol TEACHER vigente no ve ni crea evaluaciones', async () => {
      const t = await createTeacher();
      const tsc = (
        await post(
          adminA,
          '/api/teacher-assignments',
          {
            courseId: courseA2,
            subjectId: (
              await post(
                adminA,
                '/api/subjects',
                { name: `E2E ${suffix()}` },
                201,
              )
            ).id,
            teacherId: t.id,
          },
          201,
        )
      ).id;
      const agent = await loginAs(t.user.email);
      await post(
        agent,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc }),
        201,
      );
      // Le quitan el rol TEACHER pero conserva otro rol (sin permiso de evaluaciones).
      await ctx.data.assignGlobalRole(
        t.user.id,
        institutionA.id,
        'STUDENT',
        campusA2.id,
      );
      await ctx.dataSource.query(
        `DELETE FROM user_institution_roles WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE name = 'TEACHER' AND institution_id IS NULL)`,
        [t.user.id],
      );
      await agent.get('/api/evaluations').expect(403);
    });
  });

  describe('alcance', () => {
    let evalA2: string;

    beforeAll(async () => {
      evalA2 = (
        await post(
          teacher2,
          '/api/evaluations',
          evaluation({ teacherAssignmentId: tsc2, percentage: 5 }),
          201,
        )
      ).id;
    });

    it('administrador de sede: solo los cursos de su sede', async () => {
      await campusAdminA.get(`/api/evaluations/${evalA2}`).expect(404);
      await post(
        campusAdminA,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc2 }),
        404,
      );
      const list = await campusAdminA
        .get('/api/evaluations?limit=100')
        .expect(200);
      expect(
        (list.body.data as { teacherAssignment: { course: { id: string } } }[])
          .map((e) => e.teacherAssignment.course.id)
          .some((id) => id === courseA2),
      ).toBe(false);
    });

    it('otra institución: 404', async () => {
      await adminB.get(`/api/evaluations/${evalA2}`).expect(404);
      await adminB
        .patch(`/api/evaluations/${evalA2}`)
        .send({ title: 'X' })
        .expect(404);
      await adminB.delete(`/api/evaluations/${evalA2}`).expect(404);
      await post(
        adminB,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc2 }),
        404,
      );
    });
  });

  describe('editar y borrar', () => {
    let subject: string;
    let tsc: string;

    beforeAll(async () => {
      subject = (
        await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201)
      ).id;
      tsc = (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId: courseA1, subjectId: subject, teacherId: teacher1Id },
          201,
        )
      ).id;
    });

    it('edita revalidando la suma y la fecha', async () => {
      const a = await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc, percentage: 50 }),
        201,
      );
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc, percentage: 30 }),
        201,
      );
      await teacher1
        .patch(`/api/evaluations/${a.id}`)
        .send({ percentage: 71 })
        .expect(409);
      const ok = await teacher1
        .patch(`/api/evaluations/${a.id}`)
        .send({ percentage: 70, title: 'Parcial' })
        .expect(200);
      expect(ok.body).toMatchObject({
        percentage: 70,
        title: 'Parcial',
        allocatedPercentage: 100,
      });
      await teacher1
        .patch(`/api/evaluations/${a.id}`)
        .send({ evaluationDate: addDays(current.start, -1) })
        .expect(400);
      await teacher1
        .patch(`/api/evaluations/${a.id}`)
        .send({ periodId: pastPeriod })
        .expect(400);
    });

    it('con notas no se borra (409); sin notas sí', async () => {
      const list = await teacher1
        .get(`/api/evaluations?teacherAssignmentId=${tsc}`)
        .expect(200);
      const [target] = list.body.data as { id: string }[];
      const user = await ctx.data.createUser({ userType: 'STUDENT' });
      const student = await ctx.dataSource.getRepository(StudentEntity).save({
        userId: user.id,
        institutionId: institutionA.id,
        campusId: campusA1.id,
      });
      await ctx.dataSource.query(
        'INSERT INTO scores (evaluation_id, student_id, score) VALUES ($1, $2, 4.5)',
        [target.id, student.id],
      );
      await teacher1.delete(`/api/evaluations/${target.id}`).expect(409);
      const [, other] = list.body.data as { id: string }[];
      await teacher1.delete(`/api/evaluations/${other.id}`).expect(204);
      await teacher1.get(`/api/evaluations/${other.id}`).expect(404);
    });

    it('las fechas del periodo no cambian si dejan evaluaciones fuera (409)', async () => {
      await adminA
        .patch(`/api/periods/${currentPeriod}`)
        .send({ endDate: addDays(today, -1) }) // hay evaluaciones con fecha de hoy
        .expect(409);
    });
  });

  describe('reemplazo de docente', () => {
    it('la carga anterior queda de solo consulta y su suma cuenta para el nuevo docente', async () => {
      const subject = (
        await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201)
      ).id;
      const old = (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId: courseA1, subjectId: subject, teacherId: teacher1Id },
          201,
        )
      ).id;
      const e = await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: old, percentage: 80 }),
        201,
      );
      const replaced = await post(
        adminA,
        `/api/teacher-assignments/${old}/replace`,
        { teacherId: teacher2Id },
        201,
      );
      // El docente anterior la consulta, pero ya no la edita ni crea en ella.
      await teacher1.get(`/api/evaluations/${e.id}`).expect(200);
      await teacher1
        .patch(`/api/evaluations/${e.id}`)
        .send({ title: 'X' })
        .expect(409);
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: old }),
        409,
      );
      // El nuevo docente: 80 ya asignado por el anterior.
      await post(
        teacher2,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: replaced.id, percentage: 21 }),
        409,
      );
      await post(
        teacher2,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: replaced.id, percentage: 20 }),
        201,
      );
    });
  });

  describe('revisión de seguridad 9a', () => {
    const newSubject = async () =>
      (await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201))
        .id;
    const newLoad = async (courseId: string, teacherId: string) =>
      (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId, subjectId: await newSubject(), teacherId },
          201,
        )
      ).id;

    it('docente que pierde el rol TEACHER en la sede del curso: 404 (aunque lo conserve en otra)', async () => {
      const t = await createTeacher([campusA1.id, campusA2.id]);
      const tsc = await newLoad(courseA2, t.id);
      const agent = await loginAs(t.user.email);
      const e = await post(
        agent,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc }),
        201,
      );
      await ctx.dataSource.query(
        `DELETE FROM user_institution_roles WHERE user_id = $1 AND campus_id = $2`,
        [t.user.id, campusA2.id],
      );
      await agent.get(`/api/evaluations/${e.id}`).expect(404);
      await agent
        .patch(`/api/evaluations/${e.id}`)
        .send({ title: 'X' })
        .expect(404);
      await post(
        agent,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc }),
        404,
      );
    });

    it('docente que además administra otra sede: periodo terminado solo donde administra', async () => {
      const t = await createTeacher();
      await ctx.data.assignGlobalRole(
        t.user.id,
        institutionA.id,
        'INSTITUTION_ADMIN',
        campusA1.id,
      );
      const inA1 = await newLoad(courseA1, t.id);
      const inA2 = await newLoad(courseA2, t.id);
      const agent = await loginAs(t.user.email);
      const closed = { periodId: pastPeriod, evaluationDate: past.start };
      await post(
        agent,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: inA2, ...closed }),
        403,
      );
      await post(
        agent,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: inA1, ...closed }),
        201,
      );
    });

    it('un rol propio que copia a TEACHER no administra evaluaciones de otros (M2)', async () => {
      const slugs = (
        await ctx.dataSource.query<{ slug: string }[]>(
          `SELECT mo.slug FROM role_menu_permissions p JOIN menu_options mo ON mo.id = p.menu_option_id
            WHERE p.role_id = (SELECT id FROM roles WHERE name = 'TEACHER' AND institution_id IS NULL)`,
        )
      ).map((r) => r.slug);
      const role = await ctx.data.createInstitutionRole(institutionA.id, slugs);
      const user = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.dataSource.query(
        'INSERT INTO user_institution_roles (user_id, institution_id, role_id) VALUES ($1, $2, $3)',
        [user.id, institutionA.id, role.id],
      );
      const agent = await loginAs(user.email);
      const list = await agent.get('/api/evaluations').expect(200);
      expect(list.body.data).toEqual([]);
      await post(agent, '/api/evaluations', evaluation(), 404);
    });

    it('año lectivo inactivo: el docente no (403), el administrador sí', async () => {
      await adminA
        .patch(`/api/academic-years/${futureYearId}`)
        .send({ isActive: false })
        .expect(200);
      try {
        const body = evaluation({
          teacherAssignmentId: tscFuture,
          periodId: futurePeriod,
          evaluationDate: future.end,
          percentage: 1,
        });
        await post(teacher1, '/api/evaluations', body, 403);
        await post(adminA, '/api/evaluations', body, 201);
      } finally {
        await adminA
          .patch(`/api/academic-years/${futureYearId}`)
          .send({ isActive: true })
          .expect(200);
      }
      expect(courseFuture).toBeDefined();
    });

    it('periodo o filtros de otra institución: 404 o lista vacía', async () => {
      const yearB = (
        await post(adminB, '/api/academic-years', { year: currentYear }, 201)
      ).id;
      const periodB = (
        await post(
          adminB,
          `/api/academic-years/${yearB}/periods`,
          { name: 'B', startDate: current.start, endDate: current.end },
          201,
        )
      ).id;
      await post(
        teacher1,
        '/api/evaluations',
        evaluation({ periodId: periodB }),
        404,
      );
      const byPeriod = await adminB
        .get(`/api/evaluations?periodId=${currentPeriod}`)
        .expect(200);
      expect(byPeriod.body.data).toEqual([]);
      const byCourse = await adminB
        .get(`/api/evaluations?courseId=${courseA1}`)
        .expect(200);
      expect(byCourse.body.data).toEqual([]);
    });

    it('administrador de sede: no edita ni borra en otra sede (404)', async () => {
      const tsc = await newLoad(courseA2, teacher2Id);
      const e = await post(
        adminA,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc }),
        201,
      );
      await campusAdminA
        .patch(`/api/evaluations/${e.id}`)
        .send({ title: 'X' })
        .expect(404);
      await campusAdminA.delete(`/api/evaluations/${e.id}`).expect(404);
    });

    it('editar y crear a la vez sin pasar de 100: uno de los dos 409', async () => {
      const tsc = await newLoad(courseA1, teacher1Id);
      const a = await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc, percentage: 50 }),
        201,
      );
      const [patch, create] = await Promise.all([
        teacher1.patch(`/api/evaluations/${a.id}`).send({ percentage: 70 }),
        teacher1
          .post('/api/evaluations')
          .send(evaluation({ teacherAssignmentId: tsc, percentage: 40 })),
      ]);
      expect([patch.status, create.status].sort()).toEqual(
        [patch.status === 200 ? 200 : 201, 409].sort(),
      );
    });

    it('con boletines, las fechas del periodo no cambian (409)', async () => {
      const yearId = (
        await post(adminA, '/api/academic-years', { year: futureYear + 1 }, 201)
      ).id;
      const periodId = (
        await post(
          adminA,
          `/api/academic-years/${yearId}/periods`,
          {
            name: 'P1',
            startDate: `${futureYear + 1}-02-01`,
            endDate: `${futureYear + 1}-03-01`,
          },
          201,
        )
      ).id;
      const user = await ctx.data.createUser({ userType: 'STUDENT' });
      const student = await ctx.dataSource.getRepository(StudentEntity).save({
        userId: user.id,
        institutionId: institutionA.id,
        campusId: campusA1.id,
      });
      await ctx.dataSource.query(
        'INSERT INTO report_cards (student_id, period_id, course_id, final_average) VALUES ($1, $2, $3, 4)',
        [student.id, periodId, courseA1],
      );
      await adminA
        .patch(`/api/periods/${periodId}`)
        .send({ endDate: `${futureYear + 1}-03-05` })
        .expect(409);
      await adminA
        .patch(`/api/periods/${periodId}`)
        .send({ name: 'Primer periodo' })
        .expect(200);
    });

    it.each([
      ['porcentaje como texto', { percentage: '20' }],
      ['título vacío', { title: '   ' }],
      ['título de más de 200', { title: 'x'.repeat(201) }],
    ])('400: %s', async (_c, extra) => {
      await post(adminA, '/api/evaluations', evaluation(extra), 400);
    });

    it('PATCH con null: 400', async () => {
      const tsc = await newLoad(courseA1, teacher1Id);
      const e = await post(
        teacher1,
        '/api/evaluations',
        evaluation({ teacherAssignmentId: tsc }),
        201,
      );
      await teacher1
        .patch(`/api/evaluations/${e.id}`)
        .send({ title: null })
        .expect(400);
    });
  });
});
