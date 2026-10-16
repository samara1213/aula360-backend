import { randomBytes, randomUUID } from 'crypto';
import * as request from 'supertest';
import { IsNull } from 'typeorm';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { MenuOptionEntity } from '../src/modules/security/entities/menu-option.entity';
import { RoleEntity } from '../src/modules/security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../src/modules/security/entities/user-institution-role.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

interface MenuNode {
  id: string;
  slug: string;
  permissions: {
    view: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  };
  children: MenuNode[];
}

/** Busca un nodo por slug en un árbol de menú. */
function findNode(nodes: MenuNode[], slug: string): MenuNode | undefined {
  for (const node of nodes) {
    if (node.slug === slug) return node;
    const found = findNode(node.children, slug);
    if (found) return found;
  }
  return undefined;
}

const suffix = () => randomBytes(4).toString('hex');

describe('Roles, permisos y menús (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let campusA2: CampusEntity;
  let campusB: CampusEntity;

  let superUser: UserEntity;
  let adminAUser: UserEntity;
  let teacherAUser: UserEntity;
  let adminBUser: UserEntity;

  let superAdmin: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let teacherA: Agent;
  let campusAdminA: Agent; // INSTITUTION_ADMIN limitado a campusA1
  let rolesManagerA: Agent; // solo security, security.roles y security.users
  let managerRole: RoleEntity;

  let globalRoles: Record<string, string>;
  let roleB: RoleEntity;
  const menuIds: Record<string, string> = {};

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
    const { data, dataSource } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');
    campusA2 = await data.createCampus(institutionA.id, 'Sede A2');
    campusB = await data.createCampus(institutionB.id, 'Sede B');

    superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
    adminAUser = await data.createUser();
    await data.assignGlobalRole(adminAUser.id, institutionA.id);
    adminBUser = await data.createUser();
    await data.assignGlobalRole(adminBUser.id, institutionB.id);
    teacherAUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(teacherAUser.id, institutionA.id, 'TEACHER');
    const campusAdminUser = await data.createUser();
    await data.assignGlobalRole(
      campusAdminUser.id,
      institutionA.id,
      'INSTITUTION_ADMIN',
      campusA1.id,
    );
    managerRole = await data.createInstitutionRole(institutionA.id, [
      'security',
      'security.roles',
      'security.users',
    ]);
    const managerUser = await data.createUser();
    await dataSource.getRepository(UserInstitutionRoleEntity).insert({
      userId: managerUser.id,
      institutionId: institutionA.id,
      roleId: managerRole.id,
    });
    roleB = await data.createInstitutionRole(institutionB.id, ['institution']);

    const roles = await dataSource
      .getRepository(RoleEntity)
      .findBy({ institutionId: IsNull() });
    globalRoles = Object.fromEntries(roles.map((r) => [r.name, r.id]));
    const menus = await dataSource.getRepository(MenuOptionEntity).find();
    menus.forEach((m) => (menuIds[m.slug] = m.id));

    superAdmin = await loginAs(superUser);
    adminA = await loginAs(adminAUser);
    adminB = await loginAs(adminBUser);
    teacherA = await loginAs(teacherAUser);
    campusAdminA = await loginAs(campusAdminUser);
    rolesManagerA = await loginAs(managerUser);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('/api/menu-options', () => {
    let root: string;
    let child: string;
    let grandchild: string;
    let rootSlug: string;

    it('401 sin sesión', async () => {
      await request(server()).get('/api/menu-options/my-menu').expect(401);
      await request(server()).get('/api/menu-options').expect(401);
    });

    it('el SUPER_ADMIN sin institución ve el árbol completo y un my-menu vacío', async () => {
      const tree = await superAdmin.get('/api/menu-options').expect(200);
      const security = findNode(tree.body as MenuNode[], 'security');
      expect(security?.children.map((c) => c.slug)).toContain('security.roles');
      const mine = await superAdmin
        .get('/api/menu-options/my-menu')
        .expect(200);
      expect(mine.body).toEqual([]);
    });

    it('el administrador consulta el árbol pero no puede modificarlo (403)', async () => {
      await adminA.get('/api/menu-options').expect(200);
      await adminA
        .post('/api/menu-options')
        .send({ name: 'X', slug: `e2e-${suffix()}` })
        .expect(403);
      await adminA
        .patch(`/api/menu-options/${menuIds['security']}/deactivate`)
        .expect(403);
    });

    it('un docente no puede consultar el árbol completo (403)', async () => {
      await teacherA.get('/api/menu-options').expect(403);
    });

    it('SUPER_ADMIN crea tres niveles y rechaza el cuarto (400)', async () => {
      rootSlug = `e2e-${suffix()}`;
      root = (
        await superAdmin
          .post('/api/menu-options')
          .send({ name: '  Raíz E2E ', slug: rootSlug, displayOrder: 99 })
          .expect(201)
      ).body.id as string;
      child = (
        await superAdmin
          .post('/api/menu-options')
          .send({ name: 'Hijo', slug: `${rootSlug}.child`, parentId: root })
          .expect(201)
      ).body.id as string;
      const created = await superAdmin
        .post('/api/menu-options')
        .send({
          name: 'Nieto',
          slug: `${rootSlug}.child.leaf`,
          parentId: child,
        })
        .expect(201);
      grandchild = created.body.id as string;
      expect(created.body).toMatchObject({
        parentId: child,
        name: 'Nieto',
        isActive: true,
        icon: null,
      });

      await superAdmin
        .post('/api/menu-options')
        .send({ name: 'Bisnieto', slug: `${rootSlug}.x`, parentId: grandchild })
        .expect(400);
    });

    it('409 con slug repetido y 400 con slug inválido o al intentar cambiarlo', async () => {
      await superAdmin
        .post('/api/menu-options')
        .send({ name: 'Dup', slug: rootSlug })
        .expect(409);
      await superAdmin
        .post('/api/menu-options')
        .send({ name: 'Mal', slug: 'E2E Con Espacios' })
        .expect(400);
      await superAdmin
        .patch(`/api/menu-options/${root}`)
        .send({ slug: `${rootSlug}-otro` })
        .expect(400);
    });

    it('400 al mover una opción dentro de su propia rama o pasar de 3 niveles', async () => {
      await superAdmin
        .patch(`/api/menu-options/${root}`)
        .send({ parentId: grandchild })
        .expect(400);
      // La rama de 3 niveles no cabe bajo otra raíz.
      await superAdmin
        .patch(`/api/menu-options/${root}`)
        .send({ parentId: menuIds['reports'] })
        .expect(400);
    });

    it('mueve una rama y la devuelve a su lugar', async () => {
      const moved = await superAdmin
        .patch(`/api/menu-options/${grandchild}`)
        .send({ parentId: root, name: 'Nieto movido' })
        .expect(200);
      expect(moved.body).toMatchObject({
        parentId: root,
        name: 'Nieto movido',
      });
      await superAdmin
        .patch(`/api/menu-options/${grandchild}`)
        .send({ parentId: child })
        .expect(200);
    });

    it('404 con una opción inexistente', async () => {
      await superAdmin.get(`/api/menu-options/${randomUUID()}`).expect(404);
      await superAdmin
        .post('/api/menu-options')
        .send({ name: 'X', slug: `e2e-${suffix()}`, parentId: randomUUID() })
        .expect(404);
    });

    it('my-menu del docente: lo de su rol con sus acciones, sin seguridad', async () => {
      const res = await teacherA.get('/api/menu-options/my-menu').expect(200);
      const tree = res.body as MenuNode[];
      expect(findNode(tree, 'security')).toBeUndefined();
      expect(findNode(tree, 'evaluations.scores')?.permissions).toEqual({
        view: true,
        create: true,
        update: true,
        delete: false,
      });
    });

    it('my-menu incluye los ancestros y oculta la rama de un padre desactivado', async () => {
      const role = await ctx.data.createInstitutionRole(institutionA.id, [
        `${rootSlug}.child.leaf`,
      ]);
      const user = await ctx.data.createUser();
      await ctx.dataSource.getRepository(UserInstitutionRoleEntity).insert({
        userId: user.id,
        institutionId: institutionA.id,
        roleId: role.id,
      });
      const agent = await loginAs(user);

      let tree = (await agent.get('/api/menu-options/my-menu').expect(200))
        .body as MenuNode[];
      expect(tree.map((n) => n.slug)).toEqual([rootSlug]);
      expect(tree[0].permissions.view).toBe(false);
      expect(tree[0].children[0].children[0]).toMatchObject({
        slug: `${rootSlug}.child.leaf`,
        permissions: { view: true, create: true, update: true, delete: true },
      });

      await superAdmin
        .patch(`/api/menu-options/${root}/deactivate`)
        .expect(200);
      tree = (await agent.get('/api/menu-options/my-menu').expect(200))
        .body as MenuNode[];
      expect(tree).toEqual([]);
      await superAdmin.patch(`/api/menu-options/${root}/activate`).expect(200);
    });

    it('my-menu suma varios roles e ignora los de una sede desactivada', async () => {
      const campus = await ctx.data.createCampus(
        institutionA.id,
        'Sede temporal',
      );
      const user = await ctx.data.createUser();
      await ctx.data.assignGlobalRole(user.id, institutionA.id, 'TEACHER');
      await ctx.data.assignGlobalRole(user.id, institutionA.id, 'STUDENT');
      await ctx.data.assignGlobalRole(
        user.id,
        institutionA.id,
        'INSTITUTION_ADMIN',
        campus.id,
      );
      const agent = await loginAs(user);

      let tree = (await agent.get('/api/menu-options/my-menu').expect(200))
        .body as MenuNode[];
      expect(findNode(tree, 'security.roles')).toBeDefined();
      expect(
        findNode(tree, 'evaluations.evaluations')?.permissions.delete,
      ).toBe(true);

      await adminA.patch(`/api/campuses/${campus.id}/deactivate`).expect(200);
      tree = (await agent.get('/api/menu-options/my-menu').expect(200))
        .body as MenuNode[];
      expect(findNode(tree, 'security.roles')).toBeUndefined();
      expect(findNode(tree, 'evaluations.scores')).toBeDefined();
    });
  });

  describe('/api/roles', () => {
    let roleId: string;

    it('lista los roles globales y los propios, nunca los de otra institución', async () => {
      const res = await adminA
        .get('/api/roles')
        .query({ limit: 100 })
        .expect(200);
      const ids = (res.body.data as { id: string }[]).map((r) => r.id);
      expect(ids).toContain(globalRoles['INSTITUTION_ADMIN']);
      expect(ids).not.toContain(roleB.id);
      await adminA.get(`/api/roles/${roleB.id}`).expect(404);
    });

    it('crea, edita, define permisos y borra un rol de su institución', async () => {
      const name = `E2E Coordinador ${suffix()}`;
      const created = await adminA
        .post('/api/roles')
        .send({ name })
        .expect(201);
      roleId = created.body.id as string;
      expect(created.body).toMatchObject({
        name,
        institutionId: institutionA.id,
        isGlobal: false,
        permissions: [],
      });

      await adminA.post('/api/roles').send({ name }).expect(409);
      await adminA
        .patch(`/api/roles/${roleId}`)
        .send({ description: 'Coordina cursos' })
        .expect(200);

      const perms = await adminA
        .put(`/api/roles/${roleId}/permissions`)
        .send({
          permissions: [
            { menuOptionId: menuIds['academic'] },
            { menuOptionId: menuIds['academic.courses'], canCreate: true },
          ],
        })
        .expect(200);
      expect(perms.body.permissions).toEqual([
        expect.objectContaining({ slug: 'academic', canCreate: false }),
        expect.objectContaining({ slug: 'academic.courses', canCreate: true }),
      ]);

      const detail = await adminA.get(`/api/roles/${roleId}`).expect(200);
      expect(detail.body.description).toBe('Coordina cursos');
      expect(detail.body.permissions).toHaveLength(2);
    });

    it('otra institución no puede ver, editar ni borrar el rol (404)', async () => {
      await adminB.get(`/api/roles/${roleId}`).expect(404);
      await adminB
        .patch(`/api/roles/${roleId}`)
        .send({ name: 'X' })
        .expect(404);
      await adminB
        .put(`/api/roles/${roleId}/permissions`)
        .send({ permissions: [] })
        .expect(404);
      await adminB.delete(`/api/roles/${roleId}`).expect(404);
    });

    it('los roles globales son de solo lectura desde una institución (403)', async () => {
      const id = globalRoles['TEACHER'];
      await adminA.get(`/api/roles/${id}`).expect(200);
      await adminA.patch(`/api/roles/${id}`).send({ name: 'X' }).expect(403);
      await adminA
        .put(`/api/roles/${id}/permissions`)
        .send({ permissions: [] })
        .expect(403);
      await adminA.delete(`/api/roles/${id}`).expect(403);
    });

    it('400 con permisos repetidos o campos extra y 404 con una opción inexistente', async () => {
      const id = menuIds['academic'];
      await adminA
        .put(`/api/roles/${roleId}/permissions`)
        .send({ permissions: [{ menuOptionId: id }, { menuOptionId: id }] })
        .expect(400);
      await adminA
        .put(`/api/roles/${roleId}/permissions`)
        .send({ permissions: [{ menuOptionId: id, canView: true }] })
        .expect(400);
      await adminA
        .put(`/api/roles/${roleId}/permissions`)
        .send({ permissions: [{ menuOptionId: randomUUID() }] })
        .expect(404);
    });

    it('no se puede otorgar ni tocar lo que uno no tiene (403)', async () => {
      // El gestor solo tiene permisos de seguridad.
      const own = await rolesManagerA
        .post('/api/roles')
        .send({ name: `E2E Ayudante ${suffix()}` })
        .expect(201);
      await rolesManagerA
        .put(`/api/roles/${own.body.id as string}/permissions`)
        .send({ permissions: [{ menuOptionId: menuIds['academic.courses'] }] })
        .expect(403);
      await rolesManagerA
        .put(`/api/roles/${own.body.id as string}/permissions`)
        .send({
          permissions: [
            { menuOptionId: menuIds['security.roles'], canUpdate: true },
          ],
        })
        .expect(200);
      // El rol del coordinador tiene permisos académicos: no lo puede editar ni borrar.
      await rolesManagerA
        .patch(`/api/roles/${roleId}`)
        .send({ name: 'Rebautizado' })
        .expect(403);
      await rolesManagerA.delete(`/api/roles/${roleId}`).expect(403);
    });

    it('un docente no gestiona roles y un administrador por sede tampoco (403)', async () => {
      await teacherA.get('/api/roles').expect(403);
      await campusAdminA
        .post('/api/roles')
        .send({ name: `E2E Sede ${suffix()}` })
        .expect(403);
    });

    it('409 al borrar un rol asignado; 204 sin asignaciones', async () => {
      const assignment = await adminA
        .post('/api/role-assignments')
        .send({ userId: teacherAUser.id, roleId })
        .expect(201);
      await adminA.delete(`/api/roles/${roleId}`).expect(409);
      await adminA
        .delete(`/api/role-assignments/${assignment.body.id as string}`)
        .expect(204);
      await adminA.delete(`/api/roles/${roleId}`).expect(204);
      await adminA.get(`/api/roles/${roleId}`).expect(404);
    });
  });

  describe('/api/global-roles', () => {
    it('solo el SUPER_ADMIN (403 para un administrador)', async () => {
      await adminA.get('/api/global-roles').expect(403);
      await adminA
        .post('/api/global-roles')
        .send({ name: `E2E Global ${suffix()}` })
        .expect(403);
    });

    it('SUPER_ADMIN crea, define permisos y borra un rol global', async () => {
      const created = await superAdmin
        .post('/api/global-roles')
        .send({ name: `E2E Global ${suffix()}` })
        .expect(201);
      const id = created.body.id as string;
      expect(created.body.isGlobal).toBe(true);
      await superAdmin
        .put(`/api/global-roles/${id}/permissions`)
        .send({
          permissions: [{ menuOptionId: menuIds['reports'], canDelete: true }],
        })
        .expect(200);
      // Un rol de institución no existe en /global-roles.
      await superAdmin.get(`/api/global-roles/${roleB.id}`).expect(404);
      await superAdmin.delete(`/api/global-roles/${id}`).expect(204);
    });
  });

  describe('/api/role-assignments', () => {
    it('lista las asignaciones de la institución sin datos sensibles', async () => {
      const res = await adminA
        .get('/api/role-assignments')
        .query({ userId: teacherAUser.id })
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        institutionId: institutionA.id,
        user: { id: teacherAUser.id, userType: 'TEACHER' },
        role: { id: globalRoles['TEACHER'], isGlobal: true },
        campus: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });

    it('el administrador por sede solo ve las asignaciones de su sede', async () => {
      const res = await campusAdminA
        .get('/api/role-assignments')
        .query({ limit: 100 })
        .expect(200);
      for (const row of res.body.data as { campus: { id: string } | null }[]) {
        expect(row.campus?.id).toBe(campusA1.id);
      }
    });

    it('asigna con sede; 409 duplicada; 404 sede ajena; 400 sede inactiva', async () => {
      const body = {
        userId: teacherAUser.id,
        roleId: globalRoles['STUDENT'],
        campusId: campusA2.id,
      };
      const created = await adminA
        .post('/api/role-assignments')
        .send(body)
        .expect(201);
      expect(created.body.campus).toMatchObject({ id: campusA2.id });
      await adminA.post('/api/role-assignments').send(body).expect(409);
      await adminA
        .post('/api/role-assignments')
        .send({ ...body, campusId: campusB.id })
        .expect(404);

      const inactive = await ctx.data.createCampus(
        institutionA.id,
        'Sede cerrada',
      );
      await adminA.patch(`/api/campuses/${inactive.id}/deactivate`).expect(200);
      await adminA
        .post('/api/role-assignments')
        .send({ ...body, campusId: inactive.id })
        .expect(400);
      await adminA
        .delete(`/api/role-assignments/${created.body.id as string}`)
        .expect(204);
    });

    it('404 al vincular a alguien que no pertenece a la institución, o un rol ajeno', async () => {
      await adminA
        .post('/api/role-assignments')
        .send({ userId: adminBUser.id, roleId: globalRoles['TEACHER'] })
        .expect(404);
      await adminA
        .post('/api/role-assignments')
        .send({ userId: teacherAUser.id, roleId: roleB.id })
        .expect(404);
    });

    it('400 con datos inválidos', async () => {
      await adminA
        .post('/api/role-assignments')
        .send({ userId: 'no-uuid', roleId: globalRoles['TEACHER'] })
        .expect(400);
    });

    it('no puede asignar un rol con más permisos de los que tiene (403)', async () => {
      await rolesManagerA
        .post('/api/role-assignments')
        .send({
          userId: teacherAUser.id,
          roleId: globalRoles['INSTITUTION_ADMIN'],
        })
        .expect(403);
    });

    it('nadie se quita sus propias asignaciones (403)', async () => {
      const res = await adminA
        .get('/api/role-assignments')
        .query({ userId: adminAUser.id })
        .expect(200);
      await adminA
        .delete(`/api/role-assignments/${res.body.data[0].id as string}`)
        .expect(403);
    });

    it('otra institución no puede ver ni quitar la asignación (404)', async () => {
      const res = await adminA
        .get('/api/role-assignments')
        .query({ userId: teacherAUser.id })
        .expect(200);
      const id = res.body.data[0].id as string;
      await adminB.delete(`/api/role-assignments/${id}`).expect(404);
      const list = await adminB
        .get('/api/role-assignments')
        .query({ userId: teacherAUser.id })
        .expect(200);
      expect(list.body.data).toEqual([]);
    });

    it('un administrador no gestiona a un SUPER_ADMIN vinculado (403)', async () => {
      const otherSuper = await ctx.data.createUser({ userType: 'SUPER_ADMIN' });
      await ctx.data.assignGlobalRole(
        otherSuper.id,
        institutionA.id,
        'TEACHER',
      );
      await adminA
        .post('/api/role-assignments')
        .send({ userId: otherSuper.id, roleId: globalRoles['STUDENT'] })
        .expect(403);

      // B5: el administrador no ve sus datos de contacto; el SUPER_ADMIN sí.
      const seen = await adminA
        .get('/api/role-assignments')
        .query({ userId: otherSuper.id })
        .expect(200);
      expect(seen.body.data[0].user).toMatchObject({
        id: otherSuper.id,
        documentType: null,
        documentNumber: null,
        email: null,
      });
      const bySuper = await superAdmin
        .get(`/api/institutions/${institutionA.id}/role-assignments`)
        .query({ userId: otherSuper.id })
        .expect(200);
      expect(bySuper.body.data[0].user).toMatchObject({
        documentNumber: otherSuper.documentNumber,
        email: otherSuper.email,
      });
    });

    it('nadie quita la gestión de roles y usuarios a un rol que tiene asignado (409)', async () => {
      const full = [
        {
          menuOptionId: menuIds['security'],
          canCreate: true,
          canUpdate: true,
          canDelete: true,
        },
        {
          menuOptionId: menuIds['security.roles'],
          canCreate: true,
          canUpdate: true,
          canDelete: true,
        },
        {
          menuOptionId: menuIds['security.users'],
          canCreate: true,
          canUpdate: true,
          canDelete: true,
        },
      ];
      await rolesManagerA
        .put(`/api/roles/${managerRole.id}/permissions`)
        .send({
          permissions: full.filter(
            (p) => p.menuOptionId !== menuIds['security.users'],
          ),
        })
        .expect(409);
      await rolesManagerA
        .put(`/api/roles/${managerRole.id}/permissions`)
        .send({
          permissions: [full[0], full[1], { ...full[2], canDelete: false }],
        })
        .expect(409);
      // Conservando la gestión sí puede editar su rol (aquí quita "security").
      await rolesManagerA
        .put(`/api/roles/${managerRole.id}/permissions`)
        .send({ permissions: [full[1], full[2]] })
        .expect(200);
    });
  });

  describe('techo de permisos por alcance (revisión de seguridad)', () => {
    const link = (userId: string, roleId: string, campusId: string | null) =>
      ctx.dataSource
        .getRepository(UserInstitutionRoleEntity)
        .insert({ userId, institutionId: institutionA.id, roleId, campusId });

    it('nadie se asigna roles a sí mismo (403)', async () => {
      await adminA
        .post('/api/role-assignments')
        .send({ userId: adminAUser.id, roleId: globalRoles['STUDENT'] })
        .expect(403);
    });

    it('un permiso que solo tiene en una sede no se puede otorgar a un rol (403)', async () => {
      const security = await ctx.data.createInstitutionRole(institutionA.id, [
        'security',
        'security.roles',
      ]);
      const academic = await ctx.data.createInstitutionRole(institutionA.id, [
        'academic',
        'academic.courses',
      ]);
      const user = await ctx.data.createUser();
      await link(user.id, security.id, null);
      await link(user.id, academic.id, campusA1.id);
      const agent = await loginAs(user);

      const own = await agent
        .post('/api/roles')
        .send({ name: `E2E Ampliado ${suffix()}` })
        .expect(201);
      await agent
        .put(`/api/roles/${own.body.id as string}/permissions`)
        .send({ permissions: [{ menuOptionId: menuIds['academic.courses'] }] })
        .expect(403);
    });

    it('un asignador por sede no amplía permisos de otra sede ni ve usuarios o sedes fuera de su alcance', async () => {
      const users = await ctx.data.createInstitutionRole(institutionA.id, [
        'security',
        'security.users',
      ]);
      const academic = await ctx.data.createInstitutionRole(institutionA.id, [
        'academic',
        'academic.courses',
      ]);
      const assigner = await ctx.data.createUser();
      await link(assigner.id, users.id, campusA1.id);
      await link(assigner.id, academic.id, campusA2.id);
      const memberA1 = await ctx.data.createUser({ userType: 'TEACHER' });
      await link(memberA1.id, globalRoles['STUDENT'], campusA1.id);
      const agent = await loginAs(assigner);

      // Tiene "academic.courses" solo en A2: no lo puede otorgar en A1.
      await agent
        .post('/api/role-assignments')
        .send({
          userId: memberA1.id,
          roleId: academic.id,
          campusId: campusA1.id,
        })
        .expect(403);
      // A2 está fuera de su alcance de asignación: 404, igual que una sede inexistente.
      await agent
        .post('/api/role-assignments')
        .send({
          userId: memberA1.id,
          roleId: academic.id,
          campusId: campusA2.id,
        })
        .expect(404);
      // El docente pertenece a toda la institución, pero no a sus sedes. Con
      // un rol dentro de su techo (el rol y el techo se validan antes de mirar
      // al usuario), el usuario fuera de su alcance da 404.
      await agent
        .post('/api/role-assignments')
        .send({
          userId: teacherAUser.id,
          roleId: users.id,
          campusId: campusA1.id,
        })
        .expect(404);
    });
  });

  describe('/api/institutions/:id/role-assignments (SUPER_ADMIN)', () => {
    it('crea el primer administrador de una institución nueva', async () => {
      const institution = await ctx.data.createInstitution('Colegio Nuevo');
      const user = await ctx.data.createUser();
      await superAdmin
        .post(`/api/institutions/${institution.id}/role-assignments`)
        .send({ userId: user.id, roleId: globalRoles['INSTITUTION_ADMIN'] })
        .expect(201);
      const list = await superAdmin
        .get(`/api/institutions/${institution.id}/role-assignments`)
        .expect(200);
      expect(list.body.meta.total).toBe(1);

      const agent = await loginAs(user);
      const me = await agent.get('/api/auth/me').expect(200);
      expect(me.body.activeInstitutionId).toBe(institution.id);
      await agent.get('/api/campuses').expect(200);
    });

    it('404 con una institución inexistente y 403 para quien no es SUPER_ADMIN', async () => {
      await superAdmin
        .post(`/api/institutions/${randomUUID()}/role-assignments`)
        .send({ userId: adminAUser.id, roleId: globalRoles['TEACHER'] })
        .expect(404);
      await adminA
        .get(`/api/institutions/${institutionA.id}/role-assignments`)
        .expect(403);
    });
  });
});
