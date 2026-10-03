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
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { requestAbsence } from '../services/absences.js';
import { setPin } from '../services/employee-auth.js';
import { bookStock } from '../services/inventory.js';
import { getSeller } from '../services/masterdata.js';
import {
  createPaymentRun,
  decideIncoming,
  receiveOrder,
  saveIncoming,
  saveOrder,
  setOrderStatus,
} from '../services/purchasing.js';
import { plannedShifts, requestCorrection, saveShiftPlan } from '../services/time.js';
import { createUser, updateUser } from '../services/users.js';

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
  await phase3();
  // Belege (PDF, XRechnung/ZUGFeRD, KoSIT-Prüfbericht) für alle ausgestellten Rechnungen erzeugen
  const issued = await sql<{ id: string }[]>`select id from app.invoices where status = 'issued'`;
  for (const i of issued) await ensureDocuments(deps, i.id);
  console.log(`Belege für ${issued.length} Rechnungen erzeugt.`);
} finally {
  await sql.end();
}

/** Zeiterfassung, Einsatzplanung, Urlaub, Einkauf, Benutzer – Beispielvorgänge relativ zu heute. */
async function phase3() {
  const [done] = await sql`select 1 from app.shift_plans limit 1`;
  if (done) return;
  const today = todayBerlin();
  const emps = await sql<
    { id: string; personnel_no: string }[]
  >`select id, personnel_no from app.employees order by personnel_no`;
  const E = Object.fromEntries(emps.map((e) => [e.personnel_no, e.id])) as Record<string, string>;
  if (!E['1001']) return;
  await setPin(sql, E['1001'], '4821', A);
  for (const [no, site] of [
    ['1002', DEMO.siteSchool],
    ['1003', DEMO.siteOffice],
    ['1004', DEMO.siteHq],
  ] as const) {
    await sql`insert into app.employee_sites (employee_id, site_id) values (${E[no]!}, ${site}) on conflict do nothing`;
  }
  // Einsatzplan (seit 60 Tagen)
  const plans: [string, string, number[], string, string, number][] = [
    ['1001', DEMO.siteSchool, [1, 2, 3, 4, 5], '05:00', '08:30', 0],
    ['1002', DEMO.siteSchool, [1, 2, 3, 4, 5], '16:00', '20:00', 0],
    ['1003', DEMO.siteOffice, [2, 4], '17:00', '19:00', 0],
    ['1004', DEMO.siteHq, [1, 2, 3, 4, 5], '06:00', '12:30', 30],
  ];
  for (const [no, site, days, from, to, brk] of plans) {
    const ids = await saveShiftPlan(
      sql,
      randomUUID(),
      {
        employeeId: E[no]!,
        siteId: site,
        weekdays: days,
        startTime: from,
        endTime: to,
        breakMinutes: brk,
        validFrom: '2026-08-01',
        validUntil: null,
        note: null,
      },
      A,
    );
    await sql`update app.shift_plans set created_at = now() - interval '60 days' where id in ${sql(ids)}`;
  }
  // Abwesenheiten
  await requestAbsence(sql, {
    id: randomUUID(),
    employeeId: E['1003']!,
    kind: 'krank',
    start: addDays(today, -6),
    end: addDays(today, -5),
    halfDay: false,
    note: 'AU liegt vor',
    actor: A,
    approved: true,
  });
  await requestAbsence(sql, {
    id: randomUUID(),
    employeeId: E['1004']!,
    kind: 'urlaub',
    start: addDays(today, 9),
    end: addDays(today, 13),
    halfDay: false,
    note: null,
    actor: A,
    approved: true,
  });
  await requestAbsence(sql, {
    id: randomUUID(),
    employeeId: E['1002']!,
    kind: 'urlaub',
    start: '2026-12-21',
    end: '2026-12-31',
    halfDay: false,
    note: null,
    actor: 'm:1002',
  });
  // Ist-Zeiten der letzten 12 Tage aus dem Plan (mit kleinen Abweichungen), einzelne Lücken
  const shifts = await plannedShifts(sql, { from: addDays(today, -12), to: addDays(today, -1) });
  let n = 0;
  await sql.begin(async (tx) => {
    await tx`select set_config('app.actor', 'demo', true)`;
    for (const s of shifts) {
      if (s.absence || s.entry || s.holiday) continue;
      n++;
      if (n % 17 === 5) continue; // vergessen → erscheint als „fehlt“
      const jitterStart = ((n * 7) % 9) - 3;
      const jitterEnd = ((n * 5) % 11) - 2;
      await tx`
        insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source, status, via_qr, created_by, recorded_at)
        values (${randomUUID()}, ${s.plan.employee_id}, ${s.plan.site_id}, ${s.date},
                ((${s.date}::date + ${s.plan.start_time}::time) at time zone 'Europe/Berlin') + make_interval(mins => ${jitterStart}),
                ((${s.date}::date + ${s.plan.end_time}::time) at time zone 'Europe/Berlin') + make_interval(mins => ${jitterEnd}),
                ${s.plan.break_minutes}, ${n % 6 === 0 ? 'soll_bestaetigt' : 'stempel'}, 'erfasst', ${n % 6 !== 0},
                ${'m:' + s.plan.personnel_no},
                ((${s.date}::date + ${s.plan.end_time}::time) at time zone 'Europe/Berlin') + make_interval(mins => ${jitterEnd}))`;
    }
  });
  // offener Nachtrag
  const y = addDays(today, -1);
  await requestCorrection(sql, {
    id: randomUUID(),
    employeeId: E['1003']!,
    siteId: DEMO.siteOffice,
    date: y,
    start: '18:00',
    end: '20:15',
    breakMinutes: 0,
    reason: 'Sonderreinigung nach Veranstaltung, Handy vergessen',
    actor: 'm:1003',
  }).catch(() => undefined);

  // Einkauf
  const SUP = '00000000-0000-4000-8000-000000000221';
  const SUB = '00000000-0000-4000-8000-000000000222';
  const po = randomUUID();
  await saveOrder(
    sql,
    po,
    {
      supplierId: SUP,
      siteId: null,
      orderDate: addDays(today, -9),
      deliveryDate: addDays(today, -6),
      note: null,
      lines: [
        {
          articleId: '00000000-0000-4000-8000-000000000231',
          description: 'Allzweckreiniger 10 l',
          quantity: parseQuantity('12'),
          unit: 'Kanister',
          unitPrice: parseEuro('28,90'),
        },
        {
          articleId: '00000000-0000-4000-8000-000000000233',
          description: 'Müllbeutel 120 l (Rolle à 25)',
          quantity: parseQuantity('40'),
          unit: 'Rolle',
          unitPrice: parseEuro('6,90'),
        },
      ],
      expectedVersion: null,
    },
    A,
  );
  await setOrderStatus(sql, po, 'bestellt', A);
  await receiveOrder(sql, po, A);
  const po2 = randomUUID();
  await saveOrder(
    sql,
    po2,
    {
      supplierId: SUP,
      siteId: DEMO.siteSchool,
      orderDate: today,
      deliveryDate: addDays(today, 4),
      note: 'Bitte vor 7 Uhr anliefern (Hausmeister).',
      lines: [
        {
          articleId: '00000000-0000-4000-8000-000000000234',
          description: 'Mikrofasertücher blau (10 Stk.)',
          quantity: parseQuantity('20'),
          unit: 'Pack',
          unitPrice: parseEuro('12,90'),
        },
      ],
      expectedVersion: null,
    },
    A,
  );
  await setOrderStatus(sql, po2, 'bestellt', A);
  const inv1 = randomUUID();
  await saveIncoming(
    sql,
    inv1,
    {
      supplierId: SUP,
      invoiceNo: 'RS-2026-1187',
      invoiceDate: addDays(today, -5),
      dueDate: null,
      serviceMonth: null,
      net: parseEuro('622,80'),
      vat: parseEuro('118,33'),
      reverseCharge: false,
      category: 'material',
      siteId: DEMO.siteSchool,
      purchaseOrderId: po,
      skontoUntil: addDays(today, 4),
      skontoPercentBp: 200,
      note: null,
      expectedVersion: null,
    },
    A,
  );
  await decideIncoming(sql, inv1, 'freigegeben', A);
  const inv2 = randomUUID();
  await saveIncoming(
    sql,
    inv2,
    {
      supplierId: SUB,
      invoiceNo: 'GF-0915',
      invoiceDate: addDays(today, -3),
      dueDate: null,
      serviceMonth: addDays(today, -30).slice(0, 7),
      net: parseEuro('1.480,00'),
      vat: 0n as never,
      reverseCharge: true,
      category: 'nachunternehmer',
      siteId: DEMO.siteSchool,
      purchaseOrderId: null,
      skontoUntil: null,
      skontoPercentBp: null,
      note: 'Glasreinigung Schule, § 13b',
      expectedVersion: null,
    },
    A,
  );
  const inv3 = randomUUID();
  await saveIncoming(
    sql,
    inv3,
    {
      supplierId: SUP,
      invoiceNo: 'RS-2026-1102',
      invoiceDate: addDays(today, -20),
      dueDate: addDays(today, -6),
      serviceMonth: null,
      net: parseEuro('214,50'),
      vat: parseEuro('40,76'),
      reverseCharge: false,
      category: 'material',
      siteId: DEMO.siteHq,
      purchaseOrderId: null,
      skontoUntil: null,
      skontoPercentBp: null,
      note: null,
      expectedVersion: null,
    },
    A,
  );
  await decideIncoming(sql, inv3, 'freigegeben', A);
  const seller = await getSeller(sql);
  await createPaymentRun(deps, {
    id: randomUUID(),
    invoiceIds: [inv3],
    executionDate: today,
    debtorIban: seller.bankAccounts[0]!.iban,
    actor: A,
  });
  await sql`update app.accounting_settings set datev_consultant_no = '1234567', datev_client_no = '10001'`;
  // Lagerabgang an Objekt (Nachkalkulation Material)
  await bookStock(
    sql,
    randomUUID(),
    '00000000-0000-4000-8000-000000000231',
    -parseQuantity('3'),
    'Ausgabe an Objekt',
    DEMO.siteSchool,
    A,
  );

  // Benutzer
  const olga = await createUser(
    sql,
    {
      login: 'olga',
      name: 'Olga Objektleitung',
      email: null,
      role: 'objektleitung',
      password: 'DemoPasswort1',
      mustChange: false,
    },
    A,
  );
  await updateUser(
    sql,
    olga.id,
    {
      name: 'Olga Objektleitung',
      email: null,
      role: 'objektleitung',
      active: true,
      siteIds: [DEMO.siteSchool, DEMO.siteOffice],
      expectedVersion: null,
    },
    A,
  );
  await createUser(
    sql,
    {
      login: 'sabine',
      name: 'Sabine Buchhaltung',
      email: 'buchhaltung@viva-deluxe.example',
      role: 'buchhaltung',
      password: 'DemoPasswort1',
      mustChange: false,
    },
    A,
  );
  console.log('Demo Phase 3 angelegt.');
}
