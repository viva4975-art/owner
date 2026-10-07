import type { Child, FC } from 'hono/jsx';
import { SiteOptions } from './site-options.js';
import { KIND_TITLES, UNIT_LABELS } from '../domain/invoice/types.js';
import type { InvoiceRow, LineRow } from '../services/invoices.js';
import type { Customer, EffectiveBilling, Site, SiteService } from '../services/masterdata.js';
import type { DeliveryRow, PreflightResult } from '../services/workflow.js';
import { centsToInput, milliToInput } from './forms.js';
import { FORMAT_LABEL, STATUS_LABEL, dateDe, euro } from './layout.js';

type ListRow = InvoiceRow & {
  customer_name: string;
  site_name: string | null;
  original_number: string | null;
  delivery_status: string | null;
};

export const StatusBadge: FC<{ inv: { status: string; delivery_status?: string | null } }> = ({ inv }) => {
  const s = inv.status === 'issued' && inv.delivery_status ? inv.delivery_status : inv.status;
  return <span class={`badge ${s}`}>{STATUS_LABEL[s] ?? s}</span>;
};

export const InvoiceTable: FC<{ rows: ListRow[] }> = ({ rows }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Nummer</th>
          <th>Art</th>
          <th>Kunde / Objekt</th>
          <th>Datum</th>
          <th>Zeitraum</th>
          <th class="r">Brutto</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={7} class="mut">
              Keine Rechnungen.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr>
            <td>
              <a href={`/rechnungen/${r.id}`}>{r.number ?? 'Entwurf'}</a>
            </td>
            <td>
              {KIND_TITLES[r.kind]}
              {r.original_number && <div class="small mut">zu {r.original_number}</div>}
            </td>
            <td>
              {r.customer_name}
              {r.site_name && <div class="small mut">{r.site_name}</div>}
            </td>
            <td>{dateDe(r.issue_date)}</td>
            <td class="small">
              {r.period_start ? `${dateDe(r.period_start)} – ${dateDe(r.period_end)}` : '–'}
            </td>
            <td class="r">{euro(r.gross_cents)}</td>
            <td>
              <StatusBadge inv={r} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const lineEditorScript = `
(function(){
  var tbody=document.querySelector('#lines tbody');
  var tpl=document.querySelector('#line-tpl');
  function toCents(v){v=(v||'').trim();if(!v)return null;if(v.indexOf(',')>=0)v=v.replace(/\\./g,'').replace(',','.');var m=/^(-)?(\\d+)(?:\\.(\\d{1,2}))?$/.exec(v);if(!m)return null;var c=BigInt(m[2]+(m[3]||'').padEnd(2,'0'));return m[1]?-c:c}
  function toMilli(v){v=(v||'').trim().replace(',','.');var m=/^(-)?(\\d+)(?:\\.(\\d{1,3}))?$/.exec(v);if(!m)return null;var q=BigInt(m[2]+(m[3]||'').padEnd(3,'0'));return m[1]?-q:q}
  function round(n,d){var neg=n<0n;if(neg)n=-n;var q=(n*2n+d)/(d*2n);return neg?-q:q}
  function fmt(c){var neg=c<0n;if(neg)c=-c;var e=(c/100n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.');return (neg?'-':'')+e+','+(c%100n).toString().padStart(2,'0')+' €'}
  function recalc(){var net=0n,vat={};tbody.querySelectorAll('tr').forEach(function(tr){var q=toMilli(tr.querySelector('[name=qty]').value||'1'),p=toCents(tr.querySelector('[name=price]').value),r=BigInt(tr.querySelector('[name=vat]').value);var out=tr.querySelector('.ln');if(q===null||p===null){out.textContent='';return}var l=round(q*p,1000n);var rc=tr.querySelector('[name=rec]');if(rc&&(rc.value==='2'||rc.value==='3')){out.textContent='('+fmt(l)+')';return}out.textContent=fmt(l);net+=l;vat[r]=(vat[r]||0n)+l});var v=0n;Object.keys(vat).forEach(function(r){v+=round(vat[r]*BigInt(r),10000n)});document.getElementById('t-net').textContent=fmt(net);document.getElementById('t-vat').textContent=fmt(v);document.getElementById('t-gross').textContent=fmt(net+v)}
  function add(data){var row=tpl.content.firstElementChild.cloneNode(true);if(data){Object.keys(data).forEach(function(k){var el=row.querySelector('[name='+k+']');if(el)el.value=data[k]})}tbody.appendChild(row);recalc();return row}
  document.getElementById('add-line').addEventListener('click',function(){add().querySelector('[name=desc]').focus()});
  var sel=document.getElementById('from-service');
  if(sel)sel.addEventListener('change',function(){if(!sel.value)return;add(JSON.parse(sel.value));sel.value=''});
  tbody.addEventListener('click',function(e){if(e.target.classList.contains('del')){e.target.closest('tr').remove();recalc()}});
  function grow(t){t.style.height='auto';t.style.height=(t.scrollHeight+2)+'px'}
  tbody.querySelectorAll('textarea').forEach(grow);
  tbody.addEventListener('input',function(e){if(e.target.tagName==='TEXTAREA')grow(e.target);recalc()});
  tbody.addEventListener('change',function(e){var t=e.target;if(t.name!=='stype'||!t.value)return;var d=t.closest('tr').querySelector('[name=desc]');if(d&&!d.value.trim())d.value=t.options[t.selectedIndex].text});
  tbody.addEventListener('change',recalc);
  window.vdLines={set:function(rows){tbody.innerHTML='';rows.forEach(function(r){add(r)});if(!tbody.children.length)add();recalc()}};
  if(!tbody.children.length)add();
  recalc();
})();`;

export interface EditorLine {
  desc: string;
  detail: string;
  qty: string;
  unit: string;
  price: string;
  vat: string;
  src: string;
  /** nur Angebote: '1' = monatlich wiederkehrend */
  rec?: string;
  /** Leistungsart (nur Rechnungen) */
  stype?: string;
}

export interface ServiceTypeOption {
  id: string;
  name: string;
}

export const toEditorLine = (l: LineRow): EditorLine => ({
  desc: l.description,
  detail: l.detail ?? '',
  qty: milliToInput(l.quantity_milli),
  unit: l.unit_code,
  price: centsToInput(l.unit_price_cents),
  vat: String(l.vat_rate_bp),
  src: l.source_service_id ?? '',
  stype: l.service_type_id ?? '',
});

const LineRowInputs: FC<{
  l?: EditorLine;
  recurring?: boolean | undefined;
  types?: ServiceTypeOption[] | undefined;
}> = ({ l, recurring, types }) => (
  <tr>
    <td style="min-width:260px">
      {types && (
        <select name="stype" class="ln-type" aria-label="Leistungsart" data-nosearch>
          <option value="">– Leistungsart –</option>
          {types.map((t) => (
            <option value={t.id} selected={t.id === l?.stype}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <input name="desc" value={l?.desc ?? ''} placeholder="Leistung" />
      <textarea
        name="detail"
        rows={2}
        placeholder="Beschreibung (optional, Zeilenumbruch mit Enter)"
        class="ln-detail"
      >
        {l?.detail ?? ''}
      </textarea>
      <input type="hidden" name="src" value={l?.src ?? ''} />
    </td>
    <td style="width:90px">
      <input name="qty" value={l?.qty ?? '1'} class="right" />
    </td>
    <td style="width:110px">
      <select name="unit">
        {Object.entries(UNIT_LABELS).map(([k, v]) => (
          <option value={k} selected={(l?.unit ?? 'LS') === k}>
            {v}
          </option>
        ))}
      </select>
    </td>
    <td style="width:130px">
      <input name="price" value={l?.price ?? ''} placeholder="0,00" class="right" />
      {/* Steuersatz immer 19 %; § 13b (0 %) wird für den ganzen Beleg per Häkchen gesetzt */}
      <input type="hidden" name="vat" value="1900" />
    </td>
    {recurring && (
      <td style="width:170px">
        <select name="rec" aria-label="Abrechnung">
          <option value="0" selected={!l?.rec || l.rec === '0'}>
            einmalig
          </option>
          <option value="1" selected={l?.rec === '1'}>
            monatlich
          </option>
          <option value="2" selected={l?.rec === '2'}>
            Alternative einmalig
          </option>
          <option value="3" selected={l?.rec === '3'}>
            Alternative monatlich
          </option>
        </select>
      </td>
    )}
    <td class="r ln" style="width:120px;padding-top:12px"></td>
    <td style="width:40px">
      <button type="button" class="btn sm sec del" title="Position entfernen">
        ×
      </button>
    </td>
  </tr>
);

export const LineEditor: FC<{
  lines: EditorLine[];
  services?: SiteService[];
  recurring?: boolean | undefined;
  /** Leistungsarten zur Auswahl je Position (Rechnungen) */
  types?: ServiceTypeOption[] | undefined;
}> = ({ lines, services, recurring, types }) => (
  <>
    <div class="tbl">
      <table id="lines" class="lines" data-lines>
        <thead>
          <tr>
            <th>Leistung</th>
            <th class="r">Menge</th>
            <th>Einheit</th>
            <th class="r">Einzelpreis €</th>
            {recurring && <th>Abrechnung</th>}
            <th class="r">Gesamt</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <LineRowInputs l={l} recurring={recurring} types={types} />
          ))}
        </tbody>
      </table>
    </div>
    <template id="line-tpl">
      <LineRowInputs recurring={recurring} types={types} />
    </template>
    <div class="actions">
      <button type="button" class="btn sm sec" id="add-line">
        + Position
      </button>
      {services && services.length > 0 && (
        <select id="from-service" style="max-width:360px">
          <option value="">Aus Leistungskatalog des Objekts …</option>
          {services
            .filter((s) => s.active)
            .map((s) => (
              <option
                value={JSON.stringify({
                  desc: s.description,
                  qty: milliToInput(s.quantity_milli),
                  unit: s.unit_code,
                  price: centsToInput(s.unit_price_cents),
                  vat: String(s.vat_rate_bp),
                  src: s.id,
                  stype: s.service_type_id ?? '',
                })}
              >
                {s.description} – {euro(s.unit_price_cents)}
              </option>
            ))}
        </select>
      )}
    </div>
    <table class="totals">
      <tbody>
        <tr>
          <td>Summe netto</td>
          <td class="r" id="t-net"></td>
        </tr>
        <tr>
          <td>Umsatzsteuer</td>
          <td class="r" id="t-vat"></td>
        </tr>
        <tr class="sum">
          <td>Gesamt brutto</td>
          <td class="r" id="t-gross"></td>
        </tr>
      </tbody>
    </table>
    <p class="small mut">
      Vorschau im Browser – maßgeblich ist die Berechnung auf dem Server beim Speichern.
    </p>
    <script dangerouslySetInnerHTML={{ __html: lineEditorScript }} />
  </>
);

/** Warnhinweis und Hinweise zur Rechnungsstellung des Kunden (beim Erstellen/Prüfen von Rechnungen). */
export const CustomerNotice: FC<{
  c: Pick<Customer, 'warning' | 'billing_hint'> | null | undefined;
}> = ({ c }) =>
  c && (c.warning || c.billing_hint) ? (
    <>
      {c.warning && (
        <div class="flash err" style="white-space:pre-line">
          <b>Warnhinweis:</b> {c.warning}
        </div>
      )}
      {c.billing_hint && (
        <div class="flash warn" style="white-space:pre-line">
          <b>Hinweis zur Rechnungsstellung:</b> {c.billing_hint}
        </div>
      )}
    </>
  ) : null;

export const InvoiceEditor: FC<{
  id: string;
  inv: Partial<InvoiceRow>;
  lines: EditorLine[];
  customers: Customer[];
  sites: Site[];
  services: SiteService[];
  partials: (InvoiceRow & { customer_name: string })[];
  selectedPartials: string[];
  types: ServiceTypeOption[];
}> = ({ id, inv, lines, customers, sites, services, partials, selectedPartials, types }) => (
  <>
    <h1>{inv.status ? 'Entwurf bearbeiten' : 'Neue Rechnung'}</h1>
    <CustomerNotice c={customers.find((c) => c.id === inv.customer_id)} />
    <form method="get" action={`/rechnungen/${id}/bearbeiten`} class="card">
      <div class="grid">
        <div>
          <label for="kunde">Kunde</label>
          <select id="kunde" name="kunde" onchange="this.form.submit()">
            <option value="">– bitte wählen –</option>
            {customers.map((c) => (
              <option value={c.id} selected={c.id === inv.customer_id}>
                {c.customer_no} · {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="objekt">Objekt</label>
          <select id="objekt" name="objekt" onchange="this.form.submit()">
            <option value="">– ohne Objekt –</option>
            <SiteOptions sites={sites} selected={inv.site_id} />
          </select>
        </div>
        <div>
          <label for="art">Art</label>
          <select id="art" name="art" onchange="this.form.submit()">
            {(['invoice', 'partial', 'final'] as const).map((k) => (
              <option value={k} selected={inv.kind === k}>
                {KIND_TITLES[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </form>
    {inv.customer_id && (
      <form
        method="post"
        action={`/rechnungen/${id}`}
        class="card"
        data-autosave={`/rechnungen/${id}`}
        data-version={String(inv.version ?? '')}
      >
        <input type="hidden" name="version" value={String(inv.version ?? '')} />
        <input type="hidden" name="customer_id" value={inv.customer_id} />
        <input type="hidden" name="site_id" value={inv.site_id ?? ''} />
        <input type="hidden" name="kind" value={inv.kind ?? 'invoice'} />
        <div class="grid">
          <div>
            <label for="period_start">Leistungszeitraum von *</label>
            <input
              id="period_start"
              type="date"
              name="period_start"
              value={inv.period_start ?? ''}
              required
            />
          </div>
          <div>
            <label for="period_end">bis (leer = ein Tag)</label>
            <input id="period_end" type="date" name="period_end" value={inv.period_end ?? ''} />
          </div>
          <div>
            <label for="order_reference">Bestellnummer des Kunden</label>
            <input id="order_reference" name="order_reference" value={inv.order_reference ?? ''} />
          </div>
        </div>
        <div style="margin:12px 0">
          <label for="intro_text">Einleitungstext</label>
          <textarea id="intro_text" name="intro_text">
            {inv.intro_text ?? ''}
          </textarea>
        </div>
        {inv.kind === 'final' && (
          <div class="card" style="background:#fcfafa">
            <b>Zu verrechnende Abschlagsrechnungen</b>
            {partials.length === 0 && <p class="mut">Keine offenen Abschlagsrechnungen für diesen Kunden.</p>}
            {partials.map((p) => (
              <div class="chk" style="margin-top:6px">
                <input
                  type="checkbox"
                  name="prepayments"
                  value={p.id}
                  id={`p-${p.id}`}
                  checked={selectedPartials.includes(p.id)}
                />
                <label for={`p-${p.id}`} style="margin:0">
                  {p.number} vom {dateDe(p.issue_date)} – {euro(p.gross_cents)} brutto
                </label>
              </div>
            ))}
          </div>
        )}
        <LineEditor lines={lines} services={services} types={types} />
        <div class="chk" style="margin-top:10px">
          <input type="hidden" name="reverse_charge_shown" value="1" />
          <input
            type="checkbox"
            id="reverse_charge"
            name="reverse_charge"
            checked={
              inv.reverse_charge ?? customers.find((c) => c.id === inv.customer_id)?.reverse_charge ?? false
            }
          />
          <label for="reverse_charge">
            § 13b UStG – Steuerschuldnerschaft des Leistungsempfängers (alle Positionen 0 %, sonst 19 %)
          </label>
        </div>
        <div style="margin:12px 0">
          <label for="closing_text">Schlusstext</label>
          <textarea id="closing_text" name="closing_text">
            {inv.closing_text ?? ''}
          </textarea>
        </div>
        <div class="actions">
          <button class="btn">Entwurf speichern</button>
          <a class="btn sec" href={inv.status ? `/rechnungen/${id}` : '/rechnungen'}>
            Abbrechen
          </a>
        </div>
      </form>
    )}
  </>
);

export const CorrectionEditor: FC<{
  id: string;
  original: InvoiceRow;
  newId: string;
  types?: ServiceTypeOption[];
}> = ({ id, original, newId, types }) => (
  <>
    <h1>Rechnungskorrektur zu {original.number}</h1>
    <div class="hint" style="margin-bottom:16px">
      Für Minderungen negative Mengen eintragen (z. B. Menge <b>-1</b>, Preis <b>100,00</b>). Die
      Originalrechnung bleibt unverändert; die Korrektur erhält eine eigene Nummer und verweist auf das
      Original.
    </div>
    <form method="post" action={`/rechnungen/${id}/korrektur`} class="card" data-autosave>
      <input type="hidden" name="new_id" value={newId} />
      <div style="margin-bottom:12px">
        <label for="intro_text">Begründung / Einleitung</label>
        <textarea
          id="intro_text"
          name="intro_text"
        >{`Korrektur zur Rechnung ${original.number} vom ${dateDe(original.issue_date)}:`}</textarea>
      </div>
      <LineEditor
        lines={[{ desc: '', detail: '', qty: '-1', unit: 'C62', price: '', vat: '1900', src: '' }]}
        types={types}
      />
      <div class="actions">
        <button class="btn">Korrekturentwurf anlegen</button>
        <a class="btn sec" href={`/rechnungen/${id}`}>
          Abbrechen
        </a>
      </div>
    </form>
  </>
);

interface DocInfo {
  id: string;
  kind: string;
  filename: string;
  sha256: string;
  size_bytes: bigint;
  valid: boolean | null;
}

const DOC_LABEL: Record<string, string> = {
  pdf: 'Rechnung (PDF)',
  xrechnung_xml: 'XRechnung (UBL-XML)',
  zugferd_pdf: 'ZUGFeRD (PDF/A-3 mit XML)',
  validation_report: 'KoSIT-Prüfbericht',
  attachment: 'Anlage',
};

export const InvoiceDetail: FC<{
  inv: InvoiceRow;
  lines: LineRow[];
  customer: Customer;
  site: Site | undefined;
  original: InvoiceRow | undefined;
  derived: InvoiceRow[];
  prepayments: InvoiceRow[];
  docs: DocInfo[];
  deliveries: DeliveryRow[];
  preflight: PreflightResult | null;
  redirectNote: string;
  uploadSlot?: Child;
  /** gültige Rechnungsangaben (Objekt vor Kunde) */
  billing: EffectiveBilling;
}> = ({
  inv,
  lines,
  customer,
  site,
  original,
  derived,
  prepayments,
  docs,
  deliveries,
  preflight,
  redirectNote,
  uploadSlot,
  billing,
}) => {
  const draft = inv.status === 'draft';
  // ausgestellt: eingefrorener Empfänger; Entwurf: aktuelle Angaben (Objekt vor Kunde)
  const to = inv.buyer_snapshot
    ? {
        name: inv.buyer_snapshot.name,
        name2: inv.buyer_snapshot.name2,
        street: inv.buyer_snapshot.street,
        postalCode: inv.buyer_snapshot.postalCode,
        city: inv.buyer_snapshot.city,
        contactName: inv.buyer_snapshot.contactName,
      }
    : billing;
  const sent = deliveries.find((d) => d.status === 'sent');
  const failed = deliveries.find((d) => d.status === 'failed');
  const cancelled = derived.find((d) => d.kind === 'cancellation');
  return (
    <>
      <div class="actions">
        <h1 style="margin:0">
          {KIND_TITLES[inv.kind]} {inv.number ?? '(Entwurf)'}
        </h1>
        <StatusBadge inv={{ status: inv.status, delivery_status: deliveries.at(-1)?.status ?? null }} />
        {cancelled && <span class="badge err">storniert</span>}
      </div>
      {inv.status === 'draft' && <CustomerNotice c={customer} />}
      <div class="grid card">
        <div>
          <label>Kunde</label>
          <a href={`/kunden/${customer.id}`}>{customer.name}</a>
          <div class="small mut">
            {customer.customer_no} · Format: {FORMAT_LABEL[inv.invoice_format]}
          </div>
        </div>
        <div>
          <label>Objekt</label>
          {site ? <a href={`/objekte/${site.id}`}>{site.name}</a> : '–'}
        </div>
        <div>
          <label>Datum / fällig</label>
          {dateDe(inv.issue_date)} / {dateDe(inv.due_date)}
        </div>
        <div>
          <label>Leistungszeitraum</label>
          {inv.period_start ? `${dateDe(inv.period_start)} – ${dateDe(inv.period_end)}` : '–'}
        </div>
        <div>
          <label>Leitweg-ID</label>
          {inv.buyer_reference ?? '–'}
        </div>
        <div>
          <label>Skonto</label>
          {inv.skonto_percent_bp
            ? `${String(inv.skonto_percent_bp / 100).replace('.', ',')} % bis ${dateDe(inv.skonto_date)}`
            : inv.status === 'draft' && billing.skonto
              ? `${String(billing.skonto.percentBp / 100).replace('.', ',')} % in ${billing.skonto.days} Tagen`
              : '–'}
        </div>
        <div>
          <label>
            Rechnung an{' '}
            {billing.source === 'objekt' && (
              <span class="badge kind" style="margin-left:4px">
                vom Objekt
              </span>
            )}
          </label>
          <div>{to.name}</div>
          <div class="small mut">
            {[
              to.name2,
              to.street,
              `${to.postalCode} ${to.city}`,
              to.contactName ? `z. Hd. ${to.contactName}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <div class="small mut">E-Mail: {billing.emails.length ? billing.emails.join(', ') : '–'}</div>
        </div>
        {original && (
          <div>
            <label>Bezieht sich auf</label>
            <a href={`/rechnungen/${original.id}`}>{original.number}</a>
          </div>
        )}
      </div>

      {draft && inv.review_required && (
        <div class="flash err" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span>
            <b>Unfertig:</b> Diese Rechnung enthält eine Leistung mit „immer unfertig“. Bitte Positionen
            prüfen (bearbeiten) und dann freigeben – vorher ist Ausstellen gesperrt.
          </span>
          <form method="post" action={`/rechnungen/${inv.id}/geprueft`} style="margin-left:auto">
            <button class="btn sm">Geprüft</button>
          </form>
        </div>
      )}
      {draft && (
        <form method="post" action={`/rechnungen/${inv.id}/rechnungsdatum`} class="actions" style="gap:8px">
          <label for="planned_issue_date" class="small" style="margin:0">
            Rechnungsdatum beim Ausstellen
          </label>
          <input
            id="planned_issue_date"
            type="date"
            name="date"
            value={inv.planned_issue_date ?? ''}
            style="width:170px"
          />
          <button class="btn sm sec">Übernehmen</button>
          <span class="small mut">leer = Tag des Ausstellens</span>
        </form>
      )}
      {draft && (
        <div class="actions">
          <a class="btn sec" href={`/rechnungen/${inv.id}/vorschau.pdf`} target="_blank">
            PDF-Vorschau
          </a>
          {['invoice', 'partial', 'final'].includes(inv.kind) && (
            <a class="btn sec" href={`/rechnungen/${inv.id}/bearbeiten`}>
              Bearbeiten
            </a>
          )}
          <a class="btn sec" href={`/rechnungen/${inv.id}?pruefen=1`}>
            E-Rechnung prüfen (KoSIT)
          </a>
          <form
            method="post"
            action={`/rechnungen/${inv.id}/ausstellen`}
            onsubmit="return confirm('Rechnung jetzt verbindlich ausstellen? Danach ist sie unveränderbar und erhält eine fortlaufende Nummer.')"
          >
            <button class="btn">Ausstellen</button>
          </form>
          <form
            method="post"
            action={`/rechnungen/${inv.id}/loeschen`}
            onsubmit="return confirm('Entwurf löschen?')"
            style="margin-left:auto"
          >
            <button class="btn danger sm">Entwurf löschen</button>
          </form>
        </div>
      )}

      {preflight && (
        <div class={`flash ${preflight.valid ? 'ok' : 'err'}`}>
          {preflight.valid
            ? 'KoSIT-Prüfung bestanden: XRechnung (UBL) und ZUGFeRD-XML (CII) sind gültig.'
            : 'KoSIT-Prüfung NICHT bestanden – Ausstellen und Versand sind gesperrt.'}
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

      {!draft && (
        <div class="actions">
          {!sent && (
            <form
              method="post"
              action={`/rechnungen/${inv.id}/versenden`}
              onsubmit={`return confirm('Rechnung jetzt per E-Mail versenden?${redirectNote ? '\\n\\n' + redirectNote : ''}')`}
            >
              {failed && <input type="hidden" name="retry" value="1" />}
              <button class="btn">{failed ? 'Erneut versenden' : 'Per E-Mail versenden'}</button>
            </form>
          )}
          {inv.kind !== 'cancellation' && !cancelled && (
            <>
              <form
                method="post"
                action={`/rechnungen/${inv.id}/storno`}
                onsubmit="return confirm('Stornorechnung als Entwurf anlegen?')"
              >
                <button class="btn danger">Stornieren</button>
              </form>
              <a class="btn sec" href={`/rechnungen/${inv.id}/korrektur`}>
                Rechnungskorrektur
              </a>
            </>
          )}
        </div>
      )}

      <h2>Positionen</h2>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Pos.</th>
              <th>Leistung</th>
              <th class="r">Menge</th>
              <th>Einheit</th>
              <th class="r">Einzelpreis</th>
              <th class="r">USt</th>
              <th class="r">Gesamt netto</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr>
                <td>{l.position}</td>
                <td>
                  {l.service_type_name && (
                    <span class="badge" style="margin-right:6px">
                      {l.service_type_name}
                    </span>
                  )}
                  {l.description}
                  {l.detail && (
                    <div class="small mut" style="white-space:pre-line">
                      {l.detail}
                    </div>
                  )}
                </td>
                <td class="r">{milliToInput(l.quantity_milli)}</td>
                <td>{UNIT_LABELS[l.unit_code] ?? l.unit_code}</td>
                <td class="r">{euro(l.unit_price_cents)}</td>
                <td class="r">{l.vat_rate_bp / 100} %</td>
                <td class="r">{euro(l.net_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table class="totals" style="margin-top:8px">
        <tbody>
          <tr>
            <td>Summe netto</td>
            <td class="r">{euro(inv.net_cents)}</td>
          </tr>
          <tr>
            <td>Umsatzsteuer</td>
            <td class="r">{euro(inv.vat_cents)}</td>
          </tr>
          <tr class="sum">
            <td>Gesamt brutto</td>
            <td class="r">{euro(inv.gross_cents)}</td>
          </tr>
          {inv.prepaid_cents !== 0n && (
            <>
              {prepayments.map((p) => (
                <tr>
                  <td class="small">abzgl. {p.number}</td>
                  <td class="r small">-{euro(p.gross_cents)}</td>
                </tr>
              ))}
              <tr class="sum">
                <td>Zahlbetrag</td>
                <td class="r">{euro(inv.payable_cents)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>

      {derived.length > 0 && (
        <>
          <h2>Folgebelege</h2>
          <ul>
            {derived.map((d) => (
              <li>
                <a href={`/rechnungen/${d.id}`}>
                  {KIND_TITLES[d.kind]} {d.number ?? '(Entwurf)'}
                </a>{' '}
                {euro(d.gross_cents)}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Belege &amp; Anlagen (Archiv)</h2>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Dokument</th>
              <th>Datei</th>
              <th>Prüfung</th>
              <th class="r">Größe</th>
              <th>SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr>
                <td colspan={5} class="mut">
                  {draft ? 'Belege entstehen beim Ausstellen.' : 'Noch keine Belege.'}
                </td>
              </tr>
            )}
            {docs.map((d) => (
              <tr>
                <td>{DOC_LABEL[d.kind] ?? d.kind}</td>
                <td>
                  <a href={`/dokumente/${d.id}`}>{d.filename}</a>
                </td>
                <td>
                  {d.valid === null ? (
                    ''
                  ) : d.valid ? (
                    <span class="badge issued">gültig</span>
                  ) : (
                    <span class="badge err">ungültig</span>
                  )}
                </td>
                <td class="r">{(Number(d.size_bytes) / 1024).toFixed(0)} KB</td>
                <td class="small mut" title={d.sha256}>
                  {d.sha256.slice(0, 16)}…
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!sent && <div style="margin-top:12px">{uploadSlot}</div>}

      <h2>Versandprotokoll</h2>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Zeitpunkt</th>
              <th>Status</th>
              <th>An (tatsächlich)</th>
              <th>Laut Kundenstamm</th>
              <th>Dateien</th>
              <th class="r">Versuche</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.length === 0 && (
              <tr>
                <td colspan={6} class="mut">
                  Noch nicht versendet.
                </td>
              </tr>
            )}
            {deliveries.map((d) => (
              <tr>
                <td>{(d.sent_at ?? d.created_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}</td>
                <td>
                  <span class={`badge ${d.status}`}>{STATUS_LABEL[d.status]}</span>
                  {d.error && (
                    <div class="small" style="color:var(--err)">
                      {d.error}
                    </div>
                  )}
                </td>
                <td>{d.actual_recipients.join(', ')}</td>
                <td class="small mut">{d.intended_recipients.join(', ') || '–'}</td>
                <td class="small">
                  {d.files.map((f) => f.filename.replace(/^[0-9a-f]{12}_/, '')).join(', ')}
                </td>
                <td class="r">{d.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
