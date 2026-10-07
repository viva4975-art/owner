import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { type PlannedShift, type TimeEntryRow, clock, hm, netMinutes } from '../services/time.js';
import { dateDe } from './layout.js';
import { type CalView, calRange, monthName } from './pages-site-calendar.js';

/*
 * Einsatzkalender eines Mitarbeiters wie Fortytools (Ahmed 07.10.): Tag / 5 Tage / Woche / Monat, je Einsatz ein
 * farbiger Balken mit Objekt, und auf einen Blick, ob die Zeit bestätigt ist (Uhr-Symbol). Antippen → Details mit
 * geplant/erfasst und den passenden Aktionen (Zeit erfassen/ändern, Umplanen/Vertretung, Serie).
 */

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const EMP_VIEWS: [Exclude<CalView, 'liste'>, string][] = [
  ['tag', 'Tag'],
  ['5tage', '5 Tage'],
  ['woche', 'Woche'],
  ['monat', 'Monat'],
];

export interface EmpCalAbsence {
  kind: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
}

type State = { cls: string; label: string; clock: boolean };

const stateOf = (s: PlannedShift, today: string): State => {
  if (s.exception?.kind === 'ausfall') return { cls: 'cx', label: 'Ausfall', clock: false };
  if (s.absence)
    return {
      cls: 'abs',
      label: ABSENCE_LABEL[s.absence as AbsenceKind] ?? 'abwesend',
      clock: false,
    };
  const e = s.entry;
  if (e?.status === 'laeuft') return { cls: 'run', label: `läuft seit ${clock(e.start_at)}`, clock: false };
  if (e?.status === 'beantragt') return { cls: 'req', label: 'Nachtrag – Freigabe offen', clock: false };
  if (e && e.status !== 'abgelehnt')
    return {
      cls: 'ok',
      label: `Zeit bestätigt ${clock(e.start_at)}–${e.end_at ? clock(e.end_at) : ''}`,
      clock: true,
    };
  if (s.holiday) return { cls: 'hol', label: s.holiday, clock: false };
  if (s.date < today) return { cls: 'miss', label: 'keine Zeit erfasst', clock: false };
  return { cls: 'plan', label: 'geplant', clock: false };
};

const CSS = `
.ec-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.ec-bar .seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
.ec-bar .seg a{padding:7px 13px;color:var(--ink);text-decoration:none;border-right:1px solid var(--line);font-size:14px}
.ec-bar .seg a:last-child{border-right:0}.ec-bar .seg a.on{background:var(--brand);color:#fff}
.ec-bar h3{margin:0 6px;font-size:17px}
.ec-sum{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.ec-sum span{background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px}
.ec-sum b{font-variant-numeric:tabular-nums}
.ec{display:grid;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
.ec .dh{padding:6px 6px 2px;font-size:12px;color:var(--mut);text-align:center;border-right:1px solid var(--line);background:#fbf7f8}
.ec .dc{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px 4px 8px;min-height:96px;min-width:0}
.ec .dc .n{display:block;text-align:center;font-weight:700;font-size:13px;margin-bottom:4px;color:var(--ink);text-decoration:none}
.ec .dc .n small{display:block;font-weight:500;color:var(--mut);font-size:11px}
.ec .dc.out{background:#f6f3f4}.ec .dc.out .n{color:var(--faint)}
.ec .dc.we{background:#fcfafb}
.ec .dc.today{background:#fff8d6}
.ec .dc.hol{background:#eaf1fb}.ec .dc .hn{display:block;text-align:center;font-size:11px;color:#2f5f9e;font-weight:600;line-height:1.2;margin-bottom:3px}
.ec .dc.absd{background:repeating-linear-gradient(135deg,#f4f0f2 0 6px,#fff 6px 12px)}
.ec .dc .ab{display:block;text-align:center;font-size:11px;font-weight:600;color:#7a5a66;margin-bottom:3px}
.ev{display:flex;align-items:center;gap:4px;border-radius:6px;padding:3px 6px;margin-bottom:3px;font-size:12px;line-height:1.25;text-decoration:none;cursor:pointer;min-width:0;border:1px solid transparent}
.ev .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.ev .tm{font-variant-numeric:tabular-nums;opacity:.85}
.ev .ic{flex:none;width:14px;height:14px}
.ev.plan{background:#f6e3ea;color:#7d1435;border-color:#ecc9d6}
.ev.ok{background:#7d1435;color:#fff}
.ev.run{background:#1f6fb5;color:#fff}
.ev.req{background:#fff1d6;color:#8a5a00;border-color:#f0d18f}
.ev.miss{background:#fff;color:#b42318;border:1px dashed #e7a19a}
.ev.abs{background:#eee8eb;color:#6b5a62;text-decoration:line-through}
.ev.cx{background:#f2f2f2;color:#999;text-decoration:line-through}
.ev.hol{background:#eaf1fb;color:#2f5f9e}
.ev.extra{background:#e7f4ec;color:#1d6b35;border-color:#b9e0c6}
.ec.wk .dc{min-height:180px}.ec.wk .ev{flex-wrap:wrap;padding:6px 8px}.ec.wk .ev .t{white-space:normal;flex-basis:100%}
.ec-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin:10px 0 0}
.ec-legend .ev{display:inline-flex;margin:0;cursor:default}
#ec-dlg{border:0;border-radius:16px;padding:0;width:min(440px,94vw);box-shadow:0 20px 50px rgba(0,0,0,.25)}
#ec-dlg::backdrop{background:rgba(30,10,18,.4)}
#ec-dlg .hd{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}
#ec-dlg .hd h3{margin:2px 0;font-size:18px}#ec-dlg .hd .x{margin-left:auto;border:0;background:none;font-size:24px;cursor:pointer;color:var(--mut)}
#ec-dlg .bd{padding:12px 18px}#ec-dlg .r{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #f3eef0;font-size:14px}
#ec-dlg .r span{color:var(--mut)}#ec-dlg .ft{padding:12px 18px 16px;display:flex;flex-wrap:wrap;gap:8px}
@media (max-width:700px){.ec .dc{min-height:70px;padding:2px 2px 6px}.ev{padding:2px 3px;font-size:10.5px}.ev .tm{display:none}.ec .dh{font-size:10.5px;padding:4px 2px}.ec .dc .n{font-size:11.5px}.ec .dc .n small{display:none}.ec.wk{grid-template-columns:1fr!important}.ec.wk .dh{display:none}.ec.wk .dc .n small{display:inline;margin-left:6px}}
`;

const CLOCK_SVG =
  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const DLG_JS = `(function(){var d=document.getElementById('ec-dlg');if(!d)return;
function esc(t){return String(t||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function row(l,v){return v?'<div class="r"><span>'+l+'</span><b>'+esc(v)+'</b></div>':''}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a.ev[data-ev]');if(!a||e.ctrlKey||e.metaKey)return;e.preventDefault();
var x=JSON.parse(a.getAttribute('data-ev'));var b='';(x.links||[]).forEach(function(l,i){b+='<a class="btn'+(i?' sec':'')+'" href="'+esc(l[1])+'">'+esc(l[0])+'</a>'});
d.innerHTML='<div class="hd"><div><div class="small mut">'+esc(x.date)+'</div><h3>'+esc(x.site)+'</h3><div class="small">'+esc(x.status)+'</div></div><button type="button" class="x" aria-label="schließen">×</button></div><div class="bd">'+row('Geplant',x.plan)+row('Pause geplant',x.brk)+row('Erfasst',x.ist)+row('Pause',x.istBrk)+row('Arbeitszeit',x.net)+row('Quelle',x.src)+row('Termin',x.series)+'</div><div class="ft">'+b+'</div>';d.showModal()});
d.addEventListener('click',function(e){if(e.target===d||e.target.classList.contains('x'))d.close()});})();`;

export const EmployeeCalendarView: FC<{
  employeeId: string;
  view: Exclude<CalView, 'liste'>;
  date: string;
  today: string;
  shifts: PlannedShift[];
  extra: TimeEntryRow[];
  absences: EmpCalAbsence[];
  holiday: (d: string) => string | undefined;
  canEdit: boolean;
}> = ({ employeeId, view, date, today, shifts, extra, absences, holiday, canEdit }) => {
  const r = calRange(view, date);
  const days: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);
  const base = `/personal/${employeeId}/kalender`;
  const url = (v: string, d: string) => `${base}?ansicht=${v}&datum=${d}`;
  const back = url(view, date);
  const month = date.slice(0, 7);
  const title =
    view === 'monat'
      ? monthName(month)
      : view === 'tag'
        ? `${WD[isoWeekday(date) - 1]}, ${dateDe(date)}`
        : `${dateDe(r.from)} – ${dateDe(r.to)}`;
  const absOn = (d: string) => absences.find((a) => a.start_date <= d && a.end_date >= d);
  // Summen nur für den Monat bzw. den sichtbaren Zeitraum
  const inScope = (d: string) => (view === 'monat' ? d.slice(0, 7) === month : true);
  const vis = shifts.filter(
    (s) => inScope(s.date) && s.exception?.kind !== 'ausfall' && !s.absence && !s.holiday,
  );
  const planned = vis.reduce((a, s) => a + s.minutes, 0);
  const done = vis.filter((s) => s.entry && !['abgelehnt', 'laeuft', 'beantragt'].includes(s.entry.status));
  const worked =
    done.reduce((a, s) => a + netMinutes(s.entry!), 0) +
    extra.filter((e) => inScope(e.work_date) && e.end_at).reduce((a, e) => a + netMinutes(e), 0);
  const missing = vis.filter((s) => !s.entry && s.date < today).length;

  const Ev = ({ s }: { s: PlannedShift }) => {
    const st = stateOf(s, today);
    const e = s.entry;
    const links: [string, string][] = [];
    if (canEdit) {
      if (e) links.push(['Zeit ansehen / ändern', `/zeiterfassung/${e.id}`]);
      else if (!s.absence && s.exception?.kind !== 'ausfall' && s.date <= today)
        links.push([
          'Zeit erfassen',
          `/zeiterfassung/${randomUUID()}?mitarbeiter=${employeeId}&objekt=${s.plan.site_id}&datum=${s.date}&von=${s.plan.start_time}&bis=${s.plan.end_time}&pause=${s.plan.break_minutes ?? 0}`,
        ]);
      links.push([
        'Umplanen / Vertretung',
        `/einsatzplanung/${s.plan.id}/tag/${s.date}?zurueck=${encodeURIComponent(back)}`,
      ]);
      links.push(['Terminserie', `/einsatzplanung/${s.plan.id}?zurueck=${encodeURIComponent(back)}`]);
    }
    links.push(['Objekt', `/objekte/${s.plan.site_id}`]);
    const data = {
      site: `${s.plan.site_name} (${s.plan.site_no})`,
      date: `${WD[isoWeekday(s.date) - 1]} ${dateDe(s.date)}`,
      status: st.label,
      plan: `${s.plan.start_time}–${s.plan.end_time} · ${hm(s.minutes)} Std.`,
      brk: s.plan.break_minutes ? `${s.plan.break_minutes} Min.` : '',
      ist: e ? `${clock(e.start_at)}–${e.end_at ? clock(e.end_at) : 'läuft'}` : '',
      istBrk: e ? `${e.break_minutes} Min.` : '',
      net: e?.end_at ? `${hm(netMinutes(e))} Std.` : '',
      src: e
        ? ((
            {
              stempel: 'Stempeluhr',
              soll_bestaetigt: 'Soll bestätigt',
              nachtrag: 'Nachtrag',
              buero: 'Büro',
            } as Record<string, string>
          )[e.source] ?? e.source)
        : '',
      series:
        s.plan.recurrence === 'einmalig'
          ? 'einmalig'
          : s.plan.recurrence === 'monatlich'
            ? 'jeden Monat'
            : (s.plan.every ?? 1) > 1
              ? `alle ${s.plan.every} Wochen`
              : 'jede Woche',
      links,
    };
    return (
      <a
        class={`ev ${st.cls}`}
        href={links[0]?.[1] ?? '#'}
        data-ev={JSON.stringify(data)}
        title={`${s.plan.site_name} · ${s.plan.start_time}–${s.plan.end_time} · ${st.label}`}
      >
        <span class="t">{s.plan.site_name}</span>
        <span class="tm">
          {view === 'monat' ? s.plan.start_time : `${s.plan.start_time}–${s.plan.end_time}`}
        </span>
        {st.clock && <span style="display:contents" dangerouslySetInnerHTML={{ __html: CLOCK_SVG }} />}
      </a>
    );
  };
  const Extra = ({ e }: { e: TimeEntryRow }) => (
    <a
      class="ev extra"
      href={canEdit ? `/zeiterfassung/${e.id}` : '#'}
      title={`ohne Einsatz: ${e.site_name} ${clock(e.start_at)}–${e.end_at ? clock(e.end_at) : 'läuft'}`}
    >
      <span class="t">{e.site_name}</span>
      <span class="tm">{clock(e.start_at)}</span>
      <span style="display:contents" dangerouslySetInnerHTML={{ __html: CLOCK_SVG }} />
    </a>
  );
  const Cell = ({ d }: { d: string }) => {
    const list = shifts
      .filter((s) => s.date === d)
      .sort((a, b) => a.plan.start_time.localeCompare(b.plan.start_time));
    const ex = extra.filter((e) => e.work_date === d);
    const hol = holiday(d);
    const ab = absOn(d);
    const wd = isoWeekday(d);
    const cls = [
      'dc',
      view === 'monat' && d.slice(0, 7) !== month ? 'out' : '',
      wd >= 6 ? 'we' : '',
      hol ? 'hol' : '',
      ab ? 'absd' : '',
      d === today ? 'today' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div class={cls}>
        <a class="n" href={url('tag', d)}>
          {view === 'monat' ? `${Number(d.slice(8))}.` : `${WD[wd - 1]} ${dateDe(d).slice(0, 6)}`}
          {view === 'monat' && <small>{WD[wd - 1]}</small>}
        </a>
        {hol && <span class="hn">{hol}</span>}
        {ab && (
          <span class="ab">
            {ABSENCE_LABEL[ab.kind as AbsenceKind] ?? 'abwesend'}
            {ab.half_day ? ' (½)' : ''}
          </span>
        )}
        {(view === 'monat' ? list.slice(0, 3) : list).map((s) => (
          <Ev s={s} />
        ))}
        {view === 'monat' && list.length > 3 && (
          <a class="small" href={url('tag', d)} style="display:block;text-align:center">
            + {list.length - 3} weitere
          </a>
        )}
        {ex.map((e) => (
          <Extra e={e} />
        ))}
      </div>
    );
  };
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div class="ec-bar">
        <span class="seg">
          {EMP_VIEWS.map(([k, l]) => (
            <a href={url(k, date)} class={k === view ? 'on' : ''}>
              {l}
            </a>
          ))}
        </span>
        <span class="seg">
          <a href={url(view, r.prev)} aria-label="zurück">
            ←
          </a>
          <a href={url(view, today)}>{view === 'monat' ? 'Dieser Monat' : 'Heute'}</a>
          <a href={url(view, r.next)} aria-label="vor">
            →
          </a>
        </span>
        <h3>{title}</h3>
        {canEdit && (
          <a
            class="btn sm"
            style="margin-left:auto"
            href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${employeeId}&zurueck=${encodeURIComponent(back)}`}
          >
            + Einsatz planen
          </a>
        )}
      </div>
      <div class="ec-sum">
        <span>
          geplant <b>{hm(planned)}</b> Std.
        </span>
        <span>
          gearbeitet <b>{hm(worked)}</b> Std.
        </span>
        <span>
          bestätigt <b>{done.length}</b> von <b>{vis.filter((s) => s.date <= today).length}</b> Einsätzen
        </span>
        {missing > 0 && (
          <span style="border-color:#e7a19a;color:#b42318">
            <b>{missing}</b> ohne erfasste Zeit
          </span>
        )}
      </div>
      {view === 'monat' ? (
        <div class="ec" style="grid-template-columns:repeat(7,minmax(0,1fr))">
          {WD.map((w) => (
            <div class="dh">{w}</div>
          ))}
          {days.map((d) => (
            <Cell d={d} />
          ))}
        </div>
      ) : (
        <div class="ec wk" style={`grid-template-columns:repeat(${days.length},minmax(0,1fr))`}>
          {days.map((d) => (
            <Cell d={d} />
          ))}
        </div>
      )}
      <div class="ec-legend">
        <span class="ev plan">geplant</span>
        <span class="ev ok">
          Zeit bestätigt <span style="display:contents" dangerouslySetInnerHTML={{ __html: CLOCK_SVG }} />
        </span>
        <span class="ev run">läuft</span>
        <span class="ev req">Nachtrag offen</span>
        <span class="ev miss">keine Zeit erfasst</span>
        <span class="ev abs">abwesend</span>
        <span class="ev extra">ohne Einsatz gearbeitet</span>
      </div>
      <dialog id="ec-dlg" />
      <script dangerouslySetInnerHTML={{ __html: DLG_JS }} />
    </>
  );
};

// ---------------------------------------------------------------------------
// Einsatzliste eines Mitarbeiters: je Objekt eine Karte, gleiche Zeiten mit allen Wochentagen in einer Zeile
// ---------------------------------------------------------------------------

export interface PlanRowLite {
  id: string;
  series_id: string | null;
  site_id: string;
  site_name: string;
  site_no: string;
  weekday: number;
  start_time: string;
  end_time: string;
  break_minutes: number | null;
  valid_from: string;
  valid_until: string | null;
  recurrence: string | null;
  every: number | null;
  note: string | null;
}

export interface SiteLite {
  id: string;
  customer_name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
}

const minutesOf = (p: PlanRowLite) => {
  const [a, b] = [p.start_time, p.end_time].map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
  return Math.max(0, ((b! - a! + 1440) % 1440) - (p.break_minutes ?? 0));
};

const PL_CSS = `
.pl-site{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:14px;overflow:hidden}
.pl-site .hd{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-bottom:1px solid var(--line);background:#fbf7f8}
.pl-site .hd h3{margin:0;font-size:16px}.pl-site .hd .sub{color:var(--mut);font-size:13px;margin-top:2px}
.pl-site .hd .rt{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.pl-row{display:grid;grid-template-columns:minmax(150px,auto) 130px 90px 1fr auto;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #f3eef0}
.pl-row:last-child{border-bottom:0}
.pl-days{display:flex;gap:4px;flex-wrap:wrap}.pl-days span{width:30px;text-align:center;font-size:12px;font-weight:600;padding:4px 0;border-radius:6px;background:#f3eef0;color:#b9a9b0}
.pl-days span.on{background:#7d1435;color:#fff}
.pl-time{font-weight:700;font-variant-numeric:tabular-nums}.pl-h{color:var(--mut);font-variant-numeric:tabular-nums}
.pl-valid{font-size:13px;color:var(--mut)}
.pill.okp{background:#e3f4e8;color:#1d6b35}.pill.badp{background:#fde3e3;color:#a11d1d}
@media (max-width:760px){.pl-row{grid-template-columns:1fr 1fr;row-gap:6px}.pl-row .pl-days{grid-column:1/-1}.pl-row .pl-act{grid-column:1/-1}}
`;

export const EmployeePlanList: FC<{
  employeeId: string;
  plans: PlanRowLite[];
  sites: SiteLite[];
  /** je Objekt: Einsätze der letzten 7 Tage und davon mit erfasster Zeit */
  recent: Map<string, { total: number; done: number }>;
  today: string;
  ret: string;
  canEdit: boolean;
}> = ({ employeeId, plans, sites, recent, today, ret, canEdit }) => {
  const active = plans.filter((p) => !p.valid_until || p.valid_until >= today);
  const ended = plans.filter((p) => p.valid_until && p.valid_until < today);
  const bySite = new Map<string, PlanRowLite[]>();
  for (const p of active) bySite.set(p.site_id, [...(bySite.get(p.site_id) ?? []), p]);
  const weekMinutes = active.reduce(
    (a, p) => a + (p.recurrence === 'woechentlich' || !p.recurrence ? minutesOf(p) / (p.every ?? 1) : 0),
    0,
  );
  const groupsOf = (list: PlanRowLite[]) => {
    const g = new Map<string, PlanRowLite[]>();
    for (const p of list) {
      const k = [
        p.start_time,
        p.end_time,
        p.break_minutes ?? 0,
        p.valid_from,
        p.valid_until ?? '',
        p.recurrence,
        p.every,
      ].join('|');
      g.set(k, [...(g.get(k) ?? []), p]);
    }
    return [...g.values()].sort((a, b) => a[0]!.start_time.localeCompare(b[0]!.start_time));
  };
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PL_CSS }} />
      <div class="ec-sum" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        {canEdit && (
          <a
            class="btn sm"
            href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${employeeId}&zurueck=${encodeURIComponent(ret)}`}
          >
            + Einsatz planen
          </a>
        )}
        <span class="pill">
          {bySite.size} {bySite.size === 1 ? 'Objekt' : 'Objekte'}
        </span>
        <span class="pill">≈ {hm(Math.round(weekMinutes))} Std. pro Woche geplant</span>
        <a class="btn sm ghost" href={`/personal/${employeeId}/kalender`}>
          Einsatzkalender öffnen
        </a>
      </div>
      {bySite.size === 0 && <div class="card mut">Keine laufenden Einsätze.</div>}
      {[...bySite.entries()].map(([siteId, list]) => {
        const site = sites.find((s) => s.id === siteId);
        const rc = recent.get(siteId);
        const addr = site
          ? [site.street, [site.postal_code, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
          : '';
        return (
          <div class="pl-site">
            <div class="hd">
              <div>
                <h3>
                  <a href={`/objekte/${siteId}`}>{list[0]!.site_name}</a>{' '}
                  <span class="mut" style="font-weight:400">
                    {list[0]!.site_no}
                  </span>
                </h3>
                <div class="sub">
                  {site?.customer_name}
                  {addr ? ` · ${addr}` : ''}
                </div>
              </div>
              <div class="rt">
                {rc && rc.total > 0 && (
                  <span class={`pill ${rc.done === rc.total ? 'okp' : 'badp'}`}>
                    letzte 7 Tage: {rc.done} von {rc.total} bestätigt
                  </span>
                )}
              </div>
            </div>
            {groupsOf(list).map((g) => {
              const p = g[0]!;
              const days = new Set(g.map((x) => x.weekday));
              const rec =
                p.recurrence === 'einmalig'
                  ? `einmalig am ${dateDe(p.valid_from)}`
                  : p.recurrence === 'monatlich'
                    ? 'jeden Monat'
                    : (p.every ?? 1) > 1
                      ? `alle ${p.every} Wochen`
                      : 'jede Woche';
              return (
                <div class="pl-row">
                  <div class="pl-days">
                    {WD.map((w, i) => (
                      <span class={days.has(i + 1) ? 'on' : ''}>{w}</span>
                    ))}
                  </div>
                  <div class="pl-time">
                    {p.start_time}–{p.end_time}
                  </div>
                  <div class="pl-h">{hm(minutesOf(p))} Std.</div>
                  <div class="pl-valid">
                    {rec} · {p.recurrence === 'einmalig' ? '' : `ab ${dateDe(p.valid_from)}`}
                    {p.valid_until ? ` bis ${dateDe(p.valid_until)}` : ''}
                    {p.note ? <div>{p.note}</div> : null}
                  </div>
                  <div class="pl-act">
                    {canEdit && (
                      <a
                        class="btn sm sec"
                        href={`/einsatzplanung/${p.id}?zurueck=${encodeURIComponent(ret)}`}
                      >
                        Ändern
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {ended.length > 0 && (
        <details class="card" style="margin-top:6px">
          <summary>Beendete Einsätze ({ended.length})</summary>
          {ended
            .sort((a, b) => (b.valid_until ?? '').localeCompare(a.valid_until ?? ''))
            .slice(0, 50)
            .map((p) => (
              <div class="pl-valid" style="padding:4px 0">
                {WD[p.weekday - 1]} {p.start_time}–{p.end_time} · {p.site_name} · {dateDe(p.valid_from)} –{' '}
                {dateDe(p.valid_until!)}
              </div>
            ))}
        </details>
      )}
    </>
  );
};
