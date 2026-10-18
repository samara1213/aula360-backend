import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as Handlebars from 'handlebars';
import { TEMPLATE_MAX_BYTES } from '../../storage/storage.constants';

/** Datos que recibe toda plantilla de boletín (contrato v1). */
export interface ReportCardTemplateData {
  institution: { name: string; nit: string; logoDataUri: string | null };
  campus: { name: string } | null;
  academicYear: { year: number };
  period: { name: string; startDate: string; endDate: string };
  course: { name: string; grade: string };
  student: {
    firstName: string;
    lastName: string;
    documentType: string;
    documentNumber: string;
  };
  subjects: {
    name: string;
    teacher: string | null;
    final: number | null;
    accumulated: number;
    pending: boolean;
    level: string | null;
    passed: boolean | null;
  }[];
  average: number | null;
  averageLevel: string | null;
  averagePartial: boolean;
  scale: { min: number; max: number; passingScore: number };
  levels: { name: string; minScore: number; maxScore: number }[];
  generatedAt: string;
}

const HELPERS = ['score', 'date', 'eq', 'levelClass'] as const;

/**
 * Handlebars aislado (no comparte helpers ni parciales con nadie) y solo con
 * estos helpers. Las plantillas las sube el SUPER_ADMIN, pero igual se tratan
 * como no confiables y se validan sobre su árbol (no con expresiones
 * regulares, que se saltan con {{~{ }}}; hallazgo M1 de la fase 10a):
 * - todo dato sale escapado: sin {{{ }}} ni {{& }};
 * - sin parciales, decoradores ni helpers fuera de la lista (sin log, que
 *   escribiría datos de menores en el log, ni lookup);
 * - sin @root ni ../ y con bloques poco anidados: el costo del render crece
 *   con los datos, no de forma exponencial (hallazgo M2);
 * - sin URLs absolutas ni pistas de conexión (dns-prefetch, preconnect...):
 *   Chromium además no tiene red (hallazgo M4).
 * Handlebars >= 4.6 bloquea el acceso al prototipo por defecto.
 */
const engine = Handlebars.create();
engine.unregisterHelper('log');
engine.unregisterHelper('lookup');
engine.registerHelper('score', (value: unknown) =>
  typeof value === 'number' ? value.toFixed(2).replace('.', ',') : '—',
);
engine.registerHelper('date', (value: unknown) => {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
});
engine.registerHelper('eq', (a: unknown, b: unknown) => a === b);
engine.registerHelper('levelClass', (value: unknown) =>
  typeof value === 'string'
    ? value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
    : 'sin-nivel',
);

/** Helpers propios y bloques integrados permitidos. */
const ALLOWED_HELPERS = new Set([...HELPERS, 'if', 'unless', 'each', 'with']);
/** Variables @ permitidas (las de each). */
const ALLOWED_DATA = new Set(['index', 'first', 'last', 'key']);
const MAX_BLOCK_DEPTH = 3;
const MAX_EACH_DEPTH = 2;
/** HTML máximo que puede producir una plantilla (antes de Chromium). */
export const MAX_RENDERED_BYTES = 2 * 1024 * 1024;

/** Nada que haga a Chromium salir a la red (además, no tiene red). */
const NETWORK_HINTS: [RegExp, string][] = [
  [
    /\b(?:https?|ftp|file|wss?|blob|filesystem):/i,
    'no se permiten URLs absolutas (use data: para imágenes)',
  ],
  [
    /(?:src|href|srcset|action|poster|data|xlink:href)\s*=\s*["']?\s*\/\//i,
    'no se permiten URLs absolutas (//)',
  ],
  [/url\(\s*["']?\s*\/\//i, 'no se permiten URLs absolutas en CSS (//)'],
  [/@import/i, 'no se permite @import'],
  [
    /\brel\s*=\s*["']?[^"'>]*\b(?:dns-prefetch|preconnect|prefetch|preload|prerender|modulepreload)\b/i,
    'no se permiten pistas de conexión (dns-prefetch, preconnect...)',
  ],
];

type HbsNode = hbs.AST.Node & Record<string, unknown>;

/** 400 con el primer problema del árbol de la plantilla. */
function validateAst(program: hbs.AST.Program): void {
  const fail = (message: string): never => {
    throw new BadRequestException(`Plantilla inválida: ${message}`);
  };
  const checkPath = (node: unknown) => {
    const path = node as hbs.AST.PathExpression;
    if (path?.type !== 'PathExpression') return;
    if (path.depth > 0 || path.original.includes('../')) {
      fail('no se permite ../ (subir de contexto)');
    }
    if (path.data && !ALLOWED_DATA.has(path.parts[0] ?? path.original)) {
      fail(`no se permite @${path.parts[0] ?? path.original}`);
    }
  };
  const checkCall = (
    node:
      | hbs.AST.MustacheStatement
      | hbs.AST.BlockStatement
      | hbs.AST.SubExpression,
    isBlock: boolean,
  ) => {
    const path = node.path as hbs.AST.PathExpression;
    const isCall = isBlock || node.params.length > 0 || !!node.hash;
    if (isCall || ALLOWED_HELPERS.has(path.original)) {
      if (
        path.type !== 'PathExpression' ||
        !ALLOWED_HELPERS.has(path.original)
      ) {
        fail(`helper no permitido: ${path.original}`);
      }
    } else if (
      ['log', 'lookup', 'helperMissing', 'blockHelperMissing'].includes(
        path.original,
      )
    ) {
      fail(`helper no permitido: ${path.original}`);
    }
    checkPath(path);
    node.params.forEach((p) => visit(p as HbsNode, 0, 0));
    node.hash?.pairs.forEach((pair) => visit(pair.value as HbsNode, 0, 0));
  };
  const visit = (node: HbsNode, blocks: number, eaches: number): void => {
    switch (node.type) {
      case 'Program':
        (node as unknown as hbs.AST.Program).body.forEach((n) =>
          visit(n as HbsNode, blocks, eaches),
        );
        return;
      case 'ContentStatement':
        for (const [pattern, message] of NETWORK_HINTS) {
          if (
            pattern.test((node as unknown as hbs.AST.ContentStatement).value)
          ) {
            fail(message);
          }
        }
        return;
      case 'CommentStatement':
        return;
      case 'MustacheStatement': {
        const mustache = node as unknown as hbs.AST.MustacheStatement;
        if (!mustache.escaped) {
          fail('todos los datos deben salir escapados (sin {{{ }}} ni {{& }})');
        }
        checkCall(mustache, false);
        return;
      }
      case 'SubExpression':
        checkCall(node as unknown as hbs.AST.SubExpression, false);
        return;
      case 'BlockStatement': {
        const block = node as unknown as hbs.AST.BlockStatement;
        checkCall(block, true);
        const depth = blocks + 1;
        const eachDepth = eaches + (block.path.original === 'each' ? 1 : 0);
        if (depth > MAX_BLOCK_DEPTH) {
          fail(`máximo ${MAX_BLOCK_DEPTH} bloques anidados`);
        }
        if (eachDepth > MAX_EACH_DEPTH) {
          fail(`máximo ${MAX_EACH_DEPTH} {{#each}} anidados`);
        }
        if (block.program)
          visit(block.program as unknown as HbsNode, depth, eachDepth);
        if (block.inverse)
          visit(block.inverse as unknown as HbsNode, depth, eachDepth);
        return;
      }
      case 'PathExpression':
        checkPath(node);
        return;
      case 'StringLiteral':
      case 'NumberLiteral':
      case 'BooleanLiteral':
      case 'UndefinedLiteral':
      case 'NullLiteral':
        return;
      default:
        // Parciales, bloques de parcial, decoradores y lo desconocido.
        fail(`no se permite ${String(node.type)}`);
    }
  };
  visit(program as unknown as HbsNode, 0, 0);
}

export type CompiledTemplate = (data: ReportCardTemplateData) => string;

/** Valida y compila; 400 con el motivo si la plantilla no sirve. */
export function compileTemplate(source: string): CompiledTemplate {
  if (Buffer.byteLength(source, 'utf8') > TEMPLATE_MAX_BYTES) {
    throw new BadRequestException(
      `La plantilla supera ${TEMPLATE_MAX_BYTES / 1024} KB`,
    );
  }
  let program: hbs.AST.Program;
  try {
    program = engine.parse(source);
  } catch (error) {
    throw new BadRequestException(
      `Plantilla inválida: ${(error as Error).message.split('\n')[0]}`,
    );
  }
  validateAst(program);
  let template: HandlebarsTemplateDelegate<ReportCardTemplateData>;
  try {
    template = engine.compile<ReportCardTemplateData>(source, {
      strict: false,
      noEscape: false,
      knownHelpersOnly: true,
      knownHelpers: {
        ...Object.fromEntries(HELPERS.map((h) => [h, true])),
        log: false,
        lookup: false,
      },
    });
    // Compila de verdad (Handlebars compila al primer uso) con datos de ejemplo.
    template(SAMPLE_DATA);
  } catch (error) {
    throw new BadRequestException(
      `Plantilla inválida: ${(error as Error).message.split('\n')[0]}`,
    );
  }
  return (data) => {
    const html = template(data, {
      allowProtoPropertiesByDefault: false,
      allowProtoMethodsByDefault: false,
    });
    if (Buffer.byteLength(html, 'utf8') > MAX_RENDERED_BYTES) {
      throw new UnprocessableEntityException(
        'La plantilla generó un documento demasiado grande',
      );
    }
    return html;
  };
}

/** Datos ficticios para validar y para la vista previa (nunca datos reales). */
export const SAMPLE_DATA: ReportCardTemplateData = {
  institution: {
    name: 'Institución Educativa Ejemplo',
    nit: '900.000.000-0',
    logoDataUri: null,
  },
  campus: { name: 'Sede Principal' },
  academicYear: { year: 2026 },
  period: {
    name: 'Primer periodo',
    startDate: '2026-02-01',
    endDate: '2026-04-10',
  },
  course: { name: '601', grade: 'Sexto' },
  student: {
    firstName: 'Ana María',
    lastName: 'Pérez Gómez',
    documentType: 'TI',
    documentNumber: '1000000000',
  },
  subjects: [
    {
      name: 'Matemáticas',
      teacher: 'Carlos Rodríguez',
      final: 4.25,
      accumulated: 4.25,
      pending: false,
      level: 'Alto',
      passed: true,
    },
    {
      name: 'Lengua Castellana',
      teacher: 'Luisa Martínez',
      final: 4.8,
      accumulated: 4.8,
      pending: false,
      level: 'Superior',
      passed: true,
    },
    {
      name: 'Ciencias Naturales',
      teacher: 'Jorge Díaz',
      final: 2.7,
      accumulated: 2.7,
      pending: false,
      level: 'Bajo',
      passed: false,
    },
    {
      name: 'Inglés',
      teacher: null,
      final: null,
      accumulated: 2.1,
      pending: true,
      level: null,
      passed: null,
    },
  ],
  average: 3.92,
  averageLevel: 'Básico',
  averagePartial: true,
  scale: { min: 1, max: 5, passingScore: 3 },
  levels: [
    { name: 'Bajo', minScore: 1, maxScore: 2.99 },
    { name: 'Básico', minScore: 3, maxScore: 3.99 },
    { name: 'Alto', minScore: 4, maxScore: 4.59 },
    { name: 'Superior', minScore: 4.6, maxScore: 5 },
  ],
  generatedAt: '2026-04-15',
};
