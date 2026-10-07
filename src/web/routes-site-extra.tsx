import { randomUUID } from 'node:crypto';
import { listWordTemplates } from '../services/word-templates.js';
import { WordTemplateBox } from './routes-word-templates.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { listKeys } from '../services/inventory.js';
import { listOffers } from '../services/offers.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { Icon } from './icons.js';
import { dateDe } from './layout.js';
import { OfferTable } from './pages-offers.js';

/** Dokumentarten am Objekt; die ersten drei sind Pflicht (fehlende werden rot angezeigt). */
export const SITE_DOC_CATEGORIES: { name: string; required: boolean; hint: string }[] = [
  {
    name: 'Raumbuch',
    required: true,
    hint: 'Räume, Flächen, Intervalle (z. B. Excel oder PDF vom Auftraggeber)',
  },
  {
    name: 'Leistungsverzeichnis',
    required: true,
    hint: 'Leistungsbeschreibung / LV aus Vertrag oder Ausschreibung',
  },
  { name: 'Revierplan', required: true, hint: 'Grundrisse mit Revieren der Reinigungskräfte' },
  { name: 'Vertrag', required: false, hint: 'Reinigungsvertrag, Nachträge' },
  { name: 'Sonstiges', required: false, hint: 'Hausordnung, Pläne, Fotos …' },
];

/** Objekt-Reiter Angebote, Dokumente und Schlüssel. */
export function registerSiteExtraRoutes({ app, deps, shells }: Ctx) {
  const { sql, env } = deps;

  // ------------------------------------------------------------------ Angebote
  app.get(`/objekte/:id{${UUID}}/angebote`, (c) =>
    shells.site!(c, 'angebote', async (s) => (
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sm" href={`/neu?typ=angebot&kunde=${s.customer_id}&objekt=${s.id}`}>
            + Angebot für dieses Objekt
          </a>
        </div>
        <OfferTable rows={await listOffers(sql, { siteId: s.id })} showCustomer={false} />
        <p class="small mut">
          Das Objekt steht auf dem Angebot über der Anrede („Objekt: Name (Nr.), Adresse“).
        </p>
      </>
    )),
  );

  // ------------------------------------------------------------------ Dokumente
  app.get(`/objekte/:id{${UUID}}/dokumente`, (c) =>
    shells.site!(c, 'dokumente', async (s) => {
      const files = await listFiles(sql, { type: 'site', id: s.id });
      const known = new Set(SITE_DOC_CATEGORIES.map((k) => k.name));
      const missing = SITE_DOC_CATEGORIES.filter(
        (k) => k.required && !files.some((f) => f.category === k.name),
      );
      const other = files.filter((f) => !f.category || !known.has(f.category));
      return (
        <>
          {missing.length > 0 ? (
            <div class="flash warn">
              Pflichtdokumente fehlen: <b>{missing.map((m) => m.name).join(', ')}</b>
            </div>
          ) : (
            <div class="flash ok">
              Alle Pflichtdokumente (Raumbuch, Leistungsverzeichnis, Revierplan) sind vorhanden.
            </div>
          )}
          {SITE_DOC_CATEGORIES.map((k) => {
            const list = files.filter((f) => f.category === k.name);
            return (
              <section class="doc-cat" id={`kat-${k.name}`}>
                <h3 class="panel-title">
                  {k.name}{' '}
                  {k.required &&
                    (list.length ? (
                      <span class="tag ok">vorhanden</span>
                    ) : (
                      <span class="tag err">Pflicht – fehlt</span>
                    ))}
                </h3>
                <p class="small mut" style="margin:0 0 6px">
                  {k.hint}
                </p>
                <FileArea
                  link={{ type: 'site', id: s.id }}
                  files={list}
                  category={k.name}
                  title={`${k.name} hochladen`}
                  hint="PDF, Excel, Bilder – auch große Dateien"
                  maxBytes={env.UPLOAD_MAX_BYTES}
                />
              </section>
            );
          })}
          {other.length > 0 && (
            <section class="doc-cat">
              <h3 class="panel-title">Weitere Dateien</h3>
              <FileArea
                link={{ type: 'site', id: s.id }}
                files={other}
                maxBytes={env.UPLOAD_MAX_BYTES}
                listOnly
              />
            </section>
          )}
          <p class="small mut">
            Dateien werden unveränderbar abgelegt (Prüfsumme SHA-256). Neue Fassung = neue Datei.
          </p>
          <WordTemplateBox
            templates={[
              ...(await listWordTemplates(sql, 'objekt')),
              ...(c.get('sites') ? [] : await listWordTemplates(sql, 'kunde')),
            ]}
            target={{ type: 'site', id: s.id }}
          />
        </>
      );
    }),
  );

  // ------------------------------------------------------------------ Schlüssel
  app.get(`/objekte/:id{${UUID}}/schluessel`, (c) =>
    shells.site!(c, 'schluessel', async (s) => {
      const keys = (await listKeys(sql)).filter((k) => k.site_id === s.id);
      const employees = await sql<{ id: string; name: string; here: boolean }[]>`
        select e.id, e.last_name || ', ' || coalesce(e.first_name, '') as name,
               exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = ${s.id}) as here
          from app.employees e where e.status = 'aktiv'
         order by 3 desc, e.last_name, e.first_name`;
      const back = `/objekte/${s.id}/schluessel`;
      const nextNo = `S-${s.site_no}-${String(keys.length + 1).padStart(2, '0')}`;
      const out = keys.filter((k) => k.holder_employee_id).length;
      return (
        <>
          <p class="mut" style="margin-top:0">
            {keys.length} Schlüssel, davon {out} ausgegeben. Jede Ausgabe und Rückgabe wird unveränderbar
            protokolliert.
          </p>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Beschreibung</th>
                  <th class="r">Anzahl</th>
                  <th>Bei</th>
                  <th>Ausgabe / Rückgabe</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr>
                    <td>
                      <a href={`/schluessel/${k.id}`}>
                        <b>{k.key_no}</b>
                      </a>
                    </td>
                    <td>
                      {k.description}
                      {k.notes && <div class="small mut">{k.notes}</div>}
                    </td>
                    <td class="r">{k.quantity}</td>
                    <td>
                      {k.holder_name ? (
                        <>
                          <span class="tag warn">{k.holder_name}</span>
                          <div class="small mut">seit {dateDe(k.issued_at)}</div>
                        </>
                      ) : (
                        <span class="tag ok">im Büro</span>
                      )}
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/schluessel/${k.id}/buchen`}
                        style="display:flex;gap:6px;align-items:center;margin:0"
                      >
                        <input type="hidden" name="back" value={back} />
                        <input type="hidden" name="at" value={todayBerlin()} />
                        {k.holder_employee_id ? (
                          <button class="btn sm sec" name="action" value="rueckgabe">
                            Rückgabe heute
                          </button>
                        ) : (
                          <>
                            <select name="employee_id" required aria-label="Mitarbeiter">
                              <option value="">– an … –</option>
                              {employees.map((e) => (
                                <option value={e.id}>
                                  {e.name}
                                  {e.here ? '' : ' (anderes Objekt)'}
                                </option>
                              ))}
                            </select>
                            <button class="btn sm" name="action" value="ausgabe">
                              Ausgeben
                            </button>
                          </>
                        )}
                      </form>
                    </td>
                  </tr>
                ))}
                {!keys.length && (
                  <tr>
                    <td colspan={5} class="mut">
                      Noch keine Schlüssel für dieses Objekt.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <form
            method="post"
            action={`/schluessel/${randomUUID()}`}
            data-autosave={`${back}#neu`}
            style="margin-top:18px"
          >
            <h3 class="panel-title">
              <Icon name="plus" size={14} /> Schlüssel erfassen
            </h3>
            <input type="hidden" name="site_id" value={s.id} />
            <input type="hidden" name="back" value={back} />
            <div class="grid">
              <div>
                <label for="key_no">Schlüsselnummer</label>
                <input id="key_no" name="key_no" value={nextNo} required />
              </div>
              <div>
                <label for="description">Beschreibung</label>
                <input
                  id="description"
                  name="description"
                  required
                  placeholder="Haupteingang, Technikraum …"
                />
              </div>
              <div>
                <label for="quantity">Anzahl</label>
                <input id="quantity" name="quantity" type="number" min={1} value="1" />
              </div>
              <div>
                <label for="notes">Notiz</label>
                <input id="notes" name="notes" />
              </div>
            </div>
            <div class="actions">
              <button class="btn">Schlüssel speichern</button>
            </div>
          </form>
        </>
      );
    }),
  );
}
