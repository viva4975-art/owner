import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import {
  addNote,
  getNote,
  listNotes,
  saveNote,
  listTasks,
  saveContact,
  saveTask,
  setTaskDone,
} from './crm.js';
import { employeeInput, exportEmployeesCsv, getEmployee, saveEmployee, validIban } from './employees.js';
import { createCancellation, issue, saveDraft } from './invoices.js';
import { customerInput, getCustomer, saveCustomer } from './masterdata.js';
import { bookPayment, listBalances, listOpenItems, reversePayment } from './payments.js';
import { search } from './search.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Phase 2: Kontakte, Aufgaben, Zahlungen, Personal', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  const issuedInvoice = async (price = '1.000,00') => {
    const id = randomUUID();
    await saveDraft(
      sql,
      id,
      {
        customerId: DEMO.company,
        siteId: DEMO.siteHq,
        kind: 'invoice',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
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
    await issue(sql, id, 'test', '2026-10-01');
    return id;
  };

  describe('Zwei Tabs / optimistisches Sperren', () => {
    it('Speichern mit veralteter Version wird abgelehnt', async () => {
      const c = (await getCustomer(sql, DEMO.company))!;
      const input = customerInput.parse({
        ...c,
        skonto_percent_bp: '3',
        skonto_days: '7',
        payment_terms_days: '20',
        invoice_emails: c.invoice_emails.join(','),
        is_public_authority: '',
        contact_name: 'Tab 1',
      });
      await saveCustomer(sql, DEMO.company, input, 'tab1', c.version); // Tab 1 speichert
      await expect(
        saveCustomer(sql, DEMO.company, { ...input, contact_name: 'Tab 2' }, 'tab2', c.version),
      ).rejects.toThrow(/zwischenzeitlich geändert/);
      expect((await getCustomer(sql, DEMO.company))!.contact_name).toBe('Tab 1');
    });

    it('Rechnungsentwurf: veraltete Version wird abgelehnt', async () => {
      const id = randomUUID();
      const base = {
        customerId: DEMO.company,
        siteId: null,
        kind: 'invoice' as const,
        periodStart: null,
        periodEnd: null,
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'A',
            quantity: parseQuantity('1'),
            unitCode: 'C62',
            unitPrice: parseEuro('1'),
            vatRate: 1900,
          },
        ],
      };
      await saveDraft(sql, id, base, 'x');
      const [{ version }] = (await sql`select version from app.invoices where id = ${id}`) as unknown as [
        { version: number },
      ];
      await saveDraft(sql, id, { ...base, introText: 'Tab 1', expectedVersion: version }, 'x');
      await expect(
        saveDraft(sql, id, { ...base, introText: 'Tab 2', expectedVersion: version }, 'x'),
      ).rejects.toThrow(/zwischenzeitlich geändert/);
    });
  });

  describe('Kontakte, Notizen, Aufgaben', () => {
    it('Kontakt anlegen und mit Version ändern', async () => {
      const id = randomUUID();
      const input = {
        salutation: 'Frau',
        first_name: 'Eva',
        last_name: 'Beispiel',
        position: 'Einkauf',
        email: 'eva@example.org',
        phone: null,
        mobile: null,
        invoice_recipient: true,
        notes: null,
      };
      await saveContact(sql, id, DEMO.company, { ...input, version: null });
      await saveContact(sql, id, DEMO.company, { ...input, position: 'Leitung Einkauf', version: 1 });
      await expect(saveContact(sql, id, DEMO.company, { ...input, version: 1 })).rejects.toThrow(
        /zwischenzeitlich/,
      );
      const res = await search(sql, 'Beispiel');
      const hits = res.groups.flatMap((g) => g.hits);
      expect(hits.some((h) => h.type === 'Kontakt' && h.label === 'Eva Beispiel')).toBe(true);
      // mehrere Wörter: alle müssen vorkommen, Textausschnitt mit Fundstelle
      const two = (await search(sql, 'Eva Einkauf')).groups.flatMap((g) => g.hits);
      expect(two.find((h) => h.type === 'Kontakt')?.snippet).toMatch(/Eva/);
    });

    it('Notiz doppelt abgeschickt = eine Notiz', async () => {
      const id = randomUUID();
      await addNote(sql, id, 'site', DEMO.siteHq, 'Schlüssel beim Hausmeister', 'test');
      await addNote(sql, id, 'site', DEMO.siteHq, 'Schlüssel beim Hausmeister', 'test');
      expect(await listNotes(sql, 'site', DEMO.siteHq)).toHaveLength(1);
    });

    it('Notiz mit Titel ändern: Erfasser bleibt, Änderung vermerkt, alter Stand wird abgelehnt', async () => {
      const id = randomUUID();
      const input = { date: '2026-10-01', title: 'Begehung', body: '', expectedVersion: null };
      await saveNote(sql, id, 'site', DEMO.siteHq, input, 'anna');
      await saveNote(sql, id, 'site', DEMO.siteHq, input, 'anna'); // doppelt abgeschickt
      const n = (await getNote(sql, id))!;
      expect(n.version).toBe(2);
      await saveNote(
        sql,
        id,
        'site',
        DEMO.siteHq,
        { ...input, body: 'Treppenhaus', expectedVersion: n.version },
        'ben',
      );
      const m = (await getNote(sql, id))!;
      expect(m).toMatchObject({
        author: 'anna',
        updated_by: 'ben',
        body: 'Treppenhaus',
        note_date: '2026-10-01',
      });
      await expect(
        saveNote(sql, id, 'site', DEMO.siteHq, { ...input, expectedVersion: n.version }, 'anna'),
      ).rejects.toThrow(/zwischenzeitlich/);
      await expect(saveNote(sql, id, 'customer', DEMO.authority, input, 'x')).rejects.toThrow(
        /anderen Datensatz/,
      );
      await expect(
        saveNote(sql, randomUUID(), 'site', DEMO.siteHq, { ...input, title: ' ', body: ' ' }, 'x'),
      ).rejects.toThrow(/Titel oder Details/);
    });

    it('Aufgabe anlegen, erledigen, Fälligkeitsfilter', async () => {
      const id = randomUUID();
      await saveTask(
        sql,
        id,
        {
          title: 'Angebot nachfassen',
          description: null,
          due_date: '2026-10-05',
          assignee: 'Ahmed',
          entity_type: 'customer',
          entity_id: DEMO.company,
        },
        'test',
      );
      await saveTask(
        sql,
        id,
        {
          title: 'doppelt',
          description: null,
          due_date: null,
          assignee: null,
          entity_type: null,
          entity_id: null,
        },
        'test',
      );
      const open = await listTasks(sql, { status: 'open', entity: { type: 'customer', id: DEMO.company } });
      expect(open.map((t) => t.title)).toEqual(['Angebot nachfassen']);
      expect(open[0]!.entity_label).toContain('DEMO Musterfirma');
      await setTaskDone(sql, id, true, 'test');
      expect(
        await listTasks(sql, { status: 'open', entity: { type: 'customer', id: DEMO.company } }),
      ).toHaveLength(0);
    });
  });

  describe('Zahlungen & Offene Posten', () => {
    it('Teilzahlung, Restzahlung, Überzahlung abgelehnt', async () => {
      const id = await issuedInvoice('1.000,00'); // 1.190,00 brutto
      const op = async () => (await listOpenItems(sql)).find((o) => o.invoice_id === id);
      expect((await op())!.open_cents).toBe(119000n);
      const pay1 = randomUUID();
      await bookPayment(
        sql,
        pay1,
        id,
        { amount: parseEuro('500,00'), paid_on: '2026-10-05', method: 'ueberweisung', reference: 'RE' },
        'test',
      );
      await bookPayment(
        sql,
        pay1,
        id,
        { amount: parseEuro('500,00'), paid_on: '2026-10-05', method: 'ueberweisung', reference: 'RE' },
        'test',
      ); // doppelt geklickt
      expect((await op())!.open_cents).toBe(69000n);
      await expect(
        bookPayment(
          sql,
          randomUUID(),
          id,
          { amount: parseEuro('700,00'), paid_on: '2026-10-06', method: 'ueberweisung', reference: null },
          'test',
        ),
      ).rejects.toThrow(/höher als der offene Posten/);
      await bookPayment(
        sql,
        randomUUID(),
        id,
        { amount: parseEuro('690,00'), paid_on: '2026-10-06', method: 'ueberweisung', reference: null },
        'test',
      );
      const [view] = await sql`select open_cents, paid_cents from app.open_items where invoice_id = ${id}`;
      expect(view!.open_cents).toBe(0n);
      expect(view!.paid_cents).toBe(119000n);
      expect(await op()).toBeUndefined(); // ausgeglichen → nicht mehr in der OP-Liste
    });

    it('Fehlbuchung nur per Gegenbuchung korrigierbar', async () => {
      const id = await issuedInvoice('100,00');
      const pay = randomUUID();
      await bookPayment(
        sql,
        pay,
        id,
        { amount: parseEuro('119,00'), paid_on: '2026-10-05', method: 'bar', reference: null },
        'test',
      );
      await expect(sql`update app.payments set amount_cents = 1 where id = ${pay}`).rejects.toThrow(
        /nur anhängbar/,
      );
      await expect(sql`delete from app.payments where id = ${pay}`).rejects.toThrow(/nur anhängbar/);
      await reversePayment(sql, pay, 'test', 'falsche Rechnung');
      await reversePayment(sql, pay, 'test', 'nochmal'); // idempotent
      const item = (await listOpenItems(sql)).find((o) => o.invoice_id === id)!;
      expect(item.open_cents).toBe(11900n);
    });

    it('Stornierte Rechnung ist kein offener Posten mehr', async () => {
      const id = await issuedInvoice('200,00');
      const storno = await createCancellation(sql, id, 'test');
      await issue(sql, storno, 'test', '2026-10-02');
      expect((await listOpenItems(sql)).some((o) => o.invoice_id === id)).toBe(false);
      await expect(
        bookPayment(
          sql,
          randomUUID(),
          storno,
          { amount: parseEuro('1,00'), paid_on: '2026-10-05', method: 'bar', reference: null },
          'test',
        ),
      ).rejects.toThrow();
    });

    it('Summen je Kunde für die Startseite', async () => {
      const balances = await listBalances(sql);
      const mine = balances.find((b) => b.customer_id === DEMO.company);
      const items = (await listOpenItems(sql, DEMO.company)).reduce((s, o) => s + o.open_cents, 0n);
      expect(mine?.open_cents ?? 0n).toBe(items);
    });
  });

  describe('Personal', () => {
    const base = {
      personnel_no: '1001',
      first_name: 'Elena',
      last_name: 'Popescu',
      employment_type: 'teilzeit',
      entry_date: '2024-10-08',
      exit_date: '',
      weekly_hours: '25',
      hourly_wage: '14,25',
      phone: '',
      email: '',
      languages: 'Rumänisch, Deutsch',
      version: '',
      birth_date: '1990-10-12',
      street: 'Musterweg 1',
      postal_code: '81375',
      city: 'München',
      nationality: 'rumänisch',
      tax_id: '12345678901',
      social_security_no: '',
      health_insurance: 'AOK Bayern',
      iban: 'DE89 3704 0044 0532 0130 00',
      residence_permit_until: '',
      private_version: '',
    };

    it('IBAN-Prüfziffer', () => {
      expect(validIban('DE89 3704 0044 0532 0130 00')).toBe(true);
      expect(validIban('DE89 3704 0044 0532 0130 01')).toBe(false);
      expect(validIban('DE39701900000003297837')).toBe(true);
    });

    it('validiert Steuer-ID und IBAN', () => {
      expect(employeeInput.safeParse({ ...base, tax_id: '123' }).success).toBe(false);
      expect(employeeInput.safeParse({ ...base, iban: 'DE00 1234' }).success).toBe(false);
      expect(employeeInput.safeParse({ ...base, exit_date: '2020-01-01' }).success).toBe(false);
    });

    it('anlegen, Stundenlohn Cent-genau, Export für Lexware', async () => {
      const id = randomUUID();
      await saveEmployee(sql, id, employeeInput.parse(base), 'test');
      const e = (await getEmployee(sql, id))!;
      expect(e.employee.hourly_wage_cents).toBe(1425n);
      expect(e.employee.languages).toEqual(['Rumänisch', 'Deutsch']);
      expect(e.priv?.iban).toBe('DE89370400440532013000');
      const csv = await exportEmployeesCsv(sql);
      expect(csv.startsWith('﻿Personalnummer;Nachname')).toBe(true);
      expect(csv).toContain('1001;Popescu;Elena;Teilzeit;08.10.2024;;25;14,25;12.10.1990');
      await expect(saveEmployee(sql, randomUUID(), employeeInput.parse(base), 'test')).rejects.toThrow(
        /Personalnummer ist bereits vergeben/,
      );
    });

    it('Protokoll enthält keine vertraulichen Daten', async () => {
      const rows = await sql`select details::text as d from app.audit_log where entity = 'employee'`;
      for (const r of rows) {
        expect(r.d).not.toContain('12345678901');
        expect(r.d).not.toContain('DE89');
      }
    });

    it('Büro sieht Mitarbeiter, aber keine vertraulichen Daten; Personal sieht beides', async () => {
      const office = randomUUID();
      const hr = randomUUID();
      await sql`insert into auth.users (id) values (${office}), (${hr})`;
      await sql`insert into app.profiles (user_id, display_name, role) values (${office}, 'Büro', 'buchhaltung'), (${hr}, 'Personal', 'personal')`;
      const as = (uid: string) =>
        sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid })}, true),
                         set_config('request.jwt.claim.sub', ${uid}, true)`;
          await tx`set local role authenticated`;
          const [e] = await tx`select count(*)::int as n from app.employees`;
          const [p] = await tx`select count(*)::int as n from app.employee_private`;
          return { employees: e!.n, private: p!.n };
        });
      const o = await as(office);
      expect(o.employees).toBeGreaterThan(0);
      expect(o.private).toBe(0);
      const h = await as(hr);
      expect(h.private).toBeGreaterThan(0);
    });
  });
});
