import { randomUUID } from 'node:crypto';
import { listEmployees } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import {
  FORBIDDEN_HINT,
  SIGN_CATEGORY,
  type SignCategory,
  addRecipients,
  createSignDocument,
  getSignDocument,
  listSignDocuments,
  originalPdf,
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
    const [docs, emps] = await Promise.all([listSignDocuments(sql), listEmployees(sql, { status: 'aktiv' })]);
    return page(
      c,
      'Dokumente unterschreiben',
      'personal',
      <>
        <PageHead title="Unterweisungen & Unterschriften" crumbs={[['Personal', '/personal']]} />
        <p class="mut" style="max-width:900px;margin-top:0">
          Unterweisung oder Dokument (PDF) an alle oder ausgewählte Mitarbeitende freigeben. Beim nächsten
          Öffnen der Handy-App erscheint es sofort zum Lesen und Unterschreiben; mit „Später erinnern“ kommt
          es am nächsten Tag wieder, bis unterschrieben ist. Nach Ablauf der Frist steht es als Hinweis auf
          der Startseite.
        </p>
        <div class="flash err" style="max-width:900px">
          <b>Nicht digital:</b> {FORBIDDEN_HINT}
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Dokument</th>
                <th>Art</th>
                <th>Frist</th>
                <th class="right">Unterschrieben</th>
                <th>angelegt</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr>
                  <td>
                    <a href={`/personal/dokumente/${d.id}`}>{d.title}</a>
                  </td>
                  <td class="small">{SIGN_CATEGORY[d.category]}</td>
                  <td>{dateDe(d.due_date)}</td>
                  <td class="right">
                    <span class={`badge ${d.open ? 'warn' : 'ok'}`}>
                      {d.signed} / {d.total}
                    </span>
                  </td>
                  <td class="small mut">{berlin(d.created_at)}</td>
                </tr>
              ))}
              {!docs.length && (
                <tr>
                  <td colspan={5} class="mut">
                    Noch keine Dokumente verteilt.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form
          method="post"
          action={`/personal/dokumente/${randomUUID()}`}
          enctype="multipart/form-data"
          class="card"
          style="max-width:900px"
          id="neu"
        >
          <h3 style="margin-top:0">Unterweisung / Dokument freigeben</h3>
          <div class="grid">
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
              <label for="file">PDF (max. 20 MB)</label>
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
              onchange="document.querySelectorAll('input[name=employee]').forEach(function(x){x.checked=this.checked}.bind(this))"
            />
            <label for="all">alle aktiven Mitarbeitenden ({emps.length})</label>
          </div>
          <div class="grid" style="gap:4px 16px;max-height:260px;overflow:auto">
            {emps.map((e) => (
              <label class="chk" style="margin:0">
                <input type="checkbox" name="employee" value={e.id} />
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
    if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte PDF auswählen');
    await createSignDocument(
      deps,
      id,
      {
        title: str(b, 'title') ?? '',
        category: (str(b, 'category') ?? '') as SignCategory,
        description: str(b, 'description'),
        dueDate: str(b, 'due_date'),
        fileName: file.name || 'dokument.pdf',
        pdf: new Uint8Array(await file.arrayBuffer()),
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
