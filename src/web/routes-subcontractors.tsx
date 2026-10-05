import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { signSession, verifySession } from '../services/employee-auth.js';
import { BusinessError } from '../services/errors.js';
import { listHandovers } from '../services/handovers.js';
import {
  addPriceChange,
  BILLING,
  complianceOverview,
  compliancePdf,
  createPortalAccess,
  DOC_STATE,
  type DocState,
  docTypes,
  documentFile,
  evaluate,
  FREQUENCY,
  getSubcontract,
  getSubcontractor,
  LEGAL_FORMS,
  listSubcontracts,
  monthOverview,
  OVERALL,
  type Overall,
  portalLogin,
  portalSupplier,
  requestText,
  reviewDocument,
  revokePortal,
  revokeTermination,
  saveSubcontract,
  SC_STATUS,
  SERVICE_KINDS,
  setSubcontractStatus,
  subcontractPdf,
  type SupplierDocument,
  suggestValidUntil,
  terminate,
  TERMINATION_REASONS,
  terminationPdf,
  uploadDocument,
  uploadSignedSubcontract,
} from '../services/subcontractors.js';
import { type AppEnv, type Ctx, officeSecret, UUID } from './app.js';
import { centsToInput, str } from './forms.js';
import { CSS as MOBILE_CSS } from './m/routes-mobile.js';
import { HandoverTable } from './routes-handovers.js';
import { PageHead, Tabs, dateDe, euro, type Tab } from './layout.js';

const STATE_CLASS: Record<DocState, string> = {
  fehlt: 'err',
  abgelaufen: 'err',
  laeuft_ab: 'warn',
  gueltig: 'ok',
  zu_pruefen: 'info',
};
const OVERALL_CLASS: Record<Overall, string> = { kritisch: 'err', warnung: 'warn', ok: 'ok', inaktiv: '' };
const pdfResponse = (pdf: Uint8Array, name: string) =>
  new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, no-cache',
    },
  });
const PORTAL_COOKIE = 'vd_np';

export function registerSubcontractorRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const tabs = (active: string, pending = 0) => (
    <Tabs
      active={active}
      tabs={
        [
          { key: 'nachweise', label: 'Nachweise & Fristen', href: '/nachunternehmer' },
          { key: 'pruefen', label: 'Zu prüfen', href: '/nachunternehmer/pruefen', count: pending },
          { key: 'auftraege', label: 'Aufträge', href: '/nachunternehmer/auftraege' },
          { key: 'monat', label: 'Soll/Ist je Monat', href: '/nachunternehmer/monat' },
        ] as Tab[]
      }
    />
  );
  const pendingCount = async () =>
    Number(
      (
        await sql<
          { n: number }[]
        >`select count(*)::int as n from app.supplier_documents where status = 'zu_pruefen'`
      )[0]!.n,
    );
  const portalUrl = (token: string | null) =>
    token ? `${(env.PUBLIC_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')}/np/${token}` : null;

  // ------------------------------------------------------------------ Übersicht mit Ampel
  app.get('/nachunternehmer', async (c) => {
    const rows = await complianceOverview(sql);
    const n = (o: Overall) => rows.filter((r) => r.overall === o).length;
    return page(
      c,
      'Nachunternehmer',
      'lieferanten',
      <>
        <PageHead title="Nachunternehmer">
          <a class="btn" href={`/lieferanten/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            Nachunternehmer anlegen
          </a>
        </PageHead>
        {tabs('nachweise', await pendingCount())}
        <div class="kpis">
          <div class="kpi">
            <div class="l">Nachweise fehlen</div>
            <div class="v" style="color:var(--err)">
              {n('kritisch')}
            </div>
          </div>
          <div class="kpi">
            <div class="l">läuft in 60 Tagen ab</div>
            <div class="v" style="color:var(--warn)">
              {n('warnung')}
            </div>
          </div>
          <div class="kpi">
            <div class="l">vollständig</div>
            <div class="v" style="color:var(--ok)">
              {n('ok')}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Nachunternehmer</th>
                  <th>Status</th>
                  <th>fehlt / abgelaufen</th>
                  <th>läuft bald ab</th>
                  <th>nächster Ablauf</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr style={r.overall === 'inaktiv' ? 'opacity:.55' : ''}>
                    <td>{r.supplier.supplier_no}</td>
                    <td>
                      <a href={`/lieferanten/${r.supplier.id}/nachweise`}>
                        <b>{r.supplier.name}</b>
                      </a>
                      {r.pending > 0 && (
                        <span class="badge info" style="margin-left:6px">
                          {r.pending} zu prüfen
                        </span>
                      )}
                    </td>
                    <td>
                      <span class={`badge ${OVERALL_CLASS[r.overall]}`}>{OVERALL[r.overall]}</span>
                    </td>
                    <td class="small">{r.overall === 'inaktiv' ? '' : r.missing.join(', ')}</td>
                    <td class="small">{r.overall === 'inaktiv' ? '' : r.expiring.join(', ')}</td>
                    <td>{dateDe(r.nextExpiry)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colspan={6}>
                      <div class="empty">Noch keine Nachunternehmer.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p class="small mut">
            Als Auftraggeber haften wir für Mindestlohn (§ 13 MiLoG, § 14 AEntG) und
            Sozialversicherungsbeiträge (§ 28e Abs. 3a SGB IV) der Beschäftigten des Nachunternehmers. Bei
            „Nachweise fehlen“ werden keine neuen Aufträge erteilt; im Zahlungslauf sind die Rechnungen nicht
            vorausgewählt.
          </p>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Nachweise eines Nachunternehmers
  app.get(`/lieferanten/:id{${UUID}}/nachweise`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontractor(sql, id);
    if (!data || data.supplier.kind !== 'nachunternehmer') return c.redirect(`/lieferanten/${id}`);
    const s = data.supplier;
    const [contracts, handovers] = await Promise.all([
      listSubcontracts(sql, { supplierId: id }),
      listHandovers(sql, { scope: null, supplierId: id }),
    ]);
    const history = (t: string) => data.docs.filter((d) => d.doc_type === t);
    const url = portalUrl(s.portal_token);
    return page(
      c,
      s.name,
      'lieferanten',
      <>
        <PageHead title={s.name} no={s.supplier_no} crumbs={[['Nachunternehmer', '/nachunternehmer']]}>
          <a class="btn sec" href={`/lieferanten/${id}`} style="margin-left:auto">
            Stammdaten
          </a>
          <a class="btn sec" href={`/lieferanten/${id}/nachweise.pdf`} target="_blank">
            Nachweisübersicht (PDF)
          </a>
        </PageHead>
        <p>
          <span class={`badge ${OVERALL_CLASS[data.overall]}`}>{OVERALL[data.overall]}</span>{' '}
          <span class="small mut">
            Rechtsform: {s.legal_form ? LEGAL_FORMS[s.legal_form] : 'nicht angegeben (HR-Auszug optional)'}
          </span>
          {s.terminated_on && (
            <span class="badge err" style="margin-left:6px">
              gekündigt zum {dateDe(s.terminated_on)}
            </span>
          )}
        </p>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nachweis</th>
                  <th>Status</th>
                  <th>gültig bis</th>
                  <th>Datei</th>
                  <th>Neue Version hochladen</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr>
                    <td>
                      <b>{r.type.label}</b> {r.required ? '' : <span class="small mut">(optional)</span>}
                      {r.type.hint && <div class="small mut">{r.type.hint}</div>}
                    </td>
                    <td>
                      <span class={`badge ${r.state === 'fehlt' && !r.required ? '' : STATE_CLASS[r.state]}`}>
                        {DOC_STATE[r.state]}
                      </span>
                      {r.pending && r.current && (
                        <div>
                          <span class="badge info">neue Version zu prüfen</span>
                        </div>
                      )}
                    </td>
                    <td>
                      {r.current?.valid_until ? dateDe(r.current.valid_until) : r.current ? 'einmalig' : '–'}
                      {r.days !== null && r.days >= 0 && r.days <= 60 && (
                        <div class="small" style="color:var(--warn)">
                          noch {r.days} Tage
                        </div>
                      )}
                    </td>
                    <td class="small">
                      {r.current && (
                        <a href={`/nachweise/${r.current.id}/datei`} target="_blank">
                          {r.current.file_name}
                        </a>
                      )}
                      {history(r.type.id).length > 1 && (
                        <details>
                          <summary class="mut">{history(r.type.id).length} Versionen</summary>
                          {history(r.type.id).map((d) => (
                            <div>
                              <a href={`/nachweise/${d.id}/datei`} target="_blank">
                                {dateDe(d.created_at.toISOString().slice(0, 10))}
                              </a>{' '}
                              {d.status === 'abgelehnt'
                                ? `abgelehnt: ${d.reject_reason}`
                                : d.status === 'zu_pruefen'
                                  ? 'zu prüfen'
                                  : `bis ${dateDe(d.valid_until)}`}
                              {d.source === 'portal' ? ' · Portal' : ''}
                            </div>
                          ))}
                        </details>
                      )}
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/lieferanten/${id}/nachweise`}
                        enctype="multipart/form-data"
                        class="actions"
                        style="margin:0;flex-wrap:nowrap"
                      >
                        <input type="hidden" name="id" value={randomUUID()} />
                        <input type="hidden" name="doc_type" value={r.type.id} />
                        <input
                          type="file"
                          name="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          required
                          style="max-width:190px"
                          aria-label="Datei"
                        />
                        {r.type.valid_months > 0 && (
                          <input
                            type="date"
                            name="valid_until"
                            required
                            title={`gültig bis (vom Nachweis; üblich ${r.type.valid_months} Monate, z. B. ${dateDe(suggestValidUntil(r.type))})`}
                            aria-label="gültig bis"
                            style="max-width:150px"
                          />
                        )}
                        <button class="btn sec sm">Hochladen</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="small mut">
            Alte Versionen bleiben erhalten (nie löschen). „gültig bis“ bitte vom Nachweis übernehmen (kein
            Vorschlag, damit kein falsches Datum gespeichert wird).
          </p>
        </div>

        <div class="cols">
          <div class="card">
            <h3 style="margin-top:0">Nachweise anfordern</h3>
            <textarea rows={12} readonly style="font-size:13px" id="req">
              {requestText(s, data.rows, url)}
            </textarea>
            <div class="actions">
              {s.email && (
                <a
                  class="btn sec sm"
                  href={`mailto:${s.email}?subject=${encodeURIComponent('Nachweise für die Zusammenarbeit')}&body=${encodeURIComponent(requestText(s, data.rows, url))}`}
                >
                  Als E-Mail öffnen
                </a>
              )}
              <button
                type="button"
                class="btn sec sm"
                onclick="navigator.clipboard.writeText(document.getElementById('req').value)"
              >
                Kopieren
              </button>
            </div>
          </div>
          <div class="card">
            <h3 style="margin-top:0">Upload-Portal für den Nachunternehmer</h3>
            <p class="small mut" style="margin-top:0">
              Der Nachunternehmer lädt Nachweise selbst hoch (Link + PIN). Das Büro prüft jede Datei, erst
              dann zählt sie.
            </p>
            {url ? (
              <p class="small">
                Link: <code>{url}</code>
              </p>
            ) : (
              <p class="small mut">Kein Zugang eingerichtet.</p>
            )}
            <div class="actions">
              <form
                method="post"
                action={`/lieferanten/${id}/portal`}
                style="margin:0"
                onsubmit="return confirm('Neuen Link und PIN erzeugen? Der alte Zugang gilt dann nicht mehr.')"
              >
                <button class="btn sec sm">{url ? 'Neuen Link + PIN erzeugen' : 'Zugang einrichten'}</button>
              </form>
              {url && (
                <form method="post" action={`/lieferanten/${id}/portal/sperren`} style="margin:0">
                  <button class="btn sec sm">Zugang sperren</button>
                </form>
              )}
            </div>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-top:0">Aufträge</h3>
          <SubcontractTable rows={contracts} />
          <div class="actions">
            <a class="btn sec sm" href={`/nachunternehmer/auftraege/${randomUUID()}?nu=${id}`}>
              Auftrag anlegen
            </a>
          </div>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Übergaben (Schlüssel, Kleidung, Dokumente)</h3>
          <HandoverTable rows={handovers} />
          <div class="actions">
            <a class="btn sec sm" href={`/uebergaben/${randomUUID()}?art=sonstiges&nachunternehmer=${id}`}>
              Übergabe erfassen
            </a>
          </div>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Kündigung</h3>
          {s.terminated_on ? (
            <>
              <p>
                Gekündigt zum <b>{dateDe(s.terminated_on)}</b>: {s.termination_reason}
              </p>
              <div class="actions">
                <a class="btn sec sm" href={`/lieferanten/${id}/kuendigung.pdf`} target="_blank">
                  Kündigungsschreiben (PDF)
                </a>
                <form method="post" action={`/lieferanten/${id}/kuendigung/aufheben`} style="margin:0">
                  <button class="btn sec sm" onclick="return confirm('Kündigung aufheben?')">
                    Kündigung aufheben
                  </button>
                </form>
              </div>
            </>
          ) : (
            <form method="post" action={`/lieferanten/${id}/kuendigung`}>
              <div class="grid">
                <div>
                  <label for="kdate">zum</label>
                  <input id="kdate" type="date" name="date" required />
                </div>
              </div>
              <label>Gründe</label>
              <div class="grid" style="gap:2px 16px">
                {TERMINATION_REASONS.map((r) => (
                  <label class="chk" style="margin:0">
                    <input type="checkbox" name="reason" value={r} /> {r}
                  </label>
                ))}
              </div>
              <label for="knote">Bemerkung</label>
              <input id="knote" name="note" />
              <p class="small mut">
                Laufende Aufträge enden zum Kündigungsdatum, Entwürfe werden storniert. Kündigungsfristen laut
                Vertrag beachten.
              </p>
              <button class="btn sec" onclick="return confirm('Nachunternehmer kündigen?')">
                Kündigen
              </button>
            </form>
          )}
        </div>
      </>,
    );
  });

  app.post(`/lieferanten/:id{${UUID}}/nachweise`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const file = b.file;
    try {
      if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte Datei wählen');
      await uploadDocument(deps, {
        id: str(b, 'id') ?? randomUUID(),
        supplierId: id,
        docType: str(b, 'doc_type') ?? '',
        fileName: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
        validUntil: str(b, 'valid_until'),
        source: 'buero',
        actor: c.get('actor'),
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/lieferanten/${id}/nachweise`, { fehler: e.message });
      throw e;
    }
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Nachweis gespeichert.' });
  });

  app.get(`/nachweise/:id{${UUID}}/datei`, async (c) => {
    const { doc, data } = await documentFile(deps, c.req.param('id'));
    return new Response(data, {
      headers: {
        'Content-Type': doc.content_type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.file_name)}"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.get(`/lieferanten/:id{${UUID}}/nachweise.pdf`, async (c) =>
    pdfResponse(await compliancePdf(sql, c.req.param('id')), 'Nachweisuebersicht.pdf'),
  );

  // ------------------------------------------------------------------ Prüfen (Uploads aus dem Portal)
  app.get('/nachunternehmer/pruefen', async (c) => {
    const rows = await sql<
      (SupplierDocument & { supplier_name: string; label: string; valid_months: number })[]
    >`
      select d.*, s.name as supplier_name, t.label, t.valid_months
        from app.supplier_documents d join app.suppliers s on s.id = d.supplier_id
        join app.supplier_doc_types t on t.id = d.doc_type
       where d.status = 'zu_pruefen' order by d.created_at`;
    return page(
      c,
      'Nachweise prüfen',
      'lieferanten',
      <>
        <PageHead title="Nachunternehmer" />
        {tabs('pruefen', rows.length)}
        {!rows.length && <div class="card empty">Nichts zu prüfen.</div>}
        {rows.map((d) => (
          <form method="post" action={`/nachweise/${d.id}/pruefen`} class="card">
            <p style="margin-top:0">
              <b>{d.supplier_name}</b> · {d.label} ·{' '}
              <a href={`/nachweise/${d.id}/datei`} target="_blank">
                {d.file_name} öffnen
              </a>{' '}
              <span class="small mut">
                hochgeladen {d.created_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
              </span>
            </p>
            <div class="actions" style="margin:0">
              {d.valid_months > 0 && (
                <>
                  <label class="small" for={`v-${d.id}`} style="margin:0">
                    gültig bis (vom Nachweis)
                  </label>
                  <input
                    id={`v-${d.id}`}
                    type="date"
                    name="valid_until"
                    value={d.valid_until ?? ''}
                    style="max-width:160px"
                  />
                </>
              )}
              <button class="btn sm" name="decision" value="ok">
                Gültig
              </button>
              <input name="reason" placeholder="Grund bei Ablehnung" style="max-width:260px" />
              <button class="btn sec sm" name="decision" value="ablehnen">
                Ablehnen
              </button>
            </div>
          </form>
        ))}
      </>,
    );
  });

  app.post(`/nachweise/:id{${UUID}}/pruefen`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    try {
      await reviewDocument(
        sql,
        c.req.param('id'),
        { accept: str(b, 'decision') === 'ok', validUntil: str(b, 'valid_until'), reason: str(b, 'reason') },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/nachunternehmer/pruefen', { fehler: e.message });
      throw e;
    }
    return back(c, '/nachunternehmer/pruefen', { ok: 'Geprüft.' });
  });

  // ------------------------------------------------------------------ Portal-Zugang (Büro)
  app.post(`/lieferanten/:id{${UUID}}/portal`, async (c) => {
    const id = c.req.param('id');
    const { token, pin } = await createPortalAccess(sql, id, c.get('actor'));
    const res = await page(
      c,
      'Portal-Zugang',
      'lieferanten',
      <>
        <PageHead title="Zugang zum Upload-Portal" crumbs={[['Nachweise', `/lieferanten/${id}/nachweise`]]} />
        <div class="card" style="max-width:720px">
          <p>
            Link: <code>{portalUrl(token)}</code>
          </p>
          <p>
            PIN: <b style="font-family:monospace;font-size:20px">{pin}</b>
          </p>
          <p class="small mut">
            Jetzt notieren. Link und PIN bitte auf getrennten Wegen schicken (z. B. Link per E-Mail, PIN per
            Telefon/SMS). Die PIN wird nicht wieder angezeigt; nach 5 Fehlversuchen ist der Zugang 15 Minuten
            gesperrt.
          </p>
          <a class="btn" href={`/lieferanten/${id}/nachweise`}>
            Fertig
          </a>
        </div>
      </>,
    );
    res.headers.set('Cache-Control', 'no-store');
    return res;
  });

  app.post(`/lieferanten/:id{${UUID}}/portal/sperren`, async (c) => {
    const id = c.req.param('id');
    await revokePortal(sql, id, c.get('actor'));
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Zugang gesperrt.' });
  });

  // ------------------------------------------------------------------ Kündigung
  app.post(`/lieferanten/:id{${UUID}}/kuendigung`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    try {
      await terminate(
        sql,
        id,
        {
          date: str(b, 'date') ?? '',
          reasons: ([] as string[]).concat((b.reason as string | string[] | undefined) ?? []),
          note: str(b, 'note'),
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/lieferanten/${id}/nachweise`, { fehler: e.message });
      throw e;
    }
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Kündigung erfasst. Schreiben als PDF unten.' });
  });
  app.post(`/lieferanten/:id{${UUID}}/kuendigung/aufheben`, async (c) => {
    const id = c.req.param('id');
    await revokeTermination(sql, id, c.get('actor'));
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Kündigung aufgehoben (Aufträge bitte prüfen).' });
  });
  app.get(`/lieferanten/:id{${UUID}}/kuendigung.pdf`, async (c) =>
    pdfResponse(await terminationPdf(sql, c.req.param('id')), 'Kuendigung.pdf'),
  );

  // ------------------------------------------------------------------ Aufträge
  app.get('/nachunternehmer/auftraege', async (c) => {
    const rows = await listSubcontracts(sql);
    return page(
      c,
      'Aufträge an Nachunternehmer',
      'lieferanten',
      <>
        <PageHead title="Nachunternehmer">
          <a class="btn" href={`/nachunternehmer/auftraege/${randomUUID()}`} style="margin-left:auto">
            Auftrag anlegen
          </a>
        </PageHead>
        {tabs('auftraege', await pendingCount())}
        <div class="card">
          <SubcontractTable rows={rows} showSupplier />
        </div>
      </>,
    );
  });

  app.get(`/nachunternehmer/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontract(sql, id);
    const sc = data?.contract;
    const [subs, sites] = await Promise.all([
      sql<{ id: string; supplier_no: string; name: string }[]>`
        select id, supplier_no, name from app.suppliers where kind = 'nachunternehmer' and (active or id = ${sc?.supplier_id ?? null}) order by name`,
      sql<
        { id: string; site_no: string; name: string }[]
      >`select id, site_no, name from app.sites where active order by name`,
    ]);
    const draft = !sc || sc.status === 'entwurf';
    return page(
      c,
      sc ? `Auftrag ${sc.number}` : 'Neuer Auftrag',
      'lieferanten',
      <>
        <PageHead
          title={sc ? `Auftrag ${sc.number}` : 'Neuer Auftrag an Nachunternehmer'}
          no={sc ? SC_STATUS[sc.status] : null}
          crumbs={[['Aufträge', '/nachunternehmer/auftraege']]}
        />
        <form
          method="post"
          action={`/nachunternehmer/auftraege/${id}`}
          class="card"
          data-autosave
          data-version={String(sc?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(sc?.version ?? '')} />
          <fieldset disabled={!draft} style="border:0;padding:0;margin:0">
            <div class="grid">
              <div>
                <label for="nu">Nachunternehmer</label>
                <select id="nu" name="supplier_id" required>
                  <option value="">– bitte wählen –</option>
                  {subs.map((s) => (
                    <option value={s.id} selected={s.id === (sc?.supplier_id ?? c.req.query('nu'))}>
                      {s.name} ({s.supplier_no})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="site">Objekt</label>
                <select id="site" name="site_id" required>
                  <option value="">– bitte wählen –</option>
                  {sites.map((s) => (
                    <option value={s.id} selected={s.id === (sc?.site_id ?? c.req.query('objekt'))}>
                      {s.site_no} · {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="kind">Leistung</label>
                <select id="kind" name="service_kind">
                  {SERVICE_KINDS.map((k) => (
                    <option value={k} selected={k === sc?.service_kind}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="freq">Häufigkeit</label>
                <select id="freq" name="frequency">
                  {Object.entries(FREQUENCY).map(([k, v]) => (
                    <option value={k} selected={k === (sc?.frequency ?? 'monatlich')}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="billing">Abrechnung</label>
                <select id="billing" name="billing">
                  {Object.entries(BILLING).map(([k, v]) => (
                    <option value={k} selected={k === sc?.billing}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="price">Preis netto (€)</label>
                <input
                  id="price"
                  name="price"
                  inputmode="decimal"
                  value={sc ? centsToInput(sc.price_cents) : ''}
                  required
                />
              </div>
              <div>
                <label for="maxh">Max. Stunden/Monat (bei Stunden)</label>
                <input
                  id="maxh"
                  name="max_hours"
                  inputmode="decimal"
                  value={sc?.max_hours_month?.replace('.', ',') ?? ''}
                />
              </div>
              <div>
                <label for="from">Beginn</label>
                <input
                  id="from"
                  type="date"
                  name="valid_from"
                  value={sc?.valid_from ?? todayBerlin()}
                  required
                />
              </div>
            </div>
            <label for="desc">Leistungsumfang</label>
            <textarea id="desc" name="description" rows={3}>
              {sc?.description ?? ''}
            </textarea>
          </fieldset>
          <div class="grid">
            <div>
              <label for="to">Ende (optional)</label>
              <input id="to" type="date" name="valid_to" value={sc?.valid_to ?? ''} />
            </div>
            <div>
              <label for="note">Notiz</label>
              <input id="note" name="note" value={sc?.note ?? ''} />
            </div>
          </div>
          <div class="formfoot">
            <a class="btn sec" href="/nachunternehmer/auftraege">
              Zurück
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
        {sc && (
          <div class="card">
            <div class="actions" style="margin-top:0">
              <a class="btn sec" href={`/nachunternehmer/auftraege/${id}/auftrag.pdf`} target="_blank">
                Auftrag (PDF)
              </a>
              {sc.status === 'entwurf' && (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                  <button class="btn" name="status" value="erteilt">
                    Auftrag erteilen
                  </button>
                </form>
              )}
              {sc.status === 'erteilt' && (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                  <button
                    class="btn sec"
                    name="status"
                    value="beendet"
                    onclick="return confirm('Auftrag beenden?')"
                  >
                    Beenden
                  </button>
                </form>
              )}
              {sc.status === 'entwurf' && (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                  <button class="btn sec" name="status" value="storniert">
                    Stornieren
                  </button>
                </form>
              )}
            </div>
            <h3>Unterschriebener Auftrag (Scan)</h3>
            {sc.signed_file_path ? (
              <p>
                <a href={`/nachunternehmer/auftraege/${id}/scan`} target="_blank">
                  Scan öffnen
                </a>{' '}
                <span class="small mut">SHA-256 {sc.signed_file_sha256?.slice(0, 16)}…</span>
              </p>
            ) : (
              <form
                method="post"
                action={`/nachunternehmer/auftraege/${id}/scan`}
                enctype="multipart/form-data"
                class="actions"
              >
                <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required aria-label="Scan" />
                <button class="btn sec sm">Hochladen</button>
              </form>
            )}
            {sc.status === 'erteilt' && (
              <>
                <h3>Preisnachtrag</h3>
                {data!.prices.map((p) => (
                  <div class="small">
                    ab {p.valid_from_month.slice(5, 7)}/{p.valid_from_month.slice(0, 4)}:{' '}
                    {euro(p.price_cents)} – {p.reason}
                  </div>
                ))}
                <form method="post" action={`/nachunternehmer/auftraege/${id}/nachtrag`} class="actions">
                  <input type="hidden" name="id" value={randomUUID()} />
                  <input type="month" name="month" required aria-label="ab Monat" />
                  <input
                    name="price"
                    inputmode="decimal"
                    placeholder="neuer Preis"
                    required
                    style="max-width:140px"
                  />
                  <input
                    name="reason"
                    placeholder="Grund, z. B. Tariflohnerhöhung"
                    required
                    style="max-width:280px"
                  />
                  <button class="btn sec sm">Nachtrag speichern</button>
                </form>
              </>
            )}
          </div>
        )}
      </>,
    );
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const cur = await getSubcontract(sql, id);
    const v = str(b, 'version');
    try {
      const sc = cur?.contract;
      await saveSubcontract(
        sql,
        id,
        {
          supplierId: str(b, 'supplier_id') ?? sc?.supplier_id ?? '',
          siteId: str(b, 'site_id') ?? sc?.site_id ?? '',
          serviceKind: str(b, 'service_kind') ?? sc?.service_kind ?? '',
          frequency: str(b, 'frequency') ?? sc?.frequency ?? '',
          billing: str(b, 'billing') ?? sc?.billing ?? '',
          priceCents: str(b, 'price') ? parseEuro(str(b, 'price')!) : (sc?.price_cents ?? 0n),
          maxHours: str(b, 'max_hours'),
          validFrom: str(b, 'valid_from') ?? sc?.valid_from ?? '',
          validTo: str(b, 'valid_to'),
          description: str(b, 'description'),
          note: str(b, 'note'),
          version: v ? Number(v) : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Gespeichert.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const st = String(b.status ?? '');
    try {
      if (st !== 'erteilt' && st !== 'beendet' && st !== 'storniert')
        throw new BusinessError('Unbekannter Status');
      await setSubcontractStatus(sql, id, st, c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: `Auftrag ${SC_STATUS[st]}.` });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/nachtrag`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    try {
      await addPriceChange(
        sql,
        {
          id: str(b, 'id') ?? randomUUID(),
          subcontractId: id,
          month: str(b, 'month') ?? '',
          priceCents: parseEuro(str(b, 'price') ?? ''),
          reason: str(b, 'reason') ?? '',
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Nachtrag gespeichert.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/scan`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      const f = b.file;
      if (!(f instanceof File) || !f.size) throw new BusinessError('Bitte Datei wählen');
      await uploadSignedSubcontract(deps, id, new Uint8Array(await f.arrayBuffer()), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Scan gespeichert.' });
  });
  app.get(`/nachunternehmer/auftraege/:id{${UUID}}/scan`, async (c) => {
    const data = await getSubcontract(sql, c.req.param('id'));
    if (!data?.contract.signed_file_path) return c.notFound();
    const bytes = await deps.archive.get(data.contract.signed_file_path);
    const pdf = data.contract.signed_file_path.endsWith('.pdf');
    return new Response(bytes, {
      headers: {
        'Content-Type': pdf
          ? 'application/pdf'
          : data.contract.signed_file_path.endsWith('.png')
            ? 'image/png'
            : 'image/jpeg',
        'Cache-Control': 'private, no-cache',
      },
    });
  });
  app.get(`/nachunternehmer/auftraege/:id{${UUID}}/auftrag.pdf`, async (c) =>
    pdfResponse(await subcontractPdf(sql, c.req.param('id')), 'Auftrag.pdf'),
  );

  // ------------------------------------------------------------------ Soll/Ist je Monat
  app.get('/nachunternehmer/monat', async (c) => {
    const q = c.req.query('monat');
    const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayBerlin().slice(0, 7);
    const rows = await monthOverview(sql, month);
    const label: Record<string, [string, string]> = {
      fehlt: ['Rechnung fehlt', 'warn'],
      ok: ['passt', 'ok'],
      abweichung: ['Abweichung', 'err'],
      ueber: ['über Obergrenze', 'err'],
      erfasst: ['erfasst (nach Aufwand)', 'info'],
    };
    return page(
      c,
      'Soll/Ist Nachunternehmer',
      'lieferanten',
      <>
        <PageHead title="Nachunternehmer" />
        {tabs('monat', await pendingCount())}
        <form method="get" class="actions">
          <input type="month" name="monat" value={month} onchange="this.form.submit()" aria-label="Monat" />
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Auftrag</th>
                  <th>Nachunternehmer</th>
                  <th>Objekt / Leistung</th>
                  <th class="r">Soll</th>
                  <th class="r">Ist (Rechnungen netto)</th>
                  <th class="r">Differenz</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      <a href={`/nachunternehmer/auftraege/${r.id}`}>{r.number}</a>
                    </td>
                    <td>{r.supplier_name}</td>
                    <td class="small">
                      {r.site_name} – {r.service_kind}
                    </td>
                    <td class="r">{r.soll !== null ? euro(r.soll) : 'nach Aufwand'}</td>
                    <td class="r">
                      {r.ist_cents !== null ? euro(r.ist_cents) : '–'}
                      {r.invoices && <div class="small mut">{r.invoices}</div>}
                    </td>
                    <td class="r">{r.diff !== null ? euro(r.diff) : ''}</td>
                    <td>
                      <span class={`badge ${label[r.state]![1]}`}>{label[r.state]![0]}</span>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colspan={7}>
                      <div class="empty">Keine laufenden Aufträge in diesem Monat.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p class="small mut">
            Ist = Eingangsrechnungen mit Leistungsmonat, zugeordnet über den Auftrag oder Nachunternehmer +
            Objekt.
          </p>
        </div>
      </>,
    );
  });

  // ================================================================== Upload-Portal (öffentlich, Link + PIN)
  const portalSecret = (token: string) => `${officeSecret(env)}:np:${token}`;
  const portalPage = (
    title: string,
    flash: { ok?: string | undefined; err?: string | undefined },
    body: unknown,
  ) =>
    `<!doctype html>${(
      <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>{`${title} · Viva-Deluxe`}</title>
          <style dangerouslySetInnerHTML={{ __html: MOBILE_CSS }} />
        </head>
        <body>
          <header>
            <img src="/static/logo.png" alt="Viva-Deluxe" width="149" height="30" />
            <span class="sp" />
          </header>
          <main>
            {flash.ok && <div class="flash ok">{flash.ok}</div>}
            {flash.err && <div class="flash err">{flash.err}</div>}
            {body}
          </main>
        </body>
      </html>
    ).toString()}`;
  const portalHtml = (c: Context<AppEnv>, html: string, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(html, status);
  };

  app.get('/np/:token', async (c) => {
    const token = c.req.param('token');
    const s = await portalSupplier(sql, token);
    const flash = { ok: c.req.query('ok'), err: c.req.query('fehler') };
    if (!s)
      return portalHtml(
        c,
        portalPage('Portal', {}, <div class="card">Link ungültig oder abgelaufen.</div>),
        404,
      );
    const sid = verifySession(portalSecret(token), getCookie(c, PORTAL_COOKIE));
    if (sid !== s.id) {
      return portalHtml(
        c,
        portalPage(
          'Anmeldung',
          flash,
          <form method="post" action={`/np/${token}/anmelden`} class="card">
            <h1 style="margin-top:0">Nachweise hochladen</h1>
            <p>{s.name}</p>
            <label for="pin">PIN</label>
            <input id="pin" name="pin" inputmode="numeric" autocomplete="one-time-code" required />
            <button class="big">Weiter</button>
          </form>,
        ),
      );
    }
    const [types, docs] = await Promise.all([
      docTypes(sql),
      sql<SupplierDocument[]>`select * from app.supplier_documents where supplier_id = ${s.id}`,
    ]);
    const ev = evaluate(s, types, docs);
    return portalHtml(
      c,
      portalPage(
        'Nachweise',
        flash,
        <>
          <h1>{s.name}</h1>
          <p class="mut">
            Bitte laden Sie die markierten Nachweise als PDF oder Foto hoch (max. 10 MB). Wir prüfen jede
            Datei; bis dahin steht sie auf „in Prüfung“.
          </p>
          {ev.rows.map((r) => (
            <form method="post" action={`/np/${token}/upload`} enctype="multipart/form-data" class="card">
              <b>{r.type.label}</b> {r.required ? '' : <span class="mut">(falls zutreffend)</span>}
              <div class="mut" style="margin:4px 0 8px">
                {r.pending
                  ? 'in Prüfung'
                  : r.state === 'gueltig'
                    ? `vorhanden${r.current?.valid_until ? `, gültig bis ${dateDe(r.current.valid_until)}` : ''}`
                    : r.state === 'laeuft_ab'
                      ? `läuft ab am ${dateDe(r.current?.valid_until)} – bitte erneuern`
                      : r.state === 'abgelaufen'
                        ? 'abgelaufen – bitte erneuern'
                        : 'fehlt'}
              </div>
              <input type="hidden" name="id" value={randomUUID()} />
              <input type="hidden" name="doc_type" value={r.type.id} />
              <input
                type="file"
                name="file"
                accept=".pdf,.jpg,.jpeg,.png,image/*"
                required
                aria-label="Datei"
              />
              {r.type.valid_months > 0 && (
                <>
                  <label>gültig bis (laut Nachweis)</label>
                  <input type="date" name="valid_until" />
                </>
              )}
              <button class="big">Hochladen</button>
            </form>
          ))}
        </>,
      ),
    );
  });

  app.post('/np/:token/anmelden', async (c) => {
    const token = c.req.param('token');
    const b = await c.req.parseBody();
    try {
      const id = await portalLogin(sql, token, String(b.pin ?? ''));
      setCookie(c, PORTAL_COOKIE, signSession(portalSecret(token), id, Date.now(), 2 / 24), {
        path: `/np/${token}`,
        httpOnly: true,
        sameSite: 'Strict',
        secure: env.APP_ENV !== 'dev',
      });
      return c.redirect(`/np/${token}`, 303);
    } catch (e) {
      if (e instanceof BusinessError)
        return c.redirect(`/np/${token}?fehler=${encodeURIComponent(e.message)}`, 303);
      throw e;
    }
  });

  app.post('/np/:token/upload', async (c) => {
    const token = c.req.param('token');
    const s = await portalSupplier(sql, token);
    if (!s || verifySession(portalSecret(token), getCookie(c, PORTAL_COOKIE)) !== s.id)
      return c.redirect(`/np/${token}`, 303);
    const b = await c.req.parseBody({ all: true });
    try {
      const f = b.file;
      if (!(f instanceof File) || !f.size) throw new BusinessError('Bitte Datei wählen');
      await uploadDocument(deps, {
        id: str(b, 'id') ?? randomUUID(),
        supplierId: s.id,
        docType: str(b, 'doc_type') ?? '',
        fileName: f.name,
        data: new Uint8Array(await f.arrayBuffer()),
        validUntil: str(b, 'valid_until'),
        source: 'portal',
        actor: `portal:${s.supplier_no}`,
      });
    } catch (e) {
      if (e instanceof BusinessError)
        return c.redirect(`/np/${token}?fehler=${encodeURIComponent(e.message)}`, 303);
      throw e;
    }
    return c.redirect(`/np/${token}?ok=${encodeURIComponent('Danke – die Datei wird geprüft.')}`, 303);
  });
}

function SubcontractTable({
  rows,
  showSupplier = false,
}: {
  rows: Awaited<ReturnType<typeof listSubcontracts>>;
  showSupplier?: boolean;
}) {
  return (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Nr.</th>
            {showSupplier && <th>Nachunternehmer</th>}
            <th>Objekt</th>
            <th>Leistung</th>
            <th class="r">Preis aktuell</th>
            <th>Zeitraum</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>
                <a href={`/nachunternehmer/auftraege/${r.id}`} style="white-space:nowrap">
                  {r.number}
                </a>
              </td>
              {showSupplier && <td>{r.supplier_name}</td>}
              <td class="small">
                {r.site_name} ({r.site_no})
              </td>
              <td class="small">
                {r.service_kind} · {FREQUENCY[r.frequency]}
              </td>
              <td class="r">
                {euro(r.current_price_cents)} <span class="small mut">{BILLING[r.billing]}</span>
              </td>
              <td class="small">
                {dateDe(r.valid_from)} – {r.valid_to ? dateDe(r.valid_to) : 'offen'}
              </td>
              <td>
                <span class={`badge ${r.status === 'erteilt' ? 'ok' : r.status === 'entwurf' ? 'warn' : ''}`}>
                  {SC_STATUS[r.status]}
                </span>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colspan={7}>
                <div class="empty">Keine Aufträge.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
