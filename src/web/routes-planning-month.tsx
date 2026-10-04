import { randomUUID } from 'node:crypto';
import { monthBounds, monthLabelDe, todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { planningGroups } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import {
  EXCEPTION_LABEL,
  type ExceptionKind,
  deleteException,
  saveException,
  substituteCandidates,
  uncoveredShifts,
} from '../services/planning.js';
import { WEEKDAYS_SHORT, hm, plannedShifts } from '../services/time.js';
import { type Ctx, UUID, assertSite } from './app.js';
import { str } from './forms.js';
import { PageHead, dateDe } from './layout.js';

const shiftMonth = (m: string, n: number) => {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

/** Planung wie Fortytools: Monatstafel je Mitarbeiter, offene Vertretungen, Umplanen je Tag. */
export function registerPlanningMonthRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  // ------------------------------------------------------------ Monatstafel
  app.get('/einsatzplanung/monat', async (c) => {
    const qm = c.req.query('monat');
    const month = qm && /^\d{4}-\d{2}$/.test(qm) ? qm : todayBerlin().slice(0, 7);
    const group = c.req.query('gruppe') || null;
    const { start, end } = monthBounds(month);
    const scope = c.get('sites');
    const [all, groups, members] = await Promise.all([
      plannedShifts(sql, { from: start, to: end, includeCancelled: true }),
      planningGroups(sql),
      sql<{ id: string; planning_group: string | null; planning_notes: string | null }[]>`
        select id, planning_group, planning_notes from app.employees where status = 'aktiv'`,
    ]);
    const info = new Map(members.map((m) => [m.id, m]));
    const shifts = all.filter(
      (s) =>
        (!scope || scope.includes(s.plan.site_id)) &&
        (!group || info.get(s.plan.employee_id)?.planning_group === group),
    );
    const days: string[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    const people = [...new Map(shifts.map((s) => [s.plan.employee_id, s.plan.employee_name])).entries()].sort(
      (a, b) => a[1].localeCompare(b[1]),
    );
    const open = shifts.filter((s) => s.absence && s.exception?.kind !== 'ausfall' && !s.holiday).length;
    return page(
      c,
      `Planung ${monthLabelDe(month)}`,
      'disposition',
      <>
        <style
          dangerouslySetInnerHTML={{
            __html: `.tafel{border-collapse:separate;border-spacing:0;font-size:11px}
.tafel th,.tafel td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:2px;vertical-align:top}
.tafel th{position:sticky;top:0;background:#fff;font-weight:600;min-width:52px}
.tafel td.name{position:sticky;left:0;background:#fff;min-width:150px;font-size:12px;z-index:1}
.tafel .we{background:#f4f5f7}.tafel .hol{background:#fff4c2}
.tafel a.e{display:block;background:var(--brand);color:#fff;border-radius:3px;padding:1px 3px;margin:1px 0;text-decoration:none;white-space:nowrap;overflow:hidden;max-width:70px;text-overflow:ellipsis}
.tafel a.e.ok{background:#3b6b4d}.tafel a.e.abs{background:#b42318}.tafel a.e.ex{background:#5b6270}.tafel a.e.x{background:#d0d4db;color:#555;text-decoration:line-through}`,
          }}
        />
        <PageHead title={`Planung (${monthLabelDe(month)})`}>
          <a class="btn sec" href="/einsatzplanung" style="margin-left:auto">
            Wochenplan
          </a>
          <a class="btn" href={`/einsatzplanung/${randomUUID()}`}>
            Einsatz planen
          </a>
        </PageHead>
        <form method="get" action="/einsatzplanung/monat" class="actions" style="margin-top:0">
          <a
            class="btn sm sec"
            href={`/einsatzplanung/monat?monat=${shiftMonth(month, -1)}${group ? `&gruppe=${encodeURIComponent(group)}` : ''}`}
          >
            ←
          </a>
          <input
            type="month"
            name="monat"
            value={month}
            onchange="this.form.submit()"
            style="max-width:180px"
          />
          <a
            class="btn sm sec"
            href={`/einsatzplanung/monat?monat=${shiftMonth(month, 1)}${group ? `&gruppe=${encodeURIComponent(group)}` : ''}`}
          >
            →
          </a>
          <select name="gruppe" onchange="this.form.submit()" style="max-width:220px">
            <option value="">Alle Einsatzgruppen</option>
            {groups.map((g) => (
              <option value={g} selected={g === group}>
                {g}
              </option>
            ))}
          </select>
          {open > 0 && (
            <a class="badge err" href={`/einsatzplanung/vertretungen?von=${start}&bis=${end}`}>
              {open} Einsätze für abwesende Mitarbeiter – anzeigen
            </a>
          )}
        </form>
        <div class="tbl" style="max-height:75vh;overflow:auto">
          <table class="tafel">
            <thead>
              <tr>
                <th style="left:0;z-index:2">Mitarbeiter</th>
                {days.map((d) => (
                  <th
                    class={holidayName(d) ? 'hol' : isoWeekday(d) >= 6 ? 'we' : ''}
                    title={holidayName(d) ?? ''}
                  >
                    {WEEKDAYS_SHORT[isoWeekday(d)]} {d.slice(8)}.
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.length === 0 && (
                <tr>
                  <td colspan={days.length + 1} class="mut">
                    In diesem Monat ist nichts geplant.
                  </td>
                </tr>
              )}
              {people.map(([id, name]) => {
                const mine = shifts.filter((s) => s.plan.employee_id === id);
                const total = mine
                  .filter((s) => !s.absence && s.exception?.kind !== 'ausfall' && !s.holiday)
                  .reduce((a, s) => a + s.minutes, 0);
                return (
                  <tr>
                    <td class="name">
                      <a href={`/personal/${id}/kalender?monat=${month}`}>{name}</a>
                      <div class="small mut">
                        {hm(total)} Std.
                        {info.get(id)?.planning_group ? ` · ${info.get(id)!.planning_group}` : ''}
                      </div>
                      {info.get(id)?.planning_notes && (
                        <div class="small" style="color:var(--warn)" title={info.get(id)!.planning_notes!}>
                          ⚑ {info.get(id)!.planning_notes!.slice(0, 40)}
                        </div>
                      )}
                    </td>
                    {days.map((d) => (
                      <td class={holidayName(d) ? 'hol' : isoWeekday(d) >= 6 ? 'we' : ''}>
                        {mine
                          .filter((s) => s.date === d)
                          .map((s) => (
                            <a
                              class={`e ${s.exception?.kind === 'ausfall' ? 'x' : s.absence ? 'abs' : s.exception ? 'ex' : s.entry ? 'ok' : ''}`}
                              href={`/einsatzplanung/${s.plan.id}/tag/${d}`}
                              title={`${s.plan.site_name} ${s.plan.start_time}–${s.plan.end_time}${s.absence ? ` · ${ABSENCE_LABEL[s.absence as AbsenceKind]}` : ''}${s.exception ? ` · ${EXCEPTION_LABEL[s.exception.kind]}${s.exception.kind === 'vertretung' ? ` für ${s.exception.original}` : ''}` : ''}`}
                            >
                              {s.plan.start_time} {s.plan.site_name}
                            </a>
                          ))}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p class="small mut">
          Bordeaux = geplant, grün = Zeit erfasst, rot = Mitarbeiter abwesend (Vertretung nötig), grau =
          Vertretung/umgeplant, durchgestrichen = Ausfall. Klick auf einen Einsatz: für diesen Tag umplanen.
        </p>
      </>,
    );
  });

  // ------------------------------------------------------------ Offene Vertretungen
  app.get('/einsatzplanung/vertretungen', async (c) => {
    const today = todayBerlin();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('von') ?? '') ? c.req.query('von')! : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('bis') ?? '')
      ? c.req.query('bis')!
      : addDays(today, 27);
    const list = await uncoveredShifts(sql, from, to, c.get('sites'));
    const rows = await Promise.all(list.map(async (s) => ({ s, cands: await substituteCandidates(sql, s) })));
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
                        <option value="ausfall">Ausfall (findet nicht statt)</option>
                        {cands.map((e) => (
                          <option value={e.id} disabled={!!e.busy}>
                            {e.name}
                            {e.on_site ? ' ★' : ''}
                            {e.busy ? ` – belegt ${e.busy}` : ''}
                          </option>
                        ))}
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
          ★ = dem Objekt zugeordnet. Belegte Mitarbeitende (Überschneidung) sind nicht wählbar.
        </p>
      </>,
    );
  });

  // ------------------------------------------------------------ Umplanen je Tag
  const loadShift = async (planId: string, date: string) => {
    const day = await plannedShifts(sql, { from: date, to: date, includeCancelled: true });
    return day.find((s) => s.plan.id === planId);
  };

  app.get(`/einsatzplanung/:id{${UUID}}/tag/:date{\\d{4}-\\d{2}-\\d{2}}`, async (c) => {
    const s = await loadShift(c.req.param('id'), c.req.param('date'));
    if (!s) throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
    assertSite(c, s.plan.site_id);
    const cands = await substituteCandidates(sql, s);
    const ex = s.exception;
    const zurueck = c.req.query('zurueck');
    const backTo = zurueck && /^\/einsatzplanung[\w/?=&.-]*$/.test(zurueck) ? zurueck : null;
    return page(
      c,
      'Umplanen',
      'disposition',
      <>
        <PageHead
          title="Einsatz umplanen"
          no={`${WEEKDAYS_SHORT[isoWeekday(s.date)]} ${dateDe(s.date)}`}
          crumbs={[['Monatstafel', `/einsatzplanung/monat?monat=${s.date.slice(0, 7)}`]]}
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
            <select id="kind" name="kind">
              {(Object.keys(EXCEPTION_LABEL) as ExceptionKind[]).map((k) => (
                <option value={k} selected={k === (ex?.kind ?? (s.absence ? 'vertretung' : 'umgeplant'))}>
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
                  {e.on_site ? ' ★' : ''}
                  {e.busy ? ` – belegt ${e.busy}` : ''}
                </option>
              ))}
            </select>
            <div class="grid">
              <div>
                <label for="start">Beginn (abweichend)</label>
                <input
                  id="start"
                  type="time"
                  name="start"
                  value={ex && ex.kind !== 'ausfall' ? s.plan.start_time : ''}
                />
              </div>
              <div>
                <label for="end">Ende (abweichend)</label>
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
    const sub = subRaw === 'ausfall' ? null : subRaw;
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
        note: str(b, 'note'),
        expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
      },
      c.get('actor'),
    );
    const to = str(b, 'back');
    return back(
      c,
      to && /^\/einsatzplanung[\w/?=&.-]*$/.test(to) ? to : `/einsatzplanung/monat?monat=${date.slice(0, 7)}`,
      {
        ok: `${EXCEPTION_LABEL[kind]} gespeichert.`,
      },
    );
  });

  app.post(`/einsatzplanung/:id{${UUID}}/tag/:date{\\d{4}-\\d{2}-\\d{2}}/zuruecksetzen`, async (c) => {
    const planId = c.req.param('id');
    const date = c.req.param('date');
    const s = await loadShift(planId, date);
    if (!s) throw new BusinessError('An diesem Tag ist dieser Einsatz nicht geplant');
    assertSite(c, s.plan.site_id);
    await deleteException(sql, planId, date, c.get('actor'));
    return back(c, `/einsatzplanung/monat?monat=${date.slice(0, 7)}`, { ok: 'Wieder wie geplant.' });
  });
}
