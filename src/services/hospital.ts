/**
 * Nächstes Krankenhaus mit Notaufnahme zum Objekt (Ahmed 14.10.: „soll nach PLZ selber ermittelt werden“).
 * Quelle OpenStreetMap: Standort des Objekts (Koordinaten aus „QR-Aushang & Standort“, sonst Adresse bzw. PLZ über
 * Nominatim), dann Krankenhäuser im Umkreis von 30 km über Overpass. Bevorzugt mit Notaufnahme (emergency=yes), sonst
 * das nächste Krankenhaus. Ergebnis wird in sites.folder_info.krankenhaus gespeichert und ist änderbar.
 * Ohne Internet/Antwort: null – dann bleibt das Feld leer (keine Pflichtangabe).
 */
import type { Sql } from '../db/client.js';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'Viva-Deluxe-App/1.0 (info@viva-deluxe-reinigung.de)';
const TIMEOUT = 8_000;

export interface Hospital {
  name: string;
  address: string;
  km: number;
  emergency: boolean;
}

interface OsmElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const rad = (d: number) => (d * Math.PI) / 180;
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Aus der Overpass-Antwort das passende Krankenhaus wählen (Notaufnahme vor Entfernung, ohne Tageskliniken). */
export function pickHospital(origin: { lat: number; lng: number }, elements: OsmElement[]): Hospital | null {
  const list = elements
    .map((e) => {
      const lat = e.lat ?? e.center?.lat;
      const lng = e.lon ?? e.center?.lon;
      const t = e.tags ?? {};
      if (lat === undefined || lng === undefined || !t.name) return null;
      if (/tagesklinik|tagklinik|reha|psychiatr|hospiz/i.test(t.name)) return null;
      const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
      const town = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
      return {
        name: t.name,
        address: [street, town].filter(Boolean).join(', '),
        km: Math.round(distanceKm(origin, { lat, lng }) * 10) / 10,
        emergency: t.emergency === 'yes',
      };
    })
    .filter((h): h is Hospital => h !== null)
    .sort((a, b) => a.km - b.km);
  // Notaufnahme bevorzugt, solange sie nicht deutlich weiter weg ist als das nächste Haus
  const em = list.find((h) => h.emergency);
  if (em && (!list[0] || em.km <= list[0].km + 10)) return em;
  return list[0] ?? null;
}

export const hospitalText = (h: Hospital) =>
  `${h.name}${h.address ? `, ${h.address}` : ''} (ca. ${String(h.km).replace('.', ',')} km${h.emergency ? ', Notaufnahme' : ''})`;

async function getJson(fetcher: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetcher(url, {
      ...init,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, ...init?.headers },
    });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Koordinaten zur Adresse (bzw. nur PLZ), Deutschland. */
export async function geocode(
  fetcher: Fetch,
  a: { street: string | null; postal_code: string | null; city: string | null },
): Promise<{ lat: number; lng: number } | null> {
  const tries: Record<string, string>[] = [];
  if (a.street && (a.postal_code || a.city))
    tries.push({ street: a.street, postalcode: a.postal_code ?? '', city: a.city ?? '' });
  if (a.postal_code) tries.push({ postalcode: a.postal_code });
  for (const q of tries) {
    const p = new URLSearchParams({ ...q, country: 'de', format: 'json', limit: '1' });
    const j = (await getJson(fetcher, `https://nominatim.openstreetmap.org/search?${p}`)) as
      { lat: string; lon: string }[] | null;
    if (j?.[0]) return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
  }
  return null;
}

export async function nearestHospital(
  fetcher: Fetch,
  origin: { lat: number; lng: number },
): Promise<Hospital | null> {
  const q = `[out:json][timeout:20];nwr["amenity"="hospital"](around:30000,${origin.lat},${origin.lng});out center tags 80;`;
  const j = (await getJson(fetcher, 'https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: q }),
  })) as { elements?: OsmElement[] } | null;
  return j?.elements ? pickHospital(origin, j.elements) : null;
}

/**
 * Krankenhaus fürs Objekt ermitteln und speichern (überschreibt nur, wenn `force` oder das Feld leer ist).
 * Gibt den Text zurück oder null (nicht gefunden / keine Verbindung).
 */
export async function fillHospital(
  sql: Sql,
  siteId: string,
  actor: string,
  opts: { force?: boolean; fetcher?: Fetch } = {},
): Promise<string | null> {
  const fetcher = opts.fetcher ?? fetch;
  const [s] = await sql<
    {
      street: string | null;
      postal_code: string | null;
      city: string | null;
      geo_lat: number | null;
      geo_lng: number | null;
      current: string | null;
    }[]
  >`select street, postal_code, city, geo_lat::float8 as geo_lat, geo_lng::float8 as geo_lng,
           folder_info ->> 'krankenhaus' as current
      from app.sites where id = ${siteId}`;
  if (!s) return null;
  if (s.current && !opts.force) return s.current;
  try {
    const origin =
      s.geo_lat !== null && s.geo_lng !== null
        ? { lat: s.geo_lat, lng: s.geo_lng }
        : await geocode(fetcher, s);
    if (!origin) return null;
    const h = await nearestHospital(fetcher, origin);
    if (!h) return null;
    const text = hospitalText(h);
    await sql`update app.sites
                 set folder_info = coalesce(folder_info, '{}'::jsonb) || jsonb_build_object('krankenhaus', ${text}::text)
               where id = ${siteId}`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'krankenhaus_ermittelt', 'site', ${siteId}, ${sql.json({ krankenhaus: text })})`;
    return text;
  } catch {
    return null;
  }
}
