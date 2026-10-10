import type { Sql } from '../db/client.js';
import { monthBounds, monthlyRunLines } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { expectedInvoices } from './expected-invoices.js';
import { toRunService } from './invoices.js';
import { plannedShifts } from './time.js';

/*
 * Monatsabschluss-Assistent (Ahmed 08.10.: „ja der Assistent wäre gut“): alle Schritte zum Monatsende in einer Liste –
 * Zeiten vollständig, Stundenlisten unterschrieben, Leistungen abgerechnet, Rechnungen versendet, Eingangsrechnungen da,
 * Kasse abgeschlossen, Lohn und DATEV exportiert. Jeder Schritt mit Zahl und Link; „Monat abschließen“ hält den Stand
 * fest (nur anhängen).
 */

export interface CloseStep {
  key: string;
  group: 'Zeiten' | 'Abrechnung' | 'Einkauf' | 'Lohn & Buchhaltung';
  title: string;
  open: number;
  /** nur Hinweis, kein offener Punkt (z. B. Export manuell) */
  manual?: boolean;
  detail: string;
  href: string;
}

export async function monthCloseSteps(sql: Sql, month: string): Promise<CloseStep[]> {
  const { start, end } = monthBounds(month);
  const [[time], [sig], [conf], [drafts], [unsent], [execs], [inc], [cash], [abs]] = await Promise.all([
    sql<{ running: number; pending: number }[]>`
      select count(*) filter (where status = 'laeuft')::int as running,
             count(*) filter (where status = 'beantragt')::int as pending
        from app.time_entries where work_date between ${start} and ${end}`,
    sql<{ worked: number; signed: number }[]>`
      select count(distinct t.employee_id)::int as worked,
             count(distinct s.employee_id)::int as signed
        from app.time_entries t
        left join app.timesheet_signatures s on s.employee_id = t.employee_id and s.month = ${month}
       where t.work_date between ${start} and ${end} and t.status <> 'abgelehnt'`,
    sql<{ sites: number; confirmed: number }[]>`
      select count(distinct t.site_id)::int as sites,
             count(distinct c.site_id)::int as confirmed
        from app.time_entries t
        left join app.site_time_confirmations c on c.site_id = t.site_id and c.month = ${start}::date and c.confirmed
       where t.work_date between ${start} and ${end} and t.status <> 'abgelehnt'`,
    sql<{ n: number }[]>`select count(*)::int as n from app.invoices where status = 'draft'`,
    sql<{ n: number }[]>`
      select count(*)::int as n from app.invoices i
       where status = 'issued' and issue_date between ${start} and ${end}
         and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')`,
    sql<{ n: number }[]>`
      select count(*)::int as n from app.service_executions
       where invoice_id is null and date_from <= ${end}`,
    sql<{ n: number }[]>`select count(*)::int as n from app.incoming_invoices where status = 'erfasst'`,
    sql<{ closed: boolean; entries: number }[]>`
      select exists (select 1 from app.cash_closings where month = ${month}) as closed,
             (select count(*)::int from app.cash_entries where to_char(entry_date, 'YYYY-MM') = ${month}) as entries`,
    sql<{ n: number }[]>`
      select count(*)::int as n from app.absences
       where status = 'beantragt' and start_date <= ${end} and end_date >= ${start}`,
  ]);
  // Einsätze ohne Zeit (bis heute bzw. Monatsende)
  const shifts = await plannedShifts(sql, { from: start, to: end });
  const today = new Date().toISOString().slice(0, 10);
  const noTime = shifts.filter(
    (s) => s.date <= today && !s.entry && !s.absence && s.exception?.kind !== 'ausfall',
  ).length;
  // regelmäßige Leistungen, die im Monat fällig und noch nicht abgerechnet sind
  const services = await sql<Parameters<typeof toRunService>[0][]>`
    select ss.* from app.site_services ss join app.sites s on s.id = ss.site_id join app.customers c on c.id = s.customer_id
     where ss.active and s.active and c.active and not c.is_internal and ss.kind = 'monthly_flat'`;
  const billed = new Set(
    (
      await sql<
        { service_id: string }[]
      >`select service_id from app.monthly_run_services where month = ${month}`
    ).map((r) => r.service_id),
  );
  const due = services.filter(
    (sv) => monthlyRunLines([toRunService(sv)], month).length && !billed.has(sv.id),
  ).length;
  const expected = (await expectedInvoices(sql)).filter((e) => e.period <= month).length;
  const payrollExport =
    (
      await sql<{ at: Date }[]>`
        select max(created_at) as at from app.payroll_exports where month = ${month}`
    )[0]?.at ?? null;
  const steps: CloseStep[] = [
    {
      key: 'running',
      group: 'Zeiten',
      title: 'Keine laufenden Stempelungen',
      open: time!.running,
      detail: `${time!.running} Stempelung(en) im Monat noch nicht beendet`,
      href: `/zeiterfassung?von=${start}&bis=${end}`,
    },
    {
      key: 'pending',
      group: 'Zeiten',
      title: 'Nachträge freigegeben',
      open: time!.pending,
      detail: `${time!.pending} Nachtrag/Nachträge warten auf Freigabe`,
      href: `/zeiterfassung?von=${start}&bis=${end}`,
    },
    {
      key: 'notime',
      group: 'Zeiten',
      title: 'Einsätze mit erfasster Zeit',
      open: noTime,
      detail: `${noTime} geplante Einsätze ohne erfasste Zeit (nicht abwesend, kein Ausfall)`,
      href: '/einsatzplanung?ansicht=monat',
    },
    {
      key: 'absences',
      group: 'Zeiten',
      title: 'Urlaubsanträge entschieden',
      open: abs!.n,
      detail: `${abs!.n} offene Anträge im Monat`,
      href: '/urlaub',
    },
    {
      key: 'sites',
      group: 'Zeiten',
      title: 'Zeiterfassung je Objekt bestätigt',
      open: conf!.sites - conf!.confirmed,
      detail: `${conf!.confirmed} von ${conf!.sites} Objekten mit Zeiten bestätigt`,
      href: '/objekte',
    },
    {
      key: 'signed',
      group: 'Zeiten',
      title: 'Stundenlisten unterschrieben',
      open: sig!.worked - sig!.signed,
      detail: `${sig!.signed} von ${sig!.worked} Mitarbeitenden mit Zeiten haben unterschrieben (nicht Pflicht, Nachweis)`,
      href: `/zeiterfassung/stundenzettel?monat=${month}`,
    },
    {
      key: 'due',
      group: 'Abrechnung',
      title: 'Regelmäßige Leistungen abgerechnet',
      open: due,
      detail: `${due} im Monat fällige Pauschalen noch ohne Rechnung (Monatslauf)`,
      href: '/rechnungen/entwuerfe',
    },
    {
      key: 'execs',
      group: 'Abrechnung',
      title: 'Verrichtete Leistungen abgerechnet',
      open: execs!.n,
      detail: `${execs!.n} vorgemerkte Ausführungen bis Monatsende ohne Rechnung`,
      href: '/rechnungen/entwuerfe',
    },
    {
      key: 'drafts',
      group: 'Abrechnung',
      title: 'Rechnungsentwürfe ausgestellt',
      open: drafts!.n,
      detail: `${drafts!.n} Entwürfe offen`,
      href: '/rechnungen/entwuerfe',
    },
    {
      key: 'unsent',
      group: 'Abrechnung',
      title: 'Rechnungen versendet',
      open: unsent!.n,
      detail: `${unsent!.n} im Monat ausgestellte Rechnungen nicht versendet / nicht im Portal hochgeladen`,
      href: '/rechnungen?versand=offen',
    },
    {
      key: 'expected',
      group: 'Einkauf',
      title: 'Nachunternehmer-Rechnungen eingegangen',
      open: expected,
      detail: `${expected} erwartete Rechnungen bis einschließlich ${month.slice(5)}/${month.slice(0, 4)} fehlen`,
      href: '/rechnungseingang?status=erwartet',
    },
    {
      key: 'incoming',
      group: 'Einkauf',
      title: 'Eingangsrechnungen geprüft',
      open: inc!.n,
      detail: `${inc!.n} Eingangsrechnungen „zu prüfen“`,
      href: '/rechnungseingang',
    },
    {
      key: 'cash',
      group: 'Lohn & Buchhaltung',
      title: 'Kassenbuch abgeschlossen',
      open: cash!.closed || cash!.entries === 0 ? 0 : 1,
      detail: cash!.closed
        ? 'Monat mit Kassensturz abgeschlossen'
        : cash!.entries
          ? `${cash!.entries} Buchungen, Monat noch nicht abgeschlossen`
          : 'keine Kassenbuchungen im Monat',
      href: `/kassenbuch?monat=${month}`,
    },
    {
      key: 'payroll',
      group: 'Lohn & Buchhaltung',
      title: 'Lohnarten an das Lohnprogramm',
      open: payrollExport ? 0 : 1,
      manual: !payrollExport,
      detail: payrollExport
        ? `CSV exportiert am ${payrollExport.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })}`
        : 'CSV „Lohnprogramm“ exportieren und ins Lohnprogramm einlesen',
      href: `/zeiterfassung/stundenzettel?monat=${month}&ansicht=lohnarten`,
    },
    {
      key: 'datev',
      group: 'Lohn & Buchhaltung',
      title: 'DATEV-Export an den Steuerberater',
      open: 0,
      manual: true,
      detail: 'Buchungsstapel für den Monat erzeugen und übermitteln',
      href: `/datev?von=${start}&bis=${end}`,
    },
  ];
  return steps;
}

export async function closeMonth(
  sql: Sql,
  p: { id: string; month: string; note: string | null; actor: string },
) {
  monthBounds(p.month);
  const steps = await monthCloseSteps(sql, p.month);
  const open = steps.filter((s) => s.open > 0).length;
  if (open && !p.note?.trim())
    throw new BusinessError(
      `Noch ${open} offene Punkte – bitte begründen (Notiz), warum trotzdem abgeschlossen wird`,
    );
  await sql`insert into app.month_closings (id, month, snapshot, open_points, note, closed_by)
            values (${p.id}, ${p.month}, ${sql.json(steps as never)}, ${open}, ${p.note}, ${p.actor})
            on conflict (id) do nothing`;
}

export async function listClosings(sql: Sql, month?: string) {
  return sql<
    {
      id: string;
      month: string;
      open_points: number;
      note: string | null;
      closed_by: string;
      closed_at: Date;
    }[]
  >`
    select id, month, open_points, note, closed_by, closed_at from app.month_closings
     where ${month ? sql`month = ${month}` : sql`true`} order by closed_at desc limit 24`;
}
