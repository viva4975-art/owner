import type { Sql } from '../db/client.js';
import { addDays, monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { EXPENSE_CATEGORY } from './bank.js';
import { BusinessError } from './errors.js';
import { validIbanFormat } from './purchasing.js';

/**
 * Wiederkehrende Zahlungen (Ahmed 26.10.): Finanzamt, Miete, BG BAU, Versicherungen … Sie stehen im Fälligkeitsmonat
 * in der Zahlungsliste, bis sie als bezahlt festgehalten sind (überfällige bleiben stehen). Nur eine Merkliste – gebucht
 * wird über den Kontoauszug, daher nichts im DATEV-Export (sonst doppelt).
 */

export type RecurringCycle = 'monatlich' | 'quartalsweise' | 'halbjaehrlich' | 'jaehrlich';
export const RECURRING_CYCLE: Record<RecurringCycle, string> = {
  monatlich: 'monatlich',
  quartalsweise: 'quartalsweise',
  halbjaehrlich: 'halbjährlich',
  jaehrlich: 'jährlich',
};
const STEP: Record<RecurringCycle, number> = {
  monatlich: 1,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};

export type RecurringMethod = 'ueberweisung' | 'lastschrift' | 'dauerauftrag';
export const RECURRING_METHOD: Record<RecurringMethod, string> = {
  ueberweisung: 'Überweisung (von Hand)',
  lastschrift: 'Lastschrift (wird abgebucht)',
  dauerauftrag: 'Dauerauftrag bei der Bank',
};

export interface RecurringPayment {
  id: string;
  name: string;
  payee: string;
  iban: string | null;
  purpose: string | null;
  amount_cents: bigint | null;
  cycle: RecurringCycle;
  due_day: number;
  start_month: string;
  end_month: string | null;
  method: RecurringMethod;
  category: string | null;
  note: string | null;
  active: boolean;
  version: number;
}

export interface RecurringDue {
  payment: RecurringPayment;
  /** Monat der Fälligkeit (JJJJ-MM-01) */
  period: string;
  due_date: string;
  /** Kontoumsatz, der dazu passt (Betrag/IBAN, ±20 Tage) – Vorschlag, gebucht wird erst nach Bestätigung */
  bank: { date: string; amount_cents: bigint } | null;
}

const ym = (d: string) => d.slice(0, 7);
function addMonths(month01: string, n: number): string {
  const y = Number(month01.slice(0, 4));
  const m = Number(month01.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
}

/** Fälligkeitstag im Monat (31. → letzter Tag). */
export function dueDateOf(period: string, dueDay: number): string {
  const { end } = monthBounds(ym(period));
  const last = Number(end.slice(8, 10));
  return `${ym(period)}-${String(Math.min(dueDay, last)).padStart(2, '0')}`;
}

/** Alle Fälligkeitsmonate von Beginn bis `untilMonth` (einschließlich). */
export function periodsOf(
  p: Pick<RecurringPayment, 'cycle' | 'start_month' | 'end_month'>,
  untilMonth: string,
): string[] {
  const out: string[] = [];
  const last = p.end_month && p.end_month < untilMonth ? p.end_month : untilMonth;
  for (let m = p.start_month, i = 0; m <= last && i < 600; m = addMonths(p.start_month, ++i * STEP[p.cycle]))
    out.push(m);
  return out;
}

export async function listRecurring(sql: Sql) {
  return sql<RecurringPayment[]>`
    select id, name, payee, iban, purpose, amount_cents, cycle, due_day, start_month::text, end_month::text,
           method, category, note, active, version
      from app.recurring_payments order by active desc, name`;
}

export async function getRecurring(sql: Sql, id: string) {
  const [r] = await sql<RecurringPayment[]>`
    select id, name, payee, iban, purpose, amount_cents, cycle, due_day, start_month::text, end_month::text,
           method, category, note, active, version
      from app.recurring_payments where id = ${id}`;
  return r ?? null;
}

export interface RecurringInput {
  name: string;
  payee: string;
  iban: string | null;
  purpose: string | null;
  amount_cents: bigint | null;
  cycle: string;
  due_day: number;
  start_month: string; // JJJJ-MM
  end_month: string | null;
  method: string;
  category: string | null;
  note: string | null;
  active: boolean;
}

/** Anlegen (feste ID aus dem Formular → doppelt absenden legt nichts doppelt an) oder ändern (Versionsschutz). */
export async function saveRecurring(
  sql: Sql,
  id: string,
  input: RecurringInput,
  version: number | null,
  actor: string,
) {
  const name = input.name.trim();
  const payee = input.payee.trim();
  if (!name) throw new BusinessError('Bitte eine Bezeichnung angeben (z. B. „Umsatzsteuer-Vorauszahlung“)');
  if (!payee) throw new BusinessError('Bitte den Empfänger angeben (z. B. „Finanzamt München“)');
  if (!(input.cycle in RECURRING_CYCLE)) throw new BusinessError('Bitte Turnus wählen');
  if (!(input.method in RECURRING_METHOD)) throw new BusinessError('Bitte Zahlweg wählen');
  if (!Number.isInteger(input.due_day) || input.due_day < 1 || input.due_day > 31)
    throw new BusinessError('Fällig am: Tag 1 bis 31');
  if (!/^\d{4}-\d{2}$/.test(input.start_month))
    throw new BusinessError('Bitte den ersten Fälligkeitsmonat angeben');
  if (input.end_month && !/^\d{4}-\d{2}$/.test(input.end_month))
    throw new BusinessError('Letzter Monat ungültig');
  if (input.end_month && input.end_month < input.start_month)
    throw new BusinessError('Der letzte Monat liegt vor dem ersten');
  if (input.amount_cents !== null && input.amount_cents <= 0n)
    throw new BusinessError('Betrag muss größer als 0 sein (oder leer lassen, wenn er wechselt)');
  if (input.category && !(input.category in EXPENSE_CATEGORY)) throw new BusinessError('Kostenart unbekannt');
  const iban = input.iban ? input.iban.replace(/\s/g, '').toUpperCase() : null;
  if (iban && !validIbanFormat(iban)) throw new BusinessError('IBAN ist ungültig (Prüfziffer)');
  if (input.method === 'ueberweisung' && !iban)
    throw new BusinessError('Für eine Überweisung von Hand bitte die IBAN des Empfängers angeben');
  const purpose = input.purpose?.trim() || null;
  if (purpose && purpose.length > 140) throw new BusinessError('Verwendungszweck höchstens 140 Zeichen');
  const row = {
    name,
    payee,
    iban,
    purpose,
    amount_cents: input.amount_cents,
    cycle: input.cycle,
    due_day: input.due_day,
    start_month: `${input.start_month}-01`,
    end_month: input.end_month ? `${input.end_month}-01` : null,
    method: input.method,
    category: input.category || null,
    note: input.note?.trim() || null,
    active: input.active,
  };
  await sql.begin(async (tx) => {
    const [old] = await tx<
      RecurringPayment[]
    >`select * from app.recurring_payments where id = ${id} for update`;
    if (!old) {
      await tx`insert into app.recurring_payments ${tx({ id, ...row, created_by: actor })}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'create', 'recurring_payment', ${id}, ${tx.json({ name, payee })})`;
      return;
    }
    if (version !== null && old.version !== version)
      throw new BusinessError('Inzwischen von jemand anderem geändert – bitte Seite neu laden');
    await tx`update app.recurring_payments set ${tx(row)}, version = version + 1 where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'update', 'recurring_payment', ${id},
                     ${tx.json({ alt: { ...old, amount_cents: old.amount_cents === null ? null : String(old.amount_cents) } })})`;
  });
}

/**
 * Offene Fälligkeiten bis zum Ende des Monats von `payDate` (überfällige aus Vormonaten bleiben stehen).
 * Bezahlte (festgehalten) fallen heraus; passende Kontoumsätze werden als Vorschlag mitgegeben.
 */
export async function dueRecurring(sql: Sql, payDate = todayBerlin()): Promise<RecurringDue[]> {
  const until = `${ym(payDate)}-01`;
  const [list, paid] = await Promise.all([
    sql<RecurringPayment[]>`
      select id, name, payee, iban, purpose, amount_cents, cycle, due_day, start_month::text, end_month::text,
             method, category, note, active, version
        from app.recurring_payments where active and start_month <= ${until}::date`,
    sql<{ recurring_id: string; period: string }[]>`
      select recurring_id, period::text from app.recurring_payment_items`,
  ]);
  const done = new Set(paid.map((p) => `${p.recurring_id}|${p.period}`));
  const out: RecurringDue[] = [];
  for (const p of list)
    for (const period of periodsOf(p, until))
      if (!done.has(`${p.id}|${period}`))
        out.push({ payment: p, period, due_date: dueDateOf(period, p.due_day), bank: null });
  if (out.length) {
    const from = addDays(
      out.reduce((a, d) => (d.due_date < a ? d.due_date : a), out[0]!.due_date),
      -20,
    );
    const tx = await sql<
      {
        booking_date: string;
        amount_cents: bigint;
        counterparty_iban: string | null;
        counterparty_name: string | null;
      }[]
    >`select booking_date::text, amount_cents, counterparty_iban, counterparty_name from app.bank_transactions
       where amount_cents < 0 and booking_date >= ${from}::date`;
    const used = new Set<number>();
    for (const d of out.sort((a, b) => a.due_date.localeCompare(b.due_date))) {
      const p = d.payment;
      const word =
        p.payee
          .toLowerCase()
          .split(/\s+/)
          .find((w) => w.length >= 4) ?? '';
      const lo = addDays(d.due_date, -20);
      const hi = addDays(d.due_date, 20);
      const i = tx.findIndex((t, k) => {
        if (used.has(k) || t.booking_date < lo || t.booking_date > hi) return false;
        const ibanOk = !!p.iban && t.counterparty_iban?.replace(/\s/g, '').toUpperCase() === p.iban;
        const nameOk = !!word && (t.counterparty_name ?? '').toLowerCase().includes(word);
        if (p.amount_cents !== null) return -t.amount_cents === p.amount_cents && (ibanOk || nameOk);
        return ibanOk;
      });
      if (i >= 0) {
        used.add(i);
        d.bank = { date: tx[i]!.booking_date, amount_cents: -tx[i]!.amount_cents };
      }
    }
  }
  return out.sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || a.payment.name.localeCompare(b.payment.name),
  );
}

/** Als bezahlt festhalten: Schlüssel „<id>|<JJJJ-MM-01>“, Betrag je Schlüssel (bei wechselndem Betrag Pflicht). */
export async function markRecurringPaid(
  sql: Sql,
  p: { items: { key: string; amount_cents: bigint | null }[]; date: string; note: string | null },
  actor: string,
) {
  if (!p.items.length) throw new BusinessError('Bitte mindestens eine Zahlung auswählen');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Bitte Zahlungsdatum angeben');
  if (p.date > todayBerlin()) throw new BusinessError('Zahlungsdatum liegt in der Zukunft');
  let n = 0;
  await sql.begin(async (tx) => {
    for (const it of p.items) {
      const m = /^([0-9a-f-]{36})\|(\d{4}-\d{2}-01)$/.exec(it.key);
      if (!m) throw new BusinessError('Auswahl ungültig – bitte Seite neu laden');
      const [r] = await tx<RecurringPayment[]>`
        select id, name, amount_cents, cycle, start_month::text, end_month::text, method
          from app.recurring_payments where id = ${m[1]!}`;
      if (!r) throw new BusinessError('Zahlung nicht gefunden');
      if (!periodsOf(r, m[2]!).includes(m[2]!))
        throw new BusinessError(`${r.name}: in diesem Monat nicht fällig`);
      const amount = it.amount_cents ?? r.amount_cents;
      if (amount === null || amount <= 0n)
        throw new BusinessError(`${r.name}: bitte den gezahlten Betrag eintragen (Betrag wechselt)`);
      const res = await tx`
        insert into app.recurring_payment_items (id, recurring_id, period, amount_cents, paid_at, method, note, paid_by)
        values (gen_random_uuid(), ${r.id}, ${m[2]!}, ${amount}, ${p.date}, ${r.method}, ${p.note?.trim() || null}, ${actor})
        on conflict (recurring_id, period) do nothing returning id`;
      if (!res.length) continue;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'paid', 'recurring_payment', ${r.id},
                       ${tx.json({ period: m[2]!, amount: String(amount), date: p.date })})`;
      n++;
    }
  });
  return n;
}

export async function recentRecurringPaid(sql: Sql, sinceDays = 60) {
  return sql<
    {
      id: string;
      recurring_id: string;
      name: string;
      payee: string;
      period: string;
      amount_cents: bigint;
      paid_at: string;
      paid_by: string;
    }[]
  >`select i.id, i.recurring_id, r.name, r.payee, i.period::text, i.amount_cents, i.paid_at::text, i.paid_by
      from app.recurring_payment_items i join app.recurring_payments r on r.id = i.recurring_id
     where i.paid_at >= ${addDays(todayBerlin(), -sinceDays)}::date
     order by i.paid_at desc, r.name limit 50`;
}

/** Versehentlich festgehalten → wieder offen (Stand im Protokoll). */
export async function undoRecurringPaid(sql: Sql, itemId: string, actor: string) {
  await sql.begin(async (tx) => {
    const [old] = await tx<{ recurring_id: string; period: string; amount_cents: bigint; paid_at: string }[]>`
      delete from app.recurring_payment_items where id = ${itemId}
      returning recurring_id, period::text, amount_cents, paid_at::text`;
    if (!old) throw new BusinessError('Zahlung nicht gefunden');
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'paid_undo', 'recurring_payment', ${old.recurring_id},
                     ${tx.json({ period: old.period, amount: String(old.amount_cents), date: old.paid_at })})`;
  });
}

/** Verwendungszweck mit Platzhaltern {monat} (10/2026), {quartal} (Q4/2026), {jahr} (2026), {vormonat}, {vorquartal}. */
export function purposeFor(purpose: string | null, period: string): string {
  if (!purpose) return '';
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const prev = addMonths(period, -1);
  const q = Math.ceil(m / 3);
  const pq = q === 1 ? `Q4/${y - 1}` : `Q${q - 1}/${y}`;
  return purpose
    .replace(/\{monat\}/gi, `${String(m).padStart(2, '0')}/${y}`)
    .replace(/\{vormonat\}/gi, `${prev.slice(5, 7)}/${prev.slice(0, 4)}`)
    .replace(/\{quartal\}/gi, `Q${q}/${y}`)
    .replace(/\{vorquartal\}/gi, pq)
    .replace(/\{jahr\}/gi, String(y));
}
