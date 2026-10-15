import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { ScoreEntity } from '../evaluations/entities/score.entity';
import { InstitutionEntity } from './entities/institution.entity';
import { InstitutionsService } from './institutions.service';

function institution(
  overrides: Partial<InstitutionEntity> = {},
): InstitutionEntity {
  return {
    id: 'inst-1',
    nit: '900',
    name: 'Colegio',
    logoPath: null,
    gradingScaleMin: 1,
    gradingScaleMax: 5,
    passingScore: 3,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function uniqueViolation(): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error('dup')), {
    code: '23505',
  });
}

describe('InstitutionsService', () => {
  let service: InstitutionsService;
  const qb = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    findOne: jest.fn(),
    create: jest.fn((v: Partial<InstitutionEntity>) => v),
    save: jest.fn((v: InstitutionEntity) => Promise.resolve(v)),
  };
  const scoresQb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getExists: jest.fn(),
  };
  const scores = { createQueryBuilder: jest.fn(() => scoresQb) };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === ScoreEntity ? scores : repo,
    ),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InstitutionsService,
        { provide: getRepositoryToken(InstitutionEntity), useValue: repo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(InstitutionsService);
  });

  describe('findAll', () => {
    it('pagina, busca escapando comodines y filtra por estado', async () => {
      qb.getManyAndCount.mockResolvedValue([[institution()], 21]);

      const result = await service.findAll({
        page: 2,
        limit: 10,
        search: '50%_x',
        isActive: false,
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(i.name ILIKE :pattern OR i.nit ILIKE :pattern)',
        { pattern: '%50\\%\\_x%' },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('i.is_active = :isActive', {
        isActive: false,
      });
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 21,
        totalPages: 3,
      });
      expect(result.data[0].id).toBe('inst-1');
    });
  });

  describe('findOne', () => {
    it('404 si no existe', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('usa la escala por defecto', async () => {
      const result = await service.create({ nit: '900', name: 'Colegio' });
      expect(repo.create).toHaveBeenCalledWith({
        nit: '900',
        name: 'Colegio',
        gradingScaleMin: 1,
        gradingScaleMax: 5,
        passingScore: 3,
      });
      expect(result.passingScore).toBe(3);
    });

    it('400 si el mínimo no es menor que el máximo', async () => {
      await expect(
        service.create({
          nit: '900',
          name: 'C',
          gradingScaleMin: 5,
          gradingScaleMax: 5,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('400 si la nota aprobatoria queda fuera de la escala', async () => {
      await expect(
        service.create({ nit: '900', name: 'C', passingScore: 6 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409 si el NIT ya existe', async () => {
      repo.save.mockRejectedValueOnce(uniqueViolation());
      await expect(
        service.create({ nit: '900', name: 'C' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('bloquea la fila dentro de una transacción', async () => {
      repo.findOne.mockResolvedValue(institution());
      await service.update('inst-1', { name: 'N' });
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('valida la escala combinando con los valores actuales', async () => {
      repo.findOne.mockResolvedValue(institution());
      await expect(
        service.update('inst-1', { gradingScaleMax: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409 si cambia la escala y ya hay notas', async () => {
      repo.findOne.mockResolvedValue(institution());
      scoresQb.getExists.mockResolvedValue(true);
      await expect(
        service.update('inst-1', { passingScore: 3.5 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(scoresQb.where).toHaveBeenCalledWith(
        'g.institution_id = :institutionId',
        { institutionId: 'inst-1' },
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('permite editar el nombre sin consultar notas', async () => {
      repo.findOne.mockResolvedValue(institution());
      const result = await service.update('inst-1', { name: 'Nuevo' });
      expect(result.name).toBe('Nuevo');
      expect(scoresQb.getExists).not.toHaveBeenCalled();
    });

    it('400 si se envía null en un campo obligatorio', async () => {
      await expect(
        service.update('inst-1', { name: null as unknown as string }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('404 si no existe', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.update('x', { name: 'N' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setActive', () => {
    it('desactiva sin borrar', async () => {
      repo.findOne.mockResolvedValue(institution());
      const result = await service.setActive('inst-1', false);
      expect(result.isActive).toBe(false);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
    });

    it('no guarda si ya está en ese estado', async () => {
      repo.findOne.mockResolvedValue(institution());
      await service.setActive('inst-1', true);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
