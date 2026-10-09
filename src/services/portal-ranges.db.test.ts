import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import type { Cents, Quantity } from '../domain/money/money.js';
import { saveDraft } from './invoices.js';
import { listRanges, raiseRange } from './number-ranges.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, kositAvailable, testDeps } from './testing.js';
import {
  type Deps,
  deliveryChannel,
  issueInvoice,
  listDeliveries,
  recordPortalUpload,
  sendInvoice,
} from './workflow.js';

const db = await dbAvailable();
const kosit = db && (await kositAvailable());

describe.skipIf(!db)('Nummernkreise (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('nur anheben, nie senken, nie unter eine vergebene Nummer', async () => {
    const inv = (await listRanges(sql)).find((r) => r.key === 'invoice')!;
    await expect(raiseRange(sql, 'invoice', inv.next_value - 1n, 't')).rejects.toThrow(/nur angehoben/);
    await raiseRange(sql, 'invoice', inv.next_value + 100n, 't');
    expect((await listRanges(sql)).find((r) => r.key === 'invoice')!.next_value).toBe(inv.next_value + 100n);
    await sql`insert into app.legacy_invoices (id, number, issue_date, net_cents, gross_cents, paid)
              values (${randomUUID()}, '9999999', '2026-01-01', 100, 119, true)`;
    await expect(raiseRange(sql, 'invoice', 9999999n, 't')).rejects.toThrow(/schon vergeben/);
    await expect(raiseRange(sql, 'gibtsnicht', 5n, 't')).rejects.toThrow(/nicht gefunden/);
  });
});

describe.skipIf(!kosit)('Portal-Versand (Patentamt)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const id = randomUUID();
  const id2 = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Rechnungsgruppe „Portal“: kein Mailversand, Upload genau einmal vermerkt', async () => {
    await saveDraft(
      sql,
      id,
      {
        customerId: DEMO.company,
        siteId: null,
        kind: 'invoice',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhaltsreinigung',
            quantity: 1000n as Quantity,
            unitCode: 'LS',
            unitPrice: 50000n as Cents,
            vatRate: 1900,
          },
        ],
      },
      't',
    );
    const [g] = await sql<{ id: string }[]>`
      insert into app.invoice_groups (id, customer_id, name, bill_format, buyer_reference)
      select ${randomUUID()}, id, 'Patentamt Portal', 'xrechnung', '991-12345-67' from app.customers where id = ${DEMO.company}
      returning id`;
    await sql`update app.invoices set invoice_group_id = ${g!.id} where id = ${id}`;
    await sql`update app.invoice_groups set delivery_channel = 'portal', portal_name = 'DPMA-Portal' where id = ${g!.id}`;
    await issueInvoice(deps, id, 't');
    expect(await deliveryChannel(sql, id)).toEqual({ channel: 'portal', portal: 'DPMA-Portal' });
    await expect(sendInvoice(deps, id, 't')).rejects.toThrow(/DPMA-Portal/);
    expect(deps.mailer.sent).toHaveLength(0);
    expect((await recordPortalUpload(deps, id, { reference: 'UP-123', actor: 't' })).alreadySent).toBe(false);
    expect((await recordPortalUpload(deps, id, { reference: 'UP-123', actor: 't' })).alreadySent).toBe(true);
    const d = await listDeliveries(sql, id);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      status: 'sent',
      channel: 'portal',
      portal_reference: 'UP-123',
      recorded_by: 't',
    });
    expect(d[0]!.actual_recipients).toEqual(['DPMA-Portal']);
  });
  it('Rechnungsgruppe „kein Versand“: mit dem Ausstellen versendet, genau einmal, kein Mail', async () => {
    await saveDraft(
      sql,
      id2,
      {
        customerId: DEMO.company,
        siteId: null,
        kind: 'invoice',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhaltsreinigung',
            quantity: 1000n as Quantity,
            unitCode: 'LS',
            unitPrice: 50000n as Cents,
            vatRate: 1900,
          },
        ],
      },
      't',
    );
    const [g] = await sql<{ id: string }[]>`
      insert into app.invoice_groups (id, customer_id, name, bill_format, buyer_reference)
      select ${randomUUID()}, id, 'LHM ohne Versand', 'xrechnung', '991-12345-67' from app.customers where id = ${DEMO.company}
      returning id`;
    await sql`update app.invoices set invoice_group_id = ${g!.id} where id = ${id2}`;
    await sql`update app.invoice_groups set delivery_channel = 'keiner' where id = ${g!.id}`;
    await issueInvoice(deps, id2, 't');
    await issueInvoice(deps, id2, 't');
    await expect(sendInvoice(deps, id2, 't')).rejects.toThrow(/kein Versand/);
    expect(deps.mailer.sent).toHaveLength(0);
    const d = await listDeliveries(sql, id2);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: 'sent', channel: 'keiner' });
  });
});
