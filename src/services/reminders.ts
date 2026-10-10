import type { Sql } from '../db/client.js';
import { formatDateDe, hourBerlin, todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { resolveRecipients } from '../mail/mailer.js';
import { hrReminders } from './employees.js';
import { ecOverview } from './eigen-compliance.js';
import { BusinessError } from './errors.js';
import { dueCycleServices } from './executions.js';
import { complianceOverview } from './subcontractors.js';
import { upcomingEvents } from './tenders.js';
import { plannedShifts } from './time.js';
import type { Deps } from './workflow.js';

/*
 * Erinnerungen (Ahmed 08.10.: „Erinnerungen wären gut“): alle Fristen an einer Stelle – Seite /erinnerungen und
 * täglich eine Sammel-Mail an die eingestellten Adressen (Einstellungen → Erinnerungen). Push aufs Handy folgt mit
 * Firebase/APNs. Im Testbetrieb gehen Mails nur an die Testadresse.
 */

export type ReminderArea =
  | 'Personal'
  | 'Nachunternehmer'
  | 'Fahrzeuge'
  | 'Ausschreibungen'
  | 'Eigen-Compliance'
  | 'Aufgaben'
  | 'Rechnungseingang'
  | 'Zeiterfassung'
  | 'Leistungen'
  | 'Firma';

export interface Reminder {
  area: ReminderArea;
  level: 'rot' | 'gelb';
  text: string;
  href: string;
  /** Tage bis zur Frist (negativ = überfällig) */
  days: number | null;
}

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const fristText = (d: number) => (d < 0 ? `seit ${-d} Tg. abgelaufen` : d === 0 ? 'heute' : `in ${d} Tg.`);

export async function collectReminders(sql: Sql, today = todayBerlin()): Promise<Reminder[]> {
  const out: Reminder[] = [];
  const [hr, subs, vehicles, events, ec, tasks, skonto] = await Promise.all([
    hrReminders(sql),
    complianceOverview(sql),
    sql<{ id: string; plate: string; hu_due: string | null; service_due: string | null }[]>`
      select id, plate, hu_due::text, service_due::text from app.vehicles where active`,
    upcomingEvents(sql, 7),
    ecOverview(sql, today),
    sql<{ id: string; title: string; due_date: string }[]>`
      select id, title, due_date::text from app.tasks where status = 'open' and due_date <= ${today}::date
       order by due_date limit 50`,
    sql<{ id: string; invoice_no: string; supplier: string; skonto_until: string }[]>`
      select i.id, i.invoice_no, s.name as supplier, i.skonto_until::text from app.incoming_invoices i
        join app.suppliers s on s.id = i.supplier_id
       where i.status = 'freigegeben' and i.skonto_until between ${today}::date and ${today}::date + 3`,
  ]);
  for (const p of hr.permits) {
    const d = dayDiff(today, p.residence_permit_until);
    out.push({
      area: 'Personal',
      level: d < 14 ? 'rot' : 'gelb',
      text: `${p.kind} ${p.name} ${fristText(d)} (${formatDateDe(p.residence_permit_until)})`,
      href: `/personal/${p.id}`,
      days: d,
    });
  }
  for (const s of subs.filter((x) => x.supplier.active)) {
    for (const due of s.due) {
      out.push({
        area: 'Nachunternehmer',
        level: due.days < 0 ? 'rot' : 'gelb',
        text: `${s.supplier.name}: ${due.label} ${fristText(due.days)}`,
        href: `/lieferanten/${s.supplier.id}`,
        days: due.days,
      });
    }
  }
  for (const v of vehicles) {
    for (const [label, date] of [
      ['HU', v.hu_due],
      ['Inspektion', v.service_due],
    ] as const) {
      if (!date) continue;
      const d = dayDiff(today, date);
      if (d <= 30)
        out.push({
          area: 'Fahrzeuge',
          level: d < 0 ? 'rot' : 'gelb',
          text: `${v.plate}: ${label} ${fristText(d)}`,
          href: `/fahrzeuge/${v.id}`,
          days: d,
        });
    }
  }
  for (const e of events) {
    out.push({
      area: 'Ausschreibungen',
      level: e.days <= 2 ? 'rot' : 'gelb',
      text: `${e.kind}: ${e.title}${e.authority ? ` (${e.authority})` : ''} ${fristText(e.days)}`,
      href: `/ausschreibungen/${e.tender_id}`,
      days: e.days,
    });
  }
  for (const e of ec.entries.filter((x) => x.bucket === 'crit' || x.bucket === 'warn')) {
    out.push({
      area: 'Eigen-Compliance',
      level: e.bucket === 'crit' ? 'rot' : 'gelb',
      text: `${e.dt.name}: ${e.status === 'missing' ? 'fehlt' : e.status === 'expired' ? 'abgelaufen' : 'läuft bald ab'}`,
      href: '/eigen-compliance',
      days: null,
    });
  }
  for (const t of tasks) {
    const d = dayDiff(today, t.due_date);
    out.push({
      area: 'Aufgaben',
      level: d < 0 ? 'rot' : 'gelb',
      text: `${t.title} – fällig ${d < 0 ? `seit ${-d} Tg.` : 'heute'}`,
      href: '/aufgaben',
      days: d,
    });
  }
  for (const s of skonto) {
    const d = dayDiff(today, s.skonto_until);
    out.push({
      area: 'Rechnungseingang',
      level: d <= 1 ? 'rot' : 'gelb',
      text: `Skonto ${s.supplier} (${s.invoice_no}) bis ${formatDateDe(s.skonto_until)}`,
      href: `/rechnungseingang/${s.id}`,
      days: d,
    });
  }
  // Einsätze von gestern ohne erfasste Zeit (nicht abwesend, kein Ausfall)
  const y = addDays(today, -1);
  const missing = (await plannedShifts(sql, { from: y, to: y })).filter(
    (s) => !s.entry && !s.absence && s.exception?.kind !== 'ausfall',
  );
  if (missing.length)
    out.push({
      area: 'Zeiterfassung',
      level: 'gelb',
      text: `${missing.length} Einsätze von gestern ohne erfasste Zeit (${missing
        .slice(0, 5)
        .map((s) => `${s.plan.employee_name} – ${s.plan.site_name}`)
        .join('; ')}${missing.length > 5 ? ' …' : ''})`,
      href: `/zeiterfassung?datum=${y}`,
      days: -1,
    });
  // Zyklus-Leistungen (2-monatlich … jährlich), die nach Ausführung abgerechnet werden und fällig sind
  for (const v of await dueCycleServices(sql, today)) {
    const d = dayDiff(today, v.next_due);
    out.push({
      area: 'Leistungen',
      level: d < 0 ? 'rot' : 'gelb',
      text: `${v.description} – ${v.site_name} (${v.site_no}), ${v.customer_name}: fällig ${d < 0 ? `seit ${-d} Tg.` : d === 0 ? 'heute' : `in ${d} Tg.`} (${formatDateDe(v.next_due)})`,
      href: `/objekte/${v.site_id}/leistungen#verrichten`,
      days: d,
    });
  }
  // Erlaubnis Arbeitnehmerüberlassung: Verlängerung spätestens 3 Monate vor Ablauf beantragen (§ 2 Abs. 4 AÜG)
  const [aue] = await sql<{ until: string | null; unlimited: boolean }[]>`
    select aue_permit_valid_until::text as until, aue_permit_unlimited as unlimited from app.company where id = 1`;
  if (aue?.until && !aue.unlimited) {
    const d = dayDiff(today, aue.until);
    if (d <= 100)
      out.push({
        area: 'Firma',
        level: d <= 92 ? 'rot' : 'gelb',
        text: `Erlaubnis Arbeitnehmerüberlassung läuft ${d < 0 ? `seit ${-d} Tg. nicht mehr` : `am ${formatDateDe(aue.until)} ab`} – Verlängerung spätestens 3 Monate vorher bei der Agentur für Arbeit beantragen`,
        href: '/einstellungen/firma',
        days: d,
      });
  }
  const lv = { rot: 0, gelb: 1 };
  return out.sort((a, b) => lv[a.level] - lv[b.level] || (a.days ?? 999) - (b.days ?? 999));
}

export async function getReminderSettings(sql: Sql) {
  const [s] = await sql<
    { enabled: boolean; emails: string[]; send_hour: number; last_sent: string | null }[]
  >`
    select enabled, emails, send_hour, last_sent::text from app.reminder_settings where id = 1`;
  return s ?? { enabled: false, emails: [], send_hour: 7, last_sent: null };
}

export async function saveReminderSettings(
  sql: Sql,
  p: { enabled: boolean; emails: string[]; sendHour: number },
  actor: string,
) {
  const bad = p.emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw new BusinessError(`E-Mail ungültig: ${bad}`);
  if (p.enabled && !p.emails.length) throw new BusinessError('Bitte mindestens eine E-Mail-Adresse angeben');
  await sql`insert into app.reminder_settings (id, enabled, emails, send_hour, updated_at)
            values (1, ${p.enabled}, ${p.emails}, ${p.sendHour}, now())
            on conflict (id) do update set enabled = excluded.enabled, emails = excluded.emails,
              send_hour = excluded.send_hour, updated_at = now()`;
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${actor}, 'save', 'reminder_settings', ${sql.json(p)})`;
}

export function reminderMailText(list: Reminder[], today: string) {
  const lines = [`Erinnerungen vom ${formatDateDe(today)}`, ''];
  let area = '';
  for (const r of list) {
    if (r.area !== area) {
      area = r.area;
      lines.push('', `${area}:`);
    }
    lines.push(`${r.level === 'rot' ? '!! ' : '–  '}${r.text}`);
  }
  lines.push('', 'Alle Erinnerungen: in der App unter Übersicht → Erinnerungen.');
  return lines.join('\n');
}

/**
 * Tägliche Sammel-Mail: höchstens einmal je Tag (Datum wird vor dem Versand gesetzt → kein Doppelversand bei
 * Neustart). Nichts zu melden oder kein SMTP → keine Mail.
 */
export async function sendDailyReminders(
  deps: Deps,
  now = new Date(),
): Promise<'gesendet' | 'nichts' | 'aus'> {
  const { sql, env } = deps;
  const s = await getReminderSettings(sql);
  if (!s.enabled || !s.emails.length || deps.mailer.configured === false) return 'aus';
  const today = todayBerlin(now);
  const hour = hourBerlin(now);
  if (hour < s.send_hour) return 'aus';
  const claimed = await sql`update app.reminder_settings set last_sent = ${today}
                             where id = 1 and (last_sent is null or last_sent < ${today}) returning id`;
  if (!claimed.length) return 'aus';
  const list = await collectReminders(sql, today);
  if (!list.length) return 'nichts';
  const { actual, redirected } = resolveRecipients(env, s.emails);
  await deps.mailer.send({
    from: env.MAIL_FROM,
    to: actual,
    subject: `${redirected ? '[TEST] ' : ''}Erinnerungen ${formatDateDe(today)}: ${list.filter((r) => r.level === 'rot').length} dringend, ${list.length} gesamt`,
    text:
      (redirected ? `*** TESTVERSAND – eigentlich an ${s.emails.join(', ')} ***\n\n` : '') +
      reminderMailText(list, today),
    attachments: [],
    messageId: `<erinnerung-${today}@viva-deluxe-app>`,
  });
  return 'gesendet';
}
