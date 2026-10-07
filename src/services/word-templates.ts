import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { type FileRow, type UploadConfig, filePath, storeFile } from './uploads.js';

/*
 * Word-Vorlagen mit Fortytools-Platzhaltern: ${Mitarbeiter.Vorname}, ${Kunde.Name}, ${Dokument.Datum} …
 * Die .docx wird nur an den Platzhaltern verändert (Layout, Briefkopf, Schrift bleiben). Erzeugte Dokumente werden
 * write-once in der Akte abgelegt (Mitarbeiter, Kunde, Objekt) – Unterschrift auf Papier.
 */

export type Audience = 'mitarbeiter' | 'kunde' | 'objekt' | 'nachunternehmer';
export const AUDIENCE_LABEL: Record<Audience, string> = {
  mitarbeiter: 'Mitarbeiter',
  kunde: 'Kunde',
  objekt: 'Objekt',
  nachunternehmer: 'Nachunternehmer',
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface WordTemplate {
  id: string;
  code: string | null;
  name: string;
  audience: Audience;
  category: string;
  file_id: string;
  placeholders: string[];
  active: boolean;
  version: number;
}

/** Alle Platzhalter, die ausgefüllt werden (Anzeige in den Einstellungen). */
export const PLACEHOLDERS: Record<string, string[]> = {
  Mitarbeiter: [
    'Anrede',
    'Vorname',
    'Nachname',
    'Straße',
    'PLZ',
    'Ort',
    'Personalnummer',
    'Geburtsdatum',
    'Eintrittsdatum',
    'Austrittsdatum',
    'Wochenstunden',
    'Gehalt',
    'Stundenlohn',
    'Beschäftigungsart',
    'Einsatzgebiet',
    'Telefon',
    'E-Mail',
  ],
  Kunde: [
    'Name',
    'Kurzname',
    'Zusatz',
    'Straße',
    'PLZ',
    'Ort',
    'Nummer',
    'E-Mail',
    'Telefon',
    'Ansprechpartner',
  ],
  Objekt: ['Name', 'Nummer', 'Straße', 'PLZ', 'Ort'],
  Firma: ['Name', 'Straße', 'PLZ', 'Ort', 'Telefon', 'E-Mail', 'Geschäftsführer'],
  Dokument: ['Datum', 'Nummer', 'Signatur'],
};

const xmlEsc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const xmlUnesc = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!,
  );

const PH = /\$\{([^}]{1,80})\}/g;

/**
 * Platzhalter in einem WordprocessingML-Teil ersetzen. Word zerteilt Text oft in mehrere <w:t>-Läufe – deshalb je
 * Absatz: Texte der Läufe aneinanderhängen, Platzhalter im Gesamttext finden, Ersatz in den Lauf schreiben, in dem
 * der Platzhalter beginnt (dessen Formatierung gilt), und die übrigen betroffenen Läufe kürzen.
 */
export function fillXml(xml: string, value: (key: string) => string | null, missing: Set<string>): string {
  return xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para) => {
    const runs: { start: number; end: number; open: string; text: string }[] = [];
    const re = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)<\/w:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para)))
      runs.push({ start: m.index, end: m.index + m[0].length, open: m[1]!, text: xmlUnesc(m[2]!) });
    if (!runs.length) return para;
    const full = runs.map((r) => r.text).join('');
    if (!full.includes('${')) return para;
    // Zeichenposition → Lauf
    const owner: number[] = [];
    runs.forEach((r, i) => {
      for (let k = 0; k < r.text.length; k++) owner.push(i);
    });
    const newText = runs.map((r) => r.text.split(''));
    const matches = [...full.matchAll(PH)];
    if (!matches.length) return para;
    for (const mm of matches.reverse()) {
      const key = mm[1]!.trim();
      const v = value(key);
      if (v == null) missing.add(key);
      const repl = v ?? '__________';
      const from = mm.index!;
      const to = from + mm[0].length; // exklusiv
      const first = owner[from]!;
      // Positionen innerhalb der Läufe
      let offset = 0;
      const startInRun: number[] = [];
      runs.forEach((r, i) => {
        startInRun[i] = offset;
        offset += r.text.length;
      });
      for (let i = owner[to - 1]!; i >= first; i--) {
        const rs = startInRun[i]!;
        const a = Math.max(from, rs) - rs;
        const b = Math.min(to, rs + runs[i]!.text.length) - rs;
        newText[i]!.splice(a, b - a, ...(i === first ? [repl] : []));
      }
    }
    let out = '';
    let last = 0;
    runs.forEach((r, i) => {
      const t = newText[i]!.join('');
      const open = /xml:space=/.test(r.open) ? r.open : r.open.replace('<w:t', '<w:t xml:space="preserve"');
      out += para.slice(last, r.start) + `${open}${xmlEsc(t)}</w:t>`;
      last = r.end;
    });
    return out + para.slice(last);
  });
}

const PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/** Ausgefüllte .docx; `missing` = Platzhalter ohne Wert (werden als Linie ausgegeben). */
export function fillDocx(bytes: Uint8Array, value: (key: string) => string | null) {
  const files = unzipSync(bytes);
  if (!files['word/document.xml']) throw new BusinessError('Keine Word-Datei (.docx)');
  const missing = new Set<string>();
  for (const name of Object.keys(files)) {
    if (!PART.test(name)) continue;
    files[name] = strToU8(fillXml(strFromU8(files[name]!), value, missing));
  }
  return { data: zipSync(files, { level: 6 }), missing: [...missing] };
}

export function placeholdersOf(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  const out = new Set<string>();
  for (const name of Object.keys(files)) {
    if (!PART.test(name)) continue;
    const text = strFromU8(files[name]!)
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '');
    for (const m of xmlUnesc(text).matchAll(PH)) out.add(m[1]!.trim());
  }
  return [...out].sort();
}

// ------------------------------------------------------------------ Import (einzeln oder ZIP)

const UMLAUT: [RegExp, string][] = [
  [/Ueberlassung/g, 'Überlassung'],
  [/ueberlassung/g, 'überlassung'],
  [/Uebergabe/g, 'Übergabe'],
  [/uebergabe/g, 'übergabe'],
  [/Uebernahme/g, 'Übernahme'],
  [/uebertragung/g, 'übertragung'],
  [/Kuendigung/g, 'Kündigung'],
  [/Schluessel/g, 'Schlüssel'],
  [/Fuehrerschein/g, 'Führerschein'],
  [/Beschaeftigung/g, 'Beschäftigung'],
  [/Verlaengerung/g, 'Verlängerung'],
  [/verlaengerung/g, 'verlängerung'],
  [/Bestaetigung/g, 'Bestätigung'],
  [/bestaetigung/g, 'bestätigung'],
];

/** „VD-AV-2026-V2_Arbeitsvertrag-Reinigungskraft.docx“ → Code „VD-AV-2026-V2“, Name „Arbeitsvertrag Reinigungskraft“. */
export function nameFromFile(file: string): { code: string | null; name: string } {
  const base = file
    .split('/')
    .pop()!
    .replace(/\.docx$/i, '');
  const m = /^(VD-[A-Za-z0-9-]+?)_(.+)$/.exec(base);
  let name = (m ? m[2]! : base.replace(/^VD-/, '').replace(/-20\d\d-V\d+$/, '')).replace(/[-_]+/g, ' ');
  for (const [re, r] of UMLAUT) name = name.replace(re, r);
  return { code: m ? m[1]! : base.startsWith('VD-') ? base : null, name: name.trim() };
}

/** Ablage-Kategorie wie in der Fortytools-Anleitung (Dokumenttypen). */
export function categoryFor(code: string | null, name: string, audience: Audience): string {
  const c = `${code ?? ''} ${name}`.toUpperCase();
  if (audience === 'mitarbeiter') {
    if (/(^| )VD-AV|ARBEITSVERTRAG/.test(c) && !/ZUSATZ|NACHTRAG/.test(c)) return 'Arbeitsvertrag';
    if (/ZV-|ZUSATZVEREINBARUNG|NACHTRAG|VERLÄNGERUNG|VERLAENGERUNG|BEFRISTUNG/.test(c))
      return 'Vertragsänderung';
    if (/AUF-|AUFHEBUNG|KUE-|KÜNDIGUNG/.test(c)) return 'Beendigung';
    if (/ABMAHNUNG/.test(c)) return 'Abmahnung';
    if (/UW-|UNTERWEISUNG|BELEHRUNG/.test(c)) return 'Unterweisung';
    if (/NU-KL|ARBEITSKLEIDUNG/.test(c)) return 'Arbeitskleidung';
    if (/SP-|SCHLÜSSEL/.test(c)) return 'Schlüssel';
    if (/NU-|ÜBERLASSUNG|DIENSTFAHRZEUG|TANKKARTE|BETRIEBSEIGENTUM/.test(c)) return 'Nutzungsüberlassung';
    if (/FÜHRERSCHEIN/.test(c)) return 'Führerscheinkontrolle';
    if (/FB-44|EINWILLIGUNG/.test(c)) return 'Einwilligung';
    if (/BB-|BESCHÄFTIGUNGSBESTÄTIGUNG/.test(c)) return 'Bescheinigung';
    if (/PS-|PERSONALSTAMM/.test(c)) return 'Personalunterlagen';
    return 'Sonstiges';
  }
  if (audience === 'objekt') {
    if (/ÜBERNAHME|BEGEHUNG/.test(c)) return 'Objektübernahme';
    return 'Sonstiges';
  }
  if (audience === 'kunde') return /AUE-|ÜBERLASSUNG/.test(c) ? 'Vertrag' : 'Schriftverkehr';
  return 'Verträge';
}

function audienceFor(path: string, placeholders: string[]): Audience {
  if (placeholders.some((p) => p.startsWith('Mitarbeiter.'))) return 'mitarbeiter';
  if (placeholders.some((p) => p.startsWith('Objekt.'))) return 'objekt';
  if (placeholders.some((p) => p.startsWith('Kunde.'))) return 'kunde';
  const p = path.toLowerCase();
  if (/objekt/.test(p)) return 'objekt';
  if (/kunde|überlassung|ueberlassung|aue-/.test(p)) return 'kunde';
  if (/nachunternehmer|lieferant/.test(p)) return 'nachunternehmer';
  return 'mitarbeiter';
}

export interface ImportResult {
  created: string[];
  existing: string[];
  skipped: string[];
}

/** .docx einzeln oder ZIP (Ordnerstruktur wie die Fortytools-Vorlagen) übernehmen. Gleiche Datei = nichts doppelt. */
export async function importWordTemplates(
  sql: Sql,
  cfg: UploadConfig,
  uploads: { name: string; data: Uint8Array }[],
  actor: string,
): Promise<ImportResult> {
  const docs: { path: string; data: Uint8Array }[] = [];
  for (const u of uploads) {
    if (/\.zip$/i.test(u.name)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(u.data);
      } catch {
        throw new BusinessError(`${u.name}: ZIP-Datei lässt sich nicht öffnen`);
      }
      for (const [path, data] of Object.entries(entries))
        if (/\.docx$/i.test(path) && !/(^|\/)(\._|__MACOSX|~\$)/.test(path) && data.length)
          docs.push({ path, data });
    } else if (/\.docx$/i.test(u.name)) docs.push({ path: u.name, data: u.data });
    else
      throw new BusinessError(
        `${u.name}: bitte .docx oder .zip hochladen (alte .doc-Dateien vorher in Word als .docx speichern)`,
      );
  }
  const res: ImportResult = { created: [], existing: [], skipped: [] };
  for (const d of docs) {
    const file = d.path.split('/').pop()!;
    if (/ANLEITUNG/i.test(file)) {
      res.skipped.push(file);
      continue;
    }
    let ph: string[];
    try {
      ph = placeholdersOf(d.data);
    } catch {
      res.skipped.push(file);
      continue;
    }
    const sha = createHash('sha256').update(d.data).digest('hex');
    const [dup] = await sql`select 1 from app.word_templates where sha256 = ${sha}`;
    if (dup) {
      res.existing.push(file);
      continue;
    }
    const { code, name } = nameFromFile(file);
    const audience = audienceFor(d.path, ph);
    const id = randomUUID();
    const f = await storeFile(
      sql,
      cfg,
      {
        id: randomUUID(),
        name: file,
        type: DOCX,
        data: d.data,
        link: { type: 'word_template', id },
        category: null,
      },
      actor,
    );
    await sql`insert into app.word_templates (id, code, name, audience, category, file_id, sha256, placeholders, created_by)
              values (${id}, ${code}, ${name}, ${audience}, ${categoryFor(code, name, audience)}, ${f.id}, ${sha},
                      ${ph}, ${actor}) on conflict (sha256) do nothing`;
    res.created.push(name);
  }
  return res;
}

export async function listWordTemplates(sql: Sql, audience?: Audience, all = false) {
  return sql<WordTemplate[]>`
    select * from app.word_templates
     where ${audience ? sql`audience = ${audience}` : sql`true`} and ${all ? sql`true` : sql`active`}
     order by audience, name`;
}

export async function updateWordTemplate(
  sql: Sql,
  id: string,
  p: { name: string; audience: Audience; category: string; active: boolean },
) {
  if (!p.name.trim()) throw new BusinessError('Name fehlt');
  if (!(p.audience in AUDIENCE_LABEL)) throw new BusinessError('Zielgruppe ungültig');
  await sql`update app.word_templates set name = ${p.name.trim()}, audience = ${p.audience},
              category = ${p.category.trim() || 'Sonstiges'}, active = ${p.active} where id = ${id}`;
}

// ------------------------------------------------------------------ Ausfüllen

const de = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
const euroDe = (c: bigint | number) =>
  (Number(c) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

async function companyValues(sql: Sql) {
  const [co] = await sql<
    {
      legal_name: string;
      street: string;
      postal_code: string;
      city: string;
      phone: string | null;
      email: string | null;
      managing_director: string | null;
    }[]
  >`select legal_name, street, postal_code, city, phone, email, managing_director from app.company where id = 1`;
  return {
    'Firma.Name': co?.legal_name ?? '',
    'Firma.Straße': co?.street ?? '',
    'Firma.PLZ': co?.postal_code ?? '',
    'Firma.Ort': co?.city ?? '',
    'Firma.Telefon': co?.phone ?? '',
    'Firma.E-Mail': co?.email ?? '',
    'Firma.Geschäftsführer': co?.managing_director ?? '',
  };
}

const EMPLOYMENT: Record<string, string> = {
  vollzeit: 'Vollzeit',
  teilzeit: 'Teilzeit',
  minijob: 'Minijob',
  werkstudent: 'Werkstudent',
  aushilfe: 'Aushilfe',
};

async function employeeValues(sql: Sql, id: string): Promise<Record<string, string>> {
  const [e] = await sql<
    {
      salutation: string | null;
      first_name: string;
      last_name: string;
      personnel_no: string;
      entry_date: string;
      exit_date: string | null;
      weekly_hours: string | null;
      employment_type: string;
      phone: string | null;
      mobile: string | null;
      email: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      birth_date: string | null;
      monthly_salary_cents: bigint | null;
      wage_cents: bigint | null;
    }[]
  >`
    select e.salutation, e.first_name, e.last_name, e.personnel_no, e.entry_date::text, e.exit_date::text,
           e.weekly_hours::text, e.employment_type, e.phone, e.mobile, e.email,
           p.street, p.postal_code, p.city, p.birth_date::text, e.monthly_salary_cents,
           coalesce(e.hourly_wage_cents, (select w.hourly_wage_cents from app.wage_levels w where w.id = e.wage_level_id)) as wage_cents
      from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${id}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const sites = await sql<{ name: string }[]>`
    select s.name from app.employee_sites es join app.sites s on s.id = es.site_id where es.employee_id = ${id} order by s.name`;
  const hours = e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '';
  const wage = e.wage_cents != null ? `${euroDe(e.wage_cents)} brutto je Stunde` : '';
  return {
    'Mitarbeiter.Anrede': e.salutation ?? '',
    'Mitarbeiter.Vorname': e.first_name,
    'Mitarbeiter.Nachname': e.last_name,
    'Mitarbeiter.Straße': e.street ?? '',
    'Mitarbeiter.PLZ': e.postal_code ?? '',
    'Mitarbeiter.Ort': e.city ?? '',
    'Mitarbeiter.Personalnummer': e.personnel_no,
    'Mitarbeiter.Geburtsdatum': de(e.birth_date),
    'Mitarbeiter.Eintrittsdatum': de(e.entry_date),
    'Mitarbeiter.Austrittsdatum': de(e.exit_date),
    'Mitarbeiter.Wochenstunden': hours,
    'Mitarbeiter.Gehalt':
      e.monthly_salary_cents != null ? `${euroDe(e.monthly_salary_cents)} brutto monatlich` : wage,
    'Mitarbeiter.Stundenlohn': e.wage_cents != null ? euroDe(e.wage_cents) : '',
    'Mitarbeiter.Beschäftigungsart': EMPLOYMENT[e.employment_type] ?? e.employment_type,
    'Mitarbeiter.Einsatzgebiet': sites.map((s) => s.name).join(', '),
    'Mitarbeiter.Telefon': e.mobile ?? e.phone ?? '',
    'Mitarbeiter.E-Mail': e.email ?? '',
  };
}

async function customerValues(sql: Sql, id: string): Promise<Record<string, string>> {
  const [c] = await sql<
    {
      name: string;
      name2: string | null;
      street: string;
      postal_code: string;
      city: string;
      customer_no: string;
      contact_name: string | null;
      contact_email: string | null;
      contact_phone: string | null;
      invoice_emails: string[];
    }[]
  >`select name, name2, street, postal_code, city, customer_no, contact_name, contact_email, contact_phone, invoice_emails
      from app.customers where id = ${id}`;
  if (!c) throw new BusinessError('Kunde nicht gefunden');
  return {
    'Kunde.Name': c.name,
    'Kunde.Kurzname': c.name,
    'Kunde.Zusatz': c.name2 ?? '',
    'Kunde.Straße': c.street,
    'Kunde.PLZ': c.postal_code,
    'Kunde.Ort': c.city,
    'Kunde.Nummer': c.customer_no,
    'Kunde.E-Mail': c.contact_email ?? c.invoice_emails[0] ?? '',
    'Kunde.Telefon': c.contact_phone ?? '',
    'Kunde.Ansprechpartner': c.contact_name ?? '',
  };
}

async function siteValues(sql: Sql, id: string): Promise<{ v: Record<string, string>; customerId: string }> {
  const [s] = await sql<
    {
      name: string;
      site_no: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      customer_id: string;
    }[]
  >`select name, site_no, street, postal_code, city, customer_id from app.sites where id = ${id}`;
  if (!s) throw new BusinessError('Objekt nicht gefunden');
  return {
    customerId: s.customer_id,
    v: {
      'Objekt.Name': s.name,
      'Objekt.Nummer': s.site_no,
      'Objekt.Straße': s.street ?? '',
      'Objekt.PLZ': s.postal_code ?? '',
      'Objekt.Ort': s.city ?? '',
    },
  };
}

export type WordTarget = { type: 'employee' | 'customer' | 'site'; id: string };

/**
 * Vorlage ausfüllen und in der Akte ablegen (write-once). Dateiname nach dem Schema der Anleitung: Typ_JJJJ-MM-TT.
 * `fileId` vom Formular → doppelt absenden legt nichts doppelt an.
 */
export async function generateFromWordTemplate(
  sql: Sql,
  cfg: UploadConfig,
  p: { templateId: string; target: WordTarget; fileId: string; actorName: string },
  actor: string,
): Promise<{ file: FileRow; missing: string[] }> {
  const [t] = await sql<(WordTemplate & { storage_path: string })[]>`
    select t.*, f.storage_path from app.word_templates t join app.files f on f.id = t.file_id where t.id = ${p.templateId}`;
  if (!t) throw new BusinessError('Vorlage nicht gefunden');
  const want: Record<WordTarget['type'], Audience[]> = {
    employee: ['mitarbeiter'],
    customer: ['kunde'],
    site: ['objekt', 'kunde'],
  };
  if (!want[p.target.type].includes(t.audience))
    throw new BusinessError(
      `Diese Vorlage ist für ${AUDIENCE_LABEL[t.audience]}, nicht für diesen Datensatz`,
    );
  const [exists] = await sql<FileRow[]>`select * from app.files where id = ${p.fileId}`;
  if (exists) return { file: exists, missing: [] };
  const today = todayBerlin();
  let values: Record<string, string> = {
    ...(await companyValues(sql)),
    'Dokument.Datum': de(today),
    'Dokument.Signatur': p.actorName,
    'Dokument.Nummer': p.fileId.slice(0, 8).toUpperCase(),
  };
  let suffix: string;
  if (p.target.type === 'employee') {
    const v = await employeeValues(sql, p.target.id);
    values = { ...values, ...v };
    suffix = v['Mitarbeiter.Nachname'] ?? '';
  } else if (p.target.type === 'customer') {
    values = { ...values, ...(await customerValues(sql, p.target.id)) };
    suffix = values['Kunde.Nummer'] ?? '';
  } else {
    const s = await siteValues(sql, p.target.id);
    values = { ...values, ...(await customerValues(sql, s.customerId)), ...s.v };
    suffix = values['Objekt.Nummer'] ?? '';
  }
  const bytes = await readFile(filePath(cfg, { storage_path: t.storage_path } as FileRow));
  // leere Werte wie fehlende: Linie zum Ausfüllen von Hand
  const { data, missing } = fillDocx(bytes, (k) => (values[k] ? values[k]! : null));
  const typ = t.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const name = `${typ}_${today}${suffix ? `_${suffix.replace(/[^\p{L}\p{N}]+/gu, '-')}` : ''}.docx`;
  const file = await storeFile(
    sql,
    cfg,
    { id: p.fileId, name, type: DOCX, data, link: p.target, category: t.category },
    actor,
  );
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'word_template', ${p.target.type}, ${p.target.id}, ${sql.json({ template: t.name, file: file.id })})`;
  return { file, missing };
}
