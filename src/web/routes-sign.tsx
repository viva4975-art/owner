import { randomUUID } from 'node:crypto';
import { listEmployees } from '../services/employees.js';
import { wordTemplatePdf } from '../services/word-templates.js';
import { BusinessError } from '../services/errors.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  FORBIDDEN_HINT,
  SIGN_CATEGORY,
  type SignCategory,
  addRecipients,
  createSignDocument,
  deleteSignDocument,
  purgeSignDocument,
  getSignDocument,
  listSignDocuments,
  originalPdf,
  reopenSignDocument,
  signedPdf,
  withdrawRequest,
} from '../services/sign-documents.js';
import { type Ctx, UUID } from './app.js';
import { arr, str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, dateDe } from './layout.js';

const STATUS: Record<string, [string, string]> = {
  offen: ['offen', 'warn'],
  unterschrieben: ['unterschrieben', 'ok'],
  zurueckgezogen: ['zurückgezogen', ''],
};
const berlin = (d: Date) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
const pdfResponse = (pdf: Uint8Array, name: string) =>
  new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name.replace(/[^\w.-]+/g, '_')}"`,
      'Cache-Control': 'private, no-cache',
    },
  });

/** Büro/Personal: Dokumente zur digitalen Unterschrift verteilen und Nachweise abrufen. */
export function registerSignRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/personal/dokumente', async (c) => {
    const admin = c.get('user').role === 'admin';
    const archiv = c.req.query('ansicht') === 'archiv';
    const [docs, emps, tpls] = await Promise.all([
      listSignDocuments(sql),
      listEmployees(sql, { status: 'aktiv' }),
      sql<{ id: string; name: string; code: string | null; category: string }[]>`
        select id, name, code, category from app.word_templates where active and audience = 'mitarbeiter'
         order by (category ilike '%unterweis%' or name ilike '%unterweis%' or name ilike '%belehr%') desc, name`,
    ]);
    const active = docs.filter((d) => !d.archived_at);
    const ended = docs.filter((d) => d.archived_at);
    const shown = archiv ? ended : active;
    return page(
      c,
      'Dokumente unterschreiben',
      'personal',
      <>
        <PageHead title="Unterweisungen & Unterschriften" crumbs={[['Personal', '/personal']]}>
          <a class="btn" href="#neu">
            + Unterweisung freigeben
          </a>
        </PageHead>
        <div class="chips" style="margin-bottom:10px">
          <a class={archiv ? '' : 'on'} href="/personal/dokumente">
            Aktiv<span class="n">{active.length}</span>
          </a>
          <a class={archiv ? 'on' : ''} href="/personal/dokumente?ansicht=archiv">
            Beendet<span class="n">{ended.length}</span>
          </a>
        </div>
        <div class="card" style="padding:0">
          {shown.map((d) => {
            const pct = d.total ? Math.round((d.signed / d.total) * 100) : 0;
            const overdue = !!d.due_date && d.due_date < todayBerlin() && d.open > 0;
            return (
              <div class="sd-row">
                <div class="sd-main">
                  <a href={`/personal/dokumente/${d.id}`}>
                    <b>{d.title}</b>
                  </a>
                  <div class="small mut">
                    {SIGN_CATEGORY[d.category]} · freigegeben {berlin(d.created_at)}
                    {d.archived_at && ` · beendet ${berlin(d.archived_at)}`}
                  </div>
                </div>
                <div class="sd-due small">
                  {d.due_date ? (
                    <span style={overdue ? 'color:var(--err);font-weight:600' : ''}>
                      bis {dateDe(d.due_date)}
                      {overdue && ' – überfällig'}
                    </span>
                  ) : (
                    <span class="mut">ohne Frist</span>
                  )}
                </div>
                <div class="sd-prog">
                  <div class="sd-bar">
                    <i style={`width:${pct}%`} />
                  </div>
                  <span class="small">
                    <b>{d.signed}</b> von {d.total} unterschrieben
                    {d.open > 0 && <span class="mut"> · {d.open} offen</span>}
                  </span>
                </div>
                <div class="sd-act">
                  <a class="btn sec sm" href={`/personal/dokumente/${d.id}`}>
                    Öffnen
                  </a>
                  {d.archived_at ? (
                    <form method="post" action={`/personal/dokumente/${d.id}/wieder`} style="margin:0">
                      <button class="btn sec sm">Wieder aktiv</button>
                    </form>
                  ) : (
                    <form
                      method="post"
                      action={`/personal/dokumente/${d.id}/loeschen`}
                      style="margin:0"
                      onsubmit={
                        d.signed > 0
                          ? "return confirm('Bereits unterschrieben – die Unterweisung wird beendet (offene Anforderungen zurückgezogen), die Nachweise bleiben erhalten. Fortfahren?')"
                          : "return confirm('Unterweisung ganz löschen? Noch niemand hat unterschrieben.')"
                      }
                    >
                      <button class="btn sec sm danger">{d.signed > 0 ? 'Beenden' : 'Löschen'}</button>
                    </form>
                  )}
                  {d.signed > 0 && admin && (
                    <form
                      method="post"
                      action={`/personal/dokumente/${d.id}/endgueltig`}
                      style="margin:0"
                      onsubmit="return confirm('Endgültig löschen – auch mit den Unterschriften? Nur für Tests! Echte Unterweisungen sind der Nachweis nach § 12 ArbSchG und sollten nur beendet werden.')"
                    >
                      <button class="ic-btn" title="Endgültig löschen (Test)" aria-label="Endgültig löschen">
                        <Icon name="trash" size={15} />
                      </button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
          {!shown.length && (
            <div class="empty">
              {archiv ? 'Keine beendeten Unterweisungen.' : 'Noch keine Unterweisungen freigegeben.'}
            </div>
          )}
        </div>
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.sd-row{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(0,.9fr) minmax(0,1.4fr) auto;gap:14px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}' +
              '.sd-row:last-child{border-bottom:0}.sd-bar{height:8px;background:var(--line);border-radius:6px;overflow:hidden;margin-bottom:4px}' +
              '.sd-bar i{display:block;height:100%;background:var(--ok)}.sd-act{display:flex;gap:6px}' +
              '@media(max-width:760px){.sd-row{grid-template-columns:1fr}}',
          }}
        />
        <form
          method="post"
          action={`/personal/dokumente/${randomUUID()}`}
          enctype="multipart/form-data"
          class="card"
          style="max-width:900px"
          id="neu"
          onsubmit="var n=this.querySelectorAll('input[name=employee]:checked').length;if(!n){alert('Bitte Empfänger auswählen.');return false}return confirm('Dokument an '+n+' Mitarbeitende freigeben? Es erscheint sofort beim Öffnen ihrer Handy-App.')"
        >
          <h3 style="margin-top:0">Neue Unterweisung / Dokument freigeben</h3>
          <p class="small mut" style="margin-top:0">
            Beim nächsten Öffnen der Handy-App erscheint das Dokument sofort zum Lesen und Unterschreiben; mit
            „Später erinnern“ kommt es am nächsten Tag wieder. Nach Ablauf der Frist Hinweis auf der
            Startseite. <b>Nicht digital:</b> {FORBIDDEN_HINT}
          </p>
          <div class="grid">
            <div style="grid-column:1/-1">
              <label for="word_template">Eigene Vorlage (Einstellungen → Word-Vorlagen)</label>
              <select
                id="word_template"
                name="word_template"
                onchange="var t=document.getElementById('title');if(this.value&&!t.value)t.value=this.options[this.selectedIndex].dataset.name;document.getElementById('file').required=!this.value"
              >
                <option value="">– keine, PDF hochladen –</option>
                {tpls.map((t) => (
                  <option value={t.id} data-name={t.name}>
                    {t.name}
                    {t.code ? ` (${t.code})` : ''} · {t.category}
                  </option>
                ))}
              </select>
              {!tpls.length && (
                <div class="small mut">
                  Noch keine Mitarbeiter-Vorlagen hochgeladen – unter Einstellungen → Word-Vorlagen die ZIP
                  hochladen.
                </div>
              )}
            </div>
            <div>
              <label for="title">Titel</label>
              <input id="title" name="title" required placeholder="z. B. Unterweisung Arbeitsschutz 2026" />
            </div>
            <div>
              <label for="category">Art</label>
              <select id="category" name="category" required>
                {Object.entries(SIGN_CATEGORY).map(([k, v]) => (
                  <option value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label for="due_date">Unterschreiben bis</label>
              <input id="due_date" name="due_date" type="date" />
            </div>
            <div>
              <label for="file">oder eigenes PDF (max. 20 MB)</label>
              <input id="file" name="file" type="file" accept="application/pdf,.pdf" required />
            </div>
          </div>
          <label for="description">Hinweis für die Mitarbeitenden</label>
          <input
            id="description"
            name="description"
            placeholder="z. B. Bitte bis Monatsende lesen und unterschreiben"
          />
          <label>Empfänger</label>
          <div class="chk" style="margin:4px 0 8px">
            <input
              type="checkbox"
              id="all"
              checked={c.req.query('alle') === '1'}
              onchange="document.querySelectorAll('input[name=employee]').forEach(function(x){x.checked=this.checked}.bind(this))"
            />
            <label for="all">alle aktiven Mitarbeitenden ({emps.length})</label>
          </div>
          <input
            type="search"
            placeholder="Mitarbeiter suchen (Name oder Personalnummer)"
            data-filter-list=".sign-emps label"
            style="max-width:360px;margin-bottom:6px"
          />
          <div class="grid sign-emps" style="gap:4px 16px;max-height:300px;overflow:auto">
            {emps.map((e) => (
              <label class="chk" style="margin:0">
                <input type="checkbox" name="employee" value={e.id} checked={c.req.query('alle') === '1'} />
                {e.last_name}, {e.first_name} <span class="mut small">{e.personnel_no}</span>
              </label>
            ))}
          </div>
          <p class="small mut">
            Die Mitarbeitenden sehen das Dokument in ihrer Handy-Ansicht, bestätigen „gelesen und verstanden“
            und unterschreiben mit dem Finger. Nachweis: PDF mit Nachweisblatt (Zeitpunkt, Gerät, Prüfsumme)
            im Archiv.
          </p>
          <div class="formfoot">
            <button class="btn">Freigeben</button>
          </div>
        </form>
      </>,
    );
  });

  app.post(`/personal/dokumente/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const file = Array.isArray(b.file) ? b.file[0] : b.file;
    const tplId = str(b, 'word_template');
    let pdf: Uint8Array;
    let fileName: string;
    if (file instanceof File && file.size) {
      pdf = new Uint8Array(await file.arrayBuffer());
      fileName = file.name || 'dokument.pdf';
    } else if (tplId && /^[0-9a-f-]{36}$/.test(tplId)) {
      const t = await wordTemplatePdf(
        sql,
        { dir: deps.env.FILES_DIR, maxBytes: deps.env.UPLOAD_MAX_BYTES },
        tplId,
      );
      pdf = t.pdf;
      fileName = `${t.title.replace(/[^\p{L}\p{N}]+/gu, '-')}.pdf`;
    } else throw new BusinessError('Bitte eigene Vorlage wählen oder PDF hochladen');
    await createSignDocument(
      deps,
      id,
      {
        title: str(b, 'title') ?? '',
        category: (str(b, 'category') ?? '') as SignCategory,
        description: str(b, 'description'),
        dueDate: str(b, 'due_date'),
        fileName,
        pdf,
        employeeIds: arr(b, 'employee').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
      },
      c.get('actor'),
    );
    return back(c, `/personal/dokumente/${id}`, { ok: 'Dokument verteilt.' });
  });

  app.get(`/personal/dokumente/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getSignDocument(sql, id);
    if (!data) return c.notFound();
    const { doc, requests } = data;
    const have = new Set(requests.map((r) => r.employee_id));
    const others = (await listEmployees(sql, { status: 'aktiv' })).filter((e) => !have.has(e.id));
    return page(
      c,
      doc.title,
      'personal',
      <>
        <PageHead
          title={doc.title}
          no={SIGN_CATEGORY[doc.category]}
          crumbs={[['Dokumente unterschreiben', '/personal/dokumente']]}
        />
        <div class="actions" style="margin-top:-8px">
          <a class="btn sec" href={`/personal/dokumente/${id}/original.pdf`} target="_blank">
            <Icon name="pdf" /> Original ({doc.page_count} S.)
          </a>
          <span class="small mut" style="word-break:break-all">
            SHA-256 {doc.file_sha256}
          </span>
        </div>
        <div class="cols">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter/in</th>
                  <th>Status</th>
                  <th>unterschrieben</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr>
                    <td>
                      {r.employee_name} <span class="mut small">{r.personnel_no}</span>
                    </td>
                    <td>
                      <span class={`badge ${STATUS[r.status]![1]}`}>{STATUS[r.status]![0]}</span>
                    </td>
                    <td class="small">{r.signed_at ? berlin(r.signed_at) : ''}</td>
                    <td>
                      {r.signed_pdf_path && (
                        <a href={`/personal/dokumente/nachweis/${r.id}/nachweis.pdf`} target="_blank">
                          Nachweis-PDF
                        </a>
                      )}
                      {r.status === 'offen' && (
                        <form
                          method="post"
                          action={`/personal/dokumente/anforderung/${r.id}/zurueckziehen`}
                          onsubmit="return confirm('Anforderung zurückziehen?')"
                          style="display:inline"
                        >
                          <button class="btn sm ghost">zurückziehen</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {others.length > 0 && (
            <form method="post" action={`/personal/dokumente/${id}/empfaenger`} class="card">
              <h3 style="margin-top:0">Weitere Empfänger</h3>
              <div style="max-height:320px;overflow:auto">
                {others.map((e) => (
                  <label class="chk" style="margin:0 0 4px">
                    <input type="checkbox" name="employee" value={e.id} />
                    {e.last_name}, {e.first_name}
                  </label>
                ))}
              </div>
              <div class="formfoot">
                <button class="btn sec">Hinzufügen</button>
              </div>
            </form>
          )}
        </div>
      </>,
    );
  });

  app.post(`/personal/dokumente/:id{${UUID}}/loeschen`, async (c) => {
    const r = await deleteSignDocument(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/personal/dokumente', {
      ok:
        r === 'geloescht'
          ? 'Unterweisung gelöscht.'
          : 'Unterweisung beendet – offene Anforderungen zurückgezogen, unterschriebene Nachweise bleiben (Reiter „Beendet“).',
    });
  });

  app.post(`/personal/dokumente/:id{${UUID}}/endgueltig`, async (c) => {
    if (c.get('user').role !== 'admin') throw new BusinessError('Endgültig löschen darf nur ein Admin');
    await purgeSignDocument(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/personal/dokumente', { ok: 'Unterweisung mit allen Unterschriften gelöscht.' });
  });

  app.post(`/personal/dokumente/:id{${UUID}}/wieder`, async (c) => {
    await reopenSignDocument(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/personal/dokumente', {
      ok: 'Wieder aktiv. Zurückgezogene Empfänger bei Bedarf unter „Öffnen“ neu hinzufügen.',
    });
  });

  app.post(`/personal/dokumente/:id{${UUID}}/empfaenger`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const n = await addRecipients(
      sql,
      id,
      arr(b, 'employee').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
      c.get('actor'),
    );
    return back(c, `/personal/dokumente/${id}`, { ok: `${n} Empfänger hinzugefügt.` });
  });

  app.post(`/personal/dokumente/anforderung/:rid{${UUID}}/zurueckziehen`, async (c) => {
    const rid = c.req.param('rid');
    const [r] = await sql<
      { document_id: string }[]
    >`select document_id from app.sign_requests where id = ${rid}`;
    if (!r) return c.notFound();
    await withdrawRequest(sql, rid, c.get('actor'));
    return back(c, `/personal/dokumente/${r.document_id}`, { ok: 'Zurückgezogen.' });
  });

  app.get(`/personal/dokumente/:id{${UUID}}/original.pdf`, async (c) => {
    const data = await getSignDocument(sql, c.req.param('id'));
    if (!data) return c.notFound();
    return pdfResponse(await originalPdf(deps, data.doc.id), data.doc.file_name);
  });

  app.get(`/personal/dokumente/nachweis/:rid{${UUID}}/nachweis.pdf`, async (c) => {
    const rid = c.req.param('rid');
    return pdfResponse(await signedPdf(deps, rid), `Nachweis_${rid.slice(0, 8)}.pdf`);
  });
}
