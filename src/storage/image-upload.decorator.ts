import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiPayloadTooLargeResponse,
} from '@nestjs/swagger';
import { IMAGE_MAX_BYTES } from './storage.constants';

/**
 * Recibe una imagen en `multipart/form-data` (campo `file`) en memoria.
 * Multer corta el cuerpo al pasar del límite (413) y rechaza campos extra.
 * Se combina con ImageFilePipe en @UploadedFile().
 */
export function ImageUpload(): MethodDecorator {
  return applyDecorators(
    UseInterceptors(
      FileInterceptor('file', {
        limits: {
          fileSize: IMAGE_MAX_BYTES,
          files: 1,
          fields: 0,
          parts: 1,
        },
      }),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: 'JPEG, PNG o WEBP, máximo 2 MB',
          },
        },
      },
    }),
    ApiBadRequestResponse({
      description: 'Falta la imagen o formato inválido',
    }),
    ApiPayloadTooLargeResponse({ description: 'La imagen supera 2 MB' }),
  );
}
