import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Ruta abierta: JwtAuthGuard no exige sesión. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
