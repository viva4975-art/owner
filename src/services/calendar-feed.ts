/**
 * Kalender-Abo (Ahmed 09.10.: „Kalender mit iOS/Outlook synchronisieren“): je Benutzer bzw. Mitarbeiter ein geheimer
 * ICS-Link (webcal://…). iPhone, Outlook und Google laden ihn regelmäßig neu – nur lesen, Änderungen in der App.
 * Inhalt Büro: eigene Einsätze (verknüpfter Mitarbeiter), Aufgaben (mir zugewiesen oder ohne Zuständigkeit),
 * Ausschreibungs-Termine, Glas- und Tiefgaragen-Termine; Objektleitung: Aufgaben + eigene Einsätze; Mitarbeiter-App:
 * eigene Einsätze. Zeitraum: 14 Tage zurück bis 90 Tage voraus.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { taskVisibleTo } from './crm.js';
import { plannedShifts } from './time.js';

export type FeedOwner = { userId: string } | { employeeId: string };

export async function feedToken(sql: Sql, owner: FeedOwner, renew = false): Promise<string> {
  const col = 'userId' in owner ? sql`user_id` : sql`employee_id`;
  const val = 'userId' in owner ? owner.userId : owner.employeeId;
  const [cur] = await sql<{ token: string }[]>`select token from app.calendar_feeds where ${col} = ${val}`;
  if (cur && !renew) return cur.token;
  const token = randomBytes(24).toString('base64url');
  if (cur)
    await sql`update app.calendar_feeds set token = ${token}, created_at = now() where ${col} = ${val}`;
  else
    await sql`insert into app.calendar_feeds (id, user_id, employee_id, token)
              values (${randomUUID()}, ${'userId' in owner ? owner.userId : null},
                      ${'employeeId' in owner ? owner.employeeId : null}, ${token})
              on conflict do nothing`;
  const [r] = await sql<{ token: string }[]>`select token from app.calendar_feeds where ${col} = ${val}`;
  return r!.token;
}

interface Ev {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  /** ganztägig: JJJJ-MM-TT (bis = einschließlich) */
  day?: { from: string; to: string };
  /** mit Uhrzeit (Ortszeit Berlin) */
  at?: { date: string; start: string; end: string };
}

const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Zeilen nach RFC 5545 auf 75 Zeichen falten */
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
};
const d8 = (d: string) => d.replace(/-/g, '');
const t6 = (t: string) => `${t.replace(':', '').slice(0, 4)}00`;

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

export function renderIcs(name: string, events: Ev[]): string {
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Viva-Deluxe//Betriebs-App//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE,
  ];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@viva-deluxe-reinigung.de`, `DTSTAMP:${stamp}`);
    if (e.at) {
      lines.push(`DTSTART;TZID=Europe/Berlin:${d8(e.at.date)}T${t6(e.at.start)}`);
      const endDate = e.at.end <= e.at.start ? addDays(e.at.date, 1) : e.at.date;
      lines.push(`DTEND;TZID=Europe/Berlin:${d8(endDate)}T${t6(e.at.end)}`);
    } else if (e.day) {
      lines.push(`DTSTART;VALUE=DATE:${d8(e.day.from)}`, `DTEND;VALUE=DATE:${d8(addDays(e.day.to, 1))}`);
    }
    lines.push(`SUMMARY:${esc(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

const hm = (d: Date) =>
  d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const dayOf = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

async function shiftEvents(sql: Sql, employeeId: string, from: string, to: string): Promise<Ev[]> {
  const shifts = await plannedShifts(sql, { from, to, employeeId });
  const sites = await sql<
    { id: string; street: string | null; postal_code: string | null; city: string | null }[]
  >`
    select id, street, postal_code, city from app.sites where id = any(${[...new Set(shifts.map((s) => s.plan.site_id))]}::uuid[])`;
  const addr = new Map(
    sites.map((s) => [
      s.id,
      [s.street, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    ]),
  );
  return shifts
    .filter((s) => !s.absence && !s.holiday && s.exception?.kind !== 'ausfall')
    .map((s) => ({
      uid: `einsatz-${s.plan.id}-${s.date}`,
      summary: `Einsatz: ${s.plan.site_name}`,
      location: addr.get(s.plan.site_id) || null,
      description: s.plan.note,
      at: { date: s.date, start: s.plan.start_time, end: s.plan.end_time },
    }));
}

/** Einzelaufträge mit Termin (eigene bzw. alle offenen fürs Büro) */
async function orderEvents(sql: Sql, employeeId: string | null, from: string, to: string): Promise<Ev[]> {
  const rows = await sql<
    {
      id: string;
      number: string;
      title: string;
      planned_date: string;
      start_time: string | null;
      end_time: string | null;
      place: string | null;
      description: string | null;
      customer_name: string;
      site_name: string | null;
      site_addr: string | null;
      order_reference: string | null;
    }[]
  >`select o.id, o.number, o.title, o.planned_date, to_char(o.start_time, 'HH24:MI') as start_time,
           to_char(o.end_time, 'HH24:MI') as end_time, o.place, o.description, c.name as customer_name,
           s.name as site_name, concat_ws(', ', s.street, concat_ws(' ', s.postal_code, s.city)) as site_addr,
           o.order_reference
      from app.orders o join app.customers c on c.id = o.customer_id left join app.sites s on s.id = o.site_id
     where o.status in ('offen', 'in_arbeit') and o.planned_date between ${from} and ${to}
       and ${employeeId ? sql`${employeeId}::uuid = any(o.employee_ids)` : sql`true`}`;
  return rows.map((o) => {
    const ev: Ev = {
      uid: `auftrag-${o.id}`,
      summary: `Auftrag ${o.number}: ${o.title} (${o.customer_name})`,
      location: o.place ?? o.site_addr ?? o.site_name,
      description: [o.order_reference ? `Bestellnummer ${o.order_reference}` : null, o.description]
        .filter(Boolean)
        .join('\n'),
    };
    if (o.start_time)
      ev.at = {
        date: o.planned_date,
        start: o.start_time,
        end:
          o.end_time ??
          `${String(Math.min(23, Number(o.start_time.slice(0, 2)) + 1)).padStart(2, '0')}${o.start_time.slice(2)}`,
      };
    else ev.day = { from: o.planned_date, to: o.planned_date };
    return ev;
  });
}

export async function feedIcs(sql: Sql, token: string): Promise<{ name: string; ics: string } | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const [f] = await sql<{ id: string; user_id: string | null; employee_id: string | null }[]>`
    select id, user_id, employee_id from app.calendar_feeds where token = ${token}`;
  if (!f) return null;
  await sql`update app.calendar_feeds set last_fetched_at = now() where id = ${f.id}`;
  const today = todayBerlin();
  const from = addDays(today, -14);
  const to = addDays(today, 90);
  const events: Ev[] = [];
  if (f.employee_id) {
    const [e] = await sql<{ status: string }[]>`select status from app.employees where id = ${f.employee_id}`;
    if (!e || e.status !== 'aktiv') return null;
    events.push(...(await shiftEvents(sql, f.employee_id, from, to)));
    events.push(...(await orderEvents(sql, f.employee_id, from, to)));
    return { name: 'Viva-Deluxe Einsätze', ics: renderIcs('Viva-Deluxe Einsätze', events) };
  }
  const [u] = await sql<
    { role: string; name: string; login: string; active: boolean; employee_id: string | null }[]
  >`
    select p.role::text as role, p.display_name as name, a.login, a.active, p.employee_id
      from app.user_accounts a join app.profiles p on p.user_id = a.id where a.id = ${f.user_id}`;
  if (!u || !u.active) return null;
  if (u.employee_id) events.push(...(await shiftEvents(sql, u.employee_id, from, to)));
  // Einzelaufträge: Büro alle, Objektleitung nur die, bei denen sie eingeteilt ist
  if (u.role !== 'objektleitung') events.push(...(await orderEvents(sql, null, from, to)));
  else if (u.employee_id) events.push(...(await orderEvents(sql, u.employee_id, from, to)));
  const tasks = await sql<{ id: string; title: string; description: string | null; due_date: string }[]>`
    select id, title, description, due_date from app.tasks t
     where status::text = 'open' and due_date between ${from} and ${to}
       and ${
         u.role === 'objektleitung'
           ? taskVisibleTo(sql, { names: [u.name, u.login], actor: u.login })
           : sql`(assignee is null or assignee = '' or lower(assignee) = lower(${u.name}))`
       }`;
  for (const t of tasks)
    events.push({
      uid: `aufgabe-${t.id}`,
      summary: `Aufgabe: ${t.title}`,
      description: t.description,
      day: { from: t.due_date, to: t.due_date },
    });
  if (u.role !== 'objektleitung') {
    const tenders = await sql<
      {
        id: string;
        title: string;
        deadline_at: Date | null;
        questions_until: Date | null;
        site_visit_at: Date | null;
        url: string | null;
      }[]
    >`select id, title, deadline_at, questions_until, site_visit_at, url from app.tenders
       where status in ('neu', 'pruefen', 'bearbeitung') and coalesce(deadline_at, questions_until, site_visit_at) is not null`;
    for (const t of tenders)
      for (const [k, label, at] of [
        ['frist', 'Abgabefrist', t.deadline_at],
        ['fragen', 'Bieterfragen bis', t.questions_until],
        ['besichtigung', 'Ortsbesichtigung', t.site_visit_at],
      ] as const) {
        if (!at) continue;
        const date = dayOf(at);
        if (date < from || date > to) continue;
        const start = hm(at);
        const end = hm(new Date(at.getTime() + (k === 'besichtigung' ? 60 : 30) * 60000));
        events.push({
          uid: `ausschreibung-${k}-${t.id}`,
          summary: `${label}: ${t.title}`,
          description: t.url,
          at: { date, start, end },
        });
      }
    const glass = await sql<
      {
        id: string;
        first_day: string;
        last_day: string;
        name: string;
        address: string | null;
        part: string | null;
        team: string | null;
      }[]
    >`
      select a.id, a.first_day, a.last_day, o.name, o.address, a.part, a.team
        from app.glass_appointments a join app.glass_objects o on o.id = a.object_id
       where not a.done and a.last_day >= ${from} and a.first_day <= ${to}`;
    for (const g of glass)
      events.push({
        uid: `glas-${g.id}`,
        summary: `Glasreinigung: ${g.name}${g.part ? ` (${g.part})` : ''}`,
        location: g.address,
        description: g.team ? `Team ${g.team}` : null,
        day: { from: g.first_day, to: g.last_day },
      });
    const tg = await sql<
      {
        id: string;
        first_day: string;
        last_day: string;
        name: string;
        address: string | null;
        city: string | null;
        kind: string | null;
      }[]
    >`
      select a.id, a.first_day, a.last_day, o.name, o.address, o.city, a.kind
        from app.tg_appointments a join app.tg_objects o on o.id = a.object_id
       where not a.done and a.last_day >= ${from} and a.first_day <= ${to}`;
    for (const g of tg)
      events.push({
        uid: `tg-${g.id}`,
        summary: `Tiefgarage: ${g.name}`,
        location: [g.address, g.city].filter(Boolean).join(', ') || null,
        description: g.kind,
        day: { from: g.first_day, to: g.last_day },
      });
  }
  return { name: 'Viva-Deluxe', ics: renderIcs('Viva-Deluxe', events) };
}
