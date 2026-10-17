import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { TeacherSubjectCourseEntity } from '../src/modules/academic/entities/teacher-subject-course.entity';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { EnrollmentEntity } from '../src/modules/enrollments/entities/enrollment.entity';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const suffix = () => randomBytes(4).toString('hex');

describe('Académico: años, periodos, grados, materias y cursos (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;
  let inactiveCampusA: CampusEntity;
  let campusB: CampusEntity;

  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1
  let teacherA: Agent; // rol TEACHER: ve cursos y materias, nada más de aquí

  const server = () => ctx.app.getHttpServer();

  async function loginAs(identifier: string | null): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password: TEST_PASSWORD })
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
    inactiveCampusA = await data.createCampus(institutionA.id, 'Sede cerrada');
    await ctx.dataSource
      .getRepository(CampusEntity)
      .update({ id: inactiveCampusA.id }, { isActive: false });
    campusB = await data.createCampus(institutionB.id, 'Sede B');

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

    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminUser.email);
    teacherA = await loginAs(teacherUser.email);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  /** Año sin usar por otras pruebas de esta institución (UNIQUE por institución). */
  let nextYear = 2030;
  async function createYear(agent: Agent = adminA): Promise<string> {
    const res = await agent
      .post('/api/academic-years')
      .send({ year: nextYear++ })
      .expect(201);
    return res.body.id as string;
  }

  describe('/academic-years', () => {
    let year2026Id: string;

    it('crea, y el mismo año en la misma institución da 409 (en otra no)', async () => {
      const res = await adminA
        .post('/api/academic-years')
        .send({ year: 2026 })
        .expect(201);
      expect(res.body).toMatchObject({
        institutionId: institutionA.id,
        year: 2026,
        isActive: true,
      });
      year2026Id = res.body.id as string;
      await adminA.post('/api/academic-years').send({ year: 2026 }).expect(409);
      await adminB.post('/api/academic-years').send({ year: 2026 }).expect(201);
    });

    it('valida el año y no acepta campos extra (400)', async () => {
      await adminA.post('/api/academic-years').send({ year: 1999 }).expect(400);
      await adminA
        .post('/api/academic-years')
        .send({ year: 2027, institutionId: institutionB.id })
        .expect(400);
    });

    it('lista los de la institución activa y filtra por estado', async () => {
      const res = await adminA.get('/api/academic-years').expect(200);
      const years = (res.body.data as { year: number }[]).map((y) => y.year);
      expect(years).toContain(2026);
      expect(
        (res.body.data as { institutionId: string }[]).every(
          (y) => y.institutionId === institutionA.id,
        ),
      ).toBe(true);
      const inactive = await adminA
        .get('/api/academic-years?isActive=false')
        .expect(200);
      expect(inactive.body.data).toEqual([]);
    });

    it('otra institución: 404 al ver, editar o borrar', async () => {
      await adminB.get(`/api/academic-years/${year2026Id}`).expect(404);
      await adminB
        .patch(`/api/academic-years/${year2026Id}`)
        .send({ isActive: false })
        .expect(404);
      await adminB.delete(`/api/academic-years/${year2026Id}`).expect(404);
    });

    it('limitado a sedes: lo ve pero no lo gestiona (403)', async () => {
      await campusAdminA.get(`/api/academic-years/${year2026Id}`).expect(200);
      await campusAdminA
        .post('/api/academic-years')
        .send({ year: 2040 })
        .expect(403);
      await campusAdminA
        .patch(`/api/academic-years/${year2026Id}`)
        .send({ isActive: false })
        .expect(403);
    });

    it('el rol TEACHER no tiene acceso a años lectivos (403)', async () => {
      await teacherA.get('/api/academic-years').expect(403);
    });

    it('activa y desactiva; el número cambia solo si no tiene periodos ni cursos', async () => {
      const id = await createYear();
      const off = await adminA
        .patch(`/api/academic-years/${id}`)
        .send({ isActive: false })
        .expect(200);
      expect(off.body.isActive).toBe(false);
      await adminA
        .patch(`/api/academic-years/${id}`)
        .send({ year: 2050 })
        .expect(200);
      await adminA
        .patch(`/api/academic-years/${id}`)
        .send({ year: 2026 })
        .expect(409); // repetido
      await adminA
        .post(`/api/academic-years/${id}/periods`)
        .send({ name: 'P1', startDate: '2050-02-01', endDate: '2050-03-01' })
        .expect(201);
      await adminA
        .patch(`/api/academic-years/${id}`)
        .send({ year: 2051 })
        .expect(409);
      await adminA
        .patch(`/api/academic-years/${id}`)
        .send({ isActive: null })
        .expect(400);
    });

    it('se borra solo si nada lo usa (204 / 409)', async () => {
      const empty = await createYear();
      await adminA.delete(`/api/academic-years/${empty}`).expect(204);
      await adminA.get(`/api/academic-years/${empty}`).expect(404);
      const used = await createYear();
      await adminA
        .post(`/api/academic-years/${used}/periods`)
        .send({
          name: 'P1',
          startDate: `${nextYear - 1}-02-01`,
          endDate: `${nextYear - 1}-03-01`,
        })
        .expect(201);
      await adminA.delete(`/api/academic-years/${used}`).expect(409);
    });
  });

  describe('periodos', () => {
    let yearId: string;
    let year: number;
    let p1Id: string;

    beforeAll(async () => {
      year = nextYear;
      yearId = await createYear();
    });

    it('crea un periodo dentro del año lectivo', async () => {
      const res = await adminA
        .post(`/api/academic-years/${yearId}/periods`)
        .send({
          name: 'Primer periodo',
          startDate: `${year}-02-01`,
          endDate: `${year}-04-10`,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        academicYearId: yearId,
        name: 'Primer periodo',
        startDate: `${year}-02-01`,
        endDate: `${year}-04-10`,
      });
      p1Id = res.body.id as string;
    });

    it('calendario B: puede terminar el año siguiente', async () => {
      await adminA
        .post(`/api/academic-years/${yearId}/periods`)
        .send({
          name: 'Segundo semestre',
          startDate: `${year}-08-01`,
          endDate: `${year + 1}-06-15`,
        })
        .expect(201);
    });

    it.each([
      ['fin antes del inicio', `${2030}-05-01`, `${2030}-04-01`],
      ['empieza antes del año lectivo', 'PREV-12-01', 'CUR-01-15'],
      ['termina después del año siguiente', 'CUR-11-01', 'NEXT2-01-10'],
      ['fecha inexistente', 'CUR-02-30', 'CUR-03-10'],
      ['formato inválido', '01/05/CUR', 'CUR-06-10'],
    ])('400: %s', async (_case, start, end) => {
      const fill = (d: string) =>
        d
          .replace('PREV', String(year - 1))
          .replace('NEXT2', String(year + 2))
          .replace('CUR', String(year))
          .replace('2030', String(year));
      await adminA
        .post(`/api/academic-years/${yearId}/periods`)
        .send({
          name: `P ${suffix()}`,
          startDate: fill(start),
          endDate: fill(end),
        })
        .expect(400);
    });

    it('fechas cruzadas con otro periodo, o nombre repetido: 409', async () => {
      await adminA
        .post(`/api/academic-years/${yearId}/periods`)
        .send({
          name: 'Cruzado',
          startDate: `${year}-04-10`,
          endDate: `${year}-06-01`,
        })
        .expect(409);
      await adminA
        .post(`/api/academic-years/${yearId}/periods`)
        .send({
          name: 'Primer periodo',
          startDate: `${year}-05-01`,
          endDate: `${year}-06-01`,
        })
        .expect(409);
    });

    it('lista por fecha de inicio y edita revalidando el cruce', async () => {
      const list = await adminA
        .get(`/api/academic-years/${yearId}/periods`)
        .expect(200);
      expect((list.body as { name: string }[]).map((p) => p.name)).toEqual([
        'Primer periodo',
        'Segundo semestre',
      ]);
      await adminA
        .patch(`/api/periods/${p1Id}`)
        .send({ endDate: `${year}-09-01` })
        .expect(409);
      const ok = await adminA
        .patch(`/api/periods/${p1Id}`)
        .send({ endDate: `${year}-04-20`, name: 'Periodo 1' })
        .expect(200);
      expect(ok.body).toMatchObject({
        name: 'Periodo 1',
        startDate: `${year}-02-01`,
        endDate: `${year}-04-20`,
      });
      await adminA
        .patch(`/api/periods/${p1Id}`)
        .send({ startDate: `${year}-05-01` })
        .expect(400); // quedaría con fin antes del inicio
    });

    it('otra institución: 404; limitado a sedes: ve pero no gestiona', async () => {
      await adminB.get(`/api/periods/${p1Id}`).expect(404);
      await adminB.get(`/api/academic-years/${yearId}/periods`).expect(404);
      await adminB
        .post(`/api/academic-years/${yearId}/periods`)
        .send({
          name: 'Intruso',
          startDate: `${year}-10-01`,
          endDate: `${year}-10-02`,
        })
        .expect(404);
      await adminB.delete(`/api/periods/${p1Id}`).expect(404);
      await campusAdminA.get(`/api/periods/${p1Id}`).expect(200);
      await campusAdminA
        .patch(`/api/periods/${p1Id}`)
        .send({ name: 'X' })
        .expect(403);
    });

    it('borra un periodo', async () => {
      await adminA.delete(`/api/periods/${p1Id}`).expect(204);
      await adminA.get(`/api/periods/${p1Id}`).expect(404);
    });
  });

  describe('/grades y /subjects', () => {
    it.each(['grades', 'subjects'])(
      '%s: crea, repite (409), busca y aísla por institución',
      async (resource) => {
        const name = `E2E ${resource} ${suffix()}`;
        const created = await adminA
          .post(`/api/${resource}`)
          .send({ name: `  ${name}  ` })
          .expect(201);
        expect(created.body).toMatchObject({
          name,
          institutionId: institutionA.id,
        });
        const id = created.body.id as string;
        await adminA.post(`/api/${resource}`).send({ name }).expect(409);
        await adminB.post(`/api/${resource}`).send({ name }).expect(201);

        const found = await adminA
          .get(`/api/${resource}?search=${encodeURIComponent(name)}`)
          .expect(200);
        expect((found.body.data as { id: string }[]).map((x) => x.id)).toEqual([
          id,
        ]);
        await adminB.get(`/api/${resource}/${id}`).expect(404);
        await adminB
          .patch(`/api/${resource}/${id}`)
          .send({ name: 'X' })
          .expect(404);
        await adminB.delete(`/api/${resource}/${id}`).expect(404);

        await campusAdminA.get(`/api/${resource}/${id}`).expect(200);
        await campusAdminA
          .post(`/api/${resource}`)
          .send({ name: `E2E ${suffix()}` })
          .expect(403);

        const renamed = await adminA
          .patch(`/api/${resource}/${id}`)
          .send({ name: `${name} b` })
          .expect(200);
        expect(renamed.body.name).toBe(`${name} b`);
        await adminA
          .patch(`/api/${resource}/${id}`)
          .send({ name: null })
          .expect(400);
        await adminA.delete(`/api/${resource}/${id}`).expect(204);
      },
    );

    it('el rol TEACHER ve materias pero no grados ni las gestiona', async () => {
      await teacherA.get('/api/subjects').expect(200);
      await teacherA.get('/api/grades').expect(403);
      await teacherA
        .post('/api/subjects')
        .send({ name: `E2E ${suffix()}` })
        .expect(403);
    });
  });

  describe('/courses', () => {
    let yearId: string;
    let inactiveYearId: string;
    let gradeId: string;
    let otherGradeId: string;
    let gradeBId: string;
    let courseA1Id: string;
    let courseA2Id: string;

    const course = (extra: Record<string, unknown> = {}) => ({
      name: `E2E ${suffix()}`,
      gradeId,
      campusId: campusA1.id,
      academicYearId: yearId,
      ...extra,
    });

    beforeAll(async () => {
      yearId = await createYear();
      inactiveYearId = await createYear();
      await adminA
        .patch(`/api/academic-years/${inactiveYearId}`)
        .send({ isActive: false })
        .expect(200);
      const grade = async (agent: Agent) =>
        (
          await agent
            .post('/api/grades')
            .send({ name: `E2E Grado ${suffix()}` })
            .expect(201)
        ).body.id as string;
      gradeId = await grade(adminA);
      otherGradeId = await grade(adminA);
      gradeBId = await grade(adminB);
    });

    it('crea un curso con su grado, sede y año', async () => {
      const body = course({ name: '601' });
      const res = await adminA.post('/api/courses').send(body).expect(201);
      expect(res.body).toMatchObject({
        name: '601',
        grade: { id: gradeId },
        campus: { id: campusA1.id, isActive: true },
        academicYear: { id: yearId, isActive: true },
      });
      courseA1Id = res.body.id as string;
      await adminA.post('/api/courses').send(body).expect(409);
      courseA2Id = (
        await adminA
          .post('/api/courses')
          .send(course({ campusId: campusA2.id }))
          .expect(201)
      ).body.id as string;
    });

    it('sede o año inactivo: 400; grado, sede o año de otra institución: 404', async () => {
      await adminA
        .post('/api/courses')
        .send(course({ campusId: inactiveCampusA.id }))
        .expect(400);
      await adminA
        .post('/api/courses')
        .send(course({ academicYearId: inactiveYearId }))
        .expect(400);
      await adminA
        .post('/api/courses')
        .send(course({ gradeId: gradeBId }))
        .expect(404);
      await adminA
        .post('/api/courses')
        .send(course({ campusId: campusB.id }))
        .expect(404);
      const yearB = (
        await adminB
          .post('/api/academic-years')
          .send({ year: 2061 })
          .expect(201)
      ).body.id as string;
      await adminA
        .post('/api/courses')
        .send(course({ academicYearId: yearB }))
        .expect(404);
    });

    it('administrador de sede: solo cursos de su sede', async () => {
      await campusAdminA
        .post('/api/courses')
        .send(course({ campusId: campusA2.id }))
        .expect(404);
      await campusAdminA.post('/api/courses').send(course()).expect(201);
      const list = await campusAdminA.get('/api/courses?limit=100').expect(200);
      const campuses = new Set(
        (list.body.data as { campus: { id: string } }[]).map(
          (c) => c.campus.id,
        ),
      );
      expect([...campuses]).toEqual([campusA1.id]);
      await campusAdminA.get(`/api/courses/${courseA2Id}`).expect(404);
      await campusAdminA
        .patch(`/api/courses/${courseA2Id}`)
        .send({ name: 'X' })
        .expect(404);
      await campusAdminA.delete(`/api/courses/${courseA2Id}`).expect(404);
      // Tampoco puede mover uno suyo a otra sede.
      await campusAdminA
        .patch(`/api/courses/${courseA1Id}`)
        .send({ campusId: campusA2.id })
        .expect(404);
    });

    it('filtra por año, grado y sede', async () => {
      const res = await adminA
        .get(`/api/courses?academicYearId=${yearId}&campusId=${campusA2.id}`)
        .expect(200);
      expect((res.body.data as { id: string }[]).map((c) => c.id)).toEqual([
        courseA2Id,
      ]);
      const byGrade = await adminA
        .get(`/api/courses?gradeId=${otherGradeId}`)
        .expect(200);
      expect(byGrade.body.data).toEqual([]);
    });

    it('otra institución: no aparece y da 404', async () => {
      const list = await adminB.get('/api/courses?limit=100').expect(200);
      expect(
        (list.body.data as { id: string }[]).map((c) => c.id),
      ).not.toContain(courseA1Id);
      await adminB.get(`/api/courses/${courseA1Id}`).expect(404);
      await adminB
        .patch(`/api/courses/${courseA1Id}`)
        .send({ name: 'X' })
        .expect(404);
      await adminB.delete(`/api/courses/${courseA1Id}`).expect(404);
    });

    it('el rol TEACHER ve cursos pero no los gestiona', async () => {
      await teacherA.get(`/api/courses/${courseA1Id}`).expect(200);
      await teacherA.post('/api/courses').send(course()).expect(403);
    });

    it('edita y mueve un curso sin carga académica ni matrículas', async () => {
      const res = await adminA
        .patch(`/api/courses/${courseA2Id}`)
        .send({ name: '602', gradeId: otherGradeId, campusId: campusA1.id })
        .expect(200);
      expect(res.body).toMatchObject({
        name: '602',
        grade: { id: otherGradeId },
        campus: { id: campusA1.id },
      });
      await adminA
        .patch(`/api/courses/${courseA2Id}`)
        .send({ academicYearId: inactiveYearId })
        .expect(400);
    });

    it('con carga académica: no se mueve, no se borra, y su grado y materia tampoco', async () => {
      const subject = await adminA
        .post('/api/subjects')
        .send({ name: `E2E Materia ${suffix()}` })
        .expect(201);
      const teacherUser = await ctx.data.createUser({ userType: 'TEACHER' });
      const teacher = await ctx.dataSource
        .getRepository(TeacherEntity)
        .save({ userId: teacherUser.id, institutionId: institutionA.id });
      await ctx.dataSource.getRepository(TeacherSubjectCourseEntity).insert({
        courseId: courseA1Id,
        subjectId: subject.body.id as string,
        teacherId: teacher.id,
      });

      await adminA
        .patch(`/api/courses/${courseA1Id}`)
        .send({ campusId: campusA2.id })
        .expect(409);
      // Cambiar solo el nombre sí se puede.
      await adminA
        .patch(`/api/courses/${courseA1Id}`)
        .send({ name: '601A' })
        .expect(200);
      await adminA.delete(`/api/courses/${courseA1Id}`).expect(409);
      await adminA.delete(`/api/grades/${gradeId}`).expect(409);
      await adminA.delete(`/api/subjects/${subject.body.id}`).expect(409);
      await adminA.delete(`/api/academic-years/${yearId}`).expect(409);
    });

    it('borra un curso sin uso', async () => {
      const created = await adminA
        .post('/api/courses')
        .send(course())
        .expect(201);
      await adminA.delete(`/api/courses/${created.body.id}`).expect(204);
      await adminA.get(`/api/courses/${created.body.id}`).expect(404);
    });
  });

  describe('revisión de seguridad', () => {
    let yearId: string;
    let year: number;
    let periodId: string;
    let gradeId: string;
    let subjectId: string;
    let courseId: string;

    beforeAll(async () => {
      year = nextYear;
      yearId = await createYear();
      periodId = (
        await adminA
          .post(`/api/academic-years/${yearId}/periods`)
          .send({
            name: 'P1',
            startDate: `${year}-02-01`,
            endDate: `${year}-03-01`,
          })
          .expect(201)
      ).body.id as string;
      gradeId = (
        await adminA
          .post('/api/grades')
          .send({ name: `E2E Grado ${suffix()}` })
          .expect(201)
      ).body.id as string;
      subjectId = (
        await adminA
          .post('/api/subjects')
          .send({ name: `E2E Materia ${suffix()}` })
          .expect(201)
      ).body.id as string;
      courseId = (
        await adminA
          .post('/api/courses')
          .send({
            name: `E2E ${suffix()}`,
            gradeId,
            campusId: campusA1.id,
            academicYearId: yearId,
          })
          .expect(201)
      ).body.id as string;
    });

    it('otra institución: no edita periodos ni mueve cursos hacia sus datos (404)', async () => {
      await adminB
        .patch(`/api/periods/${periodId}`)
        .send({ name: 'X' })
        .expect(404);
      const gradeB = (
        await adminB
          .post('/api/grades')
          .send({ name: `E2E ${suffix()}` })
          .expect(201)
      ).body.id as string;
      await adminA
        .patch(`/api/courses/${courseId}`)
        .send({ gradeId: gradeB })
        .expect(404);
      await adminA
        .patch(`/api/courses/${courseId}`)
        .send({ campusId: campusB.id })
        .expect(404);
    });

    it('limitado a sedes: no edita ni borra lo de toda la institución (403)', async () => {
      await campusAdminA.delete(`/api/academic-years/${yearId}`).expect(403);
      await campusAdminA.delete(`/api/periods/${periodId}`).expect(403);
      for (const [resource, id] of [
        ['grades', gradeId],
        ['subjects', subjectId],
      ]) {
        await campusAdminA
          .patch(`/api/${resource}/${id}`)
          .send({ name: 'X' })
          .expect(403);
        await campusAdminA.delete(`/api/${resource}/${id}`).expect(403);
      }
      const other = await campusAdminA
        .get(`/api/courses?campusId=${campusA2.id}`)
        .expect(200);
      expect(other.body.data).toEqual([]);
    });

    it('el rol TEACHER no ve periodos ni edita o borra cursos (403)', async () => {
      await teacherA.get(`/api/periods/${periodId}`).expect(403);
      await teacherA
        .patch(`/api/courses/${courseId}`)
        .send({ name: 'X' })
        .expect(403);
      await teacherA.delete(`/api/courses/${courseId}`).expect(403);
    });

    it('PATCH con campos extra: 400', async () => {
      await adminA
        .patch(`/api/periods/${periodId}`)
        .send({ academicYearId: yearId })
        .expect(400);
      await adminA
        .patch(`/api/courses/${courseId}`)
        .send({ institutionId: institutionB.id })
        .expect(400);
    });

    it('dos altas simultáneas que se cruzan: una 201 y otra 409', async () => {
      const body = (name: string) => ({
        name,
        startDate: `${year}-05-01`,
        endDate: `${year}-06-01`,
      });
      const statuses = (
        await Promise.all([
          adminA
            .post(`/api/academic-years/${yearId}/periods`)
            .send(body('Concurrente 1')),
          adminA
            .post(`/api/academic-years/${yearId}/periods`)
            .send(body('Concurrente 2')),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('con matrículas: el curso no se mueve ni se borra (409)', async () => {
      const studentUser = await ctx.data.createUser({ userType: 'STUDENT' });
      const student = await ctx.dataSource.getRepository(StudentEntity).save({
        userId: studentUser.id,
        institutionId: institutionA.id,
        campusId: campusA1.id,
      });
      await ctx.dataSource.getRepository(EnrollmentEntity).insert({
        studentId: student.id,
        courseId,
        academicYearId: yearId,
      });
      await adminA
        .patch(`/api/courses/${courseId}`)
        .send({ campusId: campusA2.id })
        .expect(409);
      await adminA.delete(`/api/courses/${courseId}`).expect(409);
    });
  });
});
