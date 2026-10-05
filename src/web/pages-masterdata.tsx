import { randomUUID } from 'node:crypto';
import type { Child, FC } from 'hono/jsx';
import {
  CUSTOMER_STATUS,
  type CustomerFilter,
  type CustomerListRow,
  type CustomerStatus,
  PAGE_SIZE,
} from '../services/customer-list.js';
import {
  type Customer,
  type EffectiveBilling,
  resolveBilling,
  type Site,
  type SiteBilling,
  type SiteService,
} from '../services/masterdata.js';
import { type SiteFilter, type SiteListRow, SITE_PAGE_SIZE } from '../services/site-list.js';
import { centsToInput } from './forms.js';
import { FORMAT_LABEL, NEW_OPTIONS, PageHead, type Tab, Tabs, euro, initials } from './layout.js';

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

const mapsUrl = (c: Pick<Customer, 'street' | 'postal_code' | 'city'>) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.street}, ${c.postal_code} ${c.city}`)}`;

export const CustomerList: FC<{
  rows: CustomerListRow[];
  filtered: number;
  counts: Record<CustomerStatus, number>;
  total: number;
  filter: CustomerFilter;
  page: number;
  sites: Map<string, { id: string; site_no: string; name: string; active: boolean }[]>;
  templates: { id: string; title: string }[];
}> = ({ rows, filtered, counts, total, filter, page, sites, templates }) => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const pages = Math.max(1, Math.ceil(filtered / PAGE_SIZE));
  const url = (
    over: Partial<{ status: string | null; buchstabe: string | null; q: string | null; seite: number }>,
  ) => {
    const p = new URLSearchParams();
    const st = 'status' in over ? over.status : filter.status;
    const l = 'buchstabe' in over ? over.buchstabe : filter.letter;
    const q = 'q' in over ? over.q : filter.q;
    if (st) p.set('status', st);
    if (l) p.set('buchstabe', l);
    if (q) p.set('q', q);
    if (over.seite && over.seite > 1) p.set('seite', String(over.seite));
    const s = p.toString();
    return `/kunden${s ? `?${s}` : ''}`;
  };
  const from = filtered ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, filtered);
  const STATUS_BADGE: Record<CustomerStatus, string> = { kunde: 'ok', interessent: 'warn', ehemalig: 'err' };
  const query = new URLSearchParams(url({}).split('?')[1] ?? '');
  return (
    <>
      <PageHead title="Kunden" create={{ options: NEW_OPTIONS, selected: 'kunde' }} />
      <div class="chips">
        <a href={url({ status: null, seite: 1 })} class={filter.status ? '' : 'on'}>
          Alle<span class="n">{total}</span>
        </a>
        {(Object.keys(CUSTOMER_STATUS) as CustomerStatus[]).map((k) => (
          <a href={url({ status: k, seite: 1 })} class={filter.status === k ? 'on' : ''}>
            {CUSTOMER_STATUS[k]}
            <span class="n">{counts[k]}</span>
          </a>
        ))}
      </div>
      <div class="card">
        <form class="actions" method="get" action="/kunden" style="margin-top:0">
          {filter.status && <input type="hidden" name="status" value={filter.status} />}
          {filter.letter && <input type="hidden" name="buchstabe" value={filter.letter} />}
          <input
            name="q"
            value={filter.q ?? ''}
            placeholder="Suchen: Name, Nummer, Ort, Straße"
            style="max-width:340px"
          />
          <button class="btn sec sm">Suchen</button>
          <span style="margin-left:auto;font-weight:600">
            {from}–{to}{' '}
            <span class="mut" style="font-weight:400">
              von
            </span>{' '}
            {filtered}
          </span>
          <a class="btn sec sm" href={`/kunden/export.csv${query.toString() ? `?${query}` : ''}`}>
            Herunterladen (CSV)
          </a>
        </form>
        <div class="letters">
          <a href={url({ buchstabe: null, seite: 1 })} class={filter.letter ? '' : 'on'}>
            Alle
          </a>
          {letters.map((l) => (
            <a href={url({ buchstabe: l, seite: 1 })} class={filter.letter === l ? 'on' : ''}>
              {l}
            </a>
          ))}
          <a
            href={url({ buchstabe: '#', seite: 1 })}
            class={filter.letter === '#' ? 'on' : ''}
            title="Ziffern/Sonstige"
          >
            #
          </a>
        </div>
        <div class="list" style="margin-top:12px">
          {rows.map((c) => {
            const ss = sites.get(c.id) ?? [];
            return (
              <div class="row">
                <div class="main">
                  <a href={`/kunden/${c.id}`}>
                    <b style="color:var(--ink)">{c.name}</b>
                  </a>{' '}
                  <span class="small faint">{c.customer_no}</span>
                  <div class="small mut">
                    {c.street}, {c.postal_code} {c.city}
                  </div>
                  <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
                    <span class={`badge ${STATUS_BADGE[c.list_status]}`}>
                      {CUSTOMER_STATUS[c.list_status]}
                    </span>
                    {c.dunning_block && <span class="badge warn">Mahnsperre</span>}
                  </div>
                </div>
                <div class="side">
                  {c.open_cents !== 0n && (
                    <span class="when">
                      offen <b style="color:var(--ink)">{euro(c.open_cents)}</b>
                    </span>
                  )}
                  <a
                    class="btn ghost sm"
                    href={mapsUrl(c)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Auf der Karte zeigen"
                  >
                    Karte
                  </a>
                  {ss.length > 0 ? (
                    <details class="pop">
                      <summary class="btn sec sm">Objekte ({ss.length}) ▾</summary>
                      <div class="panel" style="padding:6px;max-height:340px;overflow:auto">
                        {ss.map((x) => (
                          <a href={`/objekte/${x.id}`} class="menuitem" style={x.active ? '' : 'opacity:.55'}>
                            {x.name} <span class="small faint">{x.site_no}</span>
                          </a>
                        ))}
                        <a href={`/objekte/neu?kunde=${c.id}`} class="menuitem" style="color:var(--brand)">
                          + Objekt anlegen
                        </a>
                      </div>
                    </details>
                  ) : (
                    <a class="btn ghost sm" href={`/objekte/neu?kunde=${c.id}`}>
                      + Objekt
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          {!rows.length && (
            <div class="row">
              <div class="main mut">Keine Kunden gefunden.</div>
            </div>
          )}
        </div>
        {pages > 1 && (
          <div class="pager">
            {page > 1 && <a href={url({ seite: page - 1 })}>‹ Zurück</a>}
            {Array.from({ length: pages }, (_, i) => i + 1)
              .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 2)
              .map((n, i, arr) => (
                <>
                  {i > 0 && n - arr[i - 1]! > 1 && <span class="gap">…</span>}
                  <a href={url({ seite: n })} class={n === page ? 'on' : ''}>
                    {n}
                  </a>
                </>
              ))}
            {page < pages && <a href={url({ seite: page + 1 })}>Vor ›</a>}
          </div>
        )}
      </div>

      <div class="card">
        <h3>Serienbrief</h3>
        <p class="small mut" style="margin-top:0">
          Ein Brief an alle <b style="color:var(--ink)">{filtered}</b> Kunden der aktuellen Auswahl (Status,
          Buchstabe, Suche). Sie erhalten ein PDF zum Drucken; jeder Brief wird zusätzlich in der Kundenakte
          (Reiter „Dateien“, Kategorie Schriftverkehr) abgelegt.
        </p>
        <form
          method="post"
          action="/kunden/serienbrief"
          class="actions"
          style="margin-bottom:0"
          target="_blank"
        >
          <input type="hidden" name="run" value={randomUUID()} />
          {filter.status && <input type="hidden" name="status" value={filter.status} />}
          {filter.letter && <input type="hidden" name="buchstabe" value={filter.letter} />}
          {filter.q && <input type="hidden" name="q" value={filter.q} />}
          <select name="vorlage" required style="max-width:360px" aria-label="Vorlage">
            <option value="">– Vorlage wählen –</option>
            {templates.map((t) => (
              <option value={t.id}>{t.title}</option>
            ))}
          </select>
          <button
            class="btn"
            disabled={!filtered}
            onclick={`return confirm('Serienbrief an ${filtered} Kunden erstellen?')`}
          >
            Jetzt erstellen
          </button>
          <a class="btn ghost sm" href="/kunden/vorlagen">
            Vorlagen bearbeiten
          </a>
        </form>
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
        </tr>
      </thead>
      <tbody>
        {sites.length === 0 && (
          <tr>
            <td colspan={6} class="mut">
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
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const SiteList: FC<{
  rows: SiteListRow[];
  filtered: number;
  counts: { aktiv: number; inaktiv: number };
  total: number;
  filter: SiteFilter;
  page: number;
  managers: { id: string; name: string; sites: number }[];
  showManagerFilter: boolean;
}> = ({ rows, filtered, counts, total, filter, page, managers, showManagerFilter }) => {
  const pages = Math.max(1, Math.ceil(filtered / SITE_PAGE_SIZE));
  const params = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | null> = {
      status: filter.status,
      ol: filter.manager,
      buchstabe: filter.letter,
      q: filter.q,
      sort: filter.sort === 'nummer' ? null : filter.sort,
      ab: filter.desc ? '1' : null,
      ...over,
    };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    return p.toString();
  };
  const url = (over: Record<string, string | null>) => {
    const q = params(over);
    return `/objekte${q ? `?${q}` : ''}`;
  };
  const from = filtered ? (page - 1) * SITE_PAGE_SIZE + 1 : 0;
  const to = Math.min(page * SITE_PAGE_SIZE, filtered);
  const exportQuery = params({ seite: null });
  const keys = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789'];
  return (
    <>
      <PageHead
        title="Objekte"
        create={{
          options: [
            ['objekt', 'Objekt'],
            ['kunde', 'Kunde'],
          ],
          selected: 'objekt',
        }}
      />
      <div class="chips">
        <a href={url({ status: null, seite: null })} class={filter.status ? '' : 'on'}>
          Alle<span class="n">{total}</span>
        </a>
        <a href={url({ status: 'aktiv', seite: null })} class={filter.status === 'aktiv' ? 'on' : ''}>
          Aktiv<span class="n">{counts.aktiv}</span>
        </a>
        <a href={url({ status: 'inaktiv', seite: null })} class={filter.status === 'inaktiv' ? 'on' : ''}>
          Inaktiv<span class="n">{counts.inaktiv}</span>
        </a>
      </div>
      <div class="card">
        <form class="actions" method="get" action="/objekte" style="margin-top:0">
          {filter.status && <input type="hidden" name="status" value={filter.status} />}
          {filter.letter && <input type="hidden" name="buchstabe" value={filter.letter} />}
          <input
            name="q"
            value={filter.q ?? ''}
            placeholder="Suchen: Objekt, Nummer, Adresse, Kunde"
            style="max-width:320px"
          />
          {showManagerFilter && (
            <select
              name="ol"
              aria-label="Objektleitung"
              style="max-width:220px"
              onchange="this.form.submit()"
            >
              <option value="">Alle Objektleitungen</option>
              {managers.map((m) => (
                <option value={m.id} selected={filter.manager === m.id}>
                  {m.name} ({m.sites})
                </option>
              ))}
              <option value="ohne" selected={filter.manager === 'ohne'}>
                ohne Objektleitung
              </option>
            </select>
          )}
          <select name="sort" aria-label="Sortieren" style="max-width:200px" onchange="this.form.submit()">
            {(
              [
                ['nummer', 'Nummer'],
                ['name', 'Objektname'],
                ['kunde', 'Kunde'],
                ['ort', 'Ort'],
              ] as const
            ).map(([k, v]) => (
              <option value={k} selected={filter.sort === k}>
                Sortiert nach {v}
              </option>
            ))}
          </select>
          <button class="btn sec sm">Suchen</button>
          <span style="margin-left:auto;font-weight:600">
            {from}–{to}{' '}
            <span class="mut" style="font-weight:400">
              von
            </span>{' '}
            {filtered}
          </span>
          <a class="btn sec sm" href={`/objekte/export.csv${exportQuery ? `?${exportQuery}` : ''}`}>
            CSV-Export
          </a>
          <a
            class="btn sec sm"
            href={`/objekte/qr-druck${exportQuery ? `?${exportQuery}` : ''}`}
            target="_blank"
          >
            QR-Codes drucken
          </a>
        </form>
        <div class="letters">
          <a href={url({ buchstabe: null, seite: null })} class={filter.letter ? '' : 'on'}>
            Alle
          </a>
          {keys.map((l) => (
            <a href={url({ buchstabe: l, seite: null })} class={filter.letter === l ? 'on' : ''}>
              {l}
            </a>
          ))}
        </div>
        <div class="list sites" style="margin-top:12px">
          {rows.map((s) => (
            <div class="row" style={s.active ? '' : 'opacity:.6'}>
              <span class="no">{s.site_no}</span>
              <div class="main">
                <a href={`/objekte/${s.id}`}>
                  <b style="color:var(--ink)">{s.name}</b>
                </a>
                {!s.active && (
                  <span class="badge" style="margin-left:6px">
                    inaktiv
                  </span>
                )}
                <div class="small mut">
                  {[s.street, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                </div>
              </div>
              <div class="cust">
                <a href={`/kunden/${s.customer_id}`} style="color:var(--ink)">
                  {s.customer_name}
                </a>
                <div class="small faint">Kd.-Nr. {s.customer_no}</div>
              </div>
              <div class="ol">
                {s.manager_name ? (
                  <span class="person-chip">
                    <span class="av">{initials(s.manager_name)}</span>
                    {s.manager_name}
                  </span>
                ) : (
                  <span class="small faint">keine Objektleitung</span>
                )}
                <div class="small faint">{s.employees} Mitarbeitende</div>
              </div>
            </div>
          ))}
          {!rows.length && (
            <div class="row">
              <div class="main mut">Keine Objekte gefunden.</div>
            </div>
          )}
        </div>
        {pages > 1 && (
          <div class="pager">
            {page > 1 && <a href={url({ seite: String(page - 1) })}>‹ Zurück</a>}
            {Array.from({ length: pages }, (_, i) => i + 1)
              .filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 2)
              .map((n, i, arr) => (
                <>
                  {i > 0 && n - arr[i - 1]! > 1 && <span class="gap">…</span>}
                  <a href={url({ seite: n > 1 ? String(n) : null })} class={n === page ? 'on' : ''}>
                    {n}
                  </a>
                </>
              ))}
            {page < pages && <a href={url({ seite: String(page + 1) })}>Vor ›</a>}
          </div>
        )}
      </div>
    </>
  );
};

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
    { key: 'rechnungsangaben', label: 'Rechnungsangaben', href: `${base}/rechnungsangaben` },
  ];
  const more: Tab[] = [
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: counts.tasks },
    { key: 'bearbeiten', label: 'Objekt bearbeiten', href: `${base}/bearbeiten` },
    { key: 'einsaetze', label: 'Einsatzplan', href: `${base}/einsaetze` },
    { key: 'zeiten', label: 'Erfasste Zeiten', href: `${base}/zeiten` },
    { key: 'qr', label: 'QR-Aushang Zeiterfassung', href: `${base}/qr` },
    { key: 'arbeitsscheine', label: 'Arbeitsscheine', href: `${base}/arbeitsscheine` },
    { key: 'x-schluessel', label: 'Schlüssel', href: '/schluessel' },
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

export const SiteForm: FC<{
  id: string;
  s: Partial<Site>;
  customers: Customer[];
  isNew: boolean;
  managers?: { id: string; name: string }[];
}> = ({ id, s, customers, isNew, managers }) => (
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
      {managers && (
        <div>
          <label for="manager_user_id">Objektleitung</label>
          <select id="manager_user_id" name="manager_user_id">
            <option value="">– keine –</option>
            {managers.map((m) => (
              <option value={m.id} selected={m.id === s.manager_user_id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
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

// ---------------------------------------------------------------------------
// Objekt: Rechnungsangaben („wie Kunde“ oder abweichend)
// ---------------------------------------------------------------------------

const BILL_JS = `
(function(){
  var f=document.getElementById('billing'); if(!f) return;
  var own=f.querySelector('#bm-eigen'), box=document.getElementById('bill-own'), cust=document.getElementById('bill-cust');
  function show(){ box.hidden=!own.checked; cust.hidden=own.checked; }
  function take(){ var d=JSON.parse(f.dataset.customer); Object.keys(d).forEach(function(k){ var el=f.querySelector('[name='+k+']'); if(!el) return; if(el.type==='checkbox') el.checked=!!d[k]; else el.value=d[k]==null?'':d[k]; }); sk(); }
  function sk(){ var c=f.querySelector('[name=bill_skonto_custom]'); document.getElementById('bill-skonto').hidden=!c.checked; }
  f.querySelectorAll('[name=billing_mode]').forEach(function(r){ r.addEventListener('change',function(){ show(); if(own.checked && !f.querySelector('[name=bill_name]').value) take(); }); });
  document.getElementById('bill-take').addEventListener('click',function(){ if(confirm('Felder mit den Rechnungsangaben des Kunden füllen?')) take(); });
  f.querySelector('[name=bill_skonto_custom]').addEventListener('change',sk);
  show(); sk();
})();`;

export const SiteBillingForm: FC<{
  site: Site & SiteBilling;
  customer: Customer;
  eff: EffectiveBilling;
}> = ({ site, customer: c, eff }) => {
  const own = site.billing_mode === 'eigen';
  const custData = {
    bill_name: c.name,
    bill_name2: c.name2 ?? '',
    bill_street: c.street,
    bill_postal_code: c.postal_code,
    bill_city: c.city,
    bill_contact_name: c.contact_name ?? '',
    bill_emails: c.invoice_emails.join(', '),
    bill_format: c.invoice_format,
    bill_leitweg_id: c.leitweg_id ?? '',
    bill_supplier_no: c.supplier_no ?? '',
    bill_payment_terms_days: String(c.payment_terms_days),
    bill_skonto_custom: false,
    bill_skonto_percent_bp: c.skonto_percent_bp ? String(c.skonto_percent_bp / 100).replace('.', ',') : '',
    bill_skonto_days: c.skonto_days ? String(c.skonto_days) : '',
  };
  const v = (k: keyof SiteBilling) => (own ? ((site[k] as string | number | null) ?? '') : '');
  return (
    <div class="cols">
      <form
        method="post"
        action={`/objekte/${site.id}/rechnungsangaben`}
        class="card"
        id="billing"
        data-customer={JSON.stringify(custData)}
        data-autosave
        data-version={String(site.version)}
      >
        <input type="hidden" name="version" value={String(site.version)} />
        <h3>Rechnungen für dieses Objekt</h3>
        <label class="chk" style="margin:0 0 6px">
          <input type="radio" name="billing_mode" value="kunde" id="bm-kunde" checked={!own} /> wie Kunde
          <span class="small faint">– alle Angaben vom Kunden {c.name}</span>
        </label>
        <label class="chk" style="margin:0">
          <input type="radio" name="billing_mode" value="eigen" id="bm-eigen" checked={own} /> abweichend für
          dieses Objekt
          <span class="small faint">– z. B. andere Rechnungsadresse, andere E-Mail, eigene Leitweg-ID</span>
        </label>

        <div id="bill-cust" class="hint" style="margin-top:16px" hidden={own}>
          Es gelten die Rechnungsangaben des Kunden.{' '}
          <a href={`/kunden/${c.id}/bearbeiten`}>Beim Kunden ändern</a>
        </div>

        <div id="bill-own" hidden={!own}>
          <div class="actions" style="margin:16px 0 4px">
            <button type="button" class="btn sec sm" id="bill-take">
              Angaben vom Kunden übernehmen
            </button>
            <span class="small faint">Leere Felder gelten automatisch wie beim Kunden.</span>
          </div>
          <div class="group-title">Rechnungsadresse</div>
          <div class="grid">
            <Field name="bill_name" label="Name / Firma" value={v('bill_name')} />
            <Field name="bill_name2" label="Zusatz (z. B. Abteilung)" value={v('bill_name2')} />
            <Field name="bill_street" label="Straße" value={v('bill_street')} />
            <Field name="bill_postal_code" label="PLZ" value={v('bill_postal_code')} />
            <Field name="bill_city" label="Ort" value={v('bill_city')} />
            <Field name="bill_contact_name" label="Ansprechpartner" value={v('bill_contact_name')} />
          </div>
          <div class="group-title">Versand und E-Rechnung</div>
          <div class="grid">
            <div>
              <label for="bill_emails">Rechnungs-E-Mails (mehrere mit Komma)</label>
              <input
                id="bill_emails"
                name="bill_emails"
                value={own ? (site.bill_emails ?? []).join(', ') : ''}
              />
            </div>
            <div>
              <label for="bill_format">Rechnungsformat</label>
              <select id="bill_format" name="bill_format">
                <option value="">wie Kunde ({FORMAT_LABEL[c.invoice_format]})</option>
                {(['pdf', 'zugferd', 'xrechnung'] as const).map((f) => (
                  <option value={f} selected={own && site.bill_format === f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
            </div>
            <Field name="bill_leitweg_id" label="Leitweg-ID" value={v('bill_leitweg_id')} />
            <Field
              name="bill_supplier_no"
              label="Unsere Lieferantennummer beim Kunden"
              value={v('bill_supplier_no')}
            />
          </div>
          <div class="group-title">Zahlung</div>
          <div class="grid">
            <Field
              name="bill_payment_terms_days"
              label={`Zahlungsziel in Tagen (Kunde: ${c.payment_terms_days})`}
              value={v('bill_payment_terms_days')}
              type="number"
            />
            <div class="chk" style="align-self:end;margin-bottom:10px">
              <input
                type="checkbox"
                id="bill_skonto_custom"
                name="bill_skonto_custom"
                checked={own && site.bill_skonto_custom}
              />
              <label for="bill_skonto_custom">eigenes Skonto für dieses Objekt</label>
            </div>
          </div>
          <div class="grid" id="bill-skonto" style="margin-top:12px">
            <Field
              name="bill_skonto_percent_bp"
              label="Skonto % (leer = kein Skonto)"
              value={
                own && site.bill_skonto_percent_bp
                  ? String(site.bill_skonto_percent_bp / 100).replace('.', ',')
                  : ''
              }
            />
            <Field name="bill_skonto_days" label="Skonto-Tage" value={v('bill_skonto_days')} type="number" />
          </div>
        </div>
        <div class="formfoot">
          <button class="btn">Speichern</button>
        </div>
        <script dangerouslySetInnerHTML={{ __html: BILL_JS }} />
      </form>

      <div class="card">
        <h3>So geht die Rechnung raus</h3>
        <p class="small mut" style="margin-top:0">
          {eff.source === 'objekt' ? 'Abweichende Angaben dieses Objekts' : 'Angaben des Kunden'} (Stand
          gespeichert)
        </p>
        <div style="line-height:1.6">
          <b>{eff.name}</b>
          {eff.name2 && <div>{eff.name2}</div>}
          <div>{eff.street}</div>
          <div>
            {eff.postalCode} {eff.city}
          </div>
          {eff.contactName && <div class="small mut">z. Hd. {eff.contactName}</div>}
        </div>
        <dl class="kv" style="margin-top:14px">
          <dt>Format</dt>
          <dd>{FORMAT_LABEL[eff.format]}</dd>
          <dt>E-Mail an</dt>
          <dd>
            {eff.emails.length ? eff.emails.join(', ') : <span style="color:var(--err)">keine Adresse</span>}
          </dd>
          {eff.leitwegId && (
            <>
              <dt>Leitweg-ID</dt>
              <dd>{eff.leitwegId}</dd>
            </>
          )}
          {eff.supplierNo && (
            <>
              <dt>Lieferanten-Nr.</dt>
              <dd>{eff.supplierNo}</dd>
            </>
          )}
          <dt>Zahlungsziel</dt>
          <dd>{eff.paymentTermsDays} Tage</dd>
          <dt>Skonto</dt>
          <dd>
            {eff.skonto
              ? `${String(eff.skonto.percentBp / 100).replace('.', ',')} % in ${eff.skonto.days} Tagen`
              : 'kein Skonto'}
          </dd>
          {site.order_reference && (
            <>
              <dt>Bestellnummer</dt>
              <dd>{site.order_reference}</dd>
            </>
          )}
        </dl>
        <p class="small faint">
          Gilt für neue Rechnungen dieses Objekts. Bereits ausgestellte Rechnungen bleiben unverändert.
          Sammelrechnungen (Rechnungsgruppen) gehen an die Angaben des Kunden.
        </p>
      </div>
    </div>
  );
};

/** Kunde: nur die Objekte zeigen, deren Rechnungsangaben abweichen (alle anderen = wie Kunde). */
export const BillingDeviations: FC<{ c: Customer; sites: (Site & SiteBilling)[] }> = ({ c, sites }) => {
  const own = sites.filter((s) => s.billing_mode === 'eigen');
  const diffs = (s: Site & SiteBilling) => {
    const e = resolveBilling(c, s);
    const d: string[] = [];
    if (s.bill_name) d.push(`Adresse: ${e.name}, ${e.city}`);
    if (e.emails.join() !== c.invoice_emails.join()) d.push(`E-Mail: ${e.emails.join(', ')}`);
    if (e.format !== c.invoice_format) d.push(`Format: ${FORMAT_LABEL[e.format]}`);
    if (e.leitwegId !== c.leitweg_id) d.push(`Leitweg-ID: ${e.leitwegId ?? '–'}`);
    if (e.supplierNo !== c.supplier_no) d.push(`Lieferanten-Nr.: ${e.supplierNo ?? '–'}`);
    if (e.paymentTermsDays !== c.payment_terms_days) d.push(`Zahlungsziel: ${e.paymentTermsDays} Tage`);
    if (s.bill_skonto_custom)
      d.push(e.skonto ? `Skonto: ${e.skonto.percentBp / 100} % / ${e.skonto.days} T.` : 'kein Skonto');
    if (s.bill_contact_name && s.bill_contact_name !== c.contact_name)
      d.push(`z. Hd. ${s.bill_contact_name}`);
    return d;
  };
  return (
    <div class="card">
      <h3>Rechnungsangaben der Objekte</h3>
      <p class="small mut" style="margin-top:0">
        {sites.length - own.length} von {sites.length} Objekten wie Kunde
        {own.length ? ` · ${own.length} abweichend:` : '.'}
      </p>
      {own.map((s) => (
        <div style="padding:10px 0;border-top:1px solid var(--line)">
          <a href={`/objekte/${s.id}/rechnungsangaben`}>
            <b>{s.name}</b>
          </a>{' '}
          <span class="small faint">{s.site_no}</span>
          {diffs(s).map((t) => (
            <div class="small mut">{t}</div>
          ))}
          {!diffs(s).length && <div class="small faint">abweichend gewählt, aber alle Felder wie Kunde</div>}
        </div>
      ))}
    </div>
  );
};
