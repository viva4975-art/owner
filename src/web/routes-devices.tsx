/**
 * Geräte mit QR-Etikett verfolgen (Stufe 1, Ahmed 19.10.): Liste mit „zuletzt gesehen“, Gerät im Detail mit Standort
 * und Verlauf, Prüfungen/Reparaturen, Etiketten drucken, Scan-Seite fürs Büro und die Weiche /g/<code> für das Etikett.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { todayBerlin } from '../domain/invoice/calc.js';
import { GEO_LABEL, type GeoStatus } from '../domain/time/geo.js';
import {
  ACTION_LABEL,
  DEVICE_KINDS,
  DEVICE_STATUS,
  SERVICE_ACTIONS,
  STALE_DAYS,
  deviceByToken,
  deviceEvents,
  kindLabel,
  posFromForm,
  recordDeviceScan,
  recordDeviceService,
} from '../services/device-tracking.js';
import { verifySession } from '../services/employee-auth.js';
import { BusinessError } from '../services/errors.js';
import {
  type DeviceListRow,
  getDevice,
  listDevices,
  markLabelsPrinted,
  needsInspection,
} from '../services/inventory.js';
import { listSites } from '../services/masterdata.js';
import { type FileRow, filePath } from '../services/uploads.js';
import { fullName, getUser } from '../services/users.js';
import { type AppEnv, type Ctx, OFFICE_COOKIE, UUID, assertSite, inScope, officeSecret } from './app.js';
import { DeviceScanForm, type ScanSite, lastSeenText } from './device-scan.js';
import { Icon } from './icons.js';
import { PageHead, anz, dateDe } from './layout.js';

const TOKEN = '[0-9a-f]{32}';

const when = (d: Date) =>
  d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const geoText = (geo: string | null, m: number | null) =>
  geo
    ? `${GEO_LABEL[geo as GeoStatus] ?? geo}${m != null && geo !== 'am_objekt' ? ` (${m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`})` : ''}`
    : null;

const mapsLink = (lat: string, lng: string) =>
  `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

const isStale = (d: DeviceListRow) => d.active && (d.seen_days == null || d.seen_days > STALE_DAYS);

/** Etiketten-Reihenfolge: Objektleitung (ohne zuletzt) → Objekt → Gerät, Lager ganz am Ende – Seiten werden lückenlos gefüllt */
const labelOrder = (a: DeviceListRow, b: DeviceListRow) =>
  (a.site_id ? 0 : 1) - (b.site_id ? 0 : 1) ||
  (a.manager_name ? 0 : 1) - (b.manager_name ? 0 : 1) ||
  (a.manager_name ?? '').localeCompare(b.manager_name ?? '', 'de') ||
  (a.site_no ?? '').localeCompare(b.site_no ?? '', 'de') ||
  a.name.localeCompare(b.name, 'de');
/** Filter Objekt / Objektleitung / nur noch nicht gedruckte (gleich in Liste und Etikettendruck) */
const matchPlace = (d: DeviceListRow, objekt: string, ol: string) =>
  (!objekt || (objekt === 'lager' ? !d.site_id : d.site_id === objekt)) &&
  (!ol || (ol === 'ohne' ? !!d.site_id && !d.manager_user_id : d.manager_user_id === ol));

export function registerDeviceRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const cfg = { dir: env.FILES_DIR, maxBytes: env.UPLOAD_MAX_BYTES };
  const qrUrl = (c: Context<AppEnv>, token: string) =>
    `${env.PUBLIC_URL ?? new URL(c.req.url).origin}/g/${token}`;

  // Etikett gescannt (Handy-Kamera): Büro-Anmeldung → Büro-Scan, sonst Mitarbeiter-App (meldet bei Bedarf an)
  app.get(`/g/:token{${TOKEN}}`, async (c) => {
    const token = c.req.param('token');
    const uid = verifySession(officeSecret(env), getCookie(c, OFFICE_COOKIE));
    const u = uid ? await getUser(sql, uid) : undefined;
    return c.redirect(u?.active ? `/geraete/scan/${token}` : `/m/g/${token}`, 303);
  });

  // ------------------------------------------------------------------ Liste

  app.get('/geraete', async (c) => {
    const all = inScope(c, await listDevices(sql));
    const f = c.req.query('f') ?? '';
    const art = c.req.query('art') ?? '';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const objekt = c.req.query('objekt') ?? '';
    const ol = c.req.query('ol') ?? '';
    const active = all.filter((d) => d.active);
    const counts = {
      lange: active.filter(isStale).length,
      defekt: active.filter((d) => d.status !== 'ok').length,
      pruefung: active.filter((d) => d.days !== null && d.days <= 30).length,
      neu: active.filter((d) => !d.label_printed_at).length,
    };
    const rows = all.filter(
      (d) =>
        (f === 'lange'
          ? isStale(d)
          : f === 'defekt'
            ? d.active && d.status !== 'ok'
            : f === 'pruefung'
              ? d.active && d.days !== null && d.days <= 30
              : f === 'inaktiv'
                ? !d.active
                : d.active) &&
        (!art || d.kind === art) &&
        matchPlace(d, objekt, ol) &&
        (!q ||
          `${d.inventory_no} ${d.name} ${d.manufacturer ?? ''} ${d.serial_no ?? ''} ${d.site_name ?? ''}`
            .toLowerCase()
            .includes(q)),
    );
    // Objekte mit Geräten (für Filter und Gruppierung je Objekt)
    const siteMap = new Map<string, { id: string; site_no: string; name: string; n: number }>();
    for (const d of active)
      if (d.site_id) {
        const e = siteMap.get(d.site_id) ?? {
          id: d.site_id,
          site_no: d.site_no ?? '',
          name: d.site_name ?? '',
          n: 0,
        };
        e.n++;
        siteMap.set(d.site_id, e);
      }
    const olMap = new Map<string, { id: string; name: string; n: number }>();
    for (const d of active)
      if (d.manager_user_id) {
        const e = olMap.get(d.manager_user_id) ?? {
          id: d.manager_user_id,
          name: d.manager_name ?? '–',
          n: 0,
        };
        e.n++;
        olMap.set(d.manager_user_id, e);
      }
    const olChoices = [...olMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const siteChoices = [...siteMap.values()].sort((a, b) => a.site_no.localeCompare(b.site_no, 'de'));
    const groups = new Map<string, DeviceListRow[]>();
    for (const d of rows) {
      const k = d.site_id ?? '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(d);
    }
    const groupList = [...groups.entries()].sort((a, b) => labelOrder(a[1][0]!, b[1][0]!));
    const href = (p: Record<string, string>) => {
      const u = new URLSearchParams({
        ...(f ? { f } : {}),
        ...(art ? { art } : {}),
        ...(q ? { q } : {}),
        ...(objekt ? { objekt } : {}),
        ...(ol ? { ol } : {}),
        ...p,
      });
      for (const [k, v] of [...u]) if (!v) u.delete(k);
      const s = u.toString();
      return `/geraete${s ? `?${s}` : ''}`;
    };
    return page(
      c,
      'Geräte',
      'inventar',
      <>
        <PageHead title="Geräte">
          <a class="btn" href={`/geraete/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            <Icon name="plus" /> Gerät anlegen
          </a>
        </PageHead>
        <p class="mut" style="margin-top:-6px">
          Jedes Gerät bekommt ein QR-Etikett. Wer es mit dem Handy scannt, meldet den Standort („ist hier“,
          „mitgenommen“, „zurück ins Lager“) oder einen Defekt mit Foto.
        </p>
        <form
          method="get"
          action="/geraete"
          style="margin:0 0 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"
        >
          <div class="chips" style="margin:0">
            <a href={href({ f: '' })} class={!f ? 'on' : ''}>
              Aktiv ({active.length})
            </a>
            <a href={href({ f: 'lange' })} class={f === 'lange' ? 'on' : ''}>
              Lange nicht gescannt ({counts.lange})
            </a>
            <a href={href({ f: 'ungedruckt' })} class={f === 'ungedruckt' ? 'on' : ''}>
              Etikett noch nicht gedruckt ({counts.neu})
            </a>
            <a href={href({ f: 'defekt' })} class={f === 'defekt' ? 'on' : ''}>
              Defekt / Reparatur ({counts.defekt})
            </a>
            <a href={href({ f: 'pruefung' })} class={f === 'pruefung' ? 'on' : ''}>
              Prüfung fällig ({counts.pruefung})
            </a>
            <a href={href({ f: 'inaktiv' })} class={f === 'inaktiv' ? 'on' : ''}>
              Inaktiv
            </a>
          </div>
          {f && <input type="hidden" name="f" value={f} />}
          <select
            name="art"
            aria-label="Art"
            onchange="this.form.submit()"
            style="width:auto;min-width:180px"
          >
            <option value="">alle Arten</option>
            {Object.entries(DEVICE_KINDS).map(([k, v]) => (
              <option value={k} selected={k === art}>
                {v}
              </option>
            ))}
          </select>
          <select
            name="ol"
            aria-label="Objektleitung"
            onchange="this.form.submit()"
            style="width:auto;min-width:200px"
          >
            <option value="">alle Objektleitungen</option>
            {olChoices.map((m) => (
              <option value={m.id} selected={m.id === ol}>
                {m.name} ({m.n})
              </option>
            ))}
            <option value="ohne" selected={ol === 'ohne'}>
              ohne Objektleitung
            </option>
          </select>
          <select
            name="objekt"
            aria-label="Objekt"
            onchange="this.form.submit()"
            style="width:auto;min-width:220px"
          >
            <option value="">alle Objekte</option>
            <option value="lager" selected={objekt === 'lager'}>
              Lager / Büro
            </option>
            {siteChoices.map((st) => (
              <option value={st.id} selected={st.id === objekt}>
                {st.site_no} · {st.name} ({st.n})
              </option>
            ))}
          </select>
          <input
            name="q"
            value={q}
            aria-label="Suche"
            placeholder="Nr., Gerät, Objekt …"
            style="width:auto;flex:1;min-width:180px"
          />
          <button class="btn sec">Suchen</button>
        </form>
        {f === 'lange' && (
          <div class="warnbox">
            Seit mehr als {STALE_DAYS} Tagen (oder noch nie) gescannt. Etikett vorhanden? Beim nächsten Besuch
            scannen lassen – sonst ist unklar, wo das Gerät steht.
          </div>
        )}
        <form method="get" action="/geraete/etiketten" target="_blank" id="g-sel">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th style="width:28px">
                    <input
                      type="checkbox"
                      aria-label="alle markieren"
                      onchange="this.closest('table').querySelectorAll('input[name=id]').forEach(function(x){x.checked=this.checked}.bind(this))"
                    />
                  </th>
                  <th>Nr.</th>
                  <th>Gerät</th>
                  <th>Zuletzt gescannt</th>
                  <th>Nächste Prüfung</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colspan={5}>
                      <div class="empty">Keine Geräte in dieser Auswahl.</div>
                    </td>
                  </tr>
                )}
                {groupList.map(([sid, list], gi) => (
                  <>
                    {sid &&
                      (gi === 0 ||
                        groupList[gi - 1]![1][0]!.manager_user_id !== list[0]!.manager_user_id ||
                        !groupList[gi - 1]![0]) && (
                        <tr class="grp-row">
                          <td colspan={5} style="padding:12px 10px 6px;border-bottom:0">
                            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                              <span class="small mut" style="text-transform:uppercase;letter-spacing:.05em">
                                Objektleitung
                              </span>
                              <b style="font-size:15px">{list[0]!.manager_name ?? 'ohne Objektleitung'}</b>
                              <a
                                class="btn sm"
                                style="margin-left:auto"
                                target="_blank"
                                href={`/geraete/etiketten?ol=${list[0]!.manager_user_id ?? 'ohne'}${f === 'ungedruckt' ? '&nur=neu' : ''}`}
                              >
                                Etiketten für alle Objekte dieser Objektleitung
                              </a>
                            </div>
                          </td>
                        </tr>
                      )}
                    <tr class="grp-row">
                      <td colspan={5} style="background:var(--tint-2,#f8eff2);padding:8px 10px">
                        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                          <b>
                            {sid ? (
                              <a href={`/objekte/${sid}`}>
                                {list[0]!.site_no} · {list[0]!.site_name}
                              </a>
                            ) : (
                              'Lager / Büro'
                            )}
                          </b>
                          <span class="small mut">{anz(list.length, 'Gerät', 'Geräte')}</span>
                          <a
                            class="btn sm sec"
                            style="margin-left:auto"
                            target="_blank"
                            href={`/geraete/etiketten?objekt=${sid || 'lager'}${f === 'ungedruckt' ? '&nur=neu' : ''}`}
                          >
                            Etiketten für dieses Objekt
                          </a>
                        </div>
                      </td>
                    </tr>
                    {list.map((d) => (
                      <tr style={d.active ? '' : 'opacity:.55'}>
                        <td>
                          <input type="checkbox" name="id" value={d.id} aria-label={`${d.name} markieren`} />
                        </td>
                        <td>
                          {d.inventory_no}
                          <div
                            class="small"
                            style={d.label_printed_at ? 'color:var(--mut)' : 'color:var(--err)'}
                          >
                            {d.label_printed_at
                              ? `Etikett ${dateDe(todayBerlin(d.label_printed_at))}`
                              : 'Etikett fehlt'}
                          </div>
                        </td>
                        <td>
                          <a href={`/geraete/${d.id}`}>
                            <b>{d.name}</b>
                          </a>
                          <div class="small mut">
                            {kindLabel(d.kind)}
                            {d.manufacturer ? ` · ${d.manufacturer}` : ''}
                          </div>
                          {d.status !== 'ok' && (
                            <span class="badge err">
                              {DEVICE_STATUS[d.status as keyof typeof DEVICE_STATUS]}
                            </span>
                          )}
                        </td>
                        <td class="small">
                          {d.seen_at ? (
                            <span style={isStale(d) ? 'color:var(--err)' : ''}>
                              {dateDe(todayBerlin(d.seen_at))} · {d.seen_by}
                              {d.seen_lat && d.seen_lng && (
                                <>
                                  {' '}
                                  ·{' '}
                                  <a
                                    href={mapsLink(d.seen_lat, d.seen_lng)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Karte
                                  </a>
                                </>
                              )}
                            </span>
                          ) : (
                            <span style={d.active ? 'color:var(--err)' : ''}>noch nie</span>
                          )}
                        </td>
                        <td>
                          {d.next_inspection ? (
                            <span class={`badge ${d.days! < 0 ? 'err' : d.days! <= 30 ? 'warn' : 'ok'}`}>
                              {dateDe(d.next_inspection)}
                            </span>
                          ) : (
                            '–'
                          )}
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          <div class="actions">
            <button class="btn sec" name="format" value="avery">
              Etiketten drucken (Avery 63,5 × 29,6 mm, 27 je Bogen)
            </button>
            <button class="btn ghost sm" name="format" value="gross">
              groß (2 × 5, Papier)
            </button>
            <span class="small mut">
              Ohne Markierung: alle {anz(rows.length, 'Gerät', 'Geräte')} dieser Auswahl, nach Objekt
              sortiert.
            </span>
          </div>
          {rows.length > 0 && <input type="hidden" name="alle" value={rows.map((d) => d.id).join(',')} />}
        </form>
        <p class="small mut">
          Elektrische Geräte (Sauger, Scheuersaugmaschinen) regelmäßig nach DGUV V3 prüfen lassen. Standort
          wird nur beim Scannen erfasst – kein laufendes Tracking.
        </p>
      </>,
    );
  });

  // ------------------------------------------------------------------ Etiketten

  app.get('/geraete/etiketten', async (c) => {
    const picked = c.req.queries('id') ?? [];
    const fallback = (c.req.query('alle') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x));
    const ids = new Set(picked.length ? picked : fallback);
    const objekt = c.req.query('objekt') ?? '';
    const ol = c.req.query('ol') ?? '';
    const nurNeu = c.req.query('nur') === 'neu';
    const all = inScope(c, await listDevices(sql));
    const list = (
      ids.size
        ? all.filter((d) => ids.has(d.id))
        : all.filter((d) => d.active && matchPlace(d, objekt, ol) && (!nurNeu || !d.label_printed_at))
    )
      // Objektleitung → Objekt → Gerät, ohne Leerräume zwischen Objekten (Seiten werden aufgefüllt)
      .sort(labelOrder)
      .slice(0, 400);
    // Formate: avery = Avery Zweckform Sicherheits-Etiketten 63,5 × 29,6 mm, 3 × 9 je A4 (Ahmed 09.11.)
    const fmt =
      c.req.query('format') === 'gross' ? 'gross' : c.req.query('format') === 'klein' ? 'klein' : 'avery';
    const perSheet = fmt === 'avery' ? 27 : fmt === 'klein' ? 24 : 10;
    // Beginnen bei Etikett Nr. (angebrochene Bögen weiterverwenden)
    const ab = Math.min(perSheet, Math.max(1, Number(c.req.query('ab') ?? 1) || 1));
    const labels = await Promise.all(
      list.map(async (d) => ({
        d,
        svg: await QRCode.toString(qrUrl(c, d.qr_token), {
          type: 'svg',
          margin: 0,
          errorCorrectionLevel: 'M',
        }),
      })),
    );
    const cells: ((typeof labels)[number] | null)[] = [...Array(ab - 1).fill(null), ...labels];
    const [co] = await sql<
      { name: string; phone: string | null }[]
    >`select legal_name as name, phone from app.company where id = 1`;
    const css =
      fmt === 'avery'
        ? // A4: 3 × 63,5 mm + 2 × 2,5 mm Abstand = 195,5 → Rand 7,25 mm; 9 × 29,6 mm = 266,4 → oben 15,3 mm
          `.sheet{grid-template-columns:repeat(3,63.5mm);grid-auto-rows:29.6mm;column-gap:2.5mm;height:297mm;
padding:calc(15.3mm + var(--dy,0mm)) 0 0 calc(7.25mm + var(--dx,0mm))}
.lab{padding:1.6mm 2mm;gap:2mm}.qr{width:25mm;height:25mm;flex:none}.nm{font-size:8pt}.k{font-size:5.6pt}
.nr{font-size:9.5pt}.ob{font-size:6pt}.own{font-size:5pt}.logo{height:3.2mm}.t{display:none}`
        : fmt === 'klein'
          ? `.sheet{grid-template-columns:repeat(3,63.5mm);grid-auto-rows:33.9mm;column-gap:2.5mm;padding:13mm 7mm}
.lab{padding:2.5mm;gap:2.5mm}.qr{width:28mm;height:28mm}.nm{font-size:9.5pt}.k{font-size:6.5pt}.nr{font-size:11pt}.t,.own,.ob{font-size:5.8pt}.logo{height:4.5mm}`
          : `.sheet{grid-template-columns:repeat(2,95mm);grid-auto-rows:54mm;column-gap:4mm;padding:10mm 8mm}
.lab{padding:4mm;gap:4mm}.qr{width:44mm;height:44mm}.nm{font-size:12pt}.k{font-size:7.5pt}.nr{font-size:16pt}.t,.ob{font-size:7.5pt}.own{font-size:6.5pt}.logo{height:7mm}`;
    const fmtText =
      fmt === 'avery'
        ? 'Avery Zweckform Sicherheits-Etiketten 63,5 × 29,6 mm (27 je Bogen)'
        : fmt === 'klein'
          ? 'klein: 3 × 8 je A4 (63,5 × 33,9 mm)'
          : 'groß: 2 × 5 je A4 (95 × 54 mm)';
    const qs = (p: Record<string, string>) => {
      const u = new URL(c.req.url);
      for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
      return `${u.pathname}?${u.searchParams.toString()}`;
    };
    // Feinjustierung (Drucker verschieben oft 1–2 mm): je Browser gemerkt
    const ADJUST_JS = `(function(){var k='vd_lab_adj';var a={dx:0,dy:0};try{a=JSON.parse(localStorage.getItem(k))||a}catch(e){}
function ap(){document.documentElement.style.setProperty('--dx',a.dx+'mm');document.documentElement.style.setProperty('--dy',a.dy+'mm');
var x=document.getElementById('dx'),y=document.getElementById('dy');if(x)x.value=a.dx;if(y)y.value=a.dy}
document.addEventListener('DOMContentLoaded',function(){ap();['dx','dy'].forEach(function(n){var el=document.getElementById(n);if(el)el.addEventListener('input',function(){a[n]=Number(el.value)||0;try{localStorage.setItem(k,JSON.stringify(a))}catch(e){}ap()})})});ap()})();`;
    return c.html(
      `<!doctype html>${(
        <html lang="de">
          <head>
            <meta charset="utf-8" />
            <title>Geräte-Etiketten</title>
            <style
              dangerouslySetInnerHTML={{
                __html: `@page{size:A4;margin:0}body{margin:0;font-family:Inter,system-ui,sans-serif;color:#1a1a1a}
.sheet{display:grid;box-sizing:border-box;width:210mm;break-after:page;align-content:start}
.lab{display:flex;align-items:center;box-sizing:border-box;border:.2mm dashed #bbb;border-radius:2mm;overflow:hidden}
.lab.empty{border-color:#eee}
.qr svg{width:100%;height:100%;display:block}.info{display:flex;flex-direction:column;gap:.6mm;min-width:0}
.k{text-transform:uppercase;letter-spacing:.06em;color:#7D1435;font-weight:700}.nm{font-weight:700;line-height:1.15;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.nr{font-weight:800;letter-spacing:.02em}.t{color:#333}.own{color:#666}.ob{color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:14px}
.bar input{width:60px}
@media print{.bar{display:none}.lab{border-color:transparent}}${css}`,
              }}
            />
            <script dangerouslySetInnerHTML={{ __html: ADJUST_JS }} />
            <script
              dangerouslySetInnerHTML={{
                __html: `window.addEventListener('afterprint',function(){var f=document.getElementById('printed-form');if(f&&confirm('Wurden die Etiketten richtig gedruckt? Dann als gedruckt vermerken.'))f.submit()});`,
              }}
            />
          </head>
          <body>
            <div class="bar">
              <b>{list.length} Etiketten</b>
              <button onclick="window.print()">Drucken</button>
              {labels.length > 0 && (
                <form method="post" action="/geraete/etiketten/gedruckt" id="printed-form" style="margin:0">
                  {labels.map(({ d }) => (
                    <input type="hidden" name="id" value={d.id} />
                  ))}
                  <button>Als gedruckt vermerken</button>
                </form>
              )}
              <span style="color:#666">{fmtText}</span>
              <form method="get" action="/geraete/etiketten" style="display:flex;gap:6px;align-items:center">
                {[...new URL(c.req.url).searchParams.entries()]
                  .filter(([k]) => k !== 'ab')
                  .map(([k, v]) => (
                    <input type="hidden" name={k} value={v} />
                  ))}
                <label>
                  Beginnen bei Etikett{' '}
                  <input type="number" name="ab" min="1" max={String(perSheet)} value={String(ab)} />
                </label>
                <button>übernehmen</button>
              </form>
              <label>
                Verschieben → mm <input id="dx" type="number" step="0.5" value="0" />
              </label>
              <label>
                ↓ mm <input id="dy" type="number" step="0.5" value="0" />
              </label>
              <span style="color:#666">
                Erst einen Bogen auf Normalpapier drucken und gegen den Etikettenbogen halten. Im Druckdialog
                „Tatsächliche Größe / 100 %“ und „ohne Ränder“ wählen.
              </span>
              {fmt !== 'avery' && <a href={qs({ format: 'avery' })}>Avery-Format</a>}
            </div>
            {Array.from({ length: Math.ceil(cells.length / perSheet) }, (_, i) =>
              cells.slice(i * perSheet, (i + 1) * perSheet),
            ).map((chunk) => (
              <div class="sheet">
                {chunk.map((cell) =>
                  cell ? (
                    <div class="lab">
                      <div class="qr" dangerouslySetInnerHTML={{ __html: cell.svg }} />
                      <div class="info">
                        <img
                          class="logo"
                          src="/static/logo-transparent.png"
                          alt="Viva-Deluxe"
                          style="align-self:flex-start"
                        />
                        <div class="k">{kindLabel(cell.d.kind)}</div>
                        <div class="nm">{cell.d.name}</div>
                        <div class="nr">Nr. {cell.d.inventory_no}</div>
                        <div class="ob">
                          {cell.d.site_id ? `${cell.d.site_no} · ${cell.d.site_name}` : 'Lager / Büro'}
                        </div>
                        <div class="t">Mit dem Handy scannen: Standort oder Defekt melden</div>
                        <div class="own">
                          Eigentum {co?.name ?? 'Viva-Deluxe'}
                          {co?.phone ? ` · ${co.phone}` : ''}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div class="lab empty" />
                  ),
                )}
              </div>
            ))}
            {!labels.length && <p style="padding:80px 20px">Keine Geräte ausgewählt.</p>}
          </body>
        </html>
      ).toString()}`,
    );
  });

  app.post('/geraete/etiketten/gedruckt', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const raw = body['id'];
    const wanted = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    // nur Geräte, die die Person sehen darf
    const allowed = new Set(inScope(c, await listDevices(sql)).map((d) => d.id));
    const n = await markLabelsPrinted(
      sql,
      wanted.filter((x) => allowed.has(x)),
      fullName(c.get('user')),
    );
    return back(c, '/geraete', { ok: `${anz(n, 'Etikett', 'Etiketten')} als gedruckt vermerkt.` });
  });

  // ------------------------------------------------------------------ Scan im Büro (Objektleitung, Büro)

  const officeSites = async (c: Context<AppEnv>): Promise<ScanSite[]> => {
    const scope = c.get('sites');
    return (await listSites(sql))
      .filter((s) => s.active && (!scope || scope.includes(s.id)))
      .map((s) => ({ id: s.id, name: s.name, site_no: s.site_no, customer: s.customer_name }));
  };

  app.get(`/geraete/scan/:token{${TOKEN}}`, async (c) => {
    const d = await deviceByToken(sql, c.req.param('token'));
    if (!d || !d.active)
      return back(c, '/geraete', { fehler: 'Unbekannter QR-Code (Gerät nicht gefunden oder inaktiv).' });
    const [last] = await deviceEvents(sql, d.id, 1);
    const sites = await officeSites(c);
    return page(
      c,
      d.name,
      'inventar',
      <>
        <PageHead title="Gerät gescannt" crumbs={[['Geräte', '/geraete']]} />
        <div style="max-width:560px">
          <DeviceScanForm
            action={`/geraete/scan/${d.qr_token}`}
            formId={randomUUID()}
            device={d}
            sites={sites}
            preSite={d.site_id}
            last={lastSeenText(last)}
            L={(k) => DE[k] ?? k}
          />
          {canSeeDevice(c, d.site_id) && (
            <p class="small">
              <a href={`/geraete/${d.id}`}>Gerät mit Verlauf ansehen</a>
            </p>
          )}
        </div>
      </>,
    );
  });

  const canSeeDevice = (c: Context<AppEnv>, siteId: string | null) => {
    const scope = c.get('sites');
    return !scope || (!!siteId && scope.includes(siteId));
  };

  app.post(`/geraete/scan/:token{${TOKEN}}`, async (c) => {
    const token = c.req.param('token');
    const d = await deviceByToken(sql, token);
    if (!d || !d.active) throw new BusinessError('Unbekannter QR-Code');
    const b = await c.req.parseBody();
    const formId = typeof b.form_id === 'string' && /^[0-9a-f-]{36}$/.test(b.form_id) ? b.form_id : null;
    if (!formId) throw new BusinessError('Formular ungültig – bitte neu laden');
    const siteId = typeof b.site_id === 'string' && b.site_id ? b.site_id : null;
    if (siteId && siteId !== d.site_id) assertSite(c, siteId);
    const f = b.foto instanceof File && b.foto.size > 0 ? b.foto : null;
    await recordDeviceScan(sql, cfg, {
      id: formId,
      deviceId: d.id,
      action: String(b.action ?? ''),
      siteId,
      note: typeof b.note === 'string' ? b.note : null,
      pos: posFromForm(b),
      photo: f ? { data: new Uint8Array(await f.arrayBuffer()), name: f.name, type: f.type } : null,
      by: fullName(c.get('user')),
      actor: c.get('actor'),
    });
    const fresh = await getDevice(sql, d.id);
    return back(c, canSeeDevice(c, fresh?.site_id ?? null) ? `/geraete/${d.id}` : '/geraete', {
      ok: 'Gespeichert.',
    });
  });

  // ------------------------------------------------------------------ Gerät im Detail

  app.get(`/geraete/:id{${UUID}}`, async (c) => {
    const d = await getDevice(sql, c.req.param('id'));
    if (!d) return c.notFound();
    assertSite(c, d.site_id);
    const [site] = d.site_id
      ? await sql<{ name: string; site_no: string; street: string | null; city: string | null }[]>`
          select name, site_no, street, city from app.sites where id = ${d.site_id}`
      : [];
    const events = await deviceEvents(sql, d.id);
    const scans = events.filter((e) => ['hier', 'mitgenommen', 'lager', 'defekt'].includes(e.action));
    const lastScan = scans[0];
    const lastPos = scans.find((e) => e.lat && e.lng);
    const qr = await QRCode.toString(qrUrl(c, d.qr_token), {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    const stale = !lastScan || (Date.now() - lastScan.created_at.getTime()) / 86_400_000 > STALE_DAYS;
    return page(
      c,
      d.name,
      'inventar',
      <>
        <PageHead title={d.name} no={d.inventory_no} crumbs={[['Geräte', '/geraete']]}>
          <div class="actions" style="margin:0 0 0 auto">
            <a class="btn sec" href={`/geraete/etiketten?id=${d.id}`} target="_blank">
              Etikett drucken
            </a>
            <a class="btn sec" href={`/geraete/${d.id}/bearbeiten`}>
              Bearbeiten
            </a>
          </div>
        </PageHead>
        <div class="cols">
          <div>
            <div class="card">
              <h3 style="margin-top:0">Standort</h3>
              <div style="font-size:18px">
                <b>
                  {d.site_id ? (
                    <a href={`/objekte/${d.site_id}`}>
                      {site?.site_no} · {site?.name}
                    </a>
                  ) : (
                    'Lager / Büro'
                  )}
                </b>
                {d.status !== 'ok' && (
                  <span class="badge err" style="margin-left:8px">
                    {DEVICE_STATUS[d.status as keyof typeof DEVICE_STATUS]}
                  </span>
                )}
              </div>
              {site?.street && (
                <div class="mut">
                  {site.street}, {site.city}
                </div>
              )}
              <p class="small" style="margin-bottom:0">
                {lastScan ? (
                  <>
                    Zuletzt gescannt {when(lastScan.created_at)} von {lastScan.by_name}
                    {geoText(lastScan.geo, lastScan.geo_m) && ` · ${geoText(lastScan.geo, lastScan.geo_m)}`}
                  </>
                ) : (
                  'Noch nie gescannt – Etikett drucken und anbringen.'
                )}
                {lastScan && stale && (
                  <span style="color:var(--err)"> · seit über {STALE_DAYS} Tagen nicht gescannt</span>
                )}
              </p>
              {lastPos && (
                <div style="margin-top:10px">
                  <div
                    class="map"
                    data-src={`https://maps.google.com/maps?q=${lastPos.lat},${lastPos.lng}&z=16&output=embed`}
                  >
                    <button
                      type="button"
                      class="btn sec sm"
                      onclick="var m=this.parentNode;var f=document.createElement('iframe');f.src=m.dataset.src;f.loading='lazy';f.title='Karte';f.referrerPolicy='no-referrer';f.style.cssText='width:100%;height:260px;border:0;border-radius:8px';m.innerHTML='';m.appendChild(f);"
                    >
                      Karte laden (Google Maps)
                    </button>{' '}
                    <span class="small mut">
                      Standort beim Scan {when(lastPos.created_at)} ·{' '}
                      <a
                        href={mapsLink(lastPos.lat!, lastPos.lng!)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        in Google Maps öffnen
                      </a>
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div class="card">
              <h3 style="margin-top:0">Verlauf ({events.length})</h3>
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Wann</th>
                      <th>Vorgang</th>
                      <th>Objekt</th>
                      <th>Standort beim Scan</th>
                      <th>Wer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.length === 0 && (
                      <tr>
                        <td colspan={5}>
                          <div class="empty">Noch kein Eintrag.</div>
                        </td>
                      </tr>
                    )}
                    {events.map((e) => {
                      const scan = ['hier', 'mitgenommen', 'lager', 'defekt'].includes(e.action);
                      return (
                        <tr>
                          <td class="small">{scan ? when(e.created_at) : dateDe(e.event_date)}</td>
                          <td>
                            <span class={e.action === 'defekt' ? 'badge err' : ''}>
                              {ACTION_LABEL[e.action]}
                            </span>
                            {e.note && <div class="small">{e.note}</div>}
                            {e.photo_file_id && (
                              <div class="small">
                                <a href={`/geraete/foto/${e.photo_file_id}`} target="_blank">
                                  Foto ansehen
                                </a>
                              </div>
                            )}
                          </td>
                          <td class="small">
                            {e.site_id ? `${e.site_no} · ${e.site_name}` : scan ? 'Lager' : ''}
                          </td>
                          <td class="small">
                            {geoText(e.geo, e.geo_m) ?? (scan ? (e.lat ? '' : 'kein Standort') : '')}
                            {e.lat && e.lng && (
                              <>
                                {' '}
                                <a href={mapsLink(e.lat, e.lng)} target="_blank" rel="noopener noreferrer">
                                  Karte
                                </a>
                              </>
                            )}
                          </td>
                          <td class="small">{e.by_name}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div>
            <div class="card">
              <h3 style="margin-top:0">Gerät</h3>
              <dl class="kv">
                <dt>Art</dt>
                <dd>{kindLabel(d.kind)}</dd>
                <dt>Hersteller / Modell</dt>
                <dd>{d.manufacturer ?? '–'}</dd>
                <dt>Seriennummer</dt>
                <dd>{d.serial_no ?? '–'}</dd>
                <dt>Anschaffung</dt>
                <dd>{d.purchase_date ? dateDe(d.purchase_date) : '–'}</dd>
                {needsInspection(d.kind) && (
                  <>
                    <dt>Nächste Prüfung</dt>
                    <dd>{d.next_inspection ? dateDe(d.next_inspection) : '–'}</dd>
                  </>
                )}
              </dl>
              {d.notes && <p class="small">{d.notes}</p>}
              <div style="max-width:150px;margin:8px 0" dangerouslySetInnerHTML={{ __html: qr }} />
              <p class="small mut" style="margin:0">
                QR-Code des Etiketts. <a href={`/geraete/scan/${d.qr_token}`}>Scan-Seite öffnen</a>
              </p>
            </div>
            <form method="post" action={`/geraete/${d.id}/vorgang`} class="card" data-no-autosave>
              <h3 style="margin-top:0">Prüfung / Reparatur erfassen</h3>
              <input type="hidden" name="form_id" value={randomUUID()} />
              <label for="v-art">Vorgang</label>
              <select id="v-art" name="action">
                {SERVICE_ACTIONS.map((a) => (
                  <option value={a}>{ACTION_LABEL[a]}</option>
                ))}
              </select>
              <label for="v-datum">Datum</label>
              <input id="v-datum" type="date" name="datum" value={todayBerlin()} />
              <label for="v-next">Nächste Prüfung (nur bei Prüfung)</label>
              <input id="v-next" type="date" name="naechste" />
              <label for="v-note">Bemerkung (Prüfer, Werkstatt, Kosten …)</label>
              <textarea id="v-note" name="note" rows={2} maxLength={1000} />
              <div class="actions">
                <button class="btn">Eintragen</button>
              </div>
              <p class="small mut" style="margin-bottom:0">
                „repariert / einsatzbereit“ setzt das Gerät wieder auf einsatzbereit und erledigt die offene
                Defekt-Aufgabe.
              </p>
            </form>
          </div>
        </div>
      </>,
    );
  });

  app.post(`/geraete/:id{${UUID}}/vorgang`, async (c) => {
    const id = c.req.param('id');
    const d = await getDevice(sql, id);
    if (!d) return c.notFound();
    assertSite(c, d.site_id);
    const b = await c.req.parseBody();
    const formId = typeof b.form_id === 'string' && /^[0-9a-f-]{36}$/.test(b.form_id) ? b.form_id : null;
    if (!formId) throw new BusinessError('Formular ungültig – bitte neu laden');
    await recordDeviceService(sql, {
      id: formId,
      deviceId: id,
      action: String(b.action ?? ''),
      date: typeof b.datum === 'string' ? b.datum : null,
      note: typeof b.note === 'string' ? b.note : null,
      nextInspection: typeof b.naechste === 'string' ? b.naechste : null,
      by: fullName(c.get('user')),
      actor: c.get('actor'),
    });
    return back(c, `/geraete/${id}`, { ok: 'Eingetragen.' });
  });

  // Foto einer Defektmeldung (ohne eigene Verknüpfung): Recht wie das Gerät
  app.get(`/geraete/foto/:id{${UUID}}`, async (c) => {
    const [e] = await sql<{ site_id: string | null }[]>`
      select d.site_id from app.device_events e join app.devices d on d.id = e.device_id
       where e.photo_file_id = ${c.req.param('id')} limit 1`;
    if (!e || !canSeeDevice(c, e.site_id)) return c.notFound();
    const [f] = await sql<FileRow[]>`select * from app.files where id = ${c.req.param('id')}`;
    if (!f) return c.notFound();
    return c.body(await readFile(filePath(cfg, f)), 200, {
      'Content-Type': f.content_type,
      'Cache-Control': 'private, max-age=86400',
    });
  });
}

/** Deutsche Texte des Scan-Formulars im Büro (gleiche Schlüssel wie die Mitarbeiter-App). */
const DE: Record<string, string> = {
  dev_now: 'Jetzt',
  dev_here: 'Gerät ist hier',
  dev_moved: 'Mitgenommen zu Objekt …',
  dev_store: 'Zurück ins Lager',
  dev_defect: 'Defekt melden',
  dev_site: 'Objekt',
  dev_site_pick: '– Objekt wählen –',
  dev_note: 'Was ist kaputt?',
  dev_note_opt: 'Bemerkung (optional)',
  dev_photo: 'Foto vom Schaden',
  dev_send: 'Speichern',
  dev_geo: 'Der Standort des Handys wird nur jetzt einmal mitgeschickt.',
  dev_store_word: 'Lager',
  dev_is_defect: 'Als defekt gemeldet',
};
