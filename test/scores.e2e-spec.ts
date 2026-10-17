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

interface ScoreRow {
  studentId: string;
  score: number | null;
  status: string;
  enrollmentStatus: string | null;
}

interface Grade {
  subjectId?: string;
  periodId?: string;
  accumulated: number;
  final: number | null;
  passed: boolean | null;
  evaluations?: { id: string; score: number | null }[];
}

interface StudentGradebook {
  subjects: {
    id: string;
    periods: Grade[];
    yearFinal?: number | null;
    yearPassed?: boolean | null;
  }[];
  periodAverages: { periodId: string; average: number | null }[];
  yearAverage?: number | null;
}

const suffix = () => randomBytes(4).toString('hex');

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Fechas relativas a hoy (Colombia), como en evaluations.e2e-spec: año
 * lectivo "actual" = año calendario anterior al de hoy, con un periodo
 * terminado (feb-mar) y uno en curso (dic hasta después de hoy, calendario
 * B); año "futuro" = año siguiente al de hoy (su periodo aún no empieza).
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

describe('Notas y cuadro de notas (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1
  let teacher1: Agent; // matemáticas en courseA1
  let teacher2: Agent; // física en courseA1 y matemáticas en courseA2
  let teacher3: Agent; // sin carga
  let student1: Agent;
  let teacher1Id: string;

  let yearId: string;
  let currentPeriod: string;
  let pastPeriod: string;
  let futurePeriod: string;
  let math: string;
  let physics: string;
  let courseA1: string;
  let courseA2: string;
  let tsc1: string;
  let tscFuture: string; // matemáticas del año futuro, teacher1
  let tscA2: string;
  let s1: string;
  let s2: string;
  let s3: string; // en courseA2

  let e1: string; // 60 %, periodo en curso, tsc1
  let e2: string; // 40 %, periodo en curso, tsc1
  let ePast: string; // 100 %, periodo terminado, tsc1

  const server = () => ctx.app.getHttpServer();

  async function loginAs(identifier: string | null): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  async function send(
    agent: Agent,
    method: 'post' | 'put',
    url: string,
    body: object,
    status: number,
  ) {
    const res = await agent[method](url).send(body);
    expect({
      url,
      status: res.status,
      body: res.body as unknown,
    }).toMatchObject({ status });
    return res.body as { id: string } & Record<string, unknown>;
  }
  const post = (a: Agent, url: string, body: object, status: number) =>
    send(a, 'post', url, body, status);
  const putScores = (
    a: Agent,
    evaluationId: string,
    scores: { studentId: string; score: number | null }[],
    status: number,
  ) =>
    send(
      a,
      'put',
      `/api/evaluations/${evaluationId}/scores`,
      { scores },
      status,
    );

  async function createTeacher(): Promise<{ id: string; agent: Agent }> {
    const user = await ctx.data.createUser({ userType: 'TEACHER' });
    await ctx.data.assignGlobalRole(user.id, institutionA.id, 'TEACHER');
    const profile = await ctx.dataSource
      .getRepository(TeacherEntity)
      .save({ userId: user.id, institutionId: institutionA.id });
    return { id: profile.id, agent: await loginAs(user.email) };
  }

  async function createStudent(campusId: string) {
    const user = await ctx.data.createUser({ userType: 'STUDENT' });
    await ctx.data.assignGlobalRole(user.id, institutionA.id, 'STUDENT');
    const profile = await ctx.dataSource
      .getRepository(StudentEntity)
      .save({ userId: user.id, institutionId: institutionA.id, campusId });
    return { id: profile.id, email: user.email };
  }

  const evaluation = async (
    agent: Agent,
    teacherAssignmentId: string,
    periodId: string,
    percentage: number,
    evaluationDate: string,
  ) =>
    (
      await post(
        agent,
        '/api/evaluations',
        {
          teacherAssignmentId,
          periodId,
          title: `Taller ${suffix()}`,
          percentage,
          evaluationDate,
        },
        201,
      )
    ).id;

  const scoresOf = async (agent: Agent, evaluationId: string) =>
    (await agent.get(`/api/evaluations/${evaluationId}/scores`).expect(200))
      .body as { students: ScoreRow[] };

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
    const t3 = await createTeacher();
    teacher1Id = t1.id;
    teacher1 = t1.agent;
    teacher2 = t2.agent;
    teacher3 = t3.agent;

    yearId = (
      await post(adminA, '/api/academic-years', { year: currentYear }, 201)
    ).id;
    const futureYearId = (
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

    const gradeId = (await post(adminA, '/api/grades', { name: 'Sexto' }, 201))
      .id;
    math = (await post(adminA, '/api/subjects', { name: 'Matemáticas' }, 201))
      .id;
    physics = (await post(adminA, '/api/subjects', { name: 'Física' }, 201)).id;
    const course = async (campusId: string) =>
      (
        await post(
          adminA,
          '/api/courses',
          { name: `60${suffix()}`, gradeId, campusId, academicYearId: yearId },
          201,
        )
      ).id;
    courseA1 = await course(campusA1.id);
    courseA2 = await course(campusA2.id);
    const load = async (
      courseId: string,
      subjectId: string,
      teacherId: string,
    ) =>
      (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId, subjectId, teacherId },
          201,
        )
      ).id;
    tsc1 = await load(courseA1, math, t1.id);
    await load(courseA1, physics, t2.id);
    tscA2 = await load(courseA2, math, t2.id);
    const courseFuture = (
      await post(
        adminA,
        '/api/courses',
        {
          name: `60${suffix()}`,
          gradeId,
          campusId: campusA1.id,
          academicYearId: futureYearId,
        },
        201,
      )
    ).id;
    tscFuture = await load(courseFuture, math, t1.id);

    const st1 = await createStudent(campusA1.id);
    const st2 = await createStudent(campusA1.id);
    const st3 = await createStudent(campusA2.id);
    [s1, s2, s3] = [st1.id, st2.id, st3.id];
    for (const [studentId, courseId] of [
      [s1, courseA1],
      [s2, courseA1],
      [s3, courseA2],
    ]) {
      await post(adminA, '/api/enrollments', { studentId, courseId }, 201);
    }
    student1 = await loginAs(st1.email);

    e1 = await evaluation(teacher1, tsc1, currentPeriod, 60, today);
    e2 = await evaluation(teacher1, tsc1, currentPeriod, 40, today);
    ePast = await evaluation(adminA, tsc1, pastPeriod, 100, past.start);
  }, 180_000);

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('GET y PUT /evaluations/:id/scores', () => {
    it('lista a los matriculados como pendientes, con la escala y sin datos de contacto', async () => {
      const res = await teacher1
        .get(`/api/evaluations/${e1}/scores`)
        .expect(200);
      expect(res.body).toMatchObject({
        evaluation: { id: e1, percentage: 60 },
        scale: { min: 1, max: 5, passingScore: 3 },
      });
      const students = (res.body as { students: ScoreRow[] }).students;
      expect(students.map((s) => s.studentId).sort()).toEqual([s1, s2].sort());
      expect(students.every((s) => s.status === 'PENDING')).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(
        /documentNumber|email|bloodType/,
      );
    });

    it('el docente registra en lote y null quita la nota', async () => {
      const body = await putScores(
        teacher1,
        e1,
        [
          { studentId: s1, score: 4.5 },
          { studentId: s2, score: 2 },
        ],
        200,
      );
      const rows = (body as unknown as { students: ScoreRow[] }).students;
      expect(rows.find((r) => r.studentId === s1)).toMatchObject({
        score: 4.5,
        status: 'GRADED',
        enrollmentStatus: 'ENROLLED',
      });
      await putScores(teacher1, e1, [{ studentId: s2, score: null }], 200);
      const after = await scoresOf(teacher1, e1);
      expect(after.students.find((r) => r.studentId === s2)).toMatchObject({
        score: null,
        status: 'PENDING',
      });
    });

    it('todo o nada: 400 con el error de cada fila y sin cambios', async () => {
      const res = await teacher1
        .put(`/api/evaluations/${e1}/scores`)
        .send({
          scores: [
            { studentId: s1, score: 5.5 },
            { studentId: s3, score: 4 },
            { studentId: s2, score: 3 },
          ],
        })
        .expect(400);
      const message = (res.body as { message: string[] }).message;
      expect(message).toHaveLength(2);
      expect(message[0]).toMatch(/^scores\[0\].*entre 1 y 5/);
      expect(message[1]).toMatch(/^scores\[1\].*matrícula vigente/);
      const after = await scoresOf(teacher1, e1);
      expect(after.students.find((r) => r.studentId === s1)?.score).toBe(4.5);
      expect(after.students.find((r) => r.studentId === s2)?.score).toBeNull();
    });

    it.each([
      ['lote vacío', { scores: [] }],
      ['nota con 3 decimales', { scores: [{ studentId: 'S1', score: 4.001 }] }],
      ['sin score', { scores: [{ studentId: 'S1' }] }],
      ['campos extra', { scores: [{ studentId: 'S1', score: 4, x: 1 }] }],
      ['studentId inválido', { scores: [{ studentId: 'x', score: 4 }] }],
    ])('400: %s', async (_c, body) => {
      const json = JSON.stringify(body).replace('S1', s1);
      await teacher1
        .put(`/api/evaluations/${e1}/scores`)
        .send(JSON.parse(json) as object)
        .expect(400);
    });

    it('estudiante repetido en el lote: 400', async () => {
      await putScores(
        teacher1,
        e1,
        [
          { studentId: s1, score: 4 },
          { studentId: s1, score: 3 },
        ],
        400,
      );
    });

    it('otro docente, otra institución u otra sede: 404', async () => {
      await putScores(teacher2, e1, [{ studentId: s1, score: 4 }], 404);
      await adminB.get(`/api/evaluations/${e1}/scores`).expect(404);
      await putScores(adminB, e1, [{ studentId: s1, score: 4 }], 404);
      const eA2 = await evaluation(adminA, tscA2, currentPeriod, 10, today);
      await campusAdminA.get(`/api/evaluations/${eA2}/scores`).expect(404);
      await putScores(campusAdminA, eA2, [{ studentId: s3, score: 4 }], 404);
    });

    it('el administrador de la sede del curso califica', async () => {
      await putScores(campusAdminA, e2, [{ studentId: s1, score: 3 }], 200);
    });

    it('el estudiante no ve el listado (404) ni registra (403)', async () => {
      await student1.get(`/api/evaluations/${e1}/scores`).expect(404);
      await putScores(student1, e1, [{ studentId: s1, score: 5 }], 403);
    });

    it('periodo terminado: el docente no (403), el administrador corrige', async () => {
      await putScores(teacher1, ePast, [{ studentId: s1, score: 4 }], 403);
      await putScores(adminA, ePast, [{ studentId: s1, score: 4 }], 200);
    });

    it('periodo que aún no empieza: el docente planea pero no califica (403)', async () => {
      const id = await evaluation(
        teacher1,
        tscFuture,
        futurePeriod,
        10,
        future.start,
      );
      await putScores(teacher1, id, [{ studentId: s1, score: 4 }], 403);
    });

    it('carga inactiva: el docente consulta (409 al registrar) y el administrador corrige; el cuadro ya no se la muestra', async () => {
      const subject = (
        await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201)
      ).id;
      const tsc = (
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId: courseA2, subjectId: subject, teacherId: teacher1Id },
          201,
        )
      ).id;
      const id = await evaluation(teacher1, tsc, currentPeriod, 50, today);
      await putScores(teacher1, id, [{ studentId: s3, score: 3 }], 200);
      const gradebook = `/api/gradebook/courses/${courseA2}?periodId=${currentPeriod}`;
      await teacher1.get(gradebook).expect(200);
      await adminA
        .patch(`/api/teacher-assignments/${tsc}/deactivate`)
        .expect(200);
      await putScores(teacher1, id, [{ studentId: s3, score: 4 }], 409);
      await teacher1.get(`/api/evaluations/${id}/scores`).expect(200);
      // Reemplazado: no ve el cuadro del curso ni al estudiante (M1).
      await teacher1.get(gradebook).expect(404);
      await teacher1
        .get(`/api/gradebook/students/${s3}?periodId=${currentPeriod}`)
        .expect(404);
      const body = await putScores(
        adminA,
        id,
        [{ studentId: s3, score: 4 }],
        200,
      );
      expect(
        (body as unknown as { students: ScoreRow[] }).students.find(
          (r) => r.studentId === s3,
        )?.score,
      ).toBe(4);
    });

    it('estudiante retirado: el docente no quita su nota (400); el administrador sí', async () => {
      const st = await createStudent(campusA1.id);
      const enrollment = await post(
        adminA,
        '/api/enrollments',
        { studentId: st.id, courseId: courseA1 },
        201,
      );
      await putScores(teacher1, e2, [{ studentId: st.id, score: 4 }], 200);
      await adminA
        .patch(`/api/enrollments/${enrollment.id}`)
        .send({ status: 'DROPPED' })
        .expect(200);
      const res = await teacher1
        .put(`/api/evaluations/${e2}/scores`)
        .send({ scores: [{ studentId: st.id, score: null }] })
        .expect(400);
      expect((res.body as { message: string[] }).message[0]).toMatch(
        /solo un administrador puede quitar su nota/,
      );
      // Tampoco se le registra una nota nueva.
      await putScores(teacher1, e2, [{ studentId: st.id, score: 5 }], 400);
      const rows = await scoresOf(teacher1, e2);
      expect(rows.students.find((r) => r.studentId === st.id)).toMatchObject({
        score: 4,
        enrollmentStatus: 'DROPPED',
      });
      await putScores(adminA, e2, [{ studentId: st.id, score: null }], 200);
    });

    it('lotes simultáneos sobre la misma evaluación: ambos 200, sin errores', async () => {
      const statuses = (
        await Promise.all(
          [4, 5].map((score) =>
            teacher1
              .put(`/api/evaluations/${e1}/scores`)
              .send({ scores: [{ studentId: s1, score }] }),
          ),
        )
      ).map((r) => r.status);
      expect(statuses).toEqual([200, 200]);
      await putScores(teacher1, e1, [{ studentId: s1, score: 4.5 }], 200);
    });
  });

  describe('GET /gradebook/courses/:courseId', () => {
    // s1: e1 = 4.5 (60 %), e2 = 3 (40 %) -> 2.7 + 1.2 = 3.9. s2: sin notas.
    it('acumulado, definitiva y promedio; el administrador ve todas las materias', async () => {
      const res = await adminA
        .get(`/api/gradebook/courses/${courseA1}?periodId=${currentPeriod}`)
        .expect(200);
      const body = res.body as {
        subjects: { id: string }[];
        students: {
          student: { id: string };
          subjects: Grade[];
          average: number | null;
        }[];
      };
      expect(body.subjects.map((s) => s.id).sort()).toEqual(
        [math, physics].sort(),
      );
      const row1 = body.students.find((s) => s.student.id === s1);
      expect(row1?.subjects.find((g) => g.subjectId === math)).toMatchObject({
        evaluationCount: 2,
        scoredCount: 2,
        allocatedPercentage: 100,
        accumulated: 3.9,
        final: 3.9,
        passed: true,
      });
      expect(row1?.subjects.find((g) => g.subjectId === physics)).toMatchObject(
        { evaluationCount: 0, final: null, passed: null },
      );
      expect(row1?.average).toBe(3.9);
      const row2 = body.students.find((s) => s.student.id === s2);
      expect(row2?.subjects.find((g) => g.subjectId === math)).toMatchObject({
        scoredCount: 0,
        accumulated: 0,
        final: null,
      });
      expect(row2?.average).toBeNull();
      expect(body.students.some((s) => s.student.id === s3)).toBe(false);
    });

    it('al docente, solo sus materias', async () => {
      const mine = await teacher1
        .get(`/api/gradebook/courses/${courseA1}?periodId=${currentPeriod}`)
        .expect(200);
      expect(
        (mine.body as { subjects: { id: string }[] }).subjects.map((s) => s.id),
      ).toEqual([math]);
      const other = await teacher2
        .get(`/api/gradebook/courses/${courseA1}?periodId=${currentPeriod}`)
        .expect(200);
      expect(
        (other.body as { subjects: { id: string }[] }).subjects.map(
          (s) => s.id,
        ),
      ).toEqual([physics]);
    });

    it('sin carga en el curso, otra institución u otra sede: 404', async () => {
      const url = `/api/gradebook/courses/${courseA1}?periodId=${currentPeriod}`;
      await teacher3.get(url).expect(404);
      await adminB.get(url).expect(404);
      await campusAdminA
        .get(`/api/gradebook/courses/${courseA2}?periodId=${currentPeriod}`)
        .expect(404);
      await student1.get(url).expect(404);
    });

    it('periodo de otro año: 400; sin periodo: 400', async () => {
      await adminA
        .get(`/api/gradebook/courses/${courseA1}?periodId=${futurePeriod}`)
        .expect(400);
      await adminA.get(`/api/gradebook/courses/${courseA1}`).expect(400);
    });
  });

  describe('GET /gradebook/students/:studentId y /gradebook/mine', () => {
    // Matemáticas de s1: terminado 4 (corrección del administrador), en curso 3.9.
    it('por año: nota anual = promedio simple de los periodos (null si falta alguno)', async () => {
      const res = await adminA
        .get(`/api/gradebook/students/${s1}?academicYearId=${yearId}`)
        .expect(200);
      const body = res.body as StudentGradebook;
      const mathRow = body.subjects.find((s) => s.id === math);
      const finals = mathRow?.periods.map((p) => [p.periodId, p.final]);
      expect(finals).toEqual(
        expect.arrayContaining([
          [pastPeriod, 4],
          [currentPeriod, 3.9],
        ]),
      );
      expect(mathRow).toMatchObject({ yearFinal: 3.95, yearPassed: true });
      // Física sin evaluaciones: sin nota anual; el promedio anual es el de matemáticas.
      expect(body.subjects.find((s) => s.id === physics)).toMatchObject({
        yearFinal: null,
        yearPassed: null,
      });
      expect(body.yearAverage).toBe(3.95);
      expect(
        body.periodAverages.find((p) => p.periodId === currentPeriod)?.average,
      ).toBe(3.9);
      // s2 no tiene la definitiva del periodo en curso: sin nota anual.
      const other = await adminA
        .get(`/api/gradebook/students/${s2}?academicYearId=${yearId}`)
        .expect(200);
      expect(
        (other.body as StudentGradebook).subjects.find((s) => s.id === math)
          ?.yearFinal,
      ).toBeNull();
    });

    it('por periodo: sin nota anual y con el detalle de las evaluaciones', async () => {
      const res = await adminA
        .get(`/api/gradebook/students/${s1}?periodId=${currentPeriod}`)
        .expect(200);
      const body = res.body as StudentGradebook;
      expect(body).not.toHaveProperty('yearAverage');
      const period = body.subjects.find((s) => s.id === math)?.periods[0];
      expect(period?.evaluations?.map((e) => [e.id, e.score])).toEqual(
        expect.arrayContaining([
          [e1, 4.5],
          [e2, 3],
        ]),
      );
    });

    it('periodId y academicYearId a la vez: 400', async () => {
      await adminA
        .get(
          `/api/gradebook/students/${s1}?periodId=${currentPeriod}&academicYearId=${yearId}`,
        )
        .expect(400);
    });

    it('el docente ve solo sus materias; sin relación, otra institución o el propio estudiante: 404', async () => {
      const res = await teacher2
        .get(`/api/gradebook/students/${s1}?periodId=${currentPeriod}`)
        .expect(200);
      expect((res.body as StudentGradebook).subjects.map((s) => s.id)).toEqual([
        physics,
      ]);
      const url = `/api/gradebook/students/${s1}?periodId=${currentPeriod}`;
      await teacher3.get(url).expect(404);
      await adminB.get(url).expect(404);
      await student1.get(url).expect(404);
      await campusAdminA
        .get(`/api/gradebook/students/${s3}?periodId=${currentPeriod}`)
        .expect(404);
    });

    it('/gradebook/mine: el estudiante ve todas sus materias del año activo', async () => {
      const res = await student1.get('/api/gradebook/mine').expect(200);
      const body = res.body as StudentGradebook & {
        academicYear: { id: string };
        student: { id: string };
      };
      expect(body.student.id).toBe(s1);
      expect(body.academicYear.id).toBe(yearId);
      expect(body.subjects.map((s) => s.id).sort()).toEqual(
        [math, physics].sort(),
      );
      expect(JSON.stringify(body)).not.toMatch(/documentNumber|email/);
    });

    it('/gradebook/mine sin perfil de estudiante: 404', async () => {
      await teacher1.get('/api/gradebook/mine').expect(404);
    });
  });
});
