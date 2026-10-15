import { BucketApi, setupBuckets } from './setup-buckets';
import { BUCKETS } from './storage.constants';

describe('setupBuckets', () => {
  const api = {
    getBucket: jest.fn(),
    createBucket: jest.fn().mockResolvedValue({ error: null }),
    updateBucket: jest.fn().mockResolvedValue({ error: null }),
  };

  beforeEach(() => jest.clearAllMocks());

  it('crea los que faltan, corrige los distintos y deja los iguales', async () => {
    api.getBucket.mockImplementation((id: string) => {
      if (id === 'avatars') return { data: null, error: { message: 'nf' } };
      if (id === 'logos') {
        // Existe pero privado: hay que ajustarlo.
        return {
          data: {
            public: false,
            file_size_limit: BUCKETS.logos.fileSizeLimit,
            allowed_mime_types: BUCKETS.logos.allowedMimeTypes,
          },
          error: null,
        };
      }
      const cfg = BUCKETS['report-cards'];
      return {
        data: {
          public: cfg.public,
          file_size_limit: cfg.fileSizeLimit,
          allowed_mime_types: cfg.allowedMimeTypes,
        },
        error: null,
      };
    });

    const result = await setupBuckets(api);

    expect(result).toEqual({
      avatars: 'creado',
      logos: 'actualizado',
      'report-cards': 'sin cambios',
    });
    expect(api.createBucket).toHaveBeenCalledWith('avatars', BUCKETS.avatars);
    expect(api.updateBucket).toHaveBeenCalledWith('logos', BUCKETS.logos);
  });

  it('solo los logos son públicos', () => {
    expect(BUCKETS.logos.public).toBe(true);
    expect(BUCKETS.avatars.public).toBe(false);
    expect(BUCKETS['report-cards'].public).toBe(false);
  });

  it('falla con mensaje claro si Supabase rechaza la creación', async () => {
    api.getBucket.mockResolvedValue({ data: null, error: { message: 'nf' } });
    api.createBucket.mockResolvedValueOnce({ error: { message: 'denied' } });
    await expect(setupBuckets(api as unknown as BucketApi)).rejects.toThrow(
      /avatars.*denied/,
    );
  });
});
