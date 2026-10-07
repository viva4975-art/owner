import { importDuplicates } from '../services/import-duplicates.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { type FtxResult, importFtx, parseFtx } from '../services/fortytools-xml-import.js';
import { type ReconRow, applyReconcile, reconcileRows } from '../services/ft-reconcile.js';
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
import {
  applyArticles,
  applyTimes,
  planArticles,
  planTimes,
  stageMore,
  stagedMore,
} from '../services/fortytools-more-import.js';
import type { Ctx } from './app.js';
import { PageHead, dateDe, euro } from './layout.js';

const kindOf = (v: unknown): ImportKind =>
  typeof v === 'string' && v in IMPORT_KIND ? (v as ImportKind) : 'kunden';

export function registerImportRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  // ------------------------------------------------------------ Dubletten aus den Importen zusammenführen
  app.get('/transfer/import/dubletten', async (c) => {
    const r = await importDuplicates(sql, { apply: false, actor: c.get('actor') });
    const same = await sql<{ customer: string; name: string; n: number; sites: string }[]>`
      select c.customer_no || ' ' || c.name as customer, s.name, count(*)::int as n,
             string_agg(s.site_no, ', ' order by s.site_no) as sites
        from app.sites s join app.customers c on c.id = s.customer_id
       where s.active and exists (select 1 from app.site_services v where v.site_id = s.id and v.active
                                    and v.billing_cycle not in ('je_ausfuehrung', 'einmalig'))
       group by c.customer_no, c.name, s.name having count(*) > 1 order by 1, 2`;
    const kunden = r.pairs.filter((p) => p.kind === 'Kunde');
    const objekte = r.pairs.filter((p) => p.kind === 'Objekt');
    return page(
      c,
      'Doppelte Kunden/Objekte',
      'transfer',
      <>
        <PageHead
          title="Doppelte Kunden und Objekte"
          crumbs={[['Import aus Fortytools', '/transfer/import']]}
        />
        <p class="mut" style="max-width:960px;margin-top:-6px">
          Entstehen, wenn erst die XML-Exporte und danach die CSV-Exporte importiert werden (bis 07.10. legte
          der CSV-Import dann alles ein zweites Mal an – Leistungen und Monatsbeträge doppelt). Behalten wird
          der Datensatz aus dem XML-Import (Fortytools-Nummer, Rechnungsarchiv); alles vom doppelten Datensatz
          (Leistungen, Kontakte, Einsätze …) wird umgehängt, danach wird die Dublette gelöscht. Aus Rechnungen
          abgeleitete Monatspauschalen werden abgeschaltet, wenn das Objekt echte Leistungen aus dem
          CSV-Export hat.
        </p>
        {r.pairs.length === 0 ? (
          <div class="card empty">Keine Import-Dubletten gefunden.</div>
        ) : (
          <form
            method="post"
            action="/transfer/import/dubletten"
            class="card"
            onsubmit={`return confirm(${JSON.stringify(`${kunden.length} Kunden und ${objekte.length} Objekte zusammenführen? Das lässt sich nicht rückgängig machen (Protokoll bleibt).`)})`}
          >
            <h3 style="margin-top:0">
              {kunden.length} Kunden, {objekte.length} Objekte doppelt
            </h3>
            <div class="tbl">
              <table class="stack-m">
                <thead>
                  <tr>
                    <th>Art</th>
                    <th>Kunde</th>
                    <th>bleibt</th>
                    <th>wird zusammengeführt</th>
                    <th class="r">Leistungen</th>
                  </tr>
                </thead>
                <tbody>
                  {r.pairs.map((p) => (
                    <tr>
                      <td data-l="Art">{p.kind}</td>
                      <td data-l="Kunde" class="small">
                        {p.customer}
                      </td>
                      <td data-l="bleibt">{p.keepLabel}</td>
                      <td data-l="wird zusammengeführt" class="mut">
                        {p.dupLabel}
                      </td>
                      <td class="r" data-l="Leistungen">
                        {p.kind === 'Objekt' ? p.services : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="actions">
              <button class="btn">Jetzt zusammenführen</button>
            </div>
          </form>
        )}
        {same.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Zur Kontrolle: gleicher Objektname mehrfach beim Kunden</h3>
            <p class="small mut" style="margin-top:0">
              Diese Objekte heißen schon in Fortytools gleich. Der CSV-Export der Leistungen nennt nur den
              Objektnamen – ob jede Monatspauschale am richtigen Objekt hängt, zeigt der{' '}
              <a href="/transfer/import/abgleich">Abgleich mit den Fortytools-Rechnungen</a>.
            </p>
            <div class="tbl">
              <table class="stack-m">
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th>Objektname</th>
                    <th>Objekte</th>
                  </tr>
                </thead>
                <tbody>
                  {same.map((x) => (
                    <tr>
                      <td data-l="Kunde">{x.customer}</td>
                      <td data-l="Objektname">{x.name}</td>
                      <td data-l="Objekte" class="small">
                        {x.n}× ({x.sites})
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

  app.post('/transfer/import/dubletten', async (c) => {
    const r = await importDuplicates(sql, { apply: true, actor: c.get('actor') });
    return back(c, '/transfer/import/dubletten', {
      ok: `${r.merged} Dubletten zusammengeführt${r.deactivated.length ? `, ${r.deactivated.length} deaktiviert (hängen an Belegen)` : ''}, ${r.derivedOff} abgeleitete Monatspauschalen abgeschaltet.`,
    });
  });

  // ------------------------------------------------------------------ Abgleich Leistungen ↔ Fortytools-Rechnungen
  app.get('/transfer/import/abgleich', async (c) => {
    const alle = c.req.query('alle') === '1';
    const rows = await reconcileRows(sql);
    const show = rows.filter((r) => alle || r.status === 'abweichend' || r.status === 'nur_fortytools');
    const count = (st: ReconRow['status']) => rows.filter((r) => r.status === st).length;
    const LABEL: Record<ReconRow['status'], [string, string]> = {
      gleich: ['stimmt', 'ok'],
      abweichend: ['abweichend', 'err'],
      nur_fortytools: ['fehlt in der App', 'warn'],
      nur_app: ['nicht in Fortytools-Rechnungen', 'info'],
      alt: ['in Fortytools zuletzt älter', 'info'],
    };
    const ym = (m: string | null) => (m ? `${m.slice(5)}/${m.slice(0, 4)}` : '–');
    return page(
      c,
      'Abgleich mit Fortytools',
      'transfer',
      <>
        <PageHead
          title="Abgleich Leistungen ↔ Fortytools-Rechnungen"
          crumbs={[['Import aus Fortytools', '/transfer/import']]}
        />
        <p class="mut" style="max-width:960px;margin-top:-6px">
          Je Objekt: monatliche Leistungen in der App gegen die letzte Monatsrechnung aus Fortytools (alle
          Positionen über einen ganzen Kalendermonat, Stornos verrechnet). „Übernehmen“ beendet die
          monatlichen Leistungen des Objekts zum Ende dieses Monats und legt die Positionen der
          Fortytools-Rechnung ab dem Folgemonat an. Leistungen „je Ausführung“/„einmalig“ bleiben unverändert.
          Vorher bitte die XML-Exporte noch einmal importieren – dabei werden gleichnamige Objekte (z. B.
          „Treppenhaus“) richtig zugeordnet.
        </p>
        <div class="chips" style="margin-bottom:12px">
          <a class={`chip${alle ? '' : ' on'}`} href="/transfer/import/abgleich">
            Abweichend / fehlt ({count('abweichend') + count('nur_fortytools')})
          </a>
          <a class={`chip${alle ? ' on' : ''}`} href="/transfer/import/abgleich?alle=1">
            Alle Objekte ({rows.length})
          </a>
          <span class="small mut" style="align-self:center">
            stimmt: {count('gleich')} · nicht in Fortytools-Rechnungen: {count('nur_app')} · zuletzt älter:{' '}
            {count('alt')}
          </span>
        </div>
        {show.length === 0 ? (
          <div class="card empty">
            Alle monatlichen Leistungen stimmen mit den Fortytools-Rechnungen überein.
          </div>
        ) : (
          <form
            method="post"
            action="/transfer/import/abgleich"
            class="card"
            onsubmit="return confirm('Monatliche Leistungen der markierten Objekte aus der Fortytools-Rechnung übernehmen? Bisherige monatliche Leistungen werden beendet (bleiben sichtbar).')"
          >
            <div class="tbl">
              <table class="stack-m">
                <thead>
                  <tr>
                    <th style="width:28px">
                      <input
                        type="checkbox"
                        aria-label="alle"
                        onclick="this.closest('table').querySelectorAll('input[name=site]:not(:disabled)').forEach(x=>x.checked=this.checked)"
                      />
                    </th>
                    <th>Kunde / Objekt</th>
                    <th>Monat</th>
                    <th class="r">Fortytools</th>
                    <th class="r">App</th>
                    <th class="r">Differenz</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {show.map((r) => {
                    const can = r.status === 'abweichend' || r.status === 'nur_fortytools';
                    return (
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            name="site"
                            value={r.site_id}
                            disabled={!can}
                            aria-label={r.site_name}
                          />
                        </td>
                        <td data-l="Objekt">
                          <a href={`/objekte/${r.site_id}/leistungen`}>
                            {r.site_name} ({r.site_no})
                          </a>
                          <div class="small mut">
                            {r.customer_no} {r.customer_name}
                            {r.street ? ` · ${r.street}` : ''}
                          </div>
                          <details class="small">
                            <summary>Positionen</summary>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px">
                              <div>
                                <b>Fortytools {ym(r.ft_month)}</b>
                                {r.ft_lines.map((l) => (
                                  <div>
                                    {l.title.split('\n')[0]} – {euro(l.net_cents)}
                                  </div>
                                ))}
                                {r.ft_lines.length === 0 && <div class="mut">–</div>}
                              </div>
                              <div>
                                <b>App (monatlich)</b>
                                {r.app_lines.map((l) => (
                                  <div>
                                    {l.description} – {euro(l.amount_cents)}
                                  </div>
                                ))}
                                {r.app_lines.length === 0 && <div class="mut">–</div>}
                              </div>
                            </div>
                          </details>
                        </td>
                        <td data-l="Monat">{ym(r.ft_month)}</td>
                        <td class="r" data-l="Fortytools">
                          {r.ft_month ? euro(r.ft_cents) : '–'}
                        </td>
                        <td class="r" data-l="App">
                          {euro(r.app_cents)}
                        </td>
                        <td class="r" data-l="Differenz">
                          {r.ft_month ? euro(r.app_cents - r.ft_cents) : '–'}
                        </td>
                        <td data-l="Status">
                          <span class={`badge ${LABEL[r.status][1]}`}>{LABEL[r.status][0]}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div class="actions">
              <button class="btn">Markierte aus Fortytools-Rechnung übernehmen</button>
            </div>
          </form>
        )}
      </>,
    );
  });

  app.post('/transfer/import/abgleich', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = ([] as unknown[]).concat(b.site ?? []).map(String);
    const r = await applyReconcile(sql, ids, c.get('actor'));
    return back(c, '/transfer/import/abgleich', {
      ok: `${r.sites} Objekte abgeglichen: ${r.ended} Leistungen beendet, ${r.created} aus Fortytools übernommen.`,
    });
  });

  app.get('/transfer/import', async (c) => {
    const imports = await listImports(sql);
    return page(
      c,
      'Import aus Fortytools',
      'transfer',
      <>
        <PageHead title="Import aus Fortytools" crumbs={[['Transfer', '/transfer/kontoumsaetze']]}>
          <a class="btn sec" href="/transfer/import/dubletten">
            Doppelte Kunden/Objekte prüfen
          </a>
          <a class="btn sec" href="/transfer/import/abgleich">
            Abgleich mit Fortytools-Rechnungen
          </a>
        </PageHead>
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
        <form
          method="post"
          action="/transfer/import/fortytools-weitere"
          enctype="multipart/form-data"
          class="card"
        >
          <h3 style="margin-top:0">Artikel und erfasste Zeiten aus Fortytools (CSV)</h3>
          <p class="small mut" style="margin-top:0">
            <b>Artikel</b> (items.csv: Nummer, Name, Einkaufs-/Verkaufspreis, Bestand) und <b>Zeiten</b>{' '}
            (Zeiten.csv: Mitarbeiter, Einsatzort, Beginn/Ende/Pause). Zeiten werden als freigegebene Zeiten
            übernommen; daraus werden wöchentliche Einsätze abgeleitet (gleicher Mitarbeiter, Objekt,
            Wochentag, Beginn mindestens zweimal). Einzelne Personalnummern lassen sich ausschließen. Erst
            Vorschau, erneut importieren legt nichts doppelt an.
          </p>
          <input type="file" name="dateien" accept=".csv,.txt" multiple required aria-label="CSV-Dateien" />
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
  // ------------------------------------------------------------ Artikel + Zeiten aus Fortytools (Runde 23)
  app.post('/transfer/import/fortytools-weitere', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const files = (Array.isArray(b.dateien) ? b.dateien : [b.dateien]).filter(
      (f): f is File => f instanceof File && f.size > 0,
    );
    if (!files.length) throw new BusinessError('Bitte mindestens eine CSV-Datei wählen');
    const shas: string[] = [];
    for (const f of files.slice(0, 4))
      shas.push((await stageMore(deps, new Uint8Array(await f.arrayBuffer()))).sha);
    return c.redirect(`/transfer/import/fortytools-weitere?f=${shas.join(',')}&ohne=1013`, 303);
  });

  app.get('/transfer/import/fortytools-weitere', async (c) => {
    const shas = (c.req.query('f') ?? '')
      .split(',')
      .filter((x) => /^[0-9a-f]{64}$/.test(x))
      .slice(0, 4);
    if (!shas.length) return c.redirect('/transfer/import', 303);
    const ohne = (c.req.query('ohne') ?? '').replace(/[^0-9, ]/g, '');
    const exclude = ohne.split(/[ ,]+/).filter(Boolean);
    const tables = await Promise.all(shas.map((s) => stagedMore(deps, s)));
    const parts = await Promise.all(
      tables.map(async (t) =>
        t.kind === 'artikel'
          ? { kind: 'artikel' as const, a: await planArticles(sql, t) }
          : { kind: 'zeiten' as const, z: await planTimes(sql, t, { exclude }) },
      ),
    );
    const grouped = (issues: { text: string; level: string; ref: string }[]) => {
      const m = new Map<string, { level: string; n: number; refs: string[] }>();
      for (const i of issues) {
        const g = m.get(i.text) ?? { level: i.level, n: 0, refs: [] };
        g.n++;
        if (g.refs.length < 4) g.refs.push(i.ref);
        m.set(i.text, g);
      }
      return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    };
    const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    return page(
      c,
      'Artikel und Zeiten prüfen',
      'transfer',
      <>
        <PageHead
          title="Artikel und Zeiten aus Fortytools prüfen"
          crumbs={[
            ['Transfer', '/transfer/kontoumsaetze'],
            ['Import aus Fortytools', '/transfer/import'],
          ]}
        />
        <form method="post" action="/transfer/import/fortytools-weitere/uebernehmen">
          <input type="hidden" name="f" value={shas.join(',')} />
          {parts.map((p) =>
            p.kind === 'artikel' ? (
              <div class="card">
                <h3 style="margin-top:0">
                  Artikel: {p.a.rows.filter((r) => r.status === 'neu').length} neu,{' '}
                  {p.a.rows.filter((r) => r.status === 'vorhanden').length} vorhanden
                </h3>
                {grouped(p.a.issues).map(([text, g]) => (
                  <div class={`small ${g.level === 'fehler' ? 'err' : 'mut'}`}>
                    {g.n}× {text} <span class="mut">({g.refs.join('; ')})</span>
                  </div>
                ))}
                <div class="tbl" style="max-height:420px;overflow:auto;margin-top:8px">
                  <table>
                    <thead>
                      <tr>
                        <th>Nr.</th>
                        <th>Bezeichnung</th>
                        <th class="r">EK</th>
                        <th class="r">VK</th>
                        <th class="r">Bestand</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.a.rows.map((r) => (
                        <tr>
                          <td>{r.article_no}</td>
                          <td>{r.name}</td>
                          <td class="r num">{r.purchase_cents == null ? '–' : euro(r.purchase_cents)}</td>
                          <td class="r num">{r.sales_cents == null ? '–' : euro(r.sales_cents)}</td>
                          <td class="r num">{(Number(r.stock_milli) / 1000).toLocaleString('de-DE')}</td>
                          <td>
                            <span class={`badge ${r.status === 'neu' ? 'ok' : ''}`}>{r.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px">
                  <input type="checkbox" name="artikel_aktualisieren" value="1" /> vorhandene Artikel
                  aktualisieren (Name, Preise, Beschreibung – Bestand wird nur beim ersten Import gesetzt)
                </label>
              </div>
            ) : (
              <div class="card">
                <h3 style="margin-top:0">
                  Zeiten: {p.z.rows.filter((r) => !r.exists).length} neu
                  {p.z.rows.some((r) => r.exists) &&
                    `, ${p.z.rows.filter((r) => r.exists).length} schon übernommen`}
                  {p.z.excluded > 0 && ` · ${p.z.excluded} ausgeschlossen`}
                </h3>
                <div class="actions" style="margin-top:0">
                  <label for="ohne" style="margin:0">
                    Personalnummern nicht übernehmen
                  </label>
                  <input
                    id="ohne"
                    name="ohne"
                    value={ohne}
                    style="max-width:200px"
                    form="ohne-form"
                    placeholder="z. B. 1013, 1020"
                  />
                  <button class="btn sm sec" form="ohne-form">
                    Vorschau neu
                  </button>
                  <input type="hidden" name="ohne" value={ohne} />
                </div>
                {grouped(p.z.issues).map(([text, g]) => (
                  <div class={`small ${g.level === 'fehler' ? 'err' : 'mut'}`}>
                    {g.n}× {text} <span class="mut">({g.refs.join('; ')})</span>
                  </div>
                ))}
                {p.z.newSites.length > 0 && (
                  <p class="small">
                    Neue Objekte „Allgemein (aus Fortytools)“ für Buchungen ohne Objekt:{' '}
                    {p.z.newSites.map((s) => s.site_no).join(', ')}
                  </p>
                )}
                <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:8px">
                  <input type="checkbox" name="einsaetze" value="1" checked /> wiederkehrende Einsätze
                  ableiten ({p.z.shifts.filter((s) => !s.exists).length} neu, gültig ab{' '}
                  {dateDe(p.z.validFrom)})
                </label>
                <details style="margin-top:6px">
                  <summary class="small">Abgeleitete Einsätze ansehen</summary>
                  <div class="tbl" style="max-height:420px;overflow:auto">
                    <table>
                      <thead>
                        <tr>
                          <th>Mitarbeiter</th>
                          <th>Objekt</th>
                          <th>Tag</th>
                          <th>Zeit</th>
                          <th class="r">Pause</th>
                          <th class="r">im Export</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.z.shifts.map((s) => (
                          <tr>
                            <td>{s.employee}</td>
                            <td>{s.site}</td>
                            <td>{WD[s.weekday]}</td>
                            <td>
                              {s.start}–{s.end}
                            </td>
                            <td class="r">{s.break_minutes} min</td>
                            <td class="r">{s.count}×</td>
                            <td class="small mut">{s.exists ? 'Einsatz vorhanden' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            ),
          )}
          <div class="actions">
            <button class="btn" onclick="return confirm('Jetzt übernehmen?')">
              Übernehmen
            </button>
            <a class="btn sec" href="/transfer/import">
              Abbrechen
            </a>
          </div>
        </form>
        <form id="ohne-form" method="get" action="/transfer/import/fortytools-weitere">
          <input type="hidden" name="f" value={shas.join(',')} />
        </form>
      </>,
    );
  });

  app.post('/transfer/import/fortytools-weitere/uebernehmen', async (c) => {
    const b = await c.req.parseBody();
    const shas = String(b.f ?? '')
      .split(',')
      .filter((x) => /^[0-9a-f]{64}$/.test(x))
      .slice(0, 4);
    const exclude = String(b.ohne ?? '')
      .replace(/[^0-9, ]/g, '')
      .split(/[ ,]+/)
      .filter(Boolean);
    const msgs: string[] = [];
    for (const sha of shas) {
      const t = await stagedMore(deps, sha);
      if (t.kind === 'artikel') {
        const r = await applyArticles(sql, t, {
          update: b.artikel_aktualisieren === '1',
          actor: c.get('actor'),
        });
        msgs.push(`Artikel: ${r.created} neu, ${r.updated} aktualisiert, ${r.booked} Bestände gesetzt`);
      } else {
        const r = await applyTimes(sql, t, { exclude, shifts: b.einsaetze === '1', actor: c.get('actor') });
        msgs.push(
          `Zeiten: ${r.created} übernommen${r.skipped ? `, ${r.skipped} wegen Überschneidung übersprungen` : ''}, ${r.shiftsCreated} Einsätze angelegt`,
        );
      }
    }
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${c.get('actor')}, 'import', 'fortytools_weitere', null, ${sql.json({ shas, msgs })})`;
    return back(c, '/transfer/import', { ok: msgs.join(' · ') });
  });

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
