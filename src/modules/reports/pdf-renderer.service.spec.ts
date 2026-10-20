import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'http';
import { AddressInfo, Socket } from 'net';
import {
  PdfRendererService,
  RENDER_CSP,
  withContentSecurityPolicy,
} from './pdf-renderer.service';

/** Con Chromium real: es la barrera frente a plantillas con HTML ajeno. */
describe('PdfRendererService (Chromium real)', () => {
  jest.setTimeout(60_000);

  let renderer: PdfRendererService;
  let server: Server;
  let base: string;
  const hits: string[] = [];
  const connections: Socket[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('ok');
    });
    // Cuenta conexiones TCP aunque no lleguen a ser peticiones (preconnect).
    server.on('connection', (socket: Socket) => connections.push(socket));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    renderer = new PdfRendererService({
      get: () => false,
    } as unknown as ConfigService);
  });

  afterAll(async () => {
    await renderer.onModuleDestroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it('la CSP del servidor va antes que todo el HTML de la plantilla (B1 de la fase 11e)', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}">`;
    expect(withContentSecurityPolicy('<!DOCTYPE html><html><head>')).toBe(
      `<!DOCTYPE html>${meta}<html><head>`,
    );
    // Un comentario o un <head> de la plantilla no quedan antes de la política.
    expect(withContentSecurityPolicy('<!-- <head> --><p>x</p>')).toBe(
      `${meta}<!-- <head> --><p>x</p>`,
    );
  });

  it('genera un PDF', async () => {
    const pdf = await renderer.render('<h1>Boletín ñ</h1>');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('no hace peticiones de red ni ejecuta JavaScript', async () => {
    const html = `
      <link rel="stylesheet" href="${base}/css">
      <img src="${base}/img">
      <iframe src="${base}/frame"></iframe>
      <iframe src="file:///etc/hosts"></iframe>
      <style>body { background: url("${base}/bg"); }</style>
      <script>fetch("${base}/script"); document.write("<img src='${base}/js'>")</script>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <p>contenido</p>`;
    const pdf = await renderer.render(html);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits).toEqual([]);
  });

  it('ni preconnect ni dns-prefetch abren conexiones (M4)', async () => {
    await renderer.render(
      `<link rel="preconnect" href="${base}"><link rel="dns-prefetch" href="${base}"><a href="${base}/a">x</a>`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connections).toHaveLength(0);
  });

  it('como máximo 20 páginas', async () => {
    const pdf = await renderer.render(
      '<div style="height: 100000px">muy largo</div>',
    );
    const pages = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeLessThanOrEqual(20);
    expect(pages.length).toBeGreaterThan(1);
  });

  it('una redirección con meta refresh no sale a la red', async () => {
    await renderer.render(
      `<meta http-equiv="refresh" content="0;url=${base}/refresh"><p>x</p>`,
    );
    expect(hits).toEqual([]);
  });

  it('varios a la vez (con el límite de páginas) y sigue funcionando', async () => {
    const pdfs = await Promise.all(
      [1, 2, 3, 4].map((n) => renderer.render(`<p>${n}</p>`)),
    );
    expect(pdfs.every((p) => p.subarray(0, 5).toString() === '%PDF-')).toBe(
      true,
    );
  });

  it('si Chromium falla: 503 genérico', async () => {
    const broken = new PdfRendererService({
      get: () => false,
    } as unknown as ConfigService);
    jest
      .spyOn(
        broken as unknown as { getBrowser: () => Promise<never> },
        'getBrowser',
      )
      .mockRejectedValue(new Error('sin chromium'));
    await expect(broken.render('<p>x</p>')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  describe('recuperación sin reiniciar el backend', () => {
    type Internals = {
      stepTimeoutMs: number;
      maxRendersPerBrowser: number;
      browser: Promise<{
        process: () => { pid?: number; kill: (s: string) => void } | null;
      }> | null;
      getBrowser: () => Promise<unknown>;
    };
    const fresh = () => {
      const r = new PdfRendererService({
        get: () => false,
      } as unknown as ConfigService);
      return { renderer: r, internals: r as unknown as Internals };
    };

    it('Chromium colgado: cada render falla a tiempo, se mata el proceso y no se traban los cupos', async () => {
      const { renderer: hung, internals } = fresh();
      internals.stepTimeoutMs = 300;
      const kill = jest.fn();
      const fake = {
        createBrowserContext: () => new Promise(() => undefined),
        process: () => ({ kill }),
      };
      const spy = jest.spyOn(internals, 'getBrowser').mockImplementation(() => {
        internals.browser = Promise.resolve(fake);
        return internals.browser;
      });
      const started = Date.now();
      // Más renders que cupos (2): ninguno queda esperando para siempre.
      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => hung.render('<p>x</p>')),
      );
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      // Chromium vuelve a responder: el mismo servicio genera de nuevo.
      spy.mockRestore();
      internals.browser = null;
      internals.stepTimeoutMs = 15_000;
      const pdf = await hung.render('<p>de nuevo</p>');
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      await hung.onModuleDestroy();
    });

    it('si el proceso de Chromium muere, el siguiente render lanza otro', async () => {
      const { renderer: r, internals } = fresh();
      await r.render('<p>1</p>');
      const first = await internals.browser!;
      first.process()?.kill('SIGKILL');
      // El que coincide con la caída puede fallar; el siguiente debe funcionar.
      await r.render('<p>2</p>').catch(() => undefined);
      const pdf = await r.render('<p>3</p>');
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect((await internals.browser!).process()?.pid).not.toBe(
        first.process()?.pid,
      );
      await r.onModuleDestroy();
    });

    it('se recicla cada cierto número de renders', async () => {
      const { renderer: r, internals } = fresh();
      internals.maxRendersPerBrowser = 2;
      await r.render('<p>1</p>');
      const pid = (await internals.browser!).process()?.pid;
      await r.render('<p>2</p>');
      await r.render('<p>3</p>');
      expect((await internals.browser!).process()?.pid).not.toBe(pid);
      await r.onModuleDestroy();
    });
  });
});
