import type { Sql, Tx } from '../db/client.js';

/*
 * Konten in Supabase Auth. Lokal (reines Postgres + Shim) legen wir die Zeile in auth.users selbst an.
 * In Supabase gehören die Auth-Tabellen dem Auth-Dienst – dort über die Admin-API (Service-Key nur auf dem Server).
 * Feste ID (unsere Konto-ID) → wiederholter Aufruf legt nichts doppelt an.
 */

interface AuthAdmin {
  url: string;
  serviceKey: string;
  fetch?: typeof fetch;
}
let admin: AuthAdmin | null = null;

export function configureAuthAdmin(cfg: AuthAdmin | null) {
  admin = cfg;
}

/** Supabase verlangt E-Mail oder Telefon – ohne E-Mail eine technische, nie angeschriebene Adresse. */
const technicalEmail = (id: string) => `konto-${id}@konten.viva-deluxe-reinigung.de`;

export async function ensureAuthUser(sql: Sql | Tx, id: string, email: string | null): Promise<void> {
  if (!admin) {
    await sql`insert into auth.users (id, email) values (${id}, ${email}) on conflict (id) do nothing`;
    return;
  }
  const f = admin.fetch ?? fetch;
  const headers = {
    apikey: admin.serviceKey,
    Authorization: `Bearer ${admin.serviceKey}`,
    'Content-Type': 'application/json',
  };
  const base = admin.url.replace(/\/$/, '');
  const existing = await f(`${base}/auth/v1/admin/users/${id}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (existing.ok) return;
  const res = await f(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(10_000),
    // Anmeldung läuft (noch) über unseren Server; das Auth-Konto trägt Rolle/RLS (auth.uid()).
    body: JSON.stringify({
      id,
      email: email ?? technicalEmail(id),
      email_confirm: true,
      user_metadata: { source: 'viva-app' },
    }),
  });
  if (!res.ok) {
    // gleichzeitig angelegt? Dann gibt es das Konto jetzt.
    const again = await f(`${base}/auth/v1/admin/users/${id}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (again.ok) return;
    throw new Error(
      `Supabase-Konto konnte nicht angelegt werden (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
}
