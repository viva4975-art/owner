import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  deleteAdvance,
  listAdvances,
  offsetAdvance,
  openAdvances,
  saveAdvance,
  undoOffsets,
} from './advances.js';
import { assignParty, reopenTransaction } from './bank.js';
import { listIncoming, markPaid, paymentList } from './purchasing.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const SUP = '00000000-0000-4000-8000-00000000ad01';

describe.skipIf(!available)('Vorschüsse an Nachunternehmer', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.suppliers (id, supplier_no, name, kind) values (${SUP}, '79801', 'Glanz Sub GmbH', 'nachunternehmer')`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  const invoice = async (no: string, gross: bigint) => {
    const id = randomUUID();
    await sql`insert into app.incoming_invoices (id, supplier_id, invoice_no, invoice_date, due_date, net_cents, vat_cents,
                                                 gross_cents, category, status, created_by)
              values (${id}, ${SUP}, ${no}, '2026-10-01', '2026-10-15', ${gross}, 0, ${gross}, 'nachunternehmer', 'freigegeben', 't')`;
    return id;
  };

  it('erfassen, doppelt absenden, mit Rechnung verrechnen, Zahlbetrag sinkt, löschen erst nach Rücknahme', async () => {
    const a = randomUUID();
    const input = {
      supplierId: SUP,
      subcontractId: null,
      paidOn: '2026-09-20',
      amount: 150000n,
      method: 'ueberweisung',
      purpose: 'Abschlag',
    };
    await saveAdvance(sql, a, input, 't');
    await saveAdvance(sql, a, input, 't'); // doppelt → nichts
    expect((await listAdvances(sql, SUP)).length).toBe(1);
    expect((await openAdvances(sql, [SUP])).get(SUP)).toBe(150000n);

    const inv = await invoice('NU-1', 400000n);
    await expect(offsetAdvance(sql, inv, 200000n, 't')).rejects.toThrow(/offene Vorschuss/);
    expect(await offsetAdvance(sql, inv, null, 't')).toBe(150000n);
    expect((await openAdvances(sql, [SUP])).get(SUP)).toBeUndefined();
    const row = (await paymentList(sql, '2026-10-10')).find((x) => x.invoice.id === inv)!;
    expect(row.amount).toBe(250000n);
    await expect(deleteAdvance(sql, a, 't')).rejects.toThrow(/verrechnet/);

    await undoOffsets(sql, inv, 't');
    expect(
      (await listIncoming(sql, { supplierId: SUP })).find((x) => x.id === inv)!.advance_offset_cents,
    ).toBe(0n);
    await offsetAdvance(sql, inv, 50000n, 't');
    await markPaid(
      sql,
      { ids: [inv], date: '2026-10-05', method: 'ueberweisung', note: null, skonto: false },
      't',
    );
    const [paid] = await sql<
      { paid_amount_cents: bigint }[]
    >`select paid_amount_cents from app.incoming_invoices where id = ${inv}`;
    expect(paid!.paid_amount_cents).toBe(350000n);
    await expect(undoOffsets(sql, inv, 't')).rejects.toThrow(/bezahlt/);
  });

  it('Vorschuss ohne Verrechnung lässt sich löschen', async () => {
    const a = randomUUID();
    await saveAdvance(
      sql,
      a,
      {
        supplierId: SUP,
        subcontractId: null,
        paidOn: '2026-09-01',
        amount: 1000n,
        method: 'bar',
        purpose: null,
      },
      't',
    );
    await deleteAdvance(sql, a, 't');
    expect((await listAdvances(sql, SUP)).some((x) => x.id === a)).toBe(false);
    await expect(
      saveAdvance(
        sql,
        randomUUID(),
        {
          supplierId: SUP,
          subcontractId: null,
          paidOn: '2099-01-01',
          amount: 1000n,
          method: 'bar',
          purpose: null,
        },
        't',
      ),
    ).rejects.toThrow(/Zukunft/);
  });

  it('Kontoumsatz als Vorschuss; wieder öffnen löscht den Vorschuss', async () => {
    const imp = randomUUID();
    await sql`insert into app.bank_imports (id, filename, format, file_path, file_sha256, line_count, new_count, created_by)
              values (${imp}, 'test.csv', 'csv', ${`x/${imp}`}, ${randomUUID()}, 1, 1, 't')`;
    const tx = randomUUID();
    await sql`insert into app.bank_transactions (id, import_id, account_iban, booking_date, amount_cents, counterparty_name, purpose)
              values (${tx}, ${imp}, 'DE39701900000003297837', '2026-10-02', -80000, 'Glanz Sub GmbH', 'Abschlag Oktober')`;
    await assignParty(sql, tx, { kind: 'lieferant', id: SUP, note: null, advance: true }, 't');
    const adv = (await listAdvances(sql, SUP)).find((x) => x.bank_transaction_id === tx)!;
    expect(adv.amount_cents).toBe(80000n);
    expect(adv.paid_on).toBe('2026-10-02');
    await reopenTransaction(sql, tx, 't');
    expect((await listAdvances(sql, SUP)).some((x) => x.bank_transaction_id === tx)).toBe(false);
    const [t] = await sql<{ status: string }[]>`select status from app.bank_transactions where id = ${tx}`;
    expect(t!.status).toBe('offen');
  });
});
