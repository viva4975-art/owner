import { describe, expect, it } from 'vitest';
import { type AbsentNow, mergeAbsent } from './absences.js';

const a = (start: string, end: string, kind: AbsentNow['kind'] = 'krank', id = 'e1'): AbsentNow => ({
  employee_id: id,
  name: 'Antonio Piccolo',
  kind,
  start_date: start,
  end_date: end,
  half_day: false,
  sites: ['Mensa'],
});

describe('mergeAbsent', () => {
  it('fasst lückenlose Einträge gleicher Art zusammen', () => {
    const r = mergeAbsent([
      a('2026-10-19', '2026-10-22'),
      a('2026-10-23', '2026-10-23'),
      a('2026-10-24', '2026-11-02'),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ start_date: '2026-10-19', end_date: '2026-11-02' });
  });
  it('über Wochenende hinweg, aber nicht bei echter Lücke oder anderer Art', () => {
    // Fr 23.10. → Mo 26.10.
    expect(mergeAbsent([a('2026-10-20', '2026-10-23'), a('2026-10-26', '2026-10-27')])).toHaveLength(1);
    expect(mergeAbsent([a('2026-10-20', '2026-10-21'), a('2026-10-23', '2026-10-27')])).toHaveLength(2);
    expect(
      mergeAbsent([a('2026-10-20', '2026-10-21'), a('2026-10-22', '2026-10-27', 'urlaub')]),
    ).toHaveLength(2);
    expect(
      mergeAbsent([a('2026-10-20', '2026-10-21'), a('2026-10-22', '2026-10-27', 'krank', 'e2')]),
    ).toHaveLength(2);
  });
});
