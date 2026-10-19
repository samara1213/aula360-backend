import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StorageDeletionsService } from '../../storage/storage-deletions.service';
import { StorageService } from '../../storage/storage.service';
import { UserEntity } from './entities/user.entity';
import { UsersService } from './users.service';

describe('UsersService (avatar)', () => {
  let service: UsersService;
  const repo = { findOne: jest.fn(), update: jest.fn() };
  const manager = { getRepository: jest.fn(() => repo) };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
  };
  const storage = {
    upload: jest.fn(),
    createSignedUrl: jest.fn(),
  };
  const deletions = {
    schedule: jest.fn(),
    flush: jest.fn(),
    discard: jest.fn(),
  };
  const file = {
    buffer: Buffer.from('x'),
    mimeType: 'image/webp',
    extension: 'webp',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    storage.upload.mockResolvedValue('users/u-1/new.webp');
    storage.createSignedUrl.mockResolvedValue('https://signed');
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(UserEntity), useValue: repo },
        { provide: DataSource, useValue: dataSource },
        { provide: StorageService, useValue: storage },
        { provide: StorageDeletionsService, useValue: deletions },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('sube a users/<userId>, guarda la ruta con la fila bloqueada y anota el borrado del anterior', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u-1',
      avatarPath: 'users/u-1/old.png',
    });
    const result = await service.replaceAvatar('u-1', file);
    expect(storage.upload).toHaveBeenCalledWith('avatars', 'users/u-1', file);
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'u-1' },
      { avatarPath: 'users/u-1/new.webp' },
    );
    // En la misma transacción, y se intenta después del commit.
    expect(deletions.schedule).toHaveBeenCalledWith(
      manager,
      'avatars',
      'users/u-1/old.png',
    );
    expect(deletions.flush).toHaveBeenCalledWith(
      'avatars',
      'users/u-1/old.png',
    );
    expect(result).toEqual({
      avatarPath: 'users/u-1/new.webp',
      url: 'https://signed',
      expiresIn: 120,
    });
  });

  it('si falla la BD descarta el archivo recién subido', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.replaceAvatar('u-1', file)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(deletions.discard).toHaveBeenCalledWith(
      'avatars',
      'users/u-1/new.webp',
    );
    expect(deletions.schedule).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('quitar el avatar pone null y borra el archivo', async () => {
    repo.findOne.mockResolvedValue({
      id: 'u-1',
      avatarPath: 'users/u-1/old.png',
    });
    await service.removeAvatar('u-1');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'u-1' },
      { avatarPath: null },
    );
    expect(deletions.schedule).toHaveBeenCalledWith(
      manager,
      'avatars',
      'users/u-1/old.png',
    );
    expect(deletions.flush).toHaveBeenCalledWith(
      'avatars',
      'users/u-1/old.png',
    );
  });

  it('quitar sin avatar no toca nada', async () => {
    repo.findOne.mockResolvedValue({ id: 'u-1', avatarPath: null });
    await service.removeAvatar('u-1');
    expect(repo.update).not.toHaveBeenCalled();
    expect(deletions.schedule).not.toHaveBeenCalled();
    expect(deletions.flush).not.toHaveBeenCalled();
  });

  it('getAvatar firma la ruta guardada y 404 si no tiene', async () => {
    repo.findOne.mockResolvedValueOnce({
      id: 'u-1',
      avatarPath: 'users/u-1/a.png',
    });
    await expect(service.getAvatar('u-1')).resolves.toMatchObject({
      url: 'https://signed',
    });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'avatars',
      'users/u-1/a.png',
    );
    repo.findOne.mockResolvedValueOnce({ id: 'u-1', avatarPath: null });
    await expect(service.getAvatar('u-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
