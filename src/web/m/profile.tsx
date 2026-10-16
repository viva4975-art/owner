import type { FC } from 'hono/jsx';

/**
 * Profil in den Apps (Mitarbeiter-App /m und Objektleitung/Büro /qm) wie Fortytools (Ahmed 15.10.):
 * Name + E-Mail, App-Tour, App-Berechtigungen, Über die App (Datenschutz, Lizenzen, Version), Abmelden.
 * Texte kommen über `tx` (in /m übersetzt, in /qm Deutsch).
 */
export type Tx = (key: string) => string;

export const PROFILE_CSS = `
.avatar{width:38px;height:38px;border-radius:999px;background:#f3e3e9;color:#7D1435!important;display:flex!important;align-items:center;justify-content:center;font-weight:700;font-size:14px!important;letter-spacing:.02em;text-decoration:none;flex:none;padding:0!important}
.pf-head{display:flex;align-items:center;gap:16px;padding:8px 2px 4px}
.pf-head .av{width:72px;height:72px;border-radius:999px;background:#f3e3e9;color:#7D1435;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:650;flex:none}
.pf-head b{display:block;font-size:20px;color:#2a1420}
.pf-head small{display:block;color:#8a7680;font-size:14px;word-break:break-all}
.pf-co{color:#5b4650;font-size:15px;padding:0 2px}
.pf-list{background:#fff;border-radius:14px;border:1px solid #efe3e7;overflow:hidden}
.pf-list>h3{margin:0;padding:14px 16px 6px;font-size:14px;color:#2a1420}
.pf-list a,.pf-list .row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:15px 16px;border-top:1px solid #f3eaee;color:#2a1420;text-decoration:none;font-size:16px}
.pf-list>h3+a,.pf-list>h3+.row{border-top:0}
.pf-list a:after{content:'→';color:#7D1435;font-size:18px}
.pf-list .row span:last-child{color:#8a7680;font-size:14px;text-align:right}
.pf-out{background:none;border:0;color:#b4235a;font:inherit;font-size:16px;padding:14px 2px;cursor:pointer;text-align:left}
.perm{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid #f3eaee}
.perm:first-of-type{border-top:0}
.perm .pi{flex:1}.perm .pi b{display:block;font-size:16px}.perm .pi small{color:#8a7680;font-size:13.5px}
.perm .ps{font-size:13px;font-weight:650;padding:4px 10px;border-radius:999px;background:#f1eef0;color:#5b4650;white-space:nowrap}
.perm .ps.ok{background:#e9f7ee;color:#15803d}.perm .ps.no{background:#fdeceb;color:#b42318}
.perm button{margin-top:8px;border:1px solid #e3cfd7;background:#fff;color:#7D1435;border-radius:10px;padding:8px 12px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.legal{background:#fff;border-radius:14px;border:1px solid #efe3e7;padding:16px;font-size:14.5px;line-height:1.5}
.legal h2{font-size:16px;margin:16px 0 4px}.legal h2:first-child{margin-top:0}.legal p,.legal ul{margin:4px 0}
.tour-hole{position:fixed;z-index:1000;border-radius:14px;box-shadow:0 0 0 9999px rgba(30,8,18,.62);pointer-events:none;transition:all .25s}
.tour-card{position:fixed;left:12px;right:12px;z-index:1001;background:#fff;border-radius:16px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.3);max-width:520px;margin:0 auto}
.tour-card p{margin:0 0 12px;font-size:16px;line-height:1.45;color:#2a1420}
.tour-card .tb{display:flex;align-items:center;gap:10px}.tour-card .tb small{flex:1;color:#8a7680}
.tour-card button{border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:650;cursor:pointer}
.tour-card .nx{background:#7D1435;color:#fff}.tour-card .sk{background:none;color:#5b4650}
`;

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 2)
    .join('') || '?';

export const Avatar: FC<{ name: string; href: string; label: string }> = ({ name, href, label }) => (
  <a href={href} class="avatar" aria-label={label}>
    {initials(name)}
  </a>
);

export const ProfileBody: FC<{
  tx: Tx;
  name: string;
  email: string | null;
  company: string;
  base: string;
  logout: string;
  /** zusätzliche Zeilen (z. B. Sprache, Passwort) */
  extra?: { href: string; label: string }[];
}> = ({ tx, name, email, company, base, logout, extra = [] }) => (
  <>
    <div class="pf-head">
      <span class="av">{initials(name)}</span>
      <div>
        <b>{name}</b>
        {email && <small>{email}</small>}
      </div>
    </div>
    <div class="pf-co">{company}</div>
    <div class="pf-list">
      <h3>{tx('pf_general')}</h3>
      <a href={`${base}?tour=1`}>{tx('pf_tour')}</a>
      <a href={`${base}/profil/berechtigungen`}>{tx('pf_perms')}</a>
      {extra.map((e) => (
        <a href={e.href}>{e.label}</a>
      ))}
      <a href={`${base}/profil/app`}>{tx('pf_about')}</a>
    </div>
    <form method="post" action={logout} style="margin:0">
      <button class="pf-out">{tx('logout')}</button>
    </form>
  </>
);

/** Berechtigungen: Mitteilungen, Kamera (QR, Fotos), Standort (nur beim Stempeln, wenn eingeschaltet). */
export const PermissionsBody: FC<{ tx: Tx; pushSave: string }> = ({ tx, pushSave }) => (
  <>
    <p style="margin:0;color:#5b4650;font-size:15px">{tx('perm_intro')}</p>
    <div class="pf-list" id="perms" data-save={pushSave}>
      {(
        [
          ['notifications', 'perm_notify', 'perm_notify_why'],
          ['camera', 'perm_camera', 'perm_camera_why'],
          ['geolocation', 'perm_location', 'perm_location_why'],
        ] as const
      ).map(([k, title, why]) => (
        <div class="perm" data-perm={k}>
          <div class="pi">
            <b>{tx(title)}</b>
            <small>{tx(why)}</small>
            <div>
              <button type="button" hidden>
                {tx('perm_allow')}
              </button>
            </div>
          </div>
          <span class="ps">…</span>
        </div>
      ))}
    </div>
    <p style="margin:0;color:#8a7680;font-size:13.5px">{tx('perm_settings_hint')}</p>
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){var L=${JSON.stringify({
          ok: tx('perm_ok'),
          no: tx('perm_no'),
          ask: tx('perm_ask'),
          na: tx('perm_na'),
        })};
function set(row,st){var s=row.querySelector('.ps'),b=row.querySelector('button');s.className='ps'+(st==='granted'?' ok':st==='denied'?' no':'');
s.textContent=st==='granted'?L.ok:st==='denied'?L.no:st==='na'?L.na:L.ask;b.hidden=st!=='prompt';}
function q(name,row){if(name==='notifications'){if(!('Notification' in window)){set(row,'na');return;}set(row,Notification.permission==='default'?'prompt':Notification.permission);return;}
if(!navigator.permissions||!navigator.permissions.query){set(row,name==='camera'&&!(navigator.mediaDevices)?'na':'prompt');return;}
navigator.permissions.query({name:name}).then(function(p){set(row,p.state);p.onchange=function(){set(row,p.state)}}).catch(function(){set(row,'prompt')});}
[].forEach.call(document.querySelectorAll('[data-perm]'),function(row){var name=row.dataset.perm;q(name,row);
row.querySelector('button').onclick=function(){
if(name==='notifications'){var pb=document.getElementById('push');if(pb&&pb.querySelector('button')){pb.querySelector('button').click();setTimeout(function(){q(name,row)},1500);}else Notification.requestPermission().then(function(){q(name,row)});}
else if(name==='camera'){navigator.mediaDevices.getUserMedia({video:true}).then(function(s){s.getTracks().forEach(function(t){t.stop()});set(row,'granted')}).catch(function(){q(name,row)});}
else navigator.geolocation.getCurrentPosition(function(){set(row,'granted')},function(){q(name,row)});};});})();`,
      }}
    />
  </>
);

export const AboutBody: FC<{ tx: Tx; base: string; version: string; privacy: string }> = ({
  tx,
  base,
  version,
  privacy,
}) => (
  <div class="pf-list">
    <a href={privacy}>{tx('pf_privacy')}</a>
    <a href={`${base}/profil/lizenzen`}>{tx('pf_licenses')}</a>
    <div class="row">
      <span>{tx('pf_version')}</span>
      <span id="appver">{version}</span>
    </div>
  </div>
);

/** Verwendete freie Software (Auszug der wichtigsten Bestandteile). */
const LICENSES: [string, string, string][] = [
  ['Inter (Schrift)', 'Rasmus Andersson', 'SIL Open Font License 1.1'],
  ['DejaVu Sans (Schrift)', 'DejaVu fonts team', 'Bitstream Vera / Public Domain'],
  ['Capacitor', 'Ionic', 'MIT'],
  ['ML Kit Barcode Scanning (Capacitor)', 'Robin Genz', 'Apache 2.0'],
  ['Hono', 'Yusuke Wada', 'MIT'],
  ['postgres.js', 'Rasmus Porsager', 'Unlicense'],
  ['pdf-lib', 'Andrew Dillon', 'MIT'],
  ['@e-invoice-eu/core', 'Guido Flohr', 'WTFPL'],
  ['xmlbuilder2', 'Ozgur Ozcitak', 'MIT'],
  ['fflate', '101arrowz', 'MIT'],
  ['unpdf / PDF.js', 'Mozilla, Johann Schopplich', 'Apache 2.0 / MIT'],
  ['web-push', 'web-push-libs', 'MPL 2.0'],
  ['zod', 'Colin McDonnell', 'MIT'],
  ['Lucide (Symbole)', 'Lucide Contributors', 'ISC'],
  ['KoSIT-Validator (Prüfung E-Rechnung)', 'KoSIT', 'Apache 2.0'],
];

export const LicensesBody: FC = () => (
  <div class="pf-list">
    {LICENSES.map(([n, a, l]) => (
      <div class="row">
        <span>
          {n}
          <br />
          <small style="color:#8a7680">{a}</small>
        </span>
        <span>{l}</span>
      </div>
    ))}
  </div>
);

export interface CompanyInfo {
  legal_name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  managing_director: string | null;
}

/**
 * Datenschutzhinweise der App (Art. 13 DSGVO), öffentlich unter /m/datenschutz – auch als Adresse für App Store /
 * Google Play. Stand der Verarbeitung laut App; vor dem Einreichen von einem Fachanwalt / Datenschutzberater prüfen lassen.
 */
export const PrivacyBody: FC<{ co: CompanyInfo }> = ({ co }) => (
  <div class="legal">
    <h2>Datenschutzhinweise zur Viva-Deluxe-App</h2>
    <p>Stand: Oktober 2026</p>
    <h2>1. Verantwortlicher</h2>
    <p>
      {co.legal_name}
      <br />
      {co.street}, {co.postal_code} {co.city}
      <br />
      {co.phone && <>Tel. {co.phone} · </>}
      {co.email}
      {co.managing_director && (
        <>
          <br />
          Geschäftsführung: {co.managing_director}
        </>
      )}
    </p>
    <p>Fragen zum Datenschutz richten Sie bitte an die oben genannte Adresse (Betreff „Datenschutz“).</p>
    <h2>2. Wofür ist die App?</h2>
    <p>
      Die App ist ein internes Arbeitsmittel für unsere Beschäftigten, Objektleitungen und das Büro: Einsätze
      ansehen, Arbeitszeit erfassen und bestätigen, Urlaub und Abwesenheiten beantragen, Dokumente lesen und
      unterschreiben, Lohnabrechnungen abrufen, Qualitätskontrollen und Arbeitsscheine erstellen. Sie ist nur
      mit einem Zugang nutzbar, den wir vergeben.
    </p>
    <h2>3. Welche Daten verarbeiten wir?</h2>
    <ul>
      <li>Stammdaten: Name, Personalnummer, Kontaktdaten, Sprache, zugeordnete Objekte.</li>
      <li>
        Arbeitszeit: Beginn, Ende, Pausen, Objekt, Bestätigungen, Nachträge und Änderungen (mit Protokoll).
      </li>
      <li>Abwesenheiten: Urlaub, Krankheit (nur „krank“, nie eine Diagnose), sonstige Abwesenheiten.</li>
      <li>Unterschriften und Bestätigungen zu Dokumenten, Arbeitsscheinen und Stundenlisten.</li>
      <li>
        Standort: nur im Moment des Ein- und Ausstempelns (Nachweis der Anwesenheit am Einsatzort).
        Gespeichert wird nur, ob Sie am Objekt waren, die Entfernung und die Genauigkeit – keine
        Bewegungsprofile.
      </li>
      <li>
        Kamera: nur zum Scannen des QR-Codes am Objekt und für Fotos, die Sie selbst aufnehmen (z. B.
        Qualitätskontrolle, Personalbogen). Bei Fotos der Qualitätskontrolle werden Aufnahmezeit und Standort
        zum Foto gespeichert.
      </li>
      <li>Mitteilungen: ein technischer Schlüssel Ihres Geräts, damit wir Ihnen Hinweise schicken können.</li>
      <li>Technische Daten: Anmeldezeitpunkt, IP-Adresse und Gerät bei Unterschriften (als Nachweis).</li>
    </ul>
    <h2>4. Rechtsgrundlagen</h2>
    <p>
      Durchführung des Arbeitsverhältnisses (Art. 6 Abs. 1 lit. b DSGVO, § 26 BDSG), gesetzliche Pflichten –
      u. a. Arbeitszeitaufzeichnung nach § 17 MiLoG, Lohn- und Steuerrecht (Art. 6 Abs. 1 lit. c DSGVO), bei
      Abwesenheitsgründen Art. 9 Abs. 2 lit. b DSGVO, sowie unser berechtigtes Interesse an einer
      nachvollziehbaren Leistungserbringung gegenüber Kunden (Art. 6 Abs. 1 lit. f DSGVO). Mitteilungen und
      Kamera nutzen wir nur mit Ihrer Freigabe auf dem Gerät.
    </p>
    <h2>5. Empfänger</h2>
    <p>
      Die Daten liegen auf unserem Server bei der IONOS SE in Deutschland (Auftragsverarbeitung nach Art. 28
      DSGVO). Lohndaten gehen an unser Lohnprogramm bzw. unseren Steuerberater, soweit für die Abrechnung
      nötig; Prüfbehörden (z. B. Zoll) erhalten Arbeitszeitnachweise, wenn das Gesetz es verlangt. Keine
      Werbung, kein Tracking, keine Weitergabe an Dritte zu anderen Zwecken. Mitteilungen werden über den
      Push-Dienst Ihres Geräteherstellers (Google bzw. Apple) zugestellt; Inhalte sind kurz und enthalten
      keine Gesundheitsdaten.
    </p>
    <h2>6. Speicherdauer</h2>
    <p>
      Arbeitszeitaufzeichnungen mindestens 2 Jahre (§ 17 MiLoG), Lohn- und Buchungsunterlagen 6 bzw. 10 Jahre
      (§ 147 AO, § 257 HGB), sonstige Daten bis zum Ende des Arbeitsverhältnisses bzw. solange Ansprüche
      geltend gemacht werden können. Danach werden sie gelöscht.
    </p>
    <h2>7. Ihre Rechte</h2>
    <p>
      Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung,
      Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO). Eine Einwilligung können Sie jederzeit
      widerrufen; Gerätefreigaben (Mitteilungen, Kamera, Standort) können Sie in den Einstellungen Ihres
      Handys abschalten. Sie können sich bei einer Datenschutz-Aufsichtsbehörde beschweren, für uns zuständig:
      Bayerisches Landesamt für Datenschutzaufsicht, Promenade 18, 91522 Ansbach.
    </p>
    <h2>8. Sicherheit</h2>
    <p>
      Alle Verbindungen sind verschlüsselt (HTTPS). Zugänge sind durch PIN bzw. Passwort geschützt und werden
      nach mehreren Fehlversuchen gesperrt. Jede Person sieht nur die Daten, die sie für ihre Aufgabe braucht.
    </p>
  </div>
);

/** App-Tour: Schritte mit Ziel-Element; fehlende Ziele werden übersprungen. Startet beim ersten Öffnen und mit ?tour=1. */
export function tourJs(
  key: string,
  steps: { sel: string; text: string }[],
  l: { next: string; skip: string; done: string },
) {
  return `(function(){var S=${JSON.stringify(steps)},L=${JSON.stringify(l)},K=${JSON.stringify(key)};
var force=/[?&]tour=1/.test(location.search);var seen=false;try{seen=localStorage.getItem(K)==='1'}catch(e){}
if(!force&&(seen||navigator.webdriver))return;
var steps=S.filter(function(s){var el=document.querySelector(s.sel);return el&&el.getClientRects().length});if(!steps.length)return;
var hole=document.createElement('div');hole.className='tour-hole';var card=document.createElement('div');card.className='tour-card';document.body.appendChild(hole);document.body.appendChild(card);
var i=0;function end(){hole.remove();card.remove();try{localStorage.setItem(K,'1')}catch(e){}if(force)history.replaceState(null,'',location.pathname);}
function show(){var s=steps[i],el=document.querySelector(s.sel);el.scrollIntoView({block:'center'});setTimeout(function(){var r=el.getBoundingClientRect(),p=6;
hole.style.left=(r.left-p)+'px';hole.style.top=(r.top-p)+'px';hole.style.width=(r.width+2*p)+'px';hole.style.height=(r.height+2*p)+'px';
card.innerHTML='';var t=document.createElement('p');t.textContent=s.text;var b=document.createElement('div');b.className='tb';var n=document.createElement('small');n.textContent=(i+1)+' / '+steps.length;
var sk=document.createElement('button');sk.className='sk';sk.type='button';sk.textContent=L.skip;sk.onclick=end;var nx=document.createElement('button');nx.className='nx';nx.type='button';nx.textContent=i===steps.length-1?L.done:L.next;
nx.onclick=function(){i++;if(i>=steps.length)end();else show()};b.appendChild(n);if(i<steps.length-1)b.appendChild(sk);b.appendChild(nx);card.appendChild(t);card.appendChild(b);
var below=r.top+r.height/2<innerHeight/2;card.style.top=below?Math.min(innerHeight-card.offsetHeight-12,r.bottom+16)+'px':'auto';card.style.bottom=below?'auto':Math.max(12,innerHeight-r.top+16)+'px';},250);}
show();})();`;
}
