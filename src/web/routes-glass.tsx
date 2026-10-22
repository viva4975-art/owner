import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { schoolHoliday } from '../domain/time/school-holidays.js';
import { BusinessError } from '../services/errors.js';
import {
  type Appointment,
  type Day,
  type GlassObject,
  HOLIDAY_PREF,
  INTERVALS,
  MONTHS,
  MONTHS_LONG,
  PER_YEAR,
  STATUS_LABEL,
  addConfirmation,
  customerContactsText,
  appointmentsCsv,
  applyProposals,
  autoPlan,
  deleteAppointment,
  districtOf,
  getAppointment,
  getObject,
  listAppointments,
  listCustomers,
  listObjects,
  markDone,
  markOpen,
  openPlanning,
  partsOf,
  specialsText,
  suggestSite,
  listSitesForGlass,
  plzOf,
  removeConfirmation,
  updateConfirmation,
  saveAppointment,
  saveCustomer,
  saveObject,
  saveTeamNames,
  setObjectActive,
  statusOf,
  suggestDays,
  teamNames,
} from '../services/glass.js';
import type { AppEnv } from './app.js';
import { type Ctx, UUID } from './app.js';
import { arr, str } from './forms.js';
import { dateDe } from './layout.js';
import { SiteOptions } from './site-options.js';

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const num = (s: string | null) => (s && /^\d+([.,]\d+)?$/.test(s) ? Number(s.replace(',', '.')) : null);
function daysText(days: Day[]) {
  return days.length === 1
    ? `${days[0]!.from}–${days[0]!.to} Uhr`
    : `${datesText(days)} · ${timesText(days)}`;
}

/** „30.03.–31.03.2027“ bei zusammenhängenden Tagen (Lücken nur Wochenende/Feiertag), sonst Liste */
const datesText = (days: Day[]) => {
  if (days.length === 1) return dateDe(days[0]!.date);
  const run = days.every((d, i) => {
    if (!i) return true;
    for (let x = addDays(days[i - 1]!.date, 1); x < d.date; x = addDays(x, 1))
      if (isoWeekday(x) <= 5 && !holidayName(x)) return false;
    return true;
  });
  const a = days[0]!.date;
  const b = days.at(-1)!.date;
  return run
    ? `${dateDe(a).slice(0, a.slice(0, 4) === b.slice(0, 4) ? 6 : 10)}–${dateDe(b)} (${days.length} Tage)`
    : days.map((d) => dateDe(d.date)).join(', ');
};
const timesText = (days: Day[]) =>
  new Set(days.map((d) => `${d.from}–${d.to}`)).size === 1
    ? `${days[0]!.from}–${days[0]!.to}${days.length > 1 ? ' täglich' : ''}`
    : days.map((d) => `${dateDe(d.date).slice(0, 6)} ${d.from}–${d.to}`).join(', ');

/** Terminbestätigungen am Termin (mehrere; bleiben beim Termin, auch wenn er verschoben wird – Ahmed 19.10.) */
const Confirmations = ({ a, back: ret, edit }: { a: Appointment; back: string; edit?: boolean }) => (
  <div class="gp-conf">
    {(a.confirmations ?? []).map((k) => (
      <div class="gp-conf-row">
        <span class="badge ok">✓ bestätigt</span> {k.at && <b>{dateDe(k.at)}</b>} {k.text}{' '}
        <span class="mut small">({k.by})</span>
        <details class="gp-conf-edit" style="display:inline-block">
          <summary class="small" title="Bestätigung ändern">
            ändern
          </summary>
          <form
            method="post"
            action={`/glasreinigung/termin/${a.id}/bestaetigung/${k.id}`}
            class="row"
            style="gap:6px;flex-wrap:wrap;margin-top:4px"
          >
            <input type="hidden" name="zurueck" value={ret} />
            <input type="date" name="am" value={k.at ?? todayBerlin()} aria-label="bestätigt am" required />
            <input name="text" value={k.text} aria-label="Bestätigung" required style="min-width:220px" />
            <button class="btn sm">Speichern</button>
          </form>
        </details>
        {edit && (
          <form
            method="post"
            action={`/glasreinigung/termin/${a.id}/bestaetigung/${k.id}/entfernen`}
            class="inline-form"
          >
            <input type="hidden" name="zurueck" value={ret} />
            <button class="btn sm ghost" data-confirm="Bestätigung entfernen?" title="entfernen">
              ×
            </button>
          </form>
        )}
      </div>
    ))}
    <details class="gp-conf-add">
      <summary class="small">+ Bestätigung eintragen</summary>
      <form
        method="post"
        action={`/glasreinigung/termin/${a.id}/bestaetigung`}
        class="row"
        style="gap:6px;flex-wrap:wrap;margin-top:4px"
      >
        <input type="hidden" name="id" value={randomUUID()} />
        <input type="hidden" name="zurueck" value={ret} />
        <input type="date" name="am" value={todayBerlin()} aria-label="bestätigt am" required />
        <input
          name="text"
          placeholder="z. B. Hausmeister telefonisch"
          aria-label="Bestätigung"
          required
          style="min-width:220px"
        />
        <button class="btn sm">Speichern</button>
      </form>
    </details>
  </div>
);

/** Ansprechpartner am Termin: Hausmeister des Objekts + Ansprechpartner des Kunden (statt Mitarbeiter – Ahmed 22.10.) */
const ContactLines = ({ a }: { a: Appointment }) => {
  const tel = (v: string) => <a href={`tel:${v.replace(/[^+\d]/g, '')}`}>{v}</a>;
  const list = [
    ...(a.caretaker_name || a.caretaker_phone
      ? [
          {
            name: a.caretaker_name ?? '',
            rolle: 'Hausmeister',
            telefon: a.caretaker_phone ?? '',
            email: a.caretaker_email ?? '',
          },
        ]
      : []),
    ...(a.customer_contacts ?? []),
  ];
  if (!list.length) return null;
  return (
    <div class="gp-contacts">
      {list.map((k) => (
        <span>
          <b>{k.name || '–'}</b>
          {k.rolle ? ` (${k.rolle})` : ''}
          {k.telefon && <> · {tel(k.telefon)}</>}
          {k.email && (
            <>
              {' '}
              · <a href={`mailto:${k.email}`}>{k.email}</a>
            </>
          )}
        </span>
      ))}
    </div>
  );
};

const GpTabs = ({ active }: { active: string }) => (
  <div class="tabs">
    {(
      [
        ['termine', 'Termine', '/glasreinigung'],
        ['kalender', 'Kalender', '/glasreinigung/kalender'],
        ['planung', 'Offene Planung', '/glasreinigung/planung'],
        ['kunden', 'Kunden', '/glasreinigung/kunden'],
        ['objekte', 'Objekte', '/glasreinigung/objekte'],
      ] as const
    ).map(([k, l, h]) => (
      <a href={h} class={active === k ? 'on' : ''}>
        {l}
      </a>
    ))}
  </div>
);

/** Glasreinigung-Planer wie die alte App. */
export function registerGlassRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  const head = async (c: Context<AppEnv>, active: string, f: string, actions?: Child) => {
    const today = todayBerlin();
    const [apps, objs] = await Promise.all([
      listAppointments(sql, { to: addDays(today, 7) }),
      sql<{ n: number }[]>`select count(*)::int as n from app.glass_objects where active`,
    ]);
    const open = apps.filter((a) => !a.done);
    const tile = (key: string, n: number, lbl: string, tone = '') => (
      <a
        class={`stat-card${tone ? ` tone-${tone}` : ''}${f === key ? ' on' : ''}`}
        href={`/glasreinigung?status=${key}`}
      >
        <div class="stat-num">{n}</div>
        <div class="stat-lbl">{lbl}</div>
      </a>
    );
    void c;
    return (
      <>
        <div class="page-head">
          <div>
            <div class="eyebrow">Vor Ort</div>
            <h1>Glasreinigung</h1>
            <div class="sub">Termine je Objekt – Planung, Durchführung und Nachweis.</div>
          </div>
          {actions && <div class="acts">{actions}</div>}
        </div>
        <GpTabs active={active} />
        <div class="stat-grid">
          {tile('ueberfaellig', open.filter((a) => a.first_day < today).length, 'Überfällig', 'err')}
          {tile('heute', open.filter((a) => a.first_day === today).length, 'Heute', 'warn')}
          {tile('geplant', open.filter((a) => a.first_day >= today).length, 'Diese Woche')}
          <a class={`stat-card tone-ok${active === 'objekte' ? ' on' : ''}`} href="/glasreinigung/objekte">
            <div class="stat-num">{objs[0]!.n}</div>
            <div class="stat-lbl">Objekte</div>
          </a>
        </div>
      </>
    );
  };

  const teamBadge = (team: string | null, teams: { team_a: string; team_b: string }) =>
    team ? <span class={`badge gp-${team}`}>{teams[team as 'team_a']}</span> : null;

  // ------------------------------------------------------------------ Termine
  app.get('/glasreinigung', async (c) => {
    // Filter bleibt erhalten (Ahmed 22.10.: „bei einem Kunden bleiben“): gemerkt im Cookie, „zurücksetzen“ löscht ihn
    const FILTER_KEYS = ['q', 'status', 'kunde', 'sort'] as const;
    if (c.req.query('reset') === '1') {
      deleteCookie(c, 'gp_f', { path: '/glasreinigung' });
      return c.redirect('/glasreinigung?status=', 303);
    }
    const given = FILTER_KEYS.some((k) => c.req.query(k) != null);
    if (!given) {
      const saved = getCookie(c, 'gp_f');
      if (saved) {
        const qs = new URLSearchParams(saved);
        for (const [k, v] of new URLSearchParams(new URL(c.req.url).search)) qs.set(k, v);
        if (!FILTER_KEYS.some((k) => qs.get(k) != null)) qs.set('status', '');
        return c.redirect(`/glasreinigung?${qs}`, 303);
      }
    } else {
      const keep = new URLSearchParams();
      for (const k of FILTER_KEYS) if (c.req.query(k)) keep.set(k, c.req.query(k)!);
      if (keep.toString())
        setCookie(c, 'gp_f', keep.toString(), {
          path: '/glasreinigung',
          maxAge: 60 * 60 * 24 * 90,
          sameSite: 'Lax',
          httpOnly: true,
        });
      else deleteCookie(c, 'gp_f', { path: '/glasreinigung' });
    }
    const today = todayBerlin();
    const st = c.req.query('status') ?? '';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const kunde = c.req.query('kunde') ?? '';
    const sort = c.req.query('sort') === 'kunde' ? 'kunde' : 'datum';
    const [apps, customers, teams] = await Promise.all([
      listAppointments(sql),
      listCustomers(sql),
      teamNames(sql),
    ]);
    const list = apps
      .filter((a) => !kunde || a.customer_id === kunde)
      .filter(
        (a) =>
          !q ||
          [
            a.object_name,
            a.object_address,
            a.customer_name,
            a.part,
            a.note,
            a.caretaker_name,
            a.site_no,
            customerContactsText(a),
          ].some((v) => (v ?? '').toLowerCase().includes(q)),
      )
      .filter((a) => {
        const s = statusOf(a, today);
        if (!st) return s !== 'erledigt';
        if (st === 'geplant') return !a.done && a.first_day >= today && a.first_day <= addDays(today, 7);
        return s === st || st === 'alle';
      });
    if (sort === 'kunde')
      list.sort(
        (x, y) =>
          (x.customer_name ?? '').localeCompare(y.customer_name ?? '', 'de') ||
          x.first_day.localeCompare(y.first_day) ||
          x.object_name.localeCompare(y.object_name, 'de'),
      );
    const selfQs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (c.req.query(k)) selfQs.set(k, c.req.query(k)!);
    const self = `/glasreinigung?${selfQs.toString() || 'status='}`;
    const ret = encodeURIComponent(self);
    let lastCust: string | null | undefined;
    return page(
      c,
      'Glasreinigung',
      'disposition',
      <div class="portal">
        {await head(
          c,
          'termine',
          st,
          <>
            <a
              class="btn sec"
              href={`/glasreinigung/bestaetigungen${kunde ? `?kunde=${kunde}` : ''}`}
              target="_blank"
            >
              Bestätigungen drucken
            </a>
            <a class="btn sec" href="/glasreinigung/autoplan">
              Auto-Plan
            </a>
            <a class="btn" href={`/glasreinigung/termin/${randomUUID()}?zurueck=${ret}`}>
              + Termin
            </a>
          </>,
        )}
        <form class="toolbar" method="get" action="/glasreinigung">
          <input class="search-input" type="search" name="q" value={q} placeholder="Suche…" />
          <select
            name="status"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Status"
            style="max-width:170px"
          >
            <option value="">Offene</option>
            <option value="alle" selected={st === 'alle'}>
              Alle Status
            </option>
            {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((k) => (
              <option value={k} selected={st === k}>
                {STATUS_LABEL[k][0]}
              </option>
            ))}
          </select>
          <select name="kunde" onchange="this.form.submit()" aria-label="Kunde" style="max-width:240px">
            <option value="">Alle Kunden</option>
            {customers.map((k) => (
              <option value={k.id} selected={kunde === k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <select
            name="sort"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Sortierung"
            style="max-width:190px"
          >
            <option value="datum">nach Datum</option>
            <option value="kunde" selected={sort === 'kunde'}>
              nach Kunde
            </option>
          </select>
          <a class="btn sec" href="/glasreinigung?reset=1">
            Filter zurücksetzen
          </a>
          <a
            class="btn sec"
            href={`/glasreinigung/termine.csv?${new URLSearchParams({ status: st, kunde, q, sort })}`}
          >
            CSV-Export
          </a>
        </form>
        {list.length === 0 ? (
          <div class="empty">Keine Termine passen zu dieser Auswahl.</div>
        ) : (
          <div class="list-cards">
            {list.map((a) => {
              const s = statusOf(a, today);
              const groupHead =
                sort === 'kunde' && a.customer_name !== lastCust ? (
                  <h3 class="gp-group">{a.customer_name ?? 'ohne Kunde'}</h3>
                ) : null;
              lastCust = a.customer_name;
              const specials = specialsText(a);
              return (
                <>
                  {groupHead}
                  <div class={`lc gp-card${a.done ? ' lc-inactive' : ''}`}>
                    <div class="lc-head">
                      <div>
                        <div class="bw-chips" style="margin-bottom:6px">
                          <span class={`badge ${STATUS_LABEL[s][1]}`}>{STATUS_LABEL[s][0]}</span>
                          {a.days.length > 1 && <span class="badge">Block-Reinigung</span>}
                          {a.confirmations?.length > 0 && (
                            <span class="badge ok">
                              Bestätigt{a.confirmations.length > 1 ? ` (${a.confirmations.length})` : ''}
                            </span>
                          )}
                          {teamBadge(a.team, teams)}
                          {a.interval !== 'einmalig' && (
                            <span class="badge">{INTERVALS[a.interval]?.label}</span>
                          )}
                          {a.part && partsOf(a.part).map((x) => <span class="badge">{x}</span>)}
                          {a.days.some((d) => schoolHoliday(d.date)) && (
                            <span class="badge gold">Ferien</span>
                          )}
                          {a.district && <span class="badge">{a.district}</span>}
                        </div>
                        <a
                          class="lc-name"
                          href={`/glasreinigung/termin/${a.id}?zurueck=${ret}`}
                          style={a.done ? 'text-decoration:line-through' : ''}
                        >
                          {a.object_name}
                        </a>
                        <div class="lc-sub">
                          {[a.customer_name, a.object_address, a.site_no ? `Kostenstelle ${a.site_no}` : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                        <div class="lc-details">
                          <span>{daysText(a.days)}</span>
                          {a.hours && <span>{String(a.hours).replace('.', ',')} h gesamt</span>}
                        </div>
                        <ContactLines a={a} />
                        {specials && <div class="gp-note">Besonderheiten: {specials}</div>}
                        {a.note && <div class="gp-note">{a.note}</div>}
                        <Confirmations a={a} back={self} />
                      </div>
                      <div class="gp-date">
                        <b>{dateDe(a.first_day).slice(0, 6)}</b>
                        <span>{WD[isoWeekday(a.first_day) - 1]}</span>
                        {a.last_day && a.last_day !== a.first_day && (
                          <span>bis {dateDe(a.last_day).slice(0, 6)}</span>
                        )}
                      </div>
                    </div>
                    <div class="lc-foot gp-acts">
                      {!a.done && (
                        <form
                          method="post"
                          action={`/glasreinigung/termin/${a.id}/erledigt`}
                          class="inline-form"
                        >
                          <input type="hidden" name="zurueck" value={self} />
                          <button class="btn sm sec">✓ Erledigt</button>
                        </form>
                      )}
                      <a class="btn sm sec" href={`/glasreinigung/termin/${a.id}?zurueck=${ret}`}>
                        Bearbeiten
                      </a>
                      <form
                        method="post"
                        action={`/glasreinigung/termin/${a.id}/loeschen`}
                        class="inline-form"
                      >
                        <input type="hidden" name="zurueck" value={self} />
                        <button class="btn sm danger" data-confirm="Termin löschen?">
                          Löschen
                        </button>
                      </form>
                    </div>
                  </div>
                </>
              );
            })}
          </div>
        )}
      </div>,
    );
  });

  app.get('/glasreinigung/termine.csv', async (c) => {
    const today = todayBerlin();
    const st = c.req.query('status') ?? '';
    const kunde = c.req.query('kunde') ?? '';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const list = (await listAppointments(sql))
      .filter((a) => !kunde || a.customer_id === kunde)
      .filter(
        (a) =>
          !q ||
          [a.object_name, a.object_address, a.customer_name, a.part].some((v) =>
            (v ?? '').toLowerCase().includes(q),
          ),
      )
      .filter((a) => (!st ? !a.done : st === 'alle' || statusOf(a, today) === st));
    if (c.req.query('sort') === 'kunde')
      list.sort(
        (x, y) =>
          (x.customer_name ?? '').localeCompare(y.customer_name ?? '', 'de') ||
          x.first_day.localeCompare(y.first_day),
      );
    return new Response(appointmentsCsv(list, await teamNames(sql)), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Glasreinigung_${today}.csv"`,
      },
    });
  });

  // ------------------------------------------------------------------ Termin
  const retOf = (v: string | null | undefined) =>
    v && /^\/glasreinigung(\/|$|\?)/.test(v) ? v : '/glasreinigung';

  app.get(`/glasreinigung/termin/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const a = await getAppointment(sql, id);
    const ret = retOf(c.req.query('zurueck'));
    const date = c.req.query('datum') ?? todayBerlin();
    // „noch n offen“ für das Jahr des Termins (vorher immer das laufende Jahr → falsche Zahl bei Terminen im Folgejahr)
    const planYear = Number((a?.first_day ?? date).slice(0, 4));
    const [objects, teams, plan, customers] = await Promise.all([
      listObjects(sql),
      teamNames(sql),
      openPlanning(sql, planYear),
      listCustomers(sql),
    ]);
    const openOf = new Map(plan.map((p) => [p.o.id, p.open]));
    const preObj = a?.object_id ?? c.req.query('objekt') ?? '';
    const pre = objects.find((o) => o.id === preObj);
    const days: Day[] =
      a?.days ?? (pre ? suggestDays(date, Number(pre.hours ?? 2)) : [{ date, from: '08:00', to: '12:00' }]);
    const curParts = a ? partsOf(a.part) : ['Gesamt'];
    const custOf = new Map(customers.map((k) => [k.id, k]));
    const dayRow = (d: Day | null) => (
      <div class="gp-dayrow">
        <input type="date" name="tag" value={d?.date ?? ''} aria-label="Datum" />
        <input type="time" name="von" value={d?.from ?? '08:00'} aria-label="von" />
        <input type="time" name="bis" value={d?.to ?? '16:00'} aria-label="bis" />
        <button type="button" class="btn sm sec" data-del-day title="Tag entfernen">
          ✕
        </button>
      </div>
    );
    // je Objekt: Teilbereiche zum Ankreuzen + Hausmeister/Ansprechpartner/Besonderheiten (sichtbar nur das gewählte)
    const objBox = (o: GlassObject) => {
      const known = ['Gesamt', ...o.parts.map((p) => p.name)];
      const isCur = o.id === preObj;
      const k = o.customer_id ? custOf.get(o.customer_id) : undefined;
      const contacts = [
        ...(o.caretaker_name || o.caretaker_phone
          ? [
              {
                name: o.caretaker_name ?? '–',
                rolle: 'Hausmeister',
                telefon: o.caretaker_phone,
                email: o.caretaker_email,
              },
            ]
          : []),
        ...(k?.contacts ?? []),
      ];
      const specials = specialsText({
        wishes: o.wishes,
        needs_police_cert: o.needs_police_cert,
        needs_lift: o.needs_lift,
        needs_other: o.needs_other,
      });
      return (
        <div class="gp-objbox" data-obj={o.id} hidden={!isCur}>
          <label style="margin-top:12px">Teilbereiche (mehrere möglich)</label>
          <div class="gp-parts">
            {known.map((n) => (
              <label>
                <input
                  type="checkbox"
                  name="teil"
                  value={n}
                  disabled={!isCur}
                  checked={isCur ? curParts.some((x) => x.toLowerCase() === n.toLowerCase()) : n === 'Gesamt'}
                />{' '}
                {n}
                {n !== 'Gesamt' && (
                  <span class="small mut">
                    {' '}
                    ({PER_YEAR.find(([v]) => v === o.parts.find((p) => p.name === n)?.per_year)?.[1] ?? ''})
                  </span>
                )}
              </label>
            ))}
          </div>
          <div class="gp-info">
            <div>
              <b>Hausmeister / Ansprechpartner Kunde</b>
            </div>
            {contacts.length ? (
              contacts.map((p) => (
                <div>
                  {p.name}
                  {p.rolle ? ` (${p.rolle})` : ''}
                  {p.telefon ? ` · ${p.telefon}` : ''}
                  {p.email ? ` · ${p.email}` : ''}
                </div>
              ))
            ) : (
              <div class="mut">Keine hinterlegt.</div>
            )}
            <div class="small" style="margin-top:4px">
              <a href={`/glasreinigung/objekte/${o.id}`}>Hausmeister am Objekt bearbeiten</a>
              {o.customer_id && (
                <>
                  {' · '}
                  <a href={`/glasreinigung/kunden/${o.customer_id}`}>Ansprechpartner beim Kunden</a>
                </>
              )}
            </div>
            {specials && (
              <div style="margin-top:6px">
                <b>Sonderwünsche / Besonderheiten:</b> {specials}
              </div>
            )}
          </div>
        </div>
      );
    };
    const otherParts = a
      ? curParts.filter(
          (x) =>
            !['gesamt', ...(pre?.parts ?? []).map((p) => p.name.toLowerCase())].includes(x.toLowerCase()),
        )
      : [];
    return page(
      c,
      a ? 'Termin bearbeiten' : 'Neuer Termin',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href={ret}>Glasreinigung</a>
            </div>
            <h1>{a ? 'Termin bearbeiten' : 'Neuer Termin'}</h1>
            {a?.done && (
              <div class="sub">
                <span class="badge ok">erledigt</span>
              </div>
            )}
          </div>
        </div>
        <form
          method="post"
          action={`/glasreinigung/termin/${id}`}
          class="card"
          style="max-width:860px"
          id="gp-termin"
        >
          <input type="hidden" name="version" value={String(a?.version ?? '')} />
          <input type="hidden" name="zurueck" value={ret} />
          <div class="grid">
            <div>
              <label for="objekt">Objekt *</label>
              <select id="objekt" name="objekt" required>
                <option value="">— Objekt wählen —</option>
                {objects.map((o) => (
                  <option value={o.id} selected={o.id === preObj}>
                    {(openOf.get(o.id) ?? 0) > 0 ? '● ' : ''}
                    {o.customer_name ? `${o.customer_name} – ` : ''}
                    {o.name}
                    {(openOf.get(o.id) ?? 0) > 0 ? ` — ${planYear} noch ${openOf.get(o.id)} offen` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="teil-frei">Weitere Teilbereiche (frei, mit Komma)</label>
              <input
                id="teil-frei"
                name="teil_frei"
                value={otherParts.join(', ')}
                placeholder="z. B. Oberlichter"
              />
            </div>
          </div>
          {objects.map(objBox)}
          <label style="margin-top:12px">Tage &amp; Uhrzeiten *</label>
          <div id="gp-days">{days.map((d) => dayRow(d))}</div>
          <template id="gp-day-tpl">{dayRow(null)}</template>
          <button type="button" class="btn sm sec" id="gp-add-day" style="margin-top:6px">
            + Tag hinzufügen
          </button>
          <div class="grid" style="margin-top:12px">
            <div>
              <label for="stunden">Gesamtstunden (leer = aus den Uhrzeiten)</label>
              <input
                id="stunden"
                name="stunden"
                inputmode="decimal"
                value={a?.hours ? String(a.hours).replace('.', ',') : ''}
              />
            </div>
            <div>
              <label for="turnus">Turnus</label>
              <select id="turnus" name="turnus" data-nosearch>
                {Object.entries(INTERVALS).map(([k, v]) => (
                  <option value={k} selected={(a?.interval ?? 'einmalig') === k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="team">Team</label>
              <select id="team" name="team" data-nosearch>
                <option value="">— kein Team —</option>
                <option value="team_a" selected={(a?.team ?? pre?.team) === 'team_a'}>
                  {teams.team_a}
                </option>
                <option value="team_b" selected={(a?.team ?? pre?.team) === 'team_b'}>
                  {teams.team_b}
                </option>
              </select>
            </div>
            <div>
              <label for="notiz">Notizen zum Termin</label>
              <textarea id="notiz" name="notiz" rows={2}>
                {a?.note ?? ''}
              </textarea>
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href={ret}>
              Abbrechen
            </a>
          </div>
        </form>
        {a && (
          <section class="card" style="max-width:900px;margin-top:14px">
            <h3>Terminbestätigungen</h3>
            <p class="mut small">
              Mehrere möglich (Hausmeister, Schule, Kunde …). Sie bleiben beim Termin, auch wenn er verschoben
              wird.
            </p>
            <Confirmations
              a={a}
              back={`/glasreinigung/termin/${a.id}?zurueck=${encodeURIComponent(ret)}`}
              edit
            />
          </section>
        )}
        {a && (
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
            {a.done ? (
              <form method="post" action={`/glasreinigung/termin/${a.id}/offen`} class="inline-form">
                <input type="hidden" name="zurueck" value={ret} />
                <button class="btn sm sec">Wieder als offen markieren</button>
              </form>
            ) : (
              <form method="post" action={`/glasreinigung/termin/${a.id}/erledigt`} class="inline-form">
                <input type="hidden" name="zurueck" value={ret} />
                <button class="btn sm sec">✓ Erledigt (legt Folgetermin nach Turnus an)</button>
              </form>
            )}
          </div>
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var box=document.getElementById('gp-days'),tpl=document.getElementById('gp-day-tpl');
document.getElementById('gp-add-day').addEventListener('click',function(){var n=tpl.content.firstElementChild.cloneNode(true);var last=box.querySelector('.gp-dayrow:last-child input[type=date]');
if(last&&last.value){var d=new Date(last.value+'T12:00:00Z');do{d.setUTCDate(d.getUTCDate()+1)}while(d.getUTCDay()===0||d.getUTCDay()===6);n.querySelector('input[type=date]').value=d.toISOString().slice(0,10)}box.appendChild(n)});
box.addEventListener('click',function(e){var b=e.target.closest('[data-del-day]');if(b&&box.children.length>1)b.parentElement.remove()});
var sel=document.getElementById('objekt');function sync(){document.querySelectorAll('.gp-objbox').forEach(function(x){var on=x.getAttribute('data-obj')===sel.value;x.hidden=!on;x.querySelectorAll('input').forEach(function(i){i.disabled=!on})})}
sel.addEventListener('change',sync);sync();})();`,
          }}
        />
      </div>,
    );
  });

  app.post(`/glasreinigung/termin/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const dates = arr(b, 'tag');
    const froms = arr(b, 'von');
    const tos = arr(b, 'bis');
    const days = dates
      .map((d, i) => ({ date: d, from: froms[i] ?? '', to: tos[i] ?? '' }))
      .filter((d) => d.date);
    // mehrere Teilbereiche (Ahmed 22.10.): angekreuzte + frei eingetragene, als Text „Oberlichter, Wintergarten“
    const parts = [...arr(b, 'teil'), ...partsOf(str(b, 'teil_frei')).filter((x) => x !== 'Gesamt')]
      .map((x) => x.trim())
      .filter((x, i, l) => x && l.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
    const part = parts.length && !(parts.length === 1 && parts[0] === 'Gesamt') ? parts.join(', ') : null;
    await saveAppointment(
      sql,
      id,
      {
        objectId: str(b, 'objekt') ?? '',
        part,
        days,
        hours: num(str(b, 'stunden')),
        interval: str(b, 'turnus') ?? 'einmalig',
        team: str(b, 'team'),
        staff: (await getAppointment(sql, id))?.staff ?? null,
        note: str(b, 'notiz'),
        expectedVersion: num(str(b, 'version')),
      },
      c.get('actor'),
    );
    return back(c, retOf(str(b, 'zurueck')), { ok: 'Termin gespeichert.' });
  });

  app.post(`/glasreinigung/termin/:id{${UUID}}/bestaetigung`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    const eid = str(b, 'id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(eid)) throw new BusinessError('Formular ungültig – bitte neu laden');
    await addConfirmation(
      sql,
      c.req.param('id'),
      { id: eid, at: str(b, 'am') ?? '', text: str(b, 'text') ?? '' },
      c.get('actor'),
    );
    return back(c, retOf(str(b, 'zurueck')), { ok: 'Bestätigung eingetragen.' });
  });
  app.post(`/glasreinigung/termin/:id{${UUID}}/bestaetigung/:eid{${UUID}}`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    await updateConfirmation(
      sql,
      c.req.param('id'),
      c.req.param('eid'),
      { at: str(b, 'am') ?? '', text: str(b, 'text') ?? '' },
      c.get('actor'),
    );
    return back(c, retOf(str(b, 'zurueck')), { ok: 'Bestätigung geändert.' });
  });
  app.post(`/glasreinigung/termin/:id{${UUID}}/bestaetigung/:eid{${UUID}}/entfernen`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    await removeConfirmation(sql, c.req.param('id'), c.req.param('eid'), c.get('actor'));
    return back(c, retOf(str(b, 'zurueck')), { ok: 'Bestätigung entfernt.' });
  });

  app.post(`/glasreinigung/termin/:id{${UUID}}/erledigt`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    const follow = await markDone(sql, c.req.param('id'), c.get('actor'));
    return back(c, retOf(str(b, 'zurueck')), {
      ok: follow ? 'Erledigt · Folgetermin angelegt' : 'Erledigt',
    });
  });

  app.post(`/glasreinigung/termin/:id{${UUID}}/offen`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    await markOpen(sql, c.req.param('id'));
    return back(c, retOf(str(b, 'zurueck')), { ok: 'Termin wieder offen.' });
  });

  app.post(`/glasreinigung/termin/:id{${UUID}}/loeschen`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    await deleteAppointment(sql, c.req.param('id'));
    return back(c, retOf(str(b, 'zurueck')), { ok: 'Termin gelöscht.' });
  });

  // ------------------------------------------------------------------ Kalender
  app.get('/glasreinigung/kalender', async (c) => {
    const today = todayBerlin();
    const m = /^\d{4}-\d{2}$/.test(c.req.query('monat') ?? '') ? c.req.query('monat')! : today.slice(0, 7);
    const kunde = c.req.query('kunde') ?? '';
    const team = c.req.query('team') ?? '';
    const first = `${m}-01`;
    const [y, mo] = m.split('-').map(Number) as [number, number];
    const last = addDays(mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`, -1);
    const [apps, customers, teams] = await Promise.all([
      listAppointments(sql, { from: first, to: last }),
      listCustomers(sql),
      teamNames(sql),
    ]);
    const objCust = new Map(
      (await sql<{ id: string; customer_id: string }[]>`select id, customer_id from app.glass_objects`).map(
        (r) => [r.id, r.customer_id],
      ),
    );
    const shown = apps
      .filter((a) => !kunde || objCust.get(a.object_id) === kunde)
      .filter((a) => !team || (team === 'ohne' ? !a.team : a.team === team));
    const byDay = new Map<string, { a: Appointment; d: Day }[]>();
    for (const a of shown)
      for (const d of a.days) byDay.set(d.date, [...(byDay.get(d.date) ?? []), { a, d }]);
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    const qs = (mm: string) =>
      `?${new URLSearchParams({ monat: mm, ...(kunde ? { kunde } : {}), ...(team ? { team } : {}) })}`;
    const cells: string[] = [];
    for (let d = addDays(first, 1 - isoWeekday(first)); d <= last || isoWeekday(d) !== 1; d = addDays(d, 1))
      cells.push(d);
    return page(
      c,
      'Glasreinigung – Kalender',
      'disposition',
      <div class="portal">
        {await head(c, 'kalender', '')}
        <form class="toolbar gp-calbar" method="get" action="/glasreinigung/kalender">
          <a class="btn sec" href={`/glasreinigung/kalender${qs(prev)}`} aria-label="zurück">
            ←
          </a>
          <b class="gp-month">
            {MONTHS_LONG[mo - 1]} {y}
          </b>
          <a class="btn sec" href={`/glasreinigung/kalender${qs(next)}`} aria-label="vor">
            →
          </a>
          <input type="hidden" name="monat" value={m} />
          <select name="kunde" onchange="this.form.submit()" aria-label="Kunde" style="max-width:220px">
            <option value="">Alle Kunden</option>
            {customers.map((k) => (
              <option value={k.id} selected={kunde === k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <select
            name="team"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Team"
            style="max-width:160px"
          >
            <option value="">Alle Teams</option>
            <option value="team_a" selected={team === 'team_a'}>
              {teams.team_a}
            </option>
            <option value="team_b" selected={team === 'team_b'}>
              {teams.team_b}
            </option>
            <option value="ohne" selected={team === 'ohne'}>
              ohne Team
            </option>
          </select>
          <a class="btn sec" href={`/glasreinigung/kalender${qs(today.slice(0, 7))}`}>
            Heute
          </a>
          <button type="button" class="btn sec" onclick="print()">
            Monat drucken
          </button>
          <a
            class="btn sec"
            href={`/glasreinigung/jahresplaner?jahr=${y}${kunde ? `&kunde=${kunde}` : ''}`}
            target="_blank"
          >
            Jahresplaner
          </a>
        </form>
        <div class="gp-cal">
          {WD.map((w) => (
            <div class="gp-wd">{w}</div>
          ))}
          {cells.map((d) => {
            const items = byDay.get(d) ?? [];
            const hol = holidayName(d);
            const fer = schoolHoliday(d);
            const cls = [
              'gp-cell',
              d.slice(0, 7) !== m ? 'out' : '',
              hol ? 'hol' : d === today ? 'today' : fer ? 'fer' : isoWeekday(d) >= 6 ? 'we' : '',
            ].join(' ');
            return (
              <div class={cls}>
                <a
                  class="gp-dn"
                  href={`/glasreinigung/termin/${randomUUID()}?datum=${d}`}
                  title="+ Termin an diesem Tag"
                >
                  {Number(d.slice(8))}
                  {fer && <span class="gp-f">F</span>}
                </a>
                {hol && <div class="gp-hol">{hol}</div>}
                {items.slice(0, 3).map(({ a, d: day }) => (
                  <a class={`gp-ev gp-${a.team ?? 'none'}`} href={`/glasreinigung/termin/${a.id}`}>
                    <b>
                      {day.from}
                      {a.confirmed ? ' ✓' : ''}
                    </b>{' '}
                    {a.object_name}
                    {a.customer_name && <span> · {a.customer_name}</span>}
                    {a.staff && <span> · {a.staff}</span>}
                  </a>
                ))}
                {items.length > 3 && (
                  <a class="small mut" href={`/glasreinigung?status=alle&q=`}>
                    +{items.length - 3} weitere
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <p class="small mut">
          <span class="gp-f">F</span> Schulferien Bayern · Feiertag (rot) · Heute (blau) · Klick auf den Tag
          legt einen Termin an.
        </p>
      </div>,
    );
  });

  // ------------------------------------------------------------------ Bestätigungsliste (Druckseite)
  app.get('/glasreinigung/bestaetigungen', async (c) => {
    const today = todayBerlin();
    const iso = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const from = iso(c.req.query('von')) ?? today;
    const to = iso(c.req.query('bis')) ?? addDays(today, 90);
    const zeige = c.req.query('zeige') ?? 'alle';
    const kunde = c.req.query('kunde') ?? '';
    const [apps, customers] = await Promise.all([listAppointments(sql, { from, to }), listCustomers(sql)]);
    const shown = apps.filter((a) => !a.done && (!kunde || a.customer_id === kunde));
    const ok = shown.filter((a) => (a.confirmations ?? []).length > 0);
    const open = shown.filter((a) => !(a.confirmations ?? []).length);
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const rows = (list: Appointment[], withConf: boolean) =>
      list
        .map(
          (a) =>
            `<tr><td>${datesText(a.days)}</td><td>${timesText(a.days)}</td><td><b>${esc(a.object_name)}</b>${a.part ? `<br><span class="k">${esc(a.part)}</span>` : ''}</td><td>${esc(a.customer_name ?? '')}</td><td>${esc(a.object_address ?? '')}</td><td>${esc(a.contact ?? '')}${a.phone ? `<br>${esc(a.phone)}` : ''}${customerContactsText(a) ? `<br><span class="k">${esc(customerContactsText(a))}</span>` : ''}</td><td>${esc(specialsText(a))}</td><td>${
              withConf
                ? (a.confirmations ?? [])
                    .map((k) => `✓ ${k.at ? `${dateDe(k.at)} ` : ''}${esc(k.text)}`)
                    .join('<br>')
                : '<span class="box"></span>'
            }</td></tr>`,
        )
        .join('');
    const table = (title: string, list: Appointment[], withConf: boolean) =>
      `<h2>${title} (${list.length})</h2>${
        list.length
          ? `<table class="ls"><thead><tr><th>Datum</th><th>Uhrzeit</th><th>Objekt</th><th>Kunde</th><th>Adresse</th><th>Hausmeister / Ansprechpartner</th><th>Sonderwünsche / Besonderheiten</th><th>${withConf ? 'Bestätigung' : 'Bestätigt am / durch'}</th></tr></thead><tbody>${rows(list, withConf)}</tbody></table>`
          : '<p class="k">Keine Termine.</p>'
      }`;
    const kname = customers.find((k) => k.id === kunde)?.name;
    const opts = customers
      .map((k) => `<option value="${k.id}"${k.id === kunde ? ' selected' : ''}>${esc(k.name)}</option>`)
      .join('');
    const sel = (v: string, l: string) =>
      `<option value="${v}"${zeige === v ? ' selected' : ''}>${l}</option>`;
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Terminbestätigungen</title><style>
@page{size:A4 landscape;margin:10mm}body{font-family:Inter,system-ui,Arial,sans-serif;margin:0 12px;color:#1c1917}
.bar{padding:10px;border-bottom:1px solid #ddd;display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:center}
.bar input,.bar select{font:inherit;padding:5px}.bar button{font:inherit;padding:7px 16px;border-radius:8px;border:0;background:#7D1435;color:#fff}
.hd{display:flex;justify-content:space-between;align-items:flex-end;padding:8px 0}.hd h1{color:#6b1a21;font-size:22px;margin:0}.k{color:#777;font-size:11px}
h2{font-size:15px;color:#6b1a21;margin:14px 0 4px}.ls{width:100%;border-collapse:collapse;font-size:10px}.ls th{text-align:left;background:#f4eef0;padding:4px}
.ls td{border-bottom:1px solid #ddd;padding:4px;vertical-align:top}.ls tr{page-break-inside:avoid}.box{display:inline-block;width:120px;border-bottom:1px solid #999;height:12px}
@media print{.bar{display:none}}</style></head><body>
<form class="bar" method="get"><label>von <input type="date" name="von" value="${from}"></label><label>bis <input type="date" name="bis" value="${to}"></label>
<select name="zeige">${sel('alle', 'Bestätigte und unbestätigte')}${sel('offen', 'Nur unbestätigte')}${sel('bestaetigt', 'Nur bestätigte')}</select>
<select name="kunde"><option value="">Alle Kunden</option>${opts}</select><button type="submit" style="background:#555">Anzeigen</button><button type="button" onclick="print()">Drucken / als PDF speichern</button></form>
<div class="hd"><div><img src="/static/logo-transparent.png" alt="Viva-Deluxe" style="height:36px;display:block;margin-bottom:4px"><b>Glasreinigung – Terminbestätigungen</b><div class="k">${esc(kname ?? 'Alle Kunden')} · offene Termine ${dateDe(from)} – ${dateDe(to)}</div></div>
<div class="k" style="text-align:right">${open.length} unbestätigt · ${ok.length} bestätigt<br>Stand ${dateDe(today)}</div></div>
${zeige !== 'bestaetigt' ? table('Noch nicht bestätigt', open, false) : ''}${zeige !== 'offen' ? table('Bestätigt', ok, true) : ''}
</body></html>`);
  });

  // ------------------------------------------------------------------ Jahresplaner (Druckseite A4 quer)
  app.get('/glasreinigung/jahresplaner', async (c) => {
    const y = Number(c.req.query('jahr')) || Number(todayBerlin().slice(0, 4));
    const kunde = c.req.query('kunde') ?? '';
    const [apps, teams, customers] = await Promise.all([
      listAppointments(sql, { from: `${y}-01-01`, to: `${y}-12-31` }),
      teamNames(sql),
      listCustomers(sql),
    ]);
    const objCust = new Map(
      (await sql<{ id: string; customer_id: string }[]>`select id, customer_id from app.glass_objects`).map(
        (r) => [r.id, r.customer_id],
      ),
    );
    const shown = apps.filter((a) => !kunde || objCust.get(a.object_id) === kunde);
    const byDay = new Map<string, Appointment[]>();
    for (const a of shown) for (const d of a.days) byDay.set(d.date, [...(byDay.get(d.date) ?? []), a]);
    const kname = customers.find((k) => k.id === kunde)?.name;
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    let grid = '<table class="yp"><thead><tr>';
    for (const mn of MONTHS_LONG) grid += `<th>${mn}</th>`;
    grid += '</tr></thead><tbody>';
    for (let day = 1; day <= 31; day++) {
      grid += '<tr>';
      for (let mo = 1; mo <= 12; mo++) {
        const d = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const valid = new Date(`${d}T12:00:00Z`).getUTCMonth() + 1 === mo;
        if (!valid) {
          grid += '<td class="x"></td>';
          continue;
        }
        const wd = isoWeekday(d);
        const hol = holidayName(d);
        const cls = [hol || wd === 7 ? 'so' : wd === 6 ? 'sa' : '', schoolHoliday(d) ? 'fe' : ''].join(' ');
        const items = byDay.get(d) ?? [];
        const first = items[0];
        grid += `<td class="${cls}"><span class="n">${day}</span><span class="w">${WD[wd - 1]}</span>${
          first
            ? `<span class="e t-${first.team ?? 'none'}">${esc(kunde ? first.object_name : (first.customer_name ?? first.object_name))}${items.length > 1 ? ` +${items.length - 1}` : ''}</span>`
            : ''
        }</td>`;
      }
      grid += '</tr>';
    }
    grid += '</tbody></table>';
    const listRows = shown
      .map(
        (a) =>
          `<tr><td>${datesText(a.days)}</td><td>${timesText(a.days)}</td><td>${esc(a.object_name)}</td><td>${esc(a.customer_name ?? '')}</td><td>${esc(a.object_address ?? '')}</td><td>${esc(a.contact ?? '')}${a.phone ? ` ${esc(a.phone)}` : ''}${customerContactsText(a) ? `<br>${esc(customerContactsText(a))}` : ''}</td><td>${esc(specialsText(a))}</td><td>${(a.confirmations ?? []).map((k) => `✓ ${k.at ? `${dateDe(k.at)} ` : ''}${esc(k.text)}`).join('<br>')}</td></tr>`,
      )
      .join('');
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Jahresplaner ${y}</title><style>
@page{size:A4 landscape;margin:8mm}body{font-family:Inter,system-ui,Arial,sans-serif;margin:0;color:#1c1917}
.bar{padding:10px;text-align:center;border-bottom:1px solid #ddd}.bar button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#7D1435;color:#fff}
.hd{display:flex;justify-content:space-between;align-items:flex-end;padding:8px 4px}.hd h1{color:#6b1a21;font-size:28px;margin:0}.hd .k{color:#777;font-size:12px}
.yp{width:100%;border-collapse:collapse;table-layout:fixed;font-size:7px}.yp th{background:#6b1a21;color:#fff;font-size:8px;padding:3px}
.yp td{border:1px solid #ddd;height:15px;padding:1px 2px;vertical-align:top;overflow:hidden;white-space:nowrap}.yp td.x{background:#f6f6f6}
.yp td.sa{background:#ededed}.yp td.so{background:#fadcdc}.yp td.fe{box-shadow:inset 3px 0 0 #2a6bb8}.n{font-weight:700}.w{color:#888;margin-left:2px}
.e{display:block;font-size:6.2px;overflow:hidden;text-overflow:ellipsis}.t-team_a{color:#6b1a21;font-weight:700}.t-team_b{color:#b88c1a;font-weight:700}.t-none{color:#444}
.lg{font-size:9px;color:#555;margin:6px 4px}.pg{page-break-before:always}.ls{width:100%;border-collapse:collapse;font-size:9px}.ls th,.ls td{border-bottom:1px solid #ddd;padding:3px;text-align:left}
@media print{.bar{display:none}}</style></head><body><div class="bar"><button onclick="print()">Drucken / als PDF speichern</button></div>
<div class="hd"><div><img src="/static/logo-transparent.png" alt="Viva-Deluxe" style="height:40px;display:block;margin-bottom:6px"><b>${esc('Viva-Deluxe Gebäudereinigung GmbH')}</b><div class="k">Glasreinigung</div></div><div style="text-align:right"><h1>${y}</h1><div class="k">${esc(kname ?? 'Jahresplaner')}</div></div></div>
${grid}<div class="lg">Rosa = Sonn-/Feiertag · Grau = Samstag · blauer Rand = Schulferien Bayern · <span class="t-team_a">${esc(teams.team_a)}</span> · <span class="t-team_b">${esc(teams.team_b)}</span> · Alle Angaben ohne Gewähr</div>
<div class="pg"><h2>Terminübersicht ${y}${kname ? ` · ${esc(kname)}` : ''}</h2><table class="ls"><thead><tr><th>Datum</th><th>Uhrzeit</th><th>Objekt</th><th>Kunde</th><th>Adresse</th><th>Hausmeister / Ansprechpartner</th><th>Besonderheiten</th><th>Bestätigung</th></tr></thead><tbody>${listRows}</tbody></table></div>
</body></html>`);
  });

  // ------------------------------------------------------------------ Offene Planung
  app.get('/glasreinigung/planung', async (c) => {
    const cy = Number(todayBerlin().slice(0, 4));
    const y = Number(c.req.query('jahr')) || cy;
    const plan = await openPlanning(sql, y);
    const open = plan.filter((p) => p.open > 0);
    const done = plan.filter((p) => p.open === 0);
    const sum = open.reduce((a, p) => a + p.open, 0);
    const hours = open.reduce((a, p) => a + p.restHours, 0);
    return page(
      c,
      'Glasreinigung – Offene Planung',
      'disposition',
      <div class="portal">
        {await head(
          c,
          'planung',
          '',
          <a class="btn" href={`/glasreinigung/autoplan?jahr=${y}`}>
            Auto-Plan {y}
          </a>,
        )}
        <div class="toolbar">
          {y > cy && (
            <a class="btn sec" href={`/glasreinigung/planung?jahr=${y - 1}`}>
              ‹
            </a>
          )}
          {[cy, cy + 1, cy + 2, cy + 3].map((j) => (
            <a class={`pill${j === y ? ' on' : ''}`} href={`/glasreinigung/planung?jahr=${j}`}>
              {j}
            </a>
          ))}
          {y < cy + 3 && (
            <a class="btn sec" href={`/glasreinigung/planung?jahr=${y + 1}`}>
              ›
            </a>
          )}
        </div>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-num">{open.length}</div>
            <div class="stat-lbl">Objekte mit offenen Terminen</div>
          </div>
          <div class="stat-card tone-warn">
            <div class="stat-num">{sum}</div>
            <div class="stat-lbl">Termine noch zu vergeben</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">~{Math.round(hours)} h</div>
            <div class="stat-lbl">geschätzter Restaufwand</div>
          </div>
        </div>
        <h3>Noch zu verplanen ({y})</h3>
        <div class="list-cards">
          {open.map((p) => (
            <div class="lc">
              <div class="lc-head">
                <div>
                  <span class="lc-name">{p.o.name}</span>
                  <div class="lc-sub">{[p.o.customer_name, p.o.address].filter(Boolean).join(' · ')}</div>
                </div>
                <div class="lc-right">
                  <span class="badge warn">{p.open} Termine offen</span>
                  <span class="badge">~{Math.round(p.restHours)} h Rest</span>
                </div>
              </div>
              {p.units.map((u) => (
                <div class="gp-unit">
                  <span>
                    <b>{u.label}</b> · {u.ist}/{u.perYear} verplant · {u.open} offen · ~
                    {Math.round(u.restHours)} h
                  </span>
                  {u.open > 0 && (
                    <a
                      class="btn sm sec"
                      href={`/glasreinigung/termin/${randomUUID()}?objekt=${p.o.id}&datum=${y}-01-08`}
                    >
                      + Termin
                    </a>
                  )}
                </div>
              ))}
              <div class="lc-foot gp-acts">
                <a class="btn sm sec" href={`/glasreinigung/objekte/${p.o.id}`}>
                  Objekt öffnen
                </a>
              </div>
            </div>
          ))}
        </div>
        {done.length > 0 && (
          <details style="margin-top:16px">
            <summary>
              <b>Vollständig verplant ({done.length})</b>
            </summary>
            {done.map((p) => (
              <div class="gp-unit">
                <span>{p.o.name}</span>
                <span class="small mut">
                  {p.units.reduce((a, u) => a + u.ist, 0)}/{p.units.reduce((a, u) => a + u.perYear, 0)}{' '}
                  verplant
                </span>
              </div>
            ))}
          </details>
        )}
      </div>,
    );
  });

  // ------------------------------------------------------------------ Auto-Plan
  app.get('/glasreinigung/autoplan', async (c) => {
    const cy = Number(todayBerlin().slice(0, 4));
    const y = Number(c.req.query('jahr')) || cy + 1;
    const run = c.req.query('los') === '1';
    const sel = c.req.queries('o') ?? [];
    const sat = c.req.query('sa') === '1';
    const plan = (await openPlanning(sql, y)).filter((p) => p.open > 0);
    const teams = await teamNames(sql);
    const proposals = run ? await autoPlan(sql, { year: y, objectIds: sel, saturday: sat }) : [];
    const byDay = new Map<string, typeof proposals>();
    for (const p of proposals) byDay.set(p.days[0]!.date, [...(byDay.get(p.days[0]!.date) ?? []), p]);
    return page(
      c,
      'Auto-Planung',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/glasreinigung/planung">Glasreinigung · Offene Planung</a>
            </div>
            <h1>Auto-Planung – Schritt {run ? 2 : 1} / 2</h1>
            <div class="sub">Jahr {y}</div>
          </div>
        </div>
        {!run ? (
          <form method="get" action="/glasreinigung/autoplan" class="card">
            <input type="hidden" name="jahr" value={String(y)} />
            <input type="hidden" name="los" value="1" />
            <p class="small mut">
              Objekte mit offenen Terminen in {y}. Vorschläge nach Wunschmonaten, Ferien-Präferenz,
              Wochenlast, max. 8 h je Tag, kurze Wege (gleiche PLZ am selben Tag) und mindestens 120 Tage
              Abstand je Objekt.
            </p>
            {plan.length === 0 && <p>Alles verplant.</p>}
            {plan.map((p) => (
              <label class="gp-pick">
                <input type="checkbox" name="o" value={p.o.id} checked />
                <span>
                  <b>{p.o.name}</b>{' '}
                  <span class="small mut">
                    {p.o.customer_name} · {p.open} offen · {HOLIDAY_PREF[p.o.holiday_pref]}
                  </span>
                </span>
              </label>
            ))}
            <label class="chk" style="margin-top:10px">
              <input type="checkbox" name="sa" value="1" /> Samstage erlauben (sonst nur Mo–Fr)
            </label>
            <div class="formfoot">
              <button class="btn" disabled={!plan.length}>
                Plan generieren ({plan.length})
              </button>
            </div>
          </form>
        ) : (
          <form method="post" action="/glasreinigung/autoplan" class="card">
            <input type="hidden" name="jahr" value={String(y)} />
            <input type="hidden" name="sa" value={sat ? '1' : ''} />
            {sel.map((o) => (
              <input type="hidden" name="o" value={o} />
            ))}
            <div class="stat-grid">
              <div class="stat-card">
                <div class="stat-num">{proposals.length}</div>
                <div class="stat-lbl">Termine</div>
              </div>
              <div class="stat-card">
                <div class="stat-num">{new Set(proposals.map((p) => p.days[0]!.date)).size}</div>
                <div class="stat-lbl">Einsatztage</div>
              </div>
            </div>
            {[...byDay.entries()].map(([d, list]) => (
              <div class="gp-unit">
                <b>
                  {WD[isoWeekday(d) - 1]} {dateDe(d)}
                  {schoolHoliday(d) ? ' · Ferien' : ''}
                </b>
                <span>
                  {list.map((p) => (
                    <div class="small">
                      {p.days.map((x) => `${x.from}–${x.to}`).join(', ')} · {p.objectName}
                      {p.part ? ` (${p.part})` : ''} · {teams[p.team]} · {p.hours} h
                      {p.days.length > 1 ? ` · ${p.days.length} Tage` : ''}
                    </div>
                  ))}
                </span>
              </div>
            ))}
            <div class="formfoot">
              <a class="btn sec" href={`/glasreinigung/autoplan?jahr=${y}`}>
                Zurück
              </a>
              <button class="btn" disabled={!proposals.length}>
                ✓ Alle {proposals.length} Termine übernehmen
              </button>
            </div>
          </form>
        )}
      </div>,
    );
  });

  app.post('/glasreinigung/autoplan', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const y = Number(str(b, 'jahr'));
    const proposals = await autoPlan(sql, {
      year: y,
      objectIds: arr(b, 'o'),
      saturday: str(b, 'sa') === '1',
    });
    const n = await applyProposals(sql, proposals, c.get('actor'));
    return back(c, `/glasreinigung/planung?jahr=${y}`, { ok: `${n} Termine übernommen.` });
  });

  // ------------------------------------------------------------------ Kunden
  app.get('/glasreinigung/kunden', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const all = await listCustomers(sql);
    const list = all.filter(
      (k) =>
        !q ||
        [
          k.name,
          k.address,
          k.note,
          ...k.contacts.map((p) => `${p.name} ${p.telefon ?? ''} ${p.email ?? ''}`),
        ].some((v) => (v ?? '').toLowerCase().includes(q)),
    );
    return page(
      c,
      'Glasreinigung – Kunden',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Vor Ort</div>
            <h1>Glasreinigung – Kunden</h1>
            <div class="sub">Kunden und ihre Objekte für die Glasreinigungs-Planung.</div>
          </div>
          <div class="acts">
            <a class="btn" href={`/glasreinigung/kunden/${randomUUID()}`}>
              + Neuer Kunde
            </a>
          </div>
        </div>
        <GpTabs active="kunden" />
        <form class="toolbar" method="get" action="/glasreinigung/kunden">
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Kunde, Adresse, Ansprechpartner…"
          />
          <button class="btn sec">Suchen</button>
          {q && (
            <a class="btn sec" href="/glasreinigung/kunden">
              zurücksetzen
            </a>
          )}
          <span class="mut small">
            {list.length} von {all.length}
          </span>
        </form>
        {list.length === 0 && <div class="empty">Keine Kunden gefunden.</div>}
        <div class="list-cards">
          {list.map((k) => (
            <a class="lc" href={`/glasreinigung/kunden/${k.id}`}>
              <div class="lc-head">
                <span class="lc-name">{k.name}</span>
                <span class="badge">{k.objects} Objekte</span>
                {!k.customer_id && <span class="badge warn">nicht mit Kunde verknüpft</span>}
              </div>
              <div class="lc-details">
                {k.address && <span>{k.address}</span>}
                {k.contacts.map((p) => (
                  <span>
                    {p.name}
                    {p.rolle ? ` (${p.rolle})` : ''}
                    {p.telefon ? ` · ${p.telefon}` : ''}
                  </span>
                ))}
              </div>
            </a>
          ))}
        </div>
      </div>,
    );
  });

  app.get(`/glasreinigung/kunden/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const k = (await listCustomers(sql)).find((x) => x.id === id);
    const contacts = [...(k?.contacts ?? []), { name: '', rolle: '', telefon: '', email: '' }];
    const [appCustomers, objs, sites, apps] = await Promise.all([
      sql<{ id: string; customer_no: string; name: string }[]>`
        select id, customer_no, name from app.customers where not coalesce(is_internal, false) order by name`,
      listObjects(sql, { all: true }),
      listSitesForGlass(sql),
      listAppointments(sql),
    ]);
    const mine = objs.filter((o) => o.customer_id === id);
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9äöü]/g, '');
    const suggestCust =
      k && !k.customer_id ? appCustomers.find((x) => norm(x.name) === norm(k.name)) : undefined;
    return page(
      c,
      k ? k.name : 'Neuer Kunde',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/glasreinigung/kunden">Glasreinigung – Kunden</a>
            </div>
            <h1>{k ? k.name : 'Neuer Kunde'}</h1>
          </div>
        </div>
        <form method="post" action={`/glasreinigung/kunden/${id}`} class="card" style="max-width:860px">
          <div class="grid">
            <div>
              <label for="name">Kundenname *</label>
              <input id="name" name="name" value={k?.name ?? ''} required />
            </div>
            <div>
              <label for="appkunde">Kunde in der App</label>
              <select id="appkunde" name="app_kunde">
                <option value="">— nicht verknüpft —</option>
                {appCustomers.map((x) => (
                  <option value={x.id} selected={(k?.customer_id ?? suggestCust?.id) === x.id}>
                    {x.customer_no} · {x.name}
                  </option>
                ))}
              </select>
              {suggestCust && <div class="small mut">Vorschlag nach Namen – mit „Speichern“ übernehmen.</div>}
            </div>
            <div>
              <label for="adr">Adresse (Hauptsitz)</label>
              <input id="adr" name="adresse" value={k?.address ?? ''} />
            </div>
            <div>
              <label for="notiz">Notiz</label>
              <textarea id="notiz" name="notiz" rows={2}>
                {k?.note ?? ''}
              </textarea>
            </div>
          </div>
          <label style="margin-top:12px">Ansprechpartner (leere Zeile = entfernen)</label>
          {contacts.map((p, i) => (
            <div class="gp-ap">
              <input
                name="ap_name"
                value={p.name}
                placeholder="Name *"
                aria-label={`Ansprechpartner ${i + 1}`}
              />
              <input
                name="ap_rolle"
                value={p.rolle ?? ''}
                placeholder="Rolle (z.B. Verwaltung)"
                aria-label="Rolle"
              />
              <input name="ap_tel" value={p.telefon ?? ''} placeholder="Telefon" aria-label="Telefon" />
              <input name="ap_mail" value={p.email ?? ''} placeholder="E-Mail" aria-label="E-Mail" />
            </div>
          ))}
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href="/glasreinigung/kunden">
              Abbrechen
            </a>
          </div>
        </form>
        {k && (
          <section class="card" style="max-width:860px;margin-top:14px">
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
              <h3 style="margin:0">Objekte ({mine.length})</h3>
              <a class="btn sm" href={`/glasreinigung/objekte/${randomUUID()}?kunde=${id}`}>
                + Objekt
              </a>
            </div>
            {mine.length === 0 ? (
              <div class="empty">Noch keine Objekte.</div>
            ) : (
              <table class="tbl keep" style="margin-top:8px">
                <thead>
                  <tr>
                    <th>Objekt</th>
                    <th>Kostenstelle</th>
                    <th>Turnus</th>
                    <th>Nächster Termin</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((o) => {
                    const sug = o.site_id ? null : suggestSite(o, sites, k.customer_id);
                    const nx = apps.find((a) => a.object_id === o.id && !a.done);
                    return (
                      <tr class={o.active ? '' : 'mut'}>
                        <td>
                          <a href={`/glasreinigung/objekte/${o.id}`}>{o.name}</a>
                          <div class="small mut">{o.address}</div>
                          {!o.active && <span class="badge">inaktiv</span>}
                        </td>
                        <td>
                          {o.site_id ? (
                            <a href={`/objekte/${o.site_id}`}>
                              {o.site_no} · {o.site_name}
                            </a>
                          ) : (
                            <>
                              <span class="badge warn">nicht verknüpft</span>
                              {sug && (
                                <div class="small mut">
                                  Vorschlag: {sug.site_no} · {sug.name}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td>{PER_YEAR.find(([v]) => v === o.per_year)?.[1]}</td>
                        <td>{nx ? dateDe(nx.first_day) : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p class="small mut">
              <a href={`/glasreinigung?kunde=${id}&status=alle`}>Alle Termine dieses Kunden →</a>
            </p>
          </section>
        )}
      </div>,
    );
  });

  app.post(`/glasreinigung/kunden/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const names = arr(b, 'ap_name');
    const roles = arr(b, 'ap_rolle');
    const tels = arr(b, 'ap_tel');
    const mails = arr(b, 'ap_mail');
    await saveCustomer(sql, c.req.param('id'), {
      name: str(b, 'name') ?? '',
      address: str(b, 'adresse'),
      note: str(b, 'notiz'),
      customerId: str(b, 'app_kunde'),
      contacts: names.map((n, i) => ({
        name: n.trim(),
        rolle: roles[i]?.trim(),
        telefon: tels[i]?.trim(),
        email: mails[i]?.trim(),
      })),
    });
    return back(c, `/glasreinigung/kunden/${c.req.param('id')}`, { ok: 'Kunde gespeichert.' });
  });

  // ------------------------------------------------------------------ Objekte
  app.get('/glasreinigung/objekte', async (c) => {
    const today = todayBerlin();
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const kunde = c.req.query('kunde') ?? '';
    const stat = c.req.query('status') ?? 'aktiv';
    const link = c.req.query('kst') ?? '';
    const [allObjs, apps, teams, customers] = await Promise.all([
      listObjects(sql, { all: true }),
      listAppointments(sql),
      teamNames(sql),
      listCustomers(sql),
    ]);
    const objs = allObjs.filter(
      (o) =>
        (stat === 'alle' || (stat === 'inaktiv' ? !o.active : o.active)) &&
        (!kunde || o.customer_id === kunde) &&
        (!link || (link === 'ohne' ? !o.site_id : !!o.site_id)) &&
        (!q ||
          [o.name, o.address, o.customer_name, o.caretaker_name, o.site_no, o.wishes, o.note].some((v) =>
            (v ?? '').toLowerCase().includes(q),
          )),
    );
    const unlinked = allObjs.filter((o) => o.active && !o.site_id).length;
    const nextOf = (o: GlassObject) => apps.find((a) => a.object_id === o.id && !a.done);
    const countOf = (o: GlassObject) => apps.filter((a) => a.object_id === o.id).length;
    const missing = objs.filter((o) => o.active && (!o.hours || !o.team)).length;
    return page(
      c,
      'Glasreinigung – Objekte',
      'disposition',
      <div class="portal">
        {await head(
          c,
          'objekte',
          '',
          <a class="btn" href={`/glasreinigung/objekte/${randomUUID()}`}>
            + Neues Objekt
          </a>,
        )}
        <form class="toolbar" method="get" action="/glasreinigung/objekte">
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Objekt, Adresse, Hausmeister…"
          />
          <select name="kunde" onchange="this.form.submit()" aria-label="Kunde" style="max-width:240px">
            <option value="">Alle Kunden</option>
            {customers.map((k) => (
              <option value={k.id} selected={kunde === k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <select
            name="status"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Status"
            style="max-width:150px"
          >
            <option value="aktiv">Aktive</option>
            <option value="inaktiv" selected={stat === 'inaktiv'}>
              Inaktive
            </option>
            <option value="alle" selected={stat === 'alle'}>
              Alle
            </option>
          </select>
          <select
            name="kst"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Kostenstelle"
            style="max-width:220px"
          >
            <option value="">Kostenstelle: alle</option>
            <option value="ohne" selected={link === 'ohne'}>
              nicht verknüpft ({unlinked})
            </option>
            <option value="mit" selected={link === 'mit'}>
              verknüpft
            </option>
          </select>
          <a class="btn sec" href="/glasreinigung/objekte">
            zurücksetzen
          </a>
          <span class="mut small">
            {objs.length} von {allObjs.length}
          </span>
        </form>
        {objs.length === 0 && <div class="empty">Keine Objekte passen zu dieser Auswahl.</div>}
        {missing > 0 && (
          <div class="due-banner warn">
            <span class="ico">!</span>
            <span>{missing} Objekte ohne Stunden oder Team – für die Auto-Planung bitte ergänzen.</span>
          </div>
        )}
        <div class="list-cards">
          {objs.map((o) => {
            const n = nextOf(o);
            const plan = o.wish_months
              .map((ms, i) => `T${i + 1}: ${ms.map((m) => MONTHS_LONG[m - 1]).join('/')}`)
              .join(' · ');
            return (
              <div class={`lc${o.active ? '' : ' lc-inactive'}`}>
                <div class="lc-head">
                  <div>
                    <a class="lc-name" href={`/glasreinigung/objekte/${o.id}`}>
                      {o.name}
                    </a>
                    <div class="lc-sub">
                      {[o.customer_name, o.address, o.district].filter(Boolean).join(' · ')}
                    </div>
                    <div class="small">
                      {o.site_id ? (
                        <a href={`/objekte/${o.site_id}`}>
                          Kostenstelle {o.site_no} · {o.site_name}
                        </a>
                      ) : (
                        <span class="badge warn">nicht mit Objekt/Kostenstelle verknüpft</span>
                      )}
                    </div>
                  </div>
                  <div class="lc-right">
                    {teamBadge(o.team, teams)}
                    {o.needs_police_cert && <span class="badge warn">Führungszeugnis</span>}
                    {o.needs_lift && <span class="badge warn">Hebebühne</span>}
                    {o.needs_other && <span class="badge">{o.needs_other}</span>}
                    {!o.active && <span class="badge">inaktiv</span>}
                  </div>
                </div>
                <div class="lc-details">
                  {o.caretaker_name && (
                    <span>
                      Hausmeister: {o.caretaker_name}
                      {o.caretaker_phone ? ` · ${o.caretaker_phone}` : ''}
                    </span>
                  )}
                  <span>
                    {PER_YEAR.find(([v]) => v === o.per_year)?.[1]}
                    {plan ? ` — ${plan}` : ''}
                  </span>
                  {o.holiday_pref !== 'egal' && <span>{HOLIDAY_PREF[o.holiday_pref]}</span>}
                  {o.hours && <span>{String(o.hours).replace('.', ',')} h</span>}
                </div>
                {o.wishes && <div class="gp-note">Besonderheiten: {o.wishes}</div>}
                <div class="lc-foot gp-acts">
                  <span class={`small ${n && n.first_day < today ? 'kb-neg' : 'mut'}`}>
                    {n ? `Nächster Termin: ${dateDe(n.first_day)}` : 'Kein Termin geplant'}
                  </span>
                  <a
                    class="btn sm sec"
                    href={`/glasreinigung?status=alle&q=${encodeURIComponent(o.name)}${o.customer_id ? `&kunde=${o.customer_id}` : ''}`}
                  >
                    Termine ({countOf(o)})
                  </a>
                  <a class="btn sm sec" href={`/glasreinigung/termin/${randomUUID()}?objekt=${o.id}`}>
                    + Termin
                  </a>
                  <a class="btn sm sec" href={`/glasreinigung/objekte/${o.id}`}>
                    Bearbeiten
                  </a>
                </div>
              </div>
            );
          })}
        </div>
        <form
          method="post"
          action="/glasreinigung/teams"
          class="card"
          style="margin-top:18px;max-width:560px"
        >
          <h3>Teamnamen</h3>
          <div class="grid">
            <div>
              <label for="ta">Team A</label>
              <input id="ta" name="a" value={teams.team_a} />
            </div>
            <div>
              <label for="tb">Team B</label>
              <input id="tb" name="b" value={teams.team_b} />
            </div>
          </div>
          <div class="formfoot">
            <button class="btn sec">Speichern</button>
          </div>
        </form>
      </div>,
    );
  });

  app.post('/glasreinigung/teams', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveTeamNames(sql, str(b, 'a') ?? '', str(b, 'b') ?? '');
    return back(c, '/glasreinigung/objekte', { ok: 'Teamnamen gespeichert.' });
  });

  app.get(`/glasreinigung/objekte/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [o, customers, teams, sites] = await Promise.all([
      getObject(sql, id),
      listCustomers(sql),
      teamNames(sql),
      listSitesForGlass(sql),
    ]);
    const gk = customers.find((k) => k.id === (o?.customer_id ?? c.req.query('kunde')));
    const sug = o && !o.site_id ? suggestSite(o, sites, gk?.customer_id ?? null) : null;
    const selSite = o?.site_id ?? sug?.id ?? '';
    // Objekte des verknüpften Kunden zuerst
    const siteOpts = [
      ...sites.filter((x) => x.customer_id === gk?.customer_id),
      ...sites.filter((x) => x.customer_id !== gk?.customer_id && (x.active || x.id === selSite)),
    ];
    const cy = Number(todayBerlin().slice(0, 4));
    const per = o?.per_year ?? 2;
    const parts = [...(o?.parts ?? []), { name: '', per_year: 1, hours: 0 }];
    return page(
      c,
      o ? 'Objekt bearbeiten' : 'Neues Objekt',
      'disposition',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/glasreinigung/objekte">Glasreinigung – Objekte</a>
            </div>
            <h1>{o ? o.name : 'Neues Objekt'}</h1>
          </div>
        </div>
        <form method="post" action={`/glasreinigung/objekte/${id}`} class="card" style="max-width:900px">
          <input type="hidden" name="version" value={String(o?.version ?? '')} />
          <div class="grid">
            <div>
              <label for="kunde">Kunde *</label>
              <select id="kunde" name="kunde" required>
                <option value="">— Kunde wählen —</option>
                {customers.map((k) => (
                  <option value={k.id} selected={o?.customer_id === k.id || c.req.query('kunde') === k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="site">Objekt in der App (Kostenstelle)</label>
              <select id="site" name="site">
                <option value="">— nicht verknüpft —</option>
                <SiteOptions sites={siteOpts} selected={selSite} />
              </select>
              {sug && (
                <div class="small mut">
                  Vorschlag (gleiche Adresse): {sug.site_no} · {sug.name} – mit „Speichern“ übernehmen.
                </div>
              )}
            </div>
            <div>
              <label for="name">Objektname *</label>
              <input
                id="name"
                name="name"
                value={o?.name ?? ''}
                required
                placeholder="z.B. Hauptsitz, Filiale Schwabing, Halle 2"
              />
            </div>
            <div>
              <label for="adr">Adresse *</label>
              <input
                id="adr"
                name="adresse"
                value={o?.address ?? ''}
                required
                placeholder="Straße, PLZ Ort"
              />
            </div>
            <div>
              <label for="bez">Bezirk / Stadtteil (leer = aus PLZ)</label>
              <input
                id="bez"
                name="bezirk"
                value={o?.district ?? ''}
                placeholder={districtOf(plzOf(o?.address)) ?? 'wird aus PLZ vorgeschlagen'}
              />
            </div>
            <div>
              <label for="hm">Hausmeister</label>
              <input id="hm" name="hm_name" value={o?.caretaker_name ?? ''} placeholder="Name" />
            </div>
            <div>
              <label for="hmt">Hausmeister Telefon</label>
              <input id="hmt" name="hm_tel" value={o?.caretaker_phone ?? ''} />
            </div>
            <div>
              <label for="hme">Hausmeister E-Mail</label>
              <input id="hme" name="hm_mail" type="email" value={o?.caretaker_email ?? ''} />
            </div>
            <div>
              <label for="freq">Frequenz pro Jahr</label>
              <select id="freq" name="frequenz" data-nosearch>
                {PER_YEAR.map(([v, l]) => (
                  <option value={String(v)} selected={per === v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label style="margin-top:12px">Wunsch-Monate pro Termin</label>
          <div class="gp-wish">
            {Array.from({ length: 4 }, (_, i) => (
              <div>
                <span class="small mut">Termin {i + 1}</span>
                <div class="gp-months">
                  {MONTHS.map((mn, mi) => (
                    <label>
                      <input
                        type="checkbox"
                        name={`wm_${i}`}
                        value={String(mi + 1)}
                        checked={!!o?.wish_months[i]?.includes(mi + 1)}
                      />
                      <span>{mn}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label style="margin-top:12px">Optionale Teilbereiche mit eigenem Turnus</label>
          <div id="gp-parts">
            {parts.map((p, i) => (
              <div class="gp-ap">
                <input
                  name="tb_name"
                  value={p.name}
                  placeholder="Bereich (z.B. Oberlichter)"
                  aria-label={`Teilbereich ${i + 1}`}
                />
                <select name="tb_freq" data-nosearch aria-label="Turnus">
                  {PER_YEAR.map(([v, l]) => (
                    <option value={String(v)} selected={p.per_year === v}>
                      {l}
                    </option>
                  ))}
                </select>
                <input
                  name="tb_std"
                  value={p.hours ? String(p.hours).replace('.', ',') : ''}
                  placeholder="Std."
                  aria-label="Stunden"
                  inputmode="decimal"
                />
              </div>
            ))}
          </div>
          <button type="button" class="btn sm sec" id="gp-add-part" style="margin-top:6px">
            + weiteren Teilbereich
          </button>
          <script
            dangerouslySetInnerHTML={{
              __html: `document.getElementById('gp-add-part').addEventListener('click',function(){var b=document.getElementById('gp-parts'),r=b.lastElementChild.cloneNode(true);r.querySelectorAll('input').forEach(function(i){i.value=''});r.querySelector('select').selectedIndex=0;b.appendChild(r);r.querySelector('input').focus()});`,
            }}
          />
          <div class="grid" style="margin-top:12px">
            <div>
              <label for="jahr">Jahr</label>
              <select id="jahr" name="jahr" data-nosearch>
                {[cy, cy + 1, cy + 2].map((j) => (
                  <option value={String(j)} selected={(o?.plan_year ?? cy + 1) === j}>
                    {j}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="fer">Ferien-Präferenz</label>
              <select id="fer" name="ferien" data-nosearch>
                {Object.entries(HOLIDAY_PREF).map(([k, l]) => (
                  <option value={k} selected={(o?.holiday_pref ?? 'egal') === k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div class="chk">
              <span class="small mut">Anforderungen am Objekt</span>
              <label>
                <input type="checkbox" name="fz" value="1" checked={!!o?.needs_police_cert} /> Führungszeugnis
              </label>
              <label>
                <input type="checkbox" name="hb" value="1" checked={!!o?.needs_lift} /> Hebebühne
              </label>
              <input
                name="sonst"
                value={o?.needs_other ?? ''}
                placeholder="Sonstiges"
                aria-label="Sonstige Anforderung"
              />
            </div>
            <div>
              <label for="team">Team-Zuordnung *</label>
              <select id="team" name="team" data-nosearch required>
                <option value="">— bitte wählen —</option>
                <option value="team_a" selected={o?.team === 'team_a'}>
                  {teams.team_a}
                </option>
                <option value="team_b" selected={o?.team === 'team_b'}>
                  {teams.team_b}
                </option>
              </select>
            </div>
            <div>
              <label for="sw">Sonderwünsche / Besonderheiten</label>
              <textarea id="sw" name="wuensche" rows={2}>
                {o?.wishes ?? ''}
              </textarea>
            </div>
            <div>
              <label for="std">Gesamtarbeitsstunden</label>
              <input
                id="std"
                name="stunden"
                inputmode="decimal"
                value={o?.hours ? String(o.hours).replace('.', ',') : ''}
              />
              <div class="small mut">
                ≤ 9 h = 1 Tag ab 08:00 · sonst je 8 h (08–16 Uhr) auf Werktage verteilt
              </div>
            </div>
            <div>
              <label for="sm">Standard-Mitarbeiter (optional)</label>
              <input id="sm" name="mitarbeiter" value={o?.default_staff ?? ''} />
            </div>
            <div>
              <label for="notiz">Allgemeine Notizen</label>
              <textarea id="notiz" name="notiz" rows={2}>
                {o?.note ?? ''}
              </textarea>
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href="/glasreinigung/objekte">
              Abbrechen
            </a>
          </div>
        </form>
        {o && (
          <form method="post" action={`/glasreinigung/objekte/${id}/aktiv`} style="margin-top:8px">
            <input type="hidden" name="aktiv" value={o.active ? '' : '1'} />
            <button class="btn sm sec">
              {o.active ? 'Objekt deaktivieren' : 'Objekt wieder aktivieren'}
            </button>
          </form>
        )}
      </div>,
    );
  });

  app.post(`/glasreinigung/objekte/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const per = Number(str(b, 'frequenz') ?? 1);
    const wish: number[][] = [];
    for (let i = 0; i < 4; i++) {
      const ms = arr(b, `wm_${i}`)
        .map(Number)
        .filter((m) => m >= 1 && m <= 12);
      if (ms.length) wish[i] = ms;
    }
    const names = arr(b, 'tb_name');
    const freqs = arr(b, 'tb_freq');
    const stds = arr(b, 'tb_std');
    const parts = names
      .map((n, i) => ({ name: n.trim(), per_year: Number(freqs[i] ?? 1), hours: num(stds[i] ?? '') ?? 0 }))
      .filter((p) => p.name);
    const hours = num(str(b, 'stunden'));
    if (str(b, 'stunden') && hours == null) throw new BusinessError('Gesamtarbeitsstunden ungültig');
    await saveObject(sql, id, {
      customer_id: str(b, 'kunde'),
      name: str(b, 'name') ?? '',
      address: str(b, 'adresse'),
      district: str(b, 'bezirk'),
      postal_code: null,
      caretaker_name: str(b, 'hm_name'),
      caretaker_phone: str(b, 'hm_tel'),
      caretaker_email: str(b, 'hm_mail'),
      contact_name: null,
      contact_phone: null,
      contact_email: null,
      per_year: per,
      parts,
      wish_months: Array.from({ length: wish.length }, (_, i) => wish[i] ?? []),
      plan_year: Number(str(b, 'jahr')) || null,
      holiday_pref: str(b, 'ferien') ?? 'egal',
      needs_police_cert: str(b, 'fz') === '1',
      needs_lift: str(b, 'hb') === '1',
      needs_other: str(b, 'sonst'),
      team: (str(b, 'team') as 'team_a' | 'team_b' | null) ?? null,
      hours: hours == null ? null : String(hours),
      default_staff: str(b, 'mitarbeiter'),
      wishes: str(b, 'wuensche'),
      note: str(b, 'notiz'),
      site_id: str(b, 'site'),
      expectedVersion: num(str(b, 'version')),
    });
    return back(c, '/glasreinigung/objekte', { ok: 'Objekt gespeichert.' });
  });

  app.post(`/glasreinigung/objekte/:id{${UUID}}/aktiv`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setObjectActive(sql, c.req.param('id'), str(b, 'aktiv') === '1');
    return back(c, '/glasreinigung/objekte', { ok: 'Gespeichert.' });
  });
}
