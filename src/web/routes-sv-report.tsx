import type { FC } from 'hono/jsx';
import { randomUUID } from 'node:crypto';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  SOFORT_FROM,
  SOFORT_VIA,
  type SofortField,
  type SofortReport,
  type SofortVia,
  deleteSofort,
  listSofort,
  recordSofort,
  sofortData,
} from '../services/sv-report.js';
import type { Sql } from '../db/client.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';

/*
 * SV-Sofortmeldung beim Mitarbeiter (Ahmed 26.10.): Meldedaten zum Übertragen in Lexware/sv.net, „gemeldet am“ mit
 * Übermittlungsnummer festhalten. Kasten steht oben in der Mitarbeiter-Übersicht (Sprungmarke #sofortmeldung).
 */

const when = (iso: string) =>
  new Date(iso).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const nowLocal = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date())
    .replace(' ', 'T');

export const SofortBox: FC<{
  employeeId: string;
  entryDate: string;
  fields: SofortField[];
  complete: boolean;
  reports: SofortReport[];
  isAdmin: boolean;
}> = ({ employeeId, entryDate, fields, complete, reports, isAdmin }) => {
  const current = reports.find((r) => r.entry_date === entryDate);
  const required = entryDate >= SOFORT_FROM;
  const today = todayBerlin();
  const copyText = fields.map((f) => `${f.label}: ${f.value}`).join('\n');
  // Eintritt vor der Umstellung ohne Eintrag: nichts anzeigen (wurde über Lexware gemeldet)
  if (!required && !reports.length) return null;
  return (
    <section
      class="card"
      id="sofortmeldung"
      style={current ? '' : 'border-left:4px solid var(--err, #b42318)'}
    >
      <h3 style="margin-top:0">
        SV-Sofortmeldung{' '}
        {current ? (
          <span class="badge ok">gemeldet am {when(current.reported_at)}</span>
        ) : (
          <span class="badge err">
            fehlt –{' '}
            {entryDate > today ? `vor Arbeitsbeginn am ${formatDateDe(entryDate)}` : 'sofort nachholen'}
          </span>
        )}
      </h3>
      {current ? (
        <p class="small" style="margin:0 0 8px">
          Beschäftigungsbeginn {formatDateDe(current.entry_date)} · über {SOFORT_VIA[current.via]}
          {current.transfer_no ? ` · Übermittlungsnummer ${current.transfer_no}` : ''}
          {current.note ? ` · ${current.note}` : ''} · erfasst von {current.created_by}
        </p>
      ) : (
        <p class="small" style="margin:0 0 8px">
          Gebäudereinigung: Meldung spätestens bei Arbeitsaufnahme (§ 28a Abs. 4 SGB IV), auch bei Minijobs –
          sonst Bußgeld bis 25.000 € (§ 111 SGB IV). In Lexware bzw. sv.net abgeben, dann hier festhalten.
        </p>
      )}
      <details open={!current}>
        <summary class="small">Meldedaten für Lexware / sv.net</summary>
        <dl class="kv" style="margin-top:8px">
          {fields.map((f) => (
            <>
              <dt>{f.label}</dt>
              <dd>
                {f.value} {f.missing && <span class="badge err">fehlt</span>}
              </dd>
            </>
          ))}
        </dl>
        {!complete && (
          <p class="small" style="color:var(--err, #b42318)">
            Es fehlen Angaben – unter „Stammdaten bearbeiten“ ergänzen
            {fields.some((f) => f.label.startsWith('Betriebsnummer') && f.missing)
              ? ' bzw. die Betriebsnummer unter Einstellungen → Firmendaten'
              : ''}
            . Ohne Versicherungsnummer vergibt die Rentenversicherung sie anhand von Geburtsdatum, -ort,
            Geschlecht, Staatsangehörigkeit und Anschrift (ggf. Geburtsname in Lexware ergänzen).
          </p>
        )}
        <textarea id={`sofort-copy-${employeeId}`} hidden>
          {copyText}
        </textarea>
        <button
          type="button"
          class="btn sm sec"
          onclick={`navigator.clipboard.writeText(document.getElementById('sofort-copy-${employeeId}').value);this.textContent='Kopiert ✓'`}
        >
          Meldedaten kopieren
        </button>
      </details>
      {!current && (
        <form
          method="post"
          action={`/personal/${employeeId}/sofortmeldung`}
          class="grid"
          style="margin-top:12px"
        >
          <input type="hidden" name="id" value={randomUUID()} />
          <div>
            <label for="sm-at">Gemeldet am</label>
            <input id="sm-at" type="datetime-local" name="reported_at" value={nowLocal()} required />
          </div>
          <div>
            <label for="sm-via">über</label>
            <select id="sm-via" name="via" data-nosearch>
              {Object.entries(SOFORT_VIA).map(([k, v]) => (
                <option value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label for="sm-no">Übermittlungs-/Bestätigungsnummer</label>
            <input
              id="sm-no"
              name="transfer_no"
              maxlength={60}
              placeholder="aus dem Protokoll von Lexware/sv.net"
            />
          </div>
          <div>
            <label for="sm-note">Bemerkung</label>
            <input id="sm-note" name="note" maxlength={500} />
          </div>
          <div class="actions">
            <button class="btn sm">Sofortmeldung festhalten</button>
          </div>
        </form>
      )}
      {reports.length > (current ? 1 : 0) || (current && isAdmin) ? (
        <details style="margin-top:8px">
          <summary class="small">Alle Sofortmeldungen ({reports.length})</summary>
          <table class="list" style="margin-top:6px">
            <thead>
              <tr>
                <th>Beginn</th>
                <th>gemeldet am</th>
                <th>über</th>
                <th>Nummer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr>
                  <td>{formatDateDe(r.entry_date)}</td>
                  <td>{when(r.reported_at)}</td>
                  <td>{SOFORT_VIA[r.via]}</td>
                  <td>{r.transfer_no ?? '–'}</td>
                  <td>
                    {isAdmin && (
                      <form
                        method="post"
                        action={`/personal/${employeeId}/sofortmeldung/${r.id}/loeschen`}
                        data-confirm="Eintrag entfernen? Nur wenn er falsch erfasst wurde – die Meldung selbst bleibt bei der Rentenversicherung."
                      >
                        <button class="btn sm ghost">entfernen</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
};

export async function sofortBoxFor(sql: Sql, employeeId: string, entryDate: string, isAdmin: boolean) {
  const [{ fields, complete }, reports] = await Promise.all([
    sofortData(sql, employeeId),
    listSofort(sql, employeeId),
  ]);
  return (
    <SofortBox
      employeeId={employeeId}
      entryDate={entryDate}
      fields={fields}
      complete={complete}
      reports={reports}
      isAdmin={isAdmin}
    />
  );
}

export function registerSvReportRoutes({ app, deps, back }: Ctx) {
  const { sql } = deps;
  app.post(`/personal/:id{${UUID}}/sofortmeldung`, async (c) => {
    const empId = c.req.param('id');
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    const id = str(b, 'id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BusinessError('Formular ungültig – Seite neu laden');
    const at = str(b, 'reported_at') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) throw new BusinessError('Zeitpunkt der Meldung fehlt');
    // Berliner Ortszeit → Zeitpunkt
    const [iso] = await sql<
      { t: string }[]
    >`select (${at}::timestamp at time zone 'Europe/Berlin')::text as t`;
    const done = await recordSofort(sql, {
      id,
      employeeId: empId,
      reportedAt: iso!.t,
      transferNo: str(b, 'transfer_no'),
      via: (str(b, 'via') ?? 'lexware') as SofortVia,
      note: str(b, 'note'),
      actor: c.get('actor'),
    });
    return back(c, `/personal/${empId}#sofortmeldung`, {
      ok: done ? 'Sofortmeldung festgehalten.' : 'Sofortmeldung war schon festgehalten.',
    });
  });
  app.post(`/personal/:id{${UUID}}/sofortmeldung/:rid{${UUID}}/loeschen`, async (c) => {
    if (c.get('user').role !== 'admin') throw new BusinessError('Entfernen nur durch einen Admin');
    await deleteSofort(sql, c.req.param('rid'), c.get('actor'));
    return back(c, `/personal/${c.req.param('id')}#sofortmeldung`, { ok: 'Eintrag entfernt.' });
  });
}
