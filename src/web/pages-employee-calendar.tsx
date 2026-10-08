import { Icon } from './icons.js';
import { randomUUID } from 'node:crypto';
import type { Child, FC } from 'hono/jsx';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { type PlannedShift, type TimeEntryRow, clock, hm, netMinutes } from '../services/time.js';
import { dateDe } from './layout.js';
import { type CalView, calRange } from './pages-site-calendar.js';

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
.ec-wrap{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:16px;align-items:start}
.ec-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.ec-bar .seg{display:inline-flex;border:1px solid #cfd4dc;border-radius:6px;overflow:hidden;background:#fff}
.ec-bar .seg a{padding:7px 13px;color:var(--ink);text-decoration:none;border-right:1px solid #cfd4dc;font-size:14px}
.ec-bar .seg a:last-child{border-right:0}.ec-bar .seg a.on{background:#e3e6eb;font-weight:600}
.ec-bar .rng{padding:7px 13px;border:1px solid #cfd4dc;border-radius:6px;background:#fff;font-size:14px;font-variant-numeric:tabular-nums}
.ec{display:grid;border:1px solid #dfe3e8;background:#fff}
.ec .dc{border-right:1px solid #e6e9ed;border-bottom:1px solid #e6e9ed;padding:0 2px 6px;min-height:104px;min-width:0}
.ec .dc .n{display:block;text-align:center;font-weight:700;font-size:13px;padding:5px 0 4px;color:var(--ink);text-decoration:none}
.ec .dc.out{background:#ececec}.ec .dc.out .n{color:#8a8f98}
.ec .dc.today{background:#fff6c7}
.ec .dc.hol .n{background:#c9a54e;color:#fff}.ec .dc .hn{display:block;text-align:center;font-size:11px;color:#fff;background:#c9a54e;font-weight:600;line-height:1.2;padding:0 2px 3px;margin:-4px -2px 3px}
.ec .dc.absd{background:repeating-linear-gradient(135deg,#f3f4f6 0 6px,#fff 6px 12px)}
.ec .dc .ab{display:block;text-align:center;font-size:11px;font-weight:600;color:#5f6b7a;margin-bottom:3px}
.ev{display:flex;align-items:center;gap:4px;padding:3px 6px;margin:0 0 2px;font-size:12.5px;line-height:1.25;text-decoration:none;cursor:pointer;min-width:0;border:1px solid transparent;border-radius:2px}
.ev .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.ev .tm{font-variant-numeric:tabular-nums;opacity:.9}
.ev .ic{flex:none;width:14px;height:14px}
.ev.plan{background:#f6e6ec;color:#7d1435;border-color:#dcb0bf}
.ev.ok{background:#7d1435;color:#fff;border-color:#64102a}
.ev.run{background:#b2456a;color:#fff}
.ev.req{background:#f6c24f;color:#4a3300}
.ev.miss{background:#fff;color:#b42318;border:1px dashed #d9534f}
.ev.abs{background:#d7dbe2;color:#55606f;text-decoration:line-through}
.ev.cx{background:#eceef1;color:#8a8f98;text-decoration:line-through}
.ev.hol{background:#f4ead2;color:#7a5a12}
.ev.extra{background:#2f8f5b;color:#fff}
/* Woche/Tag als Stundenraster */
.eg{display:grid;border:1px solid #dfe3e8;background:#fff;max-height:640px;overflow-y:auto;position:relative}
.eg .gh{position:sticky;top:0;z-index:3;background:#fff;text-align:center;font-weight:700;font-size:14px;padding:8px 2px;border-bottom:1px solid #dfe3e8}
.eg .gh.today{background:#fff6c7}.eg .gh.hol{background:#c9a54e;color:#fff}.eg .gh small{display:block;font-weight:600;font-size:11px}
.eg .hrs{position:relative}
.eg .hr{height:56px;border-bottom:1px solid #e9ecef;font-size:12px;color:#6b7280;padding:2px 6px;background:#f1f3f5}
.eg .hr:nth-child(odd){background:#e9ecef}
.eg .col{position:relative;border-left:1px solid #e6e9ed;background:repeating-linear-gradient(180deg,#f7f8f9 0 56px,#eff1f3 56px 112px)}
.eg .col.absd{background:repeating-linear-gradient(135deg,#f3f4f6 0 6px,#fff 6px 12px)}
.eg .blk{display:block;position:absolute;left:2px;right:2px;overflow:hidden;padding:5px 7px;font-size:13px;line-height:1.3;text-decoration:none;border-radius:2px}
.eg .blk b{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:16px}
.eg .blk.tiny{padding:2px 20px 2px 6px;font-size:11.5px;white-space:nowrap;text-overflow:ellipsis}.eg .blk.tiny b{display:inline;font-size:12px;padding-right:4px}.eg .blk.tiny div{display:none}.eg .blk.tiny .ic{top:3px;width:13px;height:13px}
.eg .blk .ic{position:absolute;right:5px;top:5px;width:16px;height:16px}
/* Seitenleiste wie Fortytools */
.ec-side .box{border-radius:4px;padding:14px 16px;margin-bottom:12px;color:#fff}
.ec-side .box h4{margin:0 0 10px;font-size:15px;font-weight:600;color:#fff}
.ec-side .plan{background:#9b3a57}.ec-side .ist{background:#5a0f26}
.ec-side .row{display:grid;grid-template-columns:1fr auto auto;gap:10px;font-size:13px;padding:2px 0;font-variant-numeric:tabular-nums}
.ec-side .row.sum{border-top:1px solid rgba(255,255,255,.35);margin-top:6px;padding-top:6px;font-weight:700;color:#fff;background:none}
.ec-side .box .btn{width:100%;justify-content:center;background:#fff;color:#5a0f26;border-color:#fff;margin-top:10px;font-size:13px}
.ec-side .cmp{background:#fff;border:1px solid #dfe3e8;border-radius:4px;padding:12px 14px;margin-bottom:12px}
.ec-side .cmp h4{margin:0 0 8px;font-size:14px}
.ec-side .bar{height:12px;border-radius:6px;background:#eef0f3;overflow:hidden;margin:3px 0 8px}
.ec-side .bar i{display:block;height:100%}
.ec-side .lbl{display:flex;justify-content:space-between;font-size:12.5px;color:#4b5563;font-variant-numeric:tabular-nums}
.ec-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin:10px 0 0}
.ec-legend .ev{display:inline-flex;margin:0;cursor:default}
.ec-list td{vertical-align:top}
#ec-dlg{border:0;border-radius:10px;padding:0;width:min(440px,94vw);box-shadow:0 20px 50px rgba(0,0,0,.25)}
#ec-dlg::backdrop{background:rgba(20,24,32,.4)}
#ec-dlg .hd{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}
#ec-dlg .hd h3{margin:2px 0;font-size:18px}#ec-dlg .hd .x{margin-left:auto;border:0;background:none;font-size:24px;cursor:pointer;color:var(--mut)}
#ec-dlg .bd{padding:12px 18px}#ec-dlg .r{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #f0f1f3;font-size:14px}
#ec-dlg .r span{color:var(--mut)}#ec-dlg .ft{padding:12px 18px 16px;display:flex;flex-wrap:wrap;gap:8px}
@media (max-width:980px){.ec-wrap{grid-template-columns:1fr}}
@media (max-width:700px){.ec .dc{min-height:70px}.ev{padding:2px 3px;font-size:10.5px}.ev .tm{display:none}.ec .dc .n{font-size:11.5px}.eg{grid-template-columns:44px repeat(var(--n),minmax(110px,1fr))!important;overflow-x:auto}}
`;

const CLOCK_SVG =
  '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M12 6.5v5.8l3.6 2.1" stroke="#7d1435" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';

const DLG_JS = `(function(){var d=document.getElementById('ec-dlg');if(!d)return;
function esc(t){return String(t||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function row(l,v){return v?'<div class="r"><span>'+l+'</span><b>'+esc(v)+'</b></div>':''}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-ev]');if(!a||e.ctrlKey||e.metaKey)return;e.preventDefault();
var x=JSON.parse(a.getAttribute('data-ev'));var b='';(x.links||[]).forEach(function(l,i){b+='<a class="btn'+(i?' sec':'')+'" href="'+esc(l[1])+'">'+esc(l[0])+'</a>'});
if(x.ok)b='<form method="post" action="'+esc(x.ok)+'" style="margin:0"><input type="hidden" name="mitarbeiter" value="'+esc(x.emp)+'"><input type="hidden" name="von" value="'+esc(x.day)+'"><input type="hidden" name="bis" value="'+esc(x.day)+'"><input type="hidden" name="zurueck" value="'+esc(x.back)+'"><button class="btn">So gearbeitet – bestätigen</button></form>'+b;
if(x.delTime)b+='<form method="post" action="/zeiterfassung/loeschen" style="margin:0" onsubmit="return confirm(\\'Diese erfasste Zeit löschen?\\')"><input type="hidden" name="ids" value="'+esc(x.delTime)+'"><input type="hidden" name="zurueck" value="'+esc(x.back)+'"><button class="btn sec danger">Zeit löschen</button></form>';
if(x.del)b+='<form method="post" action="'+esc(x.del)+'" style="margin:0" onsubmit="return confirm(\\'Diesen Einsatz (die ganze Serie dieses Wochentags) löschen? Erfasste Zeiten bleiben erhalten.\\')"><input type="hidden" name="zurueck" value="'+esc(x.back)+'"><button class="btn sec danger">Einsatz löschen</button></form>';
d.innerHTML='<div class="hd"><div><div class="small mut">'+esc(x.date)+'</div><h3>'+esc(x.site)+'</h3><div class="small">'+esc(x.addr)+'</div><div class="small"><b>'+esc(x.status)+'</b></div></div><button type="button" class="x" aria-label="schließen">×</button></div><div class="bd">'+row('Geplant',x.plan)+row('Pause geplant',x.brk)+row('Erfasst',x.ist)+row('Pause',x.istBrk)+row('Arbeitszeit',x.net)+row('Quelle',x.src)+row('Termin',x.series)+'</div><div class="ft">'+b+'</div>';d.showModal()});
d.addEventListener('click',function(e){if(e.target===d||e.target.classList.contains('x'))d.close()});
var g=document.querySelector('.eg[data-scroll]');if(g)g.scrollTop=Number(g.getAttribute('data-scroll'))||0;})();`;

const dec = (m: number) => `${(m / 60).toFixed(2).replace('.', ',')}h`;
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * Einsatzkalender / Zeiterfassung eines Mitarbeiters im Aufbau von Fortytools (Ahmed 08.10., Screenshots): Monat mit
 * Balken je Einsatz (Uhr = Zeit bestätigt), Woche/5 Tage/Tag als Stundenraster mit Objekt, Zeit, Dauer, Adresse,
 * Liste; rechts „Geplant“ mit „Plan-Zeiten als Ist-Zeiten erfassen“, „Erfasst“ (Einsätze, Krank, Urlaub, Sonstiges)
 * und Soll/Ist als Balken. Wird beim Mitarbeiter, in der Zeiterfassung und unter „Meine Zeiten“ verwendet.
 */
export const EmployeeCalendarView: FC<{
  employeeId: string;
  view: CalView;
  date: string;
  today: string;
  shifts: PlannedShift[];
  extra: TimeEntryRow[];
  absences: EmpCalAbsence[];
  holiday: (d: string) => string | undefined;
  canEdit: boolean;
  /** Adresse je Objekt (für Stundenraster und Details) */
  siteAddr?: Record<string, string>;
  /** Grund-Adresse der Ansicht (ohne Query), Standard: Einsatzkalender beim Mitarbeiter */
  base?: string;
  /** zusätzliche Query-Parameter, die beim Blättern erhalten bleiben (z. B. mitarbeiter=…) */
  keep?: string;
  /** POST-Ziel für „Plan-Zeiten als Ist-Zeiten erfassen“ */
  confirmAction?: string;
  /** links neben den Knöpfen, z. B. Mitarbeiterauswahl */
  head?: Child;
  /** eigene Zeiten (Meine Zeiten): Links führen zum eigenen Formular, kein Planen/Löschen */
  self?: boolean;
  /** erfasste Zeiten direkt löschen (Papierkorb wie Fortytools; Admin/Personal) */
  canDeleteTime?: boolean;
}> = ({
  employeeId,
  view,
  date,
  today,
  shifts,
  extra,
  absences,
  holiday,
  canEdit,
  siteAddr = {},
  base = `/personal/${employeeId}/kalender`,
  keep = '',
  confirmAction,
  head,
  self = false,
  canDeleteTime = false,
}) => {
  const calView = view === 'liste' ? 'monat' : view;
  const r = calRange(calView, date);
  const days: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);
  const q = (v: string, d: string) => `${base}?ansicht=${v}&datum=${d}${keep ? `&${keep}` : ''}`;
  const back = q(view, date);
  const month = date.slice(0, 7);
  const lastDay = days[days.length - 1]!;
  const rangeLabel =
    calView === 'monat'
      ? `${dateDe(`${month}-01`)} – ${dateDe(lastDayOfMonth(month))}`
      : calView === 'tag'
        ? `${WD[isoWeekday(date) - 1]}, ${dateDe(date)}`
        : `${dateDe(r.from)} – ${dateDe(lastDay)}`;
  const absOn = (d: string) => absences.find((a) => a.start_date <= d && a.end_date >= d);
  const inScope = (d: string) => (calView === 'monat' ? d.slice(0, 7) === month : d >= r.from && d <= r.to);
  const scoped = shifts.filter((s) => inScope(s.date) && s.exception?.kind !== 'ausfall');
  const work = scoped.filter((s) => !s.absence && !s.holiday);
  const plannedMin = work.reduce((a, s) => a + s.minutes, 0);
  const done = work.filter((s) => s.entry && !['abgelehnt', 'laeuft', 'beantragt'].includes(s.entry.status));
  const extraIn = extra.filter((e) => inScope(e.work_date) && e.end_at);
  const workedMin =
    done.reduce((a, s) => a + netMinutes(s.entry!), 0) + extraIn.reduce((a, e) => a + netMinutes(e), 0);
  const absMin = (kinds: string[]) =>
    scoped.filter((s) => s.absence && kinds.includes(s.absence)).reduce((a, s) => a + s.minutes, 0);
  const absCount = (kinds: string[]) => scoped.filter((s) => s.absence && kinds.includes(s.absence)).length;
  const krank = absMin(['krank', 'kind_krank']);
  const urlaub = absMin(['urlaub']);
  const sonst = absMin(['sonstiges', 'unbezahlt']);
  const open = work.filter((s) => !s.entry && s.date < today);
  const pastPlanned = work.filter((s) => s.date <= today).reduce((a, s) => a + s.minutes, 0);
  const ist = workedMin + krank + urlaub;
  const max = Math.max(plannedMin, ist, 1);

  const linksFor = (s: PlannedShift) => {
    const e = s.entry;
    const links: [string, string][] = [];
    if (self) {
      if (e) links.push(['Zeit ändern', `/zeiterfassung/meine?id=${e.id}#form`]);
      else if (!s.absence && s.exception?.kind !== 'ausfall' && s.date <= today)
        links.push([
          'Andere Zeit eintragen',
          `/zeiterfassung/meine?datum=${s.date}&objekt=${s.plan.site_id}&von=${s.plan.start_time}&bis=${s.plan.end_time}&pause=${s.plan.break_minutes ?? 0}#form`,
        ]);
      return links;
    }
    if (canEdit) {
      if (e) links.push(['Zeit ansehen / ändern', `/zeiterfassung/${e.id}`]);
      else if (!s.absence && s.exception?.kind !== 'ausfall' && s.date <= today)
        links.push([
          'Zeit erfassen',
          `/zeiterfassung/${randomUUID()}?mitarbeiter=${employeeId}&objekt=${s.plan.site_id}&datum=${s.date}&von=${s.plan.start_time}&bis=${s.plan.end_time}&pause=${s.plan.break_minutes ?? 0}`,
        ]);
      links.push(['Serie bearbeiten', `/einsatzplanung/${s.plan.id}?zurueck=${encodeURIComponent(back)}`]);
      links.push([
        'Nur diesen Tag umplanen',
        `/einsatzplanung/${s.plan.id}/tag/${s.date}?zurueck=${encodeURIComponent(back)}`,
      ]);
    }
    links.push(['Objekt', `/objekte/${s.plan.site_id}`]);
    return links;
  };
  const dataOf = (s: PlannedShift) => {
    const st = stateOf(s, today);
    const e = s.entry;
    return JSON.stringify({
      site: `${s.plan.site_name} (${s.plan.site_no})`,
      addr: siteAddr[s.plan.site_id] ?? '',
      date: `${WD[isoWeekday(s.date) - 1]} ${dateDe(s.date)}`,
      status: st.label,
      plan: `${s.plan.start_time}–${s.plan.end_time} · ${hm(s.minutes)} Std.`,
      brk: s.plan.break_minutes ? `${s.plan.break_minutes} Min.` : '',
      ist: e ? `${clock(e.start_at)}–${e.end_at ? clock(e.end_at) : 'läuft'}` : '',
      istBrk: e ? `${e.break_minutes} Min.` : '',
      net: e?.end_at ? `${hm(netMinutes(e))} Std.` : '',
      src: e ? (SRC[e.source] ?? e.source) : '',
      series:
        s.plan.recurrence === 'einmalig'
          ? 'einmalig'
          : s.plan.recurrence === 'monatlich'
            ? 'jeden Monat'
            : (s.plan.every ?? 1) > 1
              ? `alle ${s.plan.every} Wochen`
              : 'jede Woche',
      links: linksFor(s),
      back,
      ...(canEdit && !self ? { del: `/einsatzplanung/${s.plan.id}/loeschen` } : {}),
      ...(canDeleteTime && e ? { delTime: e.id } : {}),
      ...(confirmAction && !e && !s.absence && s.exception?.kind !== 'ausfall' && s.date <= today
        ? { ok: confirmAction, emp: employeeId, day: s.date }
        : {}),
    });
  };
  const dataOfExtra = (e: TimeEntryRow) =>
    JSON.stringify({
      site: e.site_name,
      addr: siteAddr[e.site_id] ?? '',
      date: `${WD[isoWeekday(e.work_date) - 1]} ${dateDe(e.work_date)}`,
      status: 'ohne Einsatz gearbeitet',
      ist: `${clock(e.start_at)}–${e.end_at ? clock(e.end_at) : 'läuft'}`,
      istBrk: `${e.break_minutes} Min.`,
      net: e.end_at ? `${hm(netMinutes(e))} Std.` : '',
      src: SRC[e.source] ?? e.source,
      links: entryHref(e) !== '#' ? [['Zeit ansehen / ändern', entryHref(e)]] : [],
      back,
      ...(canDeleteTime ? { delTime: e.id } : {}),
    });
  const entryHref = (e: TimeEntryRow) =>
    self ? `/zeiterfassung/meine?id=${e.id}#form` : canEdit ? `/zeiterfassung/${e.id}` : '#';
  const Clock = () => <span style="display:contents" dangerouslySetInnerHTML={{ __html: CLOCK_SVG }} />;
  const Ev = ({ s }: { s: PlannedShift }) => {
    const st = stateOf(s, today);
    return (
      <a
        class={`ev ${st.cls}`}
        href={linksFor(s)[0]?.[1] ?? '#'}
        data-ev={dataOf(s)}
        title={`${s.plan.site_name} · ${s.plan.start_time}–${s.plan.end_time} · ${st.label}`}
      >
        <span class="t">{s.plan.site_name}</span>
        {st.clock && <Clock />}
      </a>
    );
  };
  const dayShifts = (d: string) =>
    shifts.filter((s) => s.date === d).sort((a, b) => a.plan.start_time.localeCompare(b.plan.start_time));

  const MonthCell = ({ d }: { d: string }) => {
    const list = dayShifts(d);
    const ex = extra.filter((e) => e.work_date === d);
    const hol = holiday(d);
    const ab = absOn(d);
    const cls = [
      'dc',
      d.slice(0, 7) !== month ? 'out' : '',
      hol ? 'hol' : '',
      ab ? 'absd' : '',
      d === today ? 'today' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div class={cls}>
        <a class="n" href={q('tag', d)}>
          {WD[isoWeekday(d) - 1]} {Number(d.slice(8))}.{Number(d.slice(5, 7))}.{d.slice(2, 4)}
        </a>
        {hol && <span class="hn">{hol}</span>}
        {ab && (
          <span class="ab">
            {ABSENCE_LABEL[ab.kind as AbsenceKind] ?? 'abwesend'}
            {ab.half_day ? ' (½)' : ''}
          </span>
        )}
        {list.slice(0, 4).map((s) => (
          <Ev s={s} />
        ))}
        {list.length > 4 && (
          <a class="small" href={q('tag', d)} style="display:block;text-align:center">
            + {list.length - 4} weitere
          </a>
        )}
        {ex.map((e) => (
          <a class="ev extra" href={entryHref(e)} data-ev={dataOfExtra(e)} title="ohne Einsatz gearbeitet">
            <span class="t">{e.site_name}</span>
            <Clock />
          </a>
        ))}
      </div>
    );
  };

  // Stundenraster (Woche, 5 Tage, Tag): 44 px je Stunde
  const PX = 56;
  const Grid = () => {
    const firstStart = Math.min(
      ...days.flatMap((d) => dayShifts(d).map((s) => toMin(s.plan.start_time))),
      7 * 60,
    );
    return (
      <div
        class="eg"
        style={`grid-template-columns:52px repeat(${days.length},minmax(0,1fr));--n:${days.length}`}
        data-scroll={String(Math.max(0, Math.floor(firstStart / 60) - 1) * PX)}
      >
        <div class="gh" />
        {days.map((d) => {
          const hol = holiday(d);
          return (
            <a
              class={`gh${d === today ? ' today' : ''}${hol ? ' hol' : ''}`}
              href={q('tag', d)}
              style="text-decoration:none;color:inherit"
            >
              {WD[isoWeekday(d) - 1]} {Number(d.slice(8))}.{Number(d.slice(5, 7))}.{d.slice(2, 4)}
              {hol && <small>{hol}</small>}
              {absOn(d) && <small>{ABSENCE_LABEL[absOn(d)!.kind as AbsenceKind] ?? 'abwesend'}</small>}
            </a>
          );
        })}
        <div class="hrs">
          {Array.from({ length: 24 }, (_, h) => (
            <div class="hr">{String(h).padStart(2, '0')}:00</div>
          ))}
        </div>
        {days.map((d) => {
          const list = dayShifts(d);
          // nebeneinander, wenn sich Einsätze überschneiden
          const lanes: number[] = [];
          const lane = list.map((s) => {
            const st = toMin(s.plan.start_time);
            let i = lanes.findIndex((end) => end <= st);
            if (i < 0) i = lanes.push(0) - 1;
            lanes[i] = toMin(s.plan.end_time) > st ? toMin(s.plan.end_time) : 24 * 60;
            return i;
          });
          const n = Math.max(1, lanes.length);
          return (
            <div class={`col${absOn(d) ? ' absd' : ''}`} style={`height:${24 * PX}px`}>
              {list.map((s, i) => {
                const st = stateOf(s, today);
                const a = toMin(s.plan.start_time);
                const b = toMin(s.plan.end_time) > a ? toMin(s.plan.end_time) : 24 * 60;
                const tiny = ((b - a) / 60) * PX < 44;
                return (
                  <a
                    class={`blk ev ${st.cls}${tiny ? ' tiny' : ''}`}
                    href={linksFor(s)[0]?.[1] ?? '#'}
                    data-ev={dataOf(s)}
                    style={`top:${(a / 60) * PX}px;height:${Math.max(22, ((b - a) / 60) * PX - 2)}px;left:calc(${(lane[i]! / n) * 100}% + 2px);width:calc(${100 / n}% - 4px);right:auto`}
                    title={st.label}
                  >
                    <b>{s.plan.site_name}</b>
                    {s.plan.start_time}–{s.plan.end_time} · {dec(s.minutes)}
                    {siteAddr[s.plan.site_id] && <div>{siteAddr[s.plan.site_id]}</div>}
                    {st.clock && <Clock />}
                  </a>
                );
              })}
              {extra
                .filter((e) => e.work_date === d)
                .map((e) => {
                  const a = toMin(clock(e.start_at));
                  const b = e.end_at ? toMin(clock(e.end_at)) : a + 30;
                  return (
                    <a
                      class="blk ev extra"
                      href={entryHref(e)}
                      data-ev={dataOfExtra(e)}
                      style={`top:${(a / 60) * PX}px;height:${Math.max(22, ((Math.max(b, a + 15) - a) / 60) * PX - 2)}px`}
                    >
                      <b>{e.site_name}</b>
                      ohne Einsatz · {clock(e.start_at)}–{e.end_at ? clock(e.end_at) : 'läuft'}
                    </a>
                  );
                })}
            </div>
          );
        })}
      </div>
    );
  };

  const List = () => {
    const rows = days
      .filter((d) => inScope(d))
      .flatMap((d) => [
        ...dayShifts(d).map((s) => ({ d, s, e: s.entry })),
        ...extra.filter((e) => e.work_date === d).map((e) => ({ d, s: undefined, e })),
      ]);
    return (
      <div class="tbl">
        <table class="ec-list stack-m">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Objekt</th>
              <th>Geplant</th>
              <th>Erfasst</th>
              <th class="r">Pause</th>
              <th class="r">Dauer</th>
              <th>Status</th>
              {canDeleteTime && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colspan={8} class="mut">
                  Keine Einsätze oder Zeiten in diesem Zeitraum.
                </td>
              </tr>
            )}
            {rows.map(({ d, s, e }) => {
              const st = s ? stateOf(s, today) : { cls: 'extra', label: 'ohne Einsatz', clock: true };
              return (
                <tr>
                  <td data-l="Datum">
                    {WD[isoWeekday(d) - 1]} {dateDe(d)}
                  </td>
                  <td data-l="Objekt">{s ? s.plan.site_name : e?.site_name}</td>
                  <td data-l="Geplant">{s ? `${s.plan.start_time}–${s.plan.end_time}` : '–'}</td>
                  <td data-l="Erfasst">
                    {e && e.status !== 'abgelehnt' ? (
                      <a href={entryHref(e)}>
                        {clock(e.start_at)}–{e.end_at ? clock(e.end_at) : 'läuft'}
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td class="r" data-l="Pause">
                    {e ? `${e.break_minutes} Min.` : ''}
                  </td>
                  <td class="r" data-l="Dauer">
                    {e?.end_at ? hm(netMinutes(e)) : s ? <span class="mut">{hm(s.minutes)}</span> : ''}
                  </td>
                  <td data-l="Status">
                    {s ? (
                      <a
                        class={`ev ${st.cls}`}
                        href={linksFor(s)[0]?.[1] ?? '#'}
                        data-ev={dataOf(s)}
                        style="display:inline-flex"
                      >
                        <span class="t">{st.label}</span>
                      </a>
                    ) : (
                      <span class="ev extra" style="display:inline-flex">
                        <span class="t">ohne Einsatz</span>
                      </span>
                    )}
                  </td>
                  {canDeleteTime && (
                    <td>
                      {e && (
                        <form
                          method="post"
                          action="/zeiterfassung/loeschen"
                          style="margin:0"
                          onsubmit="return confirm('Diese erfasste Zeit löschen?')"
                        >
                          <input type="hidden" name="ids" value={e.id} />
                          <input type="hidden" name="zurueck" value={back} />
                          <button class="ic-btn" title="Zeit löschen" aria-label="Zeit löschen">
                            <Icon name="trash" size={15} />
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div class="ec-bar">
        {head}
        <span class="seg">
          <a href={q(view, today)}>
            {calView === 'monat' ? 'Dieser Monat' : calView === 'tag' ? 'Heute' : 'Diese Woche'}
          </a>
        </span>
        <span class="seg">
          <a href={q(view, r.prev)} aria-label="zurück">
            ←
          </a>
          <a href={q(view, r.next)} aria-label="vor">
            →
          </a>
        </span>
        <span class="rng">{rangeLabel}</span>
        <span class="seg">
          {EMP_VIEWS.map(([k, l]) => (
            <a href={q(k, date)} class={k === calView ? 'on' : ''}>
              {l}
            </a>
          ))}
        </span>
        <span class="seg">
          <a href={q(calView, date)} class={view !== 'liste' ? 'on' : ''}>
            Kalender
          </a>
          <a href={q('liste', date)} class={view === 'liste' ? 'on' : ''}>
            Liste
          </a>
        </span>
        {canEdit && !self && (
          <a
            class="btn sm"
            style="margin-left:auto"
            href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${employeeId}&zurueck=${encodeURIComponent(back)}`}
          >
            + Einsatz planen
          </a>
        )}
      </div>
      <div class="ec-wrap">
        <div>
          {view === 'liste' ? (
            <List />
          ) : calView === 'monat' ? (
            <div class="ec" style="grid-template-columns:repeat(7,minmax(0,1fr))">
              {days.map((d) => (
                <MonthCell d={d} />
              ))}
            </div>
          ) : (
            <Grid />
          )}
          <div class="ec-legend">
            <span class="ev plan">geplant</span>
            <span class="ev ok">
              Zeit bestätigt <Clock />
            </span>
            <span class="ev run">läuft</span>
            <span class="ev req">Nachtrag offen</span>
            <span class="ev miss">keine Zeit erfasst</span>
            <span class="ev abs">abwesend</span>
            <span class="ev extra">ohne Einsatz gearbeitet</span>
          </div>
        </div>
        <aside class="ec-side">
          <div class="box plan">
            <h4>Geplant</h4>
            <div class="row">
              <span>{work.length} Einsätze</span>
              <span>{hm(plannedMin)}</span>
              <span>{dec(plannedMin)}</span>
            </div>
            {(canEdit || self) && confirmAction && (
              <form
                method="post"
                action={confirmAction}
                onsubmit={`return ${open.length ? `confirm('Für ${open.length} vergangene Einsätze ohne Zeit die geplanten Zeiten als Ist-Zeiten eintragen?')` : "(alert('Keine vergangenen Einsätze ohne Zeit.'),false)"}`}
              >
                <input type="hidden" name="mitarbeiter" value={employeeId} />
                <input type="hidden" name="von" value={calView === 'monat' ? `${month}-01` : r.from} />
                <input
                  type="hidden"
                  name="bis"
                  value={calView === 'monat' ? lastDayOfMonth(month) : lastDay}
                />
                <input type="hidden" name="zurueck" value={back} />
                <button class="btn">
                  Plan-Zeiten als Ist-Zeiten erfassen{open.length ? ` (${open.length})` : ''}
                </button>
              </form>
            )}
          </div>
          <div class="box ist">
            <h4>Erfasst</h4>
            <div class="row">
              <span>{done.length + extraIn.length} Einsätze</span>
              <span>{hm(workedMin)}</span>
              <span>{dec(workedMin)}</span>
            </div>
            <div class="row">
              <span>{absCount(['krank', 'kind_krank'])} Krank</span>
              <span>{hm(krank)}</span>
              <span>{dec(krank)}</span>
            </div>
            <div class="row">
              <span>{absCount(['urlaub'])} Urlaub</span>
              <span>{hm(urlaub)}</span>
              <span>{dec(urlaub)}</span>
            </div>
            <div class="row">
              <span>{absCount(['sonstiges', 'unbezahlt'])} Sonstiges</span>
              <span>{hm(sonst)}</span>
              <span>{dec(sonst)}</span>
            </div>
            <div class="row sum">
              <span>Gesamt</span>
              <span>{hm(ist + sonst)}</span>
              <span>{dec(ist + sonst)}</span>
            </div>
          </div>
          <div class="cmp">
            <h4>Soll / Ist</h4>
            <div class="lbl">
              <span>Soll (geplant)</span>
              <b>{hm(plannedMin)} Std.</b>
            </div>
            <div class="bar">
              <i style={`width:${(plannedMin / max) * 100}%;background:#9b3a57`} />
            </div>
            <div class="lbl">
              <span>Ist (gearbeitet + Urlaub/Krank)</span>
              <b>{hm(ist)} Std.</b>
            </div>
            <div class="bar">
              <i
                style={`width:${(ist / max) * 100}%;background:${ist >= pastPlanned ? '#2f8f5b' : '#d97706'}`}
              />
            </div>
            <div class="lbl">
              <span>bis heute geplant</span>
              <b>{hm(pastPlanned)} Std.</b>
            </div>
            <div class="lbl" style="margin-top:4px">
              <span>Differenz bis heute</span>
              <b style={`color:${ist - pastPlanned < 0 ? '#b42318' : '#1d6b35'}`}>
                {ist - pastPlanned < 0 ? '−' : '+'}
                {hm(Math.abs(ist - pastPlanned))} Std.
              </b>
            </div>
            {open.length > 0 && (
              <div class="lbl" style="margin-top:6px;color:#b42318">
                <span>{open.length} vergangene Einsätze ohne Zeit</span>
              </div>
            )}
          </div>
        </aside>
      </div>
      <dialog id="ec-dlg" />
      <script dangerouslySetInnerHTML={{ __html: DLG_JS }} />
    </>
  );
};

const DLG_CSS = CSS.slice(CSS.indexOf('#ec-dlg{'), CSS.indexOf('@media (max-width:980px)'));
/** Detailfenster für Einsätze (auch im Objekt-Kalender): Links mit data-ev öffnen es. */
export const EventDialog: FC = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: DLG_CSS }} />
    <dialog id="ec-dlg" />
    <script dangerouslySetInnerHTML={{ __html: DLG_JS }} />
  </>
);

const SRC: Record<string, string> = {
  stempel: 'Stempeluhr',
  soll_bestaetigt: 'Soll bestätigt',
  nachtrag: 'Nachtrag',
  buero: 'Büro',
};

const lastDayOfMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
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
                    {canEdit && (
                      <form
                        method="post"
                        action="/einsatzplanung/loeschen"
                        style="display:inline"
                        onsubmit="return confirm('Diese Einsätze löschen? Schon erfasste Zeiten bleiben erhalten.')"
                      >
                        {g.map((x) => (
                          <input type="hidden" name="ids" value={x.id} />
                        ))}
                        <input type="hidden" name="zurueck" value={ret} />
                        <button class="btn sm sec">Löschen</button>
                      </form>
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
