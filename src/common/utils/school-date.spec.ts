import { schoolToday } from './school-date';

describe('schoolToday', () => {
  it('usa la fecha de Colombia (UTC-5), no la UTC', () => {
    // 2026-03-11 02:00 UTC = 2026-03-10 21:00 en Bogotá.
    expect(schoolToday(new Date('2026-03-11T02:00:00Z'))).toBe('2026-03-10');
    expect(schoolToday(new Date('2026-03-11T05:00:00Z'))).toBe('2026-03-11');
  });
});
