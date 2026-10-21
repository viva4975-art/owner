// Stellenplakat (A4, eine Seite): HTML für Druck/PDF und Bild (html2canvas). Inhalt wird bei Bedarf
// verkleinert statt abgeschnitten (FIT_JS), WhatsApp als Knopf (Bildschirm) und QR-Code (Papier).
import QRCode from 'qrcode';
import sharp from 'sharp';
import posterI18n from '../i18n/job-poster.json' with { type: 'json' };
import { type Posting, TIMES, workdaysText } from '../services/applicants.js';
import { dateDe, euro } from './layout.js';

const ORDER = ['de', 'en', 'tr', 'ru', 'pl', 'ro', 'hu', 'el', 'ar'];
const T = posterI18n.texts as Record<string, Record<string, string>>;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const multi = (k: string, from = 0) =>
  [
    ...new Set(
      ORDER.slice(from)
        .map((l) => T[l]?.[k])
        .filter(Boolean),
    ),
  ].join(' · ');
const hDe = (h: number) => String(h).replace('.', ',');

/** Telefonnummer → internationale Ziffern für wa.me (0176… → 49176…). */
export function waNumber(phone: string): string | null {
  const t = phone.trim();
  let d = t.replace(/\D/g, '');
  if (!d) return null;
  if (t.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) d = `49${d.slice(1)}`;
  return d.length >= 8 ? d : null;
}

/** Freitext (Aufgaben, Anforderungen) → Aufzählungspunkte. */
function bullets(s: string | null): string[] {
  if (!s) return [];
  return s
    .split(/\r?\n|[•;]|\s-\s/)
    .map((x) => x.replace(/^[\s\-–*·]+/, '').trim())
    .filter(Boolean);
}

const I = {
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  euro: '<path d="M17 6.5A7 7 0 1 0 17 17.5"/><path d="M4 10.5h9M4 13.5h9"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  week: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 14h2M12 14h2M16 14h0M8 17h2"/>',
  bld: '<path d="M4 21V5l8-2v18M12 8h8v13M8 8v.01M8 12v.01M8 16v.01M16 12v.01M16 16v.01M2 21h20"/>',
  chat: '<path d="M20.5 11.7a8.4 8.4 0 0 1-12.4 7.4L3.5 20.5l1.4-4.4A8.4 8.4 0 1 1 20.5 11.7z"/><path d="M9 8.8c.3-.6.9-.6 1.2 0l.6 1.3c.1.3 0 .6-.2.8l-.5.5c.6 1.2 1.6 2.2 2.8 2.8l.5-.5c.2-.2.5-.3.8-.2l1.3.6c.6.3.6.9 0 1.2-1.1.7-2.5.7-3.7 0a8.6 8.6 0 0 1-3.6-3.6c-.7-1.2-.7-2.6 0-3.7z" fill="currentColor" stroke="none"/>',
  phone:
    '<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6l8.5 7 8.5-7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
// als PNG-Hintergrund: html2canvas zeichnet Bilder/SVG in verschachtelten Knöpfen sonst nicht bzw. zu klein
let waIcon: Promise<string> | null = null;
const waIconPng = () =>
  (waIcon ??= sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#fff"/><g transform="translate(3.6 3.6) scale(.7)" fill="none" stroke="#1f9d55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I.chat.replace('fill="currentColor"', 'fill="#1f9d55"')}</g></svg>`,
    ),
  )
    .png()
    .toBuffer()
    .then((b) => `data:image/png;base64,${b.toString('base64')}`));
const ico = (k: keyof typeof I) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

export interface PosterCompany {
  legal_name: string;
  city: string;
  email: string;
  phone: string | null;
  job_whatsapp: string | null;
}

export async function posterHtml(p: Posting, co: PosterCompany | undefined): Promise<string> {
  const ot = p.object_type
    ? (posterI18n.objektart as Record<string, Record<string, string>>)[p.object_type]
    : undefined;
  const timeKey = p.time_of_day === 'abends' ? 'abend' : p.time_of_day;
  const wd = workdaysText(p.workdays);
  const phone = co?.job_whatsapp ?? co?.phone ?? '';
  const wa = waNumber(phone);
  const place = [p.street, [p.postal_code, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const waText = `Hallo, ich interessiere mich für die Stelle „${p.title}“${p.city ? ` in ${p.city}` : ''}.`;
  const waUrl = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(waText)}` : null;
  const qr = waUrl
    ? await QRCode.toDataURL(waUrl, {
        margin: 0,
        width: 360,
        errorCorrectionLevel: 'M',
        color: { dark: '#1c1917' },
      })
    : null;

  const fact = (icon: keyof typeof I, value: string, label: string, wide = false) =>
    `<div class="f${wide ? ' w' : ''}"><div class="fi">${ico(icon)}</div><div><div class="fv">${esc(value)}</div><div class="fl">${esc(label)}</div></div></div>`;
  const facts = [
    place ? fact('pin', place, multi('location')) : '',
    p.hours ? fact('clock', `${hDe(p.hours)} Std. / Woche`, multi('hours')) : '',
    p.wage_cents != null ? fact('euro', `${euro(p.wage_cents)} / Std.`, multi('salary')) : '',
    timeKey ? fact('sun', T.de?.[timeKey] ?? TIMES[p.time_of_day!] ?? '', multi('workTime')) : '',
    fact('cal', p.start_on ? `ab ${dateDe(p.start_on)}` : 'ab sofort', multi('startDate')),
    wd
      ? fact('week', wd, 'Arbeitstage · Working days · Çalışma günleri · Dni pracy · Zile de lucru', true)
      : '',
  ].filter(Boolean);
  // ungerade Anzahl schmaler Kacheln → letzte schmale über die ganze Breite
  const narrow = facts.filter((f) => !f.includes('class="f w"')).length;
  if (narrow % 2 === 1) {
    const idx = facts.map((f) => !f.includes('class="f w"')).lastIndexOf(true);
    facts[idx] = facts[idx]!.replace('class="f"', 'class="f w"');
  }

  const list = (title: string, sub: string, items: string[]) =>
    items.length
      ? `<div class="blk"><div class="bh">${esc(title)}<span>${esc(sub)}</span></div><ul>${items
          .map((x) => `<li>${ico('check')}<span>${esc(x)}</span></li>`)
          .join('')}</ul></div>`
      : '';
  const offer = (T.de?.offerText ?? '')
    .split('·')
    .map((x) => x.trim())
    .filter(Boolean);
  const blocks = [
    list(T.de?.tasks ?? 'Ihre Aufgaben', multi('tasks', 1), bullets(p.tasks)),
    list(T.de?.requirements ?? 'Was wir erwarten', multi('requirements', 1), bullets(p.requirements)),
    list(T.de?.offer ?? 'Was wir bieten', multi('offer', 1), offer),
  ].filter(Boolean);

  const FN = `Stellenplakat-${p.title}`.replace(/[^\p{L}\p{N}-]+/gu, '-') + '.jpg';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="format-detection" content="telephone=no,email=no,address=no">
<title>Plakat – ${esc(p.title)}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}a{color:inherit;text-decoration:none}
body{margin:0;background:#e9e7e8;font-family:Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#1c1917;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{position:sticky;top:0;z-index:5;background:#fff;padding:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;border-bottom:1px solid #ddd}
.bar button,.bar a{font:inherit;font-size:14px;padding:9px 16px;border-radius:8px;border:0;background:#7D1435;color:#fff;cursor:pointer}
.bar a.wa{background:#1f9d55}
.sheet{--k:1;width:210mm;height:297mm;margin:14px auto;background:#fff;position:relative;overflow:hidden;font-size:calc(15px * var(--k));box-shadow:0 2px 14px rgba(0,0,0,.12)}
.in{min-height:100%;display:flex;flex-direction:column}
.hd{background:#7D1435;color:#fff;padding:2.2em 2.7em 2em;position:relative;overflow:hidden}
.hd:after{content:"";position:absolute;right:-6em;top:-6em;width:18em;height:18em;border-radius:50%;background:rgba(255,255,255,.06)}
.hd .top{display:flex;justify-content:space-between;align-items:center;gap:1em}
.hd img{height:4.6em;display:block}
.hd .tag{font-size:.75em;letter-spacing:.14em;text-transform:uppercase;opacity:.85;text-align:right;line-height:1.5}
.hd h1{font-size:2.9em;line-height:1.08;margin:.7em 0 0;font-weight:800;letter-spacing:-.01em}
.hd .sub{margin-top:.6em;display:flex;flex-wrap:wrap;gap:.5em;font-size:.95em}
.hd .pill{background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);padding:.25em .8em;border-radius:2em}
.body{padding:1.6em 2.7em 1.2em;display:flex;flex-direction:column;gap:1.1em;flex:1}
.ot{display:flex;gap:.9em;align-items:center;background:#f9f1f3;border-left:.3em solid #7D1435;border-radius:.6em;padding:.8em 1.1em}
.ot .fi{color:#7D1435}.ot b{font-size:1.25em;display:block}.ot span{font-size:.72em;color:#6b5f63}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:.7em}
.f{display:flex;gap:.8em;align-items:flex-start;border:1px solid #ece6e8;border-radius:.7em;padding:.8em 1em;background:#fff}
.f.w{grid-column:1/-1}
.fi{flex:none;width:2.3em;height:2.3em;border-radius:50%;background:#f6e9ed;color:#7D1435;display:flex;align-items:center;justify-content:center}
.fi svg{width:1.3em;height:1.3em}
.fv{font-size:1.32em;font-weight:800;line-height:1.2}
.fl{font-size:.66em;color:#78716c;margin-top:.3em;line-height:1.35}
.blks{display:grid;grid-template-columns:repeat(auto-fit,minmax(14em,1fr));gap:1.1em}
.bh{font-weight:800;font-size:1.02em;color:#7D1435;border-bottom:2px solid #f0dfe4;padding-bottom:.35em;margin-bottom:.45em}
.bh span{display:block;font-size:.62em;font-weight:500;color:#8a7d81;margin-top:.15em}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.35em}
li{display:flex;gap:.5em;font-size:.88em;line-height:1.35}
li svg{flex:none;width:1.1em;height:1.1em;margin-top:.12em;color:#1f9d55}
.ft{margin-top:auto;background:#fbf7f8;border-top:1px solid #efe4e7;padding:1.4em 2.7em 1.5em;display:flex;gap:1.6em;align-items:center}
.ft .l{flex:1;min-width:0}
.ft .k{font-size:.72em;letter-spacing:.14em;text-transform:uppercase;color:#7D1435;font-weight:700}
.wal{display:block;width:max-content}.wab{background-color:#1f9d55;background-repeat:no-repeat;background-position:.6em 50%;background-size:1.9em 1.9em;color:#fff!important;border-radius:3em;padding:.75em 1.4em .75em 3.1em;line-height:1.2;margin:.55em 0 .5em;font-weight:800;font-size:1.15em}
.ph{font-size:2.6em;font-weight:800;line-height:1.1;letter-spacing:-.01em}
.ct{display:flex;flex-wrap:wrap;gap:.3em 1.2em;margin-top:.35em;font-size:.9em;color:#44403c}
.ct span{display:inline-flex;align-items:center;gap:.35em}.ct svg{width:1em;height:1em;color:#7D1435}
.ml{font-size:.62em;color:#8a7d81;margin-top:.6em;line-height:1.4}
.qr{flex:none;text-align:center;background:#fff;border:1px solid #ece6e8;border-radius:.8em;padding:.7em .7em .5em}
.qr img{width:8.2em;height:8.2em;display:block}
.qr div{font-size:.66em;font-weight:700;color:#1f9d55;margin-top:.4em;line-height:1.3}
.co{background:#7D1435;color:rgba(255,255,255,.85);font-size:.66em;text-align:center;padding:.6em 2em}
@media print{body{background:#fff}.bar{display:none}.sheet{margin:0;box-shadow:none;height:296mm}}
</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button> <button id="jpg" type="button">Als Bild speichern / teilen</button>${waUrl ? ` <a class="wa" href="${esc(waUrl)}" target="_blank" rel="noopener">WhatsApp testen</a>` : ''}</div>
<div class="sheet" id="sheet"><div class="in" id="in">
<div class="hd"><div class="top"><img src="/static/logo-hell.png" alt="Viva-Deluxe"><div class="tag">${esc(T.de?.title ?? 'Stellenangebot')}<br>${esc([T.en?.title, T.tr?.title, T.pl?.title, T.ro?.title].filter(Boolean).join(' · '))}</div></div>
<h1>${esc(p.title)}</h1><div class="sub">${p.job_type && p.job_type !== p.title ? `<span class="pill">${esc(p.job_type)}</span>` : ''}${p.city ? `<span class="pill">${esc(p.city)}</span>` : ''}</div></div>
<div class="body">
${
  ot
    ? `<div class="ot"><div class="fi">${ico('bld')}</div><div><b>${esc(ot.de ?? '')}</b><span>${esc(
        ORDER.slice(1)
          .map((l) => ot[l])
          .filter(Boolean)
          .join(' · '),
      )}</span></div></div>`
    : ''
}
<div class="facts">${facts.join('')}</div>
${blocks.length ? `<div class="blks">${blocks.join('')}</div>` : ''}
</div>
<div class="ft"><div class="l"><div class="k">${esc(T.de?.contact ?? 'Kontakt & Bewerbung')}</div>
${waUrl ? `<a class="wal" href="${esc(waUrl)}" target="_blank" rel="noopener"><div class="wab" style="background-image:url('${await waIconPng()}')">Jetzt per WhatsApp bewerben</div></a>` : ''}
<div class="ph">${esc(phone || 'Nummer unter Einstellungen → Firmendaten eintragen')}</div>
<div class="ct">${phone ? `<span>${ico('phone')}Anruf &amp; WhatsApp</span>` : ''}${co?.email ? `<span>${ico('mail')}${esc(co.email)}</span>` : ''}</div>
<div class="ml">${esc(
    ORDER.map((l) => T[l]?.contactText)
      .filter(Boolean)
      .join(' · '),
  )}</div></div>
${qr ? `<div class="qr"><img src="${qr}" alt="QR-Code WhatsApp"><div>QR scannen<br>→ WhatsApp</div></div>` : ''}</div>
<div class="co">${esc([co?.legal_name, co?.city].filter(Boolean).join(' · '))}</div>
</div></div>
<script src="/static/vendor/html2canvas.min.js"></script>
<script>
var FN = ${JSON.stringify(FN)};
// Inhalt passt nicht auf A4 → Schrift schrittweise verkleinern statt abschneiden
function fit() {
  var s = document.getElementById('sheet'), inn = document.getElementById('in'), k = 1;
  s.style.setProperty('--k', '1');
  while (inn.scrollHeight > s.clientHeight + 1 && k > 0.55) { k -= 0.025; s.style.setProperty('--k', String(k)); }
}
fit(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
var jb = document.getElementById('jpg'), blob = null, url = null;
function render() {
  var el = document.getElementById('sheet');
  // ca. 150 dpi (A4 = 1240 × 1754 px)
  return html2canvas(el, { scale: 1240 / el.offsetWidth, backgroundColor: '#ffffff', useCORS: false }).then(function (cv) {
    url = cv.toDataURL('image/jpeg', 0.92);
    return new Promise(function (r) { cv.toBlob(function (bl) { blob = bl; r(); }, 'image/jpeg', 0.92); });
  });
}
// vorab erzeugen: Teilen am Handy muss direkt nach dem Antippen starten
var ready = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { fit(); return render(); }).catch(function () {});
function showImg() {
  var o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;gap:12px';
  o.innerHTML = '<div style="color:#fff;font-size:15px;text-align:center">Bild lange gedrückt halten → „In Fotos sichern“ bzw. „Bild speichern“</div>';
  var i = new Image(); i.src = url; i.style.cssText = 'max-width:100%;max-height:80vh;background:#fff';
  var x = document.createElement('button'); x.textContent = 'Schließen'; x.onclick = function () { o.remove(); };
  o.appendChild(i); o.appendChild(x); document.body.appendChild(o);
}
jb.addEventListener('click', async function () {
  if (!blob) { jb.disabled = true; jb.textContent = 'Wird erstellt …'; await ready; if (!blob) await render().catch(function (e) { alert('Bild konnte nicht erstellt werden: ' + e); }); jb.disabled = false; jb.textContent = 'Als Bild speichern / teilen'; if (!blob) return; }
  var file = new File([blob], FN, { type: 'image/jpeg' });
  var touch = matchMedia('(pointer:coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: FN }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; showImg(); return; }
  }
  if (touch) { showImg(); return; }
  var a = document.createElement('a'); a.href = url; a.download = FN;
  document.body.appendChild(a); a.click(); a.remove();
});
</script></body></html>`;
}
