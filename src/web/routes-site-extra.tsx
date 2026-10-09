import { randomUUID } from 'node:crypto';
import { listWordTemplates } from '../services/word-templates.js';
import { WordTemplateBox } from './routes-word-templates.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { listKeys } from '../services/inventory.js';
import { listOffers } from '../services/offers.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID, assertSite } from './app.js';
import {
  FOLDER_QUESTIONS,
  type FolderInfo,
  buildFolderPdf,
  buildFolderZip,
  folderFacts,
  packageInfo,
  saveFolderInfo,
} from '../services/site-folder.js';
import { FileArea } from './files.js';
import { zipHref } from './routes-files.js';
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
export function registerSiteExtraRoutes({ app, deps, shells, back }: Ctx) {
  const { sql, env } = deps;

  // ------------------------------------------------------------------ Objektordner
  app.get(`/objekte/:id{${UUID}}/objektordner`, (c) =>
    shells.site!(c, 'objektordner', async (s) => {
      const f = await folderFacts(sql, s.id);
      const pkg = await packageInfo(sql);
      const asks = f.missing.filter((m) => m.key);
      const links = f.missing.filter((m) => !m.key);
      return (
        <>
          <div class="card">
            <div class="actions" style="margin-top:0;justify-content:space-between">
              <div>
                <h3 style="margin:0">Objektordner für {s.name}</h3>
                <div class="small mut">
                  Ein PDF zum Ausdrucken: Deckblatt, Inhaltsverzeichnis, Objektstammblatt mit Kontakten,
                  Leistungsverzeichnis (ohne Preise), Reinigungsplan aus dem Raumbuch, Revierplan aus den
                  Einsätzen, alle Vorlagen aus dem Objektordner-Paket mit den Objektdaten und leere
                  Nachweislisten.
                </div>
              </div>
              <div class="actions" style="margin:0">
                <a class="btn" href={`/objekte/${s.id}/objektordner.pdf`} target="_blank">
                  <Icon name="download" /> Objektordner als PDF (zum Drucken)
                </a>
                <a class="btn sec sm" href={`/objekte/${s.id}/objektordner.zip`}>
                  Word-Dateien (ZIP)
                </a>
              </div>
            </div>
            {!pkg && (
              <div class="flash warn" style="margin-bottom:0">
                Das Vorlagenpaket (ZIP „Objektordner-Komplettpaket“) ist noch nicht hochgeladen – unter{' '}
                <a href="/einstellungen/objektordner">Einstellungen → Objektordner-Vorlagen</a>. Bis dahin
                enthält der Ordner nur die PDFs aus der App.
              </div>
            )}
          </div>
          {f.missing.length > 0 ? (
            <div class="flash warn">
              <b>Es fehlen noch {f.missing.length} Angaben</b> – sonst bleiben im Ordner Lücken (Linie zum
              Ausfüllen von Hand).
              {links.length > 0 && (
                <ul style="margin:6px 0 0 18px">
                  {links.map((m) => (
                    <li>{m.href ? <a href={m.href}>{m.label}</a> : m.label}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div class="flash ok">Alle Angaben für den Objektordner sind vorhanden.</div>
          )}
          <form method="post" action={`/objekte/${s.id}/objektordner`} class="card">
            <h3 style="margin-top:0">Angaben für den Objektordner</h3>
            {asks.length > 0 && (
              <p class="small" style="margin-top:0;color:var(--err)">
                Bitte ausfüllen: {asks.map((m) => m.label).join(', ')}
              </p>
            )}
            <div class="grid">
              {FOLDER_QUESTIONS.map((q) => (
                <div>
                  <label for={`fi-${q.key}`}>
                    {q.label}
                    {q.required && !f.info[q.key] && asks.some((m) => m.key === q.key) ? ' *' : ''}
                  </label>
                  <input
                    id={`fi-${q.key}`}
                    name={q.key}
                    value={f.info[q.key] ?? ''}
                    placeholder={
                      q.key === 'ansprechpartner' && f.contact
                        ? `aus Kontakten: ${f.contact.name}`
                        : q.key === 'ansprechpartner_tel' && f.contact?.phone
                          ? `aus Kontakten: ${f.contact.phone}`
                          : q.hint
                    }
                    style={asks.some((m) => m.key === q.key) ? 'border-color:var(--err)' : ''}
                  />
                </div>
              ))}
            </div>
            <div class="formfoot">
              <button class="btn">Speichern</button>
            </div>
          </form>
          <div class="card small">
            <b>Bereits aus der App übernommen:</b> Objekt, Adresse, Kunde, Objektleitung
            {f.manager
              ? ` (${f.manager.name}${f.manager.phone ? `, ${f.manager.phone}` : ''})`
              : ' – fehlt'}, {f.rooms} Räume, {f.services} Leistungen, {f.plans} Einsätze, {f.keys} Schlüssel.
          </div>
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/objektordner`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const b = await c.req.parseBody();
    const info: FolderInfo = {};
    for (const q of FOLDER_QUESTIONS) if (typeof b[q.key] === 'string') info[q.key] = b[q.key] as string;
    await saveFolderInfo(sql, id, info, c.get('actor'));
    return back(c, `/objekte/${id}/objektordner`, { ok: 'Angaben gespeichert.' });
  });

  app.get(`/objekte/:id{${UUID}}/objektordner.zip`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const r = await buildFolderZip(deps, id);
    return c.body(r.zip as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'Cache-Control': 'private, no-store',
    });
  });

  app.get(`/objekte/:id{${UUID}}/objektordner.pdf`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const r = await buildFolderPdf(deps, id);
    return c.body(r.pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'Cache-Control': 'private, no-store',
    });
  });

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
          <div class="actions" style="margin-top:0">
            {files.length > 0 && (
              <a class="btn sm sec" href={zipHref('site', s.id, `Objekt_${s.site_no}`)}>
                Alle als ZIP herunterladen
              </a>
            )}
            <a class="btn sm sec" href={`/brief?an=objekt&id=${s.id}`}>
              Freien Brief schreiben
            </a>
          </div>
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
           -- Objektleitung: nur Leute dieses Objekts (zugeordnet oder eingeplant)
           and (${c.get('sites') === null}
                or exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = ${s.id})
                or exists (select 1 from app.shift_plans sp where sp.employee_id = e.id and sp.site_id = ${s.id}
                             and (sp.valid_until is null or sp.valid_until >= ${todayBerlin()})))
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
