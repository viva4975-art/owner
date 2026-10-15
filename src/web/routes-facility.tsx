import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import type { FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import {
  DEFECT_CATEGORIES,
  FREQUENCIES,
  type QcRating,
  QC_FAIR,
  QC_GOOD,
  QC_RATING,
  type QualityCheckRow,
  closeQualityCheck,
  createQualityCheck,
  frequencyLabel,
  getQualityCheck,
  getRoom,
  type HourTargetMode,
  WEEKDAYS_SHORT,
  hourTarget,
  listQualityChecks,
  listRoomTypes,
  listRooms,
  qcHistory,
  qcScore,
  qualityCheckPdf,
  saveQualityCheck,
  saveRoom,
  deleteRooms,
  saveRoomType,
  saveSiteHourTarget,
} from '../services/facility.js';
import { listSites } from '../services/masterdata.js';
import { stageFile, stagedFile } from '../services/fortytools-import.js';
import {
  DAILY_OPTIONS,
  ROOM_FIELDS,
  analyzeRooms,
  applyRooms,
  dailyOf,
  suggestBuildingSites,
} from '../services/room-import.js';
import type { RoomField } from '../services/room-import.js';
import type { Context } from 'hono';
import { filePath, listFiles } from '../services/uploads.js';
import { readFile } from 'node:fs/promises';
import {
  deleteQualityCheck,
  qmStatistics,
  renderAuditReportPdf,
  renderQmStatisticsPdf,
} from '../services/qm-report.js';
import { uploadConfig } from './routes-files.js';
import { APP_ROOMBOOK_RE, renderRoomBookPdf, storeRoomBookPdf } from '../services/room-pdf.js';
import { type AppEnv, type Ctx, UUID, assertSite, inScope, isTouchDevice } from './app.js';
import { FileArea } from './files.js';
import { arr, centsToInput, str } from './forms.js';
import { Icon } from './icons.js';
import { writeXlsx } from '../domain/sheet/xlsx-write.js';
import { PageHead, dateDe, euro } from './layout.js';
import { canAccess } from './permissions.js';
import { SIGN_JS } from './routes-orders.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);
const num = (n: number, d = 1) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const m2 = (centi: bigint) =>
  (Number(centi) / 100).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const hm = (minutes: number) => {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

function parseArea(v: string | null): bigint {
  try {
    const c = parseEuro(v ?? '');
    if (c <= 0n) throw new Error();
    return c;
  } catch {
    throw new BusinessError('Fläche bitte in m², z. B. 24,5');
  }
}

/** „2:30“ oder „2,5“ → Minuten (leer = 0). */
/** Hinweis am PC: Qualitätskontrollen nur in der App am Handy/Tablet (Ahmed 14.10.). */
const QkAppHint: FC<{ auditId?: string }> = ({ auditId }) => (
  <div class="card hint" style="margin:0 0 12px">
    <b>Qualitätskontrollen werden in der App am Handy oder Tablet durchgeführt.</b>
    <p class="small mut" style="margin:6px 0 0">
      Viva-App öffnen → Qualität → {auditId ? 'Audit fortsetzen' : 'Audit starten'}. Fotos nur direkt mit der
      Kamera, mit Zeitpunkt und Standort. Am PC: Ergebnisse, Auswertungsbericht und Statistik ansehen.
    </p>
  </div>
);

export function parseHours(v: string | null, what: string): number {
  const t = (v ?? '').trim();
  if (!t) return 0;
  const hmMatch = /^(\d{1,4}):([0-5]?\d)$/.exec(t);
  if (hmMatch) return Number(hmMatch[1]) * 60 + Number(hmMatch[2]);
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0)
    throw new BusinessError(`${what}: Stunden bitte als 2:30 oder 2,5 angeben`);
  return Math.round(n * 60);
}

const scoreClass = (s: number | null) =>
  s == null ? 'draft' : s >= QC_GOOD ? 'ok' : s >= QC_FAIR ? 'warn' : 'err';

export const QcTable: FC<{
  rows: QualityCheckRow[];
  site?: boolean;
  /** Löschen direkt in der Liste (Ahmed 15.10.: „vor allem für Tests“) – abgeschlossene nur Admin */
  del?: { admin: boolean; ret: string };
}> = ({ rows, site, del }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Nr.</th>
          <th>Datum</th>
          {site && <th>Objekt</th>}
          <th>Prüfer</th>
          <th class="right">Bereiche</th>
          <th class="right">Mängel</th>
          <th>Ergebnis</th>
          {del && <th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((q) => (
          <tr>
            <td>
              <a href={`/qualitaet/${q.id}`}>{q.number}</a>
            </td>
            <td>{dateDe(q.check_date)}</td>
            {site && (
              <td>
                {q.site_name} <span class="mut small">{q.site_no}</span>
              </td>
            )}
            <td>{q.inspector}</td>
            <td class="right">{q.checked_count ?? '–'}</td>
            <td class="right">{q.defect_count ?? '–'}</td>
            <td>
              {q.status === 'entwurf' ? (
                <span class="badge draft">in Arbeit</span>
              ) : (
                <span class={`badge ${scoreClass(q.score_percent)}`}>{q.score_percent} %</span>
              )}
            </td>
            {del && (
              <td class="right">
                {(q.status === 'entwurf' || del.admin) && (
                  <form method="post" action={`/qualitaet/${q.id}/loeschen`} class="inline-form">
                    <input type="hidden" name="zurueck" value={del.ret} />
                    <button
                      class="btn sm danger"
                      title="Kontrolle löschen"
                      data-confirm={`Qualitätskontrolle ${q.number} löschen?${q.status === 'entwurf' ? '' : ' Prüfbericht und Fotos bleiben im Archiv.'}`}
                    >
                      ✕
                    </button>
                  </form>
                )}
              </td>
            )}
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <td colspan={7} class="mut">
              Noch keine Qualitätskontrollen.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

export function registerFacilityRoutes(ctx: Ctx) {
  const { app, deps, page, back, shells } = ctx;
  const { sql, env } = deps;

  // ================================================================== Raumbuch

  app.get(`/objekte/:id{${UUID}}/raumbuch`, (c) =>
    shells.site!(c, 'raumbuch', async (s) => {
      const rooms = await listRooms(sql, s.id, true);
      const t = await hourTarget(sql, s.id);
      const office = canAccess(c.get('user').role, '/raumbuch/raumarten');
      const docsRb = await roomDocs(s.id);
      return (
        <>
          <div class="kpis">
            <div class="kpi">
              <div class="l">Reinigungsfläche</div>
              <div class="v">{m2(t.areaCenti)} m²</div>
              <div class="s">{t.rooms} aktive Räume</div>
            </div>
            <div class="kpi">
              <div class="l">Stundenvorgabe</div>
              <div class="v">{t.target ? `${num(t.hoursPerWeek)} Std./Woche` : '–'}</div>
              <div class="s">
                <a href={`/objekte/${s.id}/stundenvorgabe`}>
                  {t.target ? `${num(t.hoursPerMonth)} Std./Monat →` : 'eintragen →'}
                </a>
              </div>
            </div>
          </div>
          <div class="actions" style="margin-top:0">
            <a class="btn sm" href={`/objekte/${s.id}/raumbuch/${randomUUID()}`}>
              + Raum
            </a>
            <a class="btn sm sec" href={`/objekte/${s.id}/raumbuch/import`}>
              <Icon name="upload" /> Importieren (Excel, CSV, PDF)
            </a>
            {docsRb.length ? (
              <a class="btn sm" href={`/objekte/${s.id}/raumbuch/import#dokumente`}>
                <Icon name="upload" /> Aus Dokumente übernehmen ({docsRb.length})
              </a>
            ) : null}
            <a class="btn sm sec" href={`/objekte/${s.id}/raumbuch.csv`}>
              <Icon name="download" /> CSV
            </a>
            <a class="btn sm sec" href={`/objekte/${s.id}/raumbuch.pdf`} target="_blank">
              <Icon name="pdf" /> PDF
            </a>
            <form
              method="post"
              action={`/objekte/${s.id}/raumbuch/pdf-ablegen`}
              style="display:inline;margin:0"
            >
              <button class="btn sm sec" title="Raumbuch als PDF mit Logo unter Objekt → Dokumente ablegen">
                PDF in Dokumente ablegen
              </button>
            </form>
            {office && (
              <a class="btn sm ghost" href="/einstellungen/nutzungsarten">
                Raumarten
              </a>
            )}
          </div>
          {rooms.length > 0 && (
            <form
              id="roombulk"
              method="post"
              action={`/objekte/${s.id}/raumbuch/loeschen`}
              class="actions"
              style="margin:12px 0 0;gap:8px;align-items:center"
              onsubmit="if(event.submitter&&event.submitter.value==='alle')return true;var n=document.querySelectorAll('input[name=ids][form=roombulk]:checked').length;if(!n){alert('Bitte zuerst Räume markieren.');return false}return confirm(n+' markierte Räume löschen?')"
            >
              <label class="chk" style="margin:0">
                <input
                  type="checkbox"
                  onclick="document.querySelectorAll('input[name=ids][form=roombulk]').forEach(function(x){x.checked=this.checked}.bind(this))"
                />{' '}
                alle markieren
              </label>
              <button class="btn sec sm" name="umfang" value="markierte">
                <Icon name="trash" /> Markierte löschen
              </button>
              <button
                class="btn danger sm"
                name="umfang"
                value="alle"
                data-confirm={`Wirklich alle ${rooms.length} Räume dieses Objekts löschen? Danach kann das Raumbuch neu importiert werden.`}
              >
                <Icon name="trash" /> Alle Räume löschen ({rooms.length})
              </button>
              <span class="small mut">
                Räume aus Qualitätskontrollen/Tickets bleiben als Nachweis und werden nur inaktiv.
              </span>
            </form>
          )}
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th style="width:28px" />
                  <th>Etage</th>
                  <th>Raum-Nr.</th>
                  <th>Raum</th>
                  <th>Raumart</th>
                  <th>Bodenbelag</th>
                  <th class="right">Fläche m²</th>
                  <th>Intervall</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr class={r.active ? '' : 'mut'}>
                    <td>
                      <input
                        type="checkbox"
                        name="ids"
                        value={r.id}
                        form="roombulk"
                        aria-label="Raum markieren"
                      />
                    </td>
                    <td>{r.floor}</td>
                    <td>{r.room_no}</td>
                    <td>
                      <a href={`/objekte/${s.id}/raumbuch/${r.id}`}>{r.name}</a>
                      {!r.active && <span class="badge tag"> inaktiv</span>}
                    </td>
                    <td>{r.type_name}</td>
                    <td>{r.floor_covering}</td>
                    <td class="right">{m2(r.area_centi)}</td>
                    <td>
                      {frequencyLabel(r.visits_per_year)}
                      {r.turnus && <span class="small mut"> · {r.turnus}</span>}
                    </td>
                  </tr>
                ))}
                {!rooms.length && (
                  <tr>
                    <td colspan={8} class="mut">
                      Noch keine Räume erfasst. Raumbuch vom Auftraggeber? „Importieren“ oder Raumbuch unter
                      Dokumente → Raumbuch ablegen und „Aus Dokumente übernehmen“.
                    </td>
                  </tr>
                )}
              </tbody>
              {rooms.length > 0 && (
                <tfoot>
                  <tr>
                    <th colspan={6}>Summe aktive Räume</th>
                    <th class="right">{m2(t.areaCenti)}</th>
                    <th />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      );
    }),
  );

  // Leere Raumbuch-Vorlage (Ahmed 11.10.: „Vorlage mit Tagen usw., die ich immer einfügen kann“)
  app.get('/raumbuch-vorlage.xlsx', async () => {
    const types = await listRoomTypes(sql);
    const bytes = writeXlsx([
      {
        name: 'Raumbuch',
        title: ['Raumbuch – je Raum eine Zeile, Kopfzeile nicht ändern (Erklärung im zweiten Blatt)'],
        header: [
          'Gebäude',
          'Etage',
          'Raum-Nr.',
          'Raum',
          'Raumart',
          'Bodenbelag',
          'Fläche m²',
          'Turnus',
          'Reinigungstage/Jahr',
          'Leistung m²/h',
          'Bemerkung',
        ],
        rows: [],
        widths: [22, 10, 12, 28, 22, 16, 12, 10, 20, 15, 36],
      },
      {
        name: 'Erklärung',
        header: ['Spalte / Turnus', 'Bedeutung', 'Reinigungen im Jahr'],
        rows: [
          ['Gebäude, Etage', 'frei, z. B. „Haus A“, „EG“ – erscheinen zusammen als Etage', null],
          ['Raum-Nr.', 'leer lassen, wenn es keine gibt', null],
          ['Raum', 'Pflicht, wenn keine Raum-Nr. – sonst reicht die Raumart', null],
          ['Raumart', 'eine der Nutzungsarten unten oder frei („WC Damen“ → Sanitär / WC)', null],
          ['Fläche m²', 'Pflicht, z. B. 24,5', null],
          ['Reinigungstage/Jahr', 'geht vor dem Turnus (z. B. Schule: 216 statt 260)', null],
          ['Leistung m²/h', 'optional – dann rechnet die App die Stunden je Jahr', null],
          ['W1 … W7', '1- bis 7-mal pro Woche (W5 = Mo–Fr)', '52 … 365'],
          ['M1 … M4', '1- bis 4-mal pro Monat', '12 … 48'],
          ['Q1', '1-mal pro Quartal', 4],
          ['J1 … J12', '1- bis 12-mal pro Jahr', '1 … 12'],
          ['0', 'keine Reinigung (Raum steht trotzdem im Raumbuch)', 0],
          ['Text', '„täglich“, „5x wöchentlich“, „14-tägig“, „1x Monat“', null],
          [null, null, null],
          ['Nutzungsarten', types.map((t) => t.name).join(', '), null],
        ],
        widths: [22, 70, 20],
      },
    ]);
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Raumbuch-Vorlage.xlsx"',
      },
    });
  });

  // Datei mit mehreren Gebäuden (Ausschreibung über mehrere Liegenschaften): je Gebäude ein Objekt desselben Kunden,
  // Vorschlag über den Namen, in der Vorschau änderbar („geb0“, „geb1“ … = Objekt-ID oder leer = nicht übernehmen)
  const importPlan = async (
    c: Context<AppEnv>,
    siteId: string,
    bytes: Uint8Array,
    daily: number,
    pick: (key: string) => string | undefined,
  ) => {
    const all = await analyzeRooms(sql, siteId, bytes, daily);
    if (all.buildings.length < 2)
      return {
        all,
        sites: [] as { id: string; name: string; site_no: string }[],
        mapping: [] as { building: string; key: string; siteId: string }[],
        parts: [{ building: null as string | null, siteId, siteName: '', a: all }],
      };
    const { sites, suggestion } = await suggestBuildingSites(sql, siteId, all.buildings);
    const own = c.get('sites');
    const allowed = sites.filter((x) => !own || own.includes(x.id));
    const mapping = all.buildings.map((b, i) => {
      const q = pick(`geb${i}`);
      const v = q !== undefined ? q : (suggestion.get(b) ?? '');
      return { building: b, key: `geb${i}`, siteId: allowed.some((x) => x.id === v) ? v : '' };
    });
    const parts: { building: string | null; siteId: string; siteName: string; a: typeof all }[] = [];
    for (const m of mapping)
      if (m.siteId) {
        const st = allowed.find((x) => x.id === m.siteId)!;
        parts.push({
          building: m.building,
          siteId: m.siteId,
          siteName: `${st.name} (${st.site_no})`,
          a: await analyzeRooms(sql, m.siteId, bytes, daily, { building: m.building }),
        });
      }
    return { all, sites: allowed, mapping, parts };
  };

  /** Unter Objekt → Dokumente → „Raumbuch“ abgelegte Dateien, aus denen sich das Raumbuch lesen lässt
   *  (PDF mit Text, Excel, CSV) – ohne die von der App selbst erzeugte Raumbuch-PDF. */
  const appRoomBook = new RegExp(APP_ROOMBOOK_RE);
  const roomDocs = async (siteId: string) =>
    (await listFiles(sql, { type: 'site', id: siteId })).filter(
      (f) =>
        (f.category === 'Raumbuch' || f.category === 'Revierplan') &&
        !f.archived_at &&
        !appRoomBook.test(f.original_name) &&
        /\.(pdf|xlsx|csv|txt)$/i.test(f.original_name),
    );

  /** Kurzauswertung je Datei (Anzahl lesbarer Räume, erkannte Angaben) – zwischengespeichert je Dateiinhalt */
  const docInfoCache = new Map<
    string,
    { rooms: number; fields: string[]; missing: string[]; error?: string }
  >();
  const docInfo = async (siteId: string, f: Awaited<ReturnType<typeof roomDocs>>[number]) => {
    const key = `${f.sha256 ?? f.id}`;
    const hit = docInfoCache.get(key);
    if (hit) return hit;
    let info: { rooms: number; fields: string[]; missing: string[]; error?: string };
    try {
      const a = await analyzeRooms(
        sql,
        siteId,
        new Uint8Array(await readFile(filePath(uploadConfig(ctx), f))),
      );
      const has = new Set(a.columns.map((col) => col.field));
      const label: [RoomField, string][] = [
        ['floor', 'Etage'],
        ['room_no', 'Raum-Nr.'],
        ['type', 'Raumart'],
        ['covering', 'Bodenbelag'],
        ['interval', 'Intervall'],
        ['days', 'Reinigungstage'],
        ['notes', 'Hinweise'],
      ];
      const interval = has.has('interval') || has.has('days');
      info = {
        rooms: a.rows.filter((r) => !r.errors.length).length,
        fields: label.filter(([k]) => has.has(k)).map(([, l]) => l),
        missing: [
          ...label.filter(([k]) => k !== 'interval' && k !== 'days' && k !== 'notes' && !has.has(k)),
          ...(interval ? [] : ([['interval', 'Intervall']] as [RoomField, string][])),
        ].map(([, l]) => l),
      };
    } catch (e) {
      info = { rooms: 0, fields: [], missing: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (docInfoCache.size > 200) docInfoCache.clear();
    docInfoCache.set(key, info);
    return info;
  };

  // Raumbuch aus Excel/CSV: Hochladen → Vorschau (GET, Datei write-once abgelegt) → Übernehmen
  app.get(`/objekte/:id{${UUID}}/raumbuch/import`, (c) =>
    shells.site!(c, 'raumbuch', async (s) => {
      const sha = c.req.query('datei');
      const daily = dailyOf(c.req.query('taeglich'));
      const self = `/objekte/${s.id}/raumbuch/import`;
      if (!sha) {
        const docsRaw = await roomDocs(s.id);
        const infos = await Promise.all(docsRaw.map((f) => docInfo(s.id, f)));
        // vollständigste Datei zuerst: die meisten Räume, bei Gleichstand die meisten Angaben
        const score = (i: (typeof infos)[number]) => i.rooms * 100 + i.fields.length;
        const docs = docsRaw
          .map((f, i) => ({ f, info: infos[i]! }))
          .sort((a, b) => score(b.info) - score(a.info));
        const bestId = docs.length > 1 && docs[0]!.info.rooms > 0 ? docs[0]!.f.id : null;
        return (
          <>
            <p>
              <a href={`/objekte/${s.id}/raumbuch`}>‹ Raumbuch</a>
            </p>
            <h3 class="panel-title">Raumbuch importieren</h3>
            {docs.length ? (
              <div class="card" id="dokumente" style="max-width:760px">
                <h3>Aus Dokumente übernehmen</h3>
                <p class="mut">
                  Unter Dokumente → Raumbuch bzw. Revierplan abgelegt – die App liest die Räume aus der Datei
                  und schlägt die vollständigste vor.
                </p>
                {docs.map(({ f, info }) => (
                  <form
                    method="post"
                    action={`${self}/dokument`}
                    class="row"
                    style={`gap:8px;margin:6px 0;padding:8px;border-radius:8px;${f.id === bestId ? 'background:var(--tint-2,#f8eff2)' : ''}`}
                  >
                    <input type="hidden" name="file_id" value={f.id} />
                    <span style="flex:1">
                      <a href={`/dateien/${f.id}`} target="_blank">
                        {f.original_name}
                      </a>{' '}
                      <span class="mut">
                        ·{' '}
                        {(f.completed_at ?? f.created_at).toLocaleDateString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                        })}
                      </span>
                      <br />
                      {info.error ? (
                        <span class="small" style="color:var(--bad,#b42318)">
                          nicht lesbar: {info.error}
                        </span>
                      ) : (
                        <span class="small">
                          {f.id === bestId && <span class="badge ok">empfohlen – am vollständigsten</span>}{' '}
                          <b>{info.rooms} Räume</b>
                          {info.fields.length > 0 && <> · mit {info.fields.join(', ')}</>}
                          {info.missing.length > 0 && (
                            <span class="mut"> · ohne {info.missing.join(', ')}</span>
                          )}
                        </span>
                      )}
                    </span>
                    <button
                      class={f.id === bestId || docs.length === 1 ? 'btn sm' : 'btn sm sec'}
                      disabled={!!info.error || !info.rooms}
                    >
                      Räume übernehmen …
                    </button>
                  </form>
                ))}
              </div>
            ) : null}
            <p class="mut" style="max-width:760px">
              Excel (.xlsx), CSV oder PDF (mit Text, z. B. aus Excel/Fortytools gedruckt – keine Scans) – auch
              eine ganze Ausschreibungs-Kalkulation mit vielen Blättern: die App sucht sich das Blatt mit dem
              Raumbuch selbst (die Kopfzeile darf unter Titelzeilen stehen). Erkannt werden u. a.{' '}
              <b>
                Gebäude, Etage/Ebene, Raum-Nr., Raum, Raumart, Bodenbelag, Fläche (m²), Turnus,
                Reinigungstage/Jahr, Leistung m²/h, Stunden/Jahr, Tageskraft, Bemerkung
              </b>
              . Reinigungstage im Jahr gehen vor dem Turnus (z. B. W5 = 216 Schultage). Turnus als Kürzel
              (W1–W7, M1, J2, 0 = keine Reinigung) oder Text („5x wöchentlich“, „täglich“, „14-tägig“).
              Raumarten wie „WC Damen“ oder „Umkleideraum, Kabine 5“ werden der passenden Nutzungsart
              zugeordnet. Sie sehen vor dem Übernehmen eine Vorschau.
            </p>
            <p>
              <a class="btn sm sec" href="/raumbuch-vorlage.xlsx">
                <Icon name="download" /> Leere Raumbuch-Vorlage (Excel)
              </a>
            </p>
            <form method="post" action={self} enctype="multipart/form-data">
              <div class="grid">
                <div>
                  <label for="file">Datei</label>
                  <input type="file" id="file" name="file" accept=".xlsx,.csv,.txt,.pdf" required />
                </div>
              </div>
              <div class="actions">
                <button class="btn">Vorschau anzeigen</button>
              </div>
            </form>
          </>
        );
      }
      const plan = await importPlan(c, s.id, await stagedFile(deps, sha), daily, (k) => c.req.query(k));
      const a = plan.all;
      const rowsAll = plan.parts.flatMap((p) => p.a.rows);
      const ok = rowsAll.filter((r) => !r.errors.length);
      const upd = ok.filter((r) => r.existingId).length;
      const newTypes = [...new Set(plan.parts.flatMap((p) => p.a.newTypes))];
      const mapHidden = plan.mapping.map((m) => <input type="hidden" name={m.key} value={m.siteId} />);
      return (
        <>
          <p>
            <a href={self}>‹ andere Datei wählen</a>
          </p>
          <h3 class="panel-title">Vorschau Raumbuch-Import</h3>
          <p class="small mut">
            {a.sheetCount > 1 && (
              <>
                Blatt „{a.sheetName}“ (von {a.sheetCount}).{' '}
              </>
            )}
            Kopfzeile in Zeile {a.headerLine}. Erkannt:{' '}
            {a.columns.map((x) => `${x.header} → ${ROOM_FIELDS[x.field].label}`).join(' · ')}
            {a.ignored.length > 0 && <> · nicht verwendet: {a.ignored.join(', ')}</>}
          </p>
          <form method="get" action={self} class="small" style="margin:8px 0">
            <input type="hidden" name="datei" value={sha} />
            {plan.mapping.length > 0 && (
              <div class="card" style="padding:10px 14px;margin-bottom:8px">
                <b>Die Datei enthält {plan.mapping.length} Gebäude – welches gehört zu welchem Objekt?</b>
                <div class="grid" style="margin-top:6px">
                  {plan.mapping.map((m) => {
                    const n = plan.all.rows.filter(
                      (r) => r.floor?.startsWith(`${m.building} · `) || r.floor === m.building,
                    ).length;
                    return (
                      <div>
                        <label for={m.key}>
                          {m.building} <span class="mut">({n} Räume)</span>
                        </label>
                        <select id={m.key} name={m.key} onchange="this.form.submit()">
                          <option value="" selected={!m.siteId}>
                            – nicht übernehmen –
                          </option>
                          {plan.sites.map((x) => (
                            <option value={x.id} selected={x.id === m.siteId}>
                              {x.site_no} · {x.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
                <p class="small mut" style="margin:6px 0 0">
                  Vorschlag über den Namen. Fehlt ein Objekt, zuerst beim Kunden anlegen und diese Seite neu
                  laden.
                </p>
              </div>
            )}
            <label for="taeglich" style="display:inline">
              „täglich“ bzw. ohne Intervall bedeutet:{' '}
            </label>
            <select id="taeglich" name="taeglich" onchange="this.form.submit()" style="width:auto">
              {DAILY_OPTIONS.map(([n, l]) => (
                <option value={String(n)} selected={n === daily}>
                  {l}
                </option>
              ))}
            </select>
            <noscript>
              <button class="btn sec">Anwenden</button>
            </noscript>
          </form>
          {newTypes.length > 0 && (
            <div class="flash warn">Neue Raumarten werden angelegt: {newTypes.join(', ')}</div>
          )}
          <form
            method="post"
            action={`${self}/uebernehmen`}
            class="card"
            style="position:sticky;top:0;z-index:5;padding:10px 14px;margin:8px 0"
          >
            <input type="hidden" name="datei" value={sha} />
            <input type="hidden" name="taeglich" value={String(daily)} />
            {mapHidden}
            {upd > 0 && (
              <div class="chk">
                <input type="checkbox" id="update" name="update" />
                <label for="update">{upd} vorhandene Räume mit den Werten aus der Datei überschreiben</label>
              </div>
            )}
            <div class="actions">
              <button class="btn" disabled={!ok.length}>
                {ok.length - upd} neue Räume übernehmen
                {plan.parts.length > 1 && ` (${plan.parts.length} Objekte)`}
              </button>
              <span class="small mut">
                {rowsAll.length - ok.length > 0 &&
                  `${rowsAll.length - ok.length} Zeilen mit Fehler werden übersprungen.`}
              </span>
            </div>
          </form>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Zeile</th>
                  <th>Etage</th>
                  <th>Raum-Nr.</th>
                  <th>Raum</th>
                  <th>Raumart</th>
                  <th>Bodenbelag</th>
                  <th class="right">Fläche m²</th>
                  <th>Intervall</th>
                  <th>Status</th>
                </tr>
              </thead>
              {plan.parts.map((p) => (
                <tbody>
                  {p.building != null && (
                    <tr>
                      <th colspan={9} style="background:var(--bg2,#f4f4f5)">
                        {p.building} → {p.siteName} · {p.a.rows.length} Räume
                      </th>
                    </tr>
                  )}
                  {p.a.rows.map((r) => (
                    <tr style={r.errors.length ? 'background:#fdf1f1' : ''}>
                      <td class="mut">{r.line}</td>
                      <td>{r.floor}</td>
                      <td>{r.roomNo}</td>
                      <td>{r.name}</td>
                      <td>
                        {r.typeName}
                        {!r.typeId && <span class="small mut"> (neu)</span>}
                        {r.typeRaw && r.typeRaw !== r.name && <div class="small mut">„{r.typeRaw}“</div>}
                      </td>
                      <td>{r.covering}</td>
                      <td class="right">{r.areaCenti != null ? m2(r.areaCenti) : '–'}</td>
                      <td>
                        {r.visits != null ? frequencyLabel(r.visits) : '–'}
                        {r.intervalDefaulted ? (
                          <div class="small mut">nicht angegeben</div>
                        ) : (
                          r.visits != null &&
                          r.intervalText && <div class="small mut">„{r.intervalText}“</div>
                        )}
                      </td>
                      <td>
                        {r.errors.length ? (
                          <span class="tag err">{r.errors.join('; ')}</span>
                        ) : r.existingId ? (
                          <span class="tag warn">vorhanden</span>
                        ) : (
                          <span class="tag ok">neu</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/raumbuch/import`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const b = await c.req.parseBody();
    const file = b.file;
    if (!(file instanceof File) || !file.size)
      throw new BusinessError('Bitte eine Excel-, CSV- oder PDF-Datei wählen');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await analyzeRooms(sql, siteId, bytes); // Fehler (z. B. keine Kopfzeile) gleich hier melden
    const sha = await stageFile(deps, bytes);
    return c.redirect(`/objekte/${siteId}/raumbuch/import?datei=${sha}`, 303);
  });

  app.post(`/objekte/:id{${UUID}}/raumbuch/import/dokument`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const fileId = str(await c.req.parseBody(), 'file_id') ?? '';
    const f = (await roomDocs(siteId)).find((x) => x.id === fileId);
    if (!f) throw new BusinessError('Datei nicht unter Dokumente → Raumbuch dieses Objekts gefunden');
    const bytes = new Uint8Array(await readFile(filePath(uploadConfig(ctx), f)));
    await analyzeRooms(sql, siteId, bytes);
    const sha = await stageFile(deps, bytes);
    return c.redirect(`/objekte/${siteId}/raumbuch/import?datei=${sha}`, 303);
  });

  app.post(`/objekte/:id{${UUID}}/raumbuch/import/uebernehmen`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const b = await c.req.parseBody({ all: true });
    const sha = str(b, 'datei') ?? '';
    const plan = await importPlan(c, siteId, await stagedFile(deps, sha), dailyOf(str(b, 'taeglich')), (k) =>
      typeof b[k] === 'string' ? (b[k] as string) : undefined,
    );
    if (!plan.parts.length) throw new BusinessError('Bitte mindestens einem Gebäude ein Objekt zuordnen');
    const msgs: string[] = [];
    for (const p of plan.parts) {
      assertSite(c, p.siteId);
      const r = await applyRooms(sql, p.siteId, sha, p.a, { update: b.update === 'on' }, c.get('actor'));
      // Raumbuch als PDF (mit Logo) gleich in die Objekt-Dokumente legen
      const pdf = await storeRoomBookPdf(sql, uploadConfig(ctx), p.siteId, c.get('actor')).then(
        () => true,
        () => false,
      );
      msgs.push(
        `${p.building != null ? `${p.siteName}: ` : ''}${r.created} neu, ${r.updated} aktualisiert, ${r.skipped} übersprungen${pdf ? ', PDF unter Dokumente' : ''}`,
      );
    }
    return back(c, `/objekte/${siteId}/raumbuch`, { ok: `Raumbuch importiert – ${msgs.join(' · ')}.` });
  });

  app.get(`/objekte/:id{${UUID}}/raumbuch.pdf`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const pdf = await renderRoomBookPdf(sql, siteId);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="Raumbuch.pdf"',
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.post(`/objekte/:id{${UUID}}/raumbuch/pdf-ablegen`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    await storeRoomBookPdf(sql, uploadConfig(ctx), siteId, c.get('actor'));
    return back(c, `/objekte/${siteId}/raumbuch`, {
      ok: 'Raumbuch-PDF unter Objekt → Dokumente (Raumbuch) abgelegt.',
    });
  });

  app.get(`/objekte/:id{${UUID}}/raumbuch.csv`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const rooms = await listRooms(sql, siteId, true);
    const q = (v: string | null | undefined) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      'Etage;Raum-Nr.;Raum;Raumart;Bodenbelag;Fläche m²;Reinigungen pro Jahr;Intervall;aktiv',
      ...rooms.map((r) =>
        [
          q(r.floor),
          q(r.room_no),
          q(r.name),
          q(r.type_name),
          q(r.floor_covering),
          centsToInput(r.area_centi),
          r.visits_per_year,
          q(frequencyLabel(r.visits_per_year)),
          r.active ? 'ja' : 'nein',
        ].join(';'),
      ),
    ];
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Raumbuch_${siteId.slice(0, 8)}.csv"`,
      },
    });
  });

  app.get(`/objekte/:id{${UUID}}/raumbuch/:room{${UUID}}`, (c) =>
    shells.site!(c, 'raumbuch', async (s) => {
      const roomId = c.req.param('room');
      const [r, types] = await Promise.all([getRoom(sql, roomId), listRoomTypes(sql)]);
      if (r && r.site_id !== s.id) throw new BusinessError('Raum gehört zu einem anderen Objekt');
      const custom = r && !FREQUENCIES.some(([k]) => k === r.visits_per_year);
      return (
        <>
          <form
            method="post"
            action={`/objekte/${s.id}/raumbuch/${roomId}`}
            class="card"
            data-autosave={`/objekte/${s.id}/raumbuch/${roomId}`}
            data-version={String(r?.version ?? '')}
            style="max-width:860px"
          >
            <h2 style="margin-top:0">{r ? `Raum ${r.name}` : 'Neuer Raum'}</h2>
            <input type="hidden" name="version" value={String(r?.version ?? '')} />
            <div class="grid">
              <div>
                <label for="floor">Etage / Gebäudeteil</label>
                <input id="floor" name="floor" value={r?.floor ?? ''} placeholder="EG, 1. OG, Haus B" />
              </div>
              <div>
                <label for="room_no">Raumnummer</label>
                <input id="room_no" name="room_no" value={r?.room_no ?? ''} />
              </div>
              <div>
                <label for="name">Bezeichnung</label>
                <input id="name" name="name" value={r?.name ?? ''} required />
              </div>
              <div>
                <label for="room_type_id">Raumart</label>
                <select id="room_type_id" name="room_type_id" required>
                  {types.map((t) => (
                    <option value={t.id} selected={t.id === r?.room_type_id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="floor_covering">Bodenbelag</label>
                <input
                  id="floor_covering"
                  name="floor_covering"
                  list="belaege"
                  value={r?.floor_covering ?? ''}
                  placeholder="Linoleum, Fliesen, Teppich …"
                />
                <datalist id="belaege">
                  {[
                    'Linoleum',
                    'PVC',
                    'Fliesen',
                    'Teppich',
                    'Parkett',
                    'Laminat',
                    'Naturstein',
                    'Kautschuk',
                    'Sportboden',
                  ].map((b) => (
                    <option value={b} />
                  ))}
                </datalist>
              </div>
              <div>
                <label for="area">Fläche (m²)</label>
                <input
                  id="area"
                  name="area"
                  value={r ? centsToInput(r.area_centi) : ''}
                  inputmode="decimal"
                  required
                />
              </div>
              <div>
                <label for="visits">Reinigungsintervall</label>
                <select id="visits" name="visits">
                  {FREQUENCIES.map(([k, v]) => (
                    <option value={String(k)} selected={(r?.visits_per_year ?? 260) === k}>
                      {v}
                    </option>
                  ))}
                  <option value="custom" selected={!!custom}>
                    andere Anzahl pro Jahr …
                  </option>
                </select>
              </div>
              <div>
                <label for="visits_custom">Reinigungen pro Jahr (bei „andere“)</label>
                <input
                  id="visits_custom"
                  name="visits_custom"
                  inputmode="numeric"
                  value={custom ? String(r!.visits_per_year) : ''}
                />
              </div>
            </div>
            <label for="notes">Hinweise (Besonderheiten, Zugang, Reinigungsmittel)</label>
            <textarea id="notes" name="notes">
              {r?.notes ?? ''}
            </textarea>
            <div class="chk" style="margin-top:10px">
              <input type="checkbox" id="active" name="active" checked={r ? r.active : true} />
              <label for="active">aktiv (wird gereinigt und kontrolliert)</label>
            </div>
            <div class="formfoot">
              <a class="btn sec" href={`/objekte/${s.id}/raumbuch`}>
                Zurück
              </a>
              <button class="btn sec" name="next" value="new">
                Speichern und nächster Raum
              </button>
              <button class="btn">Speichern</button>
            </div>
          </form>
          {r && (
            <form method="post" action={`/objekte/${s.id}/raumbuch/loeschen`} style="margin-top:12px">
              <input type="hidden" name="ids" value={r.id} />
              <button
                class="btn danger sm"
                name="umfang"
                value="markierte"
                data-confirm={`Raum „${r.name}“ löschen?`}
              >
                <Icon name="trash" /> Raum löschen
              </button>
            </form>
          )}
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/raumbuch/loeschen`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const b = await c.req.parseBody({ all: true });
    const ids = arr(b, 'ids').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    const alle = str(b, 'umfang') === 'alle';
    if (!alle && !ids.length) throw new BusinessError('Bitte zuerst Räume markieren.');
    const r = await deleteRooms(sql, siteId, alle ? 'all' : ids, c.get('actor'));
    const msg =
      `${r.deleted} ${r.deleted === 1 ? 'Raum' : 'Räume'} gelöscht.` +
      (r.deactivated
        ? ` ${r.deactivated} aus Qualitätskontrollen/Tickets nur inaktiv gesetzt (Nachweis).`
        : '');
    return back(c, `/objekte/${siteId}/raumbuch`, { ok: msg });
  });

  app.post(`/objekte/:id{${UUID}}/raumbuch/:room{${UUID}}`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const roomId = c.req.param('room');
    const b = await c.req.parseBody({ all: true });
    const visits = str(b, 'visits') === 'custom' ? Number(str(b, 'visits_custom')) : Number(str(b, 'visits'));
    await saveRoom(sql, roomId, {
      siteId,
      roomNo: str(b, 'room_no'),
      name: str(b, 'name') ?? '',
      floor: str(b, 'floor'),
      roomTypeId: str(b, 'room_type_id') ?? '',
      floorCovering: str(b, 'floor_covering'),
      areaCenti: parseArea(str(b, 'area')),
      visitsPerYear: visits,
      notes: str(b, 'notes'),
      active: b.active === 'on',
      expectedVersion: versionOf(b.version),
    });
    if (str(b, 'next') === 'new') {
      return back(c, `/objekte/${siteId}/raumbuch/${randomUUID()}`, {
        ok: 'Raum gespeichert. Nächster Raum:',
      });
    }
    return back(c, `/objekte/${siteId}/raumbuch`, { ok: 'Raum gespeichert.' });
  });

  // Raumarten (Stammliste, Einstellungen)
  app.get('/raumbuch/leistungswerte', (c) => c.redirect('/einstellungen/nutzungsarten', 301));
  app.get('/raumbuch/raumarten', (c) => c.redirect('/einstellungen/nutzungsarten', 301));

  app.post(`/raumbuch/raumarten/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveRoomType(sql, c.req.param('id'), {
      name: str(b, 'name') ?? '',
      active: b.active === 'on',
      expectedVersion: versionOf(b.version),
    });
    return back(c, '/einstellungen/nutzungsarten', { ok: 'Raumart gespeichert.' });
  });

  // ================================================================== Stundenvorgabe (von Hand)

  app.get(`/objekte/:id{${UUID}}/stundenvorgabe`, (c) =>
    shells.site!(c, 'stundenvorgabe', async (s) => {
      const t = await hourTarget(sql, s.id);
      const v = t.target;
      const mode = v?.mode ?? 'woche';
      const office = canAccess(c.get('user').role, '/rechnungen');
      const diff = t.plannedPerWeek - t.hoursPerWeek;
      const perHour = (hoursPerMonth: number) =>
        hoursPerMonth > 0 ? euro(BigInt(Math.round(Number(t.monthlyFlatCents) / hoursPerMonth))) : '–';
      const plannedMonth = (t.plannedPerWeek * 52) / 12;
      const self = `/objekte/${s.id}/stundenvorgabe`;
      return (
        <>
          <div class="kpis">
            <div class="kpi">
              <div class="l">Stundenvorgabe</div>
              <div class="v">{v ? `${num(t.hoursPerWeek)} Std./Woche` : 'noch keine'}</div>
              <div class="s">
                {v
                  ? `${num(t.hoursPerMonth)} Std./Monat · ${num(t.hoursPerYear, 0)} Std./Jahr`
                  : 'unten eintragen'}
              </div>
            </div>
            {t.servicesHoursPerMonth > 0 && (
              <div class="kpi">
                <div class="l">Vorgabe laut Leistungen</div>
                <div class="v">{num(t.servicesHoursPerMonth)} Std./Monat</div>
                <div class="s">
                  <a href={`/objekte/${s.id}/leistungen`}>Leistungen →</a>
                </div>
              </div>
            )}
            <div class="kpi">
              <div class="l">Einsatzplan aktuell</div>
              <div class="v">{num(t.plannedPerWeek)} Std./Woche</div>
              <div class="s">
                <a href={`/objekte/${s.id}/einsaetze`}>Einsatzplan →</a>
              </div>
            </div>
            {v && (
              <div class="kpi">
                <div class="l">Abweichung Plan − Vorgabe</div>
                <div class="v" style={Math.abs(diff) > t.hoursPerWeek * 0.1 ? 'color:var(--err)' : ''}>
                  {diff >= 0 ? '+' : ''}
                  {num(diff)} Std./Woche
                </div>
                <div class="s">
                  {t.hoursPerWeek > 0
                    ? `${diff >= 0 ? '+' : ''}${num((diff / t.hoursPerWeek) * 100, 0)} %`
                    : ''}
                </div>
              </div>
            )}
            {office && (
              <div class="kpi">
                <div class="l">Monatspauschale netto</div>
                <div class="v">{euro(t.monthlyFlatCents)}</div>
                <div class="s">
                  Erlös je Vorgabe-Std. {perHour(t.hoursPerMonth)} · je Plan-Std. {perHour(plannedMonth)}
                </div>
              </div>
            )}
          </div>
          <form method="post" action={self} data-autosave={self} data-version={String(v?.version ?? '')}>
            <h3 class="panel-title">Stundenvorgabe eintragen</h3>
            <input type="hidden" name="version" value={String(v?.version ?? '')} />
            <div class="hv-modes" style="display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 12px">
              {(
                [
                  ['woche', 'je Wochentag (Mo–So)', '#hv-woche'],
                  ['monat', 'je Monat', '#hv-monat'],
                  ['jahr', 'je Jahr', '#hv-jahr'],
                ] as const
              ).map(([k, l]) => (
                <label class="chk" style="display:flex;gap:6px;align-items:center">
                  <input type="radio" name="mode" value={k} checked={mode === k} data-hv={k} /> {l}
                </label>
              ))}
            </div>
            <div id="hv-woche" class="hv-part" hidden={mode !== 'woche'}>
              <div class="tbl" style="max-width:720px">
                <table>
                  <thead>
                    <tr>
                      {WEEKDAYS_SHORT.map((d) => (
                        <th class="right">{d}</th>
                      ))}
                      <th class="right">Woche</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {WEEKDAYS_SHORT.map((d, i) => (
                        <td>
                          <input
                            name={`day${i}`}
                            id={`day${i}`}
                            class="right"
                            style="width:70px"
                            inputmode="decimal"
                            aria-label={`Stunden ${d}`}
                            placeholder="0:00"
                            value={v?.mode === 'woche' && v.day_minutes[i] ? hm(v.day_minutes[i]!) : ''}
                          />
                        </td>
                      ))}
                      <td class="right" id="hv-sum">
                        {v?.mode === 'woche' ? hm(v.day_minutes.reduce((a, b) => a + b, 0)) : ''}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="grid">
              <div id="hv-monat" class="hv-part" hidden={mode !== 'monat'}>
                <label for="month_hours">Stunden je Monat</label>
                <input
                  id="month_hours"
                  name="month_hours"
                  inputmode="decimal"
                  placeholder="z. B. 86:40 oder 86,5"
                  value={v?.month_minutes != null ? hm(v.month_minutes) : ''}
                />
              </div>
              <div id="hv-jahr" class="hv-part" hidden={mode !== 'jahr'}>
                <label for="year_hours">Stunden je Jahr</label>
                <input
                  id="year_hours"
                  name="year_hours"
                  inputmode="decimal"
                  placeholder="z. B. 1040"
                  value={v?.year_minutes != null ? hm(v.year_minutes) : ''}
                />
              </div>
              <div>
                <label for="hv-note">Bemerkung</label>
                <input
                  id="hv-note"
                  name="note"
                  value={v?.note ?? ''}
                  placeholder="z. B. laut LV der Ausschreibung"
                />
              </div>
            </div>
            <div class="actions">
              <button class="btn">Stundenvorgabe speichern</button>
              {v && (
                <span class="small mut">
                  zuletzt {v.updated_by},{' '}
                  {v.updated_at.toLocaleString('de-DE', {
                    timeZone: 'Europe/Berlin',
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              )}
            </div>
            <p class="small mut">
              Eingabe als Stunden:Minuten (2:30) oder Dezimal (2,5). Umrechnung: Monat = Woche × 4,33, Jahr =
              Monat × 12. Einsatzplan: heute gültige wiederkehrende Einsätze abzüglich Pausen.
            </p>
          </form>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){var f=document.currentScript.previousElementSibling;
function show(){var m=(f.querySelector('input[name=mode]:checked')||{}).value;
f.querySelectorAll('.hv-part').forEach(function(p){p.hidden=p.id!=='hv-'+m;});}
function mins(v){v=(v||'').trim();if(!v)return 0;var x=v.match(/^(\\d+):(\\d{1,2})$/);
if(x)return +x[1]*60+ +x[2];var n=Number(v.replace(',','.'));return isFinite(n)?Math.round(n*60):0;}
function sum(){var t=0;for(var i=0;i<7;i++){var e=f.querySelector('[name=day'+i+']');t+=mins(e&&e.value);}
var o=document.getElementById('hv-sum');if(o)o.textContent=Math.floor(t/60)+':'+String(t%60).padStart(2,'0');}
f.addEventListener('change',show);f.addEventListener('input',sum);show();})();`,
            }}
          />
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/stundenvorgabe`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const b = await c.req.parseBody({ all: true });
    const mode = (str(b, 'mode') ?? 'woche') as HourTargetMode;
    await saveSiteHourTarget(
      sql,
      siteId,
      {
        mode,
        dayMinutes: WEEKDAYS_SHORT.map((_, i) => parseHours(str(b, `day${i}`), WEEKDAYS_SHORT[i]!)),
        monthMinutes: mode === 'monat' ? parseHours(str(b, 'month_hours'), 'Monat') : null,
        yearMinutes: mode === 'jahr' ? parseHours(str(b, 'year_hours'), 'Jahr') : null,
        note: str(b, 'note'),
        expectedVersion: versionOf(b.version),
      },
      c.get('actor'),
    );
    return back(c, `/objekte/${siteId}/stundenvorgabe`, { ok: 'Stundenvorgabe gespeichert.' });
  });

  // ================================================================== Qualitätskontrolle

  app.get(`/objekte/:id{${UUID}}/qualitaet`, (c) =>
    shells.site!(c, 'qualitaet', async (s) => {
      const [rows, hist] = await Promise.all([
        listQualityChecks(sql, { siteId: s.id }),
        qcHistory(sql, s.id),
      ]);
      const avg = hist.length
        ? Math.round(hist.reduce((a, h) => a + h.score_percent, 0) / hist.length)
        : null;
      return (
        <>
          <div class="kpis">
            <div class="kpi">
              <div class="l">Letzte Kontrolle</div>
              <div class="v">{hist[0] ? `${hist[0].score_percent} %` : '–'}</div>
              <div class="s">{hist[0] ? dateDe(hist[0].check_date) : 'noch keine'}</div>
            </div>
            <div class="kpi">
              <div class="l">Durchschnitt (letzte {hist.length || 12})</div>
              <div class="v">{avg != null ? `${avg} %` : '–'}</div>
              <div class="s">Ziel ≥ {QC_GOOD} %</div>
            </div>
          </div>
          {isTouchDevice(c) ? (
            <form method="post" action="/qualitaet/neu" class="actions" style="margin-top:0">
              <input type="hidden" name="id" value={randomUUID()} />
              <input type="hidden" name="site_id" value={s.id} />
              <button class="btn sm">+ Qualitätskontrolle starten</button>
            </form>
          ) : (
            <QkAppHint />
          )}
          <QcTable rows={rows} />
        </>
      );
    }),
  );

  app.get('/qualitaet', async (c) => {
    const sites = c.get('sites');
    const rows = await listQualityChecks(sql, sites ? { siteIds: sites } : {});
    const siteList = inScope(
      c,
      (await listSites(sql)).map((s) => ({ ...s, site_id: s.id })),
    );
    return page(
      c,
      'Qualitätskontrollen',
      'disposition',
      <>
        <PageHead title="Qualitätskontrollen">
          <a class="btn sec" href="/qualitaet/statistik" style="margin-left:auto">
            Statistik
          </a>
          <a class="btn sec" href="/qm" target="_blank">
            QM-App (Audit am Handy) öffnen
          </a>
        </PageHead>
        <form method="post" action="/qualitaet/neu" class="card actions" style="max-width:780px">
          <input type="hidden" name="id" value={randomUUID()} />
          <select name="site_id" required aria-label="Objekt" style="flex:1;min-width:220px">
            <option value="">Objekt wählen …</option>
            <SiteOptions sites={siteList} />
          </select>
          <button class="btn">+ Kontrolle starten</button>
        </form>
        <QcTable rows={rows} site del={{ admin: c.get('user').role === 'admin', ret: '/qualitaet' }} />
        <p class="small mut">
          Bewertung: Anteil der geprüften Bereiche ohne Mangel. Grün ab {QC_GOOD} %, gelb ab {QC_FAIR} %.
          Jeder Mangel erzeugt beim Abschluss eine Nachbesserungs-Aufgabe für die Objektleitung (Frist 3
          Tage).
        </p>
      </>,
    );
  });

  // Qualitätsstatistik über mehrere Audits (Ahmed 11.10., Vorlage Neumann & Neumann)
  app.get('/qualitaet/statistik', async (c) => {
    const today = todayBerlin();
    const d12 = new Date(`${today}T12:00:00Z`);
    d12.setUTCFullYear(d12.getUTCFullYear() - 1);
    const isDate = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const from = isDate(c.req.query('von')) ?? d12.toISOString().slice(0, 10);
    const to = isDate(c.req.query('bis')) ?? today;
    const customerId = c.req.query('kunde') || null;
    const siteId = c.req.query('objekt') || null;
    if (siteId) assertSite(c, siteId);
    const scopeSites = c.get('sites');
    const s = await qmStatistics(sql, { from, to, customerId, siteId, siteIds: scopeSites ?? null });
    const siteList = inScope(
      c,
      (await listSites(sql)).map((x) => ({ ...x, site_id: x.id })),
    );
    const customers = [...new Map(siteList.map((x) => [x.customer_id, x.customer_name])).entries()].sort(
      (a, b) => String(a[1]).localeCompare(String(b[1]), 'de'),
    );
    const scopeLabel = siteId
      ? (siteList.find((x) => x.id === siteId)?.name ?? 'Objekt')
      : customerId
        ? String(customers.find((x) => x[0] === customerId)?.[1] ?? 'Kunde')
        : 'alle Objekte';
    if (c.req.query('pdf')) {
      const pdf = await renderQmStatisticsPdf(s, { from, to, scope: scopeLabel });
      return new Response(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="Qualitaetsstatistik_${from}_${to}.pdf"`,
          'Cache-Control': 'private, no-cache',
        },
      });
    }
    const st = s.settings;
    const col = (v: number | null) =>
      v == null
        ? '#d4d4d8'
        : v < st.threshold_low
          ? '#b91c1c'
          : v < st.threshold_target
            ? '#d97706'
            : '#15803d';
    const bars = (rows: { name: string; v: number | null; sub?: string }[]) => (
      <div class="qbars">
        {rows.map((r) => (
          <div class="qbar">
            <span class="n" title={r.name}>
              {r.name}
              {r.sub && <span class="mut small"> · {r.sub}</span>}
            </span>
            <span class="t">
              <i style={`width:${r.v ?? 0}%;background:${col(r.v)}`} />
              <b style={`left:${st.threshold_low}%`} />
            </span>
            <span class="v">{r.v == null ? '–' : `${r.v} %`}</span>
          </div>
        ))}
      </div>
    );
    const qs = new URLSearchParams({
      von: from,
      bis: to,
      ...(customerId ? { kunde: customerId } : {}),
      ...(siteId ? { objekt: siteId } : {}),
    });
    return page(
      c,
      'Qualitätsstatistik',
      'disposition',
      <>
        <PageHead title="Qualitätsstatistik" crumbs={[['Qualitätskontrollen', '/qualitaet']]}>
          <a
            class="btn sec"
            href={`/qualitaet/statistik?${qs.toString()}&pdf=1`}
            target="_blank"
            style="margin-left:auto"
          >
            <Icon name="pdf" /> Als PDF
          </a>
        </PageHead>
        <form method="get" class="card actions" style="align-items:flex-end">
          <div>
            <label for="von">von</label>
            <input id="von" type="date" name="von" value={from} />
          </div>
          <div>
            <label for="bis">bis</label>
            <input id="bis" type="date" name="bis" value={to} />
          </div>
          <div style="min-width:200px">
            <label for="kunde">Kunde</label>
            <select id="kunde" name="kunde">
              <option value="">alle Kunden</option>
              {customers.map(([id, n]) => (
                <option value={id} selected={id === customerId}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div style="min-width:220px">
            <label for="objekt">Objekt</label>
            <select id="objekt" name="objekt">
              <option value="">alle Objekte</option>
              <SiteOptions sites={siteList} selected={siteId ?? undefined} />
            </select>
          </div>
          <button class="btn">Anzeigen</button>
        </form>
        <div class="kpis">
          <div class="kpi">
            <div class="l">Ø Ergebnis</div>
            <div class="v" style={`color:${col(s.score)}`}>
              {s.score == null ? '–' : `${s.score} %`}
            </div>
            <div class="s">Ziel ab {st.threshold_target} %</div>
          </div>
          <div class="kpi">
            <div class="l">Audits</div>
            <div class="v">{s.checks}</div>
            <div class="s">abgeschlossen im Zeitraum</div>
          </div>
          <div class="kpi">
            <div class="l">Geprüfte Einheiten</div>
            <div class="v">{s.units}</div>
          </div>
          <div class="kpi">
            <div class="l">Mängel</div>
            <div class="v">{s.defects}</div>
            <div class="s">Bewertung unter {st.threshold_low} %</div>
          </div>
        </div>
        {!s.checks ? (
          <div class="card">
            <div class="empty">Im Zeitraum gibt es keine abgeschlossenen Qualitätskontrollen.</div>
          </div>
        ) : (
          <>
            <div class="card">
              <h3 style="margin-top:0">Qualitätsverlauf (Ø je Monat)</h3>
              <div class="qcols">
                {s.months.map((m) => (
                  <div class="qcol" title={`${m.checks} Audits`}>
                    <span class="v">{m.score} %</span>
                    <span class="b">
                      <i style={`height:${m.score}%;background:${col(m.score)}`} />
                      <b style={`bottom:${st.threshold_low}%`} />
                    </span>
                    <span class="l">
                      {m.month.slice(5)}/{m.month.slice(2, 4)}
                    </span>
                  </div>
                ))}
              </div>
              <p class="small mut">Rote Linie: Schwellwert {st.threshold_low} %.</p>
            </div>
            <div class="cols">
              <div class="card">
                <h3 style="margin-top:0">Leistungsbereiche</h3>
                {s.areas.length ? (
                  bars(s.areas.map((a) => ({ name: a.name, v: a.score, sub: `${a.defects} Mängel` })))
                ) : (
                  <p class="mut small">Nur Kontrollen mit Bewertung je Kontrollgegenstand (QM-App).</p>
                )}
                <h3>Leistungsgruppen (Nutzungsarten)</h3>
                {s.groups.length ? (
                  bars(s.groups.map((a) => ({ name: a.name, v: a.score, sub: `${a.units} Einheiten` })))
                ) : (
                  <p class="mut small">–</p>
                )}
              </div>
              <div class="card">
                <h3 style="margin-top:0">Top 10 Verbesserungspotentiale</h3>
                <div class="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th>Kontrollgegenstand</th>
                        <th class="right">Bewertungen</th>
                        <th class="right">Qualität</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.top.map((t) => (
                        <tr>
                          <td>
                            {t.item} <span class="mut small">· Gewicht {t.weight}</span>
                            {t.description && <div class="small mut">{t.description}</div>}
                          </td>
                          <td class="right">{t.count}</td>
                          <td class="right" style={`color:${col(t.score)};font-weight:600`}>
                            {t.score} %
                          </td>
                        </tr>
                      ))}
                      {!s.top.length && (
                        <tr>
                          <td colspan={3} class="mut">
                            Keine Abzüge.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="card">
              <h3 style="margin-top:0">Objekte</h3>
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Objekt</th>
                      <th>Kunde</th>
                      <th class="right">Audits</th>
                      <th>Letztes Audit</th>
                      <th class="right">Letztes</th>
                      <th class="right">Ø</th>
                      <th class="right">Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.sites.map((x) => (
                      <tr>
                        <td>
                          <a href={`/objekte/${x.site_id}/qualitaet`}>{x.site_name}</a>{' '}
                          <span class="mut small">{x.site_no}</span>
                        </td>
                        <td>{x.customer_name}</td>
                        <td class="right">{x.checks}</td>
                        <td>{dateDe(x.last_date)}</td>
                        <td class="right" style={`color:${col(x.last)};font-weight:600`}>
                          {x.last} %
                        </td>
                        <td class="right">{x.avg} %</td>
                        <td class="right">{x.trend == null ? '–' : `${x.trend > 0 ? '+' : ''}${x.trend}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </>,
    );
  });

  app.post('/qualitaet/neu', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const id = str(b, 'id') ?? '';
    const siteId = str(b, 'site_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id) || !siteId) throw new BusinessError('Bitte Objekt wählen');
    assertSite(c, siteId);
    const u = c.get('user');
    await createQualityCheck(
      sql,
      id,
      { siteId, checkDate: todayBerlin(), inspector: u.name || u.login, attendee: null },
      c.get('actor'),
    );
    return back(c, `/qualitaet/${id}`, { ok: 'Kontrolle angelegt. Bereiche bewerten, dann abschließen.' });
  });

  app.get(`/qualitaet/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    const { check: q, items } = data;
    const files = await listFiles(sql, { type: 'quality_check', id });
    const live = qcScore(items);
    const head = (
      <PageHead
        title={`Qualitätskontrolle ${q.number}`}
        no={`${q.site_name} · ${dateDe(q.check_date)}`}
        crumbs={[
          ['Qualitätskontrollen', '/qualitaet'],
          [q.site_name, `/objekte/${q.site_id}/qualitaet`],
        ]}
      >
        {q.status === 'entwurf' ? (
          <span class="badge draft">in Arbeit</span>
        ) : (
          <span class={`badge ${scoreClass(q.score_percent)}`}>{q.score_percent} % in Ordnung</span>
        )}
      </PageHead>
    );
    const isAdmin = c.get('user').role === 'admin';
    const delBox =
      q.status === 'entwurf' || isAdmin ? (
        <details class="card" style="margin-top:12px">
          <summary class="small">Qualitätskontrolle löschen</summary>
          <form
            method="post"
            action={`/qualitaet/${id}/loeschen`}
            data-confirm={`Qualitätskontrolle ${q.number} wirklich löschen? Bewertungen und offene Nachbesserungs-Aufgaben werden entfernt.`}
          >
            <p class="small mut">
              {q.status === 'entwurf'
                ? 'Der Entwurf wird mit allen Bewertungen gelöscht.'
                : 'Abgeschlossene Kontrolle (nur Admin): Stand wird im Protokoll festgehalten, Prüfbericht und Fotos bleiben im Archiv, offene Nachbesserungs-Aufgaben entfallen.'}
            </p>
            <button class="btn danger sm">Endgültig löschen</button>
          </form>
        </details>
      ) : null;
    const reportBtn = (
      <a class="btn" href={`/qualitaet/${id}/auswertung.pdf`} target="_blank">
        <Icon name="pdf" /> Auswertungsbericht (PDF)
      </a>
    );
    const touch = isTouchDevice(c);
    const photos = (
      <div class="card">
        <FileArea
          link={{ type: 'quality_check', id }}
          files={files}
          category="Foto"
          title="Fotos"
          maxBytes={env.UPLOAD_MAX_BYTES}
          listOnly
        />
      </div>
    );
    if (q.status !== 'entwurf') {
      return page(
        c,
        `QK ${q.number}`,
        'disposition',
        <>
          {head}
          <div class="actions" style="margin-top:-8px">
            {reportBtn}
            <a class="btn sec" href={`/qualitaet/${id}/bericht.pdf`} target="_blank">
              <Icon name="pdf" /> Prüfprotokoll (archiviert)
            </a>
          </div>
          <div class="cols">
            <div class="card">
              <p>
                Prüfer: {q.inspector}
                {q.attendee && <> · Anwesend: {q.attendee}</>}
                {q.signed_by_name && <> · Unterschrieben von {q.signed_by_name}</>}
              </p>
              {q.summary && <p>{q.summary}</p>}
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Bereich</th>
                      <th>Ergebnis</th>
                      <th>Mangel</th>
                      <th>Nachbesserung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr>
                        <td>{i.area}</td>
                        <td>
                          <span
                            class={`badge ${i.rating === 'ok' ? 'ok' : i.rating === 'mangel' ? 'err' : 'draft'}`}
                          >
                            {QC_RATING[i.rating]}
                          </span>
                        </td>
                        <td class="small">{[i.defects.join(', '), i.note].filter(Boolean).join(' – ')}</td>
                        <td>{i.task_id && <a href={`/aufgaben#${i.task_id}`}>Aufgabe</a>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              {photos}
              {delBox}
            </div>
          </div>
        </>,
      );
    }
    if (!touch)
      return page(
        c,
        `QK ${q.number}`,
        'disposition',
        <>
          {head}
          <QkAppHint auditId={id} />
          {delBox}
        </>,
      );
    return page(
      c,
      `QK ${q.number}`,
      'disposition',
      <>
        {head}
        <div class="cols">
          <form
            method="post"
            action={`/qualitaet/${id}`}
            class="card"
            data-autosave={`/qualitaet/${id}`}
            data-version={String(q.version)}
          >
            <input type="hidden" name="version" value={String(q.version)} />
            <div class="grid">
              <div>
                <label for="attendee">Anwesend (Kunde)</label>
                <input
                  id="attendee"
                  name="attendee"
                  value={q.attendee ?? ''}
                  placeholder="z. B. Hausmeister Maier"
                />
              </div>
              <div>
                <label>Zwischenstand</label>
                <p style="margin:6px 0">
                  <b>{live.checked ? `${live.score} %` : '–'}</b>{' '}
                  <span class="mut small">
                    ({live.checked} geprüft, {live.defects} {live.defects === 1 ? 'Mangel' : 'Mängel'})
                  </span>
                </p>
              </div>
            </div>
            <div class="tbl">
              <table class="qc">
                <thead>
                  <tr>
                    <th>Bereich</th>
                    <th>Ergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr>
                      <td style="min-width:160px">
                        <input type="hidden" name="item" value={i.id} />
                        <b>{i.area}</b>
                      </td>
                      <td>
                        <div class="actions" style="margin:0;gap:14px">
                          {(['ok', 'mangel', 'nicht_geprueft'] as QcRating[]).map((r) => (
                            <label class="chk" style="margin:0">
                              <input
                                type="radio"
                                name={`rating_${i.id}`}
                                value={r}
                                checked={i.rating === r}
                              />
                              {QC_RATING[r]}
                            </label>
                          ))}
                        </div>
                        <details open={i.rating === 'mangel'} class="small" style="margin-top:6px">
                          <summary>Mangel beschreiben</summary>
                          <div class="actions" style="margin:6px 0;gap:10px">
                            {DEFECT_CATEGORIES.map((d) => (
                              <label class="chk" style="margin:0">
                                <input
                                  type="checkbox"
                                  name={`defects_${i.id}`}
                                  value={d}
                                  checked={i.defects.includes(d)}
                                />
                                {d}
                              </label>
                            ))}
                          </div>
                          <input
                            name={`note_${i.id}`}
                            value={i.note ?? ''}
                            placeholder="Bemerkung"
                            aria-label="Bemerkung"
                          />
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label for="extra_area">Weiteren Bereich hinzufügen</label>
            <input id="extra_area" name="extra_area" placeholder="z. B. Außenbereich, Aufzug" />
            <label for="summary">Gesamteindruck / Vereinbarungen</label>
            <textarea id="summary" name="summary">
              {q.summary ?? ''}
            </textarea>
            <div class="formfoot">
              <button class="btn sec" name="next" value="stay">
                Speichern
              </button>
              <button class="btn" name="next" value="close">
                Speichern und abschließen
              </button>
            </div>
          </form>
          <div>
            {photos}
            <div class="card actions">
              {reportBtn}
              <a class="btn sec" href={`/qualitaet/${id}/bericht.pdf`} target="_blank">
                <Icon name="pdf" /> Prüfprotokoll (Vorschau)
              </a>
            </div>
            {delBox}
          </div>
        </div>
      </>,
    );
  });

  app.post(`/qualitaet/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    const b = await c.req.parseBody({ all: true });
    const ids = new Set(data.items.map((i) => i.id));
    const items = arr(b, 'item')
      .filter((x) => ids.has(x))
      .map((x) => {
        const r = str(b, `rating_${x}`) as QcRating | null;
        return {
          id: x,
          rating: r && r in QC_RATING ? r : ('nicht_geprueft' as QcRating),
          defects: arr(b, `defects_${x}`).filter((d) => DEFECT_CATEGORIES.includes(d)),
          note: str(b, `note_${x}`),
        };
      });
    await saveQualityCheck(sql, id, {
      attendee: str(b, 'attendee'),
      summary: str(b, 'summary'),
      items,
      extraArea: str(b, 'extra_area'),
      expectedVersion: versionOf(b.version),
    });
    if (str(b, 'next') === 'close') return c.redirect(`/qualitaet/${id}/abschliessen`, 303);
    return back(c, `/qualitaet/${id}`, { ok: 'Gespeichert.' });
  });

  app.get(`/qualitaet/:id{${UUID}}/abschliessen`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    const { check: q, items } = data;
    if (q.status !== 'entwurf') return c.redirect(`/qualitaet/${id}`);
    const live = qcScore(items);
    return page(
      c,
      'Abschließen',
      'disposition',
      <div style="max-width:720px;margin:0 auto">
        <h1 style="margin-bottom:6px">Qualitätskontrolle {q.number}</h1>
        <p class="mut" style="margin-top:0">
          {q.site_name} · {dateDe(q.check_date)}
        </p>
        <div class="card">
          <p style="font-size:20px;margin:0 0 6px">
            <b>{live.checked ? `${live.score} % in Ordnung` : 'Noch nichts bewertet'}</b>
          </p>
          <p class="mut" style="margin:0">
            {live.checked} Bereiche geprüft, {live.defects} mit Mangel
            {live.defects > 0 && ' – dafür werden Nachbesserungs-Aufgaben angelegt'}.
          </p>
        </div>
        <form method="post" action={`/qualitaet/${id}/abschliessen`} class="card">
          <label for="name">Name des Kunden (optional, wenn er gegenzeichnet)</label>
          <input
            id="name"
            name="name"
            value={q.attendee ?? ''}
            autocomplete="name"
            style="font-size:18px;height:46px"
          />
          <label style="margin-top:14px">Unterschrift (optional)</label>
          <canvas
            id="sig"
            data-optional="1"
            style="width:100%;height:180px;border:1.5px dashed var(--line-2);border-radius:var(--r);background:#fff;touch-action:none;display:block"
          ></canvas>
          <input type="hidden" id="sig-png" name="png" />
          <div class="actions">
            <button type="button" class="btn sec sm" id="sig-clear">
              Löschen
            </button>
            <span class="small" id="sig-hint" hidden></span>
          </div>
          <p class="small mut">
            Nach dem Abschluss ist die Kontrolle unveränderbar; der Prüfbericht wird als PDF archiviert.
          </p>
          <div class="formfoot">
            <a class="btn sec" href={`/qualitaet/${id}`}>
              Zurück
            </a>
            <button class="btn">Abschließen</button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />
      </div>,
    );
  });

  app.post(`/qualitaet/:id{${UUID}}/abschliessen`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    const b = await c.req.parseBody({ all: true });
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png ?? ''));
    const name = String(b.name ?? '').trim();
    if (m && !name) throw new BusinessError('Bitte Namen zur Unterschrift angeben');
    await closeQualityCheck(
      deps,
      id,
      { signature: m ? { name, png: new Uint8Array(Buffer.from(m[1]!, 'base64')) } : null },
      c.get('actor'),
    );
    return back(c, `/qualitaet/${id}`, { ok: 'Kontrolle abgeschlossen, Prüfbericht gespeichert.' });
  });

  app.post(`/qualitaet/:id{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    await deleteQualityCheck(sql, id, { admin: c.get('user').role === 'admin', actor: c.get('actor') });
    const b = await c.req.parseBody();
    const ret =
      typeof b.zurueck === 'string' && /^\/(qualitaet|qm)(\/|$|\?)/.test(b.zurueck)
        ? b.zurueck
        : `/objekte/${data.check.site_id}/qualitaet`;
    return back(c, ret, {
      ok: `Qualitätskontrolle ${data.check.number} gelöscht.`,
    });
  });

  app.get(`/qualitaet/:id{${UUID}}/auswertung.pdf`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    const pdf = await renderAuditReportPdf(deps, uploadConfig(ctx), id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Auswertungsbericht_${data.check.number}.pdf"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.get(`/qualitaet/:id{${UUID}}/bericht.pdf`, async (c) => {
    const id = c.req.param('id');
    const data = await getQualityCheck(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.check.site_id);
    const pdf = await qualityCheckPdf(deps, id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Qualitaetskontrolle_${data.check.number}.pdf"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  // Zählerstände: Seite entfernt (Ahmed 07.10.2026). Alte Adressen führen zum Objekt bzw. zur Objektliste.
  app.get('/zaehler', (c) => c.redirect('/objekte', 301));
  app.get(`/objekte/:id{${UUID}}/zaehler`, (c) => c.redirect(`/objekte/${c.req.param('id')}`, 301));
}
