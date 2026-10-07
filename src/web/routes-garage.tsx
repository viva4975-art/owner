import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { isoWeekday } from '../domain/time/holidays.js';
import {
  TG_CUSTOMERS,
  TG_KINDS,
  type TgAppointment,
  type TgObject,
  type TgPlanOptions,
  applyTgPlan,
  autoPlanTg,
  createWorkReport,
  deleteTgAppointment,
  deleteTgObject,
  getTgAppointment,
  getTgObject,
  listTgAppointments,
  listTgObjects,
  noticesPdf,
  saveTgAppointment,
  saveTgObject,
  setPausedAll,
  setTgFlag,
  tgCsv,
} from '../services/garage.js';
import { type Ctx, UUID } from './app.js';
import { arr, str } from './forms.js';
import { dateDe } from './layout.js';

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const n = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
const daysTxt = (a: TgAppointment) =>
  a.days
    .map((d) => `${WD[isoWeekday(d.date) - 1]} ${dateDe(d.date).slice(0, 6)} ${d.from}–${d.to}`)
    .join(' · ');

/** Tiefgaragenplanung wie die alte App. */
export function registerGarageRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  const load = async (kunde: string, view: string, q: string) => {
    const [objs, apps] = await Promise.all([listTgObjects(sql), listTgAppointments(sql)]);
    const ql = q.toLowerCase();
    const os = objs
      .filter((o) => !kunde || o.customer === kunde)
      .filter(
        (o) =>
          !ql ||
          [o.name, o.city, o.we_no, o.tob_name, o.postal_code].some((v) =>
            (v ?? '').toLowerCase().includes(ql),
          ),
      );
    const ids = new Set(os.map((o) => o.id));
    const as = apps.filter((a) => ids.has(a.object_id));
    const shownApps = as.filter((a) =>
      view === 'offen' ? !a.done : view === 'abgeschlossen' ? a.done : true,
    );
    return { objs: os, apps: as, shownApps };
  };

  app.get('/tiefgarage', async (c) => {
    const today = todayBerlin();
    const kunde = c.req.query('kunde') ?? '';
    const view = c.req.query('ansicht') ?? 'offen';
    const q = (c.req.query('q') ?? '').trim();
    const { objs, apps, shownApps } = await load(kunde, view, q);
    const link = (o: Record<string, string>) =>
      `/tiefgarage?${new URLSearchParams({ ...(kunde ? { kunde } : {}), ansicht: view, ...(q ? { q } : {}), ...o })}`;
    const firstOf = (o: TgObject) => shownApps.filter((a) => a.object_id === o.id)[0]?.first_day ?? '9999';
    const sorted = [...objs].sort(
      (a, b) => firstOf(a).localeCompare(firstOf(b)) || a.name.localeCompare(b.name),
    );
    const tile = (key: string, num: number, lbl: string, tone = '', click = true) =>
      click ? (
        <a
          class={`stat-card${tone ? ` tone-${tone}` : ''}${view === key ? ' on' : ''}`}
          href={link({ ansicht: key })}
        >
          <div class="stat-num">{num}</div>
          <div class="stat-lbl">{lbl}</div>
        </a>
      ) : (
        <div class={`stat-card${tone ? ` tone-${tone}` : ''}`}>
          <div class="stat-num">{num}</div>
          <div class="stat-lbl">{lbl}</div>
        </div>
      );
    const mail = (o: TgObject, reminder: boolean) => {
      const next = apps.filter((a) => a.object_id === o.id && !a.done && a.last_day >= today);
      const subject = `${reminder ? 'Erinnerung: ' : ''}Tiefgaragenreinigung – ${o.name}${o.we_no ? ` (WE ${o.we_no})` : ''}`;
      const body = `Sehr geehrte Damen und Herren,\n\nwir ${reminder ? 'erinnern an' : 'kündigen'} die Tiefgaragenreinigung für folgendes Objekt${reminder ? '' : ' an'}:\n${o.name}, ${[o.postal_code, o.city].filter(Boolean).join(' ')}\n\nTermin(e):\n${next.map(daysTxt).join('\n')}\n\nBitte hängen Sie den beigefügten Aushang rechtzeitig aus.\n\nMit freundlichen Grüßen`;
      return `mailto:${encodeURIComponent(o.tob_email ?? '')}?${new URLSearchParams({ ...(o.deputy_email ? { cc: o.deputy_email } : {}), subject, body }).toString().replace(/\+/g, '%20')}`;
    };
    return page(
      c,
      'Tiefgaragenreinigung',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Vor Ort</div>
            <h1>Tiefgaragenreinigung</h1>
            <div class="sub">Planung, Termine und Aushänge – Münchner Wohnen und Dawonia.</div>
          </div>
          <div class="acts">
            <a
              class="btn sec"
              href={`/tiefgarage/autoplan${kunde ? `?kunde=${encodeURIComponent(kunde)}` : ''}`}
            >
              ⚙ Auto-Planen
            </a>
            <a class="btn" href={`/tiefgarage/objekt/${randomUUID()}`}>
              + Neues Objekt
            </a>
          </div>
        </div>
        <div class="pills" style="margin-bottom:12px">
          <a class={`pill${!kunde ? ' on' : ''}`} href={`/tiefgarage?ansicht=${view}`}>
            Alle
          </a>
          {TG_CUSTOMERS.map((k) => (
            <a
              class={`pill${kunde === k ? ' on' : ''}`}
              href={`/tiefgarage?${new URLSearchParams({ kunde: k, ansicht: view })}`}
            >
              {k}
            </a>
          ))}
        </div>
        <div class="stat-grid">
          {tile('alle', apps.length, 'Termine')}
          {tile('offen', apps.filter((a) => !a.done).length, 'Offen', 'warn')}
          {tile('abgeschlossen', apps.filter((a) => a.done).length, 'Abgeschlossen', 'ok')}
          {tile('', apps.filter((a) => a.confirmed).length, 'Bestätigt', '', false)}
        </div>
        <form class="toolbar" method="get" action="/tiefgarage">
          {kunde && <input type="hidden" name="kunde" value={kunde} />}
          <input type="hidden" name="ansicht" value={view} />
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Objekt, Ort, WE-Nr. oder Objektbetreuer…"
          />
        </form>
        <div class="actions" style="margin:-4px 0 14px">
          <a
            class="btn sm sec"
            href={link({ druck: 'liste' }).replace('/tiefgarage?', '/tiefgarage/druck?')}
            target="_blank"
          >
            Terminliste (Druck)
          </a>
          <a
            class="btn sm sec"
            href={link({ druck: 'vorarbeiter' }).replace('/tiefgarage?', '/tiefgarage/druck?')}
            target="_blank"
          >
            Vorarbeiter-Liste
          </a>
          <a class="btn sm sec" href={link({}).replace('/tiefgarage?', '/tiefgarage/export.csv?')}>
            Excel (CSV)
          </a>
          <a
            class="btn sm sec"
            href={link({}).replace('/tiefgarage?', '/tiefgarage/aushaenge.pdf?')}
            target="_blank"
          >
            Alle Aushänge (PDF)
          </a>
          <details class="pop">
            <summary class="btn sm sec">✓ Alle markieren</summary>
            <div class="panel">
              <form method="post" action="/tiefgarage/alle">
                <input type="hidden" name="kunde" value={kunde} />
                <input type="hidden" name="q" value={q} />
                <button class="btn sm" name="aktion" value="bestaetigen">
                  Alle bestätigen
                </button>
                <button class="btn sm sec" name="aktion" value="as">
                  Bestätigen + Arbeitsscheine
                </button>
                <button
                  class="btn sm sec"
                  name="aktion"
                  value="abschliessen"
                  data-confirm="Alle offenen Termine abschließen?"
                >
                  Alle abschließen
                </button>
              </form>
            </div>
          </details>
          <details class="pop">
            <summary class="btn sm sec">⏸ Objekte pausieren</summary>
            <div class="panel">
              <form method="post" action="/tiefgarage/pausieren">
                <input type="hidden" name="kunde" value={kunde} />
                <button class="btn sm sec" name="pause" value="">
                  Alle reaktivieren
                </button>
                <button class="btn sm sec" name="pause" value="1">
                  Alle pausieren (dieses Jahr)
                </button>
              </form>
            </div>
          </details>
        </div>
        {sorted.length === 0 && <div class="empty">Noch keine Tiefgaragen-Objekte.</div>}
        <div class="list-cards">
          {sorted.map((o) => {
            const own = shownApps.filter((a) => a.object_id === o.id);
            return (
              <div class={`lc${o.active && !o.paused ? '' : ' lc-inactive'}`}>
                <div class="lc-head">
                  <div>
                    <span class="lc-name">{o.name}</span>
                    <div class="lc-sub">
                      {[o.address, [o.postal_code, o.city].filter(Boolean).join(' ')]
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                    <div class="lc-details">
                      <span>{o.customer}</span>
                      {o.we_no && <span>WE {o.we_no}</span>}
                      {(o.spaces_fixed || o.spaces_duplex) && (
                        <span>
                          {o.spaces_fixed ?? 0} fest · {o.spaces_duplex ?? 0} Duplex
                        </span>
                      )}
                      {o.sqm && <span>{o.sqm} m²</span>}
                      {o.duration && <span>{o.duration}</span>}
                      {o.tob_name && (
                        <span>
                          TOB {o.tob_name}
                          {o.tob_mobile ? ` · ${o.tob_mobile}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <div class="lc-right">
                    {o.paused && <span class="badge warn">dieses Jahr pausiert</span>}
                    {!o.active && <span class="badge">inaktiv</span>}
                  </div>
                </div>
                {own.map((a) => {
                  const days = Math.round((Date.parse(a.first_day) - Date.parse(today)) / 864e5);
                  return (
                    <div class={`tg-row${a.done ? ' done' : a.confirmed ? ' ok' : ''}`}>
                      <span>
                        <b>{daysTxt(a)}</b>{' '}
                        <span class={`badge ${a.kind === 'Kehren' ? 'gold' : 'info'}`}>{a.kind}</span>
                        {a.done && <span class="badge"> abgeschlossen</span>}
                        {!a.done && days >= 0 && days <= 14 && (
                          <span class="badge warn">⏰ in {days} Tg.</span>
                        )}
                        {a.note && <span class="small mut"> · {a.note}</span>}
                      </span>
                      <span class="gp-acts">
                        {!a.done && (
                          <form method="post" action={`/tiefgarage/termin/${a.id}/flag`} class="inline-form">
                            <input type="hidden" name="flag" value="confirmed" />
                            <input type="hidden" name="wert" value={a.confirmed ? '' : '1'} />
                            <button class="btn sm sec">{a.confirmed ? '✓ best.' : 'bestätigen'}</button>
                          </form>
                        )}
                        {a.work_report_id ? (
                          <a class="btn sm sec" href={`/arbeitsscheine/${a.work_report_id}`}>
                            📄 AS
                          </a>
                        ) : (
                          <form method="post" action={`/tiefgarage/termin/${a.id}/as`} class="inline-form">
                            <button class="btn sm sec" title="Arbeitsschein anlegen">
                              + AS
                            </button>
                          </form>
                        )}
                        <form method="post" action={`/tiefgarage/termin/${a.id}/flag`} class="inline-form">
                          <input type="hidden" name="flag" value="done" />
                          <input type="hidden" name="wert" value={a.done ? '' : '1'} />
                          <button class="btn sm sec">{a.done ? '↩' : '✓ fertig'}</button>
                        </form>
                        {!a.done && (
                          <a class="btn sm sec" href={`/tiefgarage/termin/${a.id}`} title="bearbeiten">
                            ✎
                          </a>
                        )}
                      </span>
                    </div>
                  );
                })}
                <div class="lc-foot gp-acts">
                  <a class="btn sm sec" href={`/tiefgarage/termin/${randomUUID()}?objekt=${o.id}`}>
                    + Termin
                  </a>
                  <a class="btn sm sec" href={`/tiefgarage/objekt/${o.id}`}>
                    Objekt bearbeiten
                  </a>
                  <a class="btn sm sec" href={`/tiefgarage/aushaenge.pdf?objekt=${o.id}`} target="_blank">
                    Aushang (PDF)
                  </a>
                  {o.tob_email && (
                    <>
                      <a class="btn sm sec" href={mail(o, false)}>
                        Aushang-Mail
                      </a>
                      <a class="btn sm sec" href={mail(o, true)}>
                        Erinnerung
                      </a>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>,
    );
  });

  // ------------------------------------------------------------------ Objekt
  app.get(`/tiefgarage/objekt/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const o = await getTgObject(sql, id);
    const sites = await sql<{ id: string; site_no: string; name: string; customer_name: string }[]>`
      select s.id, s.site_no, s.name, s.street, s.city, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id where s.active order by length(s.site_no), s.site_no`;
    const f = (k: keyof TgObject, label: string, extra: Record<string, string> = {}) => (
      <div>
        <label for={k}>{label}</label>
        <input id={k} name={k} value={o?.[k] == null ? '' : String(o[k])} {...extra} />
      </div>
    );
    return page(
      c,
      o ? o.name : 'Neues TG-Objekt',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/tiefgarage">Tiefgaragenreinigung</a>
            </div>
            <h1>{o ? o.name : 'Neues TG-Objekt'}</h1>
          </div>
        </div>
        <form method="post" action={`/tiefgarage/objekt/${id}`} class="card" style="max-width:900px">
          <input type="hidden" name="version" value={String(o?.version ?? '')} />
          <div class="grid">
            <div>
              <label for="customer">Kunde</label>
              <select id="customer" name="customer" data-nosearch>
                {TG_CUSTOMERS.map((k) => (
                  <option value={k} selected={(o?.customer ?? TG_CUSTOMERS[0]) === k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            {f('name', 'Objekt / Liegenschaft *', { required: '' })}
            {f('address', 'Straße')}
            {f('postal_code', 'PLZ', { inputmode: 'numeric' })}
            {f('city', 'Ort')}
            {f('sqm', 'm² (Münchner Wohnen)', { inputmode: 'numeric' })}
            {f('we_no', 'WE-Nr. (Dawonia)')}
            {f('owner_company', 'Besitzgesellschaft (Dawonia)')}
            {f('spaces_fixed', 'Stellplätze fest', { inputmode: 'numeric' })}
            {f('spaces_duplex', 'Stellplätze Duplex', { inputmode: 'numeric' })}
            {f('duration', 'Dauer', { placeholder: 'z.B. 4 Std., 1 Tag, 1/2 Tag' })}
            {f('tob_name', 'Objektbetreuer (TOB)')}
            {f('tob_email', 'TOB E-Mail', { type: 'email' })}
            {f('deputy_email', 'Vertretung E-Mail', { type: 'email' })}
            {f('tob_mobile', 'TOB Handy')}
            {f('object_no', 'Objektnummer')}
            <div>
              <label for="site">Objekt für Arbeitsschein (Kostenstelle)</label>
              <select id="site" name="site_id">
                <option value="">— nicht verknüpft —</option>
                <SiteOptions sites={sites} selected={o?.site_id} />
              </select>
            </div>
            <div>
              <label for="active">Aktiv</label>
              <select id="active" name="active" data-nosearch>
                <option value="1">ja</option>
                <option value="" selected={o ? !o.active : false}>
                  nein (inaktiv)
                </option>
              </select>
            </div>
            <div>
              <label for="paused">Dieses Jahr reinigen?</label>
              <select id="paused" name="paused" data-nosearch>
                <option value="">ja</option>
                <option value="1" selected={!!o?.paused}>
                  nein – dieses Jahr pausiert
                </option>
              </select>
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">{o ? 'Speichern' : 'Anlegen'}</button>
            <a class="btn sec" href="/tiefgarage">
              Abbrechen
            </a>
          </div>
        </form>
        {o && (
          <form method="post" action={`/tiefgarage/objekt/${id}/loeschen`} style="margin-top:8px">
            <button class="btn sm danger" data-confirm="Objekt mit allen offenen Terminen löschen?">
              Löschen
            </button>
          </form>
        )}
      </div>,
    );
  });

  app.post(`/tiefgarage/objekt/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveTgObject(sql, c.req.param('id'), {
      customer: str(b, 'customer') ?? TG_CUSTOMERS[0]!,
      name: str(b, 'name') ?? '',
      address: str(b, 'address'),
      postal_code: str(b, 'postal_code'),
      city: str(b, 'city'),
      sqm: n(str(b, 'sqm')),
      we_no: str(b, 'we_no'),
      spaces_fixed: n(str(b, 'spaces_fixed')),
      spaces_duplex: n(str(b, 'spaces_duplex')),
      duration: str(b, 'duration'),
      tob_name: str(b, 'tob_name'),
      tob_email: str(b, 'tob_email'),
      deputy_email: str(b, 'deputy_email'),
      tob_mobile: str(b, 'tob_mobile'),
      owner_company: str(b, 'owner_company'),
      object_no: str(b, 'object_no'),
      site_id: str(b, 'site_id'),
      active: str(b, 'active') === '1',
      paused: str(b, 'paused') === '1',
      expectedVersion: n(str(b, 'version')),
    });
    return back(c, '/tiefgarage', { ok: 'Objekt gespeichert.' });
  });

  app.post(`/tiefgarage/objekt/:id{${UUID}}/loeschen`, async (c) => {
    await deleteTgObject(sql, c.req.param('id'));
    return back(c, '/tiefgarage', { ok: 'Objekt gelöscht.' });
  });

  // ------------------------------------------------------------------ Termin
  app.get(`/tiefgarage/termin/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const a = await getTgAppointment(sql, id);
    const o = await getTgObject(sql, a?.object_id ?? c.req.query('objekt') ?? '');
    if (!o) return c.notFound();
    const days = a?.days ?? [{ date: todayBerlin(), from: '07:00', to: '11:00' }];
    const row = (d: { date: string; from: string; to: string } | null) => (
      <div class="gp-dayrow">
        <input type="date" name="tag" value={d?.date ?? ''} aria-label="Datum" />
        <input type="time" name="von" value={d?.from ?? '07:00'} aria-label="von" />
        <input type="time" name="bis" value={d?.to ?? '11:00'} aria-label="bis" />
        <button type="button" class="btn sm sec" data-del-day>
          ✕
        </button>
      </div>
    );
    return page(
      c,
      'TG-Termin',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/tiefgarage">Tiefgaragenreinigung</a>
            </div>
            <h1>{o.name}</h1>
            <div class="sub">{a ? 'Termin bearbeiten' : 'Neuer Termin'}</div>
          </div>
        </div>
        <form method="post" action={`/tiefgarage/termin/${id}`} class="card" style="max-width:760px">
          <input type="hidden" name="objekt" value={o.id} />
          <input type="hidden" name="version" value={String(a?.version ?? '')} />
          <label for="kind">Leistungsart</label>
          <select id="kind" name="kind" data-nosearch>
            {TG_KINDS.map((k) => (
              <option
                value={k}
                selected={
                  (a?.kind ?? (/dawonia/i.test(o.customer) ? 'Grundreinigung' : 'Nassreinigung')) === k
                }
              >
                {k}
              </option>
            ))}
          </select>
          <label style="margin-top:12px">Tage</label>
          <div id="gp-days">{days.map((d) => row(d))}</div>
          <template id="gp-day-tpl">{row(null)}</template>
          <button type="button" class="btn sm sec" id="gp-add-day">
            + Tag
          </button>
          <label for="note" style="margin-top:12px">
            Notiz
          </label>
          <input id="note" name="note" value={a?.note ?? ''} placeholder="optional" />
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href="/tiefgarage">
              Abbrechen
            </a>
          </div>
        </form>
        {a && (
          <form method="post" action={`/tiefgarage/termin/${id}/loeschen`} style="margin-top:8px">
            <button class="btn sm danger" data-confirm="Termin löschen?">
              Termin löschen
            </button>
          </form>
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var box=document.getElementById('gp-days'),tpl=document.getElementById('gp-day-tpl');
document.getElementById('gp-add-day').addEventListener('click',function(){box.appendChild(tpl.content.firstElementChild.cloneNode(true))});
box.addEventListener('click',function(e){var b=e.target.closest('[data-del-day]');if(b&&box.children.length>1)b.parentElement.remove()});})();`,
          }}
        />
      </div>,
    );
  });

  app.post(`/tiefgarage/termin/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const dates = arr(b, 'tag');
    const froms = arr(b, 'von');
    const tos = arr(b, 'bis');
    await saveTgAppointment(
      sql,
      c.req.param('id'),
      {
        objectId: str(b, 'objekt') ?? '',
        days: dates
          .map((d, i) => ({ date: d, from: froms[i] ?? '', to: tos[i] ?? '' }))
          .filter((d) => d.date),
        kind: str(b, 'kind') ?? 'Nassreinigung',
        note: str(b, 'note'),
        expectedVersion: n(str(b, 'version')),
      },
      c.get('actor'),
    );
    return back(c, '/tiefgarage', { ok: 'Termin gespeichert.' });
  });

  app.post(`/tiefgarage/termin/:id{${UUID}}/flag`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const flag = str(b, 'flag') === 'done' ? 'done' : 'confirmed';
    const value = str(b, 'wert') === '1';
    await setTgFlag(sql, c.req.param('id'), flag, value);
    // wie alte App: beim Bestätigen gleich den Arbeitsschein anlegen (falls Objekt verknüpft)
    let note = '';
    if (flag === 'confirmed' && value) {
      const o = await getTgObject(sql, (await getTgAppointment(sql, c.req.param('id')))!.object_id);
      if (o?.site_id) {
        await createWorkReport(sql, c.req.param('id'), c.get('actor'));
        note = ' Arbeitsschein angelegt.';
      }
    }
    return back(c, '/tiefgarage', { ok: `Gespeichert.${note}` });
  });

  app.post(`/tiefgarage/termin/:id{${UUID}}/as`, async (c) => {
    const wr = await createWorkReport(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/arbeitsscheine/${wr}`, { ok: 'Arbeitsschein angelegt.' });
  });

  app.post(`/tiefgarage/termin/:id{${UUID}}/loeschen`, async (c) => {
    await deleteTgAppointment(sql, c.req.param('id'));
    return back(c, '/tiefgarage', { ok: 'Termin gelöscht.' });
  });

  app.post('/tiefgarage/alle', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const { apps } = await load(str(b, 'kunde') ?? '', 'offen', str(b, 'q') ?? '');
    const open = apps.filter((a) => !a.done);
    const action = str(b, 'aktion');
    let as = 0;
    const missing: string[] = [];
    for (const a of open) {
      if (action === 'abschliessen') await setTgFlag(sql, a.id, 'done', true);
      else {
        await setTgFlag(sql, a.id, 'confirmed', true);
        if (action === 'as') {
          const o = (await getTgObject(sql, a.object_id))!;
          if (o.site_id) {
            await createWorkReport(sql, a.id, c.get('actor'));
            as++;
          } else missing.push(o.name);
        }
      }
    }
    return back(c, '/tiefgarage', {
      ok: `${open.length} Termine ${action === 'abschliessen' ? 'abgeschlossen' : 'bestätigt'}${action === 'as' ? `, ${as} Arbeitsscheine` : ''}.${missing.length ? ` Ohne verknüpftes Objekt (kein AS): ${missing.slice(0, 5).join(', ')}` : ''}`,
    });
  });

  app.post('/tiefgarage/pausieren', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setPausedAll(sql, str(b, 'pause') === '1', str(b, 'kunde'));
    return back(c, '/tiefgarage', { ok: str(b, 'pause') === '1' ? 'Alle pausiert.' : 'Alle reaktiviert.' });
  });

  // ------------------------------------------------------------------ Auto-Planer
  const planOpts = (g: (k: string) => string | null | undefined): TgPlanOptions => ({
    customer: g('kunde') || null,
    kind: g('kind') || 'Nassreinigung',
    start: g('start') || todayBerlin(),
    dayStart: g('beginn') || '07:00',
    hoursPerDay: Number((g('std') || '8,5').replace(',', '.')),
    skipHolidays: g('feiertage') !== 'nein',
    blockFrom: g('sperre_von') || null,
    blockTo: g('sperre_bis') || null,
    onlyWithout: g('nur_neue') !== 'nein',
  });

  app.get('/tiefgarage/autoplan', async (c) => {
    const g = (k: string) => c.req.query(k);
    const o = planOpts(g);
    const run = g('los') === '1';
    const plan = run ? await autoPlanTg(sql, o) : [];
    const sel = (name: string, opts: [string, string][], v: string) => (
      <select id={name} name={name} data-nosearch>
        {opts.map(([k, l]) => (
          <option value={k} selected={v === k}>
            {l}
          </option>
        ))}
      </select>
    );
    const qs = new URLSearchParams(Object.entries(c.req.query()).filter(([k]) => k !== 'los'));
    return page(
      c,
      'Auto-Termin-Planer',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/tiefgarage">Tiefgaragenreinigung</a>
            </div>
            <h1>Auto-Termin-Planer</h1>
            <div class="sub">
              Objekte werden Mo–Fr nach ihrer Dauer gepackt (mehrere kleine an einem Tag),
              Wochenenden/Feiertage/Sperrzeit übersprungen. Reihenfolge nach PLZ, dann Name.
            </div>
          </div>
        </div>
        {!run ? (
          <form method="get" action="/tiefgarage/autoplan" class="card" style="max-width:760px">
            <input type="hidden" name="los" value="1" />
            <div class="grid">
              <div>
                <label for="kunde">Kunde</label>
                {sel(
                  'kunde',
                  [['', 'Alle'], ...TG_CUSTOMERS.map((k): [string, string] => [k, k])],
                  o.customer ?? '',
                )}
              </div>
              <div>
                <label for="kind">Leistungsart</label>
                {sel(
                  'kind',
                  TG_KINDS.map((k): [string, string] => [k, k]),
                  o.kind,
                )}
              </div>
              <div>
                <label for="start">Startdatum</label>
                <input id="start" type="date" name="start" value={o.start} />
              </div>
              <div>
                <label for="beginn">Tagesbeginn</label>
                <input id="beginn" type="time" name="beginn" value={o.dayStart} />
              </div>
              <div>
                <label for="std">Std. pro Tag</label>
                <input
                  id="std"
                  name="std"
                  value={String(o.hoursPerDay).replace('.', ',')}
                  inputmode="decimal"
                />
              </div>
              <div>
                <label for="feiertage">Feiertage (Bayern) auslassen</label>
                {sel(
                  'feiertage',
                  [
                    ['ja', 'ja'],
                    ['nein', 'nein'],
                  ],
                  o.skipHolidays ? 'ja' : 'nein',
                )}
              </div>
              <div>
                <label for="sv">Sperr-Zeitraum von</label>
                <input id="sv" type="date" name="sperre_von" value={o.blockFrom ?? ''} />
              </div>
              <div>
                <label for="sb">Sperr-Zeitraum bis</label>
                <input id="sb" type="date" name="sperre_bis" value={o.blockTo ?? ''} />
              </div>
              <div>
                <label for="nur_neue">Nur Objekte ohne Termin dieser Leistungsart</label>
                {sel(
                  'nur_neue',
                  [
                    ['ja', 'ja (nur neue planen)'],
                    ['nein', 'nein (alle einplanen)'],
                  ],
                  o.onlyWithout ? 'ja' : 'nein',
                )}
              </div>
            </div>
            <div class="formfoot">
              <button class="btn">Vorschau</button>
            </div>
          </form>
        ) : (
          <form method="post" action="/tiefgarage/autoplan" class="card">
            {[...qs.entries()].map(([k, v]) => (
              <input type="hidden" name={k} value={v} />
            ))}
            <h3>Vorschau – Auto-Planung ({plan.length} Objekte)</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Objekt</th>
                    <th>Dauer</th>
                    <th>geplant</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.map((p) => (
                    <tr>
                      <td>
                        {p.object.name} <span class="small mut">{p.object.postal_code}</span>
                      </td>
                      <td>
                        {p.object.duration ?? '—'}
                        {p.guessed && <span class="badge warn"> ½ Tag angenommen</span>}
                      </td>
                      <td>
                        {p.days
                          .map((d) => `${WD[isoWeekday(d.date) - 1]} ${dateDe(d.date)} ${d.from}–${d.to}`)
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!o.onlyWithout && (
              <label class="chk">
                <input type="checkbox" name="ersetzen" value="1" /> vorhandene offene, unbestätigte Termine
                dieser Leistungsart ersetzen
              </label>
            )}
            <div class="formfoot">
              <a class="btn sec" href={`/tiefgarage/autoplan?${qs}`}>
                ← Zurück
              </a>
              <button class="btn" disabled={!plan.length}>
                Termine übernehmen
              </button>
            </div>
          </form>
        )}
      </div>,
    );
  });

  app.post('/tiefgarage/autoplan', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const o = planOpts((k) => str(b, k));
    const nn = await applyTgPlan(sql, o, str(b, 'ersetzen') === '1', c.get('actor'));
    return back(c, '/tiefgarage', { ok: `${nn} Termine angelegt.` });
  });

  // ------------------------------------------------------------------ Exporte
  app.get('/tiefgarage/export.csv', async (c) => {
    const { objs, shownApps } = await load(
      c.req.query('kunde') ?? '',
      c.req.query('ansicht') ?? 'alle',
      c.req.query('q') ?? '',
    );
    const k = c.req.query('kunde');
    return new Response(tgCsv(objs, shownApps), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Tiefgarage_${k ? (/dawonia/i.test(k) ? 'Dawonia' : 'MuenchnerWohnen') : 'Alle'}_${c.req.query('ansicht') ?? 'alle'}.csv"`,
      },
    });
  });

  app.get('/tiefgarage/aushaenge.pdf', async (c) => {
    const one = c.req.query('objekt');
    const ids = one
      ? [one]
      : (await load(c.req.query('kunde') ?? '', 'offen', c.req.query('q') ?? '')).objs.map((o) => o.id);
    return new Response(await noticesPdf(sql, ids), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="Aushang_Tiefgarage.pdf"',
      },
    });
  });

  app.get('/tiefgarage/druck', async (c) => {
    const vor = c.req.query('druck') === 'vorarbeiter';
    const { objs, shownApps } = await load(
      c.req.query('kunde') ?? '',
      c.req.query('ansicht') ?? 'offen',
      c.req.query('q') ?? '',
    );
    const byId = new Map(objs.map((o) => [o.id, o]));
    const esc = (s: string | null | undefined) =>
      (s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const rows = shownApps
      .flatMap((a) => a.days.map((d) => ({ a, d, o: byId.get(a.object_id)! })))
      .sort((x, y) => x.d.date.localeCompare(y.d.date) || x.d.from.localeCompare(y.d.from))
      .map(({ a, d, o }) =>
        vor
          ? `<tr><td>${WD[isoWeekday(d.date) - 1]} ${dateDe(d.date)}</td><td>${esc(o.name)}<br><small>${esc([o.postal_code, o.city].join(' '))}</small></td><td>${d.from}–${d.to}</td><td>${esc(a.kind)}</td><td>${esc(o.tob_name)} ${esc(o.tob_mobile)}</td><td style="width:90px"></td></tr>`
          : `<tr><td>${WD[isoWeekday(d.date) - 1]} ${dateDe(d.date)}</td><td>${esc(o.name)}</td><td>${esc(o.owner_company ?? o.customer)}</td><td>${o.sqm ? `${o.sqm} m²` : `${o.spaces_fixed ?? 0} / ${o.spaces_duplex ?? 0}`}</td><td>${d.from}–${d.to}</td><td>${esc(o.tob_name)}</td></tr>`,
      )
      .join('');
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${vor ? 'Einsatzliste Vorarbeiter' : 'Terminliste Tiefgarage'}</title><style>
@page{size:A4 ${vor ? 'portrait' : 'landscape'};margin:12mm}body{font-family:Inter,system-ui,Arial,sans-serif;font-size:11px;color:#1c1917}
h1{color:#7D1435;font-size:20px}table{width:100%;border-collapse:collapse}th{background:#7D1435;color:#fff;text-align:left;padding:5px}td{border-bottom:1px solid #ddd;padding:5px;vertical-align:top}
.bar{text-align:center;margin-bottom:10px}.bar button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#7D1435;color:#fff}@media print{.bar{display:none}}</style></head><body>
<div class="bar"><button onclick="print()">Drucken / als PDF speichern</button></div><img src="/static/logo-transparent.png" alt="Viva-Deluxe" style="height:40px;display:block;margin-bottom:6px"><h1>${vor ? 'Einsatzliste Vorarbeiter' : 'Terminliste Tiefgaragenreinigung'}</h1>
<table><thead><tr>${vor ? '<th>Datum</th><th>Objekt</th><th>Uhrzeit</th><th>Leistung</th><th>Objektbetreuer</th><th>erledigt</th>' : '<th>Datum</th><th>Objekt</th><th>Liegenschaft</th><th>Größe</th><th>Uhrzeit</th><th>Objektbetreuer</th>'}</tr></thead><tbody>${rows}</tbody></table></body></html>`);
  });
}
