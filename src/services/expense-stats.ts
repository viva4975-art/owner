import type { Sql } from '../db/client.js';
import { EXPENSE_CATEGORY } from './bank.js';
import type { StatGroup } from './statistics.js';

/*
 * Ausgaben-Statistik (Ahmed 08.10.: „Ausgaben analysieren, Diagramme wie bei der Rechnungs-Statistik“).
 * Grundlage „Konto“: alle Kontoausgänge (brutto, nach Buchungstag) – Kostenart aus der zugeordneten Eingangsrechnung,
 * sonst aus der Zuordnung (Kostenart, Mitarbeiter = Personal, Zahlungslauf), sonst „noch nicht zugeordnet“.
 * Grundlage „Eingangsrechnungen“: netto nach Rechnungsdatum (Korrekturen mindern).
 */

export type ExpenseBasis = 'konto' | 'rechnung';

export interface ExpenseStats {
  periods: { key: string; cents: bigint }[];
  total: bigint;
  count: number;
  categories: { key: string; name: string; cents: bigint }[];
  payees: { id: string | null; name: string; cents: bigint }[];
}

const CATEGORY_NAME: Record<string, string> = {
  ...EXPENSE_CATEGORY,
  zahlungslauf: 'Eingangsrechnungen (SEPA-Zahlungslauf)',
  offen: 'nicht erkannt',
};

/** Kostenart: automatisch aus Empfänger/Verwendungszweck (Ahmed: „DEVK ist klar Versicherung“) oder nach Zuordnung. */
export type CategoryMode = 'auto' | 'zuordnung';

const KEYWORDS: [string, string[]][] = [
  [
    'versicherung',
    [
      'DEVK',
      'ALLIANZ',
      ' AXA ',
      'HUK',
      ' ERGO ',
      'GENERALI',
      ' R V ',
      'ZURICH',
      'GOTHAER',
      'SIGNAL IDUNA',
      ' VHV ',
      ' HDI ',
      ' LVM ',
      'PROVINZIAL',
      'VERSICHERUNG',
      'BARMENIA',
      'WUERTTEMBERGISCHE',
      ' ARAG ',
      'NUERNBERGER',
      'BAYERISCHE V',
    ],
  ],
  [
    'steuern',
    [
      'FINANZAMT',
      'BUNDESKASSE',
      'HAUPTZOLLAMT',
      ' ZOLL ',
      ' AOK ',
      'TECHNIKER',
      ' TK ',
      'BARMER',
      ' DAK ',
      ' IKK ',
      ' BKK ',
      'KNAPPSCHAFT',
      'MINIJOB',
      'SOKA',
      'SOZIALKASSE',
      'BERUFSGENOSSENSCHAFT',
      'BG BAU',
      'BG ETEM',
      ' BGN ',
      'KRANKENKASSE',
      'RUNDFUNK',
      ' IHK ',
      'HANDWERKSKAMMER',
      'STADTKASSE',
      'GEWERBESTEUER',
      'SOZIALVERSICHERUNG',
      'ZUSATZVERSORGUNG',
      ' VBL ',
    ],
  ],
  [
    'fahrzeuge',
    [
      ' ARAL ',
      ' SHELL ',
      ' ESSO ',
      'TOTALENERGIES',
      ' TOTAL ',
      ' JET ',
      'TANKSTELLE',
      ' OMV ',
      ' AGIP ',
      ' AVIA ',
      ' ORLEN ',
      ' STAR ',
      'AUTOHAUS',
      ' KFZ ',
      ' ADAC ',
      ' DEKRA ',
      ' TUEV ',
      ' TÜV ',
      'LEASING',
      ' SIXT ',
      'EUROPCAR',
      'PARKHAUS',
      'PARKEN',
      ' MAUT ',
      'WERKSTATT',
      'REIFEN',
      'WASCHSTRASSE',
      'CARWASH',
      'TANKEN',
    ],
  ],
  [
    'material',
    [
      'HORNBACH',
      ' OBI ',
      'BAUHAUS',
      ' TOOM ',
      ' METRO ',
      'KAERCHER',
      'KÄRCHER',
      'HAGLEITNER',
      'BUZIL',
      'DR SCHNELL',
      ' IGEFA ',
      'REINIGUNGSBEDARF',
      'AMAZON',
      'WUERTH',
      'WÜRTH',
      'HOLCHEM',
      'ECOLAB',
      ' TANA ',
      ' KIEHL ',
      ' DM DROGERIE',
      'ROSSMANN',
      ' LIDL ',
      ' ALDI ',
      ' REWE ',
      ' EDEKA ',
      'KAUFLAND',
      ' NORMA ',
      'HYGIENE',
      'ARBEITSKLEIDUNG',
      'ENGELBERT STRAUSS',
    ],
  ],
  [
    'miete',
    [
      'MIETE',
      'VERMIETUNG',
      'STADTWERKE',
      ' SWM ',
      ' E ON ',
      'TELEKOM',
      'VODAFONE',
      ' O2 ',
      'TELEFONICA',
      ' 1 1 ',
      ' IONOS ',
      ' STROM ',
      'NEBENKOSTEN',
      ' STRATO ',
      'MICROSOFT',
      ' GOOGLE ',
      ' ADOBE ',
      'FORTYTOOLS',
      'LEXWARE',
      ' DATEV ',
      'BUEROBEDARF',
      'BÜROBEDARF',
    ],
  ],
  [
    'bank',
    [
      'KONTOFUEHRUNG',
      'KONTOFÜHRUNG',
      'ENTGELT',
      ' ZINSEN ',
      'ABSCHLUSS',
      'GEBUEHR',
      'GEBÜHR',
      'KARTENENTGELT',
    ],
  ],
  ['personal', [' LOHN ', 'GEHALT', 'VORSCHUSS', ' LOHN/', 'LOEHNE', 'LÖHNE']],
  ['nachunternehmer', ['SUBUNTERNEHMER', 'NACHUNTERNEHMER']],
];
const norm = (s: string) =>
  ` ${s
    .toUpperCase()
    .replace(/[^A-Z0-9ÄÖÜ]+/g, ' ')
    .trim()} `;
/** Kostenart aus Name und Verwendungszweck (Schlüsselwörter, bekannte Firmen). */
export function guessCategory(name: string | null, purpose: string | null): string | null {
  const who = norm(name ?? '');
  const all = norm(`${name ?? ''} ${purpose ?? ''}`);
  // zuerst der Name der Gegenseite (eindeutiger), dann der Verwendungszweck
  for (const hay of [who, all])
    for (const [cat, words] of KEYWORDS) if (words.some((w) => hay.includes(w))) return cat;
  return null;
}

export async function expenseStats(
  sql: Sql,
  f: { from: string; to: string; group: StatGroup; basis: ExpenseBasis; mode?: CategoryMode },
): Promise<ExpenseStats> {
  const mode = f.mode ?? 'auto';
  type Row = { d: string; cents: bigint; cat: string; sid: string | null; who: string };
  let rows: Row[];
  if (f.basis === 'konto') {
    const raw = await sql<
      {
        d: string;
        cents: bigint;
        name: string | null;
        purpose: string;
        chosen: string | null;
        inv_cat: string | null;
        assigned_kind: string | null;
        run: boolean;
        sid: string | null;
        sname: string | null;
        skind: string | null;
        employee: boolean;
      }[]
    >`
      select t.booking_date::text as d, (-t.amount_cents)::bigint as cents, t.counterparty_name as name, t.purpose,
             t.expense_category as chosen, ii.category::text as inv_cat, t.assigned_kind,
             coalesce(t.note like 'Zahlungslauf %', false) as run,
             s.id as sid, s.name as sname, s.kind as skind,
             (t.assigned_kind = 'mitarbeiter' or exists (
               select 1 from app.employee_private p
                where t.counterparty_iban is not null and upper(replace(coalesce(p.iban, ''), ' ', '')) = t.counterparty_iban)) as employee
        from app.bank_transactions t
        left join lateral (
          select category, supplier_id from app.incoming_invoices
           where bank_transaction_id = t.id order by gross_cents desc limit 1) ii on true
        left join lateral (
          select x.id, x.name, x.kind from app.suppliers x
           where x.id = coalesce(ii.supplier_id, case when t.assigned_kind = 'lieferant' then t.assigned_id end)
              or (t.counterparty_iban is not null and upper(replace(coalesce(x.iban, ''), ' ', '')) = t.counterparty_iban)
           order by (x.id = coalesce(ii.supplier_id, case when t.assigned_kind = 'lieferant' then t.assigned_id end)) desc nulls last
           limit 1) s on true
       where t.amount_cents < 0 and t.booking_date between ${f.from} and ${f.to}`;
    rows = raw.map((r) => {
      const auto =
        (r.skind === 'nachunternehmer' ? 'nachunternehmer' : null) ??
        guessCategory(r.name, r.purpose) ??
        (r.employee ? 'personal' : null);
      const assigned =
        r.chosen ?? r.inv_cat ?? (r.run ? 'zahlungslauf' : null) ?? (r.employee ? 'personal' : null);
      const cat = (mode === 'auto' ? (r.chosen ?? auto ?? assigned) : (assigned ?? auto)) ?? 'offen';
      return {
        d: r.d,
        cents: r.cents,
        cat,
        sid: r.sid,
        who: r.sname ?? (r.employee ? 'Mitarbeiter (Lohn u. a.)' : r.name?.trim() || 'unbekannt'),
      };
    });
  } else {
    rows = await sql<Row[]>`
      select i.invoice_date::text as d, i.net_cents as cents, i.category::text as cat, s.id as sid, s.name as who
        from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
       where i.invoice_date between ${f.from} and ${f.to}`;
  }
  const keyOf = (m: string) =>
    f.group === 'jahr'
      ? m.slice(0, 4)
      : f.group === 'quartal'
        ? `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`
        : m;
  const keys: string[] = [];
  for (
    let d = new Date(`${f.from.slice(0, 7)}-01T12:00:00Z`);
    d.toISOString().slice(0, 7) <= f.to.slice(0, 7);
  ) {
    const k = keyOf(d.toISOString().slice(0, 7));
    if (!keys.includes(k)) keys.push(k);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const per = new Map<string, bigint>(keys.map((k) => [k, 0n]));
  const cats = new Map<string, bigint>();
  const who = new Map<string, { id: string | null; name: string; cents: bigint }>();
  let total = 0n;
  for (const r of rows) {
    const k = keyOf(r.d.slice(0, 7));
    per.set(k, (per.get(k) ?? 0n) + r.cents);
    total += r.cents;
    cats.set(r.cat, (cats.get(r.cat) ?? 0n) + r.cents);
    const wk = r.sid ?? r.who.toUpperCase();
    const w = who.get(wk) ?? { id: r.sid, name: r.who, cents: 0n };
    w.cents += r.cents;
    who.set(wk, w);
  }
  const desc = (a: { cents: bigint }, b: { cents: bigint }) =>
    b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0;
  return {
    periods: [...per.entries()].map(([key, cents]) => ({ key, cents })),
    total,
    count: rows.length,
    categories: [...cats.entries()]
      .map(([key, cents]) => ({ key, name: CATEGORY_NAME[key] ?? key, cents }))
      .filter((c) => c.cents !== 0n)
      .sort(desc),
    payees: [...who.values()].filter((w) => w.cents !== 0n).sort(desc),
  };
}

/** Kontoeingänge im Zeitraum (für „Einnahmen − Ausgaben“ auf Konto-Grundlage). */
export async function bankIncome(sql: Sql, from: string, to: string) {
  const [r] = await sql<{ cents: bigint }[]>`
    select coalesce(sum(amount_cents), 0)::bigint as cents from app.bank_transactions
     where amount_cents > 0 and booking_date between ${from} and ${to}`;
  return r!.cents;
}

/** Offene Eingangsrechnungen (noch nicht bezahlt), brutto. */
export async function openIncoming(sql: Sql) {
  const [r] = await sql<{ cents: bigint; n: number; overdue: bigint }[]>`
    select coalesce(sum(gross_cents), 0)::bigint as cents, count(*)::int as n,
           coalesce(sum(gross_cents) filter (where due_date < (now() at time zone 'Europe/Berlin')::date), 0)::bigint as overdue
      from app.incoming_invoices where status in ('erfasst', 'freigegeben')`;
  return r!;
}
