import { PDFDocument } from '@cantoo/pdf-lib';
import type { Context } from 'hono';
import { KIND_TITLES } from '../domain/invoice/types.js';
import type { AppEnv, Ctx } from './app.js';
import { listDunnings, markDunningSent, sendDunning } from '../services/dunning.js';
import { BusinessError } from '../services/errors.js';
import { effectiveBilling } from '../services/masterdata.js';
import {
  MANUAL_WAYS,
  deliveryChannel,
  ensureDocuments,
  recordManualDelivery,
  recordPortalUpload,
  sendInvoice,
} from '../services/workflow.js';
import { PageHead, dateDe, euro, anz } from './layout.js';

/*
 * „Noch nicht versendete Dokumente“ wie Fortytools (Ahmed 09.10.): Reiter Rechnungen / Rechnungskorrekturen /
 * Mahnungen / Versandverlauf. Versandart wählen (E-Mail oder „als bereits versendet kennzeichnen“), Dokumente
 * ankreuzen, „Los“. Jedes Dokument wird einzeln behandelt (genau einmal, Fehler halten die anderen nicht auf).
 */

type Tab = 'rechnungen' | 'korrekturen' | 'mahnungen';
const TABS: [Tab | 'verlauf', string][] = [
  ['rechnungen', 'Rechnungen'],
  ['korrekturen', 'Rechnungskorrekturen'],
  ['mahnungen', 'Mahnungen'],
  ['verlauf', 'Versandverlauf'],
];

interface Row {
  id: string;
  date: string;
  number: string;
  title: string;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  pos: number;
  net: bigint | null;
  gross: bigint;
  recipients: string[];
  /** Hinweis statt E-Mail (Portal, keine E-Mail) */
  note: string | null;
  href: string;
}

export function registerVersandRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  async function invoiceRows(tab: 'rechnungen' | 'korrekturen'): Promise<Row[]> {
    const kinds = tab === 'rechnungen' ? ['invoice', 'partial', 'final'] : ['cancellation', 'correction'];
    const list = await sql<
      {
        id: string;
        number: string;
        kind: keyof typeof KIND_TITLES;
        issue_date: string;
        net_cents: bigint;
        gross_cents: bigint;
        customer_id: string;
        site_id: string | null;
        invoice_group_id: string | null;
        name: string;
        customer_no: string;
        pos: number;
      }[]
    >`
      select i.id, i.number, i.kind, i.issue_date::text, i.net_cents, i.gross_cents, i.customer_id, i.site_id,
             i.invoice_group_id, c.name, c.customer_no,
             (select count(*)::int from app.invoice_lines l where l.invoice_id = i.id) as pos
        from app.invoices i join app.customers c on c.id = i.customer_id
       where i.status = 'issued' and i.kind in ${sql(kinds)}
         and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')
       order by i.issue_date desc, i.number desc`;
    return Promise.all(
      list.map(async (i) => {
        const [billing, ch] = await Promise.all([
          effectiveBilling(sql, i.customer_id, i.site_id, i.invoice_group_id),
          deliveryChannel(sql, i.id),
        ]);
        return {
          id: i.id,
          date: i.issue_date,
          number: i.number,
          title: KIND_TITLES[i.kind],
          customer_id: i.customer_id,
          customer_name: i.name,
          customer_no: i.customer_no,
          pos: i.pos,
          net: i.net_cents,
          gross: i.gross_cents,
          recipients: billing.emails,
          note:
            ch.channel === 'portal'
              ? `Portal: ${ch.portal ?? 'Portal des Kunden'}`
              : billing.emails.length
                ? null
                : 'keine Rechnungs-E-Mail',
          href: `/rechnungen/${i.id}`,
        };
      }),
    );
  }

  async function dunningRows(): Promise<Row[]> {
    const list = (await listDunnings(sql)).filter((d) => d.status === 'erstellt');
    return Promise.all(
      list.map(async (d) => {
        const [c] = await sql<{ invoice_emails: string[] }[]>`
          select invoice_emails from app.customers where id = ${d.customer_id}`;
        const emails = c?.invoice_emails ?? [];
        return {
          id: d.id,
          date: d.issue_date,
          number: d.number,
          title: d.title,
          customer_id: d.customer_id,
          customer_name: d.customer_name,
          customer_no: d.customer_no,
          pos: d.items,
          net: null,
          gross: d.total_cents,
          recipients: emails,
          note: emails.length ? null : 'keine E-Mail beim Kunden',
          href: `/mahnungen/${d.id}`,
        };
      }),
    );
  }

  const rowsFor = (tab: Tab) => (tab === 'mahnungen' ? dunningRows() : invoiceRows(tab));
  const tabOf = (v: string | undefined): Tab => (v === 'korrekturen' || v === 'mahnungen' ? v : 'rechnungen');

  app.get('/rechnungen/versand', async (c: Context<AppEnv>) => {
    if (c.req.query('reiter') === 'verlauf') return c.redirect('/transfer/dokumentenversand');
    const tab = tabOf(c.req.query('reiter'));
    const [rows, counts] = await Promise.all([
      rowsFor(tab),
      sql<{ r: number; k: number; m: number }[]>`
        select (select count(*)::int from app.invoices i where i.status = 'issued' and i.kind in ('invoice','partial','final')
                  and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')) as r,
               (select count(*)::int from app.invoices i where i.status = 'issued' and i.kind in ('cancellation','correction')
                  and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')) as k,
               (select count(*)::int from app.dunnings where status = 'erstellt') as m`,
    ]);
    const n = counts[0]!;
    const cnt: Record<string, number> = { rechnungen: n.r, korrekturen: n.k, mahnungen: n.m };
    const sumNet = rows.reduce((a, r) => a + (r.net ?? 0n), 0n);
    const sumGross = rows.reduce((a, r) => a + r.gross, 0n);
    return page(
      c,
      'Noch nicht versendete Dokumente',
      'rechnungen',
      <>
        <PageHead title="Noch nicht versendete Dokumente" />
        <div class="tabs" style="margin-bottom:0">
          {TABS.map(([k, l]) => (
            <a href={`/rechnungen/versand?reiter=${k}`} class={k === tab ? 'on' : ''}>
              {l}
              {k !== 'verlauf' && cnt[k] ? <span class="cnt"> {cnt[k]}</span> : null}
            </a>
          ))}
        </div>
        <form method="post" action={`/rechnungen/versand?reiter=${tab}`} class="card vs-card">
          <div class="vs-top">
            <span class="small">
              Um Dokumente zu versenden, Versandart wählen, Dokumente ankreuzen und „Los“ klicken.
            </span>
            {rows.length > 0 && (
              <a class="btn sm sec" href={`/rechnungen/versand/pdf?reiter=${tab}`} target="_blank">
                Alle als PDF herunterladen
              </a>
            )}
          </div>
          <div class="vs-top">
            <select name="art" id="vs-art" required aria-label="Versandart">
              <option value="">– Versandart auswählen –</option>
              <option value="email">E-Mail</option>
              <option value="manuell">Als bereits versendet kennzeichnen</option>
              {tab !== 'mahnungen' && <option value="portal">Im Portal hochgeladen</option>}
            </select>
            <select name="way" aria-label="Versandweg" data-vs-way hidden>
              {MANUAL_WAYS.map((w) => (
                <option value={w}>{w}</option>
              ))}
            </select>
            <input
              name="note"
              placeholder="Bemerkung (optional)"
              data-vs-way
              hidden
              style="max-width:240px"
            />
            {rows.length > 0 && (
              <button class="btn" data-vs-go disabled style="margin-left:auto">
                Los (<span data-vs-n>0</span>)
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <div class="empty">Alles versendet – hier ist nichts offen.</div>
          ) : (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th style="width:28px">
                      <input type="checkbox" data-vs-all aria-label="alle" />
                    </th>
                    <th>Datum</th>
                    <th>Nr.</th>
                    <th>Kunde</th>
                    <th class="r">Pos</th>
                    <th class="r">Netto</th>
                    <th class="r">Brutto</th>
                    <th>Empfänger</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr>
                      <td>
                        <input type="checkbox" name="sel" value={r.id} data-vs-row aria-label={r.number} />
                      </td>
                      <td>{dateDe(r.date)}</td>
                      <td>
                        <a href={r.href}>{r.number}</a>
                        <div class="small mut">{r.title}</div>
                      </td>
                      <td>
                        <a href={`/kunden/${r.customer_id}`}>
                          <b>{r.customer_name}</b>
                        </a>
                        <div class="small mut">{r.customer_no}</div>
                      </td>
                      <td class="r">{r.pos}</td>
                      <td class="r">{r.net != null ? euro(r.net) : '–'}</td>
                      <td class="r">{euro(r.gross)}</td>
                      <td class="small">
                        {r.recipients.join(', ')}
                        {r.note && (
                          <div>
                            <span class={`badge ${r.note.startsWith('Portal') ? 'info' : 'warn'}`}>
                              {r.note}
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan={5}>
                      <label style="display:flex;gap:6px;align-items:center;margin:0">
                        <input type="checkbox" data-vs-all /> Alle auswählen ({rows.length})
                      </label>
                    </td>
                    <td class="r">
                      <b>{tab === 'mahnungen' ? '' : euro(sumNet)}</b>
                    </td>
                    <td class="r">
                      <b>{euro(sumGross)}</b>
                    </td>
                    <td class="r">
                      <button class="btn" data-vs-go disabled>
                        Los (<span data-vs-n>0</span>)
                      </button>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var f=document.querySelector('.vs-card');if(!f)return;var art=f.querySelector('#vs-art');function rows(){return f.querySelectorAll('[data-vs-row]')}function upd(){var n=0;rows().forEach(function(b){if(b.checked)n++});f.querySelectorAll('[data-vs-n]').forEach(function(s){s.textContent=n});f.querySelectorAll('[data-vs-go]').forEach(function(g){g.disabled=!n||!art.value});f.querySelectorAll('[data-vs-all]').forEach(function(a){a.checked=n>0&&n===rows().length});f.querySelectorAll('[data-vs-way]').forEach(function(w){w.hidden=art.value!=='manuell'&&!(art.value==='portal'&&w.tagName==='INPUT')})}f.addEventListener('submit',function(e){var n=0;rows().forEach(function(b){if(b.checked)n++});var t=art.options[art.selectedIndex].text;var m=art.value==='email'?n+' Dokument(e) jetzt per E-Mail versenden? Das lässt sich nicht zurücknehmen.':n+' Dokument(e) als versendet kennzeichnen ('+t+')?';if(!confirm(m))e.preventDefault()});f.addEventListener('change',function(e){if(e.target.matches('[data-vs-all]'))rows().forEach(function(b){b.checked=e.target.checked});upd()});upd()})();`,
          }}
        />
      </>,
    );
  });

  app.post('/rechnungen/versand', async (c) => {
    const tab = tabOf(c.req.query('reiter'));
    const b = await c.req.parseBody({ all: true });
    const sel = [...new Set(([] as unknown[]).concat(b.sel ?? []).map(String))];
    const art = String(b.art ?? '');
    const way = String(b.way ?? '');
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 200) : null;
    const actor = c.get('actor');
    const to = `/rechnungen/versand?reiter=${tab}`;
    if (!sel.length) return back(c, to, { fehler: 'Bitte Dokumente ankreuzen.' });
    if (!['email', 'manuell', 'portal'].includes(art))
      return back(c, to, { fehler: 'Bitte Versandart wählen.' });
    let ok = 0;
    const errors: string[] = [];
    for (const id of sel) {
      try {
        if (tab === 'mahnungen') {
          if (art === 'email') await sendDunning(deps, id, actor);
          else await markDunningSent(sql, id, way || 'Post', actor);
        } else if (art === 'email') await sendInvoice(deps, id, actor);
        else if (art === 'portal') await recordPortalUpload(deps, id, { reference: note, actor });
        else await recordManualDelivery(deps, id, { way: way || 'Post', note, actor });
        ok++;
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        const [n] = await sql<{ number: string }[]>`
          select number from app.invoices where id = ${id} union all select number from app.dunnings where id = ${id}`;
        errors.push(`${n?.number ?? id}: ${e.message}`);
      }
    }
    const what = art === 'email' ? 'per E-Mail versendet' : 'als versendet gekennzeichnet';
    return back(
      c,
      to,
      errors.length
        ? { fehler: `${ok} ${what}. Nicht möglich:\n${errors.join('\n')}` }
        : { ok: `${anz(ok, 'Dokument', 'Dokumente')} ${what}.` },
    );
  });

  // alle (oder die angekreuzten) als ein PDF – archivierte Belege, nichts wird neu erzeugt
  app.get('/rechnungen/versand/pdf', async (c) => {
    const tab = tabOf(c.req.query('reiter'));
    const rows = await rowsFor(tab);
    const out = await PDFDocument.create();
    for (const r of rows.slice(0, 300)) {
      let bytes: Uint8Array | null = null;
      if (tab === 'mahnungen') {
        const [d] = await sql<
          { pdf_path: string | null }[]
        >`select pdf_path from app.dunnings where id = ${r.id}`;
        if (d?.pdf_path) bytes = await deps.archive.get(d.pdf_path);
      } else {
        const docs = await ensureDocuments(deps, r.id);
        const latest = docs.reduce((m, d) => (d.kind !== 'attachment' && d.revision > m ? d.revision : m), 0);
        const pdf = docs.find((d) => d.kind === 'pdf' && d.revision === latest);
        if (pdf) bytes = await deps.archive.get(pdf.storage_path);
      }
      if (!bytes) continue;
      const src = await PDFDocument.load(bytes);
      for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    }
    const data = await out.save();
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="nicht-versendet-${tab}.pdf"`,
    });
  });
}
