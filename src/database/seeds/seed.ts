import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  BCRYPT_COST,
  isStrongPassword,
  PASSWORD_POLICY_MESSAGE,
} from '../../common/validators/password-policy';
import { MenuOptionEntity } from '../../modules/security/entities/menu-option.entity';
import { RoleMenuPermissionEntity } from '../../modules/security/entities/role-menu-permission.entity';
import { RoleEntity } from '../../modules/security/entities/role.entity';
import { UserEntity } from '../../modules/users/entities/user.entity';
import { BASE_MENU, GLOBAL_ROLES, SeedMenuOption } from './seed-data';

export interface SuperAdminSeed {
  email: string;
  documentType: string;
  documentNumber: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface SeedSummary {
  menuOptionsCreated: number;
  rolesCreated: number;
  permissionsCreated: number;
  superAdmin: 'created' | 'already-exists' | 'skipped';
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Lee y valida los datos del SUPER_ADMIN desde las variables de entorno.
 * Devuelve null si no se configuró (todas vacías, salvo el tipo de documento por defecto);
 * si están configuradas a medias, falla indicando cuáles faltan.
 */
export function readSuperAdminFromEnv(
  env: NodeJS.ProcessEnv,
): SuperAdminSeed | null {
  const seed: SuperAdminSeed = {
    email: (env.SEED_SUPERADMIN_EMAIL ?? '').trim(),
    documentType: (env.SEED_SUPERADMIN_DOCUMENT_TYPE ?? '').trim(),
    documentNumber: (env.SEED_SUPERADMIN_DOCUMENT_NUMBER ?? '').trim(),
    firstName: (env.SEED_SUPERADMIN_FIRST_NAME ?? '').trim(),
    lastName: (env.SEED_SUPERADMIN_LAST_NAME ?? '').trim(),
    password: env.SEED_SUPERADMIN_PASSWORD ?? '',
  };
  const required = [
    seed.email,
    seed.documentNumber,
    seed.firstName,
    seed.lastName,
    seed.password,
  ];
  if (required.every((value) => !value)) {
    return null;
  }
  const missing = Object.entries(seed)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(
      `Faltan variables SEED_SUPERADMIN_* en .env: ${missing.join(', ')}`,
    );
  }
  if (!EMAIL_REGEX.test(seed.email)) {
    throw new Error('SEED_SUPERADMIN_EMAIL no es un email válido');
  }
  if (!isStrongPassword(seed.password)) {
    throw new Error(
      `SEED_SUPERADMIN_PASSWORD no cumple la política: ${PASSWORD_POLICY_MESSAGE}`,
    );
  }
  return seed;
}

async function seedMenu(
  manager: EntityManager,
  options: SeedMenuOption[],
  parentId: string | null,
  bySlug: Map<string, string>,
): Promise<number> {
  const repo = manager.getRepository(MenuOptionEntity);
  let created = 0;
  for (const option of options) {
    let existing = await repo.findOne({ where: { slug: option.slug } });
    if (!existing) {
      existing = await repo.save(
        repo.create({
          slug: option.slug,
          name: option.name,
          icon: option.icon ?? null,
          displayOrder: option.displayOrder,
          parentId,
        }),
      );
      created++;
    }
    bySlug.set(option.slug, existing.id);
    created += await seedMenu(
      manager,
      option.children ?? [],
      existing.id,
      bySlug,
    );
  }
  return created;
}

/**
 * Seed idempotente: menú base, roles globales con sus permisos y el SUPER_ADMIN inicial.
 * Solo inserta lo que falta; no cambia datos existentes (ni la contraseña del SUPER_ADMIN).
 */
export async function runSeed(
  dataSource: DataSource,
  superAdmin: SuperAdminSeed | null,
): Promise<SeedSummary> {
  return dataSource.transaction(async (manager) => {
    const menuIds = new Map<string, string>();
    const menuOptionsCreated = await seedMenu(
      manager,
      BASE_MENU,
      null,
      menuIds,
    );

    const roleRepo = manager.getRepository(RoleEntity);
    const permRepo = manager.getRepository(RoleMenuPermissionEntity);
    let rolesCreated = 0;
    let permissionsCreated = 0;

    for (const seedRole of GLOBAL_ROLES) {
      let role = await roleRepo.findOne({
        where: { name: seedRole.name, institutionId: IsNull() },
      });
      if (!role) {
        role = await roleRepo.save(
          roleRepo.create({
            name: seedRole.name,
            description: seedRole.description,
            institutionId: null,
          }),
        );
        rolesCreated++;
      }
      for (const perm of seedRole.permissions) {
        const menuOptionId = menuIds.get(perm.slug);
        if (!menuOptionId)
          throw new Error(`Slug de menú desconocido en el seed: ${perm.slug}`);
        const exists = await permRepo.exists({
          where: { roleId: role.id, menuOptionId },
        });
        if (!exists) {
          await permRepo.save(
            permRepo.create({
              roleId: role.id,
              menuOptionId,
              canCreate: perm.canCreate,
              canUpdate: perm.canUpdate,
              canDelete: perm.canDelete,
            }),
          );
          permissionsCreated++;
        }
      }
    }

    if (!superAdmin) {
      return {
        menuOptionsCreated,
        rolesCreated,
        permissionsCreated,
        superAdmin: 'skipped',
      };
    }

    const userRepo = manager.getRepository(UserEntity);
    const existingAdmin = await userRepo.findOne({
      where: [
        { email: superAdmin.email },
        {
          documentType: superAdmin.documentType,
          documentNumber: superAdmin.documentNumber,
        },
      ],
    });
    let superAdminResult: SeedSummary['superAdmin'] = 'already-exists';
    if (!existingAdmin) {
      await userRepo.save(
        userRepo.create({
          userType: 'SUPER_ADMIN',
          email: superAdmin.email,
          documentType: superAdmin.documentType,
          documentNumber: superAdmin.documentNumber,
          firstName: superAdmin.firstName,
          lastName: superAdmin.lastName,
          passwordHash: await bcrypt.hash(superAdmin.password, BCRYPT_COST),
          mustChangePassword: true,
          // Lo puso el operador en .env: se da por verificado.
          emailVerifiedAt: new Date(),
        }),
      );
      superAdminResult = 'created';
    }

    return {
      menuOptionsCreated,
      rolesCreated,
      permissionsCreated,
      superAdmin: superAdminResult,
    };
  });
}
