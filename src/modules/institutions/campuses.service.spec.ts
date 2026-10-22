import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PermissionsReader } from '../security/permissions-reader.service';
import { CAMPUS_PERMISSION, CampusesService } from './campuses.service';
import { CampusEntity } from './entities/campus.entity';
import { InstitutionEntity } from './entities/institution.entity';

const user: AuthUser = {
  userId: 'user-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

const superUser: AuthUser = {
  userId: 'super-1',
  institutionId: null,
  userType: 'SUPER_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid-2',
};

function campus(overrides: Partial<CampusEntity> = {}): CampusEntity {
  return {
    id: 'campus-1',
    institutionId: 'inst-A',
    name: 'Principal',
    address: null,
    city: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CampusEntity;
}

describe('CampusesService', () => {
  let service: CampusesService;
  const qb = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const campuses = {
    createQueryBuilder: jest.fn(() => qb),
    findOne: jest.fn(),
    create: jest.fn((v: Partial<CampusEntity>) => v),
    save: jest.fn((v: CampusEntity) => Promise.resolve(v)),
  };
  const institutions = { existsBy: jest.fn() };
  const permissions = {
    campusScope: jest.fn(),
    // Misma regla que el real: con alcance por sede responde 403.
    requireInstitutionWide: jest.fn(
      async (
        u: AuthUser,
        institutionId: string,
        slug: string,
        action: string,
        message: string,
      ) => {
        const scope: unknown = await permissions.campusScope(
          u.userId,
          institutionId,
          slug,
          action,
        );
        if (scope) throw new ForbiddenException(message);
      },
    ),
  };

  const institutionWide = () => permissions.campusScope.mockResolvedValue(null);
  const limitedTo = (...ids: string[]) =>
    permissions.campusScope.mockResolvedValue(ids);

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampusesService,
        { provide: getRepositoryToken(CampusEntity), useValue: campuses },
        { provide: PermissionsReader, useValue: permissions },
        {
          provide: getRepositoryToken(InstitutionEntity),
          useValue: institutions,
        },
      ],
    }).compile();
    service = moduleRef.get(CampusesService);
  });

  describe('findAll', () => {
    it('filtra siempre por la institución del token', async () => {
      institutionWide();
      qb.getManyAndCount.mockResolvedValue([[campus()], 1]);

      const result = await service.findAll(user, { page: 1, limit: 20 });

      expect(qb.where).toHaveBeenCalledWith(
        'c.institution_id = :institutionId',
        { institutionId: 'inst-A' },
      );
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('c.id IN'),
        expect.anything(),
      );
      expect(result.meta.total).toBe(1);
    });

    it('limita a sus sedes si la asignación es por sede', async () => {
      limitedTo('campus-1');
      qb.getManyAndCount.mockResolvedValue([[campus()], 1]);
      await service.findAll(user, { page: 1, limit: 20 });
      expect(qb.andWhere).toHaveBeenCalledWith('c.id IN (:...scope)', {
        scope: ['campus-1'],
      });
    });

    it('403 sin institución activa', async () => {
      await expect(
        service.findAll(
          { ...user, institutionId: null },
          { page: 1, limit: 20 },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('findOne', () => {
    it('busca por id e institución (otra institución = 404)', async () => {
      institutionWide();
      campuses.findOne.mockResolvedValue(null);
      await expect(service.findOne(user, 'campus-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(campuses.findOne).toHaveBeenCalledWith({
        where: { id: 'campus-B', institutionId: 'inst-A' },
      });
    });

    it('404 si la sede está fuera de su alcance por sede', async () => {
      limitedTo('campus-1');
      await expect(service.findOne(user, 'campus-2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(campuses.findOne).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('crea en la institución del token', async () => {
      institutionWide();
      const result = await service.create(user, { name: 'Norte' });
      expect(campuses.create).toHaveBeenCalledWith({
        institutionId: 'inst-A',
        name: 'Norte',
        address: null,
        city: null,
      });
      expect(result.institutionId).toBe('inst-A');
    });

    it('calcula el alcance con el permiso de crear sedes', async () => {
      institutionWide();
      await service.create(user, { name: 'Norte' });
      expect(permissions.campusScope).toHaveBeenCalledWith(
        'user-1',
        'inst-A',
        CAMPUS_PERMISSION,
        'create',
      );
    });

    it('403 si su acceso está limitado a una sede', async () => {
      limitedTo('campus-1');
      await expect(
        service.create(user, { name: 'Norte' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(campuses.save).not.toHaveBeenCalled();
    });

    it('409 si el nombre ya existe en la institución', async () => {
      institutionWide();
      campuses.save.mockRejectedValueOnce(
        Object.assign(new QueryFailedError('INSERT', [], new Error('dup')), {
          code: '23505',
        }),
      );
      await expect(
        service.create(user, { name: 'Norte' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('actualiza solo los campos enviados y permite limpiar la ciudad', async () => {
      institutionWide();
      campuses.findOne.mockResolvedValue(
        campus({ city: 'Cali', address: 'Calle 1' }),
      );
      const result = await service.update(user, 'campus-1', { city: null });
      expect(result.city).toBeNull();
      expect(result.address).toBe('Calle 1');
      expect(result.name).toBe('Principal');
    });

    it('400 si el nombre es null', async () => {
      await expect(
        service.update(user, 'campus-1', { name: null as unknown as string }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 si la sede es de otra institución', async () => {
      institutionWide();
      campuses.findOne.mockResolvedValue(null);
      await expect(
        service.update(user, 'campus-B', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setActive', () => {
    it('desactiva lógicamente y exige el permiso de eliminar', async () => {
      institutionWide();
      campuses.findOne.mockResolvedValue(campus());
      const result = await service.setActive(user, 'campus-1', false);
      expect(result.isActive).toBe(false);
      expect(campuses.save).toHaveBeenCalled();
      expect(permissions.campusScope).toHaveBeenCalledWith(
        'user-1',
        'inst-A',
        CAMPUS_PERMISSION,
        'delete',
      );
    });
  });

  describe('SUPER_ADMIN: sedes de cualquier institución', () => {
    it('lista sin alcance por sede y filtra por la institución indicada', async () => {
      institutions.existsBy.mockResolvedValue(true);
      qb.getManyAndCount.mockResolvedValue([
        [campus({ institutionId: 'inst-B' })],
        1,
      ]);
      const result = await service.findAllOf('inst-B', { page: 1, limit: 20 });
      expect(result.data).toHaveLength(1);
      expect(qb.where).toHaveBeenCalledWith(
        'c.institution_id = :institutionId',
        {
          institutionId: 'inst-B',
        },
      );
      expect(permissions.campusScope).not.toHaveBeenCalled();
    });

    it('institución inexistente: 404 sin escribir', async () => {
      institutions.existsBy.mockResolvedValue(false);
      await expect(
        service.createOf(superUser, 'inst-X', { name: 'Norte' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(campuses.save).not.toHaveBeenCalled();
    });

    it('desactivar una sede de otra institución queda en la auditoría', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      institutions.existsBy.mockResolvedValue(true);
      campuses.findOne.mockResolvedValue(campus({ institutionId: 'inst-B' }));
      await service.setActiveOf(superUser, 'inst-B', 'campus-1', false);
      const entry = JSON.parse(String(log.mock.calls[0]?.[0])) as unknown;
      expect(entry).toEqual({
        audit: 'campus.deactivated',
        actorId: 'super-1',
        actorType: 'SUPER_ADMIN',
        scope: 'system',
        institutionId: 'inst-B',
        campusId: 'campus-1',
      });
      log.mockRestore();
    });

    it('una sede de otra institución: 404', async () => {
      institutions.existsBy.mockResolvedValue(true);
      campuses.findOne.mockResolvedValue(null);
      await expect(
        service.setActiveOf(superUser, 'inst-B', 'campus-1', false),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(campuses.findOne).toHaveBeenCalledWith({
        where: { id: 'campus-1', institutionId: 'inst-B' },
      });
    });
  });
});
