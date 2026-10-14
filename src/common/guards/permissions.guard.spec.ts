import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { RoleMenuPermissionEntity } from '../../modules/security/entities/role-menu-permission.entity';
import {
  PERMISSION_KEY,
  RequiredPermission,
  SUPER_ADMIN_ONLY_KEY,
} from '../decorators/require-permission.decorator';
import { AuthUser } from '../interfaces/auth-user.interface';
import { PermissionsGuard } from './permissions.guard';

function createQueryBuilderMock(exists: boolean) {
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getExists: jest.fn().mockResolvedValue(exists),
  };
  return qb;
}

function setup(options: {
  user?: AuthUser;
  permission?: RequiredPermission;
  superAdminOnly?: boolean;
  exists?: boolean;
}) {
  const qb = createQueryBuilderMock(options.exists ?? true);
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<RoleMenuPermissionEntity>;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === PERMISSION_KEY) return options.permission;
      if (key === SUPER_ADMIN_ONLY_KEY) return options.superAdminOnly;
      return undefined;
    }),
  } as unknown as Reflector;
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: options.user }) }),
  } as unknown as ExecutionContext;
  return { guard: new PermissionsGuard(reflector, repo), ctx, qb };
}

const teacher: AuthUser = {
  userId: 'u1',
  sessionId: 's1',
  institutionId: 'inst-1',
  userType: 'TEACHER',
  mustChangePassword: false,
};

describe('PermissionsGuard', () => {
  it('deja pasar las rutas sin requisitos de permiso', async () => {
    const { guard, ctx, qb } = setup({ user: teacher });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(qb.getExists).not.toHaveBeenCalled();
  });

  it('permite "view" si existe la fila de permiso en la institución activa', async () => {
    const { guard, ctx, qb } = setup({
      user: teacher,
      permission: { slug: 'academic.courses', action: 'view' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('uir.institution_id = :institutionId'),
      { userId: 'u1', institutionId: 'inst-1' },
    );
    // "view" no exige columnas can_*.
    expect(qb.andWhere).toHaveBeenCalledTimes(1);
    // Solo roles globales o de la misma institución de la asignación.
    expect(qb.innerJoin).toHaveBeenCalledWith(
      'p.role',
      'r',
      'r.institution_id IS NULL OR r.institution_id = uir.institution_id',
    );
  });

  it.each([
    ['create', 'p.can_create = true'],
    ['update', 'p.can_update = true'],
    ['delete', 'p.can_delete = true'],
  ] as const)('para "%s" exige la columna %s', async (action, column) => {
    const { guard, ctx, qb } = setup({
      user: teacher,
      permission: { slug: 'academic.courses', action },
    });
    await guard.canActivate(ctx);
    expect(qb.andWhere).toHaveBeenLastCalledWith(column);
  });

  it('responde 403 si no tiene el permiso', async () => {
    const { guard, ctx } = setup({
      user: teacher,
      permission: { slug: 'academic.courses', action: 'delete' },
      exists: false,
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('responde 403 si no hay institución activa', async () => {
    const { guard, ctx, qb } = setup({
      user: { ...teacher, institutionId: null },
      permission: { slug: 'academic.courses', action: 'view' },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(qb.getExists).not.toHaveBeenCalled();
  });

  it('@SuperAdminOnly rechaza a quien no es SUPER_ADMIN', async () => {
    const { guard, ctx } = setup({ user: teacher, superAdminOnly: true });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('@SuperAdminOnly permite al SUPER_ADMIN sin institución', async () => {
    const { guard, ctx } = setup({
      user: { ...teacher, userType: 'SUPER_ADMIN', institutionId: null },
      superAdminOnly: true,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('el SUPER_ADMIN no se salta @RequirePermission', async () => {
    const { guard, ctx } = setup({
      user: { ...teacher, userType: 'SUPER_ADMIN', institutionId: null },
      permission: { slug: 'academic.courses', action: 'view' },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
