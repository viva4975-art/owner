import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  ACTIVITY_KIND,
  type ActivityKind,
  PROSPECT_STATUS,
  type Prospect,
  type ProspectStatus,
  addActivity,
  deleteActivity,
  deleteProspect,
  dueState,
  getProspect,
  isClosed,
  listProspects,
  saveProspect,
} from '../services/prospects.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { dateDe } from './layout.js';

const PAGE = 50;
const STATUSES = Object.keys(PROSPECT_STATUS) as ProspectStatus[];
const nowLocal = () =>
  new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16).replace(' ', 'T');
const dtDe = (d: Date) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

const Badge = ({ s }: { s: ProspectStatus }) => (
  <span class={`badge ${PROSPECT_STATUS[s].tone}`}>{PROSPECT_STATUS[s].label}</span>
);

/** Akquise wie die alte App: Pipeline, Funnel, Wiedervorlage, Aktivitäten. */
export function registerProspectRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/akquise', async (c) => {
    const today = todayBerlin();
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const f = c.req.query('filter') ?? '';
    const pg = Math.max(1, Number(c.req.query('seite') ?? 1) || 1);
    const all = (await listProspects(sql)).filter(
      (p) => !q || [p.company, p.contact, p.city, p.object].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
    const n = (s: ProspectStatus) => all.filter((p) => p.status === s).length;
    const overdue = all.filter((p) => dueState(p, today) === 'overdue').length;
    const todayN = all.filter((p) => dueState(p, today) === 'today').length;
    const isDue = (p: Prospect) => !!p.followup_on && p.followup_on <= today && !isClosed(p.status);
    const list = all.filter((p) => (f === 'due' ? isDue(p) : f ? p.status === f : true));
    const shown = list.slice((pg - 1) * PAGE, pg * PAGE);
    const won = n('gewonnen');
    const lost = n('verloren');
    const nope = n('kein_interesse');
    const active = n('erstkontakt') + n('interesse_stark') + n('interesse_leicht');
    const conv = won + lost ? Math.round((won / (won + lost)) * 100) : 0;
    const link = (o: { filter?: string; seite?: number }) => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (o.filter) p.set('filter', o.filter);
      if (o.seite && o.seite > 1) p.set('seite', String(o.seite));
      const s = p.toString();
      return `/akquise${s ? `?${s}` : ''}`;
    };
    const tile = (key: string, num: number, lbl: string, tone = '') => (
      <a
        class={`stat-card${tone ? ` tone-${tone}` : ''}${f === key ? ' on' : ''}`}
        href={link({ filter: f === key ? '' : key })}
      >
        <div class="stat-num">{num}</div>
        <div class="stat-lbl">{lbl}</div>
      </a>
    );
    const stage = (s: ProspectStatus, last = false) => (
      <div class="ak-stage-w">
        <a class={`ak-stage ${PROSPECT_STATUS[s].tone}`} href={link({ filter: s })}>
          <b>{n(s)}</b>
          <span>{PROSPECT_STATUS[s].label}</span>
        </a>
        {!last && <span class="ak-arrow">↓</span>}
      </div>
    );
    return page(
      c,
      'Akquise',
      'kunden',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Vertrieb</div>
            <h1>Akquise</h1>
            <div class="sub">
              {all.length} Einträge in der Pipeline · {overdue + todayN} fällig heute oder überfällig
            </div>
          </div>
          <div class="acts">
            <a class="btn" href={`/akquise/${randomUUID()}`}>
              + Neue Akquise
            </a>
          </div>
        </div>
        <div class="stat-grid">
          {tile('', all.length, 'In Pipeline')}
          {tile('due', overdue + todayN, 'Heute / überfällig', 'err')}
          {tile('gewonnen', won, 'Gewonnen', 'ok')}
        </div>
        <form class="toolbar" method="get" action="/akquise">
          {f && <input type="hidden" name="filter" value={f} />}
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Suche nach Firma, Ansprechpartner, Ort…"
          />
        </form>
        <div class="ak-funnel">
          <div class="ak-funnel-h">
            <span>Pipeline · Funnel</span>
            <span>
              Aktive Leads: <b>{active}</b> ·{' '}
              <span class="kb-pos">
                Gewonnen: <b>{won}</b>
              </span>{' '}
              · Conversion: <b>{conv}%</b> <span class="mut">(gewonnen/entschieden)</span>
            </span>
          </div>
          <div class="ak-stages">
            {stage('erstkontakt')}
            {stage('interesse_leicht')}
            {stage('interesse_stark')}
            {stage('gewonnen', true)}
          </div>
          {lost + nope > 0 && (
            <div class="ak-funnel-f">
              <span class="kb-neg">
                Verloren: <b>{lost}</b>
              </span>
              <span>
                Kein Interesse: <b>{nope}</b>
              </span>
            </div>
          )}
        </div>
        <div class="pills" style="margin:14px 0">
          <a class={`pill${!f ? ' on' : ''}`} href={link({})}>
            Alle <span>{all.length}</span>
          </a>
          <a
            class={`pill${f === 'due' ? ' on' : ''}${overdue ? ' pill-err' : ''}`}
            href={link({ filter: 'due' })}
          >
            Heute / Überfällig <span>{overdue + todayN}</span>
          </a>
          {STATUSES.map((s) => (
            <a class={`pill${f === s ? ' on' : ''}`} href={link({ filter: s })}>
              {PROSPECT_STATUS[s].label} <span>{n(s)}</span>
            </a>
          ))}
        </div>
        {shown.length === 0 ? (
          <div class="empty">Keine Einträge in dieser Kategorie</div>
        ) : (
          <div class="list-cards">
            {shown.map((p) => {
              const d = dueState(p, today);
              return (
                <a class="lc" href={`/akquise/${p.id}`}>
                  <div class="lc-head">
                    <div>
                      <span class="lc-name">{p.company || '(ohne Firma)'}</span>
                      {p.contact && <div class="lc-sub">{p.contact}</div>}
                    </div>
                    <div class="lc-right">
                      <Badge s={p.status} />
                    </div>
                  </div>
                  <div class="lc-details">
                    {p.city && <span>{p.city}</span>}
                    {p.phone && <span>{p.phone}</span>}
                    {p.object && <span>{p.object}</span>}
                    {p.activity_count > 0 && (
                      <span>
                        {p.activity_count} Aktivität{p.activity_count === 1 ? '' : 'en'}
                      </span>
                    )}
                    {p.followup_on && (
                      <span class={d === 'overdue' ? 'ak-over' : d === 'today' ? 'ak-today' : ''}>
                        Wiedervorlage {dateDe(p.followup_on)}
                        {d === 'overdue' ? ' (überfällig)' : d === 'today' ? ' (heute!)' : ''}
                      </span>
                    )}
                  </div>
                  {p.last_kind && p.last_at && (
                    <div class="lc-foot small mut">
                      Zuletzt: {ACTIVITY_KIND[p.last_kind]} am{' '}
                      {p.last_at.toLocaleDateString('de-DE', {
                        timeZone: 'Europe/Berlin',
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                      })}
                      {p.last_note && ` · ${p.last_note.slice(0, 60)}${p.last_note.length > 60 ? '…' : ''}`}
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        )}
        {list.length > PAGE && (
          <div class="pager">
            {pg > 1 && <a href={link({ filter: f, seite: pg - 1 })}>‹ zurück</a>}
            <span>
              {(pg - 1) * PAGE + 1}–{Math.min(pg * PAGE, list.length)} von {list.length}
            </span>
            {pg * PAGE < list.length && <a href={link({ filter: f, seite: pg + 1 })}>weiter ›</a>}
          </div>
        )}
      </div>,
    );
  });

  app.get(`/akquise/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getProspect(sql, id);
    const p = data?.p;
    return page(
      c,
      p ? p.company : 'Neue Akquise',
      'kunden',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/akquise">Akquise</a>
            </div>
            <h1>{p ? p.company : 'Neue Akquise'}</h1>
            {p && (
              <div class="sub">
                <Badge s={p.status} />
                {p.followup_on && ` · Wiedervorlage ${dateDe(p.followup_on)}`}
              </div>
            )}
          </div>
        </div>
        <div class="cols">
          <form method="post" action={`/akquise/${id}`} class="card">
            <input type="hidden" name="version" value={String(p?.version ?? '')} />
            <div class="grid">
              <div>
                <label for="firma">Firma *</label>
                <input id="firma" name="firma" value={p?.company ?? ''} required />
              </div>
              <div>
                <label for="asp">Ansprechpartner</label>
                <input id="asp" name="asp" value={p?.contact ?? ''} />
              </div>
              <div>
                <label for="tel">Telefon</label>
                <input id="tel" name="tel" type="tel" value={p?.phone ?? ''} />
              </div>
              <div>
                <label for="mail">E-Mail</label>
                <input id="mail" name="mail" type="email" value={p?.email ?? ''} />
              </div>
              <div>
                <label for="ort">Ort</label>
                <input id="ort" name="ort" value={p?.city ?? ''} />
              </div>
              <div>
                <label for="quelle">Quelle</label>
                <input
                  id="quelle"
                  name="quelle"
                  value={p?.source ?? ''}
                  placeholder="Kaltakquise, Empfehlung…"
                />
              </div>
              <div>
                <label for="objekt">Objekt</label>
                <input
                  id="objekt"
                  name="objekt"
                  value={p?.object ?? ''}
                  placeholder="Was soll gereinigt werden?"
                />
              </div>
              <div>
                <label for="status">Status</label>
                <select id="status" name="status" data-nosearch>
                  {STATUSES.map((s) => (
                    <option value={s} selected={(p?.status ?? 'erstkontakt') === s}>
                      {PROSPECT_STATUS[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="wv">Wiedervorlage</label>
                <input id="wv" name="wv" type="date" value={p?.followup_on ?? ''} />
              </div>
              <div>
                <label for="grund">Grund für Wiedervorlage</label>
                <input
                  id="grund"
                  name="grund"
                  value={p?.followup_reason ?? ''}
                  placeholder="z.B. Angebot nachfassen"
                />
              </div>
            </div>
            <div class="formfoot">
              <button class="btn">Speichern</button>
              <a class="btn sec" href="/akquise">
                Abbrechen
              </a>
            </div>
          </form>
          <div>
            {p ? (
              <>
                <form method="post" action={`/akquise/${id}/aktivitaet`} class="card">
                  <h3>Aktivität zu {p.company}</h3>
                  <input type="hidden" name="aid" value={randomUUID()} />
                  <label>Typ</label>
                  <div class="seg ak-types">
                    {(Object.keys(ACTIVITY_KIND) as ActivityKind[]).map((k, i) => (
                      <label>
                        <input type="radio" name="typ" value={k} checked={i === 0} />
                        <span>{ACTIVITY_KIND[k]}</span>
                      </label>
                    ))}
                  </div>
                  <div class="grid">
                    <div>
                      <label for="at">Datum / Zeit</label>
                      <input id="at" name="at" type="datetime-local" value={nowLocal()} required />
                    </div>
                    <div>
                      <label for="ns">Neuer Status (optional)</label>
                      <select id="ns" name="neuer_status" data-nosearch>
                        <option value="">— nicht ändern —</option>
                        {STATUSES.map((s) => (
                          <option value={s}>{PROSPECT_STATUS[s].label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <label for="notiz">Notiz (was besprochen, Ergebnis, nächste Schritte)</label>
                  <textarea
                    id="notiz"
                    name="notiz"
                    rows={4}
                    placeholder="z.B. Angebot zugesagt, ruft nächste Woche zurück…"
                  />
                  <label for="wv2">Wiedervorlage aktualisieren (optional)</label>
                  <input id="wv2" name="wv" type="date" />
                  <div class="formfoot">
                    <button class="btn">Speichern</button>
                  </div>
                </form>
                <div class="card">
                  <h3>Aktivitäten ({data!.acts.length})</h3>
                  {data!.acts.length === 0 ? (
                    <p class="small mut">Noch keine Aktivitäten erfasst</p>
                  ) : (
                    <ul class="ak-acts">
                      {data!.acts.map((a) => (
                        <li>
                          <div>
                            <b>{ACTIVITY_KIND[a.kind]}</b> <span class="small mut">{dtDe(a.at)}</span>
                            {a.note && <div class="small">{a.note}</div>}
                          </div>
                          <form
                            method="post"
                            action={`/akquise/${id}/aktivitaet/${a.id}/loeschen`}
                            class="inline-form"
                          >
                            <button
                              class="btn sm danger"
                              data-confirm="Diese Aktivität löschen?"
                              title="löschen"
                            >
                              ✕
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <form method="post" action={`/akquise/${id}/loeschen`} style="margin-top:8px">
                  <button class="btn sm danger" data-confirm="Diesen Akquise-Eintrag wirklich löschen?">
                    Löschen
                  </button>
                </form>
              </>
            ) : (
              <div class="card small mut">Aktivitäten können nach dem Speichern erfasst werden.</div>
            )}
          </div>
        </div>
      </div>,
    );
  });

  app.post(`/akquise/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const existed = !!(await getProspect(sql, id));
    await saveProspect(
      sql,
      id,
      {
        company: str(b, 'firma') ?? '',
        contact: str(b, 'asp'),
        phone: str(b, 'tel'),
        email: str(b, 'mail'),
        city: str(b, 'ort'),
        source: str(b, 'quelle'),
        object: str(b, 'objekt'),
        status: str(b, 'status') ?? 'erstkontakt',
        followupOn: str(b, 'wv'),
        followupReason: str(b, 'grund'),
        expectedVersion: str(b, 'version') ? Number(str(b, 'version')) : null,
      },
      c.get('actor'),
    );
    return back(c, existed ? '/akquise' : `/akquise/${id}`, { ok: existed ? 'Aktualisiert' : 'Gespeichert' });
  });

  app.post(`/akquise/:id{${UUID}}/aktivitaet`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const aid = str(b, 'aid');
    await addActivity(
      sql,
      id,
      {
        id: aid && /^[0-9a-f-]{36}$/.test(aid) ? aid : randomUUID(),
        kind: str(b, 'typ') ?? 'notiz',
        at: str(b, 'at') ?? '',
        note: str(b, 'notiz'),
        newStatus: str(b, 'neuer_status'),
        followupOn: str(b, 'wv'),
      },
      c.get('actor'),
    );
    return back(c, `/akquise/${id}`, { ok: 'Aktivität gespeichert' });
  });

  app.post(`/akquise/:id{${UUID}}/aktivitaet/:aid{${UUID}}/loeschen`, async (c) => {
    await deleteActivity(sql, c.req.param('id'), c.req.param('aid'));
    return back(c, `/akquise/${c.req.param('id')}`, { ok: 'Aktivität gelöscht' });
  });

  app.post(`/akquise/:id{${UUID}}/loeschen`, async (c) => {
    await deleteProspect(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/akquise', { ok: 'Gelöscht' });
  });
}
