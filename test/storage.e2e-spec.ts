import { randomUUID } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as request from 'supertest';
import { CampusEntity } from '../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../src/modules/institutions/entities/institution.entity';
import { UserEntity } from '../src/modules/users/entities/user.entity';
import { sharp } from '../src/storage/sharp';
import { createTestApp, TestContext } from './utils/create-test-app';
import { pendingDeletion, retryDeletion } from './utils/storage-deletions';
import { TEST_PASSWORD } from './utils/test-data';

type Agent = ReturnType<typeof request.agent>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Imagen real de color sólido. */
function solidImage(
  format: 'png' | 'jpeg',
  width = 40,
  height = 30,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#3366cc' },
  })
    .toFormat(format)
    .toBuffer();
}

let PNG: Buffer;
let JPEG: Buffer;

describe('Storage: avatar y logo (e2e)', () => {
  let ctx: TestContext;
  let institutionA: InstitutionEntity;
  let institutionB: InstitutionEntity;
  let campusA1: CampusEntity;
  let userA: UserEntity;
  let userB: UserEntity;

  let superAdmin: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let teacherA: Agent;
  let campusAdminA: Agent;

  const server = () => ctx.app.getHttpServer();

  async function loginAs(user: UserEntity): Promise<Agent> {
    const agent = request.agent(server());
    await agent
      .post('/api/auth/login')
      .send({ identifier: user.email, password: TEST_PASSWORD })
      .expect(200);
    return agent;
  }

  function png(name = 'foto.png') {
    return [PNG, { filename: name, contentType: 'image/png' }] as const;
  }

  beforeAll(async () => {
    PNG = await solidImage('png');
    JPEG = await solidImage('jpeg');
    ctx = await createTestApp();
    const { data } = ctx;
    institutionA = await data.createInstitution('Colegio A');
    institutionB = await data.createInstitution('Colegio B');
    campusA1 = await data.createCampus(institutionA.id, 'Sede A1');

    const superUser = await data.createUser({ userType: 'SUPER_ADMIN' });
    userA = await data.createUser();
    await data.assignGlobalRole(userA.id, institutionA.id);
    userB = await data.createUser();
    await data.assignGlobalRole(userB.id, institutionB.id);
    const teacherUser = await data.createUser({ userType: 'TEACHER' });
    await data.assignGlobalRole(teacherUser.id, institutionA.id, 'TEACHER');
    const campusAdminUser = await data.createUser();
    await data.assignGlobalRole(
      campusAdminUser.id,
      institutionA.id,
      'INSTITUTION_ADMIN',
      campusA1.id,
    );

    superAdmin = await loginAs(superUser);
    adminA = await loginAs(userA);
    adminB = await loginAs(userB);
    teacherA = await loginAs(teacherUser);
    campusAdminA = await loginAs(campusAdminUser);
  });

  afterAll(async () => {
    await ctx.data.cleanup();
    await ctx.app.close();
  });

  describe('/api/users/me/avatar', () => {
    it('401 sin sesión', async () => {
      await request(server())
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(401);
      await request(server()).get('/api/users/me/avatar').expect(401);
    });

    it('sube, consulta, reemplaza y quita el avatar propio', async () => {
      const first = await adminA
        .put('/api/users/me/avatar')
        .attach('file', ...png('../../mi foto.png'))
        .expect(200);
      const firstPath = first.body.avatarPath as string;
      // Nombre generado por el servidor; el original se ignora.
      expect(firstPath).toMatch(
        new RegExp(`^users/${userA.id}/${UUID}\\.png$`),
      );
      expect(first.body).toMatchObject({ expiresIn: 120 });
      expect(ctx.storage.has('avatars', firstPath)).toBe(true);

      const got = await adminA.get('/api/users/me/avatar').expect(200);
      expect(got.body.url).toContain(firstPath);

      const second = await adminA
        .put('/api/users/me/avatar')
        .attach('file', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' })
        .expect(200);
      expect(second.body.avatarPath).toMatch(/\.jpg$/);
      expect(ctx.storage.has('avatars', firstPath)).toBe(false);

      // La sesión dice si hay avatar, sin la ruta de Storage (B6 de la fase 11e).
      const me = await adminA.get('/api/auth/me').expect(200);
      expect(me.body.user.hasAvatar).toBe(true);
      expect(me.body.user).not.toHaveProperty('avatarPath');

      await adminA.delete('/api/users/me/avatar').expect(204);
      expect(ctx.storage.has('avatars', second.body.avatarPath as string)).toBe(
        false,
      );
      await adminA.get('/api/users/me/avatar').expect(404);
      const after = await adminA.get('/api/auth/me').expect(200);
      expect(after.body.user.hasAvatar).toBe(false);
    });

    it('cada usuario solo ve su propio avatar', async () => {
      const res = await adminA
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(200);
      // userB (otra institución) no tiene avatar: no recibe el de userA.
      await adminB.get('/api/users/me/avatar').expect(404);
      expect(ctx.storage.has('avatars', res.body.avatarPath as string)).toBe(
        true,
      );
    });

    it('400 con un MIME no permitido (SVG)', async () => {
      await adminA
        .put('/api/users/me/avatar')
        .attach(
          'file',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          {
            filename: 'x.svg',
            contentType: 'image/svg+xml',
          },
        )
        .expect(400);
    });

    it('400 si el archivo dice ser PNG pero no lo es', async () => {
      await adminA
        .put('/api/users/me/avatar')
        .attach('file', Buffer.from('<html><script>x</script></html>'), {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(400);
    });

    it('guarda la imagen regenerada: sin EXIF y como máximo 512 px', async () => {
      const photo = await sharp(await solidImage('jpeg', 1200, 900))
        .withExif({
          IFD0: { Make: 'Celular', Model: 'X1' },
          IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '4/1 36/1 0/1' },
        })
        .jpeg()
        .toBuffer();
      const res = await adminA
        .put('/api/users/me/avatar')
        .attach('file', photo, { filename: 'f.jpg', contentType: 'image/jpeg' })
        .expect(200);
      const stored = ctx.storage.objects.get(
        `avatars/${res.body.avatarPath as string}`,
      );
      const meta = await sharp(stored!.buffer).metadata();
      expect(meta.exif).toBeUndefined();
      expect([meta.width, meta.height]).toEqual([512, 384]);
    });

    it('400 si solo imita la cabecera de una imagen', async () => {
      await adminA
        .put('/api/users/me/avatar')
        .attach('file', Buffer.concat([PNG_SIGNATURE, Buffer.from('PK zip')]), {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(400);
    });

    it('413 si el archivo supera 2 MB (lo corta Multer)', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      await adminA
        .put('/api/users/me/avatar')
        .attach('file', big, { filename: 'g.png', contentType: 'image/png' })
        .expect(413);
    });

    it('413 sin leer el cuerpo si la petición anuncia más del máximo', async () => {
      // Solo se envían las cabeceras: si el servidor esperara el cuerpo, la
      // prueba no terminaría. Responde de inmediato y cierra la conexión.
      const httpServer = server() as unknown as http.Server;
      if (!httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      }
      const { port } = httpServer.address() as AddressInfo;
      const res = await new Promise<{ status?: number; body: string }>(
        (resolve, reject) => {
          const req = http.request({
            port,
            method: 'PUT',
            path: '/api/users/me/avatar',
            headers: {
              'content-type': 'multipart/form-data; boundary=x',
              'content-length': String(50 * 1024 * 1024),
            },
          });
          req.on('response', (r) => {
            let body = '';
            r.on('data', (c: Buffer) => (body += c.toString()));
            r.on('end', () => resolve({ status: r.statusCode, body }));
          });
          req.on('error', reject);
          req.flushHeaders();
        },
      );
      expect(res.status).toBe(413);
      expect(res.body).toContain('tamaño máximo');
    });

    it('400 sin archivo, con otro campo o con campos extra', async () => {
      await adminA.put('/api/users/me/avatar').expect(400);
      await adminA
        .put('/api/users/me/avatar')
        .attach('imagen', ...png())
        .expect(400);
      await adminA
        .put('/api/users/me/avatar')
        .field('avatarPath', 'otra/ruta.png')
        .attach('file', ...png())
        .expect(400);
    });

    it('403 desde un origen no permitido (CSRF)', async () => {
      await adminA
        .put('/api/users/me/avatar')
        .set('Origin', 'https://sitio-malicioso.com')
        .attach('file', ...png())
        .expect(403);
    });

    it('rate limiting: 10 por minuto por usuario, no por IP (429)', async () => {
      const first = await loginAs(await ctx.data.createUser());
      const second = await loginAs(await ctx.data.createUser());
      process.env.THROTTLE_DISABLED = 'false';
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
          statuses.push((await first.delete('/api/users/me/avatar')).status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 204)).toBe(true);
        expect(statuses[10]).toBe(429);
        // Misma IP, otro usuario: tiene su propio cupo.
        await second.delete('/api/users/me/avatar').expect(204);
      } finally {
        process.env.THROTTLE_DISABLED = 'true';
      }
    });

    it('403 si debe cambiar la contraseña', async () => {
      const pending = await ctx.data.createUser({ mustChangePassword: true });
      const agent = await loginAs(pending);
      await agent
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(403);
    });
  });

  describe('/api/institutions/current/logo', () => {
    it('el administrador cambia el logo de su institución (URL pública)', async () => {
      const res = await adminA
        .put('/api/institutions/current/logo')
        .attach('file', ...png())
        .expect(200);
      const path = res.body.logoPath as string;
      expect(res.body.id).toBe(institutionA.id);
      expect(path).toMatch(
        new RegExp(`^${institutionA.id}/logos/${UUID}\\.png$`),
      );
      expect(res.body.logoUrl).toBe(
        `https://fake.storage/public/logos/${path}`,
      );
      expect(ctx.storage.has('logos', path)).toBe(true);

      const current = await adminA.get('/api/institutions/current').expect(200);
      expect(current.body.logoUrl).toBe(res.body.logoUrl);

      const removed = await adminA
        .delete('/api/institutions/current/logo')
        .expect(200);
      expect(removed.body).toMatchObject({ logoPath: null, logoUrl: null });
      expect(ctx.storage.has('logos', path)).toBe(false);
    });

    it('403 sin permiso de edición (docente)', async () => {
      const before = ctx.storage.objects.size;
      await teacherA
        .put('/api/institutions/current/logo')
        .attach('file', ...png())
        .expect(403);
      await teacherA.delete('/api/institutions/current/logo').expect(403);
      expect(ctx.storage.objects.size).toBe(before);
    });

    it('403 si su permiso está limitado a una sede', async () => {
      await campusAdminA
        .put('/api/institutions/current/logo')
        .attach('file', ...png())
        .expect(403);
    });

    it('400 con un archivo que no es imagen', async () => {
      await adminA
        .put('/api/institutions/current/logo')
        .attach('file', Buffer.from('%PDF-1.4'), {
          filename: 'x.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
    });
  });

  describe('/api/institutions/:id/logo', () => {
    it('un administrador no cambia el logo de otra institución', async () => {
      await adminA
        .put(`/api/institutions/${institutionB.id}/logo`)
        .attach('file', ...png())
        .expect(403);
      await adminA
        .delete(`/api/institutions/${institutionB.id}/logo`)
        .expect(403);
    });

    it('el SUPER_ADMIN cambia y quita el logo de cualquier institución', async () => {
      const res = await superAdmin
        .put(`/api/institutions/${institutionB.id}/logo`)
        .attach('file', ...png())
        .expect(200);
      expect(res.body.logoPath).toMatch(
        new RegExp(`^${institutionB.id}/logos/`),
      );
      // adminB lo ve en su institución activa.
      const current = await adminB.get('/api/institutions/current');
      expect(current.body.logoUrl).toBe(res.body.logoUrl);

      await superAdmin
        .delete(`/api/institutions/${institutionB.id}/logo`)
        .expect(200);
      expect(ctx.storage.has('logos', res.body.logoPath as string)).toBe(false);
    });

    it('404 sin subir nada si la institución no existe', async () => {
      const before = ctx.storage.objects.size;
      await superAdmin
        .put(`/api/institutions/${randomUUID()}/logo`)
        .attach('file', ...png())
        .expect(404);
      expect(ctx.storage.objects.size).toBe(before);
    });
  });

  describe('borrados pendientes (tarea 2.11.5)', () => {
    afterEach(() => {
      ctx.storage.failRemovals = false;
    });

    it('el caso normal borra enseguida y no deja anotaciones', async () => {
      const first = await adminB
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(200);
      const firstPath = first.body.avatarPath as string;
      await adminB
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(200);
      expect(ctx.storage.has('avatars', firstPath)).toBe(false);
      expect(await pendingDeletion(ctx, 'avatars', firstPath)).toBeNull();
    });

    it('avatar con Storage caído: queda anotado y el reintento lo borra', async () => {
      const first = await adminB
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(200);
      const firstPath = first.body.avatarPath as string;
      ctx.storage.failRemovals = true;
      // La operación no falla por el borrado.
      const second = await adminB
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(200);
      expect(ctx.storage.has('avatars', firstPath)).toBe(true);
      const pending = await pendingDeletion(ctx, 'avatars', firstPath);
      // Primer intento hecho; el siguiente, en unos 5 minutos.
      expect(pending).toMatchObject({ attempts: 1, last_error: 'http_503' });
      expect(pending!.wait).toBeGreaterThan(280);
      expect(pending!.wait).toBeLessThanOrEqual(300);

      // Sigue caído: la espera se duplica.
      await retryDeletion(ctx, 'avatars', firstPath);
      const again = await pendingDeletion(ctx, 'avatars', firstPath);
      expect(again).toMatchObject({ attempts: 2 });
      expect(again!.wait).toBeGreaterThan(580);

      ctx.storage.failRemovals = false;
      await retryDeletion(ctx, 'avatars', firstPath);
      expect(ctx.storage.has('avatars', firstPath)).toBe(false);
      expect(await pendingDeletion(ctx, 'avatars', firstPath)).toBeNull();
      // El avatar vigente no se tocó.
      expect(ctx.storage.has('avatars', second.body.avatarPath as string)).toBe(
        true,
      );
    });

    it('logo quitado con Storage caído: queda anotado y el reintento lo borra', async () => {
      const res = await superAdmin
        .put(`/api/institutions/${institutionB.id}/logo`)
        .attach('file', ...png())
        .expect(200);
      const path = res.body.logoPath as string;
      ctx.storage.failRemovals = true;
      await superAdmin
        .delete(`/api/institutions/${institutionB.id}/logo`)
        .expect(200);
      expect(ctx.storage.has('logos', path)).toBe(true);
      expect(await pendingDeletion(ctx, 'logos', path)).toMatchObject({
        attempts: 1,
      });

      ctx.storage.failRemovals = false;
      await retryDeletion(ctx, 'logos', path);
      expect(ctx.storage.has('logos', path)).toBe(false);
      expect(await pendingDeletion(ctx, 'logos', path)).toBeNull();
    });

    it('nunca borra un archivo que una fila todavía usa', async () => {
      const res = await adminB
        .put('/api/users/me/avatar')
        .attach('file', ...png())
        .expect(200);
      const path = res.body.avatarPath as string;
      // Anotación indebida (p. ej. un COMMIT confirmado con la respuesta perdida).
      await ctx.dataSource.query(
        `INSERT INTO storage_deletions (bucket, path) VALUES ('avatars', $1)`,
        [path],
      );
      await retryDeletion(ctx, 'avatars', path);
      expect(ctx.storage.has('avatars', path)).toBe(true);
      expect(await pendingDeletion(ctx, 'avatars', path)).toBeNull();
      await adminB.get('/api/users/me/avatar').expect(200);
    });
  });
});
