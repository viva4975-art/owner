// Reichert eine DEMO-Datenbank mit Vorgängen an (ausgestellte Rechnungen, Storno, Zahlung, Mahnung, Personal,
// Aufgaben) – Grundlage für die Klick-Demo. Läuft nur, wenn der Datenbankname "demo" enthält.
// Aufruf: npx tsx --env-file=.env.demo src/scripts/demo-data.ts
import { randomUUID } from 'node:crypto';
import { LocalArchiveStore } from '../archive/store.js';
import { loadEnv } from '../config/env.js';
import { createSql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { addNote, saveContact, contactInput, saveTask, taskInput } from '../services/crm.js';
import { createDunning } from '../services/dunning.js';
import { employeeInput, saveEmployee, setEmployeeSites } from '../services/employees.js';
import { keyAction } from '../services/inventory.js';
import { createCancellation, issue, runMonthly, saveDraft } from '../services/invoices.js';
import { bookPayment } from '../services/payments.js';
import { DEMO } from '../services/seed.js';
import { type Deps, ensureDocuments } from '../services/workflow.js';

const env = loadEnv();
if (env.APP_ENV === 'live' || !/demo/.test(new URL(env.DATABASE_URL).pathname)) {
  throw new Error('Nur für Demo-Datenbanken (Name muss "demo" enthalten)');
}
const sql = createSql(env.DATABASE_URL);
const deps: Deps = {
  sql,
  env,
  archive: new LocalArchiveStore(env.ARCHIVE_DIR),
  mailer: { send: async (m) => ({ messageId: m.messageId }) },
};
const A = 'ahmed';

try {
  const [done] = await sql`select 1 from app.invoices where status = 'issued' limit 1`;
  if (done) {
    console.log('Demo-Vorgänge sind bereits angelegt.');
  } else {
    // Mitarbeitende
    const people = [
      [
        '1001',
        'Elena',
        'Popescu',
        'teilzeit',
        '2024-10-08',
        '25',
        '14,25',
        'Rumänisch, Deutsch',
        '1990-10-12',
        '2026-11-15',
      ],
      [
        '1002',
        'Mehmet',
        'Yılmaz',
        'vollzeit',
        '2019-03-01',
        '39',
        '15,10',
        'Türkisch, Deutsch',
        '1984-02-20',
        null,
      ],
      [
        '1003',
        'Ana',
        'Kovačević',
        'minijob',
        '2025-06-15',
        '8',
        '13,90',
        'Kroatisch, Deutsch',
        '1999-07-03',
        null,
      ],
      ['1004', 'Josef', 'Huber', 'vollzeit', '2016-10-04', '39', '16,40', 'Deutsch', '1972-10-09', null],
    ] as const;
    const empIds: string[] = [];
    for (const [no, first, last, type, entry, hours, wage, langs, birth, permit] of people) {
      const id = randomUUID();
      empIds.push(id);
      await saveEmployee(
        sql,
        id,
        employeeInput.parse({
          personnel_no: no,
          first_name: first,
          last_name: last,
          employment_type: type,
          entry_date: entry,
          weekly_hours: hours,
          hourly_wage: wage,
          languages: langs,
          birth_date: birth,
          residence_permit_until: permit ?? '',
          city: 'München',
        }),
        A,
      );
      await setEmployeeSites(sql, id, [DEMO.siteSchool]);
    }

    // Rechnungen: Sommer-Monatsrechnung (überfällig → Mahnung), Monatslauf August + September
    const line = (d: string, p: string) => ({
      description: d,
      quantity: parseQuantity('1'),
      unitCode: 'LS',
      unitPrice: parseEuro(p),
      vatRate: 1900,
    });
    const old = randomUUID();
    await saveDraft(
      sql,
      old,
      {
        customerId: DEMO.company,
        siteId: DEMO.siteHq,
        kind: 'invoice',
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        orderReference: null,
        introText: null,
        closingText: null,
        lines: [line('Unterhaltsreinigung Juli 2026', '1.399,00')],
      },
      A,
    );
    await issue(sql, old, A, '2026-08-01');
    const special = randomUUID();
    await saveDraft(
      sql,
      special,
      {
        customerId: DEMO.company,
        siteId: DEMO.siteHq,
        kind: 'invoice',
        periodStart: '2026-08-12',
        periodEnd: '2026-08-12',
        orderReference: null,
        introText: 'Sonderreinigung nach Wasserschaden:',
        closingText: null,
        lines: [
          { ...line('Regiestunden Sonderreinigung', '31,50'), unitCode: 'HUR', quantity: parseQuantity('6') },
          line('Entsorgung', '80,00'),
        ],
      },
      A,
    );
    await issue(sql, special, A, '2026-08-14');
    for (const [month, date] of [
      ['2026-08', '2026-09-01'],
      ['2026-09', '2026-10-01'],
    ] as const) {
      await runMonthly(sql, month, A);
      const drafts = await sql<{ id: string }[]>`
        select id from app.invoices where status = 'draft' and period_start = ${`${month}-01`} order by created_at`;
      for (const d of drafts) await issue(sql, d.id, A, date);
    }
    // Storno einer Rechnung (z. B. falscher Zeitraum) + Zahlung auf eine Rechnung
    const storno = await createCancellation(sql, special, A);
    await issue(sql, storno, A, '2026-08-20');
    const [paid] = await sql<{ id: string; payable_cents: bigint }[]>`
      select id, payable_cents from app.invoices where customer_id = ${DEMO.authority} and status = 'issued'
       and period_start = '2026-08-01' order by number limit 1`;
    if (paid) {
      await bookPayment(
        sql,
        randomUUID(),
        paid.id,
        {
          amount: paid.payable_cents as never,
          paid_on: '2026-09-22',
          method: 'ueberweisung',
          reference: 'Landeshauptstadt',
        },
        A,
      );
    }
    // Ein neuer Entwurf für den Oktober-Lauf
    await runMonthly(sql, '2026-10', A);

    // Mahnung zur Juli-Rechnung
    await createDunning(deps, randomUUID(), DEMO.company, [old], A);

    // Kontakte, Notizen, Aufgaben
    await saveContact(
      sql,
      randomUUID(),
      DEMO.company,
      contactInput.parse({
        salutation: 'Frau',
        first_name: 'Sabine',
        last_name: 'Beispiel',
        position: 'Einkauf',
        email: 'einkauf@musterfirma.example',
        phone: '089 555 0102',
        invoice_recipient: 'on',
      }),
    );
    await addNote(
      sql,
      randomUUID(),
      'customer',
      DEMO.company,
      'Telefonat: Kunde wünscht ab 2027 zusätzlich Glasreinigung 2x jährlich – Angebot vorbereiten.',
      A,
    );
    await addNote(
      sql,
      randomUUID(),
      'site',
      DEMO.siteSchool,
      'Hausmeister Herr Maier, Tel. 089 555 0199. Schlüsselübergabe nur werktags 7–8 Uhr.',
      A,
    );
    for (const [title, due, type, id] of [
      ['Preisanpassung 2027 mit Frau Beispiel besprechen', '2026-10-06', 'customer', DEMO.company],
      ['Glasreinigung Schule terminieren (Herbstferien)', '2026-10-27', 'site', DEMO.siteSchool],
      ['Aufenthaltserlaubnis Popescu – Verlängerung anfordern', '2026-10-15', 'employee', empIds[0]],
    ] as const) {
      await saveTask(
        sql,
        randomUUID(),
        taskInput.parse({ title, due_date: due, assignee: 'Ahmed', entity_type: type, entity_id: id }),
        A,
      );
    }
    await keyAction(
      sql,
      '00000000-0000-4000-8000-000000000251',
      'ausgabe',
      empIds[0]!,
      '2026-09-01',
      'für Frühschicht',
      A,
    );
    console.log('Demo-Vorgänge angelegt.');
  }
  // Belege (PDF, XRechnung/ZUGFeRD, KoSIT-Prüfbericht) für alle ausgestellten Rechnungen erzeugen
  const issued = await sql<{ id: string }[]>`select id from app.invoices where status = 'issued'`;
  for (const i of issued) await ensureDocuments(deps, i.id);
  console.log(`Belege für ${issued.length} Rechnungen erzeugt.`);
} finally {
  await sql.end();
}
