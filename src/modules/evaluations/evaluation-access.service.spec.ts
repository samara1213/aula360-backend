import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PermissionsReader } from '../security/permissions-reader.service';
import { UserEntity } from '../users/entities/user.entity';
import { EvaluationAccessService } from './evaluation-access.service';

const user: AuthUser = {
  userId: 'u-1',
  institutionId: 'inst-A',
  userType: 'TEACHER',
  mustChangePassword: false,
  sessionId: 'sid',
};

type Options = { excludeGlobalRole?: string; onlyGlobalRole?: string };

describe('EvaluationAccessService', () => {
  let service: EvaluationAccessService;

  const teacherRepo = { findOneBy: jest.fn() };
  const userRepo = { findOne: jest.fn() };
  const manager = {
    getRepository: jest.fn((e: unknown) =>
      e === UserEntity ? userRepo : teacherRepo,
    ),
  };
  const dataSource = { manager };
  const permissions = { campusScope: jest.fn() };

  /** Alcances por (slug, rol): evaluaciones por otros roles, carga, TEACHER. */
  const scopes = (
    byOtherRoles: string[] | null,
    managesLoad: string[] | null,
    teacher: string[] | null,
  ) =>
    permissions.campusScope.mockImplementation(
      (_u: string, _i: string, slug: string, _a: string, o: Options) =>
        Promise.resolve(
          o.onlyGlobalRole
            ? teacher
            : slug === 'academic.teacher-assignments'
              ? managesLoad
              : byOtherRoles,
        ),
    );

  beforeEach(async () => {
    jest.clearAllMocks();
    teacherRepo.findOneBy.mockResolvedValue({ id: 't-1' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        EvaluationAccessService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(EvaluationAccessService);
  });

  it('administrador solo donde también gestiona la carga académica (M2)', async () => {
    scopes(null, ['a1'], []);
    const actor = await service.resolve(
      user,
      'evaluations.evaluations',
      'update',
    );
    expect(actor.adminScope).toEqual(['a1']);
    expect(service.isAdminOf(actor, 'a1')).toBe(true);
    expect(service.isAdminOf(actor, 'a2')).toBe(false);
  });

  it('un rol propio que copia a TEACHER (sin gestionar carga) no es administrador', async () => {
    scopes(null, [], []);
    const actor = await service.resolve(
      user,
      'evaluations.evaluations',
      'update',
    );
    expect(actor.adminScope).toEqual([]);
  });

  it('docente: solo las sedes donde su rol TEACHER le da la acción (M1/B1)', async () => {
    scopes([], [], ['a1']);
    const actor = await service.resolve(
      user,
      'evaluations.evaluations',
      'delete',
    );
    expect(actor).toMatchObject({ teacherScope: ['a1'], teacherId: 't-1' });
    expect(permissions.campusScope).toHaveBeenCalledWith(
      'u-1',
      'inst-A',
      'evaluations.evaluations',
      'delete',
      { onlyGlobalRole: 'TEACHER' },
    );
    expect(service.visibility(actor).sql).toContain(
      't.teacher_id = :actorTeacherId AND c.campus_id IN (:...teacherScope)',
    );
    expect(service.visibility(actor).sql).not.toContain('t.is_active');
    // Cuadro de notas: solo su carga activa (M1 de la fase 9b).
    expect(service.visibility(actor, { activeOnly: true }).sql).toContain(
      'c.campus_id IN (:...teacherScope) AND t.is_active = true',
    );
  });

  it('sin el rol TEACHER que dé la acción: no actúa como docente', async () => {
    scopes([], [], []);
    const actor = await service.resolve(
      user,
      'evaluations.evaluations',
      'view',
    );
    expect(actor.teacherId).toBeNull();
    expect(teacherRepo.findOneBy).not.toHaveBeenCalled();
    expect(service.visibility(actor).sql).toBe('(false OR false)');
  });

  it('dentro de una transacción, primero bloquea al usuario que actúa (B2)', async () => {
    scopes([], [], null);
    await service.resolve(
      user,
      'evaluations.evaluations',
      'create',
      manager as never,
    );
    expect(userRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
    );
  });

  it('dentro de una transacción, los alcances van por su manager y uno tras otro (M2 de la fase 11e)', async () => {
    let running = 0;
    let maxRunning = 0;
    permissions.campusScope.mockImplementation(async () => {
      maxRunning = Math.max(maxRunning, ++running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      return null;
    });
    await service.resolve(
      user,
      'evaluations.evaluations',
      'create',
      manager as never,
    );
    expect(permissions.campusScope).toHaveBeenCalledTimes(3);
    for (const call of permissions.campusScope.mock.calls) {
      expect((call as unknown[])[4]).toEqual(
        expect.objectContaining({ manager }),
      );
    }
    expect(maxRunning).toBe(1);
  });
});
