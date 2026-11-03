import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { BusinessError } from '../services/errors.js';
import { redactedTimesheetPdf, timesheetSitesOf } from '../services/redacted-timesheet.js';
import {
  addExtra,
  deleteExtra,
  extraLines,
  listExtraDays,
  listExtras,
  setExtraDay,
  deleteExtraDay,
  planPersons,
  setExtraEnd,
  suggestExtraPerson,
  WEEKDAY_SHORT,
  spanMinutes,
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
      const [persons, extras, nuLines, next, exDays] = await Promise.all([
        planPersons(sql, s.id, von, bis),
        listExtras(sql, s.id),
        extraLines(sql, s.id, von, bis),
        suggestExtraPerson(sql, s.id),
        listExtraDays(sql, s.id),
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
              Fertigstellen automatisch an der Rechnung (Leistung mit „Stundennachweis anhängen“). Namen sind
              im PDF geschwärzt.
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
                    const days = [...(exDays.get(x.id)?.values() ?? [])];
                    const inRange = days.filter((d) => d.day >= von && d.day <= bis);
                    return (
                      <>
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
                        {(edit || days.length > 0) && (
                          <tr class="keep">
                            <td colspan={edit ? 5 : 4} style="padding-top:0;border-top:0">
                              <details open={inRange.length > 0}>
                                <summary class="small">
                                  Abweichende Tage
                                  {days.length > 0 &&
                                    ` (${days.length}${inRange.length !== days.length ? `, ${inRange.length} im Zeitraum` : ''})`}
                                  <span class="mut"> – anders gearbeitet oder nicht ausgeführt</span>
                                </summary>
                                {days.length > 0 && (
                                  <table class="keep" style="margin:6px 0">
                                    <tbody>
                                      {days.map((d) => (
                                        <tr>
                                          <td class="nowrap">
                                            {WEEKDAY_SHORT[isoWeekday(d.day)]} {dateDe(d.day)}
                                          </td>
                                          <td>
                                            {d.kind === 'entfaellt' ? (
                                              <span class="pill" style="background:#f3e3e3;color:#8a1c1c">
                                                nicht ausgeführt
                                              </span>
                                            ) : (
                                              <>
                                                <span class="pill">anders gearbeitet</span> {d.start_time}–
                                                {d.end_time}
                                                {d.end_time! <= d.start_time! && (
                                                  <span class="small mut"> (+1)</span>
                                                )}
                                                {d.break_minutes > 0 && (
                                                  <span class="small mut">
                                                    {' '}
                                                    · Pause {d.break_minutes} Min.
                                                  </span>
                                                )}
                                                <span class="small mut">
                                                  {' '}
                                                  ·{' '}
                                                  {hm(
                                                    spanMinutes(d.start_time!, d.end_time!) - d.break_minutes,
                                                  )}{' '}
                                                  Std.
                                                </span>
                                              </>
                                            )}
                                            {d.note && <span class="small mut"> · {d.note}</span>}
                                          </td>
                                          {edit && (
                                            <td class="r">
                                              <form
                                                method="post"
                                                action={`/objekte/${s.id}/stundennachweis/nu/${x.id}/tag/${d.id}/loeschen`}
                                              >
                                                <input type="hidden" name="von" value={von} />
                                                <input type="hidden" name="bis" value={bis} />
                                                <button class="btn ghost sm">Entfernen</button>
                                              </form>
                                            </td>
                                          )}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                {edit && (
                                  <form
                                    method="post"
                                    action={`/objekte/${s.id}/stundennachweis/nu/${x.id}/tag`}
                                    data-noback
                                    style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0"
                                  >
                                    <input type="hidden" name="von" value={von} />
                                    <input type="hidden" name="bis" value={bis} />
                                    <input
                                      aria-label="Tag"
                                      type="date"
                                      name="tag"
                                      required
                                      min={x.valid_from}
                                      max={x.valid_until ?? undefined}
                                      style="width:auto"
                                    />
                                    <select aria-label="Art" name="art" style="width:auto" data-day-kind>
                                      <option value="anders">anders gearbeitet</option>
                                      <option value="entfaellt">nicht ausgeführt</option>
                                    </select>
                                    <span data-day-times style="display:contents">
                                      <input
                                        aria-label="Beginn"
                                        type="time"
                                        name="beginn"
                                        value={x.start_time}
                                        style="width:auto"
                                      />
                                      <span class="small mut">bis</span>
                                      <input
                                        aria-label="Ende"
                                        type="time"
                                        name="ende"
                                        value={x.end_time}
                                        style="width:auto"
                                      />
                                      <span class="small mut">Pause</span>
                                      <input
                                        aria-label="Pause (Min.)"
                                        type="number"
                                        name="pause"
                                        min="0"
                                        step="5"
                                        value={String(x.break_minutes)}
                                        style="width:70px"
                                      />
                                    </span>
                                    <input
                                      aria-label="Bemerkung"
                                      name="notiz"
                                      maxlength={300}
                                      placeholder="Bemerkung (intern)"
                                      style="width:auto;min-width:160px"
                                    />
                                    <button class="btn sec sm">Tag speichern</button>
                                  </form>
                                )}
                              </details>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}

            {edit && (
              <script
                dangerouslySetInnerHTML={{
                  __html: `document.querySelectorAll('select[data-day-kind]').forEach(function(s){var t=s.parentNode.querySelector('[data-day-times]');function f(){var off=s.value==='entfaellt';t.style.display=off?'none':'contents';t.querySelectorAll('input').forEach(function(i){i.disabled=off;});}s.addEventListener('change',f);f();});`,
                }}
              />
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
                    Schließzeiten des Objekts werden ausgelassen. Einzelne Tage mit anderer Zeit oder ohne
                    Ausführung danach unter „Abweichende Tage“ bei der Person.
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

  app.post(`/objekte/:id{${UUID}}/stundennachweis/nu/:x{${UUID}}/tag`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    const von = ISO.test(str('von')) ? str('von') : monthStart(todayBerlin());
    const bis = ISO.test(str('bis')) ? str('bis') : monthEnd(von);
    try {
      if (!mayEdit(c)) throw new BusinessError('Nur das Büro darf den Stundennachweis ändern');
      const kind = str('art') === 'entfaellt' ? 'entfaellt' : 'anders';
      const person = await setExtraDay(
        sql,
        {
          siteId: id,
          extraId: c.req.param('x'),
          day: str('tag'),
          kind,
          start: str('beginn'),
          end: str('ende'),
          breakMinutes: Number(str('pause') || 0),
          note: str('notiz'),
        },
        c.get('actor'),
      );
      return back(c, url(id, von, bis), {
        ok: `${person}, ${dateDe(str('tag'))}: ${kind === 'entfaellt' ? 'nicht ausgeführt' : 'andere Zeit'} gespeichert.`,
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, url(id, von, bis), { fehler: e.message });
      throw e;
    }
  });

  app.post(`/objekte/:id{${UUID}}/stundennachweis/nu/:x{${UUID}}/tag/:d{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const von = ISO.test(String(b.von ?? '')) ? String(b.von) : monthStart(todayBerlin());
    const bis = ISO.test(String(b.bis ?? '')) ? String(b.bis) : monthEnd(von);
    if (!mayEdit(c))
      return back(c, url(id, von, bis), { fehler: 'Nur das Büro darf den Stundennachweis ändern' });
    await deleteExtraDay(sql, id, c.req.param('d'), c.get('actor'));
    return back(c, url(id, von, bis), { ok: 'Tag wieder wie geplant.' });
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
