import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { countWorkDays, monthBounds } from '../domain/invoice/calc.js';
import { employerCost, isManagingDirector } from '../domain/hr/employer-cost.js';
import { type Cents, lineNet, type Quantity } from '../domain/money/money.js';
import { laborFromPayroll } from './costing-labor.js';
import { absenceStats, countDays } from './absence-stats.js';
import { revenueLines, siteCosting, SPECIAL_SITE_ID } from './costing.js';
import { BusinessError } from './errors.js';
import { getPlanCostRates, planCosting } from './plan-costing.js';
import { monthlyRevenue } from './statistics.js';
import { recurringCosts } from './recurring-payments.js';
import { siteClosureMap } from './site-closures.js';

/*
 * Budgetplanung je Jahr (Ahmed 22.11.: „jedes Objekt Umsatzberechnung, die monatlichen und die jährlichen Sachen,
 * filtern nach Objekt, Kunde, Gesamtsummen; alle Kosten planen“).
 *
 * Umsatz je Objekt und Monat:
 *   - laufende Pauschalen (monatlich; automatisch abgerechnete 2-monatlich … jährlich anteilig je Monat)
 *   - Turnus-Leistungen nach Ausführung (2-monatlich … jährlich) voll im Monat ihrer Fälligkeit
 *   - einmalige Leistungen mit Beginn im Jahr (noch nicht ausgeführt) im Monat des Beginns
 *   - Sonder-/Einzelleistungen wie im Vorjahr: Ist-Umsatz des Vorjahres über den regelmäßigen Leistungen
 *   - Preiserhöhung über den Lohnkostenanteil ab dem Monat der Tariferhöhung (wenn „weitergeben“)
 * Direkte Kosten je Objekt und Monat wie die Plan-Kalkulation: Lohn laut Einsatzplanung inkl. Arbeitgeberkosten
 * (× Tariferhöhung ab Monat), Nachunternehmer laut Bestellung, Material in % vom Umsatz.
 * Gemeinkosten je Kostenart mit Vorschlag (Objektleitung, Büro, Geschäftsführer aus der Einsatzplanung; Fahrzeuge,
 * Büro, Versicherung … aus wiederkehrenden Zahlungen und Ø Eingangsrechnungen der letzten 12 Monate), von Hand
 * änderbar, nach Umsatz auf die Objekte verteilt. Investitionen werden nicht verteilt (Liquidität, keine Kosten im
 * Sinne der Kalkulation).
 */

export type CostAuto = 'lead' | 'office' | 'gf' | 'cost' | 'none';
export const COST_CATS: { key: string; label: string; auto: CostAuto; invest?: boolean }[] = [
  { key: 'objektleitung', label: 'Objektleitung (Lohn + AG-Kosten)', auto: 'lead' },
  { key: 'buero_personal', label: 'Büromitarbeiter (Lohn + AG-Kosten)', auto: 'office' },
  { key: 'geschaeftsfuehrer', label: 'Geschäftsführer', auto: 'gf' },
  { key: 'fahrzeuge', label: 'Fahrzeuge (Leasing, Tanken, Reparatur, Versicherung)', auto: 'cost' },
  { key: 'buero', label: 'Büro & Miete (Miete, Nebenkosten, Büromaterial)', auto: 'cost' },
  { key: 'versicherung', label: 'Versicherungen', auto: 'cost' },
  { key: 'it', label: 'IT, Software & Telefon', auto: 'cost' },
  { key: 'beratung', label: 'Steuerberater, Rechtsanwalt, Beratung', auto: 'cost' },
  { key: 'werbung', label: 'Werbung & Akquise', auto: 'cost' },
  { key: 'schulung', label: 'Schulung, Arbeitsschutz, Arbeitskleidung', auto: 'cost' },
  { key: 'bank', label: 'Bank & Zinsen', auto: 'cost' },
  { key: 'sonstiges', label: 'Sonstige Gemeinkosten', auto: 'cost' },
  { key: 'investitionen', label: 'Investitionen (Fahrzeuge, Maschinen, IT)', auto: 'none', invest: true },
];
export const COST_LABEL = Object.fromEntries(COST_CATS.map((c) => [c.key, c.label])) as Record<
  string,
  string
>;

const CYCLE_MONTHS: Record<string, number> = {
  monatlich: 1,
  zweimonatlich: 2,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};
const MONTHS = Array.from({ length: 12 }, (_, i) => i);
const zero = () => MONTHS.map(() => 0n);
const mKey = (year: number, i: number) => `${year}-${String(i + 1).padStart(2, '0')}`;
const sum = (a: bigint[]) => a.reduce((x, y) => x + y, 0n);
const round = (num: bigint, den: bigint) =>
  num >= 0n ? (num * 2n + den) / (den * 2n) : -((-num * 2n + den) / (den * 2n));

/** Betrag centgenau nach Gewichten aufteilen (Rest an die größten Reste). */
export function splitBy(total: bigint, weights: bigint[]): bigint[] {
  const s = sum(weights.map((w) => (w > 0n ? w : 0n)));
  if (s === 0n || total === 0n) return weights.map(() => 0n);
  const ws = weights.map((w) => (w > 0n ? w : 0n));
  const neg = total < 0n;
  const t = neg ? -total : total;
  const base = ws.map((w) => (t * w) / s);
  let rest = t - sum(base);
  const order = ws
    .map((w, i) => ({ i, r: (t * w) % s }))
    .sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : 0));
  for (const o of order) {
    if (rest <= 0n) break;
    if (ws[o.i] === 0n) continue;
    base[o.i]! += 1n;
    rest -= 1n;
  }
  return neg ? base.map((x) => -x) : base;
}

export interface Budget {
  id: string;
  year: number;
  status: 'entwurf' | 'freigegeben';
  wage_increase_bp: number;
  wage_increase_month: number;
  pass_on: boolean;
  extra_like_prev: boolean;
  allocate: boolean;
  note: string | null;
  computing: boolean;
  compute_error: string | null;
  computed_at: string | null;
  computed_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  /** Urlaubstage je Vollzeit-Jahr (Standard 30) */
  vacation_days: number;
  /** Kranktage je Vollzeit-Jahr von Hand (null = Ø aus den Daten) */
  sick_days: number | null;
  sick_days_auto: number | null;
  sick_basis: string | null;
}

export interface BudgetCostRow {
  id: string;
  category: string;
  label: string;
  amounts: bigint[];
  suggested: bigint[] | null;
  source: string | null;
  manual: boolean;
  invest: boolean;
  sort: number;
  note: string | null;
}

export interface BudgetAdjustment {
  id: string;
  site_id: string | null;
  customer_id: string | null;
  label: string;
  from_month: number;
  to_month: number;
  revenue_month: bigint;
  cost_month: bigint;
  /** Stunden je Monat von Hand (z. B. neues Objekt ohne Einsatzplanung) × Stundensatz inkl. AG-Kosten */
  hours_month: number;
  wage_cents: bigint;
  /** Stunden ersetzen die Einsatzplanung des Objekts in diesen Monaten */
  replace_plan: boolean;
  note: string | null;
}

const BUDGET_COLS = (sql: Sql) => sql`
  id, year, status, wage_increase_bp, wage_increase_month, pass_on, extra_like_prev, allocate, note, computing,
  compute_error, computed_at::text, computed_by, approved_at::text, approved_by, vacation_days::float8 as vacation_days,
  sick_days::float8 as sick_days, sick_days_auto::float8 as sick_days_auto, sick_basis`;

export async function listBudgets(sql: Sql) {
  return sql<{ id: string; year: number; status: string; computed_at: string | null }[]>`
    select id, year, status, computed_at::text from app.budgets order by year desc`;
}

export async function getBudget(sql: Sql, year: number): Promise<Budget | null> {
  const [b] = await sql<Budget[]>`select ${BUDGET_COLS(sql)} from app.budgets where year = ${year}`;
  return b ?? null;
}

async function budgetById(sql: Sql, id: string): Promise<Budget> {
  const [b] = await sql<Budget[]>`select ${BUDGET_COLS(sql)} from app.budgets where id = ${id}`;
  if (!b) throw new BusinessError('Budget nicht gefunden');
  return b;
}

/** Budget für ein Jahr anlegen (mit allen Kostenarten), vorhandenes zurückgeben. */
export async function ensureBudget(sql: Sql, year: number, actor: string): Promise<Budget> {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new BusinessError('Jahr ungültig');
  const have = await getBudget(sql, year);
  if (have) return have;
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`insert into app.budgets (id, year, created_by) values (${id}, ${year}, ${actor})
             on conflict (year) do nothing`;
    const [b] = await tx<{ id: string }[]>`select id from app.budgets where year = ${year}`;
    if (b!.id !== id) return;
    let sort = 0;
    for (const c of COST_CATS)
      await tx`insert into app.budget_costs (id, budget_id, category, label, amounts, invest, sort)
               values (${randomUUID()}, ${id}, ${c.key}, ${c.label}, ${zero().map(String)}::bigint[], ${!!c.invest}, ${sort++})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'create', 'budget', ${id}, ${sql.json({ year })})`;
  });
  return (await getBudget(sql, year))!;
}

const assertDraft = (b: Budget) => {
  if (b.status !== 'entwurf') throw new BusinessError('Budget ist freigegeben – erst wieder öffnen');
};

export async function saveBudgetSettings(
  sql: Sql,
  id: string,
  s: {
    wage_increase_bp: number;
    wage_increase_month: number;
    pass_on: boolean;
    extra_like_prev: boolean;
    allocate: boolean;
    note: string | null;
    vacation_days?: number;
    sick_days?: number | null;
  },
  actor: string,
) {
  assertDraft(await budgetById(sql, id));
  if (s.vacation_days != null && !(s.vacation_days >= 0 && s.vacation_days <= 60))
    throw new BusinessError('Urlaubstage: 0 bis 60');
  if (s.sick_days != null && !(s.sick_days >= 0 && s.sick_days <= 100))
    throw new BusinessError('Kranktage: 0 bis 100');
  if (s.vacation_days != null)
    await sql`update app.budgets set vacation_days = ${s.vacation_days}, sick_days = ${s.sick_days ?? null}
              where id = ${id}`;
  if (!Number.isInteger(s.wage_increase_bp) || s.wage_increase_bp < 0 || s.wage_increase_bp > 5000)
    throw new BusinessError('Tariferhöhung: 0 bis 50 %');
  if (!Number.isInteger(s.wage_increase_month) || s.wage_increase_month < 1 || s.wage_increase_month > 12)
    throw new BusinessError('Monat der Tariferhöhung ungültig');
  await sql`update app.budgets set wage_increase_bp = ${s.wage_increase_bp},
              wage_increase_month = ${s.wage_increase_month}, pass_on = ${s.pass_on},
              extra_like_prev = ${s.extra_like_prev}, allocate = ${s.allocate}, note = ${s.note},
              updated_at = now() where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'save', 'budget', ${id}, ${sql.json({ ...s })})`;
}

export async function setBudgetStatus(
  sql: Sql,
  id: string,
  status: 'entwurf' | 'freigegeben',
  actor: string,
) {
  const b = await budgetById(sql, id);
  if (status === 'freigegeben') {
    if (!b.computed_at) throw new BusinessError('Bitte das Budget zuerst berechnen');
    if (b.computing) throw new BusinessError('Berechnung läuft noch');
  }
  await sql`update app.budgets set status = ${status},
              approved_at = ${status === 'freigegeben' ? sql`now()` : null},
              approved_by = ${status === 'freigegeben' ? actor : null}, updated_at = now() where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, ${status === 'freigegeben' ? 'approve' : 'reopen'}, 'budget', ${id}, ${sql.json({ year: b.year })})`;
}

// --------------------------------------------------------------------------------------------- Umsatz je Objekt

export interface SiteRevenue {
  flat: bigint[];
  cycle: bigint[];
  increase: bigint[];
  extra: bigint[];
  prev: bigint[];
}

/** Umsatz je Objekt und Monat eines Jahres aus den Leistungen (+ Vorjahr), siehe Kopfkommentar. */
export async function budgetRevenue(
  sql: Sql,
  year: number,
  opts: { wageBp: number; wageMonth: number; passOn: boolean; extra: boolean },
): Promise<Map<string, SiteRevenue>> {
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const services = await sql<
    {
      id: string;
      site_id: string;
      kind: string;
      billing_cycle: string;
      quantity_milli: bigint;
      unit_price_cents: bigint;
      unit_code: string;
      valid_from: string;
      valid_to: string | null;
      work_days: number[] | null;
      hours_per_day_milli: bigint | null;
      labor_bp: number | null;
      done_at: string | null;
      done_any: boolean;
    }[]
  >`
    select ss.id, ss.site_id, ss.kind::text as kind, ss.billing_cycle::text as billing_cycle, ss.quantity_milli,
           ss.unit_price_cents, ss.unit_code, ss.valid_from::text, ss.valid_to::text, ss.work_days,
           ss.hours_per_day_milli, coalesce(ss.labor_share_bp, st.labor_share_bp) as labor_bp,
           (select max(e.date_from)::text from app.service_executions e where e.service_id = ss.id) as done_at,
           exists (select 1 from app.service_executions e where e.service_id = ss.id) as done_any
      from app.site_services ss join app.sites s on s.id = ss.site_id join app.customers c on c.id = s.customer_id
      left join app.service_types st on st.id = ss.service_type_id
     where (ss.active or ss.ended_auto) and s.active and not c.is_internal
       and ss.valid_from <= ${yEnd} and (ss.valid_to is null or ss.valid_to >= ${yStart})`;
  const closed = await siteClosureMap(sql, [...new Set(services.map((s) => s.site_id))]);
  const out = new Map<string, SiteRevenue>();
  const row = (site: string) => {
    let r = out.get(site);
    if (!r) {
      r = { flat: zero(), cycle: zero(), increase: zero(), extra: zero(), prev: zero() };
      out.set(site, r);
    }
    return r;
  };
  const incStart = mKey(year, opts.wageMonth - 1) + '-01';
  const addInc = (r: SiteRevenue, i: number, net: bigint, sv: (typeof services)[number]) => {
    if (!opts.passOn || !opts.wageBp || !sv.labor_bp || i < opts.wageMonth - 1 || sv.valid_from >= incStart)
      return;
    r.increase[i]! += round(net * BigInt(sv.labor_bp) * BigInt(opts.wageBp), 100_000_000n);
  };
  const netOf = (sv: (typeof services)[number], start: string, end: string) => {
    const qty = sv.work_days?.length
      ? BigInt(
          countWorkDays(
            sv.valid_from > start ? sv.valid_from : start,
            sv.valid_to && sv.valid_to < end ? sv.valid_to : end,
            sv.work_days,
            closed.get(sv.site_id),
          ).days,
        ) * (sv.unit_code === 'HUR' ? BigInt(sv.hours_per_day_milli ?? 0n) : 1000n)
      : BigInt(sv.quantity_milli);
    return lineNet(qty as Quantity, BigInt(sv.unit_price_cents) as Cents);
  };
  // Objekte mit laufender (nicht einmaliger) Leistung im Jahr – nur sie bekommen „Sonderleistungen wie Vorjahr“
  // (abgeschlossene Baureinigung o. ä. mit nur einmaligen Leistungen soll nicht im Plan stehen, Ahmed 22.11.)
  const running = new Set(services.filter((s) => s.billing_cycle !== 'einmalig').map((s) => s.site_id));
  for (const sv of services) {
    const r = row(sv.site_id);
    const step = CYCLE_MONTHS[sv.billing_cycle];
    if (sv.kind === 'monthly_flat' && step) {
      // laufende Pauschale: je Monat anteilig (Rechnungsbetrag ÷ Monate des Zyklus)
      for (const i of MONTHS) {
        const { start, end } = monthBounds(mKey(year, i));
        if (sv.valid_from > end || (sv.valid_to && sv.valid_to < start)) continue;
        const share = round(netOf(sv, start, end), BigInt(step));
        r.flat[i]! += share;
        addInc(r, i, share, sv);
      }
    } else if (step && step > 1) {
      // nach Ausführung: voller Betrag im Fälligkeitsmonat (letzte Ausführung + Zyklus, sonst Beginn, dann alle n Monate)
      const base = sv.done_at ?? sv.valid_from;
      let idx = Number(base.slice(0, 4)) * 12 + Number(base.slice(5, 7)) - 1 + (sv.done_at ? step : 0);
      const yIdx = year * 12;
      while (idx < yIdx) idx += step;
      for (; idx < yIdx + 12; idx += step) {
        const i = idx - yIdx;
        const { start, end } = monthBounds(mKey(year, i));
        if (sv.valid_to && sv.valid_to < start) break;
        if (sv.valid_from > end) continue;
        const net = netOf(sv, start, end);
        r.cycle[i]! += net;
        addInc(r, i, net, sv);
      }
    } else if (sv.billing_cycle === 'einmalig' && !sv.done_any && sv.valid_from >= yStart) {
      const i = Number(sv.valid_from.slice(5, 7)) - 1;
      const { start, end } = monthBounds(mKey(year, i));
      r.cycle[i]! += netOf(sv, start, end);
    }
  }
  // Vorjahr (Ist nach Leistungszeitraum) – Vergleich und Grundlage der Sonderleistungen
  const active = new Set(
    (
      await sql<{ id: string }[]>`
        select s.id from app.sites s join app.customers c on c.id = s.customer_id
         where s.active and c.active and not c.is_internal`
    ).map((x) => x.id),
  );
  // Objekte, deren regelmäßige Leistungen vor dem Jahr geendet haben, bekommen keine „Sonderleistungen wie Vorjahr“
  // (sonst stünde der alte Vertrag als Sonderumsatz im Plan)
  const endedFlat = new Set(
    (
      await sql<{ site_id: string }[]>`
        select distinct ss.site_id from app.site_services ss
         where ss.kind = 'monthly_flat' and ss.valid_to is not null and ss.valid_to < ${yStart}
           and not exists (select 1 from app.site_services x where x.site_id = ss.site_id and x.kind = 'monthly_flat'
                             and (x.active or x.ended_auto) and (x.valid_to is null or x.valid_to >= ${yStart}))`
    ).map((x) => x.site_id),
  );
  for (const i of MONTHS) {
    const { start, end } = monthBounds(mKey(year - 1, i));
    for (const l of await revenueLines(sql, start, end)) {
      if (!l.site_id || !active.has(l.site_id) || l.site_id === SPECIAL_SITE_ID) continue;
      row(l.site_id).prev[i]! += l.net;
    }
  }
  if (opts.extra)
    for (const [site, r] of out) {
      if (!active.has(site) || endedFlat.has(site) || !running.has(site)) continue;
      const reg = MONTHS.map((i) => r.flat[i]! + r.cycle[i]!);
      const surplus = sum(r.prev) - sum(reg);
      if (surplus <= 0n) continue;
      const w = MONTHS.map((i) => (r.prev[i]! > reg[i]! ? r.prev[i]! - reg[i]! : 0n));
      r.extra = splitBy(surplus, sum(w) > 0n ? w : r.prev);
    }
  for (const [k, r] of out)
    if (![...r.flat, ...r.cycle, ...r.prev, ...r.extra].some((x) => x !== 0n)) out.delete(k);
  return out;
}

// --------------------------------------------------------------------------------------------- Gemeinkosten

function costCategoryOf(category: string | null, ccNumber: string | null, text: string): string {
  const t = text.toLowerCase();
  if (category === 'fahrzeuge' || ccNumber === '9100') return 'fahrzeuge';
  if (category === 'versicherung') return 'versicherung';
  if (category === 'bank') return 'bank';
  if (category === 'miete') return 'buero';
  if (ccNumber === '9300') return 'werbung';
  if (ccNumber === '9400') return 'schulung';
  if (/steuerber|rechtsanw|anwalt|kanzlei|beratung|notar|wirtschaftspr/.test(t)) return 'beratung';
  if (
    /telekom|vodafone|\bo2\b|telefon|mobilfunk|software|microsoft|ionos|lizenz|computer|internet|server/.test(
      t,
    )
  )
    return 'it';
  if (/versicher|allianz|devk|ergo|axa|hdi/.test(t)) return 'versicherung';
  if (/miete|nebenkosten|strom|reinigung büro/.test(t)) return 'buero';
  if (ccNumber === '9000') return 'buero';
  return 'sonstiges';
}

async function costSuggestions(sql: Sql, year: number) {
  const res = new Map<string, { amounts: bigint[]; src: string[] }>();
  const add = (cat: string, i: number, v: bigint, src: string) => {
    const e = res.get(cat) ?? { amounts: zero(), src: [] };
    e.amounts[i]! += v;
    if (!e.src.includes(src)) e.src.push(src);
    res.set(cat, e);
  };
  // wiederkehrende Zahlungen mit Kostenstelle, auf das Planjahr fortgeschrieben
  const rec = await recurringCosts(sql, `${year}-01-01`, `${year}-12-31`);
  const recIds = new Set(rec.map((r) => r.recurring_id));
  if (rec.length) {
    const ccs = await sql<{ id: string; number: string }[]>`
      select id, number from app.cost_centers where id = any(${[...new Set(rec.map((r) => r.cost_center_id))]}::uuid[])`;
    for (const r of rec) {
      if (r.category === 'material') continue;
      const cc = ccs.find((x) => x.id === r.cost_center_id)?.number ?? null;
      add(
        costCategoryOf(r.category, cc, `${r.name} ${r.payee}`),
        Number(r.month.slice(5, 7)) - 1,
        r.net,
        'wiederkehrende Zahlungen',
      );
    }
  }
  // Ø Eingangsrechnungen an allgemeinen Kostenstellen der letzten 12 vollen Monate (je Monat gleich)
  const [win] = await sql<{ from: string; to: string }[]>`
    select (date_trunc('month', (now() at time zone 'Europe/Berlin')::date) - interval '12 months')::date::text as from,
           (date_trunc('month', (now() at time zone 'Europe/Berlin')::date) - interval '1 day')::date::text as to`;
  const { from, to } = win!;
  const inc = await sql<{ category: string; number: string; text: string; net: bigint }[]>`
    select i.category::text as category, cc.number, coalesce(su.name, '') || ' ' || coalesce(i.note, '') as text,
           sum(a.net_cents)::bigint as net
      from app.incoming_cost_lines a join app.cost_centers cc on cc.id = a.cost_center_id
      join app.incoming_invoices i on i.id = a.incoming_invoice_id
      left join app.suppliers su on su.id = i.supplier_id
     where a.cost_center_id is not null and a.site_id is null
       and i.status in ('erfasst', 'freigegeben', 'bezahlt')
       and i.category::text not in ('material', 'umsatzsteuer', 'koerperschaftsteuer')
       and a.month between ${from} and ${to}
     group by 1, 2, 3`;
  const yearly = new Map<string, bigint>();
  for (const r of inc) {
    const cat = costCategoryOf(r.category, r.number, r.text);
    yearly.set(cat, (yearly.get(cat) ?? 0n) + BigInt(r.net));
  }
  const fmt = (d: string) => `${d.slice(5, 7)}/${d.slice(0, 4)}`;
  for (const [cat, total] of yearly) {
    const per = splitBy(
      total,
      MONTHS.map(() => 1n),
    );
    for (const i of MONTHS) add(cat, i, per[i]!, `Ø Eingangsrechnungen ${fmt(from)}–${fmt(to)}`);
  }
  void recIds;
  return res;
}

// --------------------------------------------------------------------------------------------- Berechnung

/** Budget neu berechnen (Entwurf): Umsatz, direkte Kosten je Objekt/Monat und Vorschläge der Gemeinkosten. */
export async function computeBudget(sql: Sql, id: string, actor: string) {
  const b = await budgetById(sql, id);
  assertDraft(b);
  const year = b.year;
  const rates = await getPlanCostRates(sql);
  const factor = (i: number) =>
    i >= b.wage_increase_month - 1 ? BigInt(10000 + b.wage_increase_bp) : 10000n;
  const inc = (v: bigint, i: number) => round(v * factor(i), 10000n);
  const revenue = await budgetRevenue(sql, year, {
    wageBp: b.wage_increase_bp,
    wageMonth: b.wage_increase_month,
    passOn: b.pass_on,
    extra: b.extra_like_prev,
  });
  const direct = new Map<string, { minutes: number[]; labor: bigint[]; sub: bigint[] }>();
  const dRow = (site: string) => {
    let r = direct.get(site);
    if (!r) {
      r = { minutes: MONTHS.map(() => 0), labor: zero(), sub: zero() };
      direct.set(site, r);
    }
    return r;
  };
  const emps = await sql<
    {
      id: string;
      employment_type: string | null;
      tags: string[] | null;
      full_name: string;
      md: string | null;
    }[]
  >`select e.id, e.employment_type::text, e.tags, e.first_name || ' ' || e.last_name as full_name,
           (select managing_director from app.company limit 1) as md from app.employees e`;
  const empMap = new Map(emps.map((e) => [e.id, e]));
  const internal = new Set(
    (
      await sql<{ id: string }[]>`
        select s.id from app.sites s join app.customers c on c.id = s.customer_id
         where c.is_internal and s.id <> ${SPECIAL_SITE_ID}`
    ).map((x) => x.id),
  );
  type PersCat = 'lead' | 'office' | 'gf';
  const persons = new Map<
    string,
    {
      cat: PersCat;
      name: string;
      personnel_no: string;
      minutes: number[];
      gross: bigint[];
      employer: bigint[];
      amounts: bigint[];
    }
  >();
  for (const i of MONTHS) {
    const month = mKey(year, i);
    const { start, end } = monthBounds(month);
    const plan = await planCosting(sql, { from: month, to: month }, { cachedLabor: true });
    for (const r of plan.rows) {
      if (r.internal) continue;
      const d = dRow(r.site_id);
      d.minutes[i]! += r.minutes;
      d.labor[i]! += inc(r.labor, i);
      d.sub[i]! += r.subcontractor;
    }
    // Personal der Gemeinkosten: Objektleitungen (überall), Büro und Geschäftsführer (interne Objekte / ohne Objekt)
    const [others, leads] = await Promise.all([
      laborFromPayroll(sql, start, end, { salaryOnly: true, cached: true }),
      laborFromPayroll(sql, start, end, { salaryOnly: true, cached: true, leads: 'only' }),
    ]);
    const all = [...others.filter((x) => !x.lead), ...leads];
    const byEmp = new Map<string, typeof all>();
    for (const x of all) byEmp.set(x.employee_id, [...(byEmp.get(x.employee_id) ?? []), x]);
    for (const [empId, parts] of byEmp) {
      const e = empMap.get(empId);
      const gross = parts.reduce((a, p) => a + p.gross, 0n);
      if (gross <= 0n) continue;
      const gf = !!e && isManagingDirector(e.tags, { name: e.full_name, managingDirector: e.md });
      const employer = gf
        ? 0n
        : employerCost(
            gross,
            e?.employment_type === 'minijob' ? 'minijob' : e?.employment_type ? 'sv' : null,
            rates,
          ).costCents;
      const isLead = parts.some((p) => p.lead);
      const own = isLead ? parts : parts.filter((p) => !p.site_id || internal.has(p.site_id));
      const g = own.reduce((a, p) => a + p.gross, 0n);
      if (g <= 0n) continue;
      const emp = round(employer * g, gross);
      const k: PersCat = isLead ? 'lead' : gf ? 'gf' : 'office';
      const pr = persons.get(empId) ?? {
        cat: k,
        name: own[0]!.name || e?.full_name || '',
        personnel_no: own[0]!.personnel_no ?? '',
        minutes: MONTHS.map(() => 0),
        gross: zero(),
        employer: zero(),
        amounts: zero(),
      };
      if (k === 'lead' || (k === 'gf' && pr.cat === 'office')) pr.cat = k;
      pr.minutes[i]! += own.reduce((a, p) => a + p.minutes, 0);
      pr.gross[i]! += inc(g, i);
      pr.employer[i]! += inc(emp, i);
      pr.amounts[i]! += inc(g + emp, i);
      persons.set(empId, pr);
    }
  }
  // Ø Kranktage je Vollzeit-Jahr aus den letzten Daten (Vorjahr des Plans, sonst davor)
  const { weekdays: planWeekdays } = countDays(`${year}-01-01`, `${year}-12-31`);
  let sickAuto: number | null = null;
  let sickBasis: string | null = null;
  for (const y of [year - 1, year - 2, year - 3]) {
    const st = await absenceStats(sql, y);
    if (!st.total.heads || !st.total.weekdays) continue;
    sickAuto = Math.round(st.total.sick_rate * planWeekdays * 10) / 10;
    const bis = st.partial ? ` bis ${st.to.slice(8, 10)}.${st.to.slice(5, 7)}.` : '';
    sickBasis =
      `Ø ${y}${bis}: Krankenquote ${(st.total.sick_rate * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` +
      ` (${st.total.heads} Personen, ${st.total.sick_per_head.toLocaleString('de-DE')} Tage je Vollzeit-Jahr)`;
    break;
  }
  const materialBp = BigInt(rates.material_bp);
  const sites = new Set([...revenue.keys(), ...direct.keys()]);
  const suggestions = await costSuggestions(sql, year);
  const pay = new Map(
    (
      await sql<{ id: string; pay: string | null }[]>`
        select id, case pay_model when 'festgehalt' then 'Festgehalt' when 'tarif' then 'Tariflohn'
                    when 'individuell' then 'Stundenlohn' else null end as pay
          from app.employees where id = any(${[...persons.keys()]}::uuid[])`
    ).map((x) => [x.id, x.pay]),
  );
  await sql.begin(async (tx) => {
    const overrides = new Map(
      (
        await tx<{ employee_id: string; category: string }[]>`
          select employee_id, category from app.budget_person_overrides where budget_id = ${id}`
      ).map((o) => [o.employee_id, o.category]),
    );
    await tx`delete from app.budget_cost_persons where budget_id = ${id}`;
    const prow = [...persons].map(([empId, p]) => ({
      budget_id: id,
      employee_id: empId,
      category: overrides.get(empId) ?? p.cat,
      auto_category: p.cat,
      name: p.name,
      personnel_no: p.personnel_no || null,
      pay: pay.get(empId) ?? null,
      minutes: p.minutes,
      gross: p.gross.map(String),
      employer: p.employer.map(String),
      amounts: p.amounts.map(String),
    }));
    for (let k = 0; k < prow.length; k += 300)
      await tx`insert into app.budget_cost_persons ${tx(prow.slice(k, k + 300))}`;
    await tx`delete from app.budget_site_months where budget_id = ${id}`;
    const rows: Record<string, unknown>[] = [];
    for (const site of sites) {
      const rv = revenue.get(site);
      const d = direct.get(site);
      for (const i of MONTHS) {
        const r = {
          revenue_flat: rv?.flat[i] ?? 0n,
          revenue_cycle: rv?.cycle[i] ?? 0n,
          revenue_extra: rv?.extra[i] ?? 0n,
          revenue_increase: rv?.increase[i] ?? 0n,
          prev_revenue: rv?.prev[i] ?? 0n,
          minutes: d?.minutes[i] ?? 0,
          labor: d?.labor[i] ?? 0n,
          subcontractor: d?.sub[i] ?? 0n,
        };
        const rev = r.revenue_flat + r.revenue_cycle + r.revenue_extra + r.revenue_increase;
        const material = rev > 0n ? round(rev * materialBp, 10000n) : 0n;
        if (!rev && !r.prev_revenue && !r.minutes && !r.labor && !r.subcontractor) continue;
        rows.push({
          budget_id: id,
          site_id: site,
          month: i + 1,
          revenue_flat: String(r.revenue_flat),
          revenue_cycle: String(r.revenue_cycle),
          revenue_extra: String(r.revenue_extra),
          revenue_increase: String(r.revenue_increase),
          prev_revenue: String(r.prev_revenue),
          minutes: r.minutes,
          labor: String(r.labor),
          subcontractor: String(r.subcontractor),
          material: String(material),
        });
      }
    }
    for (let k = 0; k < rows.length; k += 500)
      await tx`insert into app.budget_site_months ${tx(rows.slice(k, k + 500))}`;
    const costs = await tx<{ id: string; category: string; manual: boolean }[]>`
      select id, category, manual from app.budget_costs where budget_id = ${id}`;
    for (const c of costs) {
      const def = COST_CATS.find((x) => x.key === c.category);
      if (!def || def.auto === 'none') continue;
      let amounts: bigint[];
      let source: string;
      if (def.auto === 'lead' || def.auto === 'office' || def.auto === 'gf') continue;
      {
        const s = suggestions.get(def.key);
        amounts = s?.amounts ?? zero();
        source = s?.src.join(' + ') ?? 'keine Kosten in den letzten 12 Monaten';
      }
      await tx`update app.budget_costs set suggested = ${amounts.map(String)}::bigint[], source = ${source},
                 amounts = case when manual then amounts else ${amounts.map(String)}::bigint[] end, updated_at = now()
               where id = ${c.id}`;
    }
    await refreshPersonCosts(tx as unknown as Sql, id, year);
    await tx`update app.budgets set sick_days_auto = ${sickAuto}, sick_basis = ${sickBasis} where id = ${id}`;
    await tx`update app.budgets set computed_at = now(), computed_by = ${actor}, compute_error = null,
               updated_at = now() where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'compute', 'budget', ${id}, ${sql.json({ year, sites: sites.size })})`;
  });
}

/** Berechnung im Hintergrund starten (dauert je nach Anzahl Mitarbeitender einige Sekunden bis Minuten). */
export async function startBudgetCompute(sql: Sql, id: string, actor: string): Promise<Promise<void>> {
  const b = await budgetById(sql, id);
  assertDraft(b);
  const [got] = await sql<{ id: string }[]>`
    update app.budgets set computing = true, compute_error = null
     where id = ${id} and (not computing or updated_at < now() - interval '20 minutes') returning id`;
  if (!got) throw new BusinessError('Berechnung läuft bereits');
  return computeBudget(sql, id, actor)
    .catch(async (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Budget-Berechnung', msg);
      await sql`update app.budgets set compute_error = ${msg.slice(0, 500)} where id = ${id}`.catch(() => {});
    })
    .finally(() =>
      sql`update app.budgets set computing = false where id = ${id}`.catch(() => {}).then(() => {}),
    );
}

// --------------------------------------------------------------------------------------------- Gemeinkosten/Anpassungen

/** Personal-Gemeinkosten (Objektleitung, Büro, Geschäftsführer) aus den Personen neu summieren. */
async function refreshPersonCosts(sql: Sql, budgetId: string, year: number) {
  const ps = await sql<{ category: string; amounts: bigint[] }[]>`
    select category, amounts from app.budget_cost_persons where budget_id = ${budgetId}`;
  for (const cat of ['lead', 'office', 'gf'] as const) {
    const list = ps.filter((p) => p.category === cat);
    const amounts = zero();
    for (const p of list) for (const i of MONTHS) amounts[i]! += BigInt(p.amounts[i]!);
    const n = list.length;
    const source = `Einsatzplanung/Lohnarten ${year} (${n} ${n === 1 ? 'Person' : 'Personen'})`;
    const keys = COST_CATS.filter((c) => c.auto === cat).map((c) => c.key);
    await sql`update app.budget_costs set suggested = ${amounts.map(String)}::bigint[], source = ${source},
                amounts = case when manual then amounts else ${amounts.map(String)}::bigint[] end, updated_at = now()
              where budget_id = ${budgetId} and category = any(${keys})`;
  }
}

export interface BudgetPerson {
  employee_id: string;
  category: 'lead' | 'office' | 'gf' | 'none';
  auto_category: 'lead' | 'office' | 'gf';
  name: string;
  personnel_no: string | null;
  pay: string | null;
  minutes: number[];
  gross: bigint[];
  employer: bigint[];
  amounts: bigint[];
}

export async function budgetPersons(sql: Sql, budgetId: string): Promise<BudgetPerson[]> {
  const rows = await sql<BudgetPerson[]>`
    select employee_id, category, auto_category, name, personnel_no, pay, minutes, gross, employer, amounts
      from app.budget_cost_persons where budget_id = ${budgetId} order by name`;
  for (const r of rows) {
    r.gross = r.gross.map(BigInt);
    r.employer = r.employer.map(BigInt);
    r.amounts = r.amounts.map(BigInt);
  }
  return rows;
}

/** Person einer anderen Kostenart zuordnen (oder nicht berücksichtigen); gilt sofort und bei jedem Neuberechnen. */
export async function setPersonCategory(
  sql: Sql,
  budgetId: string,
  employeeId: string,
  category: string,
  actor: string,
) {
  if (!['lead', 'office', 'gf', 'none', 'auto'].includes(category))
    throw new BusinessError('Unbekannte Zuordnung');
  const b = await budgetById(sql, budgetId);
  assertDraft(b);
  await sql.begin(async (tx) => {
    const [p] = await tx<{ auto_category: string; category: string }[]>`
      select auto_category, category from app.budget_cost_persons
       where budget_id = ${budgetId} and employee_id = ${employeeId} for update`;
    if (!p) throw new BusinessError('Person nicht im Budget');
    const cat = category === 'auto' ? p.auto_category : category;
    if (category === 'auto' || cat === p.auto_category)
      await tx`delete from app.budget_person_overrides where budget_id = ${budgetId} and employee_id = ${employeeId}`;
    else
      await tx`insert into app.budget_person_overrides (budget_id, employee_id, category, updated_by)
               values (${budgetId}, ${employeeId}, ${cat}, ${actor})
               on conflict (budget_id, employee_id) do update set category = excluded.category,
                 updated_by = excluded.updated_by, updated_at = now()`;
    await tx`update app.budget_cost_persons set category = ${cat}
              where budget_id = ${budgetId} and employee_id = ${employeeId}`;
    await refreshPersonCosts(tx as unknown as Sql, budgetId, b.year);
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'person_category', 'budget', ${budgetId},
                     ${tx.json({ employee_id: employeeId, alt: p.category, neu: cat })})`;
  });
}

/** Objekt aus dem Budget herausnehmen bzw. wieder aufnehmen (Umsatz und direkte Kosten fallen weg). */
export async function setSiteExcluded(
  sql: Sql,
  budgetId: string,
  siteId: string,
  exclude: boolean,
  reason: string | null,
  actor: string,
) {
  const b = await budgetById(sql, budgetId);
  assertDraft(b);
  if (exclude)
    await sql`insert into app.budget_excluded_sites (budget_id, site_id, reason, created_by)
              values (${budgetId}, ${siteId}, ${reason?.trim().slice(0, 300) || null}, ${actor})
              on conflict (budget_id, site_id) do update set reason = excluded.reason`;
  else await sql`delete from app.budget_excluded_sites where budget_id = ${budgetId} and site_id = ${siteId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, ${exclude ? 'site_exclude' : 'site_include'}, 'budget', ${budgetId},
                    ${sql.json({ site_id: siteId, reason })})`;
}

/**
 * Haben sich seit der letzten Berechnung Leistungen, Objekte, Kunden oder Einsätze geändert (z. B. neuer Kunde mit
 * Leistungen ab 01.01.)? Dann rechnet die App das Budget (Entwurf) selbst neu.
 */
export async function budgetStale(sql: Sql, b: Budget): Promise<boolean> {
  if (b.status !== 'entwurf' || b.computing) return false;
  if (!b.computed_at) return true;
  const [r] = await sql<{ stale: boolean }[]>`
    select exists (select 1 from app.site_services where updated_at > ${b.computed_at})
        or exists (select 1 from app.sites where updated_at > ${b.computed_at})
        or exists (select 1 from app.customers where updated_at > ${b.computed_at})
        or exists (select 1 from app.shift_plans where updated_at > ${b.computed_at})
        or exists (select 1 from app.subcontracts where created_at > ${b.computed_at}) as stale`;
  return !!r?.stale;
}

/** Stündlich: Budgets (Entwurf) für dieses und kommende Jahre neu rechnen, wenn sich Grundlagen geändert haben. */
export async function refreshStaleBudgets(sql: Sql, thisYear: number): Promise<number> {
  const list = await sql<{ year: number }[]>`
    select year from app.budgets where status = 'entwurf' and year >= ${thisYear} and not computing`;
  let n = 0;
  for (const { year } of list) {
    const b = await getBudget(sql, year);
    if (!b || !(await budgetStale(sql, b))) continue;
    await await startBudgetCompute(sql, b.id, 'automatisch').catch(() => null);
    n++;
  }
  return n;
}

const parseAmounts = (a: bigint[]) => {
  if (a.length !== 12) throw new BusinessError('Je Monat ein Betrag');
  for (const v of a) if (v < 0n || v > 100_000_000_00n) throw new BusinessError('Betrag ungültig');
  return a;
};

export async function saveCostRow(
  sql: Sql,
  budgetId: string,
  input: { id: string; label: string; category: string; amounts: bigint[]; note: string | null },
  actor: string,
) {
  assertDraft(await budgetById(sql, budgetId));
  const label = input.label.trim();
  if (!label) throw new BusinessError('Bezeichnung fehlt');
  const cat = COST_CATS.find((c) => c.key === input.category);
  if (!cat) throw new BusinessError('Kostenart unbekannt');
  const amounts = parseAmounts(input.amounts);
  const [old] = await sql<{ amounts: bigint[]; suggested: bigint[] | null; budget_id: string }[]>`
    select amounts, suggested, budget_id from app.budget_costs where id = ${input.id}`;
  if (old && old.budget_id !== budgetId) throw new BusinessError('Zeile gehört nicht zu diesem Budget');
  const manual = !old?.suggested || old.suggested.some((v, i) => BigInt(v) !== amounts[i]);
  await sql`
    insert into app.budget_costs (id, budget_id, category, label, amounts, invest, manual, note, sort, updated_by)
    values (${input.id}, ${budgetId}, ${cat.key}, ${label}, ${amounts.map(String)}::bigint[], ${!!cat.invest}, true,
            ${input.note}, 100, ${actor})
    on conflict (id) do update set label = excluded.label, amounts = excluded.amounts, note = excluded.note,
      manual = ${manual}, updated_by = excluded.updated_by, updated_at = now()`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'save', 'budget_cost', ${input.id},
                    ${sql.json({ label, alt: old ? sum(old.amounts.map(BigInt)).toString() : null, neu: sum(amounts).toString() })})`;
}

/** Vorschlag wieder übernehmen (Betrag folgt wieder der Berechnung). */
export async function resetCostRow(sql: Sql, budgetId: string, rowId: string, actor: string) {
  assertDraft(await budgetById(sql, budgetId));
  await sql`update app.budget_costs set manual = false, amounts = coalesce(suggested, amounts), updated_by = ${actor},
              updated_at = now() where id = ${rowId} and budget_id = ${budgetId}`;
}

export async function deleteCostRow(sql: Sql, budgetId: string, rowId: string, actor: string) {
  assertDraft(await budgetById(sql, budgetId));
  const [r] = await sql<{ category: string; sort: number; label: string }[]>`
    select category, sort, label from app.budget_costs where id = ${rowId} and budget_id = ${budgetId}`;
  if (!r) return;
  if (r.sort < 100)
    throw new BusinessError('Feste Kostenarten lassen sich nicht löschen – Betrag auf 0 setzen');
  await sql`delete from app.budget_costs where id = ${rowId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'delete', 'budget_cost', ${rowId}, ${sql.json({ label: r.label })})`;
}

export async function saveAdjustment(
  sql: Sql,
  budgetId: string,
  input: Omit<BudgetAdjustment, 'note' | 'hours_month' | 'wage_cents' | 'replace_plan'> & {
    note: string | null;
    hours_month?: number;
    wage_cents?: bigint;
    replace_plan?: boolean;
  },
  actor: string,
) {
  const a = { hours_month: 0, wage_cents: 0n, replace_plan: false, ...input };
  assertDraft(await budgetById(sql, budgetId));
  if (!a.label.trim()) throw new BusinessError('Bezeichnung fehlt');
  if (a.from_month < 1 || a.to_month > 12 || a.to_month < a.from_month)
    throw new BusinessError('Monate ungültig');
  if (!(a.hours_month >= 0 && a.hours_month <= 100000)) throw new BusinessError('Stunden je Monat ungültig');
  if (a.hours_month > 0 && a.wage_cents <= 0n) throw new BusinessError('Stundensatz fehlt');
  if (a.revenue_month === 0n && a.cost_month === 0n && !a.hours_month)
    throw new BusinessError('Umsatz, Kosten oder Stunden je Monat angeben');
  await sql`
    insert into app.budget_adjustments (id, budget_id, site_id, customer_id, label, from_month, to_month,
      revenue_month, cost_month, hours_month, wage_cents, replace_plan, note, created_by)
    values (${a.id}, ${budgetId}, ${a.site_id}, ${a.customer_id}, ${a.label.trim()}, ${a.from_month}, ${a.to_month},
            ${a.revenue_month}, ${a.cost_month}, ${a.hours_month}, ${a.wage_cents},
            ${!!a.site_id && a.replace_plan && a.hours_month > 0}, ${a.note}, ${actor})
    on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'create', 'budget_adjustment', ${a.id}, ${sql.json({ label: a.label, site: a.site_id })})`;
}

/** Vorschlag Stundensatz für Stunden-Anpassungen: niedrigster aktiver Tariflohn + AG-Kosten (regulär) */
export async function defaultHourRate(sql: Sql): Promise<bigint> {
  const [w] = await sql<{ w: bigint | null }[]>`
    select min(hourly_wage_cents)::bigint as w from app.wage_levels where active`;
  const r = await getPlanCostRates(sql);
  const wage = BigInt(w?.w ?? 0n);
  return round(wage * BigInt(10000 + r.sv_employer_bp + r.levies_bp + r.accident_bp), 10000n);
}

export async function deleteAdjustment(sql: Sql, budgetId: string, adjId: string, actor: string) {
  assertDraft(await budgetById(sql, budgetId));
  await sql`delete from app.budget_adjustments where id = ${adjId} and budget_id = ${budgetId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'delete', 'budget_adjustment', ${adjId})`;
}

// --------------------------------------------------------------------------------------------- Auswertung

export interface BudgetRow {
  /** Objekt-ID oder „ng:<id>“ für Neugeschäft */
  key: string;
  site_id: string | null;
  site_no: string;
  name: string;
  customer_id: string | null;
  customer_name: string;
  customer_no: string | null;
  manager_user_id: string | null;
  newBusiness: boolean;
  flat: bigint[];
  cycle: bigint[];
  extra: bigint[];
  increase: bigint[];
  adjRevenue: bigint[];
  prev: bigint[];
  revenue: bigint[];
  minutes: number[];
  labor: bigint[];
  /** Ausfallkosten Urlaub / Krankheit auf den Lohn */
  vacation: bigint[];
  sick: bigint[];
  sub: bigint[];
  material: bigint[];
  adjCost: bigint[];
  direct: bigint[];
  db: bigint[];
  overhead: bigint[];
  result: bigint[];
}

export interface BudgetData {
  budget: Budget;
  rows: BudgetRow[];
  costs: BudgetCostRow[];
  adjustments: BudgetAdjustment[];
  /** Gemeinkosten je Monat (ohne Investitionen) */
  overhead: bigint[];
  invest: bigint[];
  /** Ausfallzeiten: Tage und Zuschläge auf den Lohn (Basispunkte) */
  absence: {
    workdays: number;
    holidays: number;
    vacation_days: number;
    sick_days: number;
    sick_auto: number | null;
    basis: string | null;
    present: number;
    vacation_bp: number;
    sick_bp: number;
  };
  /** herausgenommene Objekte (Umsatz/Kosten zählen nicht) */
  excluded: {
    site_id: string;
    site_no: string;
    name: string;
    customer_name: string;
    reason: string | null;
    revenue: bigint;
    direct: bigint;
  }[];
}

export async function budgetData(sql: Sql, year: number): Promise<BudgetData | null> {
  const budget = await getBudget(sql, year);
  if (!budget) return null;
  const [months, costs, adjustments, sites, excl] = await Promise.all([
    sql<
      {
        site_id: string;
        month: number;
        revenue_flat: bigint;
        revenue_cycle: bigint;
        revenue_extra: bigint;
        revenue_increase: bigint;
        prev_revenue: bigint;
        minutes: number;
        labor: bigint;
        subcontractor: bigint;
        material: bigint;
      }[]
    >`select * from app.budget_site_months where budget_id = ${budget.id}`,
    sql<BudgetCostRow[]>`
      select id, category, label, amounts, suggested, source, manual, invest, sort, note
        from app.budget_costs where budget_id = ${budget.id} order by sort, label`,
    sql<BudgetAdjustment[]>`
      select id, site_id, customer_id, label, from_month, to_month, revenue_month, cost_month,
             hours_month::float8 as hours_month, wage_cents, replace_plan, note
        from app.budget_adjustments where budget_id = ${budget.id} order by created_at`,
    sql<
      {
        id: string;
        site_no: string;
        name: string;
        customer_id: string;
        customer_name: string;
        customer_no: string | null;
        manager_user_id: string | null;
      }[]
    >`select s.id, s.site_no, s.name, s.customer_id, s.manager_user_id, c.name as customer_name, c.customer_no
        from app.sites s join app.customers c on c.id = s.customer_id`,
    sql<{ site_id: string; reason: string | null }[]>`
      select site_id, reason from app.budget_excluded_sites where budget_id = ${budget.id}`,
  ]);
  const exclMap = new Map(excl.map((e) => [e.site_id, e.reason]));
  const exclSum = new Map<string, { revenue: bigint; direct: bigint }>();
  for (const c of costs) {
    c.amounts = c.amounts.map(BigInt);
    c.suggested = c.suggested ? c.suggested.map(BigInt) : null;
  }
  for (const a of adjustments) {
    a.revenue_month = BigInt(a.revenue_month);
    a.cost_month = BigInt(a.cost_month);
    a.wage_cents = BigInt(a.wage_cents);
  }
  const siteMap = new Map(sites.map((s) => [s.id, s]));
  const custName = new Map(sites.map((s) => [s.customer_id, [s.customer_name, s.customer_no] as const]));
  const map = new Map<string, BudgetRow>();
  const blank = (key: string, init: Partial<BudgetRow>): BudgetRow => ({
    key,
    site_id: null,
    site_no: '',
    name: '',
    customer_id: null,
    customer_name: '',
    customer_no: null,
    manager_user_id: null,
    newBusiness: false,
    flat: zero(),
    cycle: zero(),
    extra: zero(),
    increase: zero(),
    adjRevenue: zero(),
    prev: zero(),
    revenue: zero(),
    minutes: MONTHS.map(() => 0),
    labor: zero(),
    vacation: zero(),
    sick: zero(),
    sub: zero(),
    material: zero(),
    adjCost: zero(),
    direct: zero(),
    db: zero(),
    overhead: zero(),
    result: zero(),
    ...init,
  });
  const siteRow = (id: string) => {
    let r = map.get(id);
    if (!r) {
      const s = siteMap.get(id);
      r = blank(id, {
        site_id: id,
        site_no: s?.site_no ?? '',
        name: s?.name ?? '(gelöscht)',
        customer_id: s?.customer_id ?? null,
        customer_name: s?.customer_name ?? '',
        customer_no: s?.customer_no ?? null,
        manager_user_id: s?.manager_user_id ?? null,
      });
      map.set(id, r);
    }
    return r;
  };
  for (const m of months) {
    if (exclMap.has(m.site_id)) {
      const e = exclSum.get(m.site_id) ?? { revenue: 0n, direct: 0n };
      e.revenue +=
        BigInt(m.revenue_flat) +
        BigInt(m.revenue_cycle) +
        BigInt(m.revenue_extra) +
        BigInt(m.revenue_increase);
      e.direct += BigInt(m.labor) + BigInt(m.subcontractor) + BigInt(m.material);
      exclSum.set(m.site_id, e);
      continue;
    }
    const r = siteRow(m.site_id);
    const i = m.month - 1;
    r.flat[i] = BigInt(m.revenue_flat);
    r.cycle[i] = BigInt(m.revenue_cycle);
    r.extra[i] = BigInt(m.revenue_extra);
    r.increase[i] = BigInt(m.revenue_increase);
    r.prev[i] = BigInt(m.prev_revenue);
    r.minutes[i] = m.minutes;
    r.labor[i] = BigInt(m.labor);
    r.sub[i] = BigInt(m.subcontractor);
    r.material[i] = BigInt(m.material);
  }
  // Stunden von Hand, die die Einsatzplanung ersetzen: geplante Stunden/Lohn dieser Monate erst leeren
  for (const a of adjustments)
    if (a.site_id && a.replace_plan && !exclMap.has(a.site_id)) {
      const r = siteRow(a.site_id);
      for (let i = a.from_month - 1; i < a.to_month; i++) {
        r.labor[i] = 0n;
        r.minutes[i] = 0;
      }
    }
  for (const a of adjustments) {
    let r: BudgetRow;
    if (a.site_id && exclMap.has(a.site_id)) continue;
    if (a.site_id) r = siteRow(a.site_id);
    else {
      const [cn, cno] = (a.customer_id && custName.get(a.customer_id)) || ['', null];
      r = blank(`ng:${a.id}`, {
        name: a.label,
        newBusiness: true,
        customer_id: a.customer_id,
        customer_name: cn || 'Neugeschäft',
        customer_no: cno,
        site_no: 'NEU',
      });
      map.set(r.key, r);
    }
    const hoursCost = a.hours_month
      ? round(BigInt(Math.round(a.hours_month * 100)) * a.wage_cents, 100n)
      : 0n;
    for (let i = a.from_month - 1; i < a.to_month; i++) {
      r.adjRevenue[i]! += a.revenue_month;
      r.adjCost[i]! += a.cost_month;
      r.labor[i]! += hoursCost;
      r.minutes[i]! += Math.round(a.hours_month * 60);
    }
  }
  // Ausfallzeiten: Zuschlag auf den Lohn = Ausfalltage ÷ Anwesenheitstage (Feiertage sind im Plan schon bezahlt)
  const days = countDays(`${year}-01-01`, `${year}-12-31`);
  const vacDays = Number(budget.vacation_days);
  const sickDays = Number(budget.sick_days ?? budget.sick_days_auto ?? 0);
  const present = days.weekdays - days.holidays - vacDays - sickDays;
  const bpOf = (d: number) => (present > 0 ? Math.round((d / present) * 10000) : 0);
  const absence = {
    workdays: days.weekdays,
    holidays: days.holidays,
    vacation_days: vacDays,
    sick_days: sickDays,
    sick_auto: budget.sick_days_auto == null ? null : Number(budget.sick_days_auto),
    basis: budget.sick_basis,
    present,
    vacation_bp: bpOf(vacDays),
    sick_bp: bpOf(sickDays),
  };
  // Vorjahr gesamt wie Auswertungen → Statistiken (Leistungszeitraum, eigene + übernommene Rechnungen). Was keinem
  // Objekt im Budget zugeordnet ist (inaktive/herausgenommene Objekte, Rechnungen ohne Objekt, Sonderreinigung),
  // steht in einer eigenen Zeile – so stimmt „Vorjahr“ in Summen, Diagrammen und PDF mit dem echten Umsatz überein.
  {
    const y0 = budget.year - 1;
    const total = await monthlyRevenue(sql, `${y0}-01-01`, `${y0}-12-31`);
    const rest = MONTHS.map((i) => {
      const t = total.get(`${y0}-${String(i + 1).padStart(2, '0')}`) ?? 0n;
      let have = 0n;
      for (const r of map.values()) have += r.prev[i]!;
      return t - have;
    });
    if (rest.some((v) => v !== 0n))
      map.set(
        'vj:rest',
        blank('vj:rest', {
          site_no: '–',
          name: 'Vorjahr: übrige Rechnungen (inaktive Objekte, ohne Objekt)',
          customer_name: '–',
          prev: rest,
        }),
      );
  }
  const rows = [...map.values()];
  for (const r of rows)
    for (const i of MONTHS) {
      r.vacation[i] = round(r.labor[i]! * BigInt(absence.vacation_bp), 10000n);
      r.sick[i] = round(r.labor[i]! * BigInt(absence.sick_bp), 10000n);
      r.revenue[i] = r.flat[i]! + r.cycle[i]! + r.extra[i]! + r.increase[i]! + r.adjRevenue[i]!;
      r.direct[i] = r.labor[i]! + r.vacation[i]! + r.sick[i]! + r.sub[i]! + r.material[i]! + r.adjCost[i]!;
      r.db[i] = r.revenue[i]! - r.direct[i]!;
    }
  const overhead = zero();
  const invest = zero();
  for (const c of costs) for (const i of MONTHS) (c.invest ? invest : overhead)[i]! += c.amounts[i]!;
  // Gemeinkosten nach Umsatz des Monats auf die Objekte verteilen
  if (budget.allocate)
    for (const i of MONTHS) {
      const parts = splitBy(
        overhead[i]!,
        rows.map((r) => r.revenue[i]!),
      );
      rows.forEach((r, k) => (r.overhead[i] = parts[k]!));
    }
  for (const r of rows) for (const i of MONTHS) r.result[i] = r.db[i]! - r.overhead[i]!;
  rows.sort((a, b) =>
    a.newBusiness === b.newBusiness ? a.site_no.localeCompare(b.site_no) : a.newBusiness ? 1 : -1,
  );
  const excluded = [...exclMap].map(([site_id, reason]) => {
    const st = siteMap.get(site_id);
    const e = exclSum.get(site_id) ?? { revenue: 0n, direct: 0n };
    return {
      site_id,
      site_no: st?.site_no ?? '',
      name: st?.name ?? '(gelöscht)',
      customer_name: st?.customer_name ?? '',
      reason,
      ...e,
    };
  });
  excluded.sort((a, b) => a.site_no.localeCompare(b.site_no));
  return { budget, rows, costs, adjustments, overhead, invest, absence, excluded };
}

export const yearSum = (a: bigint[]) => sum(a);

// --------------------------------------------------------------------------------------------- Soll/Ist

export interface ActualMonth {
  month: number;
  revenue: bigint;
  direct: bigint;
  overhead: bigint;
}

/**
 * Ist je Monat (Nachkalkulation) für die abgeschlossenen Monate des Jahres: je Objekt Erlös und direkte Kosten, dazu
 * Gemeinkosten (allgemeine Kostenstellen, interne Objekte wie Büro, Objektleitungen).
 */
export async function budgetActuals(sql: Sql, year: number, today: string) {
  const lastFull =
    Number(today.slice(0, 4)) > year
      ? 12
      : Number(today.slice(0, 4)) < year
        ? 0
        : Number(today.slice(5, 7)) - 1;
  const perSite = new Map<string, { revenue: bigint[]; direct: bigint[] }>();
  const months: ActualMonth[] = [];
  for (let i = 0; i < lastFull; i++) {
    const month = mKey(year, i);
    const { start, end } = monthBounds(month);
    const [{ rows, general }, leads] = await Promise.all([
      siteCosting(sql, month, undefined, { cachedLabor: true }),
      laborFromPayroll(sql, start, end, { cached: true, leads: 'only' }),
    ]);
    let rev = 0n;
    let dir = 0n;
    let oh = general.reduce((a, g) => a + g.total, 0n) + leads.reduce((a, l) => a + l.cost, 0n);
    for (const r of rows) {
      const cost = r.labor + r.material + r.subcontractor + r.equipment + r.other;
      if (r.internal) {
        // Lohn von Objektleitungen an internen Objekten steckt schon in „leads“
        oh += cost;
        continue;
      }
      rev += r.revenue;
      dir += cost;
      const p = perSite.get(r.site_id) ?? { revenue: zero(), direct: zero() };
      p.revenue[i]! += r.revenue;
      p.direct[i]! += cost;
      perSite.set(r.site_id, p);
    }
    const leadInternal = leads.filter(
      (l) => l.site_id && rows.some((r) => r.internal && r.site_id === l.site_id),
    );
    oh -= leadInternal.reduce((a, l) => a + l.cost, 0n);
    months.push({ month: i + 1, revenue: rev, direct: dir, overhead: oh });
  }
  return { months, perSite, lastFull };
}
