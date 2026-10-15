import { randomUUID } from 'node:crypto';
import { copyLegacyToDraft, createLegacyCancellation, createLegacyCorrection } from '../services/invoices.js';
import { writeOffPart } from '../services/payments.js';
import { createReductionVoucher } from '../services/reduction-vouchers.js';
import { BusinessError } from '../services/errors.js';
import { uploadConfig } from './routes-files.js';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { markLegacyPaid, renderLegacyInvoicePdf } from '../services/fortytools-xml-import.js';
import type { Context } from 'hono';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { PageHead, dateDe, euro } from './layout.js';

/*
 * Rechnungen von vor der Umstellung (nur lesen): gleiche Adresse und Listen wie eigene Rechnungen, ohne Kennzeichnung
 * (Ahmed 09.10.: „wie originale Dateien“). Ausgestellt wurden sie im alten Programm; PDF aus den Rechnungsdaten.
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

/** Rechnung von vor der Umstellung: Ansicht wie eine ausgestellte Rechnung (Blatt links, Angaben rechts). */
export async function legacyInvoicePage(sql: Sql, page: Ctx['page'], c: Context<AppEnv>, id: string) {
  const [inv] = await sql<
    (LegacyRow & {
      customer_id: string | null;
      customer_no: string | null;
      payment_terms: string | null;
      customer_reference: string | null;
      paid_part_cents: bigint;
    })[]
  >`select l.*, l.issue_date::text, l.due_date::text, l.paid_at::text, c.name as customer_name, null as sites
      from app.legacy_invoices l left join app.customers c on c.id = l.customer_id where l.id = ${id}`;
  if (!inv) return c.notFound();
  const [open] = await sql<{ open_cents: bigint }[]>`
    select open_cents from app.legacy_open_items where invoice_id = ${id}`;
  const sites = await sql<{ id: string; name: string; site_no: string }[]>`
    select distinct s.id, s.name, s.site_no from app.legacy_invoice_lines x join app.sites s on s.id = x.site_id
     where x.invoice_id = ${id} order by s.site_no`;
  const derived = await sql<
    { id: string; kind: string; status: string; number: string | null; payable_cents: bigint }[]
  >`select id, kind::text as kind, status::text as status, number, payable_cents from app.invoices
     where original_legacy_invoice_id = ${id} order by created_at`;
  const cancelled = derived.find((d) => d.kind === 'cancellation');
  const title = `${inv.net_cents < 0n ? 'Rechnungskorrektur' : 'Rechnung'} ${inv.number}`;
  const pdf = `/rechnungen/${id}/pdf`;
  return page(
    c,
    title,
    'rechnungen',
    <>
      <style>{`.lg-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:18px;align-items:start}
@media(max-width:1000px){.lg-grid{grid-template-columns:minmax(0,1fr)}}
.lg-pdf{width:100%;height:calc(100vh - 170px);min-height:640px;border:1px solid #e3e3e6;border-radius:6px;background:#fff}
@media(max-width:700px){.lg-pdf{display:none}}`}</style>
      <PageHead title={title} crumbs={[['Rechnungen', '/rechnungen']]} />
      <div class="lg-grid">
        <iframe class="lg-pdf" src={pdf} title={title} />
        <div>
          <div class="actions" style="margin-top:0;flex-direction:column;align-items:stretch">
            <a class="btn" href={pdf} target="_blank">
              PDF öffnen
            </a>
          </div>
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
              {sites.length > 0 && (
                <>
                  <dt>Objekt</dt>
                  <dd>
                    {sites.map((x, i) => (
                      <>
                        {i > 0 && ', '}
                        <a href={`/objekte/${x.id}`}>{x.name}</a>
                      </>
                    ))}
                  </dd>
                </>
              )}
              <dt>Rechnungsdatum</dt>
              <dd>{dateDe(inv.issue_date)}</dd>
              <dt>Fällig</dt>
              <dd>{inv.due_date ? dateDe(inv.due_date) : '–'}</dd>
              {inv.customer_reference && (
                <>
                  <dt>Ihre Referenz</dt>
                  <dd>{inv.customer_reference}</dd>
                </>
              )}
              <dt>Netto</dt>
              <dd>{euro(inv.net_cents)}</dd>
              <dt>Brutto</dt>
              <dd>
                <b>{euro(inv.gross_cents)}</b>
              </dd>
              <dt>Status</dt>
              <dd>
                {open && open.open_cents > 0n ? (
                  <span class={`badge ${inv.due_date && inv.due_date < todayBerlin() ? 'err' : 'warn'}`}>
                    offen · {euro(open.open_cents)}
                  </span>
                ) : inv.paid ? (
                  <span class="badge ok">bezahlt{inv.paid_at ? ` ${dateDe(inv.paid_at)}` : ''}</span>
                ) : (
                  <span class="badge ok">ausgeglichen</span>
                )}
              </dd>
              <dt>Versand</dt>
              <dd>versendet</dd>
            </dl>
          </div>
          {derived.length > 0 && (
            <div class="card">
              <h3 style="margin-top:0">Storno / Korrektur</h3>
              {derived.map((d) => (
                <div>
                  <a href={`/rechnungen/${d.id}`}>
                    {d.kind === 'cancellation' ? 'Stornorechnung' : 'Rechnungskorrektur'}{' '}
                    {d.number ?? '(Entwurf)'}
                  </a>{' '}
                  <span class="small mut">{euro(d.payable_cents)}</span>
                </div>
              ))}
            </div>
          )}
          {inv.gross_cents > 0n && inv.customer_id && (
            <div class="card">
              <h3 style="margin-top:0">Stornieren / neu ausstellen</h3>
              <p class="small mut" style="margin-top:0">
                Hier in der neuen App, nicht in Fortytools – Fortytools nutzt denselben Nummernkreis. Die
                Stornorechnung bekommt eine neue Nummer und verweist auf {inv.number}; danach ggf. die
                Rechnung neu ausstellen.
              </p>
              {!cancelled && (
                <form
                  method="post"
                  action={`/rechnungen/fortytools/${id}/storno`}
                  onsubmit={`return confirm(${JSON.stringify(`Stornorechnung zu ${inv.number} als Entwurf anlegen? Sie wird erst mit „Fertigstellen“ ausgestellt.`)})`}
                >
                  <button class="btn sec" style="width:100%">
                    Stornorechnung erstellen
                  </button>
                </form>
              )}
              <form method="post" action={`/rechnungen/fortytools/${id}/neu`} style="margin-top:8px">
                <button class="btn sec" style="width:100%">
                  Als neue Rechnung kopieren
                </button>
              </form>
            </div>
          )}
          {inv.gross_cents > 0n && inv.customer_id && open && open.open_cents > 0n && (
            <div class="card">
              <h3 style="margin-top:0">Gutschrift / Verrechnung</h3>
              <p class="small mut" style="margin-top:0">
                Betrag mindern – als Rechnungskorrektur an den Kunden oder nur intern mit Kürzungsbeleg.
              </p>
              <a class="btn sec" style="width:100%" href={`/rechnungen/${id}/verrechnung`}>
                Minderung erfassen …
              </a>
            </div>
          )}
          {open && open.open_cents > 0n && (
            <form method="post" action={`/rechnungen/fortytools/${id}/bezahlt`} class="card">
              <h3 style="margin-top:0">Zahlung festhalten</h3>
              <label>bezahlt am</label>
              <input type="date" name="datum" value={todayBerlin()} required />
              <label>Betrag (weniger = Teilzahlung)</label>
              <input
                name="betrag"
                inputmode="decimal"
                value={(Number(open.open_cents) / 100).toFixed(2).replace('.', ',')}
              />
              <button class="btn sec" style="margin-top:8px">
                Zahlung buchen
              </button>
            </form>
          )}
        </div>
      </div>
    </>,
  );
}

export async function legacyInvoicePdf(sql: Sql, c: Context<AppEnv>, id: string) {
  const { pdf, filename } = await renderLegacyInvoicePdf(sql, id);
  return c.body(pdf as unknown as ArrayBuffer, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
}

export function registerLegacyInvoiceRoutes(ctx: Ctx) {
  const { app, deps, back, page } = ctx;
  const sql = deps.sql;
  // alte Adressen → gemeinsame Rechnungsadresse
  app.get(`/rechnungen/fortytools/:id{${UUID}}`, (c) => c.redirect(`/rechnungen/${c.req.param('id')}`));
  app.get(`/rechnungen/fortytools/:id{${UUID}}/pdf`, (c) =>
    c.redirect(`/rechnungen/${c.req.param('id')}/pdf`),
  );

  // Storno / neu ausstellen in der neuen App (Ahmed 09.10.: „muss ich es noch bei Fortytools machen?“ – nein)
  app.post(`/rechnungen/fortytools/:id{${UUID}}/storno`, async (c) => {
    const nid = await createLegacyCancellation(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/rechnungen/${nid}`, {
      ok: 'Stornorechnung als Entwurf angelegt – prüfen und fertigstellen (KoSIT-Prüfung, neue Nummer).',
    });
  });
  app.post(`/rechnungen/fortytools/:id{${UUID}}/neu`, async (c) => {
    const nid = await copyLegacyToDraft(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/rechnungen/${nid}`, {
      ok: 'Neuer Rechnungsentwurf mit den Positionen der alten Rechnung.',
    });
  });

  // ------------------------------------------------------------------ Gutschrift / Verrechnung (Minderung)
  // Ahmed 15.10.: „auch aus den alten Rechnungen eine Gutschrift oder so zur Verrechnung, intern, mit der Rechnung
  // verbunden, buchhalterisch richtig“. Zwei richtige Wege: Rechnungskorrektur (Beleg an den Kunden, Belegart 384) oder
  // interne Kürzung mit Kürzungsbeleg (nichts an den Kunden). Das Wort „Gutschrift“ wird auf Belegen nicht verwendet.
  app.get(`/rechnungen/:id{${UUID}}/verrechnung`, async (c) => {
    const id = c.req.param('id');
    const [lg] = await sql<{ number: string; issue_date: string; net_cents: bigint; gross_cents: bigint }[]>`
      select number, issue_date::text, net_cents, gross_cents from app.legacy_invoices where id = ${id}`;
    const [own] = lg
      ? []
      : await sql<
          { number: string | null; issue_date: string | null; net_cents: bigint; gross_cents: bigint }[]
        >`
          select number, issue_date::text, net_cents, gross_cents from app.invoices
           where id = ${id} and status = 'issued' and kind in ('invoice', 'partial', 'final')`;
    const inv = lg ?? own;
    if (!inv) return c.notFound();
    const [o] = lg
      ? await sql<
          { open_cents: bigint }[]
        >`select open_cents from app.legacy_open_items where invoice_id = ${id}`
      : await sql<{ open_cents: bigint }[]>`select open_cents from app.open_items where invoice_id = ${id}`;
    const open = o?.open_cents ?? 0n;
    const key = randomUUID();
    return page(
      c,
      `Minderung zu ${inv.number}`,
      'rechnungen',
      <>
        <PageHead
          title={`Gutschrift / Verrechnung zu Rechnung ${inv.number}`}
          crumbs={[[`Rechnung ${inv.number}`, `/rechnungen/${id}`]]}
        />
        <p class="mut" style="margin-top:0">
          Rechnung vom {dateDe(inv.issue_date ?? '')} · netto {euro(inv.net_cents)} · brutto{' '}
          {euro(inv.gross_cents)} · <b>offen {euro(open)}</b>
        </p>
        <div
          class="grid2"
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px"
        >
          <div class="card">
            <h3 style="margin-top:0">A · Rechnungskorrektur an den Kunden</h3>
            <p class="small">
              Wenn der Kunde einen Beleg bekommen soll oder die Minderung vereinbart ist (z. B. Leistung nicht
              erbracht, Preisfehler). Eigene Nummer, Verweis auf {inv.number}, E-Rechnung (Belegart 384). Die
              Umsatzsteuer wird damit sofort richtig gemindert. Der Betrag wird mit dem offenen Posten
              verrechnet.
            </p>
            {lg ? (
              <form method="post" action={`/rechnungen/fortytools/${id}/korrektur`}>
                <label for="k_net">Minderung netto (€)</label>
                <input id="k_net" name="netto" inputmode="decimal" required placeholder="0,00" />
                <label for="k_reason">Grund (steht auf der Korrektur)</label>
                <input
                  id="k_reason"
                  name="grund"
                  required
                  placeholder="z. B. Reinigung 03.–05.09. ausgefallen"
                />
                <div class="formfoot">
                  <button class="btn">Rechnungskorrektur als Entwurf anlegen</button>
                </div>
              </form>
            ) : (
              <a class="btn" href={`/rechnungen/${id}/korrektur`}>
                Rechnungskorrektur anlegen
              </a>
            )}
          </div>
          <div class="card">
            <h3 style="margin-top:0">B · Nur intern: Kürzung ausbuchen</h3>
            <p class="small">
              Wenn der Kunde einfach weniger zahlt bzw. mit etwas verrechnet und kein Beleg an ihn geht. Der
              Betrag (brutto) wird an der Rechnung ausgebucht, es entsteht ein interner Kürzungsbeleg KB-…
              (PDF in der Kundenakte, Liste unter Rechnungen → Kürzungsbelege, DATEV-Hinweis). Umsatzsteuer:
              Minderung erst, wenn die Kürzung endgültig ist (§ 17 UStG) – der Steuerberater bucht nach dem
              Beleg.
            </p>
            {open > 0n ? (
              <form
                method="post"
                action={`/rechnungen/${id}/verrechnung`}
                onsubmit="return confirm('Betrag intern ausbuchen und Kürzungsbeleg erstellen?')"
              >
                <input type="hidden" name="key" value={key} />
                <label for="w_amt">Betrag brutto (€, höchstens {euro(open)})</label>
                <input id="w_amt" name="betrag" inputmode="decimal" required placeholder="0,00" />
                <label for="w_date">Datum</label>
                <input id="w_date" name="datum" type="date" value={todayBerlin()} required />
                <label for="w_reason">Grund</label>
                <input
                  id="w_reason"
                  name="grund"
                  required
                  placeholder="z. B. Kunde verrechnet Mängelabzug / Gegenforderung"
                />
                <div class="formfoot">
                  <button class="btn">Ausbuchen + Kürzungsbeleg</button>
                </div>
              </form>
            ) : (
              <p class="small mut">Rechnung ist nicht mehr offen.</p>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.post(`/rechnungen/fortytools/:id{${UUID}}/korrektur`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    let net: bigint;
    try {
      net = parseEuro(String(b.netto ?? ''));
    } catch {
      throw new BusinessError('Betrag ungültig');
    }
    const nid = await createLegacyCorrection(
      sql,
      id,
      { netCents: net, reason: String(b.grund ?? '') },
      c.get('actor'),
    );
    return back(c, `/rechnungen/${nid}`, {
      ok: 'Rechnungskorrektur als Entwurf angelegt – prüfen und fertigstellen (KoSIT-Prüfung, neue Nummer).',
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/verrechnung`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const key = /^[0-9a-f-]{36}$/.test(String(b.key ?? '')) ? String(b.key) : randomUUID();
    const [lg] = await sql`select 1 from app.legacy_invoices where id = ${id}`;
    let amount: bigint;
    try {
      amount = parseEuro(String(b.betrag ?? ''));
    } catch {
      throw new BusinessError('Betrag ungültig');
    }
    const date = String(b.datum ?? '');
    const reason = String(b.grund ?? '');
    await writeOffPart(sql, {
      key,
      invoiceId: id,
      legacy: !!lg,
      amount,
      date,
      reason,
      actor: c.get('actor'),
    });
    const v = await createReductionVoucher(sql, uploadConfig(ctx), {
      key,
      invoiceId: id,
      legacy: !!lg,
      grossCents: amount,
      date,
      reason,
      actor: c.get('actor'),
    });
    return back(c, `/rechnungen/${id}`, {
      ok: `Kürzung ${euro(amount)} ausgebucht · Kürzungsbeleg ${v.number} erstellt (Kunde → Dokumente, Rechnungen → Kürzungsbelege).`,
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
