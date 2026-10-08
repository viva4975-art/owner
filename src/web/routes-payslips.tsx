import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { importPayslips, listPayslips, releasePayslips } from '../services/payslips.js';
import { filePath, type FileRow } from '../services/uploads.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';
import { uploadConfig } from './routes-files.js';

const prevMonth = () => {
  const d = new Date(`${todayBerlin().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/** Lohnabrechnungen aus dem Lohnprogramm einlesen (ZIP oder Sammel-PDF) und verteilen. */
export function registerPayslipRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;

  app.get('/personal/lohnabrechnungen', async (c) => {
    const q = c.req.query('monat');
    const month = q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : prevMonth();
    const rows = await listPayslips(sql, { month });
    const open = rows.filter((r) => !r.released).length;
    return page(
      c,
      'Lohnabrechnungen',
      'transfer',
      <>
        <PageHead title="Lohnabrechnungen einlesen" crumbs={[['Transfer', '/transfer/kontoumsaetze']]} />
        <form method="post" action="/personal/lohnabrechnungen" enctype="multipart/form-data" class="card">
          <input type="hidden" name="id" value={randomUUID()} />
          <div class="grid">
            <div>
              <label for="m">Abrechnungsmonat</label>
              <input id="m" type="month" name="monat" value={month} required />
            </div>
            <div>
              <label for="f">Datei aus dem Lohnprogramm (ZIP mit Einzel-PDFs oder eine Sammel-PDF)</label>
              <input id="f" type="file" name="datei" accept=".pdf,.zip" required />
            </div>
            <div class="chk">
              <input type="checkbox" id="rel" name="release" />
              <label for="rel">Gleich in der Mitarbeiter-App freigeben</label>
            </div>
          </div>
          <div class="actions form-foot">
            <button class="btn">Einlesen und verteilen</button>
            <span class="small mut">
              Zuordnung über die Personalnummer auf der Abrechnung (bzw. im Dateinamen). Nicht zuordenbare
              Seiten werden gemeldet. Erneut einlesen legt nichts doppelt ab.
            </span>
          </div>
        </form>
        <div class="card">
          <div class="actions" style="margin-top:0">
            <h3 style="margin:0">
              {month.slice(5)}/{month.slice(0, 4)}: {rows.length} Abrechnungen
            </h3>
            <form method="get" style="margin:0 0 0 auto" class="actions">
              <input type="month" name="monat" value={month} style="max-width:170px" />
              <button class="btn sec sm">Anzeigen</button>
            </form>
            {open > 0 && (
              <form method="post" action="/personal/lohnabrechnungen/freigeben" style="margin:0">
                <input type="hidden" name="monat" value={month} />
                <button class="btn sm">{open} in der App freigeben</button>
              </form>
            )}
          </div>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Pers.-Nr.</th>
                  <th>Name</th>
                  <th>App</th>
                  <th>gelesen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>{r.personnel_no}</td>
                    <td>
                      <a href={`/personal/${r.employee_id}/dokumente`}>{r.name}</a>
                    </td>
                    <td>
                      {r.released ? (
                        <span class="badge ok">freigegeben</span>
                      ) : (
                        <span class="badge">nicht freigegeben</span>
                      )}
                    </td>
                    <td class="small">
                      {r.viewed_at ? r.viewed_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : '–'}
                    </td>
                    <td>
                      <a class="btn sec sm" href={`/dateien/${r.file_id}`} target="_blank">
                        PDF
                      </a>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={5}>
                      <div class="empty">Für diesen Monat noch nichts eingelesen.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p class="small mut">
            Rechtlich: Die Abrechnung ist in Textform zu erteilen (§ 108 GewO); die Bereitstellung im
            digitalen Mitarbeiter-Postfach genügt (BAG 28.01.2025 – 9 AZR 48/24). Wer kein Handy nutzt,
            bekommt sie weiter auf Papier.
          </p>
        </div>
      </>,
    );
  });

  app.post('/personal/lohnabrechnungen', async (c) => {
    const b = await c.req.parseBody();
    const file = b.datei;
    if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte eine Datei auswählen');
    if (file.size > 200 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 200 MB)');
    const month = String(b.monat ?? '');
    const r = await importPayslips(sql, uploadConfig(ctx), {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      month,
      release: b.release === 'on',
      actor: c.get('actor'),
    });
    const msg = `${r.assigned.length} Lohnabrechnungen zugeordnet.${
      r.unassigned.length
        ? ` Nicht zugeordnet: ${r.unassigned.slice(0, 8).join('; ')}${r.unassigned.length > 8 ? ' …' : ''}`
        : ''
    }`;
    return back(
      c,
      `/personal/lohnabrechnungen?monat=${month}`,
      r.unassigned.length ? { fehler: msg } : { ok: msg },
    );
  });

  app.post('/personal/lohnabrechnungen/freigeben', async (c) => {
    const b = await c.req.parseBody();
    const month = String(b.monat ?? '');
    const n = await releasePayslips(sql, month, c.get('actor'));
    return back(c, `/personal/lohnabrechnungen?monat=${month}`, {
      ok: `${n} Abrechnungen in der App freigegeben.`,
    });
  });
}

/** Mitarbeiter-App: eigene freigegebene Lohnabrechnung laden (vermerkt „gelesen“). */
export async function payslipFile(ctx: Ctx, employeeId: string, fileId: string) {
  const { sql } = ctx.deps;
  const [p] = await sql<{ file_id: string }[]>`
    select file_id from app.payslips where file_id = ${fileId} and employee_id = ${employeeId} and released`;
  if (!p) return null;
  const [f] = await sql<FileRow[]>`select * from app.files where id = ${fileId} and status = 'complete'`;
  if (!f) return null;
  await sql`update app.payslips set viewed_at = coalesce(viewed_at, now()) where file_id = ${fileId}`;
  return { name: f.original_name, data: new Uint8Array(await readFile(filePath(uploadConfig(ctx), f))) };
}
