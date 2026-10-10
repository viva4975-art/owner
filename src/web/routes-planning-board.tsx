import { Icon } from './icons.js';
import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday, mondayOf } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { countWithoutShift, listEmployees } from '../services/employees.js';
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
import { canAccess } from './permissions.js';
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

interface SiteInfo {
  id: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  customer_name: string;
  manager: string | null;
  manager_phone: string | null;
}

const Block: FC<{
  s: PlannedShift;
  site: SiteInfo | undefined;
  compact: boolean;
  back: string;
  phone?: string | null | undefined;
}> = ({ s, site, compact, back, phone }) => {
  const open = !s.plan.employee_id;
  const cls = open ? 'open' : s.absence ? 'absent' : s.entry ? 'done' : s.exception ? 'changed' : 'planned';
  const dayHref = `/einsatzplanung/${s.plan.id}/tag/${s.date}?zurueck=${encodeURIComponent(back)}`;
  const href = open ? `/einsatzplanung/${s.plan.id}` : dayHref;
  const status = open
    ? 'offen – noch niemand eingeplant'
    : s.absence
      ? `${ABSENCE_LABEL[s.absence as AbsenceKind]} – Vertretung nötig`
      : s.exception
        ? s.exception.kind === 'vertretung'
          ? `Vertretung für ${s.exception.original}`
          : s.exception.kind === 'ausfall'
            ? 'Ausfall'
            : 'umgeplant'
        : s.entry
          ? 'erledigt (Zeit erfasst)'
          : 'geplant';
  const addr = site
    ? [site.street, [site.postal_code, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : '';
  const data = {
    site: `${s.plan.site_name} (${s.plan.site_no})`,
    siteHref: `/objekte/${s.plan.site_id}`,
    customer: site?.customer_name ?? '',
    addr,
    maps: addr ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}` : '',
    emp: open ? '' : `${s.plan.employee_name} (${s.plan.personnel_no})`,
    empHref: open ? '' : `/personal/${s.plan.employee_id}`,
    phone: phone ?? '',
    date: `${WEEKDAYS_SHORT[isoWeekday(s.date)]} ${dateDe(s.date)}`,
    time: `${s.plan.start_time}–${s.plan.end_time}`,
    dur: `${hm(s.minutes)} Std.${s.plan.break_minutes ? ` (Pause ${s.plan.break_minutes} Min.)` : ''}`,
    series:
      s.plan.recurrence === 'einmalig'
        ? 'einmaliger Termin'
        : `${s.plan.recurrence === 'monatlich' ? 'monatlich' : `jede${(s.plan.every ?? 1) > 1 ? `n ${s.plan.every}.` : ''} ${WEEKDAYS_SHORT[s.plan.weekday]}`} seit ${dateDe(s.plan.valid_from)}${s.plan.valid_until ? ` bis ${dateDe(s.plan.valid_until)}` : ''}`,
    note: s.plan.note ?? '',
    manager: site?.manager ? `${site.manager}${site.manager_phone ? ` · ${site.manager_phone}` : ''}` : '',
    status,
    cls,
    day: dayHref,
    serie: `/einsatzplanung/${s.plan.id}?zurueck=${encodeURIComponent(back)}`,
    open,
  };
  return (
    <a
      class={`pb-ev ${cls}`}
      href={href}
      data-ev={JSON.stringify(data)}
      title={`${data.site} · ${data.time} · ${status}${s.plan.note ? ` · ${s.plan.note}` : ''}`}
    >
      <span class="t">{s.plan.site_name}</span>
      <span class="m">
        {s.plan.start_time}
        {compact ? '' : `–${s.plan.end_time} · ${hm(s.minutes)}h`}
      </span>
      {!compact && (site?.city || site?.street) && <span class="m a">{site.street ?? site.city}</span>}
      {!compact && open && s.plan.note && <span class="m a">{s.plan.note}</span>}
    </a>
  );
};

const EV_DIALOG_JS = `(function(){
var d=document.getElementById('ev-dlg');if(!d)return;
function esc(t){return String(t||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function row(l,v,h){if(!v)return '';return '<div class="r"><span>'+l+'</span><b>'+(h?'<a href="'+esc(h)+'">'+esc(v)+'</a>':esc(v))+'</b></div>'}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a.pb-ev[data-ev]');if(!a||e.ctrlKey||e.metaKey||e.shiftKey)return;e.preventDefault();
var x=JSON.parse(a.getAttribute('data-ev'));
var h='<div class="hd '+esc(x.cls)+'"><div><div class="small">'+esc(x.date)+' · '+esc(x.time)+'</div><h3>'+esc(x.site)+'</h3><div class="small">'+esc(x.status)+'</div></div><button type="button" class="x" aria-label="schließen">×</button></div><div class="bd">'
+row('Kunde',x.customer)+row('Adresse',x.addr,x.maps)+row('Mitarbeiter',x.emp,x.empHref)+row('Telefon',x.phone,x.phone?'tel:'+x.phone:'')+row('Dauer',x.dur)+row('Termin',x.series)+row('Objektleitung',x.manager)+row('Beschreibung',x.note)
+'</div><div class="ft">'+(x.open?'<a class="btn" href="'+esc(x.serie)+'">Mitarbeiter einplanen</a>':'<a class="btn" href="'+esc(x.day)+'&art=vertretung">Vertretung einplanen</a><a class="btn sec" href="'+esc(x.day)+'">Umplanen / Ausfall</a><a class="btn sec" href="'+esc(x.serie)+'">Serie bearbeiten</a>')+'<a class="btn ghost" href="'+esc(x.siteHref)+'">Objekt</a></div>';
d.innerHTML=h;d.showModal();});
d.addEventListener('click',function(e){if(e.target===d||e.target.classList.contains('x'))d.close()});
// Monat: mit gedrückter Maustaste nach links/rechts ziehen
document.querySelectorAll('.pb-sec').forEach(function(el){var down=false,sx=0,sl=0,moved=false;
el.addEventListener('mousedown',function(e){if(e.button!==0||e.target.closest('a,button,input,select'))return;down=true;moved=false;sx=e.pageX;sl=el.scrollLeft;el.classList.add('drag')});
window.addEventListener('mouseup',function(){down=false;el.classList.remove('drag')});
el.addEventListener('mousemove',function(e){if(!down)return;var dx=e.pageX-sx;if(Math.abs(dx)>3)moved=true;el.scrollLeft=sl-dx});});
})();`;

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
      sql<SiteInfo[]>`
        select s.id, s.street, s.postal_code, s.city, c.name as customer_name, m.name as manager,
               m.phone as manager_phone
          from app.sites s join app.customers c on c.id = s.customer_id
          left join app.manager_contacts m on m.user_id = s.manager_user_id`,
      sql<{ employee_id: string; kind: AbsenceKind; start_date: string; end_date: string }[]>`
        select employee_id, kind, start_date, end_date from app.absences
         where status = 'genehmigt' and start_date <= ${r.to} and end_date >= ${r.from}`,
    ]);
    const shifts = scope ? allShifts.filter((s) => scope.includes(s.plan.site_id)) : allShifts;
    const siteOf = new Map(sites.map((s) => [s.id, s]));
    const phoneOf = new Map(
      emps.map((e) => [
        e.id,
        (e as { mobile?: string | null; phone?: string | null }).mobile ??
          (e as { phone?: string | null }).phone ??
          null,
      ]),
    );
    const days: string[] = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);
    const open = shifts.filter((s) => !s.plan.employee_id);
    const noShift = await countWithoutShift(sql, scope);
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
    // Woche/5 Tage passen ohne Scrollen auf den Bildschirm, Monat ist breiter (mit der Maus ziehen)
    // Tagesspalten nie schmaler als 110 px – am Handy wird seitlich gescrollt statt unlesbar gequetscht (Seitenprüfung 10.10.)
    const cols = `grid-template-columns:clamp(110px,24vw,170px) repeat(${days.length},minmax(${compact ? 92 : view === 'tag' ? 260 : 110}px,1fr))`;
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
              Vertretungen
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
          <select
            name="gruppe"
            onchange="this.form.submit()"
            style="width:auto"
            data-nosearch
            aria-label="Einsatzgruppe"
          >
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
        {noShift > 0 && (
          <a
            class="due-banner warn"
            href={
              canAccess(c.get('user').role, '/personal')
                ? '/personal?status=aktiv&einsatz=ohne'
                : self({ alle: '1' })
            }
          >
            <span class="ico">!</span>
            <span>
              <b>{noShift} aktive Mitarbeitende ohne laufenden Einsatz</b>{' '}
              <span class="small">Anzeigen und Einsatz planen →</span>
            </span>
          </a>
        )}
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
                    <Block s={s} site={siteOf.get(s.plan.site_id)} compact={compact} back={backUrl} />
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
                          <a href={`/personal/${e.id}/kalender`}>
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
                                    site={siteOf.get(s.plan.site_id)}
                                    compact={compact}
                                    back={backUrl}
                                    phone={phoneOf.get(e.id)}
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
          · Rot = Mitarbeiter abwesend. Feiertage (Bayern) farbig. Klick auf einen Termin zeigt alle Angaben
          mit „Vertretung einplanen“, „Umplanen / Ausfall“ und „Serie bearbeiten“. Monatsansicht: mit
          gedrückter Maustaste nach links/rechts ziehen.
        </p>
        <dialog id="ev-dlg" class="ev-dlg" />
        <script dangerouslySetInnerHTML={{ __html: FILTER_JS }} />
        <script dangerouslySetInnerHTML={{ __html: EV_DIALOG_JS }} />
      </div>,
    );
  });

  // ------------------------------------------------------------------ Termin oder Terminserie planen
  app.get(`/einsatzplanung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    // Rücksprung (z. B. vom Mitarbeiter oder Objekt aus geplant → dorthin zurück)
    const ret = safeReturn(c.req.query('zurueck'));
    const series = await getShiftSeries(sql, id);
    if (series) assertSite(c, series.siteId);
    const scope = c.get('sites');
    const [sites, emps, groupRows] = await Promise.all([
      sql<
        {
          id: string;
          site_no: string;
          name: string;
          street: string | null;
          city: string | null;
          customer_id: string;
          customer_no: string;
          customer_name: string;
        }[]
      >`
        select s.id, s.site_no, s.name, s.street, s.city, c.id as customer_id, c.customer_no, c.name as customer_name
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
      holidayWork: false,
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
              <a href={ret}>{ret === '/einsatzplanung' ? 'Planung' : 'zurück'}</a>
            </div>
            <h1>
              <a href={ret} class="x" aria-label="schließen">
                ✕
              </a>{' '}
              {series ? 'Terminserie ändern' : 'Termin oder Terminserie planen'}
            </h1>
          </div>
        </div>
        <form method="post" action={`/einsatzplanung/${id}`} class="tp" data-autosave>
          <input type="hidden" name="zurueck" value={ret} />
          <div class="tp-row">
            <span class="tp-ic" title="Einsatzort">
              <Icon name="pin" size={16} />
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
                          {s.street ? ` – ${s.street}${s.city ? `, ${s.city}` : ''}` : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <div class="tp-row">
            <span class="tp-ic" title="Termin">
              <Icon name="calendar" size={16} />
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
                <button
                  type="button"
                  class="btn sm sec"
                  data-only="woechentlich"
                  onclick="this.form.querySelectorAll('input[name=weekday]').forEach(function(x){x.checked=Number(x.value)<=5})"
                >
                  Mo–Fr
                </button>
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
              <Icon name="user" size={16} />
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
              <div class="chk" style="margin-top:10px">
                <input
                  type="checkbox"
                  id="holiday_work"
                  name="holiday_work"
                  value="1"
                  checked={!!v.holidayWork}
                />
                <label for="holiday_work">
                  Auch an Sonn- und Feiertagen arbeiten
                  <span class="small mut" style="display:block">
                    Ohne Haken ist der Feiertag frei (bezahlter Feiertag) und es gibt keine
                    Sonn-/Feiertagszuschläge. Einsätze am Sonntag zählen immer als Sonntagsarbeit.
                  </span>
                </label>
              </div>
            </div>
          </div>
          <div class="tp-row">
            <span class="tp-ic" title="Hinweise">
              <Icon name="pencil" size={16} />
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
            <a class="btn sec" href={ret}>
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
            <input type="hidden" name="zurueck" value={ret} />
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
        {series && (
          <form
            method="post"
            action={`/einsatzplanung/${series.plans[0]!.id}/loeschen`}
            class="card"
            style="margin-top:16px"
            onsubmit="return confirm('Ganze Serie löschen? Alle Termine dieser Serie verschwinden aus der Planung.')"
          >
            <h3 style="margin-top:0">Serie löschen</h3>
            <p class="small mut" style="margin-top:0">
              Für falsch angelegte Einsätze: entfernt die Serie ganz (alle Mitarbeiter, alle Tage). Schon
              erfasste Zeiten bleiben erhalten (sie stehen dann „ohne Einsatz“). Einen einzelnen Tag
              streichen: in der Planung auf den Termin klicken → Ausfall.
            </p>
            <input type="hidden" name="serie" value="1" />
            <input type="hidden" name="zurueck" value={ret} />
            <div class="actions" style="margin-bottom:0">
              <button class="btn danger">Serie löschen</button>
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
        holidayWork: one('holiday_work') === '1',
      },
      c.get('actor'),
    );
    const ret = safeReturn(one('zurueck'));
    const notes: string[] = [];
    if (!old && one('valid_from') < todayBerlin())
      notes.push(
        'Hinweis: Rückwirkend angelegte Termine zählen erst ab heute als Plan/Soll. Vergangene Tage bitte als Zeit nachtragen.',
      );
    const ids = employees.filter((e): e is string => !!e);
    if (ids.length) {
      const early = await sql<{ name: string; entry_date: string }[]>`
        select first_name || ' ' || last_name as name, entry_date::text
          from app.employees where id = any(${ids}::uuid[]) and entry_date > ${one('valid_from')}::date`;
      for (const e of early)
        notes.push(`Achtung: ${e.name} tritt erst am ${dateDe(e.entry_date)} ein – vorher keine Einsätze.`);
    }
    return back(c, ret !== '/einsatzplanung' ? ret : `/einsatzplanung?datum=${one('valid_from')}`, {
      ok: [old ? 'Terminserie gespeichert.' : 'Planung erstellt.', ...notes].join(' '),
    });
  });
}

/** nur eigene, relative Adressen als Rücksprung (kein offener Redirect) */
export function safeReturn(v: unknown): string {
  return typeof v === 'string' && /^\/[a-z0-9]/i.test(v) && !v.startsWith('//') && v.length < 300
    ? v
    : '/einsatzplanung';
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
