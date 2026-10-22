/*
 * Ausschreibungssuche (Ahmed 22.10.: „München + 100 km, Stuttgart + 20 km, alle Leistungen“). Quellen:
 *  - Bekanntmachungsservice des Bundes (oeffentlichevergabe.de), Open-Data-Export je Veröffentlichungstag als OCDS-ZIP
 *    (CC0, ohne Anmeldung) – enthält die deutschen Bekanntmachungen ober- und vieler unterhalb der Schwellenwerte.
 *  - TED (EU-Amtsblatt), offizielle Such-Schnittstelle v3 – EU-weite Ausschreibungen in Deutschland.
 * Filter: Leistung über CPV-Anfang oder Stichwort, Ort über Entfernung (Nominatim, zwischengespeichert) zu den
 * eingestellten Umkreisen. Treffer landen im Eingang „Gefundene Ausschreibungen“ (feste ID je Quelle + Kennung, nichts
 * doppelt); erst „Übernehmen“ legt eine Ausschreibung an (mit Abgabefrist-Aufgabe). Vergabeunterlagen und Angebotsabgabe
 * bleiben auf der Vergabeplattform.
 */
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { distanceKm } from './hospital.js';
import { saveTender } from './tenders.js';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'Viva-Deluxe-App/1.0 Ausschreibungssuche (info@viva-deluxe-reinigung.de)';
const BUND = 'https://oeffentlichevergabe.de';
const TED = 'https://api.ted.europa.eu/v3/notices/search';
/** Beim ersten Lauf so viele Tage zurück holen */
const FIRST_DAYS = 14;
/** Ohne erkennbaren Ort: diese NUTS-Regionen liegen (teilweise) in den Umkreisen → zur Prüfung aufnehmen */
const NUTS_NEAR = ['DE21', 'DE22', 'DE23', 'DE27', 'DE111', 'DE112', 'DE113', 'DE115', 'DE116'];

export interface Region {
  name: string;
  lat: number;
  lng: number;
  km: number;
}
export interface FeedSettings {
  enabled: boolean;
  cpv_prefixes: string[];
  keywords: string[];
  regions: Region[];
  keep_unknown: boolean;
}

export interface FeedNotice {
  source: 'bund' | 'ted';
  externalId: string;
  title: string;
  description: string | null;
  authority: string | null;
  place: string | null;
  postalCode: string | null;
  nuts: string | null;
  /** ISO-Zeitpunkt (mit Zeitzone) oder JJJJ-MM-TT */
  deadline: string | null;
  published: string | null;
  cpv: string[];
  url: string | null;
  docsUrl: string | null;
  procedure: string | null;
  valueCents: bigint | null;
}

// ---------------------------------------------------------------- Einstellungen

export async function getFeedSettings(sql: Sql): Promise<FeedSettings> {
  const [s] = await sql<FeedSettings[]>`
    select enabled, cpv_prefixes, keywords, regions, keep_unknown from app.tender_feed_settings where id = 1`;
  return (
    s ?? {
      enabled: false,
      cpv_prefixes: [],
      keywords: [],
      regions: [],
      keep_unknown: true,
    }
  );
}

export async function saveFeedSettings(sql: Sql, p: FeedSettings, actor: string) {
  const cpv = [...new Set(p.cpv_prefixes.map((c) => c.replace(/\D/g, '')).filter((c) => c.length >= 2))];
  if (cpv.some((c) => c.length > 8)) throw new BusinessError('CPV-Codes haben höchstens 8 Ziffern');
  const kw = [...new Set(p.keywords.map((k) => k.trim()).filter((k) => k.length >= 3))];
  if (!cpv.length && !kw.length)
    throw new BusinessError('Bitte mindestens einen CPV-Code oder ein Stichwort angeben');
  for (const r of p.regions) {
    if (!r.name.trim()) throw new BusinessError('Umkreis: bitte Ort angeben');
    if (!(r.km >= 1 && r.km <= 500)) throw new BusinessError(`Umkreis ${r.name}: 1 bis 500 km`);
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng))
      throw new BusinessError(`Ort „${r.name}“ nicht gefunden – bitte PLZ oder genauen Ortsnamen angeben`);
  }
  if (!p.regions.length) throw new BusinessError('Bitte mindestens einen Umkreis angeben');
  await sql`
    insert into app.tender_feed_settings (id, enabled, cpv_prefixes, keywords, regions, keep_unknown, updated_at)
    values (1, ${p.enabled}, ${cpv}, ${kw}, ${sql.json(p.regions as never)}, ${p.keep_unknown}, now())
    on conflict (id) do update set enabled = excluded.enabled, cpv_prefixes = excluded.cpv_prefixes,
      keywords = excluded.keywords, regions = excluded.regions, keep_unknown = excluded.keep_unknown,
      updated_at = now()`;
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${actor}, 'save', 'tender_feed_settings',
                    ${sql.json({ cpv, keywords: kw, regions: p.regions.map((r) => `${r.name} ${r.km} km`) })})`;
}

// ---------------------------------------------------------------- Bund: OCDS

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const txt = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
};

function toCents(v: unknown): bigint | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 100));
}

/** Releases aus einer OCDS-Datei (Release-Paket, Record-Paket, einzelnes Release oder Liste). */
export function ocdsReleases(data: unknown): J[] {
  if (Array.isArray(data)) return data.flatMap(ocdsReleases);
  const d = obj(data);
  if (Array.isArray(d.releases)) return d.releases.map(obj);
  if (Array.isArray(d.records))
    return d.records.flatMap((r) => {
      const rec = obj(r);
      return rec.compiledRelease ? [obj(rec.compiledRelease)] : arr(rec.releases).map(obj);
    });
  if (d.tender || d.ocid) return [d];
  return [];
}

/** Ein OCDS-Release in eine Bekanntmachung übersetzen (null = keine laufende Ausschreibung). */
export function parseOcdsRelease(r: J): FeedNotice | null {
  const tags = arr(r.tag).map(String);
  if (tags.length && !tags.some((t) => t === 'tender' || t === 'tenderUpdate')) return null;
  const tender = obj(r.tender);
  const title = txt(tender.title) ?? txt(r.title);
  if (!title) return null;
  const parties = arr(r.parties).map(obj);
  const buyerRef = obj(r.buyer);
  const buyer =
    parties.find((p) => buyerRef.id && p.id === buyerRef.id) ??
    parties.find((p) => arr(p.roles).includes('buyer')) ??
    null;
  const lots = arr(tender.lots).map(obj);
  const items = arr(tender.items).map(obj);
  // Ort der Leistung vor Anschrift des Auftraggebers
  const delivery = [
    ...items.flatMap((i) => [...arr(i.deliveryAddresses), ...arr(i.deliveryAddress)]),
    ...arr(tender.deliveryAddresses),
    ...lots.flatMap((l) => arr(l.deliveryAddresses)),
  ].map(obj);
  const addr = delivery.find((a) => txt(a.postalCode) || txt(a.locality)) ?? obj(buyer?.address);
  const nuts =
    [...delivery.map((a) => txt(a.region)), txt(obj(buyer?.address).region)].find(
      (n) => n && /^DE[0-9A-Z]*$/.test(n),
    ) ?? null;
  const ends = [obj(tender.tenderPeriod).endDate, ...lots.map((l) => obj(l.tenderPeriod).endDate)]
    .map(txt)
    .filter((x): x is string => !!x)
    .sort();
  const cpv = [
    obj(tender.classification),
    ...items.flatMap((i) => [obj(i.classification), ...arr(i.additionalClassifications).map(obj)]),
    ...lots.flatMap((l) => arr(l.classifications).map(obj)),
  ]
    .filter((c) => !c.scheme || /cpv/i.test(String(c.scheme)))
    .map((c) => txt(c.id)?.replace(/\D/g, '').slice(0, 8))
    .filter((c): c is string => !!c && c.length >= 2);
  const docs = arr(tender.documents).map(obj);
  const docUrls = docs.map((d) => txt(d.url)).filter((u): u is string => !!u);
  const noticeId =
    docUrls.map((u) => /noticeId=([0-9a-fA-F-]{36})/.exec(u)?.[1]).find(Boolean) ??
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(r.id ?? ''))?.[1] ??
    null;
  const docsUrl =
    docUrls.find((u) => !/oeffentlichevergabe\.de/i.test(u)) ??
    txt(obj(tender.submissionMethodDetails).url) ??
    null;
  const value =
    toCents(obj(tender.value).amount) ??
    (lots.length
      ? lots.reduce<bigint | null>((s, l) => {
          const v = toCents(obj(l.value).amount);
          return v === null ? s : (s ?? 0n) + v;
        }, null)
      : null);
  const externalId = txt(r.ocid) ?? noticeId ?? txt(r.id);
  if (!externalId) return null;
  return {
    source: 'bund',
    externalId,
    title,
    description: txt(tender.description)?.slice(0, 2000) ?? null,
    authority: txt(buyer?.name) ?? txt(buyerRef.name),
    place: txt(addr.locality),
    postalCode: txt(addr.postalCode)?.replace(/\s/g, '') ?? null,
    nuts,
    deadline: ends[ends.length - 1] ?? null,
    published: txt(r.date)?.slice(0, 10) ?? null,
    cpv: [...new Set(cpv)],
    url: noticeId ? `${BUND}/ui/de/search/details?noticeId=${noticeId}` : `${BUND}/ui/de/search`,
    docsUrl,
    procedure: txt(tender.procurementMethodDetails) ?? txt(tender.procurementMethod),
    valueCents: value,
  };
}

/** Bekanntmachungen eines Veröffentlichungstags (leer, wenn der Export noch nicht da ist). */
export async function fetchBundDay(fetcher: Fetch, day: string): Promise<FeedNotice[] | null> {
  const r = await fetcher(`${BUND}/api/notice-exports?pubDay=${day}&format=ocds.zip`, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(120_000),
  });
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) throw new Error(`Bund-Export ${day}: HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return parseBundExport(buf);
}

export function parseBundExport(buf: Uint8Array): FeedNotice[] {
  const texts: string[] = [];
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf, { filter: (f) => /\.json$/i.test(f.name) });
    for (const name of Object.keys(files)) texts.push(strFromU8(files[name]!));
  } else texts.push(strFromU8(buf));
  const out: FeedNotice[] = [];
  for (const t of texts) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      continue;
    }
    for (const rel of ocdsReleases(data)) {
      const n = parseOcdsRelease(rel);
      if (n) out.push(n);
    }
  }
  return out;
}

// ---------------------------------------------------------------- TED

const TED_FIELDS = [
  'publication-number',
  'publication-date',
  'notice-title',
  'title-proc',
  'buyer-name',
  'buyer-city',
  'buyer-country',
  'classification-cpv',
  'deadline-receipt-tender-date-lot',
  'estimated-value-proc',
  'links',
];
/** Felder, die nicht jede Fassung der Schnittstelle kennt – bei Fehler ohne sie wiederholen */
const TED_EXTRA = ['buyer-post-code', 'place-of-performance', 'description-proc'];
const TED_TYPES = [
  'cn-standard',
  'cn-social',
  'cn-desg',
  'subco',
  'qu-sy',
  'pin-cfc-standard',
  'pin-cfc-social',
];

const pickLang = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return pickLang(v[0]);
  const o = obj(v);
  for (const k of ['deu', 'DEU', 'ger', 'eng', 'ENG', 'mul']) if (o[k] !== undefined) return pickLang(o[k]);
  const first = Object.values(o)[0];
  return first === undefined ? null : pickLang(first);
};

export function tedQuery(s: FeedSettings, since: string) {
  const cpv = s.cpv_prefixes.map((c) =>
    c.length >= 8 ? `classification-cpv=${c}` : `classification-cpv=${c}*`,
  );
  const kw = s.keywords.map((k) => `notice-title~"${k.replace(/"/g, '')}"`);
  const what = [...cpv, ...kw].join(' OR ');
  return (
    `(${what}) AND buyer-country IN (DEU) AND notice-type IN (${TED_TYPES.join(', ')})` +
    ` AND publication-date>=${since.replace(/-/g, '')} SORT BY publication-date DESC`
  );
}

export function parseTedNotice(n: J): FeedNotice | null {
  const pub = txt(n['publication-number']);
  const title = pickLang(n['title-proc']) ?? pickLang(n['notice-title']);
  if (!pub || !title) return null;
  const dl = arr(n['deadline-receipt-tender-date-lot'])
    .map((x) => txt(x))
    .filter((x): x is string => !!x)
    .sort();
  const html = obj(obj(n.links).html);
  const pop = arr(n['place-of-performance'])
    .map((x) => txt(x))
    .find((x) => x && /^DE[0-9A-Z]+$/.test(x));
  return {
    source: 'ted',
    externalId: pub,
    title,
    description: pickLang(n['description-proc'])?.slice(0, 2000) ?? null,
    authority: pickLang(n['buyer-name']),
    place: pickLang(n['buyer-city']),
    postalCode: pickLang(n['buyer-post-code'])?.replace(/\s/g, '') ?? null,
    nuts: pop ?? null,
    deadline: dl[dl.length - 1] ?? null,
    published: txt(arr(n['publication-date'])[0])?.slice(0, 10) ?? null,
    cpv: [
      ...new Set(
        arr(n['classification-cpv'])
          .map((c) => txt(c)?.replace(/\D/g, '').slice(0, 8))
          .filter((c): c is string => !!c),
      ),
    ],
    url: txt(html.DEU) ?? txt(html.ENG) ?? `https://ted.europa.eu/de/notice/-/detail/${pub}`,
    docsUrl: null,
    procedure: null,
    valueCents: toCents(arr(n['estimated-value-proc'])[0]),
  };
}

export async function fetchTed(fetcher: Fetch, s: FeedSettings, since: string): Promise<FeedNotice[]> {
  const out: FeedNotice[] = [];
  let fields = [...TED_FIELDS, ...TED_EXTRA];
  for (let page = 1; page <= 10; page++) {
    const body = {
      query: tedQuery(s, since),
      fields,
      page,
      limit: 100,
      paginationMode: 'PAGE_NUMBER',
      scope: 'ACTIVE',
    };
    const r = await fetcher(TED, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 400 && fields.length > TED_FIELDS.length) {
      fields = [...TED_FIELDS];
      page--;
      continue;
    }
    if (!r.ok) throw new Error(`TED: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = obj(await r.json());
    const notices = arr(j.notices).map(obj);
    for (const n of notices) {
      const p = parseTedNotice(n);
      if (p) out.push(p);
    }
    if (notices.length < 100) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  return out;
}

// ---------------------------------------------------------------- Filter

const norm = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

/** Passt die Bekanntmachung zu unseren Leistungen? Liefert den Grund (CPV oder Stichwort). */
export function matchService(n: FeedNotice, s: FeedSettings): string | null {
  const c = n.cpv.find((code) => s.cpv_prefixes.some((p) => code.startsWith(p)));
  if (c) return `CPV ${c}`;
  const hay = norm(`${n.title} ${n.description ?? ''}`);
  const k = s.keywords.find((kw) => hay.includes(norm(kw)));
  return k ? `Stichwort „${k}“` : null;
}

export function feedHitId(source: string, externalId: string) {
  const h = createHash('md5').update(`tender-feed:${source}:${externalId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Ort → Koordinaten (Nominatim, zwischengespeichert; höchstens 1 Abfrage/Sekunde). */
export async function geocodePlace(
  sql: Sql,
  fetcher: Fetch,
  postalCode: string | null,
  place: string | null,
  budget: { left: number },
): Promise<{ lat: number; lng: number } | null> {
  const pc = postalCode && /^\d{5}$/.test(postalCode) ? postalCode : null;
  const city = place?.replace(/\s+/g, ' ').trim() || null;
  if (!pc && !city) return null;
  const key = `${pc ?? ''}|${(city ?? '').toLowerCase()}`;
  const [c] = await sql<{ lat: number | null; lng: number | null; found: boolean }[]>`
    select lat, lng, found from app.geo_cache where key = ${key}`;
  if (c) return c.found && c.lat !== null && c.lng !== null ? { lat: c.lat, lng: c.lng } : null;
  if (budget.left <= 0) return null;
  budget.left--;
  const q: Record<string, string> = { country: 'de', format: 'json', limit: '1' };
  if (pc) q.postalcode = pc;
  if (city) q.city = city;
  let hit: { lat: number; lng: number } | null = null;
  try {
    await new Promise((res) => setTimeout(res, 1100));
    const r = await fetcher(`https://nominatim.openstreetmap.org/search?${new URLSearchParams(q)}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null; // nicht zwischenspeichern – nächster Lauf versucht es erneut
    const j = (await r.json()) as { lat: string; lon: string }[];
    if (j[0]) hit = { lat: Number(j[0].lat), lng: Number(j[0].lon) };
  } catch {
    return null;
  }
  await sql`insert into app.geo_cache (key, lat, lng, found) values (${key}, ${hit?.lat ?? null}, ${hit?.lng ?? null}, ${!!hit})
            on conflict (key) do nothing`;
  return hit;
}

/** Liegt der Ort in einem der Umkreise? */
export function inRegion(
  pos: { lat: number; lng: number } | null,
  nuts: string | null,
  s: FeedSettings,
): { keep: boolean; region: string | null; km: number | null } {
  if (pos) {
    let best: { region: string; km: number } | null = null;
    for (const r of s.regions) {
      const km = distanceKm(pos, r);
      if (km <= r.km && (!best || km < best.km)) best = { region: r.name, km };
    }
    return best
      ? { keep: true, region: best.region, km: Math.round(best.km * 10) / 10 }
      : { keep: false, region: null, km: null };
  }
  if (!s.keep_unknown) return { keep: false, region: null, km: null };
  if (nuts && NUTS_NEAR.some((p) => nuts.startsWith(p)))
    return { keep: true, region: 'Ort prüfen', km: null };
  if (!nuts || nuts === 'DE') return { keep: true, region: 'Ort unbekannt', km: null };
  return { keep: false, region: null, km: null };
}

// ---------------------------------------------------------------- Lauf

/** Frist als Zeitpunkt: mit Uhrzeit direkt, nur Datum → 12:00 Berliner Zeit (Uhrzeit auf der Plattform prüfen). */
function deadlineSql(sql: Sql, d: string | null) {
  if (!d) return sql`null::timestamptz`;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?)?/.exec(d);
  if (!m) return sql`null::timestamptz`;
  if (!m[2]) return sql`(${`${m[1]} 12:00`}::timestamp at time zone 'Europe/Berlin')`;
  if (!m[3]) return sql`(${`${m[1]} ${m[2]}`}::timestamp at time zone 'Europe/Berlin')`;
  return sql`${`${m[1]}T${m[2]}${m[3]}`}::timestamptz`;
}

/** Bekanntmachungen filtern und speichern. Gibt die Zahl neuer Treffer zurück. */
export async function storeNotices(
  sql: Sql,
  fetcher: Fetch,
  notices: FeedNotice[],
  s: FeedSettings,
  today: string,
  budget = { left: 80 },
): Promise<number> {
  let added = 0;
  for (const n of notices) {
    const matched = matchService(n, s);
    if (!matched) continue;
    if (n.deadline && n.deadline.slice(0, 10) < today) continue;
    const pos = await geocodePlace(sql, fetcher, n.postalCode, n.place, budget);
    const reg = inRegion(pos, n.nuts, s);
    if (!reg.keep) continue;
    const id = feedHitId(n.source, n.externalId);
    const dl = deadlineSql(sql, n.deadline);
    // Gleiche Ausschreibung aus der anderen Quelle (Auftraggeber + Abgabetag bzw. Titel) → als doppelt markieren
    const [dup] = await sql<{ id: string }[]>`
      select id from app.tender_feed_hits
       where source <> ${n.source} and status <> 'doppelt'
         and (deadline_at at time zone 'Europe/Berlin')::date = (${dl} at time zone 'Europe/Berlin')::date
         and (left(regexp_replace(lower(coalesce(authority, '')), '[^a-z0-9äöüß]', '', 'g'), 20)
                = left(regexp_replace(lower(${n.authority ?? ''}), '[^a-z0-9äöüß]', '', 'g'), 20)
              or left(regexp_replace(lower(title), '[^a-z0-9äöüß]', '', 'g'), 30)
                = left(regexp_replace(lower(${n.title}), '[^a-z0-9äöüß]', '', 'g'), 30))
       limit 1`;
    const row = await sql<{ inserted: boolean }[]>`
      insert into app.tender_feed_hits
        (id, source, external_id, title, description, authority, place, postal_code, nuts, distance_km, region,
         deadline_at, published_on, cpv, url, docs_url, procedure, value_cents, matched, status)
      values (${id}, ${n.source}, ${n.externalId}, ${n.title.slice(0, 500)}, ${n.description}, ${n.authority},
              ${n.place}, ${n.postalCode}, ${n.nuts}, ${reg.km}, ${reg.region}, ${dl}, ${n.published}::date,
              ${n.cpv}, ${n.url}, ${n.docsUrl}, ${n.procedure}, ${n.valueCents}, ${matched},
              ${dup ? 'doppelt' : 'neu'})
      on conflict (source, external_id) do update
        set title = excluded.title, description = excluded.description, deadline_at = excluded.deadline_at,
            docs_url = coalesce(excluded.docs_url, app.tender_feed_hits.docs_url),
            value_cents = coalesce(excluded.value_cents, app.tender_feed_hits.value_cents)
        where app.tender_feed_hits.status = 'neu'
      returning (xmax = 0) as inserted`;
    if (row[0]?.inserted && !dup) added++;
  }
  return added;
}

export interface FeedResult {
  bundDays: number;
  notices: number;
  added: number;
  errors: string[];
}

/**
 * Abruf: Bund je Veröffentlichungstag (fehlende Tage bis gestern, beim ersten Lauf 14 Tage), TED einmal je Tag für die
 * letzten 7 Tage. Erfolgreiche Tage werden gemerkt und nicht erneut geholt; Fehler werden beim nächsten Lauf wiederholt.
 */
export async function runTenderFeed(
  sql: Sql,
  opts: { fetcher?: Fetch; now?: Date; force?: boolean } = {},
): Promise<FeedResult> {
  const fetcher = opts.fetcher ?? fetch;
  const s = await getFeedSettings(sql);
  const res: FeedResult = { bundDays: 0, notices: 0, added: 0, errors: [] };
  if (!s.enabled && !opts.force) return res;
  const today = todayBerlin(opts.now);
  const yesterday = addDays(today, -1);
  const done = new Set(
    (
      await sql<{ day: string }[]>`
        select day::text from app.tender_feed_runs where source = 'bund' and error is null
          and day >= ${addDays(today, -FIRST_DAYS)}::date`
    ).map((r) => r.day),
  );
  const budget = { left: 80 };
  for (let d = addDays(today, -FIRST_DAYS); d <= yesterday; d = addDays(d, 1)) {
    if (done.has(d)) continue;
    try {
      const list = await fetchBundDay(fetcher, d);
      if (list === null) continue; // Export noch nicht da
      const added = await storeNotices(sql, fetcher, list, s, today, budget);
      await sql`insert into app.tender_feed_runs (source, day, notices, hits, error)
                values ('bund', ${d}, ${list.length}, ${added}, null)
                on conflict (source, day) do update set fetched_at = now(), notices = excluded.notices,
                  hits = excluded.hits, error = null`;
      res.bundDays++;
      res.notices += list.length;
      res.added += added;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.errors.push(msg);
      await sql`insert into app.tender_feed_runs (source, day, error) values ('bund', ${d}, ${msg.slice(0, 500)})
                on conflict (source, day) do update set fetched_at = now(), error = excluded.error`;
    }
    await new Promise((r) => setTimeout(r, opts.fetcher ? 0 : 1500));
  }
  const [tedDone] =
    await sql`select 1 from app.tender_feed_runs where source = 'ted' and day = ${today} and error is null`;
  if (!tedDone || opts.force) {
    try {
      const list = await fetchTed(fetcher, s, addDays(today, -7));
      const added = await storeNotices(sql, fetcher, list, s, today, budget);
      await sql`insert into app.tender_feed_runs (source, day, notices, hits, error)
                values ('ted', ${today}, ${list.length}, ${added}, null)
                on conflict (source, day) do update set fetched_at = now(), notices = excluded.notices,
                  hits = app.tender_feed_runs.hits + excluded.hits, error = null`;
      res.notices += list.length;
      res.added += added;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.errors.push(msg);
      await sql`insert into app.tender_feed_runs (source, day, error) values ('ted', ${today}, ${msg.slice(0, 500)})
                on conflict (source, day) do update set fetched_at = now(), error = excluded.error`;
    }
  }
  return res;
}

// ---------------------------------------------------------------- Eingang

export interface FeedHit {
  id: string;
  source: 'bund' | 'ted';
  external_id: string;
  title: string;
  description: string | null;
  authority: string | null;
  place: string | null;
  postal_code: string | null;
  distance_km: string | null;
  region: string | null;
  deadline_at: Date | null;
  published_on: string | null;
  cpv: string[];
  url: string | null;
  docs_url: string | null;
  procedure: string | null;
  value_cents: bigint | null;
  matched: string | null;
  status: 'neu' | 'uebernommen' | 'verworfen' | 'doppelt';
  tender_id: string | null;
  decided_by: string | null;
  days_left: number | null;
  created_at: Date;
}

export async function listHits(sql: Sql, view: 'neu' | 'uebernommen' | 'verworfen' | 'alle') {
  return sql<FeedHit[]>`
    select h.*, published_on::text,
           ((deadline_at at time zone 'Europe/Berlin')::date - (now() at time zone 'Europe/Berlin')::date)::int as days_left
      from app.tender_feed_hits h
     where (${view} = 'alle' and status <> 'doppelt') or status = ${view}
     order by (status = 'neu' and deadline_at >= now()) desc, deadline_at nulls last, created_at desc
     limit 300`;
}

export async function hitCounts(sql: Sql) {
  const [c] = await sql<{ neu: number; uebernommen: number; verworfen: number }[]>`
    select count(*) filter (where status = 'neu' and (deadline_at is null or deadline_at >= now()))::int as neu,
           count(*) filter (where status = 'uebernommen')::int as uebernommen,
           count(*) filter (where status = 'verworfen')::int as verworfen
      from app.tender_feed_hits`;
  return c ?? { neu: 0, uebernommen: 0, verworfen: 0 };
}

export const PLATFORM_HOSTS: [RegExp, string][] = [
  [/dtvp\.de/i, 'DTVP'],
  [/vergabe\.bayern\.de|vergabeplattform\.bayern/i, 'Vergabe.bayern'],
  [/evergabe-online\.de/i, 'eVergabe-online'],
  [/subreport/i, 'Subreport'],
  [/vergabe\.muenchen\.de|muenchen\.de/i, 'Vergabemarktplatz München'],
  [/meinauftrag\.rib\.de|itwo|rib\.de/i, 'iTWO tender'],
  [/ted\.europa\.eu/i, 'TED'],
  [/oeffentlichevergabe\.de/i, 'service.bund.de'],
];
export const platformOf = (url: string | null) =>
  url ? (PLATFORM_HOSTS.find(([re]) => re.test(url))?.[1] ?? null) : null;

/** Treffer als Ausschreibung übernehmen (einmal; doppelt klicken liefert dieselbe Ausschreibung). */
export async function takeOverHit(sql: Sql, hitId: string, actor: string): Promise<string> {
  const [h] = await sql<(FeedHit & { local_deadline: string | null })[]>`
    select *, to_char(deadline_at at time zone 'Europe/Berlin', 'YYYY-MM-DD"T"HH24:MI') as local_deadline
      from app.tender_feed_hits where id = ${hitId}`;
  if (!h) throw new BusinessError('Treffer nicht gefunden');
  if (h.tender_id) return h.tender_id;
  const tenderId = feedHitId('tender', hitId);
  const notes = [
    `Gefunden über ${h.source === 'ted' ? 'TED (EU-Amtsblatt)' : 'Bekanntmachungsservice des Bundes'}${h.matched ? ` – ${h.matched}` : ''}.`,
    h.url ? `Bekanntmachung: ${h.url}` : null,
    h.cpv.length ? `CPV: ${h.cpv.join(', ')}` : null,
    h.source === 'ted' ? 'Uhrzeit der Abgabefrist auf der Plattform prüfen.' : null,
    h.description ? `\n${h.description}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  await saveTender(
    sql,
    tenderId,
    {
      title: h.title.slice(0, 300),
      authority: h.authority ?? 'unbekannt',
      customerId: null,
      referenceNo: null,
      platform: platformOf(h.docs_url) ?? platformOf(h.url),
      url: h.docs_url ?? h.url,
      procedure: h.procedure,
      location: [h.postal_code, h.place].filter(Boolean).join(' ') || null,
      services: h.matched,
      contractStart: null,
      contractTerm: null,
      estimatedCents: h.value_cents,
      deadline: h.local_deadline,
      questionsUntil: null,
      siteVisit: null,
      siteVisitRequired: false,
      bindingUntil: null,
      responsible: null,
      notes,
    },
    actor,
  );
  await sql`update app.tender_feed_hits set status = 'uebernommen', tender_id = ${tenderId}, decided_by = ${actor},
                   decided_at = now() where id = ${hitId}`;
  return tenderId;
}

export async function setHitsStatus(sql: Sql, ids: string[], status: 'neu' | 'verworfen', actor: string) {
  if (!ids.length) return 0;
  const r =
    await sql`update app.tender_feed_hits set status = ${status}, decided_by = ${actor}, decided_at = now()
                       where id in ${sql(ids)} and status in ('neu', 'verworfen') returning id`;
  return r.length;
}

export async function lastRuns(sql: Sql) {
  return sql<
    { source: string; day: string; fetched_at: Date; notices: number; hits: number; error: string | null }[]
  >`
    select source, day::text, fetched_at, notices, hits, error from app.tender_feed_runs
     order by fetched_at desc limit 10`;
}
