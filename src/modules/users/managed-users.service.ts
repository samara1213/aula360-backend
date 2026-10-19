import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
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
import {
  EmailNotice,
  EmailVerificationService,
  sameEmail,
  ThirdPartyChange,
} from '../auth/email-verification.service';
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
import { StudentEntity } from './entities/student.entity';
import { TeacherEntity } from './entities/teacher.entity';
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
 * - Email de un usuario ya creado (tarea 2.11.6): con exclusividad, queda
 *   pendiente hasta que el dueño del correo nuevo lo confirme con el enlace;
 *   al anterior se le avisa. Quitarlo (null) se aplica de inmediato.
 * - Los SUPER_ADMIN no se ven desde una institución (404).
 * - Los 403 son genéricos: no revelan si pertenece a otra institución o sede.
 * - Las acciones sensibles quedan en el log de auditoría (sin secretos).
 * - Baja lógica (is_active); nunca borrado físico.
 */
const MANAGE_FORBIDDEN = 'No tiene permiso para gestionar a este usuario';
const SUPER_ADMIN_ONLY = 'Este cambio solo lo puede hacer un SUPER_ADMIN';
@Injectable()
export class ManagedUsersService implements OnModuleInit {
  private readonly logger = new Logger(ManagedUsersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly assignments: RoleAssignmentsService,
    private readonly avatars: UsersService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  /** Al confirmar un email pedido por otra persona se revalidan estas reglas. */
  onModuleInit(): void {
    this.emailVerification.setChangeGuard((manager, change) =>
      this.assertStillAllowed(manager, change),
    );
  }

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
    const ids = users.map((u) => u.id);
    const byUser = await this.loadAssignments(manager, scope, campusScope, ids);
    const pending = await this.emailVerification.pendingEmails(manager, ids);
    return paginate(
      users.map((u) =>
        UserResponseDto.from(
          u,
          byUser.get(u.id) ?? [],
          this.isSuperAdmin(scope),
          pending.get(u.id) ?? null,
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
    const { password, hash } = await this.newTemporaryPassword();
    const userId = await this.dataSource.transaction((manager) =>
      this.insertUserWithAssignment(manager, scope, dto, hash),
    );
    const user = await this.afterCreate(scope, userId, password, {
      roleId: dto.roleId,
      campusId: dto.campusId ?? null,
    });
    const response = await this.toResponse(
      this.dataSource.manager,
      scope,
      null,
      user,
    );
    return { ...response, temporaryPassword: password };
  }

  /** Contraseña temporal y su hash (bcrypt va fuera de la transacción). */
  async newTemporaryPassword(): Promise<{ password: string; hash: string }> {
    const password = generateTemporaryPassword();
    return { password, hash: await bcrypt.hash(password, BCRYPT_COST) };
  }

  /**
   * Dentro de la transacción del llamador: valida la asignación (rol, sede,
   * alcance y techo) ANTES de insertar —quien no puede crear con ese rol no
   * llega a saber si el documento o el email ya existen (409)— y crea el
   * usuario con su primera asignación. También lo usan los perfiles (fase 7b).
   */
  async insertUserWithAssignment(
    manager: EntityManager,
    scope: UsersScope,
    dto: CreateUserDto,
    passwordHash: string,
  ): Promise<string> {
    const campusId = dto.campusId ?? null;
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
  }

  /**
   * Después del commit: auditoría y correo con la contraseña temporal y el
   * enlace para verificar el email (queda sin verificar hasta abrirlo).
   */
  async afterCreate(
    scope: UsersScope,
    userId: string,
    temporaryPassword: string,
    details: Record<string, unknown>,
  ): Promise<UserEntity> {
    const user = await this.dataSource.manager
      .getRepository(UserEntity)
      .findOneByOrFail({ id: userId });
    this.audit(scope, 'user.created', userId, details);
    let verifyLink: string | null = null;
    if (user.email) {
      try {
        verifyLink = this.emailVerification.link(
          await this.emailVerification.issue(
            this.dataSource.manager,
            user.id,
            user.email,
            scope.user.userId,
            scope.institutionId,
          ),
        );
      } catch (error) {
        // Sin enlace igual se envía la contraseña; se puede pedir otro con resend.
        this.logger.error(
          `No se pudo crear el enlace de verificación: ${(error as { code?: string }).code ?? 'Error'}`,
        );
      }
    }
    this.sendTemporaryPassword(user, temporaryPassword, 'created', verifyLink);
    return user;
  }

  async update(
    scope: UsersScope,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    rejectNullFields(dto, USER_NOT_NULL_FIELDS);
    const notice = await this.dataSource.transaction(async (manager) => {
      await this.assertInstitutionExists(manager, scope);
      const { user, campusScope } = await this.findVisible(
        manager,
        scope,
        id,
        'update',
        { lock: true },
      );
      return this.applyPersonalChanges(manager, scope, user, campusScope, dto);
    });
    this.notifyEmailChange(notice);
    return this.findOne(scope, id);
  }

  /**
   * Dentro de la transacción del llamador y con el usuario ya bloqueado
   * (FOR UPDATE): reglas de gestión (techo, autogestión) y cambios de datos
   * personales (email y documento con exclusividad). Se llama aunque no haya
   * datos personales que cambiar: también protege los perfiles.
   * Un email nuevo no se aplica: queda pendiente y se devuelve el aviso, que
   * el llamador envía con notifyEmailChange después del commit.
   */
  async applyPersonalChanges(
    manager: EntityManager,
    scope: UsersScope,
    user: UserEntity,
    campusScope: CampusScope,
    dto: UpdateUserDto,
  ): Promise<EmailNotice | null> {
    rejectNullFields(dto, USER_NOT_NULL_FIELDS);
    await this.assertCanManage(manager, scope, user);

    const emailChanged =
      dto.email !== undefined && !sameEmail(dto.email, user.email);
    const documentChanged =
      (dto.documentType !== undefined &&
        dto.documentType !== user.documentType) ||
      (dto.documentNumber !== undefined &&
        dto.documentNumber !== user.documentNumber);
    if (emailChanged || documentChanged) {
      await this.assertExclusive(manager, scope, user.id, campusScope);
    }

    const changes: Partial<UserEntity> = {};
    if (dto.firstName !== undefined) changes.firstName = dto.firstName;
    if (dto.lastName !== undefined) changes.lastName = dto.lastName;
    if (dto.phone !== undefined) changes.phone = dto.phone;
    // Quitarlo se aplica ya; uno nuevo queda pendiente hasta confirmarlo.
    const removeEmail = emailChanged && dto.email === null;
    if (removeEmail) {
      changes.email = null;
      changes.emailVerifiedAt = null;
    }
    if (dto.documentType !== undefined) changes.documentType = dto.documentType;
    if (dto.documentNumber !== undefined) {
      changes.documentNumber = dto.documentNumber;
    }

    let notice: EmailNotice | null = null;
    if (emailChanged && dto.email) {
      notice = await this.emailVerification.requestChange(
        manager,
        user,
        dto.email,
        scope.user.userId,
        scope.institutionId,
      );
      this.audit(scope, 'user.email-change-requested', user.id);
    } else if (
      dto.email !== undefined &&
      !emailChanged &&
      (await this.emailVerification.cancelPending(manager, user.id)) > 0
    ) {
      // El mismo email: un administrador anula un cambio pendiente (B3).
      this.audit(scope, 'user.email-change-cancelled', user.id);
    }
    if (Object.keys(changes).length === 0) return notice;

    await this.saveUserChanges(manager, user.id, changes);
    if (removeEmail) {
      // Ni enlaces de recuperación ni cambios pendientes al correo quitado.
      await this.invalidateResetTokens(manager, user.id);
      await this.emailVerification.cancelPending(manager, user.id);
      this.audit(scope, 'user.email-removed', user.id);
      // Se avisa al correo verificado que se quitó: quitarlo y poner otro no
      // puede pasar sin que el titular se entere (M1 de la fase 11b).
      if (user.email && user.emailVerifiedAt) {
        notice = {
          kind: 'removed',
          email: user.email,
          firstName: user.firstName,
        };
      }
    }
    this.audit(scope, 'user.updated', user.id, {
      fields: Object.keys(changes),
    });
    return notice;
  }

  /** Después del commit: enlace al correo nuevo y avisos al anterior. */
  notifyEmailChange(notice: EmailNotice | null): void {
    this.emailVerification.notify(notice);
  }

  /**
   * Al confirmar un email pedido por otra persona (hallazgo A1 de la fase
   * 11b): quien lo pidió sigue activa y puede seguir gestionando al usuario
   * en esa institución con las mismas reglas que al pedirlo (permiso de
   * edición en sus sedes, techo y exclusividad). Sirve el permiso de usuarios
   * o el del perfil que el usuario tenga allí (docente o estudiante).
   */
  private async assertStillAllowed(
    manager: EntityManager,
    change: ThirdPartyChange,
  ): Promise<void> {
    const requester = await manager.getRepository(UserEntity).findOne({
      where: { id: change.requesterId, isActive: true },
    });
    if (!requester) throw new ForbiddenException(MANAGE_FORBIDDEN);
    const actor = {
      userId: requester.id,
      institutionId: change.institutionId,
      userType: requester.userType,
      mustChangePassword: false,
      sessionId: '',
    };
    const kind =
      requester.userType === 'SUPER_ADMIN' ? 'system' : 'institution';
    const hasProfile = (entity: typeof TeacherEntity | typeof StudentEntity) =>
      manager.getRepository(entity).existsBy({
        userId: change.targetId,
        institutionId: change.institutionId,
      });
    const permissions = [USERS_PERMISSION];
    if (await hasProfile(TeacherEntity)) permissions.push('people.teachers');
    if (await hasProfile(StudentEntity)) permissions.push('people.students');
    let denied: unknown = new ForbiddenException(MANAGE_FORBIDDEN);
    for (const permission of permissions) {
      const scope: UsersScope = {
        kind,
        user: actor,
        institutionId: change.institutionId,
        permission,
      };
      try {
        const { user, campusScope } = await this.findVisible(
          manager,
          scope,
          change.targetId,
          'update',
        );
        await this.assertCanManage(manager, scope, user);
        await this.assertExclusive(manager, scope, user.id, campusScope);
        return;
      } catch (error) {
        denied = error;
      }
    }
    throw denied;
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
        // Un cambio de email pendiente no sobrevive a la desactivación (M2).
        await this.emailVerification.cancelPending(manager, user.id);
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
      await this.emailVerification.cancelPending(manager, found.user.id);
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
    if (held.length === 0) {
      // Ya no pertenece a la institución (p. ej. le quitaron sus roles y solo
      // le queda un perfil): desde aquí no se gestiona. Nunca sin techo.
      if (this.isSuperAdmin(scope)) return;
      throw new NotFoundException('Usuario no encontrado');
    }
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
    // Un perfil de docente o estudiante en otra institución también cuenta.
    const otherProfile = async (
      entity: typeof TeacherEntity | typeof StudentEntity,
    ) =>
      manager
        .getRepository(entity)
        .createQueryBuilder('p')
        .where('p.user_id = :userId AND p.institution_id <> :institutionId', {
          userId,
          institutionId: scope.institutionId,
        })
        .getExists();
    if (
      (await outside.getExists()) ||
      (await otherProfile(TeacherEntity)) ||
      (await otherProfile(StudentEntity))
    ) {
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
    const pending = await this.emailVerification.pendingEmails(manager, [
      user.id,
    ]);
    return UserResponseDto.from(
      user,
      byUser.get(user.id) ?? [],
      this.isSuperAdmin(scope),
      pending.get(user.id) ?? null,
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
      scope.permission ?? USERS_PERMISSION,
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
    verifyLink: string | null = null,
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
        text:
          `Hola ${user.firstName}, ${intro}.\nContraseña temporal: ${password}\nEntra a ${login} y cámbiala al iniciar sesión.` +
          (verifyLink
            ? `\nConfirma también tu correo (vence en 24 horas): ${verifyLink}`
            : ''),
        html:
          `<p>Hola ${escapeHtml(user.firstName)}, ${intro}.</p><p>Contraseña temporal: <strong>${escapeHtml(password)}</strong></p><p>Entra a <a href="${login}">Aula360</a> y cámbiala al iniciar sesión.</p>` +
          (verifyLink
            ? `<p>Confirma también tu correo (vence en 24 horas): <a href="${verifyLink}">confirmar correo</a></p>`
            : ''),
      })
      .catch((error: Error) =>
        this.logger.error(
          `No se pudo enviar la contraseña temporal: ${error.message}`,
        ),
      );
  }
}
