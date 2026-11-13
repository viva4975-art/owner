import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { ABSENCE_LABEL, listAbsences, plannedAtSites } from '../services/absences.js';
import { listTasks, type Task } from '../services/crm.js';
import { hrReminders, permitWarningsForSites } from '../services/employees.js';
import { listTickets } from '../services/qm.js';
import { expiringQualifications } from '../services/qualifications.js';
import { timeAnomalies } from '../services/time-anomalies.js';
import type { AppEnv, Ctx } from './app.js';
import { taskViewerOf } from './app.js';
import { Icon } from './icons.js';
import { PageHead, dateDe } from './layout.js';
import { taskHref } from './pages-crm.js';
import { canAccess } from './permissions.js';

/*
 * Eingang (Ahmed 13.11., Vorbild Blink „Tickets“): alles, was jemand erledigen muss, in einer Liste – Urlaubsanträge,
 * Nachträge zur Zeiterfassung, Tickets/Reklamationen, Aufgaben (inkl. Fotos prüfen, Gerät defekt, NU-Freigabe),
 * neue Personalbögen, ablaufende Aufenthaltstitel, auffällige Zeiten. Nur Lesen und Weiterleiten auf die
 * vorhandenen Seiten; gespeichert wird dort wie bisher. Objektleitung: nur ihre Objekte bzw. ihre Leute.
 */

export type InboxKind = 'antrag' | 'nachtrag' | 'ticket' | 'aufgabe' | 'personal';
export const INBOX_KIND: Record<InboxKind, { label: string; icon: string; tone: string }> = {
  antrag: { label: 'Urlaub & Abwesenheit', icon: 'sun', tone: 'g' },
  nachtrag: { label: 'Zeiterfassung', icon: 'clock', tone: 'y' },
  ticket: { label: 'Reklamation / Ticket', icon: 'msg', tone: 'b' },
  aufgabe: { label: 'Aufgabe', icon: 'check2', tone: 'n' },
  personal: { label: 'Personal', icon: 'users', tone: 'r' },
};

export interface InboxItem {
  key: string;
  kind: InboxKind;
  /** Datum der Meldung (für Sortierung/Anzeige) */
  date: string;
  title: string;
  sub?: string | undefined;
  tags: { t: string; tone?: 'err' | 'warn' | undefined }[];
  href: string;
  status: 'neu' | 'in Arbeit';
  due?: string | null | undefined;
  who?: string | null | undefined;
  /** kleine Knöpfe direkt in der Zeile (z. B. Genehmigen) */
  actions?: Child;
}

const iso = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function inboxItems(deps: Ctx['deps'], c: Context<AppEnv>): Promise<InboxItem[]> {
  const { sql } = deps;
  const role = c.get('user').role;
  const sites = c.get('sites');
  const ol = role === 'objektleitung';
  const today = todayBerlin();
  const may = (p: string) => canAccess(role, p);
  const quals = may('/personal') ? await expiringQualifications(sql) : [];
  const [leave, requests, tickets, tasks, forms, permits, odd] = await Promise.all([
    may('/urlaub') ? listAbsences(sql, { status: ['beantragt'] }) : Promise.resolve([]),
    may('/zeiterfassung') && (!sites || sites.length)
      ? sql<
          {
            id: string;
            employee_name: string;
            site_name: string | null;
            start_at: Date;
            end_at: Date | null;
            recorded_at: Date;
          }[]
        >`
          select t.id, e.first_name || ' ' || e.last_name as employee_name, s.name as site_name,
                 t.start_at, t.end_at, coalesce(t.recorded_at, t.start_at) as recorded_at
            from app.time_entries t join app.employees e on e.id = t.employee_id
            left join app.sites s on s.id = t.site_id
           where t.status = 'beantragt' and ${sites ? sql`t.site_id = any(${sites}::uuid[])` : sql`true`}
           order by t.start_at`
      : Promise.resolve([]),
    may('/qm/tickets') ? listTickets(sql, { siteIds: sites, status: 'offen' }) : Promise.resolve([]),
    may('/aufgaben')
      ? listTasks(sql, { status: 'open', onlyFor: ol ? taskViewerOf(c) : undefined })
      : Promise.resolve([] as Task[]),
    may('/personal/personalboegen')
      ? sql<{ id: string; name: string; created_at: Date; site_name: string | null }[]>`
          select f.id, trim(coalesce(f.data->>'first_name', '') || ' ' || coalesce(f.data->>'last_name', '')) as name,
                 f.created_at, s.name as site_name
            from app.personnel_forms f left join app.sites s on s.id = f.site_id
           where f.status = 'neu' order by f.created_at`
      : Promise.resolve([]),
    ol
      ? permitWarningsForSites(sql, sites ?? [], 42)
      : may('/personal')
        ? hrReminders(sql).then((h) =>
            h.permits.map((p) => ({
              id: p.id,
              name: p.name,
              kind: (p as { kind?: string }).kind ?? 'Aufenthaltstitel',
              until: p.residence_permit_until as string | null,
              sites: [] as string[],
            })),
          )
        : Promise.resolve([]),
    may('/zeiterfassung/auffaellig')
      ? timeAnomalies(sql, ol ? { managerUserId: c.get('user').id } : {})
      : Promise.resolve([]),
  ]);

  // Objektleitung: Anträge nur von Leuten, die im Zeitraum an ihren Objekten eingeplant sind
  let leaveRows = leave;
  if (sites && leave.length) {
    if (!sites.length) leaveRows = [];
    else {
      const ok = await sql<{ id: string }[]>`
        select a.id from app.absences a where a.id = any(${leave.map((r) => r.id)}::uuid[])
           and ${plannedAtSites(sql, sql`a.employee_id`, sites, sql`a.start_date`, sql`a.end_date`)}`;
      const set = new Set(ok.map((r) => r.id));
      leaveRows = leave.filter((r) => set.has(r.id));
    }
  }

  const items: InboxItem[] = [];
  for (const a of leaveRows) {
    items.push({
      key: `a:${a.id}`,
      kind: 'antrag',
      date: a.applied_on ?? a.start_date,
      title: `${ABSENCE_LABEL[a.kind] ?? a.kind}: ${a.employee_name}`,
      sub: `${dateDe(a.start_date)}${a.end_date !== a.start_date ? ` – ${dateDe(a.end_date)}` : ''} · ${String(a.days).replace('.', ',')} ${a.days === 1 ? 'Arbeitstag' : 'Arbeitstage'}${a.note ? ` · ${a.note}` : ''}`,
      tags: [],
      href: `/urlaub/person/${a.employee_id}`,
      status: 'neu',
      actions: (
        <>
          <form method="post" action={`/urlaub/${a.id}/status`}>
            <input type="hidden" name="status" value="genehmigt" />
            <button class="btn sm">Genehmigen</button>
          </form>
          <form method="post" action={`/urlaub/${a.id}/status`}>
            <input type="hidden" name="status" value="abgelehnt" />
            <button class="btn sm sec" data-confirm={`Antrag von ${a.employee_name} ablehnen?`}>
              Ablehnen
            </button>
          </form>
        </>
      ),
    });
  }
  const hm = (d: Date) =>
    d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  for (const r of requests) {
    items.push({
      key: `n:${r.id}`,
      kind: 'nachtrag',
      date: iso(r.recorded_at),
      title: `Nachtrag: ${r.employee_name}`,
      sub: `${dateDe(iso(r.start_at))} · ${hm(r.start_at)}–${r.end_at ? hm(r.end_at) : '…'}${r.site_name ? ` · ${r.site_name}` : ''}`,
      tags: [],
      href: `/zeiterfassung/${r.id}`,
      status: 'neu',
    });
  }
  for (const t of tickets) {
    items.push({
      key: `t:${t.id}`,
      kind: 'ticket',
      date: iso(t.created_at),
      title: t.title,
      sub: [t.number, `${t.site_name} (${t.site_no})`, t.room_label].filter(Boolean).join(' · '),
      tags: t.priority === 'hoch' ? [{ t: 'hohe Priorität', tone: 'err' }] : [],
      href: `/qm/tickets?objekt=${t.site_id}`,
      status: t.status === 'in_arbeit' ? 'in Arbeit' : 'neu',
    });
  }
  for (const t of tasks) {
    const over = !!t.due_date && t.due_date < today;
    items.push({
      key: `k:${t.id}`,
      kind: 'aufgabe',
      date: iso(t.created_at),
      title: t.title,
      sub: t.entity_label ?? undefined,
      tags: over
        ? [{ t: 'überfällig', tone: 'err' }]
        : t.due_date === today
          ? [{ t: 'heute', tone: 'warn' }]
          : [],
      href: taskHref(t),
      status: 'neu',
      due: t.due_date,
      who: t.assignee,
      actions: (
        <form method="post" action={`/aufgaben/${t.id}/erledigt`}>
          <input type="hidden" name="done" value="1" />
          <input type="hidden" name="back" value="/eingang" />
          <button class="btn sm sec" title="Als erledigt markieren">
            <Icon name="check" size={14} /> erledigt
          </button>
        </form>
      ),
    });
  }
  for (const f of forms) {
    items.push({
      key: `f:${f.id}`,
      kind: 'personal',
      date: iso(f.created_at),
      title: `Neuer Personalbogen: ${f.name || 'ohne Namen'}`,
      sub: f.site_name ? `aus der App · ${f.site_name}` : 'aus der App',
      tags: [],
      href: '/personal/personalboegen',
      status: 'neu',
    });
  }
  for (const p of permits) {
    const left = p.until ? Math.round((Date.parse(p.until) - Date.parse(today)) / 86_400_000) : null;
    items.push({
      key: `p:${p.id}:${p.kind}`,
      kind: 'personal',
      date: today,
      title: `${p.kind} ${left === null ? 'fehlt' : left < 0 ? 'abgelaufen' : 'läuft ab'}: ${p.name}`,
      sub: p.until ? `gültig bis ${dateDe(p.until)}` : 'Datum in den Stammdaten fehlt',
      tags: [
        {
          t: left === null || left < 0 ? 'dringend' : `in ${left} Tagen`,
          tone: left === null || left <= 14 ? 'err' : 'warn',
        },
      ],
      href: ol ? `/team/${p.id}` : `/personal/${p.id}`,
      status: 'neu',
      due: p.until,
    });
  }
  for (const q of quals) {
    const over = q.valid_until < today;
    items.push({
      key: `q:${q.id}`,
      kind: 'personal',
      date: today,
      title: `Qualifikation ${over ? 'abgelaufen' : 'läuft ab'}: ${q.name} – ${q.employee_name}`,
      sub: `gültig bis ${dateDe(q.valid_until)}`,
      tags: [{ t: over ? 'abgelaufen' : 'bald', tone: over ? 'err' : 'warn' }],
      href: `/personal/${q.employee_id}#qualifikationen`,
      status: 'neu',
      due: q.valid_until,
    });
  }
  if (odd.length) {
    items.push({
      key: 'odd',
      kind: 'nachtrag',
      date: today,
      title: `${odd.length} ${odd.length === 1 ? 'auffällige Zeit' : 'auffällige Zeiten'} prüfen`,
      sub: 'Ist weicht stark vom Plan ab oder nicht am Objekt gestempelt (letzte 14 Tage)',
      tags: [],
      href: '/zeiterfassung/auffaellig',
      status: 'neu',
    });
  }
  // dringend zuerst: überfällig/heute, dann nach Datum der Meldung (neueste oben)
  const rank = (i: InboxItem) =>
    i.tags.some((t) => t.tone === 'err') ? 0 : i.tags.some((t) => t.tone === 'warn') ? 1 : 2;
  return items.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
}

/** Anzahl für die Zahl am Menüpunkt (60 s zwischengespeichert je Benutzer) */
const countCache = new Map<string, { at: number; n: number }>();
export async function inboxCount(deps: Ctx['deps'], c: Context<AppEnv>): Promise<number> {
  const id = c.get('user').id;
  const hit = countCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const n = (await inboxItems(deps, c)).length;
  countCache.set(id, { at: Date.now(), n });
  return n;
}
export const forgetInboxCount = () => countCache.clear();

const DOT: Record<string, string> = {
  g: 'background:#E3F4EA;color:#1F9D55',
  y: 'background:#FDF2DC;color:#9A6400',
  b: 'background:#E6EEFB;color:#2F6FDB',
  n: 'background:#F7EDF1;color:#811D40',
  r: 'background:#FBE5E5;color:#D23B3B',
};

export function registerInboxRoutes(ctx: Ctx) {
  const { app, deps, page } = ctx;

  app.get('/eingang', async (c) => {
    const all = await inboxItems(deps, c);
    countCache.set(c.get('user').id, { at: Date.now(), n: all.length });
    const art = c.req.query('art') as InboxKind | undefined;
    const mine = c.req.query('zustaendig') === 'ich';
    const names = [c.get('user').name, c.get('user').login].filter(Boolean).map((s) => s.toLowerCase());
    const rows = all.filter(
      (i) =>
        (!art || i.kind === art) &&
        (!mine || (i.who ? names.includes(i.who.toLowerCase()) : i.kind !== 'aufgabe')),
    );
    const count = (k: InboxKind) => all.filter((i) => i.kind === k).length;
    const chip = (label: string, href: string, on: boolean, n?: number) => (
      <a class={`chip${on ? ' on' : ''}`} href={href}>
        {label}
        {n !== undefined && <span class="n">{n}</span>}
      </a>
    );
    const q = (o: Record<string, string | undefined>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ art, zustaendig: mine ? 'ich' : undefined, ...o }))
        if (v) p.set(k, v);
      return `/eingang${p.size ? `?${p}` : ''}`;
    };
    return page(
      c,
      'Eingang',
      'eingang',
      <>
        <PageHead title="Eingang" />
        <div class="ib-bar">
          {chip('Alle offen', q({ art: undefined }), !art, all.length)}
          {(Object.keys(INBOX_KIND) as InboxKind[])
            .filter((k) => count(k) > 0)
            .map((k) => chip(INBOX_KIND[k].label, q({ art: k }), art === k, count(k)))}
          <span style="flex:1" />
          {chip('Mir zugewiesen', q({ zustaendig: mine ? undefined : 'ich' }), mine)}
        </div>
        {rows.length === 0 ? (
          <div class="empty">Nichts offen – alles erledigt.</div>
        ) : (
          <div class="card ib-list">
            {rows.map((i) => {
              const k = INBOX_KIND[i.kind];
              return (
                <div class="ib-row">
                  <span class="ib-dot" style={DOT[k.tone]}>
                    <Icon name={k.icon} size={17} />
                  </span>
                  <div class="ib-main">
                    <div class="ib-meta">
                      {dateDe(i.date)} · {k.label}
                      {i.due && i.kind === 'aufgabe' ? ` · fällig ${dateDe(i.due)}` : ''}
                    </div>
                    <a class="ib-title" href={i.href}>
                      {i.title}
                    </a>
                    {(i.sub || i.tags.length > 0) && (
                      <div class="ib-sub">
                        {i.sub && <span>{i.sub}</span>}
                        {i.tags.map((t) => (
                          <span class={`ib-tag ${t.tone ?? ''}`}>{t.t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {i.who && (
                    <span class="ib-who" title={`zuständig: ${i.who}`}>
                      {i.who}
                    </span>
                  )}
                  <span class={`ib-st ${i.status === 'neu' ? 'new' : 'work'}`}>{i.status}</span>
                  <div class="ib-act">
                    {i.actions}
                    <a class="btn sm sec" href={i.href}>
                      Öffnen
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p class="small mut" style="margin-top:10px">
          Ein Ort für alles Offene: Anträge, Nachträge, Tickets, Aufgaben und Personal-Hinweise. Erledigt wird
          auf der jeweiligen Seite – danach verschwindet der Eintrag hier von selbst. Neue Aufgabe:{' '}
          <a href={`/neu?typ=aufgabe`}>+ Aufgabe</a>
        </p>
      </>,
    );
  });
}
