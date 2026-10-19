import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { buildObjectPath, StorageService } from './storage.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe('StorageService', () => {
  const bucket = {
    upload: jest.fn(),
    remove: jest.fn(),
    createSignedUrl: jest.fn(),
    getPublicUrl: jest.fn((path: string) => ({
      data: { publicUrl: `https://x.supabase.co/public/${path}` },
    })),
  };
  const from = jest.fn(() => bucket);
  let service: StorageService;
  const file = {
    buffer: Buffer.from('img'),
    mimeType: 'image/png',
    extension: 'png',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (createClient as jest.Mock).mockReturnValue({ storage: { from } });
    const config = {
      getOrThrow: jest.fn((key: string) => `valor-${key}`),
    } as unknown as ConfigService;
    service = new StorageService(config);
  });

  it('crea el cliente con la service_role key y sin sesión persistente', () => {
    expect(createClient).toHaveBeenCalledWith(
      'valor-SUPABASE_URL',
      'valor-SUPABASE_SERVICE_ROLE_KEY',
      expect.objectContaining({
        auth: expect.objectContaining({ persistSession: false }) as unknown,
      }),
    );
  });

  describe('upload', () => {
    it('genera el nombre (uuid + extensión del servidor) y no sobrescribe', async () => {
      bucket.upload.mockResolvedValue({ error: null });
      const path = await service.upload('logos', 'inst-1/logos', file);
      expect(path).toMatch(new RegExp(`^inst-1/logos/${UUID.source}\\.png$`));
      expect(from).toHaveBeenCalledWith('logos');
      expect(bucket.upload).toHaveBeenCalledWith(
        path,
        file.buffer,
        expect.objectContaining({ contentType: 'image/png', upsert: false }),
      );
    });

    it('502 genérico si Supabase falla (sin detalles internos)', async () => {
      bucket.upload.mockResolvedValue({
        error: { message: 'detalle interno' },
      });
      const error = await service
        .upload('logos', 'inst-1/logos', file)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as Error).message).not.toContain('detalle interno');
    });
  });

  it('remove borra la ruta y lanza el error de Supabase si falla', async () => {
    bucket.remove.mockResolvedValueOnce({ data: [], error: null });
    await expect(
      service.remove('avatars', 'users/u/a.png'),
    ).resolves.toBeUndefined();
    expect(bucket.remove).toHaveBeenCalledWith(['users/u/a.png']);
    const failure = { message: 'x', status: 503 };
    bucket.remove.mockResolvedValueOnce({ data: null, error: failure });
    await expect(service.remove('avatars', 'users/u/a.png')).rejects.toBe(
      failure,
    );
  });

  describe('createSignedUrl', () => {
    it('firma por 120 s por defecto', async () => {
      bucket.createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://signed' },
        error: null,
      });
      await expect(
        service.createSignedUrl('avatars', 'users/u/a.png'),
      ).resolves.toBe('https://signed');
      expect(bucket.createSignedUrl).toHaveBeenCalledWith('users/u/a.png', 120);
    });

    it('404 si el archivo no existe y 502 ante otros errores', async () => {
      bucket.createSignedUrl.mockResolvedValueOnce({
        data: null,
        error: { message: 'Object not found', statusCode: '404' },
      });
      await expect(
        service.createSignedUrl('avatars', 'users/u/a.png'),
      ).rejects.toBeInstanceOf(NotFoundException);
      bucket.createSignedUrl.mockResolvedValueOnce({
        data: null,
        error: { message: 'boom', status: 500 },
      });
      await expect(
        service.createSignedUrl('avatars', 'users/u/a.png'),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('publicUrl', () => {
    it('URL pública solo para buckets públicos', () => {
      expect(service.publicUrl('logos', 'inst-1/logos/a.png')).toBe(
        'https://x.supabase.co/public/inst-1/logos/a.png',
      );
      expect(service.publicUrl('logos', null)).toBeNull();
      expect(() => service.publicUrl('avatars', 'users/u/a.png')).toThrow();
    });
  });
});

describe('buildObjectPath', () => {
  it('rechaza prefijos con recorridos o caracteres extra', () => {
    expect(() => buildObjectPath('../x', 'png')).toThrow();
    expect(() => buildObjectPath('inst/../logos', 'png')).toThrow();
    expect(() => buildObjectPath('', 'png')).toThrow();
    expect(() => buildObjectPath('inst-1/logos', 'p/ng')).toThrow();
  });
});
