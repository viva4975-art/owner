import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Bewerber-Pool und Stellenanzeigen (wie die alte App). Anders als alt: ein gemeinsames Vokabular für Berufsart und
 * Arbeitszeit bei Bewerbern und Stellen – in der alten App passten z. B. „Büro“ und „Bürokraft“ nie zusammen, das
 * Matching war dadurch bei 75 % gedeckelt. Unterlagen liegen in der Datenbank und werden beim Löschen wirklich gelöscht
 * (DSGVO); abgelehnte Bewerber werden nach 6 Monaten zum Löschen vorgeschlagen (Frist § 15 Abs. 4 AGG + Klagefrist).
 */

export const JOB_TYPES = [
  'Reinigungskraft',
  'Glasreiniger',
  'Hausmeister',
  'Bürokraft',
  'Vorarbeiter / Objektleitung',
  'Fahrer',
];
export const TIMES: Record<string, string> = {
  morgens: 'Morgens',
  tagsüber: 'Tagsüber',
  nachmittags: 'Nachmittags',
  abends: 'Abends',
  nachts: 'Nachts',
  flexibel: 'Flexibel',
};
export const LANGUAGES = [
  'Deutsch',
  'Englisch',
  'Polnisch',
  'Rumänisch',
  'Türkisch',
  'Russisch',
  'Arabisch',
  'Ungarisch',
  'Griechisch',
  'Andere',
];
export const EXPERIENCE: Record<string, string> = {
  keine: 'Keine',
  wenig: 'Wenig (<1 Jahr)',
  mittel: 'Mittel (1-3 Jahre)',
  viel: 'Viel (>3 Jahre)',
};
export const APPLICANT_STATUS: Record<string, string> = {
  Neu: 'info',
  'In Prüfung': 'warn',
  Gespräch: 'gold',
  Eingestellt: 'ok',
  Abgelehnt: 'err',
};
export const OBJECT_TYPES: [string, string][] = [
  ['Schule', 'Schule'],
  ['Kindergarten', 'Kindergarten / Kita'],
  ['Hort', 'Hort'],
  ['Krippe', 'Krippe'],
  ['Bürogebäude', 'Bürogebäude'],
  ['Praxis', 'Arzt-/Zahnarztpraxis'],
  ['Klinik', 'Klinik / Krankenhaus'],
  ['Pflegeheim', 'Pflegeheim / Seniorenheim'],
  ['Flüchtlingsunterkunft', 'Flüchtlingsunterkunft'],
  ['Wohnheim', 'Wohnheim / Studentenwohnheim'],
  ['Hotel', 'Hotel / Pension'],
  ['Restaurant', 'Restaurant'],
  ['Küche', 'Küche / Kantine'],
  ['Lebensmittelbetrieb', 'Lebensmittelbetrieb'],
  ['Gewerbe', 'Gewerbeobjekt / Werkstatt'],
  ['Industrie', 'Industrie / Produktion'],
  ['Lager', 'Lager / Logistik'],
  ['Einzelhandel', 'Einzelhandel / Filiale'],
  ['Sportstätte', 'Sportstätte / Fitnessstudio'],
  ['Schwimmbad', 'Schwimmbad / Therme'],
  ['Behörde', 'Behörde / Amt'],
  ['Bildungseinrichtung', 'Bildungseinrichtung / Hochschule'],
  ['Kirche', 'Kirche / Gemeinde'],
  ['Wohngebäude', 'Wohngebäude / Treppenhaus'],
  ['Privathaushalt', 'Privathaushalt'],
  ['Sonstiges', 'Sonstiges'],
];
export const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
export type Workdays = Partial<
  Record<(typeof DAYS)[number], { mode: 'fest' | 'flexibel'; from?: string; to?: string }>
>;

export const TEMPLATES: Record<
  string,
  { name: string; type: string; hours: number; time: string; wage: string; tasks: string; req: string }
> = {
  reinigungskraft: {
    name: 'Reinigungskraft',
    type: 'Reinigungskraft',
    hours: 20,
    time: 'morgens',
    wage: '15,00',
    tasks: 'Unterhaltsreinigung von Büros · Treppenhausreinigung · Sanitärreinigung · einfache Glasflächen',
    req: 'Zuverlässigkeit · Pünktlichkeit · Grundkenntnisse Deutsch',
  },
  glasreiniger: {
    name: 'Glasreiniger',
    type: 'Glasreiniger',
    hours: 40,
    time: 'morgens',
    wage: '18,40',
    tasks:
      'Glas- und Fassadenreinigung · Innen- und Außenreinigung · Reinigung mit Hebebühne und Teleskopstange',
    req: 'Schwindelfrei · Erfahrung Glasreinigung · Führerschein Klasse B',
  },
  hausmeister: {
    name: 'Hausmeister',
    type: 'Hausmeister',
    hours: 30,
    time: 'morgens',
    wage: '17,00',
    tasks: 'Kleinere Reparaturen · Außenanlagen pflegen · Müllentsorgung · Ansprechpartner für Mieter',
    req: 'Handwerkliches Geschick · Selbstständige Arbeitsweise · Führerschein Klasse B',
  },
  buero: {
    name: 'Büromitarbeiter',
    type: 'Bürokraft',
    hours: 40,
    time: 'tagsüber',
    wage: '17,50',
    tasks: 'Kundenbetreuung · Auftragsbearbeitung · Rechnungen · Stundenabrechnung · Schriftverkehr',
    req: 'Erfahrung in Buchhaltung oder Verwaltung · MS Office · Deutsch fließend',
  },
  vorarbeiter: {
    name: 'Vorarbeiter / Objektleitung',
    type: 'Vorarbeiter / Objektleitung',
    hours: 40,
    time: 'morgens',
    wage: '19,50',
    tasks: 'Einsatzplanung · Qualitätskontrolle · Mitarbeiterführung · Kundenkontakt',
    req: 'Erfahrung im Reinigungsgewerbe · Führungsstärke · Führerschein Klasse B · Deutsch sehr gut',
  },
  fahrer: {
    name: 'Fahrer',
    type: 'Fahrer',
    hours: 40,
    time: 'morgens',
    wage: '16,50',
    tasks: 'Transport von Mitarbeitern und Material · Fahrzeugpflege · Pünktliche Anlieferung an Objekte',
    req: 'Führerschein Klasse B (BE von Vorteil) · Zuverlässigkeit · Pünktlichkeit',
  },
};

export interface Applicant {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  postal_code: string | null;
  city: string | null;
  language: string | null;
  job_type: string | null;
  hours: number | null;
  time_of_day: string | null;
  experience: string | null;
  available: string | null;
  driving_licence: boolean | null;
  note: string | null;
  status: string;
  status_changed_at: Date;
  created_at: Date;
  version: number;
  doc_count: number;
}

export interface Posting {
  id: string;
  title: string;
  job_type: string | null;
  object_type: string | null;
  hours: number | null;
  wage_cents: bigint | null;
  time_of_day: string | null;
  city: string | null;
  postal_code: string | null;
  street: string | null;
  start_on: string | null;
  language: string | null;
  tasks: string | null;
  requirements: string | null;
  workdays: Workdays;
  website: boolean;
  status: 'aktiv' | 'geschlossen';
  created_at: Date;
  version: number;
}

// ------------------------------------------------------------------ Matching (Gewichte wie alte App)

export interface Criteria {
  city: string | null;
  postal_code: string | null;
  hours: number | null;
  language: string | null;
  job_type: string | null;
  time_of_day: string | null;
}

export function score(a: Pick<Applicant, keyof Criteria>, s: Criteria) {
  let pts = 0;
  const hit: string[] = [];
  const miss: string[] = [];
  const low = (v: string | null) => (v ?? '').trim().toLowerCase();
  const add = (n: number, label: string) => {
    pts += n;
    hit.push(label);
  };
  if (s.city) {
    if (low(a.city).includes(low(s.city))) add(25, 'Ort');
    else miss.push('Ort');
  }
  if (s.postal_code) {
    if (a.postal_code && a.postal_code.startsWith(s.postal_code.slice(0, 2))) add(15, 'PLZ-Bereich');
    else miss.push('PLZ');
  }
  if (s.language) {
    if (low(a.language).includes(low(s.language))) add(15, 'Sprache');
    else miss.push('Sprache');
  }
  if (s.hours && a.hours) {
    const d = Math.abs(a.hours - s.hours);
    if (d < 5) add(20, 'Stunden ✓');
    else if (d < 10) add(10, 'Stunden ~');
    else miss.push('Stunden');
  } else if (s.hours) miss.push('Stunden');
  if (s.job_type) {
    if (a.job_type === s.job_type) add(15, 'Art');
    else miss.push('Art');
  }
  if (s.time_of_day) {
    // „flexibel“ passt zu jeder Zeit (in der alten App nie ein Treffer)
    if (a.time_of_day === s.time_of_day || a.time_of_day === 'flexibel' || s.time_of_day === 'flexibel')
      add(10, 'Zeit');
  }
  return { score: pts, percent: pts, hit, miss };
}

export const postingCriteria = (p: Posting): Criteria => ({
  city: p.city,
  postal_code: p.postal_code,
  hours: p.hours,
  language: p.language,
  job_type: p.job_type,
  time_of_day: p.time_of_day,
});

export function matches(list: Applicant[], c: Criteria, min = 50) {
  return list
    .filter((a) => a.status !== 'Eingestellt' && a.status !== 'Abgelehnt')
    .map((a) => ({ a, ...score(a, c) }))
    .filter((m) => m.score >= min)
    .sort((x, y) => y.score - x.score);
}

// ------------------------------------------------------------------ Bewerber

export async function listApplicants(sql: Sql): Promise<Applicant[]> {
  return sql<Applicant[]>`
    select a.*, a.hours::float8 as hours, (select count(*)::int from app.applicant_documents d where d.applicant_id = a.id) as doc_count
      from app.applicants a order by a.created_at desc`;
}

export async function getApplicant(sql: Sql, id: string) {
  const [a] = await sql<
    Applicant[]
  >`select *, hours::float8 as hours, 0 as doc_count from app.applicants where id = ${id}`;
  if (!a) return undefined;
  const docs = await sql<
    { id: string; name: string; size_bytes: number; uploaded_at: Date; uploaded_by: string }[]
  >`
    select id, name, size_bytes, uploaded_at, uploaded_by from app.applicant_documents
     where applicant_id = ${id} order by uploaded_at`;
  return { a, docs };
}

export interface ApplicantInput {
  name: string;
  phone: string | null;
  email: string | null;
  postalCode: string | null;
  city: string | null;
  language: string | null;
  jobType: string | null;
  hours: number | null;
  timeOfDay: string | null;
  experience: string | null;
  available: string | null;
  drivingLicence: boolean;
  note: string | null;
  status?: string;
  expectedVersion: number | null;
}

const t = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

export async function saveApplicant(sql: Sql, id: string, p: ApplicantInput, actor: string) {
  if (!p.name.trim()) throw new BusinessError('Name erforderlich!');
  if (p.postalCode && !/^\d{5}$/.test(p.postalCode.trim()))
    throw new BusinessError('PLZ muss 5-stellig sein');
  if (p.jobType && !JOB_TYPES.includes(p.jobType)) throw new BusinessError('Art ungültig');
  if (p.timeOfDay && !(p.timeOfDay in TIMES)) throw new BusinessError('Arbeitszeit ungültig');
  if (p.experience && !(p.experience in EXPERIENCE)) throw new BusinessError('Erfahrung ungültig');
  if (p.hours != null && (!Number.isFinite(p.hours) || p.hours < 1 || p.hours > 80))
    throw new BusinessError('Stunden 1–80');
  const row = {
    name: p.name.trim(),
    phone: t(p.phone),
    email: t(p.email),
    postal_code: t(p.postalCode),
    city: t(p.city),
    language: t(p.language),
    job_type: t(p.jobType),
    hours: p.hours,
    time_of_day: t(p.timeOfDay),
    experience: t(p.experience),
    available: t(p.available),
    driving_licence: p.drivingLicence,
    note: t(p.note),
  };
  const [cur] = await sql<{ version: number }[]>`select version from app.applicants where id = ${id}`;
  if (cur) {
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Der Bewerber wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.applicants set ${sql({ ...row, updated_at: new Date() })} where id = ${id}`;
  } else {
    await sql`insert into app.applicants ${sql({ id, ...row, status: p.status ?? 'Neu', created_by: actor })}
              on conflict (id) do nothing`;
  }
}

export async function setApplicantStatus(sql: Sql, id: string, status: string) {
  if (!(status in APPLICANT_STATUS)) throw new BusinessError('Status ungültig');
  await sql`update app.applicants set status = ${status}, status_changed_at = now()
             where id = ${id} and status <> ${status}`;
}

/** Löscht Bewerber samt Unterlagen endgültig (DSGVO). Im Protokoll steht nur, dass gelöscht wurde. */
export async function deleteApplicant(sql: Sql, id: string, actor: string) {
  const r = await sql`delete from app.applicants where id = ${id}`;
  if (r.count)
    await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'delete', 'applicant', ${id})`;
}

export async function addDocument(
  sql: Sql,
  applicantId: string,
  f: { bytes: Uint8Array; name: string; type: string },
  actor: string,
) {
  if (f.bytes.length > 10 * 1024 * 1024) throw new BusinessError(`${f.name}: zu groß (max. 10 MB)`);
  if (!/\.(pdf|jpe?g|png|docx?)$/i.test(f.name)) throw new BusinessError(`${f.name}: nur PDF, JPG, PNG, DOC`);
  const [a] = await sql`select 1 from app.applicants where id = ${applicantId}`;
  if (!a) throw new BusinessError('Bewerber nicht gefunden');
  await sql`insert into app.applicant_documents ${sql({
    id: randomUUID(),
    applicant_id: applicantId,
    name: f.name.replace(/[^\wäöüÄÖÜß.\- ]/g, '_').slice(0, 150),
    content_type: f.type || 'application/octet-stream',
    size_bytes: f.bytes.length,
    sha256: createHash('sha256').update(f.bytes).digest('hex'),
    content: Buffer.from(f.bytes),
    uploaded_by: actor,
  })}`;
}

export async function getDocument(sql: Sql, applicantId: string, docId: string) {
  const [d] = await sql<{ name: string; content_type: string; content: Buffer }[]>`
    select name, content_type, content from app.applicant_documents where id = ${docId} and applicant_id = ${applicantId}`;
  return d;
}

export async function deleteDocument(sql: Sql, applicantId: string, docId: string) {
  await sql`delete from app.applicant_documents where id = ${docId} and applicant_id = ${applicantId}`;
}

/** Abgelehnte Bewerber, deren Absage mehr als 6 Monate zurückliegt → zum Löschen vorschlagen. */
export async function deletionDue(sql: Sql) {
  return sql<{ id: string; name: string; status_changed_at: Date }[]>`
    select id, name, status_changed_at from app.applicants
     where status = 'Abgelehnt' and status_changed_at < now() - interval '6 months' order by status_changed_at`;
}

// ------------------------------------------------------------------ Stellen

export async function listPostings(sql: Sql): Promise<Posting[]> {
  return sql<
    Posting[]
  >`select *, hours::float8 as hours from app.job_postings order by status, created_at desc`;
}

export async function getPosting(sql: Sql, id: string) {
  const [p] = await sql<Posting[]>`select *, hours::float8 as hours from app.job_postings where id = ${id}`;
  return p;
}

export interface PostingInput {
  title: string;
  jobType: string | null;
  objectType: string | null;
  hours: number | null;
  wageCents: bigint | null;
  timeOfDay: string | null;
  city: string | null;
  postalCode: string | null;
  street: string | null;
  startOn: string | null;
  language: string | null;
  tasks: string | null;
  requirements: string | null;
  workdays: Workdays;
  website: boolean;
  expectedVersion: number | null;
}

export async function savePosting(sql: Sql, id: string, p: PostingInput, actor: string) {
  if (!p.title.trim()) throw new BusinessError('Stellentitel erforderlich');
  if (p.hours != null && (p.hours < 1 || p.hours > 60)) throw new BusinessError('Stunden / Woche 1–60');
  if (p.jobType && !JOB_TYPES.includes(p.jobType)) throw new BusinessError('Berufsart ungültig');
  if (p.timeOfDay && !(p.timeOfDay in TIMES)) throw new BusinessError('Arbeitszeit ungültig');
  if (p.postalCode && !/^\d{5}$/.test(p.postalCode)) throw new BusinessError('PLZ muss 5-stellig sein');
  for (const [d, v] of Object.entries(p.workdays)) {
    if (!DAYS.includes(d as never)) throw new BusinessError('Arbeitstag ungültig');
    if (v.mode === 'fest' && (!v.from || !v.to || v.from >= v.to))
      throw new BusinessError(`${d}: Uhrzeit von/bis prüfen`);
  }
  const row = {
    title: p.title.trim(),
    job_type: t(p.jobType),
    object_type: t(p.objectType),
    hours: p.hours,
    wage_cents: p.wageCents,
    time_of_day: t(p.timeOfDay),
    city: t(p.city),
    postal_code: t(p.postalCode),
    street: t(p.street),
    start_on: p.startOn,
    language: t(p.language),
    tasks: t(p.tasks),
    requirements: t(p.requirements),
    workdays: sql.json(p.workdays as never),
    website: p.website,
  };
  const [cur] = await sql<{ version: number }[]>`select version from app.job_postings where id = ${id}`;
  if (cur) {
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Die Stelle wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.job_postings set ${sql({ ...row, updated_at: new Date() } as never)} where id = ${id}`;
  } else {
    await sql`insert into app.job_postings ${sql({ id, ...row, created_by: actor } as never)} on conflict (id) do nothing`;
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, ${cur ? 'update' : 'create'}, 'job_posting', ${id}, ${sql.json({ titel: row.title })})`;
}

export async function setPostingStatus(sql: Sql, id: string, status: 'aktiv' | 'geschlossen') {
  await sql`update app.job_postings set status = ${status}, updated_at = now() where id = ${id}`;
}

export async function deletePosting(sql: Sql, id: string) {
  await sql`delete from app.job_postings where id = ${id}`;
}

/** „Mo–Fr: 06:00–10:00 · Sa: flexibel“ – gleiche Nachbartage zusammengefasst (wie alte App). */
export function workdaysText(w: Workdays): string {
  const key = (d: (typeof DAYS)[number]) => {
    const v = w[d];
    return v ? (v.mode === 'flexibel' ? 'flexibel' : `${v.from}–${v.to}`) : null;
  };
  const parts: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    const k = key(DAYS[i]!);
    if (!k) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < DAYS.length && key(DAYS[j + 1]!) === k) j++;
    const label = j - i >= 2 ? `${DAYS[i]}–${DAYS[j]}` : DAYS.slice(i, j + 1).join(', ');
    parts.push(`${label}: ${k}`);
    i = j + 1;
  }
  return parts.join(' · ');
}

// ------------------------------------------------------------------ Import alte App

const LEGACY_TYPE: Record<string, string> = {
  Reinigungskraft: 'Reinigungskraft',
  Objektleiter: 'Vorarbeiter / Objektleitung',
  Vorarbeiter: 'Vorarbeiter / Objektleitung',
  Bürokraft: 'Bürokraft',
  Büro: 'Bürokraft',
  Glasreiniger: 'Glasreiniger',
  Hausmeister: 'Hausmeister',
  Fahrer: 'Fahrer',
};
const LEGACY_TIME: Record<string, string> = {
  morgen: 'morgens',
  tag: 'tagsüber',
  abend: 'abends',
  nacht: 'nachts',
};
const LEGACY_EXP: Record<string, string> = {
  keine: 'keine',
  wenig: 'wenig',
  mittel: 'mittel',
  viel: 'viel',
  'unter 1 jahr': 'wenig',
  '1–2 jahre': 'mittel',
  '3–5 jahre': 'viel',
};

export async function importLegacyApplicants(sql: Sql, rows: Record<string, unknown>[], actor: string) {
  let n = 0;
  const s = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  for (const r of rows) {
    const legacyId = `bew:${String(r.id)}`;
    const notes: string[] = [];
    const rawType = s(r.art);
    const type = rawType ? (LEGACY_TYPE[rawType] ?? 'Reinigungskraft') : null;
    if (rawType && !LEGACY_TYPE[rawType]) notes.push(`Art (alt): ${rawType}`);
    const rawLang = s(r.sprache);
    const lang = rawLang ? (LANGUAGES.find((l) => rawLang.startsWith(l)) ?? 'Andere') : null;
    if (rawLang && lang && rawLang !== lang) notes.push(`Sprache (alt): ${rawLang}`);
    const exp = s(r.erfahrung) ? (LEGACY_EXP[s(r.erfahrung)!.toLowerCase()] ?? null) : null;
    let status = s(r.status) ?? 'Neu';
    if (!(status in APPLICANT_STATUS)) {
      notes.push(`Status (alt): ${status}`);
      status = 'In Prüfung';
    }
    const plz = s(r.plz);
    const hours = Number(String(r.stunden ?? '').replace(',', '.'));
    const fs = r.fuehrerschein;
    const res = await sql`insert into app.applicants ${sql({
      id: uuidOf(legacyId),
      name: s(r.name) ?? '(ohne Name)',
      phone: s(r.telefon),
      email: s(r.email),
      postal_code: plz && /^\d{5}$/.test(plz) ? plz : null,
      city: s(r.ort),
      language: lang,
      job_type: type,
      hours: Number.isFinite(hours) && hours >= 1 && hours <= 80 ? hours : null,
      time_of_day: s(r.zeit) ? (LEGACY_TIME[s(r.zeit)!] ?? null) : null,
      experience: exp,
      available: s(r.verfuegbar),
      driving_licence: fs === true || fs === 'ja' ? true : fs === false || fs === 'nein' ? false : null,
      note: [s(r.notiz), ...notes].filter(Boolean).join('\n') || null,
      status,
      legacy_id: legacyId,
      created_by: actor,
      created_at: r.created_at ? new Date(String(r.created_at)) : new Date(),
    } as never)} on conflict (legacy_id) do nothing`;
    n += res.count;
  }
  return n;
}
