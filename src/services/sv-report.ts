import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { validSvNumber } from '../domain/hr/ids.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { uuidFrom } from './photo-stamp.js';

/*
 * SV-Sofortmeldung (§ 28a Abs. 4 SGB IV, Ahmed 26.10.): In der Gebäudereinigung muss jede Beschäftigung spätestens bei
 * Arbeitsaufnahme sofort an die Datenstelle der Rentenversicherung gemeldet werden – auch Minijobs. Übermittelt wird
 * weiter über Lexware/sv.net (zertifizierte Software nötig); die App zeigt die Meldedaten, hält Datum und
 * Übermittlungsnummer fest und warnt, solange die Meldung fehlt.
 */

/** Erst ab Umstellung prüfen – frühere Eintritte wurden über Lexware gemeldet. */
export const SOFORT_FROM = '2026-10-08';
/** Warnung schon für Eintritte in den nächsten Tagen (Meldung vor Arbeitsaufnahme). */
export const SOFORT_AHEAD_DAYS = 14;

export const SOFORT_VIA = {
  lexware: 'Lexware',
  svnet: 'sv.net',
  steuerberater: 'Steuerberater',
  sonstiges: 'sonstiges',
} as const;
export type SofortVia = keyof typeof SOFORT_VIA;

export interface SofortReport {
  id: string;
  entry_date: string;
  reported_at: string;
  transfer_no: string | null;
  via: SofortVia;
  note: string | null;
  created_by: string;
}

export interface SofortMissing {
  employee_id: string;
  personnel_no: string;
  name: string;
  entry_date: string;
  /** Tage bis Beschäftigungsbeginn (negativ = schon begonnen) */
  days: number;
  /** schon Arbeitszeit erfasst */
  worked: boolean;
}

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/** Aktive Mitarbeitende mit Beginn ab Umstellung, für deren aktuellen Beginn keine Sofortmeldung erfasst ist. */
export async function missingSofort(
  sql: Sql,
  opts: { siteIds?: string[] | null; today?: string } = {},
): Promise<SofortMissing[]> {
  const today = opts.today ?? todayBerlin();
  const rows = await sql<
    {
      id: string;
      personnel_no: string;
      name: string;
      entry_date: string;
      worked: boolean;
      site_ids: string[] | null;
    }[]
  >`
    select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, e.entry_date::text,
           exists (select 1 from app.time_entries t where t.employee_id = e.id and t.work_date >= e.entry_date
                     and t.status <> 'abgelehnt') as worked,
           (select array_agg(distinct x) from (
              select site_id as x from app.employee_sites where employee_id = e.id
              union select site_id from app.shift_plans where employee_id = e.id) s) as site_ids
      from app.employees e
     where e.status = 'aktiv' and e.entry_date >= ${SOFORT_FROM}::date
       and e.entry_date <= ${addDays(today, SOFORT_AHEAD_DAYS)}::date
       and not exists (select 1 from app.sv_immediate_reports r
                        where r.employee_id = e.id and r.entry_date = e.entry_date)
     order by e.entry_date, e.last_name, e.first_name`;
  return rows
    .filter((r) => !opts.siteIds || (r.site_ids ?? []).some((s) => opts.siteIds!.includes(s)))
    .map((r) => ({
      employee_id: r.id,
      personnel_no: r.personnel_no,
      name: r.name,
      entry_date: r.entry_date,
      days: dayDiff(today, r.entry_date),
      worked: r.worked,
    }));
}

/** Gilt für diesen Mitarbeiter eine Sofortmeldungspflicht, die noch nicht erledigt ist? */
export async function sofortMissingFor(sql: Sql, employeeId: string): Promise<{ entry_date: string } | null> {
  const [r] = await sql<{ entry_date: string }[]>`
    select e.entry_date::text from app.employees e
     where e.id = ${employeeId} and e.status = 'aktiv' and e.entry_date >= ${SOFORT_FROM}::date
       and not exists (select 1 from app.sv_immediate_reports r
                        where r.employee_id = e.id and r.entry_date = e.entry_date)`;
  return r ?? null;
}

export async function listSofort(sql: Sql, employeeId: string): Promise<SofortReport[]> {
  return sql<SofortReport[]>`
    select id, entry_date::text, reported_at::text, transfer_no, via, note, created_by
      from app.sv_immediate_reports where employee_id = ${employeeId} order by entry_date desc`;
}

export interface SofortField {
  label: string;
  value: string;
  /** Pflichtangabe fehlt */
  missing?: boolean;
}

/**
 * Meldedaten in der Reihenfolge von sv.net / Lexware: Name, Vorname, Versicherungsnummer – fehlt sie, die Angaben
 * zur Vergabe (Geburtsdatum, -ort, Geschlecht, Staatsangehörigkeit, Anschrift), Betriebsnummer, Beschäftigungsbeginn.
 */
export async function sofortData(
  sql: Sql,
  employeeId: string,
): Promise<{ fields: SofortField[]; complete: boolean }> {
  const [e] = await sql<
    {
      first_name: string;
      last_name: string;
      salutation: string | null;
      entry_date: string;
      birth_date: string | null;
      birth_place: string | null;
      birth_country: string | null;
      nationality: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      social_security_no: string | null;
      betriebsnummer: string | null;
    }[]
  >`
    select e.first_name, e.last_name, e.salutation, e.entry_date::text, p.birth_date::text, p.birth_place,
           p.birth_country, p.nationality, p.street, p.postal_code, p.city, p.social_security_no,
           (select betriebsnummer from app.company where id = 1) as betriebsnummer
      from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const sv = (e.social_security_no ?? '').replace(/\s/g, '').toUpperCase();
  const svOk = !!sv && validSvNumber(sv);
  const f: SofortField[] = [
    { label: 'Familienname', value: e.last_name },
    { label: 'Vorname', value: e.first_name },
    {
      label: 'Versicherungsnummer',
      value: sv || (svOk ? '' : 'nicht bekannt – Angaben unten'),
      missing: false,
    },
  ];
  if (sv && !svOk) f[2] = { label: 'Versicherungsnummer', value: `${sv} (ungültig – prüfen)`, missing: true };
  const need = !svOk; // ohne gültige Nummer: Angaben zur Vergabe Pflicht
  const opt = (label: string, value: string | null | undefined, required = need) =>
    f.push({ label, value: value?.trim() || '–', missing: required && !value?.trim() });
  opt('Geburtsdatum', e.birth_date ? formatDateDe(e.birth_date) : null);
  opt('Geburtsort', e.birth_place);
  opt('Geburtsland', e.birth_country, false);
  opt(
    'Geschlecht',
    e.salutation === 'Frau'
      ? 'weiblich'
      : e.salutation === 'Herr'
        ? 'männlich'
        : e.salutation === 'divers'
          ? 'divers'
          : null,
  );
  opt('Staatsangehörigkeit', e.nationality);
  opt(
    'Anschrift',
    [e.street, [e.postal_code, e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
  );
  f.push({ label: 'Betriebsnummer Arbeitgeber', value: e.betriebsnummer ?? '–', missing: !e.betriebsnummer });
  f.push({ label: 'Beschäftigungsbeginn', value: formatDateDe(e.entry_date) });
  return { fields: f, complete: !f.some((x) => x.missing) };
}

export async function recordSofort(
  sql: Sql,
  p: {
    id: string;
    employeeId: string;
    reportedAt: string; // ISO mit Zeit
    transferNo: string | null;
    via: SofortVia;
    note: string | null;
    actor: string;
  },
): Promise<boolean> {
  if (!(p.via in SOFORT_VIA)) throw new BusinessError('Meldeweg ungültig');
  if (Number.isNaN(Date.parse(p.reportedAt))) throw new BusinessError('Zeitpunkt der Meldung fehlt');
  if (Date.parse(p.reportedAt) > Date.now() + 5 * 60_000)
    throw new BusinessError('Zeitpunkt der Meldung liegt in der Zukunft');
  const transfer = p.transferNo?.trim() || null;
  if (transfer && transfer.length > 60) throw new BusinessError('Übermittlungsnummer zu lang');
  return sql.begin(async (tx) => {
    const [e] = await tx<{ entry_date: string }[]>`
      select entry_date::text from app.employees where id = ${p.employeeId} for update`;
    if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
    const ins = await tx`
      insert into app.sv_immediate_reports (id, employee_id, entry_date, reported_at, transfer_no, via, note, created_by)
      values (${p.id}, ${p.employeeId}, ${e.entry_date}, ${p.reportedAt}, ${transfer}, ${p.via},
              ${p.note?.trim().slice(0, 500) || null}, ${p.actor})
      on conflict do nothing`;
    if (!ins.count) return false;
    // Hinweis-Aufgabe aus dem Stempeln ist damit erledigt
    await tx`update app.tasks set status = 'done', done_at = now(), done_by = ${p.actor}
              where id = ${sofortTaskId(p.employeeId, e.entry_date)} and status = 'open'`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'create', 'sv_sofortmeldung', ${p.employeeId},
                     ${tx.json({ entry_date: e.entry_date, reported_at: p.reportedAt, transfer_no: transfer, via: p.via })})`;
    return true;
  });
}

/** Falsch erfasst – Eintrag entfernen, Stand ins Protokoll. */
export async function deleteSofort(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [r] = await tx<
      Record<string, unknown>[]
    >`delete from app.sv_immediate_reports where id = ${id} returning *`;
    if (!r) throw new BusinessError('Eintrag nicht gefunden');
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'sv_sofortmeldung', ${r.employee_id as string}, ${tx.json(r as never)})`;
  });
}

export const sofortTaskId = (employeeId: string, entryDate: string) =>
  uuidFrom(`${employeeId}:${entryDate}:sofortmeldung`);

/**
 * Gestempelt bzw. Arbeitszeit erfasst ohne Sofortmeldung → Aufgabe für Admin/Personal (einmal je Beschäftigung).
 * Stempeln wird nie verweigert – die Person arbeitet ja schon; die Meldung muss sofort nachgeholt werden.
 */
export async function flagWorkWithoutSofort(sql: Sql, employeeId: string, actor: string): Promise<boolean> {
  const m = await sofortMissingFor(sql, employeeId);
  if (!m) return false;
  const [e] = await sql<{ name: string; personnel_no: string }[]>`
    select first_name || ' ' || last_name as name, personnel_no from app.employees where id = ${employeeId}`;
  const [admin] = await sql<{ name: string }[]>`
    select coalesce(nullif(p.display_name, ''), a.login) as name
      from app.user_accounts a join app.profiles p on p.user_id = a.id
     where a.active and p.role in ('admin', 'personal') order by p.role = 'admin' desc, a.created_at limit 1`;
  const r = await sql`
    insert into app.tasks (id, title, description, due_date, assignee, entity_type, entity_id, created_by)
    values (${sofortTaskId(employeeId, m.entry_date)},
            ${`SV-Sofortmeldung fehlt: ${e?.name ?? ''} (${e?.personnel_no ?? ''}) arbeitet bereits`},
            ${`Beschäftigungsbeginn ${formatDateDe(m.entry_date)}. Sofortmeldung sofort über Lexware/sv.net abgeben (§ 28a Abs. 4 SGB IV) und unter Mitarbeiter → Übersicht → „Sofortmeldung“ festhalten.`},
            (now() at time zone 'Europe/Berlin')::date, ${admin?.name ?? null}, 'employee', ${employeeId}, ${actor})
    on conflict (id) do nothing`;
  return r.count > 0;
}
