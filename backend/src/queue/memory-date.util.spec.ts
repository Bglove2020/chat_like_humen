import { computeMemoryDate } from './memory-date.util';

describe('computeMemoryDate', () => {
  it('uses the previous memory date before 05:00 Asia/Shanghai', () => {
    expect(computeMemoryDate('2026-04-05T20:59:59.000Z')).toBe('2026-04-05');
  });

  it('switches to the current memory date at 05:00 Asia/Shanghai', () => {
    expect(computeMemoryDate('2026-04-05T21:00:00.000Z')).toBe('2026-04-06');
  });
});
