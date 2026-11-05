import { describe, expect, it } from 'vitest';
import { briefByDefault, briefWords } from './reminders.js';

describe('back-brief by', () => {
  const now = new Date(2026, 10, 4, 12);

  it('starts three days ahead', () => {
    expect(briefByDefault(now)).toBe('2026-11-07');
  });

  it('says when a waiting part is due, and when it’s late', () => {
    expect(briefWords({ life: 'passed', briefBy: '2026-11-05' }, now)).toBe('Back-brief by Thu 5 Nov');
    expect(briefWords({ life: 'passed', briefBy: '2026-11-04' }, now)).toBe('Back-brief by Wed 4 Nov');
    expect(briefWords({ life: 'passed', briefBy: '2026-11-03' }, now)).toBe('Back-brief was due on Tue 3 Nov');
    expect(briefWords({ life: 'active', briefBy: '2026-11-03' }, now)).toBe('');
    expect(briefWords({ life: 'passed' }, now)).toBe('');
  });
});
