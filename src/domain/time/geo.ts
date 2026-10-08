/** Entfernung zweier Punkte auf der Erde in Metern (Haversine, Erdradius 6.371 km). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1);
  const dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a))));
}

export type GeoStatus = 'am_objekt' | 'entfernt' | 'ungenau' | 'kein_standort' | 'objekt_ohne_standort';

export const GEO_LABEL: Record<GeoStatus, string> = {
  am_objekt: 'am Objekt',
  entfernt: 'nicht am Objekt',
  ungenau: 'Standort ungenau',
  kein_standort: 'kein Standort',
  objekt_ohne_standort: 'Objekt ohne Standort',
};

/**
 * Bewertung einer Stempel-Position: am Objekt, wenn Entfernung − Genauigkeit ≤ Radius (zugunsten der Mitarbeitenden).
 * Genauigkeit schlechter als 1 km → „ungenau“ (z. B. nur Mobilfunkzelle).
 */
export function judgePosition(
  site: { lat: number | null; lng: number | null; radius: number },
  pos: { lat: number; lng: number; acc: number } | null,
): { status: GeoStatus; distance: number | null; accuracy: number | null } {
  if (site.lat == null || site.lng == null)
    return { status: 'objekt_ohne_standort', distance: null, accuracy: pos ? Math.round(pos.acc) : null };
  if (!pos) return { status: 'kein_standort', distance: null, accuracy: null };
  const d = distanceMeters(site.lat, site.lng, pos.lat, pos.lng);
  const acc = Math.round(pos.acc);
  if (acc > 1000) return { status: 'ungenau', distance: d, accuracy: acc };
  return { status: d - acc <= site.radius ? 'am_objekt' : 'entfernt', distance: d, accuracy: acc };
}

/** Koordinaten aus einem Google-Maps-Link oder „48.137, 11.575“ lesen. */
export function parseCoordinates(s: string): { lat: number; lng: number } | null {
  const t = s.trim();
  const m =
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(t) ??
    /[?&](?:q|query|ll)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(t) ??
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(t) ??
    /^(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)$/.exec(t);
  if (!m) return null;
  const lat = Number(m[1]!.replace(',', '.'));
  const lng = Number(m[2]!.replace(',', '.'));
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
  return { lat, lng };
}
