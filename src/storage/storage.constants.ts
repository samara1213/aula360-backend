/** Tamaño máximo de avatares y logos. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Lado máximo (px) con el que se guardan avatares y logos. */
export const IMAGE_MAX_DIMENSION = 512;

/** Píxeles máximos de la imagen recibida (evita imágenes "bomba"). */
export const IMAGE_MAX_INPUT_PIXELS = 4096 * 4096;

/**
 * Tamaño máximo de una petición multipart: la imagen más un margen para las
 * cabeceras del formulario. Se rechaza antes de leer el cuerpo.
 */
export const MULTIPART_MAX_BYTES = IMAGE_MAX_BYTES + 64 * 1024;

/** Tipos de imagen aceptados (sin SVG: puede llevar scripts). */
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Vida de las URLs firmadas (buckets privados). */
export const SIGNED_URL_TTL_SECONDS = 120;

export interface BucketConfig {
  public: boolean;
  fileSizeLimit: number;
  allowedMimeTypes: string[];
}

/**
 * Cache-Control (segundos) de los archivos al subirlos: los logos públicos se
 * cachean; los privados poco, para que un archivo quitado deje de verse pronto.
 */
export const CACHE_CONTROL: Record<string, string> = {
  avatars: '60',
  logos: '3600',
  'report-cards': '60',
  'report-templates': '60',
};

/** Tamaño máximo de una plantilla HTML de boletín. */
export const TEMPLATE_MAX_BYTES = 256 * 1024;

/**
 * Buckets de Aula360. Los límites se repiten en Supabase (storage:setup) como
 * segunda barrera; la validación principal la hace el backend antes de subir.
 * Solo los logos son públicos (decisión de la fase 6).
 */
export const BUCKETS = {
  avatars: {
    public: false,
    fileSizeLimit: IMAGE_MAX_BYTES,
    allowedMimeTypes: IMAGE_MIME_TYPES,
  },
  logos: {
    public: true,
    fileSizeLimit: IMAGE_MAX_BYTES,
    allowedMimeTypes: IMAGE_MIME_TYPES,
  },
  'report-cards': {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['application/pdf'],
  },
  'report-templates': {
    public: false,
    fileSizeLimit: TEMPLATE_MAX_BYTES,
    allowedMimeTypes: ['text/html'],
  },
} satisfies Record<string, BucketConfig>;

export type BucketName = keyof typeof BUCKETS;
