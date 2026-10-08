import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { parseDate, splitCsvLine } from '../domain/bank/statement.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { customerInput, saveCustomer, saveService, saveSite, serviceInput, siteInput } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Import aus Fortytools (CSV-Export, Semikolon oder Komma, UTF-8 oder Windows-1252).
 * Spalten werden über die Kopfzeile erkannt (deutsche Bezeichnungen, Groß-/Kleinschreibung und Sonderzeichen egal).
 * Ablauf: Datei prüfen (Vorschau, nichts gespeichert) → übernehmen. Feste IDs aus Kunden-/Objektnummer → zweimal
 * importieren legt nichts doppelt an; vorhandene Datensätze werden nur mit „vorhandene aktualisieren“ überschrieben.
 * Reihenfolge: Kunden → Objekte → Leistungen.
 */

export type ImportKind = 'kunden' | 'objekte' | 'leistungen';
export const IMPORT_KIND: Record<ImportKind, string> = {
  kunden: 'Kunden',
  objekte: 'Objekte',
  leistungen: 'Leistungen / Preise',
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

/** Feld → mögliche Spaltennamen (normalisiert). Erstes Feld je Art ist der Schlüssel. */
const FIELDS: Record<ImportKind, Record<string, { aliases: string[]; required?: boolean; label: string }>> = {
  kunden: {
    customer_no: {
      label: 'Kundennummer',
      required: true,
      aliases: ['kundennummer', 'kundennr', 'kdnr', 'nummer', 'debitor', 'debitorennummer'],
    },
    name: {
      label: 'Name',
      required: true,
      aliases: ['name', 'name1', 'firma', 'firmenname', 'kunde', 'bezeichnung'],
    },
    name2: { label: 'Name 2', aliases: ['name2', 'zusatz', 'namenszusatz', 'abteilung'] },
    street: {
      label: 'Straße',
      required: true,
      aliases: ['strasse', 'str', 'anschrift', 'adresse', 'strassehausnummer'],
    },
    postal_code: { label: 'PLZ', required: true, aliases: ['plz', 'postleitzahl'] },
    city: { label: 'Ort', required: true, aliases: ['ort', 'stadt'] },
    vat_id: { label: 'USt-ID', aliases: ['ustid', 'ustidnr', 'umsatzsteuerid', 'ustidentnr'] },
    leitweg_id: {
      label: 'Leitweg-ID',
      aliases: ['leitwegid', 'leitweg', 'kaeuferreferenz', 'buyerreference'],
    },
    supplier_no: {
      label: 'Unsere Lieferantennr.',
      aliases: ['lieferantennummer', 'lieferantennr', 'unserelieferantennr', 'kreditornummer'],
    },
    invoice_emails: {
      label: 'Rechnungs-E-Mail',
      aliases: ['rechnungsemail', 'emailrechnung', 'rechnungsmail', 'email', 'mail'],
    },
    invoice_format: {
      label: 'Rechnungsformat',
      aliases: ['rechnungsformat', 'erechnung', 'format', 'versandart'],
    },
    payment_terms_days: {
      label: 'Zahlungsziel (Tage)',
      aliases: ['zahlungsziel', 'zahlungszieltage', 'zahlungsfrist', 'tage'],
    },
    skonto_percent: { label: 'Skonto %', aliases: ['skonto', 'skontoprozent', 'skontoproz'] },
    skonto_days: { label: 'Skonto Tage', aliases: ['skontotage', 'skontofrist'] },
    contact_name: { label: 'Ansprechpartner', aliases: ['ansprechpartner', 'kontakt', 'zhd'] },
    contact_phone: { label: 'Telefon', aliases: ['telefon', 'tel', 'telefonnummer'] },
  },
  objekte: {
    site_no: {
      label: 'Objektnummer',
      required: true,
      aliases: ['objektnummer', 'objektnr', 'objekt', 'nummer'],
    },
    customer_no: {
      label: 'Kundennummer',
      required: true,
      aliases: ['kundennummer', 'kundennr', 'kdnr', 'kunde'],
    },
    name: {
      label: 'Bezeichnung',
      required: true,
      aliases: ['bezeichnung', 'objektname', 'name', 'objektbezeichnung'],
    },
    street: { label: 'Straße', aliases: ['strasse', 'str', 'anschrift', 'adresse'] },
    postal_code: { label: 'PLZ', aliases: ['plz', 'postleitzahl'] },
    city: { label: 'Ort', aliases: ['ort', 'stadt'] },
    order_reference: {
      label: 'Bestellnummer',
      aliases: ['bestellnummer', 'bestellnr', 'auftragsnummer', 'bestellung'],
    },
    contract_reference: { label: 'Vertragsnummer', aliases: ['vertragsnummer', 'vertrag', 'vertragsnr'] },
  },
  leistungen: {
    site_no: { label: 'Objektnummer', required: true, aliases: ['objektnummer', 'objektnr', 'objekt'] },
    description: {
      label: 'Leistung',
      required: true,
      aliases: ['leistung', 'titel', 'bezeichnung', 'text', 'beschreibung', 'position'],
    },
    unit_price: {
      label: 'Preis',
      required: true,
      aliases: ['preis', 'betrag', 'einzelpreis', 'nettopreis', 'pauschale', 'netto'],
    },
    quantity: { label: 'Menge', aliases: ['menge', 'anzahl'] },
    unit: { label: 'Einheit', aliases: ['einheit', 'me'] },
    vat: { label: 'USt %', aliases: ['ust', 'mwst', 'steuersatz', 'ustsatz', 'mwstsatz'] },
    valid_from: { label: 'Beginn', aliases: ['beginn', 'anfang', 'gueltigab', 'ab', 'start', 'von'] },
    valid_to: { label: 'Ende', aliases: ['ende', 'gueltigbis', 'bis'] },
    cycle: { label: 'Zyklus', aliases: ['zyklus', 'abrechnungszyklus', 'intervall', 'turnus'] },
    kind: { label: 'Art', aliases: ['art', 'leistungsart', 'typ'] },
    note: { label: 'Zusatztext', aliases: ['zusatztext', 'zusatz', 'hinweis', 'langtext'] },
  },
};

export interface AnalyzedRow {
  line: number;
  key: string;
  data: Record<string, string>;
  status: 'neu' | 'vorhanden' | 'fehler';
  errors: string[];
}

export interface Analysis {
  kind: ImportKind;
  columns: { field: string; label: string; header: string | null; required: boolean }[];
  unknownHeaders: string[];
  rows: AnalyzedRow[];
}

function decode(bytes: Uint8Array): string {
  const utf = new TextDecoder('utf-8').decode(bytes);
  return (utf.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf).replace(/^\uFEFF/, '');
}

function table(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new BusinessError('Datei enthält keine Datenzeilen');
  const first = lines[0]!;
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const headers = splitCsvLine(first, sep);
  const rows = lines.slice(1).map((l, i) => ({ line: i + 2, cells: splitCsvLine(l, sep) }));
  return { headers, rows };
}

/** Feste ID aus einem Schlüssel, als gültige UUID v4 (Versions-/Varianten-Bits gesetzt). */
const uuidOf = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/** Fortytools-Werte in unser Format */
function toFormat(v: string, leitweg: string): 'pdf' | 'zugferd' | 'xrechnung' {
  const n = norm(v);
  if (n.includes('xrechnung')) return 'xrechnung';
  if (n.includes('zugferd') || n.includes('facturx')) return 'zugferd';
  if (n === 'pdf' || n.includes('email') || n.includes('post')) return 'pdf';
  return leitweg ? 'xrechnung' : 'zugferd';
}
const CYCLES: Record<string, string> = {
  monatlich: 'monatlich',
  '': 'monatlich',
  zweimonatlich: 'zweimonatlich',
  alle2monate: 'zweimonatlich',
  quartalsweise: 'quartalsweise',
  vierteljaehrlich: 'quartalsweise',
  quartal: 'quartalsweise',
  halbjaehrlich: 'halbjaehrlich',
  jaehrlich: 'jaehrlich',
  jahr: 'jaehrlich',
  einmalig: 'einmalig',
  jeausfuehrung: 'je_ausfuehrung',
  proausfuehrung: 'je_ausfuehrung',
};
const UNITS: Record<string, string> = {
  '': 'LS',
  pauschal: 'LS',
  pauschale: 'LS',
  ls: 'LS',
  std: 'HUR',
  stunde: 'HUR',
  stunden: 'HUR',
  h: 'HUR',
  m2: 'MTK',
  qm: 'MTK',
  stk: 'C62',
  stueck: 'C62',
  monat: 'MON',
};
const KINDS: Record<string, 'monthly_flat' | 'special' | 'hourly'> = {
  '': 'monthly_flat',
  pauschale: 'monthly_flat',
  monatspauschale: 'monthly_flat',
  dauerleistung: 'monthly_flat',
  regelmaessig: 'monthly_flat',
  sonderleistung: 'special',
  einmalig: 'special',
  regie: 'hourly',
  regiestunden: 'hourly',
  stundenlohn: 'hourly',
};

const zodErrors = (e: { issues: { message: string; path: PropertyKey[] }[] }) =>
  e.issues.map((i) => `${i.path.join('.') || 'Zeile'}: ${i.message}`);

/** Datei prüfen – liefert je Zeile neu/vorhanden/Fehler. Speichert nichts. */
export async function analyze(sql: Sql, kind: ImportKind, bytes: Uint8Array): Promise<Analysis> {
  if (!(kind in FIELDS)) throw new BusinessError('Art ungültig');
  if (bytes.length > 20 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 20 MB)');
  const { headers, rows: raw } = table(decode(bytes));
  const fields = FIELDS[kind];
  const normHeaders = headers.map(norm);
  const used = new Set<number>();
  const columns = Object.entries(fields).map(([field, f]) => {
    let idx = -1;
    for (const a of f.aliases) {
      idx = normHeaders.findIndex((h, i) => h === a && !used.has(i));
      if (idx >= 0) break;
    }
    if (idx >= 0) used.add(idx);
    return { field, label: f.label, header: idx >= 0 ? headers[idx]! : null, required: !!f.required, idx };
  });
  const missing = columns.filter((c) => c.required && c.idx < 0);
  if (missing.length) {
    throw new BusinessError(
      `Pflichtspalten nicht gefunden: ${missing.map((m) => m.label).join(', ')}. Erkannte Spalten: ${headers.join(', ')}`,
    );
  }
  const existing = await existingKeys(sql, kind);
  const parents =
    kind === 'objekte'
      ? await keysOf(sql, 'customers')
      : kind === 'leistungen'
        ? await keysOf(sql, 'sites')
        : null;
  const seen = new Set<string>();
  const rows: AnalyzedRow[] = raw.map(({ line, cells }) => {
    const data: Record<string, string> = {};
    for (const c of columns) data[c.field] = c.idx >= 0 ? (cells[c.idx] ?? '').trim() : '';
    const errors: string[] = [];
    const key = rowKey(kind, data);
    if (seen.has(key)) errors.push('doppelt in der Datei');
    seen.add(key);
    try {
      build(kind, data, '00000000-0000-4000-8000-000000000000');
    } catch (e) {
      errors.push(...(e instanceof ImportRowError ? e.messages : [(e as Error).message]));
    }
    if (kind === 'objekte' && !parents!.has(data.customer_no!))
      errors.push(`Kunde ${data.customer_no} fehlt (erst Kunden importieren)`);
    if (kind === 'leistungen' && !parents!.has(data.site_no!))
      errors.push(`Objekt ${data.site_no} fehlt (erst Objekte importieren)`);
    return {
      line,
      key,
      data,
      errors,
      status: errors.length ? 'fehler' : existing.has(key) ? 'vorhanden' : 'neu',
    };
  });
  return {
    kind,
    columns: columns.map(({ field, label, header, required }) => ({ field, label, header, required })),
    unknownHeaders: headers.filter((_, i) => !used.has(i)),
    rows,
  };
}

class ImportRowError extends Error {
  constructor(public messages: string[]) {
    super(messages.join('; '));
  }
}

function rowKey(kind: ImportKind, d: Record<string, string>) {
  if (kind === 'kunden') return d.customer_no!;
  if (kind === 'objekte') return d.site_no!;
  return `${d.site_no}|${d.description}|${d.valid_from ? safeDate(d.valid_from) : ''}`;
}
const safeDate = (v: string) => {
  try {
    return parseDate(v);
  } catch {
    return v;
  }
};

async function keysOf(sql: Sql, t: 'customers' | 'sites') {
  const rows =
    t === 'customers'
      ? await sql<{ k: string }[]>`select customer_no as k from app.customers`
      : await sql<{ k: string }[]>`select site_no as k from app.sites`;
  return new Set(rows.map((r) => r.k));
}

async function existingKeys(sql: Sql, kind: ImportKind) {
  if (kind === 'kunden') return keysOf(sql, 'customers');
  if (kind === 'objekte') return keysOf(sql, 'sites');
  const rows = await sql<{ k: string }[]>`
    select s.site_no || '|' || ss.description || '|' || ss.valid_from::text as k
      from app.site_services ss join app.sites s on s.id = ss.site_id`;
  return new Set(rows.map((r) => r.k));
}

/** Zeile in Eingabe der Stammdaten-Funktionen umsetzen (wirft ImportRowError mit allen Fehlern). */
function build(kind: ImportKind, d: Record<string, string>, parentId: string) {
  if (kind === 'kunden') {
    const leitweg = d.leitweg_id ?? '';
    const r = customerInput.safeParse({
      customer_no: d.customer_no,
      name: d.name,
      name2: d.name2 ?? '',
      street: d.street,
      postal_code: (d.postal_code ?? '').padStart(
        d.postal_code && /^\d{4}$/.test(d.postal_code) ? 5 : 0,
        '0',
      ),
      city: d.city,
      vat_id: d.vat_id ?? '',
      is_public_authority: leitweg ? 'true' : '',
      leitweg_id: leitweg,
      supplier_no: d.supplier_no ?? '',
      invoice_emails: d.invoice_emails ?? '',
      invoice_format: toFormat(d.invoice_format ?? '', leitweg),
      payment_terms_days: d.payment_terms_days || '30',
      skonto_percent_bp: d.skonto_percent ?? '',
      skonto_days: d.skonto_days ?? '',
      contact_name: d.contact_name ?? '',
      contact_email: '',
      contact_phone: d.contact_phone ?? '',
      notes: null,
      status: 'kunde',
      dunning_block: '',
    });
    if (!r.success) throw new ImportRowError(zodErrors(r.error));
    return r.data;
  }
  if (kind === 'objekte') {
    const r = siteInput.safeParse({
      customer_id: parentId,
      site_no: d.site_no,
      name: d.name,
      street: d.street ?? '',
      postal_code: d.postal_code ?? '',
      city: d.city ?? '',
      order_reference: d.order_reference ?? '',
      contract_reference: d.contract_reference ?? '',
    });
    if (!r.success) throw new ImportRowError(zodErrors(r.error));
    return r.data;
  }
  const errs: string[] = [];
  const kindV = KINDS[norm(d.kind ?? '')];
  if (!kindV) errs.push(`Art „${d.kind}“ unbekannt (Pauschale, Sonderleistung, Regie)`);
  const cycle = CYCLES[norm(d.cycle ?? '')];
  if (!cycle) errs.push(`Zyklus „${d.cycle}“ unbekannt`);
  const unit = UNITS[norm(d.unit ?? '')] ?? (d.unit ? null : 'LS');
  if (!unit) errs.push(`Einheit „${d.unit}“ unbekannt`);
  let from = `${todayBerlin().slice(0, 7)}-01`;
  let to = '';
  try {
    if (d.valid_from) from = parseDate(d.valid_from);
    if (d.valid_to) to = parseDate(d.valid_to);
  } catch (e) {
    errs.push((e as Error).message);
  }
  const vatN = Number((d.vat || '19').replace('%', '').replace(',', '.').trim());
  if (![7, 19].includes(vatN)) errs.push(`USt ${d.vat} nicht freigegeben (nur 7 % / 19 %)`);
  const r = serviceInput.safeParse({
    kind: kindV ?? 'monthly_flat',
    description: d.description,
    unit_code: unit ?? 'LS',
    quantity: d.quantity || '1',
    unit_price: (d.unit_price ?? '').replace(/€|EUR/g, '').trim(),
    vat_rate_bp: String(Math.round(vatN * 100)),
    valid_from: from,
    valid_to: to,
    note: d.note ?? '',
    service_type_id: '',
    // Sonderleistung/Regie ohne Zyklusangabe = je Ausführung
    billing_cycle: !d.cycle && kindV && kindV !== 'monthly_flat' ? 'je_ausfuehrung' : (cycle ?? 'monatlich'),
    hours_target: '',
    execution_notes: '',
    cost_center: '',
    labor_share: '',
    always_unfinished: '',
    invoice_target: '',
    version: '',
  });
  if (!r.success) errs.push(...zodErrors(r.error));
  if (errs.length) throw new ImportRowError(errs);
  return r.data!;
}

/**
 * Übernahme: nur fehlerfreie Zeilen; vorhandene nur mit `update`. Datei write-once archiviert, Protokoll in
 * data_imports. Feste ID je Import → doppelter Klick importiert nicht zweimal.
 */
export async function applyImport(
  deps: Deps,
  p: { id: string; kind: ImportKind; filename: string; bytes: Uint8Array; update: boolean; actor: string },
) {
  const { sql } = deps;
  const [done] = await sql<
    { created_count: number; updated_count: number; skipped_count: number; error_count: number }[]
  >`
    select created_count, updated_count, skipped_count, error_count from app.data_imports where id = ${p.id}`;
  if (done)
    return {
      created: done.created_count,
      updated: done.updated_count,
      skipped: done.skipped_count,
      errors: done.error_count,
    };
  const a = await analyze(sql, p.kind, p.bytes);
  const sha = createHash('sha256').update(p.bytes).digest('hex');
  const path = `importe/${sha.slice(0, 2)}/${sha}.csv`;
  await deps.archive.put(path, p.bytes);
  const ids = async (t: 'customers' | 'sites', key: string) => {
    const [r] =
      t === 'customers'
        ? await sql<{ id: string }[]>`select id from app.customers where customer_no = ${key}`
        : await sql<{ id: string }[]>`select id from app.sites where site_no = ${key}`;
    return r?.id;
  };
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { line: number; errors: string[] }[] = a.rows
    .filter((r) => r.status === 'fehler')
    .map((r) => ({ line: r.line, errors: r.errors }));
  for (const r of a.rows) {
    if (r.status === 'fehler') continue;
    if (r.status === 'vorhanden' && !p.update) {
      skipped++;
      continue;
    }
    try {
      if (p.kind === 'kunden') {
        const id =
          (await ids('customers', r.data.customer_no!)) ?? uuidOf(`ft-customer:${r.data.customer_no}`);
        await saveCustomer(
          sql,
          id,
          build('kunden', r.data, '') as Parameters<typeof saveCustomer>[2],
          p.actor,
        );
      } else if (p.kind === 'objekte') {
        const cid = (await ids('customers', r.data.customer_no!))!;
        const id = (await ids('sites', r.data.site_no!)) ?? uuidOf(`ft-site:${r.data.site_no}`);
        await saveSite(sql, id, build('objekte', r.data, cid) as Parameters<typeof saveSite>[2], p.actor);
      } else {
        const sid = (await ids('sites', r.data.site_no!))!;
        const input = build('leistungen', r.data, sid) as Parameters<typeof saveService>[3];
        const [ex] = await sql<{ id: string; version: number }[]>`
          select id, version from app.site_services where site_id = ${sid} and description = ${input.description} and valid_from = ${input.valid_from}`;
        await saveService(
          sql,
          ex?.id ?? uuidOf(`ft-service:${r.key}`),
          sid,
          { ...input, version: ex?.version ?? null },
          p.actor,
        );
      }
      if (r.status === 'vorhanden') updated++;
      else created++;
    } catch (e) {
      errors.push({ line: r.line, errors: [(e as Error).message] });
    }
  }
  await sql`insert into app.data_imports (id, kind, filename, file_path, file_sha256, update_existing, row_count, created_count,
                                          updated_count, skipped_count, error_count, errors, created_by)
            values (${p.id}, ${p.kind}, ${p.filename.slice(0, 200)}, ${path}, ${sha}, ${p.update}, ${a.rows.length}, ${created},
                    ${updated}, ${skipped}, ${errors.length}, ${sql.json(errors)}, ${p.actor})
            on conflict (id) do nothing`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'import', 'data_import', ${p.id}, ${sql.json({ kind: p.kind, created, updated, skipped, errors: errors.length })})`;
  return { created, updated, skipped, errors: errors.length };
}

export async function listImports(sql: Sql) {
  return sql<
    {
      id: string;
      kind: ImportKind;
      filename: string;
      row_count: number;
      created_count: number;
      updated_count: number;
      skipped_count: number;
      error_count: number;
      created_by: string;
      created_at: Date;
    }[]
  >`select id, kind, filename, row_count, created_count, updated_count, skipped_count, error_count, created_by, created_at
      from app.data_imports order by created_at desc limit 50`;
}

/** Hochgeladene Datei für die Vorschau ablegen (write-once, inhaltsadressiert) – die Vorschau ist dann eine GET-Seite. */
export async function stageFile(deps: Deps, bytes: Uint8Array): Promise<string> {
  if (bytes.length > 20 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 20 MB)');
  const sha = createHash('sha256').update(bytes).digest('hex');
  await deps.archive.put(`importe/${sha.slice(0, 2)}/${sha}.csv`, bytes);
  return sha;
}

export async function stagedFile(deps: Deps, sha: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new BusinessError('Datei ungültig');
  try {
    return await deps.archive.get(`importe/${sha.slice(0, 2)}/${sha}.csv`);
  } catch {
    throw new BusinessError('Datei nicht mehr vorhanden – bitte erneut hochladen');
  }
}
