import { sammelSqmCenti, sammelSummaries, sammelTotals } from '../services/subcontract-sites.js';
import { hoursOfMonth } from '../services/subcontract-hours.js';
import { costCenterReport } from '../services/cost-centers.js';
import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import { dayAmounts, workDaysLabel } from '../services/subcontract-days.js';
import {
  billingTracking,
  subcontractTodo,
  type ExpectedRow,
  expectedInvoices,
  isRecurringOrder,
  linksOf,
  skipExpected,
} from '../services/expected-invoices.js';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, parseEuro, parseQuantity } from '../domain/money/money.js';
import { addDays } from '../domain/time/holidays.js';
import { siteCostDetails, siteCosting } from '../services/costing.js';
import { getPlanCostRates, planCosting, savePlanCostRates } from '../services/plan-costing.js';
import { PAY_BAND_LABEL } from '../domain/hr/employer-cost.js';
import {
  buildExtf,
  collectBookings,
  encodeCp1252,
  getAccountingSettings,
  saveAccountingSettings,
} from '../services/datev.js';
import {
  ADVANCE_METHOD,
  listAllAdvances,
  offsetAdvance,
  openAdvances,
  undoOffsets,
} from '../services/advances.js';
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
  markPaidDirect,
  DIRECT_PAID_METHODS,
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
  deleteOrder,
} from '../services/purchasing.js';
import { hm } from '../services/time.js';
import { toCsv } from '../services/reports.js';
import { listFiles } from '../services/uploads.js';
import { planCostingPdf, siteCostingPdf } from '../services/costing-pdf.js';
import { EInvoiceRoutes, EInvoiceTable } from './routes-einvoice-in.js';
import { pendingEInvoices } from '../services/einvoice-inbox.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import {
  criticalSupplierIds,
  deleteSubcontract,
  listSubcontracts,
  SC_STATUS,
  subcontractTotal,
  unsignedSubcontractsPdf,
} from '../services/subcontractors.js';
import {
  addMonths,
  costTargets,
  getAllocations,
  saveAllocations,
  splitEvenly,
} from '../services/cost-centers.js';
import { arr, centsToInput, milliToInput, str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, Pager, type Tab, Tabs, dateDe, euro, anz } from './layout.js';

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

/** Monatsauswahl als eine Liste „Oktober 2026“ (24 Monate zurück, 3 voraus) statt Monat/Jahr-Feldern. */
const MonthSelect: FC<{
  id?: string;
  name: string;
  value: string;
  label: string;
  disabled?: boolean;
  autosubmit?: boolean;
  /** auch die nächsten 15 Monate (Plan-Kalkulation) */
  future?: boolean;
}> = ({ id, name, value, label, disabled, autosubmit, future }) => {
  const now = todayBerlin().slice(0, 7);
  const add = (m: string, n: number) => {
    const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  };
  const months: string[] = [];
  for (let i = future ? 15 : 3; i >= -24; i--) months.push(add(now, i));
  if (value && !months.includes(value)) months.push(value);
  return (
    <select
      id={id}
      name={name}
      aria-label={label}
      disabled={disabled}
      data-nosearch
      data-autosubmit={autosubmit ? '1' : undefined}
    >
      <option value="">{autosubmit ? 'Monat wählen …' : '–'}</option>
      {months.map((m) => (
        <option value={m} selected={m === value}>
          {MONTHS_DE[Number(m.slice(5, 7)) - 1]} {m.slice(0, 4)}
        </option>
      ))}
    </select>
  );
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
      <form id="exp-bulk" method="post" action="/rechnungseingang/erwartet/auswahl" class="card exp-bulk">
        <label style="display:flex;gap:6px;align-items:center;margin:0;font-weight:600">
          <input type="checkbox" data-exp-all /> alle {rows.length} markieren
        </label>
        <input
          name="grund"
          required
          value="bereits bezahlt (vor der Umstellung)"
          aria-label="Vermerk"
          style="flex:1;min-width:220px"
        />
        <button class="btn" data-exp-btn disabled>
          Markierte als erledigt vermerken (<span data-exp-n>0</span>)
        </button>
      </form>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var f=document.getElementById('exp-bulk');function boxes(sel){return document.querySelectorAll('input[form=exp-bulk][name=sel]'+(sel||''))}function upd(){var n=0;boxes().forEach(function(b){if(b.checked)n++});f.querySelector('[data-exp-n]').textContent=n;f.querySelector('[data-exp-btn]').disabled=!n;var all=f.querySelector('[data-exp-all]');all.checked=n>0&&n===boxes().length;document.querySelectorAll('[data-exp-sup]').forEach(function(g){var l=boxes('[data-sup="'+g.getAttribute('data-exp-sup')+'"]');g.checked=l.length>0&&[].every.call(l,function(x){return x.checked})})}document.addEventListener('change',function(e){var t=e.target;if(t.matches('[data-exp-all]'))boxes().forEach(function(b){b.checked=t.checked});else if(t.matches('[data-exp-sup]'))boxes('[data-sup="'+t.getAttribute('data-exp-sup')+'"]').forEach(function(b){b.checked=t.checked});if(t.matches('[data-exp-all],[data-exp-sup],input[form=exp-bulk]'))upd()});upd()})();`,
        }}
      />
      <p class="small mut" style="margin-top:0">
        Bereits bezahlte bzw. erledigte Zeiträume (z. B. vor der Umstellung abgerechnet) ankreuzen und oben
        als erledigt vermerken – sie verschwinden aus der Liste, der Vermerk steht in der Bestellung unter
        „Abrechnung“. Je laufendem Nachunternehmer-Auftrag wird je abgelaufenem Abrechnungszeitraum eine
        Rechnung erwartet. Sie verschwindet, sobald eine Eingangsrechnung den Auftrag und Zeitraum abdeckt –
        eine Rechnung darf mehrere Aufträge/Objekte abdecken (z. B. Glasreinigung). Rückblick 12 Monate.
      </p>
      {[...bySup.values()].map((list) => {
        const s0 = list[0]!;
        return (
          <details class="card exp-sup" style="margin-bottom:10px">
            <summary class="actions" style="margin:0;cursor:pointer;list-style:none">
              <h3 style="margin:0">
                <input
                  type="checkbox"
                  data-exp-sup={s0.supplier_id}
                  aria-label={`alle von ${s0.supplier_name}`}
                  style="margin-right:6px"
                />
                <a href={`/lieferanten/${s0.supplier_id}`}>{s0.supplier_name}</a>{' '}
                <span class="badge warn">{list.length} erwartet</span>
                {list.some((r) => r.expectedNet != null) && (
                  <span class="small mut" style="font-weight:400;margin-left:8px">
                    ≈ {euro(list.reduce((a, r) => a + (r.expectedNet ?? 0n), 0n))} netto
                  </span>
                )}
                <span class="small mut exp-tog" style="font-weight:400;margin-left:8px">
                  Zeiträume anzeigen
                </span>
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
            </summary>
            <div class="tbl">
              <table class="stack-m">
                <thead>
                  <tr>
                    <th style="width:28px"></th>
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
                      <td>
                        <input
                          type="checkbox"
                          form="exp-bulk"
                          name="sel"
                          value={`${r.subcontract_id}|${r.period}`}
                          data-sup={r.supplier_id}
                          aria-label={`${r.number} ${r.period}`}
                        />
                      </td>
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
          </details>
        );
      })}
    </>
  );
};

// ---- Nach-/Plan-Kalkulation: Objektleitungs-Filter und PDF-Export (Ahmed 23.10.)
const pdfResponse = (pdf: Uint8Array, name: string) =>
  new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, no-cache',
    },
  });
const MONTHS_LONG = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const calcPeriodLabel = (von: string, bis: string) => {
  const l = (m: string) => `${MONTHS_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  return von === bis ? l(von) : `${l(von)} – ${l(bis)}`;
};
type Manager = { user_id: string; name: string };
const filterLabel = (
  customer: string | undefined,
  site: { site_no: string; site_name: string } | undefined,
  ol: string,
  managers: Manager[],
  loss: boolean,
  redact: boolean,
) =>
  [
    customer && `Kunde: ${redact ? '(geschwärzt)' : customer}`,
    site && `Objekt: ${redact ? '(geschwärzt)' : `${site.site_no} ${site.site_name}`}`,
    ol &&
      `Objektleitung: ${ol === 'ohne' ? 'ohne' : redact ? '(geschwärzt)' : (managers.find((m) => m.user_id === ol)?.name ?? '')}`,
    loss && 'nur Verlust',
  ]
    .filter(Boolean)
    .join(' · ');
const OlSelect = ({ managers, value }: { managers: Manager[]; value: string }) => (
  <select name="ol" aria-label="Objektleitung" style="max-width:200px" data-nosearch>
    <option value="">Alle Objektleitungen</option>
    {managers.map((m) => (
      <option value={m.user_id} selected={m.user_id === value}>
        {m.name}
      </option>
    ))}
    <option value="ohne" selected={value === 'ohne'}>
      ohne Objektleitung
    </option>
  </select>
);
/** PDF mit den aktuellen Filtern, wahlweise mit geschwärzten Namen (Objekte, Kunden, Mitarbeitende) */
const PdfExport = ({ action, params }: { action: string; params: Record<string, string> }) => (
  <form method="get" action={action} target="_blank" class="actions" style="margin:-4px 0 12px" data-noback>
    {Object.entries(params)
      .filter(([, v]) => v)
      .map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
    <input type="hidden" name="pdf" value="1" />
    <button class="btn sec sm">PDF exportieren</button>
    <label class="small" style="margin:0;display:flex;gap:4px;align-items:center">
      <input type="checkbox" name="schwaerzen" value="1" /> Namen schwärzen (Objekte, Kunden, Mitarbeitende)
    </label>
  </form>
);

export function registerPurchasingRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const managersOf = async (ids: (string | null)[]): Promise<Manager[]> => {
    const u = [...new Set(ids.filter((x): x is string => !!x))];
    return u.length
      ? sql<
          Manager[]
        >`select user_id, name from app.manager_contacts where user_id = any(${u}::uuid[]) order by name`
      : [];
  };

  // ================================================================== Bestellungen

  // Bestellungen = Material-Bestellungen und Aufträge an Nachunternehmer in einer Liste (gleicher Nummernkreis
  // BE-JJJJ-NNNN), Aufbau wie im alten Portal: Filter-Pillen, Nachunternehmer-Auswahl, Suche, Tabelle.
  // Alle erteilten NU-Bestellungen ohne Unterschrift in einer PDF zum Drucken (Ahmed 20.10.)
  app.get('/bestellungen/ohne-unterschrift.pdf', async (c) => {
    const l = c.req.query('lieferant');
    try {
      const { pdf } = await unsignedSubcontractsPdf(
        sql,
        l && /^[0-9a-f-]{36}$/.test(l) ? { supplierId: l } : {},
      );
      return new Response(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="Bestellungen_ohne_Unterschrift.pdf"',
          'Cache-Control': 'private, no-cache',
        },
      });
    } catch (e) {
      if (!(e instanceof BusinessError)) throw e;
      return back(c, '/bestellungen', { fehler: e.message });
    }
  });

  app.get('/bestellungen', async (c) => {
    const q = c.req.query();
    const art = q.art === 'material' || q.art === 'nu' ? q.art : '';
    const view = ['erledigen', 'laufend', 'einmalig', 'abgeschlossen', 'alle'].includes(q.ansicht ?? '')
      ? q.ansicht!
      : 'erledigen';
    const supplierId = q.lieferant && /^[0-9a-f-]{36}$/.test(q.lieferant) ? q.lieferant : '';
    const search = (q.q ?? '').trim().toLowerCase();
    const onlyUnsigned = q.unterschrift === 'fehlt';
    const [orders, subcontracts, suppliers, billed] = await Promise.all([
      listOrders(sql),
      listSubcontracts(sql),
      sql<{ id: string; name: string; supplier_no: string }[]>`
        select id, name, supplier_no from app.suppliers where active order by name`,
      sql<{ id: string }[]>`
        select distinct purchase_order_id as id from app.incoming_invoices where purchase_order_id is not null`,
    ]);
    const invoiced = new Set(billed.map((b) => b.id));
    // Sammelbestellungen: Gesamtfläche + Zahl der Objekte
    const sqmMap = await sammelSqmCenti(
      sql,
      subcontracts.map((x) => x.id),
    );
    const perObjTotals = await sammelTotals(sql, subcontracts);
    const sammelInfo = await sammelSummaries(
      sql,
      subcontracts.map((x) => x.id),
    );
    const curMonth = todayBerlin().slice(0, 7);
    const hoursNow = await hoursOfMonth(
      sql,
      subcontracts.filter((x) => x.billing === 'stunde').map((x) => x.id),
      curMonth,
      subcontracts.filter((x) => !isRecurringOrder(x.frequency)).map((x) => x.id),
    );
    const daysNow = await dayAmounts(sql, subcontracts, curMonth);
    const tracking = await billingTracking(
      sql,
      subcontracts.map((x) => x.id),
      { limit: 13 },
    );
    const MON = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
    const billCell = (r: {
      kind: 'material' | 'nu';
      id: string;
      phase: string;
      from: string | null;
      status: string;
    }) => {
      if (r.kind === 'material') {
        if (r.phase === 'storniert') return null;
        return invoiced.has(r.id) ? (
          <span class="bs-pill bs-ok">Rechnung erfasst</span>
        ) : (
          <span class="small mut">noch keine Rechnung</span>
        );
      }
      const ps = tracking.get(r.id) ?? [];
      // Beginn in der Zukunft: noch kein Abrechnungszeitraum (Ahmed 22.10.: „bei genau den zwei fehlt es“)
      if (!ps.length)
        return r.phase === 'storniert' || /^(Entwurf|angefragt)/.test(r.status) ? null : (
          <span class="bs-pill bs-info">beginnt {dateDe(r.from)}</span>
        );
      const cur = ps[0]!;
      const open = ps.filter((p) => p.state === 'offen').length;
      const label =
        cur.state === 'abgerechnet'
          ? `${MON(cur.start)} abgerechnet`
          : cur.state === 'keine'
            ? `${MON(cur.start)} keine Rechnung`
            : cur.state === 'laufend'
              ? `${MON(cur.start)} läuft`
              : cur.state === 'bedarf'
                ? 'nach Ausführung'
                : `${MON(cur.start)} fehlt`;
      const tone =
        cur.state === 'abgerechnet' || cur.state === 'keine'
          ? 'ok'
          : cur.state === 'laufend' || cur.state === 'bedarf'
            ? 'info'
            : 'warn';
      return (
        <span>
          <span class={`bs-pill bs-${tone}`}>{label}</span>
          {open > (cur.state === 'offen' ? 1 : 0) ? (
            <span class="bs-sub" style="color:var(--bad)">
              {open} Zeitr. ohne Rechnung
            </span>
          ) : null}
        </span>
      );
    };
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
      /** erteilte NU-Bestellung ohne unterschriebenen Auftrag (Scan oder Handy-Unterschrift) */
      unsigned: boolean;
      /** wiederkehrend (monatlich/wöchentlich) */
      recurring?: boolean;
      /** erteilte NU-Bestellung mit Unterschrift → „erledigt“ möglich */
      canFinish: boolean;
      net: bigint | null;
      per: string;
      /** Einheitspreis unter dem Gesamtbetrag, z. B. „25,00 € / Std. × 40 Std.“ */
      unit?: string;
      phase: 'erledigen' | 'laufend' | 'einmalig' | 'abgeschlossen' | 'storniert';
      status: string;
      tone: string;
    };
    const PO_PHASE: Record<PoStatus, Row['phase']> = {
      entwurf: 'erledigen',
      bestellt: 'einmalig',
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
      qm: '/ m²',
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
        unsigned: false,
        canFinish: false,
        net: o.net_cents,
        per: '',
        // „zu erledigen“ nur Entwürfe (Ahmed 19.10.); fehlende Rechnungen stehen im Rechnungseingang
        phase: PO_PHASE[o.status],
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
        what: sammelInfo.get(sc.id)
          ? `Sammelbestellung (${sammelInfo.get(sc.id)!.n} Objekte): ${sammelInfo.get(sc.id)!.text} · ${sc.service_kind}`
          : `${sc.site_no} ${sc.site_name} · ${sc.service_kind}`,
        from: sc.valid_from,
        to: sc.valid_to,
        // laufend = regelmäßige (monatliche/wöchentliche) Bestellung; jährlich usw. = nach Ausführung (Ahmed 09.10.)
        ongoing: !sc.valid_to && isRecurringOrder(sc.frequency),
        unsigned: sc.status === 'erteilt' && !sc.signed_file_path && !sc.signed_external,
        recurring: isRecurringOrder(sc.frequency),
        canFinish: sc.status === 'erteilt' && !!(sc.signed_file_path || sc.signed_external),
        ...((): Pick<Row, 'net' | 'per' | 'unit'> => {
          // Gesamtbetrag zuerst, Einheitspreis darunter (Ahmed 18.10.)
          const total = subcontractTotal({
            ...sc,
            sqm_centi: sqmMap.get(sc.id) ?? null,
            sammel_total: perObjTotals.get(sc.id),
          });
          if (sc.billing === 'umsatz')
            return {
              net: null,
              per: '',
              unit: `${String((10000 - (sc.margin_bp ?? 0)) / 100).replace('.', ',')} % vom Umsatz`,
            };
          if (sc.billing === 'qm')
            return total !== null
              ? { net: total, per: '', unit: `${euro(sc.current_price_cents)} / m²` }
              : { net: sc.current_price_cents, per: '/ m²', unit: 'Flächen fehlen' };
          if (sc.billing === 'stunde') {
            // erfasste Stunden des laufenden Monats (Stundennachweis), max. nur als Hinweis (Ahmed 20.10.)
            const h = hoursNow.get(sc.id);
            const hrs = h ? (h.minutes / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '0';
            return {
              net: h?.amount ?? 0n,
              per: isRecurringOrder(sc.frequency) ? `erfasst ${MON(curMonth)}` : 'erfasst bisher',
              unit: `${hrs} Std. × ${euro(sc.current_price_cents)}${total !== null ? ` · max. ${euro(total)} (${sc.max_hours_month!.replace('.', ',')} Std.)` : ''}`,
            };
          }
          if (sc.billing === 'tag') {
            // Preis je Tag × Arbeitstage des laufenden Monats (Ahmed 22.10.)
            const d = daysNow.get(sc.id);
            return {
              net: d?.amount ?? 0n,
              per: MON(curMonth),
              unit: `${d?.days ?? 0} Tage (${workDaysLabel(sc.work_days)}) × ${euro(sc.current_price_cents)}`,
            };
          }
          return { net: total ?? sc.current_price_cents, per: PER[sc.billing] ?? '' };
        })(),
        ...((): Pick<Row, 'phase' | 'status' | 'tone'> => {
          // zu erledigen (Ahmed 19.10.): nur Entwurf oder unterschriebener Auftrag fehlt
          const todo = subcontractTodo({
            status: sc.status,
            signed: !!(sc.signed_file_path || sc.signed_external),
          });
          if (todo.length)
            return {
              phase: 'erledigen',
              status: `${SC_STATUS[sc.status] ?? sc.status} · ${todo.join(' · ')}`,
              tone: 'warn',
            };
          // Laufend = nur wiederkehrende (monatlich/wöchentlich), einmalige usw. eigener Reiter (Ahmed 22.10.)
          const ph = SC_PHASE[sc.status] ?? 'laufend';
          return {
            phase: ph === 'laufend' && !isRecurringOrder(sc.frequency) ? 'einmalig' : ph,
            status:
              sc.requested_by && sc.status === 'entwurf'
                ? 'angefragt (Objektleitung) · Freigabe nötig'
                : (SC_STATUS[sc.status] ?? sc.status),
            tone: sc.requested_by && sc.status === 'entwurf' ? 'warn' : (SC_TONE[sc.status] ?? ''),
          };
        })(),
      })),
    ].sort((x, y) => y.number.localeCompare(x.number, 'de', { numeric: true }));
    const base = all
      .filter((r) => !art || r.kind === art)
      .filter((r) => !supplierId || r.supplierId === supplierId)
      .filter((r) => !search || [r.number, r.supplier, r.what].some((v) => v.toLowerCase().includes(search)))
      .filter((r) => !onlyUnsigned || r.unsigned);
    const unsignedCount = all.filter((r) => r.unsigned).length;
    // Laufend/Einmalig = auch erteilte ohne Unterschrift (stehen zusätzlich unter „Zu erledigen“, Ahmed 22.10.)
    const inView = (r: (typeof base)[number], v: string) =>
      r.phase === v ||
      (r.phase === 'erledigen' &&
        r.unsigned &&
        ((v === 'laufend' && r.recurring) || (v === 'einmalig' && !r.recurring)));
    const count = (v: string) => (v === 'alle' ? base.length : base.filter((r) => inView(r, v)).length);
    const allRows = view === 'alle' ? base : base.filter((r) => inView(r, view));
    const PER_PAGE = 25;
    const pages = Math.max(1, Math.ceil(allRows.length / PER_PAGE));
    const cur = Math.min(pages, Math.max(1, Number(q.seite) || 1));
    const rows = allRows.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
    const link = (over: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const st: Record<string, string | null> = {
        ansicht: view === 'erledigen' ? null : view,
        art: art || null,
        lieferant: supplierId || null,
        q: search || null,
        unterschrift: onlyUnsigned ? 'fehlt' : null,
        ...over,
      };
      for (const [k, v] of Object.entries(st)) if (v) p.set(k, v);
      const str = p.toString();
      return `/bestellungen${str ? `?${str}` : ''}`;
    };
    const VIEWS: [string, string][] = [
      ['erledigen', 'Zu erledigen'],
      ['laufend', 'Laufend (monatlich)'],
      ['einmalig', 'Einmalig / offen'],
      ['abgeschlossen', 'Abgeschlossen'],
      ['alle', 'Alle'],
    ];
    const ARTS: [string, string][] = [
      ['', 'Alle'],
      ['nu', 'Nachunternehmer'],
      ['material', 'Material'],
    ];
    const ret = c.req.url.slice(c.req.url.indexOf('/bestellungen'));
    const period = (r: Row) =>
      r.kind === 'material'
        ? `bestellt ${dateDe(r.from)}${r.to ? ` · Lieferung ${dateDe(r.to)}` : ''}`
        : r.ongoing
          ? `ab ${dateDe(r.from)} · fortlaufend`
          : `${dateDe(r.from)} – ${dateDe(r.to ?? r.from)}`;
    return page(
      c,
      'Bestellungen',
      'lieferanten',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Einkauf</div>
            <h1>Bestellungen</h1>
            <div class="sub">Material und Aufträge an Nachunternehmer</div>
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
        <div class="ls-tabs">
          {VIEWS.map(([k, l]) => (
            <a
              class={view === k ? 'on' : ''}
              href={link({ ansicht: k === 'erledigen' ? null : k, unterschrift: null })}
            >
              {l} <span>{count(k)}</span>
            </a>
          ))}
        </div>
        <form class="ls-bar" method="get" action="/bestellungen">
          {view !== 'erledigen' && <input type="hidden" name="ansicht" value={view} />}
          {art && <input type="hidden" name="art" value={art} />}
          <div class="chips">
            {ARTS.map(([k, l]) => (
              <a class={art === k ? 'on' : ''} href={link({ art: k || null })}>
                {l}
              </a>
            ))}
          </div>
          <select
            name="lieferant"
            onchange="this.form.submit()"
            style="width:auto;max-width:260px"
            aria-label="Lieferant"
          >
            <option value="">Alle Lieferanten</option>
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
            placeholder="Nummer, Firma, Objekt …"
          />
          <span class="small mut ls-count">
            {allRows.length === 0
              ? 'keine Treffer'
              : `${(cur - 1) * PER_PAGE + 1}–${(cur - 1) * PER_PAGE + rows.length} von ${allRows.length}`}
          </span>
        </form>
        {(unsignedCount > 0 || onlyUnsigned) && (
          <div class="ls-hint">
            <b>{unsignedCount}</b> erteilte {unsignedCount === 1 ? 'Bestellung' : 'Bestellungen'} ohne
            unterschriebenen Auftrag –{' '}
            {onlyUnsigned ? (
              <a href="/bestellungen?ansicht=alle">alle zeigen</a>
            ) : (
              <a href="/bestellungen?ansicht=alle&unterschrift=fehlt">nur diese anzeigen</a>
            )}
            {unsignedCount > 0 && (
              <>
                {' · '}
                <a
                  class="btn sm sec"
                  href={`/bestellungen/ohne-unterschrift.pdf${supplierId ? `?lieferant=${supplierId}` : ''}`}
                  target="_blank"
                  style="margin-left:4px"
                >
                  <Icon name="file" size={14} /> Alle drucken (PDF)
                </a>
              </>
            )}
          </div>
        )}
        <form
          id="bs-del"
          method="post"
          action="/bestellungen/loeschen"
          class="actions bulkbar"
          style="margin:0 0 8px"
        >
          <input type="hidden" name="zurueck" value={ret} />
          <span class="small mut" />
          <button
            class="btn sm danger"
            data-confirm="Markierte Bestellungen endgültig löschen? Bestellungen mit Eingangsrechnung oder gebuchtem Wareneingang bleiben erhalten."
          >
            Markierte löschen
          </button>
        </form>
        <div class="bs-table bs2">
          <div class="bs-sel bs-sel-h">
            <input
              type="checkbox"
              aria-label="alle markieren"
              title="alle markieren"
              onchange="document.querySelectorAll('input[name=ids][form=bs-del]').forEach(function(x){x.checked=this.checked}.bind(this))"
            />
            <div class="bs-tr bs-th">
              <span>Nr.</span>
              <span>Lieferant · Objekt · Zeitraum</span>
              <span class="r">Betrag netto</span>
              <span>Status · Abrechnung</span>
            </div>
          </div>
          {rows.map((r) => (
            <div class="bs-sel">
              <input
                type="checkbox"
                name="ids"
                form="bs-del"
                value={`${r.kind === 'nu' ? 'nu' : 'po'}:${r.id}`}
                aria-label={`${r.number} markieren`}
              />
              <a class="bs-tr" href={r.href}>
                <span class="bs-nr">
                  {r.number}
                  <span class="bs-kind">{r.kind === 'nu' ? 'NU' : 'Material'}</span>
                </span>
                <span class="bs-main">
                  <b>{r.supplier}</b>
                  <span class="bs-sub">{r.what}</span>
                  <span class="bs-sub">{period(r)}</span>
                </span>
                <span class="r bs-amt">
                  {r.net !== null && (
                    <>
                      {euro(r.net)} <span class="small mut">{r.per}</span>
                    </>
                  )}
                  {r.unit && <span class="bs-sub">{r.unit}</span>}
                </span>
                <span class="bs-st">
                  <span class={`bs-pill bs-${r.tone || 'grey'}`}>{r.status}</span>
                  {r.unsigned && !r.status.includes('Unterschrift fehlt') && (
                    <span class="bs-sub" style="color:var(--bad)">
                      Unterschrift fehlt
                    </span>
                  )}
                  {billCell(r)}
                  {r.canFinish && (
                    <button
                      type="button"
                      class="btn sm sec"
                      title="Auftrag komplett erledigt (beendet)"
                      onclick={`event.preventDefault();event.stopPropagation();if(confirm(${JSON.stringify(`Auftrag ${r.number} als komplett erledigt markieren?`)}))document.getElementById('fin-${r.id}').submit()`}
                    >
                      ✓ erledigt
                    </button>
                  )}
                </span>
              </a>
            </div>
          ))}
          {!rows.length && <div class="bs-tr empty">Keine Bestellungen in dieser Ansicht.</div>}
        </div>
        <Pager cur={cur} pages={pages} url={(n) => link({ seite: n > 1 ? String(n) : null })} />
        {rows
          .filter((r) => r.canFinish)
          .map((r) => (
            <form
              id={`fin-${r.id}`}
              method="post"
              action={`/nachunternehmer/auftraege/${r.id}/status`}
              hidden
            >
              <input type="hidden" name="status" value="beendet" />
              <input type="hidden" name="zurueck" value={ret} />
            </form>
          ))}
      </div>,
    );
  });

  // Mehrere Bestellungen auf einmal löschen (Ahmed 19.10.); nicht löschbare werden mit Grund gemeldet.
  app.post('/bestellungen/loeschen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const raw = b['ids'];
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const ret = String(b['zurueck'] ?? '');
    const target = ret.startsWith('/bestellungen') ? ret : '/bestellungen';
    const o = { admin: c.get('user').role === 'admin', actor: c.get('actor') };
    let ok = 0;
    const errs: string[] = [];
    for (const v of ids) {
      const m = /^(nu|po):([0-9a-f-]{36})$/.exec(v);
      if (!m) continue;
      try {
        if (m[1] === 'nu') await deleteSubcontract(sql, m[2]!, o);
        else await deleteOrder(sql, m[2]!, o);
        ok++;
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        errs.push(e.message);
      }
    }
    const sep = target.includes('?') ? '&' : '?';
    const msg = `${ok} ${ok === 1 ? 'Bestellung' : 'Bestellungen'} gelöscht`;
    return c.redirect(
      `${target}${sep}${errs.length ? `fehler=${encodeURIComponent(`${msg}. Nicht gelöscht: ${errs.slice(0, 10).join(' · ')}${errs.length > 10 ? ` … (+${errs.length - 10})` : ''}`)}` : `ok=${encodeURIComponent(msg)}`}`,
      303,
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
                  ? o.received_at.toLocaleDateString('de-DE', {
                      timeZone: 'Europe/Berlin',
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    })
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
  const incomingTabs = (all: { status: IncomingStatus }[], expected?: number, advances?: number): Tab[] => [
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
    {
      key: 'vorschuss',
      label: 'Vorschüsse',
      href: '/rechnungseingang/vorschuesse',
      ...(advances !== undefined ? { count: advances } : {}),
    },
    { key: 'zahlung', label: 'Zahlungsliste', href: '/zahlungsliste' },
  ];
  const openAdvanceCount = async () => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from app.subcontractor_advances a
       where a.amount_cents > coalesce((select sum(o.amount_cents) from app.subcontractor_advance_offsets o
                                         where o.advance_id = a.id), 0)`;
    return r?.n ?? 0;
  };

  // Vorschüsse an Nachunternehmer im Überblick (Ahmed 09.10.: „damit man es nicht aus den Augen verliert“)
  app.get('/rechnungseingang/vorschuesse', async (c) => {
    const alle = c.req.query('alle') === '1';
    const [all, rows, n] = await Promise.all([listIncoming(sql), listAllAdvances(sql), openAdvanceCount()]);
    const shown = alle ? rows : rows.filter((r) => r.amount_cents > r.used_cents);
    const sum = (f: (r: (typeof rows)[number]) => bigint) => shown.reduce((s, r) => s + f(r), 0n);
    const today = todayBerlin();
    return page(
      c,
      'Vorschüsse',
      'lieferanten',
      <>
        <PageHead title="Rechnungseingang" />
        <Tabs tabs={incomingTabs(all, undefined, n)} active="vorschuss" />
        <div class="actions" style="margin-top:0">
          <div class="chips" style="margin:0">
            <a class={alle ? '' : 'on'} href="/rechnungseingang/vorschuesse">
              Offen <span class="n">{n}</span>
            </a>
            <a class={alle ? 'on' : ''} href="/rechnungseingang/vorschuesse?alle=1">
              Alle <span class="n">{rows.length}</span>
            </a>
          </div>
          <span class="small mut" style="margin-left:auto">
            Neuer Vorschuss: beim Nachunternehmer → Reiter „Vorschüsse“ oder aus Kontoumsätze → „Als Vorschuss
            erfassen“
          </span>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Gezahlt</th>
                <th>Nachunternehmer</th>
                <th>Bestellung / Zweck</th>
                <th>Zahlart</th>
                <th class="r">Vorschuss</th>
                <th class="r">verrechnet</th>
                <th class="r">offen</th>
                <th>mit Rechnung</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colspan={8}>
                    <div class="empty">
                      {alle ? 'Keine Vorschüsse erfasst.' : 'Keine offenen Vorschüsse.'}
                    </div>
                  </td>
                </tr>
              )}
              {shown.map((r) => {
                const open = r.amount_cents - r.used_cents;
                const days = Math.round((Date.parse(today) - Date.parse(r.paid_on)) / 86_400_000);
                return (
                  <tr>
                    <td>
                      {dateDe(r.paid_on)}
                      {open > 0n && days > 45 && (
                        <div class="small" style="color:var(--err)">
                          seit {days} Tagen offen
                        </div>
                      )}
                    </td>
                    <td>
                      <a href={`/lieferanten/${r.supplier_id}/vorschuesse`}>{r.supplier_name}</a>
                      {r.supplier_no && <span class="small mut"> {r.supplier_no}</span>}
                    </td>
                    <td>
                      {r.subcontract_number && <div>{r.subcontract_number}</div>}
                      {r.purpose && <div class="small mut">{r.purpose}</div>}
                    </td>
                    <td>{ADVANCE_METHOD[r.method] ?? r.method}</td>
                    <td class="r">{euro(r.amount_cents)}</td>
                    <td class="r">{euro(r.used_cents)}</td>
                    <td class="r">
                      {open > 0n ? <b>{euro(open)}</b> : <span class="badge ok">verrechnet</span>}
                    </td>
                    <td class="small">{r.invoices ?? '–'}</td>
                  </tr>
                );
              })}
            </tbody>
            {shown.length > 0 && (
              <tfoot>
                <tr>
                  <td colspan={4}>
                    <b>Summe</b>
                  </td>
                  <td class="r">{euro(sum((r) => r.amount_cents))}</td>
                  <td class="r">{euro(sum((r) => r.used_cents))}</td>
                  <td class="r">
                    <b>{euro(sum((r) => r.amount_cents - r.used_cents))}</b>
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p class="small mut">
          Verrechnen: an der Eingangsrechnung des Nachunternehmers (Karte „Vorschuss“) – der Zahlbetrag sinkt
          um den verrechneten Teil.
        </p>
      </>,
    );
  });

  app.get('/rechnungseingang', async (c) => {
    const st = (c.req.query('status') ?? 'erfasst') as IncomingStatus | 'alle' | 'erwartet';
    const [all, expected, pendingE] = await Promise.all([
      listIncoming(sql),
      expectedInvoices(sql),
      pendingEInvoices(sql),
    ]);
    const today = todayBerlin();
    const qs = c.req.query();
    const search = (qs.q ?? '').trim().toLowerCase();
    const supF = qs.lieferant && /^[0-9a-f-]{36}$/.test(qs.lieferant) ? qs.lieferant : '';
    const filtered = (st === 'alle' ? all : all.filter((i) => i.status === st))
      .filter((i) => !supF || i.supplier_id === supF)
      .filter(
        (i) =>
          !search ||
          [i.invoice_no, i.supplier_name, i.supplier_no, i.site_name, i.po_number].some((v) =>
            v?.toLowerCase().includes(search),
          ),
      );
    // offene nach Fälligkeit, erledigte neueste zuerst
    if (st === 'alle' || st === 'bezahlt' || st === 'abgelehnt')
      filtered.sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
    const PER_PAGE = 25;
    const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
    const cur = Math.min(pages, Math.max(1, Number(qs.seite) || 1));
    const rows = filtered.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
    const sups = [...new Map(all.map((i) => [i.supplier_id, i.supplier_name])).entries()].sort((a, b) =>
      a[1].localeCompare(b[1], 'de'),
    );
    const listUrl = (over: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const v: Record<string, string | null> = {
        status: st,
        q: search || null,
        lieferant: supF || null,
        ...over,
      };
      for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
      return `/rechnungseingang?${p.toString()}`;
    };
    const tabs = incomingTabs(all, expected.length, await openAdvanceCount());
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
              Lieferant, Rechnungsnummer, Datum, Fälligkeit, Beträge, § 13b und Skonto werden übernommen. Die
              Datei wird unverändert archiviert.
            </span>
          </form>
          {pendingE.length > 0 && (
            <ul class="small" style="margin:10px 0 0">
              {pendingE.map((f) => (
                <li>
                  <a href={`/rechnungseingang/e-rechnung/${f.id}`}>{f.original_name}</a>{' '}
                  <span class="mut">
                    · {dateDe(f.created_at.toISOString().slice(0, 10))} · {f.uploaded_by} – noch nicht
                    übernommen
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
        <div class="kpis kpis-sm">
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
          <>
            <form class="ls-bar" method="get" action="/rechnungseingang">
              <input type="hidden" name="status" value={st} />
              <select
                name="lieferant"
                onchange="this.form.submit()"
                style="width:auto;max-width:280px"
                aria-label="Lieferant"
              >
                <option value="">Alle Lieferanten</option>
                {sups.map(([id, name]) => (
                  <option value={id} selected={id === supF}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                class="search-input"
                type="search"
                name="q"
                value={search}
                placeholder="Rechnungs-Nr., Firma, Objekt, Bestellung …"
              />
              {(search || supF) && (
                <a class="btn ghost sm" href={listUrl({ q: null, lieferant: null })}>
                  Filter zurücksetzen
                </a>
              )}
              <span class="small mut ls-count">
                {filtered.length === 0
                  ? 'keine Treffer'
                  : `${(cur - 1) * PER_PAGE + 1}–${(cur - 1) * PER_PAGE + rows.length} von ${filtered.length}`}
              </span>
            </form>
            <div class="card" style="padding:0">
              <div class="tbl stack-m">
                <table class="in-tbl">
                  <thead>
                    <tr>
                      <th>Rechnung</th>
                      <th>Datum · fällig</th>
                      <th>Kostenart · Objekt</th>
                      <th class="r">Brutto</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr>
                        <td colspan={5}>
                          <div class="empty">Keine Rechnungen.</div>
                        </td>
                      </tr>
                    )}
                    {rows.map((i) => {
                      const late = i.status !== 'bezahlt' && i.status !== 'abgelehnt' && i.due_date < today;
                      return (
                        <tr>
                          <td data-label="Rechnung">
                            <a href={`/rechnungseingang/${i.id}`}>
                              <b>{i.supplier_name}</b>
                            </a>
                            <div class="small mut">
                              Nr. {i.invoice_no}
                              {i.po_number && ` · ${i.po_number}`}
                              {i.file_count > 0 && (
                                <>
                                  {' '}
                                  <Icon name="clip" size={12} />
                                </>
                              )}
                              {i.reverse_charge && (
                                <>
                                  {' '}
                                  <span class="badge tag">§ 13b</span>
                                </>
                              )}
                            </div>
                          </td>
                          <td class="small" data-label="Datum · fällig">
                            {dateDe(i.invoice_date)}
                            <div style={late ? 'color:var(--err);font-weight:600' : 'color:var(--mut)'}>
                              fällig {dateDe(i.due_date)}
                            </div>
                            {i.skonto_until && i.status === 'freigegeben' && i.skonto_until >= today && (
                              <div style="color:var(--warn)">Skonto bis {dateDe(i.skonto_until)}</div>
                            )}
                          </td>
                          <td class="small" data-label="Kostenart · Objekt">
                            {COST_CATEGORY[i.category]}
                            {i.site_name && <div class="mut">{i.site_name}</div>}
                          </td>
                          <td class="r" data-label="Brutto">
                            <b>{euro(i.gross_cents)}</b>
                          </td>
                          <td data-label="Status">
                            <span class={`badge ${IN_CLASS[i.status]}`}>{INCOMING_STATUS[i.status]}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <Pager cur={cur} pages={pages} url={(n) => listUrl({ seite: n > 1 ? String(n) : null })} />
          </>
        )}
      </>,
    );
  });

  EInvoiceRoutes({ app, deps, page, back } as Ctx);

  // Mehrere erwartete Rechnungen auf einmal als erledigt vermerken (Ahmed: „wurden schon alle bezahlt“)
  app.post('/rechnungseingang/erwartet/auswahl', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const sel = ([] as unknown[]).concat(b.sel ?? []).map(String);
    const grund = String(b.grund ?? '').trim() || 'bereits bezahlt';
    let n = 0;
    for (const v of sel) {
      const [id, month] = v.split('|');
      if (!id || !month) continue;
      await skipExpected(sql, id, month, grund, c.get('actor'));
      n++;
    }
    return back(c, '/rechnungseingang?status=erwartet', {
      ok: n ? `${n} Zeiträume als erledigt vermerkt („${grund}“).` : 'Nichts markiert.',
    });
  });

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
    const advOpen = i ? ((await openAdvances(sql, [i.supplier_id])).get(i.supplier_id) ?? 0n) : 0n;
    const siteById = new Map(sites.map((x) => [x.id, x]));
    const sammelCount = new Map(
      (
        await sql<{ id: string; n: number }[]>`
          select subcontract_id as id, count(*)::int as n from app.subcontract_sites group by subcontract_id`
      ).map((r) => [r.id, r.n]),
    );
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
    // Nur offene Bestellungen anbieten (Ahmed 22.10.): laufende bzw. mit noch nicht abgerechnetem Zeitraum;
    // ganz abgerechnete/erledigte nur, wenn sie an dieser Rechnung schon hängen
    {
      const keep = new Set(
        [
          ...linkRows.map((r) => r.sc),
          (i as { subcontract_id?: string | null } | undefined)?.subcontract_id,
        ].filter(Boolean) as string[],
      );
      const tr = await billingTracking(
        sql,
        subcontracts.map((x) => x.id),
        { limit: 24 },
      );
      const open = subcontracts.filter((x) => {
        if (keep.has(x.id)) return true;
        const ps = tr.get(x.id) ?? [];
        if (!ps.length) return x.status === 'erteilt';
        return ps.some((p) => p.state !== 'abgerechnet' && p.state !== 'keine');
      });
      subcontracts.splice(0, subcontracts.length, ...open);
    }
    const preNet =
      !i && linkRows.length && linkRows.every((r) => r.net)
        ? linkRows.reduce(
            (a, r) => a + BigInt(Math.round(Number(r.net.replace(/\./g, '').replace(',', '.')) * 100)),
            0n,
          )
        : null;
    const editable = !i || i.status === 'erfasst';
    const paidRaw = i as unknown as
      { paid_method?: PaidMethod | null; bank_transaction_id?: string | null } | undefined;
    const paidInfo = { method: paidRaw?.paid_method ?? null, bank: !!paidRaw?.bank_transaction_id };
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
                <form
                  method="post"
                  action={`/rechnungseingang/${id}/status?s=freigegeben`}
                  onsubmit={(() => {
                    const w: string[] = [];
                    if (files.length === 0) w.push('Es ist kein Beleg hochgeladen.');
                    if (Number(i.vat_cents) === 0 && !i.reverse_charge)
                      w.push('USt ist 0 € und § 13b ist nicht angehakt.');
                    return w.length
                      ? `return confirm(${JSON.stringify(w.join(' ') + ' Trotzdem freigeben?')})`
                      : undefined;
                  })()}
                >
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
                {i.approved_at?.toLocaleDateString('de-DE', {
                  timeZone: 'Europe/Berlin',
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}
              </span>
            )}
            {i.paid_at && (
              <span class="badge ok">
                bezahlt am {dateDe(i.paid_at)}
                {paidInfo.method && PAID_METHOD[paidInfo.method] ? ` · ${PAID_METHOD[paidInfo.method]}` : ''}
              </span>
            )}
            {i.status === 'bezahlt' &&
              !paidInfo.bank &&
              paidInfo.method &&
              paidInfo.method !== 'verrechnung' && (
                <form
                  method="post"
                  action={`/zahlungsliste/${id}/zuruecknehmen?zurueck=rechnung`}
                  onsubmit="return confirm('Zahlung zurücknehmen? Die Rechnung ist danach wieder offen (freigegeben).')"
                >
                  <button class="btn sm ghost">Zahlung zurücknehmen</button>
                </form>
              )}
          </div>
        )}
        {i && i.status === 'freigegeben' && (
          <details class="card" style="max-width:720px">
            <summary>Schon bezahlt (Lastschrift, PayPal, Karte, bar …)? Als bezahlt markieren</summary>
            <form
              method="post"
              action={`/rechnungseingang/${id}/bezahlt`}
              class="actions"
              style="margin-top:10px"
            >
              <label class="small" for="pd-m">
                Zahlart
              </label>
              <select id="pd-m" name="paid_method">
                {DIRECT_PAID_METHODS.map((m) => (
                  <option value={m}>{PAID_METHOD[m]}</option>
                ))}
              </select>
              <label class="small" for="pd-d">
                am
              </label>
              <input id="pd-d" type="date" name="paid_date" value={todayBerlin()} max={todayBerlin()} />
              <label class="small" for="pd-n">
                Bemerkung
              </label>
              <input id="pd-n" name="paid_note" placeholder="optional" />
              <button class="btn">Als bezahlt markieren</button>
            </form>
          </details>
        )}
        {i && (i.advance_offset_cents > 0n || advOpen > 0n) && (
          <div class="card" style="max-width:720px">
            <h3>Vorschuss</h3>
            {i.advance_offset_cents > 0n && (
              <p style="margin-top:0">
                Mit Vorschuss verrechnet: <b>{euro(i.advance_offset_cents)}</b> · noch zu zahlen{' '}
                <b>{euro(i.gross_cents - i.advance_offset_cents)}</b>
                {i.status !== 'bezahlt' && (
                  <form
                    method="post"
                    action={`/rechnungseingang/${id}/vorschuss/zuruecknehmen`}
                    style="display:inline;margin-left:8px"
                  >
                    <button class="btn sm ghost">Verrechnung zurücknehmen</button>
                  </form>
                )}
              </p>
            )}
            {advOpen > 0n && ['erfasst', 'freigegeben'].includes(i.status) && (
              <form method="post" action={`/rechnungseingang/${id}/vorschuss`} class="actions">
                <span>
                  Offener Vorschuss bei {i.supplier_name}: <b>{euro(advOpen)}</b> –{' '}
                  <a href={`/lieferanten/${i.supplier_id}/vorschuesse`}>ansehen</a>
                </span>
                <input
                  name="amount"
                  inputmode="decimal"
                  aria-label="Betrag"
                  style="max-width:140px"
                  value={centsToInput(
                    advOpen < i.gross_cents - i.advance_offset_cents
                      ? advOpen
                      : i.gross_cents - i.advance_offset_cents,
                  )}
                />
                <button class="btn sm">Vorschuss verrechnen</button>
              </form>
            )}
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
              <h2 style="margin-top:0">Rechnung</h2>
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
              </div>
              <h2>Beträge</h2>
              <div class="grid">
                <div>
                  <label for="net">Netto €</label>
                  <input id="net" name="net" value={v.net} required class="right" />
                </div>
                <div>
                  <label for="vat">USt €</label>
                  <input id="vat" name="vat" value={v.vat} class="right" placeholder="0,00" />
                  <small class="mut" id="vat-hint">
                    wird mit 19 % vom Netto vorbelegt · <span id="gross-out"></span>
                  </small>
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
                <div class="full nu-links" style="grid-column:1/-1">
                  <label>Bestellung beim Nachunternehmer – zuerst wählen</label>
                  <p class="small mut" style="margin:0 0 6px">
                    Nur offene Bestellungen des gewählten Nachunternehmers (laufend oder noch nicht ganz
                    abgerechnet). Objekt, Monat und Betrag werden übernommen – eine Zeile je Bestellung und
                    Monat.
                  </p>
                  <div style="overflow-x:auto">
                    <table class="tbl-in" style="width:100%">
                      <thead>
                        <tr>
                          <th style="text-align:left">Bestellung</th>
                          <th style="text-align:left;width:170px">Leistungsmonat</th>
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
                                <option value="">– Bestellung wählen –</option>
                                {subcontracts.map((x) => {
                                  const st = siteById.get(x.site_id);
                                  const addr = st
                                    ? [st.street, [st.postal_code, st.city].filter(Boolean).join(' ')]
                                        .filter(Boolean)
                                        .join(', ')
                                    : '';
                                  return (
                                    <option
                                      value={x.id}
                                      selected={x.id === r.sc}
                                      data-sup={x.supplier_id}
                                      data-site={x.site_id}
                                      data-multi={String(sammelCount.get(x.id) ?? 0)}
                                      data-net={
                                        x.billing === 'pauschale_monat'
                                          ? centsToInput(x.current_price_cents)
                                          : ''
                                      }
                                      hidden={!!v.supplier && x.supplier_id !== v.supplier && x.id !== r.sc}
                                    >
                                      {x.number} · {x.site_name ?? 'ohne Objekt'}
                                      {x.site_no ? ` (${x.site_no})` : ''}
                                      {addr ? ` · ${addr}` : ''} · {x.service_kind} ·{' '}
                                      {euro(x.current_price_cents)} {BILLING_DE[x.billing] ?? x.billing}
                                      {x.status === 'beendet' ? ' · beendet' : ''}
                                    </option>
                                  );
                                })}
                              </select>
                            </td>
                            <td>
                              <MonthSelect
                                name="link_month"
                                value={r.m}
                                disabled={dis}
                                label="Leistungsmonat"
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
                  </div>
                  {!dis && (
                    <button type="button" class="btn sm sec" data-nu-add style="margin-top:6px">
                      + weitere Zeile
                    </button>
                  )}
                  <p class="small mut" style="margin:4px 0 0">
                    Objekt und Leistungsmonat kommen aus den Zeilen. Beträge je Zeile sind freiwillig – ohne
                    Betrag verteilt die App das Netto nach dem Preis der Bestellungen.
                  </p>
                  <script
                    dangerouslySetInnerHTML={{
                      __html: `(function(){
var sup=document.getElementById('supplier_id'),rows=document.querySelector('[data-nu-rows]');if(!rows)return;
function setSel(el,v){if(!el||!v)return;el.value=v;if(el._cbLabel)el._cbLabel();el.dispatchEvent(new Event('change',{bubbles:true}));}
function filter(){var s=sup&&sup.value;document.querySelectorAll('select[name=link_sc],#purchase_order_id').forEach(function(sel){if(!sel._all)sel._all=Array.prototype.slice.call(sel.options);var cur=sel.value;sel._all.forEach(function(o){var ok=!o.dataset.sup||!s||o.dataset.sup===s||o.value===cur;o.hidden=false;if(ok){if(o.parentNode!==sel)sel.appendChild(o);}else if(o.parentNode===sel)sel.removeChild(o);});sel.value=cur;});}
function prevMonth(){var d=(document.getElementById('invoice_date')||{}).value||'';if(!/^\\d{4}-\\d{2}/.test(d))return '';var y=+d.slice(0,4),m=+d.slice(5,7)-1;if(m<1){m=12;y--;}return y+'-'+(m<10?'0':'')+m;}
rows.addEventListener('change',function(e){var sel=e.target;if(!sel.matches||!sel.matches('select[name=link_sc]'))return;var o=sel.selectedOptions[0];if(!o||!o.value)return;var tr=sel.closest('tr');
var first=rows.querySelector('select[name=link_sc]')===sel;var sm=document.getElementById('service_month');
var lm=tr.querySelector('[name=link_month]');if(lm&&!lm.value)setSel(lm,(sm&&sm.value)||prevMonth());
if(first){setSel(document.getElementById('site_id'),o.dataset.site);setSel(document.getElementById('category'),'nachunternehmer');if(sm&&!sm.value)setSel(sm,lm&&lm.value);
var n=document.getElementById('net');var filled=Array.prototype.filter.call(rows.querySelectorAll('select[name=link_sc]'),function(x){return x.value}).length;if(n&&!n.value&&filled===1&&o.dataset.net){n.value=o.dataset.net;n.dispatchEvent(new Event('change',{bubbles:true}));}}});
function multi(){var sites={},m=false,label='';rows.querySelectorAll('select[name=link_sc]').forEach(function(x){var o=x.selectedOptions[0];if(!o||!o.value)return;sites[o.dataset.site]=1;if(+o.dataset.multi>1)m=true;if(!label)label=(o.textContent.split(' · ')[1]||'').trim();});var n=Object.keys(sites).length;var any=n>0;m=m||n>1;var bx=document.getElementById('site-box'),au=document.getElementById('site-auto'),si=document.getElementById('site_id'),mb=document.getElementById('month-box'),tx=document.getElementById('site-auto-text');if(!bx||!au)return;bx.hidden=any;au.hidden=!any;if(mb)mb.hidden=any;if(tx)tx.textContent=m?'automatisch – die Kosten werden auf die Objekte der Bestellungen verteilt (Beträge je Zeile, sonst nach Preis; Sammelbestellung nach Fläche bzw. Betrag je Objekt).':'aus der Bestellung: '+label;if(any&&si&&si.value){si.value='';if(si._cbLabel)si._cbLabel();}}
rows.addEventListener('change',function(e){if(e.target.matches&&e.target.matches('select[name=link_sc]'))setTimeout(multi,0);});multi();
// Eingaben-Wiederherstellung und Safari-Zurück setzen Werte ohne „change“ → nachträglich noch einmal prüfen
window.addEventListener('load',function(){setTimeout(multi,50);});window.addEventListener('pageshow',function(){setTimeout(multi,50);});setTimeout(multi,400);
if(sup)sup.addEventListener('change',function(){document.querySelectorAll('select[name=link_sc],#purchase_order_id').forEach(function(x){var o=x.selectedOptions[0];if(o&&o.dataset.sup&&o.dataset.sup!==sup.value)x.value='';});filter();});filter();
var b=document.querySelector('[data-nu-add]');if(b)b.addEventListener('click',function(){var r=rows.lastElementChild.cloneNode(true);r.querySelectorAll('input').forEach(function(i){i.value=''});r.querySelectorAll('select').forEach(function(x){x.value=''});rows.appendChild(r);filter();});
})();`,
                    }}
                  />
                </div>
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
                <div id="site-box" hidden={linkRows.length > 0}>
                  <label for="site_id">Objekt (für Nachkalkulation)</label>
                  <select id="site_id" name="site_id">
                    <option value="">– kein Objekt (Gemeinkosten) –</option>
                    <SiteOptions sites={sites} selected={v.site} />
                  </select>
                </div>
                <div id="site-auto" hidden={linkRows.length === 0}>
                  <label>Objekt (für Nachkalkulation)</label>
                  <div class="small" style="padding-top:8px" id="site-auto-text">
                    automatisch aus den Bestellungen
                  </div>
                </div>
                <div id="month-box" hidden={linkRows.length > 0}>
                  <label for="service_month">Leistungsmonat</label>
                  <MonthSelect
                    id="service_month"
                    name="service_month"
                    value={i?.service_month?.slice(0, 7) ?? ''}
                    label="Leistungsmonat"
                  />
                </div>
                <div>
                  <label for="purchase_order_id">Material-Bestellung</label>
                  <select id="purchase_order_id" name="purchase_order_id">
                    <option value="">–</option>
                    {orders.map((o) => (
                      <option
                        value={o.id}
                        selected={o.id === v.po}
                        data-sup={o.supplier_id}
                        hidden={!!v.supplier && o.supplier_id !== v.supplier && o.id !== v.po}
                      >
                        {o.number} · {o.supplier_name} · {euro(o.net_cents)}
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
              {editable && (
                <>
                  <h2>Zahlung</h2>
                  <label class="chk" style="display:flex;gap:8px;align-items:center">
                    <input type="checkbox" id="paid_now" name="paid_now" value="1" data-reveal="#paid-box" />
                    Schon bezahlt (Lastschrift, PayPal, Karte, bar …) – direkt als bezahlt markieren
                  </label>
                  <div id="paid-box" class="grid" hidden>
                    <div>
                      <label for="paid_method">Zahlart</label>
                      <select id="paid_method" name="paid_method">
                        {DIRECT_PAID_METHODS.map((m) => (
                          <option value={m}>{PAID_METHOD[m]}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label for="paid_date">bezahlt am</label>
                      <input
                        id="paid_date"
                        type="date"
                        name="paid_date"
                        value={todayBerlin()}
                        max={todayBerlin()}
                      />
                    </div>
                    <div>
                      <label for="paid_note">Bemerkung (optional)</label>
                      <input
                        id="paid_note"
                        name="paid_note"
                        placeholder="z. B. PayPal-Transaktion, Kartenende"
                      />
                    </div>
                    <p class="small mut" style="grid-column:1/-1;margin:0">
                      Die Rechnung gilt damit als geprüft und freigegeben und erscheint nicht in der
                      Zahlungsliste. Beleg trotzdem hochladen.
                    </p>
                  </div>
                </>
              )}
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
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){var n=document.getElementById('net'),v=document.getElementById('vat'),r=document.getElementById('reverse_charge'),o=document.getElementById('gross-out');if(!n||!v)return;function p(x){x=(x||'').trim().replace(/\\./g,'').replace(',','.');var f=Number(x);return x===''||isNaN(f)?null:Math.round(f*100);}function fm(c){return (c/100).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2});}function upd(){var a=p(n.value),b=p(v.value);o.textContent=a==null?'':'Brutto '+fm(a+(b||0))+' €';}n.addEventListener('change',function(){var a=p(n.value);if(a!=null&&v.value.trim()===''&&!(r&&r.checked)){v.value=fm(Math.round(a*19/100));}upd();});v.addEventListener('input',upd);n.addEventListener('input',upd);if(r)r.addEventListener('change',function(){if(r.checked)v.value='0,00';upd();});upd();})();`,
            }}
          />
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
          <details
            class="card"
            open={
              allocations.reduce((a, x) => a + x.net_cents, 0n) !== i.net_cents ||
              allocations.some((a) => !a.auto)
            }
          >
            <summary style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;cursor:pointer">
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
            </summary>
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
          </details>
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
    if (one('paid_now') === '1') {
      const method = (one('paid_method') ?? '') as PaidMethod;
      await markPaidDirect(
        sql,
        id,
        { date: one('paid_date') ?? todayBerlin(), method, note: one('paid_note') },
        c.get('actor'),
      );
      return back(c, `/rechnungseingang/${id}`, {
        ok: `Gespeichert und als bezahlt markiert (${PAID_METHOD[method]}). Bitte noch den Beleg hochladen.`,
      });
    }
    return back(c, `/rechnungseingang/${id}`, { ok: 'Gespeichert. Jetzt Beleg hochladen und freigeben.' });
  });

  app.post(`/rechnungseingang/:id{${UUID}}/bezahlt`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const method = (str(b, 'paid_method') ?? '') as PaidMethod;
    try {
      await markPaidDirect(
        sql,
        id,
        { date: str(b, 'paid_date') ?? todayBerlin(), method, note: str(b, 'paid_note') },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/rechnungseingang/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/rechnungseingang/${id}`, { ok: `Als bezahlt markiert (${PAID_METHOD[method]}).` });
  });

  app.post(`/rechnungseingang/:id{${UUID}}/vorschuss`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const raw = str(b, 'amount');
    const done = await offsetAdvance(sql, id, raw ? (parseEuro(raw) as bigint) : null, c.get('actor'));
    const z = str(b, 'zurueck');
    return back(
      c,
      z && /^\/lieferanten\/[0-9a-f-]{36}\/vorschuesse$/.test(z) ? z : `/rechnungseingang/${id}`,
      {
        ok: `Vorschuss ${euro(done)} verrechnet – der Zahlbetrag ist entsprechend kleiner.`,
      },
    );
  });

  app.post(`/rechnungseingang/:id{${UUID}}/vorschuss/zuruecknehmen`, async (c) => {
    const id = c.req.param('id');
    await undoOffsets(sql, id, c.get('actor'));
    return back(c, `/rechnungseingang/${id}`, { ok: 'Verrechnung zurückgenommen.' });
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
                          data-nachweise={blocked ? p.invoice.supplier_name : undefined}
                          checked={p.invoice.due_date <= addDays(pay, 7) || p.skonto > 0n}
                          aria-label="auswählen"
                          onchange="window.vdSum()"
                        />
                      </td>
                      <td>
                        {p.invoice.supplier_name}
                        {blocked && (
                          <div class="small" style="color:var(--warn)">
                            Nachweise fehlen – Zahlung trotzdem möglich ·{' '}
                            <a href={`/lieferanten/${p.invoice.supplier_id}/nachweise`}>nachfordern</a>
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
                        {p.invoice.advance_offset_cents > 0n && (
                          <div class="small mut">abzgl. Vorschuss {euro(p.invoice.advance_offset_cents)}</div>
                        )}
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
                          {p.invoice.advance_offset_cents > 0n &&
                            ` abzgl. Vorschuss ${euro(p.invoice.advance_offset_cents)}`}
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
              <input type="checkbox" name="skonto" value="1" checked={list.some((p) => p.skonto > 0n)} />{' '}
              Skonto abziehen (nur wo die Skontofrist am Zahlungstag noch läuft)
            </label>
            <input name="notiz" placeholder="Notiz (optional)" style="max-width:220px" />
            <button
              class="btn"
              style="margin-left:auto"
              disabled={!list.length}
              onclick="return window.vdNuCheck() && confirm('Ausgewählte Rechnungen als bezahlt festhalten?')"
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
              onclick="return window.vdNuCheck() && confirm('SEPA-Datei für die ausgewählten Rechnungen erstellen? Die Rechnungen gelten danach als bezahlt.')"
            >
              <Icon name="download" /> SEPA-Datei erstellen
            </button>
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: `window.vdSum=function(){var t=0,n=0;document.querySelectorAll('input[name=invoice]:checked').forEach(function(x){t+=Number(x.dataset.amount);n++});document.getElementById('sel-sum').textContent=n?('Ausgewählt: '+n+' · '+(t/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'})):'';};window.vdSum();window.vdNuCheck=function(){var n=[];document.querySelectorAll('input[name=invoice]:checked').forEach(function(x){if(x.dataset.nachweise&&n.indexOf(x.dataset.nachweise)<0)n.push(x.dataset.nachweise)});return !n.length||confirm('Bei '+n.join(', ')+' fehlen Nachweise (Mindestlohn/Sozialversicherung). Wir haften als Auftraggeber trotzdem (§ 13 MiLoG, § 28e SGB IV) – die Zahlung ändert daran nichts. Trotzdem bezahlen?');};`,
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
      return back(c, `/zahlungsliste?datum=${date}`, {
        ok: `${anz(n, 'Rechnung', 'Rechnungen')} als bezahlt festgehalten.`,
      });
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
    const to =
      c.req.query('zurueck') === 'rechnung' ? `/rechnungseingang/${c.req.param('id')}` : '/zahlungsliste';
    try {
      await undoPaid(sql, c.req.param('id'), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, to, { fehler: e.message });
      throw e;
    }
    return back(c, to, { ok: 'Zahlung zurückgenommen.' });
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

  // ================================================================== Plan-Kalkulation (Soll)

  app.get('/auswertungen/plankalkulation', async (c) => {
    const curM = todayBerlin().slice(0, 7);
    const nextM = addDays(`${addDays(`${curM}-01`, 32).slice(0, 7)}-01`, 0).slice(0, 7);
    const qm = c.req.query('monat');
    const von = isMonth(qm) ? qm! : isMonth(c.req.query('von')) ? c.req.query('von')! : curM;
    const bisQ = isMonth(qm) ? qm! : isMonth(c.req.query('bis')) ? c.req.query('bis')! : von;
    const bis = bisQ < von ? von : bisQ > `${Number(von.slice(0, 4)) + 1}-12` ? von : bisQ;
    const fKunde = c.req.query('kunde') ?? '';
    const fObjekt = c.req.query('objekt') ?? '';
    const fOl = c.req.query('ol') ?? '';
    const fVerlust = c.req.query('verlust') === '1';
    const [plan, acct] = await Promise.all([
      planCosting(sql, { from: von, to: bis }),
      getAccountingSettings(sql),
    ]);
    const { rows: all, employees, rates, months } = plan;
    const rows = all.filter(
      (r) =>
        (!fKunde || r.customer_id === fKunde) &&
        (!fObjekt || r.site_id === fObjekt) &&
        (!fOl || (fOl === 'ohne' ? !r.manager_user_id : r.manager_user_id === fOl)) &&
        (!fVerlust || r.margin < 0n),
    );
    const managers = await managersOf(all.map((r) => r.manager_user_id));
    if (c.req.query('pdf') === '1') {
      const filter = filterLabel(
        all.find((r) => r.customer_id === fKunde)?.customer_name,
        all.find((r) => r.site_id === fObjekt),
        fOl,
        managers,
        fVerlust,
        c.req.query('schwaerzen') === '1',
      );
      const pdf = await planCostingPdf(rows, fKunde || fObjekt || fOl || fVerlust ? null : employees, {
        title: 'Plan-Kalkulation (Soll)',
        period: calcPeriodLabel(von, bis),
        filter,
        redact: c.req.query('schwaerzen') === '1',
      });
      return pdfResponse(pdf, `Plankalkulation_${von}${bis !== von ? `_${bis}` : ''}.pdf`);
    }
    const customers = [...new Map(all.map((r) => [r.customer_id, r.customer_name])).entries()].sort((a, b) =>
      a[1].localeCompare(b[1], 'de'),
    );
    const sum = (f: (r: (typeof rows)[number]) => bigint) => rows.reduce((a, r) => a + f(r), 0n);
    const rev = sum((r) => r.revenue);
    const margin = sum((r) => r.margin);
    const pct = (bp: number | null) =>
      bp === null ? '–' : `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;
    const eur = (cents: bigint) => euro(cents);
    const keep = [
      fKunde && `kunde=${fKunde}`,
      fObjekt && `objekt=${fObjekt}`,
      fOl && `ol=${fOl}`,
      fVerlust && 'verlust=1',
    ]
      .filter(Boolean)
      .join('&');
    const href = (a: string, b: string) =>
      `/auswertungen/plankalkulation?von=${a}&bis=${b}${keep ? `&${keep}` : ''}`;
    const y = Number(curM.slice(0, 4));
    const in3 = (() => {
      let m = curM;
      for (let i = 0; i < 2; i++) m = addDays(`${addDays(`${m}-01`, 32).slice(0, 7)}-01`, 0).slice(0, 7);
      return m;
    })();
    const quick: [string, string, string][] = [
      ['Dieser Monat', curM, curM],
      ['Nächster Monat', nextM, nextM],
      ['Nächste 3 Monate', curM, in3],
      [String(y), `${y}-01`, `${y}-12`],
    ];
    const mLabel = (m: string) => `${MONTHS_DE[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
    const canEdit = ['admin', 'buchhaltung'].includes(c.get('user').role);
    const n = (bp: number) => String(bp / 100).replace('.', ',');
    const ce = (v: bigint) => (Number(v) / 100).toFixed(2).replace('.', ',');
    const bandsOf = (e: (typeof employees)[number]) => e.bands.map((b) => PAY_BAND_LABEL[b]).join(' / ');
    return page(
      c,
      'Plan-Kalkulation (Soll)',
      'auswertungen',
      <>
        <PageHead title="Plan-Kalkulation (Soll)" crumbs={[['Auswertungen', '/auswertungen']]} />
        <p class="small mut" style="margin-top:-6px">
          Wie die Nachkalkulation, aber nur mit Plan-Daten: laufende Leistungen, eingeplante Einsätze,
          Nachunternehmer laut Bestellung. Vergleich mit dem Ist:{' '}
          <a href={`/auswertungen/nachkalkulation?von=${von}&bis=${bis}`}>
            Nachkalkulation für diesen Zeitraum
          </a>
        </p>
        <div class="chips" style="margin-bottom:10px;align-items:center">
          {quick.map(([l, a, b]) => (
            <a href={href(a, b)} class={von === a && bis === b ? 'on' : ''}>
              {l}
            </a>
          ))}
          <span class="small mut" style="margin-left:8px">
            Zeitraum: <b>{von === bis ? mLabel(von) : `${mLabel(von)} – ${mLabel(bis)}`}</b>
          </span>
        </div>
        <form method="get" action="/auswertungen/plankalkulation" class="actions" style="margin-top:0">
          <input type="hidden" name="von" value={von} />
          <input type="hidden" name="bis" value={bis} />
          <span style="flex:0 0 200px;max-width:200px">
            <MonthSelect name="monat" value={von === bis ? von : ''} label="Monat" autosubmit future />
          </span>
          <select name="kunde" aria-label="Kunde" style="max-width:240px" data-nosearch>
            <option value="">Alle Kunden</option>
            {customers.map(([id, name]) => (
              <option value={id} selected={id === fKunde}>
                {name}
              </option>
            ))}
          </select>
          <select name="objekt" aria-label="Objekt" style="max-width:260px">
            <option value="">Alle Objekte</option>
            {all
              .filter((r) => !fKunde || r.customer_id === fKunde)
              .map((r) => (
                <option value={r.site_id} selected={r.site_id === fObjekt}>
                  {r.site_no} · {r.site_name}
                </option>
              ))}
          </select>
          <OlSelect managers={managers} value={fOl} />
          <label class="small" style="margin:0;display:flex;gap:4px;align-items:center">
            <input type="checkbox" name="verlust" value="1" checked={fVerlust} /> nur Verlust
          </label>
          <button class="btn sec sm">Anzeigen</button>
        </form>
        <PdfExport
          action="/auswertungen/plankalkulation"
          params={{ von, bis, kunde: fKunde, objekt: fObjekt, ol: fOl, verlust: fVerlust ? '1' : '' }}
        />
        <div class="kpis">
          <div class="kpi">
            <div class="l">Erlös laut Leistungen</div>
            <div class="v">{eur(rev)}</div>
            <div class="s">{months > 1 ? `${months} Monate` : 'ein Monat'} · laufende Leistungen</div>
          </div>
          <div class="kpi">
            <div class="l">Lohn inkl. Arbeitgeberkosten</div>
            <div class="v">{eur(sum((r) => r.labor))}</div>
            <div class="s">
              brutto {eur(sum((r) => r.gross))} + AG {eur(sum((r) => r.employer))}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Nachunternehmer + Material</div>
            <div class="v">{eur(sum((r) => r.subcontractor) + sum((r) => r.material))}</div>
            <div class="s">
              NU {eur(sum((r) => r.subcontractor))} · Material {eur(sum((r) => r.material))}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Deckungsbeitrag (Plan)</div>
            <div class="v" style={margin < 0n ? 'color:var(--err)' : ''}>
              {eur(margin)}
            </div>
            <div class="s">{rev !== 0n ? pct(Number((margin * 10000n) / rev)) : '–'} vom Erlös</div>
          </div>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Objekt</th>
                <th class="r">Erlös (Plan)</th>
                <th class="r">Std. (Plan)</th>
                <th class="r">Lohn brutto</th>
                <th class="r">AG-Kosten</th>
                <th class="r">Nachunternehmer</th>
                <th class="r">Material</th>
                <th class="r">Deckungsbeitrag</th>
                <th class="r">Marge</th>
                <th class="r">Erlös / Std.</th>
              </tr>
            </thead>
            <tbody>
              {rows.length > 0 && (
                <tr style="background:var(--tint-2)">
                  <td>
                    <b>Gesamt</b>
                  </td>
                  <td class="r">
                    <b>{eur(rev)}</b>
                  </td>
                  <td class="r">
                    <b>{hm(rows.reduce((a, r) => a + r.minutes, 0))}</b>
                  </td>
                  <td class="r">
                    <b>{eur(sum((r) => r.gross))}</b>
                  </td>
                  <td class="r">
                    <b>{eur(sum((r) => r.employer))}</b>
                  </td>
                  <td class="r">
                    <b>{eur(sum((r) => r.subcontractor))}</b>
                  </td>
                  <td class="r">
                    <b>{eur(sum((r) => r.material))}</b>
                  </td>
                  <td class="r" style={margin < 0n ? 'color:var(--err)' : ''}>
                    <b>{eur(margin)}</b>
                  </td>
                  <td class="r" />
                  <td class="r" />
                </tr>
              )}
              {rows.length === 0 && (
                <tr>
                  <td colspan={10}>
                    <div class="empty">
                      Im Zeitraum gibt es keine laufenden Leistungen, Einsätze oder Bestellungen.
                    </div>
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr>
                  <td>
                    <a href={`/objekte/${r.site_id}`}>
                      {r.site_no} · {r.site_name}
                    </a>
                    <div class="small mut">{r.customer_name}</div>
                    {r.revenue === 0n && r.labor + r.subcontractor + r.material > 0n && (
                      <div class="small" style="color:var(--warn)">
                        Kosten ohne Erlös
                      </div>
                    )}
                    {r.revenue > 0n && r.minutes === 0 && r.subcontractor === 0n && (
                      <div class="small" style="color:var(--warn)">
                        keine Einsätze geplant
                      </div>
                    )}
                  </td>
                  <td class="r">{eur(r.revenue)}</td>
                  <td class="r">{hm(r.minutes)}</td>
                  <td class="r">{eur(r.gross)}</td>
                  <td class="r">{eur(r.employer)}</td>
                  <td class="r">{eur(r.subcontractor)}</td>
                  <td class="r">{eur(r.material)}</td>
                  <td class="r" style={r.margin < 0n ? 'color:var(--err)' : ''}>
                    <b>{eur(r.margin)}</b>
                  </td>
                  <td class="r">
                    <span
                      class={`badge ${r.margin_bp === null ? '' : r.margin_bp < 0 ? 'err' : r.margin_bp < acct.target_margin_bp ? 'warn' : 'ok'}`}
                    >
                      {pct(r.margin_bp)}
                    </span>
                  </td>
                  <td class="r">{r.minutes > 0 ? eur((r.revenue * 60n) / BigInt(r.minutes)) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details class="card" style="margin-top:14px">
          <summary>
            <b>Mitarbeitende im Plan ({employees.length})</b> – Entgelt je Person und Monat, Einstufung
          </summary>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter/in</th>
                  <th>Beschäftigung</th>
                  <th class="r">Std. (Plan)</th>
                  <th class="r">Entgelt brutto</th>
                  <th>Eingestuft als</th>
                  <th class="r">AG-Kosten</th>
                  <th class="r">AG-Satz</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr>
                    <td>
                      <a href={`/personal/${e.employee_id}`}>{e.name}</a>
                      <span class="small mut"> · {e.personnel_no}</span>
                      {e.wage_assumed && (
                        <div class="small" style="color:var(--warn)">
                          Vergütung fehlt – niedrigster Tariflohn angenommen
                        </div>
                      )}
                      {e.low_plan && (
                        <div class="small" style="color:var(--warn)">
                          geplantes Entgelt unter {eur(rates.minijob_limit_cents)} – Einsätze vollständig
                          geplant?
                        </div>
                      )}
                      {e.minijob_over && (
                        <div class="small" style="color:var(--err)">
                          Minijob: geplantes Entgelt über {eur(rates.minijob_limit_cents)} im Monat
                        </div>
                      )}
                    </td>
                    <td>
                      {e.employment_type ?? '–'}
                      {e.pay_model === 'festgehalt' && <span class="small mut"> · Festgehalt</span>}
                    </td>
                    <td class="r">{hm(e.minutes)}</td>
                    <td class="r">{eur(e.gross)}</td>
                    <td>{bandsOf(e)}</td>
                    <td class="r">{eur(e.employer)}</td>
                    <td class="r">{e.gross > 0n ? pct(Number((e.employer * 10000n) / e.gross)) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <details class="card" style="margin-top:14px">
          <summary>
            <b>So wird gerechnet</b> · Sätze {canEdit ? 'ändern' : 'ansehen'}
          </summary>
          <ul class="small">
            <li>
              <b>Erlös:</b> laufende Leistungen am Objekt (Monatspauschalen; 2-monatlich … jährlich anteilig
              je Monat). Einzelleistungen, Regiestunden und Einzelaufträge sind nicht planbar und fehlen hier.
            </li>
            <li>
              <b>Lohn:</b> eingeplante Einsätze (Soll, inkl. bezahlter Feiertage, ohne Tage mit eingetragener
              Abwesenheit) × Stundenlohn, ohne Zuschlag für Urlaub/Krankheit; Festgehalt = Monatsgehalt,
              verteilt nach geplanten Stunden. Sonn-/Feiertags- und Nachtzuschläge sind nicht enthalten.
            </li>
            <li>
              <b>Arbeitgeberkosten je Person und Monat</b> nach dem geplanten Entgelt: bis{' '}
              {eur(rates.minijob_limit_cents)} bzw. Beschäftigungsart Minijob = Minijob (
              {pct(rates.minijob_flat_bp)} Pauschalen); bis {eur(rates.midijob_upper_cents)} = Midijob
              (Übergangsbereich, AG-Satz sinkt von 28 % auf {pct(rates.sv_employer_bp)}); darüber regulär (
              {pct(rates.sv_employer_bp)}). Midijob und regulär zusätzlich Umlagen {pct(rates.levies_bp)};
              alle zusätzlich Unfallversicherung {pct(rates.accident_bp)}. Teilzeit/Vollzeit wird nie als
              Minijob gerechnet, auch wenn weniger geplant ist. Geschäftsführer (Tag „Geschäftsführer“): nur
              Gehalt bzw. Lohn, ohne Arbeitgeberkosten.
            </li>
            <li>
              <b>Nachunternehmer:</b> laut erteilter Bestellung jeden Monat (Pauschale, je Tag, je m², Anteil
              am Umsatz, „je Stunde“ mit max. Stunden) – auch wenn schon eine Rechnung gebucht ist.
            </li>
            <li>
              <b>Material:</b> Ø der Monate {mLabel(plan.materialFrom)} – {mLabel(plan.materialTo)} (Ist).
            </li>
          </ul>
          <p class="small" style="color:var(--warn)">
            Schätzung für die Kalkulation – die Lohnabrechnung rechnet je Person genau (Krankenkasse, Kinder,
            Beitragsgruppen). Sätze jährlich (Januar) mit dem Steuerberater abgleichen.
          </p>
          {canEdit && (
            <form method="post" action="/auswertungen/plankalkulation/saetze" data-noback>
              <input
                type="hidden"
                name="zurueck"
                value={`/auswertungen/plankalkulation?von=${von}&bis=${bis}`}
              />
              <div class="grid">
                {(
                  [
                    ['sv_employer', 'AG-Anteil Sozialversicherung %', n(rates.sv_employer_bp)],
                    ['sv_employee', 'AN-Anteil Sozialversicherung % (für Midijob)', n(rates.sv_employee_bp)],
                    ['levies', 'Umlagen U1/U2/Insolvenzgeld %', n(rates.levies_bp)],
                    ['accident', 'Unfallversicherung (BG) %', n(rates.accident_bp)],
                    ['minijob_flat', 'Minijob-Pauschalen gesamt %', n(rates.minijob_flat_bp)],
                    ['minijob_limit', 'Minijobgrenze € / Monat', ce(rates.minijob_limit_cents)],
                    ['midijob_upper', 'Midijob-Obergrenze € / Monat', ce(rates.midijob_upper_cents)],
                  ] as [string, string, string][]
                ).map(([k, l, v]) => (
                  <>
                    <label for={`pk-${k}`}>{l}</label>
                    <input id={`pk-${k}`} name={k} value={v} inputmode="decimal" required />
                  </>
                ))}
              </div>
              <div class="formfoot">
                <button class="btn">Sätze speichern</button>
              </div>
            </form>
          )}
        </details>
      </>,
    );
  });

  app.post('/auswertungen/plankalkulation/saetze', async (c) => {
    if (!['admin', 'buchhaltung'].includes(c.get('user').role)) throw new BusinessError('Keine Berechtigung');
    const b = await c.req.parseBody();
    const t = (k: string) =>
      typeof b[k] === 'string' ? (b[k] as string).trim().replace(/\./g, '').replace(',', '.') : '';
    const bp = (k: string) => {
      const v = Math.round(Number(t(k)) * 100);
      if (!t(k) || !Number.isFinite(v)) throw new BusinessError('Prozentwert ungültig');
      return v;
    };
    await savePlanCostRates(
      sql,
      {
        sv_employer_bp: bp('sv_employer'),
        sv_employee_bp: bp('sv_employee'),
        levies_bp: bp('levies'),
        accident_bp: bp('accident'),
        minijob_flat_bp: bp('minijob_flat'),
        minijob_limit_cents: BigInt(bp('minijob_limit')),
        midijob_upper_cents: BigInt(bp('midijob_upper')),
        absence_bp: (await getPlanCostRates(sql)).absence_bp,
      },
      c.get('actor'),
    );
    const z =
      typeof b.zurueck === 'string' && b.zurueck.startsWith('/auswertungen/plankalkulation')
        ? b.zurueck
        : '/auswertungen/plankalkulation';
    return back(c, z, { ok: 'Sätze gespeichert.' });
  });

  // ================================================================== Nachkalkulation

  app.get('/auswertungen/nachkalkulation', async (c) => {
    const curM = todayBerlin().slice(0, 7);
    const last = addDays(`${curM}-01`, -1).slice(0, 7);
    // Monatsauswahl geht vor von/bis (Ahmed 22.10.: „Monatsauswahl und Knöpfe wie bei Rechnungen“)
    const qm = c.req.query('monat');
    const von = isMonth(qm) ? qm! : isMonth(c.req.query('von')) ? c.req.query('von')! : last;
    const bisQ = isMonth(qm) ? qm! : isMonth(c.req.query('bis')) ? c.req.query('bis')! : von;
    const bis = bisQ < von ? von : bisQ;
    const [{ rows, general: allGeneral, overhead, targetBp }, report] = await Promise.all([
      siteCosting(sql, { from: von, to: bis }),
      costCenterReport(sql, von, bis),
    ]);
    // Filter wie in den Statistiken (Ahmed 09.10.): Kunde, Objekt, Objektleitung, nur Verlust
    const fKunde = c.req.query('kunde') ?? '';
    const fObjekt = c.req.query('objekt') ?? '';
    const fOl = c.req.query('ol') ?? '';
    const fVerlust = c.req.query('verlust') === '1';
    const filtered = !!(fKunde || fObjekt || fOl);
    const withData = rows.filter(
      (r) =>
        r.revenue !== 0n ||
        r.actual_minutes > 0 ||
        r.material + r.subcontractor + r.equipment + r.other !== 0n,
    );
    const active = withData.filter(
      (r) =>
        (!fKunde || r.customer_id === fKunde) &&
        (!fObjekt || r.site_id === fObjekt) &&
        (!fOl || (fOl === 'ohne' ? !r.manager_user_id : r.manager_user_id === fOl)) &&
        (!fVerlust || r.margin < 0n),
    );
    const general = filtered || fVerlust ? [] : allGeneral;
    const customers = [...new Map(withData.map((r) => [r.customer_id, r.customer_name])).entries()].sort(
      (a, b) => a[1].localeCompare(b[1], 'de'),
    );
    const managers = await managersOf(withData.map((r) => r.manager_user_id));
    if (c.req.query('pdf') === '1') {
      const redact = c.req.query('schwaerzen') === '1';
      const pdf = await siteCostingPdf(active, general, {
        title: 'Nachkalkulation & Kostenstellen',
        period: calcPeriodLabel(von, bis),
        filter: filterLabel(
          withData.find((r) => r.customer_id === fKunde)?.customer_name,
          withData.find((r) => r.site_id === fObjekt),
          fOl,
          managers,
          fVerlust,
          redact,
        ),
        redact,
      });
      return pdfResponse(pdf, `Nachkalkulation_${von}${bis !== von ? `_${bis}` : ''}.pdf`);
    }
    const details = fObjekt ? await siteCostDetails(sql, fObjekt, { from: von, to: bis }) : [];
    const sum = (f: (r: (typeof rows)[number]) => bigint) => active.reduce((a, r) => a + f(r), 0n);
    const totalRev = sum((r) => r.revenue);
    const generalTotal = general.reduce((a, g) => a + g.total, 0n);
    const totalMargin = sum((r) => r.margin);
    const result = totalMargin - generalTotal;
    const pct = (bp: number | null) =>
      bp === null ? '–' : `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
    const months = (() => {
      const [a, b] = [von, bis].map((x) => Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7)));
      return b! - a! + 1;
    })();
    return page(
      c,
      'Nachkalkulation & Kostenstellen',
      'auswertungen',
      <>
        <PageHead title="Nachkalkulation & Kostenstellen" crumbs={[['Auswertungen', '/auswertungen']]} />
        {(() => {
          const y = Number(curM.slice(0, 4));
          const keep = [
            fKunde && `kunde=${fKunde}`,
            fObjekt && `objekt=${fObjekt}`,
            fOl && `ol=${fOl}`,
            fVerlust && 'verlust=1',
          ]
            .filter(Boolean)
            .join('&');
          const href = (a: string, b: string) =>
            `/auswertungen/nachkalkulation?von=${a}&bis=${b}${keep ? `&${keep}` : ''}`;
          const quick: [string, string, string][] = [
            ['Dieser Monat', curM, curM],
            ['Letzter Monat', last, last],
            [String(y), `${y}-01`, curM],
            [String(y - 1), `${y - 1}-01`, `${y - 1}-12`],
          ];
          const label =
            von === bis
              ? `${MONTHS_DE[Number(von.slice(5, 7)) - 1]} ${von.slice(0, 4)}`
              : `${MONTHS_DE[Number(von.slice(5, 7)) - 1]} ${von.slice(0, 4)} – ${MONTHS_DE[Number(bis.slice(5, 7)) - 1]} ${bis.slice(0, 4)}`;
          return (
            <div class="chips" style="margin-bottom:10px;align-items:center">
              {quick.map(([l, a, b]) => (
                <a href={href(a, b)} class={von === a && bis === b ? 'on' : ''}>
                  {l}
                </a>
              ))}
              <span class="small mut" style="margin-left:8px">
                Zeitraum: <b>{label}</b>
              </span>
            </div>
          );
        })()}
        <form method="get" action="/auswertungen/nachkalkulation" class="actions" style="margin-top:0">
          <input type="hidden" name="von" value={von} />
          <input type="hidden" name="bis" value={bis} />
          <span style="flex:0 0 200px;max-width:200px">
            <MonthSelect name="monat" value={von === bis ? von : ''} label="Monat" autosubmit />
          </span>
          <select name="kunde" aria-label="Kunde" style="max-width:240px" data-nosearch>
            <option value="">Alle Kunden</option>
            {customers.map(([id, name]) => (
              <option value={id} selected={id === fKunde}>
                {name}
              </option>
            ))}
          </select>
          <select name="objekt" aria-label="Objekt" style="max-width:260px">
            <option value="">Alle Objekte</option>
            {withData
              .filter((r) => !fKunde || r.customer_id === fKunde)
              .map((r) => (
                <option value={r.site_id} selected={r.site_id === fObjekt}>
                  {r.site_no} · {r.site_name}
                </option>
              ))}
          </select>
          <select name="ol" aria-label="Objektleitung" style="max-width:200px" data-nosearch>
            <option value="">Alle Objektleitungen</option>
            {managers.map((m) => (
              <option value={m.user_id} selected={m.user_id === fOl}>
                {m.name}
              </option>
            ))}
            <option value="ohne" selected={fOl === 'ohne'}>
              ohne Objektleitung
            </option>
          </select>
          <label class="small" style="margin:0;display:flex;gap:4px;align-items:center">
            <input type="checkbox" name="verlust" value="1" checked={fVerlust} /> nur Verlust
          </label>
          <button class="btn sec sm">Anzeigen</button>
          {(filtered || fVerlust) && (
            <a class="small" href={`/auswertungen/nachkalkulation?von=${von}&bis=${bis}`}>
              Filter zurücksetzen
            </a>
          )}
          <span class="small mut" style="flex-basis:100%">
            Lohn = Ist-Stunden × Stundenlohn (fehlt die Vergütung: niedrigster Tariflohn) + Zuschlag (Minijob{' '}
            {pct(overhead.minijob)}, Teilzeit {pct(overhead.parttime)}, über 30 Std. {pct(overhead.fulltime)};
            Geschäftsführer ohne Zuschlag) · Nachunternehmer = Eingangsrechnungen, sonst Monatspauschale laut
            Bestellung · Ziel {pct(targetBp)} · <a href="/datev">Werte ändern</a>
          </span>
        </form>
        <PdfExport
          action="/auswertungen/nachkalkulation"
          params={{ von, bis, kunde: fKunde, objekt: fObjekt, ol: fOl, verlust: fVerlust ? '1' : '' }}
        />
        <div class="kpis">
          <div class="kpi">
            <div class="l">Erlös netto</div>
            <div class="v">{euro(totalRev)}</div>
            <div class="s">{months > 1 ? `${months} Monate` : 'ein Monat'}</div>
          </div>
          <div class="kpi">
            <div class="l">Deckungsbeitrag Objekte</div>
            <div class="v" style={totalMargin < 0n ? 'color:var(--err)' : ''}>
              {euro(totalMargin)}
            </div>
            <div class="s">
              {totalRev !== 0n ? pct(Number((totalMargin * 10000n) / totalRev)) : '–'} vom Erlös
            </div>
          </div>
          <div class="kpi">
            <div class="l">Allgemeine Kostenstellen</div>
            <div class="v">{euro(generalTotal)}</div>
            <div class="s">
              {filtered || fVerlust ? 'bei Filter nicht enthalten' : 'Büro, Fahrzeuge, Lager …'}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Ergebnis</div>
            <div class="v" style={result < 0n ? 'color:var(--err)' : ''}>
              {euro(result)}
            </div>
            <div class="s">Deckungsbeitrag − allgemeine Kosten</div>
          </div>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Kostenstelle / Objekt</th>
                <th class="r">Erlös</th>
                <th class="r">Std. Soll / Ist</th>
                <th class="r">Lohn</th>
                <th class="r">Material</th>
                <th class="r">Geräte</th>
                <th class="r">Nachunternehmer</th>
                <th class="r">Sonstiges</th>
                <th class="r">Deckungsbeitrag</th>
                <th class="r">Marge</th>
                <th class="r">Erlös / Std.</th>
              </tr>
            </thead>
            <tbody>
              {(active.length > 0 || general.length > 0) && (
                <tr style="background:var(--tint-2)">
                  <td>
                    <b>Gesamt</b>
                  </td>
                  <td class="r">
                    <b>{euro(totalRev)}</b>
                  </td>
                  <td class="r" />
                  <td class="r">
                    <b>{euro(sum((r) => r.labor))}</b>
                  </td>
                  <td class="r">
                    <b>{euro(sum((r) => r.material) + general.reduce((a, g) => a + g.material, 0n))}</b>
                  </td>
                  <td class="r">
                    <b>{euro(sum((r) => r.equipment) + general.reduce((a, g) => a + g.equipment, 0n))}</b>
                  </td>
                  <td class="r">
                    <b>
                      {euro(sum((r) => r.subcontractor) + general.reduce((a, g) => a + g.subcontractor, 0n))}
                    </b>
                  </td>
                  <td class="r">
                    <b>{euro(sum((r) => r.other) + general.reduce((a, g) => a + g.other, 0n))}</b>
                  </td>
                  <td class="r" style={result < 0n ? 'color:var(--err)' : ''}>
                    <b>{euro(result)}</b>
                  </td>
                  <td class="r" />
                  <td class="r" />
                </tr>
              )}
              {active.length === 0 && general.length === 0 && (
                <tr>
                  <td colspan={11}>
                    <div class="empty">Im Zeitraum gibt es keine Erlöse, Zeiten oder Kosten.</div>
                  </td>
                </tr>
              )}
              {active.map((r) => (
                <tr>
                  <td>
                    <a href={`/objekte/${r.site_id}`}>
                      {r.site_no} · {r.site_name}
                    </a>
                    <div class="small mut">{r.customer_name}</div>
                    <a
                      class="small"
                      href={`/auswertungen/nachkalkulation?von=${von}&bis=${bis}&objekt=${r.site_id}#kosten`}
                    >
                      Kosten im Detail
                    </a>
                    {r.revenue === 0n &&
                      r.material + r.subcontractor + r.equipment + r.other + r.labor > 0n && (
                        <div class="small" style="color:var(--warn)">
                          Kosten ohne Erlös
                        </div>
                      )}
                  </td>
                  <td class="r">{euro(r.revenue)}</td>
                  <td class="r">
                    {hm(r.planned_minutes)} / {hm(r.actual_minutes)}
                    {r.missing_wage > 0 && (
                      <div
                        class="small"
                        style="color:var(--warn)"
                        title="Vergütung beim Mitarbeiter fehlt – gerechnet mit dem niedrigsten Tariflohn"
                      >
                        Lohn angenommen (Tariflohn)
                      </div>
                    )}
                  </td>
                  <td class="r">{euro(r.labor)}</td>
                  <td class="r">
                    {euro(r.material)}
                    {r.material > 0n && (
                      <div class="small">
                        <a href={`/materialausgabe?objekt=${r.site_id}${von === bis ? `&monat=${von}` : ''}`}>
                          Materialausgaben
                        </a>
                      </div>
                    )}
                  </td>
                  <td class="r">{euro(r.equipment)}</td>
                  <td class="r">
                    {euro(r.subcontractor)}
                    {r.subcontractor_estimated > 0n && (
                      <div class="small mut">davon {euro(r.subcontractor_estimated)} lt. Bestellung</div>
                    )}
                  </td>
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
              {general.length > 0 && (
                <tr>
                  <td colspan={11} class="small mut" style="background:var(--head)">
                    <b>Allgemeine Kostenstellen</b> (ohne Erlös)
                  </td>
                </tr>
              )}
              {general.map((g) => (
                <tr>
                  <td>
                    <b>
                      {g.number} · {g.name}
                    </b>
                  </td>
                  <td class="r">–</td>
                  <td class="r">–</td>
                  <td class="r">–</td>
                  <td class="r">{euro(g.material)}</td>
                  <td class="r">{euro(g.equipment)}</td>
                  <td class="r">{euro(g.subcontractor)}</td>
                  <td class="r">{euro(g.other)}</td>
                  <td class="r" style="color:var(--err)">
                    <b>{euro(-g.total)}</b>
                  </td>
                  <td class="r" />
                  <td class="r" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {fObjekt && (
          <div class="card" id="kosten">
            <h3>Eingangsrechnungen dieses Objekts im Zeitraum</h3>
            {!details.length ? (
              <p class="mut small">
                Keine Eingangsrechnung mit diesem Objekt als Kostenstelle und Leistungsmonat im Zeitraum.
                Fehlt eine Rechnung: an der Eingangsrechnung „Objekt“ und „Leistungsmonat“ bzw. die
                Kostenstellen-Aufteilung prüfen.
              </p>
            ) : (
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Lieferant · Rechnung</th>
                      <th>Datum</th>
                      <th>Leistungsmonat</th>
                      <th>Kostenart</th>
                      <th>Status</th>
                      <th class="r">Netto (Anteil)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map((d) => (
                      <tr>
                        <td>
                          <a href={`/rechnungseingang/${d.id}`}>
                            {d.supplier_name} · {d.invoice_no}
                          </a>
                        </td>
                        <td>{dateDe(d.invoice_date)}</td>
                        <td>{d.month.split('-').reverse().join('/')}</td>
                        <td>{COST_CATEGORY[d.category as CostCategory] ?? d.category}</td>
                        <td>
                          {d.status}
                          {d.status === 'abgelehnt' && <span class="small mut"> (zählt nicht)</span>}
                        </td>
                        <td class="r">{euro(d.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div class="card">
          <h3>
            Eingangsrechnungen nicht (vollständig) zugeordnet{' '}
            <span class="cnt">({report.unallocated.length})</span>
          </h3>
          {!report.unallocated.length ? (
            <p class="mut small">Alles einer Kostenstelle zugeordnet.</p>
          ) : (
            <div class="list">
              {report.unallocated.map((u) => (
                <div class="row">
                  <span class="dot warn" />
                  <div class="main">
                    <a href={`/rechnungseingang/${u.id}`}>
                      <b style="color:var(--ink)">
                        {u.supplier_name} · {u.invoice_no}
                      </b>
                    </a>
                    <div class="small mut">{dateDe(u.invoice_date)}</div>
                  </div>
                  <div class="side">
                    <span class="when">
                      {euro(u.allocated)} von {euro(u.net_cents)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p class="small mut">
          Erlös: ausgestellte Rechnungen je Position dem Objekt zugeordnet, Leistungszeitraum sonst
          Rechnungsdatum, inkl. Storno/Korrektur. Kosten: Eingangsrechnungen (auch Nachunternehmer) ab
          „erfasst“ – nicht erst nach Zahlung – nach ihrer Kostenstellen-Aufteilung und ihrem Leistungsmonat
          (nicht dem Rechnungsdatum); Spalte nach Kostenart (Geräte z. B. Hebebühne, Sonstiges = Fahrzeuge,
          Miete, Sonstiges). Material zusätzlich Lagerabgänge zum EK. Objekte erscheinen auch inaktiv, sobald
          im Zeitraum etwas anfällt.
        </p>
      </>,
    );
  });
}
