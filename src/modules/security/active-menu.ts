/**
 * Condición SQL: la opción de menú (alias dado) está activa y también su padre
 * y su abuelo (máximo 3 niveles). Desactivar un padre deja sin efecto los
 * permisos de toda su rama, igual que la oculta en el menú.
 * Se usa en PermissionsGuard y en el alcance por sede.
 */
export function activeMenuCondition(alias: string): string {
  return (
    `(${alias}.is_active = true AND NOT EXISTS (` +
    `SELECT 1 FROM menu_options a1 LEFT JOIN menu_options a2 ON a2.id = a1.parent_id ` +
    `WHERE a1.id = ${alias}.parent_id AND (a1.is_active = false OR a2.is_active = false)))`
  );
}
