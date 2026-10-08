import type { Child, FC } from 'hono/jsx';
import { formatDateDe } from '../domain/invoice/calc.js';
import { type InvoiceDocument, KIND_TITLES, UNIT_LABELS } from '../domain/invoice/types.js';
import {
  REVERSE_CHARGE_NOTE,
  isReverseCharge,
  paymentTermsHuman,
  percentToXml,
} from '../einvoice/mapping.js';
import {
  INVOICE_CLOSING_NOPAY,
  INVOICE_CLOSING_PAY,
  INVOICE_INTRO_DEFAULT,
  splitLineDetail,
} from '../pdf/render.js';
import type { EffectiveBilling } from '../services/masterdata.js';
import type { InvoiceRow } from '../services/invoices.js';
import type { PreflightResult } from '../services/workflow.js';
import { milliToInput } from './forms.js';
import { euro } from './layout.js';

/*
 * Rechnungsentwurf als Briefansicht wie Fortytools (Ahmed 08.10.): links das Blatt so, wie es gedruckt wird
 * (Anschrift, grauer Balken, Leistungsort, Anrede, Positionen je Objekt, Summen, Zahlungsbedingung), rechts die
 * Aktionen untereinander, Anhänge und Versand. Daten = dieselbe Vorschau wie das PDF (loadDraftPreview).
 */

const FORMAT: Record<string, string> = { pdf: 'PDF', zugferd: 'ZUGFeRD', xrechnung: 'XRechnung + PDF' };

export const LETTER_CSS = `
.lt-grid{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:18px;align-items:start}
@media(max-width:1000px){.lt-grid{grid-template-columns:minmax(0,1fr)}}
.lt-paper{background:#fff;border:1px solid #e3e3e6;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.05);padding:34px 0 26px;font-size:14px;color:#222}
.lt-pad{padding:0 30px}
.lt-sender{font-size:11px;color:#555;border-bottom:1px solid #444;display:inline-block;padding-bottom:1px;margin-bottom:6px}
.lt-addr{line-height:1.45;min-height:84px;max-width:320px}
.lt-band{background:#f2f2f2;margin:26px 0 0;padding:16px 30px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.lt-band h2{margin:0;font-size:30px;font-weight:600;letter-spacing:-.01em}
.lt-band h2 small{font-size:20px;color:#999;font-weight:400}
.lt-info{margin-left:auto;display:grid;grid-template-columns:auto auto;gap:2px 22px;font-size:13.5px}
.lt-facts{display:flex;flex-wrap:wrap;gap:6px 26px;padding:12px 30px;border-bottom:1px solid #eee;font-size:13px}
.lt-facts div span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#888}
.lt-body{padding:18px 30px 0}
.lt-tbl{width:100%;border-collapse:collapse;margin:18px 0 6px}
.lt-tbl th{background:#f2f2f2;font-weight:600;text-align:left;padding:9px 10px;font-size:13.5px}
.lt-tbl th:first-child{border-radius:8px 0 0 8px}.lt-tbl th:last-child{border-radius:0 8px 8px 0}
.lt-tbl td{padding:10px 10px;border-bottom:1px solid #e6e6e6;vertical-align:top}
.lt-tbl .r{text-align:right;white-space:nowrap}
.lt-tbl .lt-grp td{border-bottom:0;padding:14px 10px 2px;font-weight:600}
.lt-tbl .lt-grp span{font-weight:400;color:#777}
.lt-det{color:#999;font-size:13px;white-space:pre-line}
.lt-sub td{border-bottom:0;padding-top:4px;color:#777;font-size:12.5px}
.lt-sums{margin-left:auto;width:max-content;min-width:300px}
.lt-sums div{display:flex;justify-content:space-between;gap:30px;padding:6px 10px}
.lt-sums .tot b{background:#fff3b0;padding:3px 8px;border-radius:4px}
.lt-side .btns{display:flex;flex-direction:column;border-radius:6px;overflow:hidden;margin-bottom:14px}
.lt-side .btns > *{display:block;width:100%;margin:0}
.lt-side .btns a,.lt-side .btns button{display:block;width:100%;text-align:center;background:#7D1435;color:#fff;border:0;border-bottom:1px solid rgba(255,255,255,.18);padding:10px 12px;font-weight:600;font-size:14px;text-decoration:none;cursor:pointer;border-radius:0}
.lt-side .btns a:hover,.lt-side .btns button:hover{background:#651029}
.lt-side .btns .sec{background:#fff;color:#7D1435;border-bottom:1px solid #eee}
.lt-side .btns .sec:hover{background:#faf3f5}
.lt-side .btns .del{background:#fff;color:#b42318}
.lt-side .card h3{margin:0 0 8px;font-size:15px}
.lt-edit{color:inherit;text-decoration:none;border-radius:4px;outline:1px dashed transparent;outline-offset:3px;cursor:text}
.lt-edit:hover{outline-color:#c9a3b0;background:#fbf6f8}
.lt-edit-tbl{float:right;font-size:12px;color:#7D1435;margin-top:-2px}
a.lt-addr{display:block}
.lt-foot{color:#999;font-size:12px;text-align:center;margin-top:10px}
`;

export const DraftLetter: FC<{
  inv: InvoiceRow;
  doc: InvoiceDocument;
  billing: EffectiveBilling;
  portal: string | null;
  newId: string;
  preflight: PreflightResult | null;
  attachments: { id: string; filename: string }[];
  uploadSlot?: Child;
  notice?: Child;
}> = ({ inv, doc, billing, portal, newId, preflight, attachments, uploadSlot, notice }) => {
  const s = doc.seller;
  const b = doc.buyer;
  const parsed = doc.lines.map((l) => splitLineDetail(l.detail));
  const keys = [...new Set(parsed.map((p) => p.place?.key ?? ''))];
  const grouped = keys.length > 1;
  const one = !grouped ? parsed.find((p) => p.place)?.place : null;
  const period = doc.periodStart
    ? `${formatDateDe(doc.periodStart)}${doc.periodEnd && doc.periodEnd !== doc.periodStart ? ` bis ${formatDateDe(doc.periodEnd)}` : ''}`
    : null;
  const facts: [string, Child][] = [];
  if (one)
    facts.push(['Leistungsort / Objekt', <b>{`${one.title}${one.address ? ` · ${one.address}` : ''}`}</b>]);
  else if (b.site)
    facts.push([
      'Leistungsort / Objekt',
      <b>{`${b.site.name} (${b.site.siteNo})${b.site.street ? ` · ${b.site.street}, ${b.site.postalCode ?? ''} ${b.site.city ?? ''}` : ''}`}</b>,
    ]);
  else if (grouped) facts.push(['Leistungsort', `${keys.length} Objekte (siehe Positionen)`]);
  if (period) facts.push(['Leistungszeitraum', period]);
  else facts.push(['Leistungszeitraum', <span class="tag err">fehlt – bitte eintragen</span>]);
  if (b.leitwegId) facts.push(['Leitweg-ID', b.leitwegId]);
  if (b.supplierNo) facts.push(['Unsere Lieferantennr.', b.supplierNo]);
  if (doc.orderReference) facts.push(['Bestellnummer', doc.orderReference]);
  if (doc.customerReference) facts.push(['Ihre Referenz', doc.customerReference]);
  const rc = isReverseCharge(doc);
  const intro =
    doc.introText?.replace(/^\s*Sehr geehrte Damen und Herren,?\s*/i, '').trim() || INVOICE_INTRO_DEFAULT;
  // Zwischensummen je Objekt (wie im PDF)
  const groupSum = (i: number) => {
    let j = i;
    let sum = 0n;
    while (j < doc.lines.length && parsed[j]!.place?.key === parsed[i]!.place?.key)
      sum += doc.lines[j++]!.netAmount;
    return { sum, count: j - i };
  };
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LETTER_CSS }} />
      {notice}
      <p class="small mut" style="margin:0 0 8px">
        Zum Ändern einfach auf Anschrift, Text, Positionen oder Schlusstext klicken.
      </p>
      <div class="lt-grid">
        <div>
          <div class="lt-paper">
            <div class="lt-pad">
              <div class="lt-sender">
                {s.legalName} | {s.street} | {s.postalCode} {s.city}
              </div>
              <a
                class="lt-addr lt-edit"
                href={`/rechnungen/${inv.id}/bearbeiten#anschrift`}
                title="Anschrift ändern"
              >
                {[
                  b.name,
                  b.name2,
                  b.contactName ? `z. Hd. ${b.contactName}` : null,
                  b.street,
                  `${b.postalCode} ${b.city}`,
                ]
                  .filter(Boolean)
                  .map((x) => (
                    <div>{x}</div>
                  ))}
              </a>
            </div>
            <div class="lt-band">
              <h2>
                {KIND_TITLES[inv.kind]} <small>( Entwurf )</small>
              </h2>
              <div class="lt-info">
                <span>Rechnungsdatum</span>
                <span>
                  {formatDateDe(doc.issueDate)}
                  {!inv.planned_issue_date && <span class="small faint"> (beim Ausstellen)</span>}
                </span>
                <span>Kundennummer</span>
                <a href={`/kunden/${inv.customer_id}`}>{b.customerNo}</a>
              </div>
            </div>
            <div class="lt-facts">
              {facts.map(([k, v]) => (
                <div>
                  <span>{k}</span>
                  {v}
                </div>
              ))}
            </div>
            <div class="lt-body">
              <div>Sehr geehrte Damen und Herren,</div>
              <a
                class="lt-edit"
                href={`/rechnungen/${inv.id}/bearbeiten#intro_text`}
                style="display:block;margin-top:8px;white-space:pre-line"
                title="Text ändern"
              >
                {intro}
              </a>
              <a
                class="lt-edit lt-edit-tbl"
                href={`/rechnungen/${inv.id}/bearbeiten#lines`}
                title="Positionen ändern"
              >
                ✎ Positionen ändern
              </a>
              <table class="lt-tbl">
                <thead>
                  <tr>
                    <th style="width:44px">Pos</th>
                    <th>Text</th>
                    <th class="r">Menge</th>
                    <th>Einheit</th>
                    <th class="r">Einzelpreis</th>
                    <th class="r">Gesamtpreis</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lines.map((l, i) => {
                    const p = parsed[i]!;
                    const head = grouped && (i === 0 || p.place?.key !== parsed[i - 1]!.place?.key);
                    const g = head ? groupSum(i) : null;
                    const lp =
                      p.period ??
                      (l.periodStart
                        ? `${formatDateDe(l.periodStart)}${l.periodEnd && l.periodEnd !== l.periodStart ? ` bis ${formatDateDe(l.periodEnd)}` : ''}`
                        : null);
                    const det = [p.rest, lp && lp !== period ? `Leistungszeitraum: ${lp}` : null]
                      .filter(Boolean)
                      .join('\n');
                    return (
                      <>
                        {head && (
                          <tr class="lt-grp">
                            <td />
                            <td colspan={4}>
                              {p.place?.title ?? 'Ohne Objektbezug'}
                              {p.place?.address && <span> · {p.place.address}</span>}
                            </td>
                            <td class="r">{g && g.count > 1 ? <span>{euro(g.sum)}</span> : null}</td>
                          </tr>
                        )}
                        <tr>
                          <td>{l.position}</td>
                          <td>
                            {l.description}
                            {det && <div class="lt-det">{det}</div>}
                          </td>
                          <td class="r">{milliToInput(l.quantity)}</td>
                          <td>{UNIT_LABELS[l.unitCode] ?? l.unitCode}</td>
                          <td class="r">{euro(l.unitPrice)}</td>
                          <td class="r">{euro(l.netAmount)}</td>
                        </tr>
                      </>
                    );
                  })}
                </tbody>
              </table>
              <div class="lt-sums">
                <div>
                  <span>Gesamt netto</span>
                  <span>{euro(doc.netTotal)}</span>
                </div>
                {doc.vatBreakdown.map((v) => (
                  <div>
                    <span>
                      {rc
                        ? 'Umsatzsteuer (§ 13b UStG)'
                        : `zzgl. MwSt (${percentToXml(v.vatRate).replace('.', ',')}%)`}
                    </span>
                    <span>{euro(v.taxAmount)}</span>
                  </div>
                ))}
                <div class="tot">
                  <span>Gesamtbetrag</span>
                  <b>{euro(doc.grossTotal)}</b>
                </div>
                {doc.prepayments.map((p) => (
                  <div class="small">
                    <span>abzgl. Abschlag {p.number}</span>
                    <span>-{euro(p.grossAmount)}</span>
                  </div>
                ))}
                {doc.prepayments.length > 0 && (
                  <div class="tot">
                    <span>Zahlbetrag</span>
                    <b>{euro(doc.payableTotal)}</b>
                  </div>
                )}
              </div>
              {rc && (
                <p>
                  <b>{REVERSE_CHARGE_NOTE}</b>
                  {b.vatId && <div>USt-IdNr. des Leistungsempfängers: {b.vatId}</div>}
                </p>
              )}
              <p style="margin-top:18px">{paymentTermsHuman(doc)}</p>
              <a
                class="lt-edit"
                href={`/rechnungen/${inv.id}/bearbeiten#closing_text`}
                style="display:block;white-space:pre-line;margin:8px 0"
                title="Schlusstext ändern"
              >
                {doc.closingText || <span class="faint small">+ Schlusstext hinzufügen</span>}
              </a>
              <p>{doc.payableTotal > 0n ? INVOICE_CLOSING_PAY : INVOICE_CLOSING_NOPAY}</p>
            </div>
          </div>
          <div class="lt-foot">
            Angelegt{' '}
            {inv.created_at.toLocaleString('de-DE', {
              timeZone: 'Europe/Berlin',
              dateStyle: 'short',
              timeStyle: 'short',
            })}{' '}
            · Format {FORMAT[inv.invoice_format] ?? inv.invoice_format}
          </div>
          {preflight && (
            <div class={`flash ${preflight.valid ? 'ok' : 'err'}`} style="margin-top:12px">
              {preflight.valid
                ? 'KoSIT-Prüfung bestanden: XRechnung (UBL) und ZUGFeRD-XML (CII) sind gültig.'
                : 'KoSIT-Prüfung NICHT bestanden – Ausstellen ist gesperrt.'}
              {[...preflight.ubl.messages, ...preflight.cii.messages]
                .filter((m) => m.level !== 'information')
                .slice(0, 12)
                .map((m) => (
                  <div class="small">
                    [{m.level}] {m.code}: {m.text}
                  </div>
                ))}
            </div>
          )}
        </div>
        <aside class="lt-side">
          <div class="btns">
            <a href={`/rechnungen/${inv.id}/bearbeiten`}>✎ Bearbeiten</a>
            <form
              method="post"
              action={`/rechnungen/${inv.id}/ausstellen`}
              onsubmit="return confirm('Rechnung jetzt verbindlich ausstellen? Danach ist sie unveränderbar und erhält eine fortlaufende Nummer.')"
            >
              <button>Fertigstellen (ausstellen)</button>
            </form>
            <a href={`/rechnungen/${inv.id}/vorschau.pdf`} target="_blank">
              PDF-Vorschau
            </a>
            <a class="sec" href={`/rechnungen/${inv.id}?pruefen=1`}>
              E-Rechnung prüfen (KoSIT)
            </a>
            {['invoice', 'partial'].includes(inv.kind) && (
              <form method="post" action={`/rechnungen/${inv.id}/kopieren`}>
                <input type="hidden" name="new_id" value={newId} />
                <button class="sec">Kopieren</button>
              </form>
            )}
            <a class="sec" href={`/rechnungen/${inv.id}/lieferschein.pdf`} target="_blank">
              Lieferschein erstellen
            </a>
            <form
              method="post"
              action={`/rechnungen/${inv.id}/loeschen`}
              onsubmit="return confirm('Entwurf löschen? Vorgemerkte Leistungen werden wieder frei.')"
            >
              <button class="del">Löschen</button>
            </form>
          </div>
          {inv.review_required && (
            <div class="card" style="border-color:#e3a0a0">
              <h3>Unfertig</h3>
              <p class="small" style="margin-top:0">
                Enthält eine Leistung mit „immer unfertig“. Positionen prüfen, dann freigeben.
              </p>
              <form method="post" action={`/rechnungen/${inv.id}/geprueft`}>
                <button class="btn sm">Geprüft</button>
              </form>
            </div>
          )}
          <form method="post" action={`/rechnungen/${inv.id}/rechnungsdatum`} class="card">
            <h3>Rechnungsdatum</h3>
            <input type="date" name="date" value={inv.planned_issue_date ?? ''} aria-label="Rechnungsdatum" />
            <div class="actions" style="margin:6px 0 0">
              <button class="btn sm sec">Übernehmen</button>
              <span class="small faint">leer = Tag des Ausstellens</span>
            </div>
          </form>
          <div class="card">
            <h3>Anhänge</h3>
            {attachments.length === 0 ? (
              <p class="small mut" style="margin:0 0 6px">
                Keine
              </p>
            ) : (
              attachments.map((a) => (
                <div class="small">
                  <a href={`/dokumente/${a.id}`}>{a.filename}</a>
                </div>
              ))
            )}
            {uploadSlot}
          </div>
          <div class="card">
            <h3>Versand</h3>
            <div class="small">
              {portal != null ? (
                <>Über das Portal des Kunden{portal ? ` (${portal})` : ''}</>
              ) : billing.emails.length ? (
                <>Per E-Mail an {billing.emails.join(', ')}</>
              ) : (
                <span class="tag warn">keine Rechnungs-E-Mail – Versand per Post</span>
              )}
            </div>
            <div class="small faint" style="margin-top:4px">
              Format: {FORMAT[inv.invoice_format] ?? inv.invoice_format}
              {billing.source === 'objekt' ? ' · Angaben vom Objekt' : ''}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
};
