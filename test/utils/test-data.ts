import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { DataSource, In, IsNull } from 'typeorm';
import { PasswordResetTokenEntity } from '../../src/modules/auth/entities/password-reset-token.entity';
import { RefreshTokenEntity } from '../../src/modules/auth/entities/refresh-token.entity';
import { CampusEntity } from '../../src/modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../../src/modules/institutions/entities/institution.entity';
import { MenuOptionEntity } from '../../src/modules/security/entities/menu-option.entity';
import { RoleMenuPermissionEntity } from '../../src/modules/security/entities/role-menu-permission.entity';
import { RoleEntity } from '../../src/modules/security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../../src/modules/security/entities/user-institution-role.entity';
import {
  UserEntity,
  UserType,
} from '../../src/modules/users/entities/user.entity';

export const TEST_PASSWORD = 'Prueba*E2e2026';

/** Hash calculado una sola vez (bcrypt con costo bajo: solo para pruebas). */
let passwordHashPromise: Promise<string> | undefined;
function testPasswordHash(): Promise<string> {
  passwordHashPromise ??= bcrypt.hash(TEST_PASSWORD, 4);
  return passwordHashPromise;
}

function uniqueSuffix(): string {
  return randomBytes(5).toString('hex');
}

export interface CreateUserOptions {
  userType?: UserType;
  isActive?: boolean;
  mustChangePassword?: boolean;
  withEmail?: boolean;
}

/**
 * Fábrica de datos para e2e sobre la BD compartida: registra todo lo que crea
 * y cleanup() borra SOLO esos registros (nunca TRUNCATE), en orden de dependencias.
 */
export class TestData {
  private readonly institutionIds: string[] = [];
  private readonly userIds: string[] = [];

  constructor(private readonly ds: DataSource) {}

  async createInstitution(name = 'Colegio E2E'): Promise<InstitutionEntity> {
    const suffix = uniqueSuffix();
    const institution = await this.ds.getRepository(InstitutionEntity).save({
      nit: `E2E-${suffix}`,
      name: `${name} ${suffix}`,
    });
    this.institutionIds.push(institution.id);
    return institution;
  }

  async createUser(options: CreateUserOptions = {}): Promise<UserEntity> {
    const suffix = uniqueSuffix();
    const user = await this.ds.getRepository(UserEntity).save({
      userType: options.userType ?? 'INSTITUTION_ADMIN',
      documentType: 'CC',
      documentNumber: `E2E${suffix}`,
      firstName: 'Prueba',
      lastName: `E2E ${suffix}`,
      email:
        options.withEmail === false ? null : `e2e-${suffix}@test.aula360.local`,
      passwordHash: await testPasswordHash(),
      isActive: options.isActive ?? true,
      mustChangePassword: options.mustChangePassword ?? false,
    });
    this.userIds.push(user.id);
    return user;
  }

  /** Vincula al usuario con un rol global del seed (INSTITUTION_ADMIN, TEACHER, STUDENT). */
  async assignGlobalRole(
    userId: string,
    institutionId: string,
    roleName = 'INSTITUTION_ADMIN',
    campusId: string | null = null,
  ): Promise<void> {
    const role = await this.ds
      .getRepository(RoleEntity)
      .findOneOrFail({ where: { name: roleName, institutionId: IsNull() } });
    await this.ds
      .getRepository(UserInstitutionRoleEntity)
      .insert({ userId, institutionId, roleId: role.id, campusId });
  }

  /** Sede de una institución creada por esta fábrica (se borra con ella). */
  async createCampus(
    institutionId: string,
    name = 'Sede E2E',
  ): Promise<CampusEntity> {
    return this.ds
      .getRepository(CampusEntity)
      .save({ institutionId, name: `${name} ${uniqueSuffix()}` });
  }

  /**
   * Rol propio de una institución con permisos completos sobre los slugs dados.
   * Se borra junto con la institución (sus permisos caen en cascada).
   */
  async createInstitutionRole(
    institutionId: string,
    slugs: string[],
  ): Promise<RoleEntity> {
    const role = await this.ds.getRepository(RoleEntity).save({
      institutionId,
      name: `E2E Rol ${uniqueSuffix()}`,
    });
    const options = await this.ds
      .getRepository(MenuOptionEntity)
      .findBy({ slug: In(slugs) });
    await this.ds.getRepository(RoleMenuPermissionEntity).insert(
      options.map((option) => ({
        roleId: role.id,
        menuOptionId: option.id,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      })),
    );
    return role;
  }

  /** Registra una institución creada por la API para borrarla en cleanup(). */
  trackInstitution(id: string): void {
    this.institutionIds.push(id);
  }

  /** Registra un usuario creado por la API para borrarlo en cleanup(). */
  trackUser(id: string): void {
    this.userIds.push(id);
  }

  /** Crea un token de recuperación conocido (el real solo llega por correo). */
  async createResetToken(
    userId: string,
    { expired = false } = {},
  ): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await this.ds.getRepository(PasswordResetTokenEntity).insert({
      userId,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + (expired ? -60_000 : 30 * 60_000)),
    });
    return raw;
  }

  async activeRefreshTokens(userId: string): Promise<number> {
    return this.ds
      .getRepository(RefreshTokenEntity)
      .count({ where: { userId, revokedAt: IsNull() } });
  }

  /**
   * Borra restos de corridas anteriores que se cayeron antes de cleanup()
   * (identificados por los prefijos que usa esta fábrica). Evita que queden
   * cuentas de prueba activas con contraseña conocida.
   */
  async sweepLeftovers(): Promise<void> {
    await this.ds.transaction(async (m) => {
      await m.query(
        `DELETE FROM user_institution_roles
          WHERE user_id IN (SELECT id FROM users WHERE document_number LIKE 'E2E%' AND email LIKE 'e2e-%@test.aula360.local')
             OR institution_id IN (SELECT id FROM institutions WHERE nit LIKE 'E2E-%')`,
      );
      await m.query(
        `DELETE FROM roles WHERE institution_id IN (SELECT id FROM institutions WHERE nit LIKE 'E2E-%')`,
      );
      // Roles globales y opciones de menú creados por las e2e (sus permisos caen en cascada).
      await m.query(
        `DELETE FROM roles WHERE institution_id IS NULL AND name LIKE 'E2E %'`,
      );
      await m.query(`DELETE FROM menu_options WHERE slug LIKE 'e2e-%'`);
      await m.query(
        `DELETE FROM campuses WHERE institution_id IN (SELECT id FROM institutions WHERE nit LIKE 'E2E-%')`,
      );
      await m.query(
        `DELETE FROM users WHERE document_number LIKE 'E2E%' AND (email IS NULL OR email LIKE 'e2e-%@test.aula360.local')`,
      );
      await m.query(`DELETE FROM institutions WHERE nit LIKE 'E2E-%'`);
    });
  }

  async cleanup(): Promise<void> {
    await this.ds.transaction(async (m) => {
      if (this.userIds.length || this.institutionIds.length) {
        await m
          .getRepository(UserInstitutionRoleEntity)
          .createQueryBuilder()
          .delete()
          .where('user_id IN (:...u) OR institution_id IN (:...i)', {
            u: this.userIds.length ? this.userIds : [null],
            i: this.institutionIds.length ? this.institutionIds : [null],
          })
          .execute();
      }
      if (this.userIds.length) {
        // refresh_tokens y password_reset_tokens se borran en cascada con el usuario.
        await m.getRepository(UserEntity).delete({ id: In(this.userIds) });
      }
      if (this.institutionIds.length) {
        await m
          .getRepository(RoleEntity)
          .delete({ institutionId: In(this.institutionIds) });
        await m
          .getRepository(CampusEntity)
          .delete({ institutionId: In(this.institutionIds) });
        await m
          .getRepository(InstitutionEntity)
          .delete({ id: In(this.institutionIds) });
      }
    });
    await this.sweepLeftovers();
  }
}
