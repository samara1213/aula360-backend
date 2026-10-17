import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { PermissionsReader } from '../security/permissions-reader.service';
import { GradesService } from './catalog.service';

const admin: AuthUser = {
  userId: 'admin-1',
  institutionId: 'inst-A',
  userType: 'INSTITUTION_ADMIN',
  mustChangePassword: false,
  sessionId: 'sid',
};

const pgError = (code: string) =>
  Object.assign(new QueryFailedError('SQL', [], new Error('x')), { code });

describe('CatalogService (GradesService)', () => {
  let service: GradesService;

  const repo = {
    findOne: jest.fn(),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const manager = { getRepository: jest.fn(() => repo) };
  const dataSource = {
    manager,
    getRepository: jest.fn(() => repo),
    transaction: jest.fn((work: (m: typeof manager) => unknown) =>
      work(manager),
    ),
  };
  const permissions = { requireInstitutionWide: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissions.requireInstitutionWide.mockResolvedValue(undefined);
    repo.findOne.mockResolvedValue({
      id: 'g-1',
      institutionId: 'inst-A',
      name: 'Sexto',
      createdAt: new Date(),
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        GradesService,
        { provide: DataSource, useValue: dataSource },
        { provide: PermissionsReader, useValue: permissions },
      ],
    }).compile();
    service = moduleRef.get(GradesService);
  });

  it('busca por id E institución activa (otra institución = 404)', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findOne(admin, 'g-B')).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: 'g-B', institutionId: 'inst-A' },
    });
  });

  it('limitado a sedes: 403 antes de buscar', async () => {
    permissions.requireInstitutionWide.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(service.remove(admin, 'g-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('editar bloquea la fila y usa update() (no revive un borrado)', async () => {
    const res = await service.update(admin, 'g-1', { name: 'Séptimo' });
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'g-1' },
      { name: 'Séptimo' },
    );
    expect(repo.save).not.toHaveBeenCalled();
    expect(res.name).toBe('Séptimo');
  });

  it('nombre repetido: 409', async () => {
    repo.update.mockRejectedValue(pgError('23505'));
    await expect(
      service.update(admin, 'g-1', { name: 'Séptimo' }),
    ).rejects.toThrow(ConflictException);
  });

  it('borrar en uso (FK RESTRICT): 409', async () => {
    repo.delete.mockRejectedValue(pgError('23503'));
    await expect(service.remove(admin, 'g-1')).rejects.toThrow(
      'El grado tiene cursos: no se puede borrar',
    );
  });
});
