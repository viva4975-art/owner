import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import posterI18n from '../i18n/job-poster.json' with { type: 'json' };
import {
  APPLICANT_STATUS,
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
import { dateDe, euro } from './layout.js';

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
                {p.hours && <span>{p.hours}h/Woche</span>}
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
                {kv('Stunden', p.hours ? `${p.hours} h / Woche` : null)}
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
                EL) und Handy-/WhatsApp-Nummer prominent. Ideal für Aushänge. Auf der Plakatseite „Als JPG
                herunterladen“ (z. B. für WhatsApp/Social Media) oder im Druckdialog „Als PDF speichern“
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
                      {[x.a.job_type, x.a.hours ? `${x.a.hours} h` : null, x.a.city]
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
    const p = await getPosting(sql, id);
    const nextMonth = (() => {
      const [y, m] = todayBerlin().split('-').map(Number) as [number, number];
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    })();
    const wd: Workdays = p?.workdays ?? {};
    return page(
      c,
      p ? 'Stelle bearbeiten' : 'Neue Stelle',
      'personal',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/bewerber">Offene Stellen</a>
            </div>
            <h1>{p ? 'Stelle bearbeiten' : 'Neue Stelle'}</h1>
          </div>
        </div>
        <form
          method="post"
          action={`/bewerber/stellen/${id}`}
          class="card"
          style="max-width:900px"
          id="stelle-form"
        >
          <input type="hidden" name="version" value={String(p?.version ?? '')} />
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
              <input
                id="stunden"
                name="stunden"
                type="number"
                min="1"
                max="60"
                value={String(p?.hours ?? 20)}
              />
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
              <label for="beginn">Beginn (leer = sofort)</label>
              <input id="beginn" name="beginn" type="date" value={p ? (p.start_on ?? '') : nextMonth} />
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
            <a class="btn sec" href={p ? `/bewerber/stellen/${id}` : '/bewerber'}>
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
f.querySelectorAll('input[name=tag]').forEach(function(c){c.checked=s.indexOf(c.value)>=0;});});});})();`,
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
        hours: num(str(b, 'stunden')),
        wageCents: wage,
        timeOfDay: str(b, 'zeit'),
        city: str(b, 'ort'),
        postalCode: str(b, 'plz'),
        street: str(b, 'strasse'),
        startOn: str(b, 'beginn'),
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
    const T = posterI18n.texts as Record<string, Record<string, string>>;
    const order = ['de', 'en', 'tr', 'ru', 'pl', 'ro', 'hu', 'el', 'ar'];
    const multi = (k: string) => [...new Set(order.map((l) => T[l]?.[k]).filter(Boolean))].join(' · ');
    const ot = p.object_type
      ? (posterI18n.objektart as Record<string, Record<string, string>>)[p.object_type]
      : undefined;
    const timeKey = p.time_of_day === 'abends' ? 'abend' : p.time_of_day;
    const wd = workdaysText(p.workdays);
    const phone = co?.job_whatsapp ?? co?.phone ?? '';
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const cell = (label: string, value: string) =>
      `<div class="pc"><div class="pv">${esc(value)}</div><div class="pl">${esc(label)}</div></div>`;
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plakat – ${esc(p.title)}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#eee;font-family:Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#1c1917}
.bar{position:sticky;top:0;background:#fff;padding:10px;text-align:center;border-bottom:1px solid #ddd}.bar button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#7D1435;color:#fff;cursor:pointer}
.sheet{width:210mm;height:297mm;margin:12px auto;background:#fff;position:relative;overflow:hidden;display:flex;flex-direction:column}
.hd{background:#7D1435;color:#fff;padding:34px 40px 30px}.hd .co{font-size:14px;opacity:.85;letter-spacing:.02em}.hd h1{font-size:42px;line-height:1.1;margin:10px 0 0;font-weight:800}
.hd .art{display:inline-block;margin-top:12px;background:rgba(255,255,255,.18);padding:4px 12px;border-radius:14px;font-size:14px}
.body{padding:24px 40px;display:flex;flex-direction:column;gap:14px;flex:1}
.band{border:1px solid #E8D0D0;border-radius:12px;padding:14px 18px;background:#FFF8F0}.band .lab{font-size:11px;color:#7D1435;font-weight:700;letter-spacing:.03em}
.band .big{font-size:30px;font-weight:800;margin:4px 0}.band .tr{font-size:12px;color:#57534e}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pc{background:#FAFAF9;border:1px solid #e7e5e4;border-radius:12px;padding:14px 18px}
.pv{font-size:24px;font-weight:800}.pl{font-size:10.5px;color:#78716c;margin-top:4px;line-height:1.35}.full{grid-column:1/-1}
.ft{background:#7D1435;color:#fff;padding:22px 40px 26px;text-align:center}.ft .k{font-size:13px;letter-spacing:.12em;opacity:.85}
.ft .ph{font-size:50px;font-weight:800;line-height:1.1;margin:6px 0}.ft .em{font-size:16px}.ft .ct{font-size:10.5px;opacity:.85;margin-top:8px;line-height:1.4}
@media print{body{background:#fff}.bar{display:none}.sheet{margin:0}}
</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button> <button id="jpg" type="button">Als JPG herunterladen</button></div><div class="sheet" id="sheet">
<div class="hd"><div class="co">${esc(co?.legal_name ?? '')} · ${esc(co?.city ?? '')}</div><h1>${esc(p.title)}</h1>${p.job_type && p.job_type !== p.title ? `<span class="art">${esc(p.job_type)}</span>` : ''}</div>
<div class="body">
${
  ot
    ? `<div class="band"><div class="lab">${esc(order.map((l) => (posterI18n.label as Record<string, string>)[l]).join(' · '))}</div><div class="big">${esc(ot.de ?? '')}</div><div class="tr">${esc(
        order
          .slice(1)
          .map((l) => ot[l])
          .filter(Boolean)
          .join(' · '),
      )}</div></div>`
    : ''
}
${wd ? `<div class="band"><div class="lab">Arbeitstage / Working days / Çalışma günleri / Dni pracy</div><div class="big" style="font-size:22px">${esc(wd)}</div></div>` : ''}
<div class="grid">
${cell(multi('location'), [p.street, [p.postal_code, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—')}
${p.hours ? cell(multi('hours'), `${p.hours} h / Woche`) : ''}
${p.wage_cents != null ? cell(multi('salary'), euro(p.wage_cents)) : ''}
${timeKey ? cell(multi('workTime'), T.de?.[timeKey] ?? TIMES[p.time_of_day!] ?? '') : ''}
<div class="pc full"><div class="pv">${p.start_on ? `ab ${dateDe(p.start_on)}` : 'Ab sofort'}</div><div class="pl">${esc(multi('startDate'))}</div></div>
</div></div>
<div class="ft"><div class="k">WHATSAPP · TELEFON</div><div class="ph">${esc(phone || 'Nummer unter Einstellungen → Firmendaten eintragen')}</div><div class="em">${esc(co?.email ?? '')}</div>
<div class="ct">${esc(
      order
        .map((l) => T[l]?.contactText)
        .filter(Boolean)
        .join(' · '),
    )}</div></div>
</div>
<script src="/static/vendor/html2canvas.min.js"></script>
<script>
document.getElementById('jpg').addEventListener('click', async function () {
  var b = this; b.disabled = true; b.textContent = 'Wird erstellt …';
  try {
    var el = document.getElementById('sheet');
    // ca. 150 dpi (A4 = 1240 × 1754 px)
    var canvas = await html2canvas(el, { scale: 1240 / el.offsetWidth, backgroundColor: '#ffffff', useCORS: false });
    var a = document.createElement('a');
    a.href = canvas.toDataURL('image/jpeg', 0.92);
    a.download = ${JSON.stringify(`Stellenplakat-${p.title}`.replace(/[^\p{L}\p{N}-]+/gu, '-') + '.jpg')};
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { alert('JPG konnte nicht erstellt werden: ' + e); }
  b.disabled = false; b.textContent = 'Als JPG herunterladen';
});
</script></body></html>`;
    return c.html(html);
  });

  // ------------------------------------------------------------------ Bewerber-Pool
  app.get('/bewerber/pool', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const f = c.req.query('status') ?? '';
    const all = await listApplicants(sql);
    const due = await deletionDue(sql);
    const found = all.filter(
      (a) =>
        !q ||
        [a.name, a.city, a.phone, a.language, a.job_type].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
    const list = found.filter((a) => !f || a.status === f);
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
        </form>
        {list.length === 0 ? (
          <div class="empty">Keine Bewerber</div>
        ) : (
          <div class="list-cards">
            {list.map((a) => (
              <a class="lc" href={`/bewerber/pool/${a.id}`}>
                <div class="lc-head">
                  <span class="lc-name">{a.name || '(ohne Name)'}</span>
                  <span class={`badge ${APPLICANT_STATUS[a.status]}`}>{a.status}</span>
                </div>
                <div class="lc-details">
                  {(a.postal_code || a.city) && (
                    <span>{[a.postal_code, a.city].filter(Boolean).join(' ')}</span>
                  )}
                  {a.phone && <span>{a.phone}</span>}
                  {a.hours && <span>{a.hours} Std</span>}
                  {a.language && <span>{a.language}</span>}
                  {a.job_type && <span>{a.job_type}</span>}
                  {a.doc_count > 0 && <span>{a.doc_count} Dokument(e)</span>}
                </div>
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
    const { a, docs } = d;
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
              {a.created_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
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
                {kv('Stunden/Woche', a.hours ? String(a.hours) : null)}
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
              <h3>Dokumente ({docs.length})</h3>
              {docs.map((x) => (
                <div class="bw-doc">
                  <a href={`/bewerber/pool/${a.id}/dokument/${x.id}`} target="_blank">
                    {x.name}
                  </a>
                  <span class="small mut">
                    {Math.ceil(x.size_bytes / 1024)} KB ·{' '}
                    {x.uploaded_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
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
                      {[x.p.city, x.p.hours ? `${x.p.hours} h` : null].filter(Boolean).join(' · ')}
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
              <input
                id="stunden"
                name="stunden"
                type="number"
                min="1"
                max="80"
                value={a?.hours ? String(a.hours) : ''}
              />
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
        hours: num(str(b, 'stunden')),
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
    return back(c, `/bewerber/pool/${id}`, { ok: `${files.length} Datei(en) hochgeladen.` });
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
      hours: num(q('stunden')) ?? (run ? null : 20),
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
              <input id="m-std" name="stunden" type="number" value={crit.hours ? String(crit.hours) : ''} />
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
                          {x.a.hours && <span>{x.a.hours} h</span>}
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
