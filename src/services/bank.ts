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
export async function closeBefore(sql: Sql, day: string, account: string | null, actor: string) {
  const r = await sql`
    update app.bank_transactions set status = 'ignoriert', note = 'vor der Umstellung (in Fortytools zugeordnet)',
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

export async function suggestions(sql: Sql, t: BankTx): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  if (t.status !== 'offen') return out;
  if (t.amount_cents > 0n) {
    const open = await openInvoices(sql);
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
        out.push({
          kind: 'invoices',
          confidence: 'prüfen',
          label: `Teilzahlung auf Rechnung ${o.number} (offen ${fmt(o.open_cents)})`,
          items: [{ ...pick(o), amount, skonto: 0n }],
        });
      }
    } else if (found.length > 1) {
      const sum = found.reduce((a, o) => a + o.open_cents, 0n);
      if (sum === amount) {
        out.push({
          kind: 'invoices',
          confidence: 'sicher',
          label: `Rechnungen ${found.map((o) => o.number).join(', ')}`,
          items: found.map((o) => ({ ...pick(o), amount: o.open_cents, skonto: 0n })),
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
      const all = mine.reduce((a, o) => a + o.open_cents, 0n);
      if (one.length === 1)
        out.push({
          kind: 'invoices',
          confidence: 'wahrscheinlich',
          label: `Rechnung ${one[0]!.number} (Konto des Kunden, Betrag passt)`,
          items: [{ ...pick(one[0]!), amount, skonto: 0n }],
        });
      else if (mine.length > 1 && all === amount)
        out.push({
          kind: 'invoices',
          confidence: 'wahrscheinlich',
          label: `Rechnungen ${mine.map((o) => o.number).join(', ')} (alle offenen des Kunden)`,
          items: mine.map((o) => ({ ...pick(o), amount: o.open_cents, skonto: 0n })),
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
    out.push(...(await incomingSuggestions(sql, t)));
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

const incomingSkonto = (i: IncomingRow, date: string) =>
  !i.skonto_until || !i.skonto_percent_bp || date > addDays(i.skonto_until, SKONTO_GRACE_DAYS)
    ? 0n
    : divRoundHalfUp(i.gross_cents * BigInt(i.skonto_percent_bp), 10_000n);

/** Ausgang: freigegebene Eingangsrechnung (Betrag, ggf. mit Skonto) oder schon von Hand als bezahlt festgehalten. */
async function incomingSuggestions(sql: Sql, t: BankTx): Promise<Suggestion[]> {
  const amount = -t.amount_cents;
  const rows = await sql<IncomingRow[]>`
    select i.id, i.supplier_id, s.name as supplier_name, s.iban as supplier_iban, i.invoice_no, i.invoice_date::text,
           i.gross_cents, i.skonto_until::text, i.skonto_percent_bp, i.status, i.paid_amount_cents, i.paid_at::text
      from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
     where i.bank_transaction_id is null
       and (i.status = 'freigegeben' or (i.status = 'bezahlt' and i.paid_amount_cents = ${amount}))`;
  const purpose = t.purpose.toUpperCase().replace(/\s/g, '');
  const cp = iban(t.counterparty_iban);
  const hits = rows
    .map((i) => {
      const sk = i.status === 'bezahlt' ? 0n : incomingSkonto(i, t.booking_date);
      const pay =
        i.status === 'bezahlt'
          ? i.paid_amount_cents!
          : amount === i.gross_cents
            ? i.gross_cents
            : i.gross_cents - sk;
      const no = i.invoice_no.toUpperCase().replace(/\s/g, '');
      const byNo = no.length >= 3 && purpose.includes(no);
      const byIban = !!cp && iban(i.supplier_iban) === cp;
      return { i, sk: pay === i.gross_cents ? 0n : sk, pay, byNo, byIban };
    })
    .filter((h) => h.pay === amount && (h.byNo || h.byIban || h.i.status === 'freigegeben'));
  const ranked = [
    ...hits.filter((h) => h.byNo),
    ...hits.filter((h) => !h.byNo && h.byIban),
    ...hits.filter((h) => !h.byNo && !h.byIban),
  ];
  return ranked.slice(0, 3).map((h) => ({
    kind: 'incoming' as const,
    confidence: h.byNo ? ('sicher' as const) : h.byIban ? ('wahrscheinlich' as const) : ('prüfen' as const),
    label: `Eingangsrechnung ${h.i.invoice_no} (${h.i.supplier_name})${h.sk > 0n ? ` mit Skonto ${fmt(h.sk)}` : ''}${h.i.status === 'bezahlt' ? ' – schon als bezahlt festgehalten' : ''}`,
    supplierId: h.i.supplier_id,
    supplierName: h.i.supplier_name,
    items: [
      { id: h.i.id, invoice_no: h.i.invoice_no, invoice_date: h.i.invoice_date, amount: h.pay, skonto: h.sk },
    ],
  }));
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
  items: { invoiceId: string; amount: bigint; skonto: bigint; legacy?: boolean }[],
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
      if (it.skonto > 0n && skontoFit(o, it.amount, t.booking_date) !== it.skonto) {
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

/**
 * Ausgang auf Eingangsrechnungen: freigegebene werden als bezahlt festgehalten (Betrag = Rechnung, bei einer Rechnung
 * auch mit Skonto), schon von Hand als bezahlt festgehaltene nur verknüpft. Summe muss dem Umsatz entsprechen.
 */
export async function assignIncoming(sql: Sql, txIdValue: string, ids: string[], actor: string) {
  if (!ids.length) throw new BusinessError('Bitte mindestens eine Eingangsrechnung wählen');
  await sql.begin(async (tx) => {
    const t = await lockOpen(tx, txIdValue);
    if (t.status === 'zugeordnet') return;
    if (t.amount_cents >= 0n)
      throw new BusinessError('Nur Zahlungsausgänge können Eingangsrechnungen zugeordnet werden');
    const amount = -t.amount_cents;
    const rows = await tx<IncomingRow[]>`
      select i.id, i.supplier_id, s.name as supplier_name, s.iban as supplier_iban, i.invoice_no, i.invoice_date::text,
             i.gross_cents, i.skonto_until::text, i.skonto_percent_bp, i.status, i.paid_amount_cents, i.paid_at::text
        from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
       where i.id = any(${ids}::uuid[]) for update of i`;
    if (rows.length !== ids.length) throw new BusinessError('Eingangsrechnung nicht gefunden');
    for (const r of rows) {
      if (r.status !== 'freigegeben' && r.status !== 'bezahlt')
        throw new BusinessError(`${r.invoice_no}: erst freigeben (sachlich und rechnerisch richtig)`);
    }
    const pay = (r: IncomingRow) =>
      r.status === 'bezahlt' ? (r.paid_amount_cents ?? r.gross_cents) : r.gross_cents;
    const sum = rows.reduce((a, r) => a + pay(r), 0n);
    let skonto = 0n;
    if (sum !== amount) {
      const r = rows[0]!;
      const sk = rows.length === 1 && r.status === 'freigegeben' ? incomingSkonto(r, t.booking_date) : 0n;
      if (!(sk > 0n && r.gross_cents - sk === amount))
        throw new BusinessError(
          `Summe der Rechnungen (${fmt(sum)}) entspricht nicht dem Umsatz (${fmt(amount)})`,
        );
      skonto = sk;
    }
    for (const r of rows) {
      if (r.status === 'freigegeben') {
        await tx`update app.incoming_invoices set status = 'bezahlt', paid_at = ${t.booking_date},
                   paid_amount_cents = ${r.gross_cents - skonto}, paid_skonto_cents = ${skonto},
                   paid_method = 'ueberweisung', paid_note = 'Kontoumsatz', paid_by = ${actor}, bank_transaction_id = ${t.id}
                 where id = ${r.id}`;
      } else {
        await tx`update app.incoming_invoices set bank_transaction_id = ${t.id} where id = ${r.id}`;
      }
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'paid', 'incoming_invoice', ${r.id},
                       ${tx.json({ bank_transaction: t.id, skonto: String(skonto) })})`;
    }
    const supplier = rows[0]!;
    await tx`update app.bank_transactions set status = 'zugeordnet',
               note = ${`Eingangsrechnung ${rows.map((r) => r.invoice_no).join(', ')} (${supplier.supplier_name})`},
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
       and (i.status = 'freigegeben' or (i.status = 'bezahlt' and i.paid_at > current_date - 120))
     order by i.invoice_date desc limit 100`;
}

/**
 * Umsatz ohne Rechnung einem Kunden, Lieferanten oder Mitarbeiter zuordnen (z. B. Lohn, Vorschuss, Erstattung).
 * Bucht nichts – bleibt „erledigt“ und kann wieder geöffnet werden.
 */
export async function assignParty(
  sql: Sql,
  txIdValue: string,
  p: { kind: 'kunde' | 'lieferant' | 'mitarbeiter'; id: string; note: string | null },
  actor: string,
) {
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
           matched_by = ${actor}, matched_at = now()
     where id = ${txIdValue} and status = 'offen' returning id`;
  if (!r.length) throw new BusinessError('Umsatz ist nicht (mehr) offen');
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

export async function ignoreTransaction(sql: Sql, id: string, note: string | null, actor: string) {
  const r =
    await sql`update app.bank_transactions set status = 'ignoriert', note = ${note}, matched_by = ${actor}, matched_at = now()
                      where id = ${id} and status = 'offen' returning id`;
  if (!r.length) throw new BusinessError('Umsatz ist nicht (mehr) offen');
}

export async function reopenTransaction(sql: Sql, id: string, actor: string) {
  const r =
    await sql`update app.bank_transactions set status = 'offen', note = null, assigned_kind = null, assigned_id = null,
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
