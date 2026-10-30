import type { Sql } from '../db/client.js';
import {
  employerCost,
  isManagingDirector,
  type PayBand,
  type PlanCostRates,
} from '../domain/hr/employer-cost.js';
import { countWorkDays, monthBounds } from '../domain/invoice/calc.js';
import { type Cents, lineNet, type Quantity } from '../domain/money/money.js';
import { monthRange, SPECIAL_SITE_ID, subcontractEstimates } from './costing.js';
import { BusinessError } from './errors.js';
import { laborFromPayroll } from './costing-labor.js';

/*
 * Plan-Kalkulation (Ahmed 23.10.: „wie eine gesamte Nachkalkulation, nur mit Soll-/Plan-Daten“):
 *   Erlös  = laufende Leistungen (Monatspauschalen, Zyklus-Leistungen anteilig je Monat)
 * − Lohn   = wie Lohnarten („Ist, sonst Plan“, Ahmed 30.10.): erfasste Zeit, sonst Einsatzplan, dazu Zeiten ohne Einsatz,
 *            Urlaub/Krank/Feiertagslohn und Zuschläge; + Arbeitgeberkosten je Person und Monat nach Lohnhöhe
 * − Nachunternehmer laut Bestellung (jeder Monat, auch wenn schon eine Rechnung gebucht ist)
 * − Material pauschal in % vom Erlös (Standard 2 %, Ahmed 27.10.; vorher Ø der letzten 3 Monate)
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
           midijob_upper_cents, absence_bp, material_bp from app.plan_cost_settings where id = 1`;
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
    material_bp = ${bp(r.material_bp, 5000, 'Material')},
    updated_at = now(), updated_by = ${actor} where id = 1`;
  await sql`insert into app.audit_log (actor, action, entity) values (${actor}, 'save', 'plan_cost_settings')`;
}

export interface PlanSiteRow {
  site_id: string;
  site_no: string;
  site_name: string;
  customer_id: string;
  customer_name: string;
  customer_no: string | null;
  manager_user_id: string | null;
  /** Büro/Lager (interner Bereich): Gemeinkosten, nicht im Gesamt der Objekte */
  internal: boolean;
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

/** Aufschlüsselung einer Zeile der Plan-Kalkulation (Ahmed 26.10.). */
export interface PlanSiteDetail {
  revenue: { service_id: string; title: string; cycle: string; months: number; amount: bigint }[];
  labor: {
    employee_id: string;
    name: string;
    personnel_no: string;
    minutes: number;
    gross: bigint;
    employer: bigint;
    bands: PayBand[];
    fixed: boolean;
    wage_cents: bigint;
    wage_assumed: boolean;
  }[];
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
  const [sites, services, nu, emps] = await Promise.all([
    sql<
      {
        id: string;
        site_no: string;
        name: string;
        customer_id: string;
        customer_name: string;
        customer_no: string | null;
        manager_user_id: string | null;
        active: boolean;
        internal: boolean;
      }[]
    >`
      select s.id, s.site_no, s.name, s.customer_id, s.manager_user_id, s.active, c.name as customer_name, c.customer_no,
             coalesce(c.is_internal, false) and s.id <> ${SPECIAL_SITE_ID} as internal
        from app.sites s join app.customers c on c.id = s.customer_id order by s.site_no`,
    sql<
      {
        site_id: string;
        quantity_milli: bigint;
        unit_price_cents: bigint;
        billing_cycle: string;
        valid_from: string;
        valid_to: string | null;
        unit_code: string;
        work_days: number[] | null;
        hours_per_day_milli: bigint | null;
        id: string;
        title: string;
      }[]
    >`
      select ss.id, ss.description as title, ss.site_id, ss.quantity_milli, ss.unit_price_cents, ss.billing_cycle::text as billing_cycle,
             ss.valid_from::text, ss.valid_to::text, ss.unit_code, ss.work_days, ss.hours_per_day_milli
        from app.site_services ss join app.sites s on s.id = ss.site_id join app.customers c on c.id = s.customer_id
       where ss.active and not c.is_internal
         -- nur laufende Pauschalen; Arbeiten „nach Ausführung“ (Glas, Grundreinigung …) zählen erst in der
         -- Nachkalkulation, wenn sie abgerechnet sind (Leistungszeitraum im Monat)
         and ss.kind = 'monthly_flat'
         and ss.valid_from <= ${to} and (ss.valid_to is null or ss.valid_to >= ${from})`,
    subcontractEstimates(sql, from, to, undefined, { plan: true }),
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
        tags: string[] | null;
        full_name: string;
        md: string | null;
      }[]
    >`
      select e.id, e.last_name || ', ' || e.first_name as name, e.first_name || ' ' || e.last_name as full_name,
             (select managing_director from app.company limit 1) as md, e.personnel_no, e.employment_type::text,
             e.pay_model, e.monthly_salary_cents, app.effective_wage_cents(e)::bigint as wage, e.tags,
             (select min(w.hourly_wage_cents) from app.wage_levels w where w.active)::bigint as min_wage
        from app.employees e`,
  ]);
  const siteMap = new Map(sites.map((s) => [s.id, s]));
  const details = new Map<string, PlanSiteDetail>();
  const detail = (siteId: string) => {
    let d = details.get(siteId);
    if (!d) {
      d = { revenue: [], labor: [] };
      details.set(siteId, d);
    }
    return d;
  };
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
        customer_no: s.customer_no,
        manager_user_id: s.manager_user_id,
        internal: s.internal,
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
      // nach Arbeitstagen: Menge des Monats
      const qty = sv.work_days?.length
        ? BigInt(
            countWorkDays(
              sv.valid_from > start ? sv.valid_from : start,
              sv.valid_to && sv.valid_to < end ? sv.valid_to : end,
              sv.work_days,
            ).days,
          ) * (sv.unit_code === 'HUR' ? BigInt(sv.hours_per_day_milli ?? 0n) : 1000n)
        : BigInt(sv.quantity_milli);
      const net = lineNet(qty as Quantity, BigInt(sv.unit_price_cents) as Cents);
      const cm = BigInt(CYCLE_MONTHS[sv.billing_cycle] ?? 1);
      const share = (net + cm / 2n) / cm;
      row(sv.site_id).revenue += share;
      const d = detail(sv.site_id).revenue;
      const it = d.find((x) => x.service_id === sv.id);
      if (it) {
        it.amount += share;
        it.months += 1;
      } else
        d.push({ service_id: sv.id, title: sv.title, cycle: sv.billing_cycle, months: 1, amount: share });
    }
  }
  // Lohn wie Lohnarten / Nachkalkulation (Ahmed 30.10.): je Einsatz Ist, sonst Plan; Zeiten ohne Einsatz zählen mit,
  // Urlaub/Krank/Feiertagslohn und Zuschläge wie im Lohnexport. Arbeitgeberkosten je Person und Monat nach Lohnhöhe.
  const empMap = new Map(emps.map((e) => [e.id, e]));
  const empAcc = new Map<string, PlanEmployeeRow>();
  for (const m of months) {
    const { start, end } = monthBounds(m);
    const byEmp = new Map<string, { site: string; minutes: number; gross: bigint }[]>();
    for (const sh of await laborFromPayroll(sql, start, end)) {
      const l = byEmp.get(sh.employee_id) ?? [];
      l.push({ site: sh.site_id, minutes: sh.minutes, gross: sh.gross });
      byEmp.set(sh.employee_id, l);
    }
    for (const [empId, parts] of byEmp) {
      const e = empMap.get(empId);
      if (!e) continue;
      const wage = BigInt(e.wage ?? e.min_wage ?? 0);
      const fixed = e.pay_model === 'festgehalt' && e.monthly_salary_cents;
      const gf = isManagingDirector(e.tags, { name: e.full_name, managingDirector: e.md });
      const gross = parts.reduce((a, p) => a + p.gross, 0n);
      const { band, costCents } = gf
        ? { band: 'gf' as const, costCents: 0n }
        : employerCost(
            gross,
            e.employment_type === 'minijob' ? 'minijob' : e.employment_type ? 'sv' : null,
            rates,
          );
      // Arbeitgeberkosten nach Lohnanteil je Objekt; Anteil „ohne Objekt“ fällt weg (wie in der Nachkalkulation)
      const shown = parts.filter((p) => p.site && siteMap.has(p.site));
      const minutes = shown.reduce((a, p) => a + p.minutes, 0);
      const gw = parts.map((p) => Number(p.gross > 0n ? p.gross : 0n));
      const cAll = split(costCents, gw.some((x) => x > 0) ? gw : parts.map((p) => p.minutes || 1));
      const sitesOf = shown.map((p) => p.site);
      const w = shown.map((p) => p.minutes);
      const g = shown.map((p) => p.gross);
      const c = shown.map((p) => cAll[parts.indexOf(p)]!);
      sitesOf.forEach((id, i) => {
        const r = row(id);
        r.minutes += w[i]!;
        r.gross += g[i]!;
        r.employer += c[i]!;
        const dl = detail(id).labor;
        const it = dl.find((x) => x.employee_id === empId);
        if (it) {
          it.minutes += w[i]!;
          it.gross += g[i]!;
          it.employer += c[i]!;
          if (!it.bands.includes(band)) it.bands.push(band);
        } else
          dl.push({
            employee_id: empId,
            name: e.name,
            personnel_no: e.personnel_no,
            minutes: w[i]!,
            gross: g[i]!,
            employer: c[i]!,
            bands: [band],
            fixed: !!fixed,
            wage_cents: wage,
            wage_assumed: !fixed && e.wage === null,
          });
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
      if (!gf && e.employment_type && e.employment_type !== 'minijob' && gross <= rates.minijob_limit_cents)
        ea.low_plan = true;
      empAcc.set(empId, ea);
    }
  }
  for (const n of nu) if (siteMap.has(n.site_id)) row(n.site_id).subcontractor += BigInt(n.cost);
  // Material pauschal: Erlös × Satz, kaufmännisch auf Cent
  for (const r of acc.values())
    if (r.revenue > 0n) r.material = (r.revenue * BigInt(rates.material_bp) + 5000n) / 10000n;
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
  for (const d of details.values()) {
    d.revenue.sort((a, b) => a.title.localeCompare(b.title, 'de'));
    d.labor.sort((a, b) => Number(b.gross + b.employer - a.gross - a.employer));
  }
  return {
    rows,
    employees,
    details,
    rates,
    months: months.length,
  };
}
