import type { FC } from 'hono/jsx';
import { formatDateDe } from '../domain/invoice/calc.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import type { ExecutableService, OpenExecution } from '../services/executions.js';
import type { InvoiceRow } from '../services/invoices.js';
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
  function rows(g){return scope.querySelectorAll('input[data-row]'+(g?'[data-g="'+g+'"]':''))}
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
  <div class="card" style="margin-top:14px" data-select-scope>
    <h3>Leistungen verrichten (je Ausführung / einmalig)</h3>
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
              const done = s.billing_cycle === 'einmalig' && !!s.done_at;
              return (
                <tr style={done ? 'opacity:.55' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      name="service"
                      value={s.id}
                      data-row
                      disabled={done}
                      aria-label={s.description}
                    />
                  </td>
                  <td>
                    <b>{s.description}</b>
                    {s.note && <div class="small mut">{s.note}</div>}
                    <div class="small faint">
                      {s.billing_cycle === 'einmalig' ? 'einmalig' : 'je Ausführung'} · ab{' '}
                      {dateDe(s.valid_from)}
                      {s.valid_to && ` bis ${dateDe(s.valid_to)}`}
                    </div>
                  </td>
                  <td>
                    <input
                      name={`qty_${s.id}`}
                      class="right"
                      value={milliToInput(s.quantity_milli)}
                      aria-label="Menge"
                      disabled={done}
                    />
                  </td>
                  <td>{UNIT_LABELS[s.unit_code] ?? s.unit_code}</td>
                  <td class="r">{euro(s.unit_price_cents)}</td>
                  <td class="small">
                    {done ? (
                      <span class="tag">verrichtet am {dateDe(s.done_at)}</span>
                    ) : s.open_count > 0 ? (
                      <span class="tag warn">{s.open_count} vorgemerkt</span>
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              );
            })}
            {!services.length && (
              <tr>
                <td colspan={6} class="mut">
                  Keine Leistungen „je Ausführung“ oder „einmalig“. Zyklus in der Leistung einstellen.
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
            Markierte Leistung(en) verrichten (<span data-count>0</span>)
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

const byCustomer = <T extends { customer_id: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.customer_id, [...(m.get(r.customer_id) ?? []), r]);
  return [...m.values()];
};

export const OpenExecutionsBox: FC<{ rows: OpenExecution[]; today: string }> = ({ rows }) => (
  <section class="card" data-select-scope>
    <h3>
      Vorgemerkte Leistungen <span class="cnt">({rows.length})</span>
    </h3>
    {rows.length === 0 ? (
      <p class="mut small">
        Nichts vorgemerkt. Leistungen „je Ausführung“ verrichten Sie am Objekt (Reiter „Leistungen &amp;
        Preise“).
      </p>
    ) : (
      <form method="post" action="/rechnungen/entwuerfe/aus-ausfuehrungen">
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th style="width:30px">
                  <input type="checkbox" data-all aria-label="alle" />
                </th>
                <th>Objekt</th>
                <th>Leistung</th>
                <th>Datum</th>
                <th class="r">Menge</th>
                <th class="r">Netto</th>
              </tr>
            </thead>
            {byCustomer(rows).map((list) => {
              const c = list[0]!;
              return (
                <tbody>
                  <tr class="group-row">
                    <td>
                      <input
                        type="checkbox"
                        data-group={c.customer_id}
                        aria-label={`alle von ${c.customer_name}`}
                      />
                    </td>
                    <td colspan={4}>
                      <b>{c.customer_name}</b> <span class="small mut">{c.customer_no}</span>
                    </td>
                    <td class="r">
                      <b>
                        {euro(list.reduce((a, e) => a + amount(e.quantity_milli, e.unit_price_cents), 0n))}
                      </b>
                    </td>
                  </tr>
                  {list.map((e) => (
                    <tr>
                      <td>
                        <input type="checkbox" name="exec" value={e.id} data-row data-g={c.customer_id} />
                      </td>
                      <td>
                        <a href={`/objekte/${e.site_id}/leistungen`}>{e.site_name}</a>{' '}
                        <span class="small faint">{e.site_no}</span>
                      </td>
                      <td>{e.description}</td>
                      <td class="small">{range(e.date_from, e.date_to)}</td>
                      <td class="r">
                        {milliToInput(e.quantity_milli)} {UNIT_LABELS[e.unit_code] ?? e.unit_code}
                      </td>
                      <td class="r">{euro(amount(e.quantity_milli, e.unit_price_cents))}</td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
        <div class="actions" style="align-items:end">
          <div>
            <label for="ex_date">Rechnungsdatum (leer = Tag des Ausstellens)</label>
            <input id="ex_date" type="date" name="invoice_date" />
          </div>
          <button class="btn" data-needs-selection>
            Entwürfe erstellen (<span data-count>0</span>)
          </button>
          <span class="small mut">Je Objekt bzw. Rechnungsgruppe ein Entwurf (wie der Monatslauf).</span>
        </div>
      </form>
    )}
    <script dangerouslySetInnerHTML={{ __html: SELECT_JS }} />
  </section>
);

export const DraftsBox: FC<{ rows: DraftRow[]; today: string }> = ({ rows, today }) => (
  <section class="card" data-select-scope>
    <h3>
      Rechnungsentwürfe <span class="cnt">({rows.length})</span>
    </h3>
    {rows.length === 0 ? (
      <p class="mut small">Keine Entwürfe.</p>
    ) : (
      <form method="post" action="/rechnungen/entwuerfe/auswahl">
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th style="width:30px">
                  <input type="checkbox" data-all aria-label="alle" />
                </th>
                <th>Objekt</th>
                <th>Leistungszeitraum</th>
                <th>Rechnungsdatum</th>
                <th class="r">Netto</th>
                <th class="r">Brutto</th>
                <th>Hinweis</th>
              </tr>
            </thead>
            {byCustomer(rows).map((list) => {
              const c = list[0]!;
              return (
                <tbody>
                  <tr class="group-row">
                    <td>
                      <input
                        type="checkbox"
                        data-group={c.customer_id}
                        aria-label={`alle von ${c.customer_name}`}
                      />
                    </td>
                    <td colspan={3}>
                      <a href={`/kunden/${c.customer_id}`}>
                        <b>{c.customer_name}</b>
                      </a>{' '}
                      <span class="small mut">{c.customer_no}</span>
                    </td>
                    <td class="r">
                      <b>{euro(list.reduce((a, i) => a + i.net_cents, 0n))}</b>
                    </td>
                    <td class="r">
                      <b>{euro(list.reduce((a, i) => a + i.gross_cents, 0n))}</b>
                    </td>
                    <td />
                  </tr>
                  {list.map((i) => (
                    <tr>
                      <td>
                        <input type="checkbox" name="inv" value={i.id} data-row data-g={c.customer_id} />
                      </td>
                      <td>
                        <a href={`/rechnungen/${i.id}`}>{i.site_name ?? 'ohne Objekt'}</a>
                      </td>
                      <td class="small">
                        {i.period_start ? (
                          range(i.period_start, i.period_end ?? i.period_start)
                        ) : (
                          <span class="tag err">fehlt</span>
                        )}
                      </td>
                      <td class="small">
                        {i.planned_issue_date ? (
                          dateDe(i.planned_issue_date)
                        ) : (
                          <span class="faint">beim Ausstellen</span>
                        )}
                      </td>
                      <td class="r">{euro(i.net_cents)}</td>
                      <td class="r">{euro(i.gross_cents)}</td>
                      <td class="small">
                        {i.review_required && <span class="tag warn">unfertig – prüfen</span>}{' '}
                        {i.reverse_charge && <span class="tag">§ 13b</span>}{' '}
                        {i.planned_issue_date && i.planned_issue_date > today && (
                          <span class="tag">ab {dateDe(i.planned_issue_date)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
        <div class="actions" style="align-items:end;flex-wrap:wrap">
          <div>
            <label for="dr_date">Rechnungsdatum für die Auswahl</label>
            <input id="dr_date" type="date" name="invoice_date" />
          </div>
          <button class="btn sec" name="aktion" value="datum" data-needs-selection>
            Datum setzen
          </button>
          <button
            class="btn"
            name="aktion"
            value="ausstellen"
            data-needs-selection
            onclick="return confirm('Markierte Entwürfe jetzt ausstellen? Danach sind sie unveränderbar.')"
          >
            Markierte ausstellen (<span data-count>0</span>)
          </button>
          <button
            class="btn ghost"
            name="aktion"
            value="loeschen"
            data-needs-selection
            onclick="return confirm('Markierte Entwürfe löschen? Vorgemerkte Leistungen werden wieder frei.')"
          >
            Markierte löschen
          </button>
        </div>
        <p class="small mut">
          Ausstellen: E-Rechnung wird je Rechnung gegen KoSIT geprüft und die nächste Nummer vergeben. Fehler
          bei einer Rechnung halten die anderen nicht auf.
        </p>
      </form>
    )}
    <script dangerouslySetInnerHTML={{ __html: SELECT_JS }} />
  </section>
);
