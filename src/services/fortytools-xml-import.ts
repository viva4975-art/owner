import { randomUUID } from 'node:crypto';
import { create } from 'xmlbuilder2';
import { unescapeXml } from '../domain/xml.js';
import { settleOpenItem } from './payments.js';
import type { Sql, Tx } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot, InvoiceDocument } from '../domain/invoice/types.js';
import type { Cents, Quantity, VatRate } from '../domain/money/money.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';
import { BusinessError } from './errors.js';
import { parsePaymentTerms, uuidOf } from './fortytools-export-import.js';

/*
 * Import der Fortytools-Datensicherung (XML: customers, facilities, staff_members, offers, invoices).
 * - Kunden/Objekte/Mitarbeiter werden angelegt oder ergänzt (leere Felder füllen; Fortytools-Objektnummern
 *   übernehmen, wo das Objekt aus einem früheren Import stammt). Zuordnung über Fortytools-IDs (external_ref „ftx:…“),
 *   Kundennummer, Personalnummer oder Name → mehrfach ausführen legt nichts doppelt an.
 * - Angebote mit Positionen (Status aus Fortytools), Rechnungen als unveränderbares Archiv (legacy_invoices).
 * - Monatspauschalen je Objekt aus der letzten Monatsrechnung (nur Objekte ohne regelmäßige Leistung), gültig ab dem
 *   Monat nach der letzten Fortytools-Abrechnung → kein doppeltes Abrechnen.
 * - Nummernkreise Rechnung/Angebot werden über die höchste Fortytools-Nummer gehoben (nie gesenkt).
 * Vorschau = derselbe Lauf in einer Transaktion, die am Ende zurückgerollt wird.
 */

export type FtxKind = 'customers' | 'facilities' | 'staff-members' | 'offers' | 'invoices';
export const FTX_LABEL: Record<FtxKind, string> = {
  customers: 'Kunden',
  facilities: 'Objekte',
  'staff-members': 'Mitarbeiter',
  offers: 'Angebote',
  invoices: 'Rechnungen',
};

type Node = Record<string, unknown>;
const arr = (v: unknown): Node[] => (v == null ? [] : Array.isArray(v) ? (v as Node[]) : [v as Node]);
const txt = (v: unknown): string => (typeof v === 'string' ? unescapeXml(v).trim() : '');
const get = (n: Node | undefined, path: string): string => {
  let cur: unknown = n;
  for (const k of path.split('/')) cur = cur && typeof cur === 'object' ? (cur as Node)[k] : undefined;
  return txt(cur);
};
/** „460.6“ → 46060 (exakt, kaufmännisch auf Cent gerundet) */
export function centsOf(v: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return 0n;
  const frac = (m[3] ?? '').padEnd(3, '0');
  let c = BigInt(m[2]!) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1n;
  return m[1] ? -c : c;
}
/** „32.5“ → 32500 (Menge × 1000) */
export function milliOf(v: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return 0n;
  const frac = (m[3] ?? '').padEnd(4, '0');
  let x = BigInt(m[2]!) * 1000n + BigInt(frac.slice(0, 3));
  if (Number(frac[3]) >= 5) x += 1n;
  return m[1] ? -x : x;
}
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const lastDay = (iso: string) =>
  new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).toISOString().slice(0, 10);
const nextMonth = (m: string) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1));
  return d.toISOString().slice(0, 10);
};

/** Datei erkennen und lesen (Wurzel-Element = Art). DTD/Entitäten werden abgelehnt (XXE). */
export function parseFtx(bytes: Uint8Array): { kind: FtxKind; rows: Node[] } {
  const xml = new TextDecoder('utf-8').decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new BusinessError('XML mit DTD/Entitäten wird nicht verarbeitet');
  const root = /<\s*([a-z-]+)[\s>]/i.exec(xml.replace(/^<\?xml[^>]*>/, ''))?.[1];
  const child: Record<string, string> = {
    customers: 'customer',
    facilities: 'facility',
    'staff-members': 'staff-member',
    offers: 'offer',
    invoices: 'invoice',
  };
  if (!root || !(root in child))
    throw new BusinessError(
      'Unbekannte XML-Datei – erwartet werden die Fortytools-Exporte customers, facilities, staff_members, offers, invoices',
    );
  const obj = create(xml).end({ format: 'object' }) as Node;
  return { kind: root as FtxKind, rows: arr((obj[root] as Node | undefined)?.[child[root]!]) };
}

// Krankenkassen-IK → Name (nur sicher bekannte; sonst „Sonstige (IK …)“)
const IK: Record<string, string> = {
  '108310400': 'AOK Bayern',
  '104940005': 'BARMER',
  '105830016': 'DAK-Gesundheit',
  '101575519': 'Techniker Krankenkasse (TK)',
};
const LOCALE_LANG: Record<string, string> = {
  de: 'Deutsch',
  en: 'Englisch',
  ro: 'Rumänisch',
  tr: 'Türkisch',
  pl: 'Polnisch',
  hr: 'Kroatisch/Bosnisch/Serbisch',
  bg: 'Bulgarisch',
  ar: 'Arabisch',
  uk: 'Ukrainisch',
  ru: 'Russisch',
  el: 'Griechisch',
  it: 'Italienisch',
  es: 'Spanisch',
  pt: 'Portugiesisch',
  hu: 'Ungarisch',
  sk: 'Slowakisch',
  cs: 'Tschechisch',
  fa: 'Persisch (Farsi/Dari)',
};
const APP_LANGS = new Set(['de', 'en', 'ro', 'tr', 'pl', 'hr', 'bg']);
const UNIT: Record<string, string> = {
  pauschal: 'LS',
  psch: 'LS',
  'std.': 'HUR',
  std: 'HUR',
  'stk.': 'C62',
  qm: 'MTK',
  'm²': 'MTK',
  'tg.': 'DAY',
};
const unitOf = (u: string) => UNIT[u.toLowerCase()] ?? 'C62';
// Angebotsstatus Fortytools → App (aus den Daten abgeleitet: 5 = ohne Nummer, 3 = hat Folgeangebot)
const OFFER_STATUS: Record<string, string> = {
  '1': 'angenommen',
  '2': 'abgelehnt',
  '3': 'zurueckgezogen',
  '4': 'versendet',
  '5': 'entwurf',
};

export interface FtxCount {
  neu: number;
  ergaenzt: number;
  unveraendert: number;
}
export interface FtxResult {
  files: { kind: FtxKind; label: string; rows: number }[];
  counts: Record<string, FtxCount>;
  issues: { area: string; text: string }[];
  counters: { invoiceNext: string | null; offerNext: string | null };
  /** Rechnungsnummern, die in der App und in Fortytools vorkommen (müsste es eigentlich nie geben) */
  numberClashes: string[];
}

const blank = (): FtxCount => ({ neu: 0, ergaenzt: 0, unveraendert: 0 });

export async function importFtx(
  sql: Sql,
  files: { name: string; data: Uint8Array }[],
  opts: { actor: string; dryRun: boolean },
): Promise<FtxResult> {
  const parsed = files.map((f) => parseFtx(f.data));
  const by = new Map<FtxKind, Node[]>();
  for (const p of parsed) by.set(p.kind, [...(by.get(p.kind) ?? []), ...p.rows]);
  const res: FtxResult = {
    files: [...by.entries()].map(([kind, rows]) => ({ kind, label: FTX_LABEL[kind], rows: rows.length })),
    counts: {},
    issues: [],
    counters: { invoiceNext: null, offerNext: null },
    numberClashes: [],
  };
  const ROLLBACK = new Error('rollback');
  try {
    await sql.begin(async (tx) => {
      await run(tx, by, res, opts.actor);
      if (opts.dryRun) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return res;
}

async function run(tx: Tx, by: Map<FtxKind, Node[]>, res: FtxResult, actor: string) {
  const issue = (area: string, text: string) => {
    if (res.issues.length < 300) res.issues.push({ area, text });
  };
  const today = todayBerlin();

  // ------------------------------------------------------------------ Kunden
  const custMap = new Map<string, string>(); // Fortytools-ID → customers.id
  const dbCust = await tx<
    { id: string; customer_no: string; name: string; external_ref: string | null }[]
  >`select id, customer_no, name, external_ref from app.customers`;
  const cByRef = new Map(dbCust.filter((c) => c.external_ref).map((c) => [c.external_ref!, c]));
  const cByNo = new Map(dbCust.map((c) => [c.customer_no, c]));
  const cByName = new Map(dbCust.map((c) => [norm(c.name), c]));
  // neue Nummern (Interessenten ohne Nummer) hinter allen vorhandenen UND allen Nummern der Datei – sonst kollidiert
  // eine vergebene Nummer mit einem Kunden, der erst später in der Datei kommt
  let nextNo = Math.max(
    19999,
    ...[...dbCust.map((c) => c.customer_no), ...(by.get('customers') ?? []).map((c) => get(c, 'number'))]
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n < 1e6),
  );
  const cc = (res.counts.Kunden = blank());
  for (const c of by.get('customers') ?? []) {
    const ftId = get(c, 'address/addressable-id');
    if (!ftId) continue;
    const no = get(c, 'number');
    const short = get(c, 'shortname');
    const name = get(c, 'address/name') || short;
    const hit =
      cByRef.get(`ftx:c:${ftId}`) ??
      (no ? (cByNo.get(no) ?? cByRef.get(`ft:k:${no}`)) : cByRef.get(`ft:kurz:${short}`)) ??
      cByName.get(norm(name)) ??
      cByName.get(norm(short));
    const state = get(c, 'customer-state/name');
    const status = /interessent/i.test(state) ? 'interessent' : 'kunde';
    const active = !/ehemalig/i.test(state);
    const terms = parsePaymentTerms(get(c, 'payment-practice/name'));
    const skBp = terms.skontoPercent ? Math.round(Number(terms.skontoPercent.replace(',', '.')) * 100) : null;
    const days = terms.days;
    const okSkonto = skBp && terms.skontoDays && days && terms.skontoDays < days;
    const email = get(c, 'email');
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const zip = get(c, 'address/zip');
    const notes = [
      get(c, 'shortinfo'),
      get(c, 'mobile') && `Mobil: ${get(c, 'mobile')}`,
      get(c, 'fax') && `Fax: ${get(c, 'fax')}`,
      get(c, 'webpage') && `Homepage: ${get(c, 'webpage')}`,
    ]
      .filter(Boolean)
      .join('\n');
    const warning = [
      get(c, 'warning-info'),
      terms.subcontractor
        ? 'Fortytools: Zahlungsbedingung „SUBUNTERNEHMER“ – § 13b (Reverse Charge) prüfen, USt-IdNr. eintragen'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const data = {
      street: get(c, 'address/street'),
      postal_code: /^\d{4}$/.test(zip) ? `0${zip}` : zip,
      city: get(c, 'address/city'),
      vat_id: get(c, 'tax-ident') || null,
      billing_hint: get(c, 'invoice-info') || null,
      site_notes: get(c, 'planning-info') || null,
      warning: warning || null,
      notes: notes || null,
      contact_phone: get(c, 'phone') || null,
      contact_email: emailOk ? email : null,
      customer_since: get(c, 'customer-since') || null,
    };
    if (hit) {
      custMap.set(ftId, hit.id);
      const r = await tx`
        update app.customers set
          street = case when coalesce(street, '') = '' then ${data.street} else street end,
          postal_code = case when coalesce(postal_code, '') = '' then ${data.postal_code} else postal_code end,
          city = case when coalesce(city, '') = '' then ${data.city} else city end,
          vat_id = coalesce(vat_id, ${data.vat_id}),
          billing_hint = coalesce(billing_hint, ${data.billing_hint}),
          site_notes = coalesce(site_notes, ${data.site_notes}),
          warning = coalesce(warning, ${data.warning}),
          notes = coalesce(nullif(notes, ''), ${data.notes}),
          contact_phone = coalesce(nullif(contact_phone, ''), ${data.contact_phone}),
          contact_email = coalesce(nullif(contact_email, ''), ${data.contact_email}),
          customer_since = coalesce(customer_since, ${data.customer_since}::date),
          invoice_emails = case when cardinality(invoice_emails) = 0 and ${emailOk} then array[${email}]::text[] else invoice_emails end,
          external_ref = coalesce(external_ref, ${`ftx:c:${ftId}`}),
          updated_at = now()
        where id = ${hit.id}
          and (coalesce(street, '') = '' and ${data.street} <> '' or vat_id is null and ${data.vat_id}::text is not null
               or billing_hint is null and ${data.billing_hint}::text is not null
               or warning is null and ${data.warning}::text is not null
               or customer_since is null and ${data.customer_since}::date is not null
               or external_ref is null)
        returning id`;
      if (r.length) cc.ergaenzt++;
      else cc.unveraendert++;
      continue;
    }
    // neu
    let customerNo = no && !cByNo.has(no) ? no : String(++nextNo);
    while (!no && cByNo.has(customerNo)) customerNo = String(++nextNo);
    if (!data.street || !/^\d{5}$/.test(data.postal_code) || !data.city)
      issue('Kunden', `${customerNo} ${name}: Adresse unvollständig – bitte nachtragen`);
    const id = uuidOf(`ftx-customer:${ftId}`);
    await tx`insert into app.customers ${tx({
      id,
      customer_no: customerNo,
      name,
      street: data.street,
      postal_code: data.postal_code,
      city: data.city,
      vat_id: data.vat_id,
      invoice_emails: emailOk ? [email] : [],
      invoice_format: 'zugferd',
      payment_terms_days: days ?? 30,
      skonto_percent_bp: okSkonto ? skBp : null,
      skonto_days: okSkonto ? terms.skontoDays : null,
      status,
      active,
      notes: data.notes,
      billing_hint: data.billing_hint,
      site_notes: data.site_notes,
      warning: data.warning,
      contact_phone: data.contact_phone,
      contact_email: data.contact_email,
      customer_since: data.customer_since,
      external_ref: `ftx:c:${ftId}`,
    } as Record<string, unknown>)}`;
    await tx`
      insert into app.invoice_groups (id, customer_id, name, combine, bill_emails, bill_format,
                                      bill_payment_terms_days, bill_skonto_percent_bp, bill_skonto_days)
      values (${uuidOf(`std-group:${id}`)}, ${id}, 'Standard', false, ${emailOk ? [email] : []}::text[], 'zugferd',
              ${days ?? 30}, ${okSkonto ? skBp : null}, ${okSkonto ? terms.skontoDays : null})
      on conflict do nothing`;
    custMap.set(ftId, id);
    cByNo.set(customerNo, { id, customer_no: customerNo, name, external_ref: `ftx:c:${ftId}` });
    cc.neu++;
  }
  // Kunden, die nur in anderen Dateien vorkommen: bereits per external_ref bekannt?
  for (const c of dbCust)
    if (c.external_ref?.startsWith('ftx:c:')) custMap.set(c.external_ref.slice(6), c.id);
  // Kundennummer aus Rechnungen/Angeboten als Rückfall
  const custByNo = new Map(
    (await tx<{ id: string; customer_no: string }[]>`select id, customer_no from app.customers`).map((c) => [
      c.customer_no,
      c.id,
    ]),
  );

  // ------------------------------------------------------------------ Objekte
  const siteMap = new Map<string, { id: string; customerId: string }>();
  const dbSites = await tx<
    {
      id: string;
      site_no: string;
      name: string;
      street: string | null;
      customer_id: string;
      external_ref: string | null;
    }[]
  >`select id, site_no, name, street, customer_id, external_ref from app.sites`;
  const sByRef = new Map(dbSites.filter((s) => s.external_ref).map((s) => [s.external_ref!, s]));
  const usedNo = new Set(dbSites.map((s) => s.site_no));
  const sc = (res.counts.Objekte = blank());
  // Zuordnung Fortytools-Objekt → Objekt der App. Fund 07.10.: gleichnamige Objekte eines Kunden („Treppenhaus“ an drei
  // Adressen) wurden über den Namen alle auf dasselbe Objekt gelegt. Deshalb: jedes Objekt höchstens einmal vergeben,
  // Name UND Straße müssen passen; die Fortytools-ID zählt nur, wenn die Straße dazu passt (alte Fehlzuordnung).
  const facilities = by.get('facilities') ?? [];
  const sameStreet = (a: string | null, b: string) => !a || !b || norm(a) === norm(b);
  const claimed = new Set<string>();
  const match = new Map<string, (typeof dbSites)[number]>();
  for (const f of facilities) {
    const ftId = get(f, 'address/addressable-id');
    const s = sByRef.get(`ftx:f:${ftId}`);
    if (s && !claimed.has(s.id) && sameStreet(s.street, get(f, 'address/street'))) {
      match.set(ftId, s);
      claimed.add(s.id);
    }
  }
  for (const f of facilities) {
    const ftId = get(f, 'address/addressable-id');
    if (match.has(ftId)) continue;
    const customerId = custMap.get(get(f, 'customer-id'));
    if (!customerId) continue;
    const no = get(f, 'number');
    const name = get(f, 'address/name') || `Objekt ${no}`;
    const street = get(f, 'address/street');
    const free = dbSites.filter(
      (s) => !claimed.has(s.id) && s.customer_id === customerId && norm(s.name) === norm(name),
    );
    const sameAddr = free.filter((s) => s.street && street && norm(s.street) === norm(street));
    const hit =
      sameAddr.find((s) => s.site_no === no) ??
      sameAddr[0] ??
      // ohne Straße nur, wenn der Name beim Kunden eindeutig ist
      (free.length === 1 &&
      facilities.filter(
        (g) => get(g, 'customer-id') === get(f, 'customer-id') && norm(get(g, 'address/name')) === norm(name),
      ).length === 1 &&
      sameStreet(free[0]!.street, street)
        ? free[0]
        : undefined);
    if (hit) {
      match.set(ftId, hit);
      claimed.add(hit.id);
    }
  }
  // Nummern: wer seine Fortytools-Nummer bekommt, gibt die bisherige frei (zweistufig wegen Tausch)
  const wantNo = new Map<string, string>();
  for (const f of facilities) {
    const hit = match.get(get(f, 'address/addressable-id'));
    const no = get(f, 'number');
    if (hit && no && hit.site_no !== no && (hit.external_ref ?? '').match(/^ftx?:/)) wantNo.set(hit.id, no);
  }
  const holder = new Map(dbSites.map((s) => [s.site_no, s.id]));
  for (let changed = true; changed;) {
    changed = false;
    const taken = new Set<string>();
    for (const [id, no] of wantNo) {
      const h = holder.get(no);
      // Nummer gehört einem Objekt, das sie behält, oder ist schon vergeben
      if ((h && h !== id && !wantNo.has(h)) || taken.has(no)) {
        wantNo.delete(id);
        changed = true;
      } else taken.add(no);
    }
  }
  // Fortytools-ID an einem falschen Objekt (alte Fehlzuordnung) freigeben
  const matchedIds = new Set([...match.values()].map((m) => m.id));
  const inFile = new Set(facilities.map((f) => get(f, 'address/addressable-id')));
  for (const s of dbSites) {
    const ref = s.external_ref?.startsWith('ftx:f:') ? s.external_ref.slice(6) : null;
    if (!ref || !inFile.has(ref) || match.get(ref)?.id === s.id) continue;
    if (matchedIds.has(s.id)) await tx`update app.sites set external_ref = null where id = ${s.id}`;
    else {
      await tx`update app.sites set external_ref = ${`ftx-frei:${ref}`} where id = ${s.id}`;
      issue(
        'Objekte',
        `${s.site_no} ${s.name}: war falsch dem Fortytools-Objekt ${ref} zugeordnet – Zuordnung gelöst`,
      );
    }
  }
  for (const id of wantNo.keys())
    await tx`update app.sites set site_no = site_no || '~' || left(id::text, 8) where id = ${id}`;
  for (const [id, no] of wantNo) {
    const s = dbSites.find((x) => x.id === id)!;
    usedNo.delete(s.site_no);
    usedNo.add(no);
  }
  for (const f of facilities) {
    const ftId = get(f, 'address/addressable-id');
    const custFt = get(f, 'customer-id');
    const customerId = custMap.get(custFt);
    const no = get(f, 'number');
    const name = get(f, 'address/name') || `Objekt ${no}`;
    if (!customerId) {
      issue(
        'Objekte',
        `${no} ${name}: Kunde (Fortytools-ID ${custFt}) nicht gefunden – bitte Kunden-Export mit importieren`,
      );
      continue;
    }
    const hit = match.get(ftId);
    const zip = get(f, 'address/zip');
    if (hit) {
      siteMap.set(ftId, { id: hit.id, customerId: hit.customer_id });
      const newNo = wantNo.get(hit.id);
      // Objekt trägt den Namen eines anderen Fortytools-Objekts desselben Kunden (alte Fehlzuordnung) → richtigen Namen
      const rename =
        norm(hit.name) !== norm(name) &&
        facilities.some(
          (g) =>
            get(g, 'customer-id') === custFt &&
            get(g, 'address/addressable-id') !== ftId &&
            norm(get(g, 'address/name')) === norm(hit.name),
        );
      const r = await tx`
        update app.sites set
          site_no = case when site_no like '%~%' then ${newNo ?? hit.site_no} else site_no end,
          name = ${rename ? name : hit.name},
          street = coalesce(nullif(street, ''), ${get(f, 'address/street') || null}),
          postal_code = coalesce(nullif(postal_code, ''), ${/^\d{4}$/.test(zip) ? `0${zip}` : zip || null}),
          city = coalesce(nullif(city, ''), ${get(f, 'address/city') || null}),
          external_ref = case when external_ref is null or external_ref like 'ft:%' or external_ref like 'ftx:f:%'
                              then ${`ftx:f:${ftId}`} else external_ref end,
          updated_at = now()
        where id = ${hit.id} and (site_no like '%~%' or ${rename} or external_ref is distinct from ${`ftx:f:${ftId}`}
                                  or coalesce(street, '') = '' and ${get(f, 'address/street')} <> ''
                                  or coalesce(city, '') = '' and ${get(f, 'address/city')} <> '')
        returning id`;
      if (r.length) sc.ergaenzt++;
      else sc.unveraendert++;
      continue;
    }
    let siteNo = no;
    if (!siteNo || usedNo.has(siteNo)) {
      issue('Objekte', `${no} ${name}: Objektnummer schon vergeben – mit Zusatz „-FT“ angelegt`);
      siteNo = `${no || ftId}-FT`;
    }
    usedNo.add(siteNo);
    const id = dbSites.some((s) => s.id === uuidOf(`ftx-site:${ftId}`))
      ? uuidOf(`ftx-site:${ftId}:neu`)
      : uuidOf(`ftx-site:${ftId}`);
    const [g] = await tx<{ id: string }[]>`
      select id from app.invoice_groups where customer_id = ${customerId} and active order by (name = 'Standard') desc limit 1`;
    await tx`insert into app.sites ${tx({
      id,
      customer_id: customerId,
      site_no: siteNo,
      name,
      street: get(f, 'address/street') || null,
      postal_code: /^\d{4}$/.test(zip) ? `0${zip}` : zip || null,
      city: get(f, 'address/city') || null,
      invoice_group_id: g?.id ?? null,
      external_ref: `ftx:f:${ftId}`,
    } as Record<string, unknown>)}`;
    siteMap.set(ftId, { id, customerId });
    sc.neu++;
  }
  for (const s of dbSites)
    if (s.external_ref?.startsWith('ftx:f:') && !siteMap.has(s.external_ref.slice(6)))
      siteMap.set(s.external_ref.slice(6), { id: s.id, customerId: s.customer_id });

  // ------------------------------------------------------------------ Tiefgaragen
  // In Fortytools sind Tiefgaragen normale Objekte („TG 245“, „Tiefgarage …“). Zusätzlich in die Tiefgaragenplanung
  // übernehmen (verknüpft mit dem Objekt = Kostenstelle). m², WE-Nr., Stellplätze, TOB gibt es in Fortytools nicht.
  const tc = (res.counts.Tiefgaragen = blank());
  const custName = new Map(
    (await tx<{ id: string; name: string }[]>`select id, name from app.customers`).map((c) => [c.id, c.name]),
  );
  const dbTg = await tx<{ id: string; name: string; city: string | null; legacy_id: string | null }[]>`
    select id, name, city, legacy_id from app.tg_objects`;
  for (const f of by.get('facilities') ?? []) {
    const name = get(f, 'address/name');
    if (!/^(TG\b|Tiefgarage)/i.test(name)) continue;
    const ftId = get(f, 'address/addressable-id');
    const site = siteMap.get(ftId);
    if (!site) continue;
    const cn = custName.get(site.customerId) ?? '';
    const customer = /dawonia/i.test(cn)
      ? 'Dawonia'
      : /münchner wohnen|gewofag|gwg/i.test(cn)
        ? 'Münchner Wohnen GmbH'
        : /zeus/i.test(cn)
          ? 'Zeus Property Management'
          : cn.trim() || 'Münchner Wohnen GmbH';
    const zip = get(f, 'address/zip');
    const city = get(f, 'address/city') || null;
    const legacy = `ftx:f:${ftId}`;
    const hit =
      dbTg.find((t) => t.legacy_id === legacy) ??
      dbTg.find(
        (t) => !t.legacy_id && norm(t.name) === norm(name) && norm(t.city ?? '') === norm(city ?? ''),
      );
    if (hit) {
      const r = await tx`
        update app.tg_objects set legacy_id = ${legacy}, site_id = ${site.id},
               object_no = coalesce(nullif(object_no, ''), ${get(f, 'number') || null}),
               address = coalesce(nullif(address, ''), ${get(f, 'address/street') || null}),
               postal_code = coalesce(nullif(postal_code, ''), ${/^\d{4}$/.test(zip) ? `0${zip}` : zip || null}),
               city = coalesce(nullif(city, ''), ${city})
         where id = ${hit.id} and (legacy_id is distinct from ${legacy} or site_id is distinct from ${site.id}
                                   or coalesce(object_no, '') = '' and ${get(f, 'number')} <> ''
                                   or coalesce(address, '') = '' and ${get(f, 'address/street')} <> '')
        returning id`;
      if (r.length) tc.ergaenzt++;
      else tc.unveraendert++;
      continue;
    }
    await tx`insert into app.tg_objects ${tx({
      id: uuidOf(`ftx-tg:${ftId}`),
      customer,
      name,
      address: get(f, 'address/street') || null,
      postal_code: /^\d{4}$/.test(zip) ? `0${zip}` : zip || null,
      city,
      object_no: get(f, 'number') || null,
      site_id: site.id,
      legacy_id: legacy,
    } as Record<string, unknown>)}`;
    tc.neu++;
  }

  // ------------------------------------------------------------------ Mitarbeiter
  const ec = (res.counts.Mitarbeiter = blank());
  for (const m of by.get('staff-members') ?? []) {
    const no = get(m, 'number');
    const full = get(m, 'address/name');
    if (!no) {
      issue('Mitarbeiter', `${full || 'ohne Name'}: keine Personalnummer – übersprungen`);
      continue;
    }
    const [e] = await tx<{ id: string; weekly_hours: string | null }[]>`
      select id, weekly_hours::text from app.employees where personnel_no = ${no}`;
    const tags = [
      ...new Set(
        arr((m['staff-tag-list'] as Node | undefined)?.['staff-tag-list'])
          .map(txt)
          .filter(Boolean),
      ),
    ];
    const hours = get(m, 'weekly-hours');
    const hoursNum = hours ? Number(hours) : null;
    const join = get(m, 'date-of-joining');
    const sep = get(m, 'date-of-separation');
    const loc = get(m, 'app-locale');
    const ik = get(m, 'health-insurance-ik');
    const insurer = ik ? (IK[ik] ?? `Sonstige (IK ${ik})`) : null;
    const vac = get(m, 'vacation-days-per-year');
    const zip = get(m, 'address/zip');
    const type = tags.includes('Minijob')
      ? 'minijob'
      : tags.includes('Vollzeit')
        ? 'vollzeit'
        : tags.includes('Teilzeit')
          ? 'teilzeit'
          : hoursNum && hoursNum >= 35
            ? 'vollzeit'
            : 'teilzeit';
    if (!e) {
      if (!join) {
        issue('Mitarbeiter', `${no} ${full}: ohne Eintrittsdatum – nicht angelegt`);
        continue;
      }
      const parts = full.split(/\s+/);
      const last = parts.length > 1 ? parts.pop()! : full;
      const first = parts.join(' ') || '-';
      const id = uuidOf(`ftx-employee:${no}`);
      const status = sep && sep <= today ? 'ausgetreten' : 'aktiv';
      await tx`insert into app.employees ${tx({
        id,
        personnel_no: no,
        first_name: first,
        last_name: last,
        employment_type: type,
        entry_date: join,
        exit_date: sep || null,
        status,
        weekly_hours: hoursNum,
        annual_leave_days: vac ? Math.min(60, Number(vac)) : 30,
        tags: [
          ...new Set([
            type === 'minijob' ? 'Minijob' : type === 'vollzeit' ? 'Vollzeit' : 'Teilzeit',
            ...tags,
          ]),
        ],
        languages: loc && LOCALE_LANG[loc] ? [LOCALE_LANG[loc]] : [],
        app_language: loc && APP_LANGS.has(loc) ? loc : 'de',
      } as Record<string, unknown>)}`;
      await tx`insert into app.employee_private (employee_id, street, postal_code, city, health_insurance)
               values (${id}, ${get(m, 'address/street') || null}, ${/^\d{4}$/.test(zip) ? `0${zip}` : zip || null},
                       ${get(m, 'address/city') || null}, ${insurer}) on conflict (employee_id) do nothing`;
      await tx`insert into app.employee_hours (employee_id, valid_from, weekly_hours, note, recorded_by)
               values (${id}, ${join}, ${hoursNum}, 'Fortytools-Import', ${actor}) on conflict do nothing`;
      ec.neu++;
      continue;
    }
    let changed = false;
    if (hoursNum != null && Number(e.weekly_hours ?? -1) !== hoursNum) {
      await tx`update app.employees set weekly_hours = ${hoursNum}, version = version + 1, updated_at = now() where id = ${e.id}`;
      await tx`insert into app.employee_hours (employee_id, valid_from, weekly_hours, note, recorded_by)
               values (${e.id}, ${today}, ${hoursNum}, 'Fortytools-Import', ${actor}) on conflict do nothing`;
      changed = true;
    }
    const r1 = await tx`
      update app.employees set
        annual_leave_days = case when ${vac || null}::numeric is not null and annual_leave_days = 30 then least(60, ${vac || null}::numeric) else annual_leave_days end,
        languages = case when cardinality(languages) = 0 and ${loc && LOCALE_LANG[loc] ? LOCALE_LANG[loc] : null}::text is not null
                         then array[${loc && LOCALE_LANG[loc] ? LOCALE_LANG[loc] : ''}]::text[] else languages end,
        app_language = case when app_language = 'de' and ${loc && APP_LANGS.has(loc) ? loc : null}::text is not null
                            then ${loc && APP_LANGS.has(loc) ? loc : 'de'} else app_language end,
        tags = (select array(select distinct x from unnest(tags || ${tags}::text[]) x)),
        updated_at = now()
      where id = ${e.id}
        and (cardinality(languages) = 0 and ${loc && LOCALE_LANG[loc] ? 1 : 0} = 1
             or not (tags @> ${tags}::text[])
             or annual_leave_days = 30 and ${vac || null}::numeric is not null and ${vac || null}::numeric <> 30)
      returning id`;
    const r2 = await tx`
      insert into app.employee_private (employee_id, street, postal_code, city, health_insurance)
      values (${e.id}, ${get(m, 'address/street') || null}, ${/^\d{4}$/.test(zip) ? `0${zip}` : zip || null},
              ${get(m, 'address/city') || null}, ${insurer})
      on conflict (employee_id) do update set
        street = coalesce(app.employee_private.street, excluded.street),
        postal_code = coalesce(app.employee_private.postal_code, excluded.postal_code),
        city = coalesce(app.employee_private.city, excluded.city),
        health_insurance = coalesce(app.employee_private.health_insurance, excluded.health_insurance)
      where app.employee_private.street is null and excluded.street is not null
         or app.employee_private.health_insurance is null and excluded.health_insurance is not null
      returning employee_id`;
    if (changed || r1.length || r2.length) ec.ergaenzt++;
    else ec.unveraendert++;
  }

  // ------------------------------------------------------------------ Leistungsarten (für Angebote/Leistungen)
  const typeIds = new Map(
    (await tx<{ id: string; name: string }[]>`select id, name from app.service_types`).map((t) => [
      norm(t.name),
      t.id,
    ]),
  );
  const typeId = async (name: string) => {
    if (!name) return null;
    const k = norm(name);
    if (typeIds.has(k)) return typeIds.get(k)!;
    const id = uuidOf(`ft-type:${k}`);
    await tx`insert into app.service_types (id, name, sort_order)
             values (${id}, ${name}, (select coalesce(max(sort_order), 0) + 10 from app.service_types))
             on conflict do nothing`;
    typeIds.set(k, id);
    return id;
  };

  // ------------------------------------------------------------------ Angebote
  const oc = (res.counts.Angebote = blank());
  let maxOffer = 0;
  const offers = by.get('offers') ?? [];
  const offerIdByNo = new Map<string, string>();
  for (const o of offers) {
    const no = get(o, 'number');
    if (no) offerIdByNo.set(no, uuidOf(`ftx-offer:${no}`));
  }
  for (const o of offers) {
    const no = get(o, 'number');
    const date = get(o, 'date');
    const type = get(o, 'offerable-type');
    const oid = get(o, 'offerable-id');
    const site = type === 'Facility' ? siteMap.get(oid) : undefined;
    const customerId = type === 'Customer' ? custMap.get(oid) : site?.customerId;
    if (!customerId) {
      issue('Angebote', `Angebot ${no || '(Entwurf)'} vom ${date}: Kunde/Objekt nicht gefunden`);
      continue;
    }
    if (Number(no) > maxOffer) maxOffer = Number(no);
    const id = no
      ? offerIdByNo.get(no)!
      : uuidOf(`ftx-offer:draft:${oid}:${date}:${get(o, 'header-text').length}`);
    const [ex] = await tx`select 1 from app.offers where id = ${id} or (number = ${no} and ${no} <> '')`;
    if (ex) {
      oc.unveraendert++;
      continue;
    }
    const lines = arr((o['offer-positions'] as Node | undefined)?.['offer-position']);
    let net = 0n;
    let monthly = 0n;
    const rows = lines.map((p, i) => {
      const q = milliOf(get(p, 'quantity') || '1');
      const price = centsOf(get(p, 'price') || '0');
      const lineNet = (q * price + (q * price >= 0n ? 500n : -500n)) / 1000n;
      const alt = get(p, 'is-alternative') === 'true';
      const recurring = /monat/i.test(get(p, 'service-pattern/name'));
      if (!alt) {
        net += lineNet;
        if (recurring) monthly += lineNet;
      }
      return {
        id: uuidOf(`ftx-offer-line:${id}:${i}`),
        offer_id: id,
        position: i + 1,
        description: get(p, 'title') || get(p, 'service-type/name') || 'Leistung',
        detail: get(p, 'details') || null,
        quantity_milli: q === 0n ? 1000n : q,
        unit_code: unitOf(get(p, 'unit/name')),
        unit_price_cents: price < 0n ? 0n : price,
        net_cents: lineNet,
        vat_rate_bp: 1900,
        recurring,
        alternative: alt,
      };
    });
    const vat = (net * 19n + 50n) / 100n;
    const status = OFFER_STATUS[get(o, 'state')] ?? 'versendet';
    const title =
      lines.map((p) => get(p, 'title')).find(Boolean) ||
      lines.map((p) => get(p, 'service-type/name')).find(Boolean) ||
      'Angebot';
    await tx`insert into app.offers ${tx({
      id,
      number: no || `FT-Entwurf-${id.slice(0, 8)}`,
      customer_id: customerId,
      site_id: site?.id ?? null,
      title: title.split('\n')[0]!.slice(0, 200),
      offer_date: date,
      status,
      intro_text: get(o, 'header-text') || null,
      closing_text: get(o, 'footer-text') || null,
      net_cents: net,
      vat_cents: vat,
      gross_cents: net + vat,
      monthly_net_cents: monthly,
      created_by: 'fortytools',
      decided_at: status === 'angenommen' || status === 'abgelehnt' ? new Date(`${date}T12:00:00Z`) : null,
    } as Record<string, unknown>)}`;
    if (rows.length) await tx`insert into app.offer_lines ${tx(rows as Record<string, unknown>[])}`;
    oc.neu++;
  }
  for (const o of offers) {
    const parent = get(o, 'parent-number');
    const no = get(o, 'number');
    if (parent && no && offerIdByNo.has(parent))
      await tx`update app.offers set predecessor_id = ${offerIdByNo.get(parent)!}
               where id = ${offerIdByNo.get(no)!} and predecessor_id is null
                 and exists (select 1 from app.offers where id = ${offerIdByNo.get(parent)!})`;
  }

  // ------------------------------------------------------------------ Rechnungsarchiv
  const ic = (res.counts['Rechnungen (Archiv)'] = blank());
  let maxInv = 0n;
  const invoices = by.get('invoices') ?? [];
  const ourNumbers = new Set(
    (await tx<{ number: string }[]>`select number from app.invoices where number is not null`).map(
      (r) => r.number,
    ),
  );
  const invRows: Record<string, unknown>[] = [];
  const lineRows: Record<string, unknown>[] = [];
  const existing = new Set(
    (await tx<{ number: string }[]>`select number from app.legacy_invoices`).map((r) => r.number),
  );
  const monthly = new Map<string, { month: string; lines: Node[] }>(); // Objekt → letzte Monatsrechnung
  const fix: { id: string; site: string | null; ref: string | null }[] = [];
  const head: {
    no: string;
    h: string | null;
    f: string | null;
    root: string | null;
    paidAt: string | null;
  }[] = [];
  for (const iv of invoices) {
    const no = get(iv, 'number');
    if (!no) continue; // Entwürfe in Fortytools
    if (/^\d+$/.test(no) && BigInt(no) > maxInv) maxInv = BigInt(no);
    if (ourNumbers.has(no)) res.numberClashes.push(no);
    const date = get(iv, 'date');
    const positions = arr((iv['invoice-positions'] as Node | undefined)?.['invoice-position']);
    // Monatspauschalen merken (auch für schon importierte Rechnungen)
    if (!get(iv, 'parent-invoice-id') && !get(iv, 'net-amount').startsWith('-'))
      for (const p of positions) {
        const s = get(p, 'service-period-start');
        const e = get(p, 'service-period-end');
        if (get(p, 'invoiceable-type') !== 'Facility' || !s || s.slice(8) !== '01' || e !== lastDay(s))
          continue;
        if (!/^(pauschal|psch)$/i.test(get(p, 'unit/name'))) continue;
        const fid = get(p, 'invoiceable-id');
        const cur = monthly.get(fid);
        if (!cur || cur.month < s.slice(0, 7)) monthly.set(fid, { month: s.slice(0, 7), lines: [p] });
        else if (cur.month === s.slice(0, 7)) cur.lines.push(p);
      }
    const lineSite = (p: Node) =>
      get(p, 'invoiceable-type') === 'Facility' ? (siteMap.get(get(p, 'invoiceable-id'))?.id ?? null) : null;
    const lineRef = (p: Node) =>
      get(p, 'invoiceable-type') === 'Facility' ? get(p, 'invoiceable-id') || null : null;
    if (existing.has(no)) {
      // schon im Archiv: nur die Objekt-Zuordnung (und Kopf-/Fußtext) nachziehen
      positions.forEach((p, i) =>
        fix.push({ id: uuidOf(`ftx-invoice-line:${no}:${i}`), site: lineSite(p), ref: lineRef(p) }),
      );
      head.push({
        no,
        h: get(iv, 'header-text') || null,
        f: get(iv, 'footer-text') || null,
        root: get(iv, 'open-items-root-id') || null,
        paidAt:
          get(iv, 'payment-status') === 'paid' ? get(iv, 'paid-at').slice(0, 10) || get(iv, 'date') : null,
      });
      ic.unveraendert++;
      continue;
    }
    existing.add(no);
    const cftId = get(iv, 'customer-id');
    const id = uuidOf(`ftx-invoice:${no}`);
    const paid = get(iv, 'payment-status') === 'paid';
    invRows.push({
      id,
      number: no,
      issue_date: date,
      due_date: get(iv, 'due-date') || null,
      delivery_date: get(iv, 'delivery-date') || null,
      customer_id: custMap.get(cftId) ?? custByNo.get(get(iv, 'customer/number')) ?? null,
      customer_no: get(iv, 'customer/number') || null,
      net_cents: centsOf(get(iv, 'net-amount')),
      gross_cents: centsOf(get(iv, 'gross-amount')),
      paid,
      paid_at: paid ? get(iv, 'paid-at').slice(0, 10) || null : null,
      parent_number: null,
      customer_reference: get(iv, 'customer-reference') || null,
      payment_terms: get(iv, 'payment-practice/name') || null,
      header_text: get(iv, 'header-text') || null,
      footer_text: get(iv, 'footer-text') || null,
      ft_root_id: get(iv, 'open-items-root-id') || null,
    });
    positions.forEach((p, i) => {
      lineRows.push({
        id: uuidOf(`ftx-invoice-line:${no}:${i}`),
        invoice_id: id,
        position: i + 1,
        title: get(p, 'title') || null,
        details: get(p, 'details') || null,
        quantity_milli: milliOf(get(p, 'quantity') || '0'),
        unit: get(p, 'unit/name') || null,
        unit_price_cents: centsOf(get(p, 'price') || '0'),
        net_cents: centsOf(get(p, 'net-amount') || '0'),
        service_type: get(p, 'service-type/name') || null,
        period_start: get(p, 'service-period-start') || null,
        period_end: get(p, 'service-period-end') || null,
        site_id: lineSite(p),
        facility_ref: lineRef(p),
      });
    });
    ic.neu++;
  }
  for (let i = 0; i < invRows.length; i += 500)
    await tx`insert into app.legacy_invoices ${tx(invRows.slice(i, i + 500))} on conflict do nothing`;
  for (let i = 0; i < lineRows.length; i += 500)
    await tx`insert into app.legacy_invoice_lines ${tx(lineRows.slice(i, i + 500))} on conflict do nothing`;
  let moved = 0;
  let paidNow = 0;
  for (let i = 0; i < fix.length; i += 1000) {
    const part = fix.slice(i, i + 1000);
    const [cnt] = await tx<{ n: number }[]>`
      select count(*)::int as n from app.legacy_invoice_lines l
        join unnest(${part.map((x) => x.id)}::uuid[], ${part.map((x) => x.site)}::text[]) as x(id, site) on x.id = l.id
       where l.site_id is distinct from x.site::uuid`;
    moved += cnt?.n ?? 0;
    await tx`
      update app.legacy_invoice_lines l set site_id = x.site::uuid, facility_ref = coalesce(l.facility_ref, x.ref)
        from unnest(${part.map((x) => x.id)}::uuid[], ${part.map((x) => x.site)}::text[], ${part.map((x) => x.ref)}::text[])
             as x(id, site, ref)
       where l.id = x.id and (l.site_id is distinct from x.site::uuid or l.facility_ref is null and x.ref is not null)`;
  }
  if (moved) issue('Rechnungen', `${moved} Rechnungspositionen dem richtigen Objekt zugeordnet`);
  for (let i = 0; i < head.length; i += 1000) {
    const part = head.slice(i, i + 1000);
    await tx`
      update app.legacy_invoices l set header_text = coalesce(l.header_text, x.h), footer_text = coalesce(l.footer_text, x.f),
             ft_root_id = coalesce(x.root, l.ft_root_id)
        from unnest(${part.map((x) => x.no)}::text[], ${part.map((x) => x.h)}::text[], ${part.map((x) => x.f)}::text[],
                    ${part.map((x) => x.root)}::text[]) as x(no, h, f, root)
       where l.number = x.no and (l.header_text is null and x.h is not null or l.footer_text is null and x.f is not null
                                  or l.ft_root_id is distinct from coalesce(x.root, l.ft_root_id))`;
    // in Fortytools inzwischen bezahlt → hier auch (neuerer Export); „bezahlt“ wird nie zurückgenommen
    const nowPaid = await tx`
      update app.legacy_invoices l set paid = true, paid_at = x.paid_at::date, paid_marked_by = 'Fortytools-Import'
        from unnest(${part.filter((x) => x.paidAt).map((x) => x.no)}::text[],
                    ${part.filter((x) => x.paidAt).map((x) => x.paidAt)}::text[]) as x(no, paid_at)
       where l.number = x.no and not l.paid returning l.id`;
    paidNow += nowPaid.length;
  }
  if (paidNow)
    issue(
      'Rechnungen',
      `${paidNow} Rechnungen inzwischen in Fortytools bezahlt – hier als bezahlt übernommen`,
    );
  // Storno/Korrektur: Bezug über die Fortytools-ID des Originals lässt sich nicht auflösen → Kennzeichen „negativ“
  if (res.numberClashes.length)
    issue(
      'Rechnungen',
      `ACHTUNG: ${res.numberClashes.length} Rechnungsnummer(n) gibt es in Fortytools UND in der App (${res.numberClashes.slice(0, 5).join(', ')}) – bitte sofort klären`,
    );

  // ------------------------------------------------------------------ Monatspauschalen je Objekt
  const mc = (res.counts['Monatspauschalen (aus Rechnungen)'] = blank());
  for (const [fid, m] of monthly) {
    const site = siteMap.get(fid);
    if (!site) continue;
    const [has] = await tx`
      select 1 from app.site_services where site_id = ${site.id} and active and billing_cycle <> 'je_ausfuehrung'
        and billing_cycle <> 'einmalig' and (valid_to is null or valid_to >= current_date) limit 1`;
    if (has) {
      mc.unveraendert++;
      continue;
    }
    let k = 0;
    for (const p of m.lines) {
      const price = centsOf(get(p, 'price') || '0');
      const q = milliOf(get(p, 'quantity') || '1');
      if (price <= 0n || q <= 0n) continue;
      await tx`insert into app.site_services ${tx({
        id: uuidOf(`ftx-service:${fid}:${k++}`),
        site_id: site.id,
        kind: 'monthly_flat',
        description: (get(p, 'title') || get(p, 'service-type/name') || 'Unterhaltsreinigung')
          .split('\n')[0]!
          .slice(0, 200),
        note: get(p, 'details') || null,
        unit_code: 'LS',
        quantity_milli: q,
        unit_price_cents: price,
        vat_rate_bp: 1900,
        valid_from: nextMonth(m.month),
        billing_cycle: 'monatlich',
        service_type_id: await typeId(get(p, 'service-type/name')),
      } as Record<string, unknown>)} on conflict do nothing`;
    }
    if (k) mc.neu += k;
  }

  // ------------------------------------------------------------------ Nummernkreise anheben (nie senken)
  if (maxInv > 0n) {
    const [r] = await tx<{ next_value: string }[]>`
      update app.number_ranges set next_value = greatest(next_value, ${(maxInv + 1n).toString()}::bigint), updated_at = now()
       where key = 'invoice' returning next_value::text`;
    res.counters.invoiceNext = r?.next_value ?? null;
  }
  if (maxOffer > 0) {
    const [r] = await tx<{ next_value: string }[]>`
      update app.number_ranges set next_value = greatest(next_value, ${maxOffer + 1}::bigint), updated_at = now()
       where key = 'offer' returning next_value::text`;
    res.counters.offerNext = r?.next_value ?? null;
  }
  await tx`insert into app.audit_log (actor, action, entity, details)
           values (${actor}, 'import', 'fortytools_xml', ${tx.json({ counts: res.counts, files: res.files } as never)})`;
}

/** Offene Fortytools-Rechnungen (für die Übersicht „Offene Posten“), Storno/Korrektur mit der Rechnung verrechnet. */
export async function openLegacyInvoices(sql: Sql) {
  return sql<
    {
      id: string;
      number: string;
      issue_date: string;
      due_date: string | null;
      gross_cents: bigint;
      customer_id: string | null;
      customer_name: string | null;
      customer_no: string | null;
    }[]
  >`
    select o.invoice_id as id, o.number, o.issue_date::text, o.due_date::text, o.open_cents as gross_cents, o.customer_id,
           c.name as customer_name, coalesce(c.customer_no, l.customer_no) as customer_no
      from app.legacy_open_items o join app.legacy_invoices l on l.id = o.invoice_id
      left join app.customers c on c.id = o.customer_id
     where o.open_cents <> 0
     order by o.due_date nulls last, o.number`;
}

/** Zahlung zu einer Fortytools-Rechnung festhalten: voller offener Betrag → bezahlt, sonst Teilzahlung. */
export async function markLegacyPaid(
  sql: Sql,
  id: string,
  date: string,
  actor: string,
  amountCents?: bigint,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BusinessError('Datum fehlt');
  const [o] = await sql<
    { open_cents: bigint }[]
  >`select open_cents from app.legacy_open_items where invoice_id = ${id}`;
  if (!o) throw new BusinessError('Rechnung ist nicht (mehr) offen');
  const amount = amountCents ?? o.open_cents;
  if (amount <= 0n) throw new BusinessError('Betrag muss größer als 0 sein');
  await settleOpenItem(sql, {
    batchId: randomUUID(),
    invoiceId: id,
    legacy: true,
    amount,
    date,
    rest: 'offen',
    reference: null,
    actor,
  });
}

/**
 * PDF einer Fortytools-Rechnung auf unserem Briefpapier (gleiches Layout wie eigene Rechnungen), erzeugt aus den
 * importierten Rechnungsdaten (Ahmed 07.10.: ohne Kopie-Vermerk). Das Original liegt in Fortytools – nicht erneut als
 * Rechnung versenden: zweite Rechnung über dieselbe Leistung → Steuer nach § 14c UStG.
 */
export async function renderLegacyInvoicePdf(sql: Sql, id: string) {
  const [inv] = await sql<
    {
      number: string;
      issue_date: string;
      due_date: string | null;
      customer_id: string | null;
      customer_no: string | null;
      net_cents: bigint;
      gross_cents: bigint;
      payment_terms: string | null;
      customer_reference: string | null;
      header_text: string | null;
      footer_text: string | null;
    }[]
  >`select number, issue_date::text, due_date::text, customer_id, customer_no, net_cents, gross_cents, payment_terms,
           customer_reference, header_text, footer_text
      from app.legacy_invoices where id = ${id}`;
  if (!inv) throw new BusinessError('Rechnung nicht gefunden');
  const lines = await sql<
    {
      position: number;
      title: string | null;
      details: string | null;
      quantity_milli: bigint;
      unit: string | null;
      unit_price_cents: bigint;
      net_cents: bigint;
      service_type: string | null;
      period_start: string | null;
      period_end: string | null;
      site_name: string | null;
      site_no: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`select x.position, x.title, x.details, x.quantity_milli, x.unit, x.unit_price_cents, x.net_cents, x.service_type,
           x.period_start::text, x.period_end::text, s.name as site_name, s.site_no, s.street, s.postal_code, s.city
      from app.legacy_invoice_lines x left join app.sites s on s.id = x.site_id
     where x.invoice_id = ${id} order by x.position`;
  const seller = await getSeller(sql);
  const buyer: BuyerSnapshot = inv.customer_id
    ? await buildBuyerSnapshot(sql, inv.customer_id, null)
    : {
        customerNo: inv.customer_no ?? '',
        name: `Kunde ${inv.customer_no ?? ''}`,
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
      };
  const vat = inv.gross_cents - inv.net_cents;
  const rate =
    inv.net_cents === 0n || vat === 0n
      ? 0
      : [1900, 700].reduce((best, r) =>
          Math.abs(Number((vat * 10000n) / inv.net_cents) - r) <
          Math.abs(Number((vat * 10000n) / inv.net_cents) - best)
            ? r
            : best,
        );
  const UNIT: Record<string, string> = {
    pauschal: 'LS',
    psch: 'LS',
    'std.': 'HUR',
    'stk.': 'C62',
    'tg.': 'DAY',
    qm: 'MTK',
  };
  const negative = inv.net_cents < 0n;
  const doc: InvoiceDocument = {
    kind: negative ? 'correction' : 'invoice',
    number: inv.number,
    issueDate: inv.issue_date,
    dueDate: inv.due_date ?? inv.issue_date,
    periodStart: null,
    periodEnd: null,
    buyerReference: inv.customer_reference,
    orderReference: null,
    introText: inv.header_text?.replace(/^Sehr geehrte Damen und Herren,\s*/i, '') || null,
    closingText: null,
    lines: lines.map((l) => ({
      position: l.position,
      description: (l.title || l.service_type || 'Leistung').split('\n')[0]!,
      detail:
        [
          (l.title ?? '').split('\n').slice(1).join('\n') || null,
          l.details,
          l.site_name
            ? `Objekt: ${l.site_name} (${l.site_no})${l.street ? `\n${l.street}, ${[l.postal_code, l.city].filter(Boolean).join(' ')}` : ''}`
            : null,
          l.period_start
            ? `${formatDateDe(l.period_start)}${l.period_end && l.period_end !== l.period_start ? ` bis ${formatDateDe(l.period_end)}` : ''}`
            : null,
        ]
          .filter(Boolean)
          .join('\n') || null,
      quantity: l.quantity_milli as Quantity,
      unitCode: UNIT[(l.unit ?? '').toLowerCase()] ?? 'C62',
      unitPrice: l.unit_price_cents as Cents,
      netAmount: l.net_cents as Cents,
      vatRate: rate as VatRate,
    })),
    netTotal: inv.net_cents as Cents,
    vatTotal: vat as Cents,
    grossTotal: inv.gross_cents as Cents,
    prepaidTotal: 0n as Cents,
    payableTotal: inv.gross_cents as Cents,
    vatBreakdown: [
      { vatRate: rate as VatRate, taxableAmount: inv.net_cents as Cents, taxAmount: vat as Cents },
    ],
    seller,
    buyer,
    original: null,
    prepayments: [],
    skonto: null,
  };
  const pdf = await renderInvoicePdf(doc, {
    title: `${negative ? 'Rechnungskorrektur' : 'Rechnung'} ${inv.number}`,
    terms: inv.payment_terms ? `Zahlungsbedingung: ${inv.payment_terms}` : '',
    ...(inv.footer_text ? { closing: inv.footer_text } : {}),
    qr: false,
  });
  return { pdf, filename: `Rechnung_${inv.number}.pdf` };
}
