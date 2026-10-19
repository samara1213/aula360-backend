import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { ValidatedFile } from './image-file.pipe';
import {
  BucketName,
  BUCKETS,
  CACHE_CONTROL,
  SIGNED_URL_TTL_SECONDS,
} from './storage.constants';

/** Tiempo máximo de cada llamada a Supabase Storage. */
const STORAGE_TIMEOUT_MS = 15_000;

/** Segmentos permitidos en el prefijo de una ruta (ids y nombres fijos). */
const PATH_SEGMENT = /^[A-Za-z0-9-]+$/;

const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(STORAGE_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
};

/**
 * Único acceso a Supabase Storage. Usa la service_role key (solo backend: se
 * salta las políticas de Storage), así que los permisos se comprueban antes de
 * llamar a este servicio. Los errores de Supabase se registran y se responden
 * de forma genérica, sin detalles internos.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: ReturnType<typeof createClient>;

  constructor(config: ConfigService) {
    this.client = createClient(
      config.getOrThrow<string>('SUPABASE_URL'),
      config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchWithTimeout },
      },
    );
  }

  /**
   * Sube el archivo con un nombre generado por el servidor y devuelve su ruta:
   * `<prefijo>/<uuid>.<ext>` (p. ej. `<institutionId>/logos/<uuid>.png`).
   * Nunca sobrescribe un archivo existente.
   */
  async upload(
    bucket: BucketName,
    prefix: string,
    file: ValidatedFile,
  ): Promise<string> {
    const path = buildObjectPath(prefix, file.extension);
    const { error } = await this.client.storage
      .from(bucket)
      .upload(path, file.buffer, {
        contentType: file.mimeType,
        cacheControl: CACHE_CONTROL[bucket],
        upsert: false,
      });
    if (error) {
      this.logger.error(`Fallo al subir a ${bucket}: ${error.message}`);
      throw new BadGatewayException('No se pudo guardar el archivo');
    }
    return path;
  }

  /**
   * Borra el archivo; lanza el error de Supabase si falla. Un archivo que ya
   * no existe cuenta como borrado. Solo lo usa StorageDeletionsService: los
   * demás anotan el borrado para que no se pierda si Supabase falla.
   */
  async remove(bucket: BucketName, path: string): Promise<void> {
    const { error } = await this.client.storage.from(bucket).remove([path]);
    if (error) throw error;
  }

  /** Contenido de un archivo (plantillas de boletín, logo para el PDF). */
  async download(bucket: BucketName, path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .download(path);
    if (error || !data) {
      this.logger.error(
        `Fallo al leer ${bucket}/${path}: ${error?.message ?? 'sin datos'}`,
      );
      throw new BadGatewayException('No se pudo leer el archivo');
    }
    return Buffer.from(await data.arrayBuffer());
  }

  /** URL temporal para un archivo de un bucket privado. */
  async createSignedUrl(
    bucket: BucketName,
    path: string,
    expiresIn: number = SIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn);
    if (error) {
      const { status, statusCode } = error as {
        status?: number;
        statusCode?: string;
      };
      if (status === 404 || statusCode === '404') {
        this.logger.warn(`No existe ${bucket}/${path}`);
        throw new NotFoundException('Archivo no encontrado');
      }
      this.logger.error(`Fallo al firmar ${bucket}/${path}: ${error.message}`);
      throw new BadGatewayException('No se pudo obtener el archivo');
    }
    return data.signedUrl;
  }

  /** URL permanente de un archivo de un bucket público (solo logos). */
  publicUrl(bucket: BucketName, path: string | null): string | null {
    if (!path) return null;
    if (!BUCKETS[bucket].public) {
      throw new Error(`El bucket ${bucket} es privado`);
    }
    return this.client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }
}

/** `<prefijo>/<uuid>.<ext>`; el prefijo solo admite ids y nombres fijos. */
export function buildObjectPath(prefix: string, extension: string): string {
  const segments = prefix.split('/');
  if (
    !segments.every((s) => PATH_SEGMENT.test(s)) ||
    !/^[a-z0-9]+$/.test(extension)
  ) {
    throw new Error(`Ruta de Storage inválida: ${prefix}`);
  }
  return `${prefix}/${randomUUID()}.${extension}`;
}
