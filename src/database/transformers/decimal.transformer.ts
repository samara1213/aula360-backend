import { ValueTransformer } from 'typeorm';

/** Postgres devuelve DECIMAL como string; en código se maneja como number. */
export const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value == null ? value : parseFloat(value)),
};
