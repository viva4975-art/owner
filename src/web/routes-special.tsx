import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import {
  announceRun,
  cancelRun,
  completeRun,
  getRun,
  getSpecialService,
  listSpecialServices,
  noticePdf,
  planRun,
  RUN_STATUS,
  runToInvoice,
  saveSpecialService,
  SPECIAL_DEFAULTS,
  SPECIAL_KIND,
  type SpecialKind,
  type SpecialService,
} from '../services/special-services.js';
import { type AppEnv, assertSite, type Ctx, UUID } from './app.js';
import { arr, centsToInput, str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';

export function registerSpecialRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const office = (role: string) => role === 'admin' || role === 'buchhaltung';

  // ------------------------------------------------------------------ Übersicht
  app.get('/sonderdienste', async (c) => {
    const kindQ = c.req.query('art');
    const kind = kindQ && kindQ in SPECIAL_KIND ? (kindQ as SpecialKind) : null;
    const view = c.req.query('ansicht') === 'alle' ? 'alle' : 'faellig';
    const all = await listSpecialServices(sql, { scope: c.get('sites'), kind, activeOnly: view !== 'alle' });
    const rows = view === 'alle' ? all : all.filter((r) => r.days_left <= 60 || r.open_run);
    const showPrice = office(c.get('user').role);
    return page(
      c,
      'Sonderdienste',
      'disposition',
      <>
        <PageHead title="Sonderdienste (Glasreinigung, Tiefgarage …)">
          <a class="btn" href={`/sonderdienste/${randomUUID()}`} style="margin-left:auto">
            Sonderdienst anlegen
          </a>
        </PageHead>
        <form method="get" class="actions" style="margin-top:0">
          <select name="art" onchange="this.form.submit()" style="max-width:240px" aria-label="Art">
            <option value="">Alle Arten</option>
            {(Object.keys(SPECIAL_KIND) as SpecialKind[]).map((k) => (
              <option value={k} selected={k === kind}>
                {SPECIAL_KIND[k]}
              </option>
            ))}
          </select>
          <select name="ansicht" onchange="this.form.submit()" style="max-width:260px" aria-label="Ansicht">
            <option value="faellig" selected={view === 'faellig'}>
              Fällig in 60 Tagen / geplant
            </option>
            <option value="alle" selected={view === 'alle'}>
              Alle (auch inaktive)
            </option>
          </select>
          <span class="small mut">{rows.length} Einträge</span>
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Fällig</th>
                  <th>Art</th>
                  <th>Objekt</th>
                  <th>Leistung</th>
                  <th>Intervall</th>
                  <th>zuletzt</th>
                  {showPrice && <th class="r">Preis</th>}
                  <th>Termin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr style={r.active ? '' : 'opacity:.55'}>
                    <td
                      style={
                        r.days_left < 0
                          ? 'color:var(--err);font-weight:700'
                          : r.days_left <= 14
                            ? 'color:var(--warn);font-weight:600'
                            : ''
                      }
                    >
                      {dateDe(r.next_due)}
                      <div class="small">
                        {r.days_left < 0 ? `${-r.days_left} Tage überfällig` : `in ${r.days_left} Tagen`}
                      </div>
                    </td>
                    <td>{SPECIAL_KIND[r.kind]}</td>
                    <td>
                      <a href={`/objekte/${r.site_id}`}>{r.site_name}</a>
                      <div class="small mut">
                        {r.site_no}
                        {showPrice ? ` · ${r.customer_name}` : ''}
                      </div>
                    </td>
                    <td>
                      <a href={`/sonderdienste/${r.id}`}>{r.title}</a>
                    </td>
                    <td>alle {r.interval_months} Monate</td>
                    <td>{dateDe(r.last_done)}</td>
                    {showPrice && <td class="r">{r.price_cents == null ? '–' : euro(r.price_cents)}</td>}
                    <td>
                      {r.open_run ? (
                        <a href={`/sonderdienste/termin/${r.open_run.id}`}>
                          {dateDe(r.open_run.planned_date)} · {RUN_STATUS[r.open_run.status]}
                        </a>
                      ) : r.active ? (
                        <a class="btn sm sec" href={`/sonderdienste/${r.id}/termin`}>
                          Termin planen
                        </a>
                      ) : (
                        '–'
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={8} class="mut">
                      Nichts fällig.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Anlegen / Bearbeiten
  app.get(`/sonderdienste/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getSpecialService(sql, id);
    if (data) assertSite(c, data.service.site_id);
    const scope = c.get('sites');
    const sites = (
      await sql<
        { id: string; site_no: string; name: string }[]
      >`select id, site_no, name from app.sites where active order by name`
    ).filter((s) => !scope || scope.includes(s.id));
    const kindQ = c.req.query('art');
    const kind: SpecialKind =
      data?.service.kind ?? (kindQ && kindQ in SPECIAL_KIND ? (kindQ as SpecialKind) : 'glas');
    const s: Partial<SpecialService> = data?.service ?? {
      kind,
      site_id: c.req.query('objekt') ?? '',
      interval_months: SPECIAL_DEFAULTS[kind].interval,
      notice_days: SPECIAL_DEFAULTS[kind].notice,
      next_due: todayBerlin(),
      vat_rate_bp: 1900,
      active: true,
    };
    const showPrice = office(c.get('user').role);
    return page(
      c,
      data ? s.title! : 'Neuer Sonderdienst',
      'disposition',
      <>
        <PageHead
          title={data ? s.title! : 'Neuer Sonderdienst'}
          no={data ? `${data.service.site_name} (${data.service.site_no})` : null}
          crumbs={[['Sonderdienste', '/sonderdienste']]}
        />
        <div class="cols">
          <form
            method="post"
            action={`/sonderdienste/${id}`}
            class="card"
            data-autosave
            data-version={String(s.version ?? '')}
          >
            <input type="hidden" name="version" value={String(s.version ?? '')} />
            <div class="grid">
              <div>
                <label for="site">Objekt</label>
                <select id="site" name="site_id" required>
                  <option value="">– bitte wählen –</option>
                  {sites.map((x) => (
                    <option value={x.id} selected={x.id === s.site_id}>
                      {x.site_no} · {x.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="kind">Art</label>
                <select id="kind" name="kind">
                  {(Object.keys(SPECIAL_KIND) as SpecialKind[]).map((k) => (
                    <option value={k} selected={k === s.kind}>
                      {SPECIAL_KIND[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="title">Bezeichnung (Rechnungstext)</label>
                <input
                  id="title"
                  name="title"
                  value={s.title ?? ''}
                  placeholder="z. B. Glasreinigung innen und außen"
                  required
                />
              </div>
              <div>
                <label for="interval">Intervall (Monate)</label>
                <input
                  id="interval"
                  type="number"
                  min={1}
                  max={60}
                  name="interval_months"
                  value={String(s.interval_months ?? 6)}
                  required
                />
              </div>
              <div>
                <label for="due">Nächste Fälligkeit</label>
                <input id="due" type="date" name="next_due" value={s.next_due ?? ''} required />
              </div>
              <div>
                <label for="notice">Aushang Tage vorher</label>
                <input
                  id="notice"
                  type="number"
                  min={0}
                  max={60}
                  name="notice_days"
                  value={String(s.notice_days ?? 0)}
                />
              </div>
              {showPrice && (
                <>
                  <div class="chk">
                    <input
                      type="checkbox"
                      id="has-price"
                      data-reveal="#price-box"
                      checked={s.price_cents != null}
                    />
                    <label for="has-price">Festpreis je Durchführung</label>
                  </div>
                  <div id="price-box" hidden={s.price_cents == null}>
                    <label for="price">Festpreis je Durchführung (netto)</label>
                    <input
                      id="price"
                      name="price"
                      inputmode="decimal"
                      value={s.price_cents != null ? centsToInput(s.price_cents) : ''}
                    />
                  </div>
                  <div>
                    <label for="vat">USt</label>
                    <select id="vat" name="vat_rate_bp">
                      <option value="1900" selected={s.vat_rate_bp !== 700}>
                        19 %
                      </option>
                      <option value="700" selected={s.vat_rate_bp === 700}>
                        7 %
                      </option>
                    </select>
                  </div>
                </>
              )}
            </div>
            <label for="scope">Umfang / Ausführungshinweise</label>
            <textarea
              id="scope"
              name="scope"
              rows={3}
              placeholder="z. B. 420 m² Glasfläche, Rahmen und Falze, Hubsteiger nötig"
            >
              {s.scope ?? ''}
            </textarea>
            <label for="note">Interne Notiz</label>
            <input id="note" name="note" value={s.note ?? ''} />
            <label>
              <input type="checkbox" name="active" checked={s.active !== false} /> aktiv
            </label>
            <div class="formfoot">
              <button class="btn">Speichern</button>
            </div>
          </form>
          {data && (
            <div class="card">
              <h3>Termine</h3>
              {!data.runs.some((r) => ['geplant', 'angekuendigt'].includes(r.status)) &&
                data.service.active && (
                  <a class="btn sm" href={`/sonderdienste/${id}/termin`}>
                    Termin planen
                  </a>
                )}
              <div class="tbl" style="margin-top:8px">
                <table>
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr>
                        <td>
                          <a href={`/sonderdienste/termin/${r.id}`}>{dateDe(r.planned_date)}</a>
                        </td>
                        <td>{RUN_STATUS[r.status]}</td>
                        <td class="small">
                          {r.work_report_id && (
                            <a href={`/arbeitsscheine/${r.work_report_id}`}>Arbeitsschein</a>
                          )}{' '}
                          {showPrice && r.invoice_id && <a href={`/rechnungen/${r.invoice_id}`}>Rechnung</a>}
                        </td>
                      </tr>
                    ))}
                    {data.runs.length === 0 && (
                      <tr>
                        <td colspan={3} class="mut">
                          Noch keine Termine.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </>,
    );
  });

  app.post(`/sonderdienste/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const existing = await getSpecialService(sql, id);
    const siteId = str(b, 'site_id') ?? '';
    assertSite(c, siteId);
    if (existing) assertSite(c, existing.service.site_id);
    const showPrice = office(c.get('user').role);
    const priceRaw = str(b, 'price');
    let price: bigint | null = existing?.service.price_cents ?? null;
    if (showPrice) {
      try {
        price = priceRaw ? parseEuro(priceRaw) : null;
      } catch {
        throw new BusinessError('Preis nicht lesbar');
      }
    }
    const v = str(b, 'version');
    await saveSpecialService(
      sql,
      id,
      {
        siteId,
        kind: (str(b, 'kind') ?? 'sonstiges') as SpecialKind,
        title: str(b, 'title') ?? '',
        scope: str(b, 'scope'),
        intervalMonths: Number(str(b, 'interval_months')),
        nextDue: str(b, 'next_due') ?? '',
        priceCents: price,
        vatRateBp: showPrice
          ? Number(str(b, 'vat_rate_bp') ?? 1900)
          : (existing?.service.vat_rate_bp ?? 1900),
        noticeDays: Number(str(b, 'notice_days') ?? 0),
        active: b.active === 'on',
        note: str(b, 'note'),
        expectedVersion: v ? Number(v) : null,
      },
      c.get('actor'),
    );
    return back(c, `/sonderdienste/${id}`, { ok: 'Sonderdienst gespeichert.' });
  });

  // ------------------------------------------------------------------ Termin planen
  const runForm = async (c: Context<AppEnv>, serviceId: string, runId: string) => {
    const data = await getSpecialService(sql, serviceId);
    if (!data) throw new BusinessError('Sonderdienst nicht gefunden');
    assertSite(c, data.service.site_id);
    const run = data.runs.find((r) => r.id === runId);
    const emps = await sql<{ id: string; name: string; on_site: boolean }[]>`
      select e.id, e.last_name || ', ' || e.first_name as name,
             exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = ${data.service.site_id}) as on_site
        from app.employees e where e.status = 'aktiv' order by on_site desc, e.last_name`;
    const s = data.service;
    return page(
      c,
      'Termin',
      'disposition',
      <>
        <PageHead
          title={run ? `Termin ${dateDe(run.planned_date)}` : 'Termin planen'}
          no={`${s.title} · ${s.site_name}`}
          crumbs={[
            ['Sonderdienste', '/sonderdienste'],
            [s.title, `/sonderdienste/${s.id}`],
          ]}
        />
        <div class="cols">
          <form method="post" action={`/sonderdienste/${s.id}/termin`} class="card">
            <input type="hidden" name="run_id" value={runId} />
            <input type="hidden" name="version" value={String(run?.version ?? '')} />
            <div class="grid">
              <div>
                <label for="date">Datum</label>
                <input
                  id="date"
                  type="date"
                  name="date"
                  value={run?.planned_date ?? (s.next_due < todayBerlin() ? todayBerlin() : s.next_due)}
                  required
                />
              </div>
              <div>
                <label for="start">Beginn</label>
                <input id="start" type="time" name="start" value={run?.start_time ?? ''} />
              </div>
              <div>
                <label for="end">Ende</label>
                <input id="end" type="time" name="end" value={run?.end_time ?? ''} />
              </div>
            </div>
            <label>Team</label>
            <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px">
              {emps.map((e) => (
                <label class="small" style="font-weight:400">
                  <input
                    type="checkbox"
                    name="emp"
                    value={e.id}
                    checked={run?.employee_ids.includes(e.id) ?? false}
                  />{' '}
                  {e.name}
                  {e.on_site ? ' ★' : ''}
                </label>
              ))}
            </div>
            <label for="note">Notiz</label>
            <input
              id="note"
              name="note"
              value={run?.note ?? ''}
              placeholder="z. B. Hubsteiger bestellt, Schlüssel beim Hausmeister"
            />
            <div class="formfoot">
              <button class="btn">{run ? 'Termin ändern' : 'Termin planen'}</button>
            </div>
          </form>
          <div class="card small">
            <h3>Hinweise</h3>
            <p>{s.scope ?? 'Kein Umfang hinterlegt.'}</p>
            {s.notice_days > 0 && (
              <p>
                Aushang spätestens {s.notice_days} Tage vorher (Tiefgarage: Fahrzeuge entfernen). Den Aushang
                gibt es nach dem Speichern als PDF.
              </p>
            )}
            <p class="mut">★ = dem Objekt zugeordnet</p>
          </div>
        </div>
      </>,
    );
  };

  app.get(`/sonderdienste/:id{${UUID}}/termin`, async (c) => {
    const data = await getSpecialService(sql, c.req.param('id'));
    const open = data?.runs.find((r) => ['geplant', 'angekuendigt'].includes(r.status));
    if (open) return c.redirect(`/sonderdienste/termin/${open.id}/bearbeiten`);
    return runForm(c, c.req.param('id'), randomUUID());
  });

  app.get(`/sonderdienste/termin/:rid{${UUID}}/bearbeiten`, async (c) => {
    const run = await getRun(sql, c.req.param('rid'));
    if (!run) throw new BusinessError('Termin nicht gefunden');
    return runForm(c, run.special_service_id, run.id);
  });

  app.post(`/sonderdienste/:id{${UUID}}/termin`, async (c) => {
    const id = c.req.param('id');
    const data = await getSpecialService(sql, id);
    if (!data) throw new BusinessError('Sonderdienst nicht gefunden');
    assertSite(c, data.service.site_id);
    const b = await c.req.parseBody({ all: true });
    const runId = str(b, 'run_id');
    const rid = runId && /^[0-9a-f-]{36}$/.test(runId) ? runId : randomUUID();
    const v = str(b, 'version');
    await planRun(
      sql,
      rid,
      id,
      {
        date: str(b, 'date') ?? '',
        start: str(b, 'start'),
        end: str(b, 'end'),
        employeeIds: arr(b, 'emp').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
        note: str(b, 'note'),
        expectedVersion: v ? Number(v) : null,
      },
      c.get('actor'),
    );
    return back(c, `/sonderdienste/termin/${rid}`, { ok: 'Termin gespeichert.' });
  });

  // ------------------------------------------------------------------ Termin: Ansicht + Aktionen
  const loadRun = async (c: Context<AppEnv>) => {
    const run = await getRun(sql, c.req.param('rid')!);
    if (!run) throw new BusinessError('Termin nicht gefunden');
    const data = (await getSpecialService(sql, run.special_service_id))!;
    assertSite(c, data.service.site_id);
    return { run, s: data.service };
  };

  app.get(`/sonderdienste/termin/:rid{${UUID}}`, async (c) => {
    const { run, s } = await loadRun(c);
    const names = run.employee_ids.length
      ? await sql<
          { name: string }[]
        >`select first_name || ' ' || last_name as name from app.employees where id in ${sql(run.employee_ids)}`
      : [];
    const open = ['geplant', 'angekuendigt'].includes(run.status);
    const showPrice = office(c.get('user').role);
    const today = todayBerlin();
    const post = (action: string, label: string, cls = 'sec', confirm?: string) => (
      <form
        method="post"
        action={`/sonderdienste/termin/${run.id}/${action}`}
        onsubmit={confirm ? `return confirm(${JSON.stringify(confirm)})` : undefined}
      >
        <button class={`btn ${cls}`}>{label}</button>
      </form>
    );
    return page(
      c,
      'Termin',
      'disposition',
      <>
        <PageHead
          title={`${SPECIAL_KIND[s.kind]} am ${dateDe(run.planned_date)}`}
          no={`${s.site_name} (${s.site_no})`}
          crumbs={[
            ['Sonderdienste', '/sonderdienste'],
            [s.title, `/sonderdienste/${s.id}`],
          ]}
        />
        <div class="cols">
          <div class="card">
            <dl class="kv">
              <dt>Leistung</dt>
              <dd>{s.title}</dd>
              <dt>Umfang</dt>
              <dd>{s.scope ?? '–'}</dd>
              <dt>Zeit</dt>
              <dd>{run.start_time ? `${run.start_time}–${run.end_time ?? ''} Uhr` : '–'}</dd>
              <dt>Team</dt>
              <dd>{names.map((n) => n.name).join(', ') || '–'}</dd>
              <dt>Status</dt>
              <dd>
                <span
                  class={`badge ${run.status === 'erledigt' ? 'ok' : run.status === 'abgesagt' ? '' : 'info'}`}
                >
                  {RUN_STATUS[run.status]}
                </span>
                {run.announced_at && (
                  <span class="small mut">
                    {' '}
                    · Aushang {run.announced_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
                  </span>
                )}
              </dd>
              {run.note && (
                <>
                  <dt>Notiz</dt>
                  <dd>{run.note}</dd>
                </>
              )}
            </dl>
          </div>
          <div class="card actlist" style="display:flex;flex-direction:column;gap:8px">
            {open && (
              <a class="btn sec" href={`/sonderdienste/termin/${run.id}/bearbeiten`}>
                Termin ändern / Team
              </a>
            )}
            {open && (
              <a class="btn sec" href={`/sonderdienste/termin/${run.id}/aushang.pdf`} target="_blank">
                Aushang (PDF)
              </a>
            )}
            {run.status === 'geplant' && post('angekuendigt', 'Aushang ist aufgehängt')}
            {open && run.planned_date <= today && post('erledigt', 'Erledigt → Arbeitsschein', '')}
            {open && run.planned_date > today && (
              <span class="small mut">„Erledigt“ ist ab dem Termin möglich.</span>
            )}
            {run.work_report_id && (
              <a class="btn sec" href={`/arbeitsscheine/${run.work_report_id}`}>
                Arbeitsschein öffnen (unterschreiben lassen)
              </a>
            )}
            {showPrice &&
              run.status === 'erledigt' &&
              !run.invoice_id &&
              s.price_cents != null &&
              post('rechnung', `Rechnungsentwurf (${euro(s.price_cents)} netto)`)}
            {showPrice && run.invoice_id && (
              <a class="btn sec" href={`/rechnungen/${run.invoice_id}`}>
                Rechnung öffnen
              </a>
            )}
            {open && (
              <form
                method="post"
                action={`/sonderdienste/termin/${run.id}/absagen`}
                class="actions"
                style="margin:0"
              >
                <input name="reason" placeholder="Grund der Absage" required style="max-width:240px" />
                <button class="btn ghost">Absagen</button>
              </form>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.get(`/sonderdienste/termin/:rid{${UUID}}/aushang.pdf`, async (c) => {
    const { run } = await loadRun(c);
    return new Response(await noticePdf(sql, run.id), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Aushang_${run.planned_date}.pdf"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.post(`/sonderdienste/termin/:rid{${UUID}}/angekuendigt`, async (c) => {
    const { run } = await loadRun(c);
    await announceRun(sql, run.id, c.get('actor'));
    return back(c, `/sonderdienste/termin/${run.id}`, { ok: 'Als angekündigt vermerkt.' });
  });

  app.post(`/sonderdienste/termin/:rid{${UUID}}/erledigt`, async (c) => {
    const { run } = await loadRun(c);
    const wr = await completeRun(sql, run.id, c.get('actor'));
    return back(c, `/arbeitsscheine/${wr}`, {
      ok: 'Erledigt. Arbeitsschein angelegt – jetzt prüfen und vom Kunden unterschreiben lassen. Nächste Fälligkeit ist gesetzt.',
    });
  });

  app.post(`/sonderdienste/termin/:rid{${UUID}}/absagen`, async (c) => {
    const { run } = await loadRun(c);
    await cancelRun(sql, run.id, str(await c.req.parseBody({ all: true }), 'reason'), c.get('actor'));
    return back(c, `/sonderdienste/${run.special_service_id}`, { ok: 'Termin abgesagt.' });
  });

  app.post(`/sonderdienste/termin/:rid{${UUID}}/rechnung`, async (c) => {
    if (!office(c.get('user').role)) throw new BusinessError('Nur Büro/Buchhaltung');
    const { run } = await loadRun(c);
    const id = await runToInvoice(deps, run.id, c.get('actor'));
    return back(c, `/rechnungen/${id}`, { ok: 'Rechnungsentwurf erstellt.' });
  });
}
