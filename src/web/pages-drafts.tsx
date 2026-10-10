import { Icon } from './icons.js';
import type { FC } from 'hono/jsx';
import { CYCLE_LABEL, formatDateDe } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import type { ExecutableService, OpenExecution } from '../services/executions.js';
import type { DraftListInfo, InvoiceRow } from '../services/invoices.js';
import type { BillableOrder } from '../services/orders.js';
import { milliToInput } from './forms.js';
import { dateDe, euro } from './layout.js';

/*
 * Rechnungsentwürfe / Vorfaktura (Ahmed: „Rechnungen anklicken, vom Kunden alle oder nur manche Objekte, für alle das
 * Rechnungsdatum anpassen, mehrere gleichzeitig erstellen“) und „Leistungen verrichten“ am Objekt.
 */

const amount = (q: bigint, p: bigint) => (q * p + 500n) / 1000n;
const range = (a: string, b: string) =>
  a === b ? formatDateDe(a) : `${formatDateDe(a)} – ${formatDateDe(b)}`;

/** Auswahl-Häkchen: „alle“ (data-all) bzw. je Kunde (data-group) schalten die zugehörigen Zeilen. */
export const SELECT_JS = `(function(){
document.querySelectorAll('[data-select-scope]').forEach(function(scope){
  if(scope.dataset.selInit)return;scope.dataset.selInit='1';
  function rows(g){return scope.querySelectorAll('input[data-row]'+(g?'[data-g'+(g.slice(-1)==='|'?'^':'')+'="'+g+'"]':''))}
  function sync(){scope.querySelectorAll('input[data-group]').forEach(function(h){var r=rows(h.dataset.group);h.checked=r.length>0&&[].every.call(r,function(x){return x.checked})});
    var all=scope.querySelector('input[data-all]');if(all){var r=rows();all.checked=r.length>0&&[].every.call(r,function(x){return x.checked})}
    var n=[].filter.call(rows(),function(x){return x.checked}).length;scope.querySelectorAll('[data-count]').forEach(function(c){c.textContent=n});
    scope.querySelectorAll('[data-needs-selection]').forEach(function(b){b.disabled=n===0})}
  scope.addEventListener('change',function(e){var t=e.target;
    if(t.dataset.all!==undefined)rows().forEach(function(x){x.checked=t.checked});
    else if(t.dataset.group)rows(t.dataset.group).forEach(function(x){x.checked=t.checked});
    sync()});
  sync();
});})();`;

// ---------------------------------------------------------------------------
// Am Objekt: Leistungen verrichten
// ---------------------------------------------------------------------------

export const ExecutePanel: FC<{
  siteId: string;
  services: ExecutableService[];
  open: OpenExecution[];
  token: string;
  today: string;
}> = ({ siteId, services, open, token, today }) => (
  <div class="card" style="margin-top:14px" data-select-scope id="verrichten">
    <h3>Leistungen verrichten (je Ausführung / einmalig / nach Zyklus)</h3>
    <form method="post" action={`/objekte/${siteId}/verrichten`} id="exec-form">
      <input type="hidden" name="token" value={token} />
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th style="width:30px">
                <input type="checkbox" data-all aria-label="alle" />
              </th>
              <th>Leistung</th>
              <th class="r" style="width:110px">
                Menge
              </th>
              <th>Einheit</th>
              <th class="r">Preis</th>
              <th>Hinweis</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => {
              // einmalige Leistungen dürfen öfter verrichtet werden (Ahmed) – jede Ausführung mit eigenem Datum
              return (
                <tr>
                  <td>
                    <input type="checkbox" name="service" value={s.id} data-row aria-label={s.description} />
                  </td>
                  <td>
                    <b>{s.description}</b>
                    {s.note && <div class="small mut">{s.note}</div>}
                    <div class="small faint">
                      {CYCLE_LABEL[s.billing_cycle]} · ab {dateDe(s.valid_from)}
                      {s.valid_to && ` bis ${dateDe(s.valid_to)}`}
                    </div>
                  </td>
                  <td>
                    <input
                      name={`qty_${s.id}`}
                      class="right"
                      value={milliToInput(s.quantity_milli)}
                      aria-label="Menge"
                    />
                  </td>
                  <td>{UNIT_LABELS[s.unit_code] ?? s.unit_code}</td>
                  <td class="r">{euro(s.unit_price_cents)}</td>
                  <td class="small">
                    {s.open_count > 0 && <span class="tag warn">{s.open_count} vorgemerkt</span>}{' '}
                    {s.done_at && <span class="small mut">zuletzt {dateDe(s.done_at)}</span>}
                    {s.next_due && (
                      <div>
                        <span
                          class={`tag ${s.next_due <= today ? 'err' : s.next_due <= addDays(today, 14) ? 'warn' : ''}`}
                        >
                          fällig {s.next_due <= today && !s.done_at ? 'seit' : 'ab'} {dateDe(s.next_due)}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!services.length && (
              <tr>
                <td colspan={6} class="mut">
                  Keine Leistungen, die nach Ausführung abgerechnet werden. Zyklus in der Leistung einstellen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {services.length > 0 && (
        <div class="actions" style="align-items:end">
          <div>
            <label for="exec_from">von</label>
            <input id="exec_from" type="date" name="date_from" value={today} required />
          </div>
          <div>
            <label for="exec_to">bis (leer = ein Tag)</label>
            <input id="exec_to" type="date" name="date_to" />
          </div>
          <button class="btn" data-needs-selection>
            Markierte Leistungen verrichten (<span data-count>0</span>)
          </button>
        </div>
      )}
    </form>
    {open.length > 0 && (
      <>
        <h4 style="margin:16px 0 6px">Vorgemerkt, noch nicht abgerechnet</h4>
        <div class="tbl">
          <table>
            <tbody>
              {open.map((e) => (
                <tr>
                  <td>{range(e.date_from, e.date_to)}</td>
                  <td>{e.description}</td>
                  <td class="r">
                    {milliToInput(e.quantity_milli)} {UNIT_LABELS[e.unit_code] ?? e.unit_code}
                  </td>
                  <td class="r">{euro(amount(e.quantity_milli, e.unit_price_cents))}</td>
                  <td class="r">
                    <form method="post" action={`/ausfuehrungen/${e.id}/loeschen`} style="margin:0">
                      <input type="hidden" name="back" value={`/objekte/${siteId}/leistungen`} />
                      <button
                        class="btn sm ghost"
                        onclick="return confirm('Vorgemerkte Ausführung zurücknehmen?')"
                      >
                        zurücknehmen
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form method="post" action="/rechnungen/entwuerfe/aus-ausfuehrungen" class="actions">
          {open.map((e) => (
            <input type="hidden" name="exec" value={e.id} />
          ))}
          <input type="hidden" name="back" value={`/objekte/${siteId}/leistungen`} />
          <label for="exec_inv_date" class="small">
            Rechnungsdatum
          </label>
          <input id="exec_inv_date" type="date" name="invoice_date" style="max-width:170px" />
          <button class="btn sec">Rechnungsentwurf daraus erstellen</button>
          <a class="small" href="/rechnungen/entwuerfe">
            oder unter Rechnungen → Entwürfe mit anderen zusammen
          </a>
        </form>
      </>
    )}
    <script dangerouslySetInnerHTML={{ __html: SELECT_JS }} />
  </div>
);

// ---------------------------------------------------------------------------
// Rechnungen → Entwürfe
// ---------------------------------------------------------------------------

type DraftRow = InvoiceRow & { customer_name: string; customer_no: string; site_name: string | null };

/** Rechts: vorgemerkte Einzelleistungen je Kunde → Objekt mit Betrag (kompakt, aufklappbar). */
const MONTHS = [
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
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
/** Monat nach dem ENDE des Leistungszeitraums (31.10.–03.11. → November), neueste zuerst. */
const byMonth = (rows: OpenExecution[]) => {
  const m = new Map<string, OpenExecution[]>();
  for (const e of rows) {
    const k = String(e.date_to ?? e.date_from).slice(0, 7);
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
};

const OrderLine: FC<{ o: BillableOrder; g: string }> = ({ o, g }) => {
  const waits = o.work_report_required && o.signed === 0;
  return (
    <label class="ex-line">
      <input type="checkbox" name="order" value={o.id} data-row data-g={g} />
      <span class="ex-desc">
        <a href={`/auftraege/${o.id}`}>{o.number}</a> {o.title}
        <span class="faint">
          {' '}
          · {o.planned_date ? formatDateDe(o.planned_date) : 'ohne Termin'}
          {o.place || o.site_name ? ` · ${o.place ?? o.site_name}` : ''}
          {o.order_reference ? ` · Best.-Nr. ${o.order_reference}` : ''}
        </span>
        {waits && (
          <span class="small" style="color:var(--warn)">
            {' '}
            · Arbeitsschein fehlt
          </span>
        )}
      </span>
      <span class="num">{euro(o.net_cents)}</span>
    </label>
  );
};

/**
 * Rechts: vorgemerkte Einzelleistungen und offene Einzelaufträge – je Monat des Leistungszeitraums (Ende), darin je
 * Kunde (Ahmed 09.10.: Einzelaufträge nicht separat, sondern unter dem Leistungszeitraum).
 */
export const OpenExecutionsBox: FC<{ rows: OpenExecution[]; today: string; orders?: BillableOrder[] }> = ({
  rows,
  orders = [],
}) => {
  const execMonths = new Map(byMonth(rows));
  const orderMonths = new Map<string, BillableOrder[]>();
  for (const o of orders) orderMonths.set(o.month, [...(orderMonths.get(o.month) ?? []), o]);
  const months = [...new Set([...execMonths.keys(), ...orderMonths.keys()])].sort((x, y) =>
    y.localeCompare(x),
  );
  const sumE = (l: OpenExecution[]) =>
    l.reduce((a, e) => a + amount(e.quantity_milli, e.unit_price_cents), 0n);
  const sumO = (l: BillableOrder[]) => l.reduce((a, o) => a + o.net_cents, 0n);
  return (
    <section class="card dr-side" data-select-scope>
      <h3>Aus Einzelleistungen erstellen</h3>
      {months.length === 0 ? (
        <p class="mut small" style="margin:0">
          Nichts vorgemerkt. Leistungen „je Ausführung“ verrichten Sie am Objekt (Reiter „Leistungen &amp;
          Preise“), Einzelaufträge legen Sie beim Kunden an.
        </p>
      ) : (
        <form method="post" action="/rechnungen/entwuerfe/aus-ausfuehrungen">
          {months.map((month, mi) => {
            const mrows = execMonths.get(month) ?? [];
            const mord = orderMonths.get(month) ?? [];
            const custIds = [
              ...new Set([...mrows.map((e) => e.customer_id), ...mord.map((o) => o.customer_id)]),
            ];
            const custName = (id: string) =>
              mrows.find((e) => e.customer_id === id)?.customer_name ??
              mord.find((o) => o.customer_id === id)?.customer_name ??
              '';
            custIds.sort((x, y) => custName(x).localeCompare(custName(y), 'de'));
            return (
              <details class="ex-month" open={mi === 0}>
                <summary>
                  <input
                    type="checkbox"
                    data-group={`${month}|`}
                    aria-label={`alle aus ${monthLabel(month)}`}
                  />
                  <span class="ex-name">
                    {monthLabel(month)} <span class="faint">({mrows.length + mord.length})</span>
                  </span>
                  <b class="num">{euro(sumE(mrows) + sumO(mord))}</b>
                </summary>
                {custIds.map((cid) => {
                  const list = mrows.filter((e) => e.customer_id === cid);
                  const ol = mord.filter((o) => o.customer_id === cid);
                  const g = `${month}|${cid}`;
                  const sites = new Map<string, OpenExecution[]>();
                  for (const e of list) sites.set(e.site_id, [...(sites.get(e.site_id) ?? []), e]);
                  return (
                    <details class="ex-cust">
                      <summary>
                        <input type="checkbox" data-group={g} aria-label={`alle von ${custName(cid)}`} />
                        <span class="ex-name">
                          {custName(cid)} <span class="faint">({list.length + ol.length})</span>
                        </span>
                        <b class="num">{euro(sumE(list) + sumO(ol))}</b>
                      </summary>
                      {[...sites.values()].map((sl) => {
                        const s0 = sl[0]!;
                        return (
                          <div class="ex-site">
                            <div class="ex-site-h">
                              <a href={`/objekte/${s0.site_id}/leistungen`}>{s0.site_name}</a>{' '}
                              <span class="faint small">{s0.site_no}</span>
                              <span class="num small">{euro(sumE(sl))}</span>
                            </div>
                            {sl.map((e) => (
                              <label class="ex-line">
                                <input type="checkbox" name="exec" value={e.id} data-row data-g={g} />
                                <span class="ex-desc">
                                  {e.description}
                                  <span class="faint"> · {range(e.date_from, e.date_to)}</span>
                                </span>
                                <span class="num">{euro(amount(e.quantity_milli, e.unit_price_cents))}</span>
                              </label>
                            ))}
                          </div>
                        );
                      })}
                      {ol.length > 0 && (
                        <div class="ex-site">
                          <div class="ex-site-h">
                            Einzelaufträge <span class="num small">{euro(sumO(ol))}</span>
                          </div>
                          {ol.map((o) => (
                            <OrderLine o={o} g={g} />
                          ))}
                        </div>
                      )}
                    </details>
                  );
                })}
              </details>
            );
          })}
          <div class="dr-side-f">
            <label for="ex_date">Rechnungsdatum</label>
            <input id="ex_date" type="date" name="invoice_date" title="leer = Tag des Ausstellens" />
            <button class="btn" data-needs-selection>
              Entwürfe erstellen (<span data-count>0</span>)
            </button>
          </div>
          <p class="small faint" style="margin:6px 0 0">
            Je Objekt bzw. Rechnungsgruppe ein Entwurf, je Einzelauftrag eine Rechnung.
          </p>
        </form>
      )}
      <script dangerouslySetInnerHTML={{ __html: SELECT_JS }} />
    </section>
  );
};

export const DRAFTS_CSS = `
.dr-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
@media(max-width:1100px){.dr-grid{grid-template-columns:minmax(0,1fr)}}
.dr-list{width:100%;border-collapse:collapse}
.dr-list th{font-size:12px;font-weight:600;color:#667;text-align:left;padding:8px 8px;border-bottom:1px solid #e3e3e6;background:#f6f6f8}
.dr-list td{padding:8px 8px;border-bottom:1px solid #eee;vertical-align:top}
.dr-list tr:hover td{background:#fbfafb}
.dr-list .r{text-align:right;white-space:nowrap}
.dr-list .dr-date b{display:block;font-weight:600}
.dr-list .dr-rcp a{font-weight:600;color:#7D1435;text-decoration:none}
.dr-list .dr-rcp a:hover{text-decoration:underline}
.dr-list .dr-sub{font-size:12px;color:#777;margin-top:2px}
.dr-list .dr-obj{font-size:12px;color:#444;margin-top:2px;line-height:1.35}
.dr-list .dr-chk{white-space:nowrap}
.dr-list .dr-obj span{color:#888}
.dr-sum td{background:#fafafa;font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.02em}
.dr-pill{background:var(--brand-50);padding:2px 8px;border-radius:6px;font-weight:700;color:var(--brand);text-transform:none;letter-spacing:0;font-size:13px}
.dr-ic{display:inline-flex;width:30px;height:30px;align-items:center;justify-content:center;border:1px solid #e3e3e8;border-radius:7px;background:#fff;color:#5b5f6a;cursor:pointer;text-decoration:none;padding:0}
.dr-ic:hover{border-color:#7D1435;color:#7D1435}
.dr-warn{color:#c77700;display:inline-flex;vertical-align:middle}
.dr-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:end;padding:12px 8px;background:#f6f6f8;border-top:1px solid #e3e3e6}
.dr-side h3{margin-top:0}
.ex-month{border-bottom:1px solid #e3e3e3;padding:6px 0}
.ex-month>summary{display:flex;gap:8px;align-items:center;cursor:pointer;list-style:none;font-weight:600}
.ex-month>summary::-webkit-details-marker{display:none}
.ex-month>summary:before{content:'▸';color:#999;width:10px}
.ex-month[open]>summary:before{content:'▾'}
.ex-month .ex-cust{margin-left:14px}
.ex-cust{border-bottom:1px solid #eee;padding:6px 0}
.ex-cust summary{display:flex;gap:8px;align-items:center;cursor:pointer;list-style:none}
.ex-cust summary::-webkit-details-marker{display:none}
.ex-cust summary:before{content:'▸';color:#999;width:10px}
.ex-cust[open] summary:before{content:'▾'}
.ex-name{flex:1;min-width:0}
.num{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.ex-site{margin:6px 0 4px 18px;padding-left:8px;border-left:2px solid #f0dbe2}
.ex-site-h{display:flex;gap:6px;align-items:baseline;font-size:13px;font-weight:600}
.ex-line{display:flex;gap:6px;align-items:baseline;font-size:12.5px;margin:3px 0;cursor:pointer;font-weight:400}
.ex-desc{flex:1;min-width:0}
.dr-side-f{display:grid;grid-template-columns:1fr;gap:6px 8px;align-items:center;margin-top:10px}
.dr-side-f .btn{grid-column:1/-1}
.dr-side-f input{min-width:0;width:100%}
.dr-side{min-width:0}.dr-side .dr-list td{white-space:nowrap;font-size:13px;padding-left:4px;padding-right:4px}.dr-side .mpick{width:100%}.dr-side .mpick select.mpick-s{flex:1}
`;

export const DraftsBox: FC<{ rows: DraftRow[]; today: string; info: Map<string, DraftListInfo> }> = ({
  rows,
  today,
  info,
}) => {
  const net = rows.reduce((a, i) => a + i.net_cents, 0n);
  const gross = rows.reduce((a, i) => a + i.gross_cents, 0n);
  return (
    <section class="card" data-select-scope style="padding:0;overflow:hidden">
      {rows.length === 0 ? (
        <p class="mut small" style="padding:14px">
          Keine Entwürfe.
        </p>
      ) : (
        <form method="post" action="/rechnungen/entwuerfe/auswahl">
          <div class="tbl" style="margin:0;border:0">
            <table class="dr-list">
              <thead>
                <tr>
                  <th style="width:28px" />
                  <th style="width:110px">Datum</th>
                  <th>Empfänger · Objekt</th>
                  <th style="width:36px" />
                  <th class="r" style="width:40px">
                    Pos
                  </th>
                  <th class="r">Netto</th>
                  <th class="r">Brutto</th>
                  <th style="width:36px" />
                </tr>
              </thead>
              <tbody>
                <tr class="dr-sum">
                  <td />
                  <td colspan={4}>Rechnungsentwürfe ({rows.length})</td>
                  <td class="r">
                    <span class="dr-pill">{euro(net)}</span>
                  </td>
                  <td class="r">
                    <span class="dr-pill">{euro(gross)}</span>
                  </td>
                  <td />
                </tr>
                {rows.map((i) => {
                  const x = info.get(i.id);
                  const warn = i.review_required || !i.period_start;
                  return (
                    <tr>
                      <td class="dr-chk">
                        {warn ? (
                          <span
                            class="dr-warn"
                            title={i.review_required ? 'unfertig – bitte prüfen' : 'Leistungszeitraum fehlt'}
                          >
                            <Icon name="alert" size={15} />
                          </span>
                        ) : null}
                        <input
                          type="checkbox"
                          name="inv"
                          value={i.id}
                          data-row
                          data-g="x"
                          aria-label="auswählen"
                        />
                      </td>
                      <td class="dr-date">
                        <b>{i.planned_issue_date ? dateDe(i.planned_issue_date) : dateDe(today)}</b>
                        <span class="small faint">
                          {i.kind === 'invoice'
                            ? 'Re'
                            : i.kind === 'partial'
                              ? 'Abschlag'
                              : i.kind === 'final'
                                ? 'Schluss'
                                : 'Re'}
                          {i.planned_issue_date && i.planned_issue_date > today ? ' · geplant' : ''}
                        </span>
                      </td>
                      <td class="dr-rcp">
                        <a href={`/rechnungen/${i.id}`}>{x?.recipient ?? i.customer_name}</a>{' '}
                        <span class="small faint">{i.customer_no}</span>
                        {i.reverse_charge && (
                          <span class="tag" style="margin-left:6px">
                            § 13b
                          </span>
                        )}
                        {x?.recipient && x.recipient !== i.customer_name && (
                          <div class="dr-sub">{i.customer_name}</div>
                        )}
                        {(x?.places ?? []).slice(0, 3).map((p) => (
                          <div class="dr-obj">
                            {p.name}{' '}
                            <span>
                              ({p.site_no}){p.address ? ` · ${p.address}` : ''}
                            </span>
                          </div>
                        ))}
                        {(x?.places.length ?? 0) > 3 && (
                          <div class="dr-obj">
                            <span>+ {x!.places.length - 3} weitere Objekte</span>
                          </div>
                        )}
                        <div class="dr-obj">
                          {i.period_start ? (
                            <span>Leistung {range(i.period_start, i.period_end ?? i.period_start)}</span>
                          ) : (
                            <span class="tag err">Leistungszeitraum fehlt</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <a
                          class="dr-ic"
                          href={`/rechnungen/${i.id}/vorschau.pdf`}
                          target="_blank"
                          title="PDF-Vorschau"
                        >
                          <Icon name="pdf" size={15} />
                        </a>
                      </td>
                      <td class="r">{x?.pos ?? ''}</td>
                      <td class="r">{euro(i.net_cents)}</td>
                      <td class="r">{euro(i.gross_cents)}</td>
                      <td>
                        <button
                          class="dr-ic"
                          formaction={`/rechnungen/${i.id}/loeschen`}
                          title="Entwurf löschen"
                          onclick="return confirm('Diesen Entwurf löschen? Vorgemerkte Leistungen werden wieder frei.')"
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div class="dr-foot">
            <label class="small" style="display:flex;gap:6px;align-items:center;margin:0 8px 0 0">
              <input type="checkbox" data-all /> Alle auswählen
            </label>
            <input
              type="date"
              name="invoice_date"
              aria-label="Rechnungsdatum"
              title="Rechnungsdatum für die Auswahl"
              style="max-width:160px"
            />
            <button class="btn sec sm" name="aktion" value="datum" data-needs-selection>
              Datum setzen
            </button>
            <button class="btn sec sm" name="aktion" value="pdf" data-needs-selection formtarget="_blank">
              Vorschau (<span data-count>0</span>)
            </button>
            <button
              class="btn sm"
              name="aktion"
              value="ausstellen"
              data-needs-selection
              onclick="return confirm('Markierte Entwürfe jetzt ausstellen? Danach sind sie unveränderbar.')"
            >
              Ausgewählte fertigstellen (<span data-count>0</span>)
            </button>
            <button
              class="btn danger sm"
              name="aktion"
              value="loeschen"
              data-needs-selection
              onclick="return confirm('Markierte Entwürfe löschen? Vorgemerkte Leistungen werden wieder frei.')"
            >
              Löschen (<span data-count>0</span>)
            </button>
          </div>
        </form>
      )}
      <script dangerouslySetInnerHTML={{ __html: SELECT_JS }} />
    </section>
  );
};
