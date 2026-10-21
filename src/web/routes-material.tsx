import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseQuantity } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import { listArticles } from '../services/inventory.js';
import { listSites } from '../services/masterdata.js';
import {
  cancelMaterialIssue,
  createMaterialIssue,
  getMaterialIssue,
  listMaterialIssues,
  materialIssuePdf,
} from '../services/material-issues.js';
import { type Ctx, UUID } from './app.js';
import { milliToInput } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, dateDe, euro } from './layout.js';
import { SiteOptions } from './site-options.js';

/** Inventar → Materialausgabe: interner Lieferschein an ein Objekt, Kosten auf die Kostenstelle (Ahmed 21.10.). */
export function registerMaterialRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;

  app.get('/materialausgabe', async (c) => {
    const q = c.req.query();
    const siteId = q.objekt && /^[0-9a-f-]{36}$/.test(q.objekt) ? q.objekt : null;
    const month = /^\d{4}-\d{2}$/.test(q.monat ?? '') ? q.monat! : null;
    const from = month ? `${month}-01` : null;
    const to = month
      ? new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10)
      : null;
    const [rows, sites] = await Promise.all([listMaterialIssues(sql, { siteId, from, to }), listSites(sql)]);
    const sum = rows.filter((r) => !r.cancelled_at).reduce((a, r) => a + r.total_cents, 0n);
    return page(
      c,
      'Materialausgabe',
      'inventar',
      <>
        <PageHead title="Materialausgabe (interner Lieferschein)">
          <a
            class="btn"
            href={`/materialausgabe/neu${siteId ? `?objekt=${siteId}` : ''}`}
            style="margin-left:auto"
          >
            <Icon name="plus" /> Material an Objekt ausgeben
          </a>
        </PageHead>
        <p class="small mut" style="margin-top:0">
          Material aus dem Lager an ein Objekt: Bestand wird abgebucht, der Einkaufspreis des Artikels zählt
          in der Nachkalkulation als Material auf die Kostenstelle des Objekts (Monat der Ausgabe). Wird dem
          Kunden nicht berechnet.
        </p>
        <form method="get" class="ls-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
          <div>
            <label for="f-objekt">Objekt</label>
            <select id="f-objekt" name="objekt">
              <option value="">alle Objekte</option>
              <SiteOptions sites={sites} selected={siteId ?? ''} />
            </select>
          </div>
          <div>
            <label for="f-monat">Monat</label>
            <input id="f-monat" type="month" name="monat" value={month ?? ''} />
          </div>
          <button class="btn sec sm">Anzeigen</button>
        </form>
        <div class="card flush">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Datum</th>
                  <th>Objekt</th>
                  <th>Empfangen</th>
                  <th class="r">Betrag (EK)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colspan={6}>
                      <div class="empty">Keine Materialausgaben.</div>
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr style={r.cancelled_at ? 'opacity:.55' : ''}>
                    <td>
                      <a href={`/materialausgabe/${r.id}`}>
                        <b>{r.issue_no}</b>
                      </a>
                    </td>
                    <td>{dateDe(r.issue_date)}</td>
                    <td>
                      <a href={`/objekte/${r.site_id}`}>
                        {r.site_name} ({r.site_no})
                      </a>
                      <div class="small mut">{r.customer_name}</div>
                    </td>
                    <td>{r.received_by ?? '–'}</td>
                    <td class="r">{r.cancelled_at ? <s>{euro(r.total_cents)}</s> : euro(r.total_cents)}</td>
                    <td>
                      {r.cancelled_at ? (
                        <span class="badge err">storniert</span>
                      ) : (
                        <a class="small" href={`/materialausgabe/${r.id}/pdf`} target="_blank">
                          PDF
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colspan={4} class="r">
                      <b>Summe (ohne Stornos)</b>
                    </td>
                    <td class="r">
                      <b>{euro(sum)}</b>
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </>,
    );
  });

  app.get('/materialausgabe/neu', async (c) => {
    const q = c.req.query();
    const [sites, arts] = await Promise.all([listSites(sql), listArticles(sql)]);
    const active = arts.filter((a) => a.active);
    const siteId = q.objekt && /^[0-9a-f-]{36}$/.test(q.objekt) ? q.objekt : '';
    const ROWS = 6;
    const artOptions = (
      <>
        <option value="">– Artikel wählen –</option>
        {active.map((a) => (
          <option value={a.id}>
            {a.article_no} · {a.name} ({a.unit}, Bestand {milliToInput(a.stock_milli)}
            {a.purchase_price_cents !== null ? `, EK ${euro(a.purchase_price_cents)}` : ', EK fehlt'})
          </option>
        ))}
      </>
    );
    return page(
      c,
      'Material an Objekt ausgeben',
      'inventar',
      <>
        <PageHead title="Material an Objekt ausgeben" crumbs={[['Materialausgabe', '/materialausgabe']]} />
        <form method="post" action="/materialausgabe/neu" class="card" style="max-width:900px">
          <input type="hidden" name="id" value={randomUUID()} />
          <div class="grid">
            <div>
              <label for="site_id">Objekt (Kostenstelle)</label>
              <select id="site_id" name="site_id" required>
                <option value="">– Objekt wählen –</option>
                <SiteOptions sites={sites} selected={siteId} />
              </select>
            </div>
            <div>
              <label for="issue_date">Datum der Ausgabe</label>
              <input
                id="issue_date"
                type="date"
                name="issue_date"
                value={todayBerlin()}
                max={todayBerlin()}
                required
              />
            </div>
            <div>
              <label for="received_by">Empfangen von (optional)</label>
              <input id="received_by" name="received_by" maxlength={120} placeholder="z. B. Objektleitung" />
            </div>
            <div>
              <label for="note">Bemerkung (optional)</label>
              <input id="note" name="note" maxlength={500} />
            </div>
          </div>
          <h3 style="margin:16px 0 6px">Artikel</h3>
          {active.length === 0 ? (
            <div class="empty">
              Noch keine Artikel – zuerst unter <a href="/artikel">Inventar → Artikel</a> anlegen.
            </div>
          ) : (
            <div class="tbl">
              <table class="keep" id="ma-lines">
                <thead>
                  <tr>
                    <th>Artikel</th>
                    <th style="width:140px">Menge</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: ROWS }, (_, i) => (
                    <tr>
                      <td>
                        <select name="article" aria-label={`Artikel ${i + 1}`}>
                          {artOptions}
                        </select>
                      </td>
                      <td>
                        <input
                          name="qty"
                          inputmode="decimal"
                          placeholder="z. B. 6"
                          aria-label={`Menge ${i + 1}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button
            type="button"
            class="btn sec sm"
            style="margin-top:8px"
            onclick="var t=document.querySelector('#ma-lines tbody');var r=t.rows[0].cloneNode(true);r.querySelectorAll('select,input').forEach(function(e){e.value=''});t.appendChild(r)"
          >
            + weitere Zeile
          </button>
          <label class="chk" style="margin-top:12px">
            <input type="checkbox" name="fill_shortage" value="1" />
            <span>
              Fehlenden Bestand vorher als Inventurkorrektur zubuchen (wenn der Lagerbestand nicht erfasst
              war)
            </span>
          </label>
          <div class="formfoot">
            <button class="btn">Ausgeben und Lieferschein erstellen</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/materialausgabe/neu', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const list = (k: string) => {
      const v = b[k];
      return (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => (typeof x === 'string' ? x : ''));
    };
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const arts = list('article');
    const qtys = list('qty');
    const lines = arts
      .map((a, i) => ({ a, q: (qtys[i] ?? '').trim() }))
      .filter((x) => x.a && x.q)
      .map((x) => {
        let q: bigint;
        try {
          q = parseQuantity(x.q);
        } catch {
          throw new BusinessError(`Menge „${x.q}“ ungültig`);
        }
        return { articleId: x.a, quantityMilli: q };
      });
    const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    await createMaterialIssue(
      sql,
      id,
      {
        siteId: str('site_id'),
        date: str('issue_date'),
        receivedBy: str('received_by'),
        note: str('note'),
        lines,
        fillShortage: b.fill_shortage === '1',
      },
      c.get('actor'),
    );
    return back(c, `/materialausgabe/${id}`, { ok: 'Material ausgegeben, Bestand abgebucht.' });
  });

  app.get(`/materialausgabe/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getMaterialIssue(sql, id);
    if (!data) return c.notFound();
    const { issue: m, lines } = data;
    return page(
      c,
      `Materialausgabe ${m.issue_no}`,
      'inventar',
      <>
        <PageHead
          title={`Lieferschein ${m.issue_no}`}
          no="Interne Materialausgabe"
          crumbs={[['Materialausgabe', '/materialausgabe']]}
        >
          {m.cancelled_at && <span class="badge err">storniert</span>}
          <a class="btn sm" href={`/materialausgabe/neu?objekt=${m.site_id}`} style="margin-left:auto">
            <Icon name="plus" /> Weitere Materialausgabe
          </a>
        </PageHead>
        <div class="cols">
          <div>
            <div class="card">
              <p style="margin-top:0">
                <b>Objekt:</b>{' '}
                <a href={`/objekte/${m.site_id}`}>
                  {m.site_name} ({m.site_no})
                </a>{' '}
                · {m.customer_name}
                <br />
                <b>Datum:</b> {dateDe(m.issue_date)}
                {m.received_by && (
                  <>
                    {' '}
                    · <b>Empfangen:</b> {m.received_by}
                  </>
                )}
                {m.note && (
                  <>
                    <br />
                    {m.note}
                  </>
                )}
              </p>
              {m.cancelled_at && (
                <p class="small" style="color:var(--err)">
                  Storniert: {m.cancel_reason} – Bestand und Kosten sind zurückgebucht.
                </p>
              )}
            </div>
            <div class="card flush">
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Pos.</th>
                      <th>Artikel</th>
                      <th class="r">Menge</th>
                      <th class="r">EK</th>
                      <th class="r">Betrag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr>
                        <td>{l.position}</td>
                        <td>
                          <a href={`/artikel/${l.article_id}`}>{l.description}</a>{' '}
                          <span class="small mut">{l.article_no}</span>
                        </td>
                        <td class="r">
                          {milliToInput(l.quantity_milli)} {l.unit}
                        </td>
                        <td class="r">{euro(l.unit_cost_cents)}</td>
                        <td class="r">{euro(l.net_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan={4} class="r">
                        <b>Materialkosten (EK, netto)</b>
                      </td>
                      <td class="r">
                        <b>{euro(m.total_cents)}</b>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
          <div>
            <div class="actstack">
              <a class="btn sec" href={`/materialausgabe/${id}/pdf`} target="_blank">
                <Icon name="pdf" /> Lieferschein (PDF)
              </a>
              <a class="btn sec" href={`/materialausgabe/${id}/pdf?preise=0`} target="_blank">
                <Icon name="pdf" /> Lieferschein ohne Preise
              </a>
              <a
                class="btn sec"
                href={`/auswertungen/nachkalkulation?objekt=${m.site_id}&von=${m.issue_date.slice(0, 7)}&bis=${m.issue_date.slice(0, 7)}`}
              >
                Nachkalkulation des Objekts
              </a>
            </div>
            {!m.cancelled_at && (
              <details class="card" style="margin-top:12px">
                <summary>Stornieren</summary>
                <form
                  method="post"
                  action={`/materialausgabe/${id}/storno`}
                  onsubmit="return confirm('Materialausgabe stornieren? Bestand und Kosten werden zurückgebucht.')"
                >
                  <label for="reason">Grund</label>
                  <input id="reason" name="reason" required maxlength={300} />
                  <div class="formfoot">
                    <button class="btn danger sm">Stornieren</button>
                  </div>
                </form>
              </details>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.get(`/materialausgabe/:id{${UUID}}/pdf`, async (c) => {
    const id = c.req.param('id');
    const pdf = await materialIssuePdf(sql, id, c.req.query('preise') !== '0');
    if (!pdf) return c.notFound();
    const data = await getMaterialIssue(sql, id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Lieferschein_${data!.issue.issue_no}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.post(`/materialausgabe/:id{${UUID}}/storno`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    await cancelMaterialIssue(sql, id, typeof b.reason === 'string' ? b.reason : '', c.get('actor'));
    return back(c, `/materialausgabe/${id}`, { ok: 'Storniert – Bestand und Kosten zurückgebucht.' });
  });
}
