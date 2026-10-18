import { describe, expect, it } from 'vitest';
import { type BillingPeriod, subcontractTodo } from './expected-invoices.js';

const p = (start: string, end: string, state: BillingPeriod['state']): BillingPeriod => ({
  start,
  end,
  state,
  invoices: [],
  skipReason: null,
});

describe('NU-Bestellung „zu erledigen“', () => {
  const signed = { status: 'erteilt', valid_to: null, signed: true };
  it('Unterschrift fehlt', () => {
    expect(subcontractTodo({ ...signed, signed: false }, [], '2026-10-10')).toEqual(['Unterschrift fehlt']);
  });
  it('laufend erst am Monatsende, fehlende Rechnung immer', () => {
    const per = [p('2026-10', '2026-10-31', 'laufend'), p('2026-09', '2026-09-30', 'abgerechnet')];
    expect(subcontractTodo(signed, per, '2026-10-20')).toEqual([]);
    expect(subcontractTodo(signed, per, '2026-10-27')).toEqual(['Monatsende – Rechnung 10/2026 erwartet']);
    expect(subcontractTodo(signed, [per[0]!, p('2026-09', '2026-09-30', 'offen')], '2026-10-05')).toEqual([
      'Rechnung 09/2026 fehlt',
    ]);
  });
  it('nach Ausführung ohne Rechnung, alte Fälle vor der Umstellung nicht', () => {
    const o = { status: 'beendet', valid_to: '2026-10-02', signed: true };
    expect(subcontractTodo(o, [p('2026-10', '2026-10-31', 'bedarf')], '2026-10-10')).toEqual([
      'ausgeführt – Rechnung fehlt',
    ]);
    expect(subcontractTodo(o, [p('2026-03', '2026-03-31', 'bedarf')], '2026-10-10')).toEqual([]);
    expect(subcontractTodo(o, [p('2026-10', '2026-10-31', 'abgerechnet')], '2026-10-10')).toEqual([]);
  });
});
