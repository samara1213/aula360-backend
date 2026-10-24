import * as request from 'supertest';
import { In } from 'typeorm';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { RoleMenuPermissionEntity } from '../src/modules/security/entities/role-menu-permission.entity';
import { MenuOptionEntity } from '../src/modules/security/entities/menu-option.entity';
import { InstitutionInvitationEntity } from '../src/modules/users/entities/institution-invitation.entity';
import { StudentEntity } from '../src/modules/users/entities/student.entity';
import { TeacherEntity } from '../src/modules/users/entities/teacher.entity';
import { UserInstitutionRoleEntity } from '../src/modules/security/entities/user-institution-role.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { INVITATIONS_PER_DAY } from '../src/modules/users/invitations.service';
import {
  LOOKUPS_PER_DAY,
  LookupBudget,
} from '../src/modules/users/lookup-budget';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

interface Invitation {
  id: string;
  displayName: string;
  profileType: string;
  campus: { id: string; name: string } | null;
  expiresAt: string;
}

interface Profile {
  id: string;
  sharedElsewhere?: boolean;
  campus?: { id: string } | null;
  user: { id: string };
}

/**
 * Personas en varias instituciones: invitar a quien ya tiene cuenta en otra
 * (la persona acepta o rechaza con su sesión) y quitarle el acceso a una
 * sola institución.
 */
describe('Invitaciones a personas de otra institución (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;

  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a la sede A1
  let teacherOfA: Agent; // docente de A: sin permiso de crear personas

  let carlos: UserEntity; // docente de B (correo verificado)
  let laura: UserEntity; // estudiante de B, con acudiente en B
  let inactive: UserEntity;
  let superUser: UserEntity;
  let adminOfB: UserEntity; // INSTITUTION_ADMIN de B

  const server = () => ctx.app.getHttpServer();
  const doc = (u: UserEntity) =>
    `documentType=${u.documentType}&documentNumber=${u.documentNumber}`;
  const body = (u: UserEntity) => ({
    documentType: u.documentType,
    documentNumber: u.documentNumber,
  });
  const invitations = () =>
    ctx.dataSource.getRepository(InstitutionInvitationEntity);

  async function loginAs(email: string | null): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier: email, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  async function person(
    userType: 'TEACHER' | 'STUDENT' | 'INSTITUTION_ADMIN',
    institution: InstitutionEntity,
    firstName: string,
    lastName: string,
    { isActive = true }: { isActive?: boolean } = {},
  ): Promise<UserEntity> {
    const user = await ctx.data.createUser({ userType, isActive });
    await ctx.dataSource
      .getRepository(UserEntity)
      .update({ id: user.id }, { firstName, lastName });
    await ctx.data.assignGlobalRole(user.id, institution.id, userType);
    return { ...user, firstName, lastName };
  }

  async function invite(
    agent: Agent,
    kind: 'teachers' | 'students',
    u: UserEntity,
    campusId: string | null = null,
    status = 201,
  ) {
    const res = await agent
      .post(`/api/${kind}/invitations`)
      .send({ ...body(u), campusId });
    expect({ status: res.status, body: res.body as unknown }).toMatchObject({
      status,
    });
    return res.body as Invitation;
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
    const teacherAUser = await person(
      'TEACHER',
      institutionA,
      'Ana',
      'Docente',
    );
    await ctx.dataSource
      .getRepository(TeacherEntity)
      .save({ userId: teacherAUser.id, institutionId: institutionA.id });
    superUser = await data.createUser({ userType: 'SUPER_ADMIN' });

    carlos = await person('TEACHER', institutionB, 'Carlos Andrés', 'Pérez');
    await ctx.dataSource.getRepository(TeacherEntity).save({
      userId: carlos.id,
      institutionId: institutionB.id,
      academicDegree: 'Licenciado en B',
    });
    laura = await person('STUDENT', institutionB, 'Laura', 'Gómez');
    await ctx.dataSource.getRepository(StudentEntity).save({
      userId: laura.id,
      institutionId: institutionB.id,
      guardianName: 'Acudiente B',
      guardianEmail: 'acudiente-b@test.aula360.local',
      bloodType: 'O+',
    });
    inactive = await person('TEACHER', institutionB, 'Inés', 'Inactiva', {
      isActive: false,
    });
    adminOfB = await person(
      'INSTITUTION_ADMIN',
      institutionB,
      'Rosa',
      'Rectora',
    );

    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminUser.email);
    teacherOfA = await loginAs(teacherAUser.email);
  }, 120_000);

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('GET /teachers/link-candidate', () => {
    it('responde solo el nombre y la inicial del apellido', async () => {
      const res = await adminA
        .get(`/api/teachers/link-candidate?${doc(carlos)}`)
        .expect(200);
      expect(res.body).toEqual({ displayName: 'Carlos P.' });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sin cuenta activa de docente o estudiante: 404 (inactiva, inexistente, SUPER_ADMIN o administrador; B5)', async () => {
      for (const u of [inactive, superUser, adminOfB]) {
        await adminA.get(`/api/teachers/link-candidate?${doc(u)}`).expect(404);
      }
      await adminA
        .get(
          '/api/teachers/link-candidate?documentType=CC&documentNumber=NOEXISTE1',
        )
        .expect(404);
    });

    it('otro tipo de usuario: 409 sin decir cuál (M1)', async () => {
      const res = await adminA
        .get(`/api/teachers/link-candidate?${doc(laura)}`)
        .expect(409);
      const message = (res.body as { message: string }).message;
      expect(message).toMatch(/no se puede invitar como docente/);
      expect(message).not.toMatch(/estudiante/);
    });

    it('sin permiso de crear docentes: 403; documento inválido: 400', async () => {
      await teacherOfA
        .get(`/api/teachers/link-candidate?${doc(carlos)}`)
        .expect(403);
      await adminA
        .get('/api/teachers/link-candidate?documentType=C1&documentNumber=1')
        .expect(400);
    });
  });

  describe('docente: invitar, aceptar y quitar el acceso', () => {
    let invitation: Invitation;
    let profileA: Profile;

    it('invitar no da acceso ni datos: solo el nombre corto y la sede', async () => {
      invitation = await invite(adminA, 'teachers', carlos, campusA1.id);
      expect(invitation.displayName).toBe('Carlos P.');
      expect(invitation.campus?.id).toBe(campusA1.id);
      const days =
        (new Date(invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);
      expect(JSON.stringify(invitation)).not.toContain(carlos.lastName);

      const pending = await adminA.get('/api/teachers/invitations').expect(200);
      expect((pending.body as Invitation[]).map((i) => i.id)).toEqual([
        invitation.id,
      ]);
      // Hasta que acepte, A no lo ve.
      await adminA.get(`/api/users/${carlos.id}`).expect(404);
      const list = await adminA.get('/api/teachers?limit=100').expect(200);
      expect(list.text).not.toContain(carlos.id);

      const mails = await ctx.mail.waitFor(carlos.email as string);
      expect(mails.at(-1)?.subject).toBe(
        'Aula360 - Invitación de una institución',
      );
      expect(mails.at(-1)?.text).toContain(institutionA.name);
    });

    it('otra invitación pendiente de la misma institución: 409', async () => {
      await invite(adminA, 'teachers', carlos, campusA1.id, 409);
    });

    it('la otra institución no ve ni cancela las invitaciones de A', async () => {
      const res = await adminB.get('/api/teachers/invitations').expect(200);
      expect(res.body).toEqual([]);
      await adminB
        .delete(`/api/teachers/invitations/${invitation.id}`)
        .expect(404);
    });

    it('solo la persona invitada la ve y la responde', async () => {
      const lauraAgent = await loginAs(laura.email);
      await lauraAgent
        .post(`/api/users/me/invitations/${invitation.id}/accept`)
        .expect(404);
      const agent = await loginAs(carlos.email);
      const res = await agent.get('/api/users/me/invitations').expect(200);
      expect(res.body).toEqual([
        expect.objectContaining({
          id: invitation.id,
          institution: { id: institutionA.id, name: institutionA.name },
          profileType: 'TEACHER',
          campus: expect.objectContaining({ id: campusA1.id }) as unknown,
        }),
      ]);
    });

    it('al aceptar entra a las dos instituciones; A ve su ficha, sin datos de B', async () => {
      const agent = await loginAs(carlos.email);
      const res = await agent
        .post(`/api/users/me/invitations/${invitation.id}/accept`)
        .expect(200);
      expect(res.body).toEqual({ institutionId: institutionA.id });
      const me = await agent.get('/api/auth/me').expect(200);
      expect(
        (me.body as { institutions: { id: string }[] }).institutions
          .map((i) => i.id)
          .sort(),
      ).toEqual([institutionA.id, institutionB.id].sort());
      // Ya no está pendiente: no se responde dos veces.
      await agent
        .post(`/api/users/me/invitations/${invitation.id}/accept`)
        .expect(404);

      const list = await adminA.get('/api/teachers?limit=100').expect(200);
      const row = (list.body as { data: Profile[] }).data.find(
        (t) => t.user.id === carlos.id,
      );
      expect(row).toBeDefined();
      const detail = await adminA.get(`/api/teachers/${row!.id}`).expect(200);
      profileA = detail.body as Profile;
      expect(profileA.sharedElsewhere).toBe(true);
      expect(detail.text).not.toContain('Licenciado en B');
      await adminA
        .patch(`/api/teachers/${profileA.id}`)
        .send({ firstName: 'Otro' })
        .expect(403);
    });

    it('quitar el acceso exige no tener cargas vigentes (M2)', async () => {
      // Una carga activa de Carlos en A (curso, materia y año de A).
      const year = (
        await adminA
          .post('/api/academic-years')
          .send({ year: new Date().getFullYear() })
          .expect(201)
      ).body as { id: string };
      const grade = (
        await adminA.post('/api/grades').send({ name: 'Sexto' }).expect(201)
      ).body as { id: string };
      const subject = (
        await adminA.post('/api/subjects').send({ name: 'Física' }).expect(201)
      ).body as { id: string };
      const course = (
        await adminA
          .post('/api/courses')
          .send({
            name: '601',
            gradeId: grade.id,
            campusId: campusA1.id,
            academicYearId: year.id,
          })
          .expect(201)
      ).body as { id: string };
      const load = (
        await adminA
          .post('/api/teacher-assignments')
          .send({
            courseId: course.id,
            subjectId: subject.id,
            teacherId: profileA.id,
          })
          .expect(201)
      ).body as { id: string };
      const res = await adminA
        .delete(`/api/users/${carlos.id}/institution-access`)
        .expect(409);
      expect((res.body as { message: string }).message).toMatch(
        /1 carga académica vigente/,
      );
      await ctx.dataSource.query(
        'UPDATE teacher_subject_courses SET is_active = false WHERE id = $1',
        [load.id],
      );
    });

    it('sin el permiso de quitar roles: 403 (B1)', async () => {
      // Todos los permisos (techo de sobra para gestionar a un docente)
      // menos quitar roles: así el 403 es por B1 y no por el techo.
      const slugs = (
        await ctx.dataSource.getRepository(MenuOptionEntity).find()
      ).map((o) => o.slug);
      const role = await ctx.data.createInstitutionRole(institutionA.id, slugs);
      const option = await ctx.dataSource
        .getRepository(MenuOptionEntity)
        .findOneByOrFail({ slug: 'security.users' });
      await ctx.dataSource
        .getRepository(RoleMenuPermissionEntity)
        .update(
          { roleId: role.id, menuOptionId: option.id },
          { canDelete: false },
        );
      const editor = await ctx.data.createUser();
      await ctx.dataSource.getRepository(UserInstitutionRoleEntity).insert({
        userId: editor.id,
        institutionId: institutionA.id,
        roleId: role.id,
        campusId: null,
      });
      const agent = await loginAs(editor.email);
      const res = await agent
        .delete(`/api/users/${carlos.id}/institution-access`)
        .expect(403);
      expect((res.body as { message: string }).message).toMatch(
        /permiso de quitar roles/,
      );
    });

    it('quitar el acceso: A deja de verlo y él sigue en B', async () => {
      await adminA
        .delete(`/api/users/${carlos.id}/institution-access`)
        .expect(204);
      await adminA.get(`/api/teachers/${profileA.id}`).expect(404);
      const agent = await loginAs(carlos.email);
      const me = await agent.get('/api/auth/me').expect(200);
      expect(
        (me.body as { institutions: { id: string }[] }).institutions.map(
          (i) => i.id,
        ),
      ).toEqual([institutionB.id]);
    });

    it('una invitación nueva reutiliza su perfil al aceptarla', async () => {
      const again = await invite(adminA, 'teachers', carlos);
      const agent = await loginAs(carlos.email);
      await agent
        .post(`/api/users/me/invitations/${again.id}/accept`)
        .expect(200);
      await adminA.get(`/api/teachers/${profileA.id}`).expect(200);
    });

    it('quien solo está en esta institución no se quita: se desactiva (409)', async () => {
      const created = await adminA
        .post('/api/teachers')
        .send({
          documentType: 'CC',
          documentNumber: `E2E${Date.now()}`,
          firstName: 'Solo',
          lastName: 'Aquí',
        })
        .expect(201);
      const userId = (created.body as Profile).user.id;
      ctx.data.trackUser(userId);
      const detail = await adminA
        .get(`/api/teachers/${(created.body as Profile).id}`)
        .expect(200);
      expect((detail.body as Profile).sharedElsewhere).toBe(false);
      await adminA
        .delete(`/api/users/${userId}/institution-access`)
        .expect(409);
    });

    it('el 409 del alta lleva el código USER_ALREADY_EXISTS', async () => {
      const res = await adminA
        .post('/api/teachers')
        .send({ ...body(carlos), firstName: 'X', lastName: 'Y' })
        .expect(409);
      expect((res.body as { code?: string }).code).toBe('USER_ALREADY_EXISTS');
    });
  });

  describe('estudiante: rechazar, cancelar, vencer y volver', () => {
    it('la invitación avisa al acudiente de su otra institución', async () => {
      const inv = await invite(adminA, 'students', laura, campusA1.id);
      const mails = await ctx.mail.waitFor('acudiente-b@test.aula360.local');
      expect(mails.at(-1)?.text).toContain(institutionA.name);
      expect(mails.at(-1)?.text).toContain('Laura');
      // La rechaza: no entra a A y la invitación desaparece.
      const agent = await loginAs(laura.email);
      await agent
        .post(`/api/users/me/invitations/${inv.id}/reject`)
        .expect(204);
      const me = await agent.get('/api/auth/me').expect(200);
      expect(
        (me.body as { institutions: { id: string }[] }).institutions.map(
          (i) => i.id,
        ),
      ).toEqual([institutionB.id]);
      const pending = await adminA.get('/api/students/invitations').expect(200);
      expect(pending.body).toEqual([]);
    });

    it('una cancelada ya no se puede aceptar', async () => {
      const inv = await invite(adminA, 'students', laura, campusA1.id);
      await adminA.delete(`/api/students/invitations/${inv.id}`).expect(204);
      const agent = await loginAs(laura.email);
      await agent
        .post(`/api/users/me/invitations/${inv.id}/accept`)
        .expect(404);
    });

    it('una vencida no se acepta, no aparece y se puede invitar de nuevo', async () => {
      const inv = await invite(adminA, 'students', laura, campusA1.id);
      await invitations().update(
        { id: inv.id },
        { expiresAt: new Date(Date.now() - 1000) },
      );
      const agent = await loginAs(laura.email);
      await agent
        .post(`/api/users/me/invitations/${inv.id}/accept`)
        .expect(409);
      const mine = await agent.get('/api/users/me/invitations').expect(200);
      expect(mine.body).toEqual([]);
      const fresh = await invite(adminA, 'students', laura, campusA1.id);
      expect((await invitations().findOneByOrFail({ id: inv.id })).status).toBe(
        'EXPIRED',
      );
      await agent
        .post(`/api/users/me/invitations/${fresh.id}/accept`)
        .expect(200);
    });

    it('al aceptar, su ficha en A no trae el acudiente ni el tipo de sangre de B', async () => {
      const list = await adminA.get('/api/students?limit=100').expect(200);
      const row = (list.body as { data: Profile[] }).data.find(
        (s) => s.user.id === laura.id,
      );
      const detail = await adminA.get(`/api/students/${row!.id}`).expect(200);
      expect(detail.text).not.toContain('Acudiente B');
      expect(
        (detail.body as { bloodType?: string | null }).bloodType,
      ).toBeNull();
      expect((detail.body as Profile).campus?.id).toBe(campusA1.id);
    });

    it('A2: con roles en A y solo un perfil en B, A sí le quita el acceso', async () => {
      // B le quita el acceso: le queda el perfil en B, sin roles allí.
      await adminB
        .delete(`/api/users/${laura.id}/institution-access`)
        .expect(204);
      await adminA
        .delete(`/api/users/${laura.id}/institution-access`)
        .expect(204);
    });

    it('M2: si vuelve a otra sede, quien solo administra la nueva no la mueve', async () => {
      // Su perfil en A quedó en la sede A1; vuelve con una invitación a A2...
      await ctx.dataSource
        .getRepository(StudentEntity)
        .update(
          { userId: laura.id, institutionId: institutionA.id },
          { campusId: campusA2.id },
        );
      // ...y el administrador de A1 no puede traerla a su sede.
      const res = await campusAdminA
        .post('/api/students/invitations')
        .send({ ...body(laura), campusId: campusA1.id });
      expect(res.status).toBe(403);
      // El administrador de toda la institución sí.
      await invite(adminA, 'students', laura, campusA1.id);
    });
  });

  describe('correcciones de la segunda revisión', () => {
    /** Docente de B, nuevo en cada prueba. */
    const teacherOfB = (name: string) =>
      person('TEACHER', institutionB, name, 'Segunda');
    const statusOf = async (id: string) =>
      (await invitations().findOneByOrFail({ id })).status;

    it('M1: buscar e invitar gastan el presupuesto diario, también si fallan', async () => {
      const institutionG = await ctx.data.createInstitution('Colegio G');
      const adminGUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(adminGUser.id, institutionG.id);
      const adminG = await loginAs(adminGUser.email);
      const budget = ctx.app.get(LookupBudget);
      budget.limit = 2;
      try {
        await adminG
          .get(`/api/teachers/link-candidate?${doc(carlos)}`)
          .expect(200);
        // Una invitación a un documento sin cuenta también cuenta.
        await adminG
          .post('/api/teachers/invitations')
          .send({
            documentType: 'CC',
            documentNumber: 'NOEXISTE2',
            campusId: null,
          })
          .expect(404);
        await adminG
          .get(`/api/teachers/link-candidate?${doc(carlos)}`)
          .expect(429);
        await invite(adminG, 'teachers', carlos, null, 429);
      } finally {
        budget.limit = LOOKUPS_PER_DAY;
      }
    });

    it('B1: invitaciones simultáneas no pasan del tope diario', async () => {
      const institutionF = await ctx.data.createInstitution('Colegio F');
      const adminFUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(adminFUser.id, institutionF.id);
      const adminF = await loginAs(adminFUser.email);
      await invitations().insert(
        Array.from({ length: INVITATIONS_PER_DAY - 1 }, () => ({
          institutionId: institutionF.id,
          userId: carlos.id,
          profileType: 'TEACHER' as const,
          status: 'CANCELLED' as const,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      );
      const targets = [
        await teacherOfB('Uno'),
        await teacherOfB('Dos'),
        await teacherOfB('Tres'),
      ];
      const statuses = await Promise.all(
        targets.map(async (u) => {
          const res = await adminF
            .post('/api/teachers/invitations')
            .send({ ...body(u), campusId: null });
          return res.status;
        }),
      );
      expect(statuses.sort()).toEqual([201, 429, 429]);
    });

    it('B3: si quien invitó pierde el permiso, la invitación ya no se acepta', async () => {
      const inviterUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(inviterUser.id, institutionA.id);
      const inviter = await loginAs(inviterUser.email);
      const target = await teacherOfB('Beatriz');
      const inv = await invite(inviter, 'teachers', target);
      await ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .delete({ userId: inviterUser.id, institutionId: institutionA.id });
      const agent = await loginAs(target.email);
      const res = await agent
        .post(`/api/users/me/invitations/${inv.id}/accept`)
        .expect(409);
      expect((res.body as { message: string }).message).toMatch(
        /ya no es válida/,
      );
      expect(await statusOf(inv.id)).toBe('PENDING');
    });

    it('B4: si entró por otra vía, aceptar la cancela (409)', async () => {
      const target = await teacherOfB('Camilo');
      const inv = await invite(adminA, 'teachers', target);
      await ctx.data.assignGlobalRole(target.id, institutionA.id, 'TEACHER');
      const agent = await loginAs(target.email);
      await agent
        .post(`/api/users/me/invitations/${inv.id}/accept`)
        .expect(409);
      expect(await statusOf(inv.id)).toBe('CANCELLED');
    });

    it('B4: quitar el acceso cancela sus invitaciones pendientes', async () => {
      const target = await teacherOfB('Dora');
      const inv = await invite(adminA, 'teachers', target);
      await ctx.data.assignGlobalRole(target.id, institutionA.id, 'TEACHER');
      await adminA
        .delete(`/api/users/${target.id}/institution-access`)
        .expect(204);
      expect(await statusOf(inv.id)).toBe('CANCELLED');
      const agent = await loginAs(target.email);
      await agent
        .post(`/api/users/me/invitations/${inv.id}/accept`)
        .expect(404);
    });
  });

  describe('límites', () => {
    it(`más de ${INVITATIONS_PER_DAY} invitaciones en 24 horas: 429`, async () => {
      const institutionC = await ctx.data.createInstitution('Colegio C');
      const adminCUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(adminCUser.id, institutionC.id);
      const adminC = await loginAs(adminCUser.email);
      const users = await ctx.dataSource.getRepository(UserEntity).find({
        select: { id: true },
        where: { id: In([carlos.id, laura.id, inactive.id]) },
      });
      await invitations().insert(
        Array.from({ length: INVITATIONS_PER_DAY }, (_, i) => ({
          institutionId: institutionC.id,
          userId: users[i % users.length].id,
          profileType: 'TEACHER' as const,
          status: 'CANCELLED' as const,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      );
      await invite(adminC, 'teachers', carlos, null, 429);
    });

    it('una institución inactiva no ofrece ni acepta su invitación', async () => {
      const institutionD = await ctx.data.createInstitution('Colegio D');
      const adminDUser = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(adminDUser.id, institutionD.id);
      const adminD = await loginAs(adminDUser.email);
      const pedro = await person('TEACHER', institutionB, 'Pedro', 'Ruiz');
      const inv = await invite(adminD, 'teachers', pedro);
      await ctx.dataSource
        .getRepository(InstitutionEntity)
        .update({ id: institutionD.id }, { isActive: false });
      const agent = await loginAs(pedro.email);
      const mine = await agent.get('/api/users/me/invitations').expect(200);
      expect(mine.body).toEqual([]);
      await agent
        .post(`/api/users/me/invitations/${inv.id}/accept`)
        .expect(409);
    });
  });
});
