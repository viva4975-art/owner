import type { FC } from 'hono/jsx';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  markLegacyPaid,
  openLegacyInvoices,
  renderLegacyInvoicePdf,
} from '../services/fortytools-xml-import.js';
import { type Ctx, UUID } from './app.js';
import { PageHead, dateDe, euro } from './layout.js';

/*
 * Rechnungen aus Fortytools (Archiv, nur lesen): Liste beim Kunden/Objekt, Detail mit Positionen, offene unter
 * „Offene Posten“ mit „bezahlt am“. Ausgestellt und archiviert wurden sie in Fortytools (dort liegen die PDFs).
 */

export interface LegacyRow {
  id: string;
  number: string;
  issue_date: string;
  due_date: string | null;
  net_cents: bigint;
  gross_cents: bigint;
  paid: boolean;
  paid_at: string | null;
  customer_name: string | null;
  sites: string | null;
}

export async function legacyInvoices(sql: Sql, f: { customerId?: string; siteId?: string }) {
  return sql<LegacyRow[]>`
    select l.id, l.number, l.issue_date::text, l.due_date::text, l.net_cents, l.gross_cents, l.paid, l.paid_at::text,
           c.name as customer_name,
           (select string_agg(distinct s.name, ', ') from app.legacy_invoice_lines x join app.sites s on s.id = x.site_id
             where x.invoice_id = l.id) as sites
      from app.legacy_invoices l left join app.customers c on c.id = l.customer_id
     where ${f.customerId ? sql`l.customer_id = ${f.customerId}` : sql`true`}
       and ${f.siteId ? sql`exists (select 1 from app.legacy_invoice_lines x where x.invoice_id = l.id and x.site_id = ${f.siteId})` : sql`true`}
     order by l.issue_date desc, l.number desc`;
}

export const LegacyInvoiceList: FC<{ rows: LegacyRow[]; showSite?: boolean }> = ({
  rows,
  showSite = true,
}) =>
  rows.length === 0 ? null : (
    <details class="card" style="margin-top:14px">
      <summary>
        <b>Frühere Rechnungen ({rows.length})</b>{' '}
        <span class="small mut">– offen: {rows.filter((r) => !r.paid).length}</span>
      </summary>
      <div class="tbl" style="margin-top:10px">
        <table class="stack-m">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Nr.</th>
              {showSite && <th>Objekt</th>}
              <th class="r">Netto</th>
              <th class="r">Brutto</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td data-l="Datum">{dateDe(r.issue_date)}</td>
                <td data-l="Nr.">
                  <a href={`/rechnungen/fortytools/${r.id}`}>{r.number}</a>{' '}
                  <a class="small" href={`/rechnungen/fortytools/${r.id}/pdf`} target="_blank">
                    PDF
                  </a>
                </td>
                {showSite && (
                  <td data-l="Objekt" class="small">
                    {r.sites ?? '–'}
                  </td>
                )}
                <td class="r" data-l="Netto">
                  {euro(r.net_cents)}
                </td>
                <td class="r" data-l="Brutto">
                  {euro(r.gross_cents)}
                </td>
                <td data-l="Status">
                  {r.paid ? (
                    <span class="badge ok">bezahlt{r.paid_at ? ` ${dateDe(r.paid_at)}` : ''}</span>
                  ) : (
                    <span class="badge warn">offen</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );

/** Offene Posten: offene Fortytools-Rechnungen mit „bezahlt am“ */
export const OpenLegacyCard: FC<{ rows: Awaited<ReturnType<typeof openLegacyInvoices>>[number][] }> = ({
  rows,
}) =>
  rows.length === 0 ? null : (
    <div class="card" style="margin-top:16px">
      <h3 style="margin-top:0">
        Offene Rechnungen vor der Umstellung ({rows.length} ·{' '}
        {euro(rows.reduce((a, r) => a + r.gross_cents, 0n))})
      </h3>
      <p class="small mut" style="margin-top:0">
        Zahlung festhalten: voller Betrag = bezahlt, weniger = Teilzahlung.
      </p>
      <div class="tbl">
        <table class="stack-m">
          <thead>
            <tr>
              <th>Kunde</th>
              <th>Nr.</th>
              <th>Datum</th>
              <th>fällig</th>
              <th class="r">Brutto</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td data-l="Kunde">
                  {r.customer_id ? (
                    <a href={`/kunden/${r.customer_id}`}>{r.customer_name}</a>
                  ) : (
                    (r.customer_no ?? '–')
                  )}
                </td>
                <td data-l="Nr.">
                  <a href={`/rechnungen/fortytools/${r.id}`}>{r.number}</a>
                </td>
                <td data-l="Datum">{dateDe(r.issue_date)}</td>
                <td
                  data-l="fällig"
                  style={r.due_date && r.due_date < todayBerlin() ? 'color:var(--err)' : ''}
                >
                  {r.due_date ? dateDe(r.due_date) : '–'}
                </td>
                <td class="r" data-l="Brutto">
                  {euro(r.gross_cents)}
                </td>
                <td class="acts">
                  <form
                    method="post"
                    action={`/rechnungen/fortytools/${r.id}/bezahlt`}
                    class="actions"
                    style="margin:0"
                  >
                    <input
                      type="date"
                      name="datum"
                      value={todayBerlin()}
                      required
                      style="max-width:150px"
                      aria-label="bezahlt am"
                    />
                    <input
                      name="betrag"
                      inputmode="decimal"
                      value={(Number(r.gross_cents) / 100).toFixed(2).replace('.', ',')}
                      style="max-width:110px"
                      aria-label="Betrag (weniger = Teilzahlung)"
                      title="Betrag – weniger als offen = Teilzahlung"
                    />
                    <button class="btn sm sec">Zahlung</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

export function registerLegacyInvoiceRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get(`/rechnungen/fortytools/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [inv] = await sql<
      (LegacyRow & {
        customer_id: string | null;
        customer_no: string | null;
        payment_terms: string | null;
        customer_reference: string | null;
        delivery_date: string | null;
      })[]
    >`select l.*, l.issue_date::text, l.due_date::text, l.paid_at::text, l.delivery_date::text, c.name as customer_name, null as sites
        from app.legacy_invoices l left join app.customers c on c.id = l.customer_id where l.id = ${id}`;
    if (!inv) return c.notFound();
    const lines = await sql<
      {
        position: number;
        title: string | null;
        details: string | null;
        quantity_milli: bigint;
        unit: string | null;
        unit_price_cents: bigint;
        net_cents: bigint;
        service_type: string | null;
        period_start: string | null;
        period_end: string | null;
        site_id: string | null;
        site_name: string | null;
        site_no: string | null;
      }[]
    >`select x.*, x.period_start::text, x.period_end::text, s.name as site_name, s.site_no
        from app.legacy_invoice_lines x left join app.sites s on s.id = x.site_id
       where x.invoice_id = ${id} order by x.position`;
    return page(
      c,
      `Rechnung ${inv.number}`,
      'rechnungen',
      <>
        <PageHead title={`Rechnung ${inv.number}`} crumbs={[['Rechnungen', '/rechnungen']]}>
          <a class="btn" href={`/rechnungen/fortytools/${id}/pdf`} target="_blank">
            PDF öffnen
          </a>
        </PageHead>
        <div class="card">
          <dl class="kv">
            <dt>Kunde</dt>
            <dd>
              {inv.customer_id ? (
                <a href={`/kunden/${inv.customer_id}`}>{inv.customer_name}</a>
              ) : (
                (inv.customer_no ?? '–')
              )}
            </dd>
            <dt>Rechnungsdatum</dt>
            <dd>{dateDe(inv.issue_date)}</dd>
            <dt>Fällig</dt>
            <dd>{inv.due_date ? dateDe(inv.due_date) : '–'}</dd>
            {inv.customer_reference && (
              <>
                <dt>Referenz des Kunden</dt>
                <dd>{inv.customer_reference}</dd>
              </>
            )}
            <dt>Zahlungsbedingung</dt>
            <dd>{inv.payment_terms ?? '–'}</dd>
            <dt>Status</dt>
            <dd>{inv.paid ? `bezahlt${inv.paid_at ? ` am ${dateDe(inv.paid_at)}` : ''}` : 'offen'}</dd>
          </dl>
        </div>
        <div class="tbl">
          <table class="stack-m">
            <thead>
              <tr>
                <th>Pos.</th>
                <th>Leistung</th>
                <th>Objekt</th>
                <th>Zeitraum</th>
                <th class="r">Menge</th>
                <th class="r">Einzelpreis</th>
                <th class="r">Netto</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr>
                  <td data-l="Pos.">{l.position}</td>
                  <td data-l="Leistung">
                    <b>{l.title ?? l.service_type ?? ''}</b>
                    {l.service_type && l.title && <div class="small mut">{l.service_type}</div>}
                    {l.details && (
                      <div class="small" style="white-space:pre-line">
                        {l.details}
                      </div>
                    )}
                  </td>
                  <td data-l="Objekt" class="small">
                    {l.site_id ? (
                      <a href={`/objekte/${l.site_id}`}>
                        {l.site_name} ({l.site_no})
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td data-l="Zeitraum" class="small">
                    {l.period_start
                      ? `${dateDe(l.period_start)}${l.period_end && l.period_end !== l.period_start ? ` – ${dateDe(l.period_end)}` : ''}`
                      : ''}
                  </td>
                  <td class="r" data-l="Menge">
                    {(Number(l.quantity_milli) / 1000).toLocaleString('de-DE')} {l.unit ?? ''}
                  </td>
                  <td class="r" data-l="Einzelpreis">
                    {euro(l.unit_price_cents)}
                  </td>
                  <td class="r" data-l="Netto">
                    {euro(l.net_cents)}
                  </td>
                </tr>
              ))}
              <tr>
                <td colspan={6} class="r">
                  <b>Netto / Brutto</b>
                </td>
                <td class="r">
                  <b>{euro(inv.net_cents)}</b>
                  <div class="small">{euro(inv.gross_cents)}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="small mut">
          Vor der Umstellung ausgestellt; das PDF wird aus den übernommenen Rechnungsdaten erzeugt. Nicht
          änderbar – bitte nicht erneut als Rechnung an den Kunden senden (doppelte Rechnung, § 14c UStG).
        </p>
      </>,
    );
  });

  app.get(`/rechnungen/fortytools/:id{${UUID}}/pdf`, async (c) => {
    const { pdf, filename } = await renderLegacyInvoicePdf(sql, c.req.param('id'));
    return c.body(pdf as unknown as ArrayBuffer, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
  });

  app.post(`/rechnungen/fortytools/:id{${UUID}}/bezahlt`, async (c) => {
    const b = await c.req.parseBody();
    const betrag = String(b.betrag ?? '').trim();
    let cents: bigint | undefined;
    try {
      cents = betrag ? parseEuro(betrag) : undefined;
    } catch {
      return back(c, '/offene-posten', { fehler: `Betrag „${betrag}“ ist ungültig` });
    }
    await markLegacyPaid(sql, c.req.param('id'), String(b.datum ?? ''), c.get('actor'), cents);
    return back(c, '/offene-posten', { ok: 'Zahlung festgehalten.' });
  });
}
