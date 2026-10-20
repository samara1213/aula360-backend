import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { PUBLIC_EXTENSION } from '../swagger/enrich-document';

export const IS_PUBLIC_KEY = 'isPublic';

/** Ruta abierta: JwtAuthGuard no exige sesión (y Swagger no la documenta con cookie). */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    ApiExtension(PUBLIC_EXTENSION, true),
  );
