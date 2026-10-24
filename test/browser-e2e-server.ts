/**
 * Servidor del backend para las pruebas de Playwright del frontend contra la
 * API real (aula360-frontend: yarn test:e2e:integration). Igual que en
 * producción (configureApp), pero con Storage y correo en memoria: no sube
 * nada a Supabase ni envía correos.
 *
 * - Solo con E2E_DB_MODE=isolated y una base de pruebas LOCAL cuyo nombre
 *   termine en _e2e (p. ej. aula360_e2e); nunca la compartida ni una remota
 *   (A1 de la 3g-2): crea un SUPER_ADMIN y barre lo que tenga prefijo E2E.
 * - Los usuarios del escenario reciben una contraseña aleatoria por corrida,
 *   que solo va al JSON del escenario (0600, en un directorio propio).
 * - Escucha solo en 127.0.0.1 (M1 de la 3g-2).
 * - Arma un escenario con un usuario por rol y una segunda institución, lo
 *   escribe en BROWSER_E2E_SCENARIO (JSON) y recién entonces escucha.
 * - Lo que crea lleva el prefijo E2E: lo borra al cerrarse y, si el proceso
 *   muere sin cerrarse (Playwright en Windows lo termina a la fuerza), la
 *   siguiente corrida lo barre al empezar (sweepLeftovers).
 *
 * Uso: E2E_DB_MODE=isolated DATABASE_URL_TEST=... DB_SSL_TEST=false
 *      BROWSER_E2E_SCENARIO=<ruta.json> yarn test:browser-server
 */
import './setup-e2e-env';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { rmSync, writeFileSync } from 'fs';
import * as request from 'supertest';

if (process.env.E2E_DB_MODE !== 'isolated') {
  throw new Error(
    'El servidor de pruebas del navegador exige E2E_DB_MODE=isolated.',
  );
}
// DATABASE_URL ya es la de pruebas (setup-e2e-env la reemplazó).
const db = new URL(process.env.DATABASE_URL ?? '');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
if (!LOOPBACK.has(db.hostname.toLowerCase())) {
  throw new Error(
    `El servidor de pruebas del navegador solo usa una base local (el host es ${db.hostname}).`,
  );
}
if (!decodeURIComponent(db.pathname.slice(1)).endsWith('_e2e')) {
  throw new Error(
    'El servidor de pruebas del navegador exige una base cuyo nombre termine en _e2e.',
  );
}
const scenarioFile = process.env.BROWSER_E2E_SCENARIO?.trim();
if (!scenarioFile)
  throw new Error('Falta BROWSER_E2E_SCENARIO (ruta del JSON del escenario).');

const PORT = Number(process.env.BROWSER_E2E_PORT ?? 3100);
const FRONTEND = process.env.BROWSER_E2E_FRONTEND ?? 'http://localhost:5174';
// Antes de cargar AppModule (la configuración se valida al importarlo).
process.env.CORS_ORIGINS = FRONTEND;
process.env.FRONTEND_URL = FRONTEND;
process.env.PORT = String(PORT);

type Agent = ReturnType<typeof request.agent>;

/** 'YYYY-MM-DD' de una fecha local. */
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  const { createTestApp } = await import('./utils/create-test-app');
  const { schoolToday } = await import('../src/common/utils/school-date');
  const { UserEntity } =
    await import('../src/modules/users/entities/user.entity');
  const { TeacherEntity } =
    await import('../src/modules/users/entities/teacher.entity');
  const { StudentEntity } =
    await import('../src/modules/users/entities/student.entity');

  const ctx = await createTestApp();
  const { data, dataSource } = ctx;
  const server = ctx.app.getHttpServer();

  // Contraseña aleatoria por corrida (no la de las e2e, que está en el repo).
  const password = `${randomBytes(18).toString('base64url')}aA1*`;
  const passwordHash = await bcrypt.hash(password, 10);

  const login = async (email: string): Promise<Agent> => {
    const agent = request.agent(server);
    await agent
      .post('/api/auth/login')
      .send({ identifier: email, password })
      .expect(200);
    return agent;
  };
  const call = async (
    agent: Agent,
    method: 'post' | 'put' | 'patch',
    path: string,
    body: object,
  ) => {
    const res = await agent[method](path).send(body);
    if (res.status >= 300) {
      throw new Error(
        `${method.toUpperCase()} ${path}: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as { id: string };
  };
  /** Usuario con nombre legible (las pantallas lo muestran). */
  const person = async (
    userType: 'SUPER_ADMIN' | 'INSTITUTION_ADMIN' | 'TEACHER' | 'STUDENT',
    firstName: string,
    lastName: string,
  ) => {
    const user = await data.createUser({ userType });
    await dataSource
      .getRepository(UserEntity)
      .update({ id: user.id }, { firstName, lastName, passwordHash });
    return { id: user.id, email: user.email as string, firstName, lastName };
  };

  // Instituciones: la del escenario y otra para comprobar el aislamiento.
  const institution = await data.createInstitution('Colegio Integración');
  const other = await data.createInstitution('Colegio Ajeno');
  const campus = await data.createCampus(institution.id, 'Sede Principal');

  const superAdmin = await person('SUPER_ADMIN', 'Sofía', 'Plataforma');
  const admin = await person('INSTITUTION_ADMIN', 'Rocío', 'Rectora');
  await data.assignGlobalRole(admin.id, institution.id);
  const otherAdmin = await person('INSTITUTION_ADMIN', 'Mario', 'Ajeno');
  await data.assignGlobalRole(otherAdmin.id, other.id);
  const teacher = await person('TEACHER', 'Diego', 'Docente');
  await data.assignGlobalRole(teacher.id, institution.id, 'TEACHER');
  const teacherProfile = await dataSource
    .getRepository(TeacherEntity)
    .save({ userId: teacher.id, institutionId: institution.id });
  const student = await person('STUDENT', 'Valentina', 'Estudiante');
  await data.assignGlobalRole(student.id, institution.id, 'STUDENT');
  const studentProfile = await dataSource.getRepository(StudentEntity).save({
    userId: student.id,
    institutionId: institution.id,
    campusId: campus.id,
  });

  const adminAgent = await login(admin.email);
  // createInstitution escribe directo en la base: sin niveles por defecto.
  await call(adminAgent, 'put', '/api/performance-levels', {
    levels: [
      { name: 'Bajo', minScore: 1, maxScore: 2.99 },
      { name: 'Básico', minScore: 3, maxScore: 3.99 },
      { name: 'Alto', minScore: 4, maxScore: 4.59 },
      { name: 'Superior', minScore: 4.6, maxScore: 5 },
    ],
  });

  // Año activo con un periodo en curso: el docente puede registrar notas hoy.
  const today = schoolToday();
  const year = Number(today.slice(0, 4));
  const [, month] = today.split('-').map(Number);
  const start = day(new Date(year, (month ?? 1) - 1, 1));
  const end = day(new Date(year, Math.min((month ?? 1) + 1, 12), 0));
  const yearId = (
    await call(adminAgent, 'post', '/api/academic-years', { year })
  ).id;
  await call(adminAgent, 'patch', `/api/academic-years/${yearId}`, {
    isActive: true,
  });
  const periodId = (
    await call(adminAgent, 'post', `/api/academic-years/${yearId}/periods`, {
      name: 'Cuarto periodo',
      startDate: start,
      endDate: end,
    })
  ).id;
  const gradeId = (
    await call(adminAgent, 'post', '/api/grades', { name: 'Sexto' })
  ).id;
  const subjectId = (
    await call(adminAgent, 'post', '/api/subjects', { name: 'Matemáticas' })
  ).id;
  const courseId = (
    await call(adminAgent, 'post', '/api/courses', {
      name: '601',
      gradeId,
      campusId: campus.id,
      academicYearId: yearId,
    })
  ).id;
  const assignmentId = (
    await call(adminAgent, 'post', '/api/teacher-assignments', {
      courseId,
      subjectId,
      teacherId: teacherProfile.id,
    })
  ).id;
  await call(adminAgent, 'post', '/api/enrollments', {
    studentId: studentProfile.id,
    courseId,
  });
  const evaluationId = (
    await call(adminAgent, 'post', '/api/evaluations', {
      teacherAssignmentId: assignmentId,
      periodId,
      title: 'Taller de fracciones',
      percentage: 100,
      evaluationDate: today,
    })
  ).id;

  const scenario = {
    apiUrl: `http://127.0.0.1:${PORT}`,
    password,
    institution: { id: institution.id, name: institution.name },
    otherInstitution: { id: other.id, name: other.name },
    users: { superAdmin, admin, otherAdmin, teacher, student },
    studentId: studentProfile.id,
    courseId,
    periodId,
    evaluationId,
  };
  writeFileSync(scenarioFile as string, JSON.stringify(scenario, null, 2), {
    mode: 0o600,
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    let code = 0;
    try {
      await data.cleanup();
    } catch (error) {
      // Que se vea: las cuentas quedarían hasta la siguiente corrida (B1 de la 3g-2).
      console.error('No se pudo limpiar el escenario:', error);
      code = 1;
    } finally {
      rmSync(scenarioFile as string, { force: true });
      await ctx.app.close();
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await ctx.app.listen(PORT, '127.0.0.1');
  console.log(`Servidor de pruebas del navegador en http://127.0.0.1:${PORT}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
