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
import { type DeviceListRow, getDevice, listDevices } from '../services/inventory.js';
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
    const active = all.filter((d) => d.active);
    const counts = {
      lange: active.filter(isStale).length,
      defekt: active.filter((d) => d.status !== 'ok').length,
      pruefung: active.filter((d) => d.days !== null && d.days <= 30).length,
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
        (!q ||
          `${d.inventory_no} ${d.name} ${d.manufacturer ?? ''} ${d.serial_no ?? ''} ${d.site_name ?? ''}`
            .toLowerCase()
            .includes(q)),
    );
    const href = (p: Record<string, string>) => {
      const u = new URLSearchParams({
        ...(f ? { f } : {}),
        ...(art ? { art } : {}),
        ...(q ? { q } : {}),
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
                  <th>Standort</th>
                  <th>Zuletzt gescannt</th>
                  <th>Nächste Prüfung</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colspan={6}>
                      <div class="empty">Keine Geräte in dieser Auswahl.</div>
                    </td>
                  </tr>
                )}
                {rows.map((d) => (
                  <tr style={d.active ? '' : 'opacity:.55'}>
                    <td>
                      <input type="checkbox" name="id" value={d.id} aria-label={`${d.name} markieren`} />
                    </td>
                    <td>{d.inventory_no}</td>
                    <td>
                      <a href={`/geraete/${d.id}`}>
                        <b>{d.name}</b>
                      </a>
                      <div class="small mut">
                        {kindLabel(d.kind)}
                        {d.manufacturer ? ` · ${d.manufacturer}` : ''}
                      </div>
                      {d.status !== 'ok' && (
                        <span class="badge err">{DEVICE_STATUS[d.status as keyof typeof DEVICE_STATUS]}</span>
                      )}
                    </td>
                    <td>
                      {d.site_id ? (
                        <a href={`/objekte/${d.site_id}`}>
                          {d.site_no} · {d.site_name}
                        </a>
                      ) : (
                        'Lager'
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
              </tbody>
            </table>
          </div>
          <div class="actions">
            <button class="btn sec" name="format" value="gross">
              Etiketten für markierte (groß, 2 × 5 je A4)
            </button>
            <button class="btn sec" name="format" value="klein">
              Etiketten für markierte (klein, 3 × 8 je A4)
            </button>
            <span class="small mut">
              Ohne Markierung: alle {anz(rows.length, 'Gerät', 'Geräte')} dieser Auswahl.
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
    const all = inScope(c, await listDevices(sql));
    const list = (ids.size ? all.filter((d) => ids.has(d.id)) : all.filter((d) => d.active)).slice(0, 400);
    const small = c.req.query('format') === 'klein';
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
    const [co] = await sql<
      { name: string; phone: string | null }[]
    >`select legal_name as name, phone from app.company where id = 1`;
    const css = small
      ? `.sheet{grid-template-columns:repeat(3,63.5mm);grid-auto-rows:33.9mm;column-gap:2.5mm;padding:13mm 7mm}
.lab{padding:2.5mm;gap:2.5mm}.qr{width:28mm;height:28mm}.nm{font-size:9.5pt}.k{font-size:6.5pt}.nr{font-size:11pt}.t,.own{font-size:5.8pt}.logo{height:4.5mm}`
      : `.sheet{grid-template-columns:repeat(2,95mm);grid-auto-rows:54mm;column-gap:4mm;padding:10mm 8mm}
.lab{padding:4mm;gap:4mm}.qr{width:44mm;height:44mm}.nm{font-size:12pt}.k{font-size:7.5pt}.nr{font-size:16pt}.t{font-size:7.5pt}.own{font-size:6.5pt}.logo{height:7mm}`;
    return c.html(
      `<!doctype html>${(
        <html lang="de">
          <head>
            <meta charset="utf-8" />
            <title>Geräte-Etiketten</title>
            <style
              dangerouslySetInnerHTML={{
                __html: `@page{size:A4;margin:0}body{margin:0;font-family:Inter,system-ui,sans-serif;color:#1a1a1a}
.sheet{display:grid;box-sizing:border-box;width:210mm;break-after:page}
.lab{display:flex;align-items:center;box-sizing:border-box;border:.2mm dashed #bbb;border-radius:2mm;overflow:hidden}
.qr svg{width:100%;height:100%;display:block}.info{display:flex;flex-direction:column;gap:.8mm;min-width:0}
.k{text-transform:uppercase;letter-spacing:.06em;color:#7D1435;font-weight:700}.nm{font-weight:700;line-height:1.15}
.nr{font-weight:800;letter-spacing:.02em}.t{color:#333}.own{color:#666}
.bar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;gap:12px;align-items:center;font-size:14px}
@media print{.bar{display:none}.lab{border-color:#ddd}}${css}`,
              }}
            />
          </head>
          <body>
            <div class="bar">
              <b>{list.length} Etiketten</b>
              <button onclick="window.print()">Drucken</button>
              <span style="color:#666">
                {small ? 'klein: 3 × 8 je A4 (63,5 × 33,9 mm)' : 'groß: 2 × 5 je A4 (95 × 54 mm)'} – auf
                Etikettenbogen oder Papier drucken, laminieren bzw. wetterfeste Etiketten nehmen.
              </span>
            </div>
            {Array.from({ length: Math.ceil(labels.length / (small ? 24 : 10)) }, (_, i) =>
              labels.slice(i * (small ? 24 : 10), (i + 1) * (small ? 24 : 10)),
            ).map((chunk) => (
              <div class="sheet">
                {chunk.map(({ d, svg }) => (
                  <div class="lab">
                    <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />
                    <div class="info">
                      <img
                        class="logo"
                        src="/static/logo-transparent.png"
                        alt="Viva-Deluxe"
                        style="align-self:flex-start"
                      />
                      <div class="k">{kindLabel(d.kind)}</div>
                      <div class="nm">{d.name}</div>
                      <div class="nr">Nr. {d.inventory_no}</div>
                      <div class="t">Mit dem Handy scannen: Standort oder Defekt melden</div>
                      <div class="own">
                        Eigentum {co?.name ?? 'Viva-Deluxe'}
                        {co?.phone ? ` · ${co.phone}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {!labels.length && <p style="padding:80px 20px">Keine Geräte ausgewählt.</p>}
          </body>
        </html>
      ).toString()}`,
    );
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
                <dt>Nächste Prüfung</dt>
                <dd>{d.next_inspection ? dateDe(d.next_inspection) : '–'}</dd>
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
