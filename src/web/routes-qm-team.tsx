import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import {
  ABSENCE_LABEL,
  ABSENCE_STATUS_LABEL,
  type AbsenceKind,
  requestAbsence,
} from '../services/absences.js';
import { BusinessError } from '../services/errors.js';
import { WEEKDAYS_SHORT, clock, decideCorrection, hm, listEntries, plannedShifts } from '../services/time.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { dateDe } from './layout.js';
import { Ic } from './m/icons.js';
import { QmLayout } from './routes-qm.js';

/*
 * App für Objektleitung & Büro – eigene Handy-Seiten, damit man in der App bleibt (Ahmed 07.10.):
 * Team (Kontakt, Einsätze, Abwesenheiten), Urlaub/Krank für andere eintragen, Zeiten heute mit Nachträgen.
 * Objektleitung sieht nur Mitarbeitende ihrer Objekte.
 */

const CSS = `
.tm-search{display:flex;gap:8px;margin:6px 0 12px}.tm-search input{flex:1;font:inherit;font-size:16px;padding:12px 14px;border:1px solid #e3d6db;border-radius:14px;background:#fff}
.tm-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#fff;border:1px solid #efe3e7;border-radius:14px;margin-bottom:8px;color:#2a1420;text-decoration:none}
.tm-row .av{width:40px;height:40px;border-radius:50%;background:#f6dfe7;color:#7d1435;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
.tm-row .t{flex:1;min-width:0}.tm-row .t b{display:block}.tm-row .t small{color:#8a7a80}
.tm-pill{flex:none;align-self:center;font-size:12px;padding:3px 9px;border-radius:999px;background:#eee;color:#444;white-space:nowrap}
.tm-pill.ok{background:#e3f4e8;color:#1d6b35}.tm-pill.warn{background:#fff1d6;color:#8a5a00}.tm-pill.bad{background:#fde3e3;color:#a11d1d}.tm-pill.run{background:#e4eefc;color:#1f4f99}
.tm-card{background:#fff;border:1px solid #efe3e7;border-radius:16px;padding:14px;margin-bottom:12px}
.tm-card h2{font-size:16px;margin:0 0 8px}
.tm-acts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:12px 0}
.tm-acts a,.tm-acts button{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;border-radius:14px;background:#fff;border:1px solid #efe3e7;color:#7d1435;font:inherit;font-weight:600;text-decoration:none}
.tm-acts a svg,.tm-acts button svg{width:20px;height:20px}
.tm-form{display:flex;flex-direction:column;gap:10px}.tm-form label{font-weight:600}
.tm-form input,.tm-form select,.tm-form textarea{font:inherit;font-size:16px;padding:12px;border:1px solid #e3d6db;border-radius:12px;background:#fff}
.tm-kinds{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.tm-kinds label{display:flex;align-items:center;gap:8px;padding:12px;border:1px solid #e3d6db;border-radius:12px;background:#fff;font-weight:600}
.tm-kinds input{width:20px;height:20px}
.tm-li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f3e9ec}.tm-li:last-child{border-bottom:0}
.tm-li small{color:#8a7a80}
.tm-btns{display:flex;gap:8px;margin-top:8px}.tm-btns button{flex:1;padding:10px;border-radius:12px;border:1px solid #e3d6db;background:#fff;font:inherit;font-weight:600}
.tm-btns .yes{background:#1d6b35;color:#fff;border-color:#1d6b35}
.btn-big{font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff;width:100%}
`;

const initials = (n: string) =>
  n
    .split(/[ ,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** Handynummer → WhatsApp-Link (0176… → 49176…). */
const waLink = (phone: string) => {
  let d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `49${d.slice(1)}`;
  return d.length >= 8 ? `https://wa.me/${d}` : null;
};

interface TeamRow {
  id: string;
  personnel_no: string;
  name: string;
  mobile: string | null;
  phone: string | null;
  employment_type: string | null;
  absence: string | null;
  running: string | null;
}

export function registerQmTeamRoutes({ app, deps }: Ctx) {
  const { sql } = deps;
  const render = (c: Context<AppEnv>, title: string, body: Child) =>
    c.html(
      '<!doctype html>' +
        String(
          <QmLayout
            path={c.req.path}
            title={title}
            flash={{ ok: c.req.query('ok') ?? '', err: c.req.query('fehler') ?? '' }}
          >
            <style dangerouslySetInnerHTML={{ __html: CSS }} />
            {body}
          </QmLayout>,
        ),
    );
  const Top = ({ title, href = '/qm' }: { title: string; href?: string }) => (
    <div class="qm-top">
      <a href={href} aria-label="zurück">
        <Ic n="back" />
      </a>
      <h1>{title}</h1>
      <span style="width:36px" />
    </div>
  );
  const role = (c: Context<AppEnv>) => c.get('user').role;
  /** Gesundheitsdaten (Art der Abwesenheit) nur Personal, Admin und die zuständige Objektleitung */
  const seesKind = (c: Context<AppEnv>) => role(c) !== 'buchhaltung';
  const mayEnterAbsence = (c: Context<AppEnv>) => ['admin', 'personal', 'objektleitung'].includes(role(c));

  const team = async (c: Context<AppEnv>, q = '', id?: string) => {
    const scope = c.get('sites');
    const today = todayBerlin();
    const like = `%${q.trim()}%`;
    return sql<TeamRow[]>`
      select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, e.mobile, e.phone,
             e.employment_type::text as employment_type,
             (select a.kind::text from app.absences a where a.employee_id = e.id and a.status = 'genehmigt'
                 and ${today}::date between a.start_date and a.end_date limit 1) as absence,
             (select s.name from app.time_entries t join app.sites s on s.id = t.site_id
               where t.employee_id = e.id and t.end_at is null and t.status <> 'abgelehnt' limit 1) as running
        from app.employees e
       where e.status = 'aktiv'
         and ${id ? sql`e.id = ${id}` : sql`true`}
         and ${q.trim() ? sql`(e.first_name || ' ' || e.last_name || ' ' || e.personnel_no) ilike ${like}` : sql`true`}
         and ${
           scope === null
             ? sql`true`
             : scope.length === 0
               ? sql`false`
               : sql`(exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id in ${sql(scope)})
                      or exists (select 1 from app.shift_plans p where p.employee_id = e.id and p.site_id in ${sql(scope)}
                                  and (p.valid_until is null or p.valid_until >= ${today})))`
         }
       order by e.last_name, e.first_name`;
  };
  const loadMember = async (c: Context<AppEnv>, id: string) => {
    const [m] = await team(c, '', id);
    if (!m) throw new BusinessError('Mitarbeiter nicht gefunden oder nicht in Ihren Objekten');
    return m;
  };

  const Status = ({ m, kind }: { m: TeamRow; kind: boolean }) =>
    m.absence ? (
      <span class="tm-pill warn">
        {kind ? (ABSENCE_LABEL[m.absence as AbsenceKind] ?? 'abwesend') : 'abwesend'}
      </span>
    ) : m.running ? (
      <span class="tm-pill run">im Einsatz</span>
    ) : null;

  // ------------------------------------------------------------------ Team
  app.get('/qm/team', async (c) => {
    const q = c.req.query('q') ?? '';
    const list = await team(c, q);
    const kind = seesKind(c);
    return render(
      c,
      'Team',
      <>
        <Top title="Team" />
        <form method="get" class="tm-search">
          <input name="q" value={q} placeholder="Name oder Personalnummer …" aria-label="Suche" />
        </form>
        {mayEnterAbsence(c) && (
          <div class="tm-acts" style="grid-template-columns:1fr">
            <a href="/qm/abwesenheit/neu">
              <Ic n="sun" /> Urlaub / Krankheit eintragen
            </a>
          </div>
        )}
        {list.length === 0 && <div class="qm-empty">Keine Mitarbeitenden gefunden.</div>}
        {list.map((m) => (
          <a class="tm-row" href={`/qm/team/${m.id}`}>
            <span class="av">{initials(m.name)}</span>
            <span class="t">
              <b>{m.name}</b>
              <small>
                Nr. {m.personnel_no}
                {m.running ? ` · ${m.running}` : ''}
              </small>
            </span>
            <Status m={m} kind={kind} />
          </a>
        ))}
      </>,
    );
  });

  app.get(`/qm/team/:id{${UUID}}`, async (c) => {
    const [m] = await team(c, '', c.req.param('id'));
    if (!m)
      return render(
        c,
        'Mitarbeiter',
        <>
          <Top title="Mitarbeiter" href="/qm/team" />
          <div class="qm-empty">Mitarbeiter nicht gefunden oder nicht in Ihren Objekten.</div>
        </>,
      );
    const today = todayBerlin();
    const scope = c.get('sites');
    const [plans, absences, sites] = await Promise.all([
      sql<{ weekday: number; start_time: string; end_time: string; site_name: string; site_id: string }[]>`
        select p.weekday, to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time,
               s.name as site_name, s.id as site_id
          from app.shift_plans p join app.sites s on s.id = p.site_id
         where p.employee_id = ${m.id} and p.valid_from <= ${addDays(today, 14)}
           and (p.valid_until is null or p.valid_until >= ${today})
         order by p.weekday, p.start_time`,
      sql<{ kind: string; status: string; start_date: string; end_date: string; half_day: boolean }[]>`
        select kind::text, status::text, start_date::text, end_date::text, half_day from app.absences
         where employee_id = ${m.id} and status in ('beantragt', 'genehmigt') and end_date >= ${today}
         order by start_date limit 10`,
      sql<{ id: string; name: string; site_no: string }[]>`
        select s.id, s.name, s.site_no from app.employee_sites es join app.sites s on s.id = es.site_id
         where es.employee_id = ${m.id} and s.active order by s.name`,
    ]);
    const visiblePlans = plans.filter((p) => scope === null || scope.includes(p.site_id));
    const kind = seesKind(c);
    const tel = m.mobile || m.phone;
    const wa = m.mobile ? waLink(m.mobile) : null;
    const hr = ['admin', 'personal'].includes(role(c));
    return render(
      c,
      m.name,
      <>
        <Top title="Mitarbeiter" href="/qm/team" />
        <div class="tm-card" style="display:flex;gap:12px;align-items:center">
          <span class="tm-row" style="border:0;padding:0;margin:0">
            <span class="av">{initials(m.name)}</span>
          </span>
          <div style="flex:1">
            <b style="font-size:18px">{m.name}</b>
            <div class="mut">Personalnr. {m.personnel_no}</div>
          </div>
          <Status m={m} kind={kind} />
        </div>
        <div class="tm-acts">
          {tel && (
            <a href={`tel:${tel.replace(/[^\d+]/g, '')}`}>
              <Ic n="phone" /> Anrufen
            </a>
          )}
          {wa && (
            <a href={wa}>
              <Ic n="doc" /> WhatsApp
            </a>
          )}
          {mayEnterAbsence(c) && (
            <a href={`/qm/abwesenheit/neu?ma=${m.id}`}>
              <Ic n="sun" /> Urlaub / Krank
            </a>
          )}
          {hr && (
            <a href={`/personal/${m.id}/dokumente`}>
              <Ic n="doc" /> Dokumente
            </a>
          )}
          {hr && (
            <a href={`/personal/${m.id}/uebergaben`}>
              <Ic n="list" /> Übergaben
            </a>
          )}
          {hr && (
            <a href={`/personal/${m.id}`}>
              <Ic n="monitor" /> Stammdaten
            </a>
          )}
        </div>
        <div class="tm-card">
          <h2>Einsätze</h2>
          {visiblePlans.length === 0 && <div class="mut">Keine laufenden Einsätze.</div>}
          {visiblePlans.map((p) => (
            <div class="tm-li">
              <span>
                <b>{WEEKDAYS_SHORT[p.weekday]}</b> {p.start_time}–{p.end_time}
              </span>
              <small>{p.site_name}</small>
            </div>
          ))}
        </div>
        <div class="tm-card">
          <h2>Abwesenheiten</h2>
          {absences.length === 0 && <div class="mut">Keine eingetragen.</div>}
          {absences.map((a) => (
            <div class="tm-li">
              <span>
                {dateDe(a.start_date)}
                {a.end_date !== a.start_date ? ` – ${dateDe(a.end_date)}` : ''}
                {a.half_day ? ' (½ Tag)' : ''}
              </span>
              <small>
                {kind ? ABSENCE_LABEL[a.kind as AbsenceKind] : 'abwesend'} ·{' '}
                {ABSENCE_STATUS_LABEL[a.status as keyof typeof ABSENCE_STATUS_LABEL]}
              </small>
            </div>
          ))}
        </div>
        {sites.length > 0 && (
          <div class="tm-card">
            <h2>Objekte</h2>
            {sites.map((s) => (
              <div class="tm-li">
                <a href={`/qm/objekt/${s.id}`}>{s.name}</a>
                <small>{s.site_no}</small>
              </div>
            ))}
          </div>
        )}
      </>,
    );
  });

  // ------------------------------------------------------------------ Urlaub / Krank eintragen
  app.get('/qm/abwesenheit/neu', async (c) => {
    if (!mayEnterAbsence(c)) throw new BusinessError('Keine Berechtigung');
    const list = await team(c);
    const pre = c.req.query('ma') ?? '';
    const today = todayBerlin();
    const ol = role(c) === 'objektleitung';
    return render(
      c,
      'Urlaub / Krank eintragen',
      <>
        <Top title="Abwesenheit eintragen" href={pre ? `/qm/team/${pre}` : '/qm/team'} />
        <form method="post" action="/qm/abwesenheit" class="tm-form">
          <input type="hidden" name="id" value={randomUUID()} />
          <label for="ma">Mitarbeiter</label>
          <select id="ma" name="employee_id" required>
            <option value="">– bitte wählen –</option>
            {list.map((m) => (
              <option value={m.id} selected={m.id === pre}>
                {m.name} ({m.personnel_no})
              </option>
            ))}
          </select>
          <label>Art</label>
          <div class="tm-kinds">
            {(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k, i) => (
              <label>
                <input type="radio" name="kind" value={k} required checked={i === 1} /> {ABSENCE_LABEL[k]}
              </label>
            ))}
          </div>
          <label for="von">von</label>
          <input id="von" name="start" type="date" value={today} required />
          <label for="bis">bis</label>
          <input id="bis" name="end" type="date" value={today} required />
          <label style="display:flex;gap:8px;align-items:center;font-weight:400">
            <input type="checkbox" name="half_day" value="1" style="width:20px;height:20px" /> nur halber Tag
          </label>
          <label for="note">Notiz (ohne Diagnose)</label>
          <textarea id="note" name="note" rows={2} />
          {ol && (
            <p class="small mut" style="margin:0">
              Krankheit wird sofort eingetragen. Urlaub und sonstige Abwesenheiten gehen als Antrag ans Büro.
            </p>
          )}
          <button class="btn-big">Eintragen</button>
        </form>
      </>,
    );
  });

  app.post('/qm/abwesenheit', async (c) => {
    if (!mayEnterAbsence(c)) throw new BusinessError('Keine Berechtigung');
    const b = (await c.req.parseBody()) as Record<string, string>;
    const id = /^[0-9a-f-]{36}$/.test(b.id ?? '') ? b.id! : randomUUID();
    const m = await loadMember(c, str(b, 'employee_id') ?? '');
    const kind = (str(b, 'kind') ?? '') as AbsenceKind;
    if (!(kind in ABSENCE_LABEL)) throw new BusinessError('Bitte Art wählen');
    const start = str(b, 'start') ?? '';
    const end = str(b, 'end') ?? start;
    // Krankheit trägt die Objektleitung direkt ein; Urlaub & Co. genehmigt das Büro (Personal/Admin direkt)
    const approved = role(c) !== 'objektleitung' || kind === 'krank' || kind === 'kind_krank';
    await requestAbsence(sql, {
      id,
      employeeId: m.id,
      kind,
      start,
      end,
      halfDay: b.half_day === '1',
      note: str(b, 'note') ?? null,
      actor: c.get('actor'),
      approved,
    });
    return c.redirect(
      `/qm/team/${m.id}?ok=${encodeURIComponent(
        approved
          ? `${ABSENCE_LABEL[kind]} eingetragen.`
          : `${ABSENCE_LABEL[kind]} beantragt – das Büro genehmigt.`,
      )}`,
      303,
    );
  });

  // ------------------------------------------------------------------ Zeiten heute
  app.get('/qm/zeiten', async (c) => {
    const scope = c.get('sites');
    const inScope = (siteId: string) => scope === null || scope.includes(siteId);
    const today = todayBerlin();
    const [shifts, entries, pending] = await Promise.all([
      plannedShifts(sql, { from: today, to: today }),
      listEntries(sql, { from: today, to: today }),
      listEntries(sql, { status: ['beantragt'] }),
    ]);
    const now = new Date();
    const nowHm = clock(now);
    const planned = shifts.filter((s) => inScope(s.plan.site_id) && s.exception?.kind !== 'ausfall');
    const usedEntries = new Set(planned.map((s) => s.entry?.id).filter(Boolean));
    const extra = entries.filter(
      (e) => inScope(e.site_id) && !usedEntries.has(e.id) && e.status !== 'abgelehnt',
    );
    const open = pending.filter((e) => inScope(e.site_id));
    const state = (s: (typeof planned)[number]) => {
      if (s.absence) return <span class="tm-pill warn">abwesend</span>;
      if (s.entry && !s.entry.end_at) return <span class="tm-pill run">seit {clock(s.entry.start_at)}</span>;
      if (s.entry) return <span class="tm-pill ok">erledigt</span>;
      if (s.plan.start_time <= nowHm) return <span class="tm-pill bad">nicht gestempelt</span>;
      return <span class="tm-pill">geplant</span>;
    };
    return render(
      c,
      'Zeiten heute',
      <>
        <Top title={`Zeiten heute · ${dateDe(today)}`} />
        {open.length > 0 && (
          <div class="tm-card">
            <h2>Nachträge freigeben ({open.length})</h2>
            {open.map((e) => (
              <form method="post" action={`/qm/zeiten/${e.id}`} class="tm-li" style="display:block">
                <div style="display:flex;justify-content:space-between;gap:8px">
                  <b>{e.employee_name}</b>
                  <small>{dateDe(e.work_date)}</small>
                </div>
                <small>
                  {e.site_name} · {clock(e.start_at)}–{e.end_at ? clock(e.end_at) : '…'} · Pause{' '}
                  {e.break_minutes} Min.
                  {e.note ? ` · „${e.note}“` : ''}
                </small>
                <div class="tm-btns">
                  <button name="ok" value="1" class="yes">
                    Freigeben
                  </button>
                  <button
                    name="ok"
                    value="0"
                    onclick="var r=prompt('Grund der Ablehnung');if(!r)return false;this.form.reason.value=r"
                  >
                    Ablehnen
                  </button>
                </div>
                <input type="hidden" name="reason" value="" />
              </form>
            ))}
          </div>
        )}
        <div class="tm-card">
          <h2>Einsätze heute ({planned.length})</h2>
          {planned.length === 0 && <div class="mut">Heute keine geplanten Einsätze.</div>}
          {planned
            .sort((a, b) => a.plan.start_time.localeCompare(b.plan.start_time))
            .map((s) => (
              <div class="tm-li">
                <span>
                  <b>{s.plan.employee_name}</b>
                  <br />
                  <small>
                    {s.plan.start_time}–{s.plan.end_time} · {s.plan.site_name}
                  </small>
                </span>
                {state(s)}
              </div>
            ))}
        </div>
        {extra.length > 0 && (
          <div class="tm-card">
            <h2>Ohne Einsatz gestempelt</h2>
            {extra.map((e) => (
              <div class="tm-li">
                <span>
                  <b>{e.employee_name}</b>
                  <br />
                  <small>
                    {e.site_name} · {clock(e.start_at)}–{e.end_at ? clock(e.end_at) : 'läuft'}
                  </small>
                </span>
                <small>{e.end_at ? hm(Math.max(0, e.gross_minutes - e.break_minutes)) : ''}</small>
              </div>
            ))}
          </div>
        )}
        <div class="tm-acts" style="grid-template-columns:1fr">
          <a href="/zeiterfassung">
            <Ic n="list" /> Alle Zeiten (Zeitraum, Korrektur)
          </a>
        </div>
      </>,
    );
  });

  app.post(`/qm/zeiten/:id{${UUID}}`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    const [e] = await listEntries(sql, { status: ['beantragt'] }).then((l) =>
      l.filter((x) => x.id === c.req.param('id')),
    );
    if (!e) return c.redirect('/qm/zeiten?ok=Bereits%20entschieden.', 303);
    const scope = c.get('sites');
    if (scope !== null && !scope.includes(e.site_id)) throw new BusinessError('Nicht Ihr Objekt');
    const approve = b.ok === '1';
    await decideCorrection(sql, e.id, approve, c.get('actor'), approve ? null : (b.reason ?? '').trim());
    return c.redirect(`/qm/zeiten?ok=${encodeURIComponent(approve ? 'Freigegeben.' : 'Abgelehnt.')}`, 303);
  });
}
