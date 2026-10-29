import { randomUUID } from 'node:crypto';
import { listWordTemplates } from '../services/word-templates.js';
import { WordTemplateBox } from './routes-word-templates.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { AttendanceForm, attendancePdfForSites, attendanceQuery } from './attendance-form.js';
import { listKeys, nextKeyNo } from '../services/inventory.js';
import { listOffers } from '../services/offers.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID, assertSite } from './app.js';
import { BusinessError } from '../services/errors.js';
import {
  FOLDER_QUESTIONS,
  type FolderInfo,
  buildFolderPdf,
  buildPostersPdf,
  getPosters,
  buildFolderZip,
  folderFacts,
  packageInfo,
  saveFolderInfo,
  saveSiteSpecial,
} from '../services/site-folder.js';
import { DocFoldAll, FileArea, docOpen } from './files.js';
import { fillHospital } from '../services/hospital.js';
import { listSafetySheets } from '../services/safety-sheets.js';
import { zipHref } from './routes-files.js';
import { Icon } from './icons.js';
import { raw } from 'hono/html';
import { pictoSvg } from '../pdf/pictos.js';
import { anz, dateDe } from './layout.js';
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
  { name: 'Fotos', required: false, hint: 'Fotos mit Stempel aus der App (Verwaltung → Foto)' },
  { name: 'Schlüssel', required: false, hint: 'Schlüsselübergabeprotokolle, Schließpläne' },
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
      const sdbCount = (await listSafetySheets(sql)).length;
      const posters = (await getPosters(sql)).filter((p) => p.active);
      const canEditPosters = ['admin', 'buchhaltung', 'personal'].includes(c.get('user').role);
      const [{ workers } = { workers: 0 }] = await sql<{ workers: number }[]>`
        select count(distinct employee_id)::int as workers from app.shift_plans
         where site_id = ${s.id} and employee_id is not null and (valid_until is null or valid_until >= current_date)`;
      const links = f.missing.filter((m) => !m.key);
      return (
        <>
          <div class="card">
            <div class="actions" style="margin-top:0;justify-content:space-between">
              <div>
                <h3 style="margin:0">Objektordner für {s.name}</h3>
                <div class="small mut">
                  Ein PDF zum Ausdrucken: Deckblatt, Inhaltsverzeichnis, Objektstammblatt mit Kontakten,
                  Revierplan, Leistungsverzeichnis und Raumbuch aus den eingescannten Unterlagen (Reiter
                  „Dokumente“), die Aushänge für den Putzraum (mit Piktogrammen), die Anweisungen aus dem
                  Objektordner-Paket – fertig ausgefüllt, ohne Unterschriftsfelder –, Sicherheitsdatenblätter
                  und die Anwesenheitsliste. Register-Nummern am Rand wie bei einem Ordner.
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
            {posters.length > 0 && (
              <div class="poster-box">
                <div class="poster-head">
                  <div>
                    <b>Aushänge für den Putzraum</b>
                    <div class="small mut">
                      {posters.length} Aushänge mit Skizzen, mit den Angaben dieses Objekts – gesamt oder
                      einzeln zum Aushängen.
                    </div>
                  </div>
                  <a class="btn" href={`/objekte/${s.id}/aushang/alle.pdf`} target="_blank">
                    <Icon name="download" /> Alle Aushänge ({posters.length} Seiten)
                  </a>
                </div>
                <div class="poster-grid">
                  {posters.map((p) => (
                    <a class="poster-tile" href={`/objekte/${s.id}/aushang/${p.key}.pdf`} target="_blank">
                      {p.sketch ? (
                        <img
                          class="poster-sk"
                          src={`/aushaenge/skizze/${p.sketch}.png`}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span class="poster-ic">{raw(pictoSvg(p.icon, 26))}</span>
                      )}
                      <span class="poster-t">
                        <b>{p.title}</b>
                        <span class="small mut">
                          {p.steps.length} Schritte{p.sketch ? ' · Skizze' : ''}
                        </span>
                      </span>
                      <span class="poster-dl" title="PDF herunterladen">
                        <Icon name="download" />
                      </span>
                    </a>
                  ))}
                </div>
                <div class="actions" style="margin:8px 0 0">
                  {sdbCount > 0 && (
                    <a class="btn sec sm" href="/sicherheitsdatenblaetter.pdf" target="_blank">
                      <Icon name="download" /> Sicherheitsdatenblätter ({sdbCount})
                    </a>
                  )}
                  {canEditPosters && (
                    <a class="small" href="/einstellungen/objektordner/aushaenge" style="align-self:center">
                      Texte der Aushänge ändern
                    </a>
                  )}
                </div>
              </div>
            )}
            {posters.length === 0 && sdbCount > 0 && (
              <div class="actions">
                <a class="btn sec sm" href="/sicherheitsdatenblaetter.pdf" target="_blank">
                  <Icon name="download" /> Sicherheitsdatenblätter ({sdbCount})
                </a>
              </div>
            )}
            <AttendanceForm action={`/objekte/${s.id}/anwesenheit.pdf`} />
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
              <b>Es fehlen noch {f.missing.length} Angaben</b> – solange sie fehlen, lässt der Ordner die
              betreffenden Zeilen weg (es bleibt nichts zum Ausfüllen von Hand).
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
            {['Kontakte', 'Notfall- und Meldeplan', 'Abfall', 'Sonstiges'].map((g) => (
              <>
                <div class="group-title">{g}</div>
                <div class="grid">
                  {FOLDER_QUESTIONS.filter((q) => (q.group ?? 'Kontakte') === g).map((q) => (
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
                      {q.key === 'krankenhaus' && (
                        <button
                          class="btn ghost sm"
                          type="submit"
                          formaction={`/objekte/${s.id}/objektordner/krankenhaus`}
                          formnovalidate
                        >
                          {f.info.krankenhaus ? 'Neu ermitteln' : 'Automatisch ermitteln'}
                        </button>
                      )}
                      {q.key === 'ersthelfer' && (
                        <div class="small mut">
                          {anz(workers, 'Reinigungskraft', 'Reinigungskräfte')} eingeplant. Ein Ersthelfer ist
                          Pflicht, sobald 2 oder mehr Beschäftigte gleichzeitig arbeiten (bis 20 Personen 1,
                          darüber 10 %; § 26 DGUV Vorschrift 1) – sonst reicht der Notruf 112.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ))}
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

  app.post(`/objekte/:id{${UUID}}/objektordner/besonderheiten`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const b = await c.req.parseBody();
    await saveSiteSpecial(
      sql,
      id,
      typeof b.besonderheiten === 'string' ? b.besonderheiten : '',
      c.get('actor'),
    );
    return back(c, `/objekte/${id}#besonderheiten`, { ok: 'Besonderheiten gespeichert.' });
  });

  app.post(`/objekte/:id{${UUID}}/objektordner/krankenhaus`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const text = await fillHospital(sql, id, c.get('actor'), { force: true });
    return back(
      c,
      `/objekte/${id}/objektordner`,
      text
        ? { ok: `Nächstes Krankenhaus: ${text} – bitte einmal prüfen.` }
        : {
            fehler:
              'Kein Krankenhaus gefunden (Adresse prüfen oder Internetverbindung) – bitte von Hand eintragen.',
          },
    );
  });

  app.get(`/objekte/:id{${UUID}}/aushang/:file`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const key = c.req.param('file').replace(/\.pdf$/, '');
    if (key !== 'alle' && !(await getPosters(sql)).some((p) => p.key === key)) return c.notFound();
    if (key === 'alle' || key === 'notfall') await fillHospital(sql, id, c.get('actor'));
    const r = await buildPostersPdf(deps, id, key === 'alle' ? undefined : key);
    return c.body(r.pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'Cache-Control': 'private, no-store',
    });
  });

  app.get(`/objekte/:id{${UUID}}/objektordner.zip`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    await fillHospital(sql, id, c.get('actor'));
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
    await fillHospital(sql, id, c.get('actor'));
    const r = await buildFolderPdf(deps, id);
    return c.body(r.pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'Cache-Control': 'private, no-store',
    });
  });

  /** Anwesenheitsliste: zwei Monate nebeneinander je Seite (Ahmed 10.10.) */
  app.get(`/objekte/:id{${UUID}}/anwesenheit.pdf`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const { month, pages } = attendanceQuery((k) => c.req.query(k));
    const pdf = await attendancePdfForSites(sql, [id], month, pages);
    const [f] = await sql<{ site_no: string }[]>`select site_no from app.sites where id = ${id}`;
    return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Anwesenheitsliste_${f?.site_no ?? 'Objekt'}_${month}.pdf"`,
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
  // Pflichtdokument je Objekt abwählen („nicht nötig“) bzw. wieder als Pflicht führen (Ahmed 17.10.)
  app.post(`/objekte/:id{${UUID}}/dokumente/pflicht`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const b = await c.req.parseBody();
    const cat = String(b.category ?? '');
    if (!SITE_DOC_CATEGORIES.some((k) => k.required && k.name === cat))
      throw new BusinessError('Unbekannte Dokumentart');
    const needed = b.needed === '1';
    await sql.begin(async (tx) => {
      await tx`update app.sites set docs_not_needed = ${
        needed
          ? tx`array_remove(docs_not_needed, ${cat})`
          : tx`array_append(array_remove(docs_not_needed, ${cat}), ${cat})`
      } where id = ${id}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${c.get('actor')}, ${needed ? 'doc_required' : 'doc_not_needed'}, 'site', ${id},
                       ${tx.json({ category: cat })})`;
    });
    return back(c, `/objekte/${id}/dokumente#kat-${cat}`, {
      ok: needed ? `${cat} ist wieder Pflicht.` : `${cat} ist für dieses Objekt nicht nötig.`,
    });
  });

  app.get(`/objekte/:id{${UUID}}/dokumente`, (c) =>
    shells.site!(c, 'dokumente', async (s) => {
      const files = await listFiles(sql, { type: 'site', id: s.id });
      const known = new Set(SITE_DOC_CATEGORIES.map((k) => k.name));
      const [{ docs_not_needed: notNeeded } = { docs_not_needed: [] as string[] }] = await sql<
        { docs_not_needed: string[] }[]
      >`select docs_not_needed from app.sites where id = ${s.id}`;
      const isRequired = (k: (typeof SITE_DOC_CATEGORIES)[number]) =>
        k.required && !notNeeded.includes(k.name);
      const missing = SITE_DOC_CATEGORIES.filter(
        (k) => isRequired(k) && !files.some((f) => f.category === k.name),
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
            {c.get('user').role !== 'objektleitung' && (
              <>
                <a class="btn sm sec" href={`/objekte/${s.id}/vertrag?art=reinigung`}>
                  Reinigungsvertrag erstellen
                </a>
                <a class="btn sm sec" href={`/objekte/${s.id}/vertrag?art=aue`}>
                  Arbeitnehmerüberlassungsvertrag erstellen
                </a>
              </>
            )}
          </div>
          <details class="card doc-cat">
            <summary>
              <b>Anwesenheitsliste drucken</b>{' '}
              <span class="mut small">(zwei Monate je Seite, z. B. für den Kunden)</span>
            </summary>
            <AttendanceForm action={`/objekte/${s.id}/anwesenheit.pdf`} />
          </details>
          {missing.length > 0 ? (
            <div class="flash warn">
              Pflichtdokumente fehlen: <b>{missing.map((m) => m.name).join(', ')}</b>
            </div>
          ) : (
            <div class="flash ok">Alle Pflichtdokumente sind vorhanden.</div>
          )}
          <div style="margin:0 0 8px">
            <DocFoldAll />
          </div>
          {SITE_DOC_CATEGORIES.map((k) => {
            const list = files.filter((f) => f.category === k.name);
            return (
              <details class="doc-cat card" id={`kat-${k.name}`} open={docOpen(list.length)}>
                <summary>
                  <b>{k.name}</b> <span class="mut small">({list.length})</span>
                  {k.required &&
                    (list.length ? (
                      <span class="tag ok">vorhanden</span>
                    ) : isRequired(k) ? (
                      <span class="tag err">Pflicht – fehlt</span>
                    ) : (
                      <span class="tag">nicht nötig</span>
                    ))}
                </summary>
                {k.required && !list.length && (
                  <form method="post" action={`/objekte/${s.id}/dokumente/pflicht`} style="margin:0 0 6px">
                    <input type="hidden" name="category" value={k.name} />
                    <input type="hidden" name="needed" value={isRequired(k) ? '' : '1'} />
                    <button class="btn sm ghost">
                      {isRequired(k) ? 'Für dieses Objekt nicht nötig' : 'Wieder als Pflicht führen'}
                    </button>
                  </form>
                )}
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
              </details>
            );
          })}
          {other.length > 0 && (
            <details class="doc-cat card" open={docOpen(other.length)}>
              <summary>
                <b>Weitere Dateien</b> <span class="mut small">({other.length})</span>
              </summary>
              <FileArea
                link={{ type: 'site', id: s.id }}
                files={other}
                maxBytes={env.UPLOAD_MAX_BYTES}
                listOnly
              />
            </details>
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
      const nextNo = await nextKeyNo(sql, s.id);
      const out = keys.filter((k) => k.holder_employee_id || k.holder_supplier_id).length;
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
                        {k.holder_employee_id || k.holder_supplier_id ? (
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
