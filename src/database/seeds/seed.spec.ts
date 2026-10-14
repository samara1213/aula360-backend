import { BASE_MENU, GLOBAL_ROLES, SeedMenuOption } from './seed-data';
import { readSuperAdminFromEnv } from './seed';

function flatten(
  options: SeedMenuOption[],
  depth = 1,
): { slug: string; depth: number }[] {
  return options.flatMap((o) => [
    { slug: o.slug, depth },
    ...flatten(o.children ?? [], depth + 1),
  ]);
}

describe('seed-data', () => {
  const menu = flatten(BASE_MENU);

  it('tiene slugs únicos', () => {
    const slugs = menu.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('no supera 3 niveles', () => {
    expect(Math.max(...menu.map((m) => m.depth))).toBeLessThanOrEqual(3);
  });

  it('los permisos de los roles apuntan a slugs existentes', () => {
    const slugs = new Set(menu.map((m) => m.slug));
    for (const role of GLOBAL_ROLES) {
      for (const perm of role.permissions) {
        expect(slugs.has(perm.slug)).toBe(true);
      }
    }
  });

  it('un rol con permiso sobre un hijo también puede ver a su padre (menú navegable)', () => {
    for (const role of GLOBAL_ROLES) {
      const granted = new Set(role.permissions.map((p) => p.slug));
      for (const slug of granted) {
        const parent = slug.split('.').slice(0, -1).join('.');
        if (parent) expect(granted.has(parent)).toBe(true);
      }
    }
  });
});

describe('readSuperAdminFromEnv', () => {
  const env = {
    SEED_SUPERADMIN_EMAIL: 'admin@aula360.co',
    SEED_SUPERADMIN_DOCUMENT_TYPE: 'CC',
    SEED_SUPERADMIN_DOCUMENT_NUMBER: '1234567890',
    SEED_SUPERADMIN_FIRST_NAME: 'Ana',
    SEED_SUPERADMIN_LAST_NAME: 'Pérez',
    SEED_SUPERADMIN_PASSWORD: 'Aula360*Segura',
  };

  it('lee los datos válidos', () => {
    expect(readSuperAdminFromEnv(env)).toMatchObject({
      email: 'admin@aula360.co',
      documentType: 'CC',
    });
  });

  it('devuelve null si no se configuró ninguna variable', () => {
    expect(
      readSuperAdminFromEnv({ SEED_SUPERADMIN_DOCUMENT_TYPE: 'CC' }),
    ).toBeNull();
  });

  it('indica las variables que faltan', () => {
    expect(() =>
      readSuperAdminFromEnv({ ...env, SEED_SUPERADMIN_EMAIL: '' }),
    ).toThrow(/email/);
  });

  it('rechaza un email inválido', () => {
    expect(() =>
      readSuperAdminFromEnv({ ...env, SEED_SUPERADMIN_EMAIL: 'no-es-email' }),
    ).toThrow(/email válido/);
  });

  it('rechaza una contraseña débil sin mostrarla', () => {
    expect(() =>
      readSuperAdminFromEnv({ ...env, SEED_SUPERADMIN_PASSWORD: 'debil' }),
    ).toThrow(/política/);
  });
});
