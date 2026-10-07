import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  BELAEGE,
  DC_STATUS,
  DC_STATUS_TONE,
  type DcPlan,
  type Floor,
  calc,
  deletePlan,
  fmtSqm,
  getPlan,
  listPlans,
  savePlan,
  setPlanStatus,
  summary,
} from '../services/deep-cleaning.js';
import { BusinessError } from '../services/errors.js';
import { type Ctx, UUID } from './app.js';
import { arr, centsToInput, str } from './forms.js';
import { dateDe, euro } from './layout.js';

const money = (s: string | null, what: string) => {
  if (!s) return null;
  try {
    return parseEuro(s);
  } catch {
    throw new BusinessError(`${what} ungültig`);
  }
};
const sqm = (s: string | null) => {
  if (!s) return null;
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new BusinessError(`Fläche „${s}“ ungültig`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
};
const pct = (s: string | null, def: number) => {
  if (!s) return def;
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new BusinessError('Prozentwert ungültig');
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
};
const pctIn = (bp: number) => (bp % 100 ? (bp / 100).toFixed(2).replace('.', ',') : String(bp / 100));
const hrs = (h100: bigint) => (Number(h100) / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 });

/** Planung Grundreinigung wie die alte App. */
export function registerDeepCleaningRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/grundreinigung', async (c) => {
    const cy = Number(todayBerlin().slice(0, 4));
    const y = Number(c.req.query('jahr')) || cy;
    const f = c.req.query('filter') ?? '';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const all = (await listPlans(sql, y)).filter(
      (p) => !q || [p.object, p.customer, p.supplier_name].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
    const list = all.filter((p) => !f || p.status === f);
    const tot = list.reduce(
      (a, p) => {
        const k = calc(p);
        return { vk: a.vk + k.vk, sub: a.sub + (p.execution === 'sub' ? k.sub : 0n), db: a.db + k.effDb };
      },
      { vk: 0n, sub: 0n, db: 0n },
    );
    const link = (o: Record<string, string>) =>
      `/grundreinigung?${new URLSearchParams({ jahr: String(y), ...(q ? { q } : {}), ...(f ? { filter: f } : {}), ...o })}`;
    const tile = (key: string, n: number, lbl: string, tone = '') => (
      <a
        class={`stat-card${tone ? ` tone-${tone}` : ''}${f === key ? ' on' : ''}`}
        href={link({ filter: f === key ? '' : key })}
      >
        <div class="stat-num">{n}</div>
        <div class="stat-lbl">{lbl}</div>
      </a>
    );
    return page(
      c,
      'Planung Grundreinigung',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Vor Ort</div>
            <h1>Planung Grundreinigung</h1>
            <div class="sub">Jahresplanung je Objekt inklusive Vergabe an Subunternehmer.</div>
          </div>
          <form class="acts" method="get" action="/grundreinigung">
            <select name="jahr" data-nosearch onchange="this.form.submit()" aria-label="Jahr">
              {[cy - 1, cy, cy + 1, cy + 2].map((j) => (
                <option value={String(j)} selected={j === y}>
                  {j}
                </option>
              ))}
            </select>
            <a class="btn" href={`/grundreinigung/${randomUUID()}`}>
              + Neue Planung
            </a>
          </form>
        </div>
        <div class="stat-grid">
          {tile('', all.length, 'Gesamt')}
          {tile('Geplant', all.filter((p) => p.status === 'Geplant').length, 'Geplant', 'warn')}
          {tile('Übergeben', all.filter((p) => p.status === 'Übergeben').length, 'Übergeben')}
          {tile(
            'Ausgeführt',
            all.filter((p) => p.status === 'Ausgeführt').length,
            'Ausgeführt (Archiv)',
            'ok',
          )}
        </div>
        <form class="toolbar" method="get" action="/grundreinigung">
          <input type="hidden" name="jahr" value={String(y)} />
          {f && <input type="hidden" name="filter" value={f} />}
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Objekt, Kunde oder Sub suchen…"
          />
          <a
            class="btn sec"
            href={link({}).replace('/grundreinigung?', '/grundreinigung/druck?')}
            target="_blank"
          >
            PDF
          </a>
          <a
            class="btn sec"
            href={link({ preise: '0' }).replace('/grundreinigung?', '/grundreinigung/druck?')}
            target="_blank"
          >
            PDF ohne Preise
          </a>
          <a class="btn sec" href={link({}).replace('/grundreinigung?', '/grundreinigung/export.csv?')}>
            Excel (CSV)
          </a>
        </form>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-num">{euro(tot.vk)}</div>
            <div class="stat-lbl">Umsatz VK</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{euro(tot.sub)}</div>
            <div class="stat-lbl">an Sub</div>
          </div>
          <div class={`stat-card ${tot.db >= 0n ? 'tone-ok' : 'tone-err'}`}>
            <div class="stat-num">{euro(tot.db)}</div>
            <div class="stat-lbl">Deckungsbeitrag</div>
          </div>
        </div>
        {list.length === 0 && <div class="empty">Keine Planungen in {y}.</div>}
        <div class="list-cards">
          {list.map((p) => {
            const k = calc(p);
            return (
              <div class="lc">
                <div class="lc-head">
                  <div>
                    <div class="bw-chips" style="margin-bottom:6px">
                      <span class={`badge ${DC_STATUS_TONE[p.status]}`}>{p.status}</span>
                      <span class="badge">
                        {p.execution === 'eigen'
                          ? 'Eigenpersonal'
                          : `Sub: ${p.supplier_name ?? '– später wählen –'}`}
                      </span>
                    </div>
                    <a class="lc-name" href={`/grundreinigung/${p.id}`}>
                      {p.object.split('\n')[0]}
                    </a>
                    <div class="lc-sub">
                      {[
                        p.customer,
                        p.date_from
                          ? `${dateDe(p.date_from)}${p.date_to ? ` – ${dateDe(p.date_to)}` : ''}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div class="lc-details">
                      <span>{summary(p)}</span>
                    </div>
                  </div>
                  <div class="bw-count">
                    <b>{euro(k.vk)}</b>
                    <span>
                      {p.execution === 'eigen'
                        ? `${hrs(k.hours100)} h Eigenleistung`
                        : `${euro(k.sub)} an Sub${p.sub_price_cents ? '' : ' (Vorschlag)'}`}
                    </span>
                    <span class={k.effDb >= 0n ? 'kb-pos' : 'kb-neg'}>DB {euro(k.effDb)}</span>
                  </div>
                </div>
                <div class="lc-foot gp-acts">
                  <form method="post" action={`/grundreinigung/${p.id}/status`} class="inline-form">
                    {p.status === 'Ausgeführt' ? (
                      <button class="btn sm sec" name="status" value="Übergeben">
                        ↩ Reaktivieren
                      </button>
                    ) : (
                      <button
                        class="btn sm sec"
                        name="status"
                        value="Ausgeführt"
                        data-confirm="Als ausgeführt markieren (Archiv)?"
                      >
                        ✓ Ausgeführt
                      </button>
                    )}
                  </form>
                  <a class="btn sm sec" href={`/grundreinigung/${p.id}`}>
                    Bearbeiten
                  </a>
                  <form method="post" action={`/grundreinigung/${p.id}/loeschen`} class="inline-form">
                    <button class="btn sm danger" data-confirm="Planung löschen?" title="löschen">
                      🗑
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      </div>,
    );
  });

  app.get(`/grundreinigung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const p = await getPlan(sql, id);
    const [sites, subs, customers] = await Promise.all([
      sql<
        {
          id: string;
          site_no: string;
          name: string;
          street: string | null;
          postal_code: string | null;
          city: string | null;
          customer: string;
        }[]
      >`
        select s.id, s.site_no, s.name, s.street, s.postal_code, s.city, c.name as customer
          from app.sites s join app.customers c on c.id = s.customer_id where s.active order by length(s.site_no), s.site_no`,
      sql<
        { id: string; name: string }[]
      >`select id, name from app.suppliers where kind = 'nachunternehmer' and active order by name`,
      sql<
        { customer: string }[]
      >`select distinct customer from app.deep_cleaning_plans where customer is not null order by 1`,
    ]);
    const floors: Floor[] = p?.floors.length
      ? p.floors
      : [{ belag: 'Linoleum', sqm_x100: 0, price_cents: 0 }];
    const floorRow = (fl: Floor | null) => (
      <div class="gr-floor">
        <select name="belag" data-nosearch aria-label="Belag">
          {BELAEGE.map((b) => (
            <option value={b} selected={fl?.belag === b}>
              {b}
            </option>
          ))}
        </select>
        <input
          name="flaeche"
          value={fl && fl.sqm_x100 ? fmtSqm(BigInt(fl.sqm_x100)) : ''}
          placeholder="m²"
          inputmode="decimal"
          aria-label="m²"
        />
        <input
          name="preis"
          value={fl && fl.price_cents ? centsToInput(BigInt(fl.price_cents)) : ''}
          placeholder="€/m²"
          inputmode="decimal"
          aria-label="€/m²"
        />
        <button type="button" class="btn sm sec" data-del-floor>
          ✕
        </button>
      </div>
    );
    const step = (n: number, icon: string, title: string, body: unknown) => (
      <section class="gr-step" data-step={String(n)}>
        <h3>
          {icon} {title}
        </h3>
        {body as never}
      </section>
    );
    return page(
      c,
      p ? 'Planung bearbeiten' : 'Neue Planung',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/grundreinigung">Planung Grundreinigung</a>
            </div>
            <h1>{p ? p.object.split('\n')[0] : 'Neue Planung'}</h1>
          </div>
        </div>
        <form
          method="post"
          action={`/grundreinigung/${id}`}
          class="card gr-wiz"
          style="max-width:860px"
          id="gr-form"
        >
          <input type="hidden" name="version" value={String(p?.version ?? '')} />
          <div class="gr-prog">
            <span id="gr-step-label">Schritt 1 / 5</span>
            <div class="progress">
              <div id="gr-bar" style="width:20%" />
            </div>
          </div>
          {step(
            1,
            '🏢',
            'Kunde',
            <>
              <label for="site">Objekt aus Objektliste wählen (füllt Kunde &amp; Objekt automatisch)</label>
              <select id="site" name="site_id">
                <option value="">— manuell eingeben —</option>
                {sites.map((s) => (
                  <option
                    value={s.id}
                    selected={p?.site_id === s.id}
                    data-kunde={s.customer}
                    data-objekt={[s.name, s.street, [s.postal_code, s.city].filter(Boolean).join(' ')]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    {s.site_no} {s.name} – {s.customer}
                  </option>
                ))}
              </select>
              <label for="kunde">Kunde</label>
              <input
                id="kunde"
                name="kunde"
                value={p?.customer ?? ''}
                placeholder="Kundenname"
                list="gr-kunden"
              />
              <datalist id="gr-kunden">
                {customers.map((k) => (
                  <option value={k.customer} />
                ))}
              </datalist>
            </>,
          )}
          {step(
            2,
            '📍',
            'Objekt',
            <>
              <label for="objekt">Objekt / Adresse</label>
              <textarea id="objekt" name="objekt" rows={3} required>
                {p?.object ?? ''}
              </textarea>
            </>,
          )}
          {step(
            3,
            '📐',
            'Flächen & Preis',
            <>
              <label>Kalkulation</label>
              <div class="seg" style="margin-bottom:10px">
                <label>
                  <input
                    type="radio"
                    name="modus"
                    value="belaege"
                    checked={(p?.mode ?? 'belaege') === 'belaege'}
                  />
                  <span>Nach Belägen</span>
                </label>
                <label>
                  <input type="radio" name="modus" value="pauschal" checked={p?.mode === 'pauschal'} />
                  <span>Pauschal</span>
                </label>
              </div>
              <div data-mode="belaege">
                <p class="small mut">Belag wählen, Fläche (m²) und Verkaufs-Preis pro m² eintragen.</p>
                <div id="gr-floors">{floors.map((fl) => floorRow(fl))}</div>
                <template id="gr-floor-tpl">{floorRow(null)}</template>
                <button type="button" class="btn sm sec" id="gr-add-floor">
                  + Belag
                </button>
              </div>
              <div data-mode="pauschal" class="grid">
                <div>
                  <label for="pf">Gesamtfläche m²</label>
                  <input
                    id="pf"
                    name="p_flaeche"
                    value={p?.flat_sqm_x100 ? fmtSqm(p.flat_sqm_x100) : ''}
                    placeholder="z.B. 6000"
                    inputmode="decimal"
                  />
                </div>
                <div>
                  <label for="pv">Verkaufspreis gesamt €</label>
                  <input
                    id="pv"
                    name="p_vk"
                    value={p?.flat_price_cents ? centsToInput(p.flat_price_cents) : ''}
                    placeholder="z.B. 8000"
                    inputmode="decimal"
                  />
                </div>
              </div>
              <p class="gr-live">
                Verkaufspreis gesamt: <b id="gr-vk">–</b>
              </p>
            </>,
          )}
          {step(
            4,
            '🧮',
            'Ausführung & Kalkulation',
            <>
              <label>Ausführung durch</label>
              <div class="seg" style="margin-bottom:10px">
                <label>
                  <input type="radio" name="ausfuehrung" value="eigen" checked={p?.execution === 'eigen'} />
                  <span>Eigenpersonal</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="ausfuehrung"
                    value="sub"
                    checked={(p?.execution ?? 'sub') === 'sub'}
                  />
                  <span>Subunternehmer</span>
                </label>
              </div>
              <div class="grid">
                <div>
                  <label for="db">Deckungsbeitrag %</label>
                  <input id="db" name="db" value={pctIn(p?.db_bp ?? 2500)} inputmode="decimal" />
                </div>
              </div>
              <div data-exec="sub" class="grid">
                <div>
                  <label for="sub">Subunternehmer</label>
                  <select id="sub" name="sub_id">
                    <option value="">– später wählen –</option>
                    {subs.map((s) => (
                      <option value={s.id} selected={p?.supplier_id === s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label for="mat_von">Material</label>
                  <select id="mat_von" name="mat_von" data-nosearch>
                    <option value="uns" selected={(p?.material_from ?? 'uns') === 'uns'}>
                      von uns
                    </option>
                    <option value="sub" selected={p?.material_from === 'sub'}>
                      vom Sub
                    </option>
                  </select>
                </div>
                <div>
                  <label for="mat">Material %</label>
                  <input id="mat" name="mat" value={pctIn(p?.material_bp ?? 1000)} inputmode="decimal" />
                </div>
                <div>
                  <label for="ger_von">Geräte</label>
                  <select id="ger_von" name="ger_von" data-nosearch>
                    <option value="uns" selected={(p?.devices_from ?? 'uns') === 'uns'}>
                      von uns
                    </option>
                    <option value="sub" selected={p?.devices_from === 'sub'}>
                      vom Sub
                    </option>
                  </select>
                </div>
                <div>
                  <label for="ger">Geräte %</label>
                  <input id="ger" name="ger" value={pctIn(p?.devices_bp ?? 500)} inputmode="decimal" />
                </div>
                <div>
                  <label for="subp">Tatsächlicher Preis an Sub (Vorschlag unten als Anhaltspunkt)</label>
                  <input
                    id="subp"
                    name="sub_preis"
                    value={p?.sub_price_cents ? centsToInput(p.sub_price_cents) : ''}
                    inputmode="decimal"
                  />
                </div>
              </div>
              <div data-exec="eigen" class="grid">
                <p class="small mut">Eigenleistung: Kalkulation über 40,00 € netto/Stunde → Gesamtstunden.</p>
                <div>
                  <label for="maxh">Max. Stunden (optional – Stundenbudget)</label>
                  <input id="maxh" name="max_std" value={p?.max_hours ?? ''} inputmode="decimal" />
                </div>
              </div>
              <div class="gr-box" id="gr-box" />
            </>,
          )}
          {step(
            5,
            '📅',
            'Zeitraum & Status',
            <div class="grid">
              <div>
                <label for="von">Von</label>
                <input id="von" type="date" name="von" value={p?.date_from ?? ''} />
              </div>
              <div>
                <label for="bis">Bis</label>
                <input id="bis" type="date" name="bis" value={p?.date_to ?? ''} />
              </div>
              <div>
                <label for="status">Status</label>
                <select id="status" name="status" data-nosearch>
                  {DC_STATUS.map((s) => (
                    <option value={s} selected={(p?.status ?? 'Geplant') === s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="bem">Bemerkung für Vorarbeiter / Kunde (erscheint auf dem PDF)</label>
                <textarea id="bem" name="bemerkung" rows={3}>
                  {p?.note ?? ''}
                </textarea>
              </div>
            </div>,
          )}
          <div class="formfoot">
            <a class="btn sec" href="/grundreinigung" id="gr-cancel">
              Abbrechen
            </a>
            <button type="button" class="btn sec" id="gr-prev">
              Zurück
            </button>
            <button type="button" class="btn" id="gr-next">
              Weiter
            </button>
            <button class="btn" id="gr-save">
              Speichern
            </button>
          </div>
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var f=document.getElementById('gr-form'),steps=[].slice.call(f.querySelectorAll('.gr-step')),cur=0;
function num(v){v=(v||'').trim().replace(/\\./g,'').replace(',','.');var n=parseFloat(v);return isNaN(n)?0:n}
function eur(n){return n.toLocaleString('de-DE',{style:'currency',currency:'EUR'})}
function val(n){var e=f.querySelector('[name='+n+']:checked');return e?e.value:''}
function show(){steps.forEach(function(s,i){s.hidden=i!==cur});document.getElementById('gr-step-label').textContent='Schritt '+(cur+1)+' / 5';
document.getElementById('gr-bar').style.width=((cur+1)*20)+'%';document.getElementById('gr-prev').hidden=cur===0;document.getElementById('gr-next').hidden=cur===4;document.getElementById('gr-save').hidden=cur!==4;}
document.getElementById('gr-next').onclick=function(){if(cur===1&&!f.objekt.value.trim()){f.objekt.focus();return}cur=Math.min(4,cur+1);show()};
document.getElementById('gr-prev').onclick=function(){cur=Math.max(0,cur-1);show()};
f.site_id.addEventListener('change',function(){var o=f.site_id.selectedOptions[0];if(o&&o.dataset.kunde){f.kunde.value=o.dataset.kunde;f.objekt.value=o.dataset.objekt}});
var box=document.getElementById('gr-floors'),tpl=document.getElementById('gr-floor-tpl');
document.getElementById('gr-add-floor').onclick=function(){box.appendChild(tpl.content.firstElementChild.cloneNode(true));calc()};
box.addEventListener('click',function(e){var b=e.target.closest('[data-del-floor]');if(b&&box.children.length>1){b.parentElement.remove();calc()}});
function calc(){var mode=val('modus');f.querySelectorAll('[data-mode]').forEach(function(d){d.hidden=d.dataset.mode!==mode});
var ex=val('ausfuehrung');f.querySelectorAll('[data-exec]').forEach(function(d){d.hidden=d.dataset.exec!==ex});
var vk=0;if(mode==='pauschal')vk=num(f.p_vk.value);else box.querySelectorAll('.gr-floor').forEach(function(r){vk+=num(r.querySelector('[name=flaeche]').value)*num(r.querySelector('[name=preis]').value)});
document.getElementById('gr-vk').textContent=eur(vk);var dbp=num(f.db.value),db=vk*dbp/100,mat=vk*num(f.mat.value)/100,ger=vk*num(f.ger.value)/100;
var om=f.mat_von.value==='uns'?mat:0,og=f.ger_von.value==='uns'?ger:0,vor=Math.max(0,vk-db-om-og),sp=num(f.sub_preis.value),real=sp>0?sp:vor,rdb=vk-real-om-og,h='';
if(ex==='sub'){h='<div>Verkaufspreis <b>'+eur(vk)+'</b></div><div>− Deckungsbeitrag ('+dbp+'%) '+eur(db)+'</div><div>Material ('+(om?'von uns, −':'vom Sub, ')+f.mat.value+'%) '+eur(mat)+'</div><div>Geräte ('+(og?'von uns, −':'vom Sub, ')+f.ger.value+'%) '+eur(ger)+'</div><div class="gr-big">Vorschlag an Sub: <b>'+eur(vor)+'</b></div>'+(sp>0?'<div>Tatsächlich an Sub '+eur(sp)+' → tatsächlicher Deckungsbeitrag <b class="'+(rdb>=0?'kb-pos':'kb-neg')+'">'+eur(rdb)+'</b></div>':'');}
else{var std=vk/40,mx=num(f.max_std.value);h='<div>Verkaufspreis <b>'+eur(vk)+'</b></div><div>Stundensatz 40,00 €</div><div class="gr-big">Gesamtstunden: <b>'+std.toLocaleString('de-DE',{maximumFractionDigits:1})+' h</b></div>'+(mx>0?(std>mx?'<div class="kb-neg">⚠ '+(std-mx).toLocaleString('de-DE',{maximumFractionDigits:1})+' h über dem Budget</div>':'<div class="kb-pos">✓ Im Stundenbudget ('+(mx-std).toLocaleString('de-DE',{maximumFractionDigits:1})+' h Reserve)</div>'):'');}
document.getElementById('gr-box').innerHTML=h}
f.addEventListener('input',calc);f.addEventListener('change',calc);calc();show();})();`,
          }}
        />
      </div>,
    );
  });

  app.post(`/grundreinigung/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const belaege = arr(b, 'belag');
    const fl = arr(b, 'flaeche');
    const pr = arr(b, 'preis');
    const floors = belaege
      .map((bel, i) => ({ belag: bel, sqm: fl[i] ?? '', price: pr[i] ?? '' }))
      .filter((x) => x.sqm.trim() || x.price.trim())
      .map((x) => ({
        belag: x.belag,
        sqm_x100: sqm(x.sqm) ?? 0,
        price_cents: Number(money(x.price, 'Preis je m²') ?? 0n),
      }));
    const maxh = str(b, 'max_std');
    await savePlan(
      sql,
      c.req.param('id'),
      {
        customer: str(b, 'kunde'),
        object: str(b, 'objekt') ?? '',
        site_id: str(b, 'site_id'),
        date_from: str(b, 'von'),
        date_to: str(b, 'bis'),
        execution: str(b, 'ausfuehrung') === 'eigen' ? 'eigen' : 'sub',
        supplier_id: str(b, 'sub_id'),
        mode: str(b, 'modus') === 'pauschal' ? 'pauschal' : 'belaege',
        flat_sqm_x100: (() => {
          const v = sqm(str(b, 'p_flaeche'));
          return v == null ? null : BigInt(v);
        })(),
        flat_price_cents: money(str(b, 'p_vk'), 'Verkaufspreis'),
        floors,
        db_bp: pct(str(b, 'db'), 2500),
        material_bp: pct(str(b, 'mat'), 1000),
        devices_bp: pct(str(b, 'ger'), 500),
        material_from: str(b, 'mat_von') === 'sub' ? 'sub' : 'uns',
        devices_from: str(b, 'ger_von') === 'sub' ? 'sub' : 'uns',
        sub_price_cents: money(str(b, 'sub_preis'), 'Preis an Sub'),
        max_hours: maxh ? String(Number(maxh.replace(',', '.'))) : null,
        status: str(b, 'status') ?? 'Geplant',
        note: str(b, 'bemerkung'),
        expectedVersion: str(b, 'version') ? Number(str(b, 'version')) : null,
      },
      c.get('actor'),
    );
    const y = (str(b, 'von') ?? todayBerlin()).slice(0, 4);
    return back(c, `/grundreinigung?jahr=${y}`, { ok: 'Planung gespeichert.' });
  });

  app.post(`/grundreinigung/:id{${UUID}}/status`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setPlanStatus(sql, c.req.param('id'), str(b, 'status') ?? '');
    const p = await getPlan(sql, c.req.param('id'));
    return back(c, `/grundreinigung?jahr=${p?.year ?? ''}`, { ok: `Status: ${str(b, 'status')}` });
  });

  app.post(`/grundreinigung/:id{${UUID}}/loeschen`, async (c) => {
    const p = await getPlan(sql, c.req.param('id'));
    await deletePlan(sql, c.req.param('id'));
    return back(c, `/grundreinigung?jahr=${p?.year ?? ''}`, { ok: 'Planung gelöscht.' });
  });

  const filtered = async (y: number, f: string, q: string) =>
    (await listPlans(sql, y))
      .filter(
        (p) =>
          !q ||
          [p.object, p.customer, p.supplier_name].some((v) =>
            (v ?? '').toLowerCase().includes(q.toLowerCase()),
          ),
      )
      .filter((p) => !f || p.status === f);

  app.get('/grundreinigung/export.csv', async (c) => {
    const y = Number(c.req.query('jahr')) || Number(todayBerlin().slice(0, 4));
    const prices = c.req.query('preise') !== '0';
    const list = await filtered(y, c.req.query('filter') ?? '', c.req.query('q') ?? '');
    const q = (s: string | null | undefined) =>
      `"${(s ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const e = (c2: bigint) => centsToInput(c2);
    const head = [
      'Objekt',
      'Kunde',
      'Von',
      'Bis',
      'Ausführung',
      'Subunternehmer',
      'Bodenbeläge',
      'Material',
      'Geräte',
    ];
    if (prices) head.push('Umsatz VK €', 'DB €', 'DB %', 'an Sub € / Stunden');
    head.push('Status', 'Bemerkung');
    const rows = list.map((p: DcPlan) => {
      const k = calc(p);
      const r = [
        q(p.object.replace(/\n/g, ', ')),
        q(p.customer),
        p.date_from ? dateDe(p.date_from) : '',
        p.date_to ? dateDe(p.date_to) : '',
        p.execution === 'eigen' ? 'Eigenpersonal' : 'Subunternehmer',
        q(p.supplier_name),
        q(summary(p)),
        p.material_from === 'uns' ? 'von uns' : 'vom Sub',
        p.devices_from === 'uns' ? 'von uns' : 'vom Sub',
      ];
      if (prices)
        r.push(
          e(k.vk),
          e(k.effDb),
          k.vk ? (Number((k.effDb * 10000n) / k.vk) / 100).toFixed(2).replace('.', ',') : '',
          p.execution === 'eigen' ? `${hrs(k.hours100)} h` : e(k.sub),
        );
      r.push(p.status, q(p.note));
      return r.join(';');
    });
    return new Response(`\uFEFF${head.join(';')}\r\n${rows.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Grundreinigung_${y}${prices ? '' : '_ohne_Preise'}.csv"`,
      },
    });
  });

  app.get('/grundreinigung/druck', async (c) => {
    const y = Number(c.req.query('jahr')) || Number(todayBerlin().slice(0, 4));
    const prices = c.req.query('preise') !== '0';
    const f = c.req.query('filter') ?? '';
    const list = await filtered(y, f, c.req.query('q') ?? '');
    const esc = (s: string | null | undefined) =>
      (s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    let tv = 0n;
    let ts = 0n;
    let td = 0n;
    const items = list
      .map((p) => {
        const k = calc(p);
        tv += k.vk;
        ts += p.execution === 'sub' ? k.sub : 0n;
        td += k.effDb;
        const floors =
          p.mode === 'pauschal'
            ? `<li>Pauschal ${fmtSqm(p.flat_sqm_x100 ?? 0n)} m²${prices ? ` = ${euro(k.vk)}` : ''}</li>`
            : p.floors
                .map(
                  (fl) =>
                    `<li>${esc(fl.belag)} ${fmtSqm(BigInt(fl.sqm_x100))} m²${prices ? ` × ${euro(BigInt(fl.price_cents))}/m² = ${euro((BigInt(fl.sqm_x100) * BigInt(fl.price_cents) + 50n) / 100n)}` : ''}</li>`,
                )
                .join('');
        return `<div class="it"><div class="h"><b>${esc(p.object.split('\n')[0])}</b><span>${p.execution === 'eigen' ? `${hrs(k.hours100)} h Eigenleistung` : prices ? `${euro(k.sub)} an Sub` : esc(p.supplier_name ?? 'Subunternehmer')}</span></div>
<div class="m">${esc(p.customer)} · ${p.date_from ? dateDe(p.date_from) : ''}${p.date_to ? ` – ${dateDe(p.date_to)}` : ''} · ${p.status} · ${p.execution === 'eigen' ? 'Eigenpersonal' : `Sub: ${esc(p.supplier_name ?? '–')}`}</div>
<ul>${floors}</ul><div class="m">Material: ${p.material_from === 'uns' ? 'von uns' : 'vom Sub'} · Geräte: ${p.devices_from === 'uns' ? 'von uns' : 'vom Sub'}${prices ? ` · VK ${euro(k.vk)} · DB ${euro(k.effDb)}` : ''}</div>
${p.note ? `<div class="b"><b>Bemerkung:</b> ${esc(p.note)}</div>` : ''}</div>`;
      })
      .join('');
    const title = `Planung Grundreinigung ${y} – ${f === 'Ausgeführt' ? 'Archiv (ausgeführt)' : f ? 'Offene Planung' : 'Alle (Jahresaufstellung)'}${prices ? '' : ' (ohne Verkaufspreise)'}`;
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page{size:A4;margin:14mm}body{font-family:Inter,system-ui,Arial,sans-serif;font-size:11px;color:#1c1917}h1{color:#7D1435;font-size:18px}
.it{border-bottom:1px solid #ddd;padding:8px 0;page-break-inside:avoid}.h{display:flex;justify-content:space-between;font-size:12px}.m{color:#666;margin-top:2px}ul{margin:4px 0 2px 16px;padding:0}
.b{background:#f7f2f3;padding:4px 6px;margin-top:4px}.sum{margin-top:12px;font-weight:700}.bar{text-align:center;margin-bottom:10px}.bar button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#7D1435;color:#fff}
@media print{.bar{display:none}}</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button></div><img src="/static/logo-transparent.png" alt="Viva-Deluxe" style="height:40px;display:block;margin-bottom:6px"><h1>${esc(title)}</h1>${items}
<div class="sum">Summe (${list.length})${prices ? `: VK ${euro(tv)} · an Sub ${euro(ts)} · DB ${euro(td)}` : ''}</div></body></html>`);
  });
}
