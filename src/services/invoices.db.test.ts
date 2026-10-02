import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import {
  createCancellation,
  createCorrection,
  getInvoice,
  issue,
  runMonthly,
  saveDraft,
} from './invoices.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

const line = (price: string, qty = '1') => ({
  description: 'Unterhaltsreinigung',
  quantity: parseQuantity(qty),
  unitCode: 'MON',
  unitPrice: parseEuro(price),
  vatRate: 1900,
});

describe.skipIf(!available)('Rechnungen in der Datenbank', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  const draft = (
    lines = [line('100,00')],
    kind: 'invoice' | 'partial' | 'final' = 'invoice',
    prepaymentIds?: string[],
  ) =>
    saveDraft(
      sql,
      randomUUID(),
      {
        customerId: DEMO.authority,
        siteId: DEMO.siteSchool,
        kind,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        orderReference: null,
        introText: null,
        closingText: null,
        lines,
        ...(prepaymentIds ? { prepaymentIds } : {}),
      },
      'test',
    );

  describe('Nummernkreis', () => {
    it('vergibt lückenlos fortlaufende Nummern – auch bei gleichzeitigen Aufrufen', async () => {
      const ids = await Promise.all(Array.from({ length: 12 }, () => draft()));
      const numbers = await Promise.all(ids.map((id) => issue(sql, id, 'test', '2026-10-01')));
      const seqs = numbers.map(Number).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => 1038301 + i));
      expect(numbers.every((n) => /^\d{7}$/.test(n))).toBe(true);
    });

    it('fehlgeschlagenes Ausstellen verbraucht keine Nummer', async () => {
      const [before] = await sql`select next_value from app.number_ranges where key = 'invoice'`;
      const empty = await draft([]);
      await expect(issue(sql, empty, 'test', '2026-10-01')).rejects.toThrow(/ohne Positionen/);
      const [after] = await sql`select next_value from app.number_ranges where key = 'invoice'`;
      expect(after!.next_value).toBe(before!.next_value);
    });

    it('erneutes Ausstellen ist idempotent (gleiche Nummer)', async () => {
      const id = await draft();
      const a = await issue(sql, id, 'test', '2026-10-01');
      const b = await issue(sql, id, 'test', '2026-10-01');
      expect(b).toBe(a);
    });

    it('läuft wie Fortytools über den Jahreswechsel weiter (kein Neustart)', async () => {
      const a = await issue(sql, await draft(), 'test', '2025-12-31');
      const b = await issue(sql, await draft(), 'test', '2026-01-02');
      expect(Number(b)).toBe(Number(a) + 1);
    });

    it('Startwert ist einstellbar (Übernahme des Fortytools-Kreises)', async () => {
      const [r] = await sql`select max(number_seq) as m from app.invoices`;
      const next = Number(r!.m) + 1000;
      await sql`update app.number_ranges set next_value = ${next} where key = 'invoice'`;
      expect(await issue(sql, await draft(), 'test', '2026-10-01')).toBe(String(next));
    });

    it('lehnt Rechnungsdatum in der Zukunft ab', async () => {
      const id = await draft();
      await expect(issue(sql, id, 'test', '2099-01-01')).rejects.toThrow(/Zukunft/);
    });
  });

  describe('Unveränderbarkeit', () => {
    it('ausgestellte Rechnung: kein Update, kein Löschen, keine Positionsänderung', async () => {
      const id = await draft();
      await issue(sql, id, 'test', '2026-10-01');
      await expect(sql`update app.invoices set intro_text = 'x' where id = ${id}`).rejects.toThrow(
        /unveränderbar/,
      );
      await expect(sql`delete from app.invoices where id = ${id}`).rejects.toThrow(/nicht gelöscht/);
      await expect(
        sql`update app.invoice_lines set unit_price_cents = 1 where invoice_id = ${id}`,
      ).rejects.toThrow(/unveränderbar/);
      await expect(sql`delete from app.invoice_lines where invoice_id = ${id}`).rejects.toThrow(
        /unveränderbar/,
      );
      await expect(
        sql`insert into app.invoice_lines (invoice_id, position, description, quantity_milli, unit_price_cents, net_cents, vat_rate_bp)
            values (${id}, 99, 'x', 1000, 1, 1, 1900)`,
      ).rejects.toThrow(/unveränderbar/);
    });

    it('Ausstellen nur über die DB-Funktion', async () => {
      const id = await draft();
      await expect(sql`update app.invoices set status = 'issued' where id = ${id}`).rejects.toThrow();
    });

    it('inkonsistente Summen verhindern das Ausstellen', async () => {
      const id = await draft();
      await sql`update app.invoices set net_cents = net_cents + 1 where id = ${id}`;
      await expect(issue(sql, id, 'test', '2026-10-01')).rejects.toThrow(/inkonsistent/);
    });

    it('Archiv und Protokoll sind nur anhängbar', async () => {
      await expect(sql`delete from app.audit_log`).rejects.toThrow(/nur anhängbar/);
    });
  });

  describe('Storno & Korrektur', () => {
    it('Storno: eigene Nummer, Verweis aufs Original, Summen exakt negativ', async () => {
      const id = await draft([line('4.850,00'), line('29,80', '6,5')]);
      await issue(sql, id, 'test', '2026-10-01');
      const stornoId = await createCancellation(sql, id, 'test');
      const stornoNo = await issue(sql, stornoId, 'test', '2026-10-02');
      const orig = (await getInvoice(sql, id))!.invoice;
      const storno = (await getInvoice(sql, stornoId))!.invoice;
      expect(storno.kind).toBe('cancellation');
      expect(storno.original_invoice_id).toBe(id);
      expect(stornoNo).not.toBe(orig.number);
      expect(storno.gross_cents).toBe(-orig.gross_cents);
      expect(storno.vat_cents).toBe(-orig.vat_cents);
      expect(storno.due_date).toBe(storno.issue_date);
    });

    it('eine Rechnung kann nur einmal storniert werden', async () => {
      const id = await draft();
      await issue(sql, id, 'test', '2026-10-01');
      await createCancellation(sql, id, 'test');
      await expect(createCancellation(sql, id, 'test')).rejects.toThrow(/bereits storniert/);
    });

    it('Entwürfe und Stornorechnungen sind nicht stornierbar', async () => {
      const id = await draft();
      await expect(createCancellation(sql, id, 'test')).rejects.toThrow(/Nur ausgestellte/);
      await issue(sql, id, 'test', '2026-10-01');
      const s = await createCancellation(sql, id, 'test');
      await issue(sql, s, 'test', '2026-10-01');
      await expect(createCancellation(sql, s, 'test')).rejects.toThrow(/Stornorechnung kann nicht/);
    });

    it('Rechnungskorrektur über Teilbetrag', async () => {
      const id = await draft([line('1.000,00')]);
      await issue(sql, id, 'test', '2026-10-01');
      const k = await createCorrection(
        sql,
        id,
        [{ ...line('100,00', '-1'), description: 'Minderung Reinigungsausfall' }],
        null,
        'test',
      );
      await issue(sql, k, 'test', '2026-10-02');
      const inv = (await getInvoice(sql, k))!.invoice;
      expect(inv.kind).toBe('correction');
      expect(inv.gross_cents).toBe(-11900n);
    });
  });

  describe('Abschlag & Schlussrechnung', () => {
    it('verrechnet Abschläge brutto, jeden Abschlag nur einmal', async () => {
      const a1 = await draft([line('1.000,00')], 'partial');
      const a2 = await draft([line('500,00')], 'partial');
      await issue(sql, a1, 'test', '2026-09-15');
      await issue(sql, a2, 'test', '2026-09-30');
      const fin = await draft([line('2.000,00')], 'final', [a1, a2]);
      const inv = (await getInvoice(sql, fin))!.invoice;
      expect(inv.gross_cents).toBe(238000n);
      expect(inv.prepaid_cents).toBe(119000n + 59500n);
      expect(inv.payable_cents).toBe(238000n - 178500n);
      await issue(sql, fin, 'test', '2026-10-01');
      await expect(draft([line('1,00')], 'final', [a1])).rejects.toThrow();
      await expect(createCancellation(sql, a1, 'test')).rejects.toThrow(/bereits in einer Schlussrechnung/);
    });

    it('nur ausgestellte Abschläge desselben Kunden', async () => {
      const a = await draft([line('1,00')], 'partial');
      await expect(draft([line('1,00')], 'final', [a])).rejects.toThrow(/ausgestellte Abschlagsrechnungen/);
    });
  });

  describe('Monatslauf', () => {
    it('erzeugt je Objekt einen Entwurf und ist idempotent', async () => {
      const first = await runMonthly(sql, '2026-09', 'test');
      expect(first.created).toHaveLength(3);
      const second = await runMonthly(sql, '2026-09', 'test');
      expect(second.created).toHaveLength(0);
      expect(second.skipped.every((s) => /existiert bereits/.test(s.reason))).toBe(true);

      const school = first.created.find((c) => c.siteName === 'Grundschule Musterweg')!;
      const { invoice, lines } = (await getInvoice(sql, school.invoiceId))!;
      expect(lines.map((l) => l.description)).toEqual(['Unterhaltsreinigung', 'Sanitärreinigung täglich']);
      expect(invoice.net_cents).toBe(485000n + 62000n);
      expect(invoice.period_start).toBe('2026-09-01');
      expect(invoice.period_end).toBe('2026-09-30');
      expect(invoice.invoice_format).toBe('xrechnung');
    });

    it('gleichzeitige Läufe erzeugen keine Dubletten', async () => {
      const results = await Promise.all([runMonthly(sql, '2026-08', 'a'), runMonthly(sql, '2026-08', 'b')]);
      expect(results[0].created.length + results[1].created.length).toBe(3);
    });
  });

  describe('Row Level Security', () => {
    const asUser = async (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`;
        await tx`set local role authenticated`;
        const inv = await tx`select count(*)::int as n from app.invoices`;
        const sites = await tx`select count(*)::int as n from app.sites`;
        return { invoices: inv[0]!.n, sites: sites[0]!.n };
      });

    it('Nummernkreis ist für angemeldete Benutzer nicht lesbar (nur Server)', async () => {
      await expect(
        sql.begin(async (tx) => {
          await tx`set local role authenticated`;
          await tx`select * from app.number_ranges`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('Objektleitung sieht nur eigene Objekte und keine Rechnungen; Büro sieht alles', async () => {
      const office = randomUUID();
      const manager = randomUUID();
      await sql`insert into auth.users (id) values (${office}), (${manager})`;
      await sql`insert into app.profiles (user_id, display_name, role)
                values (${office}, 'Büro', 'buchhaltung'), (${manager}, 'Objektleitung', 'objektleitung')`;
      await sql`update app.sites set manager_user_id = ${manager} where id = ${DEMO.siteSchool}`;

      const m = await asUser(manager);
      expect(m).toEqual({ invoices: 0, sites: 1 });
      const o = await asUser(office);
      expect(o.invoices).toBeGreaterThan(0);
      expect(o.sites).toBe(3);
      const anon = await asUser(randomUUID());
      expect(anon).toEqual({ invoices: 0, sites: 0 });
    });

    it('angemeldete Benutzer können nicht direkt schreiben', async () => {
      await expect(
        sql.begin(async (tx) => {
          await tx`set local role authenticated`;
          await tx`update app.customers set name = 'x'`;
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
