import { Injectable, Logger } from '@nestjs/common';

/** Tipos de contenido que envían los navegadores (Reporting API y report-uri). */
export const REPORTING_TYPE = 'application/reports+json';
export const LEGACY_REPORT_TYPE = 'application/csp-report';
/**
 * Cuerpo máximo de un envío de informes. Cada informe de la Reporting API
 * trae la política completa (cerca de 1 KB) y Chrome manda su cola en un solo
 * envío: con menos, un lote se perdería entero con 413 (B5 de la revisión).
 */
export const CSP_REPORT_MAX_BYTES = 64 * 1024;
/** Informes que se registran por petición (los demás se ignoran). */
export const MAX_REPORTS_PER_REQUEST = 20;
/**
 * Líneas por minuto en todo el proceso: cualquiera puede enviar informes, así
 * que muchas IP no llenan el log (B3). Lo que pase se cuenta en una línea.
 */
export const MAX_LOG_LINES_PER_MINUTE = 200;

const WINDOW_MS = 60_000;
const PATH_LENGTH = 200;
/** Valores como `inline`, `eval` o `trusted-types-sink` (no son URL). */
const KEYWORD = /^[a-z][a-z-]{0,39}$/;
/** Directivas de Trusted Types: su muestra empieza por el punto bloqueado. */
const TRUSTED_TYPES_DIRECTIVES = new Set([
  'require-trusted-types-for',
  'trusted-types',
]);
/** El punto bloqueado de Trusted Types, p. ej. «Element innerHTML» o «HTMLScriptElement src». */
const SINK = /^[A-Za-z][A-Za-z.]{0,39}( [A-Za-z][A-Za-z.]{0,39})?$/;

/**
 * Lo que se registra de una violación: nada de la consulta ni de la ruta de lo
 * bloqueado, ni del contenido de la página.
 */
export interface CspViolation {
  directive: string;
  blocked: string;
  /** Esquema u origen del script que la causó (p. ej. `chrome-extension:`; I2). */
  source: string;
  page: string;
  /** Solo en Trusted Types: el punto bloqueado, nunca el HTML (B2). */
  sink: string;
  disposition: string;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Directiva, `enforce` o `report`: solo letras y guiones; si no, `other`. */
function keyword(value: unknown): string {
  const v = text(value).trim().toLowerCase();
  return KEYWORD.test(v) ? v : 'other';
}

/** De una URL solo el origen (o el esquema): la ruta y la consulta pueden traer tokens. */
function originOf(value: unknown): string {
  const v = text(value).trim();
  if (!v) return 'none';
  try {
    const url = new URL(v);
    return url.origin === 'null'
      ? `${url.protocol.replace(':', '')}:`
      : url.origin;
  } catch {
    return keyword(v);
  }
}

/** De la página solo la ruta, sin consulta ni fragmento (con percent-encoding). */
function pagePath(value: unknown): string {
  try {
    return new URL(text(value)).pathname.slice(0, PATH_LENGTH);
  } catch {
    return 'unknown';
  }
}

/**
 * En Trusted Types el navegador manda «<punto>|<comienzo del valor>», y el
 * valor es HTML de la página (nombres de estudiantes, si lo inserta una
 * extensión): se queda solo el punto, y solo si tiene la forma esperada, en
 * ASCII (sin caracteres invisibles ni de dirección del texto; B1 y B2). Las
 * demás directivas no traen muestra (la CSP no tiene 'report-sample').
 */
function sinkOf(directive: string, sample: unknown): string {
  if (!TRUSTED_TYPES_DIRECTIVES.has(directive)) return '';
  const sink = text(sample).split('|', 1)[0].trim();
  return SINK.test(sink) ? sink : 'other';
}

/**
 * Violaciones de la CSP que informan los navegadores (POST /csp-reports).
 * Todo lo que llega es texto no confiable de quien sea: se reduce a unos
 * pocos campos acotados y solo va al log, nunca a la base. Son señales para
 * revisar (cualquiera puede enviarlas), no una auditoría: por eso `event`.
 */
@Injectable()
export class CspReportsService {
  private readonly logger = new Logger(CspReportsService.name);
  private windowStart = 0;
  private logged = 0;
  private dropped = 0;

  /** Registra los informes del cuerpo; lo que no tenga la forma esperada se ignora. */
  record(
    contentType: typeof REPORTING_TYPE | typeof LEGACY_REPORT_TYPE,
    body: unknown,
    now = Date.now(),
  ): number {
    const violations = (
      contentType === REPORTING_TYPE
        ? this.fromReportingApi(body)
        : this.fromLegacy(body)
    ).slice(0, MAX_REPORTS_PER_REQUEST);
    this.rollWindow(now);
    let written = 0;
    for (const violation of violations) {
      if (this.logged >= MAX_LOG_LINES_PER_MINUTE) {
        if (this.dropped === 0) {
          this.logger.warn(
            JSON.stringify({
              event: 'csp.violation.dropped',
              reason: `más de ${String(MAX_LOG_LINES_PER_MINUTE)} por minuto: se cuentan las de este minuto`,
            }),
          );
        }
        this.dropped += 1;
        continue;
      }
      this.logged += 1;
      written += 1;
      this.logger.warn(
        JSON.stringify({ event: 'csp.violation', ...violation }),
      );
    }
    return written;
  }

  /** Abre un minuto nuevo; si en el anterior se descartaron, una línea con cuántas. */
  private rollWindow(now: number): void {
    if (now - this.windowStart < WINDOW_MS) return;
    if (this.dropped > 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'csp.violation.dropped',
          count: this.dropped,
          since: new Date(this.windowStart).toISOString(),
        }),
      );
    }
    this.windowStart = now;
    this.logged = 0;
    this.dropped = 0;
  }

  /** Reporting API: `[{ type: 'csp-violation', body: { effectiveDirective, ... } }]`. */
  private fromReportingApi(body: unknown): CspViolation[] {
    if (!Array.isArray(body)) return [];
    return body
      .slice(0, MAX_REPORTS_PER_REQUEST)
      .filter(
        (r): r is Raw =>
          isObject(r) && r.type === 'csp-violation' && isObject(r.body),
      )
      .map(({ body: b }) => {
        const r = b as Raw;
        const directive = keyword(r.effectiveDirective);
        return {
          directive,
          blocked: originOf(r.blockedURL),
          source: originOf(r.sourceFile),
          page: pagePath(r.documentURL),
          sink: sinkOf(directive, r.sample),
          disposition: keyword(r.disposition),
        };
      });
  }

  /** report-uri: `{ "csp-report": { "effective-directive", ... } }`. */
  private fromLegacy(body: unknown): CspViolation[] {
    if (!isObject(body) || !isObject(body['csp-report'])) return [];
    const r = body['csp-report'];
    const directive = keyword(
      r['effective-directive'] ?? r['violated-directive'],
    );
    return [
      {
        directive,
        blocked: originOf(r['blocked-uri']),
        source: originOf(r['source-file']),
        page: pagePath(r['document-uri']),
        sink: sinkOf(directive, r['script-sample']),
        disposition: keyword(r.disposition),
      },
    ];
  }
}
