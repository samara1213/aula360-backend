import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PermissionsReader } from '../security/permissions-reader.service';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { PeriodEntity } from './entities/period.entity';
import { PeriodsService } from './periods.service';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

describe('PeriodsService', () => {
  let service: PeriodsService;

  const periodQb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
    getExists: jest.fn(),
  };
  const periodRepo = {
    createQueryBuilder: jest.fn(() => periodQb),
    create: jest.fn((v: unknown) => v),
    save: jest.fn((v: unknown) =>
      Promise.resolve({ id: 'p-new', ...(v as object) }),
    ),
    find: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const yearRepo = { findOne: jest.fn() };
  const repos = new Map<unknown, unknown>([
    [PeriodEntity, periodRepo],
    [AcademicYearEntity, yearRepo],
  ]);
  const manager = {
    getRepository: jest.fn((e: unknown) => repos.get(e)),
    query: jest.fn(),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { requireInstitutionWide: jest.fn() };

  const dto = (startDate: string, endDate: string) => ({
    name: 'P1',
    startDate,
    endDate,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.requireInstitutionWide.mockResolvedValue(undefined);
    manager.query.mockResolvedValue([
      { outside: false, hasReportCards: false },
    ]);
    yearRepo.findOne.mockResolvedValue({ id: 'y-1', year: 2026 });
    periodQb.getExists.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        PeriodsService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(PeriodsService);
  });

  describe('create: fechas', () => {
    it('bloquea el año (FOR UPDATE) de la institución activa y guarda', async () => {
      await service.create(admin, 'y-1', dto('2026-02-01', '2026-04-10'));
      expect(yearRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'y-1', institutionId: 'inst-A' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(periodRepo.save).toHaveBeenCalled();
    });

    it('calendario B: termina en el año siguiente', async () => {
      await expect(
        service.create(admin, 'y-1', dto('2026-08-01', '2027-06-15')),
      ).resolves.toBeDefined();
    });

    it.each([
      ['fin antes del inicio', '2026-05-01', '2026-04-30'],
      ['empieza el año anterior', '2025-12-01', '2026-01-15'],
      ['empieza el año siguiente', '2027-01-10', '2027-02-10'],
      [
        'termina después del 31/12 del año siguiente',
        '2026-11-01',
        '2028-01-01',
      ],
    ])('400: %s', async (_c, start, end) => {
      await expect(
        service.create(admin, 'y-1', dto(start, end)),
      ).rejects.toThrow(BadRequestException);
      expect(periodRepo.save).not.toHaveBeenCalled();
    });

    it('se cruza con otro periodo del año: 409 (bordes incluidos)', async () => {
      periodQb.getExists.mockResolvedValue(true);
      await expect(
        service.create(admin, 'y-1', dto('2026-04-10', '2026-06-01')),
      ).rejects.toThrow(ConflictException);
      expect(periodQb.andWhere).toHaveBeenCalledWith(
        'p.start_date <= :endDate AND p.end_date >= :startDate',
        { startDate: '2026-04-10', endDate: '2026-06-01' },
      );
    });

    it('año de otra institución: 404', async () => {
      yearRepo.findOne.mockResolvedValue(null);
      await expect(
        service.create(admin, 'y-B', dto('2026-02-01', '2026-03-01')),
      ).rejects.toThrow(NotFoundException);
    });

    it('limitado a sedes: 403 antes de tocar nada', async () => {
      permissions.requireInstitutionWide.mockRejectedValue(
        new ForbiddenException(),
      );
      await expect(
        service.create(admin, 'y-1', dto('2026-02-01', '2026-03-01')),
      ).rejects.toThrow(ForbiddenException);
      expect(yearRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      periodQb.getOne.mockResolvedValue({
        id: 'p-1',
        academicYearId: 'y-1',
        name: 'P1',
        startDate: '2026-02-01',
        endDate: '2026-04-10',
      });
    });

    it('combina con las fechas actuales y excluye el propio periodo del cruce', async () => {
      await service.update(admin, 'p-1', { endDate: '2026-04-20' });
      expect(periodQb.andWhere).toHaveBeenCalledWith('p.id <> :excludeId', {
        excludeId: 'p-1',
      });
      // update() y no save(): nunca reinserta un periodo borrado en paralelo.
      expect(periodRepo.update).toHaveBeenCalledWith(
        { id: 'p-1' },
        { name: 'P1', startDate: '2026-02-01', endDate: '2026-04-20' },
      );
      expect(periodRepo.save).not.toHaveBeenCalled();
      expect(periodQb.setLock).toHaveBeenCalledWith(
        'pessimistic_write',
        undefined,
        ['p'],
      );
    });

    it('no cambia fechas que dejen evaluaciones fuera (409)', async () => {
      manager.query.mockResolvedValue([
        { outside: true, hasReportCards: false },
      ]);
      await expect(
        service.update(admin, 'p-1', { endDate: '2026-03-01' }),
      ).rejects.toThrow(
        'Hay evaluaciones del periodo fuera de las fechas nuevas',
      );
      expect(periodRepo.update).not.toHaveBeenCalled();
    });

    it('con boletines, las fechas no cambian (409)', async () => {
      manager.query.mockResolvedValue([
        { outside: false, hasReportCards: true },
      ]);
      await expect(
        service.update(admin, 'p-1', { endDate: '2026-04-20' }),
      ).rejects.toThrow(ConflictException);
    });

    it('solo el nombre: no revalida fechas', async () => {
      await service.update(admin, 'p-1', { name: 'Periodo 1' });
      expect(periodQb.getExists).not.toHaveBeenCalled();
    });

    it('borrar bloquea el año y luego el periodo (mismo orden que editar)', async () => {
      await service.remove(admin, 'p-1');
      expect(yearRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(periodQb.setLock).toHaveBeenCalled();
      expect(periodRepo.delete).toHaveBeenCalledWith({ id: 'p-1' });
    });

    it('null en un campo obligatorio: 400', async () => {
      await expect(
        service.update(admin, 'p-1', { name: null as unknown as string }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
