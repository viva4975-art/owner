import { randomUUID } from 'node:crypto';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import { listCustomers } from '../services/masterdata.js';
import {
  ACTIVE,
  getTender,
  listTenders,
  offerTarget,
  PLATFORMS,
  PROCEDURES,
  saveTender,
  setTenderStatus,
  TENDER_STATUS,
  type TenderStatus,
  upcomingEvents,
} from '../services/tenders.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { centsToInput, str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';

const STATUS_CLASS: Record<TenderStatus, string> = {
  neu: 'info',
  pruefen: 'warn',
  bearbeitung: 'warn',
  abgegeben: 'info',
  gewonnen: 'ok',
  verloren: 'err',
  verzichtet: '',
  aufgehoben: '',
};
const fmt = (d: Date | null) =>
  d
    ? d.toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }) + ' Uhr'
    : '–';
const local = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .format(d)
        .replace(' ', 'T')
    : '';
const countdown = (days: number | null) =>
  days === null ? '' : days < 0 ? 'vorbei' : days === 0 ? 'heute' : days === 1 ? 'morgen' : `noch ${days} T.`;

export function registerTenderRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  app.get('/ausschreibungen', async (c) => {
    const v = c.req.query('ansicht');
    const view = v === 'abgeschlossen' || v === 'alle' ? v : 'aktiv';
    const q = c.req.query('q') ?? '';
    const [rows, events, counts] = await Promise.all([
      listTenders(sql, { view, q }),
      upcomingEvents(sql, 21),
      sql<{ aktiv: number; zu: number; won: number; lost: number }[]>`
        select count(*) filter (where status = any(${ACTIVE}::text[]))::int as aktiv,
               count(*) filter (where not status = any(${ACTIVE}::text[]))::int as zu,
               count(*) filter (where status = 'gewonnen' and created_at > now() - interval '12 months')::int as won,
               count(*) filter (where status = 'verloren' and created_at > now() - interval '12 months')::int as lost
          from app.tenders`,
    ]);
    const k = counts[0]!;
    return page(
      c,
      'Ausschreibungen',
      'angebote',
      <>
        <PageHead title="Ausschreibungen">
          <a class="btn" href={`/ausschreibungen/${randomUUID()}`} style="margin-left:auto">
            + Ausschreibung erfassen
          </a>
        </PageHead>
        <p class="mut" style="margin-top:-8px;max-width:820px">
          Termine einer Ausschreibung erfassen, bevor es Preise gibt: Abgabefrist, Bieterfragen,
          Ortsbesichtigung, Bindefrist. Das Angebot entsteht später daraus.
        </p>
        {events.length > 0 && (
          <div class="card">
            <h3>Nächste Termine (3 Wochen)</h3>
            <div class="list">
              {events.map((e) => (
                <div class="row">
                  <span class={`dot ${e.days <= 2 ? 'err' : e.days <= 7 ? 'warn' : 'info'}`} />
                  <div class="main">
                    <b>{e.kind}</b>
                    {e.kind === 'Ortsbesichtigung' && e.required && (
                      <span class="small" style="color:var(--err)">
                        {' '}
                        (Pflicht)
                      </span>
                    )}{' '}
                    · <a href={`/ausschreibungen/${e.tender_id}`}>{e.title}</a>
                    <div class="small mut">{e.authority}</div>
                  </div>
                  <div class="side">
                    <span class="when">{fmt(e.at)}</span>
                    <span class={`badge ${e.days <= 2 ? 'err' : e.days <= 7 ? 'warn' : ''}`}>
                      {countdown(e.days)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <form method="get" class="actions">
          <div class="chips" style="margin:0">
            <a href="/ausschreibungen" class={view === 'aktiv' ? 'on' : ''}>
              Laufend<span class="n">{k.aktiv}</span>
            </a>
            <a href="/ausschreibungen?ansicht=abgeschlossen" class={view === 'abgeschlossen' ? 'on' : ''}>
              Abgeschlossen<span class="n">{k.zu}</span>
            </a>
            <a href="/ausschreibungen?ansicht=alle" class={view === 'alle' ? 'on' : ''}>
              Alle
            </a>
          </div>
          {view !== 'aktiv' && <input type="hidden" name="ansicht" value={view} />}
          <input
            name="q"
            value={q}
            placeholder="Titel, Vergabestelle, Vergabenummer"
            style="max-width:300px"
          />
          <button class="btn sec sm">Suchen</button>
          <span class="small mut" style="margin-left:auto">
            12 Monate: {k.won} gewonnen · {k.lost} verloren
            {k.won + k.lost > 0 && ` · Zuschlagsquote ${Math.round((k.won / (k.won + k.lost)) * 100)} %`}
          </span>
        </form>
        <div class="card">
          <div class="list" style="border-top:0;margin-top:-22px;margin-bottom:-22px">
            {rows.map((t) => (
              <div class="row">
                <div style="width:96px;flex:none;text-align:center">
                  {t.deadline_at && ACTIVE.includes(t.status) && t.status !== 'abgegeben' ? (
                    <>
                      <div
                        style={`font-size:20px;font-weight:700;color:${(t.days_left ?? 99) <= 3 ? 'var(--err)' : (t.days_left ?? 99) <= 7 ? 'var(--warn)' : 'var(--ink)'}`}
                      >
                        {t.days_left !== null && t.days_left >= 0 ? t.days_left : '–'}
                      </div>
                      <div class="small faint">
                        {t.days_left !== null && t.days_left >= 0 ? 'Tage' : 'vorbei'}
                      </div>
                    </>
                  ) : (
                    <span class="small faint">–</span>
                  )}
                </div>
                <div class="main">
                  <a href={`/ausschreibungen/${t.id}`}>
                    <b style="color:var(--ink)">{t.title}</b>
                  </a>
                  <div class="small mut">
                    {t.authority}
                    {t.reference_no && ` · ${t.reference_no}`}
                    {t.platform && ` · ${t.platform}`}
                  </div>
                </div>
                <div class="side">
                  <span class="when">Abgabe {t.deadline_at ? fmt(t.deadline_at) : 'offen'}</span>
                  <span class={`badge ${STATUS_CLASS[t.status]}`}>{TENDER_STATUS[t.status]}</span>
                </div>
              </div>
            ))}
            {!rows.length && (
              <div class="row">
                <div class="main mut">Keine Ausschreibungen in dieser Auswahl.</div>
              </div>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.get('/ausschreibungen/neu', (c) => c.redirect(`/ausschreibungen/${randomUUID()}`));

  app.get(`/ausschreibungen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const t = await getTender(sql, id);
    const [customers, files] = await Promise.all([
      listCustomers(sql).then((l) => l.filter((x) => x.active)),
      t ? listFiles(sql, { type: 'tender', id }) : Promise.resolve([]),
    ]);
    const statusButtons: [TenderStatus, string][] = t
      ? (
          [
            ['pruefen', 'Prüfen'],
            ['bearbeitung', 'Wir nehmen teil'],
            ['abgegeben', 'Angebot abgegeben'],
            ['gewonnen', 'Zuschlag erhalten'],
            ['verloren', 'Nicht erhalten'],
            ['verzichtet', 'Nicht teilnehmen'],
            ['aufgehoben', 'Aufgehoben'],
          ] as [TenderStatus, string][]
        ).filter(([s]) => s !== t.status)
      : [];
    return page(
      c,
      t?.title ?? 'Neue Ausschreibung',
      'angebote',
      <>
        <PageHead
          title={t?.title ?? 'Neue Ausschreibung'}
          crumbs={[['Ausschreibungen', '/ausschreibungen']]}
        />
        {t && (
          <div class="card hero">
            <span
              class={`status-xl ${t.status === 'gewonnen' ? 'ok' : t.status === 'verloren' ? 'err' : ACTIVE.includes(t.status) ? 'warn' : 'off'}`}
            >
              {TENDER_STATUS[t.status]}
            </span>
            <div class="facts">
              <span>
                Abgabe <b>{fmt(t.deadline_at)}</b>
                {t.days_left !== null &&
                  ACTIVE.includes(t.status) &&
                  t.status !== 'abgegeben' &&
                  ` (${countdown(t.days_left)})`}
              </span>
              {t.site_visit_at && (
                <span>
                  Besichtigung <b>{fmt(t.site_visit_at)}</b>
                  {t.site_visit_required ? ' – Pflicht' : ''}
                </span>
              )}
              {t.questions_until && (
                <span>
                  Bieterfragen bis <b>{fmt(t.questions_until)}</b>
                </span>
              )}
              {t.binding_until && (
                <span>
                  Bindefrist <b>{dateDe(t.binding_until)}</b>
                </span>
              )}
            </div>
            <div class="acts">
              {t.url && (
                <a class="btn sec sm" href={t.url} target="_blank" rel="noopener noreferrer">
                  Vergabeplattform öffnen
                </a>
              )}
              {t.offer_id && t.offer_number ? (
                <a class="btn sm" href={`/angebote/${t.offer_id}`}>
                  Angebot {t.offer_number}
                </a>
              ) : (
                <form method="post" action={`/ausschreibungen/${id}/angebot`} style="margin:0">
                  <button class="btn sm">Angebot erstellen</button>
                </form>
              )}
            </div>
          </div>
        )}
        <div class="cols">
          <form
            method="post"
            action={`/ausschreibungen/${id}`}
            class="card"
            data-autosave
            data-version={String(t?.version ?? '')}
          >
            <input type="hidden" name="version" value={String(t?.version ?? '')} />
            <div class="group-title">Ausschreibung</div>
            <div class="grid">
              <div style="grid-column:1/-1">
                <label for="title">Titel / Leistung</label>
                <input
                  id="title"
                  name="title"
                  value={t?.title ?? ''}
                  required
                  placeholder="z. B. Unterhaltsreinigung Grundschulen Los 2"
                />
              </div>
              <div>
                <label for="authority">Vergabestelle / Auftraggeber</label>
                <input id="authority" name="authority" value={t?.authority ?? ''} required />
              </div>
              <div>
                <label for="customer">Kunde / Interessent (für das Angebot)</label>
                <select id="customer" name="customer_id">
                  <option value="">– noch keiner –</option>
                  {customers.map((x) => (
                    <option value={x.id} selected={x.id === t?.customer_id}>
                      {x.name} ({x.customer_no}){x.status === 'interessent' ? ' – Interessent' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="reference_no">Vergabenummer</label>
                <input id="reference_no" name="reference_no" value={t?.reference_no ?? ''} />
              </div>
              <div>
                <label for="procedure">Verfahren</label>
                <input id="procedure" name="procedure" list="procedures" value={t?.procedure ?? ''} />
                <datalist id="procedures">
                  {PROCEDURES.map((p) => (
                    <option value={p} />
                  ))}
                </datalist>
              </div>
              <div>
                <label for="platform">Plattform</label>
                <input id="platform" name="platform" list="platforms" value={t?.platform ?? ''} />
                <datalist id="platforms">
                  {PLATFORMS.map((p) => (
                    <option value={p} />
                  ))}
                </datalist>
              </div>
              <div>
                <label for="url">Link zur Ausschreibung</label>
                <input id="url" name="url" type="url" value={t?.url ?? ''} placeholder="https://" />
              </div>
            </div>
            <div class="group-title">Termine</div>
            <div class="grid">
              <div>
                <label for="deadline">Abgabefrist</label>
                <input
                  id="deadline"
                  name="deadline"
                  type="datetime-local"
                  value={local(t?.deadline_at ?? null)}
                />
              </div>
              <div>
                <label for="questions">Bieterfragen bis</label>
                <input
                  id="questions"
                  name="questions_until"
                  type="datetime-local"
                  value={local(t?.questions_until ?? null)}
                />
              </div>
              <div>
                <label for="visit">Ortsbesichtigung</label>
                <input
                  id="visit"
                  name="site_visit"
                  type="datetime-local"
                  value={local(t?.site_visit_at ?? null)}
                />
              </div>
              <div class="chk" style="align-self:end;margin-bottom:10px">
                <input
                  type="checkbox"
                  id="visit_req"
                  name="site_visit_required"
                  checked={t?.site_visit_required ?? false}
                />
                <label for="visit_req">Besichtigung ist Pflicht</label>
              </div>
              <div>
                <label for="binding">Bindefrist</label>
                <input id="binding" name="binding_until" type="date" value={t?.binding_until ?? ''} />
              </div>
              <div>
                <label for="start">Vertragsbeginn</label>
                <input id="start" name="contract_start" type="date" value={t?.contract_start ?? ''} />
              </div>
            </div>
            <div class="group-title">Umfang</div>
            <div class="grid">
              <div>
                <label for="location">Ort / Objekte</label>
                <input id="location" name="location" value={t?.location ?? ''} />
              </div>
              <div>
                <label for="term">Laufzeit</label>
                <input
                  id="term"
                  name="contract_term"
                  value={t?.contract_term ?? ''}
                  placeholder="z. B. 2 Jahre + 2 × 1 Jahr"
                />
              </div>
              <div>
                <label for="est">geschätztes Volumen p. a. (netto €)</label>
                <input
                  id="est"
                  name="estimated"
                  inputmode="decimal"
                  value={t?.estimated_cents != null ? centsToInput(t.estimated_cents) : ''}
                />
              </div>
              <div>
                <label for="resp">zuständig</label>
                <input id="resp" name="responsible" value={t?.responsible ?? c.get('user').name} />
              </div>
            </div>
            <label for="services" style="margin-top:12px">
              Leistungsbeschreibung (kurz)
            </label>
            <textarea id="services" name="services" rows={3}>
              {t?.services ?? ''}
            </textarea>
            <label for="notes">Notizen (Eignungsnachweise, Besonderheiten, Fragen)</label>
            <textarea id="notes" name="notes" rows={3}>
              {t?.notes ?? ''}
            </textarea>
            <div class="formfoot">
              <a class="btn sec" href="/ausschreibungen">
                Zurück
              </a>
              <button class="btn">Speichern</button>
            </div>
          </form>
          <div>
            {t && (
              <div class="card">
                <h3>Status ändern</h3>
                <form method="post" action={`/ausschreibungen/${id}/status`}>
                  <input
                    name="note"
                    placeholder="Notiz / Grund (bei „nicht erhalten“, „nicht teilnehmen“ Pflicht)"
                  />
                  <div class="actions" style="margin-bottom:0">
                    {statusButtons.map(([s, label]) => (
                      <button class="btn sec sm" name="status" value={s}>
                        {label}
                      </button>
                    ))}
                  </div>
                </form>
                {t.decision_note && <p class="small mut">Notiz: {t.decision_note}</p>}
                {t.estimated_cents != null && (
                  <p class="small mut">geschätzt {euro(t.estimated_cents)} p. a.</p>
                )}
              </div>
            )}
            {t && (
              <div class="card">
                <h3>Vergabeunterlagen</h3>
                <FileArea
                  link={{ type: 'tender', id }}
                  files={files}
                  category="Vergabeunterlagen"
                  maxBytes={env.UPLOAD_MAX_BYTES}
                />
              </div>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.post(`/ausschreibungen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const v = str(b, 'version');
    try {
      const est = str(b, 'estimated');
      await saveTender(
        sql,
        id,
        {
          title: str(b, 'title') ?? '',
          authority: str(b, 'authority') ?? '',
          customerId: str(b, 'customer_id'),
          referenceNo: str(b, 'reference_no'),
          platform: str(b, 'platform'),
          url: str(b, 'url'),
          procedure: str(b, 'procedure'),
          location: str(b, 'location'),
          services: str(b, 'services'),
          contractStart: str(b, 'contract_start'),
          contractTerm: str(b, 'contract_term'),
          estimatedCents: est ? parseEuro(est) : null,
          deadline: str(b, 'deadline'),
          questionsUntil: str(b, 'questions_until'),
          siteVisit: str(b, 'site_visit'),
          siteVisitRequired: str(b, 'site_visit_required') === 'on',
          bindingUntil: str(b, 'binding_until'),
          responsible: str(b, 'responsible'),
          notes: str(b, 'notes'),
          version: v ? Number(v) : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/ausschreibungen/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/ausschreibungen/${id}`, { ok: 'Ausschreibung gespeichert.' });
  });

  app.post(`/ausschreibungen/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      await setTenderStatus(
        sql,
        id,
        String(b.status ?? '') as TenderStatus,
        typeof b.note === 'string' ? b.note : null,
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/ausschreibungen/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/ausschreibungen/${id}`, { ok: 'Status geändert.' });
  });

  app.post(`/ausschreibungen/:id{${UUID}}/angebot`, async (c) => {
    const id = c.req.param('id');
    try {
      const t = await offerTarget(sql, id);
      if (t.offerId) return c.redirect(`/angebote/${t.offerId}`, 303);
      return c.redirect(
        `/angebote/${randomUUID()}/bearbeiten?kunde=${t.customerId}&ausschreibung=${id}`,
        303,
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/ausschreibungen/${id}`, { fehler: e.message });
      throw e;
    }
  });
}
