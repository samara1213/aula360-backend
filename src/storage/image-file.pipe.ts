import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { sharp } from './sharp';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  IMAGE_MIME_TYPES,
} from './storage.constants';

// Sin caché de libvips: cada imagen se procesa una vez y no debe quedar en memoria.
sharp.cache(false);

/** Archivo ya validado: tipo y extensión los decide el servidor, no el cliente. */
export interface ValidatedFile {
  buffer: Buffer;
  mimeType: string;
  extension: string;
}

/** Firma real (primeros bytes) de cada tipo de imagen aceptado. */
export function detectImageType(
  buffer: Buffer,
): { mimeType: string; extension: string } | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

/**
 * Valida la imagen recibida por FileInterceptor (en memoria) y la vuelve a
 * generar con sharp antes de guardarla:
 * - que exista, su tamaño, el tipo declarado y que los bytes sean de ese tipo
 *   (el tamaño ya lo corta Multer con 413; aquí se repite por si se usa sin límite);
 * - se decodifica de verdad: un archivo que solo imita la cabecera falla (400);
 * - se limita el número de píxeles (imágenes "bomba") y se reduce a 512 px;
 * - se descartan los metadatos (EXIF con GPS, modelo del celular...), lo que
 *   importa sobre todo en fotos de menores. La orientación EXIF se aplica antes.
 */
@Injectable()
export class ImageFilePipe implements PipeTransform<
  Express.Multer.File | undefined,
  Promise<ValidatedFile>
> {
  async transform(
    file: Express.Multer.File | undefined,
  ): Promise<ValidatedFile> {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        'Debe adjuntar una imagen en el campo file',
      );
    }
    if (file.size > IMAGE_MAX_BYTES) {
      throw new BadRequestException('La imagen supera el tamaño máximo (2 MB)');
    }
    const detected = detectImageType(file.buffer);
    if (
      !IMAGE_MIME_TYPES.includes(file.mimetype) ||
      !detected ||
      detected.mimeType !== file.mimetype
    ) {
      throw new BadRequestException(
        'Formato no permitido: use una imagen JPEG, PNG o WEBP',
      );
    }
    return {
      buffer: await reencode(file.buffer, detected.extension),
      ...detected,
    };
  }
}

/** Decodifica y vuelve a codificar en el mismo formato, sin metadatos. */
async function reencode(input: Buffer, extension: string): Promise<Buffer> {
  try {
    const image = sharp(input, {
      limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
      failOn: 'error',
      animated: false,
    })
      .rotate()
      .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    // Sin withMetadata(): sharp no copia EXIF, XMP ni ICC al resultado.
    if (extension === 'jpg') {
      return await image.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
    if (extension === 'png') {
      return await image.png({ compressionLevel: 9 }).toBuffer();
    }
    return await image.webp({ quality: 85 }).toBuffer();
  } catch {
    throw new BadRequestException(
      'La imagen está dañada, es demasiado grande o no se pudo procesar',
    );
  }
}
