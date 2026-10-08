import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import { type ExpectedRow, expectedInvoices, linksOf, skipExpected } from '../services/expected-invoices.js';
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
  decideIncoming,
  getIncoming,
  getOrder,
  listIncoming,
  listOrders,
  paymentList,
  markPaid,
  undoPaid,
  PAID_METHOD,
  type PaidMethod,
  createPaymentRun,
  listPaymentRuns,
  paymentRunItems,
  paymentRunXml,
  receiveOrder,
  renderOrderPdf,
  saveIncoming,
  saveOrder,
  setOrderStatus,
} from '../services/purchasing.js';
import { hm } from '../services/time.js';
import { toCsv } from '../services/reports.js';
import { listFiles } from '../services/uploads.js';
import { EInvoiceRoutes, EInvoiceTable } from './routes-einvoice-in.js';
import { pendingEInvoices } from '../services/einvoice-inbox.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { criticalSupplierIds, listSubcontracts, SC_STATUS } from '../services/subcontractors.js';
import {
  addMonths,
  costTargets,
  getAllocations,
  saveAllocations,
  splitEvenly,
} from '../services/cost-centers.js';
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

const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const periodLabel = (r: ExpectedRow) => {
  const a = `${MONTHS_DE[Number(r.period.slice(5, 7)) - 1]} ${r.period.slice(0, 4)}`;
  if (r.months <= 1) return a;
  const e = r.periodEnd.slice(0, 7);
  return `${a} – ${MONTHS_DE[Number(e.slice(5, 7)) - 1]} ${e.slice(0, 4)}`;
};
const BILLING_DE: Record<string, string> = {
  pauschale_monat: 'Monatspauschale',
  pauschale_einsatz: 'je Einsatz',
  stunde: 'je Stunde',
  tag: 'je Tag',
};

/** Rechnungseingang → „Rechnung erwartet“: je Nachunternehmer die fehlenden Rechnungen laufender Aufträge. */
const ExpectedList: FC<{ rows: ExpectedRow[] }> = ({ rows }) => {
  if (!rows.length)
    return (
      <div class="empty">
        Alles da – für alle laufenden Nachunternehmer-Aufträge liegt je abgelaufenem Zeitraum eine Rechnung
        vor.
      </div>
    );
  const bySup = new Map<string, ExpectedRow[]>();
  for (const r of rows) {
    if (!bySup.has(r.supplier_id)) bySup.set(r.supplier_id, []);
    bySup.get(r.supplier_id)!.push(r);
  }
  const param = (r: ExpectedRow) =>
    `erwartet=${encodeURIComponent(`${r.subcontract_id}:${r.period}${r.expectedNet != null ? `:${r.expectedNet}` : ''}`)}`;
  return (
    <>
      <p class="small mut" style="margin-top:0">
        Je laufendem Nachunternehmer-Auftrag wird je abgelaufenem Abrechnungszeitraum eine Rechnung erwartet.
        Sie verschwindet, sobald eine Eingangsrechnung den Auftrag und Zeitraum abdeckt – eine Rechnung darf
        mehrere Aufträge/Objekte abdecken (z. B. Glasreinigung). Rückblick 12 Monate.
      </p>
      {[...bySup.values()].map((list) => {
        const s0 = list[0]!;
        return (
          <div class="card" style="margin-bottom:14px">
            <div class="actions" style="margin:0 0 8px">
              <h3 style="margin:0">
                <a href={`/lieferanten/${s0.supplier_id}`}>{s0.supplier_name}</a>{' '}
                <span class="badge warn">{list.length} erwartet</span>
              </h3>
              {list.length > 1 && (
                <a
                  class="btn sm"
                  style="margin-left:auto"
                  href={`/rechnungseingang/${randomUUID()}?lieferant=${s0.supplier_id}&${list.map(param).join('&')}`}
                >
                  Eine Rechnung für alle {list.length} erfassen
                </a>
              )}
            </div>
            <div class="tbl">
              <table class="stack-m">
                <thead>
                  <tr>
                    <th>Auftrag</th>
                    <th>Objekt</th>
                    <th>Zeitraum</th>
                    <th class="r">erwartet netto</th>
                    <th>seit</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr>
                      <td data-l="Auftrag">
                        <a href={`/nachunternehmer/auftraege/${r.subcontract_id}`}>{r.number}</a>
                        <div class="small mut">{BILLING_DE[r.billing] ?? r.billing}</div>
                      </td>
                      <td data-l="Objekt">
                        {r.site_name ? `${r.site_name} (${r.site_no})` : '–'}
                        {r.customer_name && <div class="small mut">{r.customer_name}</div>}
                      </td>
                      <td data-l="Zeitraum">{periodLabel(r)}</td>
                      <td class="r" data-l="erwartet">
                        {r.expectedNet != null ? euro(r.expectedNet) : <span class="mut">nach Aufwand</span>}
                      </td>
                      <td data-l="seit" style={r.daysOverdue > 30 ? 'color:var(--err)' : ''}>
                        {r.daysOverdue} Tg.
                      </td>
                      <td class="acts">
                        <a
                          class="btn sm sec"
                          href={`/rechnungseingang/${randomUUID()}?lieferant=${r.supplier_id}&${param(r)}`}
                        >
                          Rechnung erfassen
                        </a>
                        <details style="display:inline-block">
                          <summary class="btn sm ghost">keine Rechnung …</summary>
                          <form
                            method="post"
                            action="/rechnungseingang/erwartet/keine"
                            class="actions"
                            style="margin-top:6px"
                          >
                            <input type="hidden" name="auftrag" value={r.subcontract_id} />
                            <input type="hidden" name="monat" value={r.period} />
                            <input
                              name="grund"
                              required
                              placeholder="Grund, z. B. Ausfall/Urlaub"
                              style="max-width:220px"
                            />
                            <button class="btn sm">Vermerken</button>
                          </form>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
};

export function registerPurchasingRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  // ================================================================== Bestellungen

  // Bestellungen = Material-Bestellungen und Aufträge an Nachunternehmer in einer Liste (gleicher Nummernkreis
  // BE-JJJJ-NNNN), Aufbau wie im alten Portal: Filter-Pillen, Nachunternehmer-Auswahl, Suche, Tabelle.
  app.get('/bestellungen', async (c) => {
    const q = c.req.query();
    const art = q.art === 'material' || q.art === 'nu' ? q.art : '';
    const view = ['erledigen', 'laufend', 'abgeschlossen', 'alle'].includes(q.ansicht ?? '')
      ? q.ansicht!
      : 'erledigen';
    const supplierId = q.lieferant && /^[0-9a-f-]{36}$/.test(q.lieferant) ? q.lieferant : '';
    const search = (q.q ?? '').trim().toLowerCase();
    const [orders, subcontracts, suppliers, billed] = await Promise.all([
      listOrders(sql),
      listSubcontracts(sql),
      sql<{ id: string; name: string; supplier_no: string }[]>`
        select id, name, supplier_no from app.suppliers where active order by name`,
      sql<{ id: string }[]>`
        select distinct purchase_order_id as id from app.incoming_invoices where purchase_order_id is not null`,
    ]);
    const invoiced = new Set(billed.map((b) => b.id));
    type Row = {
      id: string;
      href: string;
      number: string;
      kind: 'material' | 'nu';
      supplierId: string;
      supplier: string;
      what: string;
      from: string | null;
      to: string | null;
      ongoing: boolean;
      net: bigint;
      per: string;
      phase: 'erledigen' | 'laufend' | 'abgeschlossen' | 'storniert';
      status: string;
      tone: string;
    };
    const PO_PHASE: Record<PoStatus, Row['phase']> = {
      entwurf: 'erledigen',
      bestellt: 'laufend',
      geliefert: 'abgeschlossen',
      storniert: 'storniert',
    };
    const SC_PHASE: Record<string, Row['phase']> = {
      entwurf: 'erledigen',
      erteilt: 'laufend',
      beendet: 'abgeschlossen',
      storniert: 'storniert',
    };
    const SC_TONE: Record<string, string> = {
      entwurf: 'warn',
      erteilt: 'ok',
      beendet: 'grey',
      storniert: 'grey',
    };
    const PO_TONE: Record<PoStatus, string> = {
      entwurf: 'warn',
      bestellt: 'info',
      geliefert: 'ok',
      storniert: 'grey',
    };
    const PER: Record<string, string> = {
      pauschale_monat: '/ Monat',
      pauschale_einsatz: '/ Einsatz',
      tag: '/ Tag',
      stunde: '/ Std.',
    };
    const all: Row[] = [
      ...orders.map((o) => ({
        id: o.id,
        href: `/bestellungen/${o.id}`,
        number: o.number,
        kind: 'material' as const,
        supplierId: o.supplier_id,
        supplier: o.supplier_name,
        what: `${o.site_name ?? 'Lager'} · Material (${o.lines} Pos.)`,
        from: o.order_date,
        to: o.delivery_date,
        ongoing: false,
        net: o.net_cents,
        per: '',
        // geliefert, aber noch keine Eingangsrechnung erfasst → bleibt „zu erledigen“
        phase: o.status === 'geliefert' && !invoiced.has(o.id) ? ('erledigen' as const) : PO_PHASE[o.status],
        status:
          o.status === 'geliefert' && !invoiced.has(o.id)
            ? 'geliefert · Rechnung fehlt'
            : PO_STATUS[o.status],
        tone: o.status === 'geliefert' && !invoiced.has(o.id) ? 'warn' : PO_TONE[o.status],
      })),
      ...subcontracts.map((sc) => ({
        id: sc.id,
        href: `/nachunternehmer/auftraege/${sc.id}`,
        number: sc.number,
        kind: 'nu' as const,
        supplierId: sc.supplier_id,
        supplier: sc.supplier_name,
        what: `${sc.site_no} ${sc.site_name} · ${sc.service_kind}`,
        from: sc.valid_from,
        to: sc.valid_to,
        ongoing: !sc.valid_to && sc.frequency !== 'einmalig',
        net: sc.current_price_cents,
        per: PER[sc.billing] ?? '',
        phase: SC_PHASE[sc.status] ?? 'laufend',
        status:
          sc.requested_by && sc.status === 'entwurf'
            ? 'angefragt (Objektleitung) · Freigabe nötig'
            : (SC_STATUS[sc.status] ?? sc.status),
        tone: sc.requested_by && sc.status === 'entwurf' ? 'warn' : (SC_TONE[sc.status] ?? ''),
      })),
    ].sort((x, y) => y.number.localeCompare(x.number, 'de', { numeric: true }));
    const base = all
      .filter((r) => !art || r.kind === art)
      .filter((r) => !supplierId || r.supplierId === supplierId)
      .filter((r) => !search || [r.number, r.supplier, r.what].some((v) => v.toLowerCase().includes(search)));
    const count = (v: string) => (v === 'alle' ? base.length : base.filter((r) => r.phase === v).length);
    const rows = view === 'alle' ? base : base.filter((r) => r.phase === view);
    const link = (over: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const cur: Record<string, string | null> = {
        ansicht: view === 'erledigen' ? null : view,
        art: art || null,
        lieferant: supplierId || null,
        q: search || null,
        ...over,
      };
      for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
      const str = p.toString();
      return `/bestellungen${str ? `?${str}` : ''}`;
    };
    const VIEWS: [string, string][] = [
      ['erledigen', 'Zu erledigen'],
      ['laufend', 'Laufend'],
      ['abgeschlossen', 'Abgeschlossen'],
      ['alle', 'Alle'],
    ];
    return page(
      c,
      'Bestellungen',
      'lieferanten',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Einkauf</div>
            <h1>Bestellungen</h1>
            <div class="sub">
              Material und Aufträge an Nachunternehmer an einer Stelle · Nummern BE-JJJJ-NNNN fortlaufend
            </div>
          </div>
          <div class="acts">
            <a class="btn sec" href={`/bestellungen/${randomUUID()}/bearbeiten`}>
              + Material bestellen
            </a>
            <a class="btn" href={`/nachunternehmer/auftraege/${randomUUID()}`}>
              + Nachunternehmer beauftragen
            </a>
          </div>
        </div>
        <form class="toolbar" method="get" action="/bestellungen">
          <div class="pills">
            {VIEWS.map(([k, l]) => (
              <a
                class={`pill${view === k ? ' on' : ''}`}
                href={link({ ansicht: k === 'erledigen' ? null : k })}
              >
                {l} <span>{count(k)}</span>
              </a>
            ))}
          </div>
          {view !== 'erledigen' && <input type="hidden" name="ansicht" value={view} />}
          <select name="art" onchange="this.form.submit()" style="width:auto">
            <option value="">Material + Nachunternehmer</option>
            <option value="material" selected={art === 'material'}>
              nur Material
            </option>
            <option value="nu" selected={art === 'nu'}>
              nur Nachunternehmer
            </option>
          </select>
          <select name="lieferant" onchange="this.form.submit()" style="width:auto;max-width:260px">
            <option value="">Alle Lieferanten / Nachunternehmer</option>
            {suppliers.map((x) => (
              <option value={x.id} selected={x.id === supplierId}>
                {x.name} ({x.supplier_no})
              </option>
            ))}
          </select>
          <input
            class="search-input"
            type="search"
            name="q"
            value={search}
            placeholder="Bestellnummer, Objekt …"
          />
          {supplierId && (
            <a class="btn sec sm" href={`/lieferanten/${supplierId}`}>
              Stammdaten &amp; Nachweise
            </a>
          )}
        </form>
        <div class="bs-table">
          <div class="bs-tr bs-th">
            <span>Bestellnr.</span>
            <span>Lieferant · Objekt</span>
            <span>Zeitraum</span>
            <span class="r">Betrag netto</span>
            <span>Status</span>
          </div>
          {rows.map((r) => (
            <a class="bs-tr" href={r.href}>
              <span class="bs-nr">{r.number}</span>
              <span>
                <b>{r.supplier}</b>
                <span class="bs-sub">
                  {r.kind === 'nu' ? 'Nachunternehmer · ' : ''}
                  {r.what}
                </span>
              </span>
              <span class="small">
                {r.kind === 'material'
                  ? `${dateDe(r.from)}${r.to ? ` · Lieferung ${dateDe(r.to)}` : ''}`
                  : r.ongoing
                    ? `ab ${dateDe(r.from)} · fortlaufend`
                    : `${dateDe(r.from)} – ${dateDe(r.to ?? r.from)}`}
              </span>
              <span class="r">
                {euro(r.net)} <span class="small mut">{r.per}</span>
              </span>
              <span>
                <span class={`bs-pill bs-${r.tone || 'grey'}`}>{r.status}</span>
              </span>
            </a>
          ))}
          {!rows.length && <div class="bs-tr empty">Keine Bestellungen in dieser Ansicht.</div>}
        </div>
      </div>,
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
                <SiteOptions sites={sites} selected={o?.site_id} />
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

  /** Reiter des Rechnungseingangs; die Zahlungsliste ist ein Reiter davon (nicht separat). */
  const incomingTabs = (all: { status: IncomingStatus }[], expected?: number): Tab[] => [
    {
      key: 'erwartet',
      label: 'Rechnung erwartet',
      href: '/rechnungseingang?status=erwartet',
      ...(expected !== undefined ? { count: expected } : {}),
    },
    ...(['erfasst', 'freigegeben', 'bezahlt', 'abgelehnt'] as IncomingStatus[]).map((s) => ({
      key: s,
      label: INCOMING_STATUS[s][0]!.toUpperCase() + INCOMING_STATUS[s].slice(1),
      href: `/rechnungseingang?status=${s}`,
      count: all.filter((i) => i.status === s).length,
    })),
    { key: 'alle', label: 'Alle', href: '/rechnungseingang?status=alle', count: all.length },
    { key: 'zahlung', label: 'Zahlungsliste', href: '/zahlungsliste' },
  ];

  app.get('/rechnungseingang', async (c) => {
    const st = (c.req.query('status') ?? 'erfasst') as IncomingStatus | 'alle' | 'erwartet';
    const [all, expected, pendingE] = await Promise.all([
      listIncoming(sql),
      expectedInvoices(sql),
      pendingEInvoices(sql),
    ]);
    const rows = st === 'alle' ? all : all.filter((i) => i.status === st);
    const today = todayBerlin();
    const tabs = incomingTabs(all, expected.length);
    const open = all.filter((i) => i.status === 'freigegeben');
    return page(
      c,
      'Rechnungseingang',
      'lieferanten',
      <>
        <PageHead title="Rechnungseingang">
          <a class="btn sec" href="#e-rechnung" style="margin-left:auto">
            <Icon name="upload" /> E-Rechnung einlesen
          </a>
          <a class="btn" href={`/rechnungseingang/${randomUUID()}`}>
            <Icon name="plus" /> Rechnung erfassen
          </a>
        </PageHead>
        <details class="card" id="e-rechnung" open={pendingE.length > 0}>
          <summary>
            <b>E-Rechnung einlesen</b>{' '}
            <span class="small mut">XRechnung (XML) oder ZUGFeRD/Factur-X (PDF)</span>
            {pendingE.length > 0 && (
              <>
                {' '}
                <span class="badge warn">{pendingE.length} im Eingang</span>
              </>
            )}
          </summary>
          <form
            method="post"
            action="/rechnungseingang/e-rechnung"
            enctype="multipart/form-data"
            class="actions"
            style="margin:12px 0 0"
          >
            <input type="hidden" name="id" value={randomUUID()} />
            <input type="file" name="datei" accept=".xml,.pdf" required aria-label="E-Rechnung" />
            <button class="btn">Einlesen und prüfen</button>
            <span class="small mut">
              Lieferant, Rechnungsnummer, Datum, Fälligkeit, Beträge, § 13b und Skonto werden übernommen. Die Datei
              wird unverändert archiviert.
            </span>
          </form>
          {pendingE.length > 0 && (
            <ul class="small" style="margin:10px 0 0">
              {pendingE.map((f) => (
                <li>
                  <a href={`/rechnungseingang/e-rechnung/${f.id}`}>{f.original_name}</a>{' '}
                  <span class="mut">
                    · {dateDe(f.created_at.toISOString().slice(0, 10))} · {f.uploaded_by} – noch nicht übernommen
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
        <div class="kpis">
          <div class="kpi">
            <div class="l">Zu prüfen</div>
            <div class="v">{all.filter((i) => i.status === 'erfasst').length}</div>
          </div>
          <div class="kpi">
            <div class="l">Freigegeben, offen</div>
            <div class="v">{euro(open.reduce((s, i) => s + i.gross_cents, 0n))}</div>
            <div class="s">
              <a href="/zahlungsliste">Zur Zahlungsliste →</a>
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
        {st === 'erwartet' ? (
          <ExpectedList rows={expected} />
        ) : (
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
        )}
      </>,
    );
  });

  EInvoiceRoutes({ app, deps, page, back } as Ctx);

  app.post('/rechnungseingang/erwartet/keine', async (c) => {
    const b = await c.req.parseBody();
    await skipExpected(
      sql,
      String(b.auftrag ?? ''),
      String(b.monat ?? ''),
      String(b.grund ?? ''),
      c.get('actor'),
    );
    return back(c, '/rechnungseingang?status=erwartet', {
      ok: 'Vermerkt: für diesen Zeitraum kommt keine Rechnung.',
    });
  });

  app.get(`/rechnungseingang/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [i, suppliers, sites, orders, files, subcontracts, allocations, targets] = await Promise.all([
      getIncoming(sql, id),
      listSuppliers(sql),
      listSites(sql),
      listOrders(sql, { status: ['bestellt', 'geliefert'] }),
      listFiles(sql, { type: 'incoming_invoice', id }),
      listSubcontracts(sql).then((l) => l.filter((x) => x.status === 'erteilt' || x.status === 'beendet')),
      getAllocations(sql, id),
      costTargets(sql),
    ]);
    const q = c.req.query();
    // Zuordnung zu NU-Aufträgen: gespeicherte Zeilen oder aus „Rechnung erwartet“ (?erwartet=<auftrag>:<JJJJ-MM>:<cent>)
    const linkRows = i
      ? (await linksOf(sql, id)).map((l) => ({
          sc: l.subcontract_id,
          m: l.m,
          net: l.net_cents != null ? centsToInput(l.net_cents) : '',
        }))
      : (c.req
          .queries('erwartet')
          ?.map((x) => x.split(':'))
          .filter((p) => /^[0-9a-f-]{36}$/.test(p[0] ?? '') && isMonth(p[1]))
          .map((p) => ({
            sc: p[0]!,
            m: p[1]!,
            net: p[2] && /^\d+$/.test(p[2]) ? centsToInput(BigInt(p[2])) : '',
          })) ?? []);
    const preNet =
      !i && linkRows.length && linkRows.every((r) => r.net)
        ? linkRows.reduce(
            (a, r) => a + BigInt(Math.round(Number(r.net.replace(/\./g, '').replace(',', '.')) * 100)),
            0n,
          )
        : null;
    const editable = !i || i.status === 'erfasst';
    const po = q.bestellung ? orders.find((o) => o.id === q.bestellung) : undefined;
    const v = {
      supplier: i?.supplier_id ?? q.lieferant ?? '',
      site: i?.site_id ?? po?.site_id ?? '',
      po: i?.purchase_order_id ?? po?.id ?? '',
      net: i
        ? centsToInput(i.net_cents)
        : po
          ? centsToInput(po.net_cents)
          : preNet != null
            ? centsToInput(preNet)
            : '',
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
        {i?.einvoice && (
          <details class="card">
            <summary>
              <b>E-Rechnung</b>{' '}
              <span class="small mut">
                {i.einvoice.fromPdf ? 'ZUGFeRD/Factur-X' : `XRechnung ${i.einvoice.syntax}`} ·{' '}
                {i.einvoice.lines.length} Positionen
                {i.einvoice.periodStart &&
                  ` · Leistung ${dateDe(i.einvoice.periodStart)} – ${i.einvoice.periodEnd ? dateDe(i.einvoice.periodEnd) : ''}`}
                {i.einvoice.paymentReference && ` · Verwendungszweck ${i.einvoice.paymentReference}`}
              </span>{' '}
              {i.einvoice_file_id && (
                <a href={`/dateien/${i.einvoice_file_id}`} target="_blank" class="small">
                  Originaldatei
                </a>
              )}
            </summary>
            {i.einvoice.warnings.length > 0 && (
              <div class="flash warn">
                <span>{i.einvoice.warnings.join(' · ')}</span>
              </div>
            )}
            <EInvoiceTable lines={i.einvoice.lines} vat={i.einvoice.vat} />
          </details>
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
                <div class="chk">
                  <input type="checkbox" id="own-due" data-reveal="#due-box" checked={!!i?.due_date} />
                  <label for="own-due">Abweichendes Fälligkeitsdatum (sonst laut Zahlungsziel)</label>
                </div>
                <div id="due-box" hidden={!i?.due_date}>
                  <label for="due_date">fällig am</label>
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
                    <SiteOptions sites={sites} selected={v.site} />
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
                <div class="full nu-links" style="grid-column:1/-1">
                  <label>
                    Nachunternehmer-Aufträge (setzt Objekt; mehrere Zeilen = eine Rechnung für mehrere
                    Objekte/Monate)
                  </label>
                  <table class="tbl-in" style="width:100%">
                    <thead>
                      <tr>
                        <th style="text-align:left">Auftrag</th>
                        <th style="text-align:left;width:150px">Zeitraum ab</th>
                        <th style="text-align:right;width:130px">netto (optional)</th>
                      </tr>
                    </thead>
                    <tbody data-nu-rows>
                      {[...linkRows, { sc: '', m: '', net: '' }].map((r) => (
                        <tr>
                          <td>
                            <select
                              name="link_sc"
                              disabled={dis}
                              aria-label="Nachunternehmer-Auftrag"
                              data-nosearch
                            >
                              <option value="">–</option>
                              {subcontracts.map((x) => (
                                <option value={x.id} selected={x.id === r.sc}>
                                  {x.number} · {x.supplier_name} · {x.site_name ?? 'ohne Objekt'}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="month"
                              name="link_month"
                              value={r.m}
                              disabled={dis}
                              aria-label="Zeitraum ab"
                            />
                          </td>
                          <td>
                            <input
                              name="link_net"
                              value={r.net}
                              disabled={dis}
                              inputmode="decimal"
                              placeholder="0,00"
                              style="text-align:right"
                              aria-label="Anteil netto"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!dis && (
                    <button type="button" class="btn sm sec" data-nu-add style="margin-top:6px">
                      + weitere Zeile
                    </button>
                  )}
                  <p class="small mut" style="margin:4px 0 0">
                    Damit verschwindet die Rechnung aus „Rechnung erwartet“. Beträge je Zeile (Summe = netto)
                    verteilen die Kosten automatisch auf die Objekte (Kostenstellen).
                  </p>
                  <script
                    dangerouslySetInnerHTML={{
                      __html: `(function(){var b=document.querySelector('[data-nu-add]');if(!b)return;b.addEventListener('click',function(){var t=document.querySelector('[data-nu-rows]');var r=t.lastElementChild.cloneNode(true);r.querySelectorAll('input').forEach(function(i){i.value=''});r.querySelector('select').value='';t.appendChild(r);});})();`,
                    }}
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
        {i && (
          <div class="card">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <h3 style="margin:0">Kostenstellen (Nachkalkulation)</h3>
              <span
                class={`badge ${allocations.reduce((a, x) => a + x.net_cents, 0n) === i.net_cents ? 'ok' : 'warn'}`}
              >
                zugeordnet {euro(allocations.reduce((a, x) => a + x.net_cents, 0n))} von {euro(i.net_cents)}{' '}
                netto
              </span>
              {allocations.length > 0 && allocations.every((a) => a.auto) && (
                <span class="small mut">automatisch aus Objekt und Leistungsmonat</span>
              )}
            </div>
            <form method="post" action={`/rechnungseingang/${id}/aufteilung`} style="margin-top:12px">
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Kostenstelle</th>
                      <th>Leistungsmonat</th>
                      <th class="r">Netto €</th>
                      <th>Notiz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...allocations, ...Array.from({ length: 3 }, () => null)].map((a) => (
                      <tr>
                        <td>
                          <select name="target" aria-label="Kostenstelle" style="min-width:240px">
                            <option value="">–</option>
                            {(['Objekte', 'Allgemein'] as const).map((g) => (
                              <optgroup label={g}>
                                {targets
                                  .filter((t) => t.group === g)
                                  .map((t) => (
                                    <option
                                      value={t.value}
                                      selected={
                                        !!a &&
                                        (t.value === `site:${a.site_id}` ||
                                          t.value === `cc:${a.cost_center_id}`)
                                      }
                                    >
                                      {t.label}
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="month"
                            name="month"
                            value={a ? a.month.slice(0, 7) : (i.service_month ?? i.invoice_date).slice(0, 7)}
                            aria-label="Monat"
                          />
                        </td>
                        <td>
                          <input
                            name="net"
                            inputmode="decimal"
                            value={a ? centsToInput(a.net_cents) : ''}
                            aria-label="Netto"
                            style="max-width:130px;text-align:right"
                          />
                        </td>
                        <td>
                          <input name="note" value={a?.note ?? ''} aria-label="Notiz" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div class="actions" style="margin-bottom:0">
                <button class="btn sm">Aufteilung speichern</button>
                <span class="small mut">
                  Summe muss dem Nettobetrag entsprechen. Leere Zeilen werden ignoriert.
                </span>
              </div>
            </form>
            <form
              method="post"
              action={`/rechnungseingang/${id}/aufteilung/verteilen`}
              class="actions"
              style="border-top:1px solid var(--line);padding-top:12px"
            >
              <b class="small">Gleichmäßig auf Monate verteilen</b>
              <select name="target" required aria-label="Kostenstelle" style="max-width:260px">
                {targets.map((t) => (
                  <option value={t.value} selected={t.value === `site:${i.site_id}`}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input
                type="month"
                name="from"
                required
                value={(i.service_month ?? i.invoice_date).slice(0, 7)}
                aria-label="ab Monat"
                style="max-width:160px"
              />
              <input
                type="number"
                name="months"
                min={1}
                max={36}
                value="12"
                aria-label="Anzahl Monate"
                style="max-width:90px"
              />
              <span class="small mut">Monate (z. B. Jahresversicherung)</span>
              <button class="btn sec sm">Verteilen</button>
            </form>
          </div>
        )}
      </>,
    );
  });

  app.post(`/rechnungseingang/:id{${UUID}}/aufteilung`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const t = arr(b, 'target');
    const m = arr(b, 'month');
    const n = arr(b, 'net');
    const notes = arr(b, 'note');
    try {
      const rows = t
        .map((target, k) => ({
          target,
          month: m[k] ?? '',
          netRaw: (n[k] ?? '').trim(),
          note: notes[k] ?? null,
        }))
        .filter((r) => r.target && r.netRaw)
        .map((r) => ({ target: r.target, month: r.month, net: parseEuro(r.netRaw) as bigint, note: r.note }));
      await saveAllocations(sql, id, rows, c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/rechnungseingang/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/rechnungseingang/${id}`, { ok: 'Aufteilung gespeichert.' });
  });

  app.post(`/rechnungseingang/:id{${UUID}}/aufteilung/verteilen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      const i = await getIncoming(sql, id);
      if (!i) throw new BusinessError('Rechnung nicht gefunden');
      const months = Math.trunc(Number(b.months ?? 0));
      const from = String(b.from ?? '');
      if (!(months >= 1 && months <= 36) || !/^\d{4}-\d{2}$/.test(from))
        throw new BusinessError('Bitte Startmonat und 1–36 Monate angeben');
      const parts = splitEvenly(i.net_cents, months);
      await saveAllocations(
        sql,
        id,
        parts.map((net, k) => ({
          target: String(b.target ?? ''),
          month: addMonths(from, k),
          net,
          note: `${k + 1}/${months}`,
        })),
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/rechnungseingang/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/rechnungseingang/${id}`, { ok: 'Auf Monate verteilt.' });
  });

  app.post(`/rechnungseingang/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const many = (k: string) =>
      (Array.isArray(b[k]) ? (b[k] as unknown[]) : b[k] == null ? [] : [b[k]]).map((x) =>
        typeof x === 'string' ? x.trim() : '',
      );
    const scs = many('link_sc');
    const months = many('link_month');
    const nets = many('link_net');
    const links = scs
      .map((sc, k) => ({ sc, m: months[k] ?? '', n: nets[k] ?? '' }))
      .filter((r) => r.sc)
      .map((r) => {
        if (!isMonth(r.m)) throw new BusinessError('Bitte je Auftragszeile den Zeitraum (Monat) angeben');
        return {
          subcontractId: r.sc,
          month: r.m,
          net: r.n ? (money(r.n, 'Betrag je Auftrag') as bigint) : null,
        };
      });
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
        subcontractId: null,
        links,
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

  // Alter SEPA-Zahlungslauf → Zahlungsliste (frühere Läufe bleiben unter /zahlungslauf/<id> abrufbar)
  app.get('/zahlungslauf', (c) => c.redirect('/zahlungsliste'));

  app.get('/zahlungsliste', async (c) => {
    const today = todayBerlin();
    const pay = isDate(c.req.query('datum')) ? c.req.query('datum')! : today;
    const [list, crit, seller, runs, recent] = await Promise.all([
      paymentList(sql, pay),
      criticalSupplierIds(sql),
      getSeller(sql),
      listPaymentRuns(sql),
      sql<
        {
          id: string;
          invoice_no: string;
          supplier_name: string;
          paid_at: string;
          paid_amount_cents: bigint;
          paid_skonto_cents: bigint;
          paid_method: PaidMethod | null;
          run: boolean;
        }[]
      >`
        select i.id, i.invoice_no, s.name as supplier_name, i.paid_at, coalesce(i.paid_amount_cents, it.amount_cents) as paid_amount_cents,
               coalesce(it.skonto_cents, i.paid_skonto_cents) as paid_skonto_cents, i.paid_method, it.run_id is not null as run
          from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
          left join app.payment_run_items it on it.incoming_invoice_id = i.id
         where i.status = 'bezahlt' and i.paid_at >= ${addDays(today, -60)}
         order by i.paid_at desc, i.invoice_no limit 50`,
    ]);
    const sum = list.reduce((a, p) => a + p.amount, 0n);
    const dueSoon = list.filter((p) => p.invoice.due_date <= addDays(pay, 7) || p.skonto > 0n);
    return page(
      c,
      'Zahlungsliste',
      'lieferanten',
      <>
        <PageHead title="Rechnungseingang" crumbs={[['Rechnungseingang', '/rechnungseingang']]}>
          <a class="btn sec" href={`/zahlungsliste.csv?datum=${pay}`} style="margin-left:auto">
            CSV
          </a>
          <button class="btn sec" type="button" onclick="window.print()">
            Drucken
          </button>
        </PageHead>
        <Tabs tabs={incomingTabs(await listIncoming(sql))} active="zahlung" />
        <div class="kpis">
          <div class="kpi">
            <div class="l">offen (freigegeben)</div>
            <div class="v">{euro(sum)}</div>
            <div class="s">{list.length} Rechnungen</div>
          </div>
          <div class="kpi">
            <div class="l">fällig in 7 Tagen / mit Skonto</div>
            <div class="v" style="color:var(--warn)">
              {euro(dueSoon.reduce((a, p) => a + p.amount, 0n))}
            </div>
            <div class="s">{dueSoon.length} Rechnungen</div>
          </div>
          <div class="kpi">
            <div class="l">Skonto möglich bei Zahlung am {dateDe(pay)}</div>
            <div class="v" style="color:var(--ok)">
              {euro(list.reduce((a, p) => a + p.skonto, 0n))}
            </div>
          </div>
        </div>
        <form method="post" action="/zahlungsliste" class="card">
          <div class="actions" style="margin-top:0">
            <label for="datum" style="margin:0">
              Zahlung am
            </label>
            <input
              id="datum"
              type="date"
              name="datum"
              value={pay}
              max={today}
              style="max-width:170px"
              onchange="location.href='/zahlungsliste?datum='+this.value"
            />
            <span class="small mut">Skonto und Zahlbetrag gelten für diesen Tag.</span>
            <span style="margin-left:auto;font-weight:600" id="sel-sum"></span>
          </div>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="alle"
                      onchange="document.querySelectorAll('input[name=invoice]').forEach(function(x){x.checked=this.checked}.bind(this));window.vdSum()"
                    />
                  </th>
                  <th>Lieferant</th>
                  <th>Rechnung</th>
                  <th>fällig</th>
                  <th>Skonto bis</th>
                  <th class="r">Brutto</th>
                  <th class="r">Skonto</th>
                  <th class="r">Zahlbetrag</th>
                  <th>IBAN / Verwendungszweck</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => {
                  const blocked = crit.has(p.invoice.supplier_id);
                  return (
                    <tr>
                      <td>
                        <input
                          type="checkbox"
                          name="invoice"
                          value={p.invoice.id}
                          data-amount={String(p.amount)}
                          checked={(p.invoice.due_date <= addDays(pay, 7) || p.skonto > 0n) && !blocked}
                          aria-label="auswählen"
                          onchange="window.vdSum()"
                        />
                      </td>
                      <td>
                        {p.invoice.supplier_name}
                        {blocked && (
                          <div class="small" style="color:var(--err)">
                            Nachweise fehlen – Zahlung zurückhalten?{' '}
                            <a href={`/lieferanten/${p.invoice.supplier_id}/nachweise`}>prüfen</a>
                          </div>
                        )}
                      </td>
                      <td>
                        <a href={`/rechnungseingang/${p.invoice.id}`}>{p.invoice.invoice_no}</a>
                      </td>
                      <td style={p.invoice.due_date < today ? 'color:var(--err);font-weight:600' : ''}>
                        {dateDe(p.invoice.due_date)}
                      </td>
                      <td>{p.invoice.skonto_until ? dateDe(p.invoice.skonto_until) : '–'}</td>
                      <td class="r">{euro(p.invoice.gross_cents)}</td>
                      <td class="r">{p.skonto > 0n ? `− ${euro(p.skonto)}` : '–'}</td>
                      <td class="r">
                        <b>{euro(p.amount)}</b>
                      </td>
                      <td class="small">
                        {p.invoice.iban ? (
                          <code style="user-select:all">
                            {p.invoice.iban.replace(/(.{4})/g, '$1 ').trim()}
                          </code>
                        ) : (
                          <span style="color:var(--err)">IBAN fehlt</span>
                        )}
                        <div class="mut" style="user-select:all">
                          Rechnung {p.invoice.invoice_no}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!list.length && (
                  <tr>
                    <td colspan={9}>
                      <div class="empty">
                        Keine freigegebenen Rechnungen offen.{' '}
                        <a href="/rechnungseingang">Zum Rechnungseingang</a>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div class="formfoot" style="flex-wrap:wrap;justify-content:flex-start;gap:10px">
            <span style="font-weight:600">Ausgewählte als bezahlt festhalten:</span>
            <select name="zahlart" aria-label="Zahlart" style="max-width:170px">
              {(Object.keys(PAID_METHOD) as PaidMethod[]).map((m) => (
                <option value={m}>{PAID_METHOD[m]}</option>
              ))}
            </select>
            <label class="chk" style="margin:0">
              <input type="checkbox" name="skonto" value="1" checked /> Skonto gezogen
            </label>
            <input name="notiz" placeholder="Notiz (optional)" style="max-width:220px" />
            <button
              class="btn"
              style="margin-left:auto"
              disabled={!list.length}
              onclick="return confirm('Ausgewählte Rechnungen als bezahlt festhalten?')"
            >
              Als bezahlt festhalten
            </button>
          </div>
          <div
            class="formfoot"
            style="flex-wrap:wrap;justify-content:flex-start;gap:10px;border-top:0;padding-top:0"
          >
            <span style="font-weight:600">oder SEPA-Datei für die Bank:</span>
            <input type="hidden" name="run_id" value={randomUUID()} />
            <label for="ausfuehrung" class="small" style="margin:0">
              Ausführung am
            </label>
            <input
              id="ausfuehrung"
              type="date"
              name="ausfuehrung"
              value={today}
              min={today}
              style="max-width:170px"
            />
            <select name="konto" aria-label="von Konto" style="max-width:260px">
              {seller.bankAccounts.map((a) => (
                <option value={a.iban}>
                  {a.name} · …{a.iban.replace(/\s/g, '').slice(-4)}
                </option>
              ))}
            </select>
            <button
              class="btn sec"
              style="margin-left:auto"
              formaction="/zahlungsliste/sepa"
              disabled={!list.length}
              onclick="return confirm('SEPA-Datei für die ausgewählten Rechnungen erstellen? Die Rechnungen gelten danach als bezahlt.')"
            >
              <Icon name="download" /> SEPA-Datei erstellen
            </button>
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: `window.vdSum=function(){var t=0,n=0;document.querySelectorAll('input[name=invoice]:checked').forEach(function(x){t+=Number(x.dataset.amount);n++});document.getElementById('sel-sum').textContent=n?('Ausgewählt: '+n+' · '+(t/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'})):'';};window.vdSum();`,
            }}
          />
        </form>
        <p class="small mut">
          Entweder im Online-Banking einzeln überweisen (IBAN und Verwendungszweck zum Kopieren) und hier
          festhalten, oder eine SEPA-Datei (pain.001) erstellen und im Online-Banking hochladen – die
          Rechnungen sind dann als bezahlt gebucht. Zahlungen gehen in den DATEV-Export. Skonto mindert die
          Vorsteuer (§ 17 UStG), Buchung übernimmt der Steuerberater.
        </p>
        {runs.length > 0 && (
          <div class="card">
            <h3>SEPA-Dateien</h3>
            <div class="list">
              {runs.slice(0, 10).map((r) => (
                <div class="row">
                  <span class="dot ok" />
                  <div class="main">
                    <a href={`/zahlungslauf/${r.id}`}>
                      <b style="color:var(--ink)">{r.number}</b>
                    </a>
                    <div class="small mut">
                      Ausführung {dateDe(r.execution_date)} · {r.item_count} Überweisungen · {r.created_by}
                    </div>
                  </div>
                  <div class="side">
                    <span class="when">{euro(r.total_cents)}</span>
                    <a class="btn ghost sm" href={`/zahlungslauf/${r.id}/sepa.xml`}>
                      XML
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div class="card">
          <h3>Zuletzt bezahlt (60 Tage)</h3>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>bezahlt am</th>
                  <th>Lieferant</th>
                  <th>Rechnung</th>
                  <th class="r">Betrag</th>
                  <th class="r">Skonto</th>
                  <th>Zahlart</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr>
                    <td>{dateDe(r.paid_at)}</td>
                    <td>{r.supplier_name}</td>
                    <td>
                      <a href={`/rechnungseingang/${r.id}`}>{r.invoice_no}</a>
                    </td>
                    <td class="r">{r.paid_amount_cents !== null ? euro(r.paid_amount_cents) : '–'}</td>
                    <td class="r">{r.paid_skonto_cents ? euro(r.paid_skonto_cents) : '–'}</td>
                    <td>{r.run ? 'SEPA-Zahlungslauf' : r.paid_method ? PAID_METHOD[r.paid_method] : '–'}</td>
                    <td class="r">
                      {!r.run && (
                        <form method="post" action={`/zahlungsliste/${r.id}/zuruecknehmen`} style="margin:0">
                          <button
                            class="btn ghost sm"
                            onclick="return confirm('Zahlung zurücknehmen? Die Rechnung ist dann wieder offen.')"
                          >
                            zurücknehmen
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
                {!recent.length && (
                  <tr>
                    <td colspan={7} class="mut">
                      Noch nichts bezahlt.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>,
    );
  });

  app.post('/zahlungsliste', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const date = str(b, 'datum') ?? '';
    try {
      const n = await markPaid(
        sql,
        {
          ids: arr(b, 'invoice'),
          date,
          method: (str(b, 'zahlart') ?? 'ueberweisung') as PaidMethod,
          note: str(b, 'notiz'),
          skonto: str(b, 'skonto') === '1',
        },
        c.get('actor'),
      );
      return back(c, `/zahlungsliste?datum=${date}`, { ok: `${n} Rechnung(en) als bezahlt festgehalten.` });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/zahlungsliste?datum=${date}`, { fehler: e.message });
      throw e;
    }
  });

  app.post('/zahlungsliste/sepa', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const date = str(b, 'ausfuehrung') ?? '';
    const runId = str(b, 'run_id') ?? '';
    if (!new RegExp(`^${UUID}$`).test(runId))
      return back(c, '/zahlungsliste', { fehler: 'Bitte Seite neu laden' });
    try {
      await createPaymentRun(deps, {
        id: runId,
        invoiceIds: arr(b, 'invoice'),
        executionDate: date,
        debtorIban: str(b, 'konto') ?? '',
        actor: c.get('actor'),
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/zahlungsliste', { fehler: e.message });
      throw e;
    }
    return back(c, `/zahlungslauf/${runId}`, {
      ok: 'SEPA-Datei erstellt – jetzt herunterladen und im Online-Banking hochladen.',
    });
  });

  app.post(`/zahlungsliste/:id{${UUID}}/zuruecknehmen`, async (c) => {
    try {
      await undoPaid(sql, c.req.param('id'), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/zahlungsliste', { fehler: e.message });
      throw e;
    }
    return back(c, '/zahlungsliste', { ok: 'Zahlung zurückgenommen.' });
  });

  app.get('/zahlungsliste.csv', async (c) => {
    const pay = isDate(c.req.query('datum')) ? c.req.query('datum')! : todayBerlin();
    const list = await paymentList(sql, pay);
    const csv = toCsv(
      [
        'Lieferant',
        'Rechnung',
        'Rechnungsdatum',
        'fällig',
        'Skonto bis',
        'Brutto',
        'Skonto',
        'Zahlbetrag',
        'IBAN',
        'Verwendungszweck',
      ],
      list.map((p) => [
        p.invoice.supplier_name,
        p.invoice.invoice_no,
        p.invoice.invoice_date,
        p.invoice.due_date,
        p.invoice.skonto_until ?? '',
        (Number(p.invoice.gross_cents) / 100).toFixed(2).replace('.', ','),
        (Number(p.skonto) / 100).toFixed(2).replace('.', ','),
        (Number(p.amount) / 100).toFixed(2).replace('.', ','),
        p.invoice.iban ?? '',
        `Rechnung ${p.invoice.invoice_no}`,
      ]),
    );
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Zahlungsliste_${pay}.csv"`,
        'Cache-Control': 'private, no-store',
      },
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
        <PageHead title={`Zahlungslauf ${run.number}`} crumbs={[['Zahlungsliste', '/zahlungsliste']]} />
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
              <label for="overhead_minijob">Lohnzuschlag Minijob %</label>
              <input
                id="overhead_minijob"
                name="overhead_minijob"
                value={String(s.overhead_minijob_bp / 100).replace('.', ',')}
              />
            </div>
            <div>
              <label for="overhead_parttime">Lohnzuschlag Teilzeit bis 30 Std./Woche %</label>
              <input
                id="overhead_parttime"
                name="overhead_parttime"
                value={String(s.overhead_parttime_bp / 100).replace('.', ',')}
              />
            </div>
            <div>
              <label for="overhead_fulltime">Lohnzuschlag über 30 Std./Woche %</label>
              <input
                id="overhead_fulltime"
                name="overhead_fulltime"
                value={String(s.overhead_fulltime_bp / 100).replace('.', ',')}
              />
              <p class="small mut">
                Zuschlag auf den Stundenlohn für AG-Anteile, Urlaub, Krankheit, Feiertage. Minijob =
                Beschäftigungsart Minijob; ohne Wochenstunden zählt Vollzeit als über 30 Std.
              </p>
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
        overhead_minijob_bp: pct('overhead_minijob'),
        overhead_parttime_bp: pct('overhead_parttime'),
        overhead_fulltime_bp: pct('overhead_fulltime'),
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
    const { rows, overhead, targetBp } = await siteCosting(sql, month);
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
        <PageHead title="Nachkalkulation je Objekt" crumbs={[['Auswertungen', '/auswertungen']]} />
        <form method="get" action="/auswertungen/nachkalkulation" class="actions" style="margin-top:0">
          <input
            type="month"
            name="monat"
            value={month}
            style="max-width:200px"
            onchange="this.form.submit()"
          />
          <span class="small mut">
            Lohnkosten = Ist-Stunden × Stundenlohn + Zuschlag (Minijob {pct(overhead.minijob)}, Teilzeit{' '}
            {pct(overhead.parttime)}, über 30 Std. {pct(overhead.fulltime)}) · Ziel-Deckungsbeitrag{' '}
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
