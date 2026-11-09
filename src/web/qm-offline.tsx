import { QM_SCALE, itemsForRoomType, qmSites, roomMeta } from '../services/qm.js';
import { type Ctx, UUID, assertSite } from './app.js';
import { QM_OFFLINE_JS } from './qm-offline-js.js';

/*
 * Qualitätskontrolle offline (Ahmed 09.11.): Objekte vorab aufs Handy laden (Räume + Kontrollgegenstände), Audit ohne
 * Netz durchführen (Bewertungen, Bemerkungen, Kamera-Fotos in IndexedDB), beim nächsten Netz automatisch übertragen –
 * über dieselben Wege wie online (POST /qm/audit/neu, POST /qm/audit/:id/raum/:room mit Kopf X-Offline-Sync).
 * Feste IDs (Audit, Fotos) → abgebrochene/wiederholte Übertragung legt nichts doppelt an.
 */

const SW = `
var C='vd-qm-off-v1';
var SHELL='/qm/offline';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k.indexOf('vd-qm-off')===0&&k!==C;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('message',function(e){if(e.data==='cache-shell'){fetch(SHELL,{credentials:'same-origin',redirect:'manual'}).then(function(r){if(r.ok&&!r.redirected&&r.type!=='opaqueredirect')return caches.open(C).then(function(c){return Promise.all([c.put(SHELL,r),c.add('/static/logo-transparent.png').catch(function(){})]);});}).catch(function(){});}});
self.addEventListener('fetch',function(e){
  var r=e.request; if(r.method!=='GET')return;
  var u=new URL(r.url); if(u.origin!==location.origin)return;
  if(u.pathname==='/static/logo-transparent.png'){e.respondWith(caches.match(r).then(function(m){return m||fetch(r);}));return;}
  if(r.mode!=='navigate'||u.pathname.indexOf('/qm/')!==0)return;
  e.respondWith(fetch(r).then(function(res){
    if(u.pathname===SHELL&&res.ok&&!res.redirected){var cp=res.clone();caches.open(C).then(function(c){c.put(SHELL,cp);});}
    return res;
  }).catch(function(){return caches.match(SHELL).then(function(m){return m||new Response('<h1>Keine Verbindung</h1>',{headers:{'Content-Type':'text/html; charset=utf-8'}});});}));
});`;

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f8edf1"><meta name="format-detection" content="telephone=no">
<title>Qualitätskontrolle offline · Viva-Deluxe</title>
<link rel="manifest" href="/m/manifest.webmanifest">
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.4 -apple-system,system-ui,Inter,Segoe UI,sans-serif;color:#1d1d1f;background:#f6f6f7;padding:env(safe-area-inset-top) 0 calc(env(safe-area-inset-bottom) + 24px)}
header{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#fff;border-bottom:1px solid #e5e5ea;position:sticky;top:0;z-index:5}
header img{height:22px;flex:none}header b{flex:1;min-width:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header a,header button{color:#811D40;text-decoration:none;font-size:15px;background:none;border:0;padding:6px}
main{padding:12px 16px;max-width:720px;margin:0 auto}
.card{background:#fff;border:1px solid #e5e5ea;border-radius:14px;padding:14px;margin:0 0 12px}
h2{font-size:17px;margin:18px 0 8px}.mut{color:#6e6e73;font-size:14px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-top:1px solid #eee;color:inherit;text-decoration:none}
.row:first-child{border-top:0}.row .t{font-weight:600}.row .a{color:#6e6e73;font-size:13px}
.btn{display:block;width:100%;text-align:center;padding:13px;border-radius:12px;border:1px solid #d1d1d6;background:#fff;color:#1d1d1f;font:inherit;font-weight:600;margin:8px 0;text-decoration:none}
.btn.go{background:#811D40;border-color:#811D40;color:#fff}.btn.sm{display:inline-block;width:auto;padding:7px 12px;margin:0;font-size:14px}
.btn.del{color:#b42318;border-color:#f1c0bb}
.pill{display:inline-block;font-size:12px;font-weight:600;border-radius:99px;padding:2px 9px;background:#f1f1f4;color:#555}
.pill.ok{background:#e7f6ec;color:#17733a}.pill.wait{background:#fff4dc;color:#8a5a00}.pill.err{background:#fde8e6;color:#b42318}
.net{font-size:13px;padding:8px 16px;text-align:center}.net.off{background:#fff4dc;color:#8a5a00}.net.on{background:#e7f6ec;color:#17733a}
.item{background:#fff;border:1px solid #e5e5ea;border-radius:14px;padding:12px;margin:0 0 12px}.item.skipped{opacity:.55}
.item .hd{display:flex;justify-content:space-between;gap:8px}.item label.skip{display:inline-flex;gap:6px;font-size:14px;color:#6e6e73;margin:6px 0}
.yn{display:flex;gap:8px;margin:8px 0}.yn label{flex:1}.yn input{display:none}.yn span{display:block;text-align:center;padding:10px;border:1px solid #d1d1d6;border-radius:10px}
.yn input:checked+span{background:#811D40;color:#fff;border-color:#811D40}.yn label.no input:checked+span{background:#b42318;border-color:#b42318}
input[type=range]{width:100%;accent-color:#811D40}input[type=range]:not(.set){opacity:.4}.sv{text-align:center;font-weight:700;font-size:18px}.ends{display:flex;justify-content:space-between;font-size:12px;color:#6e6e73}
textarea,select,input[type=search]{width:100%;font:inherit;border:1px solid #d1d1d6;border-radius:10px;padding:10px;background:#fff}
.ph{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center}.ph img{width:64px;height:64px;object-fit:cover;border-radius:8px}
.ph label{width:64px;height:64px;border:1.5px dashed #c7c7cc;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:28px;color:#811D40}
.ph input{display:none}.ph .x{position:relative}.ph .x button{position:absolute;top:-6px;right:-6px;border:0;border-radius:99px;background:#1d1d1f;color:#fff;width:22px;height:22px;font-size:13px}
.score{font-weight:700}.flash{padding:10px 12px;border-radius:10px;margin:0 0 12px;font-size:14px}.flash.ok{background:#e7f6ec;color:#17733a}.flash.err{background:#fde8e6;color:#b42318}
</style></head><body>
<header><a href="/qm/qualitaet" id="home" aria-label="zurück">‹</a><img src="/static/logo-transparent.png" alt="Viva-Deluxe"><b id="ttl">Offline-Audits</b></header>
<div id="net" class="net"></div>
<main id="app"><p class="mut">Wird geladen …</p></main>
<script>${QM_OFFLINE_JS}</script>
</body></html>`;

export function registerQmOfflineRoutes({ app, deps }: Ctx) {
  const { sql } = deps;

  app.get('/qm/sw.js', (c) =>
    c.body(SW, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/qm/',
    }),
  );

  // Hülle: enthält keine Daten (die liegen im Handy), darf deshalb vom Service Worker gespeichert werden
  app.get('/qm/offline', (c) => c.html(PAGE, 200, { 'Cache-Control': 'no-cache' }));

  app.get('/qm/offline/objekte.json', async (c) => {
    const sites = await qmSites(sql, c.get('sites'));
    return c.json(
      sites.map((s) => ({
        id: s.id,
        no: s.site_no,
        name: s.name,
        customer: `${s.customer_no} - ${s.customer_name}`,
        address: [s.street, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        rooms: s.rooms,
      })),
    );
  });

  app.get(`/qm/offline/paket/:id{${UUID}}`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const [site] = await sql<{ id: string; site_no: string; name: string }[]>`
      select id, site_no, name from app.sites where id = ${siteId} and active`;
    if (!site) return c.json({ error: 'Objekt nicht gefunden' }, 404);
    const rooms = await sql<
      {
        id: string;
        name: string;
        floor: string | null;
        room_no: string | null;
        floor_covering: string | null;
        area_centi: bigint;
        room_type_id: string;
      }[]
    >`
      select r.id, r.name, r.floor, r.room_no, r.floor_covering, r.area_centi, r.room_type_id
        from app.rooms r where r.site_id = ${siteId} and r.active
       order by r.floor nulls first, r.sort_order, r.room_no nulls last, r.name`;
    const types = new Map<string, string[]>();
    const items: Record<
      string,
      { id: string; name: string; kind: string; opts: [number, string, number][] }
    > = {};
    for (const t of new Set(rooms.map((r) => r.room_type_id))) {
      const list = await itemsForRoomType(sql, t);
      types.set(
        t,
        list.map((i) => i.id),
      );
      for (const i of list)
        items[i.id] = {
          id: i.id,
          name: i.name,
          kind: i.kind,
          opts: QM_SCALE[i.kind].map((o) => [o.v, o.label, o.pct]),
        };
    }
    return c.json({
      site: { id: site.id, no: site.site_no, name: site.name },
      loadedAt: new Date().toISOString(),
      items,
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        meta: roomMeta(r),
        items: types.get(r.room_type_id),
      })),
    });
  });
}
