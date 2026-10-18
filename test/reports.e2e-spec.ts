import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { PerformanceLevelEntity } from '../src/modules/reports/entities/performance-level.entity';
import { createTestApp, TestContext } from './utils/create-test-app';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

interface Level {
  name: string;
  minScore: number;
  maxScore: number;
}

interface Template {
  id: string;
  isActive: boolean;
}

const NATIONAL: Level[] = [
  { name: 'Superior', minScore: 4.6, maxScore: 5 },
  { name: 'Alto', minScore: 4, maxScore: 4.59 },
  { name: 'Básico', minScore: 3, maxScore: 3.99 },
  { name: 'Bajo', minScore: 1, maxScore: 2.99 },
];

const TEMPLATE = (title = 'Boletín') =>
  Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:Letter}</style></head>
     <body><h1>${title} {{institution.name}}</h1>
     {{#each subjects}}<p>{{name}}: {{score final}} {{level}}</p>{{/each}}
     <p>{{student.lastName}} — {{score average}}</p></body></html>`,
    'utf8',
  );

/** Supertest lee application/pdf como Buffer con este parser. */
const binary = ((
  res: NodeJS.ReadableStream,
  done: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}) as unknown as Parameters<request.Test['parse']>[0];

describe('Niveles de desempeño y plantillas de boletín (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let superAdmin: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let campusAdminA: Agent;
  let teacherA: Agent;

  const server = () => ctx.app.getHttpServer();
  const templatesUrl = (institutionId: string) =>
    `/api/institutions/${institutionId}/report-card-templates`;

  async function loginAs(identifier: string | null): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  const upload = (
    agent: Agent,
    institutionId: string,
    file: Buffer,
    {
      name = `Plantilla ${randomBytes(3).toString('hex')}`,
      filename = 'boletin.html',
    } = {},
  ) =>
    agent
      .post(templatesUrl(institutionId))
      .field('name', name)
      .attach('file', file, { filename, contentType: 'text/html' });

  beforeAll(async () => {
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');

    const superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
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

    superAdmin = await loginAs(superUser.email);
    adminA = await loginAs(adminAUser.email);
    adminB = await loginAs(adminBUser.email);
    campusAdminA = await loginAs(campusAdminUser.email);
    teacherA = await loginAs(teacherUser.email);
  }, 120_000);

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('/performance-levels', () => {
    it('reemplaza el juego completo (ordenado) y cada institución ve los suyos', async () => {
      const res = await adminA
        .put('/api/performance-levels')
        .send({ levels: NATIONAL })
        .expect(200);
      expect(res.body).toMatchObject({
        scale: { min: 1, max: 5, passingScore: 3 },
      });
      expect(
        (res.body as { levels: Level[] }).levels.map((l) => [
          l.name,
          l.minScore,
          l.maxScore,
        ]),
      ).toEqual([
        ['Bajo', 1, 2.99],
        ['Básico', 3, 3.99],
        ['Alto', 4, 4.59],
        ['Superior', 4.6, 5],
      ]);
      const other = await adminB.get('/api/performance-levels').expect(200);
      expect((other.body as { levels: Level[] }).levels).toEqual([]);
    });

    it.each([
      [
        'hueco',
        [
          { name: 'A', minScore: 1, maxScore: 2 },
          { name: 'B', minScore: 2.5, maxScore: 5 },
        ],
      ],
      [
        'cruce',
        [
          { name: 'A', minScore: 1, maxScore: 3 },
          { name: 'B', minScore: 2.5, maxScore: 5 },
        ],
      ],
      ['fuera de la escala', [{ name: 'A', minScore: 0, maxScore: 5 }]],
      ['3 decimales', [{ name: 'A', minScore: 1, maxScore: 4.999 }]],
      ['vacío', []],
      ['campos extra', [{ name: 'A', minScore: 1, maxScore: 5, color: 'x' }]],
    ])('400: %s (sin cambios)', async (_c, levels) => {
      await adminA.put('/api/performance-levels').send({ levels }).expect(400);
      const res = await adminA.get('/api/performance-levels').expect(200);
      expect((res.body as { levels: Level[] }).levels).toHaveLength(4);
    });

    it('limitado a una sede: consulta pero no reemplaza (403); el docente, nada', async () => {
      await campusAdminA.get('/api/performance-levels').expect(200);
      await campusAdminA
        .put('/api/performance-levels')
        .send({ levels: NATIONAL })
        .expect(403);
      await teacherA.get('/api/performance-levels').expect(403);
    });

    it('una institución nueva trae los nacionales y se reinician al cambiar la escala', async () => {
      const created = await superAdmin
        .post('/api/institutions')
        .send({ nit: `E2E-${randomBytes(5).toString('hex')}`, name: 'Nueva' })
        .expect(201);
      const id = created.body.id as string;
      ctx.data.trackInstitution(id);
      const repo = ctx.dataSource.getRepository(PerformanceLevelEntity);
      expect(await repo.countBy({ institutionId: id })).toBe(4);
      await superAdmin
        .patch(`/api/institutions/${id}`)
        .send({ gradingScaleMin: 0, gradingScaleMax: 10, passingScore: 6 })
        .expect(200);
      expect(await repo.countBy({ institutionId: id })).toBe(0);
    });
  });

  describe('/institutions/:id/report-card-templates (SUPER_ADMIN)', () => {
    let first: Template;

    it('sube una plantilla válida: queda inactiva y el HTML va al bucket privado', async () => {
      const res = await upload(superAdmin, institutionA.id, TEMPLATE())
        .field('description', 'Diseño de prueba')
        .expect(201);
      first = res.body as Template;
      expect(res.body).toMatchObject({
        isActive: false,
        description: 'Diseño de prueba',
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /storagePath|report-templates/,
      );
      const stored = [...ctx.storage.objects.keys()].filter((k) =>
        k.startsWith(`report-templates/${institutionA.id}/report-templates/`),
      );
      expect(stored).toHaveLength(1);
    });

    it('misma plantilla otra vez: 409', async () => {
      await upload(superAdmin, institutionA.id, TEMPLATE()).expect(409);
    });

    it.each([
      ['con {{{ }}}', Buffer.from('<p>{{{student.firstName}}}</p>'), 'x.html'],
      ['con parcial', Buffer.from('{{> otra}}'), 'x.html'],
      ['que no compila', Buffer.from('{{#each subjects}}'), 'x.html'],
      ['que no es .html', TEMPLATE('Otra'), 'x.txt'],
      ['que no es UTF-8', Buffer.from([0xff, 0xfe, 0x3c, 0x70]), 'x.html'],
    ])(
      '400: plantilla %s (y no se guarda nada)',
      async (_c, file, filename) => {
        const before = ctx.storage.objects.size;
        await upload(superAdmin, institutionA.id, file, { filename }).expect(
          400,
        );
        expect(ctx.storage.objects.size).toBe(before);
      },
    );

    it.each([
      ['con {{~{ }}} (M1)', '<p>{{~{student.firstName}~}}</p>'],
      ['con {{log}} (M3)', '<p>{{log student.documentNumber}}</p>'],
      [
        'con dns-prefetch (M4)',
        '<link rel="dns-prefetch" href="//{{student.documentNumber}}.x.tld">',
      ],
      [
        'con @root anidado (M2)',
        '{{#each subjects}}{{#each @root.subjects}}x{{/each}}{{/each}}',
      ],
    ])('400: plantilla %s', async (_c, html) => {
      await upload(superAdmin, institutionA.id, Buffer.from(html)).expect(400);
    });

    it('campos de texto que no son del DTO: 400', async () => {
      await superAdmin
        .post(templatesUrl(institutionA.id))
        .field('name', 'X')
        .field('institutionId', institutionB.id)
        .attach('file', TEMPLATE('Campos'), {
          filename: 'x.html',
          contentType: 'text/html',
        })
        .expect(400);
    });

    it('sin archivo o sin nombre: 400; más de 256 KB: 413', async () => {
      await superAdmin
        .post(templatesUrl(institutionA.id))
        .field('name', 'X')
        .expect(400);
      await superAdmin
        .post(templatesUrl(institutionA.id))
        .attach('file', TEMPLATE('Sin nombre'), {
          filename: 'x.html',
          contentType: 'text/html',
        })
        .expect(400);
      await upload(
        superAdmin,
        institutionA.id,
        Buffer.alloc(256 * 1024 + 10, 'a'),
      ).expect(413);
    });

    it('administradores de institución y docentes: 403', async () => {
      await adminA.get(templatesUrl(institutionA.id)).expect(403);
      await upload(adminA, institutionA.id, TEMPLATE('A')).expect(403);
      await teacherA.get(templatesUrl(institutionA.id)).expect(403);
    });

    it('institución inexistente o plantilla de otra institución: 404', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      await superAdmin.get(templatesUrl(missing)).expect(404);
      await superAdmin
        .patch(`${templatesUrl(institutionB.id)}/${first.id}/activate`)
        .expect(404);
      await superAdmin
        .get(`${templatesUrl(institutionB.id)}/${first.id}/preview`)
        .expect(404);
    });

    it('una sola activa por institución', async () => {
      await superAdmin
        .patch(`${templatesUrl(institutionA.id)}/${first.id}/activate`)
        .expect(200);
      const second = (
        await upload(superAdmin, institutionA.id, TEMPLATE('Segunda')).expect(
          201,
        )
      ).body as Template;
      await superAdmin
        .patch(`${templatesUrl(institutionA.id)}/${second.id}/activate`)
        .expect(200);
      const list = await superAdmin
        .get(templatesUrl(institutionA.id))
        .expect(200);
      const active = (list.body as Template[]).filter((t) => t.isActive);
      expect(active.map((t) => t.id)).toEqual([second.id]);
      await superAdmin
        .patch(`${templatesUrl(institutionA.id)}/${second.id}/deactivate`)
        .expect(200);
    });

    it('vista previa en PDF: de una plantilla y de la del sistema', async () => {
      for (const url of [
        `${templatesUrl(institutionA.id)}/${first.id}/preview`,
        `${templatesUrl(institutionA.id)}/system/preview`,
      ]) {
        const res = await superAdmin
          .get(url)
          .buffer(true)
          .parse(binary)
          .expect(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.headers['cache-control']).toBe('no-store');
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      }
    });

    it('archivo alterado en Storage (SHA-256 distinto): 502 y no se usa', async () => {
      const temp = (
        await upload(superAdmin, institutionA.id, TEMPLATE('Alterada')).expect(
          201,
        )
      ).body as Template;
      const key = [...ctx.storage.objects.keys()].find(
        (k) =>
          k.startsWith(`report-templates/${institutionA.id}/`) &&
          ctx.storage.objects.get(k)?.buffer.includes('Alterada'),
      ) as string;
      const file = ctx.storage.objects.get(key)!;
      ctx.storage.objects.set(key, {
        ...file,
        buffer: Buffer.from(
          file.buffer.toString('utf8').replace('Alterada', 'Cambiada'),
        ),
      });
      await superAdmin
        .get(`${templatesUrl(institutionA.id)}/${temp.id}/preview`)
        .expect(502);
      await superAdmin
        .patch(`${templatesUrl(institutionA.id)}/${temp.id}/activate`)
        .expect(502);
      await superAdmin
        .delete(`${templatesUrl(institutionA.id)}/${temp.id}`)
        .expect(204);
    });

    it('borra una plantilla sin boletines y su archivo', async () => {
      const temp = (
        await upload(superAdmin, institutionA.id, TEMPLATE('Temporal')).expect(
          201,
        )
      ).body as Template;
      const before = ctx.storage.objects.size;
      await superAdmin
        .delete(`${templatesUrl(institutionA.id)}/${temp.id}`)
        .expect(204);
      expect(ctx.storage.objects.size).toBe(before - 1);
      await superAdmin
        .delete(`${templatesUrl(institutionA.id)}/${temp.id}`)
        .expect(404);
    });
  });
});
