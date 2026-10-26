import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  dueDateOf,
  dueRecurring,
  markRecurringPaid,
  periodsOf,
  purposeFor,
  recentRecurringPaid,
  saveRecurring,
  undoRecurringPaid,
} from './recurring-payments.js';
import { BusinessError } from './errors.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe('Wiederkehrende Zahlungen – Fälligkeiten', () => {
  it('Turnus, letzter Tag, Platzhalter', () => {
    expect(
      periodsOf({ cycle: 'quartalsweise', start_month: '2026-03-01', end_month: null }, '2026-12-01'),
    ).toEqual(['2026-03-01', '2026-06-01', '2026-09-01', '2026-12-01']);
    expect(
      periodsOf({ cycle: 'monatlich', start_month: '2026-11-01', end_month: '2026-12-01' }, '2027-03-01'),
    ).toEqual(['2026-11-01', '2026-12-01']);
    expect(dueDateOf('2026-02-01', 31)).toBe('2026-02-28');
    expect(purposeFor('USt {vormonat} / {quartal} / {vorquartal}', '2026-01-01')).toBe(
      'USt 12/2025 / Q1/2026 / Q4/2025',
    );
  });
});

describe.skipIf(!available)('Wiederkehrende Zahlungen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('erscheint im Fälligkeitsmonat, bleibt überfällig stehen, bezahlt genau einmal, zurücknehmen', async () => {
    const miete = randomUUID();
    const ust = randomUUID();
    const base = {
      iban: 'DE02 1203 0000 0000 2020 51',
      purpose: 'Miete {monat}',
      cycle: 'monatlich',
      due_day: 3,
      start_month: '2026-09',
      end_month: null,
      method: 'ueberweisung',
      category: 'miete',
      note: null,
      active: true,
    };
    await saveRecurring(
      sql,
      miete,
      { ...base, name: 'Büromiete', payee: 'Vermieter', amount_cents: 150000n },
      null,
      't',
    );
    await saveRecurring(
      sql,
      miete,
      { ...base, name: 'Büromiete', payee: 'Vermieter', amount_cents: 150000n },
      null,
      't',
    );
    await saveRecurring(
      sql,
      ust,
      {
        ...base,
        name: 'USt-VA',
        payee: 'Finanzamt München',
        amount_cents: null,
        cycle: 'quartalsweise',
        due_day: 10,
        start_month: '2026-10',
        method: 'lastschrift',
        iban: null,
      },
      null,
      't',
    );
    const due = await dueRecurring(sql, '2026-10-15');
    expect(due.map((d) => `${d.payment.name}|${d.period}`)).toEqual([
      'Büromiete|2026-09-01',
      'Büromiete|2026-10-01',
      'USt-VA|2026-10-01',
    ]);
    await expect(
      markRecurringPaid(
        sql,
        { items: [{ key: `${ust}|2026-10-01`, amount_cents: null }], date: '2026-10-10', note: null },
        't',
      ),
    ).rejects.toBeInstanceOf(BusinessError);
    const n = await markRecurringPaid(
      sql,
      {
        items: [
          { key: `${miete}|2026-09-01`, amount_cents: null },
          { key: `${ust}|2026-10-01`, amount_cents: 432112n },
        ],
        date: '2026-10-10',
        note: null,
      },
      't',
    );
    expect(n).toBe(2);
    const again = await markRecurringPaid(
      sql,
      { items: [{ key: `${miete}|2026-09-01`, amount_cents: null }], date: '2026-10-10', note: null },
      't',
    );
    expect(again).toBe(0);
    expect((await dueRecurring(sql, '2026-10-15')).map((d) => d.period)).toEqual(['2026-10-01']);
    const [paid] = (await recentRecurringPaid(sql, 9999)).filter((r) => r.recurring_id === ust);
    await undoRecurringPaid(sql, paid!.id, 't');
    expect((await dueRecurring(sql, '2026-10-15')).length).toBe(2);
    await expect(
      saveRecurring(
        sql,
        randomUUID(),
        { ...base, name: 'X', payee: 'Y', amount_cents: 1n, iban: 'DE00 1234' },
        null,
        't',
      ),
    ).rejects.toBeInstanceOf(BusinessError);
  });
});
