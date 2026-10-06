import type { FC } from 'hono/jsx';
import type { Contact, Task } from '../services/crm.js';
import type { CustomerBalance } from '../services/payments.js';
import type { SearchHit } from '../services/search.js';
import { Field } from './pages-masterdata.js';
import { NEW_OPTIONS, PageHead, dateDe, euro, initials } from './layout.js';
import { InvoiceTable } from './pages-invoices.js';

// ---------------------------------------------------------------------------
// Kontakte
// ---------------------------------------------------------------------------

export const ContactsPanel: FC<{
  customerId: string;
  contacts: Contact[];
  edit: Contact | null;
  newId: string;
}> = ({ customerId, contacts, edit, newId }) => {
  const id = edit?.id ?? newId;
  const c: Partial<Contact> = edit ?? {};
  return (
    <>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Funktion</th>
              <th>E-Mail</th>
              <th>Telefon</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 && (
              <tr>
                <td colspan={5} class="mut">
                  Noch keine Kontakte.
                </td>
              </tr>
            )}
            {contacts.map((k) => (
              <tr>
                <td>
                  <b>{[k.salutation, k.first_name, k.last_name].filter(Boolean).join(' ')}</b>
                  {k.invoice_recipient && <div class="small mut">erhält Rechnungen</div>}
                </td>
                <td>{k.position ?? ''}</td>
                <td>{k.email ? <a href={`mailto:${k.email}`}>{k.email}</a> : ''}</td>
                <td>
                  {k.phone && <div>{k.phone}</div>}
                  {k.mobile && <div class="small">mobil {k.mobile}</div>}
                </td>
                <td class="r">
                  <a class="btn sm sec" href={`/kunden/${customerId}/kontakte?bearbeiten=${k.id}`}>
                    Bearbeiten
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        method="post"
        action={`/kunden/${customerId}/kontakte/${id}`}
        class="card"
        style="margin-top:14px"
        data-autosave={`/kunden/${customerId}/kontakte/${edit ? id : 'neu'}`}
        data-version={String(c.version ?? '')}
      >
        <h3>{edit ? 'Kontakt bearbeiten' : 'Kontakt hinzufügen'}</h3>
        <input type="hidden" name="version" value={String(c.version ?? '')} />
        <div class="grid">
          <div>
            <label for="salutation">Anrede</label>
            <select id="salutation" name="salutation">
              {['', 'Frau', 'Herr', 'Divers'].map((a) => (
                <option value={a} selected={(c.salutation ?? '') === a}>
                  {a || '–'}
                </option>
              ))}
            </select>
          </div>
          <Field name="first_name" label="Vorname" value={c.first_name} />
          <Field name="last_name" label="Nachname *" value={c.last_name} required />
          <Field name="position" label="Funktion / Abteilung" value={c.position} />
          <Field name="email" label="E-Mail" type="email" value={c.email} />
          <Field name="phone" label="Telefon" value={c.phone} />
          <Field name="mobile" label="Mobil" value={c.mobile} />
          <div class="chk" style="align-self:end">
            <input
              type="checkbox"
              id="invoice_recipient"
              name="invoice_recipient"
              checked={!!c.invoice_recipient}
            />
            <label for="invoice_recipient" style="margin:0">
              Rechnungsempfänger
            </label>
          </div>
        </div>
        <div style="margin-top:10px">
          <label for="cnotes">Notiz</label>
          <textarea id="cnotes" name="notes">
            {c.notes ?? ''}
          </textarea>
        </div>
        <div class="actions">
          <button class="btn">{edit ? 'Speichern' : 'Kontakt anlegen'}</button>
          {edit && (
            <a class="btn sec" href={`/kunden/${customerId}/kontakte`}>
              Abbrechen
            </a>
          )}
        </div>
      </form>
      {edit && (
        <form
          method="post"
          action={`/kunden/${customerId}/kontakte/${edit.id}/loeschen`}
          onsubmit="return confirm('Kontakt löschen?')"
        >
          <button class="btn danger sm">Kontakt löschen</button>
        </form>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Aufgaben
// ---------------------------------------------------------------------------

export const TaskBox: FC<{ tasks: Task[]; title?: string; doneLink?: string }> = ({
  tasks,
  title,
  doneLink,
}) => (
  <div>
    <h2 style="margin-top:0">
      {title ?? 'Aufgaben'} <span class="cnt">({tasks.length})</span>
    </h2>
    {tasks.length === 0 ? (
      <div class="empty">
        Derzeit keine Aufgaben. {doneLink && <a href={doneLink}>Liste der erledigten Aufgaben →</a>}
      </div>
    ) : (
      <div class="tbl">
        <table>
          <tbody>
            {tasks.map((t) => (
              <tr>
                <td style="width:40px">
                  <form method="post" action={`/aufgaben/${t.id}/erledigt`}>
                    <input type="hidden" name="done" value={t.status === 'open' ? '1' : '0'} />
                    <button class="btn sm sec" title={t.status === 'open' ? 'Erledigt' : 'Wieder öffnen'}>
                      {t.status === 'open' ? '✓' : '↺'}
                    </button>
                  </form>
                </td>
                <td style={t.status === 'done' ? 'text-decoration:line-through;color:var(--mut)' : ''}>
                  <b>{t.title}</b>
                  {t.description && <div class="small">{t.description}</div>}
                  {t.entity_label && (
                    <div class="small mut">
                      {t.entity_type === 'tender' ? (
                        <a href={`/ausschreibungen/${t.entity_id}`}>{t.entity_label}</a>
                      ) : (
                        t.entity_label
                      )}
                    </div>
                  )}
                </td>
                <td class="r small">
                  {t.due_date ? (
                    <span
                      style={
                        t.status === 'open' && t.due_date < new Date().toISOString().slice(0, 10)
                          ? 'color:var(--err);font-weight:700'
                          : ''
                      }
                    >
                      {dateDe(t.due_date)}
                    </span>
                  ) : (
                    ''
                  )}
                  {t.assignee && <div class="mut">{t.assignee}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

export const TaskForm: FC<{
  newId: string;
  entity?: { type: string; id: string; label: string } | null;
  back: string;
  users?: { name: string; group: 'Büro' | 'Objektleitung' }[];
  /** Vorbelegung, z. B. aus einer Notiz („+ Aufgabe hinzufügen“) */
  title?: string | undefined;
}> = ({ newId, entity, back, users, title }) => (
  <form method="post" action="/aufgaben" class="card" data-autosave={`/aufgaben#${entity?.id ?? 'neu'}`}>
    <h3>Neue Aufgabe{entity ? ` für ${entity.label}` : ''}</h3>
    <input type="hidden" name="id" value={newId} />
    <input type="hidden" name="back" value={back} />
    {entity && (
      <>
        <input type="hidden" name="entity_type" value={entity.type} />
        <input type="hidden" name="entity_id" value={entity.id} />
      </>
    )}
    <div class="grid">
      <Field name="title" label="Was ist zu tun? *" required value={title} />
      <Field name="due_date" label="Fällig am" type="date" />
      {users ? (
        <div>
          <label for="assignee">Zuständig</label>
          <select id="assignee" name="assignee">
            <option value="">– niemand Bestimmtes –</option>
            {(['Büro', 'Objektleitung'] as const).map((g) => (
              <optgroup label={g}>
                {users
                  .filter((u) => u.group === g)
                  .map((u) => (
                    <option value={u.name}>{u.name}</option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      ) : (
        <Field name="assignee" label="Zuständig" />
      )}
      <div>
        <label for="description">Beschreibung</label>
        <textarea id="description" name="description" />
      </div>
    </div>
    <div class="actions">
      <button class="btn">Aufgabe anlegen</button>
    </div>
  </form>
);

// ---------------------------------------------------------------------------
// Startseite (Aufbau wie Fortytools-Übersicht)
// ---------------------------------------------------------------------------

export interface DashboardTodo {
  deadlines: {
    id: string;
    title: string;
    kind: string;
    authority: string;
    at: Date;
    days_left: number;
    required: boolean;
  }[];
  reorder: { id: string; name: string }[];
  followups: {
    due: { id: string; company: string; followup_on: string }[];
    week: { id: string; company: string; followup_on: string }[];
  };
  suppliers: { id: string; name: string }[];
  devices: { id: string; name: string; next_inspection: string | null }[];
  proposals: number;
  unsentDunnings: number;
}

export const Dashboard: FC<{
  user: string;
  tasks: Task[];
  drafts: Parameters<typeof InvoiceTable>[0]['rows'];
  balances: CustomerBalance[];
  unsent: { invoices: number; corrections: number };
  hr: {
    birthdays: { id: string; name: string; birth_date: string; age: number }[];
    jubilees: { id: string; name: string; entry_date: string; years: number }[];
    permits: { id: string; name: string; residence_permit_until: string }[];
  };
  month: string;
  todo: DashboardTodo;
}> = ({ user, tasks, drafts, balances, unsent, hr, month, todo }) => {
  const total = balances.reduce((s, b) => s + b.open_cents, 0n);
  return (
    <>
      <PageHead title={`Übersicht – ${user}`} create={{ options: NEW_OPTIONS, selected: 'rechnung' }} />
      <div class="cols">
        <div>
          {todo.deadlines.length > 0 && (
            <div class="card">
              <h2 style="margin-top:0">
                Ausschreibungen <span class="cnt">(Termine 14 Tage)</span>
              </h2>
              {todo.deadlines.map((o) => (
                <div class="person" style="justify-content:space-between">
                  <div>
                    <b>{o.kind}</b>
                    {o.kind === 'Ortsbesichtigung' && o.required && (
                      <span class="small" style="color:var(--err)">
                        {' '}
                        (Pflicht)
                      </span>
                    )}{' '}
                    · <a href={`/ausschreibungen/${o.id}`}>{o.title}</a>
                    <div class="small mut">
                      {o.authority} ·{' '}
                      {o.at.toLocaleString('de-DE', {
                        timeZone: 'Europe/Berlin',
                        weekday: 'short',
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      Uhr
                    </div>
                  </div>
                  <span class={`badge ${o.days_left <= 2 ? 'err' : o.days_left <= 7 ? 'warn' : ''}`}>
                    {o.days_left === 0 ? 'heute' : o.days_left === 1 ? 'morgen' : `noch ${o.days_left} T.`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {todo.followups.due.length + todo.followups.week.length > 0 && (
            <div class="card">
              <h2 style="margin-top:0">
                Akquise <span class="cnt">(Wiedervorlagen)</span>
              </h2>
              {todo.followups.due.length > 0 && (
                <p style="margin:0 0 6px">
                  <a href="/akquise?filter=due">
                    <b>
                      {todo.followups.due.length} Wiedervorlage{todo.followups.due.length === 1 ? '' : 'n'}{' '}
                      heute fällig
                    </b>
                  </a>
                  <span class="small mut">
                    {' '}
                    ·{' '}
                    {todo.followups.due
                      .slice(0, 3)
                      .map((f) => f.company)
                      .join(', ')}
                    {todo.followups.due.length > 3 ? ` +${todo.followups.due.length - 3}` : ''}
                  </span>
                </p>
              )}
              {todo.followups.week.length > 0 && (
                <p class="small" style="margin:0">
                  {todo.followups.week.length} diese Woche:{' '}
                  {todo.followups.week.slice(0, 4).map((f, i) => (
                    <>
                      {i > 0 && ', '}
                      <a href={`/akquise/${f.id}`}>{f.company}</a> · {dateDe(f.followup_on)}
                    </>
                  ))}
                </p>
              )}
            </div>
          )}
          <div class="card">
            <TaskBox tasks={tasks} title="Aufgaben (7 Tage)" doneLink="/aufgaben?status=done" />
          </div>
          {hr.permits.length > 0 && (
            <div class="warnbox" style="margin-bottom:16px">
              <h3>Aufenthaltserlaubnis</h3>
              <p style="margin:0 0 8px">
                Für {hr.permits.length} Mitarbeitende läuft die Aufenthaltserlaubnis in den nächsten 60 Tagen
                ab (oder ist abgelaufen).
              </p>
              {hr.permits.map((p) => (
                <div>
                  <a href={`/personal/${p.id}`}>{p.name}</a> – bis {dateDe(p.residence_permit_until)}
                </div>
              ))}
            </div>
          )}
          {(todo.reorder.length > 0 || todo.suppliers.length > 0 || todo.devices.length > 0) && (
            <div class="card">
              <h2 style="margin-top:0">Hinweise</h2>
              {todo.reorder.length > 0 && (
                <div style="margin-bottom:8px">
                  <b>Nachbestellen:</b>{' '}
                  {todo.reorder.map((a, i) => (
                    <>
                      {i > 0 && ', '}
                      <a href={`/artikel/${a.id}`}>{a.name}</a>
                    </>
                  ))}{' '}
                  <a class="small" href="/artikel?ansicht=nachbestellen">
                    → Liste
                  </a>
                </div>
              )}
              {todo.suppliers.length > 0 && (
                <div style="margin-bottom:8px">
                  <b>Nachunternehmer-Nachweise laufen ab / fehlen:</b>{' '}
                  {todo.suppliers.map((x, i) => (
                    <>
                      {i > 0 && ', '}
                      <a href={`/lieferanten/${x.id}`}>{x.name}</a>
                    </>
                  ))}
                </div>
              )}
              {todo.devices.length > 0 && (
                <div>
                  <b>Geräteprüfung fällig:</b>{' '}
                  {todo.devices.map((d, i) => (
                    <>
                      {i > 0 && ', '}
                      <a href={`/geraete/${d.id}/bearbeiten`}>{d.name}</a> ({dateDe(d.next_inspection)})
                    </>
                  ))}
                </div>
              )}
            </div>
          )}
          <div class="card">
            <h2 style="margin-top:0">
              Rechnungsentwürfe <span class="cnt">({drafts.length})</span>
            </h2>
            <InvoiceTable rows={drafts.slice(0, 8)} />
            <div class="actions" style="margin-bottom:0">
              <a href="/rechnungen/entwuerfe">Alle Entwürfe / Monatslauf →</a>
            </div>
          </div>
          <form method="post" action="/monatslauf" class="card">
            <h3>Monatslauf</h3>
            <p class="mut small" style="margin:0 0 10px">
              Erzeugt je aktivem Objekt einen Rechnungsentwurf aus den Monatspauschalen. Mehrfaches Ausführen
              erzeugt keine Dubletten.
            </p>
            <div class="actions" style="margin:0">
              <input type="month" name="month" value={month} style="max-width:200px" required />
              <button class="btn">Entwürfe erstellen</button>
            </div>
          </form>
        </div>
        <div>
          <div class="card">
            <h2 style="margin-top:0">Offene Posten</h2>
            {balances.length === 0 ? (
              <div class="empty">Keine offenen Posten.</div>
            ) : (
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Kunde</th>
                      <th class="r" title="Tage über Fälligkeit">
                        Verzug
                      </th>
                      <th class="r">
                        <span class="sum">{euro(total)}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.map((b) => (
                      <tr>
                        <td>
                          <span class="mut">{b.customer_no}</span>{' '}
                          <a href={`/kunden/${b.customer_id}/offene-posten`}>{b.customer_name}</a>
                        </td>
                        <td class="r" style={b.max_overdue_days > 0 ? 'color:var(--err)' : 'color:var(--ok)'}>
                          {b.max_overdue_days > 0 ? `${b.max_overdue_days} T.` : '–'}
                        </td>
                        <td class="r">
                          <b>{euro(b.open_cents)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div class="card">
            <h2 style="margin-top:0">Noch nicht versendete Dokumente</h2>
            <div class="tbl">
              <table>
                <tbody>
                  <tr>
                    <td style="width:50px">
                      <b>{unsent.invoices}</b>
                    </td>
                    <td>
                      <a href="/rechnungen?filter=unversendet">Rechnungen</a>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <b>{unsent.corrections}</b>
                    </td>
                    <td>
                      <a href="/rechnungen?filter=unversendet">Stornos &amp; Rechnungskorrekturen</a>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <b>{todo.unsentDunnings}</b>
                    </td>
                    <td>
                      <a href="/mahnungen/liste">Mahnungen</a>
                      {todo.proposals > 0 && (
                        <span class="small mut">
                          {' '}
                          · <a href="/mahnungen">{todo.proposals} Mahnvorschläge</a>
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <h2 style="margin-top:0">Geburtstage &amp; Jubiläen</h2>
            {hr.birthdays.length + hr.jubilees.length === 0 && (
              <div class="empty">In den nächsten 14 Tagen keine.</div>
            )}
            {hr.birthdays.length > 0 && <h3>Geburtstage</h3>}
            {hr.birthdays.map((b) => (
              <div class="person">
                <span class="avatar">{initials(b.name)}</span>
                <div>
                  <a href={`/personal/${b.id}`}>{b.name}</a>
                  <div class="small">
                    am {dateDe(b.birth_date).slice(0, 6)} ({b.age} Jahre)
                  </div>
                </div>
              </div>
            ))}
            {hr.jubilees.length > 0 && <h3 style="margin-top:10px">Firmenjubiläen</h3>}
            {hr.jubilees.map((j) => (
              <div class="person">
                <span class="avatar">{initials(j.name)}</span>
                <div>
                  <a href={`/personal/${j.id}`}>{j.name}</a>
                  <div class="small">
                    <b>{j.years} Jahre</b>, Eintritt am {dateDe(j.entry_date)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Suche
// ---------------------------------------------------------------------------

export const SearchResults: FC<{ q: string; hits: SearchHit[] }> = ({ q, hits }) => (
  <>
    <PageHead title={`Suche: „${q}“`} />
    {q.trim().length < 3 && <div class="empty">Bitte mindestens 3 Zeichen eingeben.</div>}
    {q.trim().length >= 3 && hits.length === 0 && <div class="empty">Nichts gefunden.</div>}
    {hits.length > 0 && (
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Art</th>
              <th>Treffer</th>
              <th>Zusatz</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr>
                <td>
                  <span class="badge tag">{h.type}</span>
                </td>
                <td>
                  <a href={h.href}>
                    <b>{h.label}</b>
                  </a>
                </td>
                <td class="mut">{h.sub ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </>
);

// ---------------------------------------------------------------------------
// Geplante Bereiche
// ---------------------------------------------------------------------------

export const PLANNED: Record<string, { title: string; phase: string; text: string }> = {
  angebote: {
    title: 'Angebote',
    phase: 'Phase 3',
    text: 'Angebote mit Positionen aus dem Leistungskatalog, Umwandlung in Auftrag und Rechnung, Nachverfolgung offener Angebote.',
  },
  auftraege: {
    title: 'Aufträge',
    phase: 'Phase 3',
    text: 'Aufträge je Objekt mit Abrechnungstag und Leistungsart; Rechnungsentwürfe „aus Aufträgen erstellen“ wie in Fortytools.',
  },
  mahnungen: {
    title: 'Mahnwesen',
    phase: 'Phase 2 (nächster Schritt)',
    text: 'Zahlungserinnerung und Mahnstufen aus den offenen Posten, Mahngebühren/Verzugszinsen (§ 288 BGB), Versand per E-Mail, Mahnsperre je Kunde.',
  },
  lieferscheine: {
    title: 'Lieferscheine & Arbeitsscheine',
    phase: 'Phase 3',
    text: 'Erfassen, unterschreiben lassen und als Anlage an die Rechnung hängen; Rechnungsentwürfe aus Lieferscheinen.',
  },
  lieferanten: {
    title: 'Lieferanten & Nachunternehmer',
    phase: 'Phase 3',
    text: 'Übernahme aus der alten App: Nachunternehmer, Verträge, Freistellungsbescheinigungen (§ 48b EStG) mit Fristüberwachung.',
  },
  bestellungen: {
    title: 'Bestellungen',
    phase: 'Phase 3',
    text: 'Bestellungen im Format BE-JJJJ-NNNN wie in der alten App, Freigabe, Abgleich mit Rechnungseingang.',
  },
  rechnungseingang: {
    title: 'Rechnungseingang',
    phase: 'Phase 3',
    text: 'Eingangsrechnungen (auch XRechnung/ZUGFeRD lesen), Prüfung gegen Bestellung, Freigabe, Übergabe an Zahlungslauf und DATEV.',
  },
  zahlungslauf: {
    title: 'Zahlungslauf SEPA',
    phase: 'Phase 3',
    text: 'SEPA-Überweisungsdatei (pain.001) für freigegebene Eingangsrechnungen, Skonto-Fristen beachten.',
  },
  zeiterfassung: {
    title: 'Zeiterfassung',
    phase: 'Phase 2',
    text: 'Stempeln per Handy (QR am Objekt), „Soll als Ist“ nur mit Bestätigung, Nachträge mit Freigabe durch Objektleitung, Änderungsprotokoll, Prüfbericht für den Zoll (§ 17 MiLoG). Mitarbeiter-Ansicht mehrsprachig, Login per PIN.',
  },
  urlaub: {
    title: 'Urlaubsanträge',
    phase: 'Phase 2',
    text: 'Mitarbeitende stellen Anträge in der App, Genehmigung/Ablehnung durch Büro oder Objektleitung, Resturlaub.',
  },
  unterschrift: {
    title: 'Digital unterschreiben',
    phase: 'Phase 3',
    text: 'Dokumente digital unterschreiben – ausdrücklich NICHT für Kündigungen (§ 623 BGB) und Befristungen (§ 14 Abs. 4 TzBfG), dort ist Schriftform Pflicht.',
  },
  artikel: {
    title: 'Artikel & Nachbestellung',
    phase: 'Phase 3',
    text: 'Reinigungsmittel und Verbrauchsmaterial mit Mindestbestand und Liste „nachzubestellende Artikel“.',
  },
  geraete: {
    title: 'Geräte',
    phase: 'Phase 3',
    text: 'Maschinen je Objekt, Prüftermine (DGUV V3), Wartung.',
  },
  schluessel: {
    title: 'Schlüssel',
    phase: 'Phase 3',
    text: 'Schlüsselbuch je Objekt: Ausgabe/Rückgabe mit Unterschrift.',
  },
  einsatzplanung: {
    title: 'Einsatzplanung',
    phase: 'Phase 2',
    text: 'Stundenvorgaben je Objekt, Einsätze und Einsatzkalender, Abwesenheiten/Ausnahmen.',
  },
  'soll-ist': {
    title: 'Soll-/Ist-Vergleich',
    phase: 'Phase 2',
    text: 'Geplante gegen erfasste Stunden je Objekt und Monat.',
  },
  sonderdienste: {
    title: 'Glasreinigung / Tiefgarage',
    phase: 'Phase 3',
    text: 'Übernahme der Spezialmodule aus der alten App.',
  },
  datev: {
    title: 'DATEV-Export',
    phase: 'Phase 3',
    text: 'Buchungsstapel (Ausgangsrechnungen, Zahlungen) im DATEV-Format für den Steuerberater, Belegbilder-Link.',
  },
  import: {
    title: 'Import aus Fortytools',
    phase: 'Prototyp Schritt 7',
    text: 'Wartet auf die Exporte (Kunden, Objekte, Rechnungsgruppen/Preise, Beispielrechnungen).',
  },
  nachkalkulation: {
    title: 'Nachkalkulation',
    phase: 'Phase 2',
    text: 'Je Objekt und Monat: Erlös gegen eigene Stunden × Stundensatz, Nachunternehmer und Material.',
  },
  dokumente: {
    title: 'Dokumente / Objektordner',
    phase: 'Phase 3',
    text: 'Dateiablage je Kunde/Objekt (Verträge, Leistungsverzeichnisse, Fotos), Übernahme der Objektordner aus der alten App.',
  },
  raumbuch: {
    title: 'Raumbuch',
    phase: 'Phase 3',
    text: 'Räume, Flächen, Reinigungsintervalle je Objekt – Grundlage für Kalkulation und Leistungsverzeichnis.',
  },
  audit: {
    title: 'Auditanalyse',
    phase: 'Phase 3',
    text: 'Qualitätskontrollen je Objekt (ISO 9001), Mängel und Nachbesserung.',
  },
  firmendaten: {
    title: 'Firmendaten & Einstellungen',
    phase: 'Phase 2',
    text: 'Firmenstamm, Bankverbindungen, Briefpapier, Nummernkreise und Benutzer/Rechte pflegen.',
  },
};

export const PlannedPage: FC<{ key2: string }> = ({ key2 }) => {
  const p = PLANNED[key2] ?? { title: 'Bereich', phase: 'später', text: 'Dieser Bereich ist geplant.' };
  return (
    <>
      <PageHead title={p.title} />
      <div class="card planned">
        <span class="badge tag">geplant · {p.phase}</span>
        <p>{p.text}</p>
        <p class="mut small">
          Der Menüpunkt ist schon da, damit der Aufbau wie in Fortytools vollständig ist.
        </p>
        <a href="/">← Zur Übersicht</a>
      </div>
    </>
  );
};
