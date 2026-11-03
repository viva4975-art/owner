import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from '../services/errors.js';
import { redactedTimesheetPdf, timesheetSitesOf } from '../services/redacted-timesheet.js';
import {
  addExtra,
  deleteExtra,
  extraLines,
  listExtras,
  planPersons,
  setExtraEnd,
  suggestExtraPerson,
  WEEKDAY_SHORT,
  weekdaysLabel,
} from '../services/site-timesheet.js';
import { hm } from '../services/time.js';
import type { AppEnv, Ctx } from './app.js';
import { dateDe } from './layout.js';

const UUID = '[0-9a-f-]{36}';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const mayEdit = (c: Context<AppEnv>) => c.get('user').role !== 'objektleitung';
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return addDays(`${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01`, -1);
};

/** Zeitraum aus der Adresse, sonst laufender Monat */
function periodOf(c: Context<AppEnv>) {
  const t = todayBerlin();
  const von = ISO.test(c.req.query('von') ?? '') ? c.req.query('von')! : monthStart(t);
  const bisQ = ISO.test(c.req.query('bis') ?? '') ? c.req.query('bis')! : monthEnd(von);
  return { von, bis: bisQ < von ? von : bisQ };
}

/**
 * Objekt → Stundennachweis für den Kunden (Ahmed 03.11.): kommt aus der Einsatzplanung („Person 1, 2 …“), von Hand
 * nur zusätzliche Leute vom Nachunternehmer. Geht als Anlage mit der Rechnung, wenn die Leistung
 * „Stundennachweis anhängen“ hat.
 */
export function registerSiteTimesheetRoutes({ app, deps, shells, back, page }: Ctx) {
  const { sql } = deps;
  const url = (id: string, von: string, bis: string) =>
    `/objekte/${id}/stundennachweis?von=${von}&bis=${bis}`;

  // Von der Rechnung aus: direkt zum Objekt und Leistungszeitraum (mehrere Objekte → Auswahl)
  app.get(`/rechnungen/:id{${UUID}}/stundennachweis/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const sites = await timesheetSitesOf(sql, id);
    if (sites.length === 1)
      return c.redirect(`${url(sites[0]!.site_id, sites[0]!.from, sites[0]!.to)}&rechnung=${id}`);
    return page(
      c,
      'Stundennachweis bearbeiten',
      'rechnungen',
      <div class="card">
        <h3 style="margin-top:0">Stundennachweis bearbeiten – Objekt wählen</h3>
        {sites.length === 0 ? (
          <div class="empty-line">Keine Leistung mit Stundennachweis auf dieser Rechnung.</div>
        ) : (
          <ul>
            {sites.map((t) => (
              <li>
                <a href={`${url(t.site_id, t.from, t.to)}&rechnung=${id}`}>
                  {t.site_no} · {t.site_name}
                </a>{' '}
                <span class="small mut">
                  {dateDe(t.from)} – {dateDe(t.to)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <a class="btn sec sm" href={`/rechnungen/${id}`}>
          ‹ Zurück zur Rechnung
        </a>
      </div>,
    );
  });

  app.get(`/objekte/:id{${UUID}}/stundennachweis`, (c) =>
    shells.site!(c, 'zeiten', async (s) => {
      const { von, bis } = periodOf(c);
      const edit = mayEdit(c);
      const [persons, extras, nuLines, next] = await Promise.all([
        planPersons(sql, s.id, von, bis),
        listExtras(sql, s.id),
        extraLines(sql, s.id, von, bis),
        suggestExtraPerson(sql, s.id),
      ]);
      const nuMin = new Map<string, { days: number; min: number }>();
      for (const l of nuLines) {
        const k = l.person;
        const v = nuMin.get(k) ?? { days: 0, min: 0 };
        v.days++;
        v.min += l.minutes;
        nuMin.set(k, v);
      }
      const planTotal = persons.reduce((a, p) => a + p.minutes, 0);
      const nuTotal = nuLines.reduce((a, l) => a + l.minutes, 0);
      const prev = addDays(von, -1);
      const nextM = addDays(monthEnd(von), 1);
      const inv = c.req.query('rechnung');
      const invOk = !!inv && /^[0-9a-f-]{36}$/.test(inv);
      const today = todayBerlin();
      return (
        <>
          <div class="card">
            <h3 style="margin-top:0">Stundennachweis für den Kunden</h3>
            <form method="get" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              {invOk && <input type="hidden" name="rechnung" value={inv} />}
              <a class="btn ghost sm" href={url(s.id, monthStart(prev), monthEnd(prev))}>
                ‹
              </a>
              <input aria-label="von" type="date" name="von" value={von} style="width:auto" />
              <input aria-label="bis" type="date" name="bis" value={bis} style="width:auto" />
              <a class="btn ghost sm" href={url(s.id, nextM, monthEnd(nextM))}>
                ›
              </a>
              <button class="btn sec sm">Anzeigen</button>
              <a
                class="btn sm"
                href={`/objekte/${s.id}/stundennachweis.pdf?von=${von}&bis=${bis}`}
                target="_blank"
              >
                PDF erstellen
              </a>
              {invOk && (
                <a class="btn ghost sm" href={`/rechnungen/${inv}`}>
                  ‹ Zur Rechnung
                </a>
              )}
            </form>
            <p class="small mut" style="margin:8px 0 0">
              {dateDe(von)} – {dateDe(bis)}: <b>{hm(planTotal + nuTotal)} Std.</b> · Das PDF hängt beim
              Fertigstellen automatisch an der Rechnung (Leistung mit „Stundennachweis anhängen“). Namen
              erscheinen als „Person 1, 2 …“.
            </p>
          </div>

          <div class="card">
            <h3 style="margin-top:0">
              Eingesetzte Leute (aus der Einsatzplanung)
              <span class="small mut"> · {hm(planTotal)} Std.</span>
            </h3>
            {persons.length === 0 ? (
              <div class="empty-line">
                Keine Einsätze im Zeitraum – <a href={`/objekte/${s.id}/einsaetze`}>Einsätze planen</a>.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Tage und Zeit</th>
                    <th class="r">Einsätze</th>
                    <th class="r">Stunden</th>
                  </tr>
                </thead>
                <tbody>
                  {persons.map((p) => (
                    <tr>
                      <td>{p.person}</td>
                      <td>
                        {p.times.map((t) => (
                          <div>{t}</div>
                        ))}
                      </td>
                      <td class="r">{p.shifts}</td>
                      <td class="r">{hm(p.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p class="small mut" style="margin:8px 0 0">
              Ändern über die <a href={`/objekte/${s.id}/einsaetze`}>Einsatzplanung</a> (Urlaub, Krankheit,
              Ausfall und freie Feiertage fallen automatisch weg).
            </p>
          </div>

          <div class="card">
            <h3 style="margin-top:0">
              Leute vom Nachunternehmer
              {nuTotal > 0 && <span class="small mut"> · {hm(nuTotal)} Std. im Zeitraum</span>}
            </h3>
            {extras.length === 0 ? (
              <div class="empty-line">Noch niemand eingetragen.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Tage und Zeit</th>
                    <th>Zeitraum</th>
                    <th class="r">im Zeitraum</th>
                    {edit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {extras.map((x) => {
                    const m = nuMin.get(x.person);
                    const ended = !!x.valid_until && x.valid_until < today;
                    return (
                      <tr style={ended ? 'opacity:.6' : ''}>
                        <td>{x.person}</td>
                        <td>
                          {weekdaysLabel(x.weekdays)} {x.start_time}–{x.end_time}
                          {x.end_time <= x.start_time && <span class="small mut"> (+1)</span>}
                          {x.break_minutes > 0 && (
                            <span class="small mut"> · Pause {x.break_minutes} Min.</span>
                          )}
                        </td>
                        <td class="nowrap">
                          ab {dateDe(x.valid_from)}
                          {x.valid_until ? ` bis ${dateDe(x.valid_until)}` : ''}
                        </td>
                        <td class="r nowrap">{m ? `${m.days} Tage · ${hm(m.min)} Std.` : '–'}</td>
                        {edit && (
                          <td class="r">
                            <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;flex-wrap:wrap">
                              <form
                                method="post"
                                action={`/objekte/${s.id}/stundennachweis/nu/${x.id}/ende`}
                                style="display:flex;gap:4px;align-items:center"
                              >
                                <input type="hidden" name="von" value={von} />
                                <input type="hidden" name="bis" value={bis} />
                                <input
                                  aria-label="Ende"
                                  type="date"
                                  name="ende"
                                  value={x.valid_until ?? ''}
                                  min={x.valid_from}
                                  style="width:auto"
                                />
                                <button class="btn sec sm">
                                  {x.valid_until ? 'Ende ändern' : 'Ende setzen'}
                                </button>
                              </form>
                              <form
                                method="post"
                                action={`/objekte/${s.id}/stundennachweis/nu/${x.id}/loeschen`}
                              >
                                <input type="hidden" name="von" value={von} />
                                <input type="hidden" name="bis" value={bis} />
                                <button
                                  class="btn ghost sm"
                                  data-confirm={`${x.person} löschen? Die Person fällt aus allen Stundennachweisen heraus, die neu erstellt werden.`}
                                >
                                  Löschen
                                </button>
                              </form>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {edit && (
              <details style="margin-top:12px" open={extras.length === 0}>
                <summary>
                  <b>+ Person vom Nachunternehmer hinzufügen</b>
                </summary>
                <form
                  method="post"
                  action={`/objekte/${s.id}/stundennachweis`}
                  data-noback
                  style="margin-top:10px"
                >
                  <input type="hidden" name="token" value={randomUUID()} />
                  <input type="hidden" name="p_von" value={von} />
                  <input type="hidden" name="p_bis" value={bis} />
                  <div class="grid">
                    <label for="sn-person">Person</label>
                    <input id="sn-person" name="person" value={next} required maxlength={120} />
                    <label for="sn-beg">Zeit</label>
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                      <input id="sn-beg" type="time" name="beginn" required style="width:auto" />
                      <span class="small mut">bis</span>
                      <input aria-label="Ende" type="time" name="ende" required style="width:auto" />
                      <span class="small mut">Pause</span>
                      <input
                        aria-label="Pause (Min.)"
                        type="number"
                        name="pause"
                        min="0"
                        step="5"
                        value="0"
                        style="width:80px"
                      />
                      <span class="small mut">Min.</span>
                    </div>
                    <label>Wochentage</label>
                    <div style="display:flex;gap:10px;flex-wrap:wrap">
                      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                        <label class="chk">
                          <input type="checkbox" name="wt" value={String(d)} checked={d <= 5} />{' '}
                          {WEEKDAY_SHORT[d]}
                        </label>
                      ))}
                    </div>
                    <label for="sn-ab">ab</label>
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                      <input id="sn-ab" type="date" name="ab" value={von} required style="width:auto" />
                      <span class="small mut">bis (leer = offen)</span>
                      <input aria-label="bis" type="date" name="bis_datum" style="width:auto" />
                    </div>
                  </div>
                  <p class="small mut">
                    Über Mitternacht einfach eintragen, z. B. 18:30 bis 00:30 = 6 Std. Feiertage und
                    Schließzeiten des Objekts werden ausgelassen.
                  </p>
                  <div class="form-foot">
                    <button class="btn">Hinzufügen</button>
                  </div>
                </form>
              </details>
            )}
          </div>
        </>
      );
    }),
  );

  app.get(`/objekte/:id{${UUID}}/stundennachweis.pdf`, async (c) => {
    const id = c.req.param('id');
    const { von, bis } = periodOf(c);
    const [s] = await sql<{ site_no: string; name: string; address: string; customer: string }[]>`
      select s.site_no, s.name, c.name as customer,
             concat_ws(', ', s.street, nullif(concat_ws(' ', s.postal_code, s.city), '')) as address
        from app.sites s join app.customers c on c.id = s.customer_id where s.id = ${id}`;
    if (!s) return c.notFound();
    const pdf = await redactedTimesheetPdf(
      sql,
      { site_id: id, site_no: s.site_no, site_name: s.name, address: s.address, from: von, to: bis },
      { number: null, customer: s.customer },
    );
    return new Response(pdf, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="Stundennachweis.pdf"',
      },
    });
  });

  app.post(`/objekte/:id{${UUID}}/stundennachweis`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    const pv = ISO.test(one('p_von')) ? one('p_von') : monthStart(todayBerlin());
    const pb = ISO.test(one('p_bis')) ? one('p_bis') : monthEnd(pv);
    try {
      if (!mayEdit(c)) throw new BusinessError('Nur das Büro darf den Stundennachweis ändern');
      const n = await addExtra(
        sql,
        {
          token: /^[0-9a-f-]{36}$/.test(one('token')) ? one('token') : randomUUID(),
          siteId: id,
          person: one('person'),
          start: one('beginn'),
          end: one('ende'),
          breakMinutes: Number(one('pause') || 0),
          weekdays: ([] as unknown[]).concat(b.wt ?? []).map(Number),
          from: one('ab'),
          to: one('bis_datum') || null,
        },
        c.get('actor'),
      );
      return back(c, url(id, pv, pb), {
        ok: n ? `${one('person').trim()} hinzugefügt.` : 'Schon eingetragen.',
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, url(id, pv, pb), { fehler: e.message });
      throw e;
    }
  });

  app.post(`/objekte/:id{${UUID}}/stundennachweis/nu/:x{${UUID}}/:what{ende|loeschen}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const von = ISO.test(String(b.von ?? '')) ? String(b.von) : monthStart(todayBerlin());
    const bis = ISO.test(String(b.bis ?? '')) ? String(b.bis) : monthEnd(von);
    try {
      if (!mayEdit(c)) throw new BusinessError('Nur das Büro darf den Stundennachweis ändern');
      if (c.req.param('what') === 'loeschen') {
        await deleteExtra(sql, id, c.req.param('x'), c.get('actor'));
        return back(c, url(id, von, bis), { ok: 'Gelöscht.' });
      }
      const end = String(b.ende ?? '');
      await setExtraEnd(sql, id, c.req.param('x'), ISO.test(end) ? end : null, c.get('actor'));
      return back(c, url(id, von, bis), {
        ok: ISO.test(end) ? `Ende ${dateDe(end)} gesetzt.` : 'Ende entfernt (offen).',
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, url(id, von, bis), { fehler: e.message });
      throw e;
    }
  });
}
