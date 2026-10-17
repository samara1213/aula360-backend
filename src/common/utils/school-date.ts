/** Zona horaria de las instituciones (Aula360 opera en Colombia). */
export const SCHOOL_TIME_ZONE = 'America/Bogota';

/**
 * Fecha de hoy ('YYYY-MM-DD') en la zona de las instituciones. Las fechas de
 * los periodos no tienen hora: compararlas con la fecha UTC del servidor
 * cerraría o abriría un periodo a las 7 p. m. de Colombia.
 */
export function schoolToday(now: Date = new Date()): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHOOL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
