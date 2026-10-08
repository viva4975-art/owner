import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { type FormField, applyFormFields, formFieldsOf } from './word-form.js';
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
    'Staatsangehörigkeit',
    'Eintrittsdatum',
    'Austrittsdatum',
    'Wochenstunden',
    'Stundenlohn',
    'Monatsgehalt',
    'Gehalt',
    'Lohngruppe',
    'Urlaubstage',
    'Beschäftigungsart',
    'Objekte',
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
  Dokument: ['Datum', 'Erstelldatum', 'Unterschriftsdatum', 'Frist', 'Ort', 'Nummer', 'Signatur'],
  Vertrag: ['Datum', 'Beginn', 'Ende', 'Befristung bisher', 'Freistellung ab', 'Rückgabe bis'],
  Neu: ['Wochenstunden', 'Stundenlohn', 'Monatsgehalt', 'Lohngruppe', 'Einsatzort', 'Tätigkeit'],
};

/** Beschreibung der Datums-/Vertragsplatzhalter (Ausfüll-Seite, Einstellungen). */
export const PLACEHOLDER_HINT: Record<string, string> = {
  'Dokument.Datum': 'Datum des Schreibens (Briefkopf) – Standard heute',
  'Dokument.Erstelldatum': 'Erstelldatum – Standard heute',
  'Dokument.Unterschriftsdatum': '„München, den …“ über der Unterschrift – Standard heute',
  'Dokument.Frist': 'Frist für die Rücksendung – Standard heute + 14 Tage',
  'Vertrag.Datum': 'Datum des bestehenden Arbeitsvertrags – Standard Eintrittsdatum',
  'Vertrag.Beginn': 'gilt ab / Beginn – Standard 1. des Folgemonats',
  'Vertrag.Ende': 'Ende / befristet bis / Kündigung zum',
  'Neu.Wochenstunden': 'neue Wochenstunden',
  'Neu.Stundenlohn': 'neuer Stundenlohn (ohne €)',
  'Neu.Monatsgehalt': 'neues Bruttogehalt (ohne €)',
};

/** Platzhalter mit Datum (Ausfüll-Seite zeigt eine Datumsauswahl). */
export const isDateKey = (k: string) =>
  /(datum|beginn|ende|frist|bisher| ab| bis| am)$/i.test(k) && !/^Neu\./.test(k);

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
/**
 * Word-Datumsfelder (DATE, PRINTDATE …) zeigen beim Öffnen immer das heutige Datum – ein Vertrag hätte nächste Woche
 * ein anderes Datum. Deshalb werden sie beim Erzeugen durch das feste Dokumentdatum ersetzt.
 */
export function freezeDateFields(xml: string, date: string): string {
  const run = (m: string) => {
    const rPr = (/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(m) ?? [''])[0];
    return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(date)}</w:t></w:r>`;
  };
  return xml
    .replace(
      /<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="begin"\/><\/w:r>((?:(?!fldCharType="end")[\s\S])*?)<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="end"\/><\/w:r>/g,
      (m, inner: string) =>
        /<w:instrText[^>]*>\s*(DATE|CREATEDATE|PRINTDATE|SAVEDATE|TIME)\b/.test(inner) ? run(m) : m,
    )
    .replace(
      /<w:fldSimple [^>]*w:instr="\s*(?:DATE|CREATEDATE|PRINTDATE|SAVEDATE|TIME)\b[^"]*"[^>]*>[\s\S]*?<\/w:fldSimple>/g,
      run,
    );
}

export function fillDocx(
  bytes: Uint8Array,
  value: (key: string) => string | null,
  docDate?: string,
  form?: { boxes: Record<number, boolean>; blanks: Record<number, string> },
) {
  const files = unzipSync(bytes);
  if (!files['word/document.xml']) throw new BusinessError('Keine Word-Datei (.docx)');
  const missing = new Set<string>();
  for (const name of Object.keys(files)) {
    if (!PART.test(name)) continue;
    let xml = strFromU8(files[name]!);
    if (docDate) xml = freezeDateFields(xml, docDate);
    // Kästchen/Lücken vor den Platzhaltern (Indizes wie auf der Ausfüll-Seite, dort aus der Originaldatei)
    if (form && name === 'word/document.xml') xml = applyFormFields(xml, form.boxes, form.blanks);
    files[name] = strToU8(fillXml(xml, value, missing));
  }
  return { data: zipSync(files, { level: 6 }), missing: [...missing] };
}

/** Kästchen und Lücken der Vorlage (Hauptteil) für die Ausfüll-Seite. */
export function formFieldsOfDocx(bytes: Uint8Array): FormField[] {
  const xml = unzipSync(bytes)['word/document.xml'];
  return xml ? formFieldsOf(strFromU8(xml)) : [];
}

export async function templateFormFields(cfg: UploadConfig, storagePath: string) {
  return formFieldsOfDocx(await readFile(filePath(cfg, { storage_path: storagePath } as FileRow)));
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
  /** ältere Fassungen (gleicher Code ohne „-Vn“), die durch die neue ersetzt und deaktiviert wurden */
  replaced: string[];
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
  const res: ImportResult = { created: [], existing: [], skipped: [], replaced: [] };
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
    // neue Fassung (z. B. VD-AV-2026-V3 statt -V2): ältere Fassung bleibt gespeichert, wird aber deaktiviert
    if (code) {
      const old = await sql<{ name: string }[]>`
        update app.word_templates set active = false
         where id <> ${id} and active and audience = ${audience}
           and regexp_replace(code, '-V[0-9]+$', '') = ${code.replace(/-V\d+$/, '')}
        returning name`;
      res.replaced.push(...old.map((o) => o.name));
    }
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
/** Betrag ohne Währungszeichen – die Vorlagen schreiben „EUR“ bzw. „€“ selbst dahinter. */
const numDe = (c: bigint | number) =>
  (Number(c) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
      wage_level: string | null;
      annual_leave_days: string | null;
      nationality: string | null;
    }[]
  >`
    select e.salutation, e.first_name, e.last_name, e.personnel_no, e.entry_date::text, e.exit_date::text,
           e.weekly_hours::text, e.employment_type, e.phone, e.mobile, e.email,
           p.street, p.postal_code, p.city, p.birth_date::text, e.monthly_salary_cents, p.nationality,
           e.annual_leave_days::text,
           (select w.name from app.wage_levels w where w.id = e.wage_level_id and e.pay_model is distinct from 'individuell') as wage_level,
           coalesce(e.hourly_wage_cents, (select w.hourly_wage_cents from app.wage_levels w where w.id = e.wage_level_id)) as wage_cents
      from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${id}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const sites = await sql<{ name: string }[]>`
    select s.name from app.employee_sites es join app.sites s on s.id = es.site_id where es.employee_id = ${id} order by s.name`;
  const hours = e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '';
  const wage = e.wage_cents != null ? numDe(e.wage_cents) : '';
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
    'Mitarbeiter.Staatsangehörigkeit': e.nationality ?? '',
    'Mitarbeiter.Wochenstunden': hours,
    // Beträge ohne „€“ (die Vorlage schreibt „EUR“ dahinter); Gehalt = Monatsgehalt, sonst Stundenlohn
    'Mitarbeiter.Gehalt': e.monthly_salary_cents != null ? numDe(e.monthly_salary_cents) : wage,
    'Mitarbeiter.Monatsgehalt': e.monthly_salary_cents != null ? numDe(e.monthly_salary_cents) : '',
    'Mitarbeiter.Stundenlohn': wage,
    'Mitarbeiter.Lohngruppe': e.wage_level ?? '',
    'Mitarbeiter.Urlaubstage': e.annual_leave_days
      ? String(Number(e.annual_leave_days)).replace('.', ',')
      : '',
    'Mitarbeiter.Beschäftigungsart': EMPLOYMENT[e.employment_type] ?? e.employment_type,
    'Mitarbeiter.Objekte': sites.map((s) => s.name).join(', '),
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

async function loadTemplate(sql: Sql, templateId: string, target: WordTarget) {
  const [t] = await sql<(WordTemplate & { storage_path: string })[]>`
    select t.*, f.storage_path from app.word_templates t join app.files f on f.id = t.file_id where t.id = ${templateId}`;
  if (!t) throw new BusinessError('Vorlage nicht gefunden');
  const want: Record<WordTarget['type'], Audience[]> = {
    employee: ['mitarbeiter'],
    customer: ['kunde'],
    site: ['objekt', 'kunde'],
  };
  if (!want[target.type].includes(t.audience))
    throw new BusinessError(
      `Diese Vorlage ist für ${AUDIENCE_LABEL[t.audience]}, nicht für diesen Datensatz`,
    );
  return t;
}

const isoAdd = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const firstOfNextMonth = (iso: string) => {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Vorbelegung aller Platzhalter (Ausfüll-Seite): Werte aus Firma, Mitarbeiter/Kunde/Objekt und sinnvolle Daten
 * (heute, 1. des Folgemonats …). Datumswerte als TT.MM.JJJJ.
 */
export async function templateValues(
  sql: Sql,
  target: WordTarget,
  p: { actorName: string; fileId: string },
): Promise<{ values: Record<string, string>; suffix: string }> {
  const today = todayBerlin();
  let values: Record<string, string> = {
    ...(await companyValues(sql)),
    'Dokument.Datum': de(today),
    'Dokument.Erstelldatum': de(today),
    'Dokument.Unterschriftsdatum': de(today),
    'Dokument.Frist': de(isoAdd(today, 14)),
    'Dokument.Ort': 'München',
    'Dokument.Signatur': p.actorName,
    'Dokument.Nummer': p.fileId.slice(0, 8).toUpperCase(),
    'Vertrag.Beginn': de(firstOfNextMonth(today)),
  };
  let suffix: string;
  if (target.type === 'employee') {
    const v = await employeeValues(sql, target.id);
    values = { ...values, ...v, 'Vertrag.Datum': v['Mitarbeiter.Eintrittsdatum'] ?? '' };
    if (v['Mitarbeiter.Austrittsdatum']) values['Vertrag.Ende'] = v['Mitarbeiter.Austrittsdatum'];
    suffix = v['Mitarbeiter.Nachname'] ?? '';
  } else if (target.type === 'customer') {
    values = { ...values, ...(await customerValues(sql, target.id)) };
    suffix = values['Kunde.Nummer'] ?? '';
  } else {
    const s = await siteValues(sql, target.id);
    values = { ...values, ...(await customerValues(sql, s.customerId)), ...s.v };
    suffix = values['Objekt.Nummer'] ?? '';
  }
  return { values, suffix };
}

/** Eingabe der Ausfüll-Seite übernehmen: Datum aus <input type=date> (JJJJ-MM-TT) → TT.MM.JJJJ. */
export function normalizeOverride(key: string, v: string): string {
  const t = v.trim().slice(0, 500);
  return isDateKey(key) && /^\d{4}-\d{2}-\d{2}$/.test(t) ? de(t) : t;
}

/** TT.MM.JJJJ → JJJJ-MM-TT (für die Datumsauswahl). */
export const isoOfDe = (v: string) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

export async function getTemplateFor(sql: Sql, templateId: string, target: WordTarget) {
  return loadTemplate(sql, templateId, target);
}

/**
 * Vorlage ausfüllen und in der Akte ablegen (write-once). Dateiname nach dem Schema der Anleitung: Typ_JJJJ-MM-TT.
 * `fileId` vom Formular → doppelt absenden legt nichts doppelt an. `overrides` = Werte der Ausfüll-Seite.
 */
export async function generateFromWordTemplate(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    templateId: string;
    target: WordTarget;
    fileId: string;
    actorName: string;
    overrides?: Record<string, string>;
    /** Kästchen (Index → angekreuzt) und Lücken (Index → Text) der Ausfüll-Seite */
    form?: { boxes: Record<number, boolean>; blanks: Record<number, string> };
  },
  actor: string,
): Promise<{ file: FileRow; missing: string[] }> {
  const t = await loadTemplate(sql, p.templateId, p.target);
  const [exists] = await sql<FileRow[]>`select * from app.files where id = ${p.fileId}`;
  if (exists) return { file: exists, missing: [] };
  const today = todayBerlin();
  const base = await templateValues(sql, p.target, p);
  const values: Record<string, string> = { ...base.values };
  for (const [k, v] of Object.entries(p.overrides ?? {})) values[k] = normalizeOverride(k, v);
  const bytes = await readFile(filePath(cfg, { storage_path: t.storage_path } as FileRow));
  // leere Werte wie fehlende: Linie zum Ausfüllen von Hand; Word-Datumsfelder werden fest
  const { data, missing } = fillDocx(
    bytes,
    (k) => (values[k] ? values[k]! : null),
    values['Dokument.Datum'] || de(today),
    p.form,
  );
  const typ = t.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const suffix = base.suffix;
  const name = `${typ}_${today}${suffix ? `_${suffix.replace(/[^\p{L}\p{N}]+/gu, '-')}` : ''}.docx`;
  const file = await storeFile(
    sql,
    cfg,
    {
      id: p.fileId,
      name,
      type: DOCX,
      data,
      link: p.target,
      // beim Mitarbeiter als Entwurf ablegen: zählt erst der Scan der unterschriebenen Fassung (Ahmed 08.10.)
      category: p.target.type === 'employee' ? 'Entwurf (aus Vorlage)' : t.category,
    },
    actor,
  );
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'word_template', ${p.target.type}, ${p.target.id},
                    ${sql.json({ template: t.name, template_id: t.id, file: file.id })})`;
  return { file, missing };
}

/** Text der Word-Datei (Absätze; Tabellenzellen durch „ · “ getrennt) – für PDFs ohne Word-Programm. */
export function docxText(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  const xml = files['word/document.xml'];
  if (!xml) throw new BusinessError('Keine Word-Datei (.docx)');
  const s = strFromU8(xml)
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' · ')
    .replace(/<\/w:p>/g, '\u0001');
  return xmlUnesc(s.replace(/<[^>]+>/g, ''))
    .split('\u0001')
    .map((p) =>
      p
        .replace(/( · )+$/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Unterweisung/Dokument aus einer eigenen Word-Vorlage als PDF auf dem Briefpapier (Ahmed: „unsere Vorlagen“):
 * Firmen- und Dokumentangaben werden ausgefüllt, Mitarbeiter-Platzhalter bleiben als Linie (ein PDF für alle;
 * Name, Zeitpunkt und Unterschrift stehen auf dem Nachweisblatt je Person). Formatierungen aus Word (Tabellen,
 * Bilder) werden vereinfacht – bei aufwendigen Vorlagen besser als PDF hochladen.
 */
export async function wordTemplatePdf(
  sql: Sql,
  cfg: UploadConfig,
  templateId: string,
): Promise<{ title: string; pdf: Uint8Array; category: string }> {
  const [t] = await sql<(WordTemplate & { storage_path: string })[]>`
    select t.*, f.storage_path from app.word_templates t join app.files f on f.id = t.file_id
     where t.id = ${templateId} and t.audience = 'mitarbeiter'`;
  if (!t) throw new BusinessError('Vorlage nicht gefunden (nur Mitarbeiter-Vorlagen)');
  const today = todayBerlin();
  const values: Record<string, string> = {
    ...(await companyValues(sql)),
    'Dokument.Datum': de(today),
    'Dokument.Erstelldatum': de(today),
    'Dokument.Ort': 'München',
  };
  const bytes = await readFile(filePath(cfg, { storage_path: t.storage_path } as FileRow));
  const { data } = fillDocx(bytes, (k) => values[k] ?? null, de(today));
  const paras = docxText(data);
  const { renderLetterPdf } = await import('../pdf/render.js');
  const { getSeller } = await import('./masterdata.js');
  const seller = await getSeller(sql);
  const pdf = await renderLetterPdf({
    title: t.name,
    date: today,
    info: [['Datum', de(today)]],
    seller,
    buyer: {
      customerNo: '',
      name: 'An alle Mitarbeitenden',
      name2: null,
      street: '',
      postalCode: '',
      city: '',
      countryCode: 'DE',
      vatId: null,
      leitwegId: null,
      supplierNo: null,
      email: null,
      contactName: null,
      site: null,
    },
    greeting: null,
    intro: paras[0] ?? '',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: paras.slice(1),
  });
  return { title: t.name, pdf, category: t.category };
}
