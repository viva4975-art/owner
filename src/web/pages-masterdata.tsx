import type { FC } from 'hono/jsx';
import type { Customer, Site, SiteService } from '../services/masterdata.js';
import { centsToInput, milliToInput } from './forms.js';
import { FORMAT_LABEL, SERVICE_KIND_LABEL, dateDe, euro } from './layout.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';

export const CustomerList: FC<{ customers: (Customer & { site_count: number })[] }> = ({ customers }) => (
  <>
    <div class="actions">
      <h1 style="margin:0">Kunden</h1>
      <a class="btn" href="/kunden/neu" style="margin-left:auto">
        + Neuer Kunde
      </a>
    </div>
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Nr.</th>
            <th>Name</th>
            <th>Ort</th>
            <th>Leitweg-ID</th>
            <th>Format</th>
            <th class="r">Zahlungsziel</th>
            <th class="r">Objekte</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr>
              <td>{c.customer_no}</td>
              <td>
                <a href={`/kunden/${c.id}`}>{c.name}</a>
                {!c.active && <span class="badge"> inaktiv</span>}
              </td>
              <td>{c.city}</td>
              <td class="small">{c.leitweg_id ?? '–'}</td>
              <td>{FORMAT_LABEL[c.invoice_format]}</td>
              <td class="r">{c.payment_terms_days} Tage</td>
              <td class="r">{c.site_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>
);

const Field: FC<{
  name: string;
  label: string;
  value?: string | number | null | undefined;
  type?: string;
  required?: boolean;
  placeholder?: string;
}> = (p) => (
  <div>
    <label for={p.name}>{p.label}</label>
    <input
      id={p.name}
      name={p.name}
      type={p.type ?? 'text'}
      value={p.value ?? ''}
      required={p.required}
      placeholder={p.placeholder}
    />
  </div>
);

export const CustomerForm: FC<{ id: string; c: Partial<Customer>; sites: Site[]; isNew: boolean }> = ({
  id,
  c,
  sites,
  isNew,
}) => (
  <>
    <h1>{isNew ? 'Neuer Kunde' : c.name}</h1>
    <form method="post" action={`/kunden/${id}`} class="card">
      <div class="grid">
        <Field name="customer_no" label="Kundennummer *" value={c.customer_no} required />
        <Field name="name" label="Name *" value={c.name} required />
        <Field name="name2" label="Namenszusatz / Abteilung" value={c.name2} />
        <Field name="street" label="Straße *" value={c.street} required />
        <Field name="postal_code" label="PLZ *" value={c.postal_code} required />
        <Field name="city" label="Ort *" value={c.city} required />
        <Field name="vat_id" label="USt-IdNr. des Kunden" value={c.vat_id} />
      </div>
      <h2>Rechnungsstellung</h2>
      <div class="grid">
        <div>
          <label for="invoice_format">Rechnungsformat *</label>
          <select id="invoice_format" name="invoice_format">
            {(['pdf', 'zugferd', 'xrechnung'] as const).map((f) => (
              <option value={f} selected={c.invoice_format === f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </div>
        <Field
          name="leitweg_id"
          label="Leitweg-ID (Behörden)"
          value={c.leitweg_id}
          placeholder="z. B. 09162000-12345-67"
        />
        <Field name="supplier_no" label="Unsere Lieferantennummer" value={c.supplier_no} />
        <Field
          name="payment_terms_days"
          label="Zahlungsziel (Tage) *"
          type="number"
          value={c.payment_terms_days ?? 30}
          required
        />
        <div style="grid-column:1/-1">
          <label for="invoice_emails">Rechnungs-E-Mails (mehrere mit Komma)</label>
          <input id="invoice_emails" name="invoice_emails" value={(c.invoice_emails ?? []).join(', ')} />
        </div>
        <div class="chk">
          <input
            type="checkbox"
            id="is_public_authority"
            name="is_public_authority"
            checked={!!c.is_public_authority}
          />
          <label for="is_public_authority" style="margin:0">
            Öffentlicher Auftraggeber
          </label>
        </div>
      </div>
      <h2>Ansprechpartner</h2>
      <div class="grid">
        <Field name="contact_name" label="Name" value={c.contact_name} />
        <Field name="contact_email" label="E-Mail" value={c.contact_email} />
        <Field name="contact_phone" label="Telefon" value={c.contact_phone} />
      </div>
      <div style="margin-top:12px">
        <label for="notes">Notizen</label>
        <textarea id="notes" name="notes">
          {c.notes ?? ''}
        </textarea>
      </div>
      <div class="actions">
        <button class="btn">Speichern</button>
        <a class="btn sec" href="/kunden">
          Abbrechen
        </a>
      </div>
    </form>
    {!isNew && (
      <>
        <div class="actions">
          <h2 style="margin:0">Objekte</h2>
          <a class="btn sm" href={`/objekte/neu?kunde=${id}`} style="margin-left:auto">
            + Objekt anlegen
          </a>
        </div>
        <SiteTable sites={sites} />
      </>
    )}
  </>
);

export const SiteTable: FC<{
  sites: (Site & { customer_name?: string; monthly_net_cents?: bigint })[];
  showCustomer?: boolean;
}> = ({ sites, showCustomer }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Nr.</th>
          <th>Objekt</th>
          {showCustomer && <th>Kunde</th>}
          <th>Ort</th>
          <th class="r">Pauschale/Monat netto</th>
        </tr>
      </thead>
      <tbody>
        {sites.length === 0 && (
          <tr>
            <td colspan={5} class="mut">
              Noch keine Objekte.
            </td>
          </tr>
        )}
        {sites.map((s) => (
          <tr>
            <td>{s.site_no}</td>
            <td>
              <a href={`/objekte/${s.id}`}>{s.name}</a>
              {!s.active && <span class="badge"> inaktiv</span>}
            </td>
            {showCustomer && <td>{s.customer_name}</td>}
            <td>{[s.postal_code, s.city].filter(Boolean).join(' ')}</td>
            <td class="r">{s.monthly_net_cents !== undefined ? euro(s.monthly_net_cents) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const SiteForm: FC<{
  id: string;
  s: Partial<Site>;
  customers: Customer[];
  services: SiteService[];
  isNew: boolean;
  newServiceId: string;
}> = ({ id, s, customers, services, isNew, newServiceId }) => (
  <>
    <h1>{isNew ? 'Neues Objekt' : `Objekt ${s.site_no}: ${s.name}`}</h1>
    <form method="post" action={`/objekte/${id}`} class="card">
      <div class="grid">
        <div>
          <label for="customer_id">Kunde *</label>
          <select id="customer_id" name="customer_id" required>
            <option value="">– bitte wählen –</option>
            {customers.map((c) => (
              <option value={c.id} selected={c.id === s.customer_id}>
                {c.customer_no} · {c.name}
              </option>
            ))}
          </select>
        </div>
        <Field name="site_no" label="Objektnummer *" value={s.site_no} required />
        <Field name="name" label="Bezeichnung *" value={s.name} required />
        <Field name="street" label="Straße" value={s.street} />
        <Field name="postal_code" label="PLZ" value={s.postal_code} />
        <Field name="city" label="Ort" value={s.city} />
        <Field name="order_reference" label="Bestellnummer des Kunden" value={s.order_reference} />
        <Field name="contract_reference" label="Vertragsnummer" value={s.contract_reference} />
      </div>
      <div class="actions">
        <button class="btn">Speichern</button>
        {s.customer_id && (
          <a class="btn sec" href={`/kunden/${s.customer_id}`}>
            Zum Kunden
          </a>
        )}
      </div>
    </form>

    {!isNew && (
      <>
        <h2>Leistungen &amp; Preise</h2>
        <p class="mut small">
          Monatspauschalen werden vom Monatslauf automatisch berechnet. Sonderleistungen und Regiestunden
          stehen als Vorlagen beim Erfassen von Rechnungspositionen bereit.
        </p>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Art</th>
                <th>Beschreibung</th>
                <th class="r">Menge</th>
                <th>Einheit</th>
                <th class="r">Preis netto</th>
                <th class="r">USt</th>
                <th>Gültig</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {services.map((sv) => (
                <tr style={sv.active ? '' : 'opacity:.5'}>
                  <td>{SERVICE_KIND_LABEL[sv.kind]}</td>
                  <td>{sv.description}</td>
                  <td class="r">{milliToInput(sv.quantity_milli)}</td>
                  <td>{UNIT_LABELS[sv.unit_code] ?? sv.unit_code}</td>
                  <td class="r">{euro(sv.unit_price_cents)}</td>
                  <td class="r">{sv.vat_rate_bp / 100} %</td>
                  <td class="small">
                    ab {dateDe(sv.valid_from)}
                    {sv.valid_to ? ` bis ${dateDe(sv.valid_to)}` : ''}
                  </td>
                  <td>
                    <form method="post" action={`/leistungen/${sv.id}/aktiv`}>
                      <input type="hidden" name="active" value={sv.active ? 'false' : 'true'} />
                      <input type="hidden" name="site_id" value={id} />
                      <button class="btn sm sec">{sv.active ? 'Deaktivieren' : 'Aktivieren'}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form
          method="post"
          action={`/objekte/${id}/leistungen/${newServiceId}`}
          class="card"
          style="margin-top:12px"
        >
          <b>Leistung hinzufügen</b>
          <div class="grid" style="margin-top:8px">
            <div>
              <label for="kind">Art</label>
              <select id="kind" name="kind">
                {Object.entries(SERVICE_KIND_LABEL).map(([k, v]) => (
                  <option value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div style="grid-column:span 2">
              <Field name="description" label="Beschreibung *" required />
            </div>
            <Field name="quantity" label="Menge" value="1" />
            <div>
              <label for="unit_code">Einheit</label>
              <select id="unit_code" name="unit_code">
                {Object.entries(UNIT_LABELS).map(([k, v]) => (
                  <option value={k}>{v}</option>
                ))}
              </select>
            </div>
            <Field name="unit_price" label="Einzelpreis netto (€) *" placeholder="1.850,00" required />
            <div>
              <label for="vat_rate_bp">USt</label>
              <select id="vat_rate_bp" name="vat_rate_bp">
                <option value="1900">19 %</option>
                <option value="700">7 %</option>
              </select>
            </div>
            <Field
              name="valid_from"
              label="Gültig ab *"
              type="date"
              value={new Date().toISOString().slice(0, 10)}
              required
            />
            <Field name="valid_to" label="Gültig bis" type="date" />
          </div>
          <div class="actions">
            <button class="btn">Leistung speichern</button>
          </div>
        </form>
      </>
    )}
  </>
);

export { centsToInput };
