import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday, mondayOf } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { listEmployees } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import {
  getShiftSeries,
  hm,
  MONTHS_SHORT,
  type PlannedShift,
  plannedShifts,
  RECURRENCE,
  type Recurrence,
  saveShiftSeries,
  WEEKDAYS_SHORT,
} from '../services/time.js';
import { type Ctx, UUID, assertSite } from './app.js';
import { arr } from './forms.js';
import { calRange, type CalView } from './pages-site-calendar.js';
import { dateDe } from './layout.js';

/*
 * Planung wie Fortytools (Ahmed 06.10., Screenshots „Planung (KW 41)“ und „Termin oder Terminserie planen“):
 * Tafel mit „Zu planende Einsätze“ (ohne Mitarbeiter) und „Geplante Einsätze“ je Mitarbeiter, gruppiert nach
 * Einsatzgruppe; Ansichten Tag / 5 Tage / Woche / Monat; Mitarbeiterfilter; Hinweis auf Einsätze abwesender
 * Mitarbeiter. Ein Klick auf einen Termin öffnet die Serie (offen) bzw. den Tag (umplanen, Vertretung, Ausfall).
 */

const VIEWS: [Exclude<CalView, 'liste'>, string][] = [
  ['tag', 'Tag'],
  ['5tage', '5 Tage'],
  ['woche', 'Woche'],
  ['monat', 'Monat'],
];

const kwOf = (d: string) => {
  const thu = new Date(`${addDays(mondayOf(d), 3)}T00:00:00Z`);
  const start = Date.UTC(thu.getUTCFullYear(), 0, 1);
  return Math.ceil(((thu.getTime() - start) / 86400000 + 1) / 7);
};

const Block: FC<{ s: PlannedShift; city: string | null; compact: boolean; back: string }> = ({
  s,
  city,
  compact,
  back,
}) => {
  const open = !s.plan.employee_id;
  const cls = open ? 'open' : s.absence ? 'absent' : s.entry ? 'done' : s.exception ? 'changed' : 'planned';
  const href = open
    ? `/einsatzplanung/${s.plan.id}`
    : `/einsatzplanung/${s.plan.id}/tag/${s.date}?zurueck=${encodeURIComponent(back)}`;
  const title = [
    `${s.plan.site_name} (${s.plan.site_no})`,
    `${s.plan.start_time}–${s.plan.end_time}`,
    s.plan.note,
    s.absence ? `${ABSENCE_LABEL[s.absence as AbsenceKind]} – Vertretung nötig` : '',
    s.exception
      ? s.exception.kind === 'vertretung'
        ? `Vertretung für ${s.exception.original}`
        : 'umgeplant'
      : '',
    s.entry ? 'Zeit erfasst' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <a class={`pb-ev ${cls}`} href={href} title={title}>
      <span class="t">{compact ? s.plan.site_name.slice(0, 14) : s.plan.site_name}</span>
      <span class="m">
        {compact ? s.plan.start_time : `${s.plan.start_time}–${s.plan.end_time} · ${hm(s.minutes)}h`}
        {!compact && city && <> · {city}</>}
      </span>
    </a>
  );
};

export function registerPlanningBoardRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/einsatzplanung/monat', (c) => {
    const m = c.req.query('monat');
    return c.redirect(`/einsatzplanung?ansicht=monat${m ? `&datum=${m}-01` : ''}`);
  });

  // ------------------------------------------------------------------ Tafel
  app.get('/einsatzplanung', async (c) => {
    const q = c.req.query();
    const view = (VIEWS.find(([k]) => k === q.ansicht)?.[0] ?? 'woche') as Exclude<CalView, 'liste'>;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.datum ?? '') ? q.datum! : todayBerlin();
    const r = calRange(view, date);
    const today = todayBerlin();
    const group = q.gruppe ?? '';
    const selected = new Set(arr(c.req.queries() as Record<string, string[]>, 'ma'));
    const scope = c.get('sites');
    const [allShifts, emps, sites, absences] = await Promise.all([
      plannedShifts(sql, { from: r.from, to: r.to, includeOpen: true }),
      listEmployees(sql, { status: 'aktiv' }),
      sql<{ id: string; city: string | null }[]>`select id, city from app.sites`,
      sql<{ employee_id: string; kind: AbsenceKind; start_date: string; end_date: string }[]>`
        select employee_id, kind, start_date, end_date from app.absences
         where status = 'genehmigt' and start_date <= ${r.to} and end_date >= ${r.from}`,
    ]);
    const shifts = scope ? allShifts.filter((s) => scope.includes(s.plan.site_id)) : allShifts;
    const cityOf = new Map(sites.map((s) => [s.id, s.city]));
    const days: string[] = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);
    const open = shifts.filter((s) => !s.plan.employee_id);
    const absentShifts = shifts.filter(
      (s) => s.plan.employee_id && s.absence && !s.holiday && s.date >= today,
    );
    const groups = [...new Set(emps.map((e) => e.planning_group ?? ''))].sort((a, b) =>
      !a ? 1 : !b ? -1 : a.localeCompare(b, 'de'),
    );
    // Zeilen: Mitarbeitende mit Einsätzen/Abwesenheit im Zeitraum (oder ausdrücklich gewählt)
    const busy = new Set([
      ...shifts.map((s) => s.plan.employee_id).filter(Boolean),
      ...absences.map((a) => a.employee_id),
    ]);
    const visible = emps.filter(
      (e) =>
        (!group || (e.planning_group ?? '') === (group === '-' ? '' : group)) &&
        (selected.size ? selected.has(e.id) : busy.has(e.id) || q.alle === '1'),
    );
    const compact = view === 'monat';
    const self = (over: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const cur: Record<string, string | null> = {
        ansicht: view === 'woche' ? null : view,
        datum: date === today ? null : date,
        gruppe: group || null,
        alle: q.alle === '1' ? '1' : null,
        ...over,
      };
      for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
      for (const m of selected) p.append('ma', m);
      const s = p.toString();
      return `/einsatzplanung${s ? `?${s}` : ''}`;
    };
    const backUrl = self({});
    const title =
      view === 'monat'
        ? `Planung (${MONTHS_SHORT[Number(date.slice(5, 7))]} ${date.slice(0, 4)})`
        : view === 'tag'
          ? `Planung (${WEEKDAYS_SHORT[isoWeekday(date)]} ${dateDe(date)})`
          : `Planung (KW ${kwOf(date)})`;
    const DayHead: FC<{ d: string }> = ({ d }) => (
      <div
        class={`pb-dh${d === today ? ' today' : ''}${holidayName(d) ? ' hol' : ''}${isoWeekday(d) >= 6 ? ' we' : ''}`}
      >
        <b>{WEEKDAYS_SHORT[isoWeekday(d)]}</b> {compact ? dateDe(d).slice(0, 5) : dateDe(d)}
        {holidayName(d) && <span class="hn">{holidayName(d)}</span>}
      </div>
    );
    const cols = `grid-template-columns:${compact ? '150px' : '190px'} repeat(${days.length},minmax(${compact ? 38 : 120}px,1fr))`;
    return page(
      c,
      'Planung',
      'disposition',
      <div class="portal pb">
        <div class="page-head">
          <div>
            <div class="eyebrow">Disposition</div>
            <h1>{title}</h1>
          </div>
          <div class="acts">
            <a class="btn sec" href={`/einsatzplanung/vertretungen?von=${r.from}&bis=${r.to}`}>
              Umplanen
            </a>
            <a class="btn" href={`/einsatzplanung/${randomUUID()}?datum=${date >= today ? date : today}`}>
              Einsatz planen
            </a>
          </div>
        </div>
        <form class="toolbar" method="get" action="/einsatzplanung">
          <a class="btn sec sm" href={self({ datum: null })}>
            {view === 'monat' ? 'Dieser Monat' : view === 'tag' ? 'Heute' : 'Diese Woche'}
          </a>
          <span class="seg">
            <a href={self({ datum: r.prev })} aria-label="zurück">
              ←
            </a>
            <a href={self({ datum: r.next })} aria-label="vor">
              →
            </a>
          </span>
          <input type="hidden" name="ansicht" value={view} />
          <input
            type="date"
            name="datum"
            value={date}
            onchange="this.form.submit()"
            style="width:auto"
            aria-label="Datum"
          />
          <span class="seg">
            {VIEWS.map(([k, l]) => (
              <a class={view === k ? 'on' : ''} href={self({ ansicht: k === 'woche' ? null : k })}>
                {l}
              </a>
            ))}
          </span>
          <select name="gruppe" onchange="this.form.submit()" style="width:auto" data-nosearch>
            <option value="">Alle Einsatzgruppen</option>
            {groups.map((g) => (
              <option value={g || '-'} selected={(g || '-') === group}>
                {g || 'Keine Einsatzgruppe'}
              </option>
            ))}
          </select>
          <details class="ma-filter">
            <summary>{selected.size ? `${selected.size} Mitarbeiter gewählt` : 'Mitarbeiterfilter'}</summary>
            <div class="pop">
              <input type="search" placeholder="Mitarbeiterfilter" data-filter-list=".ma-filter label" />
              <div class="list">
                {emps.map((e) => (
                  <label>
                    <input type="checkbox" name="ma" value={e.id} checked={selected.has(e.id)} />{' '}
                    {e.last_name}, {e.first_name} ({e.personnel_no})
                  </label>
                ))}
              </div>
              <div class="foot">
                <a href={self({}).replace(/([?&])ma=[^&]*/g, '$1')}>Alle Mitarbeiter</a>
                <button class="btn sm">Anwenden</button>
              </div>
            </div>
          </details>
          <a class="toggle" href={self({ alle: q.alle === '1' ? null : '1' })}>
            <span class={`sw${q.alle === '1' ? ' on' : ''}`} /> auch ohne Einsatz
          </a>
        </form>
        {absentShifts.length > 0 && (
          <a class="due-banner warn" href={`/einsatzplanung/vertretungen?von=${r.from}&bis=${r.to}`}>
            <span class="ico">!</span>
            <span>
              <b>{absentShifts.length} Einsätze für abwesende Mitarbeiter</b>{' '}
              <span class="small">Anzeigen und Vertretung planen →</span>
            </span>
          </a>
        )}
        <section class="pb-sec">
          <div class="pb-bar">
            <b>Zu planende Einsätze</b>
            <span>{open.length ? `${open.length} offen` : 'alle Termine sind besetzt'}</span>
          </div>
          <div class="pb-grid" style={cols}>
            <div class="pb-rh">Nicht zugeordnet</div>
            {days.map((d) => (
              <DayHead d={d} />
            ))}
            <div class="pb-rn" />
            {days.map((d) => (
              <div class={`pb-c${holidayName(d) ? ' hol' : ''}${d === today ? ' today' : ''}`}>
                {open
                  .filter((s) => s.date === d)
                  .map((s) => (
                    <Block s={s} city={cityOf.get(s.plan.site_id) ?? null} compact={compact} back={backUrl} />
                  ))}
              </div>
            ))}
          </div>
        </section>
        <section class="pb-sec">
          <div class="pb-bar light">
            <b>Geplante Einsätze</b>
            <span>
              {hm(shifts.filter((s) => s.plan.employee_id && !s.absence).reduce((a, s) => a + s.minutes, 0))}{' '}
              Std. geplant
            </span>
          </div>
          {groups
            .filter((g) => visible.some((e) => (e.planning_group ?? '') === g))
            .map((g) => {
              const people = visible.filter((e) => (e.planning_group ?? '') === g);
              return (
                <div class="pb-grid" style={cols}>
                  <div class="pb-rh">{g || 'Keine Einsatzgruppe'}</div>
                  {days.map((d) => (
                    <DayHead d={d} />
                  ))}
                  {people.map((e) => {
                    const mine = shifts.filter((s) => s.plan.employee_id === e.id);
                    const total = mine.filter((s) => !s.absence).reduce((a, s) => a + s.minutes, 0);
                    return (
                      <>
                        <div class="pb-rn">
                          <a href={`/personal/${e.id}/einsatzkalender`}>
                            {e.last_name}, {e.first_name}
                          </a>
                          <span class="small mut">{total ? `${hm(total)} Std.` : e.personnel_no}</span>
                        </div>
                        {days.map((d) => {
                          const abs = absences.find(
                            (a) => a.employee_id === e.id && a.start_date <= d && a.end_date >= d,
                          );
                          return (
                            <div
                              class={`pb-c${holidayName(d) ? ' hol' : ''}${d === today ? ' today' : ''}${abs ? ' abs' : ''}`}
                            >
                              {abs && !compact && <span class="pb-abs">{ABSENCE_LABEL[abs.kind]}</span>}
                              {mine
                                .filter((s) => s.date === d)
                                .map((s) => (
                                  <Block
                                    s={s}
                                    city={cityOf.get(s.plan.site_id) ?? null}
                                    compact={compact}
                                    back={backUrl}
                                  />
                                ))}
                            </div>
                          );
                        })}
                      </>
                    );
                  })}
                </div>
              );
            })}
          {!visible.length && (
            <div class="lc empty">
              Keine Einsätze in diesem Zeitraum. <a href={self({ alle: '1' })}>Alle Mitarbeiter anzeigen</a>
            </div>
          )}
        </section>
        <p class="small mut">
          Grau = noch niemand eingeplant · Blau = geplant · Grün = Zeit erfasst · Lila = Vertretung/umgeplant
          · Rot = Mitarbeiter abwesend. Feiertage (Bayern) farbig. Klick auf einen Termin: umplanen,
          Vertretung oder Ausfall für diesen Tag; offene Termine öffnen die Serie zum Besetzen.
        </p>
        <script dangerouslySetInnerHTML={{ __html: FILTER_JS }} />
      </div>,
    );
  });

  // ------------------------------------------------------------------ Termin oder Terminserie planen
  app.get(`/einsatzplanung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const series = await getShiftSeries(sql, id);
    if (series) assertSite(c, series.siteId);
    const scope = c.get('sites');
    const [sites, emps, groupRows] = await Promise.all([
      sql<
        {
          id: string;
          site_no: string;
          name: string;
          customer_id: string;
          customer_no: string;
          customer_name: string;
        }[]
      >`
        select s.id, s.site_no, s.name, c.id as customer_id, c.customer_no, c.name as customer_name
          from app.sites s join app.customers c on c.id = s.customer_id
         where s.active or s.id = ${series?.siteId ?? null}
         order by c.name, s.site_no`,
      listEmployees(sql, { status: 'aktiv' }),
      sql<{ g: string }[]>`
        select distinct g from (select planning_group as g from app.employees union select planning_group from app.shift_plans) x
         where g is not null order by 1`,
    ]);
    const mySites = scope ? sites.filter((s) => scope.includes(s.id)) : sites;
    const q = c.req.query();
    const v = series ?? {
      seriesId: id,
      siteId: q.objekt ?? '',
      employeeIds: q.mitarbeiter ? [q.mitarbeiter] : [null],
      recurrence: 'woechentlich' as Recurrence,
      every: 1,
      weekdays: [isoWeekday(/^\d{4}-\d{2}-\d{2}$/.test(q.datum ?? '') ? q.datum! : todayBerlin())],
      months: null,
      startTime: '08:00',
      endTime: '10:00',
      breakMinutes: 0,
      validFrom: /^\d{4}-\d{2}-\d{2}$/.test(q.datum ?? '') ? q.datum! : todayBerlin(),
      validUntil: null,
      note: null,
      planningGroup: null,
    };
    const customers = [...new Map(mySites.map((s) => [s.customer_id, s])).values()];
    const empSelect = (sel: string | null) => (
      <select name="employee_id">
        <option value="">offen</option>
        {emps.map((e) => (
          <option value={e.id} selected={e.id === sel}>
            {e.last_name}, {e.first_name} ({e.personnel_no})
          </option>
        ))}
      </select>
    );
    const hours = (Number(v.breakMinutes) / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 });
    return page(
      c,
      series ? 'Terminserie ändern' : 'Termin oder Terminserie planen',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/einsatzplanung">Planung</a>
            </div>
            <h1>
              <a href="/einsatzplanung" class="x" aria-label="schließen">
                ✕
              </a>{' '}
              {series ? 'Terminserie ändern' : 'Termin oder Terminserie planen'}
            </h1>
          </div>
        </div>
        <form method="post" action={`/einsatzplanung/${id}`} class="tp" data-autosave>
          <div class="tp-row">
            <span class="tp-ic" title="Einsatzort">
              ⌖
            </span>
            <div class="tp-main">
              <select name="site_id" required aria-label="Einsatzort">
                <option value="">– Einsatzort wählen –</option>
                {customers.map((cu) => (
                  <optgroup label={`${cu.customer_name} (${cu.customer_no})`}>
                    {mySites
                      .filter((s) => s.customer_id === cu.customer_id)
                      .map((s) => (
                        <option value={s.id} selected={s.id === v.siteId}>
                          ↳ {s.name} ({s.site_no})
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <div class="tp-row">
            <span class="tp-ic" title="Termin">
              ▦
            </span>
            <div class="tp-main">
              <div class="tp-line">
                <span class="seg big">
                  {(Object.keys(RECURRENCE) as Recurrence[]).map((k) => (
                    <label>
                      <input type="radio" name="recurrence" value={k} checked={v.recurrence === k} />
                      <span>{RECURRENCE[k]}</span>
                    </label>
                  ))}
                </span>
                <span class="tp-time">
                  <span class="mut">ab</span>
                  <input type="date" name="valid_from" value={v.validFrom} required />
                  <input type="time" name="start" value={v.startTime} required />
                  <span>–</span>
                  <input type="time" name="end" value={v.endTime} required />
                  <span class="tp-dur" id="tp-dur">
                    –
                  </span>
                </span>
              </div>
              <div class="tp-line">
                <span class="chk">
                  <input
                    type="checkbox"
                    id="has-end"
                    data-reveal="#end-box"
                    checked={!!v.validUntil && v.recurrence !== 'einmalig'}
                  />
                  <label for="has-end">Enddatum festlegen</label>
                </span>
                <span id="end-box" hidden={!v.validUntil || v.recurrence === 'einmalig'}>
                  <input
                    type="date"
                    name="valid_until"
                    value={v.recurrence === 'einmalig' ? '' : (v.validUntil ?? '')}
                  />
                </span>
                <span class="tp-time">
                  <span class="mut">Enthaltene Pause</span>
                  <input name="break_h" value={hours} style="width:70px" inputmode="decimal" /> <span>h</span>
                </span>
              </div>
              <div class="tp-line" data-only="woechentlich monatlich">
                <select name="every" style="width:auto" data-nosearch>
                  {[1, 2, 3, 4, 6].map((n) => (
                    <option value={String(n)} selected={v.every === n}>
                      {n === 1 ? 'jede(n)' : `alle ${n}`}
                    </option>
                  ))}
                </select>
                <span class="mut" id="every-unit">
                  {v.recurrence === 'monatlich' ? 'Monat(e) am selben Tag' : 'Woche(n)'}
                </span>
                <span class="seg" data-only="woechentlich">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <label>
                      <input
                        type="checkbox"
                        name="weekday"
                        value={String(d)}
                        checked={v.weekdays.includes(d)}
                      />
                      <span>{WEEKDAYS_SHORT[d]}</span>
                    </label>
                  ))}
                </span>
                <span class="mut small" data-only="woechentlich">
                  Mehrere Tage auswählbar
                </span>
              </div>
              <div class="tp-line" data-only="woechentlich monatlich">
                <span class="seg">
                  <label>
                    <input type="radio" name="months_mode" value="alle" checked={!v.months?.length} />
                    <span>In allen Monaten</span>
                  </label>
                  <label>
                    <input type="radio" name="months_mode" value="auswahl" checked={!!v.months?.length} />
                    <span>In ausgewählten Monaten</span>
                  </label>
                </span>
                <span class="seg" id="months-box" hidden={!v.months?.length}>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                    <label>
                      <input
                        type="checkbox"
                        name="month"
                        value={String(m)}
                        checked={!!v.months?.includes(m)}
                      />
                      <span>{MONTHS_SHORT[m]}</span>
                    </label>
                  ))}
                </span>
              </div>
            </div>
          </div>
          <div class="tp-row">
            <span class="tp-ic" title="Mitarbeiter">
              ☺
            </span>
            <div class="tp-main tp-cols">
              <div>
                <label>Mitarbeiter</label>
                <div id="emp-list">
                  {(v.employeeIds.length ? v.employeeIds : [null]).map((e) => (
                    <div class="emp-row">
                      {empSelect(e)}
                      <button type="button" class="btn sec sm emp-del" title="entfernen">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <template id="emp-tpl">
                  <div class="emp-row">
                    {empSelect(null)}
                    <button type="button" class="btn sec sm emp-del" title="entfernen">
                      ✕
                    </button>
                  </div>
                </template>
                <button type="button" class="btn sec sm" id="emp-add" style="width:100%;margin-top:6px">
                  Weiteren Mitarbeiter hinzufügen
                </button>
                <p class="small mut" style="margin:6px 0 0">
                  „offen“ = erscheint unter „Zu planende Einsätze“.
                </p>
              </div>
              <div>
                <label for="planning_group">Einsatzgruppe</label>
                <input
                  id="planning_group"
                  name="planning_group"
                  list="groups"
                  value={v.planningGroup ?? ''}
                  placeholder="Einsatzgruppe hinzufügen"
                />
                <datalist id="groups">
                  {groupRows.map((g) => (
                    <option value={g.g} />
                  ))}
                </datalist>
              </div>
            </div>
          </div>
          <div class="tp-row">
            <span class="tp-ic" title="Hinweise">
              ⓘ
            </span>
            <div class="tp-main">
              <textarea name="note" rows={3} placeholder="Einsatzbeschreibung und Hinweise">
                {v.note ?? ''}
              </textarea>
            </div>
          </div>
          <div class="tp-foot">
            {series && (
              <span class="small mut">
                Änderungen gelten für die ganze Serie. Einzelne Tage: in der Planung auf den Termin klicken.
              </span>
            )}
            <a class="btn sec" href="/einsatzplanung">
              Abbrechen
            </a>
            <button class="btn">{series ? 'Speichern' : 'Planung erstellen'}</button>
          </div>
        </form>
        {series && (
          <form
            method="post"
            action={`/einsatzplanung/${series.plans[0]!.id}/beenden`}
            class="card"
            style="margin-top:16px"
          >
            <h3 style="margin-top:0">Serie beenden</h3>
            <p class="small mut" style="margin-top:0">
              Vergangene Termine bleiben erhalten (Soll/Ist, Nachkalkulation). Gilt für alle Mitarbeiter der
              Serie.
            </p>
            <input type="hidden" name="serie" value="1" />
            <label for="last_day">letzter Einsatztag</label>
            <input
              id="last_day"
              type="date"
              name="last_day"
              value={todayBerlin()}
              required
              style="max-width:200px"
            />
            <div class="actions" style="margin-bottom:0">
              <button class="btn danger">Beenden</button>
            </div>
          </form>
        )}
        <script dangerouslySetInnerHTML={{ __html: FORM_JS }} />
      </div>,
    );
  });

  app.post(`/einsatzplanung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    const siteId = one('site_id');
    if (!/^[0-9a-f-]{36}$/.test(siteId)) throw new BusinessError('Bitte einen Einsatzort wählen');
    assertSite(c, siteId);
    const old = await getShiftSeries(sql, id);
    if (old) assertSite(c, old.siteId);
    const recurrence = (one('recurrence') || 'woechentlich') as Recurrence;
    const pause = Number(one('break_h').replace(',', '.') || '0');
    if (!Number.isFinite(pause) || pause < 0 || pause > 3)
      throw new BusinessError('Pause bitte in Stunden (z. B. 0,5)');
    const employees = arr(b, 'employee_id').map((e) => (e && /^[0-9a-f-]{36}$/.test(e) ? e : null));
    await saveShiftSeries(
      sql,
      old?.seriesId ?? id,
      {
        siteId,
        // jede Zeile zählt: „offen“ neben Mitarbeitern = zusätzlich ein zu besetzender Termin
        employeeIds: employees.length ? employees : [null],
        recurrence,
        every: Number(one('every')) || 1,
        weekdays: arr(b, 'weekday').map(Number),
        months: one('months_mode') === 'auswahl' ? arr(b, 'month').map(Number) : null,
        startTime: one('start'),
        endTime: one('end'),
        breakMinutes: Math.round(pause * 60),
        validFrom: one('valid_from'),
        validUntil: one('valid_until') || null,
        note: one('note') || null,
        planningGroup: one('planning_group') || null,
      },
      c.get('actor'),
    );
    return back(c, `/einsatzplanung?datum=${one('valid_from')}`, {
      ok: old ? 'Terminserie gespeichert.' : 'Planung erstellt.',
    });
  });
}

const FILTER_JS = `
document.querySelectorAll('[data-filter-list]').forEach(function(inp){
  var sel=inp.getAttribute('data-filter-list');
  inp.addEventListener('input',function(){var t=inp.value.toLowerCase();
    document.querySelectorAll(sel).forEach(function(l){l.hidden=t&&l.textContent.toLowerCase().indexOf(t)<0;});});
});`;

const FORM_JS = `
(function(){
  var f=document.querySelector('form.tp'); if(!f) return;
  function rec(){var r=f.querySelector('[name=recurrence]:checked'); return r?r.value:'woechentlich';}
  function sync(){
    var r=rec();
    f.querySelectorAll('[data-only]').forEach(function(el){el.hidden=el.getAttribute('data-only').split(' ').indexOf(r)<0;});
    var u=document.getElementById('every-unit'); if(u) u.textContent=r==='monatlich'?'Monat(e) am selben Tag':'Woche(n)';
    var mb=document.getElementById('months-box'); var auswahl=f.querySelector('[name=months_mode][value=auswahl]');
    if(mb&&auswahl) mb.hidden=!auswahl.checked||r==='einmalig';
    var s=f.querySelector('[name=start]').value, e=f.querySelector('[name=end]').value, p=parseFloat((f.querySelector('[name=break_h]').value||'0').replace(',','.'))||0;
    var d=document.getElementById('tp-dur');
    if(s&&e){var m=(+e.slice(0,2)*60+ +e.slice(3))-(+s.slice(0,2)*60+ +s.slice(3))-p*60; d.textContent=m>0?(m/60).toFixed(2).replace('.',',')+' h':'Ende vor Beginn';}
  }
  f.addEventListener('change',sync); f.addEventListener('input',sync); sync();
  var list=document.getElementById('emp-list'), tpl=document.getElementById('emp-tpl');
  document.getElementById('emp-add').addEventListener('click',function(){list.appendChild(tpl.content.firstElementChild.cloneNode(true));});
  list.addEventListener('click',function(ev){var b=ev.target.closest('.emp-del'); if(!b) return;
    if(list.querySelectorAll('.emp-row').length>1) b.parentNode.remove(); else b.parentNode.querySelector('select').value='';});
})();`;
