import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DataSource,
  EntityManager,
  LessThanOrEqual,
  MoreThan,
  QueryFailedError,
} from 'typeorm';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { escapeHtml } from '../../common/utils/escape-html';
import { CampusEntity } from '../institutions/entities/campus.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { MailService } from '../mail/mail.service';
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import { PermissionsReader } from '../security/permissions-reader.service';
import { RoleAssignmentsService } from '../security/role-assignments.service';
import {
  AcceptedInvitationDto,
  CreateInvitationDto,
  InvitationResponseDto,
  LinkCandidateResponseDto,
  MyInvitationDto,
  PersonDocumentDto,
} from './dto/person-link.dto';
import {
  InstitutionInvitationEntity,
  InvitationProfile,
} from './entities/institution-invitation.entity';
import { StudentEntity } from './entities/student.entity';
import { TeacherEntity } from './entities/teacher.entity';
import { UserEntity } from './entities/user.entity';
import {
  ManagedUsersService,
  shortName,
  UsersScope,
} from './managed-users.service';
import { LookupBudget } from './lookup-budget';
import { globalRoleId } from './profiles.shared';
import { STUDENTS_PERMISSION } from './students.service';
import { TEACHERS_PERMISSION } from './teachers.service';

/** Días que una invitación queda pendiente. */
export const INVITATION_DAYS = 14;
/** Invitaciones por institución en 24 horas (contra el barrido por documento). */
export const INVITATIONS_PER_DAY = 30;

const NOUN: Record<InvitationProfile, string> = {
  TEACHER: 'docente',
  STUDENT: 'estudiante',
};

const PERMISSION: Record<InvitationProfile, string> = {
  TEACHER: TEACHERS_PERMISSION,
  STUDENT: STUDENTS_PERMISSION,
};

const lookupResult = (error: unknown) =>
  error instanceof HttpException ? error.getStatus() : 'error';

/**
 * Invitaciones para sumar a una institución a quien ya tiene cuenta en otra
 * (A1 de la revisión de la entrega A, opción 1 del usuario): la institución
 * busca por documento («Carlos P.») e invita; la persona acepta o rechaza con
 * su sesión. Hasta que acepte, la institución no ve sus datos. Al aceptar se
 * crean su rol y su perfil (o se reutiliza el de antes).
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly users: ManagedUsersService,
    private readonly assignments: RoleAssignmentsService,
    private readonly permissions: PermissionsReader,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly budget: LookupBudget,
  ) {}

  // ------------------------------------------------- la institución invita

  /**
   * Nombre corto para confirmar que es la persona. Toda consulta se audita
   * (M1) y gasta el presupuesto diario de la institución (M1 de la segunda
   * revisión).
   */
  async candidate(
    scope: UsersScope,
    profile: InvitationProfile,
    document: PersonDocumentDto,
  ): Promise<LinkCandidateResponseDto> {
    try {
      this.budget.consume(scope.institutionId);
      const user = await this.users.findLinkable(
        this.dataSource.manager,
        scope,
        document,
        profile,
      );
      this.audit(scope, 'invitation.lookup', { profile, result: 'found' });
      return { displayName: shortName(user) };
    } catch (error) {
      this.audit(scope, 'invitation.lookup', {
        profile,
        result: lookupResult(error),
      });
      throw error;
    }
  }

  /**
   * Invitar también dice si el documento tiene cuenta: cada intento gasta el
   * presupuesto de búsquedas y el que falla se audita como una búsqueda (M1
   * de la segunda revisión).
   */
  async create(
    scope: UsersScope,
    profile: InvitationProfile,
    dto: CreateInvitationDto,
  ): Promise<InvitationResponseDto> {
    try {
      this.budget.consume(scope.institutionId);
      return await this.createInvitation(scope, profile, dto);
    } catch (error) {
      this.audit(scope, 'invitation.lookup', {
        profile,
        via: 'invitation',
        result: lookupResult(error),
      });
      throw error;
    }
  }

  private async createInvitation(
    scope: UsersScope,
    profile: InvitationProfile,
    dto: CreateInvitationDto,
  ): Promise<InvitationResponseDto> {
    const campusId = dto.campusId ?? null;
    const { invitation, user, campus } = await this.dataSource.transaction(
      async (manager) => {
        // La sede, el alcance y el techo antes de buscar a la persona (B3).
        const roleId = await globalRoleId(manager, profile);
        await this.assignments.validateAssignment(
          manager,
          scope,
          roleId,
          campusId,
        );
        // Las invitaciones simultáneas de la institución, en fila: si no,
        // todas contarían 29 y pasarían del tope (B1 de la segunda revisión).
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`invitations:${scope.institutionId}`],
        );
        await this.assertDailyLimit(manager, scope.institutionId);
        const user = await this.users.findLinkable(
          manager,
          scope,
          dto,
          profile,
          { lock: true },
        );
        if (profile === 'STUDENT') {
          await this.assertCanMoveProfile(manager, scope, user.id, campusId);
        }
        const repo = manager.getRepository(InstitutionInvitationEntity);
        // Una vencida deja de contar como pendiente (índice único parcial).
        await repo.update(
          {
            institutionId: scope.institutionId,
            userId: user.id,
            status: 'PENDING',
            expiresAt: LessThanOrEqual(new Date()),
          },
          { status: 'EXPIRED' },
        );
        try {
          const saved = await repo.save(
            repo.create({
              institutionId: scope.institutionId,
              userId: user.id,
              profileType: profile,
              campusId,
              status: 'PENDING',
              invitedBy: scope.user.userId,
              expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
              respondedAt: null,
            }),
          );
          const campus = campusId
            ? await manager
                .getRepository(CampusEntity)
                .findOneBy({ id: campusId })
            : null;
          return { invitation: saved, user, campus };
        } catch (error) {
          if (
            error instanceof QueryFailedError &&
            (error as QueryFailedError & { code?: string }).code === '23505'
          ) {
            throw new ConflictException(
              'Ya tiene una invitación pendiente de esta institución',
            );
          }
          throw error;
        }
      },
    );
    this.audit(scope, 'invitation.created', {
      invitationId: invitation.id,
      targetUserId: user.id,
      profile,
      campusId,
    });
    await this.notifyInvited(scope.institutionId, user, profile);
    return this.toResponse(invitation, user, campus);
  }

  /** Pendientes de la institución (con alcance por sede, las de esas sedes). */
  async list(
    scope: UsersScope,
    profile: InvitationProfile,
  ): Promise<InvitationResponseDto[]> {
    const campusScope = await this.campusScope(scope, 'create');
    const qb = this.dataSource.manager
      .getRepository(InstitutionInvitationEntity)
      .createQueryBuilder('i')
      .innerJoinAndSelect('i.user', 'u')
      .leftJoinAndSelect('i.campus', 'c')
      .where('i.institution_id = :institutionId', {
        institutionId: scope.institutionId,
      })
      .andWhere("i.status = 'PENDING' AND i.expires_at > now()")
      .andWhere('i.profile_type = :profile', { profile })
      .orderBy('i.created_at', 'DESC');
    if (campusScope) {
      qb.andWhere(
        campusScope.length ? 'i.campus_id IN (:...campusScope)' : 'false',
        { campusScope },
      );
    }
    const rows = await qb.getMany();
    return rows.map((row) => this.toResponse(row, row.user, row.campus));
  }

  async cancel(
    scope: UsersScope,
    profile: InvitationProfile,
    id: string,
  ): Promise<void> {
    const campusScope = await this.campusScope(scope, 'create');
    const repo = this.dataSource.manager.getRepository(
      InstitutionInvitationEntity,
    );
    const invitation = await repo.findOneBy({
      id,
      institutionId: scope.institutionId,
      profileType: profile,
      status: 'PENDING',
    });
    if (
      !invitation ||
      (campusScope &&
        (!invitation.campusId || !campusScope.includes(invitation.campusId)))
    ) {
      throw new NotFoundException('Invitación no encontrada');
    }
    const { affected } = await repo.update(
      { id, status: 'PENDING' },
      { status: 'CANCELLED', respondedAt: new Date() },
    );
    if (!affected) throw new NotFoundException('Invitación no encontrada');
    this.audit(scope, 'invitation.cancelled', { invitationId: id });
  }

  // ---------------------------------------------- la persona invitada responde

  /** Sus invitaciones pendientes y vigentes, de instituciones activas. */
  async mine(user: AuthUser): Promise<MyInvitationDto[]> {
    const rows = await this.dataSource.manager
      .getRepository(InstitutionInvitationEntity)
      .find({
        where: {
          userId: user.userId,
          status: 'PENDING',
          expiresAt: MoreThan(new Date()),
          institution: { isActive: true },
        },
        relations: { institution: true, campus: true },
        order: { createdAt: 'DESC' },
      });
    return rows.map((row) => ({
      id: row.id,
      institution: { id: row.institution.id, name: row.institution.name },
      profileType: row.profileType,
      campus: row.campus
        ? {
            id: row.campus.id,
            name: row.campus.name,
            isActive: row.campus.isActive,
          }
        : null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  }

  /**
   * Acepta: su rol y su perfil en la institución (el de antes, si vuelve).
   * Se vuelve a comprobar todo lo que pudo cambiar desde que lo invitaron,
   * también que quien invitó conserve el permiso en esa sede (B3 de la
   * segunda revisión).
   */
  async accept(user: AuthUser, id: string): Promise<AcceptedInvitationDto> {
    const invitation = await this.dataSource.transaction(async (manager) => {
      const invitation = await this.pendingOf(manager, user, id);
      const account = await manager.getRepository(UserEntity).findOne({
        where: { id: user.userId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!account || account.userType !== invitation.profileType) {
        throw new ConflictException('Esta invitación ya no se puede aceptar');
      }
      const institution = await manager
        .getRepository(InstitutionEntity)
        .findOneBy({ id: invitation.institutionId, isActive: true });
      if (!institution) {
        throw new ConflictException('La institución ya no está activa');
      }
      if (invitation.campusId) {
        const campus = await manager.getRepository(CampusEntity).findOneBy({
          id: invitation.campusId,
          institutionId: invitation.institutionId,
          isActive: true,
        });
        if (!campus) {
          throw new ConflictException(
            'La sede ya no está activa: pida a la institución una invitación nueva',
          );
        }
      }
      const roles = manager.getRepository(UserInstitutionRoleEntity);
      if (
        await roles.existsBy({
          userId: account.id,
          institutionId: invitation.institutionId,
        })
      ) {
        // Entró por otra vía: la invitación ya no sirve, ni para volver si
        // después le quitan el acceso (B4 de la segunda revisión).
        await this.cancelPending(manager, account.id, invitation.institutionId);
        return null;
      }
      await this.assertInviterStillAllowed(manager, invitation);
      await roles.insert({
        userId: account.id,
        institutionId: invitation.institutionId,
        roleId: await globalRoleId(manager, invitation.profileType),
        campusId: invitation.campusId,
      });
      await this.ensureProfile(manager, invitation);
      await manager
        .getRepository(InstitutionInvitationEntity)
        .update(
          { id: invitation.id },
          { status: 'ACCEPTED', respondedAt: new Date() },
        );
      return invitation;
    });
    if (!invitation) {
      throw new ConflictException('Ya perteneces a esta institución');
    }
    this.log('invitation.accepted', user.userId, invitation);
    return { institutionId: invitation.institutionId };
  }

  async reject(user: AuthUser, id: string): Promise<void> {
    const invitation = await this.dataSource.transaction(async (manager) => {
      const invitation = await this.pendingOf(manager, user, id);
      await manager
        .getRepository(InstitutionInvitationEntity)
        .update(
          { id: invitation.id },
          { status: 'REJECTED', respondedAt: new Date() },
        );
      return invitation;
    });
    this.log('invitation.rejected', user.userId, invitation);
  }

  /** Cancela sus invitaciones pendientes de la institución (B4 de la segunda revisión). */
  private async cancelPending(
    manager: EntityManager,
    userId: string,
    institutionId: string,
  ): Promise<void> {
    await manager
      .getRepository(InstitutionInvitationEntity)
      .update(
        { userId, institutionId, status: 'PENDING' },
        { status: 'CANCELLED', respondedAt: new Date() },
      );
  }

  // ------------------------------------------------------------- auxiliares

  /**
   * Quien invitó sigue activo y con el permiso de crear esas personas en la
   * sede de la invitación (B3 de la segunda revisión): si se lo quitaron, sus
   * invitaciones dejan de valer.
   */
  private async assertInviterStillAllowed(
    manager: EntityManager,
    invitation: InstitutionInvitationEntity,
  ): Promise<void> {
    const stale = new ConflictException(
      'Esta invitación ya no es válida: pida a la institución una nueva',
    );
    if (!invitation.invitedBy) throw stale;
    const inviter = await manager
      .getRepository(UserEntity)
      .existsBy({ id: invitation.invitedBy, isActive: true });
    if (!inviter) throw stale;
    const allowed = await this.permissions.campusScope(
      invitation.invitedBy,
      invitation.institutionId,
      PERMISSION[invitation.profileType],
      'create',
      { manager },
    );
    if (
      allowed &&
      (!invitation.campusId || !allowed.includes(invitation.campusId))
    ) {
      throw stale;
    }
  }

  /** La invitación pendiente y vigente de esta persona (FOR UPDATE); si no, 404 o 409. */
  private async pendingOf(
    manager: EntityManager,
    user: AuthUser,
    id: string,
  ): Promise<InstitutionInvitationEntity> {
    const invitation = await manager
      .getRepository(InstitutionInvitationEntity)
      .findOne({
        where: { id, userId: user.userId, status: 'PENDING' },
        lock: { mode: 'pessimistic_write' },
      });
    if (!invitation) throw new NotFoundException('Invitación no encontrada');
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(
        'La invitación venció: pida a la institución una nueva',
      );
    }
    return invitation;
  }

  /** Su perfil en la institución: el de antes (en la sede de la invitación) o uno nuevo. */
  private async ensureProfile(
    manager: EntityManager,
    invitation: InstitutionInvitationEntity,
  ): Promise<void> {
    const where = {
      userId: invitation.userId,
      institutionId: invitation.institutionId,
    };
    if (invitation.profileType === 'TEACHER') {
      const repo = manager.getRepository(TeacherEntity);
      if (!(await repo.existsBy(where))) await repo.insert(where);
      return;
    }
    const repo = manager.getRepository(StudentEntity);
    const previous = await repo.findOne({
      where,
      lock: { mode: 'pessimistic_write' },
    });
    if (!previous) {
      await repo.insert({ ...where, campusId: invitation.campusId });
      return;
    }
    if (previous.campusId !== invitation.campusId) {
      await this.assertNoCurrentEnrollment(manager, previous.id);
      await repo.update({ id: previous.id }, { campusId: invitation.campusId });
    }
  }

  /**
   * Si vuelve un estudiante cuyo perfil estaba en otra sede, quien invita
   * necesita editar estudiantes en esa sede y no puede tener matrícula
   * vigente (las mismas reglas que cambiarlo de sede; M2).
   */
  private async assertCanMoveProfile(
    manager: EntityManager,
    scope: UsersScope,
    userId: string,
    campusId: string | null,
  ): Promise<void> {
    const previous = await manager.getRepository(StudentEntity).findOneBy({
      userId,
      institutionId: scope.institutionId,
    });
    if (!previous || previous.campusId === campusId) return;
    const updateScope = await this.campusScope(scope, 'update', manager);
    if (
      updateScope &&
      (!previous.campusId || !updateScope.includes(previous.campusId))
    ) {
      throw new ForbiddenException(
        'Esta persona estuvo antes en otra sede: solo quien administra esa sede puede invitarla a una distinta',
      );
    }
    await this.assertNoCurrentEnrollment(manager, previous.id);
  }

  private async assertNoCurrentEnrollment(
    manager: EntityManager,
    studentId: string,
  ): Promise<void> {
    const [{ enrolled }] = await manager.query<{ enrolled: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM enrollments e
           JOIN academic_years y ON y.id = e.academic_year_id AND y.is_active
          WHERE e.student_id = $1 AND e.status IN ('ENROLLED', 'SUSPENDED')
       ) AS enrolled`,
      [studentId],
    );
    if (enrolled) {
      throw new ConflictException(
        'Tiene una matrícula vigente en otra sede: retírela primero en Académico',
      );
    }
  }

  /** 429 al pasar de INVITATIONS_PER_DAY en 24 horas (contra el barrido; M1). */
  private async assertDailyLimit(
    manager: EntityManager,
    institutionId: string,
  ): Promise<void> {
    const count = await manager
      .getRepository(InstitutionInvitationEntity)
      .countBy({
        institutionId,
        createdAt: MoreThan(new Date(Date.now() - 86_400_000)),
      });
    if (count >= INVITATIONS_PER_DAY) {
      throw new HttpException(
        `La institución ya envió ${INVITATIONS_PER_DAY} invitaciones en las últimas 24 horas: inténtelo más tarde`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private campusScope(
    scope: UsersScope,
    action: 'create' | 'update',
    manager?: EntityManager,
  ) {
    return this.permissions.campusScope(
      scope.user.userId,
      scope.institutionId,
      scope.permission as string,
      action,
      { manager },
    );
  }

  /**
   * Después del commit: aviso a la persona (si tiene el correo verificado) y,
   * si es estudiante, a los acudientes registrados en sus otras
   * instituciones. Un fallo del correo no deshace nada (B4).
   */
  private async notifyInvited(
    institutionId: string,
    user: UserEntity,
    profile: InvitationProfile,
  ): Promise<void> {
    try {
      const manager = this.dataSource.manager;
      const institution = await manager
        .getRepository(InstitutionEntity)
        .findOneByOrFail({ id: institutionId });
      const login = `${this.config.getOrThrow<string>('FRONTEND_URL')}/login`;
      const noun = NOUN[profile];
      const name = escapeHtml(institution.name);
      if (user.email && user.emailVerifiedAt) {
        this.send(
          user.email,
          `Hola ${user.firstName}, ${institution.name} te invitó a unirte como ${noun} en Aula360.\nEntra con tu misma cuenta para aceptar o rechazar la invitación: ${login}\nVence en ${INVITATION_DAYS} días.`,
          `<p>Hola ${escapeHtml(user.firstName)}, ${name} te invitó a unirte como ${noun} en Aula360.</p><p>Entra con tu misma cuenta para <a href="${login}">aceptar o rechazar la invitación</a>. Vence en ${INVITATION_DAYS} días.</p>`,
        );
      }
      if (profile === 'STUDENT') {
        const guardians = await manager
          .getRepository(StudentEntity)
          .createQueryBuilder('s')
          .select('DISTINCT s.guardian_email', 'email')
          .where('s.user_id = :userId AND s.institution_id <> :institutionId', {
            userId: user.id,
            institutionId,
          })
          .andWhere('s.guardian_email IS NOT NULL')
          .getRawMany<{ email: string }>();
        for (const { email } of guardians) {
          this.send(
            email,
            `${institution.name} invitó a ${user.firstName} a unirse como estudiante en Aula360. ${user.firstName} puede aceptarla o rechazarla al entrar con su cuenta.\nSi no lo esperaban, comuníquense con su institución.`,
            `<p>${name} invitó a ${escapeHtml(user.firstName)} a unirse como estudiante en Aula360. ${escapeHtml(user.firstName)} puede aceptarla o rechazarla al entrar con su cuenta.</p><p>Si no lo esperaban, comuníquense con su institución.</p>`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `No se pudo avisar de la invitación: ${(error as { code?: string }).code ?? 'Error'}`,
      );
    }
  }

  private send(to: string, text: string, html: string): void {
    this.mail
      .send({
        to,
        subject: 'Aula360 - Invitación de una institución',
        text,
        html,
      })
      // Solo el código: el mensaje de SMTP puede traer la dirección (B5 de la fase 11e).
      .catch((error: unknown) =>
        this.logger.error(
          `No se pudo enviar el aviso de invitación: ${(error as { code?: string }).code ?? 'Error'}`,
        ),
      );
  }

  private toResponse(
    invitation: InstitutionInvitationEntity,
    user: Pick<UserEntity, 'firstName' | 'lastName'>,
    campus: CampusEntity | null,
  ): InvitationResponseDto {
    return {
      id: invitation.id,
      displayName: shortName(user),
      profileType: invitation.profileType,
      campus: campus
        ? { id: campus.id, name: campus.name, isActive: campus.isActive }
        : null,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    };
  }

  /** Auditoría de la institución (sin el número de documento). */
  private audit(
    scope: UsersScope,
    action: string,
    details: Record<string, unknown>,
  ): void {
    this.logger.log(
      JSON.stringify({
        audit: action,
        actorId: scope.user.userId,
        institutionId: scope.institutionId,
        ...details,
      }),
    );
  }

  private log(
    action: string,
    userId: string,
    invitation: InstitutionInvitationEntity,
  ): void {
    this.logger.log(
      JSON.stringify({
        audit: action,
        actorId: userId,
        institutionId: invitation.institutionId,
        invitationId: invitation.id,
        profile: invitation.profileType,
      }),
    );
  }
}
