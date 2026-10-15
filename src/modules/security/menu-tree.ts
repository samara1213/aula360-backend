/** Máximo de niveles del menú: Padre -> Hijo -> Nieto. */
export const MAX_MENU_DEPTH = 3;

interface TreeItem {
  id: string;
  parentId: string | null;
}

/**
 * Arma el árbol respetando el orden de `items`. Un elemento cuyo padre no está
 * en la lista se descarta junto con su rama (p. ej. un padre inactivo).
 */
export function buildTree<T extends TreeItem, N extends { children: N[] }>(
  items: readonly T[],
  toNode: (item: T) => N,
): N[] {
  const nodes = new Map(items.map((item) => [item.id, toNode(item)]));
  const roots: N[] = [];
  for (const item of items) {
    const node = nodes.get(item.id) as N;
    if (item.parentId === null) roots.push(node);
    else nodes.get(item.parentId)?.children.push(node);
  }
  return roots;
}

/** Ids de los ancestros de `id`, del padre hacia la raíz (corta si hubiera un ciclo). */
export function ancestorIds(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
): string[] {
  const result: string[] = [];
  let current = parentOf.get(id) ?? null;
  while (current !== null && !result.includes(current) && current !== id) {
    result.push(current);
    current = parentOf.get(current) ?? null;
  }
  return result;
}

/** Nivel de la opción: 1 = raíz. */
export function depthOf(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
): number {
  return ancestorIds(id, parentOf).length + 1;
}

/** Niveles de la rama que cuelga de `id` (1 = no tiene hijos). */
export function subtreeHeight(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
): number {
  let height = 1;
  for (const [childId, parentId] of parentOf) {
    if (parentId === id) {
      height = Math.max(height, 1 + subtreeHeight(childId, parentOf));
    }
  }
  return height;
}
