import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot, SellerSnapshot } from '../domain/invoice/types.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { renderLetterPdf } from '../pdf/render.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Kassenbuch (Aufbau wie die alte App: Kasse je Monat mit Tagessalden, Karten-Belege-Archiv, Auswertung).
 * Anders als die alte App GoBD-fest (§ 146 AO): fortlaufende Kassen-Belegnummer, Buchungen werden nie gelöscht
 * (Storno mit Grund), jede Änderung steht mit altem/neuem Stand im Protokoll, abgeschlossene Monate sind gesperrt
 * (DB-Trigger). Der Kassenbestand darf nie negativ werden (Kassenfehlbetrag = Buchungsfehler).
 */

export type CashKind = 'einnahme' | 'ausgabe';

export interface CashEntry {
  id: string;
  entry_no: number;
  kind: CashKind;
  entry_date: string;
  description: string;
  amount_cents: bigint;
  receipt_ref: string | null;
  category: string | null;
  note: string | null;
  receipt_path: string | null;
  receipt_name: string | null;
  receipt_type: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}

export interface CardReceipt {
  id: string;
  receipt_date: string;
  amount_cents: bigint;
  note: string | null;
  receipt_path: string;
  receipt_name: string | null;
  receipt_type: string | null;
  created_at: Date;
  version: number;
}

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const nextMonth = (m: string) => {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
const eur = (c: bigint) => formatEuro(c as Cents);
const signed = (e: Pick<CashEntry, 'kind' | 'amount_cents'>) =>
  e.kind === 'einnahme' ? e.amount_cents : -e.amount_cents;

/**
 * Anfangsbestand eines Monats: von Hand festgelegt (wie alte App) – sonst der Endbestand des Vormonats
 * (letzter festgelegter Bestand + alle Bewegungen bis Monatsbeginn).
 */
export async function openingOf(sql: Sql, month: string): Promise<{ cents: bigint; manual: boolean }> {
  const [own] = await sql<{ amount_cents: bigint }[]>`
    select amount_cents from app.cash_openings where month = ${month}`;
  if (own) return { cents: own.amount_cents, manual: true };
  const [base] = await sql<{ month: string; amount_cents: bigint }[]>`
    select month, amount_cents from app.cash_openings where month < ${month} order by month desc limit 1`;
  const from = base ? `${base.month}-01` : '0001-01-01';
  const [mv] = await sql<{ s: bigint }[]>`
    select coalesce(sum(case when kind = 'einnahme' then amount_cents else -amount_cents end), 0)::bigint as s
      from app.cash_entries
     where cancelled_at is null and entry_date >= ${from} and entry_date < ${`${month}-01`}`;
  return { cents: (base?.amount_cents ?? 0n) + mv!.s, manual: false };
}

export interface MonthView {
  month: string;
  opening: bigint;
  openingManual: boolean;
  income: bigint;
  expense: bigint;
  closing: bigint;
  incomeCount: number;
  expenseCount: number;
  rows: (CashEntry & { saldo: bigint | null })[];
  closed: { closed_by: string; closed_at: Date; counted_cents: bigint | null } | null;
}

export async function monthView(sql: Sql, month: string): Promise<MonthView> {
  if (!MONTH_RE.test(month)) throw new BusinessError('Monat ungültig');
  const [{ cents: opening, manual }, rows, [closed]] = await Promise.all([
    openingOf(sql, month),
    sql<CashEntry[]>`
      select * from app.cash_entries
       where entry_date >= ${`${month}-01`} and entry_date < ${`${nextMonth(month)}-01`}
       order by entry_date, entry_no`,
    sql<{ closed_by: string; closed_at: Date; counted_cents: bigint | null }[]>`
      select closed_by, closed_at, counted_cents from app.cash_closings where month = ${month}`,
  ]);
  let saldo = opening;
  let income = 0n;
  let expense = 0n;
  let incomeCount = 0;
  let expenseCount = 0;
  const out = rows.map((r) => {
    if (r.cancelled_at) return { ...r, saldo: null };
    saldo += signed(r);
    if (r.kind === 'einnahme') {
      income += r.amount_cents;
      incomeCount++;
    } else {
      expense += r.amount_cents;
      expenseCount++;
    }
    return { ...r, saldo };
  });
  return {
    month,
    opening,
    openingManual: manual,
    income,
    expense,
    closing: opening + income - expense,
    incomeCount,
    expenseCount,
    rows: out,
    closed: closed ?? null,
  };
}

/** Monate mit Buchungen oder festgelegtem Anfangsbestand, dazu der aktuelle Monat (neueste zuerst). */
export async function cashMonths(sql: Sql): Promise<string[]> {
  const rows = await sql<{ m: string }[]>`
    select distinct to_char(entry_date, 'YYYY-MM') as m from app.cash_entries
    union select month from app.cash_openings`;
  const set = new Set(rows.map((r) => r.m));
  set.add(todayBerlin().slice(0, 7));
  return [...set].sort().reverse();
}

export interface EntryInput {
  kind: CashKind;
  date: string;
  description: string;
  amountCents: bigint;
  receiptRef: string | null;
  note: string | null;
  file?: { bytes: Uint8Array; name: string; type: string } | null;
  removeFile?: boolean;
  expectedVersion: number | null;
}

async function storeReceipt(
  deps: Deps,
  folder: string,
  f: { bytes: Uint8Array; name: string; type: string },
) {
  if (f.bytes.length > 10 * 1024 * 1024) throw new BusinessError('Beleg max. 10 MB');
  if (!/^(image\/(jpeg|png|webp|heic)|application\/pdf)$/.test(f.type))
    throw new BusinessError('Beleg bitte als Foto (JPG/PNG) oder PDF');
  const sha = createHash('sha256').update(f.bytes).digest('hex');
  const ext =
    (f.name.split('.').pop() ?? 'bin')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 5) || 'bin';
  const path = `${folder}/${sha.slice(0, 2)}/${sha}.${ext}`;
  await deps.archive.put(path, f.bytes);
  return { path, sha, name: f.name.slice(0, 200), type: f.type };
}

async function assertOpenMonth(sql: Sql, date: string) {
  const [c] = await sql`select 1 from app.cash_closings where month = ${date.slice(0, 7)}`;
  if (c)
    throw new BusinessError(
      `${monthLabel(date.slice(0, 7))} ist abgeschlossen – keine Buchungen mehr möglich`,
    );
}

/** Buchen / ändern. Neue Buchungen bekommen die nächste Kassen-Belegnummer (Zeilensperre → lückenlos). */
export async function saveEntry(deps: Deps, id: string, p: EntryInput, actor: string) {
  const { sql } = deps;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum ist Pflicht');
  if (p.date > todayBerlin()) throw new BusinessError('Buchungen in der Zukunft sind nicht möglich');
  if (!p.description.trim()) throw new BusinessError('Beschreibung ist Pflicht');
  if (p.amountCents <= 0n) throw new BusinessError('Betrag muss > 0 sein');
  if (p.kind !== 'einnahme' && p.kind !== 'ausgabe') throw new BusinessError('Typ ungültig');
  await assertOpenMonth(sql, p.date);
  const file = p.file?.bytes.length ? await storeReceipt(deps, 'kasse', p.file) : null;
  await sql.begin(async (tx) => {
    const [cur] = await tx<CashEntry[]>`select * from app.cash_entries where id = ${id} for update`;
    if (cur && p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Die Buchung wurde zwischenzeitlich geändert – bitte neu laden');
    if (cur?.cancelled_at) throw new BusinessError('Stornierte Buchung kann nicht geändert werden');
    const row = {
      kind: p.kind,
      entry_date: p.date,
      description: p.description.trim(),
      amount_cents: p.amountCents,
      receipt_ref: p.receiptRef?.trim() || null,
      note: p.note?.trim() || null,
      ...(file
        ? {
            receipt_path: file.path,
            receipt_sha256: file.sha,
            receipt_name: file.name,
            receipt_type: file.type,
          }
        : p.removeFile
          ? { receipt_path: null, receipt_sha256: null, receipt_name: null, receipt_type: null }
          : {}),
    };
    if (cur) {
      await tx`update app.cash_entries set ${tx({ ...row, updated_at: new Date() } as Record<string, unknown>)}
                where id = ${id}`;
      await tx`insert into app.cash_log (entry_id, action, old, new, actor)
               values (${id}, 'geändert', ${tx.json(logView(cur))}, ${tx.json(logView({ ...cur, ...row }))}, ${actor})`;
    } else {
      await tx`lock table app.cash_entries in share row exclusive mode`;
      const [{ n }] =
        (await tx`select coalesce(max(entry_no), 0) + 1 as n from app.cash_entries`) as unknown as [
          { n: number },
        ];
      await tx`insert into app.cash_entries ${tx({ id, entry_no: n, ...row, created_by: actor } as Record<string, unknown>)}`;
      await tx`insert into app.cash_log (entry_id, action, new, actor)
               values (${id}, 'gebucht', ${tx.json(logView({ ...row, entry_no: n }))}, ${actor})`;
    }
    await assertNotNegative(tx as unknown as Sql, p.date.slice(0, 7));
  });
}

const logView = (e: object) => {
  const r = e as Record<string, unknown>;
  const t = (v: unknown) => (v == null ? null : String(v));
  return {
    nr: t(r.entry_no),
    typ: t(r.kind),
    datum: t(r.entry_date),
    beschreibung: t(r.description),
    betrag: t(r.amount_cents),
    beleg: t(r.receipt_ref),
    datei: t(r.receipt_name),
    notiz: t(r.note),
  };
};

/** Kasse darf nie ins Minus laufen – jeder Tagesendbestand ab dem Monat wird geprüft. */
async function assertNotNegative(sql: Sql, fromMonth: string) {
  const { cents: opening } = await openingOf(sql, fromMonth);
  const days = await sql<{ d: string; s: bigint }[]>`
    select entry_date::text as d,
           sum(case when kind = 'einnahme' then amount_cents else -amount_cents end)::bigint as s
      from app.cash_entries where cancelled_at is null and entry_date >= ${`${fromMonth}-01`}
     group by entry_date order by entry_date`;
  let saldo = opening;
  const manual = new Map(
    (
      await sql<{ month: string; amount_cents: bigint }[]>`
      select month, amount_cents from app.cash_openings where month > ${fromMonth}`
    ).map((r) => [r.month, r.amount_cents]),
  );
  let cur = fromMonth;
  for (const d of days) {
    const m = d.d.slice(0, 7);
    while (cur < m) {
      cur = nextMonth(cur);
      if (manual.has(cur)) saldo = manual.get(cur)!;
    }
    saldo += d.s;
    if (saldo < 0n)
      throw new BusinessError(
        `Kassenbestand am ${formatDateDe(d.d)} wäre negativ (${eur(saldo)}). Bitte Betrag/Datum prüfen – eine Kasse kann nicht ins Minus gehen.`,
      );
  }
}

export async function cancelEntry(sql: Sql, id: string, reason: string, actor: string) {
  if (!reason.trim()) throw new BusinessError('Bitte den Grund für das Storno angeben');
  await sql.begin(async (tx) => {
    const [cur] = await tx<CashEntry[]>`select * from app.cash_entries where id = ${id} for update`;
    if (!cur) throw new BusinessError('Buchung nicht gefunden');
    if (cur.cancelled_at) return;
    await tx`update app.cash_entries set cancelled_at = now(), cancelled_by = ${actor}, cancel_reason = ${reason.trim()}
              where id = ${id}`;
    await tx`insert into app.cash_log (entry_id, action, old, new, actor)
             values (${id}, 'storniert', ${tx.json(logView(cur))}, ${tx.json({ grund: reason.trim() })}, ${actor})`;
    await assertNotNegative(tx as unknown as Sql, cur.entry_date.slice(0, 7));
  });
}

export async function setOpening(sql: Sql, month: string, cents: bigint, actor: string) {
  if (!MONTH_RE.test(month)) throw new BusinessError('Ungültiges Format');
  if (cents < 0n) throw new BusinessError('Ungültiger Betrag');
  const [c] = await sql`select 1 from app.cash_closings where month = ${month}`;
  if (c) throw new BusinessError('Monat ist abgeschlossen');
  await sql.begin(async (tx) => {
    const [old] = await tx<
      { amount_cents: bigint }[]
    >`select amount_cents from app.cash_openings where month = ${month}`;
    await tx`insert into app.cash_openings (month, amount_cents, set_by) values (${month}, ${cents}, ${actor})
             on conflict (month) do update set amount_cents = excluded.amount_cents, set_by = excluded.set_by, set_at = now()`;
    await tx`insert into app.cash_log (action, old, new, actor)
             values ('Anfangsbestand', ${tx.json(old ? { monat: month, betrag: String(old.amount_cents) } : null)},
                     ${tx.json({ monat: month, betrag: String(cents) })}, ${actor})`;
    await assertNotNegative(tx as unknown as Sql, month);
  });
}

/** Monatsabschluss mit Kassensturz: gezählter Bestand muss dem Buchbestand entsprechen. */
export async function closeMonth(sql: Sql, month: string, countedCents: bigint, actor: string) {
  const v = await monthView(sql, month);
  if (v.closed) return;
  if (month >= todayBerlin().slice(0, 7))
    throw new BusinessError('Nur vergangene Monate können abgeschlossen werden');
  if (countedCents !== v.closing)
    throw new BusinessError(
      `Kassensturz ${eur(countedCents)} weicht vom Buchbestand ${eur(v.closing)} ab (Differenz ${eur(countedCents - v.closing)}). Bitte Differenz erst klären und buchen.`,
    );
  await sql.begin(async (tx) => {
    await tx`insert into app.cash_closings (month, end_cents, counted_cents, closed_by)
             values (${month}, ${v.closing}, ${countedCents}, ${actor}) on conflict do nothing`;
    await tx`insert into app.cash_log (action, new, actor)
             values ('Monatsabschluss', ${tx.json({ monat: month, endbestand: String(v.closing) })}, ${actor})`;
  });
}

export async function getEntry(sql: Sql, id: string) {
  const [e] = await sql<CashEntry[]>`select * from app.cash_entries where id = ${id}`;
  if (!e) return undefined;
  const log = await sql<{ action: string; old: unknown; new: unknown; actor: string; created_at: Date }[]>`
    select action, old, new, actor, created_at from app.cash_log where entry_id = ${id} order by id`;
  return { entry: e, log };
}

export async function overview(sql: Sql) {
  const months = (await cashMonths(sql)).slice().reverse();
  const out: {
    month: string;
    opening: bigint;
    income: bigint;
    expense: bigint;
    closing: bigint;
    count: number;
    closed: boolean;
  }[] = [];
  for (const m of months) {
    const v = await monthView(sql, m);
    if (!v.rows.length && !v.openingManual && m !== todayBerlin().slice(0, 7)) continue;
    out.push({
      month: m,
      opening: v.opening,
      income: v.income,
      expense: v.expense,
      closing: v.closing,
      count: v.incomeCount + v.expenseCount,
      closed: !!v.closed,
    });
  }
  return out.reverse();
}

// ------------------------------------------------------------------ Export

/** Empfängerblock für interne Dokumente (eigene Firma als Adressat). */
export function internalBuyer(seller: SellerSnapshot, label: string): BuyerSnapshot {
  return {
    customerNo: '',
    name: seller.legalName,
    name2: label,
    street: seller.street,
    postalCode: seller.postalCode,
    city: seller.city,
    countryCode: 'DE',
    vatId: null,
    leitwegId: null,
    supplierNo: null,
    email: null,
    contactName: null,
    site: null,
  };
}

export function monthCsv(v: MonthView): string {
  const n = (c: bigint) => (Number(c) / 100).toFixed(2).replace('.', ',');
  const q = (s: string | null) => {
    const t = (s ?? '').replace(/"/g, '""');
    return /^[=+\-@]/.test(t) ? `"'${t}"` : `"${t}"`;
  };
  const lines = [
    `Kassenbuch;${monthLabel(v.month)}`,
    '',
    `Anfangsbestand;${n(v.opening)}`,
    '',
    'Beleg-Nr.;Datum;Beschreibung;Beleg (extern);Einnahme;Ausgabe;Saldo',
    ...v.rows
      .filter((r) => !r.cancelled_at)
      .map((r) =>
        [
          r.entry_no,
          formatDateDe(r.entry_date),
          q(r.description),
          q(r.receipt_ref),
          r.kind === 'einnahme' ? n(r.amount_cents) : '',
          r.kind === 'ausgabe' ? n(r.amount_cents) : '',
          n(r.saldo ?? 0n),
        ].join(';'),
      ),
    '',
    `Summe Einnahmen;${n(v.income)}`,
    `Summe Ausgaben;${n(v.expense)}`,
    `Endbestand;${n(v.closing)}`,
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function monthPdf(sql: Sql, month: string) {
  const v = await monthView(sql, month);
  const seller = await getSeller(sql);
  const buyer = internalBuyer(seller, 'Kassenbuch');
  const live = v.rows.filter((r) => !r.cancelled_at);
  return renderLetterPdf({
    title: `Kassenbuch ${monthLabel(month)}`,
    date: todayBerlin(),
    info: [
      ['Monat', monthLabel(month)],
      ['Stand', formatDateDe(todayBerlin())],
      ['Abschluss', v.closed ? formatDateDe(v.closed.closed_at.toISOString().slice(0, 10)) : 'offen'],
    ],
    seller,
    buyer,
    greeting: null,
    intro: `Anfangsbestand ${monthLabel(month)}: ${eur(v.opening)}`,
    columns: [
      { label: 'Nr.', x: 62.3, align: 'left' },
      { label: 'Datum', x: 95, align: 'left' },
      { label: 'Beschreibung', x: 150, align: 'left' },
      { label: 'Einnahme', x: 400 },
      { label: 'Ausgabe', x: 470 },
      { label: 'Saldo', x: 538.8 },
    ],
    rows: live.map((r) => [
      String(r.entry_no),
      formatDateDe(r.entry_date).slice(0, 6),
      r.description.length > 34 ? `${r.description.slice(0, 33)}…` : r.description,
      r.kind === 'einnahme' ? eur(r.amount_cents) : '',
      r.kind === 'ausgabe' ? eur(r.amount_cents) : '',
      eur(r.saldo ?? 0n),
    ]),
    sums: [
      ['Anfangsbestand', eur(v.opening)],
      ['Summe Einnahmen', `+ ${eur(v.income)}`],
      ['Summe Ausgaben', `− ${eur(v.expense)}`],
    ],
    total: ['Endbestand', eur(v.closing)],
    paragraphs: [
      ...(v.rows.some((r) => r.cancelled_at)
        ? [
            `Stornierte Buchungen (nicht im Bestand): ${v.rows
              .filter((r) => r.cancelled_at)
              .map((r) => `Nr. ${r.entry_no}`)
              .join(', ')}`,
          ]
        : []),
      'Ort, Datum ______________________        Unterschrift Geschäftsführer ______________________',
    ],
  });
}

// ------------------------------------------------------------------ Karten-Belege (Archiv, nicht im Kassenbestand)

export async function listCardReceipts(sql: Sql, month?: string) {
  return sql<CardReceipt[]>`
    select * from app.card_receipts
     where ${month ? sql`to_char(receipt_date, 'YYYY-MM') = ${month}` : sql`true`}
     order by receipt_date desc, created_at desc`;
}

export async function saveCardReceipt(
  deps: Deps,
  id: string,
  p: {
    date: string;
    amountCents: bigint;
    note: string | null;
    file?: { bytes: Uint8Array; name: string; type: string } | null;
    expectedVersion: number | null;
  },
  actor: string,
) {
  const { sql } = deps;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum ist Pflicht');
  if (p.amountCents <= 0n) throw new BusinessError('Betrag muss > 0 sein');
  const [cur] = await sql<CardReceipt[]>`select * from app.card_receipts where id = ${id}`;
  if (!cur && !p.file?.bytes.length) throw new BusinessError('Beleg-Foto ist Pflicht');
  if (cur && p.expectedVersion != null && cur.version !== p.expectedVersion)
    throw new BusinessError('Der Beleg wurde zwischenzeitlich geändert – bitte neu laden');
  const file = p.file?.bytes.length ? await storeReceipt(deps, 'kartenbelege', p.file) : null;
  const row = {
    receipt_date: p.date,
    amount_cents: p.amountCents,
    note: p.note?.trim() || null,
    ...(file
      ? {
          receipt_path: file.path,
          receipt_sha256: file.sha,
          receipt_name: file.name,
          receipt_type: file.type,
        }
      : {}),
  };
  if (cur) await sql`update app.card_receipts set ${sql(row as Record<string, unknown>)} where id = ${id}`;
  else
    await sql`insert into app.card_receipts ${sql({ id, ...row, created_by: actor } as Record<string, unknown>)}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'card_receipt', ${id})`;
}
