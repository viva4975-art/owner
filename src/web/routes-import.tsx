import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { type FtxResult, importFtx, parseFtx } from '../services/fortytools-xml-import.js';
import {
  analyze,
  applyImport,
  IMPORT_KIND,
  type ImportKind,
  listImports,
  stagedFile,
  stageFile,
} from '../services/fortytools-import.js';
import { BusinessError } from '../services/errors.js';
import {
  applyPlan,
  buildPlan,
  detectTable,
  FT_FILE,
  type FtFile,
  planCounts,
  stagedFtFile,
  stageFtFile,
} from '../services/fortytools-export-import.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';

const kindOf = (v: unknown): ImportKind =>
  typeof v === 'string' && v in IMPORT_KIND ? (v as ImportKind) : 'kunden';

export function registerImportRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/transfer/import', async (c) => {
    const imports = await listImports(sql);
    return page(
      c,
      'Import aus Fortytools',
      'transfer',
      <>
        <PageHead title="Import aus Fortytools" crumbs={[['Transfer', '/transfer/kontoumsaetze']]} />
        <form
          method="post"
          action="/transfer/import/fortytools-xml"
          enctype="multipart/form-data"
          class="card"
        >
          <h3 style="margin-top:0">Fortytools-Datensicherung (XML) – empfohlen</h3>
          <p class="small mut" style="margin-top:0">
            Die XML-Exporte <b>customers, facilities, staff_members, offers, invoices</b> (alle auf einmal).
            Übernimmt Kunden, Objekte mit den echten Fortytools-Objektnummern, Mitarbeiter (Wochenstunden,
            Urlaub, Krankenkasse, Sprache), Angebote mit Positionen und alle Rechnungen als unveränderbares
            Archiv; offene Fortytools-Rechnungen erscheinen unter Offene Posten. Objekte ohne regelmäßige
            Leistung bekommen die Monatspauschale aus ihrer letzten Monatsrechnung (gültig ab dem Folgemonat –
            kein doppeltes Abrechnen). Rechnungs- und Angebotsnummern der App werden über die höchste
            Fortytools-Nummer gehoben. Vorhandene Daten werden nur ergänzt, nicht überschrieben; erneut
            importieren legt nichts doppelt an. Erst Vorschau.
          </p>
          <input type="file" name="dateien" accept=".xml" multiple required aria-label="XML-Dateien" />
          <div class="actions" style="margin-bottom:0">
            <button class="btn">Prüfen (Vorschau)</button>
          </div>
        </form>
        <form method="post" action="/transfer/import/fortytools" enctype="multipart/form-data" class="card">
          <h3 style="margin-top:0">Gesamtimport: Fortytools-Exporte unverändert (CSV)</h3>
          <p class="small mut" style="margin-top:0">
            Die Exporte aus Fortytools so wie sie sind (Kunden, Objekte, aktive Leistungen, Mitarbeiter) –
            alle auf einmal oder einzeln. Die Dateien werden an der Kopfzeile erkannt. Interessenten ohne
            Kundennummer bekommen eine neue Nummer, Objekte die Nummer Kundennummer + zweistellig. Erst
            Vorschau, gespeichert wird erst nach „Übernehmen“. Erneut importieren legt nichts doppelt an.
          </p>
          <div class="grid">
            <div>
              <label for="ftdateien">CSV-Dateien</label>
              <input id="ftdateien" type="file" name="dateien" accept=".csv,.txt" multiple required />
            </div>
          </div>
          <div class="actions" style="margin-bottom:0">
            <button class="btn">Prüfen (Vorschau)</button>
          </div>
        </form>
        <details class="card" id="einzeln">
          <summary>
            <b>Nur für eigene Tabellen:</b> einzelne Liste mit eigenen Spalten (nicht für die
            Fortytools-Exporte)
          </summary>
          <form method="post" action="/transfer/import" enctype="multipart/form-data" style="margin-top:12px">
            <p class="small mut" style="margin-top:0">
              CSV-Export aus Fortytools (oder Excel „Speichern unter → CSV“). Spalten werden über die
              Kopfzeile erkannt. Reihenfolge: <b>1. Kunden → 2. Objekte → 3. Leistungen</b>. Erst kommt eine
              Vorschau mit allen Fehlern – gespeichert wird erst nach „Übernehmen“. Zweimal importieren legt
              nichts doppelt an.
            </p>
            <div class="grid">
              <div>
                <label for="art">Was wird importiert?</label>
                <select id="art" name="art">
                  {(Object.keys(IMPORT_KIND) as ImportKind[]).map((k) => (
                    <option value={k}>{IMPORT_KIND[k]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label for="datei">CSV-Datei</label>
                <input id="datei" type="file" name="datei" accept=".csv,.txt" required />
              </div>
            </div>
            <div class="actions" style="margin-bottom:0">
              <button class="btn">Prüfen (Vorschau)</button>
            </div>
          </form>
          <div class="card">
            <h3 style="margin-top:0">Erkannte Spalten</h3>
            <ul class="small">
              <li>
                <b>Kunden:</b> Kundennummer*, Name/Firma*, Straße*, PLZ*, Ort*, Name 2, USt-ID, Leitweg-ID,
                Lieferantennummer, Rechnungs-E-Mail, Rechnungsformat, Zahlungsziel, Skonto, Skontotage,
                Ansprechpartner, Telefon
              </li>
              <li>
                <b>Objekte:</b> Objektnummer*, Kundennummer*, Bezeichnung*, Straße, PLZ, Ort, Bestellnummer,
                Vertragsnummer
              </li>
              <li>
                <b>Leistungen:</b> Objektnummer*, Leistung*, Preis*, Menge, Einheit, USt, Beginn, Ende, Zyklus
                (monatlich, quartalsweise …), Art (Pauschale, Sonderleistung, Regie), Zusatztext
              </li>
            </ul>
            <p class="small mut">* Pflicht. Ohne Rechnungsformat: mit Leitweg-ID XRechnung, sonst ZUGFeRD.</p>
          </div>
        </details>
        {imports.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Bisherige Importe</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Zeitpunkt</th>
                    <th>Art</th>
                    <th>Datei</th>
                    <th class="r">Zeilen</th>
                    <th class="r">neu</th>
                    <th class="r">aktualisiert</th>
                    <th class="r">übersprungen</th>
                    <th class="r">Fehler</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((i) => (
                    <tr>
                      <td>
                        {i.created_at.toLocaleString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </td>
                      <td>{IMPORT_KIND[i.kind] ?? 'Gesamtimport'}</td>
                      <td>{i.filename}</td>
                      <td class="r">{i.row_count}</td>
                      <td class="r">{i.created_count}</td>
                      <td class="r">{i.updated_count}</td>
                      <td class="r">{i.skipped_count}</td>
                      <td class="r" style={i.error_count ? 'color:var(--err)' : ''}>
                        {i.error_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>,
    );
  });

  app.post('/transfer/import', async (c) => {
    const b = await c.req.parseBody();
    const file = b.datei;
    if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte eine CSV-Datei wählen');
    const sha = await stageFile(deps, new Uint8Array(await file.arrayBuffer()));
    const name = encodeURIComponent(file.name.slice(0, 120));
    return c.redirect(`/transfer/import/vorschau?art=${kindOf(b.art)}&datei=${sha}&name=${name}`, 303);
  });

  app.get('/transfer/import/vorschau', async (c) => {
    const kind = kindOf(c.req.query('art'));
    const sha = c.req.query('datei') ?? '';
    const name = c.req.query('name') ?? 'import.csv';
    const a = await analyze(sql, kind, await stagedFile(deps, sha));
    const count = (s: string) => a.rows.filter((r) => r.status === s).length;
    return page(
      c,
      'Import prüfen',
      'transfer',
      <>
        <PageHead
          title={`Import prüfen: ${IMPORT_KIND[kind]}`}
          no={name}
          crumbs={[
            ['Transfer', '/transfer/kontoumsaetze'],
            ['Import aus Fortytools', '/transfer/import'],
          ]}
        />
        <div class="kpis">
          <div class="kpi">
            <div class="l">neu</div>
            <div class="v">{count('neu')}</div>
          </div>
          <div class="kpi">
            <div class="l">schon vorhanden</div>
            <div class="v">{count('vorhanden')}</div>
          </div>
          <div class="kpi">
            <div class="l">mit Fehlern (werden nicht übernommen)</div>
            <div class="v" style={count('fehler') ? 'color:var(--err)' : ''}>
              {count('fehler')}
            </div>
          </div>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Spaltenzuordnung</h3>
          <p class="small">
            {a.columns.map((col) => (
              <span class={`badge ${col.header ? 'ok' : col.required ? 'err' : ''}`} style="margin:2px">
                {col.label} ← {col.header ?? '–'}
              </span>
            ))}
          </p>
          {a.unknownHeaders.length > 0 && (
            <p class="small mut">Nicht verwendet: {a.unknownHeaders.join(', ')}</p>
          )}
        </div>
        <form method="post" action="/transfer/import/uebernehmen" class="card">
          <input type="hidden" name="id" value={randomUUID()} />
          <input type="hidden" name="art" value={kind} />
          <input type="hidden" name="datei" value={sha} />
          <input type="hidden" name="name" value={name} />
          <div class="tbl" style="max-height:60vh;overflow:auto">
            <table class="small">
              <thead>
                <tr>
                  <th>Zeile</th>
                  <th>Status</th>
                  {a.columns
                    .filter((col) => col.header)
                    .map((col) => (
                      <th>{col.label}</th>
                    ))}
                  <th>Fehler</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr style={r.status === 'fehler' ? 'background:var(--err-50)' : ''}>
                    <td>{r.line}</td>
                    <td>
                      <span
                        class={`badge ${r.status === 'neu' ? 'ok' : r.status === 'fehler' ? 'err' : 'info'}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    {a.columns
                      .filter((col) => col.header)
                      .map((col) => (
                        <td>{r.data[col.field]}</td>
                      ))}
                    <td style="color:var(--err)">{r.errors.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label>
            <input type="checkbox" name="update" /> vorhandene Datensätze mit den Werten aus der Datei
            überschreiben
          </label>
          <div class="formfoot">
            <a class="btn sec" href="/transfer/import">
              Andere Datei
            </a>
            <button class="btn" disabled={!count('neu') && !count('vorhanden')}>
              {count('neu')} neue übernehmen
            </button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/transfer/import/fortytools', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const files = (Array.isArray(b.dateien) ? b.dateien : [b.dateien]).filter(
      (f): f is File => f instanceof File && f.size > 0,
    );
    if (!files.length) throw new BusinessError('Bitte mindestens eine CSV-Datei wählen');
    const staged = [];
    for (const f of files) {
      const s = await stageFtFile(deps, new Uint8Array(await f.arrayBuffer()));
      staged.push(`${s.sha}:${encodeURIComponent(f.name.slice(0, 80))}`);
    }
    return c.redirect(`/transfer/import/fortytools?f=${staged.join(',')}`, 303);
  });

  const ftFiles = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .filter(Boolean)
      .slice(0, 8)
      .map((x) => {
        const [sha = '', name = ''] = x.split(':');
        return { sha, name: decodeURIComponent(name) || 'export.csv' };
      });

  app.get('/transfer/import/fortytools', async (c) => {
    const files = ftFiles(c.req.query('f'));
    if (!files.length) return c.redirect('/transfer/import', 303);
    const tables = await Promise.all(files.map(async (f) => detectTable(await stagedFtFile(deps, f.sha))));
    const plan = await buildPlan(sql, tables);
    const n = planCounts(plan);
    const errors = plan.issues.filter((i) => i.level === 'fehler');
    const hints = plan.issues.filter((i) => i.level === 'hinweis');
    const total = (Object.keys(FT_FILE) as FtFile[]).reduce((s, k) => s + n[k].neu + n[k].vorhanden, 0);
    const lists: [FtFile, { label: string; status: string }[]][] = [
      ['kunden', plan.customers],
      ['objekte', plan.sites],
      ['leistungen', plan.services],
      ['mitarbeiter', plan.employees],
    ];
    return page(
      c,
      'Import prüfen',
      'transfer',
      <>
        <PageHead
          title="Gesamtimport prüfen"
          crumbs={[
            ['Transfer', '/transfer/kontoumsaetze'],
            ['Import aus Fortytools', '/transfer/import'],
          ]}
        />
        <div class="card">
          <p class="small" style="margin:0">
            Erkannt:{' '}
            {tables.map((t, i) => (
              <span class="badge ok" style="margin:2px">
                {FT_FILE[t.kind]} ← {files[i]!.name} ({t.rows.length} Zeilen)
              </span>
            ))}
          </p>
        </div>
        <div class="tbl card">
          <table>
            <thead>
              <tr>
                <th></th>
                <th class="r">neu</th>
                <th class="r">schon vorhanden</th>
                <th class="r">mit Fehlern (nicht übernommen)</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(FT_FILE) as FtFile[])
                .filter((k) => plan.files.includes(k) || n[k].neu + n[k].vorhanden + n[k].fehler > 0)
                .map((k) => (
                  <tr>
                    <td>{FT_FILE[k]}</td>
                    <td class="r">{n[k].neu}</td>
                    <td class="r">{n[k].vorhanden}</td>
                    <td class="r" style={n[k].fehler ? 'color:var(--err)' : ''}>
                      {n[k].fehler}
                    </td>
                  </tr>
                ))}
              <tr>
                <td class="mut">dazu Kontakte / Bankkonten</td>
                <td class="r mut" colspan={3}>
                  {n.kontakte} / {n.bankkonten}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {errors.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0;color:var(--err)">
              Fehler ({errors.length}) – diese Zeilen werden nicht übernommen
            </h3>
            <ul class="small">
              {errors.map((i) => (
                <li>
                  <b>{FT_FILE[i.area]}</b> {i.ref}: {i.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        {hints.length > 0 && (
          <details class="card">
            <summary>
              <b>Hinweise ({hints.length})</b> – werden übernommen, bitte danach prüfen
            </summary>
            <ul class="small">
              {hints.slice(0, 1000).map((i) => (
                <li>
                  <b>{FT_FILE[i.area]}</b> {i.ref}: {i.text}
                </li>
              ))}
            </ul>
          </details>
        )}
        {lists
          .filter(([, l]) => l.length)
          .map(([k, l]) => (
            <details class="card">
              <summary>
                <b>{FT_FILE[k]}</b> – alle {l.length} anzeigen
              </summary>
              <ul class="small" style="columns:2">
                {l.map((x) => (
                  <li>
                    <span
                      class={`badge ${x.status === 'neu' ? 'ok' : x.status === 'fehler' ? 'err' : 'info'}`}
                    >
                      {x.status}
                    </span>{' '}
                    {x.label}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        <form method="post" action="/transfer/import/fortytools/uebernehmen" class="card">
          <input type="hidden" name="id" value={randomUUID()} />
          <input type="hidden" name="f" value={c.req.query('f') ?? ''} />
          <p class="small mut" style="margin-top:0">
            Leistungsarten werden angelegt, falls sie fehlen. Abrechnung: Unterhaltsreinigung und Spüldienste
            monatlich, alles andere „je Ausführung“ (bitte je Objekt prüfen). Steuersatz 19 %.
          </p>
          <label>
            <input type="checkbox" name="update" /> vorhandene Datensätze mit den Werten aus den Dateien
            überschreiben (Nummern bleiben; bei Kunden auch Zahlungsziel/Skonto/E-Mail der Rechnungsgruppe
            „Standard“; bei Mitarbeitenden nur die Felder aus Fortytools) – empfohlen, wenn schon Kunden über
            die einzelne Liste importiert wurden
          </label>
          <div class="formfoot">
            <a class="btn sec" href="/transfer/import">
              Andere Dateien
            </a>
            <button class="btn" disabled={!total} onclick="return confirm('Import jetzt übernehmen?')">
              Übernehmen
            </button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/transfer/import/fortytools/uebernehmen', async (c) => {
    const b = await c.req.parseBody();
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const r = await applyPlan(deps, {
      id,
      files: ftFiles(typeof b.f === 'string' ? b.f : ''),
      update: b.update === 'on',
      actor: c.get('actor'),
    });
    return back(c, '/transfer/import', {
      ok: `Gesamtimport: ${r.created} neu, ${r.updated} aktualisiert, ${r.skipped} übersprungen, ${r.errors.length} mit Fehlern.`,
    });
  });

  // ------------------------------------------------------------------ Fortytools-XML
  const xmlPath = (sha: string) => `importe/${sha.slice(0, 2)}/${sha}.xml`;
  app.post('/transfer/import/fortytools-xml', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const files = (Array.isArray(b.dateien) ? b.dateien : [b.dateien]).filter(
      (f): f is File => f instanceof File && f.size > 0,
    );
    if (!files.length) throw new BusinessError('Bitte die XML-Dateien wählen');
    const staged = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length > 60 * 1024 * 1024) throw new BusinessError(`${f.name}: zu groß (höchstens 60 MB)`);
      parseFtx(bytes); // erkennt die Art, sonst Fehlermeldung
      const sha = createHash('sha256').update(bytes).digest('hex');
      await deps.archive.put(xmlPath(sha), bytes);
      staged.push(sha);
    }
    return c.redirect(`/transfer/import/fortytools-xml?f=${staged.join(',')}`, 303);
  });
  const xmlFiles = async (v: string) => {
    const shas = v
      .split(',')
      .filter((x) => /^[0-9a-f]{64}$/.test(x))
      .slice(0, 10);
    return Promise.all(
      shas.map(async (sha) => {
        try {
          return { name: sha, data: await deps.archive.get(xmlPath(sha)) };
        } catch {
          throw new BusinessError('Datei nicht mehr vorhanden – bitte erneut hochladen');
        }
      }),
    );
  };
  const FtxView = ({ r }: { r: FtxResult }) => (
    <>
      <div class="card">
        <h3 style="margin-top:0">Dateien</h3>
        <p class="small" style="margin:0">
          {r.files.map((f) => `${f.label}: ${f.rows}`).join(' · ')}
        </p>
      </div>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Bereich</th>
              <th class="r">neu</th>
              <th class="r">ergänzt</th>
              <th class="r">unverändert</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(r.counts).map(([k, v]) => (
              <tr>
                <td>{k}</td>
                <td class="r">{v.neu}</td>
                <td class="r">{v.ergaenzt}</td>
                <td class="r">{v.unveraendert}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(r.counters.invoiceNext || r.counters.offerNext) && (
        <div class="flash warn">
          Nächste Rechnungsnummer der App: <b>{r.counters.invoiceNext ?? '–'}</b>, nächste Angebotsnummer:{' '}
          <b>{r.counters.offerNext ?? '–'}</b> (über der höchsten Fortytools-Nummer). Ab der Umstellung bitte
          in Fortytools <b>keine Rechnungen mehr</b> schreiben – sonst doppelte Nummern.
        </div>
      )}
      {r.numberClashes.length > 0 && (
        <div class="flash err">
          Diese Rechnungsnummern gibt es in Fortytools und in der App: {r.numberClashes.join(', ')} – bitte
          sofort klären (Rechnungsnummern müssen einmalig sein, § 14 Abs. 4 Nr. 4 UStG).
        </div>
      )}
      {r.issues.length > 0 && (
        <details class="card" open>
          <summary>
            <b>Hinweise ({r.issues.length})</b>
          </summary>
          <ul class="small">
            {r.issues.map((i) => (
              <li>
                {i.area}: {i.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
  app.get('/transfer/import/fortytools-xml', async (c) => {
    const f = c.req.query('f') ?? '';
    const files = await xmlFiles(f);
    if (!files.length) return c.redirect('/transfer/import', 303);
    const r = await importFtx(sql, files, { actor: c.get('actor'), dryRun: true });
    return page(
      c,
      'Fortytools-XML – Vorschau',
      'transfer',
      <>
        <PageHead title="Fortytools-Datensicherung – Vorschau" crumbs={[['Import', '/transfer/import']]} />
        <p class="mut" style="margin-top:-6px">
          Noch nichts gespeichert. So würde der Import laufen:
        </p>
        <FtxView r={r} />
        <form method="post" action="/transfer/import/fortytools-xml/uebernehmen" class="card">
          <input type="hidden" name="f" value={f} />
          <p class="small mut" style="margin-top:0">
            Angebotsstatus aus Fortytools: 1 = angenommen, 2 = abgelehnt, 3 = durch Folgeangebot ersetzt, 4 =
            offen, 5 = Entwurf (aus den Daten abgeleitet – bitte stichprobenartig prüfen).
          </p>
          <div class="formfoot">
            <a class="btn sec" href="/transfer/import">
              Andere Dateien
            </a>
            <button class="btn" onclick="return confirm('Fortytools-Daten jetzt übernehmen?')">
              Übernehmen
            </button>
          </div>
        </form>
      </>,
    );
  });
  app.post('/transfer/import/fortytools-xml/uebernehmen', async (c) => {
    const b = await c.req.parseBody();
    const files = await xmlFiles(String(b.f ?? ''));
    const r = await importFtx(sql, files, { actor: c.get('actor'), dryRun: false });
    const sum = (k: 'neu' | 'ergaenzt') => Object.values(r.counts).reduce((a, x) => a + x[k], 0);
    return back(c, '/transfer/import', {
      ok: `Fortytools-XML übernommen: ${sum('neu')} neu, ${sum('ergaenzt')} ergänzt. Nächste Rechnungsnummer ${r.counters.invoiceNext ?? '–'}.${r.numberClashes.length ? ` ACHTUNG doppelte Rechnungsnummern: ${r.numberClashes.join(', ')}` : ''}`,
    });
  });

  app.post('/transfer/import/uebernehmen', async (c) => {
    const b = await c.req.parseBody();
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const kind = kindOf(b.art);
    const r = await applyImport(deps, {
      id,
      kind,
      filename: typeof b.name === 'string' ? b.name : 'import.csv',
      bytes: await stagedFile(deps, String(b.datei ?? '')),
      update: b.update === 'on',
      actor: c.get('actor'),
    });
    return back(c, '/transfer/import', {
      ok: `${IMPORT_KIND[kind]}: ${r.created} neu, ${r.updated} aktualisiert, ${r.skipped} übersprungen, ${r.errors} mit Fehlern.`,
    });
  });
}
