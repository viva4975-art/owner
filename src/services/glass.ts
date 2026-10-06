import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { schoolHoliday } from '../domain/time/school-holidays.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Glasreinigung-Planer (wie die alte App): Termine je Objekt, Kalender, offene Planung je Jahr, Auto-Planung.
 * Status wird berechnet (erledigt / überfällig / heute / geplant). „Erledigt“ legt den Folgetermin nach Turnus an
 * (genau einmal, DB-Index). Datum immer Europe/Berlin.
 */

export const INTERVALS: Record<string, { label: string; days: number; perYear: number }> = {
  einmalig: { label: 'Einmalig', days: 0, perYear: 0 },
  '1x': { label: '1× jährlich', days: 365, perYear: 1 },
  '2x': { label: '2× jährlich', days: 182, perYear: 2 },
  '3x': { label: '3× jährlich', days: 121, perYear: 3 },
  '4x': { label: '4× jährlich', days: 91, perYear: 4 },
};
/** Alte Turnus-Werte (nur Anzeige / Import) */
const LEGACY_INTERVAL: Record<string, string> = {
  halbjaehrlich: '2x',
  quartalsweise: '4x',
  jaehrlich: '1x',
};
export const PER_YEAR: [number, string][] = [
  [1, '1× jährlich'],
  [2, '2× jährlich'],
  [3, '3× jährlich'],
  [4, '4× jährlich (quartalsweise)'],
  [6, '6× jährlich (alle 2 Monate)'],
  [12, '12× jährlich (monatlich)'],
];
export const HOLIDAY_PREF: Record<string, string> = {
  egal: 'Egal',
  waehrend: 'Während Schulferien',
  ausserhalb: 'Außerhalb Schulferien',
};
export const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const MONTHS_LONG = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

export function districtOf(plz: string | null | undefined): string | null {
  const p = (plz ?? '').trim();
  if (!/^\d{5}$/.test(p)) return null;
  const n = Number(p.slice(0, 3));
  if (n === 801 || n === 802) return 'M-Mitte/Altstadt';
  if (n === 803) return 'M-Schwabing';
  if (n >= 804 && n <= 806) return 'M-Nord';
  if (n >= 807 && n <= 809) return 'M-Ost';
  if (n >= 810 && n <= 812) return 'M-Süd';
  if (n === 813 || n === 814) return 'M-West';
  return `PLZ ${p.slice(0, 2)} ${p.slice(2)}`;
}
export const plzOf = (address: string | null | undefined) => /\b(\d{5})\b/.exec(address ?? '')?.[1] ?? null;

export type GlassStatus = 'erledigt' | 'ueberfaellig' | 'heute' | 'geplant';
export const STATUS_LABEL: Record<GlassStatus, [string, string]> = {
  ueberfaellig: ['Überfällig', 'err'],
  heute: ['Heute', 'warn'],
  geplant: ['Geplant', 'info'],
  erledigt: ['Erledigt', 'ok'],
};
export const statusOf = (a: { done: boolean; first_day: string }, today = todayBerlin()): GlassStatus =>
  a.done ? 'erledigt' : a.first_day < today ? 'ueberfaellig' : a.first_day === today ? 'heute' : 'geplant';

export interface Day {
  date: string;
  from: string;
  to: string;
}

export interface GlassCustomer {
  id: string;
  name: string;
  address: string | null;
  note: string | null;
  contacts: {
    name: string;
    rolle?: string | undefined;
    telefon?: string | undefined;
    email?: string | undefined;
  }[];
  version: number;
}

export interface GlassObject {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  name: string;
  address: string | null;
  district: string | null;
  postal_code: string | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
  caretaker_email: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  per_year: number;
  parts: { name: string; per_year: number; hours: number }[];
  wish_months: number[][];
  plan_year: number | null;
  holiday_pref: string;
  needs_police_cert: boolean;
  needs_lift: boolean;
  needs_other: string | null;
  team: 'team_a' | 'team_b' | null;
  hours: string | null;
  default_staff: string | null;
  wishes: string | null;
  note: string | null;
  active: boolean;
  version: number;
}

export interface Appointment {
  id: string;
  object_id: string;
  object_name: string;
  object_address: string | null;
  district: string | null;
  customer_name: string | null;
  contact: string | null;
  phone: string | null;
  part: string | null;
  days: Day[];
  first_day: string;
  last_day: string;
  hours: string | null;
  interval: string;
  team: 'team_a' | 'team_b' | null;
  staff: string | null;
  note: string | null;
  confirmed: boolean;
  confirm_note: string | null;
  done: boolean;
  version: number;
}

export async function teamNames(sql: Sql) {
  const [s] = await sql<
    { team_a_name: string; team_b_name: string }[]
  >`select * from app.glass_settings where id = 1`;
  return { team_a: s?.team_a_name ?? 'Team A', team_b: s?.team_b_name ?? 'Team B' };
}

export async function saveTeamNames(sql: Sql, a: string, b: string) {
  if (!a.trim() || !b.trim()) throw new BusinessError('Bitte beide Teamnamen angeben');
  await sql`update app.glass_settings set team_a_name = ${a.trim()}, team_b_name = ${b.trim()} where id = 1`;
}

// ------------------------------------------------------------------ Lesen

export async function listCustomers(sql: Sql) {
  return sql<(GlassCustomer & { objects: number })[]>`
    select c.*, (select count(*)::int from app.glass_objects o where o.customer_id = c.id and o.active) as objects
      from app.glass_customers c order by c.name`;
}

export async function listObjects(sql: Sql, opts: { all?: boolean } = {}) {
  return sql<GlassObject[]>`
    select o.*, c.name as customer_name from app.glass_objects o
      left join app.glass_customers c on c.id = o.customer_id
     where ${opts.all ? sql`true` : sql`o.active`}
     order by c.name nulls last, o.name`;
}

export async function getObject(sql: Sql, id: string) {
  const [o] = await sql<GlassObject[]>`
    select o.*, c.name as customer_name from app.glass_objects o
      left join app.glass_customers c on c.id = o.customer_id where o.id = ${id}`;
  return o;
}

export async function listAppointments(sql: Sql, f: { from?: string; to?: string; objectId?: string } = {}) {
  return sql<Appointment[]>`
    select a.*, a.first_day::text, a.last_day::text, o.name as object_name, o.address as object_address, o.district,
           c.name as customer_name, coalesce(o.caretaker_name, o.contact_name) as contact,
           coalesce(o.caretaker_phone, o.contact_phone) as phone
      from app.glass_appointments a
      join app.glass_objects o on o.id = a.object_id
      left join app.glass_customers c on c.id = o.customer_id
     where ${f.from ? sql`a.last_day >= ${f.from}` : sql`true`}
       and ${f.to ? sql`a.first_day <= ${f.to}` : sql`true`}
       and ${f.objectId ? sql`a.object_id = ${f.objectId}` : sql`true`}
     order by a.first_day, (a.days -> 0 ->> 'from'), o.name`;
}

export async function getAppointment(sql: Sql, id: string) {
  const [a] = await listAppointmentsById(sql, id);
  return a;
}
const listAppointmentsById = (sql: Sql, id: string) => sql<Appointment[]>`
  select a.*, a.first_day::text, a.last_day::text, o.name as object_name, o.address as object_address, o.district,
         c.name as customer_name, coalesce(o.caretaker_name, o.contact_name) as contact,
         coalesce(o.caretaker_phone, o.contact_phone) as phone
    from app.glass_appointments a join app.glass_objects o on o.id = a.object_id
    left join app.glass_customers c on c.id = o.customer_id where a.id = ${id}`;

// ------------------------------------------------------------------ Schreiben

const t = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

export async function saveCustomer(
  sql: Sql,
  id: string,
  p: { name: string; address: string | null; note: string | null; contacts: GlassCustomer['contacts'] },
) {
  if (!p.name.trim()) throw new BusinessError('Kundenname fehlt');
  const contacts = p.contacts.filter((c) => c.name.trim());
  await sql`insert into app.glass_customers (id, name, address, note, contacts)
            values (${id}, ${p.name.trim()}, ${t(p.address)}, ${t(p.note)}, ${sql.json(contacts)})
            on conflict (id) do update set name = excluded.name, address = excluded.address, note = excluded.note,
              contacts = excluded.contacts`;
}

export type ObjectInput = Omit<GlassObject, 'id' | 'customer_name' | 'version' | 'active'> & {
  expectedVersion: number | null;
};

export async function saveObject(sql: Sql, id: string, p: ObjectInput) {
  if (!p.name.trim()) throw new BusinessError('Objektname fehlt');
  if (!p.customer_id) throw new BusinessError('Bitte einen Kunden wählen');
  if (!p.address?.trim()) throw new BusinessError('Adresse fehlt');
  if (!p.team) throw new BusinessError('Bitte ein Team zuordnen');
  if (!PER_YEAR.some(([n]) => n === p.per_year)) throw new BusinessError('Frequenz ungültig');
  for (const part of p.parts)
    if (!part.name.trim() || !PER_YEAR.some(([n]) => n === part.per_year) || !(part.hours >= 0))
      throw new BusinessError('Teilbereich unvollständig');
  const row = {
    customer_id: p.customer_id,
    name: p.name.trim(),
    address: t(p.address),
    district: t(p.district) ?? districtOf(plzOf(p.address)),
    postal_code: plzOf(p.address),
    caretaker_name: t(p.caretaker_name),
    caretaker_phone: t(p.caretaker_phone),
    caretaker_email: t(p.caretaker_email),
    contact_name: t(p.contact_name),
    contact_phone: t(p.contact_phone),
    contact_email: t(p.contact_email),
    per_year: p.per_year,
    parts: sql.json(p.parts as never),
    wish_months: sql.json(p.wish_months as never),
    plan_year: p.plan_year,
    holiday_pref: p.holiday_pref in HOLIDAY_PREF ? p.holiday_pref : 'egal',
    needs_police_cert: p.needs_police_cert,
    needs_lift: p.needs_lift,
    needs_other: t(p.needs_other),
    team: p.team,
    hours: p.hours,
    default_staff: t(p.default_staff),
    wishes: t(p.wishes),
    note: t(p.note),
  };
  const [cur] = await sql<{ version: number }[]>`select version from app.glass_objects where id = ${id}`;
  if (cur) {
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Das Objekt wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.glass_objects set ${sql(row as never)} where id = ${id}`;
  } else await sql`insert into app.glass_objects ${sql({ id, ...row } as never)} on conflict (id) do nothing`;
}

export async function setObjectActive(sql: Sql, id: string, active: boolean) {
  await sql`update app.glass_objects set active = ${active} where id = ${id}`;
}

export interface AppointmentInput {
  objectId: string;
  part: string | null;
  days: Day[];
  hours: number | null;
  interval: string;
  team: string | null;
  staff: string | null;
  note: string | null;
  confirmed: boolean;
  confirmNote: string | null;
  done: boolean;
  expectedVersion: number | null;
}

function checkDays(days: Day[]) {
  if (!days.length) throw new BusinessError('Bitte mindestens einen Tag angeben');
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new BusinessError('Datum fehlt');
    if (!/^\d{2}:\d{2}$/.test(d.from) || !/^\d{2}:\d{2}$/.test(d.to) || d.from >= d.to)
      throw new BusinessError(`${d.date}: Uhrzeit von/bis prüfen`);
  }
  if (new Set(days.map((d) => d.date)).size !== days.length) throw new BusinessError('Jeder Tag nur einmal');
  return [...days].sort((a, b) => a.date.localeCompare(b.date));
}
const hoursOf = (days: Day[]) =>
  days.reduce((a, d) => {
    const [h1, m1] = d.from.split(':').map(Number) as [number, number];
    const [h2, m2] = d.to.split(':').map(Number) as [number, number];
    return a + (h2 * 60 + m2 - h1 * 60 - m1) / 60;
  }, 0);

export async function saveAppointment(sql: Sql, id: string, p: AppointmentInput, actor: string) {
  const days = checkDays(p.days);
  if (!(p.interval in INTERVALS)) throw new BusinessError('Turnus ungültig');
  if (p.team && p.team !== 'team_a' && p.team !== 'team_b') throw new BusinessError('Team ungültig');
  const [o] = await sql`select 1 from app.glass_objects where id = ${p.objectId}`;
  if (!o) throw new BusinessError('Bitte ein Objekt wählen');
  const row = {
    object_id: p.objectId,
    part: t(p.part),
    days: sql.json(days as never),
    first_day: days[0]!.date,
    last_day: days.at(-1)!.date,
    hours: p.hours ?? Math.round(hoursOf(days) * 100) / 100,
    interval: p.interval,
    team: p.team || null,
    staff: t(p.staff),
    note: t(p.note),
    confirmed: p.confirmed,
    confirm_note: t(p.confirmNote),
  };
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ version: number; done: boolean }[]>`
      select version, done from app.glass_appointments where id = ${id} for update`;
    if (cur) {
      if (p.expectedVersion != null && cur.version !== p.expectedVersion)
        throw new BusinessError('Der Termin wurde zwischenzeitlich geändert – bitte neu laden');
      await tx`update app.glass_appointments set ${tx(row as never)} where id = ${id}`;
    } else
      await tx`insert into app.glass_appointments ${tx({ id, ...row, created_by: actor } as never)} on conflict (id) do nothing`;
  });
  if (p.done) await markDone(sql, id, actor);
  else await sql`update app.glass_appointments set done = false, done_at = null where id = ${id} and done`;
}

/** Erledigt: Folgetermin nach Turnus (gleiche Uhrzeiten, Tage verschoben) – genau einmal. */
export async function markDone(sql: Sql, id: string, actor: string): Promise<boolean> {
  const a = await getAppointment(sql, id);
  if (!a) throw new BusinessError('Termin nicht gefunden');
  if (!a.done) await sql`update app.glass_appointments set done = true, done_at = now() where id = ${id}`;
  const iv = INTERVALS[a.interval];
  if (!iv || !iv.days) return false;
  const days = a.days.map((d) => ({ ...d, date: addDays(d.date, iv.days) }));
  const r = await sql`
    insert into app.glass_appointments ${sql({
      id: uuidOf(`glass-follow:${id}`),
      object_id: a.object_id,
      part: a.part,
      days: sql.json(days as never),
      first_day: days[0]!.date,
      last_day: days.at(-1)!.date,
      hours: a.hours,
      interval: a.interval,
      team: a.team,
      staff: a.staff,
      follow_up_of: id,
      created_by: actor,
    } as never)} on conflict do nothing`;
  return r.count > 0;
}

export async function deleteAppointment(sql: Sql, id: string) {
  await sql`update app.glass_appointments set follow_up_of = null where follow_up_of = ${id}`;
  await sql`delete from app.glass_appointments where id = ${id}`;
}

/** Arbeitszeit-Vorschlag wie alte App: ≤ 9 h an einem Tag ab 08:00, sonst je 8 h (08–16) auf Werktage verteilt. */
export function suggestDays(start: string, hours: number, saturday = false): Day[] {
  const fmt = (h: number) =>
    `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  if (hours <= 9) return [{ date: start, from: '08:00', to: fmt(8 + Math.max(0.5, hours)) }];
  const n = Math.ceil(hours / 8);
  const out: Day[] = [];
  let d = start;
  let rest = hours;
  while (out.length < n) {
    if (isWorkday(d, saturday)) {
      const h = Math.min(8, rest);
      out.push({ date: d, from: '08:00', to: fmt(8 + h) });
      rest -= h;
    }
    d = addDays(d, 1);
  }
  return out;
}
export const isWorkday = (d: string, saturday = false) => {
  const wd = isoWeekday(d);
  return wd !== 7 && (wd !== 6 || saturday) && !holidayName(d);
};

// ------------------------------------------------------------------ Offene Planung

export interface Unit {
  label: string;
  part: string | null;
  perYear: number;
  hours: number;
}
export const unitsOf = (o: GlassObject): Unit[] => [
  { label: 'Gesamt', part: null, perYear: o.per_year, hours: Number(o.hours ?? 0) },
  ...o.parts.map((p) => ({ label: p.name, part: p.name, perYear: p.per_year, hours: p.hours })),
];

export async function openPlanning(sql: Sql, year: number) {
  const [objects, apps] = await Promise.all([
    listObjects(sql),
    listAppointments(sql, { from: `${year}-01-01`, to: `${year}-12-31` }),
  ]);
  return objects.map((o) => {
    const units = unitsOf(o).map((u) => {
      const ist = apps.filter(
        (a) => a.object_id === o.id && (a.part ?? null) === u.part && a.first_day.startsWith(String(year)),
      ).length;
      const open = Math.max(0, u.perYear - ist);
      return { ...u, ist, open, restHours: open * u.hours };
    });
    return {
      o,
      units,
      open: units.reduce((a, u) => a + u.open, 0),
      restHours: units.reduce((a, u) => a + u.restHours, 0),
    };
  });
}

// ------------------------------------------------------------------ Auto-Planung (Punktesystem der alten App)

export interface Proposal {
  objectId: string;
  objectName: string;
  part: string | null;
  team: 'team_a' | 'team_b';
  days: Day[];
  hours: number;
  month: number;
}

function travelMinutes(a: string | null, b: string | null) {
  if (!a || !b) return 40;
  if (a === b) return 10;
  if (a.slice(0, 3) === b.slice(0, 3)) return 15;
  if (a.startsWith('8') && b.startsWith('8')) return 25;
  return 40;
}

export async function autoPlan(
  sql: Sql,
  p: { year: number; objectIds: string[]; saturday: boolean },
): Promise<Proposal[]> {
  const today = todayBerlin();
  const plan = (await openPlanning(sql, p.year))
    .filter((x) => p.objectIds.includes(x.o.id) && x.open > 0)
    .sort(
      (x, y) =>
        Number(y.o.holiday_pref === 'waehrend') - Number(x.o.holiday_pref === 'waehrend') ||
        (x.o.district ?? '').localeCompare(y.o.district ?? '') ||
        x.o.name.localeCompare(y.o.name),
    );
  const existing = await listAppointments(sql, { from: `${p.year}-01-01`, to: `${p.year}-12-31` });
  const dayHours = new Map<string, number>();
  const dayPlz = new Map<string, string[]>();
  const weekLoad = new Map<string, number>();
  const objDates = new Map<string, string[]>();
  const week = (d: string) => addDays(d, 1 - isoWeekday(d));
  const book = (objectId: string, plz: string | null, days: Day[]) => {
    for (const d of days) {
      dayHours.set(d.date, (dayHours.get(d.date) ?? 0) + hoursOf([d]));
      if (plz) dayPlz.set(d.date, [...(dayPlz.get(d.date) ?? []), plz]);
    }
    weekLoad.set(week(days[0]!.date), (weekLoad.get(week(days[0]!.date)) ?? 0) + 1);
    objDates.set(objectId, [...(objDates.get(objectId) ?? []), days[0]!.date]);
  };
  for (const a of existing) book(a.object_id, null, a.days);
  const teamCount = { team_a: 0, team_b: 0 };
  const out: Proposal[] = [];
  for (const { o, units } of plan) {
    const plz = o.postal_code ?? plzOf(o.address);
    for (const u of units) {
      if (!u.open) continue;
      const hours = u.hours || 2;
      for (let i = u.perYear - u.open; i < u.perYear; i++) {
        const wish = o.wish_months[i]?.length ? o.wish_months[i]! : null;
        const startMonth = o.wish_months[0]?.[0] ?? 1;
        const months = wish ?? [((startMonth - 1 + i * Math.round(12 / u.perYear)) % 12) + 1];
        let best: { date: string; score: number } | null = null;
        for (const m of months) {
          const first = `${p.year}-${String(m).padStart(2, '0')}-01`;
          for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) {
            if (d <= today) continue;
            const wd = isoWeekday(d);
            if (wd === 7 || (wd === 6 && !p.saturday) || holidayName(d)) continue;
            const ferien = !!schoolHoliday(d);
            if (o.holiday_pref === 'ausserhalb' && ferien) continue;
            let s = 100;
            if (wd <= 5) s += 20;
            else s -= 10;
            if (wd >= 2 && wd <= 4) s += 10;
            if (ferien && o.holiday_pref === 'waehrend') s += 30;
            if (!ferien && o.holiday_pref === 'waehrend') s -= 40;
            if (!ferien && o.holiday_pref === 'ausserhalb') s += 20;
            if (wd <= 5 && (holidayName(addDays(d, -1)) || holidayName(addDays(d, 1)))) s -= 15; // Brückentag
            s -= (weekLoad.get(week(d)) ?? 0) * 8;
            const days = suggestDays(d, hours, p.saturday);
            const free = days.every((x) => (dayHours.get(x.date) ?? 0) + hoursOf([x]) <= 8);
            if (!free) s -= 2000;
            else s -= (dayHours.get(d) ?? 0) * 1.5;
            for (const other of dayPlz.get(d) ?? []) {
              const min = travelMinutes(plz, other);
              s += min <= 15 ? 25 : min <= 30 ? 12 : min >= 50 ? -15 : 0;
            }
            if ((objDates.get(o.id) ?? []).some((x) => Math.abs(Date.parse(x) - Date.parse(d)) < 120 * 864e5))
              s -= 1000;
            if (!best || s > best.score) best = { date: d, score: s };
          }
        }
        if (!best) continue;
        let days = suggestDays(best.date, hours, p.saturday);
        const used = dayHours.get(best.date) ?? 0;
        if (used > 0 && days.length === 1) {
          const start = 8 + used + 0.5;
          const fmt = (h: number) =>
            `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
          days = [{ date: best.date, from: fmt(start), to: fmt(Math.min(23.5, start + hours)) }];
        }
        const team = o.team ?? (teamCount.team_a <= teamCount.team_b ? 'team_a' : 'team_b');
        teamCount[team]++;
        book(o.id, plz, days);
        out.push({
          objectId: o.id,
          objectName: o.name,
          part: u.part,
          team,
          days,
          hours,
          month: Number(best.date.slice(5, 7)),
        });
      }
    }
  }
  return out.sort((a, b) => a.days[0]!.date.localeCompare(b.days[0]!.date));
}

export async function applyProposals(sql: Sql, list: Proposal[], actor: string) {
  let n = 0;
  for (const pr of list) {
    const id = uuidOf(`glass-auto:${pr.objectId}:${pr.part ?? ''}:${pr.days[0]!.date}`);
    const r = await sql`
      insert into app.glass_appointments ${sql({
        id,
        object_id: pr.objectId,
        part: pr.part,
        days: sql.json(pr.days as never),
        first_day: pr.days[0]!.date,
        last_day: pr.days.at(-1)!.date,
        hours: pr.hours,
        interval: 'einmalig',
        team: pr.team,
        created_by: actor,
      } as never)} on conflict (id) do nothing`;
    n += r.count;
  }
  return n;
}

// ------------------------------------------------------------------ CSV

export function appointmentsCsv(list: Appointment[], teams: { team_a: string; team_b: string }) {
  const q = (s: string | null | undefined) => {
    const v = (s ?? '').replace(/"/g, '""');
    return /^[=+\-@]/.test(v) ? `"'${v}"` : `"${v}"`;
  };
  const rows = list.map((a) =>
    [
      a.days.map((d) => d.date.split('-').reverse().join('.')).join(' + '),
      a.days.map((d) => `${d.from}–${d.to}`).join(' + '),
      q(a.object_name),
      q(a.object_address),
      q(a.district),
      q(a.contact),
      q(a.phone),
      String(a.hours ?? '').replace('.', ','),
      INTERVALS[a.interval]?.label ?? a.interval,
      q([a.team ? teams[a.team] : null, a.staff].filter(Boolean).join(' · ')),
      STATUS_LABEL[statusOf(a)][0],
      q(a.note),
    ].join(';'),
  );
  return `\uFEFFDatum;Uhrzeit;Objekt;Adresse;Bezirk;Kontakt;Telefon;Dauer (h);Turnus;Mitarbeiter;Status;Notiz\r\n${rows.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ Import alte App

export async function importLegacyGlass(
  sql: Sql,
  data: {
    objekte: Record<string, unknown>[];
    termine: Record<string, unknown>[];
    kunden?: Record<string, unknown>[];
  },
  actor: string,
) {
  const s = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  let customers = 0;
  let objects = 0;
  let apps = 0;
  const custId = new Map<string, string>();
  for (const k of data.kunden ?? []) {
    const id = uuidOf(`gpk:${String(k.id)}`);
    const r = await sql`insert into app.glass_customers ${sql({
      id,
      name: s(k.name) ?? '(ohne Name)',
      address: s(k.adresse),
      note: s(k.notiz),
      contacts: sql.json((Array.isArray(k.ansprechpartner) ? k.ansprechpartner : []) as never),
      legacy_id: `gpk:${String(k.id)}`,
    } as never)} on conflict (legacy_id) do nothing`;
    customers += r.count;
    custId.set(String(k.id), id);
  }
  const objMap = new Map<string, string>();
  for (const o of data.objekte) {
    // Kunden ohne eigene Tabelle im Backup: aus dem Kundennamen am Objekt anlegen
    const kname = s(o.kunde) ?? '(ohne Kunde)';
    const key = s(o.kunde_id) ?? `name:${kname}`;
    let cid = custId.get(key);
    if (!cid) {
      cid = uuidOf(`gpk:${key}`);
      const r =
        await sql`insert into app.glass_customers ${sql({ id: cid, name: kname, legacy_id: `gpk:${key}` } as never)}
                          on conflict (legacy_id) do nothing`;
      customers += r.count;
      custId.set(key, cid);
    }
    const id = uuidOf(`gpo:${String(o.id)}`);
    objMap.set(String(o.id), id);
    const per = [1, 2, 3, 4, 6, 12].includes(Number(o.frequenz_pro_jahr)) ? Number(o.frequenz_pro_jahr) : 1;
    const wish = Array.isArray(o.wunschmonate)
      ? (o.wunschmonate as unknown[]).map((x) =>
          Array.isArray(x) ? x.map(Number).filter((n) => n >= 1 && n <= 12) : [],
        )
      : o.wunschmonat
        ? [[Number(o.wunschmonat)]]
        : [];
    const parts = (Array.isArray(o.teilbereiche) ? o.teilbereiche : []) as Record<string, unknown>[];
    const address = s(o.adresse);
    const r = await sql`insert into app.glass_objects ${sql({
      id,
      customer_id: cid,
      name: s(o.name) ?? '(ohne Name)',
      address,
      district: s(o.bezirk) ?? districtOf(plzOf(address)),
      postal_code: plzOf(address),
      caretaker_name: s(o.hausmeister_name),
      caretaker_phone: s(o.hausmeister_telefon),
      caretaker_email: s(o.hausmeister_email),
      contact_name: s(o.kontaktname),
      contact_phone: s(o.telefon),
      contact_email: s(o.email),
      per_year: per,
      parts: sql.json(
        parts
          .filter((x) => s(x.name))
          .map((x) => ({
            name: s(x.name),
            per_year: [1, 2, 3, 4, 6, 12].includes(Number(x.frequenz)) ? Number(x.frequenz) : 1,
            hours: Number(x.dauer) || 0,
          })) as never,
      ),
      wish_months: sql.json(wish as never),
      plan_year: Number(o.wunschjahr) || null,
      holiday_pref: ['egal', 'waehrend', 'ausserhalb'].includes(String(o.ferienpraeferenz))
        ? String(o.ferienpraeferenz)
        : 'egal',
      needs_police_cert: o.anf_fuehrungszeugnis === true,
      needs_lift: o.anf_hebebuehne === true,
      needs_other: o.anf_sonstiges_aktiv ? s(o.anf_sonstiges_text) : null,
      team: o.team === 'team_b' ? 'team_b' : o.team === 'team_a' ? 'team_a' : null,
      hours: Number(o.standarddauer) || null,
      default_staff: s(o.standardmitarbeiter),
      wishes: s(o.sonderwuensche),
      note: s(o.notiz),
      legacy_id: `gpo:${String(o.id)}`,
    } as never)} on conflict (legacy_id) do nothing`;
    objects += r.count;
  }
  for (const a of data.termine) {
    const oid = objMap.get(String(a.objektid));
    if (!oid) continue;
    let days: Day[] = (Array.isArray(a.tage) ? a.tage : [])
      .map((d) => d as Record<string, unknown>)
      .filter((d) => s(d.datum))
      .map((d) => ({
        date: String(d.datum).slice(0, 10),
        from: String(d.von ?? '08:00').slice(0, 5),
        to: String(d.bis ?? '16:00').slice(0, 5),
      }));
    if (!days.length && s(a.datum))
      days = [
        {
          date: String(a.datum).slice(0, 10),
          from: String(a.uhrzeit ?? '08:00').slice(0, 5),
          to: String(a.uhrzeit_bis ?? '16:00').slice(0, 5),
        },
      ];
    if (!days.length) continue;
    days.sort((x, y) => x.date.localeCompare(y.date));
    const iv = String(a.intervall ?? 'einmalig');
    const r = await sql`insert into app.glass_appointments ${sql({
      id: uuidOf(`gpt:${String(a.id)}`),
      object_id: oid,
      part: s(a.teilbereich),
      days: sql.json(days as never),
      first_day: days[0]!.date,
      last_day: days.at(-1)!.date,
      hours: Number(a.dauerstunden) || null,
      interval: iv in INTERVALS ? iv : (LEGACY_INTERVAL[iv] ?? 'einmalig'),
      team: a.team === 'team_b' ? 'team_b' : a.team === 'team_a' ? 'team_a' : null,
      staff: s(a.mitarbeiter),
      note: s(a.notiz),
      confirmed: a.bestaetigt === true,
      confirm_note: s(a.bestaetigung_notiz),
      done: a.erledigt === true,
      legacy_id: `gpt:${String(a.id)}`,
      created_by: actor,
    } as never)} on conflict (legacy_id) do nothing`;
    apps += r.count;
  }
  return { customers, objects, apps };
}
