import { BadRequestException } from '@nestjs/common';

/**
 * En los DTOs de actualización (PartialType) @IsOptional también deja pasar null.
 * Para columnas NOT NULL se rechaza explícitamente con 400.
 */
export function rejectNullFields<T extends object>(
  dto: T,
  fields: readonly (keyof T & string)[],
): void {
  const nulls = fields.filter((field) => dto[field] === null);
  if (nulls.length) {
    throw new BadRequestException(
      nulls.map((field) => `${field} no puede ser nulo`),
    );
  }
}
