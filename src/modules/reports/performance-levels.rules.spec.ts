import { BadRequestException } from '@nestjs/common';
import {
  defaultLevelsFor,
  levelFor,
  NATIONAL_LEVELS,
  validateLevels,
} from './performance-levels.rules';

const scale = { gradingScaleMin: 1, gradingScaleMax: 5 };

describe('performance-levels.rules', () => {
  it('los niveles nacionales cubren la escala 1-5 y se ordenan', () => {
    const shuffled = [...NATIONAL_LEVELS].reverse();
    expect(validateLevels(shuffled, scale).map((l) => l.name)).toEqual([
      'Bajo',
      'Básico',
      'Alto',
      'Superior',
    ]);
  });

  it.each([
    [
      'hueco',
      [
        { name: 'Bajo', minScore: 1, maxScore: 2.98 },
        { name: 'Alto', minScore: 3, maxScore: 5 },
      ],
      /deja un hueco/,
    ],
    [
      'cruce',
      [
        { name: 'Bajo', minScore: 1, maxScore: 3 },
        { name: 'Alto', minScore: 3, maxScore: 5 },
      ],
      /se cruza/,
    ],
    [
      'no empieza en el mínimo',
      [{ name: 'Único', minScore: 1.5, maxScore: 5 }],
      /empezar en 1.00/,
    ],
    [
      'no termina en el máximo',
      [{ name: 'Único', minScore: 1, maxScore: 4.99 }],
      /terminar en 5.00/,
    ],
    [
      'nombre repetido sin distinguir mayúsculas',
      [
        { name: 'Alto', minScore: 1, maxScore: 2.99 },
        { name: 'alto', minScore: 3, maxScore: 5 },
      ],
      /repetido/,
    ],
    [
      'mínima mayor que máxima',
      [{ name: 'Único', minScore: 5, maxScore: 1 }],
      /supera la máxima/,
    ],
  ])('400: %s', (_c, levels, message) => {
    expect(() => validateLevels(levels, scale)).toThrow(BadRequestException);
    expect(() => validateLevels(levels, scale)).toThrow(message);
  });

  it('nivel de una nota, con límites exactos en centésimas', () => {
    expect(levelFor(NATIONAL_LEVELS, 2.99)).toBe('Bajo');
    expect(levelFor(NATIONAL_LEVELS, 3)).toBe('Básico');
    expect(levelFor(NATIONAL_LEVELS, 4.59)).toBe('Alto');
    expect(levelFor(NATIONAL_LEVELS, 4.6)).toBe('Superior');
    expect(levelFor(NATIONAL_LEVELS, null)).toBeNull();
    expect(levelFor([], 4)).toBeNull();
  });

  it('niveles por defecto solo para la escala 1-5', () => {
    expect(defaultLevelsFor(scale)).toBe(NATIONAL_LEVELS);
    expect(
      defaultLevelsFor({ gradingScaleMin: 0, gradingScaleMax: 10 }),
    ).toEqual([]);
  });
});
