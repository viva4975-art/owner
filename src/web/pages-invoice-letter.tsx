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
import { centsToInput, milliToInput } from './forms.js';
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
.lt-row{cursor:pointer}.lt-row:hover td{background:#fbf6f8}
.lt-add td{color:#7D1435;font-size:13px;border-bottom:0}
.lt-f{background:#fbf6f8;border:1px solid #e8d5dc;border-radius:6px;padding:10px;margin:6px 0}
.lt-f textarea,.lt-f input,.lt-f select{width:100%;margin:0}
.lt-fg{display:grid;gap:6px}
.lt-fl{display:grid;grid-template-columns:minmax(0,1fr) 90px 110px 120px;gap:6px;align-items:start}
@media(max-width:700px){.lt-fl{grid-template-columns:1fr 1fr}}
.lt-fb{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}
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
  workReports?: { id: string; number: string; status: string; cancelled: boolean; attached: boolean }[];
}> = ({ inv, doc, billing, portal, newId, preflight, attachments, uploadSlot, notice, workReports = [] }) => {
  const wrs = workReports.filter((w) => !w.cancelled);
  const wrSigned = wrs.some((w) => w.status === 'unterschrieben');
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
      <script dangerouslySetInnerHTML={{ __html: DIRECT_JS }} />
      {notice}
      <p class="small mut" style="margin:0 0 8px">
        Zum Ändern direkt auf Anschrift, Text, eine Position oder den Schlusstext klicken – wird sofort
        gespeichert.
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
                id="v-addr"
                data-open="f-addr"
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
              <Direct inv={inv} what="anschrift" id="f-addr" show="v-addr">
                <div class="lt-fg">
                  <input name="bill_name" value={b.name} placeholder="Name" required aria-label="Name" />
                  <input name="bill_name2" value={b.name2 ?? ''} placeholder="Zusatz" aria-label="Zusatz" />
                  <input
                    name="bill_contact"
                    value={b.contactName ?? ''}
                    placeholder="z. Hd. (Ansprechpartner)"
                    aria-label="Ansprechpartner"
                  />
                  <input
                    name="bill_street"
                    value={b.street}
                    placeholder="Straße"
                    required
                    aria-label="Straße"
                  />
                  <div style="display:flex;gap:6px">
                    <input
                      name="bill_postal_code"
                      value={b.postalCode}
                      placeholder="PLZ"
                      required
                      style="max-width:90px"
                      aria-label="PLZ"
                    />
                    <input name="bill_city" value={b.city} placeholder="Ort" required aria-label="Ort" />
                  </div>
                </div>
                {inv.bill_address && (
                  <button class="btn sec sm" name="reset" value="1" formnovalidate>
                    Anschrift wie Kunde
                  </button>
                )}
              </Direct>
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
                id="v-intro"
                data-open="f-intro"
                href={`/rechnungen/${inv.id}/bearbeiten#intro_text`}
                style="display:block;margin-top:8px;white-space:pre-line"
                title="Text ändern"
              >
                {intro}
              </a>
              <Direct inv={inv} what="einleitung" id="f-intro" show="v-intro">
                <textarea name="text" rows={4} data-grow aria-label="Einleitungstext">
                  {intro}
                </textarea>
              </Direct>
              <a
                class="lt-edit lt-edit-tbl"
                href={`/rechnungen/${inv.id}/bearbeiten#lines`}
                title="Alle Felder der Positionen (Leistungsart, Zeitraum …)"
              >
                ✎ alle Felder
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
                        <tr class="lt-row" id={`v-l${i}`} data-open={`f-l${i}`} title="Position ändern">
                          <td>{l.position}</td>
                          <td>
                            <span style="white-space:pre-line">{l.description}</span>
                            {det && <div class="lt-det">{det}</div>}
                          </td>
                          <td class="r">{milliToInput(l.quantity)}</td>
                          <td>{UNIT_LABELS[l.unitCode] ?? l.unitCode}</td>
                          <td class="r">{euro(l.unitPrice)}</td>
                          <td class="r">{euro(l.netAmount)}</td>
                        </tr>
                        <tr id={`f-l${i}`} class="lt-frow" hidden>
                          <td colspan={6}>
                            <LineForm inv={inv} index={i} line={l} show={`v-l${i}`} />
                          </td>
                        </tr>
                      </>
                    );
                  })}
                  <tr class="lt-row lt-add" id="v-new" data-open="f-new">
                    <td />
                    <td colspan={5}>+ Position hinzufügen</td>
                  </tr>
                  <tr id="f-new" class="lt-frow" hidden>
                    <td colspan={6}>
                      <LineForm inv={inv} index={null} line={null} show="v-new" />
                    </td>
                  </tr>
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
                id="v-closing"
                data-open="f-closing"
                href={`/rechnungen/${inv.id}/bearbeiten#closing_text`}
                style="display:block;white-space:pre-line;margin:8px 0"
                title="Schlusstext ändern"
              >
                {doc.closingText || <span class="faint small">+ Schlusstext hinzufügen</span>}
              </a>
              <Direct inv={inv} what="schluss" id="f-closing" show="v-closing">
                <textarea name="text" rows={3} data-grow aria-label="Schlusstext">
                  {doc.closingText ?? ''}
                </textarea>
              </Direct>
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
            {wrs.length === 0 && (
              <form
                method="post"
                action={`/rechnungen/${inv.id}/arbeitsschein`}
                onsubmit="return confirm('Arbeitsschein aus dieser Rechnung anlegen? Die Rechnung lässt sich dann erst ausstellen, wenn der Kunde den Arbeitsschein unterschrieben hat.')"
              >
                <button class="sec">Arbeitsschein erstellen</button>
              </form>
            )}
            <form
              method="post"
              action={`/rechnungen/${inv.id}/loeschen`}
              onsubmit="return confirm('Entwurf löschen? Vorgemerkte Leistungen werden wieder frei.')"
            >
              <button class="del">Löschen</button>
            </form>
          </div>
          {(inv.work_report_required || wrs.length > 0) && (
            <div class="card" style={inv.work_report_required && !wrSigned ? 'border-color:#e3a0a0' : ''}>
              <h3>Arbeitsschein</h3>
              {wrs.map((w) => (
                <div style="margin-bottom:4px">
                  <a href={`/arbeitsscheine/${w.id}`}>{w.number}</a>{' '}
                  <span class={`badge ${w.status === 'unterschrieben' ? 'ok' : 'warn'}`}>
                    {w.status === 'unterschrieben'
                      ? 'unterschrieben'
                      : w.status === 'entwurf'
                        ? 'noch nicht unterschrieben'
                        : 'ohne Unterschrift'}
                  </span>
                  {w.attached && <span class="small mut"> · hängt an</span>}
                </div>
              ))}
              {inv.work_report_required && !wrSigned && (
                <p class="small" style="margin:6px 0">
                  Ausstellen erst, wenn der Kunde den Arbeitsschein unterschrieben hat (am Handy/Tablet oder
                  in der App des Mitarbeiters). Das PDF hängt dann automatisch an der Rechnung.
                </p>
              )}
              {inv.work_report_required && wrs.length === 0 && (
                <form method="post" action={`/rechnungen/${inv.id}/arbeitsschein`}>
                  <button class="btn sm">Neuen Arbeitsschein anlegen</button>
                </form>
              )}
              {inv.work_report_required && !wrSigned && (
                <details style="margin-top:6px">
                  <summary class="small">Ohne unterschriebenen Arbeitsschein ausstellen …</summary>
                  <form method="post" action={`/rechnungen/${inv.id}/arbeitsschein-pflicht`} class="actions">
                    <input
                      name="grund"
                      required
                      placeholder="Grund (z. B. Kunde unterschreibt nicht digital)"
                    />
                    <button class="btn sm sec">Pflicht aufheben</button>
                  </form>
                </details>
              )}
            </div>
          )}
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

/* Direkt im Brief ändern: Klick blendet das kleine Formular an Ort und Stelle ein (ohne JavaScript: Link zum Editor). */
export const DIRECT_JS = `document.addEventListener('DOMContentLoaded',function(){
document.querySelectorAll('[data-open]').forEach(function(el){el.addEventListener('click',function(e){
var f=document.getElementById(el.getAttribute('data-open'));if(!f)return;e.preventDefault();
document.querySelectorAll('.lt-f-open').forEach(function(o){o.hidden=true;o.classList.remove('lt-f-open');var v=document.getElementById(o.getAttribute('data-show'));if(v)v.hidden=false;});
f.hidden=false;f.classList.add('lt-f-open');el.hidden=true;var i=f.querySelector('textarea,input:not([type=hidden]),select');if(i){i.focus();if(i.select&&i.tagName!=='SELECT')i.select();}});});
document.querySelectorAll('[data-cancel]').forEach(function(b){b.addEventListener('click',function(){
var f=document.getElementById(b.getAttribute('data-cancel'));if(!f)return;f.hidden=true;f.classList.remove('lt-f-open');var v=document.getElementById(f.getAttribute('data-show'));if(v)v.hidden=false;});});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){var o=document.querySelector('.lt-f-open [data-cancel]');if(o)o.click();}});
});`;

const Direct: FC<{ inv: InvoiceRow; what: string; id: string; show: string; children?: Child }> = ({
  inv,
  what,
  id,
  show,
  children,
}) => (
  <form method="post" action={`/rechnungen/${inv.id}/direkt`} class="lt-f" id={id} data-show={show} hidden>
    <input type="hidden" name="what" value={what} />
    <input type="hidden" name="version" value={String(inv.version)} />
    {children}
    <div class="lt-fb">
      <button class="btn sm">Speichern</button>
      <button type="button" class="btn sec sm" data-cancel={id}>
        Abbrechen
      </button>
    </div>
  </form>
);

const LineForm: FC<{
  inv: InvoiceRow;
  index: number | null;
  line: InvoiceDocument['lines'][number] | null;
  show: string;
}> = ({ inv, index, line, show }) => (
  <div class="lt-f" style="margin:0;border:0;padding:0;background:none">
    <form method="post" action={`/rechnungen/${inv.id}/direkt`}>
      <input type="hidden" name="what" value="position" />
      <input type="hidden" name="index" value={index == null ? '' : String(index)} />
      <input type="hidden" name="version" value={String(inv.version)} />
      <div class="lt-fl">
        <textarea
          name="desc"
          rows={2}
          data-grow
          required
          aria-label="Leistungsbeschreibung"
          placeholder="Leistung"
        >
          {line?.description ?? ''}
        </textarea>
        <input
          name="qty"
          inputmode="decimal"
          value={line ? milliToInput(line.quantity) : '1'}
          aria-label="Menge"
          title="Menge (Stunden, Stück …)"
        />
        <select name="unit" aria-label="Einheit">
          {Object.entries(UNIT_LABELS).map(([k, v]) => (
            <option value={k} selected={(line?.unitCode ?? 'C62') === k}>
              {v || k}
            </option>
          ))}
        </select>
        <input
          name="price"
          inputmode="decimal"
          value={line ? centsToInput(line.unitPrice) : ''}
          placeholder="Einzelpreis"
          required
          aria-label="Einzelpreis €"
        />
      </div>
      <div class="lt-fb">
        <button class="btn sm">Speichern</button>
        <button
          type="button"
          class="btn sec sm"
          onclick={`var f=document.getElementById('f-${index == null ? 'new' : `l${index}`}');f.hidden=true;document.getElementById('${show}').hidden=false`}
        >
          Abbrechen
        </button>
        {index != null && (
          <button
            class="btn sec sm"
            style="margin-left:auto;color:var(--err)"
            name="loeschen"
            value="1"
            formnovalidate
            onclick="return confirm('Position löschen?')"
          >
            Position löschen
          </button>
        )}
      </div>
    </form>
  </div>
);
