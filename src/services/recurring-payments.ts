import type { Sql, Tx } from '../db/client.js';
import { addDays, monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { EXPENSE_CATEGORY, quickSupplier } from './bank.js';
import { BusinessError } from './errors.js';
import { validIbanFormat } from './purchasing.js';

/**
 * Wiederkehrende Zahlungen (Ahmed 26.10.): Finanzamt, Miete, BG BAU, Versicherungen … Sie stehen im Fälligkeitsmonat
 * in der Zahlungsliste (zwischen den Rechnungen, auch in der SEPA-Datei), bis sie bezahlt sind (überfällige bleiben
 * stehen). Empfänger = Lieferant (auch Finanzamt, Krankenkasse, Vermieter). Kosten mit Kostenstelle (z. B. Miete →
 * 9000 Verwaltung) zählen netto in der Nachkalkulation; Steuern und Sozialabgaben ohne Kostenstelle (sind keine
 * Kosten bzw. stecken schon im Lohnzuschlag). Nicht im DATEV-Export – gebucht wird über den Kontoauszug.
 */

/** Vorschlag Kostenstelle je Kostenart: Büro-Kosten auf 9000, Fahrzeuge 9100; Steuern/Personal/Privat keine. */
export const CC_VERWALTUNG = '00000000-0000-4000-8000-0000000cc001';
export const CC_FAHRZEUGE = '00000000-0000-4000-8000-0000000cc002';
export function defaultCostCenter(category: string | null): string | null {
  if (!category) return CC_VERWALTUNG;
  if (category === 'fahrzeuge') return CC_FAHRZEUGE;
  if (['steuern', 'personal', 'privat', 'nachunternehmer'].includes(category)) return null;
  return CC_VERWALTUNG;
}

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

export type RecurringApplies = 'laufend' | 'vorher';
export const RECURRING_APPLIES: Record<RecurringApplies, string> = {
  laufend: 'laufenden Zeitraum (im Voraus) – z. B. Miete 01.09. für September, Gewerbesteuer 15.05. für Q2',
  vorher: 'vorherigen Zeitraum (nachträglich) – z. B. 10.10. für September',
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
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_bic: string | null;
  cost_center_id: string | null;
  cost_center_name: string | null;
  vat_rate_bp: number;
  applies_to: RecurringApplies;
}

const COLS = (sql: Sql | Tx) => sql`
  r.id, r.name, r.payee, coalesce(r.iban, s.iban) as iban, r.purpose, r.amount_cents, r.cycle, r.due_day,
  r.start_month::text, r.end_month::text, r.method, r.category, r.note, r.active, r.version, r.supplier_id,
  s.name as supplier_name, s.bic as supplier_bic, r.cost_center_id, cc.number || ' ' || cc.name as cost_center_name,
  r.vat_rate_bp, r.applies_to`;
const FROM = (sql: Sql | Tx) => sql`
  app.recurring_payments r left join app.suppliers s on s.id = r.supplier_id
  left join app.cost_centers cc on cc.id = r.cost_center_id`;

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

/**
 * Zeitraum, für den eine Zahlung gilt: Kalender-Monat/-Quartal/-Halbjahr/-Jahr, in dem sie fällig ist (laufend)
 * bzw. der davor (vorher). Gewerbesteuer-Vorauszahlung 15.05. → Q2, Miete 01.09. → September.
 */
export function coveredPeriod(
  p: Pick<RecurringPayment, 'cycle' | 'applies_to'>,
  period: string,
): { start: string; months: number; label: string } {
  const step = STEP[p.cycle];
  const y0 = Number(period.slice(0, 4));
  const m0 = Number(period.slice(5, 7)) - 1;
  let start = `${y0}-${String(Math.floor(m0 / step) * step + 1).padStart(2, '0')}-01`;
  if (p.applies_to === 'vorher') start = addMonths(start, -step);
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  const label =
    step === 1
      ? `${start.slice(5, 7)}/${y}`
      : step === 3
        ? `Q${Math.ceil(m / 3)}/${y}`
        : step === 6
          ? `${m === 1 ? 1 : 2}. Halbjahr ${y}`
          : String(y);
  return { start, months: step, label };
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
  return sql<RecurringPayment[]>`select ${COLS(sql)} from ${FROM(sql)} order by r.active desc, r.name`;
}

export async function getRecurring(sql: Sql, id: string) {
  const [r] = await sql<RecurringPayment[]>`select ${COLS(sql)} from ${FROM(sql)} where r.id = ${id}`;
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
  /** vorhandener Lieferant; leer = Empfänger als Lieferant anlegen (bzw. gleichnamigen nehmen) */
  supplier_id: string | null;
  cost_center_id: string | null;
  vat_rate_bp: number;
  applies_to?: string;
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
  const applies = input.applies_to ?? 'laufend';
  if (!(applies in RECURRING_APPLIES))
    throw new BusinessError('Bitte wählen, für welchen Zeitraum die Zahlung gilt');
  if (![0, 700, 1900].includes(input.vat_rate_bp)) throw new BusinessError('USt-Satz 0, 7 oder 19 %');
  if (input.cost_center_id) {
    const [cc] = await sql`select 1 from app.cost_centers where id = ${input.cost_center_id}`;
    if (!cc) throw new BusinessError('Kostenstelle unbekannt');
  }
  // Empfänger als Lieferant (Ahmed 26.10.) – Finanzamt, Krankenkasse, Vermieter … stehen dann in der Lieferantenliste,
  // der Kontoabgleich erkennt sie über die IBAN.
  let supplierId = input.supplier_id;
  if (supplierId) {
    const [s0] = await sql`select 1 from app.suppliers where id = ${supplierId}`;
    if (!s0) throw new BusinessError('Lieferant nicht gefunden');
  } else {
    supplierId = await quickSupplier(sql, payee, null, actor);
  }
  if (iban) await sql`update app.suppliers set iban = ${iban} where id = ${supplierId} and iban is null`;
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
    supplier_id: supplierId,
    cost_center_id: input.cost_center_id || null,
    vat_rate_bp: input.vat_rate_bp,
    applies_to: applies,
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
      select ${COLS(sql)} from ${FROM(sql)} where r.active and r.start_month <= ${until}::date`,
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
    const [run] = await tx`select 1 from app.payment_run_recurring where item_id = ${itemId}`;
    if (run) throw new BusinessError('In einer SEPA-Datei enthalten – nicht zurücknehmbar');
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
export function purposeFor(purpose: string | null, period: string, zeitraum?: string): string {
  if (!purpose) return '';
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  // ohne Platzhalter (Normalfall seit 26.10.): Zeitraum automatisch anhängen
  if (!purpose.includes('{')) return zeitraum ? `${purpose} ${zeitraum}` : purpose;
  const prev = addMonths(period, -1);
  const q = Math.ceil(m / 3);
  const pq = q === 1 ? `Q4/${y - 1}` : `Q${q - 1}/${y}`;
  return purpose
    .replace(/\{monat\}/gi, `${String(m).padStart(2, '0')}/${y}`)
    .replace(/\{vormonat\}/gi, `${prev.slice(5, 7)}/${prev.slice(0, 4)}`)
    .replace(/\{quartal\}/gi, `Q${q}/${y}`)
    .replace(/\{vorquartal\}/gi, pq)
    .replace(/\{jahr\}/gi, String(y))
    .replace(/\{zeitraum\}/gi, zeitraum ?? `${String(m).padStart(2, '0')}/${y}`);
}

/** Verwendungszweck einer Fälligkeit: fester Teil (z. B. Steuernummer) + Zeitraum, ohne festen Teil Bezeichnung + Zeitraum. */
export function remittanceFor(
  p: Pick<RecurringPayment, 'name' | 'purpose' | 'cycle' | 'applies_to'>,
  period: string,
): string {
  const label = coveredPeriod(p, period).label;
  return purposeFor(p.purpose, period, label) || `${p.name} ${label}`;
}

const parseKey = (key: string) => {
  const m = /^([0-9a-f-]{36})\|(\d{4}-\d{2}-01)$/.exec(key);
  if (!m) throw new BusinessError('Auswahl ungültig – bitte Seite neu laden');
  return { id: m[1]!, period: m[2]! };
};

/**
 * Wiederkehrende Zahlungen in einen SEPA-Zahlungslauf aufnehmen (in der Transaktion des Laufs): je Fälligkeit wird sie
 * als bezahlt festgehalten (Datum = Ausführungstag) und mit Empfänger/IBAN/Zweck in `payment_run_recurring` abgelegt.
 */
export async function addRecurringToRun(
  tx: Tx,
  runId: string,
  items: { key: string; amount_cents: bigint | null }[],
  executionDate: string,
  actor: string,
) {
  const out: { amount: bigint; name: string; iban: string; bic: string | null; remittance: string }[] = [];
  for (const it of items) {
    const k = parseKey(it.key);
    const [r] = await tx<RecurringPayment[]>`select ${COLS(tx)} from ${FROM(tx)} where r.id = ${k.id}`;
    if (!r) throw new BusinessError('Zahlung nicht gefunden');
    if (!periodsOf(r, k.period).includes(k.period))
      throw new BusinessError(`${r.name}: in diesem Monat nicht fällig`);
    const amount = it.amount_cents ?? r.amount_cents;
    if (amount === null || amount <= 0n)
      throw new BusinessError(`${r.name}: bitte den Betrag eintragen (Betrag wechselt)`);
    const iban = r.iban?.replace(/\s/g, '').toUpperCase() ?? '';
    if (!iban || !validIbanFormat(iban)) throw new BusinessError(`${r.name}: keine gültige IBAN hinterlegt`);
    const [item] = await tx<{ id: string }[]>`
      insert into app.recurring_payment_items (id, recurring_id, period, amount_cents, paid_at, method, note, paid_by)
      values (gen_random_uuid(), ${r.id}, ${k.period}, ${amount}, ${executionDate}, 'sepa', null, ${actor})
      on conflict (recurring_id, period) do nothing returning id`;
    if (!item) throw new BusinessError(`${r.name}: für diesen Monat schon bezahlt – bitte Seite neu laden`);
    const remittance = remittanceFor(r, k.period).slice(0, 140);
    const name = r.supplier_name ?? r.payee;
    await tx`insert into app.payment_run_recurring (run_id, item_id, amount_cents, creditor_name, creditor_iban, creditor_bic, remittance)
             values (${runId}, ${item.id}, ${amount}, ${name}, ${iban}, ${r.supplier_bic}, ${remittance})`;
    out.push({ amount, name, iban, bic: r.supplier_bic, remittance });
  }
  return out;
}

/**
 * Kosten der wiederkehrenden Zahlungen mit Kostenstelle für die Nachkalkulation: netto (USt herausgerechnet),
 * gleichmäßig auf die Monate des Turnus verteilt (Quartalsmiete → je Monat ein Drittel), ab dem Fälligkeitsmonat.
 * Betrag = gezahlter Betrag der Fälligkeit, sonst der feste Betrag.
 */
export async function recurringCosts(sql: Sql, from: string, to: string) {
  const [list, paid] = await Promise.all([
    sql<RecurringPayment[]>`select ${COLS(sql)} from ${FROM(sql)} where r.cost_center_id is not null`,
    sql<{ recurring_id: string; period: string; amount_cents: bigint }[]>`
      select recurring_id, period::text, amount_cents from app.recurring_payment_items`,
  ]);
  const amt = new Map(paid.map((p) => [`${p.recurring_id}|${p.period}`, p.amount_cents]));
  const out: {
    cost_center_id: string;
    category: string | null;
    month: string;
    net: bigint;
    recurring_id: string;
    name: string;
    payee: string;
  }[] = [];
  const fromM = `${from.slice(0, 7)}-01`;
  for (const r of list) {
    if (!r.active && !paid.some((p) => p.recurring_id === r.id)) continue;
    const step = STEP[r.cycle];
    for (const period of periodsOf(r, `${to.slice(0, 7)}-01`)) {
      // Kosten auf die Monate des Zeitraums, für den gezahlt wird (Miete Q4 am 01.10. → Okt–Dez)
      const cover = coveredPeriod(r, period).start;
      if (addMonths(cover, step) <= fromM) continue;
      const gross = amt.get(`${r.id}|${period}`) ?? (r.active ? r.amount_cents : null);
      if (gross === null) continue;
      // netto = brutto ÷ (1 + USt), kaufmännisch gerundet; Verteilung centgenau (Rest auf die ersten Monate)
      const net =
        (gross * 10000n * 2n + BigInt(10000 + r.vat_rate_bp)) / (BigInt(10000 + r.vat_rate_bp) * 2n);
      const base = net / BigInt(step);
      let rest = net - base * BigInt(step);
      for (let i = 0; i < step; i++) {
        const m = addMonths(cover, i);
        const share = base + (rest > 0n ? 1n : 0n);
        if (rest > 0n) rest--;
        if (m >= fromM && m <= to && share !== 0n)
          out.push({
            cost_center_id: r.cost_center_id!,
            category: r.category,
            month: m,
            net: share,
            recurring_id: r.id,
            name: r.name,
            payee: r.supplier_name ?? r.payee,
          });
      }
    }
  }
  return out;
}
