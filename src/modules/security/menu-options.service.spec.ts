import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { MenuOptionEntity } from './entities/menu-option.entity';
import { MenuOptionsService } from './menu-options.service';
import {
  PermissionFlags,
  PermissionsReader,
} from './permissions-reader.service';

function option(
  id: string,
  parentId: string | null,
  overrides: Partial<MenuOptionEntity> = {},
): MenuOptionEntity {
  return {
    id,
    parentId,
    name: id,
    slug: id,
    icon: null,
    displayOrder: 0,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  } as MenuOptionEntity;
}

const user: AuthUser = {
  userId: 'user-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

const FULL: PermissionFlags = {
  canCreate: true,
  canUpdate: true,
  canDelete: true,
};
const VIEW: PermissionFlags = {
  canCreate: false,
  canUpdate: false,
  canDelete: false,
};

describe('MenuOptionsService', () => {
  let service: MenuOptionsService;
  // Árbol: a -> a1 -> a11 ; b (raíz sola)
  let rows: MenuOptionEntity[];
  const repo = {
    find: jest.fn(() => Promise.resolve(rows)),
    findOne: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
    ),
    create: jest.fn((v: Partial<MenuOptionEntity>) => v),
    save: jest.fn((v: MenuOptionEntity) => Promise.resolve(v)),
  };
  const manager = {
    query: jest.fn(),
    getRepository: jest.fn(() => repo),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { effective: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    rows = [
      option('a', null, { displayOrder: 1 }),
      option('a1', 'a'),
      option('a11', 'a1'),
      option('b', null, { displayOrder: 2 }),
    ];
    const moduleRef = await Test.createTestingModule({
      providers: [
        MenuOptionsService,
        { provide: getRepositoryToken(MenuOptionEntity), useValue: repo },
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(MenuOptionsService);
  });

  describe('create', () => {
    it('crea bajo un padre de nivel 2 (queda en nivel 3) con bloqueo', async () => {
      await service.create({ name: 'X', slug: 'x', parentId: 'a1' });
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        expect.any(Array),
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'a1', displayOrder: 0 }),
      );
    });

    it('400 si quedaría en un cuarto nivel', async () => {
      await expect(
        service.create({ name: 'X', slug: 'x', parentId: 'a11' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('404 si el padre no existe', async () => {
      await expect(
        service.create({ name: 'X', slug: 'x', parentId: 'zz' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 si el slug ya existe', async () => {
      repo.save.mockRejectedValueOnce(
        Object.assign(new QueryFailedError('INSERT', [], new Error('dup')), {
          code: '23505',
        }),
      );
      await expect(
        service.create({ name: 'X', slug: 'a' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update (mover)', () => {
    it('400 si se mueve dentro de su propia rama (ciclo)', async () => {
      await expect(
        service.update('a', { parentId: 'a11' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update('a', { parentId: 'a' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 si la rama movida pasaría de 3 niveles', async () => {
      // a tiene 3 niveles; bajo b quedaría en 4.
      await expect(
        service.update('a', { parentId: 'b' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('mueve una rama de 2 niveles bajo una raíz', async () => {
      const result = await service.update('a1', { parentId: 'b' });
      expect(result.parentId).toBe('b');
    });

    it('mueve a la raíz con parentId null', async () => {
      const result = await service.update('a1', { parentId: null });
      expect(result.parentId).toBeNull();
    });

    it('400 si el nombre es null', async () => {
      await expect(
        service.update('a', { name: null as unknown as string }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('myMenu', () => {
    it('devuelve vacío sin institución activa', async () => {
      await expect(
        service.myMenu({ ...user, institutionId: null }),
      ).resolves.toEqual([]);
      expect(permissions.effective).not.toHaveBeenCalled();
    });

    it('incluye los ancestros de lo permitido, sin permiso de ver', async () => {
      permissions.effective.mockResolvedValue(new Map([['a11', FULL]]));
      const tree = await service.myMenu(user);
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('a');
      expect(tree[0].permissions.view).toBe(false);
      const leaf = tree[0].children[0].children[0];
      expect(leaf.id).toBe('a11');
      expect(leaf.permissions).toEqual({
        view: true,
        create: true,
        update: true,
        delete: true,
      });
      expect(permissions.effective).toHaveBeenCalledWith('user-1', 'inst-A');
    });

    it('excluye la rama de un ancestro inactivo', async () => {
      rows[0].isActive = false; // a inactiva
      permissions.effective.mockResolvedValue(
        new Map([
          ['a11', FULL],
          ['b', VIEW],
        ]),
      );
      const tree = await service.myMenu(user);
      expect(tree.map((n) => n.id)).toEqual(['b']);
      expect(tree[0].permissions).toEqual({
        view: true,
        create: false,
        update: false,
        delete: false,
      });
    });
  });
});
