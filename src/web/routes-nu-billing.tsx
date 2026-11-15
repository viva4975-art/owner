import { randomUUID } from 'node:crypto';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import { getSupplier } from '../services/inventory.js';
import {
  SELF_BILLING_VAT,
  type ExtraLine,
  type PickedLine,
  createCreditNote,
  invoiceFromStatement,
  listCreditNotes,
  nuStatement,
  nuStatements,
  selfBillingAgreementPdf,
  sendCreditNote,
  setSelfBilling,
  skipStatement,
  statementLabel,
} from '../services/nu-statement.js';
import { type Ctx, UUID } from './app.js';
import { centsToInput, str } from './forms.js';
import { PageHead, anz, euro } from './layout.js';
import { MonthSelect } from './routes-purchasing.js';

/*
 * NU-Abrechnung je Monat (Ahmed 15.11.): Übersicht aller Nachunternehmer eines Monats und je Nachunternehmer ein Blatt
 * mit den Positionen laut Bestellungen. Daraus: Rechnung des NU erfassen, Gutschrift erstellen (wenn vereinbart) oder
 * „keine Rechnung“ vermerken.
 */

const MON_DE = [
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
const monthName = (m: string) => `${MON_DE[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const addMonth = (m: string, n: number) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
/** Standard: Vormonat (der laufende ist meist noch nicht abzurechnen) */
const defaultMonth = () => addMonth(todayBerlin().slice(0, 7), -1);
const monthOf = (v: string | undefined) => (v && /^\d{4}-\d{2}$/.test(v) ? v : defaultMonth());

const STATE_BADGE: Record<string, [string, string]> = {
  offen: ['warn', 'offen'],
  abgerechnet: ['ok', 'abgerechnet'],
  keine: ['grey', 'keine Rechnung'],
};

export function registerNuBillingRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const files = { sql, filesDir: env.FILES_DIR, maxBytes: env.UPLOAD_MAX_BYTES };

  const MonthNav = ({ month, base }: { month: string; base: string }) => (
    <div style="display:flex;gap:8px;align-items:center;margin:0 0 14px;flex-wrap:wrap">
      <a class="btn sec sm" href={`${base}?monat=${addMonth(month, -1)}`} aria-label="Vormonat">
        ‹ {monthName(addMonth(month, -1))}
      </a>
      <form method="get" action={base} style="margin:0;display:inline-block;width:220px">
        <MonthSelect name="monat" value={month} label="Monat" autosubmit />
      </form>
      <a class="btn sec sm" href={`${base}?monat=${addMonth(month, 1)}`} aria-label="Folgemonat">
        {monthName(addMonth(month, 1))} ›
      </a>
    </div>
  );

  // ------------------------------------------------------------------ Übersicht
  app.get('/nachunternehmer/abrechnung', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const [list, notes] = await Promise.all([nuStatements(sql, month), listCreditNotes(sql, { month })]);
    const open = list.filter((s) => s.lines.some((l) => l.state === 'offen'));
    const done = list.filter((s) => !s.lines.some((l) => l.state === 'offen'));
    const total = open.reduce((a, s) => a + s.openTotal, 0n);
    const Row = ({ s }: { s: (typeof list)[number] }) => {
      const nOpen = s.lines.filter((l) => l.state === 'offen').length;
      return (
        <tr>
          <td>
            <a href={`/lieferanten/${s.supplierId}/abrechnung?monat=${month}`}>
              <b>{s.supplierName}</b>
            </a>
            <div class="small mut">
              {s.supplierNo}
              {s.selfBilling && ' · Gutschriftverfahren'}
            </div>
          </td>
          <td class="r">{anz(s.lines.length, 'Position', 'Positionen')}</td>
          <td class="r">{s.billedTotal ? euro(s.billedTotal) : '–'}</td>
          <td class="r">
            <b>{nOpen ? euro(s.openTotal) : '–'}</b>
          </td>
          <td>
            {nOpen ? (
              <span class="badge warn">{anz(nOpen, 'offen', 'offen')}</span>
            ) : (
              <span class="badge ok">erledigt</span>
            )}
          </td>
          <td class="r">
            <a
              class={nOpen ? 'btn sm' : 'btn sec sm'}
              href={`/lieferanten/${s.supplierId}/abrechnung?monat=${month}`}
            >
              {nOpen ? (s.selfBilling ? 'Gutschrift / abrechnen' : 'Abrechnen') : 'Ansehen'}
            </a>
          </td>
        </tr>
      );
    };
    return page(
      c,
      'NU-Abrechnung',
      'lieferanten',
      <>
        <PageHead
          title={`NU-Abrechnung ${monthName(month)}`}
          crumbs={[['Nachunternehmer', '/nachunternehmer']]}
        />
        <MonthNav month={month} base="/nachunternehmer/abrechnung" />
        <p class="small mut" style="max-width:860px;margin-top:-4px">
          Je Nachunternehmer alles, was laut erteilten Bestellungen in diesem Monat anfällt (Pauschalen, je
          m², je Tag, Stunden und Regie aus dem Stundennachweis). Öffnen → Rechnung des Nachunternehmers
          erfassen, Gutschrift erstellen oder „keine Rechnung“ vermerken. Die Kosten landen automatisch auf
          den Objekten (Kostenstellen).
        </p>
        <div class="kpis" style="margin-bottom:14px">
          <div class="kpi">
            <div class="kpi-l">noch abzurechnen</div>
            <div class="kpi-v">{euro(total)}</div>
            <div class="small mut">{anz(open.length, 'Nachunternehmer', 'Nachunternehmer')}</div>
          </div>
          <div class="kpi">
            <div class="kpi-l">erledigt</div>
            <div class="kpi-v">{done.length}</div>
            <div class="small mut">Rechnung da oder keine nötig</div>
          </div>
          <div class="kpi">
            <div class="kpi-l">Gutschriften</div>
            <div class="kpi-v">{notes.length}</div>
            <div class="small mut">für {monthName(month)}</div>
          </div>
        </div>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nachunternehmer</th>
                  <th class="r">Positionen</th>
                  <th class="r">abgerechnet</th>
                  <th class="r">offen netto</th>
                  <th>Stand</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {open.map((s) => (
                  <Row s={s} />
                ))}
                {done.map((s) => (
                  <Row s={s} />
                ))}
                {!list.length && (
                  <tr>
                    <td colspan={6}>
                      <div class="empty">Keine erteilten Bestellungen in {monthName(month)}.</div>
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

  // ------------------------------------------------------------------ Blatt je Nachunternehmer
  app.get(`/lieferanten/:id{${UUID}}/abrechnung`, async (c) => {
    const id = c.req.param('id');
    const month = monthOf(c.req.query('monat'));
    const s = await getSupplier(sql, id);
    if (!s) return c.notFound();
    const [st, notes, last] = await Promise.all([
      nuStatement(sql, id, month),
      listCreditNotes(sql, { supplierId: id }),
      sql<{ reverse_charge: boolean }[]>`
        select reverse_charge from app.incoming_invoices where supplier_id = ${id}
         order by invoice_date desc limit 1`,
    ]);
    const rc = s.self_billing_vat ? s.self_billing_vat === '13b' : (last[0]?.reverse_charge ?? true);
    const anyOpen = st.lines.some((l) => l.state === 'offen');
    const rid = randomUUID();
    const today = todayBerlin();
    return page(
      c,
      `NU-Abrechnung ${s.name}`,
      'lieferanten',
      <>
        <PageHead
          title={`Abrechnung ${monthName(month)}`}
          crumbs={[
            ['NU-Abrechnung', `/nachunternehmer/abrechnung?monat=${month}`],
            [s.name, `/lieferanten/${id}`],
          ]}
        />
        <MonthNav month={month} base={`/lieferanten/${id}/abrechnung`} />
        <p class="small" style="margin-top:-4px">
          <b>{s.name}</b> ({s.supplier_no}) ·{' '}
          {st.selfBilling ? (
            <span class="badge ok">Gutschriftverfahren seit {formatDateDe(s.self_billing_since!)}</span>
          ) : (
            <span class="mut">stellt eigene Rechnungen</span>
          )}{' '}
          · <a href={`/lieferanten/${id}/auftraege`}>Bestellungen</a>
        </p>

        <form
          method="post"
          action={`/lieferanten/${id}/abrechnung/rechnung`}
          enctype="multipart/form-data"
          id="nuabr"
          data-resubmit
        >
          <input type="hidden" name="rid" value={rid} />
          <input type="hidden" name="monat" value={month} />
          <div class="card">
            <div class="tbl">
              <table class="keep" data-nostick>
                <thead>
                  <tr>
                    <th style="width:28px">
                      <input
                        type="checkbox"
                        data-nuabr-all
                        aria-label="alle offenen wählen"
                        checked={anyOpen}
                      />
                    </th>
                    <th>Bestellung</th>
                    <th>Abrechnung</th>
                    <th class="r" style="width:150px">
                      Betrag netto
                    </th>
                    <th>Stand</th>
                  </tr>
                </thead>
                <tbody>
                  {st.lines.map((l) => {
                    const open = l.state === 'offen';
                    const [tone, label] = STATE_BADGE[l.state]!;
                    return (
                      <tr style={open ? '' : 'opacity:.6'}>
                        <td>
                          {open && (
                            <input
                              type="checkbox"
                              name="pick"
                              value={l.key}
                              checked={(l.amount ?? 0n) > 0n}
                              aria-label={`${l.number} wählen`}
                            />
                          )}
                        </td>
                        <td>
                          <a href={`/nachunternehmer/auftraege/${l.subcontractId}`}>
                            <b>{l.number}</b>
                          </a>{' '}
                          · {l.serviceKind}
                          {l.kind === 'regie' && <span class="badge info">Regie</span>}
                          <div class="small mut">{l.where}</div>
                        </td>
                        <td class="small">
                          {l.calc}
                          {!l.calc.startsWith('Pauschale je Einsatz') && (
                            <div class="mut">{statementLabel(l)}</div>
                          )}
                        </td>
                        <td class="r">
                          {open ? (
                            <input
                              name={`amt_${l.key}`}
                              inputmode="decimal"
                              value={l.amount !== null ? centsToInput(l.amount) : ''}
                              placeholder="Betrag"
                              aria-label={`Betrag ${l.number}`}
                              style="max-width:130px;text-align:right"
                            />
                          ) : l.amount !== null ? (
                            euro(l.amount)
                          ) : (
                            '–'
                          )}
                        </td>
                        <td class="small">
                          <span class={`badge ${tone}`}>{label}</span>
                          {l.invoices.map((i) => (
                            <div>
                              <a href={`/rechnungseingang/${i.id}`}>{i.invoice_no}</a>
                            </div>
                          ))}
                          {l.state === 'keine' && l.skipReason && <div class="mut">{l.skipReason}</div>}
                        </td>
                      </tr>
                    );
                  })}
                  {!st.lines.length && (
                    <tr>
                      <td colspan={5}>
                        <div class="empty">Keine erteilten Bestellungen in {monthName(month)}.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
                {anyOpen && (
                  <tfoot>
                    <tr>
                      <td colspan={3} class="r">
                        <b>Ausgewählt netto</b>
                      </td>
                      <td class="r">
                        <b data-nuabr-sum>{euro(st.openTotal)}</b>
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {anyOpen && (
              <p class="small mut" style="margin:8px 0 0">
                Beträge sind änderbar (z. B. Abzug wegen nicht erbrachter Leistung). Zusatzarbeiten ohne
                Bestellung bitte als Regiestunden in der Bestellung erfassen oder bei der Gutschrift als
                Zusatzzeile.
              </p>
            )}
          </div>

          {anyOpen && (
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:14px;align-items:start">
              {st.selfBilling && (
                <section class="card accent">
                  <h3 style="margin-top:0">Gutschrift erstellen</h3>
                  <p class="small mut" style="margin-top:-6px">
                    Wir rechnen ab, die Gutschrift gilt als Rechnung des Nachunternehmers (§ 14 Abs. 2 S. 2
                    UStG). Umsatzsteuer: {SELF_BILLING_VAT[s.self_billing_vat ?? '13b']}.
                  </p>
                  <label>
                    Datum der Gutschrift
                    <input type="date" name="datum" value={today} max={today} />
                  </label>
                  <details style="margin:8px 0">
                    <summary>Zusatzzeilen (z. B. Abzug, Zusatzleistung)</summary>
                    {[0, 1, 2].map((i) => (
                      <div class="actions" style="margin-top:6px">
                        <input
                          name="x_text"
                          placeholder="Text, z. B. Abzug 16.10. nicht gereinigt"
                          aria-label={`Zusatzzeile ${i + 1} Text`}
                        />
                        <input
                          name="x_amt"
                          inputmode="decimal"
                          placeholder="Betrag (Abzug mit −)"
                          aria-label={`Zusatzzeile ${i + 1} Betrag`}
                          style="max-width:160px"
                        />
                      </div>
                    ))}
                  </details>
                  <label>
                    Bemerkung (intern)
                    <input name="g_note" />
                  </label>
                  <button
                    class="btn"
                    formaction={`/lieferanten/${id}/abrechnung/gutschrift`}
                    data-confirm="Gutschrift mit eigener Nummer erstellen? Sie ist danach unveränderbar."
                    style="margin-top:10px"
                  >
                    Gutschrift erstellen
                  </button>
                </section>
              )}
              <section class="card">
                <h3 style="margin-top:0">Rechnung des Nachunternehmers erfassen</h3>
                <p class="small mut" style="margin-top:-6px">
                  Rechnung liegt vor: Nummer, Datum, Betrag laut Rechnung und PDF. Weicht der Betrag von der
                  Auswahl ab, wird die Abweichung vermerkt; die Kosten werden im Verhältnis auf die
                  Bestellungen verteilt.
                </p>
                <div class="grid">
                  <label>
                    Rechnungsnr.
                    <input name="invoice_no" />
                  </label>
                  <label>
                    Rechnungsdatum
                    <input type="date" name="invoice_date" value={today} />
                  </label>
                  <label>
                    Fällig am (leer = Zahlungsziel)
                    <input type="date" name="due_date" />
                  </label>
                  <label>
                    Netto laut Rechnung (leer = Auswahl)
                    <input name="net" inputmode="decimal" />
                  </label>
                  <label>
                    USt
                    <select name="vat_mode">
                      <option value="13b" selected={rc}>
                        § 13b – ohne USt
                      </option>
                      <option value="19" selected={!rc}>
                        19 %
                      </option>
                      <option value="0">ohne USt (Kleinunternehmer)</option>
                    </select>
                  </label>
                  <div>
                    <label for="nuabr-file">Rechnung (PDF/Foto)</label>
                    <input id="nuabr-file" type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" />
                  </div>
                </div>
                <button class="btn sec" style="margin-top:10px">
                  Rechnung erfassen
                </button>
              </section>
              <section class="card">
                <h3 style="margin-top:0">Keine Rechnung</h3>
                <p class="small mut" style="margin-top:-6px">
                  Für die gewählten Positionen kommt keine Rechnung (z. B. nicht ausgeführt, schon anders
                  abgerechnet).
                </p>
                <label>
                  Grund
                  <input name="reason" placeholder="z. B. Objekt geschlossen" />
                </label>
                <button
                  class="btn ghost"
                  formaction={`/lieferanten/${id}/abrechnung/keine`}
                  style="margin-top:10px"
                >
                  Als „keine Rechnung“ vermerken
                </button>
              </section>
            </div>
          )}
        </form>

        {notes.length > 0 && (
          <section class="card" style="margin-top:14px">
            <h3 style="margin-top:0">Gutschriften</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Nummer</th>
                    <th>Monat</th>
                    <th class="r">Betrag</th>
                    <th>Versand</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map((n) => (
                    <tr>
                      <td>
                        <a href={`/rechnungseingang/${n.incoming_invoice_id}`}>{n.number}</a>
                      </td>
                      <td>{monthName(n.period_month.slice(0, 7))}</td>
                      <td class="r">{euro(n.gross_cents)}</td>
                      <td class="small">
                        {n.sent_at
                          ? `gesendet ${formatDateDe(n.sent_at.toISOString().slice(0, 10))}`
                          : 'noch nicht'}
                      </td>
                      <td class="r">
                        {n.file_id && (
                          <a class="btn sec sm" href={`/dateien/${n.file_id}`} target="_blank">
                            PDF
                          </a>
                        )}{' '}
                        <form
                          method="post"
                          action={`/gutschriften/${n.incoming_invoice_id}/senden`}
                          style="display:inline"
                        >
                          <input
                            type="hidden"
                            name="zurueck"
                            value={`/lieferanten/${id}/abrechnung?monat=${month}`}
                          />
                          <button
                            class="btn sec sm"
                            data-confirm={`Gutschrift ${n.number} an ${s.email ?? '(keine E-Mail)'} senden?`}
                          >
                            {n.sent_at ? 'erneut senden' : 'per E-Mail senden'}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <details class="card" style="margin-top:14px">
          <summary>
            <b>Gutschriftverfahren</b>{' '}
            <span class="small mut">
              {s.self_billing_since
                ? `vereinbart seit ${formatDateDe(s.self_billing_since)}`
                : 'nicht vereinbart'}
            </span>
          </summary>
          <p class="small mut">
            Statt Rechnungen anzufordern, rechnen wir mit einer Gutschrift ab. Voraussetzung: vorher
            schriftlich vereinbart (Vereinbarung als PDF unten, unterschrieben unter Dokumente ablegen),
            Steuernummer oder USt-IdNr. des Nachunternehmers steht auf jeder Gutschrift. Der Nachunternehmer
            kann einer Gutschrift widersprechen – dann verliert sie die Wirkung als Rechnung. Leer lassen =
            Nachunternehmer stellt Rechnungen.
          </p>
          <form method="post" action={`/lieferanten/${id}/gutschriftverfahren`} class="grid">
            <input type="hidden" name="monat" value={month} />
            <label>
              Vereinbart ab
              <input type="date" name="since" value={s.self_billing_since ?? ''} />
            </label>
            <label>
              Umsatzsteuer auf der Gutschrift
              <select name="vat">
                {Object.entries(SELF_BILLING_VAT).map(([k, v]) => (
                  <option value={k} selected={(s.self_billing_vat ?? '13b') === k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Steuernummer des Nachunternehmers
              <input name="tax_no" value={s.tax_no ?? ''} />
            </label>
            <label>
              USt-IdNr. des Nachunternehmers
              <input name="vat_id" value={s.vat_id ?? ''} />
            </label>
            <div class="actions">
              <button class="btn sec">Speichern</button>
              <a class="btn ghost" href={`/lieferanten/${id}/gutschriftverfahren.pdf`} target="_blank">
                Vereinbarung als PDF
              </a>
            </div>
          </form>
        </details>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var f=document.getElementById('nuabr');if(!f)return;function n(v){v=String(v||'').trim().replace(/\\s|€/g,'');if(!v)return 0;if(v.indexOf(',')>=0)v=v.replace(/\\./g,'').replace(',','.');var x=Math.round(parseFloat(v)*100);return isFinite(x)?x:0}function upd(){var s=0;f.querySelectorAll('input[name=pick]').forEach(function(b){if(b.checked){var a=f.querySelector('[name="amt_'+b.value+'"]');s+=a?n(a.value):0}});var o=f.querySelector('[data-nuabr-sum]');if(o)o.textContent=(s/100).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €'}f.addEventListener('change',function(e){if(e.target.matches('[data-nuabr-all]'))f.querySelectorAll('input[name=pick]').forEach(function(b){b.checked=e.target.checked});upd()});f.addEventListener('input',upd);upd()})();`,
          }}
        />
      </>,
    );
  });

  /** Gewählte Positionen mit Beträgen aus dem Formular */
  const picked = (b: Record<string, unknown>): PickedLine[] => {
    const v = b.pick;
    const keys = (Array.isArray(v) ? v : v !== undefined ? [v] : []).map(String);
    return keys.map((key) => {
      const raw = b[`amt_${key}`];
      const a = typeof raw === 'string' ? raw.trim() : '';
      if (!a) throw new BusinessError('Bei einer gewählten Position fehlt der Betrag');
      return { key, amount: parseEuro(a) };
    });
  };
  const listOf = (b: Record<string, unknown>, k: string) => {
    const v = b[k];
    return (Array.isArray(v) ? v : v !== undefined ? [v] : []).map((x) => (typeof x === 'string' ? x : ''));
  };

  app.post(`/lieferanten/:id{${UUID}}/abrechnung/rechnung`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    const month = monthOf(str(b as never, 'monat') ?? undefined);
    const ret = `/lieferanten/${id}/abrechnung?monat=${month}`;
    try {
      const p = picked(b);
      const sum = p.reduce((a, x) => a + x.amount, 0n);
      const netIn = str(b as never, 'net');
      const net = netIn ? parseEuro(netIn) : sum;
      const mode = str(b as never, 'vat_mode') ?? '13b';
      const vat = mode === '19' ? (net * 19n * 2n + 100n) / 200n : 0n;
      const file = b.file instanceof File && b.file.size ? b.file : null;
      const invoiceId = await invoiceFromStatement(
        files,
        {
          id: str(b as never, 'rid') ?? randomUUID(),
          supplierId: id,
          month,
          picked: p,
          invoiceNo: str(b as never, 'invoice_no') ?? '',
          invoiceDate: str(b as never, 'invoice_date') ?? todayBerlin(),
          dueDate: str(b as never, 'due_date'),
          net,
          vat,
          reverseCharge: mode === '13b',
          note: null,
          file: file
            ? { name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) }
            : null,
        },
        c.get('actor'),
      );
      return back(c, `/rechnungseingang/${invoiceId}`, {
        ok: 'Rechnung erfasst und den Bestellungen zugeordnet – bitte prüfen und freigeben.',
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, ret, { fehler: e.message });
      throw e;
    }
  });

  app.post(`/lieferanten/:id{${UUID}}/abrechnung/gutschrift`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    const month = monthOf(str(b as never, 'monat') ?? undefined);
    const ret = `/lieferanten/${id}/abrechnung?monat=${month}`;
    try {
      const texts = listOf(b, 'x_text');
      const amts = listOf(b, 'x_amt');
      const extras: ExtraLine[] = [];
      texts.forEach((t, i) => {
        const a = (amts[i] ?? '').trim();
        if (!t.trim() && !a) return;
        if (!t.trim() || !a) throw new BusinessError('Zusatzzeile: bitte Text und Betrag angeben');
        extras.push({ text: t.trim(), amount: parseEuro(a) });
      });
      const r = await createCreditNote(
        files,
        {
          id: str(b as never, 'rid') ?? randomUUID(),
          supplierId: id,
          month,
          picked: picked(b),
          extras,
          date: str(b as never, 'datum') ?? todayBerlin(),
          note: str(b as never, 'g_note'),
        },
        c.get('actor'),
      );
      return back(c, ret, {
        ok: `Gutschrift ${r.number} erstellt und freigegeben – steht in der Zahlungsliste. Jetzt per E-Mail senden.`,
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, ret, { fehler: e.message });
      throw e;
    }
  });

  app.post(`/lieferanten/:id{${UUID}}/abrechnung/keine`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    const month = monthOf(str(b as never, 'monat') ?? undefined);
    const ret = `/lieferanten/${id}/abrechnung?monat=${month}`;
    try {
      const n = await skipStatement(
        sql,
        id,
        month,
        listOf(b, 'pick'),
        str(b as never, 'reason') ?? '',
        c.get('actor'),
      );
      return back(c, ret, { ok: `${anz(n, 'Bestellung', 'Bestellungen')}: „keine Rechnung“ vermerkt.` });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, ret, { fehler: e.message });
      throw e;
    }
  });

  app.post(`/lieferanten/:id{${UUID}}/gutschriftverfahren`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody()) as Record<string, string>;
    const month = monthOf(b.monat);
    const ret = `/lieferanten/${id}/abrechnung?monat=${month}`;
    try {
      const vat = b.vat === '19' || b.vat === 'klein' ? b.vat : '13b';
      await setSelfBilling(
        sql,
        id,
        { since: b.since?.trim() || null, vat, taxNo: b.tax_no ?? null, vatId: b.vat_id ?? null },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, ret, { fehler: e.message });
      throw e;
    }
    return back(c, ret, { ok: 'Gutschriftverfahren gespeichert.' });
  });

  app.get(`/lieferanten/:id{${UUID}}/gutschriftverfahren.pdf`, async (c) => {
    const id = c.req.param('id');
    const s = await getSupplier(sql, id);
    if (!s) return c.notFound();
    const pdf = await selfBillingAgreementPdf(sql, id, s.self_billing_since ?? null);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="Vereinbarung_Gutschriftverfahren.pdf"',
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.post(`/gutschriften/:id{${UUID}}/senden`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody()) as Record<string, string>;
    const ret =
      typeof b.zurueck === 'string' && /^\/[a-z]/.test(b.zurueck) ? b.zurueck : `/rechnungseingang/${id}`;
    try {
      const to = await sendCreditNote(deps, id, c.get('actor'));
      return back(c, ret, { ok: `Gutschrift gesendet an ${to.join(', ')}.` });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, ret, { fehler: e.message });
      throw e;
    }
  });
}
