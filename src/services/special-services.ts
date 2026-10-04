import { createHash } from 'node:crypto';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { Cents, Quantity } from '../domain/money/money.js';
import { isoWeekday } from '../domain/time/holidays.js';
import { pdfFonts } from '../pdf/render.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { saveDraft } from './invoices.js';
import { getSeller } from './masterdata.js';
import { saveWorkReport, workReportPdf } from './orders.js';
import { addAttachment, type Deps } from './workflow.js';

/*
 * Sonderdienste (Glasreinigung, Tiefgarage, Grundreinigung …): wiederkehrend je Objekt alle n Monate.
 * Ablauf je Durchführung: Termin planen → (Aushang drucken, „angekündigt“) → erledigt (Arbeitsschein-Entwurf, nächste
 * Fälligkeit = Termin + Intervall) → Rechnungsentwurf zum Festpreis. Alles idempotent (feste IDs aus dem Termin).
 */

export type SpecialKind = 'glas' | 'tiefgarage' | 'grundreinigung' | 'teppich' | 'sonstiges';
export const SPECIAL_KIND: Record<SpecialKind, string> = {
  glas: 'Glasreinigung',
  tiefgarage: 'Tiefgaragenreinigung',
  grundreinigung: 'Grundreinigung',
  teppich: 'Teppichreinigung',
  sonstiges: 'Sonstiger Sonderdienst',
};
/** Vorgaben je Art: Intervall und Aushang-Vorlauf (Tiefgarage: Fahrzeuge müssen raus). */
export const SPECIAL_DEFAULTS: Record<SpecialKind, { interval: number; notice: number }> = {
  glas: { interval: 6, notice: 7 },
  tiefgarage: { interval: 12, notice: 14 },
  grundreinigung: { interval: 12, notice: 0 },
  teppich: { interval: 6, notice: 0 },
  sonstiges: { interval: 12, notice: 0 },
};
export type RunStatus = 'geplant' | 'angekuendigt' | 'erledigt' | 'abgesagt';
export const RUN_STATUS: Record<RunStatus, string> = {
  geplant: 'geplant',
  angekuendigt: 'angekündigt',
  erledigt: 'erledigt',
  abgesagt: 'abgesagt',
};

export interface SpecialService {
  id: string;
  site_id: string;
  kind: SpecialKind;
  title: string;
  scope: string | null;
  interval_months: number;
  next_due: string;
  price_cents: bigint | null;
  vat_rate_bp: number;
  notice_days: number;
  active: boolean;
  note: string | null;
  version: number;
}

export interface SpecialRun {
  id: string;
  special_service_id: string;
  planned_date: string;
  start_time: string | null;
  end_time: string | null;
  employee_ids: string[];
  status: RunStatus;
  announced_at: Date | null;
  done_at: Date | null;
  work_report_id: string | null;
  invoice_id: string | null;
  note: string | null;
  version: number;
}

const uuidOf = (s: string) =>
  createHash('md5')
    .update(s)
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Datum + n Monate; Monatsende wird gekappt (31.01. + 1 Monat = 28./29.02.). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const runSelect = (sql: Sql) => sql`
  select r.*, to_char(r.start_time, 'HH24:MI') as start_time, to_char(r.end_time, 'HH24:MI') as end_time
    from app.special_service_runs r`;

export type SpecialRow = SpecialService & {
  site_name: string;
  site_no: string;
  customer_name: string;
  open_run: SpecialRun | null;
  last_done: string | null;
  days_left: number;
};

export async function listSpecialServices(
  sql: Sql,
  f: {
    scope?: string[] | null;
    kind?: SpecialKind | null;
    siteId?: string | null;
    activeOnly?: boolean;
  } = {},
): Promise<SpecialRow[]> {
  const rows = await sql<
    (SpecialService & {
      site_name: string;
      site_no: string;
      customer_name: string;
      days_left: number;
      last_done: string | null;
    })[]
  >`
    select x.*, s.name as site_name, s.site_no, c.name as customer_name,
           (x.next_due - (now() at time zone 'Europe/Berlin')::date)::int as days_left,
           (select max(planned_date)::text from app.special_service_runs r where r.special_service_id = x.id and r.status = 'erledigt') as last_done
      from app.special_services x join app.sites s on s.id = x.site_id join app.customers c on c.id = s.customer_id
     where ${f.kind ? sql`x.kind = ${f.kind}` : sql`true`}
       and ${f.siteId ? sql`x.site_id = ${f.siteId}` : sql`true`}
       and ${f.activeOnly === false ? sql`true` : sql`x.active`}
       and ${f.scope ? (f.scope.length ? sql`x.site_id in ${sql(f.scope)}` : sql`false`) : sql`true`}
     order by x.next_due, s.name`;
  if (!rows.length) return [];
  const open = await sql<SpecialRun[]>`
    ${runSelect(sql)} where r.special_service_id in ${sql(rows.map((r) => r.id))} and r.status in ('geplant', 'angekuendigt')`;
  return rows.map((r) => ({ ...r, open_run: open.find((o) => o.special_service_id === r.id) ?? null }));
}

export async function getSpecialService(sql: Sql, id: string) {
  const [s] = await sql<
    (SpecialService & {
      site_name: string;
      site_no: string;
      customer_id: string;
      site_street: string | null;
      site_city: string | null;
      site_postal_code: string | null;
    })[]
  >`
    select x.*, s.name as site_name, s.site_no, s.customer_id, s.street as site_street, s.city as site_city,
           s.postal_code as site_postal_code
      from app.special_services x join app.sites s on s.id = x.site_id where x.id = ${id}`;
  if (!s) return undefined;
  const runs = await sql<
    SpecialRun[]
  >`${runSelect(sql)} where r.special_service_id = ${id} order by r.planned_date desc`;
  return { service: s, runs };
}

export async function getRun(sql: Sql, runId: string) {
  const [r] = await sql<SpecialRun[]>`${runSelect(sql)} where r.id = ${runId}`;
  return r;
}

export interface SpecialInput {
  siteId: string;
  kind: SpecialKind;
  title: string;
  scope: string | null;
  intervalMonths: number;
  nextDue: string;
  priceCents: bigint | null;
  vatRateBp: number;
  noticeDays: number;
  active: boolean;
  note: string | null;
  expectedVersion: number | null;
}

export async function saveSpecialService(sql: Sql, id: string, p: SpecialInput, actor: string) {
  if (!(p.kind in SPECIAL_KIND)) throw new BusinessError('Art ungültig');
  if (!p.title.trim()) throw new BusinessError('Bitte eine Bezeichnung angeben');
  if (!Number.isInteger(p.intervalMonths) || p.intervalMonths < 1 || p.intervalMonths > 60)
    throw new BusinessError('Intervall: 1 bis 60 Monate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.nextDue)) throw new BusinessError('Nächste Fälligkeit fehlt');
  if (![700, 1900].includes(p.vatRateBp)) throw new BusinessError('Steuersatz 7 % oder 19 %');
  if (!Number.isInteger(p.noticeDays) || p.noticeDays < 0 || p.noticeDays > 60)
    throw new BusinessError('Aushang-Vorlauf: 0 bis 60 Tage');
  if (p.priceCents != null && p.priceCents < 0n) throw new BusinessError('Preis darf nicht negativ sein');
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number }[]
    >`select version from app.special_services where id = ${id} for update`;
    assertVersion(cur?.version, p.expectedVersion, 'Der Sonderdienst');
    const [site] = await tx`select 1 from app.sites where id = ${p.siteId}`;
    if (!site) throw new BusinessError('Objekt nicht gefunden');
    const row = {
      site_id: p.siteId,
      kind: p.kind,
      title: p.title.trim(),
      scope: p.scope,
      interval_months: p.intervalMonths,
      next_due: p.nextDue,
      price_cents: p.priceCents,
      vat_rate_bp: p.vatRateBp,
      notice_days: p.noticeDays,
      active: p.active,
      note: p.note,
    };
    if (cur) await tx`update app.special_services set ${tx(row as Record<string, unknown>)} where id = ${id}`;
    else
      await tx`insert into app.special_services ${tx({ id, created_by: actor, ...row } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'special_service', ${id})`;
  });
}

/** Termin planen bzw. offenen Termin ändern (je Sonderdienst höchstens ein offener Termin). */
export async function planRun(
  sql: Sql,
  runId: string,
  serviceId: string,
  p: {
    date: string;
    start: string | null;
    end: string | null;
    employeeIds: string[];
    note: string | null;
    expectedVersion: number | null;
  },
  actor: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum fehlt');
  if ((p.start && !HHMM.test(p.start)) || (p.end && !HHMM.test(p.end)))
    throw new BusinessError('Uhrzeit bitte als HH:MM');
  if (p.start && p.end && p.end <= p.start) throw new BusinessError('Ende muss nach dem Beginn liegen');
  await sql.begin(async (tx) => {
    const [svc] = await tx<
      { active: boolean }[]
    >`select active from app.special_services where id = ${serviceId}`;
    if (!svc) throw new BusinessError('Sonderdienst nicht gefunden');
    if (!svc.active) throw new BusinessError('Sonderdienst ist inaktiv');
    const [cur] = await tx<
      { version: number; status: RunStatus; special_service_id: string; planned_date: string }[]
    >`
      select version, status, special_service_id, planned_date from app.special_service_runs where id = ${runId} for update`;
    assertVersion(cur?.version, p.expectedVersion, 'Der Termin');
    if (cur && cur.special_service_id !== serviceId)
      throw new BusinessError('Termin gehört zu einem anderen Sonderdienst');
    if (cur && !['geplant', 'angekuendigt'].includes(cur.status))
      throw new BusinessError('Termin ist abgeschlossen');
    if (!cur) {
      const [open] = await tx<{ id: string }[]>`
        select id from app.special_service_runs where special_service_id = ${serviceId} and status in ('geplant', 'angekuendigt')`;
      if (open)
        throw new BusinessError('Es gibt schon einen offenen Termin – bitte diesen ändern oder absagen');
      if (p.date < todayBerlin()) throw new BusinessError('Neuer Termin liegt in der Vergangenheit');
    }
    // Termin verschoben, nachdem schon ausgehängt war → neu ankündigen
    const moved = cur?.status === 'angekuendigt' && cur.planned_date !== p.date;
    const row = {
      planned_date: p.date,
      start_time: p.start,
      end_time: p.end,
      employee_ids: p.employeeIds,
      note: p.note,
      ...(moved ? { status: 'geplant', announced_at: null } : {}),
    };
    if (cur)
      await tx`update app.special_service_runs set ${tx(row as Record<string, unknown>)} where id = ${runId}`;
    else {
      await tx`insert into app.special_service_runs ${tx({ id: runId, special_service_id: serviceId, created_by: actor, ...row } as Record<string, unknown>)}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, ${cur ? 'reschedule' : 'plan'}, 'special_service', ${serviceId}, ${tx.json({ run: runId, date: p.date })})`;
  });
}

export async function announceRun(sql: Sql, runId: string, actor: string) {
  const r = await sql`update app.special_service_runs set status = 'angekuendigt', announced_at = now()
                      where id = ${runId} and status = 'geplant' returning special_service_id`;
  if (r.length) {
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'announce', 'special_service', ${r[0]!.special_service_id}, ${sql.json({ run: runId })})`;
  }
}

export async function cancelRun(sql: Sql, runId: string, reason: string | null, actor: string) {
  if (!reason?.trim()) throw new BusinessError('Bitte einen Grund angeben');
  const r =
    await sql`update app.special_service_runs set status = 'abgesagt', note = coalesce(note || ' · ', '') || ${`Abgesagt: ${reason.trim()}`}
                      where id = ${runId} and status in ('geplant', 'angekuendigt') returning special_service_id`;
  if (!r.length) throw new BusinessError('Nur offene Termine können abgesagt werden');
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'cancel', 'special_service', ${r[0]!.special_service_id}, ${sql.json({ run: runId, reason })})`;
}

/**
 * Durchführung erledigt: Arbeitsschein-Entwurf (zum Unterschreiben vor Ort/später), nächste Fälligkeit =
 * Termin + Intervall. Doppelt ausgelöst → nichts doppelt (feste Arbeitsschein-ID, Statusprüfung).
 */
export async function completeRun(sql: Sql, runId: string, actor: string): Promise<string> {
  const run = await getRun(sql, runId);
  if (!run) throw new BusinessError('Termin nicht gefunden');
  const wrId = uuidOf(`special-run:${runId}`);
  if (run.status === 'erledigt') return run.work_report_id ?? wrId;
  if (run.status === 'abgesagt') throw new BusinessError('Termin ist abgesagt');
  if (run.planned_date > todayBerlin()) throw new BusinessError('Termin liegt in der Zukunft');
  const data = (await getSpecialService(sql, run.special_service_id))!;
  const s = data.service;
  const [exists] = await sql`select 1 from app.work_reports where id = ${wrId}`;
  if (!exists) {
    await saveWorkReport(
      sql,
      wrId,
      {
        orderId: null,
        siteId: s.site_id,
        workDate: run.planned_date,
        startTime: run.start_time,
        endTime: run.end_time,
        employeeIds: run.employee_ids,
        description: [`${SPECIAL_KIND[s.kind]}: ${s.title}`, s.scope].filter(Boolean).join('\n'),
        materials: null,
        remarks: null,
        lines: [{ description: s.title, quantity: 1000n as Quantity, unitCode: 'LS' }],
        expectedVersion: null,
      },
      actor,
    );
  }
  await sql.begin(async (tx) => {
    const r =
      await tx`update app.special_service_runs set status = 'erledigt', done_at = now(), work_report_id = ${wrId}
                       where id = ${runId} and status in ('geplant', 'angekuendigt') returning id`;
    if (!r.length) return;
    // nächste Fälligkeit nur vorwärts (ein nachgeholter alter Termin schiebt nicht zurück)
    await tx`update app.special_services set next_due = greatest(next_due, ${addMonths(run.planned_date, s.interval_months)}::date)
              where id = ${s.id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'done', 'special_service', ${s.id}, ${tx.json({ run: runId, work_report: wrId })})`;
  });
  return wrId;
}

/** Rechnungsentwurf zum Festpreis; abgeschlossener Arbeitsschein hängt an. Nur einmal je Durchführung. */
export async function runToInvoice(deps: Deps, runId: string, actor: string): Promise<string> {
  const { sql } = deps;
  const run = await getRun(sql, runId);
  if (!run) throw new BusinessError('Termin nicht gefunden');
  if (run.invoice_id) return run.invoice_id;
  if (run.status !== 'erledigt') throw new BusinessError('Erst nach Erledigung abrechnen');
  const s = (await getSpecialService(sql, run.special_service_id))!.service;
  if (s.price_cents == null)
    throw new BusinessError('Kein Festpreis hinterlegt – bitte am Sonderdienst eintragen');
  const id = uuidOf(`special-invoice:${runId}`);
  await saveDraft(
    sql,
    id,
    {
      customerId: s.customer_id,
      siteId: s.site_id,
      kind: 'invoice',
      periodStart: run.planned_date,
      periodEnd: run.planned_date,
      orderReference: null,
      introText: null,
      closingText: null,
      lines: [
        {
          description: s.title,
          detail: [
            s.scope,
            `Objekt: ${s.site_name} (${s.site_no})`,
            `ausgeführt am ${formatDateDe(run.planned_date)}`,
          ]
            .filter(Boolean)
            .join('\n'),
          quantity: 1000n as Quantity,
          unitCode: 'LS',
          unitPrice: s.price_cents as Cents,
          vatRate: s.vat_rate_bp,
        },
      ],
    },
    actor,
  );
  if (run.work_report_id) {
    const [w] = await sql<{ number: string; status: string; invoice_id: string | null }[]>`
      select number, status::text, invoice_id from app.work_reports where id = ${run.work_report_id}`;
    if (w && w.status !== 'entwurf' && !w.invoice_id) {
      await addAttachment(
        deps,
        id,
        `Arbeitsschein_${w.number}.pdf`,
        'application/pdf',
        await workReportPdf(deps, run.work_report_id),
        actor,
      );
      await sql`update app.work_reports set invoice_id = ${id} where id = ${run.work_report_id} and invoice_id is null`;
    }
  }
  await sql`update app.special_service_runs set invoice_id = ${id} where id = ${runId} and invoice_id is null`;
  return id;
}

const WD = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

/** Aushang (A4 quer lesbar aus der Entfernung): Tiefgarage – Fahrzeuge entfernen; sonst Hinweis auf die Reinigung. */
export async function noticePdf(sql: Sql, runId: string): Promise<Uint8Array> {
  const run = await getRun(sql, runId);
  if (!run) throw new BusinessError('Termin nicht gefunden');
  const s = (await getSpecialService(sql, run.special_service_id))!.service;
  const seller = await getSeller(sql);
  const fonts = await pdfFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: false });
  const bold = await pdf.embedFont(fonts.bold, { subset: false });
  const page = pdf.addPage([595.28, 841.89]);
  const brand = rgb(0x7d / 255, 0x14 / 255, 0x35 / 255);
  const W = 595.28;
  const center = (text: string, y: number, size: number, f = regular, color = rgb(0, 0, 0)) => {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (W - w) / 2, y, size, font: f, color });
  };
  const wrap = (text: string, size: number, maxW: number) => {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const t = line ? `${line} ${word}` : word;
        if (regular.widthOfTextAtSize(t, size) > maxW && line) {
          out.push(line);
          line = word;
        } else line = t;
      }
      out.push(line);
    }
    return out;
  };
  page.drawRectangle({ x: 0, y: 841.89 - 110, width: W, height: 110, color: brand });
  center('WICHTIGER HINWEIS', 841.89 - 50, 30, bold, rgb(1, 1, 1));
  center(seller.legalName, 841.89 - 85, 13, regular, rgb(1, 1, 1));
  const garage = s.kind === 'tiefgarage';
  center(garage ? 'Reinigung der Tiefgarage' : SPECIAL_KIND[s.kind], 640, 28, bold, brand);
  const date = `${WD[isoWeekday(run.planned_date)]}, ${formatDateDe(run.planned_date)}`;
  center(date, 590, 34, bold);
  if (run.start_time)
    center(`${run.start_time}${run.end_time ? ` – ${run.end_time}` : ''} Uhr`, 548, 24, regular);
  const body = garage
    ? `Bitte entfernen Sie Ihr Fahrzeug bis ${formatDateDe(run.planned_date)}${run.start_time ? `, ${run.start_time} Uhr,` : ''} aus der Tiefgarage. ` +
      'Während der Reinigung ist die Zufahrt gesperrt. Nicht entfernte Fahrzeuge können nicht gereinigt werden ' +
      'und behindern die Arbeiten.'
    : `Wir führen an diesem Tag folgende Arbeiten durch: ${s.title}${s.scope ? ` (${s.scope})` : ''}. ` +
      'Bitte halten Sie Fenster und Zugänge frei und rechnen Sie mit kurzen Einschränkungen.';
  let y = 480;
  for (const l of wrap(body, 17, W - 120)) {
    center(l, y, 17);
    y -= 26;
  }
  y -= 20;
  center(`Objekt: ${s.site_name}${s.site_street ? `, ${s.site_street}` : ''}`, y, 13);
  center('Vielen Dank für Ihr Verständnis.', 140, 16, bold);
  center(
    [seller.legalName, seller.phone ? `Tel. ${seller.phone}` : null, seller.email]
      .filter(Boolean)
      .join(' · '),
    90,
    11,
  );
  return pdf.save();
}
