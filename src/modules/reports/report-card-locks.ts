import { EntityManager } from 'typeorm';

const key = (courseId: string, periodId: string) =>
  `report-cards:${courseId}:${periodId}`;

/**
 * Bloqueo por (curso, periodo) entre guardar un boletín (exclusivo) y
 * cambiar lo que muestra (compartido): notas, porcentajes, materias del
 * curso y cambios de curso de la matrícula. Así un boletín nunca queda
 * vigente con datos que ya cambiaron (decisión B4 de la fase 9b: se marca
 * como desactualizado, no 409). La escala y los niveles se serializan con
 * la fila de la institución (el generador la lee FOR SHARE).
 */
export async function lockReportCards(
  manager: EntityManager,
  courseId: string,
  periodId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const fn =
    mode === 'shared'
      ? 'pg_advisory_xact_lock_shared'
      : 'pg_advisory_xact_lock';
  await manager.query(`SELECT ${fn}(hashtextextended($1, 0))`, [
    key(courseId, periodId),
  ]);
}

/**
 * Bloqueo compartido de los boletines de esos cursos en todos los periodos
 * de su año, en orden fijo (el generador solo toma uno: no hay ciclo).
 */
export async function lockCourseReportCards(
  manager: EntityManager,
  courseIds: string[],
): Promise<void> {
  const rows = await manager.query<{ courseId: string; periodId: string }[]>(
    `SELECT c.id AS "courseId", p.id AS "periodId"
       FROM courses c
       JOIN periods p ON p.academic_year_id = c.academic_year_id
      WHERE c.id = ANY($1::uuid[])`,
    [courseIds],
  );
  const keys = [...new Set(rows.map((r) => key(r.courseId, r.periodId)))];
  for (const k of keys.sort()) {
    await manager.query(
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
      [k],
    );
  }
}

/** Qué boletines vigentes marcar (se combinan con AND). */
export interface OutdatedFilter {
  courseId?: string;
  periodId?: string;
  studentIds?: string[];
  academicYearId?: string;
  /** Todos los de la institución en años lectivos activos. */
  institutionId?: string;
}

/**
 * Marca como desactualizados los boletines vigentes que cumplen el filtro,
 * dentro de la transacción que cambió los datos. Las filas se bloquean antes
 * en orden de id: dos marcas a la vez no forman un deadlock (hallazgo B2 de
 * la fase 10b). updated_at no cambia: es la fecha de la última generación.
 * Devuelve los ids marcados.
 */
export async function markReportCardsOutdated(
  manager: EntityManager,
  filter: OutdatedFilter,
): Promise<string[]> {
  if (filter.studentIds && !filter.studentIds.length) return [];
  const where: string[] = ['r.outdated_at IS NULL'];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (filter.courseId) add((n) => `r.course_id = ${n}`, filter.courseId);
  if (filter.periodId) add((n) => `r.period_id = ${n}`, filter.periodId);
  if (filter.studentIds) {
    add((n) => `r.student_id = ANY(${n}::uuid[])`, filter.studentIds);
  }
  if (filter.academicYearId) {
    add(
      (n) =>
        `r.period_id IN (SELECT id FROM periods WHERE academic_year_id = ${n})`,
      filter.academicYearId,
    );
  }
  if (filter.institutionId) {
    add(
      (n) => `r.course_id IN (
        SELECT c.id FROM courses c
          JOIN grades g ON g.id = c.grade_id
          JOIN academic_years y ON y.id = c.academic_year_id
         WHERE g.institution_id = ${n} AND y.is_active = true)`,
      filter.institutionId,
    );
  }
  if (where.length === 1) throw new Error('Filtro de boletines vacío');
  const [rows] = await manager.query<[{ id: string }[], number]>(
    `WITH target AS (
       SELECT r.id FROM report_cards r
        WHERE ${where.join(' AND ')}
        ORDER BY r.id
        FOR UPDATE
     )
     UPDATE report_cards SET outdated_at = CURRENT_TIMESTAMP
       FROM target WHERE report_cards.id = target.id
     RETURNING report_cards.id`,
    params,
  );
  return rows.map((row) => row.id);
}
