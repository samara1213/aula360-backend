import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const suffix = () => randomBytes(4).toString('hex');

describe('Carga académica y matrículas (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1

  let yearId: string;
  let otherYearId: string;
  let subjectId: string;
  let subjectBId: string;
  let courseA1: string; // sede A1
  let courseA1b: string; // sede A1
  let courseA2: string; // sede A2
  let courseOtherYear: string; // sede A1, otro año
  let courseB: string;
  let gradeA: string;

  const server = () => ctx.app.getHttpServer();

  async function loginAs(identifier: string | null): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  /** Docente con perfil y rol TEACHER (en la sede indicada o en toda la institución). */
  async function createTeacher(
    institutionId: string,
    campusId: string | null,
    { isActive = true } = {},
  ) {
    const user = await ctx.data.createUser({ userType: 'TEACHER', isActive });
    await ctx.data.assignGlobalRole(
      user.id,
      institutionId,
      'TEACHER',
      campusId,
    );
    const profile = await ctx.dataSource
      .getRepository(TeacherEntity)
      .save({ userId: user.id, institutionId });
    return { user, id: profile.id };
  }

  /** Estudiante con perfil y rol STUDENT en su sede. */
  async function createStudent(
    institutionId: string,
    campusId: string | null,
    { isActive = true } = {},
  ) {
    const user = await ctx.data.createUser({ userType: 'STUDENT', isActive });
    await ctx.data.assignGlobalRole(
      user.id,
      institutionId,
      'STUDENT',
      campusId,
    );
    const profile = await ctx.dataSource
      .getRepository(StudentEntity)
      .save({ userId: user.id, institutionId, campusId });
    return { user, id: profile.id };
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

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');
    campusA2 = await data.createCampus(institutionA.id, 'Sede A2');
    const campusB = await data.createCampus(institutionB.id, 'Sede B');

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

    yearId = (await post(adminA, '/api/academic-years', { year: 2026 }, 201))
      .id;
    otherYearId = (
      await post(adminA, '/api/academic-years', { year: 2027 }, 201)
    ).id;
    const gradeId = (await post(adminA, '/api/grades', { name: 'Sexto' }, 201))
      .id;
    gradeA = gradeId;
    subjectId = (
      await post(adminA, '/api/subjects', { name: 'Matemáticas' }, 201)
    ).id;
    const course = async (name: string, campusId: string, year = yearId) =>
      (
        await post(
          adminA,
          '/api/courses',
          { name, gradeId, campusId, academicYearId: year },
          201,
        )
      ).id;
    courseA1 = await course('601', campusA1.id);
    courseA1b = await course('602', campusA1.id);
    courseA2 = await course('603', campusA2.id);
    courseOtherYear = await course('601', campusA1.id, otherYearId);

    const yearB = (
      await post(adminB, '/api/academic-years', { year: 2026 }, 201)
    ).id;
    const gradeB = (await post(adminB, '/api/grades', { name: 'Sexto' }, 201))
      .id;
    subjectBId = (
      await post(adminB, '/api/subjects', { name: 'Matemáticas' }, 201)
    ).id;
    courseB = (
      await post(
        adminB,
        '/api/courses',
        {
          name: '601',
          gradeId: gradeB,
          campusId: campusB.id,
          academicYearId: yearB,
        },
        201,
      )
    ).id;
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('/teacher-assignments', () => {
    let teacher1: Awaited<ReturnType<typeof createTeacher>>;
    let teacher2: Awaited<ReturnType<typeof createTeacher>>;
    let assignmentId: string;

    beforeAll(async () => {
      teacher1 = await createTeacher(institutionA.id, campusA1.id);
      teacher2 = await createTeacher(institutionA.id, null);
    });

    it('asigna un docente a una materia en un curso', async () => {
      const body = await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1, subjectId, teacherId: teacher1.id },
        201,
      );
      expect(body).toMatchObject({
        isActive: true,
        deactivatedAt: null,
        course: { id: courseA1, campus: { id: campusA1.id } },
        subject: { id: subjectId },
        teacher: { id: teacher1.id, userId: teacher1.user.id },
      });
      expect(JSON.stringify(body)).not.toMatch(
        /documentNumber|email|passwordHash/,
      );
      assignmentId = body.id;
      // Un solo docente activo por materia y curso.
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1, subjectId, teacherId: teacher2.id },
        409,
      );
    });

    it('el docente necesita el rol TEACHER en la sede del curso y estar activo (400)', async () => {
      const onlyA2 = await createTeacher(institutionA.id, campusA2.id);
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1b, subjectId, teacherId: onlyA2.id },
        400,
      );
      const inactive = await createTeacher(institutionA.id, null, {
        isActive: false,
      });
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1b, subjectId, teacherId: inactive.id },
        400,
      );
    });

    it('curso, materia o docente de otra institución: 404', async () => {
      const teacherB = await createTeacher(institutionB.id, null);
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1b, subjectId, teacherId: teacherB.id },
        404,
      );
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1b, subjectId: subjectBId, teacherId: teacher2.id },
        404,
      );
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseB, subjectId, teacherId: teacher2.id },
        404,
      );
      await adminB.get(`/api/teacher-assignments/${assignmentId}`).expect(404);
      await adminB
        .post(`/api/teacher-assignments/${assignmentId}/replace`)
        .send({ teacherId: teacher2.id })
        .expect(404);
    });

    it('administrador de sede: solo la carga de los cursos de su sede', async () => {
      await post(
        campusAdminA,
        '/api/teacher-assignments',
        { courseId: courseA2, subjectId, teacherId: teacher2.id },
        404,
      );
      const inA2 = await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA2, subjectId, teacherId: teacher2.id },
        201,
      );
      await campusAdminA.get(`/api/teacher-assignments/${inA2.id}`).expect(404);
      const list = await campusAdminA
        .get('/api/teacher-assignments?limit=100')
        .expect(200);
      const campuses = new Set(
        (list.body.data as { course: { campus: { id: string } } }[]).map(
          (a) => a.course.campus.id,
        ),
      );
      expect([...campuses]).toEqual([campusA1.id]);
    });

    it('reemplazo: la anterior queda en el historial y la nueva activa', async () => {
      await adminA
        .post(`/api/teacher-assignments/${assignmentId}/replace`)
        .send({ teacherId: teacher1.id })
        .expect(400); // mismo docente
      const res = await adminA
        .post(`/api/teacher-assignments/${assignmentId}/replace`)
        .send({ teacherId: teacher2.id })
        .expect(201);
      expect(res.body).toMatchObject({
        isActive: true,
        teacher: { id: teacher2.id },
        course: { id: courseA1 },
      });
      const old = await adminA
        .get(`/api/teacher-assignments/${assignmentId}`)
        .expect(200);
      expect(old.body.isActive).toBe(false);
      expect(old.body.deactivatedAt).not.toBeNull();
      await adminA
        .post(`/api/teacher-assignments/${assignmentId}/replace`)
        .send({ teacherId: teacher1.id })
        .expect(409); // ya no está activa
      const history = await adminA
        .get(`/api/teacher-assignments?courseId=${courseA1}&isActive=false`)
        .expect(200);
      expect((history.body.data as { id: string }[]).map((a) => a.id)).toEqual([
        assignmentId,
      ]);
    });

    it('mi carga: el docente ve solo su carga activa, sin permiso de menú', async () => {
      const t2 = await loginAs(teacher2.user.email);
      const mine = await t2.get('/api/teacher-assignments/mine').expect(200);
      const courses = (mine.body as { course: { id: string } }[])
        .map((a) => a.course.id)
        .sort();
      expect(courses).toEqual([courseA1, courseA2].sort());
      const t1 = await loginAs(teacher1.user.email);
      const none = await t1.get('/api/teacher-assignments/mine').expect(200);
      expect(none.body).toEqual([]); // fue reemplazado
      await t1.get('/api/teacher-assignments').expect(403);
      await t1
        .post('/api/teacher-assignments')
        .send({ courseId: courseA1b, subjectId, teacherId: teacher1.id })
        .expect(403);
    });

    it('termina sin reemplazo y borra una asignación sin evaluaciones', async () => {
      const created = await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1b, subjectId, teacherId: teacher1.id },
        201,
      );
      const off = await adminA
        .patch(`/api/teacher-assignments/${created.id}/deactivate`)
        .expect(200);
      expect(off.body.isActive).toBe(false);
      await adminA.delete(`/api/teacher-assignments/${created.id}`).expect(204);
      await adminA.get(`/api/teacher-assignments/${created.id}`).expect(404);
    });

    it('año lectivo inactivo: no se asigna carga (400)', async () => {
      await adminA
        .patch(`/api/academic-years/${otherYearId}`)
        .send({ isActive: false })
        .expect(200);
      try {
        await post(
          adminA,
          '/api/teacher-assignments',
          { courseId: courseOtherYear, subjectId, teacherId: teacher1.id },
          400,
        );
      } finally {
        await adminA
          .patch(`/api/academic-years/${otherYearId}`)
          .send({ isActive: true })
          .expect(200);
      }
    });
  });

  describe('/enrollments', () => {
    let s1: Awaited<ReturnType<typeof createStudent>>;
    let enrollmentId: string;

    beforeAll(async () => {
      s1 = await createStudent(institutionA.id, campusA1.id);
    });

    it('matricula; el año es el del curso y uno por año', async () => {
      const body = await post(
        adminA,
        '/api/enrollments',
        { studentId: s1.id, courseId: courseA1, observations: '  Nuevo  ' },
        201,
      );
      expect(body).toMatchObject({
        status: 'ENROLLED',
        observations: 'Nuevo',
        student: { id: s1.id },
        course: { id: courseA1, campus: { id: campusA1.id } },
        academicYear: { id: yearId, year: 2026 },
      });
      expect(JSON.stringify(body)).not.toMatch(/documentNumber|email|guardian/);
      enrollmentId = body.id;
      await post(
        adminA,
        '/api/enrollments',
        { studentId: s1.id, courseId: courseA1b },
        409,
      );
      // Otro año sí.
      await post(
        adminA,
        '/api/enrollments',
        { studentId: s1.id, courseId: courseOtherYear },
        201,
      );
    });

    it('el cliente no elige el año ni campos extra (400)', async () => {
      const s = await createStudent(institutionA.id, campusA1.id);
      await post(
        adminA,
        '/api/enrollments',
        { studentId: s.id, courseId: courseA1, academicYearId: otherYearId },
        400,
      );
    });

    it('sede distinta, sin sede o estudiante inactivo: 400', async () => {
      const inA2 = await createStudent(institutionA.id, campusA2.id);
      await post(
        adminA,
        '/api/enrollments',
        { studentId: inA2.id, courseId: courseA1 },
        400,
      );
      const noCampus = await createStudent(institutionA.id, null);
      await post(
        adminA,
        '/api/enrollments',
        { studentId: noCampus.id, courseId: courseA1 },
        400,
      );
      const inactive = await createStudent(institutionA.id, campusA1.id, {
        isActive: false,
      });
      await post(
        adminA,
        '/api/enrollments',
        { studentId: inactive.id, courseId: courseA1 },
        400,
      );
    });

    it('estudiante o curso de otra institución: 404', async () => {
      const sB = await createStudent(institutionB.id, null);
      await post(
        adminA,
        '/api/enrollments',
        { studentId: sB.id, courseId: courseA1 },
        404,
      );
      const s = await createStudent(institutionA.id, campusA1.id);
      await post(
        adminA,
        '/api/enrollments',
        { studentId: s.id, courseId: courseB },
        404,
      );
      await adminB.get(`/api/enrollments/${enrollmentId}`).expect(404);
      await adminB
        .patch(`/api/enrollments/${enrollmentId}`)
        .send({ status: 'DROPPED' })
        .expect(404);
      const listB = await adminB.get('/api/enrollments?limit=100').expect(200);
      expect(
        (listB.body.data as { id: string }[]).map((e) => e.id),
      ).not.toContain(enrollmentId);
    });

    it('administrador de sede: solo cursos de su sede', async () => {
      const inA2 = await createStudent(institutionA.id, campusA2.id);
      await post(
        campusAdminA,
        '/api/enrollments',
        { studentId: inA2.id, courseId: courseA2 },
        404,
      );
      const inA2Enrollment = await post(
        adminA,
        '/api/enrollments',
        { studentId: inA2.id, courseId: courseA2 },
        201,
      );
      await campusAdminA
        .get(`/api/enrollments/${inA2Enrollment.id}`)
        .expect(404);
      await campusAdminA.get(`/api/enrollments/${enrollmentId}`).expect(200);
    });

    it('cambios de estado permitidos y prohibidos', async () => {
      const s = await createStudent(institutionA.id, campusA1.id);
      const { id } = await post(
        adminA,
        '/api/enrollments',
        { studentId: s.id, courseId: courseA1 },
        201,
      );
      const to = (status: string, expected: number) =>
        adminA
          .patch(`/api/enrollments/${id}`)
          .send({ status })
          .expect(expected);
      await to('SUSPENDED', 200);
      await to('GRADUATED', 409);
      await to('DROPPED', 200);
      await to('SUSPENDED', 409);
      await to('ENROLLED', 200); // reintegro
      await to('GRADUATED', 200);
      await to('ENROLLED', 409); // definitivo
      await adminA
        .patch(`/api/enrollments/${id}`)
        .send({ status: 'OTRO' })
        .expect(400);
    });

    it('cambio de curso: mismo año y misma sede', async () => {
      const res = await adminA
        .patch(`/api/enrollments/${enrollmentId}`)
        .send({ courseId: courseA1b })
        .expect(200);
      expect(res.body.course.id).toBe(courseA1b);
      await adminA
        .patch(`/api/enrollments/${enrollmentId}`)
        .send({ courseId: courseA2 })
        .expect(400); // otra sede
      await adminA
        .patch(`/api/enrollments/${enrollmentId}`)
        .send({ courseId: courseA1 })
        .expect(200);
    });

    it('con matrícula vigente no cambia de sede; retirar, mover y reintegrar sí', async () => {
      const s = await createStudent(institutionA.id, campusA1.id);
      const { id } = await post(
        adminA,
        '/api/enrollments',
        { studentId: s.id, courseId: courseA1 },
        201,
      );
      await adminA
        .patch(`/api/students/${s.id}`)
        .send({ campusId: campusA2.id })
        .expect(409);
      await adminA
        .patch(`/api/enrollments/${id}`)
        .send({ status: 'DROPPED' })
        .expect(200);
      await adminA
        .patch(`/api/students/${s.id}`)
        .send({ campusId: campusA2.id })
        .expect(200);
      // Reintegro en el curso de la sede nueva, en el mismo PATCH.
      await adminA
        .patch(`/api/enrollments/${id}`)
        .send({ status: 'ENROLLED' })
        .expect(400); // su curso es de la sede anterior
      const res = await adminA
        .patch(`/api/enrollments/${id}`)
        .send({ status: 'ENROLLED', courseId: courseA2 })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'ENROLLED',
        course: { id: courseA2 },
      });
    });

    it('dos matrículas simultáneas del mismo estudiante: una 201 y otra 409', async () => {
      const s = await createStudent(institutionA.id, campusA1.id);
      const statuses = (
        await Promise.all(
          [courseA1, courseA1b].map((courseId) =>
            adminA.post('/api/enrollments').send({ studentId: s.id, courseId }),
          ),
        )
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('el curso con matrículas no cambia de sede (bloqueo compartido)', async () => {
      await adminA
        .patch(`/api/courses/${courseA1}`)
        .send({ campusId: campusA2.id })
        .expect(409);
    });
  });

  describe('/students para docentes', () => {
    it('el docente solo ve a los estudiantes de los cursos con su carga activa', async () => {
      const teacher = await createTeacher(institutionA.id, null);
      const mine = await createStudent(institutionA.id, campusA1.id);
      const other = await createStudent(institutionA.id, campusA1.id);
      await post(
        adminA,
        '/api/enrollments',
        { studentId: mine.id, courseId: courseA1b },
        201,
      );
      await post(
        adminA,
        '/api/enrollments',
        { studentId: other.id, courseId: courseA2 },
        400,
      ); // sede distinta: no se matricula
      const english = (
        await post(adminA, '/api/subjects', { name: `Inglés ${suffix()}` }, 201)
      ).id;
      await post(
        adminA,
        '/api/teacher-assignments',
        { courseId: courseA1b, subjectId: english, teacherId: teacher.id },
        201,
      );

      const agent = await loginAs(teacher.user.email);
      const list = await agent.get('/api/students?limit=100').expect(200);
      const ids = (list.body.data as { id: string }[]).map((s) => s.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(other.id);
      await agent.get(`/api/students/${mine.id}`).expect(200);
      await agent.get(`/api/students/${other.id}`).expect(404);
      const byCourse = await agent
        .get(`/api/students?courseId=${courseA1b}&limit=100`)
        .expect(200);
      expect(
        (byCourse.body.data as { id: string }[]).map((s) => s.id),
      ).toContain(mine.id);
    });

    it('rol TEACHER sin perfil de docente: no ve estudiantes', async () => {
      const user = await ctx.data.createUser({ userType: 'TEACHER' });
      await ctx.data.assignGlobalRole(user.id, institutionA.id, 'TEACHER');
      const agent = await loginAs(user.email);
      const list = await agent.get('/api/students').expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('el administrador sigue viendo a todos', async () => {
      const list = await adminA.get('/api/students?limit=1').expect(200);
      expect(list.body.meta.total).toBeGreaterThan(3);
    });
  });

  describe('revisión de seguridad 8b', () => {
    /** Docente con carga de una materia nueva en el curso, y un estudiante matriculado. */
    async function teacherWithStudent(courseId: string, campusId: string) {
      const teacher = await createTeacher(institutionA.id, null);
      const student = await createStudent(institutionA.id, campusId);
      const enrollment = await post(
        adminA,
        '/api/enrollments',
        { studentId: student.id, courseId },
        201,
      );
      const subject = (
        await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201)
      ).id;
      const assignment = await post(
        adminA,
        '/api/teacher-assignments',
        { courseId, subjectId: subject, teacherId: teacher.id },
        201,
      );
      const agent = await loginAs(teacher.user.email);
      const sees = async (id: string) =>
        (await agent.get(`/api/students/${id}`)).status === 200;
      return { teacher, student, enrollment, assignment, agent, sees, subject };
    }

    it('el docente deja de ver al estudiante al retirarlo o al terminar su carga', async () => {
      const t = await teacherWithStudent(courseA1, campusA1.id);
      expect(await t.sees(t.student.id)).toBe(true);
      await adminA
        .patch(`/api/enrollments/${t.enrollment.id}`)
        .send({ status: 'DROPPED' })
        .expect(200);
      expect(await t.sees(t.student.id)).toBe(false);
      await adminA
        .patch(`/api/enrollments/${t.enrollment.id}`)
        .send({ status: 'ENROLLED' })
        .expect(200);
      expect(await t.sees(t.student.id)).toBe(true);
      await adminA
        .patch(`/api/teacher-assignments/${t.assignment.id}/deactivate`)
        .expect(200);
      expect(await t.sees(t.student.id)).toBe(false);
    });

    it('al cerrar el año, el docente deja de verlo y /mine no muestra esa carga', async () => {
      const yearId = (
        await post(adminA, '/api/academic-years', { year: 2031 }, 201)
      ).id;
      const course = (
        await post(
          adminA,
          '/api/courses',
          {
            name: '601',
            gradeId: gradeA,
            campusId: campusA1.id,
            academicYearId: yearId,
          },
          201,
        )
      ).id;
      const t = await teacherWithStudent(course, campusA1.id);
      expect(await t.sees(t.student.id)).toBe(true);
      await adminA
        .patch(`/api/academic-years/${yearId}`)
        .send({ isActive: false })
        .expect(200);
      expect(await t.sees(t.student.id)).toBe(false);
      const mine = await t.agent
        .get('/api/teacher-assignments/mine')
        .expect(200);
      expect(mine.body).toEqual([]);
      // Reintegro en un año inactivo: 400.
      await adminA
        .patch(`/api/enrollments/${t.enrollment.id}`)
        .send({ status: 'DROPPED' })
        .expect(200);
      await adminA
        .patch(`/api/enrollments/${t.enrollment.id}`)
        .send({ status: 'ENROLLED' })
        .expect(400);
    });

    it('docente que además administra otra sede: esa sede y sus cursos, nada más', async () => {
      const t = await teacherWithStudent(courseA1b, campusA1.id);
      await ctx.data.assignGlobalRole(
        t.teacher.user.id,
        institutionA.id,
        'INSTITUTION_ADMIN',
        campusA2.id,
      );
      const inA2 = await createStudent(institutionA.id, campusA2.id);
      const otherInA1 = await createStudent(institutionA.id, campusA1.id);
      expect(await t.sees(t.student.id)).toBe(true); // su curso
      expect(await t.sees(inA2.id)).toBe(true); // la sede que administra
      expect(await t.sees(otherInA1.id)).toBe(false);
    });

    it('filtro por curso: no revela matrículas de cursos ajenos', async () => {
      const t = await teacherWithStudent(courseA1, campusA1.id);
      // Su estudiante estuvo antes en 602 (curso donde no dicta).
      await adminA
        .patch(`/api/enrollments/${t.enrollment.id}`)
        .send({ courseId: courseA1b })
        .expect(200);
      await adminA
        .patch(`/api/enrollments/${t.enrollment.id}`)
        .send({ courseId: courseA1 })
        .expect(200);
      const foreign = await t.agent
        .get(`/api/students?courseId=${courseA1b}`)
        .expect(200);
      expect(foreign.body.data).toEqual([]);
      const own = await t.agent
        .get(`/api/students?courseId=${courseA1}&limit=100`)
        .expect(200);
      expect((own.body.data as { id: string }[]).map((x) => x.id)).toContain(
        t.student.id,
      );
      // Administrador de sede con un curso de otra sede: vacío.
      const other = await campusAdminA
        .get(`/api/students?courseId=${courseA2}`)
        .expect(200);
      expect(other.body.data).toEqual([]);
    });

    it('filtro por curso: exige el permiso de ver Cursos (B1 de la 3d-2)', async () => {
      const role = await ctx.data.createInstitutionRole(institutionA.id, [
        'people',
        'people.students',
      ]);
      const user = await ctx.data.createUser();
      await ctx.dataSource.query(
        'INSERT INTO user_institution_roles (user_id, institution_id, role_id) VALUES ($1, $2, $3)',
        [user.id, institutionA.id, role.id],
      );
      const agent = await loginAs(user.email);
      await agent.get('/api/students').expect(200);
      await agent.get(`/api/students?courseId=${courseA1}`).expect(403);
    });

    it('/mine: sin el rol TEACHER vigente, lista vacía', async () => {
      const t = await teacherWithStudent(courseA1, campusA1.id);
      const before = await t.agent
        .get('/api/teacher-assignments/mine')
        .expect(200);
      expect(before.body).toHaveLength(1);
      // Le quitan el rol TEACHER pero conserva otro rol en la institución.
      await ctx.data.assignGlobalRole(
        t.teacher.user.id,
        institutionA.id,
        'STUDENT',
        campusA1.id,
      );
      await ctx.dataSource.query(
        `DELETE FROM user_institution_roles WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE name = 'TEACHER' AND institution_id IS NULL)`,
        [t.teacher.user.id],
      );
      const after = await t.agent
        .get('/api/teacher-assignments/mine')
        .expect(200);
      expect(after.body).toEqual([]);
    });

    it('administrador de sede: carga y matrículas de otra sede responden 404', async () => {
      const t = await teacherWithStudent(courseA2, campusA2.id);
      const teacherB = await createTeacher(institutionB.id, null);
      await campusAdminA
        .post(`/api/teacher-assignments/${t.assignment.id}/replace`)
        .send({ teacherId: teacherB.id })
        .expect(404);
      await campusAdminA
        .patch(`/api/teacher-assignments/${t.assignment.id}/deactivate`)
        .expect(404);
      await campusAdminA
        .delete(`/api/teacher-assignments/${t.assignment.id}`)
        .expect(404);
      // Estudiante de otra sede (y su estado): 404, no 400.
      const inactiveA2 = await createStudent(institutionA.id, campusA2.id, {
        isActive: false,
      });
      await post(
        campusAdminA,
        '/api/enrollments',
        { studentId: inactiveA2.id, courseId: courseA1 },
        404,
      );
      // Mover una matrícula suya a un curso de otra sede o institución: 404.
      const mine = await createStudent(institutionA.id, campusA1.id);
      const e = await post(
        adminA,
        '/api/enrollments',
        { studentId: mine.id, courseId: courseA1 },
        201,
      );
      await campusAdminA
        .patch(`/api/enrollments/${e.id}`)
        .send({ courseId: courseA2 })
        .expect(404);
      await campusAdminA
        .patch(`/api/enrollments/${e.id}`)
        .send({ courseId: courseB })
        .expect(404);
      // Docente sin el rol TEACHER en sus sedes: 404.
      const onlyA2 = await createTeacher(institutionA.id, campusA2.id);
      await post(
        campusAdminA,
        '/api/teacher-assignments',
        { courseId: courseA1, subjectId: t.subject, teacherId: onlyA2.id },
        404,
      );
    });

    it('otra institución: no termina ni borra carga ajena (404)', async () => {
      const t = await teacherWithStudent(courseA1, campusA1.id);
      await adminB
        .patch(`/api/teacher-assignments/${t.assignment.id}/deactivate`)
        .expect(404);
      await adminB
        .delete(`/api/teacher-assignments/${t.assignment.id}`)
        .expect(404);
    });

    it('altas y reemplazos simultáneos: uno 201 y otro 409', async () => {
      const subject = (
        await post(adminA, '/api/subjects', { name: `E2E ${suffix()}` }, 201)
      ).id;
      const [t1, t2] = await Promise.all([
        createTeacher(institutionA.id, null),
        createTeacher(institutionA.id, null),
      ]);
      const creates = await Promise.all(
        [t1, t2].map((t) =>
          adminA
            .post('/api/teacher-assignments')
            .send({ courseId: courseA1, subjectId: subject, teacherId: t.id }),
        ),
      );
      expect(creates.map((r) => r.status).sort()).toEqual([201, 409]);
      const created = creates.find((r) => r.status === 201)!.body as {
        id: string;
        teacher: { id: string };
      };
      const others = await Promise.all([
        createTeacher(institutionA.id, null),
        createTeacher(institutionA.id, null),
      ]);
      const replaces = await Promise.all(
        others.map((t) =>
          adminA
            .post(`/api/teacher-assignments/${created.id}/replace`)
            .send({ teacherId: t.id }),
        ),
      );
      expect(replaces.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('las observaciones solo las ve quien puede editar matrículas (M1 de la 3d-2)', async () => {
      const s = await createStudent(institutionA.id, campusA1.id);
      const e = await post(
        adminA,
        '/api/enrollments',
        { studentId: s.id, courseId: courseA1, observations: 'Viene de Cali' },
        201,
      );
      const role = await ctx.data.createInstitutionRole(
        institutionA.id,
        ['academic', 'academic.enrollments'],
        { viewOnly: true },
      );
      const viewer = await ctx.data.createUser();
      await ctx.dataSource.query(
        'INSERT INTO user_institution_roles (user_id, institution_id, role_id) VALUES ($1, $2, $3)',
        [viewer.id, institutionA.id, role.id],
      );
      const agent = await loginAs(viewer.email);
      const seen = await agent.get(`/api/enrollments/${e.id}`).expect(200);
      expect(seen.body.status).toBe('ENROLLED');
      expect(seen.body).not.toHaveProperty('observations');
      // Quien puede editar en la sede del curso, sí.
      const full = await campusAdminA
        .get(`/api/enrollments/${e.id}`)
        .expect(200);
      expect(full.body.observations).toBe('Viene de Cali');
    });

    it('las observaciones solo van en el detalle', async () => {
      const s = await createStudent(institutionA.id, campusA1.id);
      const e = await post(
        adminA,
        '/api/enrollments',
        { studentId: s.id, courseId: courseA1, observations: 'Llega tarde' },
        201,
      );
      expect(e.observations).toBe('Llega tarde');
      const list = await adminA
        .get(`/api/enrollments?studentId=${s.id}`)
        .expect(200);
      expect(list.body.data[0]).not.toHaveProperty('observations');
    });
  });
});
