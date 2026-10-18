import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'http';
import { AddressInfo, Socket } from 'net';
import { PdfRendererService } from './pdf-renderer.service';

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
});
