import type { FC } from 'hono/jsx';
import type { CustomerBankAccount, EntityInvoiceRow, RevenueMode } from '../services/customer-overview.js';
import type { InvoiceGroupRow } from '../services/invoice-groups.js';
import { type Customer, customerStatusOf } from '../services/masterdata.js';
import type { LedgerEntry, OpenItem } from '../services/payments.js';
import { CUSTOMER_STATUS } from '../services/customer-list.js';
import { dateDe, euro } from './layout.js';

/*
 * Kundenübersicht im Aufbau von Fortytools: links Aufgaben, Offene Posten (Soll/Skonto/Haben/Saldo), offene Angebote,
 * Netto-Umsatz; rechts Kundenkarte, Karte, Bankkonten.
 */

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
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** Offene Posten eines Kunden: je Rechnung Soll, darunter Zahlungen, dann Summenzeile mit Saldo und Auswahl. */
export const CustomerLedger: FC<{
  customerId: string;
  items: (OpenItem & { haben: LedgerEntry[] })[];
  today: string;
}> = ({ customerId, items, today }) => {
  const total = items.reduce((a, i) => a + i.open_cents, 0n);
  return (
    <section class="panel">
      <h2 class="panel-title">
        Offene Posten <span class="cnt">({items.length})</span>
      </h2>
      {!items.length ? (
        <div class="empty-line">Derzeit keine offenen Posten.</div>
      ) : (
        <form method="post" action="/mahnungen/stapel" id="cust-op">
          <div class="tbl ledger">
            <table>
              <thead>
                <tr>
                  <th>Rechnung</th>
                  <th>Datum</th>
                  <th class="r" title="Tage bis zur Fälligkeit (negativ = überfällig)">
                    Tage
                  </th>
                  <th class="r">Soll</th>
                  <th class="r">Skonto</th>
                  <th class="r">Haben</th>
                  <th class="r">
                    <span class="total">{euro(total)}</span>
                  </th>
                  <th />
                </tr>
              </thead>
              {items.map((i) => {
                const skonto = i.haben.filter((h) => h.skonto).reduce((a, h) => a + h.cents, 0n);
                const haben = i.haben.filter((h) => !h.skonto).reduce((a, h) => a + h.cents, 0n);
                const days = daysBetween(today, i.due_date);
                return (
                  <tbody class="ledger-item">
                    <tr>
                      <td>
                        <a href={`/rechnungen/${i.invoice_id}`}>
                          <b>{i.number}</b>
                        </a>
                        <a class="pdf" href={`/rechnungen/${i.invoice_id}/pdf`} title="PDF">
                          PDF
                        </a>
                        {i.site_name && <div class="small mut">{i.site_name}</div>}
                      </td>
                      <td>{dateDe(i.issue_date)}</td>
                      <td class={`r ${days < 0 ? 'neg' : 'pos'}`}>{days}</td>
                      <td class="r">{euro(i.payable_cents)}</td>
                      <td />
                      <td />
                      <td />
                      <td />
                    </tr>
                    {i.haben.map((h) => (
                      <tr class="sub">
                        <td class="mut">{h.href ? <a href={h.href}>{h.label}</a> : h.label}</td>
                        <td class="mut">{dateDe(h.date)}</td>
                        <td />
                        <td />
                        <td class="r">{h.skonto ? euro(h.cents) : ''}</td>
                        <td class="r">{h.skonto ? '' : euro(h.cents)}</td>
                        <td />
                        <td />
                      </tr>
                    ))}
                    <tr class="sum">
                      <td colspan={3} />
                      <td class="r">{euro(i.payable_cents)}</td>
                      <td class="r">{skonto ? euro(skonto) : ''}</td>
                      <td class="r">{euro(haben)}</td>
                      <td class="r">
                        <b>{euro(i.open_cents)}</b>
                      </td>
                      <td class="r">
                        <input
                          type="checkbox"
                          name={`inv_${customerId}`}
                          value={i.invoice_id}
                          aria-label={`${i.number} auswählen`}
                        />
                      </td>
                    </tr>
                  </tbody>
                );
              })}
            </table>
          </div>
          <div class="panel-foot">
            <button class="linkbtn">Mahnung erstellen →</button>
          </div>
        </form>
      )}
    </section>
  );
};

export const OpenOffers: FC<{
  customerId: string;
  offers: {
    id: string;
    number: string;
    title: string;
    offer_date: string;
    net_cents: bigint;
    status: string;
  }[];
}> = ({ customerId, offers }) => (
  <section class="panel">
    <h2 class="panel-title">
      Offene Angebote <span class="cnt">({offers.length})</span>
    </h2>
    {!offers.length ? (
      <div class="empty-line">
        Derzeit gibt es keine offenen Angebote.{' '}
        <a href={`/neu?typ=angebot&kunde=${customerId}`}>Neues Angebot erstellen →</a>
      </div>
    ) : (
      <div class="tbl">
        <table>
          <tbody>
            {offers.map((o) => (
              <tr>
                <td>
                  <a href={`/angebote/${o.id}`}>
                    <b>{o.number}</b>
                  </a>{' '}
                  {o.title}
                </td>
                <td>{dateDe(o.offer_date)}</td>
                <td>{o.status === 'entwurf' ? 'Entwurf' : 'abgegeben'}</td>
                <td class="r">{euro(o.net_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

/** Netto-Umsatz: Säulendiagramm mit Achse + Monatstabelle mit Summe, Auswahl Rechnungsdatum/Leistungszeitraum, ab Jahr. */
export const RevenuePanel: FC<{
  rows: { month: string; net_cents: bigint }[];
  mode: RevenueMode;
  fromYear: number;
  years: number[];
}> = ({ rows, mode, fromYear, years }) => {
  const total = rows.reduce((a, r) => a + r.net_cents, 0n);
  const maxC = rows.reduce((m, r) => (r.net_cents > m ? r.net_cents : m), 0n);
  // Achse: runde Schrittweite (1/2/5 × 10^n), 3 Linien
  const maxE = Number(maxC) / 100;
  const raw = maxE / 3 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * pow).find((v) => v >= raw)!;
  const top = step * 3;
  const W = 640;
  const H = 240;
  const L = 64;
  const B = 56;
  const plotW = W - L - 8;
  const plotH = H - B - 10;
  const bw = plotW / Math.max(rows.length, 1);
  const y = (e: number) => 10 + plotH - (Math.max(e, 0) / top) * plotH;
  const fmt = (e: number) => `${e.toLocaleString('de-DE')} €`;
  const labelEvery = Math.ceil(rows.length / 12);
  return (
    <section class="panel">
      <h2 class="panel-title">Netto-Umsatz</h2>
      <form method="get" class="actions" style="margin:0 0 10px">
        <select name="umsatz" aria-label="Zuordnung" onchange="this.form.submit()" style="width:auto">
          <option value="rechnung" selected={mode === 'rechnung'}>
            Nach Rechnungsdatum
          </option>
          <option value="leistung" selected={mode === 'leistung'}>
            Nach Leistungszeitraum
          </option>
        </select>
        <select name="ab" aria-label="ab Jahr" onchange="this.form.submit()" style="width:auto">
          {years.map((yr) => (
            <option value={String(yr)} selected={yr === fromYear}>
              ab {yr}
            </option>
          ))}
        </select>
      </form>
      <div class="revenue">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Netto-Umsatz je Monat" class="revchart">
          {[0, 1, 2, 3].map((k) => (
            <g>
              <line x1={L} x2={W - 8} y1={y(step * k)} y2={y(step * k)} class="grid-line" />
              <text x={L - 8} y={y(step * k) + 4} text-anchor="end" class="axis">
                {fmt(step * k)}
              </text>
            </g>
          ))}
          {rows.map((r, idx) => {
            const e = Number(r.net_cents) / 100;
            const x = L + idx * bw + bw * 0.18;
            return (
              <g>
                <rect x={x} y={y(e)} width={bw * 0.64} height={Math.max(0, y(0) - y(e))} class="bar">
                  <title>
                    {monthLabel(r.month)}: {euro(r.net_cents)}
                  </title>
                </rect>
                {idx % labelEvery === 0 && (
                  <text
                    x={x + bw * 0.32}
                    y={H - B + 14}
                    text-anchor="end"
                    transform={`rotate(-40 ${x + bw * 0.32} ${H - B + 14})`}
                    class="axis"
                  >
                    {monthLabel(r.month)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div class="tbl revtable">
          <table>
            <thead>
              <tr>
                <th>Monat</th>
                <th class="r">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>{monthLabel(r.month)}</td>
                  <td class="r">{euro(r.net_cents)}</td>
                </tr>
              ))}
              <tr class="sum">
                <td>
                  <b>Summe</b>
                </td>
                <td class="r">
                  <b>{euro(total)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

const STATUS_CLASS = { kunde: 'ok', interessent: 'warn', ehemalig: 'err' } as const;

/** Rechte Spalte: Kundenkarte mit Adresse, Rechnungs-E-Mails, „Kunde seit“, Status. */
export const CustomerSide: FC<{ c: Customer; groups: InvoiceGroupRow[] }> = ({ c, groups }) => {
  const st = customerStatusOf(c);
  const address = `${c.street}, ${c.postal_code} ${c.city}`;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  const emails = [...new Set(groups.filter((g) => g.active).flatMap((g) => g.bill_emails))];
  const since = c.customer_since ?? (c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : null);
  return (
    <div class="panel side-card">
      <div class="side-actions">
        <a class="btn sec sm" href={`/kunden/${c.id}/bearbeiten`}>
          Bearbeiten
        </a>
      </div>
      <div class="addr">
        <b>{c.name}</b>
        {c.name2 && <div>{c.name2}</div>}
        <div>
          {c.street}{' '}
          <a href={mapsUrl} target="_blank" rel="noopener" title="In Google Maps öffnen" class="pin">
            Karte
          </a>
        </div>
        <div>
          {c.postal_code} {c.city}
        </div>
      </div>
      {emails.map((e) => (
        <div>
          <a href={`mailto:${e}`}>{e}</a>
        </div>
      ))}
      {c.contact_phone && <div>{c.contact_phone}</div>}
      {since && (
        <div class="mut small" style="margin-top:6px">
          Kunde seit: {dateDe(since)}
        </div>
      )}
      {c.notes && (
        <div class="small" style="margin-top:8px;white-space:pre-line">
          {c.notes}
        </div>
      )}
      <div style="margin-top:10px">
        <span class={`tag ${STATUS_CLASS[st]}`}>{CUSTOMER_STATUS[st]}</span>
      </div>
    </div>
  );
};

/** Karte erst auf Klick laden (keine Verbindung zu Google ohne Zustimmung – Datenschutz). */
export const MapPanel: FC<{ c: Customer }> = ({ c }) => {
  const q = encodeURIComponent(`${c.street}, ${c.postal_code} ${c.city}`);
  return (
    <section class="panel">
      <h3 class="panel-head">Karte</h3>
      <div class="map" data-src={`https://maps.google.com/maps?q=${q}&output=embed`}>
        <button
          type="button"
          class="btn sec sm"
          onclick="var m=this.parentNode;var f=document.createElement('iframe');f.src=m.dataset.src;f.loading='lazy';f.title='Karte';f.referrerPolicy='no-referrer';m.innerHTML='';m.appendChild(f);"
        >
          Karte laden
        </button>
        <div class="small mut">Beim Laden werden Daten an Google übertragen.</div>
      </div>
    </section>
  );
};

export const BankPanel: FC<{ customerId: string; accounts: CustomerBankAccount[]; newId: string }> = ({
  customerId,
  accounts,
  newId,
}) => (
  <section class="panel">
    <h3 class="panel-head">Bankkonten</h3>
    {accounts.map((a) => (
      <div class="bank">
        <div>
          <span class="mut">Kontoinhaber</span> {a.holder}
        </div>
        <div>
          <span class="mut">IBAN</span> {a.iban.replace(/(.{4})/g, '$1 ').trim()}
        </div>
        {a.bic && (
          <div>
            <span class="mut">BIC</span> {a.bic}
          </div>
        )}
        <form method="post" action={`/kunden/${customerId}/bankkonten/${a.id}/loeschen`} class="bank-del">
          <button class="linkbtn small" onclick="return confirm('Bankkonto entfernen?')">
            entfernen
          </button>
        </form>
      </div>
    ))}
    {!accounts.length && <div class="small mut">Noch kein Bankkonto hinterlegt.</div>}
    <details class="bank-add">
      <summary class="btn sec sm">Bankkonto hinzufügen</summary>
      <form method="post" action={`/kunden/${customerId}/bankkonten/${newId}`} class="inline">
        <div class="grid">
          <div>
            <label for="bk-holder">Kontoinhaber</label>
            <input id="bk-holder" name="holder" required />
          </div>
          <div>
            <label for="bk-iban">IBAN</label>
            <input id="bk-iban" name="iban" required />
          </div>
          <div>
            <label for="bk-bic">BIC</label>
            <input id="bk-bic" name="bic" />
          </div>
        </div>
        <div class="actions">
          <button class="btn sm">Speichern</button>
        </div>
      </form>
    </details>
  </section>
);

/** Rechnungen eines Kunden/Objekts wie Fortytools: Monatsübersicht netto/brutto, Liste mit Objekt und Status. */
export const EntityInvoices: FC<{
  rows: EntityInvoiceRow[];
  months: { month: string; net_cents: bigint; gross_cents: bigint }[];
  showSite: boolean;
  newHref: string;
  /** ohne: nur die neuesten 60 Rechnungen, darunter „alle anzeigen“ */
  showAll?: boolean;
}> = ({ rows: allRows, months, showSite, newHref, showAll }) => {
  const rows = showAll ? allRows : allRows.slice(0, 60);
  const sumNet = months.reduce((a, m) => a + m.net_cents, 0n);
  const sumGross = months.reduce((a, m) => a + m.gross_cents, 0n);
  const status = (r: EntityInvoiceRow) =>
    r.status === 'draft'
      ? ['draft', 'Entwurf']
      : r.cancelled
        ? ['err', 'storniert']
        : r.kind === 'cancellation' || r.kind === 'correction'
          ? ['info', r.kind === 'cancellation' ? 'Storno' : 'Korrektur']
          : r.legacy && r.open_cents == null && !r.legacy_paid
            ? ['ok', 'Ausgeglichen']
            : r.open_cents == null || r.open_cents <= 0n
              ? ['ok', 'Bezahlt']
              : r.open_cents < r.gross_cents
                ? ['warn', 'Teilbezahlt']
                : ['warn', 'Offen'];
  return (
    <>
      <div class="actions" style="margin-top:0">
        <a class="btn sm" href={newHref}>
          + Rechnung
        </a>
      </div>
      <div class="tbl" style="margin-bottom:20px">
        <table>
          <thead>
            <tr>
              <th />
              {months.map((m) => (
                <th class="r">{monthLabel(m.month).replace(/ (\d\d)$/, ' 20$1')}</th>
              ))}
              <th class="r">Summe</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>Netto</b>
              </td>
              {months.map((m) => (
                <td class="r">{euro(m.net_cents)}</td>
              ))}
              <td class="r">
                <b>{euro(sumNet)}</b>
              </td>
            </tr>
            <tr>
              <td>
                <b>Brutto</b>
              </td>
              {months.map((m) => (
                <td class="r">{euro(m.gross_cents)}</td>
              ))}
              <td class="r">
                <b>{euro(sumGross)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Rechnung</th>
              <th>Empfänger</th>
              {showSite && <th>Objekt</th>}
              <th class="r">Pos</th>
              <th class="r">Netto</th>
              <th class="r">Brutto</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [cls, label] = status(r);
              return (
                <tr>
                  <td>{r.issue_date ? dateDe(r.issue_date) : <span class="mut">–</span>}</td>
                  <td>
                    <a href={`/rechnungen/${r.id}`}>
                      <b>{r.number ?? 'Entwurf'}</b>
                    </a>
                    {r.status === 'issued' && (
                      <a class="pdf" href={`/rechnungen/${r.id}/pdf`} title="PDF">
                        PDF
                      </a>
                    )}
                  </td>
                  <td>
                    {r.recipient}
                    {r.first_line && <div class="small mut">{r.first_line}</div>}
                  </td>
                  {showSite && (
                    <td>
                      {r.site_id ? (
                        <a href={`/objekte/${r.site_id}`}>{r.site_name}</a>
                      ) : r.group_name ? (
                        <span>Sammelrechnung {r.group_name}</span>
                      ) : (
                        <span class="mut">ohne Objekt</span>
                      )}
                    </td>
                  )}
                  <td class="r">{r.positions}</td>
                  <td class="r mut">{euro(r.net_cents)}</td>
                  <td class="r">{euro(r.gross_cents)}</td>
                  <td>
                    <span class={`tag ${cls}`}>{label}</span>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colspan={showSite ? 8 : 7} class="mut">
                  Noch keine Rechnungen.
                </td>
              </tr>
            )}
            {rows.length < allRows.length && (
              <tr>
                <td colspan={showSite ? 8 : 7}>
                  <a href="?alle=1">Alle {allRows.length} Rechnungen anzeigen</a>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
};
