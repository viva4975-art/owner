import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { BusinessError } from '../services/errors.js';
import { loadEInvoice, takeOverEInvoice, uploadEInvoice } from '../services/einvoice-inbox.js';
import { listSuppliers } from '../services/inventory.js';
import { listSites } from '../services/masterdata.js';
import { COST_CATEGORY, type CostCategory } from '../services/purchasing.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, dateDe, euro } from './layout.js';
import { SiteOptions } from './site-options.js';

const UNIT: Record<string, string> = {
  C62: 'Stk.',
  H87: 'Stk.',
  HUR: 'Std.',
  MON: 'Monat',
  DAY: 'Tag',
  MTK: 'm²',
  MTR: 'm',
  LTR: 'l',
  KGM: 'kg',
  LS: 'pauschal',
  XPP: 'Stk.',
};
const qty = (milli: bigint | string) => {
  const n = Number(milli) / 1000;
  return n.toLocaleString('de-DE', { maximumFractionDigits: 3 });
};
const pct = (bp: number) => `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;
const TYPE: Record<string, string> = {
  '380': 'Rechnung',
  '326': 'Abschlagsrechnung',
  '875': 'Abschlagsrechnung',
  '876': 'Abschlagsrechnung',
  '877': 'Schlussrechnung',
  '381': 'Korrektur (Minderung)',
  '384': 'Rechnungskorrektur / Storno',
  '389': 'Rechnung (vom Empfänger ausgestellt)',
};

export interface EInvoiceLines {
  lines: {
    name: string;
    quantityMilli: string | bigint;
    unitCode: string | null;
    netCents: string | bigint;
    vatRateBp: number | null;
  }[];
  vat: { category: string; rateBp: number; baseCents: string | bigint; taxCents: string | bigint }[];
}

/** Positionen + Steueraufschlüsselung einer E-Rechnung (Prüfseite und Eingangsrechnung). */
export const EInvoiceTable: FC<EInvoiceLines> = ({ lines, vat }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Pos.</th>
          <th>Leistung / Artikel</th>
          <th class="r">Menge</th>
          <th>Einheit</th>
          <th class="r">USt</th>
          <th class="r">Netto</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr>
            <td>{i + 1}</td>
            <td style="white-space:pre-line">{l.name}</td>
            <td class="r">{qty(l.quantityMilli)}</td>
            <td>{l.unitCode ? (UNIT[l.unitCode] ?? l.unitCode) : ''}</td>
            <td class="r">{l.vatRateBp == null ? '' : pct(l.vatRateBp)}</td>
            <td class="r">{euro(BigInt(l.netCents))}</td>
          </tr>
        ))}
        {vat.map((v) => (
          <tr class="small mut">
            <td colspan={5} class="r">
              {v.category === 'AE'
                ? 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b)'
                : `USt ${pct(v.rateBp)}`}{' '}
              auf {euro(BigInt(v.baseCents))}
            </td>
            <td class="r">{euro(BigInt(v.taxCents))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export function EInvoiceRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const cfg = { dir: env.FILES_DIR, maxBytes: env.UPLOAD_MAX_BYTES };

  app.post('/rechnungseingang/e-rechnung', async (c) => {
    const b = await c.req.parseBody();
    const file = b.datei;
    if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte eine Datei auswählen');
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const f = await uploadEInvoice(
      sql,
      cfg,
      { id, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
      c.get('actor'),
    );
    return c.redirect(`/rechnungseingang/e-rechnung/${f.id}`, 303);
  });

  app.get(`/rechnungseingang/e-rechnung/:file{${UUID}}`, async (c) => {
    const fileId = c.req.param('file');
    const v = await loadEInvoice(sql, cfg, fileId);
    if (v.takenId) return c.redirect(`/rechnungseingang/${v.takenId}`, 303);
    const [suppliers, sites] = await Promise.all([listSuppliers(sql), listSites(sql)]);
    const { e } = v;
    const own = v.warnings.some((w) => w.startsWith('Das ist eine Rechnung von uns selbst'));
    const s = e.seller;
    return page(
      c,
      `E-Rechnung ${e.invoiceNo}`,
      'lieferanten',
      <>
        <PageHead
          title={`E-Rechnung ${e.invoiceNo} prüfen`}
          crumbs={[['Rechnungseingang', '/rechnungseingang']]}
        >
          <span class="badge">{e.fromPdf ? 'ZUGFeRD/Factur-X (PDF)' : `XRechnung ${e.syntax}`}</span>
        </PageHead>
        {v.warnings.length > 0 && (
          <div class={`flash ${own ? 'err' : 'warn'}`}>
            <span>
              {v.warnings.map((w) => (
                <div>{w}</div>
              ))}
            </span>
          </div>
        )}
        {v.duplicateId && (
          <div class="flash err">
            <span>
              Rechnung {e.invoiceNo} dieses Lieferanten ist schon erfasst –{' '}
              <a href={`/rechnungseingang/${v.duplicateId}`}>ansehen</a>. Nicht doppelt übernehmen.
            </span>
          </div>
        )}
        <div class="cols">
          <div class="card">
            <h3 style="margin-top:0">{TYPE[e.typeCode] ?? `Belegart ${e.typeCode}`}</h3>
            <dl class="kv">
              <dt>Rechnungsnummer</dt>
              <dd>
                <b>{e.invoiceNo}</b>
              </dd>
              <dt>Rechnungsdatum</dt>
              <dd>{dateDe(e.issueDate)}</dd>
              <dt>fällig</dt>
              <dd>{e.dueDate ? dateDe(e.dueDate) : '– (Zahlungsziel des Lieferanten)'}</dd>
              {(e.periodStart || e.deliveryDate) && (
                <>
                  <dt>Leistung</dt>
                  <dd>
                    {e.periodStart
                      ? `${dateDe(e.periodStart)} – ${e.periodEnd ? dateDe(e.periodEnd) : ''}`
                      : dateDe(e.deliveryDate!)}
                  </dd>
                </>
              )}
              {e.precedingInvoice && (
                <>
                  <dt>bezieht sich auf</dt>
                  <dd>Rechnung {e.precedingInvoice}</dd>
                </>
              )}
              {e.orderReference && (
                <>
                  <dt>Bestellnummer</dt>
                  <dd>{e.orderReference}</dd>
                </>
              )}
              <dt>Netto</dt>
              <dd>{euro(e.netCents)}</dd>
              <dt>USt</dt>
              <dd>
                {euro(e.vatCents)}
                {e.reverseCharge && <span class="badge tag"> § 13b</span>}
              </dd>
              <dt>Brutto</dt>
              <dd>
                <b>{euro(e.grossCents)}</b>
              </dd>
              {e.prepaidCents !== 0n && (
                <>
                  <dt>Abschläge</dt>
                  <dd>− {euro(e.prepaidCents)}</dd>
                  <dt>Zahlbetrag</dt>
                  <dd>{euro(e.payableCents)}</dd>
                </>
              )}
              {e.skonto && (
                <>
                  <dt>Skonto</dt>
                  <dd>
                    {pct(e.skonto.percentBp)} bei Zahlung binnen {e.skonto.days} Tagen
                  </dd>
                </>
              )}
              {e.paymentTerms && (
                <>
                  <dt>Zahlungsbedingung</dt>
                  <dd class="small" style="white-space:pre-line">
                    {e.paymentTerms.replace(/#SKONTO#[^\n]*/g, '').trim()}
                  </dd>
                </>
              )}
            </dl>
          </div>
          <div class="card">
            <h3 style="margin-top:0">Rechnungssteller</h3>
            <p style="margin:0">
              <b>{s.name}</b>
              <br />
              {s.street}
              <br />
              {s.postalCode} {s.city}
              {s.country && s.country !== 'DE' ? ` (${s.country})` : ''}
            </p>
            <dl class="kv small">
              {s.vatId && (
                <>
                  <dt>USt-IdNr.</dt>
                  <dd>{s.vatId}</dd>
                </>
              )}
              {s.taxNumber && (
                <>
                  <dt>Steuernummer</dt>
                  <dd>{s.taxNumber}</dd>
                </>
              )}
              {e.iban && (
                <>
                  <dt>IBAN</dt>
                  <dd>{e.iban.replace(/(.{4})/g, '$1 ').trim()}</dd>
                </>
              )}
              {s.email && (
                <>
                  <dt>E-Mail</dt>
                  <dd>{s.email}</dd>
                </>
              )}
            </dl>
            {v.match ? (
              <p class="flash ok" style="margin-bottom:0">
                <span>
                  Erkannt über {v.match.by}:{' '}
                  <a href={`/lieferanten/${v.match.id}`}>
                    {v.match.supplier_no} · {v.match.name}
                  </a>
                </span>
              </p>
            ) : (
              <p class="flash warn" style="margin-bottom:0">
                <span>Lieferant nicht gefunden – unten wählen oder aus den Rechnungsdaten neu anlegen.</span>
              </p>
            )}
          </div>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Positionen</h3>
          <EInvoiceTable lines={e.lines} vat={e.vat} />
          {e.notes.length > 0 && (
            <p class="small mut" style="white-space:pre-line">
              {e.notes.join('\n')}
            </p>
          )}
        </div>
        {!own && (
          <form method="post" action={`/rechnungseingang/e-rechnung/${fileId}`} class="card">
            <h3 style="margin-top:0">Als Eingangsrechnung übernehmen</h3>
            <div class="grid">
              <div>
                <label for="supplier_id">Lieferant / Nachunternehmer</label>
                <select id="supplier_id" name="supplier_id" required>
                  <option value="neu" selected={!v.match}>
                    + neu anlegen: {s.name}
                  </option>
                  {suppliers.map((x) => (
                    <option value={x.id} selected={x.id === v.match?.id}>
                      {x.supplier_no} · {x.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="category">Kostenart</label>
                <select id="category" name="category" required>
                  {(Object.keys(COST_CATEGORY) as CostCategory[]).map((k) => (
                    <option value={k} selected={k === 'material'}>
                      {COST_CATEGORY[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="site_id">Objekt (Kostenstelle)</label>
                <select id="site_id" name="site_id">
                  <option value="">– keins / später aufteilen –</option>
                  <SiteOptions sites={sites} />
                </select>
              </div>
              <div>
                <label for="service_month">Leistungsmonat</label>
                <input
                  id="service_month"
                  type="month"
                  name="service_month"
                  value={(e.periodStart ?? e.deliveryDate ?? e.issueDate).slice(0, 7)}
                />
              </div>
              <div>
                <label for="note">Notiz</label>
                <input id="note" name="note" />
              </div>
            </div>
            <div class="actions form-foot">
              <button class="btn" disabled={!!v.duplicateId}>
                <Icon name="check" /> Übernehmen
              </button>
              <a class="btn sec" href={`/dateien/${fileId}`} target="_blank">
                Originaldatei
              </a>
              <span class="small mut">
                Danach wie gewohnt prüfen und „sachlich und rechnerisch richtig“ freigeben.
              </span>
            </div>
          </form>
        )}
      </>,
    );
  });

  app.post(`/rechnungseingang/e-rechnung/:file{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const cat = str(b, 'category') as CostCategory | null;
    if (!cat || !(cat in COST_CATEGORY)) throw new BusinessError('Bitte Kostenart wählen');
    const month = str(b, 'service_month');
    const id = await takeOverEInvoice(
      sql,
      cfg,
      c.req.param('file'),
      {
        supplierId: str(b, 'supplier_id') ?? '',
        category: cat,
        siteId: str(b, 'site_id'),
        serviceMonth: month && /^\d{4}-\d{2}$/.test(month) ? month : null,
        note: str(b, 'note'),
      },
      c.get('actor'),
    );
    return back(c, `/rechnungseingang/${id}`, { ok: 'E-Rechnung übernommen – bitte prüfen und freigeben.' });
  });
}
