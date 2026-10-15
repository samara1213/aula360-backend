import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { CampusEntity } from '../institutions/entities/campus.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { UserEntity } from '../users/entities/user.entity';
import { CreateRoleAssignmentDto } from './dto/create-role-assignment.dto';
import { RoleAssignmentQueryDto } from './dto/role-assignment-query.dto';
import { RoleAssignmentResponseDto } from './dto/role-assignment-response.dto';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { RoleEntity } from './entities/role.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';
import { CampusScope, PermissionsReader } from './permissions-reader.service';

/** Slug de menú que controla la vinculación de usuarios a roles. */
export const ASSIGNMENT_PERMISSION = 'security.users';

/**
 * institution: la institución activa del token, con las reglas del
 * administrador (usuarios ya vinculados, alcance por sede, techo de permisos).
 * system: el SUPER_ADMIN sobre cualquier institución (p. ej. su primer administrador).
 */
export type AssignmentScope =
  | { kind: 'institution'; user: AuthUser; institutionId: string }
  | { kind: 'system'; user: AuthUser; institutionId: string };

@Injectable()
export class RoleAssignmentsService {
  constructor(
    @InjectRepository(UserInstitutionRoleEntity)
    private readonly assignments: Repository<UserInstitutionRoleEntity>,
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(
    scope: AssignmentScope,
    query: RoleAssignmentQueryDto,
  ): Promise<Paginated<RoleAssignmentResponseDto>> {
    await this.assertInstitutionExists(this.dataSource.manager, scope);
    const qb = this.baseQuery(this.assignments).where(
      'uir.institution_id = :institutionId',
      { institutionId: scope.institutionId },
    );
    const campusScope = await this.campusScope(scope, 'view');
    if (campusScope) {
      qb.andWhere(
        campusScope.length ? 'uir.campus_id IN (:...campusScope)' : 'false',
        { campusScope },
      );
    }
    if (query.userId) {
      qb.andWhere('uir.user_id = :userId', { userId: query.userId });
    }
    if (query.roleId) {
      qb.andWhere('uir.role_id = :roleId', { roleId: query.roleId });
    }
    if (query.campusId) {
      qb.andWhere('uir.campus_id = :campusId', { campusId: query.campusId });
    }
    qb.orderBy('u.last_name', 'ASC')
      .addOrderBy('u.first_name', 'ASC')
      .addOrderBy('r.name', 'ASC')
      .addOrderBy('uir.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) =>
        RoleAssignmentResponseDto.from(row, this.isSuperAdmin(scope)),
      ),
      total,
      query,
    );
  }

  async create(
    scope: AssignmentScope,
    dto: CreateRoleAssignmentDto,
  ): Promise<RoleAssignmentResponseDto> {
    const { institutionId } = scope;
    const campusId = dto.campusId ?? null;

    const id = await this.dataSource.transaction(async (manager) => {
      await this.assertInstitutionExists(manager, scope);

      // Alcance por sede primero: una sede fuera de su alcance responde 404
      // igual que una inexistente (no se revela cuáles existen).
      const campusScope = await this.campusScope(scope, 'create');
      if (campusScope) {
        if (!campusId) {
          throw new ForbiddenException(
            'Su acceso está limitado a sedes: solo puede asignar roles en ellas',
          );
        }
        if (!campusScope.includes(campusId)) {
          throw new NotFoundException('Sede no encontrada');
        }
      }

      const target = await manager.getRepository(UserEntity).findOne({
        select: { id: true, userType: true },
        where: { id: dto.userId, isActive: true },
      });
      // Desde una institución solo se vinculan usuarios que ya pertenecen a
      // ella (y, con alcance por sede, a alguna de sus sedes). No se revela
      // si el usuario existe en otra parte.
      const visible =
        target !== null &&
        (scope.kind === 'system' ||
          (await manager.getRepository(UserInstitutionRoleEntity).existsBy({
            userId: target.id,
            institutionId,
            ...(campusScope ? { campusId: In(campusScope) } : {}),
          })));
      if (!target || !visible) {
        throw new NotFoundException('Usuario no encontrado');
      }
      if (scope.kind === 'institution' && target.id === scope.user.userId) {
        throw new ForbiddenException('No puede asignarse roles a sí mismo');
      }
      this.assertCanTouchUser(scope, target);

      // FOR SHARE: sus permisos no cambian mientras se evalúa el techo.
      const role = await manager.getRepository(RoleEntity).findOne({
        where: { id: dto.roleId },
        lock: { mode: 'pessimistic_read' },
      });
      if (
        !role ||
        (role.institutionId !== null && role.institutionId !== institutionId)
      ) {
        throw new NotFoundException('Rol no encontrado');
      }

      if (campusId) {
        const campus = await manager
          .getRepository(CampusEntity)
          .findOne({ where: { id: campusId, institutionId } });
        if (!campus) throw new NotFoundException('Sede no encontrada');
        if (!campus.isActive) {
          throw new BadRequestException('La sede está inactiva');
        }
      }

      await this.assertRoleWithinCeiling(manager, scope, role.id, campusId);

      try {
        const result = await manager
          .getRepository(UserInstitutionRoleEntity)
          .insert({
            userId: target.id,
            institutionId,
            roleId: role.id,
            campusId,
          });
        return (result.identifiers[0] as { id: string }).id;
      } catch (error) {
        if (
          error instanceof QueryFailedError &&
          (error as QueryFailedError & { code?: string }).code === '23505'
        ) {
          throw new ConflictException(
            'El usuario ya tiene ese rol en esa sede o institución',
          );
        }
        if (
          error instanceof QueryFailedError &&
          (error as QueryFailedError & { code?: string }).code === '23503'
        ) {
          // El usuario, el rol o la sede se borraron en paralelo.
          throw new NotFoundException(
            'El usuario, el rol o la sede ya no existe',
          );
        }
        throw error;
      }
    });

    const created = await this.baseQuery(this.assignments)
      .where('uir.id = :id', { id })
      .getOneOrFail();
    return RoleAssignmentResponseDto.from(created, this.isSuperAdmin(scope));
  }

  /** Quita la asignación; el acceso se pierde en la siguiente petición. */
  async remove(scope: AssignmentScope, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertInstitutionExists(manager, scope);
      const repo = manager.getRepository(UserInstitutionRoleEntity);
      const assignment = await repo.findOne({
        where: { id, institutionId: scope.institutionId },
        relations: { user: true },
      });
      const campusScope = await this.campusScope(scope, 'delete');
      if (
        !assignment ||
        (campusScope &&
          (!assignment.campusId || !campusScope.includes(assignment.campusId)))
      ) {
        throw new NotFoundException('Asignación no encontrada');
      }
      if (assignment.userId === scope.user.userId) {
        throw new ForbiddenException(
          'No puede quitarse sus propias asignaciones',
        );
      }
      this.assertCanTouchUser(scope, assignment.user);
      await this.assertRoleWithinCeiling(
        manager,
        scope,
        assignment.roleId,
        assignment.campusId,
      );
      await repo.delete({ id: assignment.id });
    });
  }

  /** Datos de la asignación con usuario (sin datos sensibles), rol y sede. */
  private baseQuery(repo: Repository<UserInstitutionRoleEntity>) {
    return repo
      .createQueryBuilder('uir')
      .innerJoin('uir.user', 'u')
      .addSelect([
        'u.id',
        'u.firstName',
        'u.lastName',
        'u.documentType',
        'u.documentNumber',
        'u.email',
        'u.userType',
      ])
      .innerJoinAndSelect('uir.role', 'r')
      .leftJoinAndSelect('uir.campus', 'c');
  }

  private isSuperAdmin(scope: AssignmentScope): boolean {
    return scope.user.userType === 'SUPER_ADMIN';
  }

  /** Solo el SUPER_ADMIN gestiona las asignaciones de otro SUPER_ADMIN. */
  private assertCanTouchUser(
    scope: AssignmentScope,
    target: Pick<UserEntity, 'userType'>,
  ): void {
    if (
      target.userType === 'SUPER_ADMIN' &&
      scope.user.userType !== 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException(
        'Solo un SUPER_ADMIN puede gestionar a otro SUPER_ADMIN',
      );
    }
  }

  /**
   * No se puede asignar ni quitar un rol con permisos que quien actúa no tiene
   * en ese mismo alcance (la sede de la asignación, o toda la institución).
   */
  private async assertRoleWithinCeiling(
    manager: EntityManager,
    scope: AssignmentScope,
    roleId: string,
    campusId: string | null,
  ): Promise<void> {
    if (scope.kind === 'system') return;
    const rolePerms = await manager
      .getRepository(RoleMenuPermissionEntity)
      .find({ where: { roleId } });
    await this.permissions.assertWithinCeiling(
      scope.user,
      scope.institutionId,
      rolePerms,
      campusId ?? 'institution',
    );
  }

  private campusScope(
    scope: AssignmentScope,
    action: PermissionAction,
  ): Promise<CampusScope> {
    if (scope.kind === 'system') return Promise.resolve(null);
    return this.permissions.campusScope(
      scope.user.userId,
      scope.institutionId,
      ASSIGNMENT_PERMISSION,
      action,
    );
  }

  private async assertInstitutionExists(
    manager: EntityManager,
    scope: AssignmentScope,
  ): Promise<void> {
    if (scope.kind !== 'system') return;
    const exists = await manager
      .getRepository(InstitutionEntity)
      .existsBy({ id: scope.institutionId });
    if (!exists) throw new NotFoundException('Institución no encontrada');
  }
}
