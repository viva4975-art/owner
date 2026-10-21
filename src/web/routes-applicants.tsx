import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  APPLICANT_STATUS,
  CONTACT_KINDS,
  CONTACT_RESULTS,
  RATINGS,
  addApplicantContact,
  deleteApplicantContact,
  setApplicantRating,
  type Criteria,
  DAYS,
  EXPERIENCE,
  JOB_TYPES,
  LANGUAGES,
  OBJECT_TYPES,
  type Posting,
  TEMPLATES,
  TIMES,
  type Workdays,
  addDocument,
  deleteApplicant,
  deleteDocument,
  deletePosting,
  deletionDue,
  getApplicant,
  getDocument,
  getPosting,
  listApplicants,
  listPostings,
  matches,
  postingCriteria,
  saveApplicant,
  savePosting,
  score,
  setApplicantStatus,
  setPostingStatus,
  workdaysText,
} from '../services/applicants.js';
import { BusinessError } from '../services/errors.js';
import { type Ctx, UUID } from './app.js';
import { arr, centsToInput, str } from './forms.js';
import { posterHtml } from './job-poster.js';
import { dateDe, euro, anz } from './layout.js';

const BwTabs = ({ active }: { active: string }) => (
  <div class="tabs">
    <a href="/bewerber" class={active === 'stellen' ? 'on' : ''}>
      Offene Stellen
    </a>
    <a href="/bewerber/pool" class={active === 'pool' ? 'on' : ''}>
      Bewerber-Pool
    </a>
    <a href="/bewerber/matching" class={active === 'matching' ? 'on' : ''}>
      Manuelles Matching
    </a>
  </div>
);

const Opt = ({
  list,
  sel,
  empty,
}: {
  list: [string, string][];
  sel: string | null | undefined;
  empty?: string;
}) => (
  <>
    {empty !== undefined && <option value="">{empty}</option>}
    {list.map(([v, l]) => (
      <option value={v} selected={sel === v}>
        {l}
      </option>
    ))}
  </>
);
const pairs = (a: string[]): [string, string][] => a.map((x) => [x, x]);
const objLabel = (k: string | null) => OBJECT_TYPES.find(([v]) => v === k)?.[1] ?? k ?? '';
const pct = (n: number) => (n >= 75 ? 'ok' : n >= 50 ? 'warn' : '');
const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
/** Stunden mit Komma oder Punkt (32,5) */
const hrs = (s: string | null) =>
  s && /^\d{1,2}([.,]\d{1,2})?$/.test(s.trim()) ? Number(s.trim().replace(',', '.')) : null;
const hDe = (h: number | null | undefined) => (h ? String(h).replace('.', ',') : '');

/** Bewerber + Stellenanzeigen wie die alte App. */
export function registerApplicantRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  // ------------------------------------------------------------------ Offene Stellen
  app.get('/bewerber', async (c) => {
    const [posts, pool] = await Promise.all([listPostings(sql), listApplicants(sql)]);
    const open = posts.filter((p) => p.status === 'aktiv');
    const closed = posts.filter((p) => p.status === 'geschlossen');
    const card = (p: Posting) => {
      const m = matches(pool, postingCriteria(p));
      return (
        <a class={`lc${p.status === 'geschlossen' ? ' lc-inactive' : ''}`} href={`/bewerber/stellen/${p.id}`}>
          <div class="lc-head">
            <div>
              <span class="lc-name">{p.title}</span>
              <div class="lc-details">
                {p.city && <span>{p.city}</span>}
                {p.hours && <span>{hDe(p.hours)}h/Woche</span>}
                {p.wage_cents != null && <span>{euro(p.wage_cents)}/h</span>}
                <span>ab {p.start_on ? dateDe(p.start_on) : 'sofort'}</span>
                {p.website && p.status === 'aktiv' && <span class="badge brand">Website</span>}
              </div>
            </div>
            <div class="bw-count">
              <span>Passende Bewerber</span>
              <b class={m.length ? 'kb-pos' : ''}>{m.length}</b>
            </div>
          </div>
          {m.length > 0 && (
            <div class="lc-foot bw-chips">
              {m.slice(0, 3).map((x) => (
                <span class="badge ok">
                  {x.a.name} · {x.percent}%
                </span>
              ))}
              {m.length > 3 && <span class="small mut">+{m.length - 3} weitere</span>}
            </div>
          )}
        </a>
      );
    };
    return page(
      c,
      'Offene Stellen',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Personalmanagement</div>
            <h1>Offene Stellen</h1>
            <div class="sub">
              {open.length} aktiv{closed.length ? ` · ${closed.length} geschlossen` : ''}
            </div>
          </div>
          <div class="acts">
            <a class="btn" href={`/bewerber/stellen/${randomUUID()}/bearbeiten`}>
              + Neue Stelle
            </a>
          </div>
        </div>
        <BwTabs active="stellen" />
        {posts.length === 0 ? (
          <div class="empty">
            <b>Noch keine Stellen angelegt</b>
            <div class="small">
              Erstelle eine Stellenausschreibung – auswählen aus Vorlagen wie Reinigungskraft, Hausmeister,
              Büro etc.
            </div>
            <a class="btn" style="margin-top:10px" href={`/bewerber/stellen/${randomUUID()}/bearbeiten`}>
              Erste Stelle anlegen
            </a>
          </div>
        ) : (
          <div class="list-cards">{open.map(card)}</div>
        )}
        {closed.length > 0 && (
          <>
            <h3 style="margin-top:24px">Geschlossene Stellen</h3>
            <div class="list-cards" style="opacity:.7">
              {closed.map(card)}
            </div>
          </>
        )}
      </div>,
    );
  });

  /**
   * Offene Stellen nur lesen (Ahmed 14.10.: Objektleitung soll die Stellen sehen) – ohne Bewerber/Matching, mit Plakat
   * zum Aushängen bzw. Weiterschicken. Bewerberdaten bleiben bei Admin/Personal.
   */
  app.get('/stellen', async (c) => {
    const posts = (await listPostings(sql)).filter((p) => p.status === 'aktiv');
    return page(
      c,
      'Offene Stellen',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <h1>Offene Stellen</h1>
            <div class="sub">
              {anz(posts.length, 'offene Stelle', 'offene Stellen')} · Interessenten bitte an das Büro bzw.
              die WhatsApp-Nummer auf dem Plakat verweisen.
            </div>
          </div>
        </div>
        {posts.length === 0 ? (
          <div class="empty">
            <b>Derzeit keine offenen Stellen</b>
          </div>
        ) : (
          <div class="list-cards">
            {posts.map((p) => (
              <div class="lc">
                <div class="lc-head">
                  <div>
                    <span class="lc-name">{p.title}</span>
                    <div class="lc-details">
                      {p.city && <span>{p.city}</span>}
                      {p.hours && <span>{hDe(p.hours)}h/Woche</span>}
                      <span>ab {p.start_on ? dateDe(p.start_on) : 'sofort'}</span>
                    </div>
                    {p.tasks && (
                      <div class="small mut" style="margin-top:6px;white-space:pre-line">
                        {p.tasks}
                      </div>
                    )}
                  </div>
                  <a class="btn sec" href={`/bewerber/stellen/${p.id}/plakat`}>
                    Plakat
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>,
    );
  });

  app.get(`/bewerber/stellen/:id{${UUID}}`, async (c) => {
    const p = await getPosting(sql, c.req.param('id'));
    if (!p) return c.notFound();
    const m = matches(await listApplicants(sql), postingCriteria(p));
    const kv = (k: string, v: string | null | undefined) =>
      v ? (
        <div>
          <span class="small mut">{k}</span>
          <div>
            <b>{v}</b>
          </div>
        </div>
      ) : null;
    return page(
      c,
      p.title,
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/bewerber">Offene Stellen</a> · {p.job_type}
            </div>
            <h1>{p.title}</h1>
            <div class="sub">
              <span class={`badge ${p.status === 'aktiv' ? 'ok' : ''}`}>
                {p.status === 'aktiv' ? 'Aktiv' : 'Geschlossen'}
              </span>
            </div>
          </div>
          <div class="acts">
            <a class="btn" href={`/bewerber/stellen/${p.id}/bearbeiten`}>
              Bearbeiten
            </a>
            <a class="btn sec" href={`/bewerber/stellen/${randomUUID()}/bearbeiten?kopie=${p.id}`}>
              Kopieren
            </a>
          </div>
        </div>
        <div class="cols">
          <div>
            <div class="card">
              <div class="bw-kv">
                {kv(
                  'Adresse',
                  [p.street, [p.postal_code, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
                )}
                {kv('Objektart', objLabel(p.object_type))}
                {kv('Stunden', p.hours ? `${hDe(p.hours)} h / Woche` : null)}
                {kv('Lohn', p.wage_cents != null ? `${euro(p.wage_cents)} / h brutto` : null)}
                {kv('Arbeitszeit', p.time_of_day ? TIMES[p.time_of_day] : null)}
                {kv('Beginn', p.start_on ? `ab ${dateDe(p.start_on)}` : 'sofort')}
                {kv('Sprache', p.language)}
                {kv('Arbeitstage', workdaysText(p.workdays))}
              </div>
              {p.tasks && (
                <>
                  <h4>Aufgaben</h4>
                  <p>{p.tasks}</p>
                </>
              )}
              {p.requirements && (
                <>
                  <h4>Voraussetzungen</h4>
                  <p>{p.requirements}</p>
                </>
              )}
            </div>
            <div class="card">
              <h3>Stellenausschreibung als Plakat</h3>
              <p class="small mut">
                A4-Plakat mit den wichtigsten Eckdaten in 9 Sprachen (DE · EN · TR · AR · RU · PL · RO · HU ·
                EL) und Handy-/WhatsApp-Nummer prominent. Ideal für Aushänge. Auf der Plakatseite „Als Bild
                speichern / teilen“ (z. B. für WhatsApp/Social Media) oder im Druckdialog „Als PDF speichern“
                wählen.
              </p>
              <a class="btn" href={`/bewerber/stellen/${p.id}/plakat`} target="_blank">
                Plakat öffnen (A4)
              </a>
            </div>
            <div class="actions">
              <form method="post" action={`/bewerber/stellen/${p.id}/status`} class="inline-form">
                <input type="hidden" name="status" value={p.status === 'aktiv' ? 'geschlossen' : 'aktiv'} />
                <button class="btn sec">
                  {p.status === 'aktiv' ? 'Stelle als besetzt markieren' : 'Stelle wieder öffnen'}
                </button>
              </form>
              <form method="post" action={`/bewerber/stellen/${p.id}/loeschen`} class="inline-form">
                <button class="btn danger" data-confirm="Stelle löschen?">
                  Löschen
                </button>
              </form>
            </div>
          </div>
          <div class="card">
            <h3>Passende Bewerber ({m.length})</h3>
            <p class="small mut">ab 50% Match-Score</p>
            {m.length === 0 ? (
              <p class="small mut">
                Keine passenden Bewerber im Pool. Sobald neue Bewerber dazukommen, erscheinen sie hier
                automatisch.
              </p>
            ) : (
              m.map((x) => (
                <a class="bw-match" href={`/bewerber/pool/${x.a.id}`}>
                  <div>
                    <b>{x.a.name}</b>
                    <div class="small mut">
                      {[x.a.job_type, x.a.hours ? `${hDe(x.a.hours)} h` : null, x.a.city]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div class="small kb-pos">
                      {x.hit
                        .slice(0, 3)
                        .map((h) => `✓ ${h}`)
                        .join('  ')}
                    </div>
                  </div>
                  <span class={`badge ${pct(x.percent)}`}>{x.percent}%</span>
                </a>
              ))
            )}
          </div>
        </div>
      </div>,
    );
  });

  app.get(`/bewerber/stellen/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const cur = await getPosting(sql, id);
    const kopieId = c.req.query('kopie');
    const src =
      !cur && kopieId && /^[0-9a-f-]{36}$/i.test(kopieId) ? await getPosting(sql, kopieId) : undefined;
    const p = cur ?? src;
    const nextMonth = (() => {
      const [y, m] = todayBerlin().split('-').map(Number) as [number, number];
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    })();
    const wd: Workdays = p?.workdays ?? {};
    const firstDay = DAYS.map((d) => wd[d]).find(Boolean);
    return page(
      c,
      cur ? 'Stelle bearbeiten' : src ? 'Stelle kopieren' : 'Neue Stelle',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/bewerber">Offene Stellen</a>
            </div>
            <h1>{cur ? 'Stelle bearbeiten' : src ? 'Stelle kopieren' : 'Neue Stelle'}</h1>
          </div>
        </div>
        <form
          method="post"
          action={`/bewerber/stellen/${id}`}
          class="card"
          style="max-width:900px"
          id="stelle-form"
        >
          <input type="hidden" name="version" value={String(cur?.version ?? '')} />
          <div class="grid">
            {!p && (
              <div>
                <label for="vorlage">Vorlage wählen (vorausgefüllt)</label>
                <select id="vorlage" data-nosearch>
                  <option value="">— Eigene Stelle ohne Vorlage —</option>
                  {Object.entries(TEMPLATES).map(([k, v]) => (
                    <option value={k}>{v.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label for="titel">Stellentitel *</label>
              <input
                id="titel"
                name="titel"
                value={p?.title ?? ''}
                required
                placeholder="z.B. Reinigungskraft Mini-Job 20h"
              />
            </div>
            <div>
              <label for="art">Berufsart</label>
              <select id="art" name="art" data-nosearch>
                <Opt list={pairs(JOB_TYPES)} sel={p?.job_type ?? 'Reinigungskraft'} />
              </select>
            </div>
            <div>
              <label for="objektart">Objektart</label>
              <select id="objektart" name="objektart">
                <Opt list={OBJECT_TYPES} sel={p?.object_type} empty="— bitte wählen —" />
              </select>
            </div>
            <div>
              <label for="stunden">Stunden / Woche</label>
              <input id="stunden" name="stunden" inputmode="decimal" value={hDe(p?.hours ?? 20)} />
            </div>
            <div>
              <label for="lohn">Stundenlohn (EUR brutto)</label>
              <input
                id="lohn"
                name="lohn"
                inputmode="decimal"
                value={p?.wage_cents != null ? centsToInput(p.wage_cents) : ''}
              />
            </div>
            <div>
              <label for="zeit">Arbeitszeit (grob)</label>
              <select id="zeit" name="zeit" data-nosearch>
                <Opt list={Object.entries(TIMES)} sel={p?.time_of_day ?? 'morgens'} />
              </select>
            </div>
          </div>
          <label style="margin-top:14px">Arbeitstage (optional · für Plakat)</label>
          <div class="actions" style="margin:4px 0 8px">
            <button type="button" class="btn sm sec" data-days="Mo,Di,Mi,Do,Fr">
              Mo–Fr aktivieren
            </button>
            <button type="button" class="btn sm sec" data-days="Mo,Di,Mi,Do,Fr,Sa">
              Mo–Sa aktivieren
            </button>
            <button type="button" class="btn sm sec" data-days="Mo,Di,Mi,Do,Fr,Sa,So">
              Alle Tage
            </button>
            <button type="button" class="btn sm sec" data-days="">
              Alle leeren
            </button>
          </div>
          <div class="bw-day" style="margin-bottom:6px">
            <span class="small" style="font-weight:600">
              Für alle markierten Tage
            </span>
            <select id="all_modus" data-nosearch aria-label="Modus für alle Tage">
              <option value="fest" selected={firstDay?.mode !== 'flexibel'}>
                Feste Uhrzeit
              </option>
              <option value="flexibel" selected={firstDay?.mode === 'flexibel'}>
                Flexibel (nach Absprache)
              </option>
            </select>
            <input type="time" id="all_von" value={firstDay?.from ?? '06:00'} aria-label="von (alle Tage)" />
            <input type="time" id="all_bis" value={firstDay?.to ?? '10:00'} aria-label="bis (alle Tage)" />
          </div>
          <div class="small mut" style="margin-bottom:6px">
            Zeit hier einmal eintragen – sie gilt für alle markierten Tage. Einzelne Tage darunter nur bei
            Abweichung ändern.
          </div>
          <div class="bw-days">
            {DAYS.map((d) => {
              const v = wd[d];
              return (
                <div class="bw-day">
                  <label class="chk">
                    <input type="checkbox" name="tag" value={d} checked={!!v} /> {d}
                  </label>
                  <select name={`modus_${d}`} data-nosearch aria-label={`${d} Modus`}>
                    <option value="fest" selected={v?.mode !== 'flexibel'}>
                      Feste Uhrzeit
                    </option>
                    <option value="flexibel" selected={v?.mode === 'flexibel'}>
                      Flexibel (nach Absprache)
                    </option>
                  </select>
                  <input type="time" name={`von_${d}`} value={v?.from ?? '06:00'} aria-label={`${d} von`} />
                  <input type="time" name={`bis_${d}`} value={v?.to ?? '10:00'} aria-label={`${d} bis`} />
                </div>
              );
            })}
          </div>
          <div class="grid" style="margin-top:14px">
            <div>
              <label for="ort">Stadt</label>
              <input id="ort" name="ort" value={p?.city ?? 'München'} />
            </div>
            <div>
              <label for="plz">PLZ</label>
              <input id="plz" name="plz" value={p?.postal_code ?? ''} inputmode="numeric" />
            </div>
            <div>
              <label for="strasse">Straße &amp; Hausnummer (optional)</label>
              <input id="strasse" name="strasse" value={p?.street ?? ''} />
            </div>
            <div>
              <label for="beginn_art">Beginn</label>
              <select id="beginn_art" name="beginn_art" data-nosearch>
                <option value="sofort" selected={!!p && !p.start_on}>
                  ab sofort
                </option>
                <option value="datum" selected={!p || !!p.start_on}>
                  ab Datum …
                </option>
              </select>
              <input
                id="beginn"
                name="beginn"
                type="date"
                aria-label="Beginn ab Datum"
                style="margin-top:6px"
                hidden={!!p && !p.start_on}
                value={p ? (p.start_on ?? '') : nextMonth}
              />
            </div>
            <div>
              <label for="sprache">Bevorzugte Sprache</label>
              <select id="sprache" name="sprache" data-nosearch>
                <Opt list={pairs(LANGUAGES)} sel={p?.language ?? 'Deutsch'} />
              </select>
            </div>
            <div>
              <label for="aufgaben">Aufgaben (kurz, max. 3-4 Punkte)</label>
              <textarea id="aufgaben" name="aufgaben" rows={3}>
                {p?.tasks ?? ''}
              </textarea>
            </div>
            <div>
              <label for="vor">Voraussetzungen</label>
              <textarea id="vor" name="voraussetzungen" rows={3}>
                {p?.requirements ?? ''}
              </textarea>
            </div>
            <div class="chk">
              <label>
                <input type="checkbox" name="website" value="1" checked={!!p?.website} /> Auf der Website
                veröffentlichen
              </label>
              <div class="small mut">
                Erscheint unter viva-deluxe-reinigung.de/karriere (nur solange die Stelle aktiv ist).
                Stundenlohn und Straße werden nicht veröffentlicht. (Anbindung der Website folgt.)
              </div>
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a
              class="btn sec"
              href={cur ? `/bewerber/stellen/${id}` : src ? `/bewerber/stellen/${src.id}` : '/bewerber'}
            >
              Abbrechen
            </a>
          </div>
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var T=${JSON.stringify(TEMPLATES)};var f=document.getElementById('stelle-form');
var v=document.getElementById('vorlage');if(v)v.addEventListener('change',function(){var t=T[v.value];if(!t)return;
f.titel.value=t.name;f.art.value=t.type;f.stunden.value=t.hours;f.lohn.value=t.wage;f.zeit.value=t.time;f.aufgaben.value=t.tasks;f.voraussetzungen.value=t.req;
['art','zeit'].forEach(function(n){f[n].dispatchEvent(new Event('change'))});});
f.querySelectorAll('[data-days]').forEach(function(b){b.addEventListener('click',function(){var s=b.getAttribute('data-days').split(',');
f.querySelectorAll('input[name=tag]').forEach(function(c){c.checked=s.indexOf(c.value)>=0;});apply(false);});});
var am=document.getElementById('all_modus'),av=document.getElementById('all_von'),ab=document.getElementById('all_bis');
function setDay(d){if(f['modus_'+d])f['modus_'+d].value=am.value;if(f['von_'+d])f['von_'+d].value=av.value;if(f['bis_'+d])f['bis_'+d].value=ab.value;}
function apply(){f.querySelectorAll('input[name=tag]').forEach(function(c){if(c.checked)setDay(c.value);});}
[am,av,ab].forEach(function(x){x.addEventListener('change',apply);x.addEventListener('input',apply);});
f.querySelectorAll('input[name=tag]').forEach(function(c){c.addEventListener('change',function(){if(c.checked)setDay(c.value);});});
var ba=document.getElementById('beginn_art'),bd=document.getElementById('beginn');
function bsync(){bd.hidden=ba.value!=='datum';bd.required=ba.value==='datum';}ba.addEventListener('change',bsync);bsync();setTimeout(bsync,300);})();`,
          }}
        />
      </div>,
    );
  });

  app.post(`/bewerber/stellen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const workdays: Workdays = {};
    for (const d of arr(b, 'tag')) {
      if (!DAYS.includes(d as never)) continue;
      const mode = str(b, `modus_${d}`) === 'flexibel' ? 'flexibel' : 'fest';
      workdays[d as (typeof DAYS)[number]] =
        mode === 'flexibel'
          ? { mode }
          : { mode, from: str(b, `von_${d}`) ?? '', to: str(b, `bis_${d}`) ?? '' };
    }
    let wage: bigint | null = null;
    const lohn = str(b, 'lohn');
    if (lohn) {
      try {
        wage = parseEuro(lohn);
      } catch {
        throw new BusinessError('Stundenlohn ungültig');
      }
    }
    await savePosting(
      sql,
      id,
      {
        title: str(b, 'titel') ?? '',
        jobType: str(b, 'art'),
        objectType: str(b, 'objektart'),
        hours: hrs(str(b, 'stunden')),
        wageCents: wage,
        timeOfDay: str(b, 'zeit'),
        city: str(b, 'ort'),
        postalCode: str(b, 'plz'),
        street: str(b, 'strasse'),
        startOn: str(b, 'beginn_art') === 'sofort' ? null : str(b, 'beginn'),
        language: str(b, 'sprache'),
        tasks: str(b, 'aufgaben'),
        requirements: str(b, 'voraussetzungen'),
        workdays,
        website: str(b, 'website') === '1',
        expectedVersion: num(str(b, 'version')),
      },
      c.get('actor'),
    );
    return back(c, `/bewerber/stellen/${id}`, { ok: 'Stelle gespeichert.' });
  });

  app.post(`/bewerber/stellen/:id{${UUID}}/status`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setPostingStatus(
      sql,
      c.req.param('id'),
      str(b, 'status') === 'geschlossen' ? 'geschlossen' : 'aktiv',
    );
    return back(c, `/bewerber/stellen/${c.req.param('id')}`, { ok: 'Status geändert.' });
  });

  app.post(`/bewerber/stellen/:id{${UUID}}/loeschen`, async (c) => {
    await deletePosting(sql, c.req.param('id'));
    return back(c, '/bewerber', { ok: 'Stelle gelöscht.' });
  });

  // ------------------------------------------------------------------ Plakat (HTML, im Browser als PDF drucken)
  app.get(`/bewerber/stellen/:id{${UUID}}/plakat`, async (c) => {
    const p = await getPosting(sql, c.req.param('id'));
    if (!p) return c.notFound();
    const [co] = await sql<
      { legal_name: string; city: string; email: string; phone: string | null; job_whatsapp: string | null }[]
    >`
      select legal_name, city, email, phone, job_whatsapp from app.company where id = 1`;
    return c.html(await posterHtml(p, co));
  });

  // ------------------------------------------------------------------ Bewerber-Pool
  app.get('/bewerber/pool', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const f = c.req.query('status') ?? '';
    const rf = c.req.query('einschaetzung') ?? '';
    const all = await listApplicants(sql);
    const due = await deletionDue(sql);
    const found = all.filter(
      (a) =>
        !q ||
        [a.name, a.city, a.phone, a.language, a.job_type].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
    const list = found
      .filter((a) => !f || a.status === f)
      .filter((a) => !rf || (rf === 'ohne' ? !a.rating : a.rating === rf));
    const rateHref = (k: string) =>
      `/bewerber/pool?${new URLSearchParams({
        ...(q ? { q } : {}),
        ...(f ? { status: f } : {}),
        ...(k && rf !== k ? { einschaetzung: k } : {}),
      })}`;
    const cnt = (s: string) => found.filter((a) => a.status === s).length;
    const tile = (key: string, n: number, lbl: string, tone = '') => (
      <a
        class={`stat-card${tone ? ` tone-${tone}` : ''}${f === key ? ' on' : ''}`}
        href={`/bewerber/pool?${new URLSearchParams({ ...(q ? { q } : {}), ...(key && f !== key ? { status: key } : {}) })}`}
      >
        <div class="stat-num">{n}</div>
        <div class="stat-lbl">{lbl}</div>
      </a>
    );
    return page(
      c,
      'Bewerber',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Personalmanagement</div>
            <h1>Bewerber</h1>
            <div class="sub">{all.length} Bewerber im Pool</div>
          </div>
          <div class="acts">
            <a class="btn" href={`/bewerber/pool/${randomUUID()}/bearbeiten`}>
              + Neuer Bewerber
            </a>
          </div>
        </div>
        <BwTabs active="pool" />
        {due.length > 0 && (
          <div class="due-banner warn">
            <span class="ico">!</span>
            <span>
              <b>{due.length} abgelehnte Bewerber seit über 6 Monaten</b> – Unterlagen bitte löschen (DSGVO):{' '}
              {due.slice(0, 5).map((d, i) => (
                <>
                  {i > 0 && ', '}
                  <a href={`/bewerber/pool/${d.id}`}>{d.name}</a>
                </>
              ))}
            </span>
          </div>
        )}
        <div class="stat-grid">
          {tile('', found.length, 'Gesamt')}
          {tile('Neu', cnt('Neu'), 'Neu', 'warn')}
          {tile('Gespräch', cnt('Gespräch'), 'Im Gespräch')}
          {tile('Eingestellt', cnt('Eingestellt'), 'Eingestellt', 'ok')}
        </div>
        <form class="toolbar" method="get" action="/bewerber/pool">
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Suche nach Name, Ort, Telefon…"
          />
          <select
            name="status"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Status"
            style="max-width:180px"
          >
            <Opt list={pairs(Object.keys(APPLICANT_STATUS))} sel={f} empty="Alle Status" />
          </select>
          {rf && <input type="hidden" name="einschaetzung" value={rf} />}
        </form>
        <div class="chips" style="margin:-4px 0 12px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="small mut" style="align-self:center">
            Einschätzung:
          </span>
          {Object.entries(RATINGS).map(([k, r]) => (
            <a class={`chip ${rf === k ? 'on' : ''}`} href={rateHref(k)}>
              <span class="rate-dot" style={`background:${r.color}`} />
              {r.label} ({found.filter((a) => a.rating === k).length})
            </a>
          ))}
          <a class={`chip ${rf === 'ohne' ? 'on' : ''}`} href={rateHref('ohne')}>
            ohne ({found.filter((a) => !a.rating).length})
          </a>
        </div>
        {list.length === 0 ? (
          <div class="empty">Keine Bewerber</div>
        ) : (
          <div class="list-cards">
            {list.map((a) => (
              <a class="lc" href={`/bewerber/pool/${a.id}`}>
                <div
                  class="lc-head"
                  style={
                    a.rating
                      ? `border-left:4px solid ${RATINGS[a.rating]?.color};padding-left:8px`
                      : undefined
                  }
                >
                  <span class="lc-name">
                    {a.rating && (
                      <span
                        class="rate-dot"
                        style={`background:${RATINGS[a.rating]?.color}`}
                        title={`Einschätzung: ${RATINGS[a.rating]?.label}`}
                      />
                    )}
                    {a.name || '(ohne Name)'}
                  </span>
                  <span class={`badge ${APPLICANT_STATUS[a.status]}`}>{a.status}</span>
                </div>
                <div class="lc-details">
                  {(a.postal_code || a.city) && (
                    <span>{[a.postal_code, a.city].filter(Boolean).join(' ')}</span>
                  )}
                  {a.phone && <span>{a.phone}</span>}
                  {a.hours && <span>{hDe(a.hours)} Std</span>}
                  {a.language && <span>{a.language}</span>}
                  {a.job_type && <span>{a.job_type}</span>}
                  {a.doc_count > 0 && <span>{anz(a.doc_count, 'Dokument', 'Dokumente')}</span>}
                </div>
                {a.last_contact_on && (
                  <div class="small mut" style="margin-top:4px">
                    Zuletzt: {CONTACT_KINDS[a.last_contact_kind ?? ''] ?? a.last_contact_kind}{' '}
                    {dateDe(a.last_contact_on)}
                    {a.last_contact_result && ` · ${CONTACT_RESULTS[a.last_contact_result] ?? ''}`}
                    {(a.contact_count ?? 0) > 1 && ` · ${a.contact_count} Kontakte`}
                  </div>
                )}
              </a>
            ))}
          </div>
        )}
      </div>,
    );
  });

  app.get(`/bewerber/pool/:id{${UUID}}`, async (c) => {
    const d = await getApplicant(sql, c.req.param('id'));
    if (!d) return c.redirect(`/bewerber/pool/${c.req.param('id')}/bearbeiten`);
    const { a, docs, contacts } = d;
    const posts = (await listPostings(sql)).filter((p) => p.status === 'aktiv');
    const fit = posts
      .map((p) => ({ p, ...score(a, postingCriteria(p)) }))
      .filter((x) => x.score >= 50)
      .sort((x, y) => y.score - x.score);
    const kv = (k: string, v: string | null | undefined) => (
      <div>
        <span class="small mut">{k}</span>
        <div>
          <b>{v || '—'}</b>
        </div>
      </div>
    );
    return page(
      c,
      a.name,
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/bewerber/pool">Bewerber-Pool</a>
            </div>
            <h1>{a.name}</h1>
            <div class="sub">
              <span class={`badge ${APPLICANT_STATUS[a.status]}`}>{a.status}</span> · seit{' '}
              {a.created_at.toLocaleDateString('de-DE', {
                timeZone: 'Europe/Berlin',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })}
            </div>
          </div>
          <div class="acts">
            <form method="post" action={`/bewerber/pool/${a.id}/status`} class="inline-form">
              <select name="status" data-nosearch onchange="this.form.submit()" aria-label="Status">
                <Opt list={pairs(Object.keys(APPLICANT_STATUS))} sel={a.status} />
              </select>
            </form>
            <a class="btn" href={`/bewerber/pool/${a.id}/bearbeiten`}>
              Bearbeiten
            </a>
          </div>
        </div>
        <div class="cols">
          <div>
            <div class="card">
              <h3>Kontakt</h3>
              <div class="bw-kv">
                {kv('Name', a.name)}
                {kv('Telefon', a.phone)}
                {kv('E-Mail', a.email)}
                {kv('Ort', [a.postal_code, a.city].filter(Boolean).join(' '))}
                {kv('Sprache', a.language)}
              </div>
              <h3>Position</h3>
              <div class="bw-kv">
                {kv('Art', a.job_type)}
                {kv('Stunden/Woche', a.hours ? hDe(a.hours) : null)}
                {kv('Arbeitszeit', a.time_of_day ? TIMES[a.time_of_day] : null)}
                {kv('Erfahrung', a.experience ? EXPERIENCE[a.experience] : null)}
                {kv('Verfügbar ab', a.available)}
                {kv('Führerschein', a.driving_licence == null ? null : a.driving_licence ? 'Ja' : 'Nein')}
              </div>
              {a.note && (
                <>
                  <h3>Notizen</h3>
                  <p style="white-space:pre-wrap">{a.note}</p>
                </>
              )}
            </div>
            <div class="card">
              <h3>Kontaktverlauf ({contacts.length})</h3>
              <form method="post" action={`/bewerber/pool/${a.id}/kontakt`} class="bw-contact-form">
                <input type="hidden" name="kid" value={randomUUID()} />
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
                  <div>
                    <label for="k-on">Datum</label>
                    <input id="k-on" type="date" name="datum" value={todayBerlin()} required />
                  </div>
                  <div>
                    <label for="k-kind">Art</label>
                    <select id="k-kind" name="art" data-nosearch>
                      {Object.entries(CONTACT_KINDS).map(([k, l]) => (
                        <option value={k}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="k-res">Ergebnis</label>
                    <select id="k-res" name="ergebnis" data-nosearch>
                      <option value="">–</option>
                      {Object.entries(CONTACT_RESULTS).map(([k, l]) => (
                        <option value={k}>{l}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <label for="k-note" style="margin-top:8px">
                  Notiz
                </label>
                <textarea id="k-note" name="notiz" rows={2} placeholder="z. B. ruft Montag zurück" />
                <button class="btn sm" style="margin-top:8px">
                  Kontakt festhalten
                </button>
                <div class="small mut" style="margin-top:4px">
                  „hat etwas anderes gefunden“ setzt den Status automatisch auf „Hat etwas gefunden“.
                </div>
              </form>
              {contacts.length > 0 && (
                <ul class="calm-list" style="margin-top:12px">
                  {contacts.map((k) => (
                    <li style="display:flex;gap:10px;align-items:flex-start">
                      <div style="flex:1">
                        <b>{CONTACT_KINDS[k.kind] ?? k.kind}</b> · {dateDe(k.contact_on)}
                        {k.result && (
                          <span
                            class={`badge ${k.result === 'gefunden' || k.result === 'kein_interesse' ? 'err' : k.result === 'nicht_erreicht' ? 'warn' : 'ok'}`}
                            style="margin-left:6px"
                          >
                            {CONTACT_RESULTS[k.result]}
                          </span>
                        )}
                        {k.note && <div style="white-space:pre-wrap">{k.note}</div>}
                        <div class="small mut">{k.created_by}</div>
                      </div>
                      <form
                        method="post"
                        action={`/bewerber/pool/${a.id}/kontakt/${k.id}/loeschen`}
                        class="inline-form"
                      >
                        <button class="btn sm danger" data-confirm="Eintrag löschen?" title="löschen">
                          ✕
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div class="card">
              <h3>Dokumente ({docs.length})</h3>
              {docs.map((x) => (
                <div class="bw-doc">
                  <a href={`/bewerber/pool/${a.id}/dokument/${x.id}`} target="_blank">
                    {x.name}
                  </a>
                  <span class="small mut">
                    {Math.ceil(x.size_bytes / 1024)} KB ·{' '}
                    {x.uploaded_at.toLocaleDateString('de-DE', {
                      timeZone: 'Europe/Berlin',
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    })}
                  </span>
                  <form
                    method="post"
                    action={`/bewerber/pool/${a.id}/dokument/${x.id}/loeschen`}
                    class="inline-form"
                  >
                    <button class="btn sm danger" data-confirm="Dokument löschen?" title="löschen">
                      ✕
                    </button>
                  </form>
                </div>
              ))}
              <form
                method="post"
                action={`/bewerber/pool/${a.id}/dokumente`}
                enctype="multipart/form-data"
                style="margin-top:8px"
              >
                <label class="btn sm sec">
                  + Datei hochladen (PDF, JPG, DOC bis 10 MB)
                  <input
                    type="file"
                    name="datei"
                    multiple
                    accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    hidden
                    onchange="this.form.submit()"
                  />
                </label>
              </form>
            </div>
            <form method="post" action={`/bewerber/pool/${a.id}/loeschen`}>
              <button class="btn sm danger" data-confirm="Bewerber mit allen Unterlagen endgültig löschen?">
                Löschen (inkl. Unterlagen)
              </button>
            </form>
          </div>
          <div>
            <div class="card">
              <h3>Interne Einschätzung</h3>
              <form method="post" action={`/bewerber/pool/${a.id}/einschaetzung`} class="rate-pick">
                {Object.entries(RATINGS).map(([k, r]) => (
                  <label>
                    <input
                      type="radio"
                      name="einschaetzung"
                      value={k}
                      checked={a.rating === k}
                      onchange="this.form.submit()"
                    />
                    <span class="rate-dot" style={`background:${r.color}`} />
                    {r.label}
                  </label>
                ))}
                <label>
                  <input
                    type="radio"
                    name="einschaetzung"
                    value=""
                    checked={!a.rating}
                    onchange="this.form.submit()"
                  />
                  keine
                </label>
                <noscript>
                  <button class="btn sm">Speichern</button>
                </noscript>
              </form>
              <p class="small mut" style="margin-bottom:0">
                Nur intern sichtbar (Admin/Personal). Sachlich halten – Bewerber haben ein Auskunftsrecht
                (Art. 15 DSGVO).
              </p>
            </div>
            <div class="card">
              <h3>Passende offene Stellen ({fit.length})</h3>
              {fit.length === 0 ? (
                <p class="small mut">Keine offene Stelle mit mindestens 50 % Übereinstimmung.</p>
              ) : (
                fit.map((x) => (
                  <a class="bw-match" href={`/bewerber/stellen/${x.p.id}`}>
                    <div>
                      <b>{x.p.title}</b>
                      <div class="small mut">
                        {[x.p.city, x.p.hours ? `${hDe(x.p.hours)} h` : null].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <span class={`badge ${pct(x.percent)}`}>{x.percent}%</span>
                  </a>
                ))
              )}
            </div>
          </div>
        </div>
      </div>,
    );
  });

  app.get(`/bewerber/pool/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const a = (await getApplicant(sql, id))?.a;
    return page(
      c,
      a ? `Bearbeiten: ${a.name}` : 'Neuer Bewerber',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/bewerber/pool">Bewerber-Pool</a>
            </div>
            <h1>{a ? `Bearbeiten: ${a.name}` : 'Neuer Bewerber'}</h1>
          </div>
        </div>
        <form method="post" action={`/bewerber/pool/${id}`} class="card" style="max-width:900px">
          <input type="hidden" name="version" value={String(a?.version ?? '')} />
          <div class="grid">
            <div>
              <label for="name">Name *</label>
              <input id="name" name="name" value={a?.name ?? ''} required />
            </div>
            <div>
              <label for="tel">Telefon</label>
              <input id="tel" name="tel" type="tel" value={a?.phone ?? ''} />
            </div>
            <div>
              <label for="mail">E-Mail</label>
              <input id="mail" name="mail" type="email" value={a?.email ?? ''} />
            </div>
            <div>
              <label for="plz">PLZ</label>
              <input id="plz" name="plz" value={a?.postal_code ?? ''} inputmode="numeric" />
            </div>
            <div>
              <label for="ort">Ort</label>
              <input id="ort" name="ort" value={a?.city ?? ''} />
            </div>
            <div>
              <label for="sprache">Sprache</label>
              <select id="sprache" name="sprache" data-nosearch>
                <Opt list={pairs(LANGUAGES)} sel={a?.language ?? 'Deutsch'} />
              </select>
            </div>
            <div>
              <label for="art">Art</label>
              <select id="art" name="art" data-nosearch>
                <Opt list={pairs(JOB_TYPES)} sel={a?.job_type ?? 'Reinigungskraft'} />
              </select>
            </div>
            <div>
              <label for="stunden">Stunden/Woche</label>
              <input id="stunden" name="stunden" inputmode="decimal" value={hDe(a?.hours)} />
            </div>
            <div>
              <label for="zeit">Arbeitszeit</label>
              <select id="zeit" name="zeit" data-nosearch>
                <Opt list={Object.entries(TIMES)} sel={a?.time_of_day} empty="—" />
              </select>
            </div>
            <div>
              <label for="erf">Erfahrung</label>
              <select id="erf" name="erfahrung" data-nosearch>
                <Opt list={Object.entries(EXPERIENCE)} sel={a?.experience} empty="— keine Angabe —" />
              </select>
            </div>
            <div>
              <label for="verf">Verfügbar ab</label>
              <input id="verf" name="verfuegbar" value={a?.available ?? ''} placeholder="z.B. sofort" />
            </div>
            <div class="chk">
              <label>
                <input type="checkbox" name="fs" value="1" checked={!!a?.driving_licence} /> Führerschein
                vorhanden
              </label>
            </div>
            <div>
              <label for="notiz">Notizen</label>
              <textarea id="notiz" name="notiz" rows={3}>
                {a?.note ?? ''}
              </textarea>
            </div>
          </div>
          {!a && <p class="small mut">Dokumente kannst du nach dem Speichern hochladen.</p>}
          <div class="formfoot">
            <button class="btn">{a ? 'Aktualisieren' : 'Speichern'}</button>
            <a class="btn sec" href={a ? `/bewerber/pool/${id}` : '/bewerber/pool'}>
              Abbrechen
            </a>
          </div>
        </form>
      </div>,
    );
  });

  app.post(`/bewerber/pool/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    await saveApplicant(
      sql,
      id,
      {
        name: str(b, 'name') ?? '',
        phone: str(b, 'tel'),
        email: str(b, 'mail'),
        postalCode: str(b, 'plz'),
        city: str(b, 'ort'),
        language: str(b, 'sprache'),
        jobType: str(b, 'art'),
        hours: hrs(str(b, 'stunden')),
        timeOfDay: str(b, 'zeit'),
        experience: str(b, 'erfahrung'),
        available: str(b, 'verfuegbar'),
        drivingLicence: str(b, 'fs') === '1',
        note: str(b, 'notiz'),
        expectedVersion: num(str(b, 'version')),
      },
      c.get('actor'),
    );
    return back(c, `/bewerber/pool/${id}`, { ok: 'Gespeichert.' });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/status`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setApplicantStatus(sql, c.req.param('id'), str(b, 'status') ?? '');
    return back(c, `/bewerber/pool/${c.req.param('id')}`, { ok: `Status: ${str(b, 'status')}` });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/einschaetzung`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setApplicantRating(sql, c.req.param('id'), str(b, 'einschaetzung'));
    return back(c, `/bewerber/pool/${c.req.param('id')}`, { ok: 'Einschätzung gespeichert.' });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/kontakt`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const kid = str(b, 'kid') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(kid)) throw new BusinessError('Formular ungültig – bitte neu laden');
    await addApplicantContact(
      sql,
      c.req.param('id'),
      {
        id: kid,
        on: str(b, 'datum') ?? todayBerlin(),
        kind: str(b, 'art') ?? 'anruf',
        result: str(b, 'ergebnis'),
        note: str(b, 'notiz'),
      },
      c.get('actor'),
    );
    return back(c, `/bewerber/pool/${c.req.param('id')}`, { ok: 'Kontakt festgehalten.' });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/kontakt/:k{${UUID}}/loeschen`, async (c) => {
    await deleteApplicantContact(sql, c.req.param('id'), c.req.param('k'));
    return back(c, `/bewerber/pool/${c.req.param('id')}`, { ok: 'Eintrag gelöscht.' });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/loeschen`, async (c) => {
    await deleteApplicant(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/bewerber/pool', { ok: 'Bewerber und Unterlagen gelöscht.' });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/dokumente`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const files = (Array.isArray(b.datei) ? b.datei : [b.datei]).filter(
      (f): f is File => f instanceof File && f.size > 0,
    );
    if (!files.length) throw new BusinessError('Bitte eine Datei auswählen');
    for (const f of files)
      await addDocument(
        sql,
        id,
        { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, type: f.type },
        c.get('actor'),
      );
    return back(c, `/bewerber/pool/${id}`, { ok: `${anz(files.length, 'Datei', 'Dateien')} hochgeladen.` });
  });

  app.get(`/bewerber/pool/:id{${UUID}}/dokument/:doc{${UUID}}`, async (c) => {
    const d = await getDocument(sql, c.req.param('id'), c.req.param('doc'));
    if (!d) return c.notFound();
    return new Response(new Uint8Array(d.content), {
      headers: {
        'Content-Type': d.content_type,
        'Content-Disposition': `inline; filename="${d.name.replace(/[^\w.\- ]/g, '_')}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.post(`/bewerber/pool/:id{${UUID}}/dokument/:doc{${UUID}}/loeschen`, async (c) => {
    await deleteDocument(sql, c.req.param('id'), c.req.param('doc'));
    return back(c, `/bewerber/pool/${c.req.param('id')}`, { ok: 'Dokument gelöscht.' });
  });

  // ------------------------------------------------------------------ Manuelles Matching
  app.get('/bewerber/matching', async (c) => {
    const q = (k: string) => c.req.query(k)?.trim() || null;
    const run = c.req.query('los') === '1';
    const crit: Criteria = {
      city: q('ort'),
      postal_code: q('plz'),
      hours: hrs(q('stunden')) ?? (run ? null : 20),
      language: q('sprache') ?? 'Deutsch',
      job_type: q('art') ?? 'Reinigungskraft',
      time_of_day: q('zeit') ?? 'abends',
    };
    const res = run
      ? (await listApplicants(sql))
          .map((a) => ({ a, ...score(a, crit) }))
          .filter((x) => x.score > 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, 15)
      : [];
    return page(
      c,
      'Manuelles Matching',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Personalmanagement</div>
            <h1>Manuelles Matching</h1>
          </div>
        </div>
        <BwTabs active="matching" />
        <form method="get" action="/bewerber/matching" class="card">
          <h3>Stelle definieren – Bewerber werden passend gematched</h3>
          <input type="hidden" name="los" value="1" />
          <div class="grid">
            <div>
              <label for="m-ort">Ort</label>
              <input id="m-ort" name="ort" value={crit.city ?? ''} placeholder="z.B. München" />
            </div>
            <div>
              <label for="m-plz">PLZ</label>
              <input id="m-plz" name="plz" value={crit.postal_code ?? ''} placeholder="z.B. 81375" />
            </div>
            <div>
              <label for="m-std">Stunden/Woche</label>
              <input id="m-std" name="stunden" inputmode="decimal" value={hDe(crit.hours)} />
            </div>
            <div>
              <label for="m-spr">Sprache</label>
              <select id="m-spr" name="sprache" data-nosearch>
                <Opt list={pairs(LANGUAGES)} sel={crit.language} />
              </select>
            </div>
            <div>
              <label for="m-art">Art</label>
              <select id="m-art" name="art" data-nosearch>
                <Opt list={pairs(JOB_TYPES)} sel={crit.job_type} />
              </select>
            </div>
            <div>
              <label for="m-zeit">Arbeitszeit</label>
              <select id="m-zeit" name="zeit" data-nosearch>
                <Opt list={Object.entries(TIMES)} sel={crit.time_of_day} />
              </select>
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">Matching starten</button>
          </div>
        </form>
        {run &&
          (res.length === 0 ? (
            <div class="empty">
              Keine passenden Bewerber gefunden. Passe die Suchkriterien an oder lege neue Bewerber an.
            </div>
          ) : (
            <>
              <h3>Top {res.length} Matches</h3>
              <div class="list-cards">
                {res.map((x, i) => (
                  <a class="lc" href={`/bewerber/pool/${x.a.id}`}>
                    <div class="lc-head">
                      <div>
                        <span class="lc-name">
                          #{i + 1} · {x.a.name}
                        </span>
                        <div class="lc-details">
                          {x.a.city && <span>{x.a.city}</span>}
                          {x.a.hours && <span>{hDe(x.a.hours)} h</span>}
                          {x.a.job_type && <span>{x.a.job_type}</span>}
                        </div>
                        <div class="bw-chips" style="margin-top:6px">
                          {x.hit.map((h) => (
                            <span class="badge ok">✓ {h}</span>
                          ))}
                          {x.miss.map((h) => (
                            <span class="badge">✗ {h}</span>
                          ))}
                        </div>
                      </div>
                      <div class="bw-count">
                        <b class={x.percent >= 70 ? 'kb-pos' : ''}>{x.percent}%</b>
                        <span>{x.score}/100 P</span>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </>
          ))}
      </div>,
    );
  });
}
