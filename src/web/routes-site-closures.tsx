import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { BusinessError } from '../services/errors.js';
import {
  addSiteClosure,
  addSiteSchoolClosures,
  deleteSiteClosure,
  listSiteClosures,
} from '../services/site-closures.js';
import type { AppEnv, Ctx } from './app.js';
import { dateDe } from './layout.js';

const UUID = '[0-9a-f-]{36}';
const mayEdit = (c: Context<AppEnv>) => c.get('user').role !== 'objektleitung';

/**
 * Objekt → Schließzeiten (Ahmed 30.10.): Tage, an denen nicht gereinigt wird. Leistungen „nach Arbeitstagen“ und
 * NU-Bestellungen „je Tag“ zählen sie nicht, eingeplante Einsätze entfallen.
 */
export function registerSiteClosureRoutes({ app, deps, shells, back }: Ctx) {
  const { sql } = deps;
  const url = (id: string) => `/objekte/${id}/schliesszeiten`;

  app.get(`/objekte/:id{${UUID}}/schliesszeiten`, (c) =>
    shells.site!(c, 'uebersicht', async (s) => {
      const list = await listSiteClosures(sql, s.id);
      const edit = mayEdit(c);
      return (
        <div class="card">
          <h3 style="margin-top:0">Schließzeiten</h3>
          <p class="small mut">
            An diesen Tagen wird nicht gereinigt: Leistungen „Menge nach Arbeitstagen“ (je Tag/Stunde) zählen
            sie nicht – auch nicht auf der Rechnung –, Nachunternehmer „je Tag“ an diesem Objekt ebenso, und
            eingeplante Einsätze entfallen (kein Soll, nicht in der App). Feiertage zählen ohnehin nicht.
          </p>
          {list.length === 0 ? (
            <div class="empty-line">Keine Schließzeiten eingetragen.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Zeitraum</th>
                  <th>Grund</th>
                  <th>erfasst von</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr>
                    <td class="nowrap">
                      {dateDe(x.date_from)}
                      {x.date_to !== x.date_from && ` – ${dateDe(x.date_to)}`}
                    </td>
                    <td>{x.note ?? ''}</td>
                    <td class="small mut">{x.created_by}</td>
                    <td>
                      {edit && (
                        <form method="post" action={`${url(s.id)}/${x.id}/loeschen`} style="display:inline">
                          <button class="btn ghost sm" data-confirm="Schließzeit entfernen?">
                            entfernen
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {edit && (
            <>
              <form
                method="post"
                action={url(s.id)}
                class="actions"
                style="align-items:flex-end;flex-wrap:wrap"
              >
                <input type="hidden" name="token" value={randomUUID()} />
                <div>
                  <label for="cl-von">von</label>
                  <input id="cl-von" type="date" name="von" required />
                </div>
                <div>
                  <label for="cl-bis">bis (leer = ein Tag)</label>
                  <input id="cl-bis" type="date" name="bis" />
                </div>
                <div style="flex:1;min-width:200px">
                  <label for="cl-note">Grund</label>
                  <input id="cl-note" name="notiz" placeholder="z. B. Betriebsruhe, Umbau" />
                </div>
                <button class="btn">Schließzeit eintragen</button>
              </form>
              <form method="post" action={`${url(s.id)}/schulferien`} style="margin-top:8px">
                <button
                  class="btn sec sm"
                  data-confirm="Alle bekannten Schulferien Bayern (+ Buß- und Bettag) ab heute als Schließzeiten eintragen?"
                >
                  Schule: alle Schulferien eintragen
                </button>
              </form>
              <p class="small mut" style="margin-bottom:0">
                Hinweis Lohn: Schließt das Objekt, entfallen die Einsätze im Plan. Wer dort fest eingeplant
                ist, behält ohne Ruhens-Vereinbarung im Vertrag den Lohnanspruch (§ 615 BGB) – dann umplanen
                oder Urlaub/unbezahlt nur mit Vereinbarung eintragen.
              </p>
            </>
          )}
        </div>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/schliesszeiten`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      if (!mayEdit(c)) throw new BusinessError('Nur das Büro darf Schließzeiten ändern');
      const token = typeof b.token === 'string' && /^[0-9a-f-]{36}$/.test(b.token) ? b.token : randomUUID();
      await addSiteClosure(
        sql,
        {
          id: token,
          siteId: id,
          from: String(b.von ?? ''),
          to: String(b.bis ?? ''),
          note: typeof b.notiz === 'string' ? b.notiz : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, url(id), { fehler: e.message });
      throw e;
    }
    return back(c, url(id), { ok: 'Schließzeit eingetragen.' });
  });

  app.post(`/objekte/:id{${UUID}}/schliesszeiten/schulferien`, async (c) => {
    const id = c.req.param('id');
    if (!mayEdit(c)) return back(c, url(id), { fehler: 'Nur das Büro darf Schließzeiten ändern' });
    const n = await addSiteSchoolClosures(sql, id, c.get('actor'));
    return back(c, url(id), {
      ok: n ? `${n} Ferienzeiträume eingetragen.` : 'Nichts neu – schon eingetragen.',
    });
  });

  app.post(`/objekte/:id{${UUID}}/schliesszeiten/:cid{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    if (!mayEdit(c)) return back(c, url(id), { fehler: 'Nur das Büro darf Schließzeiten ändern' });
    await deleteSiteClosure(sql, id, c.req.param('cid'), c.get('actor'));
    return back(c, url(id), { ok: 'Schließzeit entfernt.' });
  });
}
