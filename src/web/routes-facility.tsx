import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import {
  DEFECT_CATEGORIES,
  FREQUENCIES,
  METER_KIND,
  METER_UNIT,
  type MeterKind,
  type MeterRow,
  type QcRating,
  QC_FAIR,
  QC_GOOD,
  QC_RATING,
  type QualityCheckRow,
  addReading,
  closeQualityCheck,
  createQualityCheck,
  frequencyLabel,
  getMeter,
  getQualityCheck,
  getRoom,
  type HourTargetMode,
  WEEKDAYS_SHORT,
  hourTarget,
  listMeters,
  listQualityChecks,
  listRoomTypes,
  listRooms,
  qcHistory,
  qcScore,
  qualityCheckPdf,
  readingsWithConsumption,
  saveMeter,
  saveQualityCheck,
  saveRoom,
  saveRoomType,
  saveSiteHourTarget,
} from '../services/facility.js';
import { listSites } from '../services/masterdata.js';
import { stageFile, stagedFile } from '../services/fortytools-import.js';
import { DAILY_OPTIONS, ROOM_FIELDS, analyzeRooms, applyRooms, dailyOf } from '../services/room-import.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID, assertSite, inScope } from './app.js';
import { FileArea } from './files.js';
import { arr, centsToInput, milliToInput, str } from './forms.js';
import { Icon } from './icons.js';
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

export const QcTable: FC<{ rows: QualityCheckRow[]; site?: boolean }> = ({ rows, site }) => (
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

export function registerFacilityRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql, env } = deps;

  // ================================================================== Raumbuch

  app.get(`/objekte/:id{${UUID}}/raumbuch`, (c) =>
    shells.site!(c, 'raumbuch', async (s) => {
      const rooms = await listRooms(sql, s.id, true);
      const t = await hourTarget(sql, s.id);
      const office = canAccess(c.get('user').role, '/raumbuch/raumarten');
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
              <Icon name="upload" /> Aus Excel importieren
            </a>
            <a class="btn sm sec" href={`/objekte/${s.id}/raumbuch.csv`}>
              <Icon name="download" /> CSV
            </a>
            {office && (
              <a class="btn sm ghost" href="/raumbuch/raumarten">
                Raumarten
              </a>
            )}
          </div>
          <div class="tbl">
            <table>
              <thead>
                <tr>
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
                    <td>{r.floor}</td>
                    <td>{r.room_no}</td>
                    <td>
                      <a href={`/objekte/${s.id}/raumbuch/${r.id}`}>{r.name}</a>
                      {!r.active && <span class="badge tag"> inaktiv</span>}
                    </td>
                    <td>{r.type_name}</td>
                    <td>{r.floor_covering}</td>
                    <td class="right">{m2(r.area_centi)}</td>
                    <td>{frequencyLabel(r.visits_per_year)}</td>
                  </tr>
                ))}
                {!rooms.length && (
                  <tr>
                    <td colspan={7} class="mut">
                      Noch keine Räume erfasst. Raumbuch vom Auftraggeber? „Aus Excel importieren“.
                    </td>
                  </tr>
                )}
              </tbody>
              {rooms.length > 0 && (
                <tfoot>
                  <tr>
                    <th colspan={5}>Summe aktive Räume</th>
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

  // Raumbuch aus Excel/CSV: Hochladen → Vorschau (GET, Datei write-once abgelegt) → Übernehmen
  app.get(`/objekte/:id{${UUID}}/raumbuch/import`, (c) =>
    shells.site!(c, 'raumbuch', async (s) => {
      const sha = c.req.query('datei');
      const daily = dailyOf(c.req.query('taeglich'));
      const self = `/objekte/${s.id}/raumbuch/import`;
      if (!sha) {
        return (
          <>
            <p>
              <a href={`/objekte/${s.id}/raumbuch`}>‹ Raumbuch</a>
            </p>
            <h3 class="panel-title">Raumbuch aus Excel importieren</h3>
            <p class="mut" style="max-width:760px">
              Excel (.xlsx) oder CSV. Die Spalten werden über die Kopfzeile erkannt (sie darf unter
              Titelzeilen stehen):
              <b> Etage, Raum-Nr., Raum, Raumart, Bodenbelag, Fläche (m²), Intervall</b>. Intervall z. B. „5x
              wöchentlich“, „täglich“ (Mo–Fr, Mo–Sa oder Mo–So – wählbar in der Vorschau), „14-tägig“, „1x
              Monat“ oder eine Zahl (bis 7 = pro Woche, sonst pro Jahr). Ohne Intervall gilt „täglich“. Sie
              sehen vor dem Übernehmen eine Vorschau.
            </p>
            <form method="post" action={self} enctype="multipart/form-data">
              <div class="grid">
                <div>
                  <label for="file">Datei</label>
                  <input type="file" id="file" name="file" accept=".xlsx,.csv,.txt" required />
                </div>
              </div>
              <div class="actions">
                <button class="btn">Vorschau anzeigen</button>
              </div>
            </form>
          </>
        );
      }
      const a = await analyzeRooms(sql, s.id, await stagedFile(deps, sha), daily);
      const ok = a.rows.filter((r) => !r.errors.length);
      const upd = ok.filter((r) => r.existingId).length;
      return (
        <>
          <p>
            <a href={self}>‹ andere Datei wählen</a>
          </p>
          <h3 class="panel-title">Vorschau Raumbuch-Import</h3>
          <p class="small mut">
            Kopfzeile in Zeile {a.headerLine}. Erkannt:{' '}
            {a.columns.map((x) => `${x.header} → ${ROOM_FIELDS[x.field].label}`).join(' · ')}
            {a.ignored.length > 0 && <> · nicht verwendet: {a.ignored.join(', ')}</>}
          </p>
          <form method="get" action={self} class="small" style="margin:8px 0">
            <input type="hidden" name="datei" value={sha} />
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
          {a.newTypes.length > 0 && (
            <div class="flash warn">Neue Raumarten werden angelegt: {a.newTypes.join(', ')}</div>
          )}
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
              <tbody>
                {a.rows.map((r) => (
                  <tr style={r.errors.length ? 'background:#fdf1f1' : ''}>
                    <td class="mut">{r.line}</td>
                    <td>{r.floor}</td>
                    <td>{r.roomNo}</td>
                    <td>{r.name}</td>
                    <td>
                      {r.typeName}
                      {!r.typeId && <span class="small mut"> (neu)</span>}
                    </td>
                    <td>{r.covering}</td>
                    <td class="right">{r.areaCenti != null ? m2(r.areaCenti) : '–'}</td>
                    <td>
                      {r.visits ? frequencyLabel(r.visits) : '–'}
                      {r.intervalDefaulted ? (
                        <div class="small mut">nicht angegeben</div>
                      ) : (
                        r.visits && <div class="small mut">„{r.intervalText}“</div>
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
            </table>
          </div>
          <form method="post" action={`${self}/uebernehmen`}>
            <input type="hidden" name="datei" value={sha} />
            <input type="hidden" name="taeglich" value={String(daily)} />
            {upd > 0 && (
              <div class="chk">
                <input type="checkbox" id="update" name="update" />
                <label for="update">{upd} vorhandene Räume mit den Werten aus der Datei überschreiben</label>
              </div>
            )}
            <div class="actions">
              <button class="btn" disabled={!ok.length}>
                {ok.length - upd} neue Räume übernehmen
              </button>
              <span class="small mut">
                {a.rows.length - ok.length > 0 &&
                  `${a.rows.length - ok.length} Zeilen mit Fehler werden übersprungen.`}
              </span>
            </div>
          </form>
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
      throw new BusinessError('Bitte eine Excel- oder CSV-Datei wählen');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await analyzeRooms(sql, siteId, bytes); // Fehler (z. B. keine Kopfzeile) gleich hier melden
    const sha = await stageFile(deps, bytes);
    return c.redirect(`/objekte/${siteId}/raumbuch/import?datei=${sha}`, 303);
  });

  app.post(`/objekte/:id{${UUID}}/raumbuch/import/uebernehmen`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    const b = await c.req.parseBody({ all: true });
    const sha = str(b, 'datei') ?? '';
    const a = await analyzeRooms(sql, siteId, await stagedFile(deps, sha), dailyOf(str(b, 'taeglich')));
    const r = await applyRooms(sql, siteId, sha, a, { update: b.update === 'on' }, c.get('actor'));
    return back(c, `/objekte/${siteId}/raumbuch`, {
      ok: `Raumbuch importiert: ${r.created} neu, ${r.updated} aktualisiert, ${r.skipped} übersprungen.`,
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
      );
    }),
  );

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
  app.get('/raumbuch/leistungswerte', (c) => c.redirect('/raumbuch/raumarten', 301));
  app.get('/raumbuch/raumarten', async (c) => {
    const types = await listRoomTypes(sql, true);
    return page(
      c,
      'Raumarten',
      'disposition',
      <>
        <PageHead title="Raumarten" crumbs={[['Einstellungen', '/einstellungen']]} />
        <p class="mut" style="max-width:780px">
          Auswahlliste für das Raumbuch. Beim Excel-Import werden unbekannte Raumarten automatisch angelegt.
        </p>
        <div class="tbl" style="max-width:640px">
          <table>
            <thead>
              <tr>
                <th>Raumart</th>
                <th>aktiv</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...types, null].map((t) => {
                const id = t?.id ?? randomUUID();
                const f = `rt-${id.slice(0, 8)}`;
                return (
                  <tr>
                    <td>
                      <form id={f} method="post" action={`/raumbuch/raumarten/${id}`}></form>
                      <input type="hidden" form={f} name="version" value={String(t?.version ?? '')} />
                      <input
                        form={f}
                        name="name"
                        value={t?.name ?? ''}
                        placeholder="neue Raumart"
                        aria-label="Raumart"
                      />
                    </td>
                    <td style="width:70px">
                      <input
                        type="checkbox"
                        form={f}
                        name="active"
                        checked={t ? t.active : true}
                        aria-label="aktiv"
                      />
                    </td>
                    <td style="width:110px">
                      <button class="btn sm sec" form={f}>
                        {t ? 'Speichern' : 'Anlegen'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.post(`/raumbuch/raumarten/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveRoomType(sql, c.req.param('id'), {
      name: str(b, 'name') ?? '',
      active: b.active === 'on',
      expectedVersion: versionOf(b.version),
    });
    return back(c, '/raumbuch/raumarten', { ok: 'Raumart gespeichert.' });
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
              Eingabe als Stunden:Minuten (2:30) oder Dezimal (2,5). Umrechnung: Woche = Jahr ÷ 52, Monat =
              Jahr ÷ 12. Einsatzplan: heute gültige wiederkehrende Einsätze abzüglich Pausen.
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
          <form method="post" action="/qualitaet/neu" class="actions" style="margin-top:0">
            <input type="hidden" name="id" value={randomUUID()} />
            <input type="hidden" name="site_id" value={s.id} />
            <button class="btn sm">+ Qualitätskontrolle starten</button>
          </form>
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
        <PageHead title="Qualitätskontrollen" />
        <form method="post" action="/qualitaet/neu" class="card actions" style="max-width:780px">
          <input type="hidden" name="id" value={randomUUID()} />
          <select name="site_id" required aria-label="Objekt" style="flex:1;min-width:220px">
            <option value="">Objekt wählen …</option>
            {siteList.map((s) => (
              <option value={s.id}>
                {s.name} ({s.site_no})
              </option>
            ))}
          </select>
          <button class="btn">+ Kontrolle starten</button>
        </form>
        <QcTable rows={rows} site />
        <p class="small mut">
          Bewertung: Anteil der geprüften Bereiche ohne Mangel. Grün ab {QC_GOOD} %, gelb ab {QC_FAIR} %.
          Jeder Mangel erzeugt beim Abschluss eine Nachbesserungs-Aufgabe für die Objektleitung (Frist 3
          Tage).
        </p>
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
    const photos = (
      <div class="card">
        <FileArea
          link={{ type: 'quality_check', id }}
          files={files}
          category="Foto"
          title="Fotos"
          maxBytes={env.UPLOAD_MAX_BYTES}
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
            <a class="btn sec" href={`/qualitaet/${id}/bericht.pdf`} target="_blank">
              <Icon name="pdf" /> Prüfbericht (PDF)
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
            {photos}
          </div>
        </>,
      );
    }
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
            <div class="card">
              <a class="btn sec" href={`/qualitaet/${id}/bericht.pdf`} target="_blank">
                <Icon name="pdf" /> PDF-Vorschau
              </a>
            </div>
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

  // ================================================================== Zählerstände

  const ReadingForm: FC<{ meterId: string; back: string }> = ({ meterId, back: to }) => (
    <form
      method="post"
      action={`/zaehler/${meterId}/ablesung`}
      class="actions"
      style="margin:0;gap:6px;flex-wrap:nowrap"
    >
      <input type="hidden" name="id" value={randomUUID()} />
      <input type="hidden" name="back" value={to} />
      <input
        type="date"
        name="read_on"
        value={todayBerlin()}
        max={todayBerlin()}
        aria-label="Datum"
        style="width:150px"
      />
      <input
        name="value"
        inputmode="decimal"
        placeholder="Stand"
        aria-label="Zählerstand"
        required
        style="width:120px"
      />
      <label class="chk small" style="margin:0" title="Neuer Zähler: Startwert">
        <input type="checkbox" name="replacement" /> Tausch
      </label>
      <button class="btn sm">Erfassen</button>
    </form>
  );

  const MeterTable: FC<{ rows: MeterRow[]; site?: boolean; backTo: string }> = ({ rows, site, backTo }) => (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            {site && <th>Objekt</th>}
            <th>Zähler</th>
            <th>Ort</th>
            <th class="right">Letzter Stand</th>
            <th>abgelesen</th>
            <th>Neue Ablesung</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const age = m.last_read_on
              ? Math.round((Date.parse(todayBerlin()) - Date.parse(m.last_read_on)) / 86_400_000)
              : null;
            return (
              <tr class={m.active ? '' : 'mut'}>
                {site && (
                  <td>
                    <a href={`/objekte/${m.site_id}/zaehler`}>{m.site_name}</a>
                  </td>
                )}
                <td>
                  <a href={`/zaehler/${m.id}`}>
                    {METER_KIND[m.kind]} {m.meter_no}
                  </a>
                </td>
                <td>{m.location}</td>
                <td class="right">
                  {m.last_value_milli != null ? `${milliToInput(m.last_value_milli)} ${m.unit}` : '–'}
                </td>
                <td>
                  {m.last_read_on ? dateDe(m.last_read_on) : '–'}
                  {age != null && age > 35 && <span class="badge warn"> {age} Tage</span>}
                </td>
                <td>{m.active && <ReadingForm meterId={m.id} back={backTo} />}</td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colspan={6} class="mut">
                Noch keine Zähler erfasst.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  app.get(`/objekte/:id{${UUID}}/zaehler`, (c) =>
    shells.site!(c, 'zaehler', async (s) => {
      const rows = await listMeters(sql, { siteId: s.id });
      return (
        <>
          <MeterTable rows={rows} backTo={`/objekte/${s.id}/zaehler`} />
          <form method="post" action={`/zaehler/${randomUUID()}`} class="card" style="max-width:860px">
            <h3 style="margin-top:0">Zähler hinzufügen</h3>
            <input type="hidden" name="site_id" value={s.id} />
            <div class="grid">
              <div>
                <label for="kind">Art</label>
                <select id="kind" name="kind">
                  {Object.entries(METER_KIND).map(([k, v]) => (
                    <option value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label for="meter_no">Zählernummer</label>
                <input id="meter_no" name="meter_no" required />
              </div>
              <div>
                <label for="location">Ort</label>
                <input id="location" name="location" placeholder="z. B. Keller, Hausanschlussraum" />
              </div>
              <div>
                <label for="unit">Einheit</label>
                <input id="unit" name="unit" placeholder="automatisch (kWh / m³)" />
              </div>
            </div>
            <div class="formfoot">
              <button class="btn">Zähler anlegen</button>
            </div>
          </form>
        </>
      );
    }),
  );

  app.get('/zaehler', async (c) => {
    const sites = c.get('sites');
    const rows = await listMeters(sql, sites ? { siteIds: sites } : {});
    const due = c.req.query('faellig') === '1';
    const today = Date.parse(todayBerlin());
    const shown = due
      ? rows.filter(
          (m) => m.active && (!m.last_read_on || today - Date.parse(m.last_read_on) > 35 * 86_400_000),
        )
      : rows;
    return page(
      c,
      'Zählerstände',
      'disposition',
      <>
        <PageHead title="Zählerstände" />
        <div class="actions" style="margin-top:-8px">
          <a class={`btn sm ${due ? 'sec' : ''}`} href="/zaehler">
            Alle ({rows.length})
          </a>
          <a class={`btn sm ${due ? '' : 'sec'}`} href="/zaehler?faellig=1">
            Ablesung fällig (älter als 35 Tage)
          </a>
        </div>
        <MeterTable rows={shown} site backTo={due ? '/zaehler?faellig=1' : '/zaehler'} />
        <p class="small mut">
          Zähler legen Sie im Objekt unter „Zähler“ an. Ablesungen sind unveränderbar; Korrektur über eine
          neue Ablesung.
        </p>
      </>,
    );
  });

  app.get(`/zaehler/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const m = await getMeter(sql, id);
    if (!m) return c.notFound();
    assertSite(c, m.site_id);
    const [readings, [site]] = await Promise.all([
      readingsWithConsumption(sql, id),
      sql<{ name: string }[]>`select name from app.sites where id = ${m.site_id}`,
    ]);
    return page(
      c,
      `Zähler ${m.meter_no}`,
      'disposition',
      <>
        <PageHead
          title={`${METER_KIND[m.kind]}zähler ${m.meter_no}`}
          no={site?.name ?? ''}
          crumbs={[
            ['Zählerstände', '/zaehler'],
            [site?.name ?? 'Objekt', `/objekte/${m.site_id}/zaehler`],
          ]}
        />
        <div class="cols">
          <div>
            <div class="card">
              <h3 style="margin-top:0">Neue Ablesung</h3>
              <ReadingForm meterId={id} back={`/zaehler/${id}`} />
            </div>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th class="right">Stand</th>
                    <th class="right">Verbrauch</th>
                    <th class="right">pro Tag</th>
                    <th>Hinweis</th>
                    <th>erfasst</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.map((r) => (
                    <tr>
                      <td>{dateDe(r.read_on)}</td>
                      <td class="right">
                        {milliToInput(r.value_milli)} {m.unit}
                      </td>
                      <td class="right">
                        {r.consumption_milli != null ? `${milliToInput(r.consumption_milli)} ${m.unit}` : '–'}
                      </td>
                      <td class="right">
                        {r.consumption_milli != null && r.days
                          ? num(Number(r.consumption_milli) / 1000 / r.days, 2)
                          : '–'}
                      </td>
                      <td>
                        {r.is_replacement && <span class="badge tag">Zählertausch</span>} {r.note}
                      </td>
                      <td class="small mut">
                        {r.recorded_by},{' '}
                        {r.recorded_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
                      </td>
                    </tr>
                  ))}
                  {!readings.length && (
                    <tr>
                      <td colspan={6} class="mut">
                        Noch keine Ablesung.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <form method="post" action={`/zaehler/${id}`} class="card" data-version={String(m.version)}>
            <h3 style="margin-top:0">Stammdaten</h3>
            <input type="hidden" name="version" value={String(m.version)} />
            <input type="hidden" name="site_id" value={m.site_id} />
            <label for="kind">Art</label>
            <select id="kind" name="kind">
              {Object.entries(METER_KIND).map(([k, v]) => (
                <option value={k} selected={k === m.kind}>
                  {v}
                </option>
              ))}
            </select>
            <label for="meter_no">Zählernummer</label>
            <input id="meter_no" name="meter_no" value={m.meter_no} required />
            <label for="location">Ort</label>
            <input id="location" name="location" value={m.location ?? ''} />
            <label for="unit">Einheit</label>
            <input id="unit" name="unit" value={m.unit} />
            <div class="chk" style="margin-top:10px">
              <input type="checkbox" id="active" name="active" checked={m.active} />
              <label for="active">aktiv</label>
            </div>
            <div class="formfoot">
              <button class="btn sec">Speichern</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/zaehler/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const siteId = str(b, 'site_id') ?? '';
    assertSite(c, siteId);
    const cur = await getMeter(sql, id);
    if (cur) assertSite(c, cur.site_id);
    const kind = (str(b, 'kind') ?? 'sonstiges') as MeterKind;
    await saveMeter(sql, id, {
      siteId,
      kind,
      meterNo: str(b, 'meter_no') ?? '',
      location: str(b, 'location'),
      unit: str(b, 'unit') ?? METER_UNIT[kind] ?? null,
      active: cur ? b.active === 'on' : true,
      expectedVersion: versionOf(b.version),
    });
    return cur
      ? back(c, `/zaehler/${id}`, { ok: 'Zähler gespeichert.' })
      : back(c, `/objekte/${siteId}/zaehler`, { ok: 'Zähler angelegt.' });
  });

  app.post(`/zaehler/:id{${UUID}}/ablesung`, async (c) => {
    const meterId = c.req.param('id');
    const m = await getMeter(sql, meterId);
    if (!m) return c.notFound();
    assertSite(c, m.site_id);
    const b = await c.req.parseBody({ all: true });
    const to = str(b, 'back') ?? `/zaehler/${meterId}`;
    const safeBack = /^\/(zaehler|objekte)[/?\w=-]*$/.test(to) ? to : `/zaehler/${meterId}`;
    let value: bigint;
    try {
      value = parseQuantity(str(b, 'value') ?? '');
    } catch {
      throw new BusinessError('Zählerstand bitte als Zahl, z. B. 12345,6');
    }
    await addReading(
      sql,
      str(b, 'id') ?? randomUUID(),
      {
        meterId,
        readOn: str(b, 'read_on') ?? todayBerlin(),
        valueMilli: value,
        isReplacement: b.replacement === 'on',
        note: str(b, 'note'),
      },
      c.get('actor'),
    );
    return back(c, safeBack, { ok: `Zählerstand ${m.meter_no} erfasst.` });
  });
}
