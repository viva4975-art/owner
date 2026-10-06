import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { createDunning, getDunning, proposals, renderDunningPdf, sendDunning } from './dunning.js';
import { bookStock, getArticle, keyAction, keyLog, saveArticle, saveKey } from './inventory.js';
import { issue, saveDraft } from './invoices.js';
import { listServices } from './masterdata.js';
import {
  acceptIntoSite,
  copyOffer,
  getOffer,
  listOffers,
  offerToInvoiceDraft,
  renderOfferPdf,
  saveOffer,
  setOfferStatus,
} from './offers.js';
import { bookPayment } from './payments.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Angebote, Mahnwesen, Inventar', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const offerInput = (over: Partial<Parameters<typeof saveOffer>[2]> = {}) => ({
    customerId: DEMO.authority,
    siteId: null,
    title: 'Unterhaltsreinigung Grundschule',
    tenderReference: '2026-V-1',
    tenderPlatform: 'Bayerischer Vergabemarktplatz',
    submissionDeadline: '2026-11-02T10:00',
    offerDate: '2026-10-01',
    validUntil: '2026-12-31',
    introText: null,
    closingText: null,
    lines: [
      {
        description: 'Unterhaltsreinigung',
        quantity: parseQuantity('1'),
        unitCode: 'C62',
        unitPrice: parseEuro('4.850,00'),
        vatRate: 1900,
        recurring: true,
      },
      {
        description: 'Grundreinigung',
        quantity: parseQuantity('1'),
        unitCode: 'C62',
        unitPrice: parseEuro('1.200,00'),
        vatRate: 1900,
        recurring: false,
      },
    ],
    ...over,
  });

  describe('Angebote', () => {
    it('vergibt fortlaufende Nummern, rechnet Summen und Monatsanteil Cent-genau', async () => {
      const a = randomUUID();
      const b = randomUUID();
      await saveOffer(sql, a, offerInput(), 'test');
      await saveOffer(sql, b, offerInput(), 'test');
      const oa = (await getOffer(sql, a))!.offer;
      const ob = (await getOffer(sql, b))!.offer;
      expect(Number(ob.number)).toBe(Number(oa.number) + 1);
      expect(oa.net_cents).toBe(605000n);
      expect(oa.vat_cents).toBe(114950n);
      expect(oa.gross_cents).toBe(719950n);
      expect(oa.monthly_net_cents).toBe(485000n);
    });

    it('speichert die Abgabefrist als deutsche Ortszeit (Sommer- und Winterzeit)', async () => {
      const id = randomUUID();
      await saveOffer(sql, id, offerInput({ submissionDeadline: '2026-10-20T10:00' }), 'test');
      expect((await getOffer(sql, id))!.offer.submission_deadline!.toISOString()).toBe(
        '2026-10-20T08:00:00.000Z',
      );
      await saveOffer(
        sql,
        id,
        offerInput({
          submissionDeadline: '2026-11-20T10:00',
          expectedVersion: (await getOffer(sql, id))!.offer.version,
        }),
        'test',
      );
      expect((await getOffer(sql, id))!.offer.submission_deadline!.toISOString()).toBe(
        '2026-11-20T09:00:00.000Z',
      );
    });

    it('zweiter Tab mit alter Version wird abgelehnt', async () => {
      const id = randomUUID();
      await saveOffer(sql, id, offerInput(), 'test');
      const v = (await getOffer(sql, id))!.offer.version;
      await saveOffer(sql, id, offerInput({ title: 'Tab 1', expectedVersion: v }), 'tab1');
      await expect(
        saveOffer(sql, id, offerInput({ title: 'Tab 2', expectedVersion: v }), 'tab2'),
      ).rejects.toThrow(/zwischenzeitlich geändert/);
    });

    it('nach Abgabe nicht mehr änderbar, nur gültige Statuswechsel', async () => {
      const id = randomUUID();
      await saveOffer(sql, id, offerInput(), 'test');
      await expect(setOfferStatus(sql, id, 'angenommen', 'test')).rejects.toThrow(/kann nicht/);
      await setOfferStatus(sql, id, 'versendet', 'test');
      await expect(saveOffer(sql, id, offerInput(), 'test')).rejects.toThrow(/Nur Angebote im Entwurf/);
      const copy = await copyOffer(sql, id, 'test');
      expect((await getOffer(sql, copy))!.offer.status).toBe('entwurf');
      expect((await getOffer(sql, copy))!.lines).toHaveLength(2);
    });

    it('Zuschlag: Übernahme ins Objekt legt Monatspauschale + Sonderleistung genau einmal an', async () => {
      const id = randomUUID();
      await saveOffer(sql, id, offerInput(), 'test');
      await expect(acceptIntoSite(sql, id, DEMO.siteOffice, '2026-11-01', 'test')).rejects.toThrow(
        /angenommene/,
      );
      await setOfferStatus(sql, id, 'versendet', 'test');
      await setOfferStatus(sql, id, 'angenommen', 'test');
      const before = (await listServices(sql, DEMO.siteOffice)).length;
      expect(await acceptIntoSite(sql, id, DEMO.siteOffice, '2026-11-01', 'test')).toBe(2);
      expect(await acceptIntoSite(sql, id, DEMO.siteOffice, '2026-11-01', 'test')).toBe(0);
      const services = await listServices(sql, DEMO.siteOffice);
      expect(services.length).toBe(before + 2);
      expect(
        services.find((s) => s.description === 'Unterhaltsreinigung' && s.note?.includes('Angebot'))?.kind,
      ).toBe('monthly_flat');
      expect(services.find((s) => s.description === 'Grundreinigung')?.kind).toBe('special');
      await expect(acceptIntoSite(sql, id, DEMO.siteHq, '2026-11-01', 'test')).rejects.toThrow(
        /gehört nicht/,
      );
      const inv = await offerToInvoiceDraft(sql, id, 'test');
      const [row] = await sql<
        { gross_cents: bigint }[]
      >`select gross_cents from app.invoices where id = ${inv}`;
      expect(row!.gross_cents).toBe(719950n);
    });

    it('PDF wird erzeugt, Liste zeigt Tage bis zur Frist', async () => {
      const id = randomUUID();
      await saveOffer(sql, id, offerInput(), 'test');
      const { pdf } = await renderOfferPdf(sql, id);
      expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
      const row = (await listOffers(sql)).find((o) => o.id === id)!;
      expect(typeof row.days_left).toBe('number');
    });
  });

  describe('Mahnwesen', () => {
    const overdueInvoice = async (issueDate: string, price = '1.000,00') => {
      const id = randomUUID();
      await saveDraft(
        sql,
        id,
        {
          customerId: DEMO.company,
          siteId: DEMO.siteHq,
          kind: 'invoice',
          periodStart: null,
          periodEnd: null,
          orderReference: null,
          introText: null,
          closingText: null,
          lines: [
            {
              description: 'Unterhaltsreinigung',
              quantity: parseQuantity('1'),
              unitCode: 'LS',
              unitPrice: parseEuro(price),
              vatRate: 1900,
            },
          ],
        },
        'test',
      );
      await issue(sql, id, 'test', issueDate);
      return id;
    };

    it('schlägt überfällige Rechnungen vor, erstellt Mahnung mit Gebühr ohne USt, genau einmal', async () => {
      const inv = await overdueInvoice('2026-06-01'); // Zahlungsziel 20 Tage → weit überfällig
      const { proposals: list } = await proposals(sql);
      const p = list.find((x) => x.customer_id === DEMO.company)!;
      expect(p.items.map((i) => i.invoice_id)).toContain(inv);
      expect(p.level).toBe(1);

      const id = randomUUID();
      await createDunning(deps, id, DEMO.company, [inv], 'test');
      await createDunning(deps, id, DEMO.company, [inv], 'test'); // doppelt abgeschickt
      const [{ n }] =
        (await sql`select count(*)::int as n from app.dunnings where id = ${id}`) as unknown as [
          { n: number },
        ];
      expect(n).toBe(1);
      const d = (await getDunning(sql, id))!;
      expect(d.dunning.level).toBe(1);
      expect(d.dunning.fee_cents).toBe(0n);
      expect(d.dunning.total_cents).toBe(119000n);
      expect(d.dunning.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);

      // Direkt danach kein neuer Vorschlag für dieselbe Rechnung (Mindestabstand)
      const again = (await proposals(sql)).proposals.find((x) => x.customer_id === DEMO.company);
      expect(again?.items.some((i) => i.invoice_id === inv) ?? false).toBe(false);

      // Zweite Stufe (Mindestabstand simuliert durch zurückdatierte erste Mahnung)
      await sql`update app.dunnings set issue_date = issue_date - 30 where id = ${id}`;
      const lvl2 = (await proposals(sql)).proposals.find((x) => x.customer_id === DEMO.company)!;
      expect(lvl2.items.find((i) => i.invoice_id === inv)!.next_level).toBe(2);
      const id2 = randomUUID();
      await createDunning(deps, id2, DEMO.company, [inv], 'test');
      const d2 = (await getDunning(sql, id2))!;
      expect(d2.dunning.level).toBe(2);
      // Geschäftskunde: Verzugspauschale 40 €, Mahngebühr wird angerechnet (§ 288 Abs. 5 S. 3 BGB)
      expect(d2.dunning.late_fee_cents).toBe(4000n);
      expect(d2.dunning.fee_cents).toBe(0n);
      expect(d2.dunning.total_cents).toBe(119000n + 4000n);
      const { pdf } = await renderDunningPdf(sql, id2);
      expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');

      // Stufe 3: Pauschale je Rechnung nur einmal, Mahngebühr weiter angerechnet
      await sql`update app.dunnings set issue_date = issue_date - 30 where id = ${id2}`;
      const id3 = randomUUID();
      await createDunning(deps, id3, DEMO.company, [inv], 'test');
      const d3 = (await getDunning(sql, id3))!;
      expect(d3.dunning.level).toBe(3);
      expect([d3.dunning.late_fee_cents, d3.dunning.fee_cents, d3.dunning.total_cents]).toEqual([
        0n,
        0n,
        119000n,
      ]);
    });

    it('Privatkunde: keine Verzugspauschale, Mahngebühr laut Stufe', async () => {
      await sql`update app.customers set is_consumer = true where id = ${DEMO.company}`;
      try {
        const inv = await overdueInvoice('2026-06-04');
        const id = randomUUID();
        await createDunning(deps, id, DEMO.company, [inv], 'test');
        await sql`update app.dunnings set issue_date = issue_date - 30 where id = ${id}`;
        const id2 = randomUUID();
        await createDunning(deps, id2, DEMO.company, [inv], 'test');
        const d = (await getDunning(sql, id2))!;
        expect(d.dunning.level).toBe(2);
        expect([d.dunning.late_fee_cents, d.dunning.fee_cents]).toEqual([0n, 500n]);
      } finally {
        await sql`update app.customers set is_consumer = false where id = ${DEMO.company}`;
      }
    });

    it('Versand genau einmal und nur an die Testadresse', async () => {
      const inv = await overdueInvoice('2026-06-02');
      const id = randomUUID();
      await createDunning(deps, id, DEMO.company, [inv], 'test');
      const before = deps.mailer.sent.length;
      const r1 = await sendDunning(deps, id, 'test');
      const r2 = await sendDunning(deps, id, 'test');
      expect(r1.alreadySent).toBe(false);
      expect(r2.alreadySent).toBe(true);
      expect(deps.mailer.sent.length).toBe(before + 1);
      expect(deps.mailer.sent.at(-1)!.to).toEqual(['test@viva-deluxe.local']);
      expect(deps.mailer.sent.at(-1)!.subject).toMatch(/^\[TEST\]/);
    });

    it('bezahlte Rechnungen und Mahnsperre werden nicht gemahnt', async () => {
      const inv = await overdueInvoice('2026-06-03', '50,00');
      await bookPayment(
        sql,
        randomUUID(),
        inv,
        { amount: parseEuro('59,50'), paid_on: '2026-07-01', method: 'ueberweisung', reference: null },
        'test',
      );
      await expect(createDunning(deps, randomUUID(), DEMO.company, [inv], 'test')).rejects.toThrow(
        /nicht \(mehr\) überfällig/,
      );
      await sql`update app.customers set dunning_block = true where id = ${DEMO.company}`;
      const r = await proposals(sql);
      expect(r.proposals.find((x) => x.customer_id === DEMO.company)).toBeUndefined();
      expect(r.blocked.find((x) => x.customer_id === DEMO.company)).toBeDefined();
      await sql`update app.customers set dunning_block = false where id = ${DEMO.company}`;
    });

    it('Mahnpositionen sind unveränderbar', async () => {
      await expect(sql`update app.dunning_items set open_cents = 0`).rejects.toThrow();
    });
  });

  describe('Inventar', () => {
    it('Bestandsbuchung idempotent, Bestand nie negativ', async () => {
      const id = randomUUID();
      await saveArticle(
        sql,
        id,
        { article_no: 'T-1', name: 'Allzweckreiniger', unit: 'Kanister', min_stock: '5', active: 'on' },
        null,
        'test',
      );
      const move = randomUUID();
      await bookStock(sql, move, id, parseQuantity('10'), 'Lieferung', null, 'test');
      await bookStock(sql, move, id, parseQuantity('10'), 'Lieferung', null, 'test'); // Doppelklick
      expect((await getArticle(sql, id))!.stock_milli).toBe(10000n);
      await expect(
        bookStock(sql, randomUUID(), id, -parseQuantity('11'), 'Ausgabe', null, 'test'),
      ).rejects.toThrow(/negativ/);
      await bookStock(sql, randomUUID(), id, -parseQuantity('7,5'), 'Ausgabe', DEMO.siteSchool, 'test');
      expect((await getArticle(sql, id))!.stock_milli).toBe(2500n);
      await expect(sql`delete from app.stock_movements`).rejects.toThrow();
    });

    it('Schlüsselbuch protokolliert Ausgabe und Rückgabe', async () => {
      const [emp] = await sql<{ id: string }[]>`
        insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
        values (${randomUUID()}, 'T900', 'Maria', 'Test', '2026-01-01') returning id`;
      const key = randomUUID();
      await saveKey(
        sql,
        key,
        { key_no: 'S-1', site_id: DEMO.siteSchool, description: 'Haupteingang', quantity: '2' },
        null,
        'test',
      );
      await keyAction(sql, key, 'ausgabe', emp!.id, '2026-10-01', null, 'test');
      await expect(keyAction(sql, key, 'ausgabe', emp!.id, '2026-10-01', null, 'test')).rejects.toThrow(
        /bereits ausgegeben/,
      );
      await keyAction(sql, key, 'rueckgabe', null, '2026-10-05', 'vollständig', 'test');
      const log = await keyLog(sql, key);
      expect(log.map((l) => l.action)).toEqual(['rueckgabe', 'ausgabe']);
      expect(log[0]!.employee_name).toBe('Test, Maria');
    });
  });
});
