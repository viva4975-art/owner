import type { Sql } from '../db/client.js';
import { judgePosition } from '../domain/time/geo.js';
import { BusinessError } from './errors.js';
import { plainPhoto, uuidFrom } from './photo-stamp.js';
import { type UploadConfig, storeFile } from './uploads.js';

/*
 * Geräte mit QR-Code verfolgen, Stufe 1 (Ahmed 19.10.): Jedes Gerät (Scheuersaugmaschine, Staubsauger, Wischwagen …)
 * hat ein QR-Etikett. Wer es in der App scannt, meldet „Gerät ist hier“, „mitgenommen zu Objekt …“, „zurück ins Lager“
 * oder „defekt“ (mit Foto). Der Standort des Handys wird nur in diesem Moment mitgeschickt – kein laufendes Tracking.
 * Jeder Vorgang ist ein Eintrag in app.device_events (nur anhängen, feste ID je Formular → doppelt absenden zählt einmal).
 */

export const DEVICE_KINDS = {
  scheuersaugmaschine: 'Scheuersaugmaschine',
  staubsauger: 'Staubsauger',
  nasssauger: 'Nasssauger',
  wischwagen: 'Wischwagen',
  reinigungswagen: 'Reinigungswagen',
  einscheibenmaschine: 'Einscheibenmaschine',
  hochdruckreiniger: 'Hochdruckreiniger',
  leiter: 'Leiter',
  sonstiges: 'Sonstiges',
} as const;
export type DeviceKind = keyof typeof DEVICE_KINDS;
export const kindLabel = (k: string) => DEVICE_KINDS[k as DeviceKind] ?? 'Gerät';

export const DEVICE_STATUS = { ok: 'einsatzbereit', defekt: 'defekt', reparatur: 'in Reparatur' } as const;

/** Aktionen beim Scannen (App) */
export const SCAN_ACTIONS = ['hier', 'mitgenommen', 'lager', 'defekt'] as const;
export type ScanAction = (typeof SCAN_ACTIONS)[number];
/** Einträge vom Büro */
export const SERVICE_ACTIONS = ['pruefung', 'reparatur', 'repariert', 'notiz'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export const ACTION_LABEL: Record<string, string> = {
  hier: 'Gerät ist hier',
  mitgenommen: 'mitgenommen',
  lager: 'zurück ins Lager',
  defekt: 'defekt gemeldet',
  pruefung: 'Prüfung durchgeführt',
  reparatur: 'in Reparatur gegeben',
  repariert: 'repariert / einsatzbereit',
  notiz: 'Notiz',
};

/** Ab so vielen Tagen ohne Scan steht ein Gerät in „Lange nicht gescannt“. */
export const STALE_DAYS = 60;

export interface ScanDevice {
  id: string;
  inventory_no: string;
  name: string;
  kind: string;
  status: string;
  manufacturer: string | null;
  site_id: string | null;
  site_name: string | null;
  site_no: string | null;
  active: boolean;
  qr_token: string;
}

export async function deviceByToken(sql: Sql, token: string): Promise<ScanDevice | undefined> {
  const [d] = await sql<ScanDevice[]>`
    select d.id, d.inventory_no, d.name, d.kind, d.status, d.manufacturer, d.site_id, s.name as site_name, s.site_no,
           d.active, d.qr_token
      from app.devices d left join app.sites s on s.id = d.site_id
     where d.qr_token = ${token}`;
  return d;
}

export interface DeviceEvent {
  id: string;
  action: string;
  site_id: string | null;
  site_name: string | null;
  site_no: string | null;
  event_date: string;
  note: string | null;
  photo_file_id: string | null;
  geo: string | null;
  geo_m: number | null;
  geo_acc_m: number | null;
  lat: string | null;
  lng: string | null;
  by_name: string;
  created_at: Date;
}

export async function deviceEvents(sql: Sql, deviceId: string, limit = 200): Promise<DeviceEvent[]> {
  return sql<DeviceEvent[]>`
    select e.id, e.action, e.site_id, s.name as site_name, s.site_no, e.event_date::text as event_date, e.note,
           e.photo_file_id, e.geo, e.geo_m, e.geo_acc_m, e.lat::text as lat, e.lng::text as lng, e.by_name, e.created_at
      from app.device_events e left join app.sites s on s.id = e.site_id
     where e.device_id = ${deviceId}
     order by e.created_at desc limit ${limit}`;
}

type Pos = { lat: number; lng: number; acc: number } | null;

/** Koordinaten aus dem Formular (versteckte Felder geo_lat/geo_lng/geo_acc). */
export function posFromForm(b: Record<string, unknown>): Pos {
  const num = (k: string) => {
    const s = typeof b[k] === 'string' ? (b[k] as string) : '';
    const v = Number(s);
    return s && Number.isFinite(v) ? v : null;
  };
  const [lat, lng, acc] = [num('geo_lat'), num('geo_lng'), num('geo_acc')];
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { lat, lng, acc: acc ?? 9999 }
    : null;
}

async function firstAdmin(sql: Sql): Promise<string | null> {
  const [a] = await sql<{ name: string }[]>`
    select coalesce(nullif(p.display_name, ''), a.login) as name
      from app.user_accounts a join app.profiles p on p.user_id = a.id
     where a.active and p.role = 'admin' order by a.created_at limit 1`;
  return a?.name ?? null;
}

export const defectTaskId = (eventId: string) => uuidFrom(`${eventId}:geraet-defekt`);

/**
 * Scan aus der App festhalten. Setzt den Standort des Geräts (hier/mitgenommen → Objekt, Lager → ohne Objekt), bei
 * „defekt“ den Status und legt eine Aufgabe fürs Büro an. Gibt false zurück, wenn das Formular schon verarbeitet ist.
 */
export async function recordDeviceScan(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    id: string;
    deviceId: string;
    action: string;
    siteId: string | null;
    note: string | null;
    pos: Pos;
    photo?: { data: Uint8Array; name: string; type: string } | null;
    by: string;
    employeeId?: string | null;
    actor: string;
  },
): Promise<boolean> {
  if (!(SCAN_ACTIONS as readonly string[]).includes(p.action))
    throw new BusinessError('Bitte eine Aktion wählen');
  const action = p.action as ScanAction;
  const [done] = await sql`select 1 from app.device_events where id = ${p.id}`;
  if (done) return false;
  const [dev] = await sql<{ id: string; name: string; inventory_no: string; site_id: string | null }[]>`
    select id, name, inventory_no, site_id from app.devices where id = ${p.deviceId}`;
  if (!dev) throw new BusinessError('Gerät nicht gefunden');
  const note = p.note?.trim().slice(0, 1000) || null;
  let siteId = action === 'lager' ? null : p.siteId;
  if ((action === 'hier' || action === 'mitgenommen') && !siteId)
    throw new BusinessError('Bitte das Objekt wählen, an dem das Gerät jetzt ist');
  if (action === 'defekt' && !note) throw new BusinessError('Bitte kurz beschreiben, was kaputt ist');
  if (action === 'defekt' && !siteId) siteId = dev.site_id;
  const [site] = siteId
    ? await sql<{ lat: string | null; lng: string | null; radius: number; name: string; site_no: string }[]>`
        select geo_lat::text as lat, geo_lng::text as lng, geo_radius_m as radius, name, site_no
          from app.sites where id = ${siteId}`
    : [];
  if (siteId && !site) throw new BusinessError('Objekt nicht gefunden');
  const judged = site
    ? judgePosition(
        {
          lat: site.lat != null ? Number(site.lat) : null,
          lng: site.lng != null ? Number(site.lng) : null,
          radius: site.radius,
        },
        p.pos,
      )
    : { status: null, distance: null, accuracy: p.pos ? Math.round(p.pos.acc) : null };

  let photoId: string | null = null;
  if (p.photo && p.photo.data.length) {
    photoId = uuidFrom(`${p.id}:foto`);
    let data: Uint8Array;
    try {
      data = await plainPhoto(p.photo.data);
    } catch {
      throw new BusinessError('Foto konnte nicht gelesen werden – bitte erneut aufnehmen');
    }
    await storeFile(
      sql,
      cfg,
      {
        id: photoId,
        name: `geraet_${dev.inventory_no}_defekt.jpg`,
        type: 'image/jpeg',
        data,
        link: null,
        category: null,
      },
      p.actor,
    );
  }

  const admin = action === 'defekt' ? await firstAdmin(sql) : null;
  return sql.begin(async (tx) => {
    const ins = await tx`
      insert into app.device_events (id, device_id, action, site_id, note, photo_file_id, geo, geo_m, geo_acc_m, lat, lng,
                                     by_name, employee_id, created_by)
      values (${p.id}, ${dev.id}, ${action}, ${siteId}, ${note}, ${photoId}, ${judged.status}, ${judged.distance},
              ${judged.accuracy}, ${p.pos ? p.pos.lat.toFixed(5) : null}, ${p.pos ? p.pos.lng.toFixed(5) : null},
              ${p.by}, ${p.employeeId ?? null}, ${p.actor})
      on conflict (id) do nothing`;
    if (!ins.count) return false;
    if (action === 'defekt')
      await tx`update app.devices set status = 'defekt', site_id = ${siteId}, updated_at = now() where id = ${dev.id}`;
    else if (siteId !== dev.site_id)
      await tx`update app.devices set site_id = ${siteId}, updated_at = now() where id = ${dev.id}`;
    if (action === 'defekt') {
      const where = site ? ` · ${site.site_no} ${site.name}` : '';
      await tx`
        insert into app.tasks (id, title, description, due_date, assignee, entity_type, entity_id, created_by)
        values (${defectTaskId(p.id)}, ${`Gerät defekt: ${dev.name} (${dev.inventory_no})`.slice(0, 300)},
                ${`${note}${where} – gemeldet von ${p.by}`.slice(0, 2000)},
                (now() at time zone 'Europe/Berlin')::date, ${admin}, 'device', ${dev.id}, ${p.actor})
        on conflict (id) do nothing`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, ${`scan_${action}`}, 'devices', ${dev.id},
                     ${tx.json({ site_id: siteId, geo: judged.status, geo_m: judged.distance })})`;
    return true;
  });
}

/** Prüfung, Reparatur, „repariert“ oder Notiz vom Büro. „repariert“ setzt das Gerät wieder einsatzbereit. */
export async function recordDeviceService(
  sql: Sql,
  p: {
    id: string;
    deviceId: string;
    action: string;
    date: string | null;
    note: string | null;
    nextInspection: string | null;
    by: string;
    actor: string;
  },
): Promise<boolean> {
  if (!(SERVICE_ACTIONS as readonly string[]).includes(p.action))
    throw new BusinessError('Bitte eine Art wählen');
  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null;
  const next = p.nextInspection && /^\d{4}-\d{2}-\d{2}$/.test(p.nextInspection) ? p.nextInspection : null;
  const note = p.note?.trim().slice(0, 1000) || null;
  if (p.action === 'notiz' && !note) throw new BusinessError('Bitte eine Notiz eingeben');
  return sql.begin(async (tx) => {
    const [dev] = await tx<{ site_id: string | null }[]>`
      select site_id from app.devices where id = ${p.deviceId} for update`;
    if (!dev) throw new BusinessError('Gerät nicht gefunden');
    const ins = await tx`
      insert into app.device_events (id, device_id, action, site_id, event_date, note, by_name, created_by)
      values (${p.id}, ${p.deviceId}, ${p.action}, ${dev.site_id},
              coalesce(${date}::date, (now() at time zone 'Europe/Berlin')::date), ${note}, ${p.by}, ${p.actor})
      on conflict (id) do nothing`;
    if (!ins.count) return false;
    if (p.action === 'repariert') {
      await tx`update app.devices set status = 'ok', updated_at = now() where id = ${p.deviceId}`;
      await tx`update app.tasks set status = 'done', done_at = now(), done_by = ${p.actor}
                where entity_type = 'device' and entity_id = ${p.deviceId} and status = 'open'`;
    }
    if (p.action === 'reparatur')
      await tx`update app.devices set status = 'reparatur', updated_at = now() where id = ${p.deviceId}`;
    if (p.action === 'pruefung' && next)
      await tx`update app.devices set next_inspection = ${next}, updated_at = now() where id = ${p.deviceId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, ${`geraet_${p.action}`}, 'devices', ${p.deviceId}, ${tx.json({ date, next })})`;
    return true;
  });
}
