import type { Sql } from '../db/client.js';
import { divRoundHalfUp } from '../domain/money/money.js';
import { BusinessError } from './errors.js';

/*
 * DATEV-Buchungsstapel (Format „EXTF“, Version 700, Kategorie 21) für den Steuerberater.
 *
 * Inhalt (wählbar): Ausgangsrechnungen inkl. Storno/Korrektur, Zahlungseingänge, Eingangsrechnungen,
 * Zahlungsausgänge aus Zahlungsläufen. Debitor = Kundennummer (5-stellig ab 20000), Kreditor = Lieferantennummer
 * (ab 70001). Nicht festgeschrieben – der Steuerberater prüft und schreibt fest.
 *
 * Vorläufig, vor dem Echtbetrieb mit dem Steuerberater testen: Kontenrahmen/Konten, BU-Schlüssel für § 13b,
 * Behandlung von Schlussrechnungen mit Abschlägen und Skonto.
 */

export interface AccountingSettings {
  datev_consultant_no: string | null;
  datev_client_no: string | null;
  chart: 'SKR03' | 'SKR04';
  fiscal_year_start: string;
  account_length: number;
  revenue_19: string;
  revenue_7: string;
  bank_account: string;
  expense_material: string;
  expense_subcontractor: string;
  expense_other: string;
  rc_tax_key: string;
  labor_overhead_bp: number;
  overhead_minijob_bp: number;
  overhead_parttime_bp: number;
  overhead_fulltime_bp: number;
  target_margin_bp: number;
}

export async function getAccountingSettings(sql: Sql): Promise<AccountingSettings> {
  const [s] = await sql<AccountingSettings[]>`select * from app.accounting_settings`;
  return s!;
}

export async function saveAccountingSettings(sql: Sql, s: Omit<AccountingSettings, never>, actor: string) {
  const acct = (v: string, label: string) => {
    if (!/^\d{4,8}$/.test(v)) throw new BusinessError(`${label}: Kontonummer mit 4–8 Ziffern`);
    return v;
  };
  if (s.datev_consultant_no && !/^\d{4,7}$/.test(s.datev_consultant_no))
    throw new BusinessError('Beraternummer: 4–7 Ziffern');
  if (s.datev_client_no && !/^\d{1,5}$/.test(s.datev_client_no))
    throw new BusinessError('Mandantennummer: 1–5 Ziffern');
  if (!/^\d{2}-\d{2}$/.test(s.fiscal_year_start)) throw new BusinessError('Wirtschaftsjahr-Beginn als MM-TT');
  await sql`update app.accounting_settings set
    datev_consultant_no = ${s.datev_consultant_no}, datev_client_no = ${s.datev_client_no}, chart = ${s.chart},
    fiscal_year_start = ${s.fiscal_year_start}, account_length = ${s.account_length},
    revenue_19 = ${acct(s.revenue_19, 'Erlöse 19 %')}, revenue_7 = ${acct(s.revenue_7, 'Erlöse 7 %')},
    bank_account = ${acct(s.bank_account, 'Bank')}, expense_material = ${acct(s.expense_material, 'Material')},
    expense_subcontractor = ${acct(s.expense_subcontractor, 'Fremdleistungen')}, expense_other = ${acct(s.expense_other, 'Sonstige Kosten')},
    rc_tax_key = ${s.rc_tax_key}, overhead_minijob_bp = ${s.overhead_minijob_bp}, overhead_parttime_bp = ${s.overhead_parttime_bp},
    overhead_fulltime_bp = ${s.overhead_fulltime_bp}, target_margin_bp = ${s.target_margin_bp}`;
  await sql`insert into app.audit_log (actor, action, entity) values (${actor}, 'save', 'accounting_settings')`;
}

export interface Booking {
  amount: bigint; // immer positiv
  sh: 'S' | 'H';
  account: string;
  contra: string;
  taxKey: string;
  date: string; // YYYY-MM-DD
  doc: string; // Belegfeld 1
  doc2: string;
  text: string;
  kind: 'ausgang' | 'zahlungseingang' | 'eingang' | 'zahlungsausgang';
}

/** Windows-1252 (DATEV-Standard für EXTF). Zeichen außerhalb werden ersetzt. */
export function encodeCp1252(s: string): Uint8Array {
  const special: Record<string, number> = {
    '€': 0x80,
    '‚': 0x82,
    ƒ: 0x83,
    '„': 0x84,
    '…': 0x85,
    '†': 0x86,
    '‡': 0x87,
    ˆ: 0x88,
    '‰': 0x89,
    Š: 0x8a,
    '‹': 0x8b,
    Œ: 0x8c,
    Ž: 0x8e,
    '‘': 0x91,
    '’': 0x92,
    '“': 0x93,
    '”': 0x94,
    '•': 0x95,
    '–': 0x96,
    '—': 0x97,
    '˜': 0x98,
    '™': 0x99,
    š: 0x9a,
    '›': 0x9b,
    œ: 0x9c,
    ž: 0x9e,
    Ÿ: 0x9f,
  };
  const out = new Uint8Array(s.length);
  let i = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out[i++] = special[ch] ?? (c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : 0x3f);
  }
  return out.slice(0, i);
}

const dm = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}`;
const num = (c: bigint) => {
  const a = c < 0n ? -c : c;
  return `${a / 100n},${String(a % 100n).padStart(2, '0')}`;
};
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function collectBookings(
  sql: Sql,
  f: { from: string; to: string; outgoing: boolean; incoming: boolean; payments: boolean },
): Promise<{ bookings: Booking[]; warnings: string[] }> {
  const s = await getAccountingSettings(sql);
  const bookings: Booking[] = [];
  const warnings: string[] = [];

  if (f.outgoing) {
    const inv = await sql<
      {
        id: string;
        number: string;
        kind: string;
        issue_date: string;
        customer_no: string;
        name: string;
        original_number: string | null;
      }[]
    >`
      select i.id, i.number, i.kind::text, i.issue_date, c.customer_no, c.name, o.number as original_number
        from app.invoices i join app.customers c on c.id = i.customer_id left join app.invoices o on o.id = i.original_invoice_id
       where i.status = 'issued' and i.issue_date between ${f.from} and ${f.to} order by i.number`;
    const lines = inv.length
      ? await sql<{ invoice_id: string; vat_rate_bp: number; net: bigint }[]>`
          select invoice_id, vat_rate_bp, sum(net_cents)::bigint as net from app.invoice_lines
           where invoice_id in ${sql(inv.map((i) => i.id))} group by invoice_id, vat_rate_bp`
      : [];
    for (const i of inv) {
      if (i.kind === 'final')
        warnings.push(
          `Schlussrechnung ${i.number}: Verrechnung der Abschläge (Anzahlungen) bitte beim Steuerberater prüfen.`,
        );
      for (const l of lines.filter((x) => x.invoice_id === i.id)) {
        const vat = divRoundHalfUp(l.net * BigInt(l.vat_rate_bp), 10000n);
        const gross = l.net + vat;
        if (gross === 0n) continue;
        const contra = l.vat_rate_bp === 1900 ? s.revenue_19 : l.vat_rate_bp === 700 ? s.revenue_7 : null;
        if (!contra) {
          warnings.push(
            `Rechnung ${i.number}: Steuersatz ${l.vat_rate_bp / 100} % ohne Erlöskonto – nicht exportiert.`,
          );
          continue;
        }
        bookings.push({
          amount: gross < 0n ? -gross : gross,
          sh: gross < 0n ? 'H' : 'S',
          account: i.customer_no,
          contra,
          taxKey: '',
          date: i.issue_date,
          doc: i.number,
          doc2: i.original_number ?? '',
          text: `${i.kind === 'cancellation' ? 'Storno ' : i.kind === 'correction' ? 'Korrektur ' : ''}${i.name}`.slice(
            0,
            60,
          ),
          kind: 'ausgang',
        });
      }
    }
  }

  if (f.payments) {
    const pays = await sql<
      {
        amount_cents: bigint;
        paid_on: string;
        method: string;
        number: string;
        customer_no: string;
        name: string;
      }[]
    >`
      select p.amount_cents, p.paid_on, p.method::text, i.number, c.customer_no, c.name
        from app.payments p join app.invoices i on i.id = p.invoice_id join app.customers c on c.id = i.customer_id
       where p.paid_on between ${f.from} and ${f.to} order by p.paid_on`;
    for (const p of pays) {
      if (p.method === 'skonto' || p.method === 'verrechnung') {
        warnings.push(
          `${p.method === 'skonto' ? 'Skonto-Abzug' : 'Verrechnung'} ${p.number} (${num(p.amount_cents)} €): bitte manuell buchen (USt-Korrektur § 17 UStG).`,
        );
        continue;
      }
      bookings.push({
        amount: p.amount_cents < 0n ? -p.amount_cents : p.amount_cents,
        sh: p.amount_cents < 0n ? 'H' : 'S',
        account: s.bank_account,
        contra: p.customer_no,
        taxKey: '',
        date: p.paid_on,
        doc: p.number,
        doc2: '',
        text: `Zahlung ${p.name}`.slice(0, 60),
        kind: 'zahlungseingang',
      });
    }
  }

  if (f.incoming) {
    const inc = await sql<
      {
        invoice_no: string;
        invoice_date: string;
        net_cents: bigint;
        vat_cents: bigint;
        gross_cents: bigint;
        reverse_charge: boolean;
        category: string;
        supplier_no: string;
        name: string;
        status: string;
      }[]
    >`
      select i.invoice_no, i.invoice_date, i.net_cents, i.vat_cents, i.gross_cents, i.reverse_charge, i.category::text, s.supplier_no, s.name, i.status::text
        from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
       where i.status in ('freigegeben', 'bezahlt') and i.invoice_date between ${f.from} and ${f.to} order by i.invoice_date`;
    for (const i of inc) {
      const contra =
        i.category === 'material'
          ? s.expense_material
          : i.category === 'nachunternehmer'
            ? s.expense_subcontractor
            : s.expense_other;
      let taxKey = '';
      if (i.reverse_charge) {
        taxKey = s.rc_tax_key;
        warnings.push(
          `§ 13b ${i.name} ${i.invoice_no}: BU-Schlüssel ${s.rc_tax_key} – mit Steuerberater abstimmen.`,
        );
      } else if (i.vat_cents !== 0n) {
        const r = Number(i.vat_cents) / Number(i.net_cents);
        if (Math.abs(r - 0.19) < 0.002) taxKey = '9';
        else if (Math.abs(r - 0.07) < 0.002) taxKey = '8';
        else
          warnings.push(
            `Eingangsrechnung ${i.name} ${i.invoice_no}: gemischte Steuersätze – bitte aufteilen.`,
          );
      }
      bookings.push({
        amount: i.gross_cents < 0n ? -i.gross_cents : i.gross_cents,
        sh: i.gross_cents < 0n ? 'S' : 'H',
        account: i.supplier_no,
        contra,
        taxKey,
        date: i.invoice_date,
        doc: i.invoice_no.slice(0, 36),
        doc2: '',
        text: i.name.slice(0, 60),
        kind: 'eingang',
      });
    }
    const outPay = await sql<
      {
        amount_cents: bigint;
        skonto_cents: bigint;
        execution_date: string;
        invoice_no: string;
        supplier_no: string;
        name: string;
        run: string;
      }[]
    >`
      select it.amount_cents, it.skonto_cents, r.execution_date, i.invoice_no, s.supplier_no, s.name, r.number as run
        from app.payment_run_items it join app.payment_runs r on r.id = it.run_id
        join app.incoming_invoices i on i.id = it.incoming_invoice_id join app.suppliers s on s.id = i.supplier_id
       where r.execution_date between ${f.from} and ${f.to}
      union all
      select i.paid_amount_cents, i.paid_skonto_cents, i.paid_at, i.invoice_no, s.supplier_no, s.name, 'Zahlungsliste'
        from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
       where i.status = 'bezahlt' and i.paid_amount_cents is not null and i.paid_at between ${f.from} and ${f.to}
         and not exists (select 1 from app.payment_run_items it where it.incoming_invoice_id = i.id)`;
    // Vorschüsse an Nachunternehmer: Zahlung auf den Kreditor; die spätere Rechnung wird nur noch mit dem Rest bezahlt
    const adv = await sql<
      {
        amount_cents: bigint;
        paid_on: string;
        method: string;
        supplier_no: string;
        name: string;
        purpose: string | null;
      }[]
    >`select a.amount_cents, a.paid_on::text as paid_on, a.method, s.supplier_no, s.name, a.purpose
        from app.subcontractor_advances a join app.suppliers s on s.id = a.supplier_id
       where a.paid_on between ${f.from} and ${f.to}`;
    for (const a of adv) {
      if (a.method === 'bar')
        warnings.push(
          `Vorschuss ${num(a.amount_cents)} € an ${a.name} bar gezahlt: Gegenkonto Kasse statt Bank prüfen.`,
        );
      bookings.push({
        amount: a.amount_cents,
        sh: 'H',
        account: s.bank_account,
        contra: a.supplier_no,
        taxKey: '',
        date: a.paid_on,
        doc: 'Vorschuss',
        doc2: '',
        text: `Vorschuss ${a.name}`.slice(0, 60),
        kind: 'zahlungsausgang',
      });
    }
    if (adv.length)
      warnings.push(
        'Vorschüsse an Nachunternehmer sind als Zahlung auf den Kreditor gebucht. Bei § 13b-Leistungen entsteht die Steuer schon mit der Zahlung (§ 13b Abs. 4 S. 2 UStG) – mit dem Steuerberater klären.',
      );
    for (const p of outPay) {
      if (p.amount_cents === 0n) continue; // vollständig mit Vorschuss verrechnet
      if (p.skonto_cents > 0n)
        warnings.push(
          `Skonto ${num(p.skonto_cents)} € auf ${p.name} ${p.invoice_no}: bitte manuell buchen (Vorsteuerkorrektur).`,
        );
      bookings.push({
        amount: p.amount_cents,
        sh: 'H',
        account: s.bank_account,
        contra: p.supplier_no,
        taxKey: '',
        date: p.execution_date,
        doc: p.invoice_no.slice(0, 36),
        doc2: p.run,
        text: `Zahlung ${p.name}`.slice(0, 60),
        kind: 'zahlungsausgang',
      });
    }
  }
  return { bookings, warnings };
}

export function buildExtf(
  s: AccountingSettings,
  f: { from: string; to: string },
  bookings: Booking[],
  now = new Date(),
): string {
  if (!s.datev_consultant_no || !s.datev_client_no)
    throw new BusinessError('Bitte Berater- und Mandantennummer in den DATEV-Einstellungen eintragen');
  if (f.from.slice(0, 4) !== f.to.slice(0, 4))
    throw new BusinessError('Ein Buchungsstapel darf nur ein Wirtschaftsjahr umfassen');
  const fyStart = `${f.from.slice(0, 4)}${s.fiscal_year_start.replace('-', '')}`;
  const ts = now
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 17);
  const header = [
    q('EXTF'),
    '700',
    '21',
    q('Buchungsstapel'),
    '13',
    ts,
    '',
    q('RE'),
    q(''),
    q(''),
    s.datev_consultant_no,
    s.datev_client_no,
    fyStart,
    String(s.account_length),
    f.from.replace(/-/g, ''),
    f.to.replace(/-/g, ''),
    q(`Viva-Deluxe ${f.from}–${f.to}`),
    q(''),
    '1',
    '0',
    '0',
    q('EUR'),
    '',
    q(''),
    '',
    '',
    q(''),
    '',
    '',
    q(''),
    q(''),
  ].join(';');
  const cols = [
    'Umsatz (ohne Soll/Haben-Kz)',
    'Soll/Haben-Kennzeichen',
    'WKZ Umsatz',
    'Kurs',
    'Basis-Umsatz',
    'WKZ Basis-Umsatz',
    'Konto',
    'Gegenkonto (ohne BU-Schlüssel)',
    'BU-Schlüssel',
    'Belegdatum',
    'Belegfeld 1',
    'Belegfeld 2',
    'Skonto',
    'Buchungstext',
  ].join(';');
  const rows = bookings.map((b) =>
    [
      num(b.amount),
      q(b.sh),
      q('EUR'),
      '',
      '',
      q(''),
      b.account,
      b.contra,
      q(b.taxKey),
      dm(b.date),
      q(b.doc),
      q(b.doc2),
      '',
      q(b.text),
    ].join(';'),
  );
  return [header, cols, ...rows].join('\r\n') + '\r\n';
}
