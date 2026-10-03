import type { Child, FC } from 'hono/jsx';
import { EMPLOYMENT_TYPES, type Employee, type EmployeePrivate } from '../services/employees.js';
import { type OpenItem, PAYMENT_METHODS, type PaymentRow } from '../services/payments.js';
import { centsToInput } from './forms.js';
import { NEW_OPTIONS, PageHead, type Tab, Tabs, dateDe, euro, initials } from './layout.js';
import { Field } from './pages-masterdata.js';

// ---------------------------------------------------------------------------
// Personal
// ---------------------------------------------------------------------------

type EmployeeRow = Employee & { residence_permit_until: string | null; site_count: number };

export const EmployeeList: FC<{
  rows: EmployeeRow[];
  status: string;
  q: string | null;
  canExport: boolean;
}> = ({ rows, status, q, canExport }) => (
  <>
    <PageHead title="Mitarbeiter" create={{ options: NEW_OPTIONS, selected: 'mitarbeiter' }} />
    <div class="card">
      <form class="actions" method="get" action="/personal" style="margin-top:0">
        <select name="status" style="max-width:180px">
          {[
            ['aktiv', 'Aktive'],
            ['ausgetreten', 'Ausgetretene'],
            ['alle', 'Alle'],
          ].map(([v, l]) => (
            <option value={v} selected={status === v}>
              {l}
            </option>
          ))}
        </select>
        <input name="q" value={q ?? ''} placeholder="Name oder Personalnummer" style="max-width:280px" />
        <button class="btn sec sm">Filtern</button>
        {canExport && (
          <a class="btn sm" href="/personal/export.csv" style="margin-left:auto">
            Export Lexware Lohn (CSV)
          </a>
        )}
      </form>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Pers.-Nr.</th>
              <th>Name</th>
              <th>Beschäftigung</th>
              <th>Eintritt</th>
              <th class="r">Std./Woche</th>
              <th class="r">Objekte</th>
              <th>Aufenthaltserlaubnis</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colspan={7} class="mut">
                  Keine Mitarbeiter.
                </td>
              </tr>
            )}
            {rows.map((e) => {
              const soon =
                e.residence_permit_until &&
                e.residence_permit_until <= new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
              return (
                <tr>
                  <td>{e.personnel_no}</td>
                  <td>
                    <a href={`/personal/${e.id}`}>
                      <b>
                        {e.last_name}, {e.first_name}
                      </b>
                    </a>
                    {e.status === 'ausgetreten' && <span class="badge"> ausgetreten</span>}
                  </td>
                  <td>{EMPLOYMENT_TYPES[e.employment_type]}</td>
                  <td>{dateDe(e.entry_date)}</td>
                  <td class="r">{e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '–'}</td>
                  <td class="r">{e.site_count}</td>
                  <td style={soon ? 'color:var(--err);font-weight:700' : ''}>
                    {e.residence_permit_until ? dateDe(e.residence_permit_until) : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  </>
);

export const EmployeeShell: FC<{
  e: Employee;
  active: string;
  notes: number;
  tasks: number;
  children?: Child;
}> = ({ e, active, notes, tasks, children }) => {
  const base = `/personal/${e.id}`;
  const tabs: Tab[] = [
    { key: 'uebersicht', label: 'Übersicht', href: base },
    { key: 'bearbeiten', label: 'Stammdaten', href: `${base}/bearbeiten` },
    { key: 'notizen', label: 'Notizen', href: `${base}/notizen`, count: notes },
    { key: 'zeiten', label: 'Zeiten', href: `${base}/zeiten` },
    { key: 'einsaetze', label: 'Einsätze', href: `${base}/einsaetze` },
    { key: 'abwesenheiten', label: 'Urlaub & Krank', href: `${base}/abwesenheiten` },
  ];
  const more: Tab[] = [
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: tasks },
    { key: 'app', label: 'Handy-Zugang (PIN)', href: `${base}/app-zugang` },
    { key: 'x-dokumente', label: 'Dokumente (bald)', href: '/geplant/dokumente' },
  ];
  return (
    <>
      <PageHead
        title={`${e.first_name} ${e.last_name}`}
        no={e.personnel_no}
        create={{
          options: [['aufgabe', 'Aufgabe']],
          suffix: 'für diesen Mitarbeiter',
          context: { mitarbeiter: e.id },
        }}
      />
      <Tabs tabs={tabs} more={more} active={active} />
      <div class="tabbody">{children}</div>
    </>
  );
};

export const EmployeeOverview: FC<{
  e: Employee;
  priv: EmployeePrivate | undefined;
  sites: { id: string; site_no: string; name: string }[];
  showPrivate: boolean;
}> = ({ e, priv, sites, showPrivate }) => (
  <div class="cols">
    <div class="card">
      <div class="person">
        <span class="avatar">{initials(`${e.first_name} ${e.last_name}`)}</span>
        <div>
          <b>
            {e.first_name} {e.last_name}
          </b>
          <div class="small mut">Personalnummer {e.personnel_no}</div>
        </div>
        <span class={`badge ${e.status === 'aktiv' ? 'ok' : ''}`} style="margin-left:auto">
          {e.status === 'aktiv' ? 'Mitarbeiter' : 'ausgetreten'}
        </span>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>Beschäftigung</dt>
        <dd>{EMPLOYMENT_TYPES[e.employment_type]}</dd>
        <dt>Eintritt</dt>
        <dd>{dateDe(e.entry_date)}</dd>
        {e.exit_date && (
          <>
            <dt>Austritt</dt>
            <dd>{dateDe(e.exit_date)}</dd>
          </>
        )}
        <dt>Std./Woche</dt>
        <dd>{e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '–'}</dd>
        <dt>Stundenlohn</dt>
        <dd>{e.hourly_wage_cents != null ? euro(e.hourly_wage_cents) : '–'}</dd>
        <dt>Telefon</dt>
        <dd>{e.phone ?? '–'}</dd>
        <dt>Sprachen</dt>
        <dd>{e.languages.length ? e.languages.join(', ') : '–'}</dd>
      </dl>
    </div>
    <div>
      <div class="card">
        <h3>Objekte</h3>
        {sites.length ? (
          sites.map((s) => (
            <div>
              <a href={`/objekte/${s.id}`}>
                {s.site_no} · {s.name}
              </a>
            </div>
          ))
        ) : (
          <div class="empty">Keinem Objekt zugeordnet.</div>
        )}
      </div>
      {showPrivate && priv && (
        <div class="card">
          <h3>Vertrauliche Daten</h3>
          <dl class="kv">
            <dt>Geburtsdatum</dt>
            <dd>{dateDe(priv.birth_date)}</dd>
            <dt>Staatsangehörigkeit</dt>
            <dd>{priv.nationality ?? '–'}</dd>
            <dt>Aufenthaltserlaubnis bis</dt>
            <dd>{dateDe(priv.residence_permit_until)}</dd>
            <dt>Krankenkasse</dt>
            <dd>{priv.health_insurance ?? '–'}</dd>
          </dl>
          <p class="mut small" style="margin-bottom:0">
            Steuer-ID, SV-Nummer und IBAN nur unter „Stammdaten“.
          </p>
        </div>
      )}
    </div>
  </div>
);

export const EmployeeForm: FC<{
  id: string;
  e: Partial<Employee>;
  priv: Partial<EmployeePrivate>;
  isNew: boolean;
  sites: { id: string; site_no: string; name: string; customer_name: string }[];
  selectedSites: string[];
}> = ({ id, e, priv, isNew, sites, selectedSites }) => (
  <form
    method="post"
    action={`/personal/${id}`}
    data-autosave={`/personal/${id}`}
    data-version={`${e.version ?? ''}/${priv.version ?? ''}`}
  >
    <input type="hidden" name="version" value={String(e.version ?? '')} />
    <input type="hidden" name="private_version" value={String(priv.version ?? '')} />
    <h3>Beschäftigung</h3>
    <div class="grid">
      <Field name="personnel_no" label="Personalnummer *" value={e.personnel_no} required />
      <Field name="first_name" label="Vorname *" value={e.first_name} required />
      <Field name="last_name" label="Nachname *" value={e.last_name} required />
      <div>
        <label for="employment_type">Beschäftigungsart *</label>
        <select id="employment_type" name="employment_type">
          {Object.entries(EMPLOYMENT_TYPES).map(([k, v]) => (
            <option value={k} selected={(e.employment_type ?? 'teilzeit') === k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <Field name="entry_date" label="Eintritt *" type="date" value={e.entry_date} required />
      <Field name="exit_date" label="Austritt" type="date" value={e.exit_date} />
      <Field
        name="weekly_hours"
        label="Stunden/Woche"
        value={e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : ''}
      />
      <Field
        name="hourly_wage"
        label="Stundenlohn (€)"
        value={e.hourly_wage_cents != null ? centsToInput(e.hourly_wage_cents) : ''}
        placeholder="z. B. 14,25"
      />
      <Field name="phone" label="Telefon" value={e.phone} />
      <Field name="email" label="E-Mail" type="email" value={e.email} />
      <Field
        name="languages"
        label="Sprachen (für die App)"
        value={(e.languages ?? []).join(', ')}
        placeholder="z. B. Deutsch, Rumänisch"
      />
    </div>
    <h3 style="margin-top:20px">
      Vertrauliche Daten <span class="mut small">(nur Geschäftsführung/Personal sichtbar)</span>
    </h3>
    <div class="grid">
      <Field name="birth_date" label="Geburtsdatum" type="date" value={priv.birth_date} />
      <Field name="street" label="Straße" value={priv.street} />
      <Field name="postal_code" label="PLZ" value={priv.postal_code} />
      <Field name="city" label="Ort" value={priv.city} />
      <Field name="nationality" label="Staatsangehörigkeit" value={priv.nationality} />
      <Field
        name="residence_permit_until"
        label="Aufenthaltserlaubnis bis"
        type="date"
        value={priv.residence_permit_until}
      />
      <Field name="tax_id" label="Steuer-ID (11 Ziffern)" value={priv.tax_id} />
      <Field name="social_security_no" label="SV-Nummer" value={priv.social_security_no} />
      <Field name="health_insurance" label="Krankenkasse" value={priv.health_insurance} />
      <Field name="iban" label="IBAN" value={priv.iban} />
    </div>
    <h3 style="margin-top:20px">Objekte</h3>
    <div class="grid">
      {sites.map((s) => (
        <div class="chk">
          <input
            type="checkbox"
            id={`site-${s.id}`}
            name="sites"
            value={s.id}
            checked={selectedSites.includes(s.id)}
          />
          <label for={`site-${s.id}`} style="margin:0">
            {s.site_no} · {s.name} <span class="mut small">({s.customer_name})</span>
          </label>
        </div>
      ))}
    </div>
    <div class="actions">
      <button class="btn">Speichern</button>
      <a class="btn sec" href={isNew ? '/personal' : `/personal/${id}`}>
        Abbrechen
      </a>
    </div>
  </form>
);

// ---------------------------------------------------------------------------
// Offene Posten & Zahlungen
// ---------------------------------------------------------------------------

export const OpenItemsTable: FC<{ items: OpenItem[]; showCustomer?: boolean }> = ({
  items,
  showCustomer,
}) => {
  const total = items.reduce((s, i) => s + i.open_cents, 0n);
  return (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Rechnung</th>
            {showCustomer && <th>Kunde</th>}
            <th>Datum</th>
            <th>Fällig</th>
            <th class="r">Soll</th>
            <th class="r">Haben</th>
            <th class="r">
              Saldo <span class="sum">{euro(total)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colspan={7} class="mut">
                Keine offenen Posten.
              </td>
            </tr>
          )}
          {items.map((i) => (
            <tr>
              <td>
                <a href={`/rechnungen/${i.invoice_id}#zahlungen`}>
                  <b>{i.number}</b>
                </a>
                {i.site_name && <div class="small mut">{i.site_name}</div>}
              </td>
              {showCustomer && (
                <td>
                  <span class="mut">{i.customer_no}</span> {i.customer_name}
                </td>
              )}
              <td>{dateDe(i.issue_date)}</td>
              <td style={i.overdue_days > 0 ? 'color:var(--err);font-weight:700' : ''}>
                {dateDe(i.due_date)}
                {i.overdue_days > 0 && <div class="small">{i.overdue_days} Tage überfällig</div>}
              </td>
              <td class="r">{euro(i.payable_cents)}</td>
              <td class="r">
                {i.paid_cents - i.adjustments_cents !== 0n ? euro(i.paid_cents - i.adjustments_cents) : ''}
              </td>
              <td class="r">
                <b>{euro(i.open_cents)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const PaymentsSection: FC<{
  invoiceId: string;
  payments: PaymentRow[];
  open: { open_cents: bigint; skonto_date: string | null } | undefined;
  skontoAmount: bigint | null;
  newId: string;
  today: string;
}> = ({ invoiceId, payments, open, skontoAmount, newId, today }) => (
  <>
    <h2 id="zahlungen">Zahlungen</h2>
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th>Art</th>
            <th>Verwendungszweck / Notiz</th>
            <th class="r">Betrag</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 && (
            <tr>
              <td colspan={5} class="mut">
                Noch keine Zahlungen gebucht.
              </td>
            </tr>
          )}
          {payments.map((p) => (
            <tr style={p.reversed || p.reverses_payment_id ? 'color:var(--mut)' : ''}>
              <td>{dateDe(p.paid_on)}</td>
              <td>{PAYMENT_METHODS[p.method as keyof typeof PAYMENT_METHODS] ?? p.method}</td>
              <td class="small">
                {p.reference ?? ''}
                {p.note && <div>{p.note}</div>}
                <div class="mut">gebucht von {p.created_by}</div>
              </td>
              <td class="r">{euro(p.amount_cents)}</td>
              <td class="r">
                {!p.reversed && !p.reverses_payment_id && (
                  <form
                    method="post"
                    action={`/zahlungen/${p.id}/korrigieren`}
                    onsubmit="return confirm('Zahlung durch Gegenbuchung korrigieren?')"
                  >
                    <button class="btn sm sec">Korrigieren</button>
                  </form>
                )}
                {p.reversed && <span class="small">korrigiert</span>}
              </td>
            </tr>
          ))}
          {open && (
            <tr>
              <td colspan={3}>
                <b>Offen</b>
              </td>
              <td class="r">
                <b>{euro(open.open_cents)}</b>
              </td>
              <td></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
    {open && open.open_cents > 0n && (
      <form
        method="post"
        action={`/rechnungen/${invoiceId}/zahlung`}
        class="card"
        style="margin-top:12px"
        data-autosave={`/rechnungen/${invoiceId}/zahlung`}
      >
        <h3>Zahlungseingang buchen</h3>
        <input type="hidden" name="id" value={newId} />
        <div class="grid">
          <Field name="amount" label="Betrag (€) *" value={centsToInput(open.open_cents)} required />
          <Field name="paid_on" label="Eingang am *" type="date" value={today} required />
          <div>
            <label for="method">Art</label>
            <select id="method" name="method">
              {(['ueberweisung', 'lastschrift', 'bar', 'skonto', 'verrechnung'] as const).map((m) => (
                <option value={m}>{PAYMENT_METHODS[m]}</option>
              ))}
            </select>
          </div>
          <Field name="reference" label="Verwendungszweck" />
        </div>
        {skontoAmount && open.skonto_date && (
          <p class="small mut">
            Skonto bis {dateDe(open.skonto_date)}: {euro(skontoAmount)}. Zahlt der Kunde mit Abzug, den
            Zahlbetrag als Überweisung und den Rest als „Skonto-Abzug“ buchen.
          </p>
        )}
        <div class="actions">
          <button class="btn">Zahlung buchen</button>
        </div>
      </form>
    )}
  </>
);
