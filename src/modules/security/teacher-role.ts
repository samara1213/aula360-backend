import { EntityManager } from 'typeorm';
import { ACTIVE_ASSIGNMENT_CONDITION } from './active-assignment';

/**
 * ¿Tiene el usuario el rol global TEACHER vigente en la institución (sede
 * activa)? Con campuses, solo cuenta si es de toda la institución o de una de
 * esas sedes. La autorización del docente nunca se basa solo en su carga
 * académica (que no se desactiva al quitarle el rol).
 */
export async function hasActiveTeacherRole(
  db: Pick<EntityManager, 'query'>,
  userId: string,
  institutionId: string,
  campuses?: readonly string[],
): Promise<boolean> {
  const [{ allowed }] = await db.query<{ allowed: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM user_institution_roles uir
        WHERE uir.user_id = $1 AND uir.institution_id = $2
          AND uir.role_id = (SELECT r.id FROM roles r WHERE r.name = 'TEACHER' AND r.institution_id IS NULL)
          AND ($3::uuid[] IS NULL OR uir.campus_id IS NULL OR uir.campus_id = ANY($3::uuid[]))
          AND ${ACTIVE_ASSIGNMENT_CONDITION}
     ) AS allowed`,
    [userId, institutionId, campuses ? [...campuses] : null],
  );
  return allowed;
}
