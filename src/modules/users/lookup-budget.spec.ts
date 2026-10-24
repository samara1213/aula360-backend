import { HttpException } from '@nestjs/common';
import { LOOKUPS_PER_DAY, LookupBudget } from './lookup-budget';

const DAY_MS = 86_400_000;

function status(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as HttpException).getStatus();
  }
}

describe('LookupBudget', () => {
  it(`permite ${LOOKUPS_PER_DAY} búsquedas por institución en 24 horas y después responde 429`, () => {
    const budget = new LookupBudget();
    for (let i = 0; i < LOOKUPS_PER_DAY; i++) budget.consume('a', 1_000 + i);
    expect(status(() => budget.consume('a', 2_000))).toBe(429);
  });

  it('cada institución tiene su propio presupuesto', () => {
    const budget = new LookupBudget();
    budget.limit = 1;
    budget.consume('a', 1_000);
    expect(status(() => budget.consume('a', 1_001))).toBe(429);
    expect(status(() => budget.consume('b', 1_001))).toBeNull();
  });

  it('las búsquedas de hace más de 24 horas ya no cuentan', () => {
    const budget = new LookupBudget();
    budget.limit = 2;
    budget.consume('a', 1_000);
    budget.consume('a', 2_000);
    expect(status(() => budget.consume('a', 999 + DAY_MS))).toBe(429);
    // La de las 1 000 ya tiene 24 horas: queda una sola en la ventana.
    expect(status(() => budget.consume('a', 1_000 + DAY_MS))).toBeNull();
  });

  it('un intento rechazado no gasta presupuesto', () => {
    const budget = new LookupBudget();
    budget.limit = 1;
    budget.consume('a', 1_000);
    for (let i = 0; i < 5; i++) {
      expect(status(() => budget.consume('a', 2_000 + i))).toBe(429);
    }
    expect(status(() => budget.consume('a', 1_001 + DAY_MS))).toBeNull();
  });
});
