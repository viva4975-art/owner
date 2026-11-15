import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { BusinessError } from '../services/errors.js';
import { FREQUENCY } from '../services/subcontractors.js';
import {
  EXCEPTION_LABEL,
  type ExceptionKind,
  deleteException,
  saveException,
  substituteCandidates,
  uncoveredShifts,
} from '../services/planning.js';
import { WEEKDAYS_SHORT, plannedShifts } from '../services/time.js';
import type { Context } from 'hono';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import { str } from './forms.js';
import { PageHead, dateDe } from './layout.js';

/** Planung wie Fortytools: Monatstafel je Mitarbeiter, offene Vertretungen, Umplanen je Tag. */
export function registerPlanningMonthRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  // ------------------------------------------------------------ Monatstafel
  // Monatstafel: jetzt Ansicht „Monat“ der Planungstafel (routes-planning-board.tsx)

  app.get('/einsatzplanung/vertretungen', async (c) => {
    const today = todayBerlin();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('von') ?? '') ? c.req.query('von')! : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('bis') ?? '')
      ? c.req.query('bis')!
      : addDays(today, 27);
    const list = await uncoveredShifts(sql, from, to, c.get('sites'));
    const rows = await Promise.all(list.map(async (s) => ({ s, cands: await substituteCandidates(sql, s) })));
    const orders = await sql<
      {
        id: string;
        number: string;
        supplier_name: string;
        site_id: string;
        site_name: string;
        site_no: string | null;
        service_kind: string;
        frequency: string;
        site_ids: string[];
      }[]
    >`
      select sc.id, sc.number, sp.name as supplier_name, sc.site_id, s.name as site_name, s.site_no,
             sc.service_kind, sc.frequency,
             array(select ss.site_id::text from app.subcontract_sites ss where ss.subcontract_id = sc.id) as site_ids
        from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id join app.sites s on s.id = sc.site_id
       where sc.status = 'erteilt' and sc.valid_from <= ${to} and (sc.valid_to is null or sc.valid_to >= ${from})
       order by sp.name, sc.number`;
    // Mehrere Tage auf einmal (Ahmed 15.11.: „fehlt eine Woche – nur einmal die Vertretung wählen“): je abwesender
    // Person gruppiert, Tage ankreuzen, unten einmal Vertretung/Nachunternehmer wählen und „Markierte planen“.
    const here = (o: (typeof orders)[number], siteId: string) =>
      o.site_id === siteId || o.site_ids.includes(siteId);
    const orderLabel = (o: (typeof orders)[number]) =>
      `${o.number} · ${o.supplier_name} · ${o.service_kind || 'Leistung'} (${FREQUENCY[o.frequency] ?? o.frequency}) · ` +
      (o.site_ids.length > 1
        ? `Sammelbestellung ${o.site_ids.length} Objekte (u. a. ${o.site_no ? `${o.site_no} ` : ''}${o.site_name})`
        : `Objekt ${o.site_no ? `${o.site_no} ` : ''}${o.site_name}`);
    const selSites = new Set(list.map((x) => x.plan.site_id));
    const sugOrders = orders.filter((o) => [...selSites].some((sid) => here(o, sid)));
    const restOrders = orders.filter((o) => !sugOrders.includes(o));
    // Mitarbeiter-Auswahl: alle Kandidaten der angezeigten Tage; „frei an n von m Tagen“
    const emp = new Map<string, { name: string; free: number; onSite: boolean }>();
    for (const { cands } of rows)
      for (const e of cands) {
        const x = emp.get(e.id) ?? { name: e.name, free: 0, onSite: false };
        if (!e.busy) x.free += 1;
        x.onSite ||= e.on_site;
        emp.set(e.id, x);
      }
    const emps = [...emp.entries()].sort(
      (a, b) => Number(b[1].onSite) - Number(a[1].onSite) || a[1].name.localeCompare(b[1].name, 'de'),
    );
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.s.plan.employee_name}|${r.s.absence}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const self = `/einsatzplanung/vertretungen?von=${from}&bis=${to}`;
    return page(
      c,
      'Vertretungen',
      'disposition',
      <>
        <PageHead
          title="Einsätze für abwesende Mitarbeiter"
          crumbs={[['Einsatzplanung', '/einsatzplanung']]}
        />
        <form method="get" action="/einsatzplanung/vertretungen" class="ls-bar" style="margin-top:0">
          <input type="date" name="von" value={from} style="max-width:170px" aria-label="von" />
          <input type="date" name="bis" value={to} style="max-width:170px" aria-label="bis" />
          <button class="btn sm sec">Anzeigen</button>
          <span class="small mut">{list.length} offen</span>
        </form>
        {list.length === 0 && (
          <div class="empty">Alles geregelt – keine Einsätze ohne Vertretung im Zeitraum.</div>
        )}
        {list.length > 0 && (
          <form method="post" action="/einsatzplanung/vertretungen/planen" id="vt">
            <input type="hidden" name="back" value={self} />
            {[...groups.entries()].map(([k, g]) => (
              <section class="card" style="padding:0;margin-bottom:12px">
                <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)">
                  <label style="margin:0;display:flex;gap:8px;align-items:center;font-weight:600">
                    <input
                      type="checkbox"
                      data-vt-all={k}
                      aria-label={`alle Tage von ${g[0]!.s.plan.employee_name}`}
                    />
                    {g[0]!.s.plan.employee_name}
                  </label>
                  <span class="badge err">{ABSENCE_LABEL[g[0]!.s.absence as AbsenceKind]}</span>
                  <span class="small mut">{g.length === 1 ? '1 Einsatz' : `${g.length} Einsätze`}</span>
                </div>
                <div class="tbl">
                  <table class="keep" data-nostick>
                    <tbody>
                      {g.map(({ s, cands }) => {
                        const free = cands.filter((e) => e.on_site && !e.busy).slice(0, 3);
                        const nu = orders.filter((o) => here(o, s.plan.site_id));
                        return (
                          <tr>
                            <td style="width:30px">
                              <input
                                type="checkbox"
                                name="sel"
                                value={`${s.plan.id}|${s.date}`}
                                data-vt={k}
                                aria-label={`${dateDe(s.date)} ${s.plan.site_name}`}
                              />
                            </td>
                            <td style="white-space:nowrap">
                              {WEEKDAYS_SHORT[isoWeekday(s.date)]} {dateDe(s.date)}
                            </td>
                            <td>
                              <b>{s.plan.site_name}</b>
                              <div class="small mut">
                                {s.plan.start_time}–{s.plan.end_time}
                              </div>
                            </td>
                            <td class="small">
                              {free.length > 0 && (
                                <div>frei am Objekt: {free.map((e) => e.name).join(', ')}</div>
                              )}
                              {nu.length > 0 && (
                                <div>
                                  NU an diesem Objekt:{' '}
                                  {nu.map((o) => `${o.supplier_name} (${o.number})`).join(', ')}
                                </div>
                              )}
                              {!free.length && !nu.length && <span class="mut">kein Vorschlag</span>}
                              {s.exception && (
                                <div class="mut">bisher: {EXCEPTION_LABEL[s.exception.kind]}</div>
                              )}
                            </td>
                            <td class="r">
                              <a
                                class="small"
                                href={`/einsatzplanung/${s.plan.id}/tag/${s.date}?zurueck=${encodeURIComponent(self)}`}
                              >
                                einzeln …
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            <div
              class="card"
              style="position:sticky;bottom:8px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;box-shadow:var(--sh-float,0 6px 24px rgba(0,0,0,.12))"
            >
              <label style="margin:0;flex:1 1 360px">
                Vertretung für die markierten Tage
                <select name="sub" required>
                  <option value="">– wählen –</option>
                  <option value="nicht_notwendig">Nicht notwendig (wird nicht benötigt)</option>
                  <option value="ausfall">Ausfall (findet nicht statt)</option>
                  {sugOrders.length > 0 && (
                    <optgroup label="Nachunternehmer an diesen Objekten">
                      {sugOrders.map((o) => (
                        <option value={`nu:${o.id}`}>{orderLabel(o)}</option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Mitarbeiter (frei an … der angezeigten Tage)">
                    {emps.map(([id, e]) => (
                      <option value={id}>
                        {e.name}
                        {e.onSite ? ' · am Objekt' : ''} – frei an {e.free} von {rows.length}
                      </option>
                    ))}
                  </optgroup>
                  {restOrders.length > 0 && (
                    <optgroup label="Andere Nachunternehmer-Bestellungen">
                      {restOrders.map((o) => (
                        <option value={`nu:${o.id}`}>{orderLabel(o)}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <button class="btn">
                Markierte planen (<span data-vt-n>0</span>)
              </button>
            </div>
            <script
              dangerouslySetInnerHTML={{
                __html: `(function(){var f=document.getElementById('vt');function n(){f.querySelector('[data-vt-n]').textContent=f.querySelectorAll('input[name=sel]:checked').length}f.addEventListener('change',function(e){var k=e.target.getAttribute('data-vt-all');if(k!==null)f.querySelectorAll('input[name=sel]').forEach(function(b){if(b.getAttribute('data-vt')===k)b.checked=e.target.checked});n()});n()})();`,
              }}
            />
          </form>
        )}
        <p class="small mut">
          Tage ankreuzen (Häkchen am Namen = alle Tage dieser Person) und unten einmal wählen. Belegte Tage
          einer Vertretung werden übersprungen und gemeldet. „Nicht notwendig“ und „Nachunternehmer“ zählen
          wie ein Ausfall nicht als eigener Einsatz; die Bestellung wird am Tag vermerkt.
        </p>
      </>,
    );
  });

  // ------------------------------------------------------------ Umplanen je Tag
  const loadShift = async (planId: string, date: string) => {
    const day = await plannedShifts(sql, { from: date, to: date, includeCancelled: true });
    return day.find((s) => s.plan.id === planId);
  };

  /** Rücksprung nur auf eigene Seiten (Planung, Mitarbeiter-/Objekt-Kalender …). */
  const okBack = (x: string | null | undefined) => !!x && /^\/(?!\/)[\w/?=&.%-]*$/.test(x);

  /** Vertretung/Ausfall/Nachunternehmer für einen geplanten Tag eintragen (einzeln und für mehrere Tage). */
  const applySub = async (
    c: Context<AppEnv>,
    planId: string,
    date: string,
    subRaw: string | null,
    o: {
      note?: string | null;
      kind?: string | null;
      start?: string | null;
      end?: string | null;
      id?: string | null;
      version?: number | null;
    },
  ) => {
    const s = await loadShift(planId, date);
    if (!s) throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
    assertSite(c, s.plan.site_id);
    const nuId = subRaw?.startsWith('nu:') ? subRaw.slice(3) : null;
    if (nuId && !/^[0-9a-f-]{36}$/.test(nuId)) throw new BusinessError('Bestellung ungültig');
    let note = o.note ?? null;
    if (subRaw === 'nicht_notwendig') note = note ?? 'nicht notwendig';
    if (nuId) {
      const [x] = await sql<{ number: string; name: string }[]>`
        select sc.number, sp.name from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id where sc.id = ${nuId}`;
      note = note ?? (x ? `Nachunternehmer: ${x.name} (${x.number})` : null);
    }
    const sub = subRaw === 'ausfall' || subRaw === 'nicht_notwendig' || nuId ? null : subRaw;
    if (!o.kind && !subRaw) throw new BusinessError('Bitte Vertretung oder „Ausfall“ wählen');
    const kind: ExceptionKind =
      o.kind && o.kind in EXCEPTION_LABEL ? (o.kind as ExceptionKind) : sub ? 'vertretung' : 'ausfall';
    const id = o.id && /^[0-9a-f-]{36}$/.test(o.id) ? o.id : randomUUID();
    await saveException(
      sql,
      id,
      {
        planId,
        date,
        kind,
        substituteId: sub,
        start: o.start ?? null,
        end: o.end ?? null,
        note,
        subcontractId: nuId,
        expectedVersion: o.version === undefined ? (s.exception?.version ?? null) : o.version,
      },
      c.get('actor'),
    );
    return { kind, nuId };
  };

  app.post('/einsatzplanung/vertretungen/planen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const sel = ([] as unknown[]).concat(b.sel ?? []).map(String);
    const subRaw = str(b, 'sub');
    const to = str(b, 'back');
    const ret = okBack(to) ? to! : '/einsatzplanung/vertretungen';
    if (!sel.length) return back(c, ret, { fehler: 'Bitte mindestens einen Tag ankreuzen' });
    if (!subRaw) return back(c, ret, { fehler: 'Bitte Vertretung oder „Ausfall“ wählen' });
    let ok = 0;
    const errs: string[] = [];
    for (const v of sel) {
      const [planId, date] = v.split('|');
      if (!planId || !/^[0-9a-f-]{36}$/.test(planId) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      try {
        await applySub(c, planId, date, subRaw, {});
        ok += 1;
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        errs.push(`${dateDe(date)}: ${e.message}`);
      }
    }
    return back(c, ret, {
      ...(ok ? { ok: `${ok === 1 ? '1 Tag' : `${ok} Tage`} geplant.` } : {}),
      ...(errs.length
        ? { fehler: `Nicht geplant – ${errs.slice(0, 6).join(' · ')}${errs.length > 6 ? ' …' : ''}` }
        : {}),
    });
  });

  app.get(`/einsatzplanung/:id{${UUID}}/tag/:date{\\d{4}-\\d{2}-\\d{2}}`, async (c) => {
    const s = await loadShift(c.req.param('id'), c.req.param('date'));
    if (!s) throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
    assertSite(c, s.plan.site_id);
    const cands = await substituteCandidates(sql, s);
    const ex = s.exception;
    const zurueck = c.req.query('zurueck');
    const backTo = okBack(zurueck) ? zurueck! : null;
    return page(
      c,
      'Umplanen',
      'disposition',
      <>
        <PageHead
          title="Einsatz umplanen"
          no={`${WEEKDAYS_SHORT[isoWeekday(s.date)]} ${dateDe(s.date)}`}
          crumbs={[['Planung', `/einsatzplanung?datum=${s.date}`]]}
        />
        <div class="cols">
          <form method="post" action={`/einsatzplanung/${s.plan.id}/tag/${s.date}`} class="card">
            <input type="hidden" name="id" value={ex?.id ?? randomUUID()} />
            <input type="hidden" name="version" value={String(ex?.version ?? '')} />
            {backTo && <input type="hidden" name="back" value={backTo} />}
            <p style="margin-top:0">
              <b>{s.plan.site_name}</b> · geplant: {ex ? ex.original : s.plan.employee_name}
              {s.absence && <span class="badge err"> {ABSENCE_LABEL[s.absence as AbsenceKind]}</span>}
            </p>
            <label for="kind">Was passiert an diesem Tag?</label>
            <select id="kind" name="kind" required>
              <option value="">– bitte wählen –</option>
              {(Object.keys(EXCEPTION_LABEL) as ExceptionKind[]).map((k) => (
                <option
                  value={k}
                  selected={
                    k === (ex?.kind ?? (s.absence || c.req.query('art') === 'vertretung' ? 'vertretung' : ''))
                  }
                >
                  {EXCEPTION_LABEL[k]}
                </option>
              ))}
            </select>
            <label for="sub">Mitarbeiter (Vertretung / umgeplant auf)</label>
            <select id="sub" name="sub">
              <option value="">– wie geplant –</option>
              {cands.map((e) => (
                <option
                  value={e.id}
                  disabled={!!e.busy}
                  selected={ex?.kind !== 'ausfall' && ex !== undefined && s.plan.employee_id === e.id}
                >
                  {e.name}
                  {e.on_site ? ' ·Objekt' : ''}
                  {e.busy ? ` – belegt ${e.busy}` : ''}
                </option>
              ))}
            </select>
            <div class="grid">
              <div>
                <label for="start">
                  Beginn (geplant {s.plan.start_time.slice(0, 5)}, leer = wie geplant)
                </label>
                <input
                  id="start"
                  type="time"
                  name="start"
                  value={ex && ex.kind !== 'ausfall' ? s.plan.start_time : ''}
                />
              </div>
              <div>
                <label for="end">Ende (geplant {s.plan.end_time.slice(0, 5)})</label>
                <input
                  id="end"
                  type="time"
                  name="end"
                  value={ex && ex.kind !== 'ausfall' ? s.plan.end_time : ''}
                />
              </div>
            </div>
            <label for="note">Notiz</label>
            <input
              id="note"
              name="note"
              value={ex?.note ?? ''}
              placeholder="z. B. Objekt wegen Ferien geschlossen"
            />
            <div class="formfoot">
              <a class="btn sec" href={backTo ?? `/einsatzplanung?datum=${s.date}`}>
                Abbrechen
              </a>
              <button class="btn">Speichern</button>
            </div>
          </form>
          <div class="card">
            <h3>Hinweise</h3>
            <p class="small">
              Die Änderung gilt nur für diesen Tag; die wiederkehrende Planung bleibt. Die Vertretung sieht
              den Einsatz in ihrer Handy-App und kann ihn bestätigen bzw. stempeln.
            </p>
            <p class="small">
              <a href={`/einsatzplanung/${s.plan.id}`}>Wiederkehrenden Einsatz bearbeiten oder beenden</a>
            </p>
            {ex && (
              <form method="post" action={`/einsatzplanung/${s.plan.id}/tag/${s.date}/zuruecksetzen`}>
                <input type="hidden" name="back" value={backTo ?? ''} />
                <button class="btn sec sm">Wie geplant (Umplanung entfernen)</button>
              </form>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.post(`/einsatzplanung/:id{${UUID}}/tag/:date{\\d{4}-\\d{2}-\\d{2}}`, async (c) => {
    const planId = c.req.param('id');
    const date = c.req.param('date');
    const b = await c.req.parseBody({ all: true });
    const subRaw = str(b, 'sub');
    const { kind, nuId } = await applySub(c, planId, date, subRaw, {
      note: str(b, 'note'),
      kind: str(b, 'kind'),
      start: str(b, 'start'),
      end: str(b, 'end'),
      id: str(b, 'id'),
      version: typeof b.version === 'string' && b.version ? Number(b.version) : null,
    });
    const to = str(b, 'back');
    return back(c, okBack(to) ? to! : `/einsatzplanung?datum=${date}`, {
      ok:
        subRaw === 'nicht_notwendig'
          ? 'Als „nicht notwendig“ vermerkt.'
          : nuId
            ? 'Nachunternehmer eingetragen.'
            : `${EXCEPTION_LABEL[kind]} gespeichert.`,
    });
  });

  app.post(`/einsatzplanung/:id{${UUID}}/tag/:date{\\d{4}-\\d{2}-\\d{2}}/zuruecksetzen`, async (c) => {
    const planId = c.req.param('id');
    const date = c.req.param('date');
    const s = await loadShift(planId, date);
    if (!s) throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
    assertSite(c, s.plan.site_id);
    await deleteException(sql, planId, date, c.get('actor'));
    const to = str(await c.req.parseBody(), 'back');
    return back(c, okBack(to) ? to! : `/einsatzplanung?datum=${date}`, {
      ok: 'Wieder wie geplant.',
    });
  });
}
