import { NotFoundException } from '@nestjs/common';
import { ValidatedFile } from '../../src/storage/image-file.pipe';
import { BucketName, BUCKETS } from '../../src/storage/storage.constants';
import {
  buildObjectPath,
  StorageService,
} from '../../src/storage/storage.service';

/**
 * Storage en memoria para las e2e: mismas rutas y reglas que StorageService,
 * sin subir archivos reales a Supabase.
 */
export class FakeStorageService implements Pick<
  StorageService,
  'upload' | 'removeQuietly' | 'createSignedUrl' | 'publicUrl' | 'download'
> {
  readonly objects = new Map<string, ValidatedFile>();

  has(bucket: BucketName, path: string | null): boolean {
    return path !== null && this.objects.has(`${bucket}/${path}`);
  }

  upload(
    bucket: BucketName,
    prefix: string,
    file: ValidatedFile,
  ): Promise<string> {
    const path = buildObjectPath(prefix, file.extension);
    this.objects.set(`${bucket}/${path}`, file);
    return Promise.resolve(path);
  }

  download(bucket: BucketName, path: string): Promise<Buffer> {
    const file = this.objects.get(`${bucket}/${path}`);
    if (!file) {
      return Promise.reject(new Error(`No existe ${bucket}/${path}`));
    }
    return Promise.resolve(file.buffer);
  }

  removeQuietly(bucket: BucketName, path: string): Promise<void> {
    this.objects.delete(`${bucket}/${path}`);
    return Promise.resolve();
  }

  createSignedUrl(bucket: BucketName, path: string): Promise<string> {
    if (!this.has(bucket, path)) {
      return Promise.reject(new NotFoundException('Archivo no encontrado'));
    }
    return Promise.resolve(`https://fake.storage/sign/${bucket}/${path}?t=1`);
  }

  publicUrl(bucket: BucketName, path: string | null): string | null {
    if (!path) return null;
    if (!BUCKETS[bucket].public) {
      throw new Error(`El bucket ${bucket} es privado`);
    }
    return `https://fake.storage/public/${bucket}/${path}`;
  }
}
