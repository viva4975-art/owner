import { randomUUID } from 'node:crypto';
import type { Child, FC } from 'hono/jsx';
import {
  CUSTOMER_STATUS,
  type CustomerFilter,
  type CustomerListRow,
  type CustomerStatus,
  PAGE_SIZE,
} from '../services/customer-list.js';
import { type Customer, type Site, type SiteService, customerStatusOf } from '../services/masterdata.js';
import { type SiteFilter, type SiteListRow, SITE_PAGE_SIZE } from '../services/site-list.js';
import type { InvoiceGroupRow } from '../services/invoice-groups.js';
import { centsToInput } from './forms.js';
import { canAccess } from './permissions.js';
import type { Role } from '../services/users.js';
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
            <span class={`dot ${STATUS_BADGE[k]}`} style="margin-right:6px" />
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

export const CustomerShell: FC<{
  c: Customer;
  counts: CustomerCounts;
  active: string;
  side?: Child;
  aside?: Child;
  children?: Child;
}> = ({ c, counts, active, side, aside, children }) => {
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
      {c.warning && (
        <div class="flash err" style="white-space:pre-line">
          <b>Warnhinweis:</b> {c.warning}
        </div>
      )}
      <div class="entity-layout">
        <aside class="info-col">
          {side}
          {aside}
        </aside>
        <div class="content-col">
          <Tabs tabs={tabs} more={more} active={active} />
          <div class="tabbody">{children}</div>
        </div>
      </div>
    </>
  );
};

const STATUS_CLASS = { kunde: 'ok', interessent: 'warn', ehemalig: 'err' } as const;

export const CustomerCard: FC<{ c: Customer }> = ({ c }) => {
  const st = customerStatusOf(c);
  return (
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
        {c.contact_name && (
          <>
            <dt>Ansprechpartner</dt>
            <dd>{c.contact_name}</dd>
          </>
        )}
        {c.contact_email && (
          <>
            <dt>E-Mail</dt>
            <dd>
              <a href={`mailto:${c.contact_email}`}>{c.contact_email}</a>
            </dd>
          </>
        )}
        {c.contact_phone && (
          <>
            <dt>Telefon</dt>
            <dd>{c.contact_phone}</dd>
          </>
        )}
        {c.vat_id && (
          <>
            <dt>USt-IdNr.</dt>
            <dd>{c.vat_id}</dd>
          </>
        )}
      </dl>
      <div class="actions" style="margin-bottom:0">
        <span class={`badge ${STATUS_CLASS[st]}`}>{CUSTOMER_STATUS[st]}</span>
      </div>
    </div>
  );
};

/** Übersicht beim Kunden: Rechnungsgruppen mit ihren Objekten. */
export const GroupSummary: FC<{ customerId: string; groups: InvoiceGroupRow[] }> = ({
  customerId,
  groups,
}) => (
  <div class="card">
    <div class="actions" style="margin-top:0">
      <h3 style="margin:0">Rechnungsgruppen</h3>
      <a class="btn sm sec" href={`/kunden/${customerId}/rechnungsgruppen`} style="margin-left:auto">
        Verwalten
      </a>
    </div>
    <div class="list" style="margin-bottom:-22px">
      {groups
        .filter((g) => g.active && g.site_ids.length)
        .map((g) => (
          <div class="row">
            <div class="main">
              <a href={`/kunden/${customerId}/rechnungsgruppen?bearbeiten=${g.id}`}>
                <b style="color:var(--ink)">{g.name}</b>
              </a>
              {g.combine && (
                <span class="badge info" style="margin-left:6px">
                  Sammelrechnung
                </span>
              )}
              <div class="small mut">
                {FORMAT_LABEL[g.bill_format]}
                {g.buyer_reference ? ` · ${g.buyer_reference}` : ''} · {g.site_ids.length} Objekt
                {g.site_ids.length === 1 ? '' : 'e'}
              </div>
            </div>
          </div>
        ))}
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

const TextBox: FC<{ name: string; label: string; value: string | null | undefined; hint?: string }> = ({
  name,
  label,
  value,
  hint,
}) => (
  <div>
    <label for={name}>{label}</label>
    <textarea id={name} name={name} rows={2}>
      {value ?? ''}
    </textarea>
    {hint && <div class="help">{hint}</div>}
  </div>
);

export const CustomerForm: FC<{ id: string; c: Partial<Customer>; isNew: boolean }> = ({ id, c, isNew }) => (
  <form
    method="post"
    action={`/kunden/${id}`}
    data-autosave={`/kunden/${id}`}
    data-version={String(c.version ?? '')}
  >
    <input type="hidden" name="version" value={String(c.version ?? '')} />
    <h2 class="form-section">Basisdaten</h2>
    <div class="grid">
      <Field name="customer_no" label="Kundennummer *" value={c.customer_no} required />
      <Field name="name" label="Name *" value={c.name} required />
      <Field name="name2" label="Namenszusatz / Abteilung" value={c.name2} />
      <Field name="street" label="Straße *" value={c.street} required />
      <Field name="postal_code" label="PLZ *" value={c.postal_code} required />
      <Field name="city" label="Ort *" value={c.city} required />
      <div>
        <label for="status">Status</label>
        <select id="status" name="status">
          {(['kunde', 'interessent', 'ehemalig'] as const).map((st) => (
            <option
              value={st}
              selected={(isNew ? (c.status ?? 'kunde') : customerStatusOf(c as Customer)) === st}
            >
              {CUSTOMER_STATUS[st]}
            </option>
          ))}
        </select>
      </div>
    </div>
    <h2 class="form-section">Zusatzinformationen</h2>
    <div class="grid">
      <Field name="vat_id" label="USt-IdNr." value={c.vat_id} />
      <TextBox name="notes" label="Kurzinfo" value={c.notes} />
      <TextBox
        name="billing_hint"
        label="Hinweise zur Rechnungsstellung"
        value={c.billing_hint}
        hint="Wird bei der Rechnungsstellung angezeigt"
      />
      <TextBox
        name="site_notes"
        label="Einsatzort-Notizen"
        value={c.site_notes}
        hint="Diese Notizen werden in der Zeiterfassungs-App für Mitarbeitende angezeigt"
      />
      <TextBox
        name="warning"
        label="Warnhinweis"
        value={c.warning}
        hint="Besonders hervorgehobene Info zu diesem Kunden"
      />
    </div>
    <p class="help" style="margin-top:14px">
      Rechnungseinstellungen (Rechnungsadresse, E-Mails, Format, Leitweg-ID, Zahlungsziel, Skonto) pflegen Sie
      im Reiter „Rechnungsgruppen“, Ansprechpartner im Reiter „Kontakte“.
    </p>
    <div class="formfoot">
      <a class="btn sec" href={isNew ? '/kunden' : `/kunden/${id}`}>
        Abbrechen
      </a>
      <button class="btn">Speichern</button>
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

export interface SiteInfo {
  manager: { name: string; phone: string | null; email: string | null } | null;
  cleaners: number;
  customer: Pick<
    Customer,
    'id' | 'customer_no' | 'name' | 'name2' | 'street' | 'postal_code' | 'city' | 'active' | 'status'
  >;
}

/** Objektseite: links Infospalte (Objekt, Objektleitung, Kunde), rechts Reiter. Reiter nach Rolle gefiltert. */
export const SiteShell: FC<{
  s: Site & { customer_name: string };
  counts: SiteCounts;
  active: string;
  info: SiteInfo;
  role: Role;
  aside?: Child;
  children?: Child;
}> = ({ s, counts, active, info, role, aside, children }) => {
  const base = `/objekte/${s.id}`;
  const all: (Tab & { main?: boolean })[] = [
    { key: 'uebersicht', label: 'Übersicht', href: base, main: true },
    { key: 'notizen', label: 'Notizen', href: `${base}/notizen`, count: counts.notes, main: true },
    {
      key: 'rechnungen',
      label: 'Rechnungen',
      href: `${base}/rechnungen`,
      count: counts.invoices,
      main: true,
    },
    {
      key: 'leistungen',
      label: 'Leistungen & Preise',
      href: `${base}/leistungen`,
      count: counts.services,
      main: true,
    },
    { key: 'einsaetze', label: 'Einsätze', href: `${base}/einsaetze`, main: true },
    { key: 'zeiten', label: 'Erfasste Zeiten', href: `${base}/zeiten`, main: true },
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: counts.tasks },
    { key: 'angebote', label: 'Angebote', href: `${base}/angebote` },
    { key: 'arbeitsscheine', label: 'Arbeitsscheine', href: `${base}/arbeitsscheine` },
    { key: 'dokumente', label: 'Dokumente', href: `${base}/dokumente` },
    { key: 'schluessel', label: 'Schlüssel', href: `${base}/schluessel` },
    { key: 'raumbuch', label: 'Raumbuch', href: `${base}/raumbuch` },
    { key: 'stundenvorgabe', label: 'Stundenvorgabe', href: `${base}/stundenvorgabe` },
    { key: 'qualitaet', label: 'Qualitätskontrolle', href: `${base}/qualitaet` },
    { key: 'qr', label: 'QR-Aushang Zeiterfassung', href: `${base}/qr` },
    { key: 'rechnungsangaben', label: 'Rechnungsangaben', href: `${base}/rechnungsangaben` },
  ];
  const allowed = all.filter((t) => canAccess(role, t.href));
  // Objektleitung: keine Übersicht (enthält Preise) → Einsätze als erster Reiter
  const visible = role === 'objektleitung' ? allowed.filter((t) => t.key !== 'uebersicht') : allowed;
  const tabs = visible.filter((t) => t.main);
  const more = visible.filter((t) => !t.main);
  const c = info.customer;
  const st = customerStatusOf(c as Customer);
  return (
    <>
      <PageHead
        title={`Objekt: ${s.name}`}
        no={s.site_no}
        create={{
          options: [
            ['aufgabe', 'Aufgabe'],
            ['rechnung', 'Rechnung'],
            ['angebot', 'Angebot'],
          ],
          suffix: 'für dieses Objekt',
          context: { objekt: s.id, kunde: s.customer_id },
        }}
      />
      <div class="entity-layout">
        <aside class="info-col">
          <section class="panel side-card">
            {canAccess(role, `${base}/bearbeiten`) && (
              <div class="side-actions">
                <a class="btn sec sm" href={`${base}/bearbeiten`}>
                  Bearbeiten
                </a>
              </div>
            )}
            <div class="addr">
              <b>{s.name}</b>
              {s.street && <div>{s.street}</div>}
              {(s.postal_code || s.city) && (
                <div>
                  {s.postal_code} {s.city}
                </div>
              )}
            </div>
            <dl class="kv small">
              <dt>Objektleitung</dt>
              <dd>
                {info.manager ? (
                  <>
                    {info.manager.name}
                    {info.manager.phone && (
                      <div>
                        <a href={`tel:${info.manager.phone.replace(/\s/g, '')}`}>{info.manager.phone}</a>
                      </div>
                    )}
                  </>
                ) : (
                  <span class="mut">keine</span>
                )}
              </dd>
              <dt>Reinigungskräfte</dt>
              <dd>{info.cleaners} aktiv</dd>
            </dl>
          </section>
          <section class="panel">
            <h3 class="panel-head">Kunde / Verwaltung</h3>
            <div style="margin-top:10px">
              <span class="mut">{c.customer_no}</span>{' '}
              <span class={`tag ${st === 'kunde' ? 'ok' : st === 'interessent' ? 'warn' : 'err'}`}>
                {CUSTOMER_STATUS[st]}
              </span>
            </div>
            <div style="margin-top:4px">
              {canAccess(role, `/kunden/${c.id}`) ? (
                <a href={`/kunden/${c.id}`}>{c.name}</a>
              ) : (
                <b>{c.name}</b>
              )}
              {c.name2 && <div class="small">{c.name2}</div>}
              <div>{c.street}</div>
              <div>
                {c.postal_code} {c.city}
              </div>
            </div>
          </section>
          {aside}
        </aside>
        <div class="content-col">
          <Tabs tabs={tabs} more={more} active={active} />
          <div class="tabbody">{children}</div>
        </div>
      </div>
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
  services: SiteService[];
  employees: { id: string; name: string; phone: string | null }[];
  tasksSlot: Child;
  docsSlot?: Child;
}> = ({ s, services, employees, tasksSlot, docsSlot }) => {
  const kinds = [...new Set(services.filter((x) => x.active).map((x) => x.description))];
  return (
    <div class="main-col">
      {tasksSlot}
      {docsSlot}
      <section>
        <h2 class="panel-title">Aktive Leistungen</h2>
        {kinds.length ? (
          <div class="tbl">
            <table>
              <tbody>
                {kinds.map((k) => (
                  <tr>
                    <td>
                      <a href={`/objekte/${s.id}/leistungen`}>{k}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty-line">Keine aktiven Leistungen.</div>
        )}
      </section>
      <section>
        <h2 class="panel-title">
          Reinigungskräfte <span class="cnt">({employees.length})</span>
        </h2>
        {employees.length ? (
          <div class="tbl">
            <table>
              <tbody>
                {employees.map((e) => (
                  <tr>
                    <td>
                      <a href={`/personal/${e.id}`}>{e.name}</a>
                    </td>
                    <td>{e.phone ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty-line">Noch keine Reinigungskräfte zugeordnet (Zuordnung beim Mitarbeiter).</div>
        )}
      </section>
    </div>
  );
};

export { centsToInput };
