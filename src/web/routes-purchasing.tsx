import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, parseEuro, parseQuantity } from '../domain/money/money.js';
import { addDays } from '../domain/time/holidays.js';
import { siteCosting } from '../services/costing.js';
import {
  buildExtf,
  collectBookings,
  encodeCp1252,
  getAccountingSettings,
  saveAccountingSettings,
} from '../services/datev.js';
import { BusinessError } from '../services/errors.js';
import { listArticles, listSuppliers } from '../services/inventory.js';
import { getSeller, listSites } from '../services/masterdata.js';
import {
  type CostCategory,
  type IncomingStatus,
  type PoStatus,
  COST_CATEGORY,
  INCOMING_STATUS,
  PO_STATUS,
  createPaymentRun,
  decideIncoming,
  getIncoming,
  getOrder,
  listIncoming,
  listOrders,
  listPaymentRuns,
  paymentProposal,
  paymentRunItems,
  paymentRunXml,
  receiveOrder,
  renderOrderPdf,
  saveIncoming,
  saveOrder,
  setOrderStatus,
} from '../services/purchasing.js';
import { hm } from '../services/time.js';
import { listFiles } from '../services/uploads.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { arr, centsToInput, milliToInput, str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const money = (v: string | null, label: string): Cents => {
  try {
    return parseEuro(v ?? '');
  } catch {
    throw new BusinessError(`${label}: Betrag ungültig`);
  }
};

const PO_CLASS: Record<PoStatus, string> = {
  entwurf: 'draft',
  bestellt: 'info',
  geliefert: 'ok',
  storniert: '',
};
const IN_CLASS: Record<IncomingStatus, string> = {
  erfasst: 'warn',
  freigegeben: 'info',
  bezahlt: 'ok',
  abgelehnt: 'err',
};

// Positions-Editor für Bestellungen (Artikel wählen füllt Text, Einheit, Preis)
const PO_LINES_JS = `
(function(){
  var tb=document.querySelector('#po-lines tbody'), tpl=document.getElementById('po-line-tpl');
  function wire(tr){var s=tr.querySelector('[name=article_id]');s.addEventListener('change',function(){var o=s.selectedOptions[0];if(!o||!o.value)return;tr.querySelector('[name=desc]').value=o.dataset.name;tr.querySelector('[name=unit]').value=o.dataset.unit;if(o.dataset.price)tr.querySelector('[name=price]').value=o.dataset.price;});
    tr.querySelector('.del').addEventListener('click',function(){tr.remove()});}
  Array.prototype.forEach.call(tb.querySelectorAll('tr'),wire);
  document.getElementById('po-add').addEventListener('click',function(){var tr=tpl.content.firstElementChild.cloneNode(true);tb.appendChild(tr);wire(tr);});
})();`;

export function registerPurchasingRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  // ================================================================== Bestellungen

  app.get('/bestellungen', async (c) => {
    const st = c.req.query('status') as PoStatus | undefined;
    const all = await listOrders(sql);
    const rows =
      st && st in PO_STATUS
        ? all.filter((o) => o.status === st)
        : all.filter((o) => o.status !== 'storniert');
    const tabs: Tab[] = [
      {
        key: '',
        label: 'Offen',
        href: '/bestellungen',
        count: all.filter((o) => ['entwurf', 'bestellt'].includes(o.status)).length,
      },
      ...(['entwurf', 'bestellt', 'geliefert', 'storniert'] as PoStatus[]).map((s) => ({
        key: s,
        label: PO_STATUS[s][0]!.toUpperCase() + PO_STATUS[s].slice(1),
        href: `/bestellungen?status=${s}`,
        count: all.filter((o) => o.status === s).length,
      })),
    ];
    return page(
      c,
      'Bestellungen',
      'lieferanten',
      <>
        <PageHead title="Bestellungen">
          <a class="btn" href={`/bestellungen/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            <Icon name="plus" /> Bestellung anlegen
          </a>
        </PageHead>
        <Tabs tabs={tabs} active={st ?? ''} />
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Lieferant</th>
                <th>Lieferung an</th>
                <th>Datum</th>
                <th class="r">Netto</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={6}>
                    <div class="empty">Keine Bestellungen.</div>
                  </td>
                </tr>
              )}
              {rows.map((o) => (
                <tr>
                  <td>
                    <a href={`/bestellungen/${o.id}`}>
                      <b>{o.number}</b>
                    </a>
                  </td>
                  <td>
                    <a href={`/lieferanten/${o.supplier_id}`}>{o.supplier_name}</a>
                  </td>
                  <td>{o.site_name ?? 'Lager'}</td>
                  <td>{dateDe(o.order_date)}</td>
                  <td class="r">{euro(o.net_cents)}</td>
                  <td>
                    <span class={`badge ${PO_CLASS[o.status]}`}>{PO_STATUS[o.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/bestellungen/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getOrder(sql, id);
    if (data && data.order.status !== 'entwurf')
      return back(c, `/bestellungen/${id}`, { fehler: 'Nur Entwürfe können geändert werden.' });
    const [suppliers, sites, articles] = await Promise.all([
      listSuppliers(sql),
      listSites(sql),
      listArticles(sql),
    ]);
    const q = c.req.query();
    const o = data?.order;
    const preArticle = q.artikel ? articles.find((a) => a.id === q.artikel) : undefined;
    const lines = data?.lines.length
      ? data.lines.map((l) => ({
          article: l.article_id ?? '',
          desc: l.description,
          qty: milliToInput(l.quantity_milli),
          unit: l.unit,
          price: centsToInput(l.unit_price_cents),
        }))
      : preArticle
        ? [
            {
              article: preArticle.id,
              desc: preArticle.name,
              qty: milliToInput(
                preArticle.min_stock_milli * 2n - preArticle.stock_milli > 0n
                  ? preArticle.min_stock_milli * 2n - preArticle.stock_milli
                  : 1000n,
              ),
              unit: preArticle.unit,
              price:
                preArticle.purchase_price_cents !== null ? centsToInput(preArticle.purchase_price_cents) : '',
            },
          ]
        : [{ article: '', desc: '', qty: '1', unit: 'Stk.', price: '' }];
    const Row: FC<{ l?: (typeof lines)[number] }> = ({ l }) => (
      <tr>
        <td style="min-width:200px">
          <select name="article_id">
            <option value="">– frei –</option>
            {articles
              .filter((a) => a.active)
              .map((a) => (
                <option
                  value={a.id}
                  selected={a.id === l?.article}
                  data-name={a.name}
                  data-unit={a.unit}
                  data-price={a.purchase_price_cents !== null ? centsToInput(a.purchase_price_cents) : ''}
                >
                  {a.article_no} · {a.name}
                </option>
              ))}
          </select>
        </td>
        <td style="min-width:220px">
          <input name="desc" value={l?.desc ?? ''} placeholder="Bezeichnung" />
        </td>
        <td style="width:90px">
          <input name="qty" value={l?.qty ?? '1'} class="right" />
        </td>
        <td style="width:110px">
          <input name="unit" value={l?.unit ?? 'Stk.'} />
        </td>
        <td style="width:120px">
          <input name="price" value={l?.price ?? ''} placeholder="0,00" class="right" />
        </td>
        <td style="width:40px">
          <button type="button" class="btn sm sec del" title="Position entfernen">
            ×
          </button>
        </td>
      </tr>
    );
    return page(
      c,
      o ? `Bestellung ${o.number}` : 'Neue Bestellung',
      'lieferanten',
      <>
        <PageHead
          title={o ? `Bestellung ${o.number} bearbeiten` : 'Neue Bestellung'}
          crumbs={[['Bestellungen', '/bestellungen']]}
        />
        <form
          method="post"
          action={`/bestellungen/${id}`}
          class="card"
          data-autosave={`/bestellungen/${id}`}
          data-version={String(o?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(o?.version ?? '')} />
          <div class="grid">
            <div>
              <label for="supplier_id">Lieferant</label>
              <select id="supplier_id" name="supplier_id" required>
                <option value="">– bitte wählen –</option>
                {suppliers
                  .filter((s) => s.active)
                  .map((s) => (
                    <option
                      value={s.id}
                      selected={s.id === (o?.supplier_id ?? q.lieferant ?? preArticle?.supplier_id)}
                    >
                      {s.supplier_no} · {s.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label for="site_id">Lieferung an</label>
              <select id="site_id" name="site_id">
                <option value="">Lager / Büro</option>
                {sites.map((s) => (
                  <option value={s.id} selected={s.id === o?.site_id}>
                    {s.site_no} · {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="order_date">Bestelldatum</label>
              <input
                id="order_date"
                type="date"
                name="order_date"
                value={o?.order_date ?? todayBerlin()}
                required
              />
            </div>
            <div>
              <label for="delivery_date">Wunsch-Liefertermin</label>
              <input id="delivery_date" type="date" name="delivery_date" value={o?.delivery_date ?? ''} />
            </div>
          </div>
          <h2>Positionen</h2>
          <div class="tbl">
            <table id="po-lines" class="lines">
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Bezeichnung</th>
                  <th class="r">Menge</th>
                  <th>Einheit</th>
                  <th class="r">EK netto €</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <Row l={l} />
                ))}
              </tbody>
            </table>
          </div>
          <template id="po-line-tpl">
            <Row />
          </template>
          <div class="actions">
            <button type="button" class="btn sm sec" id="po-add">
              + Position
            </button>
          </div>
          <label for="note">Hinweis an den Lieferanten</label>
          <textarea id="note" name="note">
            {o?.note ?? ''}
          </textarea>
          <div class="formfoot">
            <a class="btn sec" href={o ? `/bestellungen/${id}` : '/bestellungen'}>
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: PO_LINES_JS }} />
      </>,
    );
  });

  app.post(`/bestellungen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const art = arr(b, 'article_id');
    const desc = arr(b, 'desc');
    const qty = arr(b, 'qty');
    const unit = arr(b, 'unit');
    const price = arr(b, 'price');
    const lines = desc
      .map((d, i) => ({ d: d.trim(), i }))
      .filter((x) => x.d)
      .map(({ d, i }) => {
        let quantity, unitPrice;
        try {
          quantity = parseQuantity(qty[i] || '1');
          unitPrice = parseEuro(price[i] || '0');
        } catch {
          throw new BusinessError(`Position „${d}“: Menge oder Preis ungültig`);
        }
        return { articleId: art[i] || null, description: d, quantity, unit: unit[i] || 'Stk.', unitPrice };
      });
    const supplierId = str(b, 'supplier_id');
    if (!supplierId) throw new BusinessError('Bitte Lieferant wählen');
    await saveOrder(
      sql,
      id,
      {
        supplierId,
        siteId: str(b, 'site_id'),
        orderDate: str(b, 'order_date') ?? todayBerlin(),
        deliveryDate: str(b, 'delivery_date'),
        note: str(b, 'note'),
        lines,
        expectedVersion: versionOf(b.version),
      },
      c.get('actor'),
    );
    return back(c, `/bestellungen/${id}`, { ok: 'Bestellung gespeichert.' });
  });

  app.get(`/bestellungen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getOrder(sql, id);
    if (!data) return c.redirect(`/bestellungen/${id}/bearbeiten`);
    const { order: o, lines } = data;
    const [suppliers, invoices] = await Promise.all([
      listSuppliers(sql),
      sql<{ id: string; invoice_no: string; gross_cents: bigint; status: IncomingStatus }[]>`
        select id, invoice_no, gross_cents, status from app.incoming_invoices where purchase_order_id = ${id}`,
    ]);
    const s = suppliers.find((x) => x.id === o.supplier_id)!;
    const act = (path: string, label: Child, cls = 'sec', confirm?: string) => (
      <form
        method="post"
        action={`/bestellungen/${id}/${path}`}
        onsubmit={confirm ? `return confirm(${JSON.stringify(confirm)})` : undefined}
      >
        <button class={`btn ${cls}`}>{label}</button>
      </form>
    );
    return page(
      c,
      `Bestellung ${o.number}`,
      'lieferanten',
      <>
        <PageHead title={`Bestellung ${o.number}`} crumbs={[['Bestellungen', '/bestellungen']]}>
          <span class={`badge ${PO_CLASS[o.status]}`}>{PO_STATUS[o.status]}</span>
        </PageHead>
        <div class="actions" style="margin-top:-8px">
          {o.status === 'entwurf' && (
            <a class="btn" href={`/bestellungen/${id}/bearbeiten`}>
              Bearbeiten
            </a>
          )}
          <a class="btn sec" href={`/bestellungen/${id}/bestellung.pdf`} target="_blank">
            <Icon name="pdf" /> PDF
          </a>
          {o.status === 'entwurf' &&
            act(
              'status?s=bestellt',
              <>
                <Icon name="mail" /> Als bestellt markieren
              </>,
              '',
            )}
          {o.status === 'bestellt' &&
            act(
              'wareneingang',
              <>
                <Icon name="check" /> Wareneingang buchen
              </>,
              '',
              'Ware vollständig erhalten? Artikel werden ins Lager gebucht.',
            )}
          {(o.status === 'bestellt' || o.status === 'geliefert') && (
            <a
              class="btn sec"
              href={`/rechnungseingang/${randomUUID()}?lieferant=${o.supplier_id}&bestellung=${id}`}
            >
              Rechnung erfassen
            </a>
          )}
          {['entwurf', 'bestellt'].includes(o.status) &&
            act('status?s=storniert', 'Stornieren', 'ghost', 'Bestellung stornieren?')}
        </div>
        <div class="cols">
          <div class="card flush">
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Pos.</th>
                    <th>Bezeichnung</th>
                    <th class="r">Menge</th>
                    <th class="r">EK</th>
                    <th class="r">Gesamt</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr>
                      <td>{l.position}</td>
                      <td>
                        {l.article_id ? (
                          <a href={`/artikel/${l.article_id}`}>{l.description}</a>
                        ) : (
                          l.description
                        )}
                      </td>
                      <td class="r">
                        {milliToInput(l.quantity_milli)} {l.unit}
                      </td>
                      <td class="r">{euro(l.unit_price_cents)}</td>
                      <td class="r">{euro(l.net_cents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan={4} class="r">
                      <b>Summe netto</b>
                    </td>
                    <td class="r">
                      <b>{euro(o.net_cents)}</b>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <div class="card">
            <dl class="kv">
              <dt>Lieferant</dt>
              <dd>
                <a href={`/lieferanten/${s.id}`}>{s.name}</a>
                {s.email && <div class="small">{s.email}</div>}
              </dd>
              <dt>Bestelldatum</dt>
              <dd>{dateDe(o.order_date)}</dd>
              <dt>Liefertermin</dt>
              <dd>{dateDe(o.delivery_date)}</dd>
              <dt>Wareneingang</dt>
              <dd>
                {o.received_at
                  ? o.received_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })
                  : '–'}
              </dd>
              <dt>Rechnungen</dt>
              <dd>
                {invoices.length
                  ? invoices.map((i) => (
                      <div>
                        <a href={`/rechnungseingang/${i.id}`}>{i.invoice_no}</a> {euro(i.gross_cents)} (
                        {INCOMING_STATUS[i.status]})
                      </div>
                    ))
                  : '–'}
              </dd>
              {o.note && (
                <>
                  <dt>Hinweis</dt>
                  <dd style="white-space:pre-line">{o.note}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </>,
    );
  });

  app.get(`/bestellungen/:id{${UUID}}/bestellung.pdf`, async (c) => {
    const { pdf, filename } = await renderOrderPdf(sql, c.req.param('id'));
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.post(`/bestellungen/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const s = c.req.query('s');
    if (s !== 'bestellt' && s !== 'storniert') throw new BusinessError('Status ungültig');
    await setOrderStatus(sql, id, s, c.get('actor'));
    return back(c, `/bestellungen/${id}`, {
      ok:
        s === 'bestellt' ? 'Als bestellt markiert. PDF an den Lieferanten senden.' : 'Bestellung storniert.',
    });
  });

  app.post(`/bestellungen/:id{${UUID}}/wareneingang`, async (c) => {
    const id = c.req.param('id');
    await receiveOrder(sql, id, c.get('actor'));
    return back(c, `/bestellungen/${id}`, { ok: 'Wareneingang gebucht, Lagerbestand erhöht.' });
  });

  // ================================================================== Rechnungseingang

  app.get('/rechnungseingang', async (c) => {
    const st = (c.req.query('status') ?? 'erfasst') as IncomingStatus | 'alle';
    const all = await listIncoming(sql);
    const rows = st === 'alle' ? all : all.filter((i) => i.status === st);
    const today = todayBerlin();
    const tabs: Tab[] = (['erfasst', 'freigegeben', 'bezahlt', 'abgelehnt'] as IncomingStatus[]).map((s) => ({
      key: s,
      label: INCOMING_STATUS[s][0]!.toUpperCase() + INCOMING_STATUS[s].slice(1),
      href: `/rechnungseingang?status=${s}`,
      count: all.filter((i) => i.status === s).length,
    }));
    tabs.push({ key: 'alle', label: 'Alle', href: '/rechnungseingang?status=alle', count: all.length });
    const open = all.filter((i) => i.status === 'freigegeben');
    return page(
      c,
      'Rechnungseingang',
      'lieferanten',
      <>
        <PageHead title="Rechnungseingang">
          <a class="btn" href={`/rechnungseingang/${randomUUID()}`} style="margin-left:auto">
            <Icon name="plus" /> Rechnung erfassen
          </a>
        </PageHead>
        <div class="kpis">
          <div class="kpi">
            <div class="l">Zu prüfen</div>
            <div class="v">{all.filter((i) => i.status === 'erfasst').length}</div>
          </div>
          <div class="kpi">
            <div class="l">Freigegeben, offen</div>
            <div class="v">{euro(open.reduce((s, i) => s + i.gross_cents, 0n))}</div>
            <div class="s">
              <a href="/zahlungslauf">Zum Zahlungslauf →</a>
            </div>
          </div>
          <div class="kpi">
            <div class="l">Überfällig</div>
            <div class="v" style="color:var(--err)">
              {open.filter((i) => i.due_date < today).length}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Skonto läuft ab (≤ 3 Tage)</div>
            <div class="v" style="color:var(--warn)">
              {
                open.filter(
                  (i) => i.skonto_until && i.skonto_until >= today && i.skonto_until <= addDays(today, 3),
                ).length
              }
            </div>
          </div>
        </div>
        <Tabs tabs={tabs} active={st} />
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Lieferant</th>
                <th>Rechnungs-Nr.</th>
                <th>Datum</th>
                <th>fällig</th>
                <th>Art / Objekt</th>
                <th class="r">Brutto</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={7}>
                    <div class="empty">Keine Rechnungen.</div>
                  </td>
                </tr>
              )}
              {rows.map((i) => (
                <tr>
                  <td>
                    <a href={`/lieferanten/${i.supplier_id}`}>{i.supplier_name}</a>
                  </td>
                  <td>
                    <a href={`/rechnungseingang/${i.id}`}>
                      <b>{i.invoice_no}</b>
                    </a>
                    {i.file_count > 0 && (
                      <span class="mut">
                        {' '}
                        <Icon name="clip" size={12} />
                      </span>
                    )}
                    {i.reverse_charge && (
                      <>
                        {' '}
                        <span class="badge tag">§ 13b</span>
                      </>
                    )}
                  </td>
                  <td>{dateDe(i.invoice_date)}</td>
                  <td style={i.status !== 'bezahlt' && i.due_date < today ? 'color:var(--err)' : ''}>
                    {dateDe(i.due_date)}
                    {i.skonto_until && i.status === 'freigegeben' && i.skonto_until >= today && (
                      <div class="small" style="color:var(--warn)">
                        Skonto bis {dateDe(i.skonto_until)}
                      </div>
                    )}
                  </td>
                  <td class="small">
                    {COST_CATEGORY[i.category]}
                    {i.site_name && <div class="mut">{i.site_name}</div>}
                  </td>
                  <td class="r">{euro(i.gross_cents)}</td>
                  <td>
                    <span class={`badge ${IN_CLASS[i.status]}`}>{INCOMING_STATUS[i.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/rechnungseingang/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [i, suppliers, sites, orders, files] = await Promise.all([
      getIncoming(sql, id),
      listSuppliers(sql),
      listSites(sql),
      listOrders(sql, { status: ['bestellt', 'geliefert'] }),
      listFiles(sql, { type: 'incoming_invoice', id }),
    ]);
    const q = c.req.query();
    const editable = !i || i.status === 'erfasst';
    const po = q.bestellung ? orders.find((o) => o.id === q.bestellung) : undefined;
    const v = {
      supplier: i?.supplier_id ?? q.lieferant ?? '',
      site: i?.site_id ?? po?.site_id ?? '',
      po: i?.purchase_order_id ?? po?.id ?? '',
      net: i ? centsToInput(i.net_cents) : po ? centsToInput(po.net_cents) : '',
      vat: i ? centsToInput(i.vat_cents) : '',
    };
    const dis = !editable;
    return page(
      c,
      i ? `Eingangsrechnung ${i.invoice_no}` : 'Rechnung erfassen',
      'lieferanten',
      <>
        <PageHead
          title={i ? `${i.supplier_name} · ${i.invoice_no}` : 'Eingangsrechnung erfassen'}
          crumbs={[['Rechnungseingang', '/rechnungseingang']]}
        >
          {i && <span class={`badge ${IN_CLASS[i.status]}`}>{INCOMING_STATUS[i.status]}</span>}
        </PageHead>
        {i && (
          <div class="actions" style="margin-top:-8px">
            {i.status === 'erfasst' && (
              <>
                <form method="post" action={`/rechnungseingang/${id}/status?s=freigegeben`}>
                  <button class="btn">
                    <Icon name="check" /> Sachlich und rechnerisch richtig – freigeben
                  </button>
                </form>
                <form
                  method="post"
                  action={`/rechnungseingang/${id}/status?s=abgelehnt`}
                  onsubmit="return confirm('Rechnung ablehnen?')"
                >
                  <button class="btn danger">Ablehnen</button>
                </form>
              </>
            )}
            {(i.status === 'freigegeben' || i.status === 'abgelehnt') && (
              <form method="post" action={`/rechnungseingang/${id}/status?s=erfasst`}>
                <button class="btn sec">Zurück auf „zu prüfen“</button>
              </form>
            )}
            {i.approved_by && (
              <span class="small mut">
                freigegeben von {i.approved_by} am{' '}
                {i.approved_at?.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
              </span>
            )}
            {i.paid_at && <span class="badge ok">bezahlt am {dateDe(i.paid_at)}</span>}
          </div>
        )}
        <div class="cols">
          <form
            method="post"
            action={`/rechnungseingang/${id}`}
            class="card"
            data-autosave={`/rechnungseingang/${id}`}
            data-version={String(i?.version ?? '')}
          >
            <input type="hidden" name="version" value={String(i?.version ?? '')} />
            <fieldset disabled={dis} style="border:0;padding:0;margin:0">
              <div class="grid">
                <div>
                  <label for="supplier_id">Lieferant / Nachunternehmer</label>
                  <select id="supplier_id" name="supplier_id" required>
                    <option value="">– bitte wählen –</option>
                    {suppliers.map((s) => (
                      <option value={s.id} selected={s.id === v.supplier}>
                        {s.supplier_no} · {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label for="invoice_no">Rechnungsnummer (vom Beleg)</label>
                  <input id="invoice_no" name="invoice_no" value={i?.invoice_no ?? ''} required />
                </div>
                <div>
                  <label for="invoice_date">Rechnungsdatum</label>
                  <input
                    id="invoice_date"
                    type="date"
                    name="invoice_date"
                    value={i?.invoice_date ?? todayBerlin()}
                    required
                  />
                </div>
                <div>
                  <label for="due_date">fällig am (leer = Zahlungsziel)</label>
                  <input id="due_date" type="date" name="due_date" value={i?.due_date ?? ''} />
                </div>
                <div>
                  <label for="net">Netto €</label>
                  <input id="net" name="net" value={v.net} required class="right" />
                </div>
                <div>
                  <label for="vat">USt €</label>
                  <input id="vat" name="vat" value={v.vat} class="right" placeholder="0,00" />
                </div>
                <div class="chk" style="align-self:end;height:38px">
                  <input
                    type="checkbox"
                    id="reverse_charge"
                    name="reverse_charge"
                    checked={!!i?.reverse_charge}
                  />
                  <label for="reverse_charge">§ 13b – Steuerschuld liegt bei uns</label>
                </div>
              </div>
              <h2>Zuordnung</h2>
              <div class="grid">
                <div>
                  <label for="category">Kostenart</label>
                  <select id="category" name="category">
                    {(Object.keys(COST_CATEGORY) as CostCategory[]).map((k) => (
                      <option
                        value={k}
                        selected={
                          k ===
                          (i?.category ??
                            (suppliers.find((s) => s.id === v.supplier)?.kind === 'nachunternehmer'
                              ? 'nachunternehmer'
                              : 'material'))
                        }
                      >
                        {COST_CATEGORY[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label for="site_id">Objekt (für Nachkalkulation)</label>
                  <select id="site_id" name="site_id">
                    <option value="">– kein Objekt (Gemeinkosten) –</option>
                    {sites.map((s) => (
                      <option value={s.id} selected={s.id === v.site}>
                        {s.site_no} · {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label for="service_month">Leistungsmonat</label>
                  <input
                    id="service_month"
                    type="month"
                    name="service_month"
                    value={i?.service_month?.slice(0, 7) ?? ''}
                  />
                </div>
                <div>
                  <label for="purchase_order_id">Bestellung</label>
                  <select id="purchase_order_id" name="purchase_order_id">
                    <option value="">–</option>
                    {orders.map((o) => (
                      <option value={o.id} selected={o.id === v.po}>
                        {o.number} · {o.supplier_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <h2>Skonto</h2>
              <div class="grid">
                <div>
                  <label for="skonto_percent">Skonto %</label>
                  <input
                    id="skonto_percent"
                    name="skonto_percent"
                    value={i?.skonto_percent_bp ? String(i.skonto_percent_bp / 100).replace('.', ',') : ''}
                    placeholder="z. B. 2"
                  />
                </div>
                <div>
                  <label for="skonto_until">bei Zahlung bis</label>
                  <input id="skonto_until" type="date" name="skonto_until" value={i?.skonto_until ?? ''} />
                </div>
              </div>
              <div style="margin-top:12px">
                <label for="note">Notiz</label>
                <textarea id="note" name="note">
                  {i?.note ?? ''}
                </textarea>
              </div>
            </fieldset>
            {editable && (
              <div class="formfoot">
                <a class="btn sec" href="/rechnungseingang">
                  Abbrechen
                </a>
                <button class="btn">Speichern</button>
              </div>
            )}
          </form>
          <div class="card">
            <h3>Beleg</h3>
            {i ? (
              <FileArea
                link={{ type: 'incoming_invoice', id }}
                files={files}
                category="Eingangsrechnung"
                title="Rechnung (PDF/Scan) hierher ziehen"
                hint="Beleg wird unveränderbar mit Prüfsumme abgelegt (GoBD)."
                maxBytes={env.UPLOAD_MAX_BYTES}
              />
            ) : (
              <p class="small mut">Nach dem Speichern kann hier der Beleg hochgeladen werden.</p>
            )}
            {i?.supplier_kind === 'nachunternehmer' && (
              <p class="small" style="margin-top:12px">
                Nachunternehmer: Bei Reinigungsleistungen an uns (selbst Gebäudereiniger) gilt meist § 13b
                UStG – Rechnung ohne Umsatzsteuer mit Hinweis „Steuerschuldnerschaft des Leistungsempfängers“.
                Freistellungsbescheinigung prüfen.
              </p>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.post(`/rechnungseingang/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const one = (k: string) =>
      typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string).trim() : null;
    const sk = one('skonto_percent');
    const bp = sk ? Math.round(Number(sk.replace(',', '.')) * 100) : null;
    if (sk && (!Number.isFinite(bp) || bp! <= 0 || bp! > 1000)) throw new BusinessError('Skonto % ungültig');
    const cat = (one('category') ?? 'sonstiges') as CostCategory;
    if (!(cat in COST_CATEGORY)) throw new BusinessError('Kostenart ungültig');
    await saveIncoming(
      sql,
      id,
      {
        supplierId: one('supplier_id') ?? '',
        invoiceNo: one('invoice_no') ?? '',
        invoiceDate: one('invoice_date') ?? todayBerlin(),
        dueDate: one('due_date'),
        serviceMonth: isMonth(one('service_month')) ? one('service_month') : null,
        net: money(one('net'), 'Netto'),
        vat: one('vat') ? money(one('vat'), 'USt') : (0n as Cents),
        reverseCharge: b.reverse_charge === 'on',
        category: cat,
        siteId: one('site_id'),
        purchaseOrderId: one('purchase_order_id'),
        skontoUntil: one('skonto_until'),
        skontoPercentBp: bp,
        note: one('note'),
        expectedVersion: versionOf(b.version),
      },
      c.get('actor'),
    );
    return back(c, `/rechnungseingang/${id}`, { ok: 'Gespeichert. Jetzt Beleg hochladen und freigeben.' });
  });

  app.post(`/rechnungseingang/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const s = c.req.query('s');
    if (s !== 'freigegeben' && s !== 'abgelehnt' && s !== 'erfasst')
      throw new BusinessError('Status ungültig');
    await decideIncoming(sql, id, s, c.get('actor'));
    return back(c, `/rechnungseingang/${id}`, {
      ok: s === 'freigegeben' ? 'Freigegeben – erscheint im Zahlungslauf.' : 'Status geändert.',
    });
  });

  // ================================================================== Zahlungslauf

  app.get('/zahlungslauf', async (c) => {
    const exec = isDate(c.req.query('ausfuehrung')) ? c.req.query('ausfuehrung')! : addDays(todayBerlin(), 1);
    const [prop, runs, seller] = await Promise.all([
      paymentProposal(sql, exec),
      listPaymentRuns(sql),
      getSeller(sql),
    ]);
    const today = todayBerlin();
    return page(
      c,
      'Zahlungslauf',
      'lieferanten',
      <>
        <PageHead title="Zahlungslauf (SEPA-Überweisungen)" />
        <div class="cols">
          <form method="post" action="/zahlungslauf" class="card">
            <input type="hidden" name="id" value={randomUUID()} />
            <div class="grid" style="align-items:end">
              <div>
                <label for="ausfuehrung">Ausführungstag</label>
                <input
                  id="ausfuehrung"
                  type="date"
                  name="execution_date"
                  value={exec}
                  min={today}
                  onchange={`location.href='/zahlungslauf?ausfuehrung='+this.value`}
                />
              </div>
              <div>
                <label for="iban">von Konto</label>
                <select id="iban" name="debtor_iban">
                  {seller.bankAccounts.map((b) => (
                    <option value={b.iban}>
                      {b.name} · {b.iban}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div class="tbl" style="margin-top:14px">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Lieferant</th>
                    <th>Rechnung</th>
                    <th>fällig</th>
                    <th class="r">Brutto</th>
                    <th class="r">Skonto</th>
                    <th class="r">Zahlbetrag</th>
                  </tr>
                </thead>
                <tbody>
                  {prop.length === 0 && (
                    <tr>
                      <td colspan={7}>
                        <div class="empty">
                          Keine freigegebenen Rechnungen. <a href="/rechnungseingang">Zum Rechnungseingang</a>
                        </div>
                      </td>
                    </tr>
                  )}
                  {prop.map((p) => {
                    const due = p.invoice.due_date <= addDays(exec, 7) || p.skonto > 0n;
                    return (
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            name="invoice"
                            value={p.invoice.id}
                            checked={due}
                            disabled={!p.invoice.iban}
                            aria-label="auswählen"
                          />
                        </td>
                        <td>
                          {p.invoice.supplier_name}
                          {!p.invoice.iban && (
                            <div class="small" style="color:var(--err)">
                              IBAN fehlt
                            </div>
                          )}
                        </td>
                        <td>
                          <a href={`/rechnungseingang/${p.invoice.id}`}>{p.invoice.invoice_no}</a>
                        </td>
                        <td style={p.invoice.due_date < today ? 'color:var(--err)' : ''}>
                          {dateDe(p.invoice.due_date)}
                        </td>
                        <td class="r">{euro(p.invoice.gross_cents)}</td>
                        <td class="r">{p.skonto > 0n ? `− ${euro(p.skonto)}` : '–'}</td>
                        <td class="r">
                          <b>{euro(p.amount)}</b>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p class="small mut">
              Vorausgewählt: fällig innerhalb von 7 Tagen nach dem Ausführungstag oder mit Skonto. Die
              SEPA-Datei (pain.001.001.09) im Online-Banking hochladen. Die Rechnungen gelten danach als
              bezahlt.
            </p>
            <div class="formfoot">
              <button class="btn" disabled={prop.length === 0}>
                <Icon name="euro" /> Zahlungslauf erstellen
              </button>
            </div>
          </form>
          <div class="card">
            <h3>Bisherige Zahlungsläufe</h3>
            {runs.length === 0 && <div class="small mut">Noch keine.</div>}
            {runs.map((r) => (
              <div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)">
                <a href={`/zahlungslauf/${r.id}`}>
                  <b>{r.number}</b>
                </a>{' '}
                · {dateDe(r.execution_date)} · {r.item_count} Überweisungen · {euro(r.total_cents)}
              </div>
            ))}
          </div>
        </div>
      </>,
    );
  });

  app.post('/zahlungslauf', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    await createPaymentRun(deps, {
      id,
      invoiceIds: arr(b, 'invoice'),
      executionDate: str(b, 'execution_date') ?? '',
      debtorIban: str(b, 'debtor_iban') ?? '',
      actor: c.get('actor'),
    });
    return back(c, `/zahlungslauf/${id}`, {
      ok: 'Zahlungslauf erstellt. SEPA-Datei herunterladen und im Online-Banking hochladen.',
    });
  });

  app.get(`/zahlungslauf/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [[run], items] = await Promise.all([
      sql<
        {
          number: string;
          execution_date: string;
          total_cents: bigint;
          item_count: number;
          debtor_iban: string;
          created_by: string;
          xml_sha256: string | null;
        }[]
      >`
        select number, execution_date, total_cents, item_count, debtor_iban, created_by, xml_sha256 from app.payment_runs where id = ${id}`,
      paymentRunItems(sql, id),
    ]);
    if (!run) return c.notFound();
    return page(
      c,
      `Zahlungslauf ${run.number}`,
      'lieferanten',
      <>
        <PageHead title={`Zahlungslauf ${run.number}`} crumbs={[['Zahlungslauf', '/zahlungslauf']]} />
        <div class="actions" style="margin-top:-8px">
          <a class="btn" href={`/zahlungslauf/${id}/sepa.xml`}>
            <Icon name="download" /> SEPA-Datei (pain.001)
          </a>
          <span class="small mut">
            Ausführung {dateDe(run.execution_date)} · von {run.debtor_iban} · {run.item_count} Überweisungen ·{' '}
            {euro(run.total_cents)} · SHA-256 {run.xml_sha256?.slice(0, 12)}…
          </span>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Empfänger</th>
                <th>IBAN</th>
                <th>Verwendungszweck</th>
                <th class="r">Skonto</th>
                <th class="r">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr>
                  <td>
                    <a href={`/rechnungseingang/${i.incoming_invoice_id}`}>{i.creditor_name}</a>
                  </td>
                  <td class="small">{i.creditor_iban.replace(/(.{4})/g, '$1 ')}</td>
                  <td class="small">{i.remittance}</td>
                  <td class="r">{i.skonto_cents > 0n ? euro(i.skonto_cents) : '–'}</td>
                  <td class="r">{euro(i.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/zahlungslauf/:id{${UUID}}/sepa.xml`, async (c) => {
    const id = c.req.param('id');
    const [run] = await sql<
      { number: string; xml_path: string | null }[]
    >`select number, xml_path from app.payment_runs where id = ${id}`;
    if (!run) return c.notFound();
    const xml = run.xml_path
      ? new TextDecoder().decode(await deps.archive.get(run.xml_path))
      : await paymentRunXml(sql, id);
    return c.body(xml, 200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="SEPA_${run.number}.xml"`,
      'Cache-Control': 'no-store',
    });
  });

  // ================================================================== DATEV

  const datevPage = async (c: Context<AppEnv>, body: Child) =>
    page(
      c,
      'DATEV-Export',
      'transfer',
      <>
        <PageHead title="DATEV-Export für den Steuerberater" />
        {body}
      </>,
    );

  app.get('/datev', async (c) => {
    const s = await getAccountingSettings(sql);
    const m = todayBerlin().slice(0, 7);
    const prev = addDays(`${m}-01`, -1).slice(0, 7);
    const from = isDate(c.req.query('von')) ? c.req.query('von')! : `${prev}-01`;
    const to = isDate(c.req.query('bis')) ? c.req.query('bis')! : addDays(`${m}-01`, -1);
    const { bookings, warnings } = await collectBookings(sql, {
      from,
      to,
      outgoing: true,
      incoming: true,
      payments: true,
    });
    const count = (k: string) => bookings.filter((b) => b.kind === k).length;
    const Inp: FC<{ n: keyof typeof s; l: string }> = ({ n, l }) => (
      <div>
        <label for={n}>{l}</label>
        <input id={n} name={n} value={String(s[n] ?? '')} />
      </div>
    );
    return datevPage(
      c,
      <div class="cols">
        <div>
          <form method="get" action="/datev" class="card">
            <h3>Zeitraum</h3>
            <div class="grid" style="align-items:end">
              <div>
                <label for="von">von</label>
                <input id="von" type="date" name="von" value={from} />
              </div>
              <div>
                <label for="bis">bis</label>
                <input id="bis" type="date" name="bis" value={to} />
              </div>
              <div>
                <button class="btn sec">Vorschau</button>
              </div>
            </div>
            <dl class="kv" style="margin-top:14px">
              <dt>Ausgangsrechnungen</dt>
              <dd>{count('ausgang')} Buchungen</dd>
              <dt>Zahlungseingänge</dt>
              <dd>{count('zahlungseingang')}</dd>
              <dt>Eingangsrechnungen</dt>
              <dd>{count('eingang')}</dd>
              <dt>Zahlungsausgänge</dt>
              <dd>{count('zahlungsausgang')}</dd>
            </dl>
            {warnings.length > 0 && (
              <div class="warnbox" style="margin-top:14px">
                <h3>Bitte mit dem Steuerberater klären</h3>
                {warnings.map((w) => (
                  <div class="small">{w}</div>
                ))}
              </div>
            )}
            <div class="actions" style="margin-bottom:0">
              <a class="btn" href={`/datev/buchungsstapel.csv?von=${from}&bis=${to}`}>
                <Icon name="download" /> Buchungsstapel herunterladen (EXTF)
              </a>
            </div>
            <p class="small mut">
              Format DATEV-Buchungsstapel (EXTF 700), Windows-1252, nicht festgeschrieben. Belege (PDF) liegen
              im Archiv. Vorläufig – vor dem ersten Echt-Export mit dem Steuerberater testen.
            </p>
          </form>
        </div>
        <form method="post" action="/datev/einstellungen" class="card">
          <h3>Einstellungen</h3>
          <div class="grid">
            <Inp n="datev_consultant_no" l="Beraternummer" />
            <Inp n="datev_client_no" l="Mandantennummer" />
            <div>
              <label for="chart">Kontenrahmen</label>
              <select id="chart" name="chart">
                <option selected={s.chart === 'SKR03'}>SKR03</option>
                <option selected={s.chart === 'SKR04'}>SKR04</option>
              </select>
            </div>
            <Inp n="fiscal_year_start" l="WJ-Beginn (MM-TT)" />
            <Inp n="account_length" l="Sachkontenlänge" />
            <Inp n="revenue_19" l="Erlöse 19 %" />
            <Inp n="revenue_7" l="Erlöse 7 %" />
            <Inp n="bank_account" l="Bank" />
            <Inp n="expense_material" l="Material" />
            <Inp n="expense_subcontractor" l="Fremdleistungen" />
            <Inp n="expense_other" l="Sonstige Kosten" />
            <Inp n="rc_tax_key" l="BU-Schlüssel § 13b" />
          </div>
          <h3 style="margin-top:16px">Nachkalkulation</h3>
          <div class="grid">
            <div>
              <label for="labor_overhead">Lohnzuschlag % (AG-Anteile, Urlaub, Krankheit, Feiertage)</label>
              <input
                id="labor_overhead"
                name="labor_overhead"
                value={String(s.labor_overhead_bp / 100).replace('.', ',')}
              />
            </div>
            <div>
              <label for="target_margin">Ziel-Deckungsbeitrag %</label>
              <input
                id="target_margin"
                name="target_margin"
                value={String(s.target_margin_bp / 100).replace('.', ',')}
              />
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
          </div>
        </form>
      </div>,
    );
  });

  app.post('/datev/einstellungen', async (c) => {
    const b = await c.req.parseBody();
    const s = await getAccountingSettings(sql);
    const t = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    const pct = (k: string) => {
      const n = Math.round(Number(t(k).replace(',', '.')) * 100);
      if (!Number.isFinite(n) || n < 0 || n > 20000) throw new BusinessError('Prozentwert ungültig');
      return n;
    };
    await saveAccountingSettings(
      sql,
      {
        ...s,
        datev_consultant_no: t('datev_consultant_no') || null,
        datev_client_no: t('datev_client_no') || null,
        chart: t('chart') === 'SKR04' ? 'SKR04' : 'SKR03',
        fiscal_year_start: t('fiscal_year_start'),
        account_length: Number(t('account_length')) || 4,
        revenue_19: t('revenue_19'),
        revenue_7: t('revenue_7'),
        bank_account: t('bank_account'),
        expense_material: t('expense_material'),
        expense_subcontractor: t('expense_subcontractor'),
        expense_other: t('expense_other'),
        rc_tax_key: t('rc_tax_key'),
        labor_overhead_bp: pct('labor_overhead'),
        target_margin_bp: pct('target_margin'),
      },
      c.get('actor'),
    );
    return back(c, '/datev', { ok: 'Einstellungen gespeichert.' });
  });

  app.get('/datev/buchungsstapel.csv', async (c) => {
    const from = c.req.query('von');
    const to = c.req.query('bis');
    if (!isDate(from) || !isDate(to)) throw new BusinessError('Zeitraum ungültig');
    const { bookings } = await collectBookings(sql, {
      from,
      to,
      outgoing: true,
      incoming: true,
      payments: true,
    });
    const csv = buildExtf(await getAccountingSettings(sql), { from, to }, bookings);
    await sql`insert into app.audit_log (actor, action, entity, details) values (${c.get('actor')}, 'export', 'datev', ${sql.json({ from, to, bookings: bookings.length })})`;
    return new Response(encodeCp1252(csv), {
      headers: {
        'Content-Type': 'text/csv; charset=windows-1252',
        'Content-Disposition': `attachment; filename="EXTF_Buchungsstapel_${from}_${to}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  // ================================================================== Nachkalkulation

  app.get('/auswertungen/nachkalkulation', async (c) => {
    const month = isMonth(c.req.query('monat'))
      ? c.req.query('monat')!
      : addDays(`${todayBerlin().slice(0, 7)}-01`, -1).slice(0, 7);
    const { rows, overheadBp, targetBp } = await siteCosting(sql, month);
    const active = rows.filter(
      (r) => r.revenue !== 0n || r.actual_minutes > 0 || r.material + r.subcontractor + r.other !== 0n,
    );
    const sum = (f: (r: (typeof rows)[number]) => bigint) => active.reduce((a, r) => a + f(r), 0n);
    const totalRev = sum((r) => r.revenue);
    const totalMargin = sum((r) => r.margin);
    const pct = (bp: number | null) =>
      bp === null ? '–' : `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
    return page(
      c,
      'Nachkalkulation',
      'auswertungen',
      <>
        <PageHead title="Nachkalkulation je Objekt" />
        <form method="get" action="/auswertungen/nachkalkulation" class="actions" style="margin-top:0">
          <input
            type="month"
            name="monat"
            value={month}
            style="max-width:200px"
            onchange="this.form.submit()"
          />
          <span class="small mut">
            Lohnkosten = Ist-Stunden × Stundenlohn + {pct(overheadBp)} Zuschlag · Ziel-Deckungsbeitrag{' '}
            {pct(targetBp)} · <a href="/datev">Werte ändern</a>
          </span>
        </form>
        <div class="kpis">
          <div class="kpi">
            <div class="l">Erlös netto</div>
            <div class="v">{euro(totalRev)}</div>
          </div>
          <div class="kpi">
            <div class="l">Kosten gesamt</div>
            <div class="v">{euro(totalRev - totalMargin)}</div>
          </div>
          <div class="kpi">
            <div class="l">Deckungsbeitrag</div>
            <div class="v" style={totalMargin < 0n ? 'color:var(--err)' : ''}>
              {euro(totalMargin)}
            </div>
            <div class="s">
              {totalRev !== 0n ? pct(Number((totalMargin * 10000n) / totalRev)) : '–'} vom Erlös
            </div>
          </div>
          <div class="kpi">
            <div class="l">Objekte unter Ziel</div>
            <div class="v" style="color:var(--err)">
              {active.filter((r) => r.margin_bp !== null && r.margin_bp < targetBp).length}
            </div>
          </div>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Objekt</th>
                <th class="r">Erlös</th>
                <th class="r">Std. Soll / Ist</th>
                <th class="r">Lohn</th>
                <th class="r">Material</th>
                <th class="r">Nachunternehmer</th>
                <th class="r">Sonstiges</th>
                <th class="r">Deckungsbeitrag</th>
                <th class="r">Marge</th>
                <th class="r">Erlös / Std.</th>
              </tr>
            </thead>
            <tbody>
              {active.length === 0 && (
                <tr>
                  <td colspan={10}>
                    <div class="empty">Für diesen Monat gibt es keine Erlöse, Zeiten oder Kosten.</div>
                  </td>
                </tr>
              )}
              {active.map((r) => (
                <tr>
                  <td>
                    <a href={`/objekte/${r.site_id}`}>{r.site_name}</a>
                    <div class="small mut">{r.customer_name}</div>
                  </td>
                  <td class="r">{euro(r.revenue)}</td>
                  <td class="r">
                    {hm(r.planned_minutes)} / {hm(r.actual_minutes)}
                    {r.missing_wage > 0 && (
                      <div class="small" style="color:var(--err)">
                        Stundenlohn fehlt
                      </div>
                    )}
                  </td>
                  <td class="r">{euro(r.labor)}</td>
                  <td class="r">{euro(r.material)}</td>
                  <td class="r">{euro(r.subcontractor)}</td>
                  <td class="r">{euro(r.other)}</td>
                  <td class="r" style={r.margin < 0n ? 'color:var(--err)' : ''}>
                    <b>{euro(r.margin)}</b>
                  </td>
                  <td class="r">
                    <span
                      class={`badge ${r.margin_bp === null ? '' : r.margin_bp < 0 ? 'err' : r.margin_bp < targetBp ? 'warn' : 'ok'}`}
                    >
                      {pct(r.margin_bp)}
                    </span>
                  </td>
                  <td class="r">
                    {r.actual_minutes > 0 ? euro((r.revenue * 60n) / BigInt(r.actual_minutes)) : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small mut">
          Erlös: ausgestellte Rechnungen des Objekts (Leistungszeitraum, sonst Rechnungsdatum), inkl.
          Storno/Korrektur. Material: Lagerabgänge an das Objekt zum EK + Eingangsrechnungen „Material“ mit
          Objekt. Gemeinkosten (Büro, Fahrzeuge ohne Objekt) sind nicht enthalten.
        </p>
      </>,
    );
  });
}
