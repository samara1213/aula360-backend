import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
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
import { UserInstitutionRoleEntity } from '../security/entities/user-institution-role.entity';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import { RoleAssignmentsService } from '../security/role-assignments.service';
import {
  CreatedStudentResponseDto,
  StudentResponseDto,
  StudentSummaryDto,
} from './dto/profile-response.dto';
import {
  CreateStudentDto,
  StudentQueryDto,
  UpdateStudentDto,
} from './dto/student.dto';
import { StudentEntity } from './entities/student.entity';
import { ManagedUsersService, UsersScope } from './managed-users.service';
import {
  globalRoleId,
  lockUser,
  personalFields,
  pickDefined,
} from './profiles.shared';

export const STUDENTS_PERMISSION = 'people.students';

/** Puede editar a ese estudiante: toda la institución o la sede del estudiante. */
function canEdit(
  updateScope: CampusScope,
  student: Pick<StudentEntity, 'campusId'>,
): boolean {
  return (
    updateScope === null ||
    (student.campusId !== null && updateScope.includes(student.campusId))
  );
}

const STUDENT_CODE_CONSTRAINT = 'students_institution_id_student_code_key';

const PROFILE_FIELDS = [
  'studentCode',
  'guardianName',
  'guardianPhone',
  'guardianEmail',
  'bloodType',
] as const;

/**
 * Estudiantes de la institución activa (perfil `students` + su usuario).
 * Alta: usuario STUDENT, rol global STUDENT en la sede del estudiante y perfil,
 * en una transacción y con las mismas reglas que /users. Su sede es la del
 * perfil (`students.campus_id`) y la de su rol: cambiarla mueve ambas.
 * Alcance por sede: solo los estudiantes de esas sedes (los sin sede, no).
 * Solo son visibles quienes conservan alguna asignación en la institución.
 * Dato mínimo necesario (Ley 1581, menores): quien solo puede ver (p. ej. un
 * docente) recibe nombres, código, sede y estado; documento, contacto y
 * acudiente solo para quien puede editar a ESE estudiante, y `blood_type`
 * además nunca va en listados. Tampoco puede buscar por documento.
 * Cambiar la sede exige `update` sobre el estudiante y `create` en la sede
 * nueva (se valida como una asignación nueva). El propio estudiante consultará
 * sus datos por un endpoint aparte (no por aquí: no se gestiona a sí mismo).
 */
@Injectable()
export class StudentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
    private readonly users: ManagedUsersService,
    private readonly assignments: RoleAssignmentsService,
  ) {}

  async findAll(
    scope: UsersScope,
    query: StudentQueryDto,
  ): Promise<Paginated<StudentSummaryDto>> {
    const campusScope = await this.campusScope(scope, 'view');
    const updateScope = await this.campusScope(scope, 'update');
    const qb = this.baseQuery(this.dataSource.manager, scope, campusScope);
    if (query.campusId) {
      qb.andWhere('s.campus_id = :campusId', { campusId: query.campusId });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('u.is_active = :isActive', { isActive: query.isActive });
    }
    if (query.search) {
      // Por documento solo entre los estudiantes que puede editar.
      const byDocument =
        updateScope === null
          ? 'u.document_number ILIKE :pattern'
          : updateScope.length
            ? '(u.document_number ILIKE :pattern AND s.campus_id IN (:...editableCampuses))'
            : 'false';
      qb.andWhere(
        `(u.first_name ILIKE :pattern OR u.last_name ILIKE :pattern OR (u.first_name || ' ' || u.last_name) ILIKE :pattern OR ${byDocument} OR s.student_code ILIKE :pattern)`,
        {
          pattern: containsPattern(query.search),
          editableCampuses: updateScope,
        },
      );
    }
    qb.orderBy('u.last_name', 'ASC')
      .addOrderBy('u.first_name', 'ASC')
      .addOrderBy('s.id', 'ASC');
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((s) => StudentSummaryDto.from(s, canEdit(updateScope, s))),
      total,
      query,
    );
  }

  async findOne(scope: UsersScope, id: string): Promise<StudentResponseDto> {
    const manager = this.dataSource.manager;
    const campusScope = await this.campusScope(scope, 'view');
    const student = await this.findVisible(manager, scope, campusScope, id);

    // Documento, contacto, acudiente y tipo de sangre: solo para quien puede
    // editar a ESTE estudiante.
    const updateScope = await this.campusScope(scope, 'update');
    if (!canEdit(updateScope, student)) {
      return StudentResponseDto.fromDetail(student, undefined);
    }
    return this.fullDetail(manager, student);
  }

  async create(
    scope: UsersScope,
    dto: CreateStudentDto,
  ): Promise<CreatedStudentResponseDto> {
    const { password, hash } = await this.users.newTemporaryPassword();
    const campusId = dto.campusId ?? null;
    const { response, userId } = await this.dataSource.transaction(
      async (manager) => {
        const roleId = await globalRoleId(manager, 'STUDENT');
        const newUserId = await this.users.insertUserWithAssignment(
          manager,
          scope,
          {
            ...personalFields(dto),
            documentType: dto.documentType,
            documentNumber: dto.documentNumber,
            firstName: dto.firstName,
            lastName: dto.lastName,
            userType: 'STUDENT',
            roleId,
            campusId,
          },
          hash,
        );
        const id = await this.insertStudent(manager, {
          userId: newUserId,
          institutionId: scope.institutionId,
          campusId,
          studentCode: dto.studentCode ?? null,
          guardianName: dto.guardianName ?? null,
          guardianPhone: dto.guardianPhone ?? null,
          guardianEmail: dto.guardianEmail ?? null,
          bloodType: dto.bloodType ?? null,
        });
        // La respuesta se arma aquí y no con findOne: quien puede crear pero
        // no ver no debe perder la contraseña temporal (404).
        const created = await this.findVisible(manager, scope, null, id);
        return {
          response: await this.fullDetail(manager, created),
          userId: newUserId,
        };
      },
    );
    await this.users.afterCreate(scope, userId, password, {
      profile: 'student',
      campusId,
    });
    return { ...response, temporaryPassword: password };
  }

  async update(
    scope: UsersScope,
    id: string,
    dto: UpdateStudentDto,
  ): Promise<StudentResponseDto> {
    await this.dataSource.transaction(async (manager) => {
      const campusScope = await this.campusScope(scope, 'update');
      const found = await this.findVisible(manager, scope, campusScope, id);
      const user = await lockUser(manager, found.userId);
      // Se relee (FOR UPDATE) con el usuario ya bloqueado: un cambio de sede
      // en paralelo ya terminó y aquí se ve su resultado.
      const student = await this.findVisible(manager, scope, campusScope, id, {
        lock: true,
      });
      // Reglas de gestión siempre (aunque solo cambie el perfil).
      await this.users.applyPersonalChanges(
        manager,
        scope,
        user,
        campusScope,
        personalFields(dto),
      );

      const changes: Partial<StudentEntity> = pickDefined(dto, PROFILE_FIELDS);
      if (dto.campusId !== undefined && dto.campusId !== student.campusId) {
        await this.moveCampus(manager, scope, student, dto.campusId);
        changes.campusId = dto.campusId;
      }
      if (Object.keys(changes).length) {
        await this.saveStudentChanges(manager, student.id, changes);
      }
    });
    return this.findOne(scope, id);
  }

  /**
   * Cambia la sede del estudiante y mueve su rol STUDENT a la sede nueva. La
   * sede nueva se valida como una asignación nueva (su alcance, activa y de
   * la institución). Si su rol STUDENT no está en la sede del perfil, no se
   * mueve nada (409): el perfil y el rol nunca quedan en sedes distintas.
   */
  private async moveCampus(
    manager: EntityManager,
    scope: UsersScope,
    student: StudentEntity,
    campusId: string | null,
  ): Promise<void> {
    const roleId = await globalRoleId(manager, 'STUDENT');
    await this.assignments.validateAssignment(manager, scope, roleId, campusId);
    let affected: number | undefined;
    try {
      ({ affected } = await manager
        .getRepository(UserInstitutionRoleEntity)
        .createQueryBuilder()
        .update()
        .set({ campusId })
        .where(
          'user_id = :userId AND institution_id = :institutionId AND role_id = :roleId AND campus_id IS NOT DISTINCT FROM :previous',
          {
            userId: student.userId,
            institutionId: scope.institutionId,
            roleId,
            previous: student.campusId,
          },
        )
        .execute());
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        throw new ConflictException(
          'El estudiante ya tiene el rol STUDENT en esa sede',
        );
      }
      throw error;
    }
    if (affected !== 1) {
      throw new ConflictException(
        'El rol STUDENT del estudiante no coincide con su sede',
      );
    }
  }

  /** Detalle completo: incluye el tipo de sangre (columna con select: false). */
  private async fullDetail(
    manager: EntityManager,
    student: StudentEntity,
  ): Promise<StudentResponseDto> {
    const row = await manager
      .getRepository(StudentEntity)
      .createQueryBuilder('s')
      .select('s.id')
      .addSelect('s.bloodType')
      .where('s.id = :id', { id: student.id })
      .getOneOrFail();
    return StudentResponseDto.fromDetail(student, {
      bloodType: row.bloodType,
    });
  }

  private async insertStudent(
    manager: EntityManager,
    values: Partial<StudentEntity>,
  ): Promise<string> {
    try {
      const result = await manager.getRepository(StudentEntity).insert(values);
      return (result.identifiers[0] as { id: string }).id;
    } catch (error) {
      throw this.mapStudentCodeConflict(error);
    }
  }

  private async saveStudentChanges(
    manager: EntityManager,
    id: string,
    changes: Partial<StudentEntity>,
  ): Promise<void> {
    try {
      await manager.getRepository(StudentEntity).update({ id }, changes);
    } catch (error) {
      throw this.mapStudentCodeConflict(error);
    }
  }

  private mapStudentCodeConflict(error: unknown): unknown {
    const driver = (error as { driverError?: { constraint?: string } })
      .driverError;
    if (
      error instanceof QueryFailedError &&
      driver?.constraint === STUDENT_CODE_CONSTRAINT
    ) {
      return new ConflictException(
        'Ya existe un estudiante con ese código en la institución',
      );
    }
    return error;
  }

  /** Estudiante de la institución; con alcance por sede, de esas sedes. */
  private async findVisible(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
    id: string,
    { lock = false }: { lock?: boolean } = {},
  ): Promise<StudentEntity> {
    const qb = this.baseQuery(manager, scope, campusScope).andWhere(
      's.id = :id',
      { id },
    );
    // FOR UPDATE OF s: la sede (join externo) no se puede bloquear.
    if (lock) qb.setLock('pessimistic_write', undefined, ['s']);
    const student = await qb.getOne();
    if (!student) throw new NotFoundException('Estudiante no encontrado');
    return student;
  }

  private baseQuery(
    manager: EntityManager,
    scope: UsersScope,
    campusScope: CampusScope,
  ): SelectQueryBuilder<StudentEntity> {
    const qb = manager
      .getRepository(StudentEntity)
      .createQueryBuilder('s')
      .innerJoinAndSelect('s.user', 'u')
      .leftJoinAndSelect('s.campus', 'c')
      .where('s.institution_id = :institutionId', {
        institutionId: scope.institutionId,
      })
      // Defensa adicional: los perfiles nunca son de un SUPER_ADMIN.
      .andWhere(`u.user_type <> 'SUPER_ADMIN'`)
      // Sin asignaciones en la institución ya no pertenece a ella.
      .andWhere(
        'EXISTS (SELECT 1 FROM user_institution_roles m WHERE m.user_id = s.user_id AND m.institution_id = s.institution_id)',
      );
    if (campusScope) {
      qb.andWhere(
        campusScope.length ? 's.campus_id IN (:...campusScope)' : 'false',
        { campusScope },
      );
    }
    return qb;
  }

  private campusScope(
    scope: UsersScope,
    action: PermissionAction,
  ): Promise<CampusScope> {
    return this.permissions.campusScope(
      scope.user.userId,
      scope.institutionId,
      STUDENTS_PERMISSION,
      action,
    );
  }
}
