import { Logger } from '@nestjs/common';
import {
  CspReportsService,
  LEGACY_REPORT_TYPE,
  MAX_LOG_LINES_PER_MINUTE,
  MAX_REPORTS_PER_REQUEST,
  REPORTING_TYPE,
} from './csp-reports.service';

/** Las líneas que deja en el log `fn` (en JSON). */
function logged(
  fn: (service: CspReportsService) => void,
  service = new CspReportsService(),
): Record<string, unknown>[] {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  try {
    fn(service);
    return warn.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
  } finally {
    warn.mockRestore();
  }
}

const violation = (body: Record<string, unknown>) => ({
  type: 'csp-violation',
  url: 'https://app.aula360.co/people/students?search=Laura',
  body,
});

describe('CspReportsService', () => {
  it('Reporting API: registra solo campos acotados, sin la consulta ni la ruta de lo bloqueado', () => {
    const lines = logged((s) =>
      s.record(REPORTING_TYPE, [
        violation({
          effectiveDirective: 'img-src',
          blockedURL: 'https://evil.example/pixel.gif?token=secreto',
          sourceFile: 'https://app.aula360.co/assets/index-abc.js',
          documentURL:
            'https://app.aula360.co/people/students/1?doc=1012345678#x',
          sample: 'no debería salir',
          disposition: 'enforce',
        }),
      ]),
    );
    expect(lines).toEqual([
      {
        event: 'csp.violation',
        directive: 'img-src',
        blocked: 'https://evil.example',
        source: 'https://app.aula360.co',
        page: '/people/students/1',
        sink: '',
        disposition: 'enforce',
      },
    ]);
  });

  it('B2: en Trusted Types solo el punto bloqueado, nunca el HTML de la página', () => {
    const lines = logged((s) =>
      s.record(LEGACY_REPORT_TYPE, {
        'csp-report': {
          'violated-directive': 'require-trusted-types-for',
          'blocked-uri': 'trusted-types-sink',
          'source-file': 'chrome-extension://abcdef/content.js',
          'document-uri': 'https://app.aula360.co/people/students/1',
          'script-sample': 'Element innerHTML|<td>Laura Gómez</td>',
        },
      }),
    );
    expect(lines).toEqual([
      {
        event: 'csp.violation',
        directive: 'require-trusted-types-for',
        blocked: 'trusted-types-sink',
        source: 'chrome-extension:',
        page: '/people/students/1',
        sink: 'Element innerHTML',
        disposition: 'other',
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Laura/);
  });

  it('B1: caracteres invisibles o de dirección del texto no llegan al log', () => {
    // Separador de línea, inversión del texto, NEL y espacio de ancho cero.
    const invisible = [0x2028, 0x202e, 0x85, 0x200b].map((code) =>
      String.fromCharCode(code),
    );
    const tricky = [
      ...invisible.map((char) => `Element${char}innerHTML|x`),
      '{"event":"falso"}|x',
    ];
    const lines = logged((s) =>
      s.record(
        REPORTING_TYPE,
        tricky.map((sample) =>
          violation({ effectiveDirective: 'trusted-types', sample }),
        ),
      ),
    );
    expect(lines.map((l) => l.sink)).toEqual(tricky.map(() => 'other'));
    const json = JSON.stringify(lines);
    for (const char of invisible) expect(json).not.toContain(char);
  });

  it('valores inesperados: directiva «other», origen de data: y página desconocida', () => {
    const [line] = logged((s) =>
      s.record(REPORTING_TYPE, [
        violation({
          effectiveDirective: 'img-src"}\n{"audit":"falso"',
          blockedURL: 'data:image/png;base64,AAAA',
          documentURL: 'no es una URL',
        }),
      ]),
    );
    expect(line).toMatchObject({
      directive: 'other',
      blocked: 'data:',
      source: 'none',
      page: 'unknown',
      sink: '',
    });
  });

  it(`ignora lo que no tiene la forma esperada y registra ${MAX_REPORTS_PER_REQUEST} por petición como máximo`, () => {
    const many = Array.from({ length: MAX_REPORTS_PER_REQUEST + 5 }, () =>
      violation({ effectiveDirective: 'script-src' }),
    );
    expect(logged((s) => s.record(REPORTING_TYPE, many))).toHaveLength(
      MAX_REPORTS_PER_REQUEST,
    );
    expect(
      logged((s) =>
        s.record(REPORTING_TYPE, [
          { type: 'deprecation', body: {} },
          'x',
          null,
        ]),
      ),
    ).toEqual([]);
    expect(logged((s) => s.record(REPORTING_TYPE, { no: 'array' }))).toEqual(
      [],
    );
    expect(logged((s) => s.record(LEGACY_REPORT_TYPE, ['x']))).toEqual([]);
  });

  it(`B3: ${MAX_LOG_LINES_PER_MINUTE} líneas por minuto en todo el proceso; lo demás, una línea con el conteo`, () => {
    const service = new CspReportsService();
    const batch = Array.from({ length: MAX_REPORTS_PER_REQUEST }, () =>
      violation({ effectiveDirective: 'script-src' }),
    );
    const requests = MAX_LOG_LINES_PER_MINUTE / MAX_REPORTS_PER_REQUEST + 3;
    const first = logged((s) => {
      for (let i = 0; i < requests; i++)
        s.record(REPORTING_TYPE, batch, 1_000 + i);
    }, service);
    expect(first.filter((l) => l.event === 'csp.violation')).toHaveLength(
      MAX_LOG_LINES_PER_MINUTE,
    );
    expect(
      first.filter((l) => l.event === 'csp.violation.dropped'),
    ).toHaveLength(1);

    // El minuto siguiente: el conteo de lo descartado y vuelve a registrar.
    const next = logged(
      (s) => s.record(REPORTING_TYPE, batch.slice(0, 1), 1_000 + 60_000),
      service,
    );
    expect(next).toEqual([
      expect.objectContaining({ event: 'csp.violation.dropped', count: 60 }),
      expect.objectContaining({ event: 'csp.violation' }),
    ]);
  });
});
