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
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import {
  closeQualityCheck,
  createQualityCheck,
  getQualityCheck,
  saveQualityCheck,
  saveRoom,
} from '../services/facility.js';
import { groupBillingInput, saveInvoiceGroup, setSiteInvoiceGroup } from '../services/invoice-groups.js';
import {
  closeWithoutSignature,
  saveOrder as saveCustomerOrder,
  saveWorkReport,
  signWorkReport,
} from '../services/orders.js';
import { createSignDocument, requestsForEmployee, signRequest } from '../services/sign-documents.js';
import { saveException } from '../services/planning.js';
import { copyOffer, saveOffer, setOfferStatus } from '../services/offers.js';
import { importStatement } from '../services/bank.js';
import { applyImport } from '../services/fortytools-import.js';
import { ensureSiteGroups } from '../services/masterdata.js';
import { saveTender, setTenderStatus } from '../services/tenders.js';
import { bookStock as bookClothing, saveHandover, signHandover } from '../services/handovers.js';
import {
  addPriceChange,
  docTypes,
  reviewDocument,
  saveSubcontract,
  setSubcontractStatus,
  uploadDocument,
} from '../services/subcontractors.js';

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
  await phase4();
  await phase5();
  await phase6();
  await phase7();
  await phase8();
  await phase9();
  await ensureSiteGroups(sql);
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

/** Unterschrift als PNG (Schwung) – ohne Canvas, für Demo-Daten. */
function signaturePng(seed: number): Uint8Array {
  const w = 360;
  const h = 110;
  const px = new Uint8Array(w * h).fill(255);
  for (let x = 20; x < w - 20; x++) {
    const y = Math.round(55 + Math.sin(x / (14 + seed)) * 28 * Math.cos(x / 90) + Math.sin(x / 5) * 4);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) px[(y + dy) * w + x + dx] = 20;
  }
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    Buffer.from(px.subarray(y * w, (y + 1) * w)).copy(raw, y * (w + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 0; // Graustufen
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Aufträge/Arbeitsscheine, Raumbuch, Qualitätskontrolle, Rechnungsgruppe, Dokumente. */
async function phase4() {
  const [done] = await sql`select 1 from app.rooms limit 1`;
  if (done) return;
  const today = todayBerlin();
  const emps = await sql<{ id: string; personnel_no: string }[]>`select id, personnel_no from app.employees`;
  const E = Object.fromEntries(emps.map((e) => [e.personnel_no, e.id])) as Record<string, string>;

  // Raumbuch Grundschule
  const T = (n: number) => `00000000-0000-4000-8000-0000000a000${n.toString(16)}`;
  const rooms: [string, string, string, number, string, string, number][] = [
    ['EG', '0.01', 'Eingangshalle', 5, 'Naturstein', '86', 260],
    ['EG', '0.02', 'Sekretariat', 1, 'Linoleum', '32', 260],
    ['EG', '0.03', 'Lehrerzimmer', 2, 'Linoleum', '58', 260],
    ['EG', '0.04', 'WC Mädchen', 6, 'Fliesen', '24', 260],
    ['EG', '0.05', 'WC Jungen', 6, 'Fliesen', '26', 260],
    ['EG', '0.10', 'Flur EG', 4, 'Linoleum', '140', 260],
    ['1. OG', '1.01', 'Klasse 1a', 3, 'Linoleum', '64', 260],
    ['1. OG', '1.02', 'Klasse 1b', 3, 'Linoleum', '64', 260],
    ['1. OG', '1.03', 'Klasse 2a', 3, 'Linoleum', '62', 260],
    ['1. OG', '1.10', 'Flur 1. OG', 4, 'Linoleum', '120', 260],
    ['1. OG', '1.20', 'Teeküche', 8, 'Fliesen', '14', 260],
    ['UG', 'U.01', 'Turnhalle', 9, 'Sportboden', '420', 104],
    ['UG', 'U.02', 'Umkleiden', 7, 'Fliesen', '48', 104],
    ['UG', 'U.05', 'Technik', 10, 'Beton', '35', 12],
  ];
  let i = 0;
  for (const [floor, no, name, type, cov, area, visits] of rooms) {
    await saveRoom(sql, `00000000-0000-4000-8000-0000000b${String(++i).padStart(4, '0')}`, {
      siteId: DEMO.siteSchool,
      roomNo: no,
      name,
      floor,
      roomTypeId: T(type),
      floorCovering: cov,
      areaCenti: parseEuro(area),
      visitsPerYear: visits,
      notes: null,
      active: true,
      expectedVersion: null,
    });
  }

  // Qualitätskontrollen: eine vor 3 Wochen (abgeschlossen), eine heute in Arbeit
  for (const [id, date, close] of [
    ['00000000-0000-4000-8000-0000000c0001', addDays(today, -21), true],
    ['00000000-0000-4000-8000-0000000c0002', today, false],
  ] as const) {
    await createQualityCheck(
      sql,
      id,
      { siteId: DEMO.siteSchool, checkDate: date, inspector: 'Ahmed Chomontek', attendee: null },
      A,
    );
    const qc = (await getQualityCheck(sql, id))!;
    await saveQualityCheck(sql, id, {
      attendee: 'Hausmeister Maier',
      summary: close ? 'Insgesamt sauber, Sanitär nacharbeiten.' : null,
      items: qc.items.map((it, k) => ({
        id: it.id,
        rating:
          !close && k > 6
            ? 'nicht_geprueft'
            : it.area.includes('WC Jungen') || (close && it.area.includes('Teeküche'))
              ? 'mangel'
              : 'ok',
        defects: it.area.includes('WC')
          ? ['Sanitärobjekte', 'Verbrauchsmaterial']
          : ['Oberflächen / Mobiliar'],
        note: it.area.includes('WC') ? 'Urinale verkalkt, Seife leer' : 'Arbeitsfläche klebrig',
      })),
      extraArea: null,
      expectedVersion: null,
    });
    if (close)
      await closeQualityCheck(
        deps,
        id,
        { signature: { name: 'Hausmeister Maier', png: signaturePng(1) } },
        A,
      );
  }

  // Auftrag mit unterschriebenem Arbeitsschein, Regiearbeit ohne Unterschrift
  const order = '00000000-0000-4000-8000-0000000e0001';
  await saveCustomerOrder(
    sql,
    order,
    {
      customerId: DEMO.authority,
      siteId: DEMO.siteSchool,
      offerId: null,
      title: 'Grundreinigung Turnhalle nach Sanierung',
      description: 'Bauendreinigung inkl. Grundreinigung Sportboden',
      orderReference: 'BE-2026-0117',
      plannedDate: addDays(today, -3),
      lines: [
        {
          description: 'Grundreinigung Sportboden Turnhalle',
          detail: null,
          quantity: parseQuantity('420'),
          unitCode: 'MTK',
          unitPrice: parseEuro('2,40'),
          vatRate: 1900,
        },
        {
          description: 'Bauendreinigung Umkleiden',
          detail: null,
          quantity: parseQuantity('1'),
          unitCode: 'LS',
          unitPrice: parseEuro('380,00'),
          vatRate: 1900,
        },
      ],
      expectedVersion: null,
    },
    A,
  );
  const wr = '00000000-0000-4000-8000-0000000e0101';
  await saveWorkReport(
    sql,
    wr,
    {
      orderId: order,
      siteId: DEMO.siteSchool,
      workDate: addDays(today, -3),
      startTime: '07:00',
      endTime: '14:30',
      employeeIds: [E['1001'], E['1002']].filter(Boolean) as string[],
      description: 'Sportboden maschinell grundgereinigt und eingepflegt, Umkleiden bauendgereinigt',
      materials: 'Grundreiniger 10 l, Sportbodenpflege 5 l',
      remarks: 'Sehr gut, danke!',
      lines: [
        { description: 'Grundreinigung Sportboden', quantity: parseQuantity('420'), unitCode: 'MTK' },
        { description: 'Regiestunden', quantity: parseQuantity('15'), unitCode: 'HUR' },
      ],
      expectedVersion: null,
    },
    A,
  );
  await signWorkReport(deps, wr, { name: 'Hausmeister Maier', png: signaturePng(2) }, A);
  const wr2 = '00000000-0000-4000-8000-0000000e0102';
  await saveWorkReport(
    sql,
    wr2,
    {
      orderId: null,
      siteId: DEMO.siteSchool,
      workDate: addDays(today, -1),
      startTime: '18:00',
      endTime: '20:00',
      employeeIds: [E['1002']].filter(Boolean) as string[],
      description: 'Wasserschaden Keller: Wasser aufgenommen, Boden getrocknet',
      materials: null,
      remarks: null,
      lines: [{ description: 'Regiestunden', quantity: parseQuantity('2'), unitCode: 'HUR' }],
      expectedVersion: null,
    },
    A,
  );
  await closeWithoutSignature(deps, wr2, 'Hausmeister nicht mehr im Haus', A);
  await saveWorkReport(
    sql,
    '00000000-0000-4000-8000-0000000e0103',
    {
      orderId: null,
      siteId: DEMO.siteOffice,
      workDate: today,
      startTime: '17:00',
      endTime: null,
      employeeIds: [],
      description: 'Glasreinigung Eingang (Sonderwunsch)',
      materials: null,
      remarks: null,
      lines: [{ description: 'Regiestunden', quantity: parseQuantity('1,5'), unitCode: 'HUR' }],
      expectedVersion: null,
    },
    A,
  );

  // Rechnungsgruppe (wirkt ab dem nächsten Monatslauf)
  await saveInvoiceGroup(
    sql,
    '00000000-0000-4000-8000-0000000f0001',
    {
      customerId: DEMO.authority,
      name: 'Referat für Bildung – Sammelrechnung',
      combine: true,
      billing: groupBillingInput.parse({
        bill_emails: 'rechnung-bildung@example.org',
        bill_format: 'xrechnung',
        buyer_reference: '09162000-DEMO-90',
        bill_payment_terms_days: '30',
      }),
      orderReference: 'SR-2026-RfB',
      note: 'Ab November alle Schulen auf einer Rechnung',
      active: true,
      siteIds: [DEMO.siteSchool, DEMO.siteOffice],
      expectedVersion: null,
    },
    A,
  );

  // Dokument zur Unterschrift: 1001 offen (Handy-Demo), 1002 unterschrieben
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pg = doc.addPage([595.28, 841.89]);
  pg.drawText('Unterweisung Arbeitsschutz 2026 (DEMO)', { x: 56, y: 780, size: 16, font: bold });
  const text = [
    '1. Reinigungsmittel nur nach Betriebsanweisung verwenden, nie mischen.',
    '2. Schutzhandschuhe bei Sanitärreinigung tragen.',
    '3. Nasse Böden mit Warnschild kennzeichnen.',
    '4. Leitern nur geprüft und standsicher benutzen.',
    '5. Unfälle sofort der Objektleitung melden.',
  ];
  text.forEach((t, k) => pg.drawText(t, { x: 56, y: 740 - k * 22, size: 11, font }));
  const pdf = await doc.save();
  const docId = '00000000-0000-4000-8000-0000000f0101';
  await createSignDocument(
    deps,
    docId,
    {
      title: 'Unterweisung Arbeitsschutz 2026',
      category: 'unterweisung',
      description: 'Bitte lesen und bis Monatsende unterschreiben.',
      dueDate: addDays(today, 14),
      fileName: 'Unterweisung_Arbeitsschutz_2026.pdf',
      pdf,
      employeeIds: [E['1001'], E['1002'], E['1003']].filter(Boolean) as string[],
    },
    A,
  );
  if (E['1002']) {
    const [r] = await requestsForEmployee(sql, E['1002']);
    if (r)
      await signRequest(deps, r.id, E['1002'], {
        png: signaturePng(3),
        confirmed: true,
        ip: '192.0.2.10',
        userAgent: 'Demo (Android, Chrome)',
      });
  }
  console.log('Demo Phase 4 angelegt.');
}

/** Leistungen wie Fortytools: Leistungsarten, Zyklen, Stundenvorgabe, Ausführungshinweise, Gruppen-Kopftext. */
async function phase5() {
  const [done] = await sql`select 1 from app.site_services where service_type_id is not null limit 1`;
  if (done) return;
  const T = {
    unterhalt: '00000000-0000-4000-8000-0000000b1001',
    glas: '00000000-0000-4000-8000-0000000b1003',
    sonder: '00000000-0000-4000-8000-0000000b1004',
  };
  await sql`update app.site_services set service_type_id = ${T.unterhalt}
             where kind = 'monthly_flat' and description ilike '%reinigung%' and service_type_id is null`;
  await sql`update app.site_services set service_type_id = ${T.sonder}
             where kind <> 'monthly_flat' and service_type_id is null`;
  await sql`update app.site_services
               set hours_target_milli = 124000,
                   execution_notes = 'Schlüssel beim Hausmeister (Raum 0.12). Turnhalle nur nach 16 Uhr. Mülltrennung beachten.',
                   cost_center = 'KST 100 München Süd', labor_share_bp = 7500
             where id = '00000000-0000-4000-8000-000000000101'`;
  const svc = (
    id: string,
    siteId: string,
    d: string,
    price: string,
    cycle: string,
    extra: Record<string, unknown> = {},
  ) =>
    sql`insert into app.site_services ${sql({
      id,
      site_id: siteId,
      kind: 'monthly_flat',
      description: d,
      unit_code: 'LS',
      quantity_milli: 1000,
      unit_price_cents: parseEuro(price),
      vat_rate_bp: 1900,
      valid_from: '2026-01-01',
      sort_order: 20,
      billing_cycle: cycle,
      ...extra,
    } as Record<string, unknown>)} on conflict (id) do nothing`;
  await svc(
    '00000000-0000-4000-8000-0000000b2001',
    DEMO.siteSchool,
    'Glasreinigung innen/außen',
    '1.180,00',
    'quartalsweise',
    {
      service_type_id: T.glas,
      note: 'Fenster, Oberlichter und Glastüren',
      execution_notes: 'Hubsteiger über Fa. Lift-Rent, Termin 2 Wochen vorher abstimmen.',
    },
  );
  await svc(
    '00000000-0000-4000-8000-0000000b2002',
    DEMO.siteHq,
    'Grundreinigung Teppichböden',
    '2.450,00',
    'jaehrlich',
    {
      service_type_id: '00000000-0000-4000-8000-0000000b1002',
      separate_invoice: true,
      always_unfinished: true,
      note: 'Menge nach Aufmaß',
    },
  );
  await sql`update app.invoice_groups
               set intro_text = 'Sehr geehrte Damen und Herren, für die Schulen des Referats berechnen wir unsere Leistungen wie folgt:',
                   closing_text = 'Bitte geben Sie bei Zahlung die Rechnungsnummer an. Vielen Dank für die gute Zusammenarbeit.'
             where id = '00000000-0000-4000-8000-0000000f0001'`;
  // Abrechnung am Objekt für den laufenden Monat (Entwürfe, Rechnungsdatum = Ausstellungstag)
  await runMonthly(sql, todayBerlin().slice(0, 7), A, { siteIds: [DEMO.siteHq] });
  console.log('Demo Phase 5 angelegt.');
}

/** Planung (Vertretung), Angebote mit Alternativen/Folgeangebot, Bankabgleich, Import. */
async function phase6() {
  const [done] = await sql`select 1 from app.offers where id = '00000000-0000-4000-8000-0000000d6201'`;
  if (done) return;
  const today = todayBerlin();
  // --- Planung: Einsatzgruppen, Krankheit nächste Woche mit Vertretung und eine offene Lücke
  const emps = await sql<
    { id: string }[]
  >`select id from app.employees where status = 'aktiv' order by personnel_no`;
  await sql`update app.employees set planning_group = case when personnel_no::int % 2 = 0 then 'Team Süd' else 'Team West' end,
                                     planning_notes = case when personnel_no = '1001' then 'kein Führerschein' end`;
  const next = await plannedShifts(sql, { from: addDays(today, 7), to: addDays(today, 13) });
  const first = next.find((x) => !x.holiday);
  if (first && emps.length > 1) {
    await requestAbsence(sql, {
      id: '00000000-0000-4000-8000-0000000d6001',
      employeeId: first.plan.employee_id,
      kind: 'krank',
      start: first.date,
      end: addDays(first.date, 2),
      halfDay: false,
      note: 'AU liegt vor',
      actor: A,
      approved: true,
    });
    const sub = emps.find((e) => e.id !== first.plan.employee_id)!;
    await saveException(
      sql,
      '00000000-0000-4000-8000-0000000d6002',
      {
        planId: first.plan.id,
        date: first.date,
        kind: 'vertretung',
        substituteId: sub.id,
        start: '05:00',
        end: '06:30',
        note: 'Vertretung wegen Krankheit',
        expectedVersion: null,
      },
      A,
    ).catch((e: Error) => console.log('Vertretung übersprungen:', e.message));
  }
  // --- Angebote: mit Alternativen, Folgeangebot, abgelehnt
  const line = (description: string, price: string, recurring: boolean, alternative = false) => ({
    description,
    quantity: parseQuantity('1'),
    unitCode: 'LS',
    unitPrice: parseEuro(price),
    vatRate: 1900,
    recurring,
    alternative,
  });
  const O = '00000000-0000-4000-8000-0000000d6201';
  await saveOffer(
    sql,
    O,
    {
      customerId: DEMO.authority,
      siteId: null,
      title: 'Unterhaltsreinigung Gymnasium Nord',
      tenderReference: 'V-2026-118',
      tenderPlatform: 'Bayerischer Vergabemarktplatz',
      submissionDeadline: `${addDays(today, 12)}T10:00`,
      offerDate: today,
      validUntil: addDays(today, 60),
      introText: null,
      closingText: null,
      lines: [
        line('Unterhaltsreinigung 5×/Woche lt. LV', '6.480,00', true),
        line('Unterhaltsreinigung 3×/Woche (Alternative)', '4.120,00', true, true),
        line('Bauendreinigung vor Leistungsbeginn', '2.300,00', false),
      ],
    },
    A,
  );
  await setOfferStatus(sql, O, 'versendet', A);
  await copyOffer(sql, O, A, { followUp: true, newId: '00000000-0000-4000-8000-0000000d6202' });
  const R = '00000000-0000-4000-8000-0000000d6203';
  await saveOffer(
    sql,
    R,
    {
      customerId: DEMO.company,
      siteId: null,
      title: 'Glasreinigung Bürogebäude',
      tenderReference: null,
      tenderPlatform: null,
      submissionDeadline: null,
      offerDate: addDays(today, -40),
      validUntil: null,
      introText: null,
      closingText: null,
      lines: [line('Glasreinigung 2×/Jahr', '1.980,00', false)],
    },
    A,
  );
  await setOfferStatus(sql, R, 'versendet', A);
  await setOfferStatus(sql, R, 'abgelehnt', A);
  // --- Kontoauszug: Zahlung auf eine offene Rechnung, Miete, unbekannter Eingang
  const [open] = await sql<{ number: string; open_cents: bigint }[]>`
    select number, open_cents from app.open_items where open_cents > 0 order by due_date limit 1`;
  const seller = await getSeller(sql);
  const own = seller.bankAccounts[0]!.iban.replace(/\s/g, '');
  const eur = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
  const entry = (amt: string, ind: string, name: string, purpose: string, ref: string) =>
    `<Ntry><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${addDays(today, -1)}</Dt></BookgDt>` +
    `<AcctSvcrRef>${ref}</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><${ind === 'CRDT' ? 'Dbtr' : 'Cdtr'}><Nm>${name}</Nm></${ind === 'CRDT' ? 'Dbtr' : 'Cdtr'}></RltdPties>` +
    `<RmtInf><Ustrd>${purpose}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
  const camt = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>DEMO</MsgId></GrpHdr><Stmt><Id>1</Id><Acct><Id><IBAN>${own}</IBAN></Id></Acct>
${open ? entry(eur(open.open_cents), 'CRDT', 'Landeshauptstadt Muenchen', `RE ${open.number} Kassenzeichen 4711-0815`, 'DEMO1') : ''}
${entry('1850.00', 'DBIT', 'Immobilien Sendling GmbH', 'Miete Lager Oktober', 'DEMO2')}
${entry('250.00', 'CRDT', 'Unbekannt', 'Abschlag Reinigung', 'DEMO3')}
</Stmt></BkToCstmrStmt></Document>`;
  await importStatement(deps, {
    id: '00000000-0000-4000-8000-0000000d6401',
    filename: 'Kontoauszug_Muenchner_Bank.xml',
    bytes: new TextEncoder().encode(camt),
    accountIban: null,
    actor: A,
  });
  // --- Import aus Fortytools (Beispiel)
  const csv =
    'Kd-Nr.;Firma;Straße;PLZ;Ort;Rechnungs-E-Mail;Zahlungsziel\r\n29950;DEMO WEG Sendlinger Höfe;Plinganserstr. 10;81369;München;verwaltung@example.org;14\r\n';
  await applyImport(deps, {
    id: '00000000-0000-4000-8000-0000000d6501',
    kind: 'kunden',
    filename: 'fortytools_kunden.csv',
    bytes: new TextEncoder().encode(csv),
    update: false,
    actor: A,
  });
  console.log('Demo Phase 6 angelegt.');
}

/** Übergaben (Kleidung, Schlüssel) und Nachunternehmer mit Nachweisen, Portal-Upload und Auftrag. */
async function phase7() {
  const [done] = await sql`select 1 from app.handovers limit 1`;
  if (done) return;
  const today = todayBerlin();
  const SHIRT = '00000000-0000-4000-8000-0000000c7001';
  const PANTS = '00000000-0000-4000-8000-0000000c7004';
  const SHOES = '00000000-0000-4000-8000-0000000c7008';
  for (const [i, [art, size, n]] of (
    [
      [SHIRT, 'M', 20],
      [SHIRT, 'L', 15],
      [PANTS, '48', 8],
      [PANTS, 'M', 10],
      [SHOES, '40', 4],
      [SHOES, '42', 1],
    ] as const
  ).entries()) {
    await bookClothing(
      sql,
      {
        id: `00000000-0000-4000-8000-0000000d7${String(i).padStart(3, '0')}`,
        articleId: art,
        size,
        delta: n,
        reason: 'zugang',
        note: 'Lieferung Demo',
      },
      A,
    );
  }
  const emps = await sql<
    { id: string }[]
  >`select id from app.employees where status = 'aktiv' order by personnel_no`;
  const h1 = '00000000-0000-4000-8000-0000000d7101';
  const base = {
    direction: 'ausgabe' as const,
    supplierId: null,
    recipientName: null,
    siteId: DEMO.siteSchool,
    date: addDays(today, -3),
    title: null,
    bodyText: null,
    wageDeduction: false,
    relatedId: null,
    note: null,
    issuerName: 'Objektleitung Demo',
  };
  await saveHandover(
    deps,
    h1,
    {
      ...base,
      kind: 'kleidung',
      employeeId: emps[0]!.id,
      items: [
        { label: '', article_id: SHIRT, size: 'M', qty: 3 },
        { label: '', article_id: PANTS, size: '48', qty: 2 },
        { label: '', article_id: SHOES, size: '40', qty: 1 },
      ],
    },
    A,
  );
  await signHandover(deps, h1, { name: 'Elena Popescu', png: signaturePng(4) }, A);
  // Schlüssel-Übergabe wartet auf Unterschrift
  await saveHandover(
    deps,
    '00000000-0000-4000-8000-0000000d7102',
    {
      ...base,
      kind: 'schluessel',
      siteId: DEMO.siteOffice,
      date: today,
      employeeId: emps[1]!.id,
      items: [{ label: '', key_id: '00000000-0000-4000-8000-000000000252', qty: 1 }],
    },
    A,
  );

  // Nachunternehmer: fast vollständig, Haftpflicht läuft bald ab, BG-Bescheinigung kommt über das Portal
  const NU = '00000000-0000-4000-8000-000000000222';
  await sql`update app.suppliers set legal_form = 'ug' where id = ${NU}`;
  const pdfDoc = await PDFDocument.create();
  const pg = pdfDoc.addPage([595, 842]);
  pg.drawText('DEMO-Nachweis (Beispieldatei)', {
    x: 60,
    y: 760,
    size: 18,
    font: await pdfDoc.embedFont(StandardFonts.Helvetica),
  });
  const pdf = await pdfDoc.save();
  const types = await docTypes(sql);
  let n = 0;
  for (const t of types) {
    if (t.required === 'nein' || t.id === 'ub_bg') continue;
    const until =
      t.valid_months === 0
        ? null
        : t.id === 'haftpflicht'
          ? addDays(today, 35)
          : addDays(today, 30 * t.valid_months - 20);
    await uploadDocument(deps, {
      id: `00000000-0000-4000-8000-0000000d72${String(n++).padStart(2, '0')}`,
      supplierId: NU,
      docType: t.id,
      fileName: `${t.label}.pdf`,
      data: pdf,
      validUntil: until,
      source: 'buero',
      actor: A,
    });
  }
  await uploadDocument(deps, {
    id: '00000000-0000-4000-8000-0000000d7290',
    supplierId: NU,
    docType: 'ub_bg',
    fileName: 'BG_BAU_Unbedenklichkeit.pdf',
    data: pdf,
    validUntil: addDays(today, 170),
    source: 'portal',
    actor: 'portal:70002',
  });
  // Zum Erteilen braucht es alle Pflicht-Nachweise → BG kurz prüfen, Auftrag erteilen, danach neue Portal-Datei offen
  await reviewDocument(
    sql,
    '00000000-0000-4000-8000-0000000d7290',
    { accept: true, validUntil: addDays(today, 170), reason: null },
    A,
  );
  const sc = '00000000-0000-4000-8000-0000000d7301';
  await saveSubcontract(
    sql,
    sc,
    {
      supplierId: NU,
      siteId: DEMO.siteOffice,
      serviceKind: 'Glasreinigung',
      frequency: 'quartalsweise',
      billing: 'pauschale_einsatz',
      priceCents: 68000n,
      maxHours: null,
      validFrom: `${today.slice(0, 4)}-01-01`,
      validTo: null,
      description: 'Glasflächen innen und außen inkl. Rahmen, Hubsteiger stellt der Nachunternehmer',
      note: null,
    },
    A,
  );
  await setSubcontractStatus(sql, sc, 'erteilt', A);
  await addPriceChange(
    sql,
    {
      id: '00000000-0000-4000-8000-0000000d7302',
      subcontractId: sc,
      month: today.slice(0, 7),
      priceCents: 71400n,
      reason: 'Tariflohnerhöhung Gebäudereinigung',
    },
    A,
  );
  await uploadDocument(deps, {
    id: '00000000-0000-4000-8000-0000000d7291',
    supplierId: NU,
    docType: 'haftpflicht',
    fileName: 'Versicherungsbestaetigung_neu.pdf',
    data: pdf,
    validUntil: addDays(today, 400),
    source: 'portal',
    actor: 'portal:70002',
  });
  console.log('Demo Phase 7 angelegt.');
}

/** Eigene Rechnungsgruppe für das Verwaltungsgebäude (andere Rechnungsstelle, eigene Rechnung). */
async function phase8() {
  const gid = '00000000-0000-4000-8000-0000000f0008';
  const [done] = await sql`select 1 from app.invoice_groups where id = ${gid}`;
  if (done) return;
  await saveInvoiceGroup(
    sql,
    gid,
    {
      customerId: DEMO.authority,
      name: 'Kommunalreferat – Verwaltungsgebäude',
      combine: false,
      billing: groupBillingInput.parse({
        bill_name: 'DEMO Beispielbehörde – Kommunalreferat Gebäudemanagement',
        bill_name2: 'Rechnungsstelle Verwaltungsgebäude',
        bill_street: 'Roßmarkt 3',
        bill_postal_code: '80331',
        bill_city: 'München',
        bill_contact_name: 'Herr Demo-Hausverwaltung',
        bill_emails: 'rechnung-verwaltung@example.org',
        bill_format: 'zugferd',
        bill_payment_terms_days: '21',
      }),
      orderReference: null,
      note: null,
      active: true,
      siteIds: null,
      expectedVersion: null,
    },
    A,
  );
  await setSiteInvoiceGroup(sql, DEMO.siteOffice, gid, A);
  console.log('Demo Phase 8 angelegt.');
}

/** Ausschreibungen mit Terminen (Abgabe, Besichtigung, Bieterfragen) und eine verlorene. */
async function phase9() {
  const [done] = await sql`select 1 from app.tenders limit 1`;
  if (done) return;
  const today = todayBerlin();
  const base = {
    customerId: null,
    url: 'https://www.vergabe.bayern.de/',
    location: 'München',
    services: null,
    contractStart: `${Number(today.slice(0, 4)) + 1}-01-01`,
    estimatedCents: null,
    questionsUntil: null,
    siteVisit: null,
    siteVisitRequired: false,
    bindingUntil: null,
    responsible: 'Ahmed',
    notes: null,
  };
  await saveTender(
    sql,
    '00000000-0000-4000-8000-0000000d9001',
    {
      ...base,
      title: 'DEMO Unterhaltsreinigung Grund- und Mittelschulen Los 3',
      authority: 'DEMO Landeshauptstadt München, Referat für Bildung',
      customerId: DEMO.authority,
      referenceNo: 'DEMO-RBS-2026-117',
      platform: 'Vergabe.bayern',
      procedure: 'offenes Verfahren',
      contractTerm: '2 Jahre + 2 × 1 Jahr',
      estimatedCents: parseEuro('240.000,00'),
      deadline: `${addDays(today, 9)}T10:00`,
      questionsUntil: `${addDays(today, 4)}T12:00`,
      siteVisit: `${addDays(today, 2)}T09:00`,
      siteVisitRequired: true,
      bindingUntil: addDays(today, 100),
      notes: 'Eignung: Referenzen 3 vergleichbare Objekte, Tariftreueerklärung, Umsatz letzte 3 Jahre.',
    },
    A,
  );
  await saveTender(
    sql,
    '00000000-0000-4000-8000-0000000d9002',
    {
      ...base,
      title: 'DEMO Glasreinigung Verwaltungsgebäude (2× jährlich)',
      authority: 'DEMO Gemeinde Musterhausen',
      referenceNo: 'DEMO-GM-2026-08',
      platform: 'E-Mail / Post',
      procedure: 'Preisanfrage (privat)',
      contractTerm: '1 Jahr',
      deadline: `${addDays(today, 16)}T12:00`,
    },
    A,
  );
  await saveTender(
    sql,
    '00000000-0000-4000-8000-0000000d9003',
    {
      ...base,
      title: 'DEMO Reinigung Feuerwachen Nord',
      authority: 'DEMO Landeshauptstadt München, Branddirektion',
      referenceNo: 'DEMO-BD-2026-04',
      platform: 'DTVP',
      procedure: 'offenes Verfahren',
      contractTerm: '3 Jahre',
      deadline: `${addDays(today, -20)}T10:00`,
    },
    A,
  );
  await setTenderStatus(sql, '00000000-0000-4000-8000-0000000d9003', 'abgegeben', null, A);
  await setTenderStatus(
    sql,
    '00000000-0000-4000-8000-0000000d9003',
    'verloren',
    'Zuschlag an Mitbewerber, ca. 8 % günstiger',
    A,
  );
  console.log('Demo Phase 9 angelegt.');
}
