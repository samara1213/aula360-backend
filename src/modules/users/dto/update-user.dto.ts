import { PartialType } from '@nestjs/swagger';
import { UserPersonalDataDto } from './create-user.dto';

/**
 * Nombres y teléfono: cualquier usuario gestionable de la institución.
 * Documento: solo si el usuario pertenece únicamente a esta institución (y a
 * las sedes de quien actúa), o lo hace un SUPER_ADMIN.
 * Email: con la misma exclusividad; uno nuevo queda pendiente hasta que su
 * dueño lo confirme (tarea 2.11.6) y null lo quita de inmediato.
 */
export class UpdateUserDto extends PartialType(UserPersonalDataDto) {}

/** Columnas NOT NULL: en la actualización no se aceptan como null. */
export const USER_NOT_NULL_FIELDS = [
  'documentType',
  'documentNumber',
  'firstName',
  'lastName',
] as const;
