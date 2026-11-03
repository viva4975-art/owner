import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from '../services/errors.js';
import { redactedTimesheetPdf, timesheetSitesOf } from '../services/redacted-timesheet.js';
import {
  addTimesheetRows,
  deleteTimesheetRows,
  importTimesheetRows,
  listTimesheetRows,
  suggestPerson,
} from '../services/site-timesheet.js';
import { hm } from '../services/time.js';
import type { AppEnv, Ctx } from './app.js';
import { dateDe } from './layout.js';

const UUID = '[0-9a-f-]{36}';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const mayEdit = (c: Context<AppEnv>) => c.get('user').role !== 'objektleitung';
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const wd = (d: string) => WD[new Date(`${d}T12:00:00Z`).getUTCDay()]!;
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
 * Objekt → Stundennachweis für den Kunden (Ahmed 03.11.): Stunden je Tag mit „Person 1, 2 …“, aus Ist oder Plan
 * übernommen oder von Hand (z. B. Nachunternehmer). Geht als Anlage mit der Rechnung, wenn die Leistung
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
      const rows = await listTimesheetRows(sql, s.id, von, bis);
      const edit = mayEdit(c);
      const total = rows.reduce((a, r) => a + r.minutes, 0);
      const persons = [...new Set(rows.map((r) => r.person))];
      const next = await suggestPerson(sql, s.id, von, bis);
      const prev = addDays(von, -1);
      const nextM = addDays(monthEnd(von), 1);
      const back2 = c.req.query('rechnung');
      return (
        <>
          <div class="card">
            <h3 style="margin-top:0">Stundennachweis für den Kunden</h3>
            <p class="small mut">
              Stunden je Tag, mit „Person 1, Person 2 …“ statt Namen. Ist bei einer Leistung „Stundennachweis
              an die Rechnung anhängen“ angekreuzt, geht <b>diese Liste</b> mit der Rechnung an den Kunden.
              Ist für den Zeitraum nichts eingetragen, nimmt die Rechnung automatisch die erfassten Zeiten.
            </p>
            <form method="get" class="actions" style="align-items:flex-end;flex-wrap:wrap">
              <div>
                <label for="st-von">von</label>
                <input id="st-von" type="date" name="von" value={von} />
              </div>
              <div>
                <label for="st-bis">bis</label>
                <input id="st-bis" type="date" name="bis" value={bis} />
              </div>
              <button class="btn sec sm">Anzeigen</button>
              <a class="btn ghost sm" href={url(s.id, monthStart(prev), monthEnd(prev))}>
                ‹ Vormonat
              </a>
              <a class="btn ghost sm" href={url(s.id, nextM, monthEnd(nextM))}>
                Folgemonat ›
              </a>
              <a
                class="btn sec sm"
                href={`/objekte/${s.id}/stundennachweis.pdf?von=${von}&bis=${bis}`}
                target="_blank"
              >
                PDF-Vorschau
              </a>
              {back2 && /^[0-9a-f-]{36}$/.test(back2) && (
                <a class="btn ghost sm" href={`/rechnungen/${back2}`}>
                  ‹ Zur Rechnung
                </a>
              )}
            </form>
            {edit && (
              <div class="actions" style="margin-top:10px;flex-wrap:wrap">
                <form method="post" action={`/objekte/${s.id}/stundennachweis/uebernehmen`}>
                  <input type="hidden" name="von" value={von} />
                  <input type="hidden" name="bis" value={bis} />
                  <input type="hidden" name="quelle" value="ist" />
                  <button class="btn sec sm">Aus erfassten Zeiten übernehmen</button>
                </form>
                <form method="post" action={`/objekte/${s.id}/stundennachweis/uebernehmen`}>
                  <input type="hidden" name="von" value={von} />
                  <input type="hidden" name="bis" value={bis} />
                  <input type="hidden" name="quelle" value="plan" />
                  <button class="btn sec sm">Aus Einsatzplanung übernehmen</button>
                </form>
                <span class="small mut" style="align-self:center">
                  Tage, an denen eine Person schon eingetragen ist, werden nicht doppelt übernommen.
                </span>
              </div>
            )}
          </div>

          <div class="card">
            <h3 style="margin-top:0">
              {dateDe(von)} – {dateDe(bis)} · {rows.length} Zeilen · {hm(total)} Std.
              {persons.length > 0 && <span class="small mut"> · {persons.length} Personen</span>}
            </h3>
            {rows.length === 0 ? (
              <div class="empty-line">
                Noch nichts eingetragen – die Rechnung nimmt dann die erfassten Zeiten des Objekts.
              </div>
            ) : (
              <form method="post" action={`/objekte/${s.id}/stundennachweis/loeschen`}>
                <input type="hidden" name="von" value={von} />
                <input type="hidden" name="bis" value={bis} />
                <table>
                  <thead>
                    <tr>
                      {edit && <th></th>}
                      <th>Datum</th>
                      <th>Person</th>
                      <th class="r">Beginn</th>
                      <th class="r">Ende</th>
                      <th class="r">Pause</th>
                      <th class="r">Stunden</th>
                      <th>Quelle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr>
                        {edit && (
                          <td>
                            <input type="checkbox" name="id" value={r.id} aria-label="markieren" />
                          </td>
                        )}
                        <td class="nowrap">
                          {wd(r.work_date)} {dateDe(r.work_date)}
                        </td>
                        <td>{r.person}</td>
                        <td class="r">{r.start_time}</td>
                        <td class="r">{r.end_time}</td>
                        <td class="r">{r.break_minutes ? hm(r.break_minutes) : '–'}</td>
                        <td class="r">{hm(r.minutes)}</td>
                        <td class="small mut">
                          {r.source === 'ist'
                            ? 'erfasst'
                            : r.source === 'plan'
                              ? 'Einsatzplanung'
                              : 'von Hand'}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      {edit && <td></td>}
                      <td colspan={5}>
                        <b>Summe</b>
                      </td>
                      <td class="r">
                        <b>{hm(total)}</b>
                      </td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
                {edit && (
                  <div class="actions" style="margin-top:8px">
                    <button class="btn ghost sm" data-confirm="Markierte Zeilen löschen?">
                      Markierte löschen
                    </button>
                    <button
                      class="btn ghost sm"
                      name="alle"
                      value="1"
                      data-confirm={`Alle ${rows.length} Zeilen im Zeitraum löschen? Danach nimmt die Rechnung wieder die erfassten Zeiten.`}
                    >
                      Alle Zeilen löschen
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>

          {edit && (
            <div class="card">
              <h3 style="margin-top:0">Person / Stunden hinzufügen</h3>
              <p class="small mut">
                Für einen Tag: nur „von“ ausfüllen. Für mehrere Tage: „von“ und „bis“ und die Wochentage – es
                entsteht je Tag eine Zeile. Nachunternehmer z. B. als „Nachunternehmer – Person 1“.
              </p>
              <form method="post" action={`/objekte/${s.id}/stundennachweis`} data-noback>
                <input type="hidden" name="token" value={randomUUID()} />
                <input type="hidden" name="p_von" value={von} />
                <input type="hidden" name="p_bis" value={bis} />
                <div class="grid">
                  <label for="sn-person">Person</label>
                  <input
                    id="sn-person"
                    name="person"
                    value={next}
                    list="sn-persons"
                    required
                    maxlength={120}
                  />
                  <datalist id="sn-persons">
                    {[...persons, next, 'Nachunternehmer – Person 1'].map((p) => (
                      <option value={p} />
                    ))}
                  </datalist>
                  <label for="sn-von">Datum von</label>
                  <input id="sn-von" type="date" name="von" value={von} required />
                  <label for="sn-bis">bis (leer = ein Tag)</label>
                  <input id="sn-bis" type="date" name="bis" />
                  <label>Wochentage (bei mehreren Tagen)</label>
                  <div class="actions" style="gap:10px;flex-wrap:wrap">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <label class="chk">
                        <input type="checkbox" name="wt" value={String(d)} checked={d >= 1 && d <= 5} />{' '}
                        {WD[d]}
                      </label>
                    ))}
                  </div>
                  <label for="sn-beg">Beginn</label>
                  <input id="sn-beg" type="time" name="beginn" required />
                  <label for="sn-end">Ende</label>
                  <input id="sn-end" type="time" name="ende" required />
                  <label for="sn-pause">Pause (Min.)</label>
                  <input id="sn-pause" type="number" name="pause" min="0" step="5" value="0" />
                </div>
                <div class="form-foot">
                  <button class="btn">Hinzufügen</button>
                </div>
              </form>
            </div>
          )}
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
    const pv = ISO.test(one('p_von')) ? one('p_von') : one('von');
    const pb = ISO.test(one('p_bis')) ? one('p_bis') : pv;
    try {
      if (!mayEdit(c)) throw new BusinessError('Nur das Büro darf den Stundennachweis ändern');
      const wt = ([] as unknown[])
        .concat(b.wt ?? [])
        .map(Number)
        .filter((n) => n >= 0 && n <= 6);
      const n = await addTimesheetRows(
        sql,
        {
          token: /^[0-9a-f-]{36}$/.test(one('token')) ? one('token') : randomUUID(),
          siteId: id,
          person: one('person'),
          start: one('beginn'),
          end: one('ende'),
          breakMinutes: Number(one('pause') || 0),
          from: one('von'),
          to: one('bis'),
          weekdays: wt,
        },
        c.get('actor'),
      );
      return back(c, url(id, pv, pb), { ok: n ? `${n} Zeile(n) hinzugefügt.` : 'Schon eingetragen.' });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, url(id, pv, pb), { fehler: e.message });
      throw e;
    }
  });

  app.post(`/objekte/:id{${UUID}}/stundennachweis/uebernehmen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const von = String(b.von ?? '');
    const bis = String(b.bis ?? '');
    if (!ISO.test(von) || !ISO.test(bis))
      return back(c, `/objekte/${id}/stundennachweis`, { fehler: 'Zeitraum fehlt' });
    if (!mayEdit(c))
      return back(c, url(id, von, bis), { fehler: 'Nur das Büro darf den Stundennachweis ändern' });
    const src = b.quelle === 'plan' ? 'plan' : 'ist';
    const r = await importTimesheetRows(sql, { siteId: id, from: von, to: bis, source: src }, c.get('actor'));
    return back(c, url(id, von, bis), {
      ok: `${r.added} Zeile(n) aus ${src === 'plan' ? 'der Einsatzplanung' : 'den erfassten Zeiten'} übernommen${
        r.skipped ? `, ${r.skipped} übersprungen (schon eingetragen bzw. über Mitternacht)` : ''
      }.`,
    });
  });

  app.post(`/objekte/:id{${UUID}}/stundennachweis/loeschen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const von = String(b.von ?? '');
    const bis = String(b.bis ?? '');
    if (!mayEdit(c))
      return back(c, url(id, von, bis), { fehler: 'Nur das Büro darf den Stundennachweis ändern' });
    let ids = ([] as unknown[])
      .concat(b.id ?? [])
      .map(String)
      .filter((x) => /^[0-9a-f-]{36}$/.test(x));
    if (b.alle === '1' && ISO.test(von) && ISO.test(bis))
      ids = (await listTimesheetRows(sql, id, von, bis)).map((r) => r.id);
    const n = await deleteTimesheetRows(sql, id, ids, c.get('actor'));
    return back(c, url(id, von, bis), { ok: `${n} Zeile(n) gelöscht.` });
  });
}
