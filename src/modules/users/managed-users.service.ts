import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  QueryFailedError,
  SelectQueryBuilder,
} from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { containsPattern } from '../../common/dto/list-query.dto';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { escapeHtml } from '../../common/utils/escape-html';
import { BCRYPT_COST } from '../../common/validators/password-policy';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { PasswordResetTokenEntity } from '../auth/entities/password-reset-token.entity';
import { RefreshTokenEntity } from '../auth/entities/refresh-token.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { MailService } from '../mail/mail.service';
import { RoleMenuPermissionEntity } from '../security/entities/role-menu-permission.entity';
import { RoleEntity } from '../security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import {
  ASSIGNMENT_PERMISSION,
  AssignmentScope,
  RoleAssignmentsService,
} from '../security/role-assignments.service';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto, USER_NOT_NULL_FIELDS } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UserQueryDto } from './dto/user-query.dto';
import {
  CreatedUserResponseDto,
  TemporaryPasswordResponseDto,
  UserResponseDto,
} from './dto/user-response.dto';
import { UserEntity } from './entities/user.entity';
import { generateTemporaryPassword } from './temporary-password';
import { UsersService } from './users.service';

/** Slug de menú que controla la gestión de usuarios (el mismo de las asignaciones). */
export const USERS_PERMISSION = ASSIGNMENT_PERMISSION;

/**
 * institution: la institución activa del token, con las reglas del administrador.
 * system: el SUPER_ADMIN sobre cualquier institución (p. ej. su primer administrador).
 */
export type UsersScope = AssignmentScope;

/**
 * Gestión de usuarios por administradores (fase 7a). Reglas:
 * - Pertenencia: solo se ven y gestionan usuarios con alguna asignación en la
 *   institución (y en las sedes de quien actúa, si su permiso está limitado a
 *   sedes). Lo demás responde 404, sin revelar si existe.
 * - Nadie se gestiona a sí mismo por aquí; a un SUPER_ADMIN solo otro SUPER_ADMIN.
 * - Techo: no se gestiona a quien tiene permisos que quien actúa no tiene.
 * - Exclusividad: email, documento, contraseña temporal y activar/desactivar
 *   solo si todas sus asignaciones están en esta institución y en las sedes
 *   de quien actúa (o lo hace un SUPER_ADMIN). Evita que un colegio tome la
 *   cuenta de alguien que también es administrador en otro.
 * - Email de un usuario ya creado: solo el SUPER_ADMIN (hasta que exista la
 *   verificación de email, tarea 2.11.6): un administrador podría poner un
 *   correo suyo y tomar la cuenta cuando el usuario reciba más permisos.
 * - Los SUPER_ADMIN no se ven desde una institución (404).
 * - Los 403 son genéricos: no revelan si pertenece a otra institución o sede.
 * - Las acciones sensibles quedan en el log de auditoría (sin secretos).
 * - Baja lógica (is_active); nunca borrado físico.
 */
const MANAGE_FORBIDDEN = 'No tiene permiso para gestionar a este usuario';
const SUPER_ADMIN_ONLY = 'Este cambio solo lo puede hacer un SUPER_ADMIN';
@Injectable()
export class ManagedUsersService {
  private readonly logger = new Logger(ManagedUsersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly assignments: RoleAssignmentsService,
    private readonly avatars: UsersService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  // ------------------------------------------------------------- lectura

  async findAll(
    scope: UsersScope,
    query: UserQueryDto,
  ): Promise<Paginated<UserResponseDto>> {
    const manager = this.dataSource.manager;
    await this.assertInstitutionExists(manager, scope);
    const campusScope = await this.campusScope(scope, 'view');

    const qb = this.membersQuery(manager, scope, campusScope, {
      roleId: query.roleId,
      campusId: query.campusId,
    });
    if (query.isActive !== undefined) {
      qb.andWhere('u.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.search) {
      qb.andWhere(
        `(u.first_name ILIKE :pattern OR u.last_name ILIKE :pattern OR (u.first_name || ' ' || u.last_name) ILIKE :pattern OR u.document_number ILIKE :pattern OR u.email ILIKE :pattern)`,
        { pattern: containsPattern(query.search) },
      );
    }
    qb.orderBy('u.last_name', 'ASC')
      .addOrderBy('u.first_name', 'ASC')
      .addOrderBy('u.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [users, total] = await qb.skip(skip).take(take).getManyAndCount();
    const byUser = await this.loadAssignments(
      manager,
      scope,
      campusScope,
      users.map((u) => u.id),
    );
    return paginate(
      users.map((u) =>
        UserResponseDto.from(
          u,
          byUser.get(u.id) ?? [],
          this.isSuperAdmin(scope),
        ),
      ),
      total,
      query,
    );
  }

  async findOne(scope: UsersScope, id: string): Promise<UserResponseDto> {
    const manager = this.dataSource.manager;
    await this.assertInstitutionExists(manager, scope);
    const { user, campusScope } = await this.findVisible(
      manager,
      scope,
      id,
      'view',
    );
    return this.toResponse(manager, scope, campusScope, user);
  }

  /** URL firmada del avatar de un usuario de la institución (y de sus sedes). */
  async getAvatar(scope: UsersScope, id: string): Promise<AvatarResponseDto> {
    const { user } = await this.findVisible(
      this.dataSource.manager,
      scope,
      id,
      'view',
    );
    return this.avatars.getAvatar(user.id);
  }

  // ------------------------------------------------------------ escritura

  /**
   * Crea el usuario con una contraseña temporal y su primera asignación, en una
   * transacción (mismas reglas que POST /role-assignments). La contraseña se
   * devuelve una sola vez y, si hay email, también se envía por correo.
   */
  async create(
    scope: UsersScope,
    dto: CreateUserDto,
  ): Promise<CreatedUserResponseDto> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);

    const campusId = dto.campusId ?? null;
    const userId = await this.dataSource.transaction(async (manager) => {
      // Rol, sede, alcance y techo antes de insertar: quien no puede crear con
      // ese rol no llega a saber si el documento o el email ya existen (409).
      const { campusScope } = await this.assignments.validateAssignment(
        manager,
        scope,
        dto.roleId,
        campusId,
      );
      if (dto.userType === 'INSTITUTION_ADMIN' && campusScope) {
        throw new ForbiddenException(
          'Para crear administradores necesita alcance en toda la institución',
        );
      }
      const id = await this.insertUser(manager, {
        userType: dto.userType,
        documentType: dto.documentType,
        documentNumber: dto.documentNumber,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        passwordHash,
        mustChangePassword: true,
        isActive: true,
      });
      await this.assignments.insertAssignment(
        manager,
        scope,
        { userId: id, roleId: dto.roleId, campusId },
        { newUser: true },
      );
      return id;
    });

    const manager = this.dataSource.manager;
    const user = await manager
      .getRepository(UserEntity)
      .findOneByOrFail({ id: userId });
    this.audit(scope, 'user.created', userId, { roleId: dto.roleId, campusId });
    this.sendTemporaryPassword(user, temporaryPassword, 'created');
    const response = await this.toResponse(manager, scope, null, user);
    return { ...response, temporaryPassword };
  }

  async update(
    scope: UsersScope,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    rejectNullFields(dto, USER_NOT_NULL_FIELDS);

    await this.dataSource.transaction(async (manager) => {
      await this.assertInstitutionExists(manager, scope);
      const { user, campusScope } = await this.findVisible(
        manager,
        scope,
        id,
        'update',
        { lock: true },
      );
      await this.assertCanManage(manager, scope, user);

      const emailChanged = dto.email !== undefined && dto.email !== user.email;
      const documentChanged =
        (dto.documentType !== undefined &&
          dto.documentType !== user.documentType) ||
        (dto.documentNumber !== undefined &&
          dto.documentNumber !== user.documentNumber);
      if (emailChanged && !this.isSuperAdmin(scope)) {
        throw new ForbiddenException(SUPER_ADMIN_ONLY);
      }
      if (documentChanged) {
        await this.assertExclusive(manager, scope, user.id, campusScope);
      }

      const changes: Partial<UserEntity> = {};
      if (dto.firstName !== undefined) changes.firstName = dto.firstName;
      if (dto.lastName !== undefined) changes.lastName = dto.lastName;
      if (dto.phone !== undefined) changes.phone = dto.phone;
      if (emailChanged) changes.email = dto.email ?? null;
      if (dto.documentType !== undefined) {
        changes.documentType = dto.documentType;
      }
      if (dto.documentNumber !== undefined) {
        changes.documentNumber = dto.documentNumber;
      }
      if (Object.keys(changes).length === 0) return;

      await this.saveUserChanges(manager, user.id, changes);
      // Un enlace de recuperación enviado al correo anterior deja de servir.
      if (emailChanged) await this.invalidateResetTokens(manager, user.id);
      this.audit(scope, 'user.updated', user.id, {
        fields: Object.keys(changes),
      });
    });

    return this.findOne(scope, id);
  }

  /** Desactivar cierra todas sus sesiones (pierde el acceso en la siguiente petición). */
  async setStatus(
    scope: UsersScope,
    id: string,
    dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertInstitutionExists(manager, scope);
      const { user, campusScope } = await this.findVisible(
        manager,
        scope,
        id,
        'update',
        { lock: true },
      );
      await this.assertCanManage(manager, scope, user);
      await this.assertExclusive(manager, scope, user.id, campusScope);
      if (user.isActive === dto.isActive) return;

      await manager
        .getRepository(UserEntity)
        .update({ id: user.id }, { isActive: dto.isActive });
      if (!dto.isActive) {
        await this.endAllSessions(manager, user.id);
        await this.invalidateResetTokens(manager, user.id);
      }
      this.audit(
        scope,
        dto.isActive ? 'user.activated' : 'user.deactivated',
        user.id,
      );
    });
    return this.findOne(scope, id);
  }

  /**
   * Genera una contraseña temporal nueva (must_change_password = true) y cierra
   * todas sus sesiones. Se devuelve una sola vez y, si hay email, se envía.
   */
  async resetTemporaryPassword(
    scope: UsersScope,
    id: string,
  ): Promise<TemporaryPasswordResponseDto> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);

    const user = await this.dataSource.transaction(async (manager) => {
      await this.assertInstitutionExists(manager, scope);
      const found = await this.findVisible(manager, scope, id, 'update', {
        lock: true,
      });
      await this.assertCanManage(manager, scope, found.user);
      await this.assertExclusive(
        manager,
        scope,
        found.user.id,
        found.campusScope,
      );
      if (!found.user.isActive) {
        throw new BadRequestException(
          'El usuario está inactivo: actívelo primero',
        );
      }
      await manager
        .getRepository(UserEntity)
        .update(
          { id: found.user.id },
          { passwordHash, mustChangePassword: true },
        );
      await this.endAllSessions(manager, found.user.id);
      await this.invalidateResetTokens(manager, found.user.id);
      this.audit(scope, 'user.temporary-password', found.user.id);
      return found.user;
    });

    this.sendTemporaryPassword(user, temporaryPassword, 'reset');
    return { temporaryPassword };
  }

  // -------------------------------------------------------------- reglas

  /**
   * Usuario con alguna asignación en la institución (y en las sedes de quien
   * actúa, si su permiso para esa acción está limitado a sedes). 404 si no.
   */
  private async findVisible(
    manager: EntityManager,
    scope: UsersScope,
    id: string,
    action: PermissionAction,
    { lock = false }: { lock?: boolean } = {},
  ): Promise<{ user: UserEntity; campusScope: CampusScope }> {
    const campusScope = await this.campusScope(scope, action);
    const qb = this.membersQuery(manager, scope, campusScope).andWhere(
      'u.id = :id',
      { id },
    );
    if (lock) qb.setLock('pessimistic_write');
    const user = await qb.getOne();
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return { user, campusScope };
  }

  /** Nadie se gestiona a sí mismo; SUPER_ADMIN solo por otro; techo de permisos. */
  private async assertCanManage(
    manager: EntityManager,
    scope: UsersScope,
    target: UserEntity,
  ): Promise<void> {
    if (target.id === scope.user.userId) {
      throw new ForbiddenException(
        'No puede gestionar su propia cuenta desde aquí',
      );
    }
    // Defensa adicional: membersQuery ya oculta a los SUPER_ADMIN.
    if (target.userType === 'SUPER_ADMIN' && !this.isSuperAdmin(scope)) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (scope.kind === 'system') return;

    // Cada rol del usuario en esta institución debe estar dentro de lo que
    // quien actúa tiene en ese mismo alcance (la sede o toda la institución).
    const held = await manager.getRepository(UserInstitutionRoleEntity).find({
      select: { roleId: true, campusId: true },
      where: { userId: target.id, institutionId: scope.institutionId },
    });
    if (held.length === 0) return;
    // FOR SHARE sobre sus roles: los permisos no cambian mientras se evalúa
    // el techo (las asignaciones ya están fijas por el bloqueo del usuario).
    await manager.getRepository(RoleEntity).find({
      select: { id: true },
      where: { id: In([...new Set(held.map((h) => h.roleId))]) },
      lock: { mode: 'pessimistic_read' },
    });
    const seen = new Set<string>();
    for (const { roleId, campusId } of held) {
      const key = `${roleId}:${campusId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rolePerms = await manager
        .getRepository(RoleMenuPermissionEntity)
        .find({ where: { roleId } });
      try {
        await this.permissions.assertWithinCeiling(
          scope.user,
          scope.institutionId,
          rolePerms,
          campusId ?? 'institution',
        );
      } catch (error) {
        // Mensaje genérico: no revela en qué sede ni con qué rol está.
        if (error instanceof ForbiddenException) {
          throw new ForbiddenException(MANAGE_FORBIDDEN);
        }
        throw error;
      }
    }
  }

  /**
   * Exclusividad: todas las asignaciones del usuario están en esta institución
   * y, si quien actúa está limitado a sedes, en esas sedes. El SUPER_ADMIN está exento.
   */
  private async assertExclusive(
    manager: EntityManager,
    scope: UsersScope,
    userId: string,
    campusScope: CampusScope,
  ): Promise<void> {
    if (this.isSuperAdmin(scope)) return;
    const outside = manager
      .getRepository(UserInstitutionRoleEntity)
      .createQueryBuilder('uir')
      .where('uir.user_id = :userId', { userId });
    if (campusScope) {
      outside.andWhere(
        '(uir.institution_id <> :institutionId OR uir.campus_id IS NULL OR uir.campus_id NOT IN (:...campusScope))',
        { institutionId: scope.institutionId, campusScope },
      );
    } else {
      outside.andWhere('uir.institution_id <> :institutionId', {
        institutionId: scope.institutionId,
      });
    }
    if (await outside.getExists()) {
      throw new ForbiddenException(SUPER_ADMIN_ONLY);
    }
  }

  // ------------------------------------------------------------- consultas

  /**
   * Usuarios con alguna asignación en la institución (dentro del alcance por
   * sede) que cumpla los filtros. EXISTS: un usuario con varias asignaciones
   * sale una sola vez.
   */
  private membersQuery(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
    filters: { roleId?: string; campusId?: string } = {},
  ): SelectQueryBuilder<UserEntity> {
    const conditions = [
      'm.user_id = u.id',
      'm.institution_id = :institutionId',
    ];
    if (campusScope) {
      conditions.push(
        campusScope.length ? 'm.campus_id IN (:...campusScope)' : 'false',
      );
    }
    if (filters.roleId) conditions.push('m.role_id = :roleId');
    if (filters.campusId) conditions.push('m.campus_id = :campusId');
    const qb = manager
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .where(
        `EXISTS (SELECT 1 FROM user_institution_roles m WHERE ${conditions.join(' AND ')})`,
        {
          institutionId: scope.institutionId,
          campusScope,
          roleId: filters.roleId,
          campusId: filters.campusId,
        },
      );
    // Un SUPER_ADMIN solo es visible para otro SUPER_ADMIN.
    if (!this.isSuperAdmin(scope)) {
      qb.andWhere(`u.user_type <> 'SUPER_ADMIN'`);
    }
    return qb;
  }

  /** Asignaciones de esos usuarios en la institución, dentro del alcance por sede. */
  private async loadAssignments(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
    userIds: string[],
  ): Promise<Map<string, UserInstitutionRoleEntity[]>> {
    const byUser = new Map<string, UserInstitutionRoleEntity[]>();
    if (userIds.length === 0) return byUser;
    const rows = await manager.getRepository(UserInstitutionRoleEntity).find({
      where: {
        userId: In(userIds),
        institutionId: scope.institutionId,
        ...(campusScope ? { campusId: In(campusScope) } : {}),
      },
      relations: { role: true, campus: true },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    return byUser;
  }

  private async toResponse(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
    user: UserEntity,
  ): Promise<UserResponseDto> {
    const byUser = await this.loadAssignments(manager, scope, campusScope, [
      user.id,
    ]);
    return UserResponseDto.from(
      user,
      byUser.get(user.id) ?? [],
      this.isSuperAdmin(scope),
    );
  }

  private async insertUser(
    manager: EntityManager,
    values: Partial<UserEntity>,
  ): Promise<string> {
    try {
      const result = await manager.getRepository(UserEntity).insert(values);
      return (result.identifiers[0] as { id: string }).id;
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  private async saveUserChanges(
    manager: EntityManager,
    id: string,
    changes: Partial<UserEntity>,
  ): Promise<void> {
    try {
      await manager.getRepository(UserEntity).update({ id }, changes);
    } catch (error) {
      throw this.mapUniqueViolation(error);
    }
  }

  /** Mensaje genérico: no dice si coincidió el documento o el email. */
  private mapUniqueViolation(error: unknown): unknown {
    if (
      error instanceof QueryFailedError &&
      (error as QueryFailedError & { code?: string }).code === '23505'
    ) {
      return new ConflictException(
        'Ya existe un usuario con ese documento o email',
      );
    }
    return error;
  }

  /**
   * Las sesiones se eliminan (no se revocan), como al cambiar la contraseña:
   * un refresh token viejo no se confunde con una reutilización.
   */
  private async endAllSessions(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.getRepository(RefreshTokenEntity).delete({ userId });
  }

  private async invalidateResetTokens(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager
      .getRepository(PasswordResetTokenEntity)
      .update({ userId, usedAt: IsNull() }, { usedAt: new Date() });
  }

  private campusScope(
    scope: UsersScope,
    action: PermissionAction,
  ): Promise<CampusScope> {
    if (scope.kind === 'system') return Promise.resolve(null);
    return this.permissions.campusScope(
      scope.user.userId,
      scope.institutionId,
      USERS_PERMISSION,
      action,
    );
  }

  private async assertInstitutionExists(
    manager: EntityManager,
    scope: UsersScope,
  ): Promise<void> {
    if (scope.kind !== 'system') return;
    const exists = await manager
      .getRepository(InstitutionEntity)
      .existsBy({ id: scope.institutionId });
    if (!exists) throw new NotFoundException('Institución no encontrada');
  }

  private isSuperAdmin(scope: UsersScope): boolean {
    return scope.user.userType === 'SUPER_ADMIN';
  }

  /**
   * Registro de auditoría de acciones sensibles: quién, en qué institución,
   * sobre quién y qué campos. Nunca valores secretos (ni contraseñas ni emails).
   */
  private audit(
    scope: UsersScope,
    action: string,
    targetUserId: string,
    details: Record<string, unknown> = {},
  ): void {
    this.logger.log(
      JSON.stringify({
        audit: action,
        actorId: scope.user.userId,
        actorType: scope.user.userType,
        scope: scope.kind,
        institutionId: scope.institutionId,
        targetUserId,
        ...details,
      }),
    );
  }

  /**
   * Riesgo aceptado (B6 de la fase 7a): la contraseña viaja en claro por correo
   * y, si el email se escribió mal, le llega a un tercero. Un enlace de un solo
   * uso no lo evita (quien lo recibe igual fija la contraseña); lo mitiga la
   * verificación de email (tarea 2.11.6) y el cambio obligatorio al entrar.
   *
   * Sin email no se envía nada: el administrador entrega la contraseña de la respuesta. */
  private sendTemporaryPassword(
    user: UserEntity,
    password: string,
    reason: 'created' | 'reset',
  ): void {
    if (!user.email) return;
    const login = `${this.config.getOrThrow<string>('FRONTEND_URL')}/login`;
    const intro =
      reason === 'created'
        ? 'se creó tu cuenta en Aula360'
        : 'un administrador generó una nueva contraseña temporal para tu cuenta de Aula360';
    this.mail
      .send({
        to: user.email,
        subject: 'Aula360 - Contraseña temporal',
        text: `Hola ${user.firstName}, ${intro}.\nContraseña temporal: ${password}\nEntra a ${login} y cámbiala al iniciar sesión.`,
        html: `<p>Hola ${escapeHtml(user.firstName)}, ${intro}.</p><p>Contraseña temporal: <strong>${escapeHtml(password)}</strong></p><p>Entra a <a href="${login}">Aula360</a> y cámbiala al iniciar sesión.</p>`,
      })
      .catch((error: Error) =>
        this.logger.error(
          `No se pudo enviar la contraseña temporal: ${error.message}`,
        ),
      );
  }
}
