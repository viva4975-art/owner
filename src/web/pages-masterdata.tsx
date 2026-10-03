import type { Child, FC } from 'hono/jsx';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import type { Customer, Site, SiteService } from '../services/masterdata.js';
import { centsToInput, milliToInput } from './forms.js';
import {
  FORMAT_LABEL,
  NEW_OPTIONS,
  PageHead,
  SERVICE_KIND_LABEL,
  type Tab,
  Tabs,
  dateDe,
  euro,
} from './layout.js';

export const Field: FC<{
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

// ---------------------------------------------------------------------------
// Kundenliste (wie Fortytools: Status, Nummer, Kurzname/Adresse, A–Z)
// ---------------------------------------------------------------------------

type CustomerRow = Customer & { site_count: number; open_cents?: bigint };

export const CustomerList: FC<{ customers: CustomerRow[]; letter: string | null; q: string | null }> = ({
  customers,
  letter,
  q,
}) => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  return (
    <>
      <PageHead title="Kunden" create={{ options: NEW_OPTIONS, selected: 'kunde' }} />
      <div class="card">
        <form class="actions" method="get" action="/kunden" style="margin-top:0">
          <input
            name="q"
            value={q ?? ''}
            placeholder="Kunden filtern (Name, Nummer, Ort)"
            style="max-width:320px"
          />
          <button class="btn sec sm">Filtern</button>
          <span class="mut small" style="margin-left:auto">
            {customers.length} Kunden
          </span>
        </form>
        <div class="actions" style="gap:4px">
          <a class={`btn sm ${letter ? 'sec' : ''}`} href="/kunden">
            ✱
          </a>
          {letters.map((l) => (
            <a class={`btn sm ${letter === l ? '' : 'sec'}`} href={`/kunden?buchstabe=${l}`}>
              {l}
            </a>
          ))}
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>#</th>
                <th>
                  Kurzname
                  <div class="mut small">Adresse</div>
                </th>
                <th>Format</th>
                <th class="r">Objekte</th>
                <th class="r">Offen</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 && (
                <tr>
                  <td colspan={6} class="mut">
                    Keine Kunden gefunden.
                  </td>
                </tr>
              )}
              {customers.map((c) => (
                <tr>
                  <td>
                    {!c.active ? (
                      <span class="badge">inaktiv</span>
                    ) : c.status === 'interessent' ? (
                      <span class="badge info">Interessent</span>
                    ) : (
                      <span class="badge ok">Kunde</span>
                    )}
                    {c.dunning_block && <span class="badge warn">Mahnsperre</span>}
                  </td>
                  <td>{c.customer_no}</td>
                  <td>
                    <a href={`/kunden/${c.id}`}>
                      <b>{c.name}</b>
                    </a>
                    <div class="mut small">
                      {c.street}/{c.postal_code} {c.city}
                    </div>
                  </td>
                  <td>
                    {FORMAT_LABEL[c.invoice_format]}
                    {c.is_public_authority && <div class="small mut">Behörde</div>}
                  </td>
                  <td class="r">{c.site_count}</td>
                  <td class="r">{c.open_cents ? euro(c.open_cents) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Kunde: Rahmen mit Reitern
// ---------------------------------------------------------------------------

export interface CustomerCounts {
  contacts: number;
  notes: number;
  invoices: number;
  sites: number;
  tasks: number;
  openItems: number;
  offers: number;
  dunnings: number;
  files: number;
}

export const CustomerShell: FC<{ c: Customer; counts: CustomerCounts; active: string; children?: Child }> = ({
  c,
  counts,
  active,
  children,
}) => {
  const base = `/kunden/${c.id}`;
  const tabs: Tab[] = [
    { key: 'uebersicht', label: 'Übersicht', href: base },
    { key: 'kontakte', label: 'Kontakte', href: `${base}/kontakte`, count: counts.contacts },
    { key: 'notizen', label: 'Notizen', href: `${base}/notizen`, count: counts.notes },
    { key: 'rechnungen', label: 'Rechnungen', href: `${base}/rechnungen`, count: counts.invoices },
    { key: 'objekte', label: 'Objekte', href: `${base}/objekte`, count: counts.sites },
  ];
  const more: Tab[] = [
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: counts.tasks },
    { key: 'op', label: 'Offene Posten', href: `${base}/offene-posten`, count: counts.openItems },
    { key: 'rechnungsgruppen', label: 'Rechnungsgruppen', href: `${base}/rechnungsgruppen` },
    { key: 'bearbeiten', label: 'Stammdaten bearbeiten', href: `${base}/bearbeiten` },
    { key: 'angebote', label: 'Angebote', href: `${base}/angebote`, count: counts.offers },
    { key: 'mahnungen', label: 'Mahnungen', href: `${base}/mahnungen`, count: counts.dunnings },
    { key: 'dokumente', label: 'Dokumente', href: `${base}/dokumente`, count: counts.files },
    { key: 'x-einsaetze', label: 'Einsätze (bald)', href: '/geplant/einsatzplanung' },
  ];
  return (
    <>
      <PageHead
        title={c.name}
        no={c.customer_no}
        create={{
          options: [
            ['aufgabe', 'Aufgabe'],
            ['rechnung', 'Rechnung'],
            ['angebot', 'Angebot'],
            ['objekt', 'Objekt'],
            ['kontakt', 'Kontakt'],
          ],
          suffix: 'für diesen Kunden',
          context: { kunde: c.id },
        }}
      />
      <Tabs tabs={tabs} more={more} active={active} />
      <div class="tabbody">{children}</div>
    </>
  );
};

export const CustomerCard: FC<{ c: Customer }> = ({ c }) => (
  <div class="card">
    <div class="actions" style="margin-top:0">
      <h3 style="margin:0">
        {c.name}
        {c.name2 && <div class="mut small">{c.name2}</div>}
      </h3>
      <a class="btn sm sec" href={`/kunden/${c.id}/bearbeiten`} style="margin-left:auto">
        Bearbeiten
      </a>
    </div>
    <div>
      {c.street}
      <br />
      {c.postal_code} {c.city}
    </div>
    <dl class="kv" style="margin-top:12px">
      <dt>Rechnungsformat</dt>
      <dd>{FORMAT_LABEL[c.invoice_format]}</dd>
      {c.leitweg_id && (
        <>
          <dt>Leitweg-ID</dt>
          <dd>{c.leitweg_id}</dd>
        </>
      )}
      <dt>Zahlungsziel</dt>
      <dd>
        {c.payment_terms_days} Tage
        {c.skonto_percent_bp &&
          `, ${String(c.skonto_percent_bp / 100).replace('.', ',')} % Skonto in ${c.skonto_days} Tagen`}
      </dd>
      <dt>Rechnungs-E-Mail</dt>
      <dd>
        {c.invoice_emails.length
          ? c.invoice_emails.map((e) => (
              <div>
                <a href={`mailto:${e}`}>{e}</a>
              </div>
            ))
          : '–'}
      </dd>
      {c.supplier_no && (
        <>
          <dt>Lieferanten-Nr.</dt>
          <dd>{c.supplier_no}</dd>
        </>
      )}
    </dl>
    <div class="actions" style="margin-bottom:0">
      {c.active ? <span class="badge ok">Kunde</span> : <span class="badge">inaktiv</span>}
      {c.is_public_authority && <span class="badge tag">Öffentlicher Auftraggeber</span>}
    </div>
  </div>
);

export const RevenueBars: FC<{ rows: { month: string; net_cents: bigint }[] }> = ({ rows }) => {
  const max = rows.reduce((m, r) => (r.net_cents > m ? r.net_cents : m), 1n);
  const total = rows.reduce((s, r) => s + r.net_cents, 0n);
  const label = (m: string) => {
    const [y, mo] = m.split('-');
    return `${['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'][Number(mo) - 1]} ${y!.slice(2)}`;
  };
  return (
    <>
      <div class="bars" role="img" aria-label="Netto-Umsatz je Monat">
        {rows.map((r) => (
          <div
            style={`height:${Math.max(1, Number((r.net_cents * 100n) / max))}%`}
            title={`${label(r.month)}: ${euro(r.net_cents)}`}
          />
        ))}
      </div>
      <div class="barlabels">
        {rows.map((r, i) => (
          <span>{(rows.length - 1 - i) % 3 === 0 ? label(r.month) : ''}</span>
        ))}
      </div>
      <div class="tbl" style="margin-top:12px">
        <table>
          <thead>
            <tr>
              <th>Monat</th>
              <th class="r">Netto</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>{label(r.month)}</td>
                <td class="r">{euro(r.net_cents)}</td>
              </tr>
            ))}
            <tr>
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
    </>
  );
};

// ---------------------------------------------------------------------------
// Kunde bearbeiten
// ---------------------------------------------------------------------------

export const CustomerForm: FC<{ id: string; c: Partial<Customer>; isNew: boolean }> = ({ id, c, isNew }) => (
  <form
    method="post"
    action={`/kunden/${id}`}
    data-autosave={`/kunden/${id}`}
    data-version={String(c.version ?? '')}
  >
    <input type="hidden" name="version" value={String(c.version ?? '')} />
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
      <div>
        <label for="skonto_percent">Skonto % (leer = kein Skonto)</label>
        <input
          id="skonto_percent"
          name="skonto_percent_bp"
          placeholder="z. B. 3"
          value={c.skonto_percent_bp ? String(c.skonto_percent_bp / 100).replace('.', ',') : ''}
        />
      </div>
      <Field
        name="skonto_days"
        label="Skonto innerhalb (Tage)"
        type="number"
        value={c.skonto_days}
        placeholder="z. B. 7"
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
      <div class="chk">
        <input type="checkbox" id="dunning_block" name="dunning_block" checked={!!c.dunning_block} />
        <label for="dunning_block" style="margin:0">
          Mahnsperre (keine Mahnvorschläge)
        </label>
      </div>
      <div>
        <label for="status">Status</label>
        <select id="status" name="status">
          <option value="kunde" selected={c.status !== 'interessent'}>
            Kunde
          </option>
          <option value="interessent" selected={c.status === 'interessent'}>
            Interessent (nur Angebote)
          </option>
        </select>
      </div>
    </div>
    <h2>Hauptansprechpartner</h2>
    <p class="mut small" style="margin-top:-6px">
      Weitere Ansprechpartner im Reiter „Kontakte“.
    </p>
    <div class="grid">
      <Field name="contact_name" label="Name" value={c.contact_name} />
      <Field name="contact_email" label="E-Mail" value={c.contact_email} />
      <Field name="contact_phone" label="Telefon" value={c.contact_phone} />
    </div>
    <div style="margin-top:12px">
      <label for="notes">Interne Bemerkung</label>
      <textarea id="notes" name="notes">
        {c.notes ?? ''}
      </textarea>
    </div>
    <div class="actions">
      <button class="btn">Speichern</button>
      <a class="btn sec" href={isNew ? '/kunden' : `/kunden/${id}`}>
        Abbrechen
      </a>
    </div>
  </form>
);

// ---------------------------------------------------------------------------
// Objekte
// ---------------------------------------------------------------------------

export const SiteTable: FC<{
  sites: (Site & { customer_name?: string; monthly_net_cents?: bigint })[];
  showCustomer?: boolean;
}> = ({ sites, showCustomer }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Nummer</th>
          <th>Name</th>
          {showCustomer && <th>Kunde</th>}
          <th>Straße</th>
          <th>PLZ</th>
          <th>Stadt</th>
          <th class="r">Pauschale/Monat</th>
        </tr>
      </thead>
      <tbody>
        {sites.length === 0 && (
          <tr>
            <td colspan={7} class="mut">
              Noch keine Objekte.
            </td>
          </tr>
        )}
        {sites.map((s) => (
          <tr>
            <td>
              <a href={`/objekte/${s.id}`}>{s.site_no}</a>
            </td>
            <td>
              <a href={`/objekte/${s.id}`}>
                <b>{s.name}</b>
              </a>
              {!s.active && <span class="badge"> inaktiv</span>}
            </td>
            {showCustomer && <td>{s.customer_name}</td>}
            <td>{s.street ?? ''}</td>
            <td>{s.postal_code ?? ''}</td>
            <td>{s.city ?? ''}</td>
            <td class="r">{s.monthly_net_cents !== undefined ? euro(s.monthly_net_cents) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export interface SiteCounts {
  services: number;
  notes: number;
  invoices: number;
  employees: number;
  tasks: number;
}

export const SiteShell: FC<{
  s: Site & { customer_name: string };
  counts: SiteCounts;
  active: string;
  children?: Child;
}> = ({ s, counts, active, children }) => {
  const base = `/objekte/${s.id}`;
  const tabs: Tab[] = [
    { key: 'uebersicht', label: 'Übersicht', href: base },
    { key: 'leistungen', label: 'Leistungen & Preise', href: `${base}/leistungen`, count: counts.services },
    { key: 'notizen', label: 'Notizen', href: `${base}/notizen`, count: counts.notes },
    { key: 'rechnungen', label: 'Rechnungen', href: `${base}/rechnungen`, count: counts.invoices },
  ];
  const more: Tab[] = [
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: counts.tasks },
    { key: 'bearbeiten', label: 'Objekt bearbeiten', href: `${base}/bearbeiten` },
    { key: 'einsaetze', label: 'Einsatzplan', href: `${base}/einsaetze` },
    { key: 'zeiten', label: 'Erfasste Zeiten', href: `${base}/zeiten` },
    { key: 'qr', label: 'QR-Aushang Zeiterfassung', href: `${base}/qr` },
    { key: 'arbeitsscheine', label: 'Arbeitsscheine', href: `${base}/arbeitsscheine` },
    { key: 'x-schluessel', label: 'Schlüssel (bald)', href: '/geplant/schluessel' },
    { key: 'raumbuch', label: 'Raumbuch', href: `${base}/raumbuch` },
    { key: 'stundenvorgabe', label: 'Stundenvorgabe', href: `${base}/stundenvorgabe` },
    { key: 'qualitaet', label: 'Qualitätskontrolle', href: `${base}/qualitaet` },
    { key: 'zaehler', label: 'Zähler', href: `${base}/zaehler` },
  ];
  return (
    <>
      <PageHead
        title={`Objekt: ${s.name}`}
        no={s.site_no}
        create={{
          options: [
            ['aufgabe', 'Aufgabe'],
            ['rechnung', 'Rechnung'],
          ],
          suffix: 'für dieses Objekt',
          context: { objekt: s.id, kunde: s.customer_id },
        }}
      />
      <Tabs tabs={tabs} more={more} active={active} />
      <div class="tabbody">{children}</div>
    </>
  );
};

export const SiteForm: FC<{ id: string; s: Partial<Site>; customers: Customer[]; isNew: boolean }> = ({
  id,
  s,
  customers,
  isNew,
}) => (
  <form
    method="post"
    action={`/objekte/${id}`}
    data-autosave={`/objekte/${id}`}
    data-version={String(s.version ?? '')}
  >
    <input type="hidden" name="version" value={String(s.version ?? '')} />
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
      <a
        class="btn sec"
        href={isNew ? (s.customer_id ? `/kunden/${s.customer_id}/objekte` : '/objekte') : `/objekte/${id}`}
      >
        Abbrechen
      </a>
    </div>
  </form>
);

export const ServicesPanel: FC<{ siteId: string; services: SiteService[]; newServiceId: string }> = ({
  siteId,
  services,
  newServiceId,
}) => (
  <>
    <p class="mut small" style="margin-top:0">
      Monatspauschalen werden vom Monatslauf automatisch berechnet. Sonderleistungen und Regiestunden stehen
      als Vorlagen beim Erfassen von Rechnungspositionen bereit.
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
          {services.length === 0 && (
            <tr>
              <td colspan={8} class="mut">
                Noch keine Leistungen.
              </td>
            </tr>
          )}
          {services.map((sv) => (
            <tr style={sv.active ? '' : 'opacity:.5'}>
              <td>{SERVICE_KIND_LABEL[sv.kind]}</td>
              <td>
                {sv.description}
                {sv.note && <div class="small mut">{sv.note}</div>}
              </td>
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
                  <input type="hidden" name="site_id" value={siteId} />
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
      action={`/objekte/${siteId}/leistungen/${newServiceId}`}
      class="card"
      style="margin-top:12px"
      data-autosave={`/objekte/${siteId}/leistungen/neu`}
    >
      <h3>Leistung hinzufügen</h3>
      <div class="grid">
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
              <option value={k} selected={k === 'LS'}>
                {v}
              </option>
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
        <div style="grid-column:1/-1">
          <Field
            name="note"
            label="Zusatztext auf der Rechnung (optional)"
            placeholder="z. B. 3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026"
          />
        </div>
      </div>
      <div class="actions">
        <button class="btn">Leistung speichern</button>
      </div>
    </form>
  </>
);

export const SiteOverview: FC<{
  s: Site & { customer_name: string };
  customer: Customer;
  services: SiteService[];
  employees: { id: string; name: string }[];
  tasksSlot: Child;
}> = ({ s, customer, services, employees, tasksSlot }) => {
  const kinds = [...new Set(services.filter((x) => x.active).map((x) => x.description))];
  return (
    <div class="cols">
      <div>
        {tasksSlot}
        <h2>Aktive Leistungen</h2>
        {kinds.length ? (
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Leistungsart</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map((k) => (
                  <tr>
                    <td>
                      <b>{k}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty">Keine aktiven Leistungen.</div>
        )}
        <h2>Mitarbeiter am Objekt</h2>
        {employees.length ? (
          employees.map((e) => (
            <div>
              <a href={`/personal/${e.id}`}>{e.name}</a>
            </div>
          ))
        ) : (
          <div class="empty">Noch keine Mitarbeiter zugeordnet (Zuordnung beim Mitarbeiter).</div>
        )}
      </div>
      <div>
        <div class="card">
          <div class="actions" style="margin-top:0">
            <h3 style="margin:0">{s.name}</h3>
            <a class="btn sm sec" href={`/objekte/${s.id}/bearbeiten`} style="margin-left:auto">
              Bearbeiten
            </a>
          </div>
          {s.street && <div>{s.street}</div>}
          <div>
            {s.postal_code} {s.city}
          </div>
          {(s.order_reference || s.contract_reference) && (
            <dl class="kv" style="margin-top:10px">
              {s.order_reference && (
                <>
                  <dt>Bestell-Nr.</dt>
                  <dd>{s.order_reference}</dd>
                </>
              )}
              {s.contract_reference && (
                <>
                  <dt>Vertrag</dt>
                  <dd>{s.contract_reference}</dd>
                </>
              )}
            </dl>
          )}
        </div>
        <div class="card">
          <h3>Kunde / Verwaltung</h3>
          <div class="mut">
            {customer.customer_no} <span class="badge ok">Kunde</span>
          </div>
          <a href={`/kunden/${customer.id}`}>
            <b>{customer.name}</b>
          </a>
          <div>{customer.street}</div>
          <div>
            {customer.postal_code} {customer.city}
          </div>
          {customer.contact_name && (
            <>
              <h3 style="margin-top:12px">Ansprechpartner</h3>
              <div>{customer.contact_name}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export { centsToInput };
