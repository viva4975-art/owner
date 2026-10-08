import { createHash } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import {
  invoiceNumbersIn,
  parseBankCsv,
  parseCamt053,
  type StatementLine,
} from '../domain/bank/statement.js';
import { addDays, formatDateDe } from '../domain/invoice/calc.js';
import { divRoundHalfUp } from '../domain/money/money.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Kontoumsätze: Auszug (CAMT.053 oder CSV) einlesen → Umsätze (unveränderbar, doppelt einlesen schadet nicht) →
 * Vorschläge (Rechnungsnummer im Verwendungszweck, Betrag, Skonto, Lastschrifteinzug, Zahlungslauf, Rücklastschrift)
 * → Büro bestätigt → Zahlungen werden gebucht (feste IDs, nie doppelt). Nichts wird automatisch gebucht.
 */

export interface BankTx {
  id: string;
  import_id: string;
  account_iban: string | null;
  booking_date: string;
  value_date: string | null;
  amount_cents: bigint;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  purpose: string;
  end_to_end_id: string | null;
  bank_ref: string | null;
  status: 'offen' | 'zugeordnet' | 'ignoriert';
  note: string | null;
  assigned_kind: 'kunde' | 'lieferant' | 'mitarbeiter' | 'sonstiges' | null;
  assigned_id: string | null;
  matched_by: string | null;
  matched_at: Date | null;
}

const MAX_BYTES = 20 * 1024 * 1024;
const SKONTO_GRACE_DAYS = 5; // Überweisung am Skontotag, Gutschrift wenige Tage später

const iban = (s: string | null | undefined) => (s ?? '').replace(/\s/g, '').toUpperCase();

function decode(bytes: Uint8Array): string {
  const utf = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // CSV der Banken oft in Windows-1252 → Ersatzzeichen deuten darauf hin
  return utf.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf;
}

const txId = (l: StatementLine, occurrence: number) =>
  createHash('md5')
    .update(
      [
        l.accountIban ?? '',
        l.bookingDate,
        String(l.amountCents),
        l.bankRef ?? l.endToEndId ?? '',
        l.purpose,
        occurrence,
      ].join('|'),
    )
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Auszug einlesen. Feste Import-ID → doppelter Klick legt nichts doppelt an; Umsätze per Inhalts-ID dedupliziert. */
export async function importStatement(
  deps: Deps,
  p: { id: string; filename: string; bytes: Uint8Array; accountIban: string | null; actor: string },
) {
  const { sql } = deps;
  const [done] = await sql<{ line_count: number; new_count: number }[]>`
    select line_count, new_count from app.bank_imports where id = ${p.id}`;
  if (done) return { lines: done.line_count, created: done.new_count };
  if (p.bytes.length > MAX_BYTES) throw new BusinessError('Datei zu groß (höchstens 20 MB)');
  const text = decode(p.bytes);
  const isXml = text.trimStart().startsWith('<');
  let lines: StatementLine[];
  try {
    lines = isXml ? parseCamt053(text) : parseBankCsv(text, p.accountIban);
  } catch (e) {
    throw new BusinessError(`Auszug nicht lesbar: ${(e as Error).message}`);
  }
  if (!lines.length) throw new BusinessError('Keine gebuchten Umsätze in der Datei');
  const own = (await getSeller(sql)).bankAccounts.map((b) => iban(b.iban));
  for (const l of lines) {
    l.accountIban = iban(l.accountIban ?? p.accountIban) || null;
    if (!l.accountIban) throw new BusinessError('Konto unbekannt – bitte das Konto auswählen');
    if (!own.includes(l.accountIban)) {
      throw new BusinessError(`Auszug gehört nicht zu unseren Konten (${l.accountIban})`);
    }
  }
  const seen = new Map<string, number>();
  const rows = lines.map((l) => {
    const key = [
      l.accountIban,
      l.bookingDate,
      l.amountCents,
      l.bankRef ?? l.endToEndId ?? '',
      l.purpose,
    ].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { id: txId(l, n), l };
  });
  const ext = isXml ? 'xml' : 'csv';
  const sha = createHash('sha256').update(p.bytes).digest('hex');
  const path = `kontoauszuege/${sha.slice(0, 2)}/${sha}.${ext}`;
  await deps.archive.put(path, p.bytes);
  let created = 0;
  await sql.begin(async (tx) => {
    await tx`insert into app.bank_imports (id, filename, format, file_path, file_sha256, line_count, new_count, created_by)
             values (${p.id}, ${p.filename.slice(0, 200)}, ${isXml ? 'camt053' : 'csv'}, ${path}, ${sha}, ${rows.length}, 0, ${p.actor})`;
    for (const { id, l } of rows) {
      const r = await tx`
        insert into app.bank_transactions (id, import_id, account_iban, booking_date, value_date, amount_cents,
                                           counterparty_name, counterparty_iban, purpose, end_to_end_id, bank_ref)
        values (${id}, ${p.id}, ${l.accountIban}, ${l.bookingDate}, ${l.valueDate}, ${l.amountCents},
                ${l.counterpartyName}, ${l.counterpartyIban}, ${l.purpose}, ${l.endToEndId}, ${l.bankRef})
        on conflict (id) do nothing`;
      created += r.count;
    }
    await tx`update app.bank_imports set new_count = ${created} where id = ${p.id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'import', 'bank_import', ${p.id}, ${tx.json({ lines: rows.length, created, file: p.filename })})`;
  });
  return { lines: rows.length, created };
}

export type TxFilter = BankTx['status'] | 'alle' | 'erledigt';
export async function listTransactions(
  sql: Sql,
  f: { status?: TxFilter; account?: string | null; limit?: number; offset?: number } = {},
) {
  const st = f.status ?? 'offen';
  const where = sql`${
    st === 'alle' ? sql`true` : st === 'erledigt' ? sql`status <> 'offen'` : sql`status = ${st}`
  } and ${f.account ? sql`account_iban = ${iban(f.account)}` : sql`true`}`;
  const [rows, [cnt]] = await Promise.all([
    sql<BankTx[]>`
      select * from app.bank_transactions where ${where}
       order by booking_date desc, amount_cents desc limit ${f.limit ?? 500} offset ${f.offset ?? 0}`,
    sql<{ n: number }[]>`select count(*)::int as n from app.bank_transactions where ${where}`,
  ]);
  return Object.assign(rows, { total: cnt!.n });
}

/** Vor der Umstellung (in Fortytools zugeordnet): alle offenen Umsätze bis zu einem Tag als erledigt abhaken. */
export async function closeBefore(
  sql: Sql,
  day: string,
  account: string | null,
  actor: string,
  note = 'vor der Umstellung (in Fortytools zugeordnet)',
) {
  const r = await sql`
    update app.bank_transactions set status = 'ignoriert', note = ${note},
           assigned_kind = 'sonstiges', matched_by = ${actor}, matched_at = now()
     where status = 'offen' and booking_date <= ${day} and ${account ? sql`account_iban = ${iban(account)}` : sql`true`}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'close_before', 'bank_transaction', null, ${sql.json({ day, count: r.count, account })})`;
  return r.count;
}

export async function getTransaction(sql: Sql, id: string) {
  const [t] = await sql<BankTx[]>`select * from app.bank_transactions where id = ${id}`;
  return t;
}

// ---------------------------------------------------------------- Vorschläge

export interface InvoiceMatch {
  invoice_id: string;
  number: string;
  customer_name: string;
  customer_no?: string;
  issue_date?: string;
  /** Rechnung aus Fortytools (Zahlung in legacy_payments) */
  legacy?: boolean;
  open_cents: bigint;
  amount: bigint; // Zahlung
  skonto: bigint; // Skonto-Abzug (eigene Buchung)
  /** Skonto nicht vereinbart, aber erkannt (Differenz in %) – nur nach Bestätigung */
  free?: boolean;
}

export type Suggestion =
  | {
      kind: 'invoices';
      label: string;
      confidence: 'sicher' | 'wahrscheinlich' | 'prüfen';
      items: InvoiceMatch[];
    }
  | {
      kind: 'incoming';
      label: string;
      confidence: 'sicher' | 'wahrscheinlich' | 'prüfen';
      supplierId: string;
      supplierName: string;
      items: { id: string; invoice_no: string; invoice_date: string; amount: bigint; skonto: bigint }[];
    }
  | {
      kind: 'party';
      label: string;
      party: 'kunde' | 'lieferant' | 'mitarbeiter';
      partyId: string;
      partyName: string;
      partyNo: string;
    }
  | { kind: 'debit_run'; label: string; runId: string }
  | { kind: 'payment_run'; label: string; runId: string }
  | { kind: 'return'; label: string; runId: string; invoiceId: string };

interface OpenRow {
  invoice_id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  issue_date: string;
  legacy: boolean;
  open_cents: bigint;
  payable_cents: bigint;
  skonto_percent_bp: number | null;
  skonto_date: string | null;
}

/** Offene eigene Rechnungen und offene Rechnungen aus Fortytools (ohne Skonto-Automatik). */
async function openInvoices(sql: Sql | Tx) {
  return sql<OpenRow[]>`
    select o.invoice_id, o.number, o.customer_id, c.name as customer_name, c.customer_no, i.issue_date::text,
           false as legacy, o.open_cents, o.payable_cents, i.skonto_percent_bp, i.skonto_date
      from app.open_items o join app.invoices i on i.id = o.invoice_id join app.customers c on c.id = o.customer_id
     where o.open_cents > 0
    union all
    select o.invoice_id, o.number, o.customer_id, c.name, c.customer_no, o.issue_date::text,
           true, o.open_cents, o.open_cents, null, null
      from app.legacy_open_items o join app.customers c on c.id = o.customer_id
     where o.open_cents > 0`;
}

/** Skonto, wenn der Betrag genau dem Zahlbetrag nach Skonto entspricht und rechtzeitig gezahlt wurde. */
function skontoFit(o: OpenRow, amount: bigint, bookingDate: string): bigint {
  if (!o.skonto_percent_bp || !o.skonto_date) return 0n;
  if (bookingDate > addDays(o.skonto_date, SKONTO_GRACE_DAYS)) return 0n;
  // nur, solange noch nichts (Teil-)bezahlt wurde: Skonto vom vollen Zahlbetrag
  if (o.open_cents !== o.payable_cents) return 0n;
  const sk = divRoundHalfUp(o.payable_cents * BigInt(o.skonto_percent_bp), 10_000n);
  const diff = o.open_cents - amount;
  return diff > 0n && (diff === sk || diff - sk === 1n || sk - diff === 1n) ? diff : 0n;
}

/** Daten, die für alle Umsätze einer Seite gleich sind – einmal laden statt je Zeile (Seite war sonst langsam). */
export interface SuggestionCache {
  open?: Promise<OpenRow[]>;
  incoming?: Promise<IncomingRow[]>;
}

export async function suggestions(sql: Sql, t: BankTx, cache: SuggestionCache = {}): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  if (t.status !== 'offen') return out;
  if (t.amount_cents > 0n) {
    const open = await (cache.open ??= openInvoices(sql));
    const byNo = new Map(open.map((o) => [o.number, o]));
    const nos = invoiceNumbersIn(t.purpose, (n) => byNo.has(n));
    const found = nos.map((n) => byNo.get(n)!);
    const amount = t.amount_cents;
    if (found.length === 1) {
      const o = found[0]!;
      const sk = skontoFit(o, amount, t.booking_date);
      if (amount === o.open_cents || sk > 0n) {
        out.push({
          kind: 'invoices',
          confidence: 'sicher',
          label: sk > 0n ? `Rechnung ${o.number} mit Skonto ${fmt(sk)}` : `Rechnung ${o.number} vollständig`,
          items: [{ ...pick(o), amount, skonto: sk }],
        });
      } else if (amount < o.open_cents) {
        const part: Suggestion = {
          kind: 'invoices',
          confidence: 'prüfen',
          label: `Teilzahlung auf Rechnung ${o.number} (offen ${fmt(o.open_cents)})`,
          items: [{ ...pick(o), amount, skonto: 0n }],
        };
        // Kunde hat Skonto abgezogen, obwohl nicht (mehr) vereinbart: Differenz bis 5 % als Skonto anbieten
        const diff = o.open_cents - amount;
        const bp = Number((diff * 10_000n) / o.open_cents);
        if (bp >= 1 && bp <= 500) {
          const sk: Suggestion = {
            kind: 'invoices',
            confidence: nearRoundPercent(diff, o.open_cents) ? 'wahrscheinlich' : 'prüfen',
            label: `Rechnung ${o.number} mit Skonto-Abzug ${pctText(diff, o.open_cents)} (${fmt(diff)}) – Skonto war nicht vereinbart`,
            items: [{ ...pick(o), amount, skonto: diff, free: true }],
          };
          out.push(...(nearRoundPercent(diff, o.open_cents) ? [sk, part] : [part, sk]));
        } else out.push(part);
      }
    } else if (found.length > 1) {
      const sum = found.reduce((a, o) => a + o.open_cents, 0n);
      const sub = sum === amount ? found : subsetSum(found, (o) => o.open_cents, amount);
      if (sub) {
        out.push({
          kind: 'invoices',
          confidence: 'sicher',
          label: `Rechnungen ${sub.map((o) => o.number).join(', ')}`,
          items: sub.map((o) => ({ ...pick(o), amount: o.open_cents, skonto: 0n })),
        });
      }
    }
    if (!out.length && t.counterparty_iban) {
      // IBAN eines Kunden: eine offene Rechnung mit genau dem Betrag oder alle offenen zusammen
      const custs = await sql<{ customer_id: string }[]>`
        select distinct customer_id from app.customer_bank_accounts where iban = ${iban(t.counterparty_iban)}`;
      const ids = new Set(custs.map((c) => c.customer_id));
      const mine = open.filter((o) => ids.has(o.customer_id));
      const one = mine.filter((o) => o.open_cents === amount);
      const sub = one.length ? null : subsetSum(mine, (o) => o.open_cents, amount);
      if (one.length === 1)
        out.push({
          kind: 'invoices',
          confidence: 'wahrscheinlich',
          label: `Rechnung ${one[0]!.number} (Konto des Kunden, Betrag passt)`,
          items: [{ ...pick(one[0]!), amount, skonto: 0n }],
        });
      else if (sub)
        out.push({
          kind: 'invoices',
          confidence: 'wahrscheinlich',
          label: `Rechnungen ${sub.map((o) => o.number).join(', ')} (Konto des Kunden, Summe passt)`,
          items: sub.map((o) => ({ ...pick(o), amount: o.open_cents, skonto: 0n })),
        });
    }
    if (!out.length) {
      // ohne Nummer: eindeutiger Betrag
      const same = open.filter((o) => o.open_cents === amount);
      if (same.length === 1) {
        out.push({
          kind: 'invoices',
          confidence: 'wahrscheinlich',
          label: `Betrag passt genau zu Rechnung ${same[0]!.number} (${same[0]!.customer_name})`,
          items: [{ ...pick(same[0]!), amount, skonto: 0n }],
        });
      }
    }
    const runs = await sql<{ id: string; number: string }[]>`
      select id, number from app.direct_debit_runs where status = 'erstellt' and total_cents = ${amount}`;
    for (const r of runs)
      out.push({ kind: 'debit_run', runId: r.id, label: `Lastschrifteinzug ${r.number} (Sammelgutschrift)` });
  } else {
    out.push(...(await incomingSuggestions(sql, t, cache)));
    const prs = await sql<{ id: string; number: string }[]>`
      select id, number from app.payment_runs where total_cents = ${-t.amount_cents}
         and not exists (select 1 from app.bank_transactions b where b.status = 'zugeordnet' and b.note = 'Zahlungslauf ' || payment_runs.number)`;
    for (const r of prs) out.push({ kind: 'payment_run', runId: r.id, label: `Zahlungslauf ${r.number}` });
    if (t.end_to_end_id) {
      const ret = await sql<{ run_id: string; invoice_id: string; number: string; inv: string }[]>`
        select d.run_id, d.invoice_id, r.number, i.number as inv
          from app.direct_debit_items d join app.direct_debit_runs r on r.id = d.run_id join app.invoices i on i.id = d.invoice_id
         where d.end_to_end_id = ${t.end_to_end_id} and d.returned_at is null and d.amount_cents <= ${-t.amount_cents}`;
      for (const r of ret) {
        out.push({
          kind: 'return',
          runId: r.run_id,
          invoiceId: r.invoice_id,
          label: `Rücklastschrift zu Rechnung ${r.inv} (Einzug ${r.number})`,
        });
      }
    }
  }
  if (!out.some((s) => s.kind === 'invoices' || s.kind === 'incoming'))
    out.push(...(await partySuggestions(sql, t)));
  return out;
}

const pick = (o: OpenRow) => ({
  invoice_id: o.invoice_id,
  number: o.number,
  customer_name: o.customer_name,
  customer_no: o.customer_no,
  issue_date: o.issue_date,
  legacy: o.legacy,
  open_cents: o.open_cents,
});

interface IncomingRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_iban: string | null;
  invoice_no: string;
  invoice_date: string;
  gross_cents: bigint;
  skonto_until: string | null;
  skonto_percent_bp: number | null;
  status: string;
  paid_amount_cents: bigint | null;
  paid_at: string | null;
}

const INCOMING_COLS = (sql: Sql | Tx) => sql`
  i.id, i.supplier_id, s.name as supplier_name, s.iban as supplier_iban, i.invoice_no, i.invoice_date::text,
  i.gross_cents, i.skonto_until::text, i.skonto_percent_bp, i.status, i.paid_amount_cents, i.paid_at::text`;

const incomingSkonto = (i: IncomingRow, date: string) =>
  !i.skonto_until || !i.skonto_percent_bp || date > addDays(i.skonto_until, SKONTO_GRACE_DAYS)
    ? 0n
    : divRoundHalfUp(i.gross_cents * BigInt(i.skonto_percent_bp), 10_000n);

/** Großbuchstaben und Ziffern – „RE-2026/0815“ findet auch „RE 2026 0815“ im Verwendungszweck. */
const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '');
const NAME_STOP = new Set([
  'GMBH',
  'MBH',
  'HANDELS',
  'HANDEL',
  'SERVICE',
  'SERVICES',
  'DEUTSCHLAND',
  'GERMANY',
  'MUENCHEN',
  'MÜNCHEN',
  'GEBÄUDEREINIGUNG',
  'GEBAEUDEREINIGUNG',
  'FIRMA',
  'UND',
  'GROUP',
  'GRUPPE',
  'HOLDING',
  'VERTRIEB',
]);
/** Erstes kennzeichnendes Wort des Lieferantennamens kommt im Namen der Gegenseite vor. */
const nameMatches = (supplier: string, counterparty: string | null) => {
  const cp = norm(counterparty);
  if (!cp) return false;
  const word = supplier
    .toUpperCase()
    .split(/[^A-Z0-9ÄÖÜ]+/)
    .find((w) => w.length >= 4 && !NAME_STOP.has(w));
  return !!word && cp.includes(word);
};
const nearRoundPercent = (diff: bigint, base: bigint) => {
  const bp = Number((diff * 10_000n) / base);
  const round = Math.round(bp / 50) * 50; // 0,5-%-Schritte (2 %, 2,5 %, 3 % …)
  return (
    round > 0 &&
    divRoundHalfUp(base * BigInt(round), 10_000n) - diff <= 1n &&
    diff - divRoundHalfUp(base * BigInt(round), 10_000n) <= 1n
  );
};
const pctText = (diff: bigint, base: bigint) =>
  `${(Number((diff * 10_000n) / base) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;

/** Kleinste Auswahl (bis 14 Posten), deren Summe genau dem Betrag entspricht – auch mit Minusbeträgen (Verrechnung). */
export function subsetSum<T>(items: T[], val: (t: T) => bigint, target: bigint): T[] | null {
  const list = items.slice(0, 14);
  let best: T[] | null = null;
  for (let m = 1; m < 1 << list.length; m++) {
    let sum = 0n;
    const pickd: T[] = [];
    for (let i = 0; i < list.length; i++)
      if (m & (1 << i)) {
        sum += val(list[i]!);
        pickd.push(list[i]!);
      }
    if (sum === target && pickd.length >= 2 && (!best || pickd.length < best.length)) best = pickd;
  }
  return best;
}

type IncomingSuggestion = Extract<Suggestion, { kind: 'incoming' }>;
const RANK = { sicher: 0, wahrscheinlich: 1, prüfen: 2 } as const;

/**
 * Ausgang → Eingangsrechnungen. Erkannt wird über Rechnungsnummer im Verwendungszweck, IBAN oder Namen des Lieferanten;
 * Betrag genau, mit Skonto (vereinbart oder als Differenz bis 5 %) oder als Verrechnung mehrerer Rechnungen und
 * Rechnungskorrekturen (Minusbeträge) desselben Lieferanten. Auch noch nicht freigegebene Rechnungen.
 */
async function incomingSuggestions(sql: Sql, t: BankTx, cache: SuggestionCache = {}): Promise<Suggestion[]> {
  const amount = -t.amount_cents;
  // alle offenen (bzw. schon bezahlten, noch nicht verknüpften) Eingangsrechnungen – Betrag wird je Umsatz geprüft
  const rows = (
    await (cache.incoming ??= sql<IncomingRow[]>`
    select ${INCOMING_COLS(sql)}
      from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
     where i.bank_transaction_id is null
       and (i.status in ('erfasst', 'freigegeben') or (i.status = 'bezahlt' and i.paid_at > current_date - 400))`.then(
      (r) => [...r],
    ))
  ).filter((i) => i.status !== 'bezahlt' || i.paid_amount_cents === amount);
  const purpose = norm(t.purpose);
  const cp = iban(t.counterparty_iban);
  const byNo = (i: IncomingRow) => {
    const n = norm(i.invoice_no);
    return n.length >= 4 && purpose.includes(n);
  };
  const supplierHit = new Map<string, 'nummer' | 'iban' | 'name'>();
  for (const i of rows) {
    if (byNo(i)) supplierHit.set(i.supplier_id, 'nummer');
    else if (!supplierHit.has(i.supplier_id) && cp && iban(i.supplier_iban) === cp)
      supplierHit.set(i.supplier_id, 'iban');
    else if (!supplierHit.has(i.supplier_id) && nameMatches(i.supplier_name, t.counterparty_name))
      supplierHit.set(i.supplier_id, 'name');
  }
  const out: IncomingSuggestion[] = [];
  const add = (
    conf: IncomingSuggestion['confidence'],
    label: string,
    items: { i: IncomingRow; pay: bigint; sk: bigint }[],
  ) => {
    const key = items
      .map((x) => x.i.id)
      .sort()
      .join();
    if (
      out.some(
        (o) =>
          o.items
            .map((x) => x.id)
            .sort()
            .join() === key,
      )
    )
      return;
    const h = items[0]!.i;
    out.push({
      kind: 'incoming',
      confidence: conf,
      label,
      supplierId: h.supplier_id,
      supplierName: h.supplier_name,
      items: items.map((x) => ({
        id: x.i.id,
        invoice_no: x.i.invoice_no,
        invoice_date: x.i.invoice_date,
        amount: x.pay,
        skonto: x.sk,
      })),
    });
  };
  const paid = (i: IncomingRow) => i.status === 'bezahlt';
  const done = (i: IncomingRow) => (paid(i) ? ' – schon als bezahlt festgehalten' : '');
  for (const i of rows) {
    const hit = supplierHit.get(i.supplier_id);
    const own = byNo(i);
    const value = paid(i) ? i.paid_amount_cents! : i.gross_cents;
    if (value === amount && (own || hit)) {
      add(
        own ? 'sicher' : 'wahrscheinlich',
        `Eingangsrechnung ${i.invoice_no} (${i.supplier_name})${done(i)}`,
        [{ i, pay: amount, sk: 0n }],
      );
      continue;
    }
    if (paid(i) || i.gross_cents <= 0n || amount >= i.gross_cents || !(own || hit)) continue;
    const diff = i.gross_cents - amount;
    const agreed = incomingSkonto(i, t.booking_date);
    const bp = Number((diff * 10_000n) / i.gross_cents);
    const fits = agreed > 0n && diff - agreed <= 1n && agreed - diff <= 1n;
    if (fits || (own && bp >= 1 && bp <= 500)) {
      add(
        own && (fits || nearRoundPercent(diff, i.gross_cents)) ? 'sicher' : 'wahrscheinlich',
        `Eingangsrechnung ${i.invoice_no} (${i.supplier_name}) mit Skonto ${pctText(diff, i.gross_cents)} (${fmt(diff)})`,
        [{ i, pay: amount, sk: diff }],
      );
    }
  }
  // Verrechnung: mehrere offene Rechnungen/Korrekturen desselben (erkannten) Lieferanten ergeben den Betrag
  for (const [sid, how] of supplierHit) {
    const mine = rows.filter((i) => i.supplier_id === sid && !paid(i));
    const sub = subsetSum(mine, (i) => i.gross_cents, amount);
    if (!sub) continue;
    const plus = sub.filter((i) => i.gross_cents > 0n);
    const minus = sub.filter((i) => i.gross_cents < 0n);
    add(
      how === 'nummer' && plus.every(byNo) ? 'sicher' : 'wahrscheinlich',
      `${minus.length ? 'Verrechnung: ' : ''}Eingangsrechnungen ${plus.map((i) => i.invoice_no).join(', ')}${
        minus.length
          ? ` abzgl. Korrektur ${minus.map((i) => `${i.invoice_no} (${fmt(-i.gross_cents)})`).join(', ')}`
          : ''
      } (${sub[0]!.supplier_name})`,
      sub.map((i) => ({ i, pay: i.gross_cents, sk: 0n })),
    );
  }
  if (!out.length) {
    // unbekannte Gegenseite: genau eine offene Rechnung mit dem Betrag
    const same = rows.filter((i) => !paid(i) && i.gross_cents === amount);
    if (same.length === 1)
      add('prüfen', `Betrag passt zu Eingangsrechnung ${same[0]!.invoice_no} (${same[0]!.supplier_name})`, [
        { i: same[0]!, pay: amount, sk: 0n },
      ]);
  }
  return out.sort((x, y) => RANK[x.confidence] - RANK[y.confidence]).slice(0, 3);
}

/** Ohne Rechnung: Gegenkonto gehört einem Kunden, Lieferanten oder Mitarbeiter. */
async function partySuggestions(sql: Sql, t: BankTx): Promise<Suggestion[]> {
  const cp = iban(t.counterparty_iban);
  if (!cp) return [];
  const rows = await sql<
    { party: 'kunde' | 'lieferant' | 'mitarbeiter'; id: string; name: string; no: string }[]
  >`
    select 'kunde' as party, c.id, c.name, c.customer_no as no
      from app.customer_bank_accounts b join app.customers c on c.id = b.customer_id where b.iban = ${cp}
    union all
    select 'lieferant', s.id, s.name, s.supplier_no from app.suppliers s
     where upper(replace(coalesce(s.iban, ''), ' ', '')) = ${cp}
    union all
    select 'mitarbeiter', e.id, trim(coalesce(e.first_name, '') || ' ' || e.last_name), e.personnel_no
      from app.employee_private p join app.employees e on e.id = p.employee_id
     where upper(replace(coalesce(p.iban, ''), ' ', '')) = ${cp}
    limit 3`;
  return rows.map((r) => ({
    kind: 'party' as const,
    party: r.party,
    partyId: r.id,
    partyName: r.name,
    partyNo: r.no,
    label: `${PARTY_LABEL[r.party]} ${r.no} ${r.name} (Konto bekannt)`,
  }));
}

export const PARTY_LABEL = { kunde: 'Kunde', lieferant: 'Lieferant', mitarbeiter: 'Mitarbeiter' } as const;
const fmt = (c: bigint) =>
  `${(Number(c) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// ---------------------------------------------------------------- Zuordnen

const uuidOf = (s: string) =>
  createHash('md5')
    .update(s)
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

async function lockOpen(tx: Tx, id: string) {
  const [t] = await tx<BankTx[]>`select * from app.bank_transactions where id = ${id} for update`;
  if (!t) throw new BusinessError('Umsatz nicht gefunden');
  return t;
}

/**
 * Zahlungseingang auf Rechnungen buchen. Summe der Zahlungen = Umsatz; Skonto je Rechnung als eigene Buchung
 * „Skonto-Abzug“. Feste IDs aus Umsatz + Rechnung → doppelt absenden bucht nichts doppelt.
 */
export async function assignInvoices(
  sql: Sql,
  txIdValue: string,
  items: { invoiceId: string; amount: bigint; skonto: bigint; legacy?: boolean; free?: boolean }[],
  actor: string,
) {
  if (!items.length) throw new BusinessError('Bitte mindestens eine Rechnung wählen');
  let customerId: string | null = null;
  await sql.begin(async (tx) => {
    const t = await lockOpen(tx, txIdValue);
    if (t.status === 'zugeordnet') return; // schon erledigt
    if (t.amount_cents <= 0n)
      throw new BusinessError('Nur Zahlungseingänge können Rechnungen zugeordnet werden');
    const sum = items.reduce((a, i) => a + i.amount, 0n);
    if (sum !== t.amount_cents) {
      throw new BusinessError(
        `Summe der Zuordnung (${fmt(sum)}) entspricht nicht dem Umsatz (${fmt(t.amount_cents)})`,
      );
    }
    const nos: string[] = [];
    for (const it of items) {
      if (it.amount <= 0n || it.skonto < 0n) throw new BusinessError('Beträge müssen positiv sein');
      if (it.legacy) {
        nos.push(await payLegacy(tx, t, it, actor));
        continue;
      }
      await tx`select 1 from app.invoices where id = ${it.invoiceId} for update`;
      const [o] = await tx<OpenRow[]>`
        select o.invoice_id, o.number, o.customer_id, '' as customer_name, o.open_cents, o.payable_cents,
               i.skonto_percent_bp, i.skonto_date
          from app.open_items o join app.invoices i on i.id = o.invoice_id where o.invoice_id = ${it.invoiceId}`;
      if (!o) throw new BusinessError('Rechnung nicht offen (oder Storno/Korrektur)');
      if (it.amount + it.skonto > o.open_cents) {
        throw new BusinessError(
          `Rechnung ${o.number}: Betrag höher als offen (${fmt(o.open_cents)}) – Überzahlung klären`,
        );
      }
      // erkannter, nicht vereinbarter Skonto: höchstens 5 % und nur, wenn er die Rechnung ausgleicht
      const freeOk =
        it.free && it.amount + it.skonto === o.open_cents && it.skonto * 10_000n <= o.open_cents * 500n;
      if (it.skonto > 0n && !freeOk && skontoFit(o, it.amount, t.booking_date) !== it.skonto) {
        throw new BusinessError(`Rechnung ${o.number}: Skonto nicht zulässig (Frist/Betrag)`);
      }
      nos.push(o.number);
      customerId ??= o.customer_id;
      const ref = `Bank ${formatDateDe(t.booking_date)} ${t.counterparty_name ?? ''}`.trim().slice(0, 120);
      await tx`insert into app.payments (id, invoice_id, amount_cents, paid_on, method, reference, note, bank_transaction_id, created_by)
               values (${uuidOf(`${t.id}:${it.invoiceId}`)}, ${it.invoiceId}, ${it.amount}, ${t.booking_date}, 'ueberweisung',
                       ${ref}, ${t.purpose.slice(0, 500) || null}, ${t.id}, ${actor})
               on conflict (id) do nothing`;
      if (it.skonto > 0n) {
        await tx`insert into app.payments (id, invoice_id, amount_cents, paid_on, method, reference, bank_transaction_id, created_by)
                 values (${uuidOf(`${t.id}:${it.invoiceId}:skonto`)}, ${it.invoiceId}, ${it.skonto}, ${t.booking_date}, 'skonto',
                         ${'Skonto-Abzug'}, ${t.id}, ${actor})
                 on conflict (id) do nothing`;
      }
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'payment', 'invoice', ${it.invoiceId},
                       ${tx.json({ amount_cents: String(it.amount), skonto_cents: String(it.skonto), bank_transaction: t.id })})`;
    }
    if (!customerId) {
      const [l] = await tx<{ customer_id: string }[]>`
        select customer_id from app.legacy_invoices where id = ${items[0]!.invoiceId}`;
      customerId = l?.customer_id ?? null;
    }
    if (customerId) await learnCustomerIban(tx, customerId, t, actor);
    await tx`update app.bank_transactions set status = 'zugeordnet', note = ${`Rechnung ${nos.join(', ')}`},
               assigned_kind = 'kunde', assigned_id = ${customerId},
               matched_by = ${actor}, matched_at = now() where id = ${t.id}`;
  });
}

/** Zahlung auf eine Rechnung aus Fortytools (Skonto nur, wenn er die Rechnung genau ausgleicht). */
async function payLegacy(
  tx: Tx,
  t: BankTx,
  it: { invoiceId: string; amount: bigint; skonto: bigint },
  actor: string,
) {
  await tx`select 1 from app.legacy_invoices where id = ${it.invoiceId} for update`;
  const [o] = await tx<{ number: string; open_cents: bigint }[]>`
    select number, open_cents from app.legacy_open_items where invoice_id = ${it.invoiceId}`;
  if (!o) throw new BusinessError('Rechnung (Fortytools) ist nicht mehr offen');
  if (it.amount + it.skonto > o.open_cents)
    throw new BusinessError(
      `Rechnung ${o.number}: Betrag höher als offen (${fmt(o.open_cents)}) – Überzahlung klären`,
    );
  if (it.skonto > 0n && it.amount + it.skonto !== o.open_cents)
    throw new BusinessError(`Rechnung ${o.number}: Skonto nur als Rest der Rechnung möglich`);
  const ref = `Bank ${formatDateDe(t.booking_date)} ${t.counterparty_name ?? ''}`.trim().slice(0, 120);
  await tx`insert into app.legacy_payments (id, invoice_id, amount_cents, paid_on, method, reference, bank_transaction_id, created_by)
           values (${uuidOf(`${t.id}:${it.invoiceId}`)}, ${it.invoiceId}, ${it.amount}, ${t.booking_date}, 'zahlung', ${ref}, ${t.id}, ${actor})
           on conflict (id) do nothing`;
  if (it.skonto > 0n)
    await tx`insert into app.legacy_payments (id, invoice_id, amount_cents, paid_on, method, reference, bank_transaction_id, created_by)
             values (${uuidOf(`${t.id}:${it.invoiceId}:skonto`)}, ${it.invoiceId}, ${it.skonto}, ${t.booking_date}, 'skonto', 'Skonto-Abzug', ${t.id}, ${actor})
             on conflict (id) do nothing`;
  const closed = it.amount + it.skonto === o.open_cents;
  await tx`update app.legacy_invoices set paid_part_cents = paid_part_cents + ${it.amount},
             paid = ${closed}, paid_at = ${closed ? t.booking_date : null}, paid_marked_by = ${closed ? actor : null}
           where id = ${it.invoiceId}`;
  await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
           values (${actor}, 'payment', 'legacy_invoice', ${it.invoiceId},
                   ${tx.json({ amount_cents: String(it.amount), skonto_cents: String(it.skonto), bank_transaction: t.id })})`;
  return o.number;
}

const IBAN_RE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
/** Gegenkonto beim Kunden merken → nächstes Mal erkannt. */
async function learnCustomerIban(tx: Tx, customerId: string, t: BankTx, actor: string) {
  const i = iban(t.counterparty_iban);
  if (!IBAN_RE.test(i)) return;
  await tx`insert into app.customer_bank_accounts (id, customer_id, holder, iban, created_by)
           values (${uuidOf(`cba:${customerId}:${i}`)}, ${customerId}, ${(t.counterparty_name ?? 'Konto').slice(0, 120) || 'Konto'}, ${i}, ${actor})
           on conflict do nothing`;
}
/** IBAN beim Lieferanten nachtragen, wenn noch keine hinterlegt ist. */
async function learnSupplierIban(tx: Sql | Tx, supplierId: string, t: BankTx) {
  const i = iban(t.counterparty_iban);
  if (!IBAN_RE.test(i)) return;
  await tx`update app.suppliers set iban = ${i} where id = ${supplierId} and coalesce(iban, '') = ''`;
}

/**
 * Ausgang auf Eingangsrechnungen (auch noch nicht freigegebene): als bezahlt festhalten, Betrag = Rechnung − Skonto;
 * Rechnungskorrekturen (Minusbeträge) werden verrechnet. Schon von Hand als bezahlt festgehaltene werden nur verknüpft.
 * Summe muss dem Umsatz entsprechen. Ohne Skonto-Angabe gilt bei einer Rechnung die Differenz bis 5 % als Skonto.
 */
export async function assignIncoming(
  sql: Sql,
  txIdValue: string,
  items: { id: string; skonto?: bigint }[],
  actor: string,
) {
  if (!items.length) throw new BusinessError('Bitte mindestens eine Eingangsrechnung wählen');
  await sql.begin(async (tx) => {
    const t = await lockOpen(tx, txIdValue);
    if (t.status === 'zugeordnet') return;
    if (t.amount_cents >= 0n)
      throw new BusinessError('Nur Zahlungsausgänge können Eingangsrechnungen zugeordnet werden');
    const amount = -t.amount_cents;
    const ids = items.map((x) => x.id);
    const rows = await tx<IncomingRow[]>`
      select ${INCOMING_COLS(tx)}
        from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
       where i.id = any(${ids}::uuid[]) and i.bank_transaction_id is null for update of i`;
    if (rows.length !== ids.length)
      throw new BusinessError('Eingangsrechnung nicht gefunden oder schon zugeordnet');
    if (new Set(rows.map((r) => r.supplier_id)).size > 1)
      throw new BusinessError('Bitte nur Rechnungen eines Lieferanten zusammen zuordnen');
    for (const r of rows)
      if (!['erfasst', 'freigegeben', 'bezahlt'].includes(r.status))
        throw new BusinessError(`${r.invoice_no}: Status ${r.status} – nicht zuordenbar`);
    const sk = new Map(items.map((x) => [x.id, x.skonto ?? 0n]));
    const pay = (r: IncomingRow) =>
      r.status === 'bezahlt' ? (r.paid_amount_cents ?? r.gross_cents) : r.gross_cents - (sk.get(r.id) ?? 0n);
    let sum = rows.reduce((a, r) => a + pay(r), 0n);
    if (sum !== amount && rows.length === 1 && rows[0]!.status !== 'bezahlt' && !sk.get(rows[0]!.id)) {
      const r = rows[0]!;
      const diff = r.gross_cents - amount;
      if (diff > 0n && diff * 10_000n <= r.gross_cents * 500n) {
        sk.set(r.id, diff);
        sum = amount;
      }
    }
    for (const r of rows) {
      const s0 = sk.get(r.id) ?? 0n;
      if (s0 < 0n || (s0 > 0n && (r.gross_cents <= 0n || s0 * 10_000n > r.gross_cents * 500n)))
        throw new BusinessError(`${r.invoice_no}: Skonto über 5 % – bitte prüfen (Teilzahlung?)`);
    }
    if (sum !== amount)
      throw new BusinessError(
        `Summe der Rechnungen (${fmt(sum)}) entspricht nicht dem Umsatz (${fmt(amount)})`,
      );
    for (const r of rows) {
      const s0 = sk.get(r.id) ?? 0n;
      if (r.status !== 'bezahlt') {
        await tx`update app.incoming_invoices set status = 'bezahlt', paid_at = ${t.booking_date},
                   paid_amount_cents = ${r.gross_cents - s0}, paid_skonto_cents = ${s0},
                   paid_method = ${r.gross_cents < 0n ? 'verrechnung' : 'ueberweisung'},
                   paid_note = ${r.gross_cents < 0n ? 'verrechnet (Kontoumsatz)' : 'Kontoumsatz'}, paid_by = ${actor},
                   approved_by = coalesce(approved_by, ${actor}), approved_at = coalesce(approved_at, now()),
                   bank_transaction_id = ${t.id}
                 where id = ${r.id}`;
      } else {
        await tx`update app.incoming_invoices set bank_transaction_id = ${t.id} where id = ${r.id}`;
      }
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'paid', 'incoming_invoice', ${r.id},
                       ${tx.json({ bank_transaction: t.id, skonto: String(s0), from_status: r.status })})`;
    }
    const supplier = rows[0]!;
    await learnSupplierIban(tx, supplier.supplier_id, t);
    const plus = rows.filter((r) => r.gross_cents > 0n).map((r) => r.invoice_no);
    const minus = rows.filter((r) => r.gross_cents < 0n).map((r) => r.invoice_no);
    const skTotal = [...sk.values()].reduce((a, b) => a + b, 0n);
    await tx`update app.bank_transactions set status = 'zugeordnet',
               note = ${`Eingangsrechnung ${plus.join(', ')}${minus.length ? ` abzgl. Korrektur ${minus.join(', ')}` : ''}${skTotal > 0n ? ` mit Skonto ${fmt(skTotal)}` : ''} (${supplier.supplier_name})`.slice(0, 300)},
               assigned_kind = 'lieferant', assigned_id = ${supplier.supplier_id},
               matched_by = ${actor}, matched_at = now() where id = ${t.id}`;
  });
}

/** Freigegebene/als bezahlt festgehaltene Eingangsrechnungen eines Lieferanten zur Auswahl. */
export async function incomingForSupplier(sql: Sql, supplierId: string) {
  return sql<IncomingRow[]>`
    select i.id, i.supplier_id, s.name as supplier_name, s.iban as supplier_iban, i.invoice_no, i.invoice_date::text,
           i.gross_cents, i.skonto_until::text, i.skonto_percent_bp, i.status, i.paid_amount_cents, i.paid_at::text
      from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
     where i.supplier_id = ${supplierId} and i.bank_transaction_id is null
       and (i.status in ('erfasst', 'freigegeben') or (i.status = 'bezahlt' and i.paid_at > current_date - 120))
     order by i.invoice_date desc limit 100`;
}

/**
 * Umsatz ohne Rechnung einem Kunden, Lieferanten oder Mitarbeiter zuordnen (z. B. Lohn, Vorschuss, Erstattung).
 * Bucht nichts – bleibt „erledigt“ und kann wieder geöffnet werden.
 */
export async function assignParty(
  sql: Sql,
  txIdValue: string,
  p: {
    kind: 'kunde' | 'lieferant' | 'mitarbeiter';
    id: string;
    note: string | null;
    category?: string | null;
  },
  actor: string,
) {
  const category = p.kind === 'mitarbeiter' ? 'personal' : checkCategory(p.category);
  const [who] =
    p.kind === 'kunde'
      ? await sql<
          { label: string }[]
        >`select customer_no || ' ' || name as label from app.customers where id = ${p.id}`
      : p.kind === 'lieferant'
        ? await sql<
            { label: string }[]
          >`select supplier_no || ' ' || name as label from app.suppliers where id = ${p.id}`
        : await sql<{ label: string }[]>`
            select personnel_no || ' ' || trim(coalesce(first_name, '') || ' ' || last_name) as label
              from app.employees where id = ${p.id}`;
  if (!who) throw new BusinessError('Nicht gefunden – bitte aus der Liste wählen');
  const note = `${PARTY_LABEL[p.kind]} ${who.label}${p.note?.trim() ? `: ${p.note.trim()}` : ''}`.slice(
    0,
    300,
  );
  const r = await sql`
    update app.bank_transactions set status = 'ignoriert', note = ${note}, assigned_kind = ${p.kind}, assigned_id = ${p.id},
           expense_category = ${category}, matched_by = ${actor}, matched_at = now()
     where id = ${txIdValue} and status = 'offen' returning id`;
  if (!r.length) throw new BusinessError('Umsatz ist nicht (mehr) offen');
  if (p.kind === 'lieferant') {
    const t = await getTransaction(sql, txIdValue);
    if (t) await learnSupplierIban(sql, p.id, t);
  }
}

/** Kostenarten für Ausgaben ohne Eingangsrechnung (Ausgaben-Statistik). */
export const EXPENSE_CATEGORY: Record<string, string> = {
  material: 'Material / Reinigungsmittel',
  nachunternehmer: 'Nachunternehmer',
  geraete: 'Geräte / Wartung',
  fahrzeuge: 'Fahrzeuge / Tanken',
  miete: 'Miete / Büro',
  personal: 'Personal (Lohn, Vorschuss, Auslagen)',
  steuern: 'Steuern / Abgaben / Sozialversicherung',
  versicherung: 'Versicherungen',
  bank: 'Bankgebühren / Zinsen',
  privat: 'Privat / Gesellschafter',
  sonstiges: 'Sonstiges',
};
const checkCategory = (c: string | null | undefined) => {
  if (!c) return null;
  if (!(c in EXPENSE_CATEGORY)) throw new BusinessError('Kostenart unbekannt');
  return c;
};

/** Neuen Lieferanten nur mit Namen anlegen (Schnellanlage aus dem Kontoumsatz, IBAN wird übernommen). */
export async function quickSupplier(sql: Sql, name: string, t: BankTx | null, actor: string) {
  const n = name.trim();
  if (n.length < 2) throw new BusinessError('Bitte einen Namen angeben');
  const [dup] = await sql<
    { id: string }[]
  >`select id from app.suppliers where lower(name) = lower(${n}) limit 1`;
  if (dup) return dup.id;
  const [row] = await sql<{ no: string }[]>`
    select (greatest(70000, coalesce(max(case when supplier_no ~ '^[0-9]{1,9}$' then supplier_no::bigint end), 70000)) + 1)::text as no
      from app.suppliers`;
  const no = row!.no;
  const id = uuidOf(`supplier:${n.toLowerCase()}`);
  const ib = iban(t?.counterparty_iban);
  await sql`insert into app.suppliers (id, supplier_no, name, iban) values (${id}, ${no}, ${n.slice(0, 200)}, ${IBAN_RE.test(ib) ? ib : null})
            on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'create', 'supplier', ${id}, ${sql.json({ name: n, quick: true })})`;
  return id;
}

/** Sammelgutschrift eines Lastschrifteinzugs: alle Positionen als bezahlt buchen. */
export async function assignDebitRun(sql: Sql, txIdValue: string, runId: string, actor: string) {
  await sql.begin(async (tx) => {
    const t = await lockOpen(tx, txIdValue);
    if (t.status === 'zugeordnet') return;
    const [run] = await tx<{ number: string; total_cents: bigint; status: string }[]>`
      select number, total_cents, status from app.direct_debit_runs where id = ${runId} for update`;
    if (!run) throw new BusinessError('Einzug nicht gefunden');
    if (run.total_cents !== t.amount_cents) throw new BusinessError('Betrag passt nicht zum Einzug');
    await settleDebitRunTx(tx, runId, t.booking_date, actor, t.id);
    await tx`update app.bank_transactions set status = 'zugeordnet', note = ${`Lastschrifteinzug ${run.number}`},
               matched_by = ${actor}, matched_at = now() where id = ${t.id}`;
  });
}

/** Lastschrifteinzug als eingegangen buchen (auch ohne Kontoauszug, z. B. nach Blick ins Online-Banking). */
export async function settleDebitRunTx(
  tx: Tx,
  runId: string,
  paidOn: string,
  actor: string,
  bankTxId: string | null,
) {
  const [run] = await tx<{ number: string; status: string }[]>`
    select number, status from app.direct_debit_runs where id = ${runId} for update`;
  if (!run) throw new BusinessError('Einzug nicht gefunden');
  if (run.status === 'eingezogen') return;
  const items = await tx<{ invoice_id: string; amount_cents: bigint }[]>`
    select invoice_id, amount_cents from app.direct_debit_items where run_id = ${runId} and returned_at is null`;
  for (const i of items) {
    const [o] = await tx<
      { open_cents: bigint }[]
    >`select open_cents from app.open_items where invoice_id = ${i.invoice_id}`;
    if (!o || o.open_cents < i.amount_cents) {
      throw new BusinessError(
        'Eine Rechnung im Einzug ist inzwischen anders bezahlt/storniert – bitte einzeln klären',
      );
    }
    await tx`insert into app.payments (id, invoice_id, amount_cents, paid_on, method, reference, bank_transaction_id, created_by)
             values (${uuidOf(`${runId}:${i.invoice_id}`)}, ${i.invoice_id}, ${i.amount_cents}, ${paidOn}, 'lastschrift',
                     ${`Lastschrifteinzug ${run.number}`}, ${bankTxId}, ${actor})
             on conflict (id) do nothing`;
  }
  await tx`update app.direct_debit_runs set status = 'eingezogen', settled_at = now() where id = ${runId}`;
  await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
           values (${actor}, 'settle', 'direct_debit_run', ${runId}, ${tx.json({ items: items.length, paid_on: paidOn })})`;
}

/** Ausgang = Zahlungslauf (Eingangsrechnungen sind beim Lauf schon als bezahlt markiert) → nur abhaken. */
export async function assignPaymentRun(sql: Sql, txIdValue: string, runId: string, actor: string) {
  await sql.begin(async (tx) => {
    const t = await lockOpen(tx, txIdValue);
    if (t.status === 'zugeordnet') return;
    const [run] = await tx<{ number: string; total_cents: bigint }[]>`
      select number, total_cents from app.payment_runs where id = ${runId}`;
    if (!run || run.total_cents !== -t.amount_cents)
      throw new BusinessError('Betrag passt nicht zum Zahlungslauf');
    await tx`update app.bank_transactions set status = 'zugeordnet', note = ${`Zahlungslauf ${run.number}`},
               matched_by = ${actor}, matched_at = now() where id = ${t.id}`;
  });
}

/** Rücklastschrift: Einzugsposition zurückgegeben, gebuchte Zahlung per Gegenbuchung korrigieren → Rechnung wieder offen. */
export async function assignReturn(
  sql: Sql,
  txIdValue: string,
  runId: string,
  invoiceId: string,
  actor: string,
) {
  await sql.begin(async (tx) => {
    const t = await lockOpen(tx, txIdValue);
    if (t.status === 'zugeordnet') return;
    const [item] = await tx<{ amount_cents: bigint; returned_at: string | null }[]>`
      select amount_cents, returned_at from app.direct_debit_items where run_id = ${runId} and invoice_id = ${invoiceId} for update`;
    if (!item) throw new BusinessError('Einzugsposition nicht gefunden');
    if (!item.returned_at) {
      await tx`update app.direct_debit_items set returned_at = ${t.booking_date}, return_reason = ${t.purpose.slice(0, 200)}
                where run_id = ${runId} and invoice_id = ${invoiceId}`;
    }
    const pid = uuidOf(`${runId}:${invoiceId}`);
    const [paid] = await tx`select 1 from app.payments where id = ${pid}`;
    if (paid) {
      await tx`insert into app.payments (id, invoice_id, amount_cents, paid_on, method, reference, note, reverses_payment_id, bank_transaction_id, created_by)
               values (${uuidOf(`${pid}:return`)}, ${invoiceId}, ${-item.amount_cents}, ${t.booking_date}, 'korrektur',
                       'Rücklastschrift', ${t.purpose.slice(0, 500) || null}, ${pid}, ${t.id}, ${actor})
               on conflict (id) do nothing`;
    }
    const fee = -t.amount_cents - item.amount_cents;
    await tx`update app.bank_transactions set status = 'zugeordnet',
               note = ${`Rücklastschrift${fee > 0n ? ` (Bankgebühr ${fmt(fee)})` : ''}`},
               matched_by = ${actor}, matched_at = now() where id = ${t.id}`;
    const [inv] = await tx<{ number: string }[]>`select number from app.invoices where id = ${invoiceId}`;
    await tx`insert into app.tasks (id, title, description, due_date, entity_type, entity_id, created_by)
             values (${uuidOf(`${t.id}:task`)}, ${`Rücklastschrift Rechnung ${inv?.number ?? ''} klären`},
                     ${`Grund laut Bank: ${t.purpose.slice(0, 300)}. Kunde kontaktieren, Mandat/Kontodaten prüfen; erneuter Einzug erst nach Klärung.`},
                     (now() at time zone 'Europe/Berlin')::date + 2, 'invoice', ${invoiceId}, ${actor})
             on conflict (id) do nothing`;
  });
}

export async function ignoreTransaction(
  sql: Sql,
  id: string,
  note: string | null,
  actor: string,
  category: string | null = null,
) {
  const cat = checkCategory(category);
  const r = await sql`update app.bank_transactions set status = 'ignoriert',
                        note = ${cat && (!note || note === 'nicht zugeordnet') ? EXPENSE_CATEGORY[cat]! : note},
                        expense_category = ${cat}, matched_by = ${actor}, matched_at = now()
                      where id = ${id} and status = 'offen' returning id`;
  if (!r.length) throw new BusinessError('Umsatz ist nicht (mehr) offen');
}

export async function reopenTransaction(sql: Sql, id: string, actor: string) {
  const r =
    await sql`update app.bank_transactions set status = 'offen', note = null, assigned_kind = null, assigned_id = null,
                      expense_category = null,
                      matched_by = ${actor}, matched_at = now()
                      where id = ${id} and status = 'ignoriert' returning id`;
  if (!r.length) throw new BusinessError('Nur ignorierte Umsätze können wieder geöffnet werden');
}

export async function listImports(sql: Sql) {
  return sql<
    {
      id: string;
      filename: string;
      format: string;
      line_count: number;
      new_count: number;
      created_by: string;
      created_at: Date;
    }[]
  >`select id, filename, format, line_count, new_count, created_by, created_at from app.bank_imports order by created_at desc limit 50`;
}
