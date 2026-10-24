import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { ACTIVE_ASSIGNMENT_CONDITION } from '../security/active-assignment';
import { containsPattern } from '../../common/dto/list-query.dto';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import {
  CreatedTeacherResponseDto,
  TeacherResponseDto,
} from './dto/profile-response.dto';
import {
  CreateTeacherDto,
  TeacherQueryDto,
  UpdateTeacherDto,
} from './dto/teacher.dto';
import { TeacherEntity } from './entities/teacher.entity';
import { ManagedUsersService, UsersScope } from './managed-users.service';
import {
  globalRoleId,
  lockUser,
  personalFields,
  pickDefined,
} from './profiles.shared';

export const TEACHERS_PERMISSION = 'people.teachers';

/**
 * Asignación (alias uir) del rol global TEACHER del docente `t` en esta
 * institución, en sede activa (o en toda la institución). Otros roles que
 * tenga en una sede no lo hacen "docente de esa sede".
 */
const TEACHER_ASSIGNMENT = `uir.user_id = t.user_id AND uir.institution_id = t.institution_id AND uir.role_id = (SELECT gr.id FROM roles gr WHERE gr.name = 'TEACHER' AND gr.institution_id IS NULL) AND ${ACTIVE_ASSIGNMENT_CONDITION}`;

/**
 * Docentes de la institución activa (perfil `teachers` + su usuario).
 * Alta: usuario TEACHER, rol global TEACHER (en la sede, si se indica) y perfil,
 * en una transacción y con las mismas reglas que /users (techo, alcance por
 * sede, validación antes de insertar). Los datos personales se editan con las
 * reglas de /users; la baja es PATCH /users/:id/status (no hay borrado).
 * Alcance por sede: el docente es visible si tiene su rol TEACHER en esas
 * sedes (activas). Solo son visibles quienes conservan alguna asignación en
 * la institución.
 */
@Injectable()
export class TeachersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly users: ManagedUsersService,
  ) {}

  async findAll(
    scope: UsersScope,
    query: TeacherQueryDto,
  ): Promise<Paginated<TeacherResponseDto>> {
    const campusScope = await this.campusScope(scope, 'view');
    const qb = this.baseQuery(this.dataSource.manager, scope, campusScope);
    if (query.campusId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM user_institution_roles uir WHERE ${TEACHER_ASSIGNMENT} AND uir.campus_id = :campusId)`,
        { campusId: query.campusId },
      );
    }
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
      .addOrderBy('t.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((t) => TeacherResponseDto.from(t)),
      total,
      query,
    );
  }

  async findOne(scope: UsersScope, id: string): Promise<TeacherResponseDto> {
    const campusScope = await this.campusScope(scope, 'view');
    const teacher = await this.findVisible(
      this.dataSource.manager,
      scope,
      campusScope,
      id,
    );
    return {
      ...TeacherResponseDto.from(teacher),
      sharedElsewhere: await this.users.sharedElsewhere(
        this.dataSource.manager,
        scope.institutionId,
        teacher.userId,
      ),
    };
  }

  async create(
    scope: UsersScope,
    dto: CreateTeacherDto,
  ): Promise<CreatedTeacherResponseDto> {
    const { password, hash } = await this.users.newTemporaryPassword();
    const campusId = dto.campusId ?? null;
    const { response, userId } = await this.dataSource.transaction(
      async (manager) => {
        const roleId = await globalRoleId(manager, 'TEACHER');
        const newUserId = await this.users.insertUserWithAssignment(
          manager,
          scope,
          {
            ...personalFields(dto),
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
            firstName: dto.firstName,
            lastName: dto.lastName,
            userType: 'TEACHER',
            roleId,
            campusId,
          },
          hash,
        );
        const result = await manager.getRepository(TeacherEntity).insert({
          userId: newUserId,
          institutionId: scope.institutionId,
          academicDegree: dto.academicDegree ?? null,
          specialty: dto.specialty ?? null,
        });
        // La respuesta se arma aquí y no con findOne: quien puede crear pero
        // no ver no debe perder la contraseña temporal (404).
        const created = await this.findVisible(
          manager,
          scope,
          null,
          (result.identifiers[0] as { id: string }).id,
        );
        return {
          response: TeacherResponseDto.from(created),
          userId: newUserId,
        };
      },
    );
    await this.users.afterCreate(scope, userId, password, {
      profile: 'teacher',
      campusId,
    });
    return { ...response, temporaryPassword: password };
  }

  async update(
    scope: UsersScope,
    id: string,
    dto: UpdateTeacherDto,
  ): Promise<TeacherResponseDto> {
    const notice = await this.dataSource.transaction(async (manager) => {
      const campusScope = await this.campusScope(scope, 'update', manager);
      const teacher = await this.findVisible(manager, scope, campusScope, id);
      const user = await lockUser(manager, teacher.userId);
      // Reglas de gestión siempre (aunque solo cambie el perfil).
      const change = await this.users.applyPersonalChanges(
        manager,
        scope,
        user,
        campusScope,
        personalFields(dto),
      );
      const changes = pickDefined(dto, ['academicDegree', 'specialty']);
      if (Object.keys(changes).length) {
        await manager
          .getRepository(TeacherEntity)
          .update({ id: teacher.id }, changes);
      }
      return change;
    });
    this.users.notifyEmailChange(notice);
    return this.findOne(scope, id);
  }

  /** Docente de la institución; con alcance por sede, con asignación en esas sedes. */
  private async findVisible(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
    id: string,
  ): Promise<TeacherEntity> {
    const teacher = await this.baseQuery(manager, scope, campusScope)
      .andWhere('t.id = :id', { id })
      .getOne();
    if (!teacher) throw new NotFoundException('Docente no encontrado');
    return teacher;
  }

  private baseQuery(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
  ): SelectQueryBuilder<TeacherEntity> {
    const qb = manager
      .getRepository(TeacherEntity)
      .createQueryBuilder('t')
      .innerJoinAndSelect('t.user', 'u')
      .where('t.institution_id = :institutionId', {
        institutionId: scope.institutionId,
      })
      // Defensa adicional: los perfiles nunca son de un SUPER_ADMIN.
      .andWhere(`u.user_type <> 'SUPER_ADMIN'`)
      // Sin asignaciones en la institución ya no pertenece a ella.
      .andWhere(
        'EXISTS (SELECT 1 FROM user_institution_roles m WHERE m.user_id = t.user_id AND m.institution_id = t.institution_id)',
      );
    if (campusScope) {
      qb.andWhere(
        campusScope.length
          ? `EXISTS (SELECT 1 FROM user_institution_roles uir WHERE ${TEACHER_ASSIGNMENT} AND uir.campus_id IN (:...campusScope))`
          : 'false',
        { campusScope },
      );
    }
    return qb;
  }

  private campusScope(
    scope: UsersScope,
    action: PermissionAction,
    manager?: EntityManager,
  ): Promise<CampusScope> {
    return this.permissions.campusScope(
      scope.user.userId,
      scope.institutionId,
      TEACHERS_PERMISSION,
      action,
      { manager },
    );
  }
}
