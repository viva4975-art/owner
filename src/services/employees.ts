import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { assertVersion, versionField } from './crm.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = z.preprocess(emptyToNull, z.string().trim().nullable().default(null));
const optDate = z.preprocess(emptyToNull, z.iso.date().nullable().default(null));

export interface Employee {
  id: string;
  personnel_no: string;
  first_name: string;
  last_name: string;
  status: 'aktiv' | 'ausgetreten';
  employment_type: 'vollzeit' | 'teilzeit' | 'minijob' | 'werkstudent' | 'aushilfe';
  entry_date: string;
  exit_date: string | null;
  weekly_hours: string | null;
  hourly_wage_cents: bigint | null;
  phone: string | null;
  email: string | null;
  languages: string[];
  annual_leave_days: string;
  salutation: 'Herr' | 'Frau' | 'divers' | null;
  tags: string[];
  warning_note: string | null;
  info: string | null;
  mobile: string | null;
  email_private: string | null;
  wage_level_id: string | null;
  /** Vergütung: Tariflohn (Lohngruppe), individueller Stundenlohn oder Festgehalt */
  pay_model: 'tarif' | 'individuell' | 'festgehalt' | null;
  monthly_salary_cents: bigint | null;
  /** RTV § 10 g: Sonn-/Feiertagsarbeit regelmäßig am selben Arbeitsplatz → 75 % */
  regular_sunday_work: boolean;
  carry_over_leave: boolean;
  planning_group: string | null;
  planning_notes: string | null;
  version: number;
}

export interface EmployeePrivate {
  birth_date: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  nationality: string | null;
  tax_id: string | null;
  social_security_no: string | null;
  health_insurance: string | null;
  iban: string | null;
  residence_permit_until: string | null;
  birth_place: string | null;
  birth_country: string | null;
  marital_status: string | null;
  residence_permit_info: string | null;
  version: number;
}

/** Vorschläge wie in Fortytools; freie Tags sind ebenfalls möglich. */
export const TAG_SUGGESTIONS = [
  'Minijob',
  'Teilzeit',
  'Vollzeit',
  'Objektleitung',
  'Springer',
  'Führerschein',
];
export const MARITAL_STATUS = [
  'ledig',
  'verheiratet',
  'eingetragene Lebenspartnerschaft',
  'geschieden',
  'verwitwet',
  'nicht verheiratet/unbekannt',
];
const tagList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? [
          ...new Set(
            v
              .split(/[,;]+/)
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ]
      : (v ?? []),
  z.array(z.string().max(40)).max(20),
);

export const EMPLOYMENT_TYPES = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob: 'Minijob',
  werkstudent: 'Werkstudent',
  aushilfe: 'Aushilfe',
} as const;

/** IBAN-Prüfsumme (ISO 13616, mod 97). */
export function validIban(iban: string): boolean {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export const employeeInput = z
  .object({
    personnel_no: z.string().trim().min(1, 'Personalnummer fehlt'),
    first_name: z.string().trim().min(1, 'Vorname fehlt'),
    last_name: z.string().trim().min(1, 'Nachname fehlt'),
    employment_type: z.enum(['vollzeit', 'teilzeit', 'minijob', 'werkstudent', 'aushilfe'], {
      error: 'Bitte die Beschäftigungsart wählen (Vollzeit, Teilzeit, Minijob …)',
    }),
    entry_date: z.iso.date('Eintrittsdatum fehlt'),
    exit_date: optDate,
    weekly_hours: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : null),
      z.number().min(0).max(60).nullable(),
    ),
    hourly_wage: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
      z
        .string()
        .regex(/^\d{1,3}([.,]\d{1,2})?$/, 'Stundenlohn z. B. 14,25')
        .nullable(),
    ),
    phone: optText,
    email: z.preprocess(emptyToNull, z.email('Ungültige E-Mail').nullable().default(null)),
    languages: z.preprocess(
      (v) =>
        typeof v === 'string'
          ? v
              .split(/[,;]+/)
              .map((x) => x.trim())
              .filter(Boolean)
          : (v ?? []),
      z.array(z.string()),
    ),
    annual_leave_days: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : 30),
      z.number().min(0, 'Urlaubsanspruch 0–60 Tage').max(60, 'Urlaubsanspruch 0–60 Tage'),
    ),
    salutation: z.preprocess(emptyToNull, z.enum(['Herr', 'Frau', 'divers']).nullable().default(null)),
    tags: tagList,
    warning_note: optText,
    info: optText,
    mobile: optText,
    email_private: z.preprocess(emptyToNull, z.email('Ungültige weitere E-Mail').nullable().default(null)),
    wage_level_id: z.preprocess(emptyToNull, z.uuid().nullable().default(null)),
    pay_model: z.preprocess(
      emptyToNull,
      z.enum(['tarif', 'individuell', 'festgehalt']).nullable().default(null),
    ),
    monthly_salary: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\./g, '') : null),
      z
        .string()
        .regex(/^\d{1,6}(,\d{1,2})?$/, 'Festgehalt z. B. 2.450,00')
        .nullable()
        .default(null),
    ),
    carry_over_leave: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
    regular_sunday_work: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
    planning_group: optText,
    planning_notes: optText,
    version: versionField,
    // vertraulich
    birth_place: optText,
    birth_country: optText,
    marital_status: optText,
    residence_permit_info: optText,
    birth_date: optDate,
    street: optText,
    postal_code: optText,
    city: optText,
    nationality: optText,
    tax_id: z.preprocess(
      emptyToNull,
      z
        .string()
        .regex(/^\d{11}$/, 'Steuer-ID hat 11 Ziffern')
        .nullable()
        .default(null),
    ),
    social_security_no: optText,
    health_insurance: optText,
    iban: z.preprocess(
      emptyToNull,
      z.string().refine(validIban, 'IBAN ist ungültig (Prüfziffer)').nullable().default(null),
    ),
    residence_permit_until: optDate,
    private_version: versionField,
  })
  .refine((e) => !e.exit_date || e.exit_date >= e.entry_date, {
    message: 'Austritt liegt vor dem Eintritt',
    path: ['exit_date'],
  })
  .refine((e) => e.pay_model !== 'tarif' || e.wage_level_id, {
    message: 'Bitte den Tariflohn (Lohngruppe) wählen',
    path: ['wage_level_id'],
  })
  .refine((e) => e.pay_model !== 'individuell' || e.hourly_wage, {
    message: 'Bitte den individuellen Stundenlohn eintragen',
    path: ['hourly_wage'],
  })
  .refine((e) => e.pay_model !== 'festgehalt' || e.monthly_salary, {
    message: 'Bitte das Festgehalt (brutto/Monat) eintragen',
    path: ['monthly_salary'],
  })
  .refine((e) => e.pay_model !== 'festgehalt' || (e.weekly_hours ?? 0) > 0, {
    message: 'Bei Festgehalt bitte die Wochenstunden angeben (für Mindestlohn-Prüfung und Nachkalkulation)',
    path: ['weekly_hours'],
  });

export type EmployeeInput = z.infer<typeof employeeInput>;

export async function listEmployees(
  sql: Sql,
  opts: { status?: 'aktiv' | 'ausgetreten'; q?: string; tag?: string } = {},
) {
  return sql<(Employee & { residence_permit_until: string | null; site_count: number })[]>`
    select e.*, p.residence_permit_until,
           (select count(*)::int from app.employee_sites es where es.employee_id = e.id) as site_count
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     where ${opts.status ? sql`e.status = ${opts.status}` : sql`true`}
       and ${opts.tag ? sql`${opts.tag} = any(e.tags)` : sql`true`}
       and ${opts.q ? sql`(e.last_name || ' ' || e.first_name || ' ' || e.personnel_no) ilike ${'%' + opts.q + '%'}` : sql`true`}
     order by e.last_name, e.first_name`;
}

export async function getEmployee(sql: Sql, id: string) {
  const [e] = await sql<Employee[]>`select * from app.employees where id = ${id}`;
  if (!e) return undefined;
  const [p] = await sql<EmployeePrivate[]>`select * from app.employee_private where employee_id = ${id}`;
  const sites = await sql<{ id: string; site_no: string; name: string }[]>`
    select s.id, s.site_no, s.name from app.employee_sites es join app.sites s on s.id = es.site_id
     where es.employee_id = ${id} order by s.site_no`;
  return { employee: e, priv: p, sites };
}

function centsFromWage(v: string | null): bigint | null {
  if (!v) return null;
  const [eur, ct = ''] = v
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.')
    .split('.');
  return BigInt(eur!) * 100n + BigInt(ct.padEnd(2, '0'));
}

export async function saveEmployee(sql: Sql, id: string, input: EmployeeInput, actor: string) {
  const status = input.exit_date && input.exit_date <= todayBerlin() ? 'ausgetreten' : 'aktiv';
  const base = {
    personnel_no: input.personnel_no,
    first_name: input.first_name,
    last_name: input.last_name,
    employment_type: input.employment_type,
    entry_date: input.entry_date,
    exit_date: input.exit_date,
    status,
    weekly_hours: input.weekly_hours,
    // Vergütung: nur das Feld der gewählten Art bleibt gesetzt
    hourly_wage_cents:
      input.pay_model && input.pay_model !== 'individuell' ? null : centsFromWage(input.hourly_wage),
    pay_model: input.pay_model,
    monthly_salary_cents: input.pay_model === 'festgehalt' ? centsFromWage(input.monthly_salary) : null,
    phone: input.phone,
    email: input.email,
    languages: input.languages,
    annual_leave_days: input.annual_leave_days,
    salutation: input.salutation,
    tags: input.tags,
    warning_note: input.warning_note,
    info: input.info,
    mobile: input.mobile,
    email_private: input.email_private,
    wage_level_id: input.pay_model && input.pay_model !== 'tarif' ? null : input.wage_level_id,
    carry_over_leave: input.carry_over_leave,
    regular_sunday_work: input.regular_sunday_work,
    planning_group: input.planning_group,
    planning_notes: input.planning_notes,
  };
  const priv = {
    birth_date: input.birth_date,
    street: input.street,
    postal_code: input.postal_code,
    city: input.city,
    nationality: input.nationality,
    tax_id: input.tax_id,
    social_security_no: input.social_security_no,
    health_insurance: input.health_insurance,
    iban: input.iban ? input.iban.replace(/\s/g, '').toUpperCase() : null,
    residence_permit_until: input.residence_permit_until,
    birth_place: input.birth_place,
    birth_country: input.birth_country,
    marital_status: input.marital_status,
    residence_permit_info: input.residence_permit_info,
  };
  try {
    await sql.begin(async (tx) => {
      const [cur] = await tx<
        { version: number }[]
      >`select version from app.employees where id = ${id} for update`;
      assertVersion(cur?.version, input.version, 'Der Mitarbeiter');
      if (cur) {
        await tx`update app.employees set ${tx({ ...base, updated_at: new Date() } as Record<string, unknown>)} where id = ${id}`;
      } else {
        await tx`insert into app.employees ${tx({ id, ...base } as Record<string, unknown>)}`;
      }
      const [curP] = await tx<
        { version: number }[]
      >`select version from app.employee_private where employee_id = ${id} for update`;
      assertVersion(curP?.version, input.private_version, 'Die vertraulichen Daten');
      if (curP) {
        await tx`update app.employee_private set ${tx({ ...priv, updated_at: new Date() } as Record<string, unknown>)}
                 where employee_id = ${id}`;
      } else {
        await tx`insert into app.employee_private ${tx({ employee_id: id, ...priv } as Record<string, unknown>)}`;
      }
      // Protokoll ohne vertrauliche Inhalte
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, ${cur ? 'update' : 'create'}, 'employee', ${id}, ${tx.json({ personnel_no: input.personnel_no })})`;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw new BusinessError('Personalnummer ist bereits vergeben');
    throw err;
  }
}

export async function setEmployeeSites(sql: Sql, id: string, siteIds: string[]) {
  await sql.begin(async (tx) => {
    await tx`delete from app.employee_sites where employee_id = ${id}`;
    for (const s of siteIds)
      await tx`insert into app.employee_sites (employee_id, site_id) values (${id}, ${s})`;
  });
}

export async function suggestPersonnelNo(sql: Sql): Promise<string> {
  const [r] = await sql<{ n: string | null }[]>`
    select max(personnel_no::bigint)::text as n from app.employees where personnel_no ~ '^[0-9]+$'`;
  return String(Math.max(Number(r?.n ?? 0) + 1, 1001));
}

/** Startseite: Geburtstage (nächste 14 Tage), Firmenjubiläen, ablaufende Aufenthaltserlaubnisse (60 Tage). */
export async function hrReminders(sql: Sql) {
  const birthdays = await sql<{ id: string; name: string; birth_date: string; age: number }[]>`
    select e.id, e.first_name || ' ' || e.last_name as name, p.birth_date,
           (extract(year from age(current_date + 14, p.birth_date)))::int as age
      from app.employees e join app.employee_private p on p.employee_id = e.id
     where e.status = 'aktiv' and p.birth_date is not null
       and (make_date(extract(year from current_date)::int, extract(month from p.birth_date)::int,
                      least(extract(day from p.birth_date)::int, 28)) - current_date) between 0 and 14
     order by extract(month from p.birth_date), extract(day from p.birth_date)`;
  const jubilees = await sql<{ id: string; name: string; entry_date: string; years: number }[]>`
    select id, first_name || ' ' || last_name as name, entry_date,
           (extract(year from current_date) - extract(year from entry_date))::int as years
      from app.employees
     where status = 'aktiv' and extract(year from current_date) > extract(year from entry_date)
       and (make_date(extract(year from current_date)::int, extract(month from entry_date)::int,
                      least(extract(day from entry_date)::int, 28)) - current_date) between 0 and 14
     order by extract(month from entry_date), extract(day from entry_date)`;
  const permits = await sql<{ id: string; name: string; residence_permit_until: string }[]>`
    select e.id, e.first_name || ' ' || e.last_name as name, p.residence_permit_until
      from app.employees e join app.employee_private p on p.employee_id = e.id
     where e.status = 'aktiv' and p.residence_permit_until is not null
       and p.residence_permit_until <= current_date + 60
     order by p.residence_permit_until`;
  return { birthdays, jubilees, permits };
}

/**
 * Export für Lexware Lohn (Stammdaten). Das genaue Importformat hängt vom Lexware-Produkt ab
 * (offener Punkt) – bis dahin eine Semikolon-CSV in Excel-tauglicher Form (UTF-8 mit BOM).
 */
export async function exportEmployeesCsv(sql: Sql): Promise<string> {
  const rows = await sql`
    select e.personnel_no, e.last_name, e.first_name, e.employment_type, e.entry_date, e.exit_date, e.weekly_hours,
           e.hourly_wage_cents, p.birth_date, p.street, p.postal_code, p.city, p.nationality, p.tax_id,
           p.social_security_no, p.health_insurance, p.iban
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     order by e.personnel_no`;
  const header = [
    'Personalnummer',
    'Nachname',
    'Vorname',
    'Beschäftigung',
    'Eintritt',
    'Austritt',
    'Wochenstunden',
    'Stundenlohn',
    'Geburtsdatum',
    'Straße',
    'PLZ',
    'Ort',
    'Staatsangehörigkeit',
    'Steuer-ID',
    'SV-Nummer',
    'Krankenkasse',
    'IBAN',
  ];
  const de = (d: unknown) => (typeof d === 'string' && d ? d.split('-').reverse().join('.') : '');
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.personnel_no,
      r.last_name,
      r.first_name,
      EMPLOYMENT_TYPES[r.employment_type as keyof typeof EMPLOYMENT_TYPES],
      de(r.entry_date),
      de(r.exit_date),
      r.weekly_hours != null ? String(Number(r.weekly_hours)).replace('.', ',') : '',
      r.hourly_wage_cents != null
        ? `${(r.hourly_wage_cents as bigint) / 100n},${String((r.hourly_wage_cents as bigint) % 100n).padStart(2, '0')}`
        : '',
      de(r.birth_date),
      r.street,
      r.postal_code,
      r.city,
      r.nationality,
      r.tax_id,
      r.social_security_no,
      r.health_insurance,
      r.iban,
    ]
      .map(esc)
      .join(';'),
  );
  return '﻿' + [header.join(';'), ...lines].join('\r\n') + '\r\n';
}

/** Alle verwendeten Tags (für Filter-Chips). */
export async function allTags(sql: Sql) {
  return sql<{ tag: string; n: number }[]>`
    select t as tag, count(*)::int as n from app.employees, unnest(tags) t
     where status = 'aktiv' group by t order by t`;
}

// ---------------------------------------------------------------------------
// Lohnstufen
// ---------------------------------------------------------------------------

export interface WageLevel {
  id: string;
  name: string;
  hourly_wage_cents: bigint;
  valid_from: string | null;
  note: string | null;
  active: boolean;
  version: number;
}

export async function listWageLevels(sql: Sql, all = false) {
  return sql<(WageLevel & { employees: number })[]>`
    select w.*, (select count(*)::int from app.employees e where e.wage_level_id = w.id and e.status = 'aktiv') as employees
      from app.wage_levels w where ${all ? sql`true` : sql`w.active`} order by w.name`;
}

export async function saveWageLevel(
  sql: Sql,
  id: string,
  p: {
    name: string;
    wageCents: bigint;
    validFrom: string | null;
    note: string | null;
    active: boolean;
    expectedVersion: number | null;
  },
) {
  if (!p.name.trim()) throw new BusinessError('Bitte Bezeichnung angeben');
  if (p.wageCents <= 0n) throw new BusinessError('Stundenlohn muss größer 0 sein');
  const [cur] = await sql<{ version: number }[]>`select version from app.wage_levels where id = ${id}`;
  assertVersion(cur?.version, p.expectedVersion, 'Die Lohnstufe');
  try {
    await sql`
      insert into app.wage_levels (id, name, hourly_wage_cents, valid_from, note, active)
      values (${id}, ${p.name.trim()}, ${p.wageCents}, ${p.validFrom}, ${p.note}, ${p.active})
      on conflict (id) do update set name = excluded.name, hourly_wage_cents = excluded.hourly_wage_cents,
        valid_from = excluded.valid_from, note = excluded.note, active = excluded.active`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new BusinessError(`„${p.name.trim()}“ gibt es schon`);
    throw e;
  }
}

/** Wirksamer Stundenlohn: individueller Lohn vor Lohnstufe. */
export async function effectiveWage(sql: Sql, employeeId: string): Promise<bigint | null> {
  const [r] = await sql<{ c: bigint | null }[]>`
    select app.effective_wage_cents(e) as c from app.employees e where e.id = ${employeeId}`;
  return r?.c ?? null;
}

// ---------------------------------------------------------------------------
// Dokumentvorlagen (Serienbrief, „Neu aus Vorlage“)
// ---------------------------------------------------------------------------

export const DOC_CATEGORIES = [
  'Arbeitsvertrag',
  'Personalunterlagen',
  'Unterweisung',
  'Bescheinigung',
  'Sonstiges',
];

export interface DocumentTemplate {
  id: string;
  title: string;
  category: string;
  body: string;
  active: boolean;
  version: number;
  audience: 'mitarbeiter' | 'kunde';
}

export async function listTemplates(
  sql: Sql,
  all = false,
  audience: 'mitarbeiter' | 'kunde' = 'mitarbeiter',
) {
  return sql<DocumentTemplate[]>`
    select * from app.document_templates where ${all ? sql`true` : sql`active`} and audience = ${audience}
     order by title`;
}

export async function saveTemplate(
  sql: Sql,
  id: string,
  p: {
    title: string;
    category: string;
    body: string;
    active: boolean;
    expectedVersion: number | null;
    audience?: 'mitarbeiter' | 'kunde';
  },
) {
  if (!p.title.trim() || !p.body.trim()) throw new BusinessError('Bitte Titel und Text angeben');
  const [cur] = await sql<{ version: number }[]>`select version from app.document_templates where id = ${id}`;
  assertVersion(cur?.version, p.expectedVersion, 'Die Vorlage');
  await sql`
    insert into app.document_templates (id, title, category, body, active, audience)
    values (${id}, ${p.title.trim()}, ${p.category}, ${p.body}, ${p.active}, ${p.audience ?? 'mitarbeiter'})
    on conflict (id) do update set title = excluded.title, category = excluded.category, body = excluded.body,
      active = excluded.active`;
}

export const TEMPLATE_FIELDS: [string, string][] = [
  ['anrede_name', 'Herr Max Mustermann'],
  ['anrede', 'Herr / Frau'],
  ['vorname', 'Vorname'],
  ['nachname', 'Nachname'],
  ['personalnummer', 'Personalnummer'],
  ['eintritt', 'Eintrittsdatum'],
  ['beschaeftigung', 'Beschäftigungsart'],
  ['wochenstunden', 'Wochenstunden'],
  ['geburtsdatum', 'Geburtsdatum'],
  ['strasse', 'Straße'],
  ['plz', 'PLZ'],
  ['ort', 'Ort'],
  ['heute', 'heutiges Datum'],
];

/** Platzhalter füllen. Unbekannte Platzhalter bleiben sichtbar stehen (fällt beim Lesen auf). */
export function fillTemplate(body: string, e: Employee, p: Partial<EmployeePrivate> | undefined): string {
  const d = (x: string | null | undefined) => (x ? x.split('-').reverse().join('.') : '');
  const anrede = e.salutation === 'divers' ? '' : (e.salutation ?? '');
  const v: Record<string, string> = {
    anrede_name: [anrede, e.first_name, e.last_name].filter(Boolean).join(' '),
    anrede,
    vorname: e.first_name,
    nachname: e.last_name,
    personalnummer: e.personnel_no,
    eintritt: d(e.entry_date),
    beschaeftigung: EMPLOYMENT_TYPES[e.employment_type],
    wochenstunden: e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '–',
    geburtsdatum: d(p?.birth_date),
    strasse: p?.street ?? '',
    plz: p?.postal_code ?? '',
    ort: p?.city ?? '',
    heute: d(todayBerlin()),
  };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => v[k] ?? m);
}

export async function planningGroups(sql: Sql) {
  return (
    await sql<{ g: string }[]>`select distinct planning_group as g from app.employees
                                where status = 'aktiv' and planning_group is not null order by 1`
  ).map((r) => r.g);
}
