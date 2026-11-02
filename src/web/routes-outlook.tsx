import type { Child } from 'hono/jsx';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  CAL_COLORS,
  type CalEvent,
  type CalRef,
  type EventInput,
  type ExchangeAccount,
  type FolderInfo,
  REMINDERS,
  connectAccount,
  createEvent,
  dateToBerlin,
  deleteEvent,
  disconnectAccount,
  getAccount,
  getEvent,
  listAccounts,
  listEvents,
  listFolders,
  probeSharedCalendar,
  saveCalendars,
  shownCalendars,
  updateEvent,
} from '../services/exchange-calendar.js';
import type { Ctx } from './app.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead } from './layout.js';

/*
 * Outlook-Kalender in der App (Ahmed 01.11.): eigenes Exchange-Postfach verbinden, Kalender ansehen (Woche, Monat,
 * Liste), Termine mit Ort, Notiz und Erinnerung anlegen, ändern, löschen. Nichts wird automatisch eingetragen.
 * Mehrere Konten je Benutzer, je Konto mehrere Kalender (Unterkalender, freigegebene) mit eigener Farbe (02.11.).
 */

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const deDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const mondayOf = (d: string) => addDays(d, -weekday(d));
const BUSY: [EventInput['busy'], string][] = [
  ['Busy', 'Gebucht'],
  ['Tentative', 'Mit Vorbehalt'],
  ['Free', 'Frei'],
  ['OOF', 'Abwesend'],
];

/** Termine je Tag (Ortszeit); mehrtägige stehen an jedem Tag. */
function byDay(events: CalEvent[], from: string, to: string) {
  const map = new Map<string, CalEvent[]>();
  for (let d = from; d < to; d = addDays(d, 1)) map.set(d, []);
  for (const e of events) {
    const s = dateToBerlin(e.start).date;
    // Ende ist exklusiv (ganztägig: Mitternacht des Folgetags)
    const last = dateToBerlin(new Date(e.end.getTime() - 1)).date;
    for (let d = s < from ? from : s; d <= last && d < to; d = addDays(d, 1)) map.get(d)?.push(e);
  }
  return map;
}
const timeLabel = (e: CalEvent) =>
  e.allDay ? 'ganztägig' : `${dateToBerlin(e.start).time}–${dateToBerlin(e.end).time}`;

const CSS = `
.olk-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.olk-bar .ttl{font-weight:650;font-size:17px;margin:0 6px}
.olk-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.olk-day{background:#fff;border:1px solid var(--line);border-radius:10px;min-height:150px;padding:8px;display:flex;flex-direction:column;gap:6px}
.olk-day.today{border-color:var(--brand);box-shadow:inset 0 3px 0 var(--brand)}
.olk-day h4{margin:0;font-size:13px;display:flex;justify-content:space-between;align-items:center}
.olk-day h4 a{font-weight:400;text-decoration:none;font-size:18px;line-height:1}
.olk-ev{display:block;text-decoration:none;color:inherit;border-left:3px solid var(--c,var(--brand));background:color-mix(in srgb,var(--c,#7D1435) 9%,#fff);border-radius:6px;padding:5px 7px;font-size:12.5px;line-height:1.3}
.olk-ev.free{background:#f4f4f5;opacity:.85}
.olk-ev.tent{border-left-style:dashed}
.olk-ev.oof{background:#f3ecf8}
.olk-ev i{font-style:normal;font-size:11px;color:var(--c,var(--ink-3))}
.olk-legend{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:13px;margin:-4px 0 12px}
.olk-legend span{display:inline-flex;align-items:center;gap:6px}
.olk-legend span::before{content:"";width:10px;height:10px;border-radius:3px;background:var(--c)}
.olk-cals{display:grid;gap:4px;margin:8px 0}
.olk-cals label{display:flex;align-items:center;gap:8px}
.olk-cals input[type=color]{width:32px;height:24px;padding:0;border:1px solid var(--line);border-radius:4px;flex:none}
.olk-ev b{display:block;font-weight:600;overflow-wrap:anywhere}
.olk-ev span{color:var(--ink-3)}
.olk-month{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line);background:#fff}
.olk-month>div{border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-height:96px;padding:4px;font-size:12px}
.olk-month .hd{min-height:0;font-weight:600;text-align:center;background:var(--tint-2,#f8eff2)}
.olk-month .out{background:#fafafa;color:var(--ink-3)}
.olk-month .today .dn{background:var(--brand);color:#fff;border-radius:999px;padding:0 6px}
.olk-month .dn{text-decoration:none;color:inherit;font-weight:600}
.olk-month .olk-ev{margin-top:3px;padding:2px 5px;font-size:11.5px}
.olk-month .olk-ev b{display:inline;font-weight:550}
@media (max-width:760px){
  .olk-week{grid-template-columns:1fr}
  .olk-day{min-height:0}
  .olk-month>div{min-height:64px}
  .olk-month .olk-ev b{display:none}
}`;

const FORM_JS = `(function(){var a=document.getElementById('t-allday');function u(){document.querySelectorAll('.olk-time').forEach(function(t){t.hidden=a.checked;t.required=!a.checked})}a.addEventListener('change',u);u();
var sd=document.getElementById('t-date'),ed=document.getElementById('t-edate');sd.addEventListener('change',function(){if(!ed.value||ed.value<sd.value)ed.value=sd.value})})();`;

export function registerOutlookRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  const connectForm = (email: string | null | undefined, note?: Child, title = 'Outlook-Konto verbinden') => (
    <form method="post" action="/kalender/verbinden" class="card" style="max-width:640px">
      <h3 style="margin-top:0">{title}</h3>
      {note}
      <p class="small mut">
        Mit Ihrem IONOS-Exchange-Postfach anmelden (dieselben Zugangsdaten wie in Outlook). Danach sehen Sie
        Ihren Kalender hier und können Termine eintragen – sie erscheinen sofort in Outlook und auf dem Handy.
      </p>
      <div class="grid">
        <label for="olk-mail">E-Mail-Adresse</label>
        <input id="olk-mail" name="email" type="email" required value={email ?? ''} autocomplete="username" />
        <label for="olk-pw">Passwort</label>
        <input id="olk-pw" name="password" type="password" required autocomplete="current-password" />
      </div>
      <details style="margin-top:8px">
        <summary class="small">Erweitert (nur wenn die Verbindung nicht klappt)</summary>
        <div class="grid" style="margin-top:8px">
          <label for="olk-login">Benutzername (falls anders als E-Mail)</label>
          <input id="olk-login" name="login" autocomplete="off" />
          <label for="olk-url">Server-Adresse (EWS)</label>
          <input id="olk-url" name="url" placeholder="z. B. exchange2019.ionos.de" autocomplete="off" />
        </div>
      </details>
      <p class="small mut">
        Das Passwort wird verschlüsselt auf unserem Server gespeichert und nur für Ihren Kalender benutzt.
        Ändern Sie es in IONOS, hier bitte neu verbinden.
      </p>
      <div class="actions">
        <button class="btn">Verbinden</button>
      </div>
    </form>
  );

  // ------------------------------------------------------------ Übersicht
  app.get('/kalender', async (c) => {
    const user = c.get('user');
    const accounts = await listAccounts(sql, user.id);
    if (!accounts.length)
      return page(
        c,
        'Kalender',
        'verwaltung',
        <>
          <PageHead title="Kalender" />
          {connectForm(user.email)}
        </>,
      );

    const view =
      c.req.query('ansicht') === 'monat' ? 'monat' : c.req.query('ansicht') === 'liste' ? 'liste' : 'woche';
    const today = todayBerlin();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('datum') ?? '') ? c.req.query('datum')! : today;
    let from: string;
    let to: string;
    let title: string;
    let prev: string;
    let next: string;
    if (view === 'monat') {
      const first = `${d.slice(0, 7)}-01`;
      const nextMonth = new Date(`${first}T00:00:00Z`);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const nm = nextMonth.toISOString().slice(0, 10);
      const prevMonth = new Date(`${first}T00:00:00Z`);
      prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
      from = mondayOf(first);
      to = addDays(mondayOf(addDays(nm, -1)), 7);
      title = `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
      prev = prevMonth.toISOString().slice(0, 10);
      next = nm;
    } else if (view === 'liste') {
      from = d;
      to = addDays(d, 30);
      title = `${deDate(from)} – ${deDate(addDays(to, -1))}`;
      prev = addDays(d, -30);
      next = to;
    } else {
      from = mondayOf(d);
      to = addDays(from, 7);
      title = `${deDate(from)} – ${deDate(addDays(to, -1))}`;
      prev = addDays(from, -7);
      next = to;
    }

    const { events, errors } = await listEvents(sql, env, user.id, from, to);
    const legend = accounts.flatMap((a, i) => shownCalendars(a, i).map((cal) => ({ ...cal, acc: a.email })));
    const days = byDay(events, from, to);
    const q = (p: Record<string, string>) => `/kalender?${new URLSearchParams({ ansicht: view, ...p })}`;
    const cls = (e: CalEvent) =>
      `olk-ev${e.busy === 'Free' ? ' free' : e.busy === 'Tentative' ? ' tent' : e.busy === 'OOF' ? ' oof' : ''}`;
    const evLink = (e: CalEvent, full: boolean) => (
      <a
        class={cls(e)}
        style={e.color ? `--c:${e.color}` : undefined}
        title={e.calName || undefined}
        href={`/kalender/termin?konto=${e.acc ?? ''}&id=${encodeURIComponent(e.id)}&zurueck=${encodeURIComponent(q({ datum: d }))}`}
      >
        {full ? (
          <>
            <span>
              {timeLabel(e)}
              {e.recurring ? ' ↻' : ''}
              {e.reminder !== null && <Icon name="bell" size={12} />}
            </span>
            <b>{e.subject}</b>
            {e.location && <span>{e.location}</span>}
            {e.calName && <i>{e.calName}</i>}
          </>
        ) : (
          <>
            {!e.allDay && <span>{dateToBerlin(e.start).time} </span>}
            <b>{e.subject}</b>
          </>
        )}
      </a>
    );

    return page(
      c,
      'Kalender',
      'verwaltung',
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <PageHead title="Kalender">
          <a class="btn sec" href="/kalender/konten">
            Konten &amp; Kalender
          </a>
          <a class="btn" href={`/kalender/neu?datum=${d < from || d >= to ? from : d}`}>
            + Termin
          </a>
        </PageHead>
        <div class="olk-bar">
          <a class="btn sec sm" href={q({ datum: prev })} aria-label="zurück">
            ←
          </a>
          <a class="btn sec sm" href={q({ datum: today })}>
            Heute
          </a>
          <a class="btn sec sm" href={q({ datum: next })} aria-label="weiter">
            →
          </a>
          <span class="ttl">{title}</span>
          <span style="flex:1" />
          <div class="chips" style="margin:0">
            {(
              [
                ['woche', 'Woche'],
                ['monat', 'Monat'],
                ['liste', 'Liste'],
              ] as const
            ).map(([k, l]) => (
              <a class={view === k ? 'on' : ''} href={`/kalender?ansicht=${k}&datum=${d}`}>
                {l}
              </a>
            ))}
          </div>
        </div>
        {legend.length > 1 && (
          <div class="olk-legend">
            {legend.map((l) => (
              <span style={`--c:${l.color}`} title={l.acc}>
                {l.name}
                {accounts.length > 1 ? <small class="mut"> ({l.acc})</small> : ''}
              </span>
            ))}
          </div>
        )}
        {errors.length > 0 && (
          <div class="card" style="border-left:4px solid var(--err);margin-bottom:12px">
            <b>Nicht alles konnte geladen werden:</b>
            <ul style="margin:6px 0 0 18px;padding:0">
              {errors.map((x) => (
                <li>
                  {x.account}
                  {x.calendar ? ` · ${x.calendar}` : ''}: {x.message}
                </li>
              ))}
            </ul>
            <p class="small">
              Passwort geändert? Unter <a href="/kalender/konten">Konten &amp; Kalender</a> das Konto neu
              verbinden.
            </p>
          </div>
        )}
        {view === 'woche' ? (
          <div class="olk-week">
            {[...days].map(([day, list]) => (
              <div class={`olk-day${day === today ? ' today' : ''}`}>
                <h4>
                  <span>
                    {WD[weekday(day)]} {deDate(day).slice(0, 6)}
                  </span>
                  <a href={`/kalender/neu?datum=${day}`} title="Termin an diesem Tag">
                    +
                  </a>
                </h4>
                {list.length ? list.map((e) => evLink(e, true)) : <span class="small mut">–</span>}
              </div>
            ))}
          </div>
        ) : view === 'monat' ? (
          <div class="olk-month">
            {WD.map((w) => (
              <div class="hd">{w}</div>
            ))}
            {[...days].map(([day, list]) => (
              <div
                class={`${day.slice(0, 7) !== d.slice(0, 7) ? 'out' : ''}${day === today ? ' today' : ''}`}
              >
                <a class="dn" href={`/kalender?ansicht=woche&datum=${day}`}>
                  {Number(day.slice(8, 10))}
                </a>
                {list.slice(0, 4).map((e) => evLink(e, false))}
                {list.length > 4 && (
                  <a class="small" href={`/kalender?ansicht=woche&datum=${day}`}>
                    + {list.length - 4} weitere
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div class="card">
            {[...days].filter(([, l]) => l.length).length === 0 && (
              <p class="mut">Keine Termine in den nächsten 30 Tagen.</p>
            )}
            {[...days]
              .filter(([, l]) => l.length)
              .map(([day, list]) => (
                <div style="margin-bottom:12px">
                  <h4 style="margin:0 0 6px">
                    {WD[weekday(day)]}, {deDate(day)}
                    {day === today && ' (heute)'}
                  </h4>
                  <div style="display:grid;gap:6px">{list.map((e) => evLink(e, true))}</div>
                </div>
              ))}
          </div>
        )}
        <p class="small mut" style="margin-top:14px">
          Verbunden: <b>{accounts.map((a) => a.email).join(', ')}</b>. Erinnerungen kommen von Outlook bzw.
          der Mail-App auf dem Handy. Serientermine lassen sich hier nur einzeln (dieses Vorkommen) ändern.
        </p>
      </>,
    );
  });

  // ------------------------------------------------------------ Konten & Kalender
  app.get('/kalender/konten', async (c) => {
    const user = c.get('user');
    const accounts = await listAccounts(sql, user.id);
    const folders = await Promise.all(
      accounts.map(async (a) => {
        try {
          return { list: await listFolders(sql, env, user.id, a.id), error: null as string | null };
        } catch (e) {
          if (!(e instanceof BusinessError)) throw e;
          return { list: [] as FolderInfo[], error: e.message };
        }
      }),
    );
    const accCard = (a: ExchangeAccount, i: number) => {
      const shown = new Map(shownCalendars(a, i).map((x) => [x.id, x]));
      const f = folders[i]!;
      // eigene Ordner + bereits gewählte freigegebene Kalender
      const rows: { id: string; name: string; label: string }[] = [
        ...f.list.map((x) => ({ id: x.id, name: x.name, label: x.path })),
        ...[...shown.values()]
          .filter((x) => x.id.startsWith('mbx:'))
          .map((x) => ({ id: x.id, name: x.name, label: `${x.name} (freigegeben: ${x.id.slice(4)})` })),
      ];
      if (!rows.length)
        rows.push(...[...shown.values()].map((x) => ({ id: x.id, name: x.name, label: x.name })));
      return (
        <div class="card" style="max-width:720px;margin-bottom:14px">
          <h3 style="margin-top:0">{a.email}</h3>
          {f.error && (
            <p style="color:var(--err)">
              Kalenderliste nicht abrufbar: {f.error}. Passwort geändert? Unten mit derselben E-Mail neu
              verbinden.
            </p>
          )}
          <form method="post" action={`/kalender/konten/${a.id}/kalender`}>
            <div class="small mut">Angezeigte Kalender (Haken) und Farbe:</div>
            <div class="olk-cals">
              {rows.map((r, j) => {
                const cur = shown.get(r.id);
                return (
                  <label>
                    <input type="checkbox" name={`on_${j}`} value="1" checked={!!cur} />
                    <input
                      type="color"
                      name={`col_${j}`}
                      value={cur?.color ?? CAL_COLORS[(i * 3 + j) % CAL_COLORS.length]}
                      aria-label={`Farbe ${r.name}`}
                    />
                    <input type="hidden" name={`id_${j}`} value={r.id} />
                    <input type="hidden" name={`nm_${j}`} value={r.name} />
                    <span>{r.label}</span>
                  </label>
                );
              })}
            </div>
            <input type="hidden" name="n" value={String(rows.length)} />
            <button class="btn sm">Auswahl speichern</button>
          </form>
          <details style="margin-top:12px">
            <summary class="small">Freigegebenen Kalender eines anderen Postfachs hinzufügen</summary>
            <form method="post" action={`/kalender/konten/${a.id}/freigegeben`} style="margin-top:8px">
              <div class="grid">
                <label for={`sh-${a.id}`}>E-Mail des Postfachs</label>
                <input
                  id={`sh-${a.id}`}
                  name="mailbox"
                  type="email"
                  required
                  placeholder="kollege@viva-deluxe-reinigung.de"
                />
                <label for={`shn-${a.id}`}>Anzeigename</label>
                <input id={`shn-${a.id}`} name="name" placeholder="z. B. Kalender Objektleitung" />
              </div>
              <p class="small mut">
                Geht nur, wenn der Kalender in Outlook für {a.email} freigegeben ist (mindestens Lesen).
              </p>
              <button class="btn sec sm">Hinzufügen</button>
            </form>
          </details>
          <form
            method="post"
            action={`/kalender/konten/${a.id}/trennen`}
            data-confirm={`${a.email} von der App trennen? Die Termine in Outlook bleiben erhalten.`}
            style="margin-top:12px"
          >
            <button class="btn ghost sm">Konto trennen</button>
          </form>
        </div>
      );
    };
    return page(
      c,
      'Konten & Kalender',
      'verwaltung',
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <PageHead title="Konten & Kalender" crumbs={[['Kalender', '/kalender']]} />
        {accounts.map(accCard)}
        {connectForm(
          accounts.length ? '' : user.email,
          accounts.length ? (
            <p class="small">
              Weiteres Postfach (z. B. info@ oder ein Team-Postfach) hinzufügen. Mit derselben E-Mail-Adresse
              wie oben wird das Konto neu verbunden (z. B. nach Passwortänderung).
            </p>
          ) : undefined,
          accounts.length ? 'Weiteres Konto verbinden' : 'Outlook-Konto verbinden',
        )}
      </>,
    );
  });

  app.post('/kalender/konten/:id/kalender', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const n = Math.min(200, Number(str(b, 'n') ?? 0) || 0);
    const cals: CalRef[] = [];
    for (let j = 0; j < n; j++)
      if (str(b, `on_${j}`) === '1')
        cals.push({
          id: str(b, `id_${j}`) ?? '',
          name: str(b, `nm_${j}`) ?? '',
          color: str(b, `col_${j}`) ?? '',
        });
    if (!cals.length) throw new BusinessError('Bitte mindestens einen Kalender anhaken');
    await saveCalendars(sql, c.get('user').id, c.req.param('id'), cals);
    return back(c, '/kalender/konten', { ok: 'Auswahl gespeichert.' });
  });

  app.post('/kalender/konten/:id/freigegeben', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const user = c.get('user');
    const acc = await getAccount(sql, user.id, c.req.param('id'));
    if (!acc) throw new BusinessError('Konto nicht gefunden');
    const id = await probeSharedCalendar(sql, env, user.id, acc.id, str(b, 'mailbox') ?? '');
    const cur = shownCalendars(acc).filter((x) => x.id !== id);
    await saveCalendars(sql, user.id, acc.id, [
      ...cur,
      {
        id,
        name: (str(b, 'name') ?? '').trim() || `Kalender ${id.slice(4)}`,
        color: CAL_COLORS[(cur.length + 2) % CAL_COLORS.length]!,
      },
    ]);
    return back(c, '/kalender/konten', { ok: 'Freigegebener Kalender hinzugefügt.' });
  });

  app.post('/kalender/konten/:id/trennen', async (c) => {
    const user = c.get('user');
    await disconnectAccount(sql, user.id, c.req.param('id'));
    await sql`insert into app.audit_log (actor, action, entity, entity_id)
      values (${c.get('actor')}, 'disconnect', 'exchange_account', ${user.id})`;
    return back(c, '/kalender/konten', { ok: 'Konto getrennt – das Passwort ist gelöscht.' });
  });

  app.post('/kalender/verbinden', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const user = c.get('user');
    const { url } = await connectAccount(sql, env, {
      userId: user.id,
      email: str(b, 'email') ?? '',
      login: str(b, 'login'),
      password: typeof b.password === 'string' ? b.password : '',
      url: str(b, 'url'),
    });
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
      values (${c.get('actor')}, 'connect', 'exchange_account', ${user.id}, ${sql.json({ url })})`;
    return back(c, '/kalender/konten', {
      ok: 'Outlook-Konto verbunden. Jetzt die Kalender anhaken, die angezeigt werden sollen.',
    });
  });

  // ------------------------------------------------------------ Termin anlegen / ändern
  const eventForm = (p: {
    ev?: CalEvent;
    acc?: string;
    targets?: { value: string; label: string }[];
    calLabel?: string;
    date: string;
    time?: string;
    back: string;
  }) => {
    const e = p.ev;
    const s = e ? dateToBerlin(e.start) : { date: p.date, time: p.time ?? '09:00' };
    const endD = e
      ? e.allDay
        ? dateToBerlin(new Date(e.end.getTime() - 1))
        : dateToBerlin(e.end)
      : {
          date: p.date,
          time: (() => {
            const [h, m] = s.time.split(':').map(Number);
            return `${String(Math.min(23, h! + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          })(),
        };
    const rem = e ? e.reminder : 15;
    return (
      <form method="post" action="/kalender/termin" class="card" style="max-width:720px" data-noback>
        {e && <input type="hidden" name="id" value={e.id} />}
        {e && <input type="hidden" name="ck" value={e.changeKey} />}
        {e && <input type="hidden" name="konto" value={p.acc ?? ''} />}
        <input type="hidden" name="zurueck" value={p.back} />
        <div class="grid">
          {!e && p.targets && p.targets.length > 1 && (
            <>
              <label for="t-cal">Kalender</label>
              <select id="t-cal" name="ziel" required>
                {p.targets.map((t) => (
                  <option value={t.value}>{t.label}</option>
                ))}
              </select>
            </>
          )}
          {!e && p.targets && p.targets.length === 1 && (
            <input type="hidden" name="ziel" value={p.targets[0]!.value} />
          )}
          {e && p.calLabel && (
            <>
              <span class="lbl">Kalender</span>
              <span>{p.calLabel}</span>
            </>
          )}
          <label for="t-subj">Betreff</label>
          <input id="t-subj" name="subject" required maxlength={255} value={e?.subject ?? ''} />
          <label for="t-loc">Ort</label>
          <input id="t-loc" name="location" value={e?.location ?? ''} />
          <label for="t-allday">Ganztägig</label>
          <span>
            <input id="t-allday" type="checkbox" name="allday" value="1" checked={e?.allDay ?? false} />
          </span>
          <label for="t-date">Beginn</label>
          <span style="display:flex;gap:8px">
            <input id="t-date" type="date" name="date" required value={s.date} />
            <input type="time" name="start" value={s.time} class="olk-time" aria-label="Uhrzeit Beginn" />
          </span>
          <label for="t-edate">Ende</label>
          <span style="display:flex;gap:8px">
            <input id="t-edate" type="date" name="end_date" value={endD.date} />
            <input type="time" name="end" value={endD.time} class="olk-time" aria-label="Uhrzeit Ende" />
          </span>
          <label for="t-rem">Erinnerung</label>
          <select id="t-rem" name="reminder">
            {REMINDERS.map(([v, l]) => (
              <option value={v === null ? '' : String(v)} selected={v === rem}>
                {l}
              </option>
            ))}
            {rem !== null && !REMINDERS.some(([v]) => v === rem) && (
              <option value={String(rem)} selected>
                {rem} Minuten vorher
              </option>
            )}
          </select>
          <label for="t-busy">Anzeigen als</label>
          <select id="t-busy" name="busy">
            {BUSY.map(([v, l]) => (
              <option value={v} selected={(e?.busy ?? 'Busy') === v}>
                {l}
              </option>
            ))}
          </select>
          <label for="t-body">Notiz</label>
          <textarea id="t-body" name="body" rows={5}>
            {e?.body ?? ''}
          </textarea>
        </div>
        {e?.recurring && <p class="small mut">Serientermin: Änderungen gelten nur für dieses Vorkommen.</p>}
        {e?.organizer && <p class="small mut">Organisator: {e.organizer}</p>}
        <div class="actions">
          <button class="btn">Speichern</button>
          <a class="btn sec" href={p.back}>
            Abbrechen
          </a>
        </div>
        <script dangerouslySetInnerHTML={{ __html: FORM_JS }} />
      </form>
    );
  };

  const safeBack = (v: string | null | undefined) =>
    v && v.startsWith('/kalender') && !v.startsWith('//') ? v : '/kalender';

  app.get('/kalender/neu', async (c) => {
    const user = c.get('user');
    const accounts = await listAccounts(sql, user.id);
    if (!accounts.length) return c.redirect('/kalender', 302);
    const targets = accounts.flatMap((a, i) =>
      shownCalendars(a, i).map((x) => ({
        value: `${a.id}|${x.id}`,
        label: accounts.length > 1 ? `${x.name} – ${a.email}` : x.name,
      })),
    );
    const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('datum') ?? '')
      ? c.req.query('datum')!
      : todayBerlin();
    const back = `/kalender?ansicht=woche&datum=${date}`;
    return page(
      c,
      'Neuer Termin',
      'verwaltung',
      <>
        <PageHead title="Neuer Termin" crumbs={[['Kalender', back]]} />
        {eventForm({ date, back, targets, ...(c.req.query('zeit') ? { time: c.req.query('zeit')! } : {}) })}
      </>,
    );
  });

  app.get('/kalender/termin', async (c) => {
    const user = c.get('user');
    const id = c.req.query('id') ?? '';
    const backTo = safeBack(c.req.query('zurueck'));
    const acc = await getAccount(sql, user.id, c.req.query('konto') || undefined);
    if (!acc) return c.redirect('/kalender', 302);
    const ev = await getEvent(sql, env, user.id, acc.id, id);
    const multi = (await listAccounts(sql, user.id)).length > 1;
    return page(
      c,
      'Termin',
      'verwaltung',
      <>
        <PageHead title={ev.subject} crumbs={[['Kalender', backTo]]} />
        {eventForm({
          ev,
          acc: acc.id,
          ...(multi ? { calLabel: acc.email } : {}),
          date: dateToBerlin(ev.start).date,
          back: backTo,
        })}
        <form
          method="post"
          action="/kalender/termin/loeschen"
          data-confirm="Termin löschen? Er wird auch in Outlook gelöscht (Ordner „Gelöschte Elemente“)."
          style="margin-top:10px"
        >
          <input type="hidden" name="id" value={ev.id} />
          <input type="hidden" name="konto" value={acc.id} />
          <input type="hidden" name="zurueck" value={backTo} />
          <button class="btn danger sm">Termin löschen</button>
        </form>
      </>,
    );
  });

  app.post('/kalender/termin', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const user = c.get('user');
    const remRaw = str(b, 'reminder');
    const busy = str(b, 'busy');
    const input: EventInput = {
      subject: str(b, 'subject') ?? '',
      date: str(b, 'date') ?? '',
      start: str(b, 'start') ?? '',
      endDate: str(b, 'end_date') ?? '',
      end: str(b, 'end') ?? '',
      allDay: str(b, 'allday') === '1',
      location: str(b, 'location') ?? '',
      body: typeof b.body === 'string' ? b.body : '',
      reminder: remRaw === null || remRaw === '' ? null : Math.max(0, Math.min(40320, Number(remRaw) || 0)),
      busy: BUSY.some(([v]) => v === busy) ? (busy as EventInput['busy']) : 'Busy',
    };
    const id = str(b, 'id');
    if (id) {
      const acc = await getAccount(sql, user.id, str(b, 'konto') || undefined);
      if (!acc) throw new BusinessError('Konto nicht gefunden');
      await updateEvent(sql, env, user.id, acc.id, id, str(b, 'ck') ?? '', input);
    } else {
      const [accId, ...cal] = (str(b, 'ziel') ?? '').split('|');
      const acc = await getAccount(sql, user.id, accId || undefined);
      if (!acc) throw new BusinessError('Bitte einen Kalender wählen');
      const calId = cal.join('|') || 'calendar';
      if (!shownCalendars(acc).some((x) => x.id === calId))
        throw new BusinessError('Kalender nicht gefunden');
      await createEvent(sql, env, user.id, acc.id, input, calId);
    }
    const backTo = safeBack(str(b, 'zurueck'));
    const target = id ? backTo : `/kalender?ansicht=woche&datum=${input.date}`;
    return back(c, target, { ok: id ? 'Termin geändert.' : 'Termin eingetragen.' });
  });

  app.post('/kalender/termin/loeschen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const user = c.get('user');
    const acc = await getAccount(sql, user.id, str(b, 'konto') || undefined);
    if (!acc) throw new BusinessError('Konto nicht gefunden');
    await deleteEvent(sql, env, user.id, acc.id, str(b, 'id') ?? '');
    return back(c, safeBack(str(b, 'zurueck')), { ok: 'Termin gelöscht.' });
  });
}
