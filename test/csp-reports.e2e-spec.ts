import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { CSP_REPORT_THROTTLE } from '../src/common/constants/throttle';
import {
  LEGACY_REPORT_TYPE,
  REPORTING_TYPE,
} from '../src/modules/csp-reports/csp-reports.service';
import { createTestApp, TestContext } from './utils/create-test-app';

/**
 * Informes de la CSP que manda el navegador (Reporting-Endpoints y
 * report-uri del frontend): sin sesión, solo al log y con campos acotados.
 */
describe('POST /api/csp-reports (e2e)', () => {
  let ctx: TestContext;
  const server = () => ctx.app.getHttpServer();

  const reporting = [
    {
      type: 'csp-violation',
      url: 'https://app.aula360.co/people/students?search=Laura',
      body: {
        effectiveDirective: 'script-src-elem',
        blockedURL: 'https://evil.example/x.js?token=secreto',
        documentURL: 'https://app.aula360.co/people/students?search=Laura',
        disposition: 'enforce',
      },
    },
  ];
  const legacy = {
    'csp-report': {
      'effective-directive': 'require-trusted-types-for',
      'blocked-uri': 'trusted-types-sink',
      'document-uri': 'https://app.aula360.co/login?next=/x',
      'script-sample': 'Element innerHTML|<img src=x>',
    },
  };

  const post = (type: string, body: unknown) =>
    request(server())
      .post('/api/csp-reports')
      .set('Content-Type', type)
      .send(JSON.stringify(body));

  /** Las líneas csp.violation que dejó la petición en el log. */
  async function violationsLogged(send: () => Promise<unknown>) {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await send();
      return warn.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('csp.violation'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } finally {
      warn.mockRestore();
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('Reporting API: 204 sin sesión y en el log solo el origen de lo bloqueado y la ruta', async () => {
    const lines = await violationsLogged(async () => {
      const res = await post(REPORTING_TYPE, reporting).expect(204);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
    expect(lines).toEqual([
      {
        event: 'csp.violation',
        directive: 'script-src-elem',
        blocked: 'https://evil.example',
        source: 'none',
        page: '/people/students',
        sink: '',
        disposition: 'enforce',
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/secreto|Laura/);
  });

  it('report-uri: el formato antiguo también (Trusted Types)', async () => {
    const lines = await violationsLogged(() =>
      post(LEGACY_REPORT_TYPE, legacy).expect(204),
    );
    expect(lines).toEqual([
      expect.objectContaining({
        directive: 'require-trusted-types-for',
        blocked: 'trusted-types-sink',
        page: '/login',
        sink: 'Element innerHTML',
      }),
    ]);
  });

  it('otro tipo de contenido: 415 sin registrar nada', async () => {
    const lines = await violationsLogged(async () => {
      await post('application/json', reporting).expect(415);
      await post('text/plain', reporting).expect(415);
    });
    expect(lines).toEqual([]);
  });

  it('cuerpo de más de 64 KB: 413; JSON inválido: 400', async () => {
    const big = [{ ...reporting[0], body: { sample: 'x'.repeat(66_000) } }];
    await post(REPORTING_TYPE, big).expect(413);
    await request(server())
      .post('/api/csp-reports')
      .set('Content-Type', REPORTING_TYPE)
      .send('{no es json')
      .expect(400);
  });

  it('acepta cualquier Origin (exenta del chequeo CSRF); las demás rutas no', async () => {
    await post(REPORTING_TYPE, reporting)
      .set('Origin', 'https://evil.example')
      .expect(204);
    await post(LEGACY_REPORT_TYPE, legacy).set('Origin', 'null').expect(204);
    await request(server())
      .post('/api/auth/logout')
      .set('Origin', 'https://evil.example')
      .expect(403);
  });

  it(`más de ${CSP_REPORT_THROTTLE.default.limit} por minuto desde la misma IP: 429`, async () => {
    process.env.THROTTLE_DISABLED = 'false';
    try {
      const statuses: number[] = [];
      for (let i = 0; i <= CSP_REPORT_THROTTLE.default.limit; i++) {
        statuses.push((await post(REPORTING_TYPE, [])).status);
      }
      expect(statuses.slice(0, -1).every((s) => s === 204)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      process.env.THROTTLE_DISABLED = 'true';
    }
  });
});
