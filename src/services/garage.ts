import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { Quantity } from '../domain/money/money.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { pdfFonts } from '../pdf/render.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';
import { getSeller } from './masterdata.js';
import { saveWorkReport } from './orders.js';

/*
 * Tiefgaragenplanung (wie die alte App): Objekte von Münchner Wohnen / Dawonia, Termine (auch mehrtägig), Auto-Planer
 * (Objekte nach Dauer auf Mo–Fr packen), Aushänge, Arbeitsscheine mit der Dawonia-Positionsliste.
 */

export const TG_CUSTOMERS = ['Münchner Wohnen GmbH', 'Dawonia', 'Zeus Property Management'];
export const TG_KINDS = ['Nassreinigung', 'Kehren', 'Grundreinigung', 'Sonstige'];

export interface TgObject {
  id: string;
  customer: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  sqm: number | null;
  we_no: string | null;
  spaces_fixed: number | null;
  spaces_duplex: number | null;
  duration: string | null;
  tob_name: string | null;
  tob_email: string | null;
  deputy_email: string | null;
  tob_mobile: string | null;
  owner_company: string | null;
  object_no: string | null;
  site_id: string | null;
  active: boolean;
  paused: boolean;
  version: number;
}
export interface Day {
  date: string;
  from: string;
  to: string;
}
export interface TgAppointment {
  id: string;
  object_id: string;
  days: Day[];
  first_day: string;
  last_day: string;
  kind: string;
  note: string | null;
  confirmed: boolean;
  done: boolean;
  work_report_id: string | null;
  version: number;
}

export async function listTgObjects(sql: Sql) {
  return sql<TgObject[]>`select * from app.tg_objects order by postal_code nulls last, name`;
}
export async function getTgObject(sql: Sql, id: string) {
  const [o] = await sql<TgObject[]>`select * from app.tg_objects where id = ${id}`;
  return o;
}
export async function listTgAppointments(sql: Sql, objectId?: string) {
  return sql<TgAppointment[]>`
    select a.*, a.first_day::text, a.last_day::text from app.tg_appointments a
     where ${objectId ? sql`a.object_id = ${objectId}` : sql`true`} order by a.first_day, a.created_at`;
}
export async function getTgAppointment(sql: Sql, id: string) {
  const [a] = await sql<
    TgAppointment[]
  >`select *, first_day::text, last_day::text from app.tg_appointments where id = ${id}`;
  return a;
}

const t = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
const int = (v: number | null) => (v == null || Number.isNaN(v) ? null : Math.max(0, Math.round(v)));

export type TgObjectInput = Omit<TgObject, 'id' | 'version'> & { expectedVersion: number | null };

export async function saveTgObject(sql: Sql, id: string, p: TgObjectInput) {
  if (!p.name.trim()) throw new BusinessError('Objekt / Liegenschaft fehlt');
  if (p.postal_code && !/^\d{5}$/.test(p.postal_code)) throw new BusinessError('PLZ muss 5-stellig sein');
  const row = {
    customer: p.customer.trim() || TG_CUSTOMERS[0]!,
    name: p.name.trim(),
    address: t(p.address),
    postal_code: t(p.postal_code),
    city: t(p.city),
    sqm: int(p.sqm),
    we_no: t(p.we_no),
    spaces_fixed: int(p.spaces_fixed),
    spaces_duplex: int(p.spaces_duplex),
    duration: t(p.duration),
    tob_name: t(p.tob_name),
    tob_email: t(p.tob_email),
    deputy_email: t(p.deputy_email),
    tob_mobile: t(p.tob_mobile),
    owner_company: t(p.owner_company),
    object_no: t(p.object_no),
    site_id: p.site_id || null,
    active: p.active,
    paused: p.paused,
  };
  const [cur] = await sql<{ version: number }[]>`select version from app.tg_objects where id = ${id}`;
  if (cur) {
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Das Objekt wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.tg_objects set ${sql(row)} where id = ${id}`;
  } else await sql`insert into app.tg_objects ${sql({ id, ...row })} on conflict (id) do nothing`;
}

export async function deleteTgObject(sql: Sql, id: string) {
  const [x] =
    await sql`select 1 from app.tg_appointments where object_id = ${id} and (done or work_report_id is not null)`;
  if (x)
    throw new BusinessError(
      'Objekt hat erledigte Termine/Arbeitsscheine – bitte stattdessen auf „inaktiv“ setzen',
    );
  await sql`delete from app.tg_objects where id = ${id}`;
}

export async function setPausedAll(sql: Sql, paused: boolean, customer: string | null) {
  await sql`update app.tg_objects set paused = ${paused} where active and ${customer ? sql`customer = ${customer}` : sql`true`}`;
}

function checkDays(days: Day[]) {
  if (!days.length) throw new BusinessError('Bitte mindestens einen Tag angeben');
  for (const d of days)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
      !/^\d{2}:\d{2}$/.test(d.from) ||
      !/^\d{2}:\d{2}$/.test(d.to) ||
      d.from >= d.to
    )
      throw new BusinessError('Tag/Uhrzeit prüfen (von vor bis)');
  return [...days].sort((a, b) => a.date.localeCompare(b.date));
}

export async function saveTgAppointment(
  sql: Sql,
  id: string,
  p: { objectId: string; days: Day[]; kind: string; note: string | null; expectedVersion: number | null },
  actor: string,
) {
  const days = checkDays(p.days);
  if (!TG_KINDS.includes(p.kind)) throw new BusinessError('Leistungsart ungültig');
  const row = {
    object_id: p.objectId,
    days: sql.json(days as never),
    first_day: days[0]!.date,
    last_day: days.at(-1)!.date,
    kind: p.kind,
    note: t(p.note),
  };
  const [cur] = await sql<
    { version: number; done: boolean }[]
  >`select version, done from app.tg_appointments where id = ${id}`;
  if (cur) {
    if (cur.done) throw new BusinessError('Abgeschlossene Termine sind nicht mehr änderbar – erst „↩“');
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Der Termin wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.tg_appointments set ${sql(row as never)} where id = ${id}`;
  } else
    await sql`insert into app.tg_appointments ${sql({ id, ...row, created_by: actor } as never)} on conflict (id) do nothing`;
}

export async function setTgFlag(sql: Sql, id: string, flag: 'confirmed' | 'done', value: boolean) {
  if (flag === 'confirmed') await sql`update app.tg_appointments set confirmed = ${value} where id = ${id}`;
  else await sql`update app.tg_appointments set done = ${value} where id = ${id}`;
}

export async function deleteTgAppointment(sql: Sql, id: string) {
  const [a] = await sql<
    { work_report_id: string | null }[]
  >`select work_report_id from app.tg_appointments where id = ${id}`;
  if (a?.work_report_id)
    throw new BusinessError('Zum Termin gibt es einen Arbeitsschein – Termin bleibt erhalten');
  await sql`delete from app.tg_appointments where id = ${id}`;
}

// ------------------------------------------------------------------ Arbeitsschein (Dawonia-Positionsliste)

export const DAWONIA_POSITIONS: [string, string, 'psch' | 'stk' | 'duplex'][] = [
  ['01.01', 'Wände und Stützsäulen, soweit vorhanden', 'psch'],
  ['01.02', 'Bodenflächen', 'psch'],
  ['02.01', 'Reinigung von Installationen und Einbauten', 'psch'],
  ['03.01', 'Trockenreinigung Stellplatz – Bodenflächen', 'stk'],
  ['03.02', 'Trockenreinigung Zu- und Ausfahrten', 'psch'],
  ['03.03', 'Trockenreinigung Zu- und Ausgänge', 'psch'],
  ['04.01', 'Nassreinigung Stellplatz – Bodenflächen', 'stk'],
  ['04.02', 'Nassreinigung Stellplatz – Wandflächen, soweit vorhanden', 'stk'],
  ['04.03', 'Nassreinigung Zu- und Ausfahrten', 'psch'],
  ['04.04', 'Nassreinigung Zu- und Ausgänge', 'psch'],
  ['05.01', 'Trockenreinigung Duplexgrube', 'duplex'],
  ['05.02', 'Trockenreinigung Duplexparkfläche', 'duplex'],
  ['05.03', 'Nassreinigung Duplexparkfläche', 'duplex'],
];

/** Arbeitsschein-Entwurf zum Termin (feste ID → nichts doppelt). Braucht ein verknüpftes Objekt (Kostenstelle). */
export async function createWorkReport(sql: Sql, appointmentId: string, actor: string): Promise<string> {
  const a = await getTgAppointment(sql, appointmentId);
  if (!a) throw new BusinessError('Termin nicht gefunden');
  if (a.work_report_id) return a.work_report_id;
  const o = (await getTgObject(sql, a.object_id))!;
  if (!o.site_id)
    throw new BusinessError(
      'Für den Arbeitsschein bitte das TG-Objekt mit einem Objekt (Kostenstelle) verknüpfen',
    );
  const dawonia = /dawonia/i.test(o.customer);
  const q = (n: number) => BigInt(n * 1000) as Quantity;
  const lines = dawonia
    ? DAWONIA_POSITIONS.filter(([, , u]) => u !== 'duplex' || (o.spaces_duplex ?? 0) > 0).map(
        ([nr, text, u]) => ({
          description: `${nr} ${text}`,
          quantity: q(
            u === 'psch' ? 1 : u === 'stk' ? (o.spaces_fixed ?? 0) || 1 : (o.spaces_duplex ?? 0) || 1,
          ),
          unitCode: u === 'psch' ? 'LS' : 'C62',
        }),
      )
    : [{ description: `Tiefgaragenreinigung – ${a.kind}`, quantity: q(1), unitCode: 'LS' }];
  const id = uuidOf(`tg-as:${appointmentId}`);
  const [exists] = await sql`select 1 from app.work_reports where id = ${id}`;
  if (!exists)
    await saveWorkReport(
      sql,
      id,
      {
        orderId: null,
        siteId: o.site_id,
        workDate: a.first_day,
        startTime: a.days[0]!.from,
        endTime: a.days[0]!.to,
        employeeIds: [],
        description: [
          `Tiefgaragenreinigung (${a.kind})`,
          dawonia && o.owner_company ? `${o.owner_company} · Dawonia Süd` : o.customer,
          [o.name, [o.postal_code, o.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
          o.we_no ? `Kostenstelle WE ${o.we_no}` : o.object_no ? `Kostenstelle ${o.object_no}` : null,
          a.days.length > 1 ? `Zeitraum ${formatDateDe(a.first_day)} – ${formatDateDe(a.last_day)}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        materials: null,
        remarks: null,
        lines,
        expectedVersion: null,
      },
      actor,
    );
  await sql`update app.tg_appointments set work_report_id = ${id} where id = ${appointmentId} and work_report_id is null`;
  return id;
}

// ------------------------------------------------------------------ Auto-Planer

/** Dauer aus dem Freitext in Minuten („4 Std.“, „1 Tag“, „1/2 Tag“, „3“) – null = unbekannt. */
export function durationMinutes(raw: string | null, capMin: number): number | null {
  const s = (raw ?? '').toLowerCase().replace(',', '.').trim();
  if (!s) return null;
  const half = /(\d+)\s*\/\s*2\s*tag/.exec(s);
  if (half) return Math.round((Number(half[1]) * capMin) / 2);
  const day = /([\d.]+)\s*tag/.exec(s);
  if (day) return Math.round(Number(day[1]) * capMin);
  const h = /([\d.]+)\s*(std|h)?/.exec(s);
  if (h && Number(h[1]) > 0) return Math.round(Number(h[1]) * 60);
  return null;
}

export interface TgPlanOptions {
  customer: string | null;
  kind: string;
  start: string;
  dayStart: string; // "07:00"
  hoursPerDay: number; // 8.5
  skipHolidays: boolean;
  blockFrom: string | null;
  blockTo: string | null;
  onlyWithout: boolean;
}

const hm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function nextValidDay(
  d: string,
  o: Pick<TgPlanOptions, 'skipHolidays' | 'blockFrom' | 'blockTo'>,
): string {
  let x = d;
  for (;;) {
    const wd = isoWeekday(x);
    const blocked = o.blockFrom && o.blockTo && x >= o.blockFrom && x <= o.blockTo;
    if (wd <= 5 && !(o.skipHolidays && holidayName(x)) && !blocked) return x;
    x = addDays(x, 1);
  }
}

export async function autoPlanTg(sql: Sql, o: TgPlanOptions) {
  if (!TG_KINDS.includes(o.kind)) throw new BusinessError('Leistungsart ungültig');
  if (!(o.hoursPerDay > 0 && o.hoursPerDay <= 12)) throw new BusinessError('Std. pro Tag 1–12');
  const [h, m] = o.dayStart.split(':').map(Number) as [number, number];
  const begin = h * 60 + m;
  const cap = Math.round(o.hoursPerDay * 60);
  const objects = (await listTgObjects(sql)).filter(
    (x) => x.active && !x.paused && (!o.customer || x.customer === o.customer),
  );
  const apps = await listTgAppointments(sql);
  const todo = objects
    .filter((x) => !o.onlyWithout || !apps.some((a) => a.object_id === x.id && a.kind === o.kind && !a.done))
    .sort((a, b) => (a.postal_code ?? '').localeCompare(b.postal_code ?? '') || a.name.localeCompare(b.name));
  const out: { object: TgObject; days: Day[]; minutes: number; guessed: boolean }[] = [];
  let day = nextValidDay(o.start, o);
  let used = 0;
  for (const x of todo) {
    let dm = durationMinutes(x.duration, cap);
    let guessed = false;
    if (dm == null) {
      dm = Math.round(cap / 2);
      guessed = true;
    }
    const days: Day[] = [];
    if (dm > cap) {
      if (used > 0) day = nextValidDay(addDays(day, 1), o);
      let rest = dm;
      while (rest > 0) {
        day = nextValidDay(day, o);
        const chunk = Math.min(rest, cap);
        days.push({ date: day, from: hm(begin), to: hm(begin + chunk) });
        rest -= chunk;
        day = addDays(day, 1);
      }
      used = 0;
    } else {
      if (used + dm > cap) {
        day = nextValidDay(addDays(day, 1), o);
        used = 0;
      }
      day = nextValidDay(day, o);
      days.push({ date: day, from: hm(begin + used), to: hm(begin + used + dm) });
      used += dm;
      if (used >= cap) {
        day = addDays(day, 1);
        used = 0;
      }
    }
    out.push({ object: x, days, minutes: dm, guessed });
  }
  return out;
}

export async function applyTgPlan(sql: Sql, o: TgPlanOptions, replace: boolean, actor: string) {
  const plan = await autoPlanTg(sql, o);
  let n = 0;
  await sql.begin(async (tx) => {
    if (replace)
      await tx`delete from app.tg_appointments where kind = ${o.kind} and not done and not confirmed and work_report_id is null
                 and object_id = any(${plan.map((p) => p.object.id)}::uuid[])`;
    for (const p of plan) {
      const r = await tx`insert into app.tg_appointments ${tx({
        id: uuidOf(`tg-auto:${p.object.id}:${o.kind}:${p.days[0]!.date}`),
        object_id: p.object.id,
        days: tx.json(p.days as never),
        first_day: p.days[0]!.date,
        last_day: p.days.at(-1)!.date,
        kind: o.kind,
        created_by: actor,
      } as never)} on conflict (id) do nothing`;
      n += r.count;
    }
  });
  return n;
}

// ------------------------------------------------------------------ Aushang

const WD = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

async function drawNotice(
  pdf: PDFDocument,
  fonts: { regular: PDFFont; bold: PDFFont },
  o: TgObject,
  days: Day[],
  footer: string,
) {
  const page: PDFPage = pdf.addPage([595.28, 841.89]);
  const W = 595.28;
  const wine = rgb(0.545, 0.137, 0.196);
  const grey = rgb(0.4, 0.4, 0.4);
  const center = (text: string, y: number, size: number, f = fonts.regular, color = rgb(0, 0, 0)) =>
    page.drawText(text, { x: (W - f.widthOfTextAtSize(text, size)) / 2, y, size, font: f, color });
  center('ANKÜNDIGUNG', 760, 30, fonts.bold, wine);
  center('Tiefgaragenreinigung', 725, 22, fonts.bold);
  page.drawLine({ start: { x: 120, y: 708 }, end: { x: W - 120, y: 708 }, thickness: 1.5, color: wine });
  center(o.name, 680, 17, fonts.bold);
  center([o.postal_code, o.city].filter(Boolean).join(' '), 660, 13, fonts.regular, grey);
  center(days.length > 1 ? 'Reinigungstermine:' : 'Reinigungstermin:', 620, 14);
  let y = 590;
  for (const d of days) {
    center(`${WD[isoWeekday(d.date)]}, ${formatDateDe(d.date)}`, y, 20, fonts.bold, wine);
    center(`von ${d.from}–${d.to} Uhr`, y - 24, 15);
    y -= 60;
  }
  const boxY = Math.min(y - 20, 420) - 110;
  page.drawRectangle({
    x: 70,
    y: boxY,
    width: W - 140,
    height: 110,
    color: rgb(0.99, 0.93, 0.94),
    borderColor: wine,
    borderWidth: 1.2,
  });
  [
    'Bitte entfernen Sie Ihr Fahrzeug im',
    'genannten Zeitraum aus der Tiefgarage.',
    'Nicht entfernte Fahrzeuge können nicht',
    'im Umfeld gereinigt werden.',
  ].forEach((l, i) => center(l, boxY + 80 - i * 20, 14, fonts.bold));
  [
    'Haftungsausschluss: Für Schäden an Fahrzeugen, die trotz Ankündigung nicht',
    'rechtzeitig aus der Tiefgarage entfernt wurden, sowie für daraus entstehende',
    'Folgeschäden übernehmen wir keine Haftung. Das Befahren und Betreten der',
    'Tiefgarage während der Reinigungsarbeiten erfolgt auf eigene Gefahr.',
  ].forEach((l, i) => center(l, boxY - 30 - i * 13, 9, fonts.regular, grey));
  center('Vielen Dank für Ihr Verständnis.', 120, 15, fonts.bold);
  center(footer, 90, 11);
}

export async function noticesPdf(sql: Sql, objectIds: string[]): Promise<Uint8Array> {
  const seller = await getSeller(sql);
  const f = await pdfFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = {
    regular: await pdf.embedFont(f.regular, { subset: false }),
    bold: await pdf.embedFont(f.bold, { subset: false }),
  };
  const today = todayBerlin();
  const apps = await listTgAppointments(sql);
  const footer = [seller.legalName, seller.phone ? `Tel. ${seller.phone}` : null].filter(Boolean).join(' · ');
  for (const id of objectIds) {
    const o = await getTgObject(sql, id);
    if (!o || o.paused || !o.active) continue;
    const days = apps
      .filter((a) => a.object_id === id && !a.done && a.last_day >= today)
      .flatMap((a) => a.days.filter((d) => d.date >= today));
    if (!days.length) continue;
    await drawNotice(pdf, fonts, o, days, footer);
  }
  if (!pdf.getPageCount()) throw new BusinessError('Keine kommenden Termine für einen Aushang');
  return pdf.save();
}

// ------------------------------------------------------------------ Export

export function tgCsv(objects: TgObject[], apps: TgAppointment[]) {
  const q = (s: string | number | null | undefined) => {
    const v = String(s ?? '').replace(/"/g, '""');
    return /^[=+\-@]/.test(v) ? `"'${v}"` : `"${v}"`;
  };
  const byId = new Map(objects.map((o) => [o.id, o]));
  const rows: string[] = [];
  for (const a of apps) {
    const o = byId.get(a.object_id);
    if (!o) continue;
    for (const d of a.days)
      rows.push(
        [
          q(o.customer),
          formatDateDe(d.date),
          WD[isoWeekday(d.date)],
          q(o.name),
          q(o.postal_code),
          q(o.city),
          o.sqm ?? '',
          o.spaces_fixed ?? '',
          o.spaces_duplex ?? '',
          d.from,
          d.to,
          q(o.duration),
          a.kind,
          q(o.we_no),
          q(o.tob_name),
          q(o.tob_mobile),
          q(o.tob_email),
          q(o.deputy_email),
          a.confirmed ? 'ja' : 'nein',
          a.done ? 'ja' : 'nein',
        ].join(';'),
      );
  }
  return `\uFEFFKunde;Datum;Wochentag;Objekt / Liegenschaft;PLZ;Ort;m²;Stellpl. fest;Stellpl. Duplex;von;bis;Dauer;Leistungsart;WE-Nr.;Objektbetreuer;Handy;TOB E-Mail;Vertretung E-Mail;bestätigt;abgeschlossen\r\n${rows.join('\r\n')}\r\n`;
}
