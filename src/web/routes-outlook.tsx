import type { Child } from 'hono/jsx';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  type CalEvent,
  type EventInput,
  REMINDERS,
  connectAccount,
  createEvent,
  dateToBerlin,
  deleteEvent,
  disconnectAccount,
  getAccount,
  getEvent,
  listEvents,
  updateEvent,
} from '../services/exchange-calendar.js';
import type { Ctx } from './app.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead } from './layout.js';

/*
 * Outlook-Kalender in der App (Ahmed 01.11.): eigenes Exchange-Postfach verbinden, Kalender ansehen (Woche, Monat,
 * Liste), Termine mit Ort, Notiz und Erinnerung anlegen, ändern, löschen. Nichts wird automatisch eingetragen.
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
.olk-ev{display:block;text-decoration:none;color:inherit;border-left:3px solid var(--brand);background:#f8eff2;border-radius:6px;padding:5px 7px;font-size:12.5px;line-height:1.3}
.olk-ev.free{border-left-color:#9aa0a6;background:#f4f4f5}
.olk-ev.tent{border-left-style:dashed}
.olk-ev.oof{border-left-color:#7b3fa0;background:#f3ecf8}
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

  const connectForm = (email: string | null | undefined, note?: Child) => (
    <form method="post" action="/kalender/verbinden" class="card" style="max-width:640px">
      <h3 style="margin-top:0">Outlook-Konto verbinden</h3>
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
    const acc = await getAccount(sql, user.id);
    if (!acc)
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

    let events: CalEvent[] = [];
    let error: string | null = null;
    try {
      events = await listEvents(sql, env, user.id, from, to);
    } catch (e) {
      if (!(e instanceof BusinessError)) throw e;
      error = e.message;
    }
    const days = byDay(events, from, to);
    const q = (p: Record<string, string>) => `/kalender?${new URLSearchParams({ ansicht: view, ...p })}`;
    const cls = (e: CalEvent) =>
      `olk-ev${e.busy === 'Free' ? ' free' : e.busy === 'Tentative' ? ' tent' : e.busy === 'OOF' ? ' oof' : ''}`;
    const evLink = (e: CalEvent, full: boolean) => (
      <a
        class={cls(e)}
        href={`/kalender/termin?id=${encodeURIComponent(e.id)}&zurueck=${encodeURIComponent(q({ datum: d }))}`}
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
        {error ? (
          <div class="card" style="border-left:4px solid var(--err)">
            <b>Kalender konnte nicht geladen werden:</b> {error}
            {acc.last_ok_at && (
              <p class="small mut">
                Zuletzt erfolgreich: {acc.last_ok_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
              </p>
            )}
            <p class="small">Passwort geändert? Dann unten „Konto trennen“ und neu verbinden.</p>
          </div>
        ) : view === 'woche' ? (
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
          Verbunden mit <b>{acc.email}</b>. Erinnerungen kommen von Outlook bzw. der Mail-App auf dem Handy.{' '}
          Serientermine lassen sich hier nur einzeln (dieses Vorkommen) ändern.
        </p>
        <form
          method="post"
          action="/kalender/trennen"
          data-confirm="Outlook-Konto von der App trennen? Die Termine in Outlook bleiben erhalten."
        >
          <button class="btn ghost sm">Konto trennen</button>
        </form>
      </>,
    );
  });

  app.post('/kalender/verbinden', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const user = c.get('user');
    const url = await connectAccount(sql, env, {
      userId: user.id,
      email: str(b, 'email') ?? '',
      login: str(b, 'login'),
      password: typeof b.password === 'string' ? b.password : '',
      url: str(b, 'url'),
    });
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
      values (${c.get('actor')}, 'connect', 'exchange_account', ${user.id}, ${sql.json({ url })})`;
    return back(c, '/kalender', { ok: 'Outlook-Kalender verbunden.' });
  });

  app.post('/kalender/trennen', async (c) => {
    const user = c.get('user');
    await disconnectAccount(sql, user.id);
    await sql`insert into app.audit_log (actor, action, entity, entity_id)
      values (${c.get('actor')}, 'disconnect', 'exchange_account', ${user.id})`;
    return back(c, '/kalender', { ok: 'Konto getrennt – das Passwort ist gelöscht.' });
  });

  // ------------------------------------------------------------ Termin anlegen / ändern
  const eventForm = (p: { ev?: CalEvent; date: string; time?: string; back: string }) => {
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
        <input type="hidden" name="zurueck" value={p.back} />
        <div class="grid">
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
    if (!(await getAccount(sql, user.id))) return c.redirect('/kalender', 302);
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
        {eventForm({ date, back, ...(c.req.query('zeit') ? { time: c.req.query('zeit')! } : {}) })}
      </>,
    );
  });

  app.get('/kalender/termin', async (c) => {
    const user = c.get('user');
    const id = c.req.query('id') ?? '';
    const backTo = safeBack(c.req.query('zurueck'));
    const ev = await getEvent(sql, env, user.id, id);
    return page(
      c,
      'Termin',
      'verwaltung',
      <>
        <PageHead title={ev.subject} crumbs={[['Kalender', backTo]]} />
        {eventForm({ ev, date: dateToBerlin(ev.start).date, back: backTo })}
        <form
          method="post"
          action="/kalender/termin/loeschen"
          data-confirm="Termin löschen? Er wird auch in Outlook gelöscht (Ordner „Gelöschte Elemente“)."
          style="margin-top:10px"
        >
          <input type="hidden" name="id" value={ev.id} />
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
    if (id) await updateEvent(sql, env, user.id, id, str(b, 'ck') ?? '', input);
    else await createEvent(sql, env, user.id, input);
    const backTo = safeBack(str(b, 'zurueck'));
    const target = id ? backTo : `/kalender?ansicht=woche&datum=${input.date}`;
    return back(c, target, { ok: id ? 'Termin geändert.' : 'Termin eingetragen.' });
  });

  app.post('/kalender/termin/loeschen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await deleteEvent(sql, env, c.get('user').id, str(b, 'id') ?? '');
    return back(c, safeBack(str(b, 'zurueck')), { ok: 'Termin gelöscht.' });
  });
}
