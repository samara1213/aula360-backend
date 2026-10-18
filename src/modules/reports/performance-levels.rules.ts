import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PerformanceLevelEntity } from './entities/performance-level.entity';

export interface LevelInput {
  name: string;
  minScore: number;
  maxScore: number;
}

interface ScaleLike {
  gradingScaleMin: number;
  gradingScaleMax: number;
}

/** Escala nacional (MEN, Decreto 1290) para la escala 1.00-5.00. */
export const NATIONAL_LEVELS: LevelInput[] = [
  { name: 'Bajo', minScore: 1, maxScore: 2.99 },
  { name: 'Básico', minScore: 3, maxScore: 3.99 },
  { name: 'Alto', minScore: 4, maxScore: 4.59 },
  { name: 'Superior', minScore: 4.6, maxScore: 5 },
];

const cents = (value: number) => Math.round(value * 100);

/** Niveles por defecto de una escala: los nacionales solo para 1-5. */
export function defaultLevelsFor(scale: ScaleLike): LevelInput[] {
  return cents(scale.gradingScaleMin) === 100 &&
    cents(scale.gradingScaleMax) === 500
    ? NATIONAL_LEVELS
    : [];
}

/**
 * Ordena por nota mínima y exige que cubran toda la escala, sin huecos ni
 * cruces, en pasos de 0.01 (las notas tienen 2 decimales). 400 con el motivo.
 */
export function validateLevels(
  levels: LevelInput[],
  scale: ScaleLike,
): LevelInput[] {
  const names = new Set<string>();
  for (const level of levels) {
    const key = level.name.toLocaleLowerCase('es');
    if (names.has(key)) {
      throw new BadRequestException(`Nivel repetido: ${level.name}`);
    }
    names.add(key);
    if (cents(level.minScore) > cents(level.maxScore)) {
      throw new BadRequestException(
        `${level.name}: la nota mínima supera la máxima`,
      );
    }
  }
  const sorted = [...levels].sort(
    (a, b) => cents(a.minScore) - cents(b.minScore),
  );
  const min = cents(scale.gradingScaleMin);
  const max = cents(scale.gradingScaleMax);
  if (cents(sorted[0].minScore) !== min) {
    throw new BadRequestException(
      `El primer nivel debe empezar en ${scale.gradingScaleMin.toFixed(2)}`,
    );
  }
  if (cents(sorted[sorted.length - 1].maxScore) !== max) {
    throw new BadRequestException(
      `El último nivel debe terminar en ${scale.gradingScaleMax.toFixed(2)}`,
    );
  }
  for (let i = 1; i < sorted.length; i++) {
    const expected = cents(sorted[i - 1].maxScore) + 1;
    const start = cents(sorted[i].minScore);
    if (start !== expected) {
      throw new BadRequestException(
        `${sorted[i].name} debe empezar en ${(expected / 100).toFixed(2)} (${
          start < expected ? 'se cruza' : 'deja un hueco'
        } con ${sorted[i - 1].name})`,
      );
    }
  }
  return sorted;
}

/** Nivel de una nota (null si no hay niveles que la cubran). */
export function levelFor(
  levels: Pick<LevelInput, 'name' | 'minScore' | 'maxScore'>[],
  score: number | null,
): string | null {
  if (score === null) return null;
  const value = cents(score);
  return (
    levels.find((l) => cents(l.minScore) <= value && value <= cents(l.maxScore))
      ?.name ?? null
  );
}

/** Reemplaza los niveles de la institución (dentro de la transacción). */
export async function replaceLevels(
  manager: EntityManager,
  institutionId: string,
  levels: LevelInput[],
): Promise<void> {
  const repo = manager.getRepository(PerformanceLevelEntity);
  await repo.delete({ institutionId });
  if (levels.length) {
    await repo.insert(
      levels.map((level, index) => ({
        institutionId,
        name: level.name,
        minScore: level.minScore,
        maxScore: level.maxScore,
        displayOrder: index + 1,
      })),
    );
  }
}
