/**
 * Condición SQL (alias `uir` = user_institution_roles): la asignación cuenta solo
 * si es de toda la institución o si su sede sigue activa. Desactivar una sede
 * corta el acceso de quienes estaban limitados a ella, igual que con las instituciones.
 * Se usa en login, cambio de institución, JwtAuthGuard, PermissionsGuard y alcance por sede.
 */
export const ACTIVE_ASSIGNMENT_CONDITION =
  '(uir.campus_id IS NULL OR EXISTS (SELECT 1 FROM campuses ac WHERE ac.id = uir.campus_id AND ac.is_active = true))';
