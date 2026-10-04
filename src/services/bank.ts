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

export async function listTransactions(sql: Sql, f: { status?: BankTx['status'] | 'alle' } = {}) {
  const st = f.status ?? 'offen';
  return sql<BankTx[]>`
    select * from app.bank_transactions
     where ${st === 'alle' ? sql`true` : sql`status = ${st}`}
     order by booking_date desc, amount_cents desc limit 500`;
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
  | { kind: 'debit_run'; label: string; runId: string }
  | { kind: 'payment_run'; label: string; runId: string }
  | { kind: 'return'; label: string; runId: string; invoiceId: string };

interface OpenRow {
  invoice_id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  open_cents: bigint;
  payable_cents: bigint;
  skonto_percent_bp: number | null;
  skonto_date: string | null;
}

async function openInvoices(sql: Sql | Tx) {
  return sql<OpenRow[]>`
    select o.invoice_id, o.number, o.customer_id, c.name as customer_name, o.open_cents, o.payable_cents,
           i.skonto_percent_bp, i.skonto_date
      from app.open_items o join app.invoices i on i.id = o.invoice_id join app.customers c on c.id = o.customer_id
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
  return out;
}

const pick = (o: OpenRow) => ({
  invoice_id: o.invoice_id,
  number: o.number,
  customer_name: o.customer_name,
  open_cents: o.open_cents,
});
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
  items: { invoiceId: string; amount: bigint; skonto: bigint }[],
  actor: string,
) {
  if (!items.length) throw new BusinessError('Bitte mindestens eine Rechnung wählen');
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
    await tx`update app.bank_transactions set status = 'zugeordnet', note = ${`Rechnung ${nos.join(', ')}`},
               matched_by = ${actor}, matched_at = now() where id = ${t.id}`;
  });
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
    await sql`update app.bank_transactions set status = 'offen', note = null, matched_by = ${actor}, matched_at = now()
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
