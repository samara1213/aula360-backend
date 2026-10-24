import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { schoolToday } from '../src/common/utils/school-date';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { UserInstitutionRoleEntity } from '../src/modules/security/entities/user-institution-role.entity';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { sharp } from '../src/storage/sharp';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Response = Awaited<ReturnType<Agent['get']>>;

/**
 * Una petición: `route` es la ruta registrada (con :params) y `path` la
 * concreta. `expected` es el status y el mensaje exactos (un 400 o 404 de
 * otra validación no puede ocultar que falte el filtro de institución).
 */
interface Call {
  route: string;
  path: string;
  body?: object;
  expected?: [number, string];
}

interface Person {
  id: string; // perfil (docente o estudiante)
  userId: string;
  email: string;
  documentNumber: string;
  lastName: string;
}

/** Datos completos de una institución, creados por la API. */
interface Tenant {
  institution: InstitutionEntity;
  tag: string; // en los nombres: las búsquedas distinguen A de B
  admin: Agent;
  adminUserId: string;
  campus1: string;
  campus2: string;
  year: string;
  period: string;
  grade: string;
  subject: string;
  course: string;
  assignment: string;
  evaluation: string;
  teacher: Person;
  student: Person;
  enrollment: string;
  role: string;
  roleAssignment: string;
  reportCard: string;
  levels: string[];
  /** Curso sin cargas ni matrículas y estudiante sin matrícula: se pueden mover. */
  freeCourse: string;
  freeStudent: Person;
  /** Invitaciones pendientes de la institución (a personas de una tercera). */
  teacherInvitation: string;
  studentInvitation: string;
}

const suffix = () => randomBytes(4).toString('hex');
/** Año lectivo anterior: el periodo ya terminó y se puede generar el boletín. */
const lastYear = Number(schoolToday().slice(0, 4)) - 1;
/** Las matrices hacen cientos de peticiones contra la base remota. */
const MATRIX_TIMEOUT = 300_000;
const MUST_CHANGE = 'Debe cambiar la contraseña';
const SUPER_ADMIN_ONLY = 'Este cambio solo lo puede hacer un SUPER_ADMIN';
const GLOBAL_ROLES = 'Los roles globales solo los gestiona el SUPER_ADMIN';
const whitelist = (field: string) => `property ${field} should not exist`;

function messageOf(res: Response): string {
  const message = (res.body as { message?: unknown }).message;
  return Array.isArray(message) ? message.join('; ') : String(message);
}

/**
 * Aislamiento entre instituciones (tarea 2.11.2): todos los actores de A con
 * los ids de B reciben 404 (o 403 en rutas solo SUPER_ADMIN) con el mensaje
 * exacto, B queda igual fila por fila y archivo por archivo, y ninguna ruta
 * registrada queda sin clasificar (una ruta nueva sin prueba de aislamiento
 * rompe la suite).
 */
describe('Aislamiento entre instituciones (e2e)', () => {
  let ctx: TestContext;
  let a: Tenant;
  let b: Tenant;
  let superAdmin: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a la sede 1 de A
  let teacherA: Agent;
  let studentA: Agent;
  let dual: Agent; // INSTITUTION_ADMIN de A y de B, con sesión en A
  let dualUserId: string;
  /** Docente en A y administrador en B: objetivo de las acciones de A. */
  let shared: Person & { teacherInA: string };
  let globalTeacherRole: string;
  let menuOptionId: string;
  let bFingerprint: string[];
  let globalFingerprint: string[];
  let bFiles: string[];
  let bEmails: string[];
  let mailCount: number;
  let bTemplate: string;
  let PNG: Buffer;

  /** Rutas cubiertas por cada grupo de pruebas (para la guardia de cobertura). */
  const covered = new Set<string>();

  const server = () => ctx.app.getHttpServer();

  async function loginAs(identifier: string): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  function call(agent: Agent, { route, path, body }: Call) {
    const method = route.split(' ')[0].toLowerCase() as Method;
    const req = agent[method](`/api${path}`);
    return body ? req.send(body) : req;
  }

  /** Compara con `expected` y devuelve la diferencia (o null). */
  async function check(agent: Agent, entry: Call): Promise<string | null> {
    const res = await call(agent, entry);
    const [status, message] = entry.expected!;
    if (res.status === status && messageOf(res) === message) return null;
    return `${entry.route} ${JSON.stringify(entry.body ?? {})} -> ${res.status} ${messageOf(res)} (esperado ${status} ${message})`;
  }

  async function ok<T = { id: string }>(
    agent: Agent,
    method: Method,
    path: string,
    body?: object,
  ): Promise<T> {
    const req = agent[method](`/api${path}`);
    const res = await (body ? req.send(body) : req);
    if (res.status >= 300) {
      throw new Error(`${method} ${path}: ${res.status} ${res.text}`);
    }
    return res.body as T;
  }

  /** Institución completa: sedes, año, periodo, curso, carga, notas, boletín... */
  async function buildTenant(name: string): Promise<Tenant> {
    const { data, dataSource } = ctx;
    const tag = `${name}${suffix()}`;
    const institution = await data.createInstitution(`Colegio ${name}`);
    const campus1 = (await data.createCampus(institution.id, 'Sede 1')).id;
    const campus2 = (await data.createCampus(institution.id, 'Sede 2')).id;
    const adminUser = await data.createUser();
    await data.assignGlobalRole(adminUser.id, institution.id);
    const admin = await loginAs(adminUser.email!);

    const levels = await ok<{ levels: { id: string }[] }>(
      admin,
      'put',
      '/performance-levels',
      {
        levels: [
          { name: 'Bajo', minScore: 1, maxScore: 2.99 },
          { name: 'Básico', minScore: 3, maxScore: 3.99 },
          { name: 'Alto', minScore: 4, maxScore: 4.59 },
          { name: 'Superior', minScore: 4.6, maxScore: 5 },
        ],
      },
    );

    const person = async (type: 'TEACHER' | 'STUDENT'): Promise<Person> => {
      const user = await data.createUser({ userType: type });
      await data.assignGlobalRole(user.id, institution.id, type);
      const entity = type === 'TEACHER' ? TeacherEntity : StudentEntity;
      const profile = await dataSource.getRepository(entity).save({
        userId: user.id,
        institutionId: institution.id,
        ...(type === 'STUDENT' ? { campusId: campus1 } : {}),
      });
      return {
        id: profile.id,
        userId: user.id,
        email: user.email!,
        documentNumber: user.documentNumber,
        lastName: user.lastName,
      };
    };
    const teacher = await person('TEACHER');
    const student = await person('STUDENT');
    const freeStudent = await person('STUDENT');

    const year = (
      await ok(admin, 'post', '/academic-years', { year: lastYear })
    ).id;
    const period = (
      await ok(admin, 'post', `/academic-years/${year}/periods`, {
        name: `Primero ${tag}`,
        startDate: `${lastYear}-02-01`,
        endDate: `${lastYear}-03-01`,
      })
    ).id;
    const grade = (await ok(admin, 'post', '/grades', { name: `Sexto ${tag}` }))
      .id;
    const subject = (
      await ok(admin, 'post', '/subjects', { name: `Física ${tag}` })
    ).id;
    const newCourse = async (prefix: string) =>
      (
        await ok(admin, 'post', '/courses', {
          name: `${prefix} ${tag}`,
          gradeId: grade,
          campusId: campus1,
          academicYearId: year,
        })
      ).id;
    const course = await newCourse('601');
    const freeCourse = await newCourse('602');
    const assignment = (
      await ok(admin, 'post', '/teacher-assignments', {
        courseId: course,
        subjectId: subject,
        teacherId: teacher.id,
      })
    ).id;
    const enrollment = (
      await ok(admin, 'post', '/enrollments', {
        studentId: student.id,
        courseId: course,
      })
    ).id;
    const evaluation = (
      await ok(admin, 'post', '/evaluations', {
        teacherAssignmentId: assignment,
        periodId: period,
        title: `Taller ${tag}`,
        percentage: 100,
        evaluationDate: `${lastYear}-02-10`,
      })
    ).id;
    await ok(admin, 'put', `/evaluations/${evaluation}/scores`, {
      scores: [{ studentId: student.id, score: 4.2 }],
    });
    const reportCard = (
      await ok(admin, 'post', '/report-cards', {
        studentId: student.id,
        periodId: period,
      })
    ).id;
    const role = (
      await ok(admin, 'post', '/roles', { name: `Coordinación ${tag}` })
    ).id;
    const roleAssignment = (
      await ok(admin, 'post', '/role-assignments', {
        userId: teacher.userId,
        roleId: role,
      })
    ).id;

    // Archivos: avatar del estudiante (lo sube él mismo).
    const studentAgent = await loginAs(student.email);
    await studentAgent
      .put('/api/users/me/avatar')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);

    return {
      institution,
      tag,
      admin,
      adminUserId: adminUser.id,
      campus1,
      campus2,
      year,
      period,
      grade,
      subject,
      course,
      assignment,
      evaluation,
      teacher,
      student,
      enrollment,
      role,
      roleAssignment,
      reportCard,
      levels: levels.levels.map((l) => l.id),
      freeCourse,
      freeStudent,
      // Se crean en beforeAll, cuando ya existen las dos instituciones.
      teacherInvitation: '',
      studentInvitation: '',
    };
  }

  async function rowsOf(
    sources: Record<string, string>,
    params: unknown[],
  ): Promise<string[]> {
    const rows: string[] = [];
    for (const [table, where] of Object.entries(sources)) {
      const result = await ctx.dataSource.query<{ row: string }[]>(
        `SELECT '${table}:' || to_jsonb(t)::text AS row FROM ${table} t WHERE ${where}`,
        params,
      );
      rows.push(...result.map((r) => r.row));
    }
    return rows.sort();
  }

  /**
   * Huella de todo lo de una institución: cada fila (todas sus columnas) de
   * las tablas que le pertenecen, también la de sus usuarios y sesiones.
   */
  function fingerprint(institutionId: string): Promise<string[]> {
    const years = `SELECT id FROM academic_years WHERE institution_id = $1`;
    const periods = `SELECT id FROM periods WHERE academic_year_id IN (${years})`;
    const courses = `SELECT id FROM courses WHERE academic_year_id IN (${years})`;
    const evaluations = `SELECT id FROM evaluations WHERE period_id IN (${periods})`;
    const roles = `SELECT id FROM roles WHERE institution_id = $1`;
    const users = `SELECT user_id FROM user_institution_roles WHERE institution_id = $1`;
    return rowsOf(
      {
        institutions: 'id = $1',
        campuses: 'institution_id = $1',
        academic_years: 'institution_id = $1',
        grades: 'institution_id = $1',
        subjects: 'institution_id = $1',
        roles: 'institution_id = $1',
        performance_levels: 'institution_id = $1',
        report_card_templates: 'institution_id = $1',
        teachers: 'institution_id = $1',
        students: 'institution_id = $1',
        user_institution_roles: 'institution_id = $1',
        periods: `id IN (${periods})`,
        courses: `id IN (${courses})`,
        teacher_subject_courses: `course_id IN (${courses})`,
        evaluations: `id IN (${evaluations})`,
        scores: `evaluation_id IN (${evaluations})`,
        enrollments: `academic_year_id IN (${years})`,
        report_cards: `period_id IN (${periods})`,
        role_menu_permissions: `role_id IN (${roles})`,
        users: `id IN (${users})`,
        refresh_tokens: `user_id IN (${users})`,
        password_reset_tokens: `user_id IN (${users})`,
        email_verification_tokens: `user_id IN (${users})`,
        storage_deletions: `split_part(path, '/', 1) = $1::uuid::text
           OR (split_part(path, '/', 1) = 'users' AND split_part(path, '/', 2) IN (SELECT user_id::text FROM user_institution_roles WHERE institution_id = $1::uuid))`,
      },
      [institutionId],
    );
  }

  /** Roles globales, sus permisos y los menús: deciden lo que puede hacer B. */
  function globalRows(): Promise<string[]> {
    const roles = `SELECT id FROM roles WHERE institution_id IS NULL`;
    return rowsOf(
      {
        roles: 'institution_id IS NULL',
        role_menu_permissions: `role_id IN (${roles})`,
        menu_options: 'true',
      },
      [],
    );
  }

  /** Archivos del Storage en memoria de la institución o de esos usuarios. */
  function filesOf(institutionId: string, userIds: string[]): string[] {
    return [...ctx.storage.objects.keys()]
      .filter(
        (key) =>
          key.includes(institutionId) || userIds.some((id) => key.includes(id)),
      )
      .sort();
  }

  async function usersOf(
    institutionId: string,
  ): Promise<{ id: string; email: string | null }[]> {
    return ctx.dataSource.query<{ id: string; email: string | null }[]>(
      `SELECT DISTINCT u.id, u.email FROM users u
         JOIN user_institution_roles r ON r.user_id = u.id
        WHERE r.institution_id = $1`,
      [institutionId],
    );
  }

  beforeAll(async () => {
    PNG = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#3366cc' },
    })
      .png()
      .toBuffer();
    ctx = await createTestApp();
    const { data, dataSource } = ctx;
    const superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
    superAdmin = await loginAs(superUser.email!);

    a = await buildTenant('A');
    b = await buildTenant('B');

    // Plantilla y logo de B (solo el SUPER_ADMIN los gestiona).
    const template = await superAdmin
      .post(`/api/institutions/${b.institution.id}/report-card-templates`)
      .field('name', 'Plantilla B')
      .attach(
        'file',
        Buffer.from('<html><body>{{student.firstName}}</body></html>'),
        { filename: 'b.html', contentType: 'text/html' },
      )
      .expect(201);
    bTemplate = template.body.id as string;
    await superAdmin
      .patch(
        `/api/institutions/${b.institution.id}/report-card-templates/${bTemplate}/activate`,
      )
      .expect(200);
    await superAdmin
      .put(`/api/institutions/${b.institution.id}/logo`)
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(200);

    const campusAdminUser = await data.createUser();
    await data.assignGlobalRole(
      campusAdminUser.id,
      a.institution.id,
      'INSTITUTION_ADMIN',
      a.campus1,
    );
    campusAdminA = await loginAs(campusAdminUser.email!);
    teacherA = await loginAs(a.teacher.email);
    studentA = await loginAs(a.student.email);

    const dualUser = await data.createUser();
    dualUserId = dualUser.id;
    await data.assignGlobalRole(dualUser.id, a.institution.id);
    await data.assignGlobalRole(dualUser.id, b.institution.id);
    dual = await loginAs(dualUser.email!);
    await dual
      .post('/api/auth/switch-institution')
      .send({ institutionId: a.institution.id })
      .expect(200);

    const sharedUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(sharedUser.id, a.institution.id, 'TEACHER');
    await data.assignGlobalRole(sharedUser.id, b.institution.id);
    const sharedProfile = await dataSource
      .getRepository(TeacherEntity)
      .save({ userId: sharedUser.id, institutionId: a.institution.id });
    shared = {
      id: sharedProfile.id,
      teacherInA: sharedProfile.id,
      userId: sharedUser.id,
      email: sharedUser.email!,
      documentNumber: sharedUser.documentNumber,
      lastName: sharedUser.lastName,
    };

    globalTeacherRole = (
      await dataSource.query<{ id: string }[]>(
        `SELECT id FROM roles WHERE name = 'TEACHER' AND institution_id IS NULL`,
      )
    )[0].id;
    menuOptionId = (
      await dataSource.query<{ id: string }[]>(
        `SELECT id FROM menu_options WHERE slug = 'academic.courses'`,
      )
    )[0].id;

    // Cada institución invita a un docente y a un estudiante de una tercera.
    const third = await data.createInstitution('Colegio C');
    for (const t of [a, b]) {
      const invite = async (profile: 'TEACHER' | 'STUDENT') => {
        const invited = await data.createUser({ userType: profile });
        await data.assignGlobalRole(invited.id, third.id, profile);
        const kind = profile === 'TEACHER' ? 'teachers' : 'students';
        return (
          await ok(t.admin, 'post', `/${kind}/invitations`, {
            documentType: invited.documentType,
            documentNumber: invited.documentNumber,
            campusId: t.campus1,
          })
        ).id;
      };
      t.teacherInvitation = await invite('TEACHER');
      t.studentInvitation = await invite('STUDENT');
    }

    const bUsers = await usersOf(b.institution.id);
    bEmails = bUsers.flatMap((u) => (u.email ? [u.email] : []));
    bFingerprint = await fingerprint(b.institution.id);
    globalFingerprint = await globalRows();
    bFiles = filesOf(
      b.institution.id,
      bUsers.map((u) => u.id),
    );
    expect(bFiles.length).toBeGreaterThanOrEqual(3); // avatar, PDF y logo
    mailCount = ctx.mail.messages.length;
  }, 300_000);

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  /**
   * Rutas que reciben un id de recurso de `t` (con el 404 que deben dar a
   * otra institución). `other` aporta ids válidos para los bodies.
   */
  const idRoutes = (t: Tenant, other: Tenant): Call[] => {
    const nf = (message: string): [number, string] => [404, message];
    const year = nf('Año lectivo no encontrado');
    const period = nf('Periodo no encontrado');
    const grade = nf('Grado no encontrado');
    const subject = nf('Materia no encontrada');
    const course = nf('Curso no encontrado');
    const load = nf('Asignación no encontrada');
    const enrollment = nf('Matrícula no encontrada');
    const evaluation = nf('Evaluación no encontrada');
    const campus = nf('Sede no encontrada');
    const user = nf('Usuario no encontrado');
    const teacher = nf('Docente no encontrado');
    const student = nf('Estudiante no encontrado');
    const role = nf('Rol no encontrado');
    return [
      {
        route: 'GET /academic-years/:id',
        path: `/academic-years/${t.year}`,
        expected: year,
      },
      {
        route: 'PATCH /academic-years/:id',
        path: `/academic-years/${t.year}`,
        body: { isActive: false },
        expected: year,
      },
      {
        route: 'DELETE /academic-years/:id',
        path: `/academic-years/${t.year}`,
        expected: year,
      },
      {
        route: 'GET /academic-years/:id/periods',
        path: `/academic-years/${t.year}/periods`,
        expected: year,
      },
      {
        route: 'POST /academic-years/:id/periods',
        path: `/academic-years/${t.year}/periods`,
        body: {
          name: 'Intruso',
          startDate: `${lastYear}-04-01`,
          endDate: `${lastYear}-05-01`,
        },
        expected: year,
      },
      {
        route: 'GET /periods/:id',
        path: `/periods/${t.period}`,
        expected: period,
      },
      {
        route: 'PATCH /periods/:id',
        path: `/periods/${t.period}`,
        body: { name: 'Cambiado' },
        expected: period,
      },
      {
        route: 'DELETE /periods/:id',
        path: `/periods/${t.period}`,
        expected: period,
      },
      { route: 'GET /grades/:id', path: `/grades/${t.grade}`, expected: grade },
      {
        route: 'PATCH /grades/:id',
        path: `/grades/${t.grade}`,
        body: { name: 'Cambiado' },
        expected: grade,
      },
      {
        route: 'DELETE /grades/:id',
        path: `/grades/${t.grade}`,
        expected: grade,
      },
      {
        route: 'GET /subjects/:id',
        path: `/subjects/${t.subject}`,
        expected: subject,
      },
      {
        route: 'PATCH /subjects/:id',
        path: `/subjects/${t.subject}`,
        body: { name: 'Cambiado' },
        expected: subject,
      },
      {
        route: 'DELETE /subjects/:id',
        path: `/subjects/${t.subject}`,
        expected: subject,
      },
      {
        route: 'GET /courses/:id',
        path: `/courses/${t.course}`,
        expected: course,
      },
      {
        route: 'PATCH /courses/:id',
        path: `/courses/${t.course}`,
        body: { name: 'Cambiado' },
        expected: course,
      },
      {
        route: 'DELETE /courses/:id',
        path: `/courses/${t.course}`,
        expected: course,
      },
      {
        route: 'GET /teacher-assignments/:id',
        path: `/teacher-assignments/${t.assignment}`,
        expected: load,
      },
      {
        route: 'POST /teacher-assignments/:id/replace',
        path: `/teacher-assignments/${t.assignment}/replace`,
        body: { teacherId: other.teacher.id },
        expected: load,
      },
      {
        route: 'PATCH /teacher-assignments/:id/deactivate',
        path: `/teacher-assignments/${t.assignment}/deactivate`,
        expected: load,
      },
      {
        route: 'DELETE /teacher-assignments/:id',
        path: `/teacher-assignments/${t.assignment}`,
        expected: load,
      },
      {
        route: 'GET /enrollments/:id',
        path: `/enrollments/${t.enrollment}`,
        expected: enrollment,
      },
      {
        route: 'PATCH /enrollments/:id',
        path: `/enrollments/${t.enrollment}`,
        body: { observations: 'Intruso' },
        expected: enrollment,
      },
      {
        route: 'GET /evaluations/:id',
        path: `/evaluations/${t.evaluation}`,
        expected: evaluation,
      },
      {
        route: 'PATCH /evaluations/:id',
        path: `/evaluations/${t.evaluation}`,
        body: { title: 'Cambiado' },
        expected: evaluation,
      },
      {
        route: 'DELETE /evaluations/:id',
        path: `/evaluations/${t.evaluation}`,
        expected: evaluation,
      },
      {
        route: 'GET /evaluations/:id/scores',
        path: `/evaluations/${t.evaluation}/scores`,
        expected: evaluation,
      },
      {
        route: 'PUT /evaluations/:id/scores',
        path: `/evaluations/${t.evaluation}/scores`,
        body: { scores: [{ studentId: t.student.id, score: 1 }] },
        expected: evaluation,
      },
      {
        route: 'GET /gradebook/courses/:courseId',
        path: `/gradebook/courses/${t.course}?periodId=${t.period}`,
        expected: course,
      },
      {
        route: 'GET /gradebook/students/:studentId',
        path: `/gradebook/students/${t.student.id}?periodId=${t.period}`,
        expected: student,
      },
      {
        route: 'GET /campuses/:id',
        path: `/campuses/${t.campus1}`,
        expected: campus,
      },
      {
        route: 'PATCH /campuses/:id',
        path: `/campuses/${t.campus1}`,
        body: { name: 'Cambiada' },
        expected: campus,
      },
      {
        route: 'PATCH /campuses/:id/deactivate',
        path: `/campuses/${t.campus2}/deactivate`,
        expected: campus,
      },
      {
        route: 'PATCH /campuses/:id/activate',
        path: `/campuses/${t.campus2}/activate`,
        expected: campus,
      },
      {
        route: 'GET /report-cards/:id/download',
        path: `/report-cards/${t.reportCard}/download`,
        expected: nf('Boletín no encontrado'),
      },
      {
        route: 'GET /report-cards/:id/pdf',
        path: `/report-cards/${t.reportCard}/pdf`,
        expected: nf('Boletín no encontrado'),
      },
      {
        route: 'GET /users/:id',
        path: `/users/${t.student.userId}`,
        expected: user,
      },
      {
        route: 'GET /users/:id/avatar',
        path: `/users/${t.student.userId}/avatar`,
        expected: user,
      },
      {
        route: 'PATCH /users/:id',
        path: `/users/${t.student.userId}`,
        body: { firstName: 'Cambiado' },
        expected: user,
      },
      {
        route: 'PATCH /users/:id/status',
        path: `/users/${t.student.userId}/status`,
        body: { isActive: false },
        expected: user,
      },
      {
        route: 'POST /users/:id/temporary-password',
        path: `/users/${t.student.userId}/temporary-password`,
        expected: user,
      },
      {
        route: 'DELETE /users/:id/institution-access',
        path: `/users/${t.student.userId}/institution-access`,
        expected: user,
      },
      {
        route: 'DELETE /teachers/invitations/:invitationId',
        path: `/teachers/invitations/${t.teacherInvitation}`,
        expected: nf('Invitación no encontrada'),
      },
      {
        route: 'DELETE /students/invitations/:invitationId',
        path: `/students/invitations/${t.studentInvitation}`,
        expected: nf('Invitación no encontrada'),
      },
      {
        // Solo la persona invitada responde la suya.
        route: 'POST /users/me/invitations/:id/accept',
        path: `/users/me/invitations/${t.teacherInvitation}/accept`,
        expected: nf('Invitación no encontrada'),
      },
      {
        route: 'POST /users/me/invitations/:id/reject',
        path: `/users/me/invitations/${t.studentInvitation}/reject`,
        expected: nf('Invitación no encontrada'),
      },
      {
        route: 'GET /teachers/:id',
        path: `/teachers/${t.teacher.id}`,
        expected: teacher,
      },
      {
        route: 'PATCH /teachers/:id',
        path: `/teachers/${t.teacher.id}`,
        body: { specialty: 'Intrusión' },
        expected: teacher,
      },
      {
        route: 'GET /students/:id',
        path: `/students/${t.student.id}`,
        expected: student,
      },
      {
        route: 'PATCH /students/:id',
        path: `/students/${t.student.id}`,
        body: { guardianName: 'Intruso' },
        expected: student,
      },
      { route: 'GET /roles/:id', path: `/roles/${t.role}`, expected: role },
      {
        route: 'PATCH /roles/:id',
        path: `/roles/${t.role}`,
        body: { name: 'Cambiado' },
        expected: role,
      },
      {
        route: 'PUT /roles/:id/permissions',
        path: `/roles/${t.role}/permissions`,
        body: { permissions: [{ menuOptionId, canCreate: true }] },
        expected: role,
      },
      { route: 'DELETE /roles/:id', path: `/roles/${t.role}`, expected: role },
      {
        route: 'DELETE /role-assignments/:id',
        path: `/role-assignments/${t.roleAssignment}`,
        expected: nf('Asignación no encontrada'),
      },
    ];
  };

  /** Rutas solo SUPER_ADMIN: cualquier otro actor recibe 403 (con ids de B). */
  const superAdminRoutes = (): Call[] => {
    const inst = b.institution.id;
    const users = `/institutions/${inst}/users`;
    const assignments = `/institutions/${inst}/role-assignments`;
    const templates = `/institutions/${inst}/report-card-templates`;
    const campuses = `/institutions/${inst}/campuses`;
    return [
      { route: 'GET /institutions', path: '/institutions' },
      { route: 'GET /institutions/:institutionId/campuses', path: campuses },
      {
        route: 'POST /institutions/:institutionId/campuses',
        path: campuses,
        body: { name: `Intrusa ${suffix()}` },
      },
      {
        route: 'PATCH /institutions/:institutionId/campuses/:id',
        path: `${campuses}/${b.campus1}`,
        body: { name: 'Cambiada' },
      },
      {
        route: 'PATCH /institutions/:institutionId/campuses/:id/deactivate',
        path: `${campuses}/${b.campus1}/deactivate`,
      },
      {
        route: 'PATCH /institutions/:institutionId/campuses/:id/activate',
        path: `${campuses}/${b.campus1}/activate`,
      },
      {
        route: 'GET /users/lookup',
        path: '/users/lookup?email=nadie%40aula360.test',
      },
      {
        route: 'POST /institutions',
        path: '/institutions',
        body: { nit: `E2E-${suffix()}`, name: 'Intrusa' },
      },
      { route: 'GET /institutions/:id', path: `/institutions/${inst}` },
      {
        route: 'PATCH /institutions/:id',
        path: `/institutions/${inst}`,
        body: { name: 'Cambiada' },
      },
      {
        route: 'PUT /institutions/:id/logo',
        path: `/institutions/${inst}/logo`,
      },
      {
        route: 'DELETE /institutions/:id/logo',
        path: `/institutions/${inst}/logo`,
      },
      {
        route: 'PATCH /institutions/:id/deactivate',
        path: `/institutions/${inst}/deactivate`,
      },
      {
        route: 'PATCH /institutions/:id/activate',
        path: `/institutions/${inst}/activate`,
      },
      { route: 'GET /institutions/:institutionId/users', path: users },
      {
        route: 'POST /institutions/:institutionId/users',
        path: users,
        body: {
          userType: 'INSTITUTION_ADMIN',
          documentType: 'CC',
          documentNumber: `E2E${suffix()}`,
          firstName: 'Intruso',
          lastName: 'E2E',
          roleId: globalTeacherRole,
        },
      },
      {
        route: 'GET /institutions/:institutionId/users/:id',
        path: `${users}/${b.student.userId}`,
      },
      {
        route: 'PATCH /institutions/:institutionId/users/:id',
        path: `${users}/${b.student.userId}`,
        body: { firstName: 'Cambiado' },
      },
      {
        route: 'PATCH /institutions/:institutionId/users/:id/status',
        path: `${users}/${b.student.userId}/status`,
        body: { isActive: false },
      },
      {
        route: 'POST /institutions/:institutionId/users/:id/temporary-password',
        path: `${users}/${b.student.userId}/temporary-password`,
      },
      {
        route: 'GET /institutions/:institutionId/role-assignments',
        path: assignments,
      },
      {
        route: 'POST /institutions/:institutionId/role-assignments',
        path: assignments,
        body: { userId: b.teacher.userId, roleId: b.role },
      },
      {
        route: 'DELETE /institutions/:institutionId/role-assignments/:id',
        path: `${assignments}/${b.roleAssignment}`,
      },
      {
        route: 'GET /institutions/:institutionId/report-card-templates',
        path: templates,
      },
      {
        route: 'POST /institutions/:institutionId/report-card-templates',
        path: templates,
      },
      {
        route:
          'GET /institutions/:institutionId/report-card-templates/system/preview',
        path: `${templates}/system/preview`,
      },
      {
        route:
          'GET /institutions/:institutionId/report-card-templates/:id/preview',
        path: `${templates}/${bTemplate}/preview`,
      },
      {
        route:
          'PATCH /institutions/:institutionId/report-card-templates/:id/activate',
        path: `${templates}/${bTemplate}/activate`,
      },
      {
        route:
          'PATCH /institutions/:institutionId/report-card-templates/:id/deactivate',
        path: `${templates}/${bTemplate}/deactivate`,
      },
      {
        route: 'DELETE /institutions/:institutionId/report-card-templates/:id',
        path: `${templates}/${bTemplate}`,
      },
      { route: 'GET /global-roles', path: '/global-roles' },
      { route: 'GET /global-roles/:id', path: `/global-roles/${b.role}` },
      {
        route: 'POST /global-roles',
        path: '/global-roles',
        body: { name: `E2E Intruso ${suffix()}` },
      },
      {
        route: 'PATCH /global-roles/:id',
        path: `/global-roles/${b.role}`,
        body: { name: 'Cambiado' },
      },
      {
        route: 'PUT /global-roles/:id/permissions',
        path: `/global-roles/${b.role}/permissions`,
        body: { permissions: [{ menuOptionId }] },
      },
      { route: 'DELETE /global-roles/:id', path: `/global-roles/${b.role}` },
      {
        route: 'POST /menu-options',
        path: '/menu-options',
        body: { name: 'Intrusa', slug: `e2e-${suffix()}` },
      },
      {
        route: 'PATCH /menu-options/:id',
        path: `/menu-options/${menuOptionId}`,
        body: { name: 'Cambiada' },
      },
      {
        route: 'PATCH /menu-options/:id/deactivate',
        path: `/menu-options/${menuOptionId}/deactivate`,
      },
      {
        route: 'PATCH /menu-options/:id/activate',
        path: `/menu-options/${menuOptionId}/activate`,
      },
    ];
  };

  describe('controles: cada actor accede a lo suyo', () => {
    it(
      'las mismas rutas con ids de A responden al administrador de A',
      async () => {
        const failures: string[] = [];
        for (const entry of idRoutes(a, b)) {
          if (!entry.route.startsWith('GET ')) continue;
          const res = await call(a.admin, entry);
          if (res.status !== 200) {
            failures.push(`${entry.path} -> ${res.status} ${messageOf(res)}`);
          }
        }
        expect(failures).toEqual([]);
      },
      MATRIX_TIMEOUT,
    );

    it('/teacher-assignments/mine/periods: el docente de A solo ve los periodos de A', async () => {
      const res = await teacherA
        .get('/api/teacher-assignments/mine/periods')
        .expect(200);
      expect((res.body as { id: string }[]).map((p) => p.id)).toEqual([
        a.period,
      ]);
    });

    it('docente, estudiante, administrador de sede y usuario de A y B tienen sesión útil', async () => {
      await teacherA.get('/api/teacher-assignments/mine').expect(200);
      await studentA.get('/api/gradebook/mine').expect(200);
      await studentA.get('/api/report-cards/mine').expect(200);
      await campusAdminA.get(`/api/courses/${a.course}`).expect(200);
      await dual.get(`/api/courses/${a.course}`).expect(200);
    });
  });

  describe('ids de B en la ruta', () => {
    it(
      'administrador de A y usuario de A y B con sesión en A: 404 exacto en todas',
      async () => {
        const failures: string[] = [];
        for (const agent of [a.admin, dual]) {
          for (const entry of idRoutes(b, a)) {
            covered.add(entry.route);
            const failure = await check(agent, entry);
            if (failure) failures.push(failure);
          }
        }
        expect(failures).toEqual([]);
      },
      MATRIX_TIMEOUT,
    );

    it(
      'administrador de sede, docente, estudiante y SUPER_ADMIN: 403 o 404, nunca acceso',
      async () => {
        const failures: string[] = [];
        for (const agent of [campusAdminA, teacherA, studentA, superAdmin]) {
          for (const entry of idRoutes(b, a)) {
            const res = await call(agent, entry);
            const message = messageOf(res);
            if (
              (res.status !== 403 && res.status !== 404) ||
              message === MUST_CHANGE ||
              message.startsWith('Cannot ')
            ) {
              failures.push(`${entry.route} -> ${res.status} ${message}`);
            }
          }
        }
        expect(failures).toEqual([]);
      },
      MATRIX_TIMEOUT,
    );

    it(
      'rutas solo SUPER_ADMIN: 403 para todos los actores de A',
      async () => {
        const failures: string[] = [];
        for (const agent of [a.admin, dual, campusAdminA, teacherA, studentA]) {
          for (const entry of superAdminRoutes()) {
            covered.add(entry.route);
            const res = await call(agent, entry);
            if (res.status !== 403 || messageOf(res) === MUST_CHANGE) {
              failures.push(
                `${entry.route} -> ${res.status} ${messageOf(res)}`,
              );
            }
          }
        }
        expect(failures).toEqual([]);
      },
      MATRIX_TIMEOUT,
    );

    it('SUPER_ADMIN: un recurso de B pedido bajo la ruta de A da 404', async () => {
      const inst = a.institution.id;
      const users = `/institutions/${inst}/users/${b.student.userId}`;
      const templates = `/institutions/${inst}/report-card-templates/${bTemplate}`;
      const user: [number, string] = [404, 'Usuario no encontrado'];
      const template: [number, string] = [404, 'Plantilla no encontrada'];
      const campus: [number, string] = [404, 'Sede no encontrada'];
      const campuses = `/institutions/${inst}/campuses/${b.campus1}`;
      const entries: Call[] = [
        {
          route: 'PATCH /institutions/:institutionId/campuses/:id',
          path: campuses,
          body: { name: 'Cambiada' },
          expected: campus,
        },
        {
          route: 'PATCH /institutions/:institutionId/campuses/:id/deactivate',
          path: `${campuses}/deactivate`,
          expected: campus,
        },
        {
          route: 'PATCH /institutions/:institutionId/campuses/:id/activate',
          path: `${campuses}/activate`,
          expected: campus,
        },
        {
          route: 'GET /institutions/:institutionId/users/:id',
          path: users,
          expected: user,
        },
        {
          route: 'PATCH /institutions/:institutionId/users/:id',
          path: users,
          body: { firstName: 'Cambiado' },
          expected: user,
        },
        {
          route: 'PATCH /institutions/:institutionId/users/:id/status',
          path: `${users}/status`,
          body: { isActive: false },
          expected: user,
        },
        {
          route:
            'POST /institutions/:institutionId/users/:id/temporary-password',
          path: `${users}/temporary-password`,
          expected: user,
        },
        {
          route: 'DELETE /institutions/:institutionId/role-assignments/:id',
          path: `/institutions/${inst}/role-assignments/${b.roleAssignment}`,
          expected: [404, 'Asignación no encontrada'],
        },
        {
          route:
            'GET /institutions/:institutionId/report-card-templates/:id/preview',
          path: `${templates}/preview`,
          expected: template,
        },
        {
          route:
            'PATCH /institutions/:institutionId/report-card-templates/:id/activate',
          path: `${templates}/activate`,
          expected: template,
        },
        {
          route:
            'PATCH /institutions/:institutionId/report-card-templates/:id/deactivate',
          path: `${templates}/deactivate`,
          expected: template,
        },
        {
          route:
            'DELETE /institutions/:institutionId/report-card-templates/:id',
          path: templates,
          expected: template,
        },
      ];
      const failures: string[] = [];
      for (const entry of entries) {
        const failure = await check(superAdmin, entry);
        if (failure) failures.push(failure);
      }
      expect(failures).toEqual([]);
    });
  });

  describe('ids de B dentro del body o de la query', () => {
    /** Crear o editar en A apuntando a datos de B: el 404 de ese dato. */
    const injections = (): Call[] => {
      const course = {
        name: `Intruso ${suffix()}`,
        gradeId: a.grade,
        campusId: a.campus1,
        academicYearId: a.year,
      };
      const evaluation = {
        teacherAssignmentId: a.assignment,
        periodId: a.period,
        title: 'Intrusa',
        percentage: 10,
        evaluationDate: `${lastYear}-02-10`,
      };
      const person = () => ({
        documentType: 'CC',
        documentNumber: `E2E${suffix()}`,
        firstName: 'Intruso',
        lastName: 'E2E',
      });
      const inst = { institutionId: b.institution.id };
      const nf = (message: string): [number, string] => [404, message];
      const notWhitelisted: [number, string] = [
        400,
        whitelist('institutionId'),
      ];
      return [
        {
          route: 'POST /academic-years',
          path: '/academic-years',
          body: { year: lastYear - 1, ...inst },
          expected: notWhitelisted,
        },
        {
          route: 'POST /grades',
          path: '/grades',
          body: { name: 'Intruso', ...inst },
          expected: notWhitelisted,
        },
        {
          route: 'POST /subjects',
          path: '/subjects',
          body: { name: 'Intrusa', ...inst },
          expected: notWhitelisted,
        },
        {
          route: 'POST /campuses',
          path: '/campuses',
          body: { name: 'Intrusa', ...inst },
          expected: notWhitelisted,
        },
        {
          route: 'POST /roles',
          path: '/roles',
          body: { name: 'Intruso', ...inst },
          expected: notWhitelisted,
        },
        {
          route: 'PUT /performance-levels',
          path: '/performance-levels',
          body: {
            levels: [{ name: 'Único', minScore: 1, maxScore: 5 }],
            ...inst,
          },
          expected: notWhitelisted,
        },
        {
          route: 'POST /courses',
          path: '/courses',
          body: { ...course, gradeId: b.grade },
          expected: nf('Grado no encontrado'),
        },
        {
          route: 'POST /courses',
          path: '/courses',
          body: { ...course, campusId: b.campus1 },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /courses',
          path: '/courses',
          body: { ...course, academicYearId: b.year },
          expected: nf('Año lectivo no encontrado'),
        },
        {
          route: 'PATCH /courses/:id',
          path: `/courses/${a.freeCourse}`,
          body: { gradeId: b.grade },
          expected: nf('Grado no encontrado'),
        },
        {
          route: 'PATCH /courses/:id',
          path: `/courses/${a.freeCourse}`,
          body: { campusId: b.campus1 },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'PATCH /courses/:id',
          path: `/courses/${a.freeCourse}`,
          body: { academicYearId: b.year },
          expected: nf('Año lectivo no encontrado'),
        },
        {
          route: 'POST /teacher-assignments',
          path: '/teacher-assignments',
          body: {
            courseId: b.course,
            subjectId: a.subject,
            teacherId: a.teacher.id,
          },
          expected: nf('Curso no encontrado'),
        },
        {
          route: 'POST /teacher-assignments',
          path: '/teacher-assignments',
          body: {
            courseId: a.freeCourse,
            subjectId: b.subject,
            teacherId: a.teacher.id,
          },
          expected: nf('Materia no encontrada'),
        },
        {
          route: 'POST /teacher-assignments',
          path: '/teacher-assignments',
          body: {
            courseId: a.freeCourse,
            subjectId: a.subject,
            teacherId: b.teacher.id,
          },
          expected: nf('Docente no encontrado'),
        },
        {
          route: 'POST /teacher-assignments/:id/replace',
          path: `/teacher-assignments/${a.assignment}/replace`,
          body: { teacherId: b.teacher.id },
          expected: nf('Docente no encontrado'),
        },
        {
          route: 'POST /enrollments',
          path: '/enrollments',
          body: { studentId: b.freeStudent.id, courseId: a.course },
          expected: nf('Estudiante no encontrado'),
        },
        {
          route: 'POST /enrollments',
          path: '/enrollments',
          body: { studentId: a.freeStudent.id, courseId: b.course },
          expected: nf('Curso no encontrado'),
        },
        {
          route: 'PATCH /enrollments/:id',
          path: `/enrollments/${a.enrollment}`,
          body: { courseId: b.freeCourse },
          expected: nf('Curso no encontrado'),
        },
        {
          route: 'POST /evaluations',
          path: '/evaluations',
          body: { ...evaluation, teacherAssignmentId: b.assignment },
          expected: nf('Carga académica no encontrada'),
        },
        {
          route: 'POST /evaluations',
          path: '/evaluations',
          body: { ...evaluation, periodId: b.period },
          expected: nf('Periodo no encontrado'),
        },
        {
          route: 'PUT /evaluations/:id/scores',
          path: `/evaluations/${a.evaluation}/scores`,
          body: { scores: [{ studentId: b.student.id, score: 1 }] },
          // Por diseño: no tiene matrícula vigente en el curso de A.
          expected: [
            400,
            `scores[0] (${b.student.id}): el estudiante no tiene matrícula vigente en el curso`,
          ],
        },
        {
          route: 'POST /report-cards',
          path: '/report-cards',
          body: { studentId: b.student.id, periodId: a.period },
          expected: nf(
            'Estudiante no encontrado o sin matrícula en el año del periodo',
          ),
        },
        {
          route: 'POST /report-cards',
          path: '/report-cards',
          body: { studentId: a.student.id, periodId: b.period },
          expected: nf('Periodo no encontrado'),
        },
        {
          route: 'POST /report-cards/batch',
          path: '/report-cards/batch',
          body: { courseId: b.course, periodId: a.period },
          expected: nf('Curso no encontrado'),
        },
        {
          route: 'POST /report-cards/batch',
          path: '/report-cards/batch',
          body: { courseId: a.course, periodId: b.period },
          expected: nf('Periodo no encontrado'),
        },
        {
          route: 'POST /users',
          path: '/users',
          body: { ...person(), userType: 'INSTITUTION_ADMIN', roleId: b.role },
          expected: nf('Rol no encontrado'),
        },
        {
          route: 'POST /users',
          path: '/users',
          body: {
            ...person(),
            userType: 'INSTITUTION_ADMIN',
            roleId: a.role,
            campusId: b.campus1,
          },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /teachers',
          path: '/teachers',
          body: { ...person(), campusId: b.campus1 },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /students',
          path: '/students',
          body: { ...person(), campusId: b.campus1 },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /teachers/invitations',
          path: '/teachers/invitations',
          body: {
            documentType: 'CC',
            documentNumber: b.teacher.documentNumber,
            campusId: b.campus1,
          },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /students/invitations',
          path: '/students/invitations',
          body: {
            documentType: 'CC',
            documentNumber: b.student.documentNumber,
            campusId: b.campus1,
          },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'PATCH /students/:id',
          path: `/students/${a.freeStudent.id}`,
          body: { campusId: b.campus1 },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /role-assignments',
          path: '/role-assignments',
          body: { userId: b.student.userId, roleId: a.role },
          expected: nf('Usuario no encontrado'),
        },
        {
          route: 'POST /role-assignments',
          path: '/role-assignments',
          body: { userId: a.teacher.userId, roleId: b.role },
          expected: nf('Rol no encontrado'),
        },
        {
          route: 'POST /role-assignments',
          path: '/role-assignments',
          body: {
            userId: a.teacher.userId,
            roleId: a.role,
            campusId: b.campus1,
          },
          expected: nf('Sede no encontrada'),
        },
        {
          route: 'POST /auth/switch-institution',
          path: '/auth/switch-institution',
          body: inst,
          expected: nf('Institución no encontrada'),
        },
        // Ids mezclados en la query: recurso de A con periodo o año de B.
        {
          route: 'GET /gradebook/courses/:courseId',
          path: `/gradebook/courses/${a.course}?periodId=${b.period}`,
          expected: nf('Periodo no encontrado'),
        },
        {
          route: 'GET /gradebook/students/:studentId',
          path: `/gradebook/students/${a.student.id}?academicYearId=${b.year}`,
          expected: nf('Año lectivo no encontrado'),
        },
        {
          route: 'GET /gradebook/mine',
          path: `/gradebook/mine?academicYearId=${b.year}`,
          expected: nf('Año lectivo no encontrado'),
        },
      ];
    };

    it(
      'administrador de A: el 404 exacto del dato de B y nada cambia en A',
      async () => {
        const before = await fingerprint(a.institution.id);
        const failures: string[] = [];
        for (const entry of injections()) {
          covered.add(entry.route);
          const agent =
            entry.route === 'GET /gradebook/mine' ? studentA : a.admin;
          const failure = await check(agent, entry);
          if (failure) failures.push(failure);
        }
        expect(failures).toEqual([]);
        expect(await fingerprint(a.institution.id)).toEqual(before);
      },
      MATRIX_TIMEOUT,
    );

    it('SUPER_ADMIN: datos de B en una ruta de A dan el 404 de ese dato', async () => {
      const inst = a.institution.id;
      const entries: Call[] = [
        {
          route: 'POST /institutions/:institutionId/role-assignments',
          path: `/institutions/${inst}/role-assignments`,
          body: { userId: a.teacher.userId, roleId: b.role },
          expected: [404, 'Rol no encontrado'],
        },
        {
          route: 'POST /institutions/:institutionId/role-assignments',
          path: `/institutions/${inst}/role-assignments`,
          body: {
            userId: a.teacher.userId,
            roleId: globalTeacherRole,
            campusId: b.campus1,
          },
          expected: [404, 'Sede no encontrada'],
        },
        {
          route: 'POST /institutions/:institutionId/users',
          path: `/institutions/${inst}/users`,
          body: {
            userType: 'INSTITUTION_ADMIN',
            documentType: 'CC',
            documentNumber: `E2E${suffix()}`,
            firstName: 'Intruso',
            lastName: 'E2E',
            roleId: b.role,
          },
          expected: [404, 'Rol no encontrado'],
        },
      ];
      const before = await fingerprint(a.institution.id);
      const failures: string[] = [];
      for (const entry of entries) {
        const failure = await check(superAdmin, entry);
        if (failure) failures.push(failure);
      }
      expect(failures).toEqual([]);
      expect(await fingerprint(a.institution.id)).toEqual(before);
    });

    it('los roles globales (que también usa B) no se tocan desde A', async () => {
      const forbidden: [number, string] = [403, GLOBAL_ROLES];
      const entries: Call[] = [
        {
          route: 'PATCH /roles/:id',
          path: `/roles/${globalTeacherRole}`,
          body: { name: 'Cambiado' },
          expected: forbidden,
        },
        {
          route: 'PUT /roles/:id/permissions',
          path: `/roles/${globalTeacherRole}/permissions`,
          body: { permissions: [{ menuOptionId, canDelete: true }] },
          expected: forbidden,
        },
        {
          route: 'DELETE /roles/:id',
          path: `/roles/${globalTeacherRole}`,
          expected: forbidden,
        },
      ];
      const failures: string[] = [];
      for (const agent of [a.admin, dual]) {
        for (const entry of entries) {
          const failure = await check(agent, entry);
          if (failure) failures.push(failure);
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe('listados', () => {
    /**
     * Listados de A, sin filtro y filtrando por ids de B. `own` es un id de A
     * que el administrador de A debe ver (si no, la prueba no demuestra nada).
     */
    const lists = (): (Call & { own?: string })[] => [
      {
        route: 'GET /academic-years',
        path: '/academic-years',
        own: a.year,
      },
      { route: 'GET /grades', path: '/grades', own: a.grade },
      { route: 'GET /subjects', path: '/subjects', own: a.subject },
      { route: 'GET /campuses', path: '/campuses', own: a.campus1 },
      { route: 'GET /roles', path: '/roles?limit=100', own: a.role },
      {
        route: 'GET /performance-levels',
        path: '/performance-levels',
        own: a.levels[0],
      },
      {
        route: 'GET /institutions/current',
        path: '/institutions/current',
        own: a.institution.id,
      },
      { route: 'GET /menu-options/my-menu', path: '/menu-options/my-menu' },
      {
        route: 'GET /auth/me',
        path: '/auth/me',
        own: a.institution.id,
      },
      { route: 'GET /users/me/avatar', path: '/users/me/avatar' },
      {
        route: 'GET /teacher-assignments/mine',
        path: '/teacher-assignments/mine',
      },
      {
        route: 'GET /teacher-assignments/mine/periods',
        path: '/teacher-assignments/mine/periods',
      },
      { route: 'GET /gradebook/mine', path: '/gradebook/mine' },
      {
        route: 'GET /gradebook/mine',
        path: `/gradebook/mine?periodId=${b.period}`,
      },
      { route: 'GET /report-cards/mine', path: '/report-cards/mine' },
      { route: 'GET /courses', path: '/courses?limit=100', own: a.course },
      {
        route: 'GET /courses',
        path: `/courses?campusId=${b.campus1}&gradeId=${b.grade}&academicYearId=${b.year}`,
      },
      {
        route: 'GET /teacher-assignments',
        path: '/teacher-assignments?limit=100',
        own: a.assignment,
      },
      {
        route: 'GET /teacher-assignments',
        path: `/teacher-assignments?courseId=${b.course}&teacherId=${b.teacher.id}`,
      },
      {
        route: 'GET /teacher-assignments',
        path: `/teacher-assignments?subjectId=${b.subject}&academicYearId=${b.year}`,
      },
      {
        route: 'GET /enrollments',
        path: '/enrollments?limit=100',
        own: a.enrollment,
      },
      {
        route: 'GET /enrollments',
        path: `/enrollments?courseId=${b.course}&studentId=${b.student.id}`,
      },
      {
        route: 'GET /enrollments',
        path: `/enrollments?academicYearId=${b.year}`,
      },
      {
        route: 'GET /evaluations',
        path: '/evaluations?limit=100',
        own: a.evaluation,
      },
      {
        route: 'GET /evaluations',
        path: `/evaluations?courseId=${b.course}&periodId=${b.period}`,
      },
      {
        route: 'GET /evaluations',
        path: `/evaluations?teacherAssignmentId=${b.assignment}&subjectId=${b.subject}`,
      },
      {
        route: 'GET /report-cards',
        path: '/report-cards?limit=100',
        own: a.reportCard,
      },
      {
        route: 'GET /report-cards',
        path: `/report-cards?studentId=${b.student.id}&periodId=${b.period}&courseId=${b.course}`,
      },
      {
        route: 'GET /users',
        path: '/users?limit=100',
        own: a.student.userId,
      },
      {
        route: 'GET /users',
        path: `/users?roleId=${b.role}&campusId=${b.campus1}`,
      },
      {
        route: 'GET /teachers/invitations',
        path: '/teachers/invitations',
        own: a.teacherInvitation,
      },
      {
        route: 'GET /students/invitations',
        path: '/students/invitations',
        own: a.studentInvitation,
      },
      { route: 'GET /users/me/invitations', path: '/users/me/invitations' },
      {
        route: 'GET /teachers/link-candidate',
        path: `/teachers/link-candidate?documentType=CC&documentNumber=${b.teacher.documentNumber}`,
      },
      {
        route: 'GET /students/link-candidate',
        path: `/students/link-candidate?documentType=CC&documentNumber=${b.student.documentNumber}`,
      },
      {
        route: 'GET /teachers',
        path: '/teachers?limit=100',
        own: a.teacher.id,
      },
      { route: 'GET /teachers', path: `/teachers?campusId=${b.campus1}` },
      {
        route: 'GET /students',
        path: '/students?limit=100',
        own: a.student.id,
      },
      {
        route: 'GET /students',
        path: `/students?campusId=${b.campus1}&courseId=${b.course}`,
      },
      {
        route: 'GET /role-assignments',
        path: '/role-assignments?limit=100',
        own: a.roleAssignment,
      },
      {
        route: 'GET /role-assignments',
        path: `/role-assignments?userId=${b.student.userId}`,
      },
      {
        route: 'GET /role-assignments',
        path: `/role-assignments?roleId=${b.role}&campusId=${b.campus1}`,
      },
    ];

    /** Lo que identifica a B: ids, nombres, correos y documentos. */
    const bSecrets = () => [
      b.institution.id,
      b.campus1,
      b.campus2,
      b.year,
      b.period,
      b.grade,
      b.subject,
      b.course,
      b.freeCourse,
      b.assignment,
      b.evaluation,
      b.enrollment,
      b.role,
      b.roleAssignment,
      b.reportCard,
      b.adminUserId,
      bTemplate,
      b.tag,
      ...b.levels,
      ...[b.teacher, b.student, b.freeStudent].flatMap((p) => [
        p.id,
        p.userId,
        p.email,
        p.documentNumber,
        p.lastName,
      ]),
    ];

    it(
      'ningún listado de A muestra datos de B',
      async () => {
        const secrets = bSecrets();
        const failures: string[] = [];
        for (const agent of [a.admin, dual, campusAdminA, teacherA, studentA]) {
          for (const entry of lists()) {
            covered.add(entry.route);
            const res = await call(agent, entry);
            if (agent === a.admin && entry.own) {
              if (res.status !== 200 || !res.text.includes(entry.own)) {
                failures.push(`${entry.path} -> ${res.status} sin datos de A`);
              }
            } else if (![200, 403, 404].includes(res.status)) {
              failures.push(`${entry.path} -> ${res.status} ${res.text}`);
              continue;
            }
            // Los errores repiten la ruta pedida (con los ids que mandó el
            // cliente): solo se ignora ese campo si es exactamente esa ruta.
            const body = { ...(res.body as Record<string, unknown>) };
            if (body.path === `/api${entry.path}`) delete body.path;
            const text = res.status >= 400 ? JSON.stringify(body) : res.text;
            // El usuario de A y B ve a B entre sus instituciones.
            const allowed =
              agent === dual && entry.route === 'GET /auth/me'
                ? [b.institution.id, b.tag]
                : [];
            const leaked = secrets.filter(
              (s) => text.includes(s) && !allowed.includes(s),
            );
            if (leaked.length) {
              failures.push(
                `${entry.path} -> ${res.status} con ${leaked.join(', ')}`,
              );
            }
          }
        }
        expect(failures).toEqual([]);
      },
      MATRIX_TIMEOUT,
    );

    it(
      'buscar por nombre, correo o documento de B no encuentra nada (y lo de A sí)',
      async () => {
        const searches: [string, string, string][] = [
          ['/users', b.student.documentNumber, a.student.documentNumber],
          ['/users', b.student.email, a.student.email],
          ['/students', b.student.lastName, a.student.lastName],
          ['/teachers', b.teacher.documentNumber, a.teacher.documentNumber],
          ['/grades', b.tag, a.tag],
          ['/subjects', b.tag, a.tag],
          ['/courses', b.tag, a.tag],
          ['/roles', b.tag, a.tag],
          ['/enrollments', b.student.lastName, a.student.lastName],
        ];
        const failures: string[] = [];
        for (const [path, bText, aText] of searches) {
          const page = async (text: string) =>
            (
              await a.admin
                .get(`/api${path}`)
                .query({ search: text })
                .expect(200)
            ).body as { data: unknown[] };
          if ((await page(bText)).data.length !== 0) {
            failures.push(`${path}?search=${bText} encontró datos de B`);
          }
          if ((await page(aText)).data.length === 0) {
            failures.push(`${path}?search=${aText} no encontró los de A`);
          }
        }
        expect(failures).toEqual([]);
      },
      MATRIX_TIMEOUT,
    );
  });

  describe('usuario de A que también está en B', () => {
    it('A no cambia sus datos personales, su estado ni su contraseña', async () => {
      const forbidden: [number, string] = [403, SUPER_ADMIN_ONLY];
      const user = `/users/${shared.userId}`;
      const teacher = `/teachers/${shared.teacherInA}`;
      const entries: Call[] = [
        {
          route: 'PATCH /users/:id',
          path: user,
          body: { firstName: 'Cambiado' },
          expected: forbidden,
        },
        {
          route: 'PATCH /users/:id',
          path: user,
          body: { lastName: 'Cambiado' },
          expected: forbidden,
        },
        {
          route: 'PATCH /users/:id',
          path: user,
          body: { phone: '+57 300 000 0000' },
          expected: forbidden,
        },
        {
          route: 'PATCH /users/:id',
          path: user,
          body: { email: `e2e-${suffix()}@test.aula360.local` },
          expected: forbidden,
        },
        {
          route: 'PATCH /users/:id',
          path: user,
          body: { email: null },
          expected: forbidden,
        },
        {
          route: 'PATCH /users/:id',
          path: user,
          body: { documentNumber: `E2E${suffix()}` },
          expected: forbidden,
        },
        {
          route: 'PATCH /teachers/:id',
          path: teacher,
          body: { firstName: 'Cambiado' },
          expected: forbidden,
        },
        {
          route: 'PATCH /users/:id/status',
          path: `${user}/status`,
          body: { isActive: false },
          expected: forbidden,
        },
        {
          route: 'POST /users/:id/temporary-password',
          path: `${user}/temporary-password`,
          expected: forbidden,
        },
      ];
      const failures: string[] = [];
      for (const entry of entries) {
        const failure = await check(a.admin, entry);
        if (failure) failures.push(failure);
      }
      expect(failures).toEqual([]);
    });

    it('A sí edita su perfil de docente en A y puede reenviar los mismos datos', async () => {
      const user = await a.admin.get(`/api/users/${shared.userId}`).expect(200);
      const { firstName, lastName, email } = user.body as {
        firstName: string;
        lastName: string;
        email: string;
      };
      await a.admin
        .patch(`/api/users/${shared.userId}`)
        .send({ firstName, lastName, email })
        .expect(200);
      await a.admin
        .patch(`/api/teachers/${shared.teacherInA}`)
        .send({ specialty: 'Álgebra', firstName })
        .expect(200);
    });
  });

  describe('logo de la institución activa', () => {
    it('el usuario de A y B con sesión en A solo cambia el logo de A', async () => {
      covered.add('PUT /institutions/current/logo');
      covered.add('DELETE /institutions/current/logo');
      const res = await dual
        .put('/api/institutions/current/logo')
        .attach('file', PNG, { filename: 'l.png', contentType: 'image/png' })
        .expect(200);
      expect((res.body as { id: string }).id).toBe(a.institution.id);
      const removed = await dual.delete('/api/institutions/current/logo');
      expect(removed.status).toBeLessThan(300);
    });
  });

  describe('B queda intacta', () => {
    it('mismas filas (y roles globales), mismos archivos y ningún correo a usuarios de B', async () => {
      expect(await fingerprint(b.institution.id)).toEqual(bFingerprint);
      expect(await globalRows()).toEqual(globalFingerprint);
      const bUsers = await usersOf(b.institution.id);
      expect(
        filesOf(
          b.institution.id,
          bUsers.map((u) => u.id),
        ),
      ).toEqual(bFiles);
      const sent = ctx.mail.messages.slice(mailCount);
      expect(
        sent.filter((m) =>
          bEmails.some((e) => e.toLowerCase() === m.to.toLowerCase()),
        ),
      ).toEqual([]);
    });
  });

  describe('cambio de email pendiente pedido desde B', () => {
    it('A no lo ve ni lo anula; B sí lo ve', async () => {
      const email = `e2e-${suffix()}@test.aula360.local`;
      await superAdmin
        .patch(`/api/institutions/${b.institution.id}/users/${shared.userId}`)
        .send({ email })
        .expect(200);
      await ctx.mail.waitFor(email);

      const fromA = await a.admin
        .get(`/api/users/${shared.userId}`)
        .expect(200);
      expect(fromA.body).toMatchObject({ hasPendingEmail: false });
      const fromB = await b.admin
        .get(`/api/users/${shared.userId}`)
        .expect(200);
      expect(fromB.body).toMatchObject({ hasPendingEmail: true });

      // Reenviar el email actual desde A no anula el cambio que pidió B.
      await a.admin
        .patch(`/api/users/${shared.userId}`)
        .send({ email: shared.email })
        .expect(200);
      await request(server())
        .post('/api/auth/verify-email')
        .send({ token: ctx.mail.verifyToken(email) })
        .expect(204);
    });
  });

  describe('usuario de varias instituciones', () => {
    it('al cambiar a B ve B y deja de ver A', async () => {
      covered.add('POST /auth/switch-institution');
      await dual.get(`/api/courses/${b.course}`).expect(404);
      await dual
        .post('/api/auth/switch-institution')
        .send({ institutionId: b.institution.id })
        .expect(200);
      await dual.get(`/api/courses/${b.course}`).expect(200);
      await dual.get(`/api/courses/${a.course}`).expect(404);
      await dual.get(`/api/students/${a.student.id}`).expect(404);
      const list = await dual.get('/api/courses').expect(200);
      expect(list.text).not.toContain(a.course);
      await dual
        .post('/api/auth/switch-institution')
        .send({ institutionId: a.institution.id })
        .expect(200);
      await dual.get(`/api/courses/${a.course}`).expect(200);
    });

    it('sin rol en una institución no puede activarla', async () => {
      await a.admin
        .post('/api/auth/switch-institution')
        .send({ institutionId: b.institution.id })
        .expect(404);
      const me = await a.admin.get('/api/auth/me').expect(200);
      expect(me.body.activeInstitutionId).toBe(a.institution.id);
    });

    it('si le quitan el rol en A, su sesión en A deja de servir', async () => {
      const [assignment] = await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .findBy({ userId: dualUserId, institutionId: a.institution.id });
      await a.admin
        .delete(`/api/role-assignments/${assignment.id}`)
        .expect(204);
      // El access token de A deja de servir en cualquier ruta.
      await dual.get(`/api/courses/${a.course}`).expect(401);
      await dual.get('/api/auth/me').expect(401);
      // Al renovar la sesión queda sin institución activa (no pasa a B en
      // silencio: M1 de la fase 3a) y su acceso a B sigue intacto.
      await dual.post('/api/auth/refresh-token').expect(204);
      const me = await dual.get('/api/auth/me').expect(200);
      expect(me.body.activeInstitutionId).toBeNull();
      await dual.get(`/api/courses/${a.course}`).expect(403);
      await dual
        .post('/api/auth/switch-institution')
        .send({ institutionId: b.institution.id })
        .expect(200);
      await dual.get(`/api/courses/${b.course}`).expect(200);
    });

    it('si se desactiva A, las sesiones en A dejan de servir y B sigue', async () => {
      await superAdmin
        .patch(`/api/institutions/${a.institution.id}/deactivate`)
        .expect(200);
      await a.admin.get(`/api/courses/${a.course}`).expect(401);
      await teacherA.get('/api/teacher-assignments/mine').expect(401);
      await b.admin.get(`/api/courses/${b.course}`).expect(200);
      await dual.get(`/api/courses/${b.course}`).expect(200);
    });
  });

  describe('cobertura', () => {
    /**
     * Rutas sin datos de otra institución en juego, con el motivo. Todas las
     * demás deben estar en alguno de los grupos de arriba.
     */
    const EXEMPT: Record<string, string> = {
      'GET /health': 'pública, sin datos',
      'POST /auth/login': 'pública: crea la sesión',
      'POST /auth/refresh-token': 'pública: solo la cookie propia',
      'POST /auth/logout': 'pública: solo la cookie propia',
      'POST /auth/forgot-password': 'pública: respuesta siempre igual',
      'POST /auth/reset-password': 'pública: token de un solo uso',
      'POST /auth/verify-email':
        'pública: revalida la institución que pidió el cambio (A1 en email-verification.e2e)',
      'POST /auth/verify-email/resend': 'solo el propio usuario',
      'POST /auth/change-password': 'solo el propio usuario',
      'PUT /users/me/email':
        'solo el propio usuario (el 409 por correo ya registrado es riesgo aceptado)',
      'PUT /users/me/avatar': 'solo el propio usuario',
      'DELETE /users/me/avatar': 'solo el propio usuario',
      'GET /menu-options': 'catálogo global de menús (solo lectura)',
      'GET /menu-options/:id': 'catálogo global de menús (solo lectura)',
    };

    it('toda ruta registrada está probada o exenta con motivo', () => {
      const registered = registeredRoutes();
      expect(registered.length).toBeGreaterThan(100);
      const missing = registered.filter(
        (route) => !covered.has(route) && !(route in EXEMPT),
      );
      expect(missing).toEqual([]);
      // Las exenciones y las rutas probadas siguen existiendo.
      const stale = [...covered, ...Object.keys(EXEMPT)].filter(
        (route) => !registered.includes(route),
      );
      expect(stale).toEqual([]);
    });
  });

  /** "MÉTODO /ruta" de cada ruta de la app (sin el prefijo /api). */
  function registeredRoutes(): string[] {
    const express = ctx.app.getHttpAdapter().getInstance() as {
      router: {
        stack: {
          route?: { path: string; methods: Record<string, boolean> };
        }[];
      };
    };
    const routes = new Set<string>();
    for (const layer of express.router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        routes.add(
          `${method.toUpperCase()} ${layer.route.path.replace(/^\/api/, '')}`,
        );
      }
    }
    return [...routes].sort();
  }
});
