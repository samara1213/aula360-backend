import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Cuerpo de todo error (AllExceptionsFilter y la verificación de Origin). */
export class ErrorResponseDto {
  @ApiProperty({ description: 'Código HTTP', example: 404 })
  statusCode: number;

  @ApiProperty({
    description:
      'Mensaje para el usuario. En errores de validación (400) es la lista de errores. Nunca trae detalles internos.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Sede no encontrada',
  })
  message: string | string[];

  @ApiProperty({
    description: 'Nombre del status HTTP',
    example: 'NOT_FOUND',
  })
  error: string;

  @ApiPropertyOptional({
    description:
      'Código estable del error para el cliente (p. ej. PASSWORD_CHANGE_REQUIRED, REFRESH_TOKEN_ROTATED). Solo en algunos errores.',
    example: 'PASSWORD_CHANGE_REQUIRED',
  })
  code?: string;

  @ApiProperty({
    description: 'Ruta pedida (con su query string)',
    example: '/api/campuses/3f2b6c1e-8d4a-4c3e-9b1f-2a7d5e6f8a90',
  })
  path: string;

  @ApiProperty({
    description: 'Momento del error (ISO 8601, UTC)',
    format: 'date-time',
    example: '2026-10-19T14:05:00.000Z',
  })
  timestamp: string;
}
