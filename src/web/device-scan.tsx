/** Scan-Seite eines Geräts (QR-Etikett): gleiche Ansicht in der Mitarbeiter-App (/m/g/…) und im Büro (/geraete/scan/…). */
import type { FC } from 'hono/jsx';
import { Ic } from './m/icons.js';
import { DEVICE_STATUS, type ScanDevice, kindLabel } from '../services/device-tracking.js';

export type ScanSite = { id: string; name: string; site_no: string; customer?: string };

export const DeviceScanForm: FC<{
  action: string;
  formId: string;
  device: ScanDevice;
  sites: ScanSite[];
  preSite: string | null;
  last: string | null;
  L: (key: string) => string;
}> = ({ action, formId, device: d, sites, preSite, last, L }) => {
  const opt = (s: ScanSite) => (
    <option value={s.id} selected={s.id === preSite}>
      {s.site_no} · {s.name}
      {s.customer ? ` (${s.customer})` : ''}
    </option>
  );
  const acts: [string, string, string][] = [
    ['hier', L('dev_here'), 'pin'],
    ['mitgenommen', L('dev_moved'), 'arrow'],
    ['lager', L('dev_store'), 'home'],
    ['defekt', L('dev_defect'), 'ticket'],
  ];
  return (
    <>
      <div class="card devhead">
        <div class="devkind">{kindLabel(d.kind)}</div>
        <h1 style="margin:2px 0">{d.name}</h1>
        <div class="mut">
          Nr. {d.inventory_no}
          {d.manufacturer ? ` · ${d.manufacturer}` : ''}
        </div>
        {d.status !== 'ok' && (
          <div class="devbad">{d.status === 'defekt' ? L('dev_is_defect') : DEVICE_STATUS.reparatur}</div>
        )}
        <div class="small" style="margin-top:8px">
          {L('dev_now')}: <b>{d.site_id ? `${d.site_no} · ${d.site_name}` : L('dev_store_word')}</b>
          {last && <div class="mut">{last}</div>}
        </div>
      </div>
      <form
        method="post"
        action={action}
        enctype="multipart/form-data"
        class="card"
        id="devscan"
        data-no-autosave
      >
        <input type="hidden" name="form_id" value={formId} />
        <input type="hidden" name="geo_lat" />
        <input type="hidden" name="geo_lng" />
        <input type="hidden" name="geo_acc" />
        <div class="devacts">
          {acts.map(([v, label, sym], i) => (
            <label class={`devact${v === 'defekt' ? ' bad' : ''}`}>
              <input type="radio" name="action" value={v} checked={i === 0} />
              <span class="sym">
                <Ic n={sym} />
              </span>
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div data-for="hier mitgenommen defekt">
          <label for="dev-site">{L('dev_site')}</label>
          <select id="dev-site" name="site_id">
            <option value="">{L('dev_site_pick')}</option>
            {sites.map(opt)}
          </select>
        </div>
        <div>
          <label for="dev-note" data-lbl-defekt={L('dev_note')} data-lbl={L('dev_note_opt')}>
            {L('dev_note_opt')}
          </label>
          <textarea id="dev-note" name="note" rows={2} maxLength={1000} />
        </div>
        <div data-for="defekt">
          <label class="devphoto">
            <Ic n="cam" />
            <span data-empty={L('dev_photo')}>{L('dev_photo')}</span>
            <input type="file" name="foto" accept="image/*" capture="environment" />
          </label>
        </div>
        <p class="small mut" id="dev-geo">
          {L('dev_geo')}
        </p>
        <button class="big go btn" style="width:100%">
          {L('dev_send')}
        </button>
      </form>
      <style>{`.devkind{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7D1435;font-weight:700}
.devbad{margin-top:8px;display:inline-block;padding:3px 10px;border-radius:999px;background:#fef3f2;color:#b42318;font-weight:600;font-size:13px}
.devacts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.devact{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:84px;padding:10px 6px;border:1.5px solid #e2d6db;border-radius:12px;text-align:center;font-weight:600;font-size:14px;cursor:pointer;margin:0;background:#fff}
.devact input{position:absolute;opacity:0;pointer-events:none}
.devact .sym{line-height:1;color:#7D1435}.devact .sym svg{width:26px;height:26px}
.devact:has(input:checked){border-color:#7D1435;background:#faf3f5;box-shadow:inset 0 0 0 1px #7D1435}
.devact.bad .sym{color:#b42318}.devact.bad:has(input:checked){border-color:#b42318;background:#fef3f2;box-shadow:inset 0 0 0 1px #b42318}
#devscan select,#devscan textarea{width:100%;box-sizing:border-box}
.devphoto{display:flex;align-items:center;justify-content:center;gap:8px;margin:10px 0;padding:14px;border:1.5px dashed #d7c3cb;border-radius:12px;color:#7D1435;font-weight:600;cursor:pointer}
.devphoto svg{width:24px;height:24px}.devphoto input{display:none}`}</style>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var f=document.getElementById('devscan');if(!f)return;
function geo(){if(!navigator.geolocation)return;navigator.geolocation.getCurrentPosition(function(p){f.geo_lat.value=p.coords.latitude.toFixed(5);f.geo_lng.value=p.coords.longitude.toFixed(5);f.geo_acc.value=Math.round(p.coords.accuracy)},function(){},{enableHighAccuracy:true,timeout:15000,maximumAge:60000})}
geo();
function sync(){var a=(f.querySelector('input[name=action]:checked')||{}).value||'';f.querySelectorAll('[data-for]').forEach(function(el){el.hidden=el.getAttribute('data-for').split(' ').indexOf(a)<0});
var s=f.site_id;s.required=a==='hier'||a==='mitgenommen';var n=f.note;n.required=a==='defekt';var l=f.querySelector('label[for=dev-note]');l.textContent=a==='defekt'?l.getAttribute('data-lbl-defekt'):l.getAttribute('data-lbl')}
f.querySelectorAll('input[name=action]').forEach(function(r){r.addEventListener('change',sync)});sync();
var ph=f.querySelector('.devphoto input');if(ph)ph.addEventListener('change',function(){var t=ph.parentNode.querySelector('span');t.textContent=ph.files&&ph.files[0]?'\u2713 '+ph.files[0].name:t.getAttribute('data-empty')});
f.addEventListener('submit',function(){var b=f.querySelector('button');if(b){b.disabled=true}})})();`,
        }}
      />
    </>
  );
};

/** „Zuletzt: 12.10.2026 14:05 von Maria Beispiel“ */
export function lastSeenText(e: { created_at: Date; by_name: string } | undefined): string | null {
  if (!e) return null;
  const when = e.created_at.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${when} · ${e.by_name}`;
}
