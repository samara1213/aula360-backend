import { BadRequestException } from '@nestjs/common';
import { DEFAULT_REPORT_CARD_TEMPLATE } from './default-report-card.template';
import { compileTemplate, SAMPLE_DATA } from './report-template.engine';

describe('report-template.engine', () => {
  it('la plantilla del sistema compila y usa los datos', () => {
    const html = compileTemplate(DEFAULT_REPORT_CARD_TEMPLATE)(SAMPLE_DATA);
    expect(html).toContain('Institución Educativa Ejemplo');
    expect(html).toContain('4,25');
    expect(html).toContain('class="level superior"');
    expect(html).toContain('15/04/2026');
    // Nombres y luego apellidos, como en el resto de la app.
    expect(html).toContain('<strong>Ana María Pérez Gómez</strong>');
  });

  it('los datos siempre salen escapados (un nombre no inyecta HTML)', () => {
    const render = compileTemplate('<p>{{student.firstName}}</p>');
    const html = render({
      ...SAMPLE_DATA,
      student: {
        ...SAMPLE_DATA.student,
        firstName: '<b>Ana</b><img src=x>',
      },
    });
    expect(html).toBe('<p>&lt;b&gt;Ana&lt;/b&gt;&lt;img src&#x3D;x&gt;</p>');
  });

  it.each([
    ['triple llave', '<p>{{{student.firstName}}}</p>', /escapados/],
    [
      'triple llave con ~ (M1)',
      '<p>{{~{student.firstName}~}}</p>',
      /escapados/,
    ],
    ['ampersand', '<p>{{& student.firstName}}</p>', /escapados/],
    ['parcial', '{{> otro}}', /PartialStatement/],
    [
      'parcial en bloque (M1)',
      '{{#> otro}}x{{/otro}}',
      /PartialBlockStatement/,
    ],
    ['decorador', '{{* deco}}', /Decorator/],
    ['log (M3)', '{{log student.documentNumber}}', /helper no permitido: log/],
    ['log sin argumentos', '{{log}}', /helper no permitido: log/],
    ['lookup', '{{lookup student "firstName"}}', /helper no permitido: lookup/],
    [
      'helper desconocido',
      '{{lookupProperty this "x"}}',
      /helper no permitido/,
    ],
    [
      'bloque desconocido',
      '{{#blockHelperMissing x}}y{{/blockHelperMissing}}',
      /helper no permitido/,
    ],
    [
      '@root (M2)',
      '{{#each subjects}}{{#each @root.subjects}}x{{/each}}{{/each}}',
      /@root/,
    ],
    [
      '../ (M2)',
      '{{#each subjects}}{{../student.firstName}}{{/each}}',
      /\.\.\//,
    ],
    [
      '3 each anidados (M2)',
      '{{#each subjects}}{{#each levels}}{{#each levels}}x{{/each}}{{/each}}{{/each}}',
      /each/,
    ],
    [
      '4 bloques anidados',
      '{{#if a}}{{#if b}}{{#if c}}{{#if d}}x{{/if}}{{/if}}{{/if}}{{/if}}',
      /bloques anidados/,
    ],
    ['URL absoluta (M4)', '<img src="https://x.tld/a.png">', /URLs absolutas/],
    ['URL sin esquema (M4)', '<img src="//x.tld/a.png">', /URLs absolutas/],
    [
      'dns-prefetch (M4)',
      '<link rel="dns-prefetch" href="{{student.documentNumber}}.x.tld">',
      /pistas de conexión/,
    ],
    [
      'preconnect (M4)',
      '<link rel=preconnect href="{{x}}">',
      /pistas de conexión/,
    ],
    ['@import', '<style>@import "x.css";</style>', /@import/],
    [
      'URL partida con un comentario de Handlebars (B1 de la fase 11e)',
      '<img src="fi{{!x}}le:///etc/passwd">',
      /URLs absolutas/,
    ],
    [
      'pista de conexión partida con comentarios (B1)',
      '<link rel="pre{{!}}connect" href="/{{!}}/x.tld">',
      /pistas de conexión|URLs absolutas/,
    ],
    [
      'esquema escondido con entidades HTML (B1)',
      '<img src="file&colon;///etc/passwd">',
      /URLs absolutas/,
    ],
    [
      'barras escondidas con entidades numéricas (B1)',
      '<img src="&#47;&#x2f;x.tld/a.png">',
      /URLs absolutas/,
    ],
    ['error de sintaxis', '{{#each subjects}}<p>', /inválida/],
  ])('400: %s', (_c, source, message) => {
    expect(() => compileTemplate(source)).toThrow(BadRequestException);
    expect(() => compileTemplate(source)).toThrow(message);
  });

  it('se permiten @index, @first, @last, data: y sub-expresiones con helpers', () => {
    const render = compileTemplate(
      '{{#each subjects}}{{@index}}{{#if @first}}F{{/if}}{{#unless @last}},{{/unless}}{{/each}}<img src="data:image/png;base64,AA==">{{#if (eq course.name "601")}}ok{{/if}}',
    );
    expect(render(SAMPLE_DATA)).toBe(
      '0F,1,2,3<img src="data:image/png;base64,AA==">ok',
    );
  });

  it('422 si el HTML generado pasa de 2 MB', () => {
    const render = compileTemplate('{{#each subjects}}{{name}}{{/each}}');
    const huge = {
      ...SAMPLE_DATA,
      subjects: [
        { ...SAMPLE_DATA.subjects[0], name: 'x'.repeat(2 * 1024 * 1024 + 1) },
      ],
    };
    expect(() => render(huge)).toThrow(/demasiado grande/);
  });

  it('400: más de 256 KB', () => {
    expect(() => compileTemplate('a'.repeat(256 * 1024 + 1))).toThrow(
      /supera 256 KB/,
    );
  });

  it('sin acceso al prototipo de los datos', () => {
    const render = compileTemplate('[{{student.constructor}}][{{__proto__}}]');
    expect(render(SAMPLE_DATA)).toBe('[][]');
  });

  it('helpers: score, date, eq y levelClass', () => {
    const render = compileTemplate(
      '{{score average}}|{{score null}}|{{date period.startDate}}|{{#if (eq course.name "601")}}sí{{/if}}|{{levelClass averageLevel}}',
    );
    expect(render(SAMPLE_DATA)).toBe('3,92|—|01/02/2026|sí|basico');
  });
});
