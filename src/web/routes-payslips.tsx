import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  importPayslips,
  listPayslips,
  monthLabel,
  releasePayslips,
  syncPayslipsFromFiles,
} from '../services/payslips.js';
import {
  payslipMailPreview,
  payslipMonths,
  payslipMailStatus,
  payslipRecipients,
  sendPayslip,
  setPayslipMailSkip,
} from '../services/payslip-mail.js';
import { dismissSendJob, queuedIds, recentSendJobs, startSendJob } from '../services/send-jobs.js';
import { filePath, type FileRow } from '../services/uploads.js';
import type { Context } from 'hono';
import type { AppEnv, Ctx } from './app.js';
import { PageHead, anz } from './layout.js';
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
    // Abrechnungen, die direkt in der Personalakte (Dokumente → Lohn) liegen, gehören auch in die Liste
    const synced = await syncPayslipsFromFiles(sql, uploadConfig(ctx));
    // nur Mitarbeitende, die im Monat noch beschäftigt waren (Austritt im Monat oder später bzw. kein Austritt)
    const allRows = await listPayslips(sql, { month });
    const rows = allRows.filter((r) => !r.left_before);
    const leftCount = allRows.length - rows.length;
    const months = await payslipMonths(sql);
    if (!months.some((m) => m.month === month)) months.push({ month, total: 0, open: 0 });
    months.sort((a, b) => b.month.localeCompare(a.month));
    const open = rows.filter((r) => !r.released).length;
    const ids = rows.map((r) => r.file_id);
    const [mails, rcpt] = await Promise.all([payslipMailStatus(sql, ids), payslipRecipients(sql, ids)]);
    const jobs = recentSendJobs('lohn');
    const running = jobs.some((j) => j.running);
    const queued = new Set(queuedIds('lohn'));
    const fmt = (d: Date) =>
      d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
    const sendable = rows.filter((r) => {
      const x = rcpt.get(r.file_id);
      return x?.email && x.has_birth && !queued.has(r.file_id);
    });
    const isSent = (id: string) => {
      const m = mails.get(id);
      return !!m && m.status !== 'fehler';
    };
    const unsent = sendable.filter((r) => !r.mail_skip_at && !isSent(r.file_id)).length;
    const sentCount = rows.filter((r) => !r.mail_skip_at && isSent(r.file_id)).length;
    // Gesendete standardmäßig ausblenden; nur wer sie noch einmal senden will, blendet sie ein
    // Ansicht: offen (Standard) / mit gesendeten / ausgeblendet
    const view =
      c.req.query('ausgeblendet') === '1' ? 'skip' : c.req.query('gesendet') === '1' ? 'sent' : 'open';
    const showSent = view === 'sent';
    const active = rows.filter((r) => !r.mail_skip_at);
    const skipped = rows.filter((r) => r.mail_skip_at);
    const visible = view === 'skip' ? skipped : showSent ? active : active.filter((r) => !isSent(r.file_id));
    const viewQ = view === 'skip' ? '&ausgeblendet=1' : showSent ? '&gesendet=1' : '';
    const self = (extra = '') => `/personal/lohnabrechnungen?monat=${month}${extra}`;
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
              <label for="m">Abrechnungsmonat, falls nicht erkennbar</label>
              <input id="m" type="month" name="monat" value={month} />
              <span class="small mut">
                Der Monat wird je Datei erkannt (Lexware-Dateiname bzw. „Abrechnungsmonat“ auf der Abrechnung)
                – eine ZIP mit mehreren Monaten geht. Dieser Monat gilt nur für Dateien ohne erkennbaren
                Monat.
              </span>
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
        {running && <meta http-equiv="refresh" content={`4;url=${self(viewQ)}`} />}
        {jobs.map((j) => (
          <div
            class="card"
            style={`padding:10px 14px;border-left:4px solid ${j.running ? '#7d1435' : j.errors.length ? '#c2410c' : '#15803d'}`}
          >
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <b>
                {j.running
                  ? `Versand läuft: ${j.done} von ${j.ids.length} Lohnabrechnungen`
                  : `Versand fertig: ${j.ok} von ${j.ids.length} Lohnabrechnungen per E-Mail gesendet`}
              </b>
              {j.running && <span class="small mut">– Seite aktualisiert sich selbst.</span>}
              {!j.running && (
                <form
                  method="post"
                  action={`/personal/lohnabrechnungen/auftrag/${j.id}/ausblenden?monat=${month}`}
                  style="margin-left:auto"
                >
                  <button class="btn sm ghost">Ausblenden</button>
                </form>
              )}
            </div>
            {j.errors.length > 0 && (
              <ul class="small" style="margin:6px 0 0;color:#b91c1c">
                {j.errors.map((e) => (
                  <li>{e}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div class="card">
          <div class="actions" style="margin-top:0">
            <h3 style="margin:0">
              {monthLabel(month)}: {rows.length} Abrechnungen
            </h3>
            <form method="get" style="margin:0 0 0 auto" class="actions">
              <label for="lm" class="small mut">
                Monat
              </label>
              <select id="lm" name="monat" data-autosubmit style="min-width:220px">
                {months.map((m) => (
                  <option value={m.month} selected={m.month === month}>
                    {monthLabel(m.month)}
                    {m.total ? ` – ${m.open} offen von ${m.total}` : ' – keine Abrechnungen'}
                  </option>
                ))}
              </select>
              <noscript>
                <button class="btn sec sm">Anzeigen</button>
              </noscript>
            </form>
            {open > 0 && (
              <form method="post" action="/personal/lohnabrechnungen/freigeben" style="margin:0">
                <input type="hidden" name="monat" value={month} />
                <button class="btn sm">{open} in der App freigeben</button>
              </form>
            )}
          </div>
          <div class="actions" style="margin:10px 0 0;gap:6px">
            {months.slice(0, 6).map((m) => (
              <a
                class={`btn sm ${m.month === month ? '' : 'sec'}`}
                href={`/personal/lohnabrechnungen?monat=${m.month}`}
              >
                {monthLabel(m.month)}
                {m.open ? ` · ${m.open} offen` : m.total ? ' · erledigt' : ''}
              </a>
            ))}
          </div>
          {leftCount > 0 && (
            <p class="small mut" style="margin:6px 0 0">
              {anz(leftCount, 'Abrechnung', 'Abrechnungen')} von schon vor {monthLabel(month)} Ausgetretenen
              nicht in der Liste.
            </p>
          )}
          <p class="small mut" style="margin:6px 0 0">
            Nur Mitarbeitende, die im Monat noch beschäftigt waren; wer keine Abrechnung für den Monat hat,
            steht nicht in der Liste. Die Liste nimmt alle Lohnabrechnungen aus den Personalakten (Dokumente →
            Lohn) – auch dort direkt hochgeladene. Der Monat kommt aus dem Dateinamen bzw. aus
            „Abrechnungsmonat“ auf der Abrechnung.
          </p>
          {synced.unknown.length > 0 && (
            <details class="warn" style="margin-top:8px">
              <summary>
                {anz(synced.unknown.length, 'Datei', 'Dateien')} unter Lohn ohne erkennbaren Monat – nicht in
                der Liste
              </summary>
              <ul class="small" style="margin:6px 0 0">
                {synced.unknown.slice(0, 50).map((u) => (
                  <li>
                    <a href={`/personal/${u.employee_id}/dokumente`}>{u.name}</a> – Datei umbenennen, z. B.
                    „Lohnabrechnung 2026-10 …“
                  </li>
                ))}
              </ul>
            </details>
          )}
          <form
            method="post"
            action={`/personal/lohnabrechnungen/senden?monat=${month}${viewQ}`}
            id="lohnmail"
          >
            <input type="hidden" name="formid" value={randomUUID()} />
            {showSent && <input type="hidden" name="erneut" value="on" />}
            <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">
              <nav class="ls-tabs" style="flex:1;margin-bottom:0">
                <a class={view === 'open' ? 'on' : ''} href={self()}>
                  Noch nicht gesendet<span>{active.length - sentCount}</span>
                </a>
                <a class={showSent ? 'on' : ''} href={self('&gesendet=1')}>
                  Mit schon gesendeten (erneut senden)<span>{active.length}</span>
                </a>
                <a class={view === 'skip' ? 'on' : ''} href={self('&ausgeblendet=1')}>
                  Ausgeblendet (kein Versand)<span>{skipped.length}</span>
                </a>
              </nav>
              <a
                class="btn sec sm"
                href={`/personal/lohnabrechnungen/mail-vorschau${visible[0] ? `?datei=${visible[0].file_id}` : ''}`}
                target="_blank"
              >
                So sieht die E-Mail aus
              </a>
            </div>
            <div class="actions" style="margin:8px 0">
              {view === 'skip' ? (
                <button
                  class="btn sm"
                  formaction={`/personal/lohnabrechnungen/einblenden?monat=${month}${viewQ}`}
                >
                  Markierte wieder einblenden
                </button>
              ) : (
                <>
                  <button
                    class="btn sm"
                    data-confirm={
                      showSent
                        ? 'Markierte Lohnabrechnungen per E-Mail senden? Schon gesendete gehen damit noch einmal raus.'
                        : 'Markierte Lohnabrechnungen jetzt per E-Mail senden? Das PDF ist mit dem Geburtsdatum (TTMMJJ) geschützt.'
                    }
                  >
                    Markierte per E-Mail senden
                  </button>
                  <details class="inline-pop">
                    <summary class="btn sec sm">Markierte ausblenden …</summary>
                    <div class="actions" style="margin-top:6px">
                      <input
                        name="grund"
                        maxlength={200}
                        placeholder="Grund (optional), z. B. auf Papier / schon erhalten"
                        aria-label="Grund für das Ausblenden"
                        style="min-width:280px"
                      />
                      <button
                        class="btn sec sm"
                        formaction={`/personal/lohnabrechnungen/ausblenden?monat=${month}${viewQ}`}
                      >
                        Ausblenden – kein Versand
                      </button>
                    </div>
                  </details>
                </>
              )}
              <span class="small mut" style="margin-left:auto">
                {unsent} bereit zum Senden · Absender Buchhaltung
              </span>
            </div>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th style="width:30px">
                      <input
                        type="checkbox"
                        aria-label="alle markieren"
                        onclick="for(const x of this.closest('table').querySelectorAll('input[name=sel]:not(:disabled)'))x.checked=this.checked"
                      />
                    </th>
                    <th>Pers.-Nr.</th>
                    <th>Name</th>
                    <th>E-Mail</th>
                    <th>Versand</th>
                    <th>App</th>
                    <th>gelesen</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const x = rcpt.get(r.file_id);
                    const m = mails.get(r.file_id);
                    const q = queued.has(r.file_id);
                    return (
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            name="sel"
                            value={r.file_id}
                            aria-label={`${r.name} auswählen`}
                            disabled={q}
                            title={
                              !x?.email
                                ? 'keine E-Mail-Adresse'
                                : !x.has_birth
                                  ? 'Geburtsdatum fehlt (Passwort)'
                                  : undefined
                            }
                          />
                        </td>
                        <td>{r.personnel_no}</td>
                        <td>
                          <a href={`/personal/${r.employee_id}/dokumente`}>{r.name}</a>
                        </td>
                        <td class="small">
                          {x?.email ?? <span class="badge warn">keine E-Mail</span>}
                          {x?.email && !x.has_birth && (
                            <>
                              {' '}
                              <a class="badge warn" href={`/personal/${r.employee_id}/bearbeiten`}>
                                Geburtsdatum fehlt
                              </a>
                            </>
                          )}
                        </td>
                        <td class="small">
                          {r.mail_skip_at ? (
                            <span class="badge" title={r.mail_skip_reason ?? ''}>
                              ausgeblendet{r.mail_skip_reason ? `: ${r.mail_skip_reason}` : ''}
                            </span>
                          ) : q ? (
                            <span class="badge">wird gesendet …</span>
                          ) : !m ? (
                            '–'
                          ) : m.status === 'gesendet' ? (
                            <span class="badge ok" title={m.sent_to ?? ''}>
                              gesendet {fmt(m.at)}
                            </span>
                          ) : m.status === 'fehler' ? (
                            <span class="badge err" title={m.error ?? ''}>
                              Fehler {fmt(m.at)}
                            </span>
                          ) : (
                            <span class="badge">läuft</span>
                          )}
                        </td>
                        <td>
                          {r.released ? (
                            <span class="badge ok">freigegeben</span>
                          ) : (
                            <span class="badge">nicht freigegeben</span>
                          )}
                        </td>
                        <td class="small">
                          {r.viewed_at
                            ? r.viewed_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })
                            : '–'}
                        </td>
                        <td>
                          <a class="btn sec sm" href={`/dateien/${r.file_id}`} target="_blank">
                            PDF
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colspan={8}>
                        <div class="empty">
                          {rows.length === 0
                            ? 'Für diesen Monat noch nichts eingelesen.'
                            : view === 'skip'
                              ? 'Keine ausgeblendeten Abrechnungen in diesem Monat.'
                              : 'Alle Abrechnungen dieses Monats sind schon gesendet oder ausgeblendet.'}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </form>
          <p class="small mut">
            E-Mail: Das PDF ist mit dem Geburtsdatum der Person im Format TTMMJJ geschützt (z. B. 05.03.1985 →
            050385); das Passwort steht nicht in der Mail, nur die Regel. Gesendet wird von der
            Buchhaltungs-Adresse, nacheinander (der Mailserver erlaubt nur wenige Mails je Minute). Jede
            Abrechnung geht nur einmal raus; schon gesendete gehen nur über den Reiter „Mit schon gesendeten“
            noch einmal raus.
          </p>
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
    const shown = r.months[0]?.month ?? month;
    const msg = `${r.assigned.length} Lohnabrechnungen zugeordnet${
      r.months.length ? ` (${r.months.map((x) => `${monthLabel(x.month)}: ${x.count}`).join(', ')})` : ''
    }.${
      r.unassigned.length
        ? ` Nicht zugeordnet: ${r.unassigned.slice(0, 8).join('; ')}${r.unassigned.length > 8 ? ' …' : ''}`
        : ''
    }`;
    return back(
      c,
      `/personal/lohnabrechnungen?monat=${shown}`,
      r.unassigned.length ? { fehler: msg } : { ok: msg },
    );
  });

  app.post('/personal/lohnabrechnungen/senden', async (c) => {
    const month = String(c.req.query('monat') ?? '');
    const to = `/personal/lohnabrechnungen?monat=${month}${c.req.query('gesendet') === '1' ? '&gesendet=1' : ''}`;
    const b = await c.req.parseBody({ all: true });
    const sel = [...new Set(([] as unknown[]).concat(b.sel ?? []).map(String))];
    if (!sel.length) return back(c, to, { fehler: 'Bitte Personen ankreuzen.' });
    // ohne E-Mail/Geburtsdatum oder ausgeblendet: nicht in den Versand (nur zum Ausblenden ankreuzbar)
    const rc = await payslipRecipients(sql, sel);
    const skippedRows = await sql<{ file_id: string }[]>`
      select p.file_id from app.payslips p join app.employees e on e.id = p.employee_id
       where p.file_id = any(${sel}::uuid[])
         and (p.mail_skip_at is not null or (e.exit_date is not null and e.exit_date < (p.month || '-01')::date))`;
    const skipSet = new Set(skippedRows.map((x) => x.file_id));
    const ready = sel.filter((id) => rc.get(id)?.email && rc.get(id)?.has_birth && !skipSet.has(id));
    const notReady = sel.length - ready.length;
    if (!ready.length)
      return back(c, to, {
        fehler:
          'Keine der markierten Personen kann eine E-Mail bekommen (E-Mail-Adresse oder Geburtsdatum fehlt).',
      });
    const again = b.erneut === 'on' ? String(b.formid ?? randomUUID()) : undefined;
    const actor = c.get('actor');
    const cfg = uploadConfig(ctx);
    const job = startSendJob(
      'Lohnabrechnungen',
      ready,
      (id) => sendPayslip(deps, cfg, id, actor, again),
      async (_id, e) => (e as Error).message,
      'lohn',
    );
    return back(c, to, {
      ok: job.ids.length
        ? `Versand von ${job.ids.length} Lohnabrechnungen gestartet – läuft im Hintergrund.${
            notReady ? ` ${notReady} ohne E-Mail-Adresse/Geburtsdatum bzw. ausgetreten übersprungen.` : ''
          }`
        : 'Die markierten Abrechnungen werden schon gesendet.',
    });
  });

  const skipRoute = (skip: boolean) => async (c: Context<AppEnv>) => {
    const month = String(c.req.query('monat') ?? '');
    const q =
      c.req.query('ausgeblendet') === '1'
        ? '&ausgeblendet=1'
        : c.req.query('gesendet') === '1'
          ? '&gesendet=1'
          : '';
    const to = `/personal/lohnabrechnungen?monat=${month}${q}`;
    const b = await c.req.parseBody({ all: true });
    const sel = [...new Set(([] as unknown[]).concat(b.sel ?? []).map(String))];
    if (!sel.length) return back(c, to, { fehler: 'Bitte Personen ankreuzen.' });
    const n = await setPayslipMailSkip(
      sql,
      sel,
      skip,
      c.get('actor'),
      typeof b.grund === 'string' ? b.grund : null,
    );
    return back(c, to, {
      ok: skip
        ? `${anz(n, 'Abrechnung', 'Abrechnungen')} ausgeblendet – keine E-Mail.`
        : `${anz(n, 'Abrechnung', 'Abrechnungen')} wieder eingeblendet.`,
    });
  };
  app.post('/personal/lohnabrechnungen/ausblenden', skipRoute(true));
  app.post('/personal/lohnabrechnungen/einblenden', skipRoute(false));

  app.get('/personal/lohnabrechnungen/mail-vorschau', async (c) => {
    const v = await payslipMailPreview(sql, deps.env, c.req.query('datei') || undefined);
    return page(
      c,
      'Vorschau Lohn-E-Mail',
      'transfer',
      <>
        <PageHead
          title="So sieht die E-Mail aus"
          crumbs={[['Lohnabrechnungen', '/personal/lohnabrechnungen']]}
        />
        <section class="card" style="max-width:820px">
          {v.example && (
            <p class="small mut" style="margin-top:0">
              Beispiel – für diesen Monat ist noch keine Abrechnung da.
            </p>
          )}
          <table class="keep" style="width:100%;table-layout:fixed;overflow-wrap:anywhere">
            <colgroup>
              <col style="width:90px" />
              <col />
            </colgroup>
            <tbody>
              <tr>
                <th>Von</th>
                <td>{v.from}</td>
              </tr>
              <tr>
                <th>An</th>
                <td>{v.to}</td>
              </tr>
              <tr>
                <th>Betreff</th>
                <td>
                  <b>{v.subject}</b>
                </td>
              </tr>
              <tr>
                <th>Anhang</th>
                <td>{v.attachment}</td>
              </tr>
            </tbody>
          </table>
          <iframe
            title="Vorschau der E-Mail"
            sandbox=""
            srcdoc={v.html}
            style="width:100%;height:760px;border:1px solid var(--line);border-radius:8px;background:#fff;margin-top:10px"
          />
        </section>
      </>,
    );
  });

  app.post('/personal/lohnabrechnungen/auftrag/:id/ausblenden', (c) => {
    dismissSendJob(c.req.param('id'));
    return back(c, `/personal/lohnabrechnungen?monat=${c.req.query('monat') ?? ''}`, {});
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
