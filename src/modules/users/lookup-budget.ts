import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/** Búsquedas de cuentas por documento de cada institución en 24 horas. */
export const LOOKUPS_PER_DAY = 100;

const DAY_MS = 86_400_000;
/** Con más instituciones en el mapa, se barren las que no buscan hace un día. */
const SWEEP_ABOVE = 1_000;

/**
 * Presupuesto diario de búsquedas por documento de cada institución (M1 de la
 * segunda revisión de la entrega A): lo gastan «Buscar su cuenta» y cada
 * intento de invitar, también los que fallan, porque ambos dicen si un
 * documento tiene cuenta. Así no se recorren documentos para saber quién está
 * en Aula360 (el tope de invitaciones solo cuenta las creadas).
 *
 * En memoria (opción 1 del usuario): se reinicia con el proceso y cada
 * instancia cuenta aparte. Pasa a Redis con la entrega B.
 */
@Injectable()
export class LookupBudget {
  /** Público para que las pruebas lo bajen. */
  limit = LOOKUPS_PER_DAY;
  private readonly used = new Map<string, number[]>();

  /** Gasta una búsqueda; 429 si la institución ya gastó las de las últimas 24 horas. */
  consume(institutionId: string, now = Date.now()): void {
    if (this.used.size > SWEEP_ABOVE) this.sweep(now);
    const recent = (this.used.get(institutionId) ?? []).filter(
      (at) => at > now - DAY_MS,
    );
    if (recent.length >= this.limit) {
      this.used.set(institutionId, recent);
      throw new HttpException(
        `La institución ya hizo ${this.limit} búsquedas de cuentas en las últimas 24 horas: inténtelo más tarde`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.used.set(institutionId, recent);
  }

  private sweep(now: number): void {
    for (const [institutionId, times] of this.used) {
      if (!times.some((at) => at > now - DAY_MS)) {
        this.used.delete(institutionId);
      }
    }
  }
}
