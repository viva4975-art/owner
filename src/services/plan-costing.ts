import type { Sql } from '../db/client.js';
import { employerCost, type PayBand, type PlanCostRates } from '../domain/hr/employer-cost.js';
import { monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, lineNet, type Quantity } from '../domain/money/money.js';
import { monthRange, siteCosting, subcontractEstimates } from './costing.js';
import { BusinessError } from './errors.js';
import { plannedShifts } from './time.js';

/*
 * Plan-Kalkulation (Ahmed 23.10.: „wie eine gesamte Nachkalkulation, nur mit Soll-/Plan-Daten“):
 *   Erlös  = laufende Leistungen (Monatspauschalen, Zyklus-Leistungen anteilig je Monat)
 * − Lohn   = eingeplante Einsätze (Soll) × Stundenlohn × (1 + Ausfall Urlaub/Krank) bzw. Festgehalt,
 *            + Arbeitgeberkosten je Person und Monat nach Lohnhöhe (Minijob / Midijob / regulär)
 * − Nachunternehmer laut Bestellung (jeder Monat, auch wenn schon eine Rechnung gebucht ist)
 * − Sachkosten (Material, Geräte, Sonstiges) als Ø der letzten 3 abgeschlossenen Monate
 * Feiertage im Plan zählen als bezahlte Stunden; Tage mit eingetragener Abwesenheit nicht (deckt der Ausfall-Zuschlag).
 */

const CYCLE_MONTHS: Record<string, number> = {
  monatlich: 1,
  zweimonatlich: 2,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};

export async function getPlanCostRates(sql: Sql): Promise<PlanCostRates> {
  const [r] = await sql<PlanCostRates[]>`
    select sv_employer_bp, sv_employee_bp, levies_bp, accident_bp, minijob_flat_bp, minijob_limit_cents,
           midijob_upper_cents, absence_bp from app.plan_cost_settings where id = 1`;
  return {
    ...r!,
    minijob_limit_cents: BigInt(r!.minijob_limit_cents),
    midijob_upper_cents: BigInt(r!.midijob_upper_cents),
  };
}

export async function savePlanCostRates(sql: Sql, r: PlanCostRates, actor: string) {
  const bp = (v: number, max: number, label: string) => {
    if (!Number.isInteger(v) || v < 0 || v > max)
      throw new BusinessError(`${label}: Wert zwischen 0 und ${max / 100} %`);
    return v;
  };
  if (r.minijob_limit_cents <= 0n || r.midijob_upper_cents <= r.minijob_limit_cents)
    throw new BusinessError('Midijob-Obergrenze muss über der Minijobgrenze liegen');
  await sql`update app.plan_cost_settings set
    sv_employer_bp = ${bp(r.sv_employer_bp, 5000, 'AG-Anteil')}, sv_employee_bp = ${bp(r.sv_employee_bp, 5000, 'AN-Anteil')},
    levies_bp = ${bp(r.levies_bp, 2000, 'Umlagen')}, accident_bp = ${bp(r.accident_bp, 2000, 'Unfallversicherung')},
    minijob_flat_bp = ${bp(r.minijob_flat_bp, 6000, 'Minijob-Pauschale')}, minijob_limit_cents = ${r.minijob_limit_cents},
    midijob_upper_cents = ${r.midijob_upper_cents}, absence_bp = ${bp(r.absence_bp, 5000, 'Ausfall')},
    updated_at = now(), updated_by = ${actor} where id = 1`;
  await sql`insert into app.audit_log (actor, action, entity) values (${actor}, 'save', 'plan_cost_settings')`;
}

export interface PlanSiteRow {
  site_id: string;
  site_no: string;
  site_name: string;
  customer_id: string;
  customer_name: string;
  manager_user_id: string | null;
  revenue: bigint;
  minutes: number;
  gross: bigint;
  employer: bigint;
  labor: bigint;
  subcontractor: bigint;
  material: bigint;
  margin: bigint;
  margin_bp: number | null;
}

export interface PlanEmployeeRow {
  employee_id: string;
  name: string;
  personnel_no: string;
  employment_type: string | null;
  pay_model: string | null;
  minutes: number;
  gross: bigint;
  employer: bigint;
  bands: PayBand[];
  wage_assumed: boolean;
  /** Beschäftigungsart Minijob, aber geplantes Entgelt eines Monats über der Minijobgrenze */
  minijob_over: boolean;
  /** sozialversicherungspflichtig, aber geplantes Entgelt unter der Minijobgrenze → Plan vermutlich unvollständig */
  low_plan: boolean;
}

/** Cent-genaue Verteilung eines Betrags nach Gewichten (größter Rest). */
function split(total: bigint, weights: number[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0n);
  const raw = weights.map((w) => (total * BigInt(w)) / BigInt(sum));
  let rest = total - raw.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, r: Number((total * BigInt(w)) % BigInt(sum)) }))
    .sort((a, b) => b.r - a.r);
  for (const o of order) {
    if (rest <= 0n) break;
    raw[o.i]! += 1n;
    rest -= 1n;
  }
  return raw;
}

function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to;) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

export async function planCosting(sql: Sql, period: { from: string; to: string }) {
  const months = monthsOf(period.from, period.to);
  const from = monthRange(period.from).from;
  const to = monthRange(period.to).to;
  const rates = await getPlanCostRates(sql);
  // Sachkosten: Ø der 3 Monate vor dem aktuellen Monat (Ist)
  const now = todayBerlin().slice(0, 7);
  const prev = monthsOf('2000-01', now).slice(-4, -1);
  const [sites, services, shifts, nu, past, emps] = await Promise.all([
    sql<
      {
        id: string;
        site_no: string;
        name: string;
        customer_id: string;
        customer_name: string;
        manager_user_id: string | null;
        active: boolean;
      }[]
    >`
      select s.id, s.site_no, s.name, s.customer_id, s.manager_user_id, s.active, c.name as customer_name
        from app.sites s join app.customers c on c.id = s.customer_id order by s.site_no`,
    sql<
      {
        site_id: string;
        quantity_milli: bigint;
        unit_price_cents: bigint;
        billing_cycle: string;
        valid_from: string;
        valid_to: string | null;
      }[]
    >`
      select ss.site_id, ss.quantity_milli, ss.unit_price_cents, ss.billing_cycle::text as billing_cycle,
             ss.valid_from::text, ss.valid_to::text
        from app.site_services ss join app.sites s on s.id = ss.site_id join app.customers c on c.id = s.customer_id
       where ss.active and not c.is_internal
         and (ss.kind = 'monthly_flat'
              or ss.billing_cycle in ('zweimonatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich'))
         and ss.valid_from <= ${to} and (ss.valid_to is null or ss.valid_to >= ${from})`,
    plannedShifts(sql, { from, to }),
    subcontractEstimates(sql, from, to, undefined, { plan: true }),
    siteCosting(sql, { from: prev[0]!, to: prev[2]! }),
    sql<
      {
        id: string;
        name: string;
        personnel_no: string;
        employment_type: string | null;
        pay_model: string | null;
        monthly_salary_cents: bigint | null;
        wage: bigint | null;
        min_wage: bigint | null;
      }[]
    >`
      select e.id, e.last_name || ', ' || e.first_name as name, e.personnel_no, e.employment_type::text,
             e.pay_model, e.monthly_salary_cents, app.effective_wage_cents(e)::bigint as wage,
             (select min(w.hourly_wage_cents) from app.wage_levels w where w.active)::bigint as min_wage
        from app.employees e`,
  ]);
  const siteMap = new Map(sites.map((s) => [s.id, s]));
  const acc = new Map<string, Omit<PlanSiteRow, 'margin' | 'margin_bp' | 'labor'>>();
  const row = (siteId: string) => {
    let r = acc.get(siteId);
    if (!r) {
      const s = siteMap.get(siteId)!;
      r = {
        site_id: s.id,
        site_no: s.site_no,
        site_name: s.name,
        customer_id: s.customer_id,
        customer_name: s.customer_name,
        manager_user_id: s.manager_user_id,
        revenue: 0n,
        minutes: 0,
        gross: 0n,
        employer: 0n,
        subcontractor: 0n,
        material: 0n,
      };
      acc.set(siteId, r);
    }
    return r;
  };
  // Erlös: Pauschalen je Monat, Zyklus-Leistungen anteilig (Rechnungsbetrag ÷ Monate des Zyklus)
  for (const m of months) {
    const { start, end } = monthBounds(m);
    for (const sv of services) {
      if (sv.valid_from > end || (sv.valid_to && sv.valid_to < start) || !siteMap.has(sv.site_id)) continue;
      const net = lineNet(BigInt(sv.quantity_milli) as Quantity, BigInt(sv.unit_price_cents) as Cents);
      const cm = BigInt(CYCLE_MONTHS[sv.billing_cycle] ?? 1);
      row(sv.site_id).revenue += (net + cm / 2n) / cm;
    }
  }
  // Lohn: geplante Minuten je Mitarbeiter, Monat und Objekt
  const planned = new Map<string, Map<string, number>>(); // emp|month → site → Minuten
  for (const s of shifts) {
    if (!s.plan.employee_id || s.absence || s.minutes <= 0 || !siteMap.has(s.plan.site_id)) continue;
    const k = `${s.plan.employee_id}|${s.date.slice(0, 7)}`;
    const bySite = planned.get(k) ?? new Map<string, number>();
    bySite.set(s.plan.site_id, (bySite.get(s.plan.site_id) ?? 0) + s.minutes);
    planned.set(k, bySite);
  }
  const empMap = new Map(emps.map((e) => [e.id, e]));
  const empAcc = new Map<string, PlanEmployeeRow>();
  for (const [k, bySite] of planned) {
    const [empId] = k.split('|') as [string];
    const e = empMap.get(empId);
    if (!e) continue;
    const minutes = [...bySite.values()].reduce((a, b) => a + b, 0);
    const wage = BigInt(e.wage ?? e.min_wage ?? 0);
    const fixed = e.pay_model === 'festgehalt' && e.monthly_salary_cents;
    // Stundenlohn: Minuten × Lohn × (1 + Ausfall), kaufmännisch gerundet; Festgehalt: Monatsgehalt
    const gross = fixed
      ? BigInt(e.monthly_salary_cents!)
      : (BigInt(minutes) * wage * BigInt(10000 + rates.absence_bp) + 300000n) / 600000n;
    const { band, costCents } = employerCost(
      gross,
      e.employment_type === 'minijob' ? 'minijob' : e.employment_type ? 'sv' : null,
      rates,
    );
    const sitesOf = [...bySite.keys()];
    const w = sitesOf.map((id) => bySite.get(id)!);
    const g = split(gross, w);
    const c = split(costCents, w);
    sitesOf.forEach((id, i) => {
      const r = row(id);
      r.minutes += w[i]!;
      r.gross += g[i]!;
      r.employer += c[i]!;
    });
    const ea = empAcc.get(empId) ?? {
      employee_id: empId,
      name: e.name,
      personnel_no: e.personnel_no,
      employment_type: e.employment_type,
      pay_model: e.pay_model,
      minutes: 0,
      gross: 0n,
      employer: 0n,
      bands: [],
      wage_assumed: !fixed && e.wage === null,
      minijob_over: false,
      low_plan: false,
    };
    ea.minutes += minutes;
    ea.gross += gross;
    ea.employer += costCents;
    if (!ea.bands.includes(band)) ea.bands.push(band);
    if (e.employment_type === 'minijob' && gross > rates.minijob_limit_cents) ea.minijob_over = true;
    if (e.employment_type && e.employment_type !== 'minijob' && gross <= rates.minijob_limit_cents)
      ea.low_plan = true;
    empAcc.set(empId, ea);
  }
  for (const n of nu) if (siteMap.has(n.site_id)) row(n.site_id).subcontractor += BigInt(n.cost);
  for (const p of past.rows) {
    const avg = (p.material + p.equipment + p.other) / 3n;
    if (avg > 0n && siteMap.get(p.site_id)?.active) row(p.site_id).material += avg * BigInt(months.length);
  }
  const rows: PlanSiteRow[] = [...acc.values()]
    .filter((r) => r.revenue || r.minutes || r.subcontractor || r.material)
    .map((r) => {
      const labor = r.gross + r.employer;
      const margin = r.revenue - labor - r.subcontractor - r.material;
      return {
        ...r,
        labor,
        margin,
        margin_bp: r.revenue !== 0n ? Number((margin * 10000n) / r.revenue) : null,
      };
    })
    .sort((a, b) => a.site_no.localeCompare(b.site_no));
  const employees = [...empAcc.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { rows, employees, rates, months: months.length, materialFrom: prev[0]!, materialTo: prev[2]! };
}
