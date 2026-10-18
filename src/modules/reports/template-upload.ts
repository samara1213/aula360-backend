import {
  applyDecorators,
  BadRequestException,
  Injectable,
  PipeTransform,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiPayloadTooLargeResponse,
} from '@nestjs/swagger';
import { TEMPLATE_MAX_BYTES } from '../../storage/storage.constants';

/**
 * Recibe la plantilla en `multipart/form-data`: el archivo en `file` y los
 * campos `name` y `description`. Multer corta el cuerpo al pasar del límite
 * (413). Se combina con TemplateFilePipe en @UploadedFile().
 */
export function TemplateUpload(): MethodDecorator {
  return applyDecorators(
    UseInterceptors(
      FileInterceptor('file', {
        limits: {
          fileSize: TEMPLATE_MAX_BYTES,
          files: 1,
          fields: 2,
          parts: 3,
          // 500 caracteres de hasta 4 bytes en UTF-8 (B7).
          fieldSize: 4096,
        },
      }),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['file', 'name'],
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: `HTML con variables Handlebars, UTF-8, máximo ${TEMPLATE_MAX_BYTES / 1024} KB`,
          },
          name: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
        },
      },
    }),
    ApiPayloadTooLargeResponse({
      description: 'El archivo es demasiado grande',
    }),
    ApiBadRequestResponse({
      description: 'Sin archivo, no es HTML en UTF-8 o la plantilla no compila',
    }),
  );
}

/** Contenido de la plantilla como texto; su validación la hace compileTemplate. */
@Injectable()
export class TemplateFilePipe implements PipeTransform<
  Express.Multer.File | undefined,
  string
> {
  transform(file: Express.Multer.File | undefined): string {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Falta el archivo de la plantilla (file)');
    }
    if (!/\.html?$/i.test(file.originalname ?? '')) {
      throw new BadRequestException('La plantilla debe ser un archivo .html');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new BadRequestException('La plantilla debe estar en UTF-8');
    }
  }
}
