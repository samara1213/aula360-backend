import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PermissionAction } from '../../common/decorators/require-permission.decorator';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { TEACHER_ASSIGNMENTS_PERMISSION } from '../academic/teacher-assignments.service';
import {
  CampusScope,
  PermissionsReader,
} from '../security/permissions-reader.service';
import { TeacherEntity } from '../users/entities/teacher.entity';
import { UserEntity } from '../users/entities/user.entity';

/**
 * Quién actúa sobre evaluaciones y notas:
 * - adminScope: sedes donde es "administrador": un rol DISTINTO del TEACHER
 *   global le da la acción pedida Y además le deja editar la carga académica
 *   (hallazgo M2 de la fase 9a: un rol propio que copie a TEACHER no
 *   administra las evaluaciones de otros). null = toda la institución,
 *   [] = ninguna.
 * - teacherScope: sedes (activas) donde su rol TEACHER global le da la acción
 *   pedida, sin sumar los permisos de sus otros roles. Como docente solo
 *   actúa sobre su propia carga y en esas sedes.
 * - teacherId: su perfil de docente, si teacherScope no está vacío.
 */
export interface EvaluationActor {
  institutionId: string;
  userId: string;
  adminScope: CampusScope;
  teacherScope: CampusScope;
  teacherId: string | null;
}

/** Intersección de alcances por sede (null = toda la institución). */
function intersect(a: CampusScope, b: CampusScope): CampusScope {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((campusId) => b.includes(campusId));
}

@Injectable()
export class EvaluationAccessService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  /**
   * Con manager (escrituras), dentro de la transacción: primero bloquea al
   * usuario que actúa (FOR SHARE). Asignar o quitar roles bloquea esa misma
   * fila (FOR UPDATE), así que sus roles no cambian hasta el fin de la
   * operación (hallazgo B2 de la fase 9a).
   */
  async resolve(
    user: AuthUser,
    slug: string,
    action: PermissionAction,
    manager?: EntityManager,
  ): Promise<EvaluationActor> {
    const institutionId = activeInstitutionId(user);
    if (manager) {
      await manager.getRepository(UserEntity).findOne({
        select: { id: true },
        where: { id: user.userId },
        lock: { mode: 'pessimistic_read' },
      });
    }
    const scope = (s: string, a: PermissionAction, role: object) =>
      this.permissions.campusScope(user.userId, institutionId, s, a, role);
    const [byOtherRoles, managesLoad, teacherScope] = await Promise.all([
      scope(slug, action, { excludeGlobalRole: 'TEACHER' }),
      scope(TEACHER_ASSIGNMENTS_PERMISSION, 'update', {
        excludeGlobalRole: 'TEACHER',
      }),
      scope(slug, action, { onlyGlobalRole: 'TEACHER' }),
    ]);
    let teacherId: string | null = null;
    if (teacherScope === null || teacherScope.length) {
      const teacher = await (manager ?? this.dataSource.manager)
        .getRepository(TeacherEntity)
        .findOneBy({ userId: user.userId, institutionId });
      teacherId = teacher?.id ?? null;
    }
    return {
      institutionId,
      userId: user.userId,
      adminScope: intersect(byOtherRoles, managesLoad),
      teacherScope,
      teacherId,
    };
  }

  /** Administra la sede del curso. */
  isAdminOf(actor: EvaluationActor, campusId: string): boolean {
    return actor.adminScope === null || actor.adminScope.includes(campusId);
  }

  /**
   * Condición SQL de visibilidad sobre la carga (alias `t`) y su curso (alias
   * `c`): cursos de las sedes que administra, o su propia carga en las sedes
   * donde su rol TEACHER le da la acción (si no, 404, sin oráculo).
   * activeOnly: la propia carga solo si sigue activa (cuadro de notas: un
   * docente reemplazado no ve lo que registra el siguiente; hallazgo M1 de
   * la fase 9b).
   */
  visibility(
    actor: EvaluationActor,
    { activeOnly = false }: { activeOnly?: boolean } = {},
  ): {
    sql: string;
    params: Record<string, unknown>;
  } {
    const byAdmin =
      actor.adminScope === null
        ? 'true'
        : actor.adminScope.length
          ? 'c.campus_id IN (:...adminScope)'
          : 'false';
    let byTeacher = 'false';
    if (actor.teacherId) {
      byTeacher =
        actor.teacherScope === null
          ? 't.teacher_id = :actorTeacherId'
          : 't.teacher_id = :actorTeacherId AND c.campus_id IN (:...teacherScope)';
      if (activeOnly) byTeacher += ' AND t.is_active = true';
    }
    return {
      sql: `(${byAdmin} OR ${byTeacher})`,
      params: {
        adminScope: actor.adminScope,
        teacherScope: actor.teacherScope,
        actorTeacherId: actor.teacherId,
      },
    };
  }
}
