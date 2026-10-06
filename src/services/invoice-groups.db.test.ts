import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { listInvoiceGroups, saveInvoiceGroup, groupBillingInput } from './invoice-groups.js';
import { createCancellation, deleteDraft, getInvoice, runMonthly } from './invoices.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { type Deps, issueInvoice } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Rechnungsgruppen im Monatslauf', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  const group = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const input = (over: Partial<Parameters<typeof saveInvoiceGroup>[2]> = {}) => ({
    customerId: DEMO.authority,
    name: 'Referat Bildung – Sammelrechnung',
    combine: true,
    billing: groupBillingInput.parse({
      bill_format: 'xrechnung',
      buyer_reference: '04011000-99999-11',
      bill_emails: 'rechnung@example.org',
      bill_payment_terms_days: '30',
    }),
    orderReference: 'SR-2026',
    note: null,
    active: true,
    siteIds: [DEMO.siteSchool, DEMO.siteOffice],
    expectedVersion: null,
    ...over,
  });

  it('Objekte nur vom selben Kunden', async () => {
    await expect(saveInvoiceGroup(sql, randomUUID(), input({ siteIds: [DEMO.siteHq] }), 't')).rejects.toThrow(
      /nicht zu diesem Kunden/,
    );
    await expect(
      sql`update app.sites set invoice_group_id = ${randomUUID()} where id = ${DEMO.siteHq}`,
    ).rejects.toThrow();
  });

  it('eine Sammelrechnung je Gruppe und Monat, Leitweg-ID/Bestellnr. der Gruppe, KoSIT-gültig', async () => {
    await saveInvoiceGroup(sql, group, input(), 't');
    const [g] = await listInvoiceGroups(sql, DEMO.authority);
    expect(g!.site_names).toEqual([
      'Grundschule Musterweg (2990101)',
      'Verwaltungsgebäude Am Platz (2990102)',
    ]);

    const run = await runMonthly(sql, '2026-09', 't');
    expect(run.created.map((c) => c.siteName).sort()).toEqual([
      'Firmenzentrale Planegg',
      'Referat Bildung – Sammelrechnung (Sammelrechnung)',
    ]);
    const gid = run.created.find((c) => c.siteName.includes('(Sammelrechnung)'))!.invoiceId;
    const { invoice, lines } = (await getInvoice(sql, gid))!;
    expect(invoice.site_id).toBeNull();
    expect(invoice.invoice_group_id).toBe(group);
    expect(invoice.buyer_reference).toBe('04011000-99999-11');
    expect(invoice.order_reference).toBe('SR-2026');
    expect(lines.map((l) => l.description)).toEqual([
      'Unterhaltsreinigung',
      'Sanitärreinigung täglich',
      'Unterhaltsreinigung',
    ]);
    expect(lines[2]!.detail).toContain('Verwaltungsgebäude Am Platz (2990102)');
    expect(invoice.net_cents).toBe(485000n + 62000n + 212050n);

    // zweiter Lauf: nichts doppelt
    const again = await runMonthly(sql, '2026-09', 't');
    expect(again.created).toHaveLength(0);

    // Ausstellen inkl. KoSIT-Prüfung (Rechnung ohne einzelnes Objekt)
    const docs = await issueInvoice(deps, gid, 't');
    expect(docs.find((d) => d.kind === 'xrechnung_xml')!.valid).toBe(true);

    // Storno behält die Gruppe
    const st = await createCancellation(sql, gid, 't');
    expect((await getInvoice(sql, st))!.invoice.invoice_group_id).toBe(group);
  });

  it('Objekt wechselt im Monat in/aus der Gruppe → nie doppelt abgerechnet', async () => {
    // Oktober: Gruppe aufgelöst (inaktiv) → Einzelrechnungen
    await saveInvoiceGroup(sql, group, input({ active: false, expectedVersion: null }), 't');
    const oct = await runMonthly(sql, '2026-10', 't');
    expect(oct.created).toHaveLength(3);
    // Gruppe wieder aktiv im selben Monat → keine Sammelrechnung, beide Objekte schon abgerechnet
    await saveInvoiceGroup(sql, group, input({ active: true }), 't');
    const oct2 = await runMonthly(sql, '2026-10', 't');
    expect(oct2.created).toHaveLength(0);
    expect(oct2.skipped.filter((s) => /existiert bereits/.test(s.reason)).length).toBeGreaterThanOrEqual(2);

    // Entwurf einer Einzelrechnung gelöscht → Objekt kann wieder abgerechnet werden (jetzt in der Gruppe)
    const school = oct.created.find((c) => c.siteName === 'Grundschule Musterweg')!.invoiceId;
    await deleteDraft(sql, school, 't');
    const oct3 = await runMonthly(sql, '2026-10', 't');
    expect(oct3.created).toHaveLength(1);
    const { lines } = (await getInvoice(sql, oct3.created[0]!.invoiceId))!;
    expect(lines.map((l) => l.description)).toEqual(['Unterhaltsreinigung', 'Sanitärreinigung täglich']);
  });
});
