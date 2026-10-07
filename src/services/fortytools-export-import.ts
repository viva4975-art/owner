import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { parseDate } from '../domain/bank/statement.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { saveContact } from './crm.js';
import { saveCustomerBankAccount } from './customer-overview.js';
import { employeeInput, saveEmployee, validIban } from './employees.js';
import { BusinessError } from './errors.js';
import {
  customerInput,
  saveCustomer,
  saveService,
  saveSite,
  serviceInput,
  siteInput,
  standardGroupId,
} from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Gesamtimport der Fortytools-Exporte (so wie Fortytools sie liefert, ohne Umbauen in Excel):
 *   Kunden.csv      – je Kontakt eine Zeile, Interessenten ohne Kundennummer, Name mehrzeilig, Zahlungsbedingung als Text
 *   Objekte.csv     – ohne Objektnummer, Kunde über Kundennummer (sonst Kurzname)
 *   Leistungen.csv  – „aktive Leistungen“: Objekt über Kunde + Objektname, „Link zum Auftrag“ als feste Kennung
 *   Mitarbeiter.csv – Komma-getrennt, Tags (Minijob/Teilzeit/Vollzeit/Objektleitung)
 * Die Dateien werden an der Kopfzeile erkannt. Vorschau zeigt Zahlen und alle Probleme, nichts wird gespeichert.
 * Übernahme mit festen IDs bzw. external_ref → erneut ausführen legt nichts doppelt an und setzt nach einem Abbruch fort.
 * Vorhandene Datensätze werden nur mit „aktualisieren“ überschrieben; vergebene Nummern bleiben.
 */

export type FtFile = 'kunden' | 'objekte' | 'leistungen' | 'mitarbeiter';
export const FT_FILE: Record<FtFile, string> = {
  kunden: 'Kunden',
  objekte: 'Objekte',
  leistungen: 'Leistungen',
  mitarbeiter: 'Mitarbeiter',
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');

/** Feste ID aus einem Schlüssel, als gültige UUID v4. */
export const uuidOf = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

function decode(bytes: Uint8Array): string {
  const utf = new TextDecoder('utf-8').decode(bytes);
  return (utf.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(bytes) : utf).replace(
    /^\uFEFF/,
    '',
  );
}

/** CSV mit Anführungszeichen, auch Zeilenumbrüche innerhalb von Feldern (Fortytools: mehrzeilige Namen). */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Tabelle mit Spaltenzugriff über normalisierte Namen; doppelte Namen (Kunden: zwei „E-Mail“) per Index. */
interface Table {
  kind: FtFile;
  headers: string[];
  rows: string[][];
}

const SIGNATURES: Record<FtFile, string[]> = {
  kunden: ['kundenstatus', 'kurzname', 'zahlungsbedingung'],
  objekte: ['kundennummer', 'name', 'status'],
  leistungen: ['objektname', 'leistungsart', 'betrag'],
  mitarbeiter: ['personalnummer', 'nachname', 'wochenstunden'],
};

/** Fortytools schreibt Kopfzeilen wie {one: "Kundenstatus", other: "…"} – auf den ersten Namen kürzen. */
const headerName = (h: string) => {
  const m = /one:\s*"?([^",}]+)/.exec(h);
  return norm(m ? m[1]! : h);
};

export function detectTable(bytes: Uint8Array): Table {
  const all = parseCsv(decode(bytes));
  if (all.length < 2) throw new BusinessError('Datei enthält keine Datenzeilen');
  const headers = all[0]!.map(headerName);
  const kind = (Object.keys(SIGNATURES) as FtFile[]).find((k) =>
    SIGNATURES[k].every((s) => headers.includes(s)),
  );
  if (!kind)
    throw new BusinessError(
      `Datei nicht erkannt (Kopfzeile: ${all[0]!.slice(0, 6).join(', ')} …). Erwartet: Kunden-, Objekte-, Leistungen- oder Mitarbeiter-Export aus Fortytools.`,
    );
  const width = headers.length;
  const rows = all.slice(1).map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
  return { kind, headers, rows };
}

const col = (t: Table, name: string, nth = 0) => {
  let seen = -1;
  for (let i = 0; i < t.headers.length; i++) if (t.headers[i] === name && ++seen === nth) return i;
  return -1;
};
const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type Status = 'neu' | 'vorhanden' | 'fehler';
export interface Issue {
  area: FtFile;
  ref: string;
  level: 'fehler' | 'hinweis';
  text: string;
}

interface PCustomer {
  key: string; // external_ref
  id: string;
  customerNo: string;
  label: string;
  status: Status;
  input: Record<string, unknown>;
  contacts: { id: string; input: Record<string, unknown> }[];
  banks: { id: string; holder: string; iban: string; bic: string | null }[];
}
interface PSite {
  key: string;
  id: string;
  siteNo: string;
  customerId: string;
  label: string;
  status: Status;
  input: Record<string, unknown>;
}
interface PService {
  id: string;
  siteId: string;
  label: string;
  status: Status;
  input: Record<string, unknown>;
  typeName: string;
}
interface PEmployee {
  id: string;
  personnelNo: string;
  label: string;
  status: Status;
  input: Record<string, unknown>;
}

export interface Plan {
  files: FtFile[];
  customers: PCustomer[];
  sites: PSite[];
  services: PService[];
  employees: PEmployee[];
  serviceTypes: { name: string; id: string; exists: boolean }[];
  issues: Issue[];
}

/** „7 Tage 3%, 20 Tage netto“ → Skonto 3 % / 7 Tage, Zahlungsziel 20 Tage. */
export function parsePaymentTerms(v: string) {
  const net = /(\d+)\s*Tage\s*netto/i.exec(v);
  const sk = /(\d+)\s*Tage\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(v);
  return {
    days: net ? Number(net[1]) : null,
    skontoDays: sk ? Number(sk[1]) : null,
    skontoPercent: sk ? sk[2]!.replace('.', ',') : null,
    subcontractor: /subunternehmer/i.test(v),
  };
}

const EMAIL = { test: (v: string) => z.email().safeParse(v).success };
const statusOf = (s: string) =>
  /ehemalig/i.test(s) ? 'ehemalig' : /interessent/i.test(s) ? 'interessent' : 'kunde';
const zodText = (e: { issues: { message: string; path: PropertyKey[] }[] }) =>
  e.issues.map((i) => i.message).join('; ');

/** Regelmäßig (Monatslauf) nur Unterhaltsreinigung und Spüldienste – alles andere wird je Ausführung abgerechnet. */
const MONTHLY_TYPES = ['unterhaltsreinigung', 'spueldienste', 'spueldienst'];

export async function buildPlan(sql: Sql, tables: Table[]): Promise<Plan> {
  const byKind = new Map<FtFile, Table>();
  for (const t of tables) {
    if (byKind.has(t.kind)) throw new BusinessError(`${FT_FILE[t.kind]}-Datei doppelt hochgeladen`);
    byKind.set(t.kind, t);
  }
  const issues: Issue[] = [];
  const plan: Plan = {
    files: [...byKind.keys()],
    customers: [],
    sites: [],
    services: [],
    employees: [],
    serviceTypes: [],
    issues,
  };

  // Bestand
  const dbCustomers = await sql<
    { id: string; customer_no: string; external_ref: string | null; name: string }[]
  >`select id, customer_no, external_ref, name from app.customers order by customer_no`;
  // Interessenten ohne Nummer: über den Namen erkennen (z. B. schon aus dem XML-Import mit vergebener Nummer)
  const custByName = new Map<string, (typeof dbCustomers)[number]>();
  for (const x of dbCustomers) if (!custByName.has(norm(x.name))) custByName.set(norm(x.name), x);
  const custByNo = new Map(dbCustomers.map((c) => [c.customer_no, c]));
  const custByRef = new Map(dbCustomers.filter((c) => c.external_ref).map((c) => [c.external_ref!, c]));
  const dbSites = await sql<
    {
      id: string;
      site_no: string;
      external_ref: string | null;
      customer_id: string;
      name: string;
      street: string | null;
    }[]
  >`
    select id, site_no, external_ref, customer_id, name, street from app.sites order by site_no`;
  const siteByRef = new Map(dbSites.filter((s) => s.external_ref).map((s) => [s.external_ref!, s]));
  // Objekte aus dem XML-Import (oder von Hand) haben eine andere Kennung – über Kunde + Name erkennen, sonst entstehen
  // Dubletten (Fund 07.10.: erst XML, dann CSV → jedes Objekt doppelt, Leistungen doppelt)
  const siteByName = new Map<string, (typeof dbSites)[number][]>();
  for (const s of dbSites) {
    const k = `${s.customer_id}|${norm(s.name)}`;
    siteByName.set(k, [...(siteByName.get(k) ?? []), s]);
  }
  const takenSites = new Set<string>();
  const usedSiteNos = new Set(dbSites.map((s) => s.site_no));
  const dbServiceIds = new Set(
    (await sql<{ id: string }[]>`select id from app.site_services`).map((r) => r.id),
  );
  const dbTypes = await sql<{ id: string; name: string }[]>`select id, name from app.service_types`;
  const dbEmployees = new Map(
    (await sql<{ id: string; personnel_no: string }[]>`select id, personnel_no from app.employees`).map(
      (e) => [e.personnel_no, e.id],
    ),
  );

  // Kunden: Zuordnung Kundennummer/Kurzname → geplanter Kunde (auch für Objekte/Leistungen ohne Kundendatei)
  const planByNo = new Map<string, PCustomer>();
  const planByShort = new Map<string, PCustomer>();
  const kunden = byKind.get('kunden');
  if (kunden) {
    const c = {
      status: col(kunden, 'kundenstatus'),
      no: col(kunden, 'kundennummer'),
      short: col(kunden, 'kurzname'),
      name: col(kunden, 'name'),
      street: col(kunden, 'strasse'),
      plz: col(kunden, 'plz'),
      city: col(kunden, 'ort'),
      extra: col(kunden, 'zusatz'),
      phone: col(kunden, 'telefon'),
      fax: col(kunden, 'fax'),
      mobile: col(kunden, 'mobilnummer'),
      email: col(kunden, 'email'),
      web: col(kunden, 'homepage'),
      terms: col(kunden, 'zahlungsbedingung'),
      iban: col(kunden, 'iban'),
      holder: col(kunden, 'kontoinhaber'),
      bic: col(kunden, 'bic'),
      info: col(kunden, 'kurzinfo'),
      siteNotes: col(kunden, 'einsatzortnotizen'),
      cSal: col(kunden, 'anrede'),
      cFirst: col(kunden, 'vorname'),
      cLast: col(kunden, 'nachname'),
      cEmail: col(kunden, 'email', 1),
      cPhone: col(kunden, 'telefon', 1),
      cMobile: col(kunden, 'mobil'),
    };
    let nextNo = Math.max(
      19999,
      ...dbCustomers.map((x) => Number(x.customer_no)).filter((n) => Number.isFinite(n) && n < 1e6),
      ...kunden.rows.map((r) => Number(cell(r, c.no))).filter((n) => Number.isFinite(n) && n < 1e6),
    );
    for (const r of kunden.rows) {
      const no = cell(r, c.no);
      const short = oneLine(cell(r, c.short));
      const key = no ? `ft:k:${no}` : `ft:kurz:${short}`;
      let p = no ? planByNo.get(no) : planByShort.get(short);
      if (!p) {
        const firstLine =
          cell(r, c.name)
            .split(/\r?\n/)
            .map((x) => x.trim())
            .find(Boolean) ?? short;
        const existing =
          (no ? custByNo.get(no) : undefined) ??
          custByRef.get(key) ??
          (no ? undefined : (custByName.get(norm(firstLine)) ?? custByName.get(norm(short))));
        const customerNo = existing?.customer_no ?? (no || String(++nextNo));
        const [name = '', ...rest] = cell(r, c.name)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const terms = parsePaymentTerms(cell(r, c.terms));
        const email = cell(r, c.email);
        const notes = [
          cell(r, c.info),
          cell(r, c.phone) && `Telefon: ${cell(r, c.phone)}`,
          cell(r, c.mobile) && `Mobil: ${cell(r, c.mobile)}`,
          cell(r, c.fax) && `Fax: ${cell(r, c.fax)}`,
          cell(r, c.web) && `Homepage: ${cell(r, c.web)}`,
        ]
          .filter(Boolean)
          .join('\n');
        const plz = cell(r, c.plz);
        const input = {
          customer_no: customerNo,
          name: name || short,
          name2: [...rest, cell(r, c.extra)].filter(Boolean).join(', '),
          street: oneLine(cell(r, c.street)),
          postal_code: /^\d{4}$/.test(plz) ? `0${plz}` : plz,
          city: cell(r, c.city),
          invoice_emails: EMAIL.test(email) ? email : '',
          invoice_format: 'zugferd',
          ...(terms.days != null ? { payment_terms_days: String(terms.days) } : {}),
          ...(terms.skontoDays != null
            ? { skonto_percent_bp: terms.skontoPercent!, skonto_days: String(terms.skontoDays) }
            : {}),
          contact_phone: cell(r, c.phone),
          notes,
          site_notes: cell(r, c.siteNotes),
          warning: terms.subcontractor
            ? 'Fortytools: Zahlungsbedingung „SUBUNTERNEHMER“ – § 13b (Reverse Charge) prüfen, USt-IdNr. eintragen'
            : '',
          status: statusOf(cell(r, c.status)),
        };
        const label = `${customerNo} ${input.name}`;
        const parsed = customerInput.safeParse(input);
        let status: Status = existing ? 'vorhanden' : 'neu';
        if (!parsed.success) {
          status = 'fehler';
          issues.push({ area: 'kunden', ref: label, level: 'fehler', text: zodText(parsed.error) });
        }
        if (email && !EMAIL.test(email))
          issues.push({ area: 'kunden', ref: label, level: 'hinweis', text: `E-Mail „${email}“ ungültig` });
        if (terms.subcontractor)
          issues.push({
            area: 'kunden',
            ref: label,
            level: 'hinweis',
            text: 'Zahlungsbedingung „SUBUNTERNEHMER“ → Warnhinweis § 13b gesetzt (bitte prüfen)',
          });
        p = {
          key,
          id: existing?.id ?? uuidOf(`ft-customer:${key}`),
          customerNo,
          label,
          status,
          input,
          contacts: [],
          banks: [],
        };
        plan.customers.push(p);
        if (no) planByNo.set(no, p);
        if (short) planByShort.set(short, p);
        const iban = cell(r, c.iban).replace(/\s+/g, '').toUpperCase();
        if (iban) {
          if (validIban(iban))
            p.banks.push({
              id: uuidOf(`ft-bank:${p.id}:${iban}`),
              holder: cell(r, c.holder) || (p.input.name as string),
              iban,
              bic: cell(r, c.bic) || null,
            });
          else
            issues.push({
              area: 'kunden',
              ref: label,
              level: 'hinweis',
              text: 'IBAN ungültig – nicht übernommen',
            });
        }
      }
      const last = cell(r, c.cLast);
      if (last) {
        const cEmail = cell(r, c.cEmail);
        const first = cell(r, c.cFirst);
        const sal = cell(r, c.cSal);
        if (cEmail && !EMAIL.test(cEmail))
          issues.push({
            area: 'kunden',
            ref: p.label,
            level: 'hinweis',
            text: `Kontakt ${first} ${last}: E-Mail ungültig – ohne E-Mail übernommen`,
          });
        p.contacts.push({
          id: uuidOf(`ft-contact:${p.id}:${norm(first)}|${norm(last)}|${cEmail.toLowerCase()}`),
          input: {
            salutation: sal === 'Herr' || sal === 'Frau' ? sal : null,
            first_name: first || null,
            last_name: last,
            position: null,
            email: EMAIL.test(cEmail) ? cEmail : null,
            phone: cell(r, c.cPhone) || null,
            mobile: cell(r, c.cMobile) || null,
            invoice_recipient: false,
            notes: null,
            version: null,
          },
        });
      }
    }
  }
  /** Kunde für Objekte/Leistungen: aus der Kundendatei oder aus dem Bestand. */
  const customerFor = (no: string, short: string): { id: string; no: string; label: string } | null => {
    const p = (no && planByNo.get(no)) || (short && planByShort.get(oneLine(short)));
    if (p) return p.status === 'fehler' ? null : { id: p.id, no: p.customerNo, label: p.label };
    const e = (no && custByNo.get(no)) || custByRef.get(`ft:kurz:${oneLine(short)}`);
    return e ? { id: e.id, no: e.customer_no, label: e.customer_no } : null;
  };

  // Objekte
  const sitesByCustomer = new Map<string, PSite[]>();
  const nextSiteNo = (custNo: string) => {
    for (let i = 1; i < 1000; i++) {
      const n = `${custNo}${String(i).padStart(i < 100 ? 2 : 3, '0')}`;
      if (!usedSiteNos.has(n)) {
        usedSiteNos.add(n);
        return n;
      }
    }
    throw new BusinessError(`Keine freie Objektnummer für Kunde ${custNo}`);
  };
  const addSite = (
    cust: { id: string; no: string },
    name: string,
    addr: { street: string; postal_code: string; city: string },
    ref: string,
    plainName = name,
  ) => {
    // auch über die feste ID (z. B. Objekt „Allgemein“, im Büro umbenannt)
    let existing = siteByRef.get(ref) ?? dbSites.find((x) => x.id === uuidOf(`ft-site:${ref}`));
    if (!existing) {
      // gleicher Name beim Kunden: zuerst mit gleicher Straße, sonst das erste noch nicht zugeordnete
      const free = (siteByName.get(`${cust.id}|${norm(plainName)}`) ?? []).filter(
        (x) => !takenSites.has(x.id),
      );
      existing = free.find((x) => norm(x.street ?? '') === norm(addr.street)) ?? free[0];
    }
    if (existing) takenSites.add(existing.id);
    const siteNo = existing?.site_no ?? nextSiteNo(cust.no);
    const input = { customer_id: cust.id, site_no: siteNo, name, ...addr };
    const parsed = siteInput.safeParse(input);
    const label = `${siteNo} ${name}`;
    let status: Status = existing ? 'vorhanden' : 'neu';
    if (!parsed.success) {
      status = 'fehler';
      issues.push({ area: 'objekte', ref: label, level: 'fehler', text: zodText(parsed.error) });
    }
    const s: PSite = {
      key: ref,
      id: existing?.id ?? uuidOf(`ft-site:${ref}`),
      siteNo,
      customerId: cust.id,
      label,
      status,
      input,
    };
    plan.sites.push(s);
    const list = sitesByCustomer.get(cust.id) ?? [];
    list.push(s);
    sitesByCustomer.set(cust.id, list);
    return s;
  };
  const objekte = byKind.get('objekte');
  if (objekte) {
    const c = {
      no: col(objekte, 'kundennummer'),
      short: col(objekte, 'kunde'),
      name: col(objekte, 'name'),
      street: col(objekte, 'strasse'),
      plz: col(objekte, 'plz'),
      city: col(objekte, 'ort'),
      extra: col(objekte, 'zusatz'),
      status: col(objekte, 'status'),
    };
    const seen = new Set<string>();
    for (const r of objekte.rows) {
      const name = oneLine(cell(r, c.name));
      const cust = customerFor(cell(r, c.no), cell(r, c.short));
      if (!cust) {
        issues.push({
          area: 'objekte',
          ref: name,
          level: 'fehler',
          text: `Kunde ${cell(r, c.no) || cell(r, c.short)} fehlt oder ist fehlerhaft`,
        });
        continue;
      }
      const street = oneLine(cell(r, c.street));
      const ref = `ft:o:${cust.no}|${norm(name)}|${norm(street)}`;
      if (seen.has(ref)) {
        issues.push({
          area: 'objekte',
          ref: name,
          level: 'hinweis',
          text: 'doppelt in der Datei – einmal übernommen',
        });
        continue;
      }
      seen.add(ref);
      const plz = cell(r, c.plz);
      const s = addSite(
        cust,
        [name, cell(r, c.extra)].filter(Boolean).join(' – '),
        { street, postal_code: /^\d{4}$/.test(plz) ? `0${plz}` : plz, city: cell(r, c.city) },
        ref,
        name,
      );
      (s as PSite & { matchName: string }).matchName = norm(name);
      if (/inaktiv/i.test(cell(r, c.status))) s.input.active = false;
      if (!street || !plz)
        issues.push({ area: 'objekte', ref: s.label, level: 'hinweis', text: 'Adresse unvollständig' });
    }
    for (const list of sitesByCustomer.values()) {
      const names = new Map<string, number>();
      for (const s of list) {
        const n = (s as PSite & { matchName?: string }).matchName ?? '';
        names.set(n, (names.get(n) ?? 0) + 1);
      }
      for (const s of list)
        if ((names.get((s as PSite & { matchName?: string }).matchName ?? '') ?? 0) > 1)
          issues.push({
            area: 'objekte',
            ref: s.label,
            level: 'hinweis',
            text: 'Objektname beim Kunden mehrfach vorhanden – Leistungen werden dem ersten zugeordnet',
          });
    }
  }

  // Leistungen
  const leistungen = byKind.get('leistungen');
  if (leistungen) {
    const c = {
      no: col(leistungen, 'kundennummer'),
      custName: col(leistungen, 'kundenname'),
      street: col(leistungen, 'strasse'),
      plz: col(leistungen, 'plz'),
      city: col(leistungen, 'ort'),
      site: col(leistungen, 'objektname'),
      orderNo: col(leistungen, 'auftragsnummer'),
      link: col(leistungen, 'linkzumauftrag'),
      type: col(leistungen, 'leistungsart'),
      title: col(leistungen, 'titel'),
      desc: col(leistungen, 'beschreibung'),
      qty: col(leistungen, 'menge'),
      price: col(leistungen, 'betrag'),
      from: col(leistungen, 'anfangsdatum'),
      to: col(leistungen, 'enddatum'),
    };
    const perLink = new Map<string, number>();
    const typeNames = new Map<string, string>();
    for (const r of leistungen.rows) {
      const no = cell(r, c.no);
      const cust = customerFor(no, '');
      const typeName = oneLine(cell(r, c.type)) || 'Sonstiges';
      const title = oneLine(cell(r, c.title));
      const description = title || typeName;
      const link = cell(r, c.link);
      const n = (perLink.get(link) ?? 0) + 1;
      perLink.set(link, n);
      const ref = `${no} ${oneLine(cell(r, c.site)) || '(ohne Objekt)'}: ${description}`;
      if (!cust) {
        issues.push({
          area: 'leistungen',
          ref,
          level: 'fehler',
          text: `Kunde ${no} fehlt oder ist fehlerhaft`,
        });
        continue;
      }
      const siteName = norm(oneLine(cell(r, c.site)));
      const list = sitesByCustomer.get(cust.id) ?? [];
      let site: PSite | undefined;
      if (siteName) {
        const hits = list.filter((s) => (s as PSite & { matchName?: string }).matchName === siteName);
        site = hits[0];
        if (hits.length > 1)
          issues.push({
            area: 'leistungen',
            ref,
            level: 'hinweis',
            text: `Objektname mehrdeutig – zugeordnet zu ${hits[0]!.siteNo}, bitte prüfen`,
          });
      }
      if (!site) {
        // ohne (gefundenes) Objekt → Objekt „Allgemein“ des Kunden mit der Kundenadresse
        const gref = `ft:o:${cust.no}|allgemein`;
        site = plan.sites.find((s) => s.key === gref);
        if (!site) {
          const plz = cell(r, c.plz);
          site = addSite(
            cust,
            'Allgemein (aus Fortytools)',
            {
              street: oneLine(cell(r, c.street)),
              postal_code: /^\d{4}$/.test(plz) ? `0${plz}` : plz,
              city: cell(r, c.city),
            },
            gref,
          );
        }
        issues.push({
          area: 'leistungen',
          ref,
          level: 'hinweis',
          text: siteName
            ? `Objekt „${oneLine(cell(r, c.site))}“ nicht gefunden → Objekt „Allgemein“`
            : 'ohne Objekt → Objekt „Allgemein“',
        });
      }
      const qty = cell(r, c.qty) || '1';
      const price = cell(r, c.price);
      const isOne = /^1([.,]0+)?$/.test(qty);
      // Einzelpreis unter 2 € bei Menge > 1 = Preis je m² (Tiefgarage, Glas), sonst Stück
      const euros = Number(price.replace(/\./g, '').replace(',', '.'));
      const unit = isOne ? 'LS' : euros < 2 ? 'MTK' : 'C62';
      const monthly = MONTHLY_TYPES.includes(norm(typeName));
      let from = '';
      let to = '';
      const errs: string[] = [];
      try {
        from = cell(r, c.from) ? parseDate(cell(r, c.from)) : `${todayBerlin().slice(0, 7)}-01`;
        to = cell(r, c.to) ? parseDate(cell(r, c.to)) : '';
      } catch (e) {
        errs.push((e as Error).message);
      }
      typeNames.set(norm(typeName), typeName);
      const orderNo = cell(r, c.orderNo);
      const input = {
        description,
        unit_code: unit,
        quantity: qty,
        unit_price: price,
        vat_rate_bp: '1900',
        valid_from: from,
        valid_to: to,
        note: [cell(r, c.desc), orderNo && `Fortytools-Auftrag ${orderNo}`].filter(Boolean).join('\n'),
        service_type_id: '',
        billing_cycle: monthly ? 'monatlich' : 'je_ausfuehrung',
        hours_target: '',
        execution_notes: '',
        cost_center: '',
        labor_share: '',
        always_unfinished: '',
        invoice_target: '',
        version: '',
      };
      const parsed = serviceInput.safeParse(input);
      if (!parsed.success) errs.push(zodText(parsed.error));
      if (euros === 0 && !errs.length)
        issues.push({ area: 'leistungen', ref, level: 'hinweis', text: 'Betrag 0,00 €' });
      const id = uuidOf(`ft-service:${link || ref}#${n}`);
      if (errs.length) issues.push({ area: 'leistungen', ref, level: 'fehler', text: errs.join('; ') });
      plan.services.push({
        id,
        siteId: site.id,
        label: `${site.siteNo}: ${description}`,
        status:
          errs.length || site.status === 'fehler' ? 'fehler' : dbServiceIds.has(id) ? 'vorhanden' : 'neu',
        input,
        typeName,
      });
    }
    for (const [k, name] of typeNames) {
      const ex = dbTypes.find((t) => norm(t.name) === k);
      plan.serviceTypes.push({ name, id: ex?.id ?? uuidOf(`ft-type:${k}`), exists: !!ex });
    }
  }

  // Mitarbeiter
  const ma = byKind.get('mitarbeiter');
  if (ma) {
    const c = {
      no: col(ma, 'personalnummer'),
      sal: col(ma, 'anrede'),
      last: col(ma, 'nachname'),
      first: col(ma, 'vorname'),
      birth: col(ma, 'geburtsdatum'),
      email: col(ma, 'email'),
      phone: col(ma, 'telefon'),
      mobile: col(ma, 'mobil'),
      street: col(ma, 'strasse'),
      plz: col(ma, 'plz'),
      city: col(ma, 'ort'),
      info: col(ma, 'information'),
      group: col(ma, 'staffgroups'),
      hours: col(ma, 'wochenstunden'),
      tags: col(ma, 'tags'),
      entry: col(ma, 'eintrittsdatum'),
      exit: col(ma, 'austrittsdatum'),
    };
    const seen = new Set<string>();
    for (const r of ma.rows) {
      const no = cell(r, c.no);
      const name = `${cell(r, c.last)}, ${cell(r, c.first)}`;
      const label = `${no || '–'} ${name}`;
      const tags = cell(r, c.tags)
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const hours = cell(r, c.hours) ? Number(cell(r, c.hours).replace(',', '.')) : null;
      const lower = tags.map(norm);
      const employment = lower.includes('minijob')
        ? 'minijob'
        : lower.includes('vollzeit')
          ? 'vollzeit'
          : lower.includes('teilzeit')
            ? 'teilzeit'
            : hours != null && hours > 30
              ? 'vollzeit'
              : 'teilzeit';
      const errs: string[] = [];
      const date = (v: string) => {
        if (!v) return '';
        try {
          return parseDate(v);
        } catch (e) {
          errs.push((e as Error).message);
          return '';
        }
      };
      const email = cell(r, c.email);
      const sal = cell(r, c.sal);
      const input = {
        personnel_no: no,
        first_name: cell(r, c.first),
        last_name: cell(r, c.last),
        employment_type: employment,
        entry_date: date(cell(r, c.entry)),
        exit_date: date(cell(r, c.exit)),
        weekly_hours: hours != null && Number.isFinite(hours) ? String(hours) : '',
        hourly_wage: '',
        phone: cell(r, c.phone),
        email: EMAIL.test(email) ? email : '',
        languages: 'de',
        annual_leave_days: '',
        salutation: sal === 'Herr' || sal === 'Frau' ? sal : '',
        tags,
        warning_note: '',
        info: cell(r, c.info),
        mobile: cell(r, c.mobile),
        email_private: '',
        wage_level_id: '',
        carry_over_leave: 'on',
        planning_group: cell(r, c.group),
        planning_notes: '',
        version: '',
        birth_date: date(cell(r, c.birth)),
        street: oneLine(cell(r, c.street)),
        postal_code: cell(r, c.plz),
        city: cell(r, c.city),
        private_version: '',
      };
      if (!no) errs.push('Personalnummer fehlt');
      else if (seen.has(no)) errs.push('Personalnummer doppelt in der Datei');
      seen.add(no);
      if (!input.entry_date)
        errs.push('Eintrittsdatum fehlt – bitte in Fortytools nachtragen oder später von Hand anlegen');
      const parsed = employeeInput.safeParse(input);
      if (!parsed.success && input.entry_date) errs.push(zodText(parsed.error));
      if (email && !EMAIL.test(email))
        issues.push({
          area: 'mitarbeiter',
          ref: label,
          level: 'hinweis',
          text: 'E-Mail ungültig – nicht übernommen',
        });
      if (!tags.length)
        issues.push({
          area: 'mitarbeiter',
          ref: label,
          level: 'hinweis',
          text: `ohne Tag – Beschäftigungsart „${employment}“ aus den Wochenstunden angenommen`,
        });
      if (errs.length)
        issues.push({ area: 'mitarbeiter', ref: label, level: 'fehler', text: errs.join('; ') });
      const existing = dbEmployees.get(no);
      plan.employees.push({
        id: existing ?? uuidOf(`ft-employee:${no}`),
        personnelNo: no,
        label,
        status: errs.length ? 'fehler' : existing ? 'vorhanden' : 'neu',
        input,
      });
    }
  }
  return plan;
}

export function planCounts(plan: Plan) {
  const count = (list: { status: Status }[]) => ({
    neu: list.filter((x) => x.status === 'neu').length,
    vorhanden: list.filter((x) => x.status === 'vorhanden').length,
    fehler: list.filter((x) => x.status === 'fehler').length,
  });
  return {
    kunden: count(plan.customers),
    objekte: count(plan.sites),
    leistungen: count(plan.services),
    mitarbeiter: count(plan.employees),
    kontakte: plan.customers.reduce((s, c) => s + (c.status === 'fehler' ? 0 : c.contacts.length), 0),
    bankkonten: plan.customers.reduce((s, c) => s + (c.status === 'fehler' ? 0 : c.banks.length), 0),
  };
}

// ---------------------------------------------------------------------------
// Übernahme
// ---------------------------------------------------------------------------

export interface ApplyResult {
  created: number;
  updated: number;
  skipped: number;
  errors: { ref: string; text: string }[];
}

export async function applyPlan(
  deps: Deps,
  p: { id: string; files: { sha: string; name: string }[]; update: boolean; actor: string },
): Promise<ApplyResult> {
  const { sql } = deps;
  const [done] = await sql<
    {
      created_count: number;
      updated_count: number;
      skipped_count: number;
      errors: { ref: string; text: string }[];
    }[]
  >`
    select created_count, updated_count, skipped_count, errors from app.data_imports where id = ${p.id}`;
  if (done)
    return {
      created: done.created_count,
      updated: done.updated_count,
      skipped: done.skipped_count,
      errors: done.errors,
    };
  const tables = await Promise.all(p.files.map(async (f) => detectTable(await stagedFtFile(deps, f.sha))));
  const plan = await buildPlan(sql, tables);
  const res: ApplyResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const run = async (ref: string, status: Status, fn: () => Promise<void>) => {
    if (status === 'fehler') return;
    if (status === 'vorhanden' && !p.update) {
      res.skipped++;
      return;
    }
    try {
      await fn();
      if (status === 'neu') res.created++;
      else res.updated++;
    } catch (e) {
      res.errors.push({ ref, text: (e as Error).message });
    }
  };

  for (const t of plan.serviceTypes)
    if (!t.exists)
      await sql`insert into app.service_types (id, name, sort_order)
                values (${t.id}, ${t.name}, (select coalesce(max(sort_order), 0) + 10 from app.service_types))
                on conflict do nothing`;
  const typeId = new Map(plan.serviceTypes.map((t) => [t.name, t.id]));

  for (const c of plan.customers) {
    await run(c.label, c.status, async () => {
      const input = customerInput.parse(c.input);
      await saveCustomer(sql, c.id, input, p.actor);
      await sql`update app.customers set external_ref = ${c.key} where id = ${c.id} and external_ref is null`;
      if (c.status === 'vorhanden') {
        // Rechnungsangaben stehen in der Gruppe „Standard“ – beim Überschreiben mitziehen (z. B. Kunden aus dem alten
        // Einzel-Import mit Zahlungsziel 30 Tage ohne Skonto)
        await sql`update app.invoice_groups
                     set bill_payment_terms_days = coalesce(${input.payment_terms_days ?? null}, bill_payment_terms_days),
                         bill_skonto_percent_bp = ${input.skonto_percent_bp ?? null},
                         bill_skonto_days = ${input.skonto_days ?? null},
                         bill_emails = case when ${input.invoice_emails?.length ?? 0} > 0
                                            then ${input.invoice_emails ?? []}::text[] else bill_emails end
                   where id = ${standardGroupId(c.id)}`;
      }
    });
    if (c.status === 'fehler') continue;
    // Kontakte und Bankkonten: feste IDs, vorhandene bleiben unverändert (außer „aktualisieren“)
    for (const ct of c.contacts) {
      const [ex] = await sql`select 1 from app.contacts where id = ${ct.id}`;
      if (ex && !p.update) continue;
      try {
        await saveContact(sql, ct.id, c.id, ct.input as Parameters<typeof saveContact>[3]);
      } catch (e) {
        res.errors.push({ ref: `${c.label} – Kontakt`, text: (e as Error).message });
      }
    }
    for (const b of c.banks) {
      const [ex] =
        await sql`select 1 from app.customer_bank_accounts where customer_id = ${c.id} and iban = ${b.iban}`;
      if (ex) continue;
      try {
        await saveCustomerBankAccount(sql, c.id, b, p.actor);
      } catch (e) {
        res.errors.push({ ref: `${c.label} – Bankkonto`, text: (e as Error).message });
      }
    }
  }
  for (const s of plan.sites)
    await run(s.label, s.status, async () => {
      const { active, ...rest } = s.input;
      await saveSite(sql, s.id, siteInput.parse(rest), p.actor);
      await sql`update app.sites set external_ref = ${s.key} where id = ${s.id} and external_ref is null`;
      if (active === false) await sql`update app.sites set active = false where id = ${s.id}`;
    });
  const monthlySites = new Set<string>();
  for (const s of plan.services)
    await run(s.label, s.status, async () => {
      const [cur] = await sql<
        { version: number }[]
      >`select version from app.site_services where id = ${s.id}`;
      const input = serviceInput.parse({ ...s.input, service_type_id: typeId.get(s.typeName) ?? '' });
      await saveService(sql, s.id, s.siteId, { ...input, version: cur?.version ?? null }, p.actor);
      if (input.billing_cycle !== 'je_ausfuehrung' && input.billing_cycle !== 'einmalig')
        monthlySites.add(s.siteId);
    });
  // Der XML-Import legt Monatspauschalen aus der letzten Rechnung an, wenn ein Objekt noch keine Leistung hat. Kommen die
  // echten Leistungen danach aus dem CSV-Export, sind die abgeleiteten Pauschalen doppelt → abschalten (bleiben sichtbar).
  if (monthlySites.size) {
    const derived = await sql<{ id: string; ref: string }[]>`
      select id, external_ref as ref from app.sites where id in ${sql([...monthlySites])} and external_ref like 'ftx:f:%'`;
    for (const d of derived) {
      const ids = Array.from({ length: 40 }, (_, k) => uuidOf(`ftx-service:${d.ref.slice(6)}:${k}`));
      await sql`update app.site_services set active = false, valid_to = coalesce(valid_to, greatest(valid_from, current_date - 1)),
                       note = coalesce(note || ' · ', '') || 'abgelöst durch Leistungen aus dem Fortytools-CSV-Export',
                       updated_at = now(), version = version + 1
                 where site_id = ${d.id} and id in ${sql(ids)} and active`;
    }
  }
  for (const e of plan.employees)
    await run(e.label, e.status, async () => {
      if (e.status === 'vorhanden') {
        // nur die Felder aus Fortytools ändern – Lohn, Steuer-ID, IBAN usw. bleiben
        const i = employeeInput.parse(e.input);
        const status = i.exit_date && i.exit_date <= todayBerlin() ? 'ausgetreten' : 'aktiv';
        await sql.begin(async (tx) => {
          await tx`update app.employees set first_name = ${i.first_name}, last_name = ${i.last_name},
                          employment_type = ${i.employment_type}, entry_date = ${i.entry_date}, exit_date = ${i.exit_date},
                          status = ${status}, weekly_hours = ${i.weekly_hours}, phone = ${i.phone}, email = ${i.email},
                          mobile = ${i.mobile}, salutation = ${i.salutation}, tags = ${i.tags}, info = ${i.info},
                          updated_at = now(), version = version + 1
                    where id = ${e.id}`;
          await tx`update app.employee_private set birth_date = ${i.birth_date}, street = ${i.street},
                          postal_code = ${i.postal_code}, city = ${i.city}, updated_at = now()
                    where employee_id = ${e.id}`;
          await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
                   values (${p.actor}, 'import', 'employee', ${e.id}, ${tx.json({ personnel_no: e.personnelNo })})`;
        });
      } else {
        await saveEmployee(sql, e.id, employeeInput.parse(e.input), p.actor);
      }
    });

  const errors = [
    ...plan.issues
      .filter((i) => i.level === 'fehler')
      .map((i) => ({ ref: `${FT_FILE[i.area]}: ${i.ref}`, text: i.text })),
    ...res.errors,
  ];
  const sha = p.files.map((f) => f.sha).join(',');
  const names = p.files.map((f) => f.name).join(', ');
  await sql`insert into app.data_imports (id, kind, filename, file_path, file_sha256, update_existing, row_count, created_count,
                                          updated_count, skipped_count, error_count, errors, created_by)
            values (${p.id}, 'fortytools', ${names.slice(0, 200)}, ${p.files.map((f) => ftPath(f.sha)).join(',')},
                    ${createHash('sha256').update(sha).digest('hex')}, ${p.update},
                    ${plan.customers.length + plan.sites.length + plan.services.length + plan.employees.length},
                    ${res.created}, ${res.updated}, ${res.skipped}, ${errors.length}, ${sql.json(errors)}, ${p.actor})
            on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'import', 'data_import', ${p.id},
                    ${sql.json({ kind: 'fortytools', files: plan.files, created: res.created, updated: res.updated, skipped: res.skipped, errors: errors.length })})`;
  return { ...res, errors };
}

const ftPath = (sha: string) => `importe/${sha.slice(0, 2)}/${sha}.csv`;

export async function stageFtFile(deps: Deps, bytes: Uint8Array): Promise<{ sha: string; kind: FtFile }> {
  if (bytes.length > 20 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 20 MB)');
  const { kind } = detectTable(bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await deps.archive.put(ftPath(sha), bytes);
  return { sha, kind };
}

export async function stagedFtFile(deps: Deps, sha: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new BusinessError('Datei ungültig');
  try {
    return await deps.archive.get(ftPath(sha));
  } catch {
    throw new BusinessError('Datei nicht mehr vorhanden – bitte erneut hochladen');
  }
}
