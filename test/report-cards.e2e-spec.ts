import { BadGatewayException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { schoolToday } from '../src/common/utils/school-date';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { PdfRendererService } from '../src/modules/reports/pdf-renderer.service';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

interface ReportCard {
  id: string;
  student: { id: string };
  course: { id: string };
  period: { id: string };
  finalAverage: number;
  templateId: string | null;
  outdated: boolean;
  outdatedAt: string | null;
  generatedBy: string | null;
}

interface Page {
  data: ReportCard[];
  meta: { total: number };
}

const suffix = () => randomBytes(4).toString('hex');

/** Año lectivo del año calendario anterior: un periodo ya terminado. */
const year = Number(schoolToday().slice(0, 4)) - 1;
const past = { start: `${year}-02-01`, end: `${year}-03-01` };

const TEMPLATE = Buffer.from(
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
   <h1>Propia {{institution.name}}</h1>
   {{#each subjects}}<p>{{name}} {{score final}} {{level}}</p>{{/each}}
   </body></html>`,
  'utf8',
);

describe('Boletines (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let superAdmin: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1
  let teacher1: Agent; // matemáticas en courseA1 (carga activa)
  let teacher3: Agent; // sin carga
  let teacher1Id: string;
  let student1: Agent;
  let student2: Agent;
  let adminAUserId: string;

  let period: string;
  let courseA1: string;
  let courseA1b: string; // misma sede y año, sin cargas
  let student2UserId: string;
  let s1: string;
  let s2: string;
  let s3: string; // en courseA2, sin evaluaciones
  let mathA: string; // 60 %
  let mathB: string; // 40 %
  let physics: string; // 100 %

  let card1: ReportCard; // de s1

  const server = () => ctx.app.getHttpServer();
  const url = '/api/report-cards';

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
    method: 'post' | 'put' | 'patch',
    path: string,
    body: object,
    status: number,
  ) {
    const res = await agent[method](path).send(body);
    expect({
      path,
      status: res.status,
      body: res.body as unknown,
    }).toMatchObject({ status });
    return res.body as { id: string; message?: string } & Record<
      string,
      unknown
    >;
  }
  const post = (a: Agent, path: string, body: object, status: number) =>
    send(a, 'post', path, body, status);
  const generate = (
    a: Agent,
    studentId: string,
    status: number,
    force?: boolean,
  ) =>
    send(
      a,
      'post',
      url,
      { studentId, periodId: period, ...(force ? { force } : {}) },
      status,
    ) as unknown as Promise<ReportCard & { message?: string }>;
  const scores = (
    evaluationId: string,
    rows: { studentId: string; score: number | null }[],
  ) =>
    send(
      adminA,
      'put',
      `/api/evaluations/${evaluationId}/scores`,
      { scores: rows },
      200,
    );
  const list = async (a: Agent, query = '') =>
    (await a.get(`${url}${query}`).expect(200)).body as Page;
  const cardOf = async (studentId: string) =>
    (await list(adminA, `?studentId=${studentId}`)).data[0];

  async function createTeacher() {
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
    return { id: profile.id, email: user.email, userId: user.id };
  }

  /** Captura el HTML que se imprime (y lo imprime de verdad). */
  function captureHtml(): { html: () => string; restore: () => void } {
    const renderer = ctx.app.get(PdfRendererService);
    const original = renderer.render.bind(renderer);
    let last = '';
    const spy = jest
      .spyOn(renderer, 'render')
      .mockImplementation((html: string) => {
        last = html;
        return original(html);
      });
    return { html: () => last, restore: () => spy.mockRestore() };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');
    campusA2 = await data.createCampus(institutionA.id, 'Sede A2');

    const superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
    const adminAUser = await data.createUser();
    adminAUserId = adminAUser.id;
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
    superAdmin = await loginAs(superUser.email);
    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminUser.email);

    // createInstitution escribe directo en la base: sin niveles por defecto.
    await send(
      adminA,
      'put',
      '/api/performance-levels',
      {
        levels: [
          { name: 'Bajo', minScore: 1, maxScore: 2.99 },
          { name: 'Básico', minScore: 3, maxScore: 3.99 },
          { name: 'Alto', minScore: 4, maxScore: 4.59 },
          { name: 'Superior', minScore: 4.6, maxScore: 5 },
        ],
      },
      200,
    );

    const t1 = await createTeacher();
    const t2 = await createTeacher();
    const t3 = await createTeacher();
    teacher1 = t1.agent;
    teacher1Id = t1.id;
    teacher3 = t3.agent;

    const yearId = (await post(adminA, '/api/academic-years', { year }, 201))
      .id;
    period = (
      await post(
        adminA,
        `/api/academic-years/${yearId}/periods`,
        { name: 'Primero', startDate: past.start, endDate: past.end },
        201,
      )
    ).id;
    const gradeId = (await post(adminA, '/api/grades', { name: 'Sexto' }, 201))
      .id;
    const math = (
      await post(adminA, '/api/subjects', { name: 'Matemáticas' }, 201)
    ).id;
    const phys = (await post(adminA, '/api/subjects', { name: 'Física' }, 201))
      .id;
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
    courseA1b = await course(campusA1.id);
    const courseA2 = await course(campusA2.id);
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
    const tscMath = await load(courseA1, math, t1.id);
    const tscPhys = await load(courseA1, phys, t2.id);
    await load(courseA2, math, t2.id);

    const st1 = await createStudent(campusA1.id);
    const st2 = await createStudent(campusA1.id);
    const st3 = await createStudent(campusA2.id);
    [s1, s2, s3] = [st1.id, st2.id, st3.id];
    student2UserId = st2.userId;
    for (const [studentId, courseId] of [
      [s1, courseA1],
      [s2, courseA1],
      [s3, courseA2],
    ]) {
      await post(adminA, '/api/enrollments', { studentId, courseId }, 201);
    }
    student1 = await loginAs(st1.email);
    student2 = await loginAs(st2.email);

    const evaluation = async (tsc: string, percentage: number) =>
      (
        await post(
          adminA,
          '/api/evaluations',
          {
            teacherAssignmentId: tsc,
            periodId: period,
            title: `Taller ${suffix()}`,
            percentage,
            evaluationDate: past.start,
          },
          201,
        )
      ).id;
    mathA = await evaluation(tscMath, 60);
    mathB = await evaluation(tscMath, 40);
    physics = await evaluation(tscPhys, 100);
    // s1: matemáticas completa (4.6 * 0.6 + 4.0 * 0.4 = 4.36), física pendiente.
    await scores(mathA, [
      { studentId: s1, score: 4.6 },
      { studentId: s2, score: 3 },
    ]);
    await scores(mathB, [
      { studentId: s1, score: 4 },
      { studentId: s2, score: 3 },
    ]);
  }, 180_000);

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('POST /report-cards', () => {
    it('sin ninguna definitiva: 409 aunque venga force', async () => {
      const body = await generate(adminA, s3, 409, true);
      expect(body.message).toMatch(/ninguna definitiva/);
    });

    it('con materias pendientes: 409 con sus nombres; con force se genera con promedio parcial', async () => {
      const body = await generate(adminA, s1, 409);
      expect(body.message).toMatch(/Física/);
      expect(body.message).not.toMatch(/Matemáticas/);

      const capture = captureHtml();
      try {
        card1 = await generate(adminA, s1, 201, true);
      } finally {
        capture.restore();
      }
      expect(card1).toMatchObject({
        student: { id: s1 },
        course: { id: courseA1 },
        period: { id: period },
        finalAverage: 4.36,
        templateId: null,
        outdated: false,
        outdatedAt: null,
        generatedBy: adminAUserId,
      });
      const html = capture.html();
      expect(html).toContain('Matemáticas');
      expect(html).toContain('4,36');
      expect(html).toContain('Física');
      expect(html).toMatch(/Alto/); // 4.36 es Alto en la escala nacional
      // El PDF está en el bucket privado con nombre generado por el servidor.
      const files = [...ctx.storage.objects.keys()].filter((k) =>
        k.startsWith(`report-cards/${institutionA.id}/report-cards/`),
      );
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\/[0-9a-f-]{36}\.pdf$/);
      expect(
        ctx.storage.objects.get(files[0])!.buffer.subarray(0, 5).toString(),
      ).toBe('%PDF-');
    });

    it('validación: ids inválidos o campos extra, 400', async () => {
      await generate(adminA, 'no-es-uuid', 400);
      await post(
        adminA,
        url,
        { studentId: s1, periodId: period, extra: true },
        400,
      );
    });

    it('otra sede, otra institución o sin permiso de generar', async () => {
      // s3 está en la sede A2: el administrador de A1 no lo ve.
      await generate(campusAdminA, s3, 404);
      await generate(adminB, s1, 404); // el periodo no es de su institución
      await post(teacher1, url, { studentId: s1, periodId: period }, 403);
      await post(student1, url, { studentId: s1, periodId: period }, 403);
    });

    it('el administrador de la sede del curso también genera', async () => {
      const card = await generate(campusAdminA, s2, 201, true);
      expect(card.finalAverage).toBe(3);
    });
  });

  describe('desactualizado y regenerado (B4)', () => {
    it('una nota nueva marca el boletín; regenerarlo lo deja vigente y reemplaza el PDF', async () => {
      const before = [...ctx.storage.objects.keys()];
      await scores(physics, [{ studentId: s1, score: 5 }]);
      const outdated = await cardOf(s1);
      expect(outdated.outdated).toBe(true);
      expect(outdated.outdatedAt).not.toBeNull();
      // El de s2 no cambió.
      expect((await cardOf(s2)).outdated).toBe(false);
      expect(
        (await list(adminA, '?outdated=true')).data.map((c) => c.id),
      ).toEqual([card1.id]);

      // Ya no faltan definitivas: sin force.
      const again = await generate(adminA, s1, 201);
      expect(again).toMatchObject({
        id: card1.id,
        outdated: false,
        finalAverage: 4.68, // (4.36 + 5) / 2
      });
      const after = [...ctx.storage.objects.keys()];
      expect(after).toHaveLength(before.length);
      expect(after.filter((k) => !before.includes(k))).toHaveLength(1);
    });

    it('cambiar el porcentaje de una evaluación marca todos los del curso y periodo', async () => {
      await send(
        adminA,
        'patch',
        `/api/evaluations/${mathB}`,
        { percentage: 30 },
        200,
      );
      expect((await cardOf(s1)).outdated).toBe(true);
      expect((await cardOf(s2)).outdated).toBe(true);
      await send(
        adminA,
        'patch',
        `/api/evaluations/${mathB}`,
        { percentage: 40 },
        200,
      );
      await generate(adminA, s1, 201);
      await generate(adminA, s2, 201, true);
      expect((await list(adminA, '?outdated=true')).meta.total).toBe(0);
    });

    it('si una nota cambia mientras se imprime: 409 y no queda el PDF nuevo', async () => {
      const renderer = ctx.app.get(PdfRendererService);
      const original = renderer.render.bind(renderer);
      const spy = jest
        .spyOn(renderer, 'render')
        .mockImplementation(async (html: string) => {
          const pdf = await original(html);
          // Otra persona corrige una nota mientras tanto.
          await scores(physics, [{ studentId: s1, score: 4 }]);
          return pdf;
        });
      const before = ctx.storage.objects.size;
      try {
        const body = await generate(adminA, s1, 409);
        expect(body.message).toMatch(/cambiaron/);
      } finally {
        spy.mockRestore();
      }
      expect(ctx.storage.objects.size).toBe(before);
      // El boletín anterior queda, pero desactualizado.
      expect((await cardOf(s1)).outdated).toBe(true);
      await generate(adminA, s1, 201);
    });
  });

  describe('plantilla de la institución', () => {
    it('usa la plantilla activa y guarda template_id; ya usada, no se borra', async () => {
      const templatesUrl = `/api/institutions/${institutionA.id}/report-card-templates`;
      const template = (
        await superAdmin
          .post(templatesUrl)
          .field('name', `Propia ${suffix()}`)
          .attach('file', TEMPLATE, {
            filename: 'boletin.html',
            contentType: 'text/html',
          })
          .expect(201)
      ).body as { id: string };
      await superAdmin
        .patch(`${templatesUrl}/${template.id}/activate`)
        .expect(200);
      const capture = captureHtml();
      let card: ReportCard;
      try {
        card = await generate(adminA, s1, 201);
      } finally {
        capture.restore();
      }
      expect(card.templateId).toBe(template.id);
      expect(capture.html()).toContain('Propia Colegio A');
      await superAdmin.delete(`${templatesUrl}/${template.id}`).expect(409);
      await superAdmin
        .patch(`${templatesUrl}/${template.id}/deactivate`)
        .expect(200);
      expect((await generate(adminA, s1, 201)).templateId).toBeNull();
    });
  });

  describe('GET /report-cards, /mine y /:id/download', () => {
    it('el administrador ve los de su institución; el de sede, los de sus sedes', async () => {
      expect((await list(adminA)).meta.total).toBe(2);
      expect((await list(campusAdminA)).meta.total).toBe(2);
      expect((await list(adminB)).meta.total).toBe(0);
      expect(
        (await list(adminA, `?courseId=${courseA1}&periodId=${period}`)).meta
          .total,
      ).toBe(2);
    });

    it('el docente no ve boletines, aunque tenga carga en el curso (M1): 403', async () => {
      await teacher1.get(url).expect(403);
      await teacher1.get(`${url}/${card1.id}/download`).expect(403);
      await teacher3.get(`${url}/${card1.id}/download`).expect(403);
    });

    it('un estudiante que además es docente no ve boletines ajenos', async () => {
      await ctx.data.assignGlobalRole(
        student2UserId,
        institutionA.id,
        'TEACHER',
      );
      await student2.get(`${url}/${card1.id}/download`).expect(404);
      expect((await list(student2)).meta.total).toBe(0);
    });

    it('el estudiante ve y descarga solo los suyos', async () => {
      const mine = (await student1.get(`${url}/mine`).expect(200))
        .body as ReportCard[];
      expect(mine.map((c) => c.id)).toEqual([card1.id]);
      // Sin quién lo generó ni la plantilla (B4).
      expect(Object.keys(mine[0]).sort()).toEqual([
        'course',
        'finalAverage',
        'generatedAt',
        'id',
        'outdated',
        'period',
      ]);
      const res = await student1.get(`${url}/${card1.id}/download`).expect(200);
      expect(res.body).toEqual({
        url: expect.stringContaining('/report-cards/') as string,
        expiresIn: 120,
      });
      await student2.get(`${url}/${card1.id}/download`).expect(404);
      expect((await list(student2)).meta.total).toBe(0);
    });

    it('otra institución: 404 al descargar; id inválido: 400', async () => {
      await adminB.get(`${url}/${card1.id}/download`).expect(404);
      await adminA.get(`${url}/no-es-uuid/download`).expect(400);
      await adminA.get(`${url}?outdated=quizas`).expect(400);
    });

    it('nunca expone la ruta del PDF', async () => {
      const page = await list(adminA);
      expect(JSON.stringify(page)).not.toMatch(/pdfPath|report-cards\//);
    });
  });
  describe('otros cambios que lo desactualizan (M2)', () => {
    const levels = (altoMax: number, top: number) => ({
      levels: [
        { name: 'Bajo', minScore: 1, maxScore: 2.99 },
        { name: 'Básico', minScore: 3, maxScore: 3.99 },
        { name: 'Alto', minScore: 4, maxScore: altoMax },
        { name: 'Superior', minScore: top, maxScore: 5 },
      ],
    });
    const outdatedTotal = async () =>
      (await list(adminA, '?outdated=true')).meta.total;

    it('niveles iguales: no marca; niveles distintos: marca todos los del año activo', async () => {
      expect(await outdatedTotal()).toBe(0);
      await send(
        adminA,
        'put',
        '/api/performance-levels',
        levels(4.59, 4.6),
        200,
      );
      expect(await outdatedTotal()).toBe(0);
      await send(
        adminA,
        'put',
        '/api/performance-levels',
        levels(4.49, 4.5),
        200,
      );
      expect(await outdatedTotal()).toBe(2);
      await send(
        adminA,
        'put',
        '/api/performance-levels',
        levels(4.59, 4.6),
        200,
      );
      await generate(adminA, s1, 201);
      await generate(adminA, s2, 201, true);
    });

    it('si Storage falla al subir: 502 y el boletín no cambia', async () => {
      const before = await cardOf(s1);
      const spy = jest
        .spyOn(ctx.storage, 'upload')
        .mockRejectedValueOnce(
          new BadGatewayException('No se pudo guardar el archivo'),
        );
      try {
        await generate(adminA, s1, 502);
      } finally {
        spy.mockRestore();
      }
      expect(await cardOf(s1)).toEqual(before);
    });

    it('límite de 10 generaciones por minuto (429)', async () => {
      process.env.THROTTLE_DISABLED = 'false';
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
          // Cuerpo inválido: el límite se cuenta antes de validar.
          statuses.push((await campusAdminA.post(url).send({})).status);
        }
        expect(statuses.slice(0, 10).every((st) => st === 400)).toBe(true);
        expect(statuses[10]).toBe(429);
      } finally {
        process.env.THROTTLE_DISABLED = 'true';
      }
    });

    it('una materia nueva en el curso marca todos sus boletines', async () => {
      const subject = (
        await post(adminA, '/api/subjects', { name: `Arte ${suffix()}` }, 201)
      ).id;
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1, subjectId: subject, teacherId: teacher1Id },
        201,
      );
      expect((await cardOf(s1)).outdated).toBe(true);
      expect((await cardOf(s2)).outdated).toBe(true);
      // La materia nueva sale como pendiente.
      const body = await generate(adminA, s1, 409);
      expect(body.message).toMatch(/Arte/);
      await generate(adminA, s1, 201, true);
    });

    it('un cambio de curso marca el boletín anterior del estudiante', async () => {
      const enrollment = (
        (await adminA.get(`/api/enrollments?studentId=${s1}`).expect(200))
          .body as { data: { id: string }[] }
      ).data[0];
      await send(
        adminA,
        'patch',
        `/api/enrollments/${enrollment.id}`,
        { courseId: courseA1b },
        200,
      );
      const card = await cardOf(s1);
      expect(card).toMatchObject({ course: { id: courseA1 }, outdated: true });
      // En el curso nuevo no tiene ninguna definitiva.
      await generate(adminA, s1, 409, true);
    });
  });
});
