import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { BusinessError } from '../services/errors.js';
import {
  EXCEPTION_LABEL,
  type ExceptionKind,
  deleteException,
  saveException,
  substituteCandidates,
  uncoveredShifts,
} from '../services/planning.js';
import { WEEKDAYS_SHORT, plannedShifts } from '../services/time.js';
import { type Ctx, UUID, assertSite } from './app.js';
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
        service_kind: string;
      }[]
    >`
      select sc.id, sc.number, sp.name as supplier_name, sc.site_id, s.name as site_name, sc.service_kind
        from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id join app.sites s on s.id = sc.site_id
       where sc.status = 'erteilt' and sc.valid_from <= ${to} and (sc.valid_to is null or sc.valid_to >= ${from})
       order by sp.name, sc.number`;
    return page(
      c,
      'Vertretungen',
      'disposition',
      <>
        <PageHead
          title="Einsätze für abwesende Mitarbeiter"
          crumbs={[['Einsatzplanung', '/einsatzplanung']]}
        />
        <form method="get" action="/einsatzplanung/vertretungen" class="actions" style="margin-top:0">
          <input type="date" name="von" value={from} style="max-width:170px" />
          <input type="date" name="bis" value={to} style="max-width:170px" />
          <button class="btn sm sec">Anzeigen</button>
          <span class="small mut">{list.length} offen</span>
        </form>
        {list.length === 0 && (
          <div class="empty">Alles geregelt – keine Einsätze ohne Vertretung im Zeitraum.</div>
        )}
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Objekt</th>
                <th>Zeit</th>
                <th>abwesend</th>
                <th>Vertretung / Ausfall</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, cands }) => (
                <tr>
                  <td>
                    {WEEKDAYS_SHORT[isoWeekday(s.date)]} {dateDe(s.date)}
                  </td>
                  <td>{s.plan.site_name}</td>
                  <td>
                    {s.plan.start_time}–{s.plan.end_time}
                  </td>
                  <td>
                    {s.plan.employee_name}{' '}
                    <span class="badge err">{ABSENCE_LABEL[s.absence as AbsenceKind]}</span>
                  </td>
                  <td>
                    <form
                      method="post"
                      action={`/einsatzplanung/${s.plan.id}/tag/${s.date}`}
                      class="actions"
                      style="margin:0;gap:6px;flex-wrap:nowrap"
                    >
                      <input type="hidden" name="id" value={randomUUID()} />
                      <input
                        type="hidden"
                        name="back"
                        value={`/einsatzplanung/vertretungen?von=${from}&bis=${to}`}
                      />
                      {s.exception && (
                        <input type="hidden" name="version" value={String(s.exception.version)} />
                      )}
                      <select name="sub" aria-label="Vertretung" style="min-width:220px" required>
                        <option value="">– Vertretung wählen –</option>
                        <option value="nicht_notwendig">Nicht notwendig (wird nicht benötigt)</option>
                        <option value="ausfall">Ausfall (findet nicht statt)</option>
                        <optgroup label="Vertretung (Mitarbeiter)">
                          {cands.map((e) => (
                            <option value={e.id} disabled={!!e.busy}>
                              {e.name}
                              {e.on_site ? ' ·Objekt' : ''}
                              {e.busy ? ` – belegt ${e.busy}` : ''}
                            </option>
                          ))}
                        </optgroup>
                        {orders.length > 0 && (
                          <optgroup label="Nachunternehmer-Bestellung">
                            {[...orders]
                              .sort(
                                (a, b) =>
                                  Number(b.site_id === s.plan.site_id) - Number(a.site_id === s.plan.site_id),
                              )
                              .map((o) => (
                                <option value={`nu:${o.id}`}>
                                  {o.number} · {o.supplier_name}
                                  {o.site_id === s.plan.site_id ? ' ·Objekt' : ` (${o.site_name})`}
                                </option>
                              ))}
                          </optgroup>
                        )}
                      </select>
                      <button class="btn sm">Übernehmen</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small mut">
          „·Objekt“ = dem Objekt zugeordnet. Belegte Mitarbeitende (Überschneidung) sind nicht wählbar. „Nicht
          notwendig“ und „Nachunternehmer“ zählen wie ein Ausfall nicht als eigener Einsatz; die Bestellung
          wird am Tag vermerkt (<a href="/bestellungen?art=nu">Bestellungen</a>).
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
    const s = await loadShift(planId, date);
    if (!s) throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
    assertSite(c, s.plan.site_id);
    const b = await c.req.parseBody({ all: true });
    const subRaw = str(b, 'sub');
    const nuId = subRaw?.startsWith('nu:') ? subRaw.slice(3) : null;
    if (nuId && !/^[0-9a-f-]{36}$/.test(nuId)) throw new BusinessError('Bestellung ungültig');
    let note = str(b, 'note');
    if (subRaw === 'nicht_notwendig') note = note ?? 'nicht notwendig';
    if (nuId) {
      const [o] = await sql<{ number: string; name: string }[]>`
        select sc.number, sp.name from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id where sc.id = ${nuId}`;
      note = note ?? (o ? `Nachunternehmer: ${o.name} (${o.number})` : null);
    }
    const sub = subRaw === 'ausfall' || subRaw === 'nicht_notwendig' || nuId ? null : subRaw;
    const kindRaw = str(b, 'kind');
    if (!kindRaw && !subRaw) throw new BusinessError('Bitte Vertretung oder „Ausfall“ wählen');
    const kind: ExceptionKind =
      kindRaw && kindRaw in EXCEPTION_LABEL ? (kindRaw as ExceptionKind) : sub ? 'vertretung' : 'ausfall';
    const id = str(b, 'id') ?? randomUUID();
    await saveException(
      sql,
      /^[0-9a-f-]{36}$/.test(id) ? id : randomUUID(),
      {
        planId,
        date,
        kind,
        substituteId: sub,
        start: str(b, 'start'),
        end: str(b, 'end'),
        note,
        subcontractId: nuId,
        expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
      },
      c.get('actor'),
    );
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
