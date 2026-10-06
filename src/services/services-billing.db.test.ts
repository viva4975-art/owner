import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { saveInvoiceGroup, groupBillingInput } from './invoice-groups.js';
import { getInvoice, markReviewed, runMonthly } from './invoices.js';
import { saveService, serviceInput } from './masterdata.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import { type Deps, issueInvoice } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Leistungen wie Fortytools im Abrechnungslauf', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const svc = async (siteId: string, over: Record<string, string> = {}) => {
    const id = randomUUID();
    await saveService(
      sql,
      id,
      siteId,
      serviceInput.parse({
        kind: 'monthly_flat',
        description: 'Glasreinigung',
        unit_code: 'LS',
        quantity: '1',
        unit_price: '600,00',
        vat_rate_bp: '1900',
        valid_from: '2026-01-01',
        valid_to: '',
        note: '',
        billing_cycle: 'monatlich',
        version: '',
        ...over,
      }),
      'test',
    );
    return id;
  };
  const linesOf = async (invoiceId: string) =>
    (await getInvoice(sql, invoiceId))!.lines.map((l) => l.description);

  it('quartalsweise: nur in fälligen Monaten, Zeitraum über drei Monate', async () => {
    await svc(DEMO.siteHq, {
      description: 'Glasreinigung quartalsweise',
      billing_cycle: 'quartalsweise',
      valid_from: '2026-07-01',
    });
    const aug = await runMonthly(sql, '2026-08', 't', { siteIds: [DEMO.siteHq] });
    expect(await linesOf(aug.created[0]!.invoiceId)).toEqual(['Unterhaltsreinigung']);
    const oct = await runMonthly(sql, '2026-10', 't', { siteIds: [DEMO.siteHq] });
    const inv = (await getInvoice(sql, oct.created[0]!.invoiceId))!;
    expect(inv.lines.map((l) => l.description)).toEqual([
      'Unterhaltsreinigung',
      'Glasreinigung quartalsweise',
    ]);
    expect(inv.lines[1]!.detail).toContain('01.10.2026 bis 31.12.2026');
    expect(inv.invoice.period_end).toBe('2026-12-31');
  });

  it('eigene Rechnung je Leistung, Rechnungsgruppe je Leistung mit Kopftext, nur gewähltes Objekt', async () => {
    const group = randomUUID();
    await saveInvoiceGroup(
      sql,
      group,
      {
        customerId: DEMO.authority,
        name: 'Glas alle Schulen',
        combine: true,
        billing: groupBillingInput.parse({ bill_format: 'zugferd', bill_payment_terms_days: '30' }),
        orderReference: 'GL-1',
        note: null,
        introText: 'Hiermit berechnen wir die Glasreinigung:',
        closingText: null,
        active: true,
        siteIds: [],
        expectedVersion: null,
      },
      't',
    );
    await svc(DEMO.siteSchool, { description: 'Sonderreinigung Aula', invoice_target: 'separat' });
    await svc(DEMO.siteSchool, { description: 'Glas Schule', invoice_target: group });
    // fremde Gruppe am Objekt eines anderen Kunden → abgelehnt
    await expect(svc(DEMO.siteHq, { invoice_target: group })).rejects.toThrow(/anderen Kunden/);

    const r = await runMonthly(sql, '2026-09', 't', {
      siteIds: [DEMO.siteSchool],
      invoiceDate: '2026-09-30',
    });
    const names = r.created.map((c) => c.siteName).sort();
    expect(names).toEqual([
      'Glas alle Schulen (Sammelrechnung)',
      'Grundschule Musterweg',
      'Grundschule Musterweg – Sonderreinigung Aula',
    ]);
    const byName = Object.fromEntries(r.created.map((c) => [c.siteName, c.invoiceId]));
    expect(await linesOf(byName['Grundschule Musterweg']!)).toEqual([
      'Unterhaltsreinigung',
      'Sanitärreinigung täglich',
    ]);
    const g = (await getInvoice(sql, byName['Glas alle Schulen (Sammelrechnung)']!))!.invoice;
    expect(g.intro_text).toBe('Hiermit berechnen wir die Glasreinigung:');
    expect(g.order_reference).toBe('GL-1');
    expect(g.planned_issue_date).toBe('2026-09-30');
    // Verwaltungsgebäude (gleicher Kunde) war nicht ausgewählt
    const [other] =
      await sql`select 1 from app.monthly_run_services r join app.site_services s on s.id = r.service_id
                               where s.site_id = ${DEMO.siteOffice} and r.month = '2026-09'`;
    expect(other).toBeUndefined();
    // zweiter Lauf (alle Objekte): bereits abgerechnete Leistungen nicht noch einmal
    const all = await runMonthly(sql, '2026-09', 't');
    const again = await sql<{ n: number }[]>`
      select count(*)::int as n from app.monthly_run_services r join app.site_services s on s.id = r.service_id
       where s.site_id = ${DEMO.siteSchool} and r.month = '2026-09'`;
    expect(again[0]!.n).toBe(4);
    expect(all.created.map((c) => c.siteName)).not.toContain('Grundschule Musterweg');
  });

  it('„immer unfertig“: Ausstellen erst nach Prüfung, mit Rechnungsdatum aus dem Lauf', async () => {
    const today = todayBerlin();
    await svc(DEMO.siteOffice, {
      description: 'Reinigung nach Aufmaß',
      always_unfinished: 'on',
      invoice_target: 'separat',
    });
    const r = await runMonthly(sql, '2026-11', 't', { siteIds: [DEMO.siteOffice], invoiceDate: today });
    const id = r.created.find((c) => c.siteName.includes('Aufmaß'))!.invoiceId;
    expect((await getInvoice(sql, id))!.invoice.review_required).toBe(true);
    await expect(issueInvoice(deps, id, 't')).rejects.toThrow(/unfertig/);
    await markReviewed(sql, id, 't');
    await issueInvoice(deps, id, 't');
    const inv = (await getInvoice(sql, id))!.invoice;
    expect(inv.status).toBe('issued');
    expect(inv.issue_date).toBe(today);
  });

  it('Rechnungsdatum in der Zukunft: Ausstellen gesperrt mit klarer Meldung', async () => {
    await svc(DEMO.siteOffice, {
      description: 'Zukunft',
      invoice_target: 'separat',
      valid_from: '2026-12-01',
    });
    const r = await runMonthly(sql, '2026-12', 't', {
      siteIds: [DEMO.siteOffice],
      invoiceDate: '2099-12-31',
    });
    const id = r.created.find((c) => c.siteName.includes('Zukunft'))!.invoiceId;
    await expect(issueInvoice(deps, id, 't')).rejects.toThrow(/in der Zukunft/);
  });
});
