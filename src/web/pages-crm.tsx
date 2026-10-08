import type { Child, FC } from 'hono/jsx';
import type { Contact, Task } from '../services/crm.js';
import type { CustomerBalance } from '../services/payments.js';
import type { SearchResult } from '../services/search.js';
import { Field } from './pages-masterdata.js';
import { PageHead, dateDe, euro, initials } from './layout.js';
import { InvoiceTable } from './pages-invoices.js';
import { ABSENCE_LABEL, type AbsentNow } from '../services/absences.js';
import { hourBerlin } from '../domain/invoice/calc.js';

/** „Abwesend“: heute, nächste 7 Tage und 8–14 Tage (Urlaub zwei Wochen vorher sichtbar), mit Art inkl. „krank“. */
export const AbsentCard: FC<{ absent: AbsentNow[]; today: string; href?: string | undefined }> = ({
  absent,
  today,
  href,
}) => {
  const plus = (d: number) => {
    const x = new Date(`${today}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + d);
    return x.toISOString().slice(0, 10);
  };
  const d7 = plus(7);
  const now = absent.filter((a) => a.start_date <= today);
  const week = absent.filter((a) => a.start_date > today && a.start_date <= d7);
  const later = absent.filter((a) => a.start_date > d7);
  const Row = ({ a }: { a: AbsentNow }) => (
    <li>
      <span class="avatar">{initials(a.name)}</span>
      <div class="dl-main">
        {href ? <a href={`/personal/${a.employee_id}/abwesenheiten`}>{a.name}</a> : a.name}
        <div class="dl-sub">
          {ABSENCE_LABEL[a.kind]}
          {a.half_day ? ' (halber Tag)' : ''} ·{' '}
          {a.start_date > today
            ? `${dateDe(a.start_date)} – ${dateDe(a.end_date)}`
            : `bis ${dateDe(a.end_date)}`}
          {a.sites.length ? ` · ${a.sites.slice(0, 2).join(', ')}${a.sites.length > 2 ? ' …' : ''}` : ''}
        </div>
      </div>
      {a.start_date > today && <span class="dl-r">ab {dateDe(a.start_date).slice(0, 6)}</span>}
    </li>
  );
  const Group = ({ title, list, empty }: { title: string; list: AbsentNow[]; empty?: string }) =>
    list.length === 0 && !empty ? null : (
      <>
        <div class="dl-sub" style="margin:10px 0 6px;font-weight:600">
          {title}
          {list.length ? ` (${list.length})` : ''}
        </div>
        {list.length === 0 ? (
          <div class="dash-empty">{empty}</div>
        ) : (
          <ul class="dash-list">
            {list.slice(0, 8).map((a) => (
              <Row a={a} />
            ))}
          </ul>
        )}
        {list.length > 8 && <div class="dash-more">+ {list.length - 8} weitere</div>}
      </>
    );
  return (
    <section class="card dash-card">
      {href ? (
        <DashHead title="Abwesend" count={absent.length} href={href} more="Urlaubskalender" />
      ) : (
        <DashHead title="Abwesend" count={absent.length} />
      )}
      <Group title="Heute" list={now} empty="Heute ist niemand abwesend." />
      <Group title="Nächste 7 Tage" list={week} />
      <Group title="In 8–14 Tagen" list={later} />
    </section>
  );
};

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

/** Karten der Startseite (Reihenfolge/Spalte/Ausblenden je Benutzer, „Übersicht anpassen“). */
export type DashCardKey =
  | 'aufgaben'
  | 'akquise'
  | 'entwuerfe'
  | 'offeneposten'
  | 'unversendet'
  | 'abwesend'
  | 'hinweise'
  | 'ampel'
  | 'geburtstage';
export const DASH_CARDS: Record<DashCardKey, string> = {
  aufgaben: 'Aufgaben (inkl. Ausschreibungs-Termine)',
  akquise: 'Wiedervorlagen Akquise',
  entwuerfe: 'Rechnungsentwürfe & Monatslauf',
  offeneposten: 'Offene Posten',
  unversendet: 'Noch nicht versendet',
  abwesend: 'Abwesend (heute, 7 und 14 Tage)',
  hinweise: 'Hinweise (Fristen, Unterschriften, Prüfungen)',
  ampel: 'Nachkalkulation Vormonat (Ampel je Objekt)',
  geburtstage: 'Geburtstage & Jubiläen',
};
export interface DashItem {
  key: DashCardKey;
  col: 1 | 2;
  hidden: boolean;
}
export const DEFAULT_DASH: DashItem[] = [
  // Offene Posten breit links wie Fortytools (Spalten Tage/Offen/Überfällig/Summe brauchen Platz)
  { key: 'offeneposten', col: 1, hidden: false },
  { key: 'aufgaben', col: 1, hidden: false },
  { key: 'akquise', col: 1, hidden: false },
  { key: 'entwuerfe', col: 2, hidden: false },
  { key: 'unversendet', col: 2, hidden: false },
  { key: 'abwesend', col: 2, hidden: false },
  { key: 'hinweise', col: 2, hidden: false },
  { key: 'ampel', col: 2, hidden: false },
  { key: 'geburtstage', col: 2, hidden: false },
];
/** Gespeichertes Layout prüfen und um neue Karten ergänzen. */
export function normalizeDash(raw: unknown): DashItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DashItem[] = [];
  for (const x of list as Partial<DashItem>[])
    if (x && x.key && x.key in DASH_CARDS && !out.some((o) => o.key === x.key))
      out.push({ key: x.key, col: x.col === 2 ? 2 : 1, hidden: !!x.hidden });
  for (const d of DEFAULT_DASH) if (!out.some((o) => o.key === d.key)) out.push(d);
  return out;
}

export interface DashboardKpi {
  monthNet: bigint;
  prevNet: bigint;
  monthLabel: string;
  today: string;
}

const WEEKDAY_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTH_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const longDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAY_DE[d.getUTCDay()]}, ${d.getUTCDate()}. ${MONTH_DE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const greeting = () => {
  const h = hourBerlin();
  return h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
};

const TASK_HREF: Record<string, string> = {
  customer: '/kunden/',
  site: '/objekte/',
  employee: '/personal/',
  tender: '/ausschreibungen/',
  supplier: '/lieferanten/',
};
const taskHref = (t: Task) =>
  t.entity_type && t.entity_id && TASK_HREF[t.entity_type]
    ? `${TASK_HREF[t.entity_type]}${t.entity_id}`
    : '/aufgaben';

/** Kopf einer Startseiten-Karte: Titel, Anzahl, Link „alle“ */
const DashHead: FC<{ title: string; count?: number | undefined; href?: string; more?: string }> = ({
  title,
  count,
  href,
  more,
}) => (
  <div class="dh">
    <h2>
      {title}
      {count !== undefined && <span class="dh-n">{count}</span>}
    </h2>
    {href && <a href={href}>{more ?? 'Alle anzeigen'} →</a>}
  </div>
);

export const Dashboard: FC<{
  user: string;
  tasks: Task[];
  drafts: Parameters<typeof InvoiceTable>[0]['rows'];
  balances: CustomerBalance[];
  unsent: { invoices: number; corrections: number };
  hr: {
    birthdays: { id: string; name: string; birth_date: string; age: number }[];
    jubilees: { id: string; name: string; entry_date: string; years: number }[];
    permits: { id: string; name: string; residence_permit_until: string; kind?: string }[];
  };
  month: string;
  todo: DashboardTodo;
  kpi: DashboardKpi;
  absent?: AbsentNow[];
  signOverdue?: { id: string; title: string; open: number }[];
  /** Anzahl Mitarbeitende mit fehlenden Pflichtunterlagen (null = Rolle sieht es nicht) */
  missingDocs?: number;
  /** aktive Mitarbeitende ohne laufenden Einsatz (+ Ziel des Hinweises) */
  noShift?: { n: number; href: string };
  reminders?: { n: number; red: number };
  /** Nachkalkulation Vormonat: Ampel je Objekt */
  ampel?: {
    month: string;
    targetBp: number;
    green: number;
    yellow: number;
    red: number;
    worst: {
      site_id: string;
      site_no: string;
      site_name: string;
      margin: bigint;
      margin_bp: number | null;
    }[];
  } | null;
  /** Anfragen aus der App der Objektleitung: NU-Aufträge zur Freigabe, neue Personalbögen */
  appRequests?: { nu: number; bogen: number };
  absentHref?: string | undefined;
  layout?: DashItem[] | undefined;
  showAkquise?: boolean;
}> = ({
  layout,
  showAkquise = true,
  user,
  tasks,
  drafts,
  balances,
  unsent,
  hr,
  month,
  todo,
  kpi,
  absent = [],
  signOverdue = [],
  missingDocs = 0,
  noShift = { n: 0, href: '' },
  reminders = { n: 0, red: 0 },
  ampel = null,
  appRequests = { nu: 0, bogen: 0 },
  absentHref,
}) => {
  const total = balances.reduce((s, b) => s + b.open_cents, 0n);
  const overdue = balances.filter((b) => b.max_overdue_days > 0);
  const overdueTasks = tasks.filter((t) => t.due_date && t.due_date < kpi.today).length;
  const hints: { tone: string; text: Child; href: string }[] = [
    ...(reminders.n
      ? [
          {
            tone: reminders.red ? 'err' : 'warn',
            text: (
              <>
                <b>{reminders.n}</b> Erinnerungen{reminders.red ? `, davon ${reminders.red} dringend` : ''} –
                alle Fristen ansehen
              </>
            ),
            href: '/erinnerungen',
          },
        ]
      : []),
    ...(appRequests.nu
      ? [
          {
            tone: 'warn',
            text: (
              <>
                <b>{appRequests.nu}</b> Nachunternehmer-Auftrag/-Aufträge von der Objektleitung zur Freigabe
              </>
            ),
            href: '/bestellungen',
          },
        ]
      : []),
    ...(appRequests.bogen
      ? [
          {
            tone: 'warn',
            text: (
              <>
                <b>{appRequests.bogen}</b> neue(r) Personalbogen aus der App
              </>
            ),
            href: '/personal/personalboegen',
          },
        ]
      : []),
    ...(missingDocs
      ? [
          {
            tone: 'err',
            text: (
              <>
                Fehlende Pflichtunterlagen bei <b>{missingDocs}</b> Mitarbeitenden
              </>
            ),
            href: '/personal/unterlagen',
          },
        ]
      : []),
    ...(noShift.n
      ? [
          {
            tone: 'warn',
            text: (
              <>
                <b>{noShift.n}</b> aktive Mitarbeitende ohne laufenden Einsatz
              </>
            ),
            href: noShift.href,
          },
        ]
      : []),
    ...hr.permits.map((p) => ({
      tone: p.residence_permit_until < kpi.today ? 'err' : 'warn',
      text: (
        <>
          {p.kind ?? 'Aufenthaltserlaubnis'} <b>{p.name}</b>{' '}
          {p.residence_permit_until < kpi.today ? 'abgelaufen' : 'bis'} {dateDe(p.residence_permit_until)}
        </>
      ),
      href: `/personal/${p.id}`,
    })),
    ...signOverdue.map((d) => ({
      tone: 'err',
      text: (
        <>
          Unterschrift überfällig: <b>{d.title}</b> – {d.open} offen
        </>
      ),
      href: `/personal/dokumente/${d.id}`,
    })),
    ...todo.suppliers.map((x) => ({
      tone: 'warn',
      text: (
        <>
          Nachweise fehlen / laufen ab: <b>{x.name}</b>
        </>
      ),
      href: `/lieferanten/${x.id}`,
    })),
    ...todo.devices.map((d) => ({
      tone: 'info',
      text: (
        <>
          Geräteprüfung <b>{d.name}</b> am {dateDe(d.next_inspection)}
        </>
      ),
      href: `/geraete/${d.id}/bearbeiten`,
    })),
    ...todo.reorder.map((a) => ({
      tone: 'info',
      text: (
        <>
          Nachbestellen: <b>{a.name}</b>
        </>
      ),
      href: `/artikel/${a.id}`,
    })),
  ];
  const people = [
    ...hr.birthdays.map((b) => ({
      id: b.id,
      name: b.name,
      sub: `Geburtstag am ${dateDe(b.birth_date).slice(0, 6)} · ${b.age} Jahre`,
    })),
    ...hr.jubilees.map((j) => ({ id: j.id, name: j.name, sub: `${j.years} Jahre im Unternehmen` })),
  ];
  return (
    <div class="dash">
      <div class="dash-hero">
        <div class="dash-brand">
          <img
            src="/static/logo-transparent.png"
            alt="Viva-Deluxe Gebäudereinigung GmbH"
            width="280"
            height="64"
          />
        </div>
        <div>
          <div class="dash-date">{longDate(kpi.today)}</div>
          <h1>
            {greeting()}, {user}
          </h1>
        </div>
        <div class="dash-quick">
          <a class="btn" href="/neu?typ=rechnung">
            + Rechnung
          </a>
          <a class="btn sec" href="/neu?typ=angebot">
            + Angebot
          </a>
          <a class="btn sec" href="/neu?typ=kunde">
            + Kunde
          </a>
          <a class="btn sec" href="/neu?typ=aufgabe">
            + Aufgabe
          </a>
          <a class="btn ghost sm" href="/startseite/anpassen" title="Karten ein-/ausblenden und anordnen">
            Übersicht anpassen
          </a>
        </div>
      </div>

      {(() => {
        const cards: Record<DashCardKey, Child> = {
          aufgaben: (
            <section class="card dash-card">
              <DashHead
                title="Aufgaben – nächste 7 Tage"
                count={tasks.length}
                href="/aufgaben"
                more="Alle Aufgaben"
              />
              {overdueTasks > 0 && (
                <div class="dash-alert">
                  {overdueTasks} Aufgabe{overdueTasks === 1 ? '' : 'n'} überfällig
                </div>
              )}
              {tasks.length === 0 ? (
                <div class="dash-empty">Keine offenen Aufgaben – alles erledigt.</div>
              ) : (
                <ul class="dash-list">
                  {tasks.slice(0, 7).map((t) => (
                    <li>
                      <form method="post" action={`/aufgaben/${t.id}/erledigt`} class="dl-check">
                        <input type="hidden" name="done" value="1" />
                        <input type="hidden" name="back" value="/" />
                        <button
                          class={`chk-btn ${t.due_date && t.due_date < kpi.today ? 'err' : t.due_date === kpi.today ? 'warn' : ''}`}
                          title="Als erledigt markieren"
                        >
                          ✓
                        </button>
                      </form>
                      <div class="dl-main">
                        <a href={taskHref(t)}>{t.title}</a>
                        <div class="dl-sub">
                          {[t.entity_label, t.assignee].filter(Boolean).join(' · ') || 'ohne Zuordnung'}
                        </div>
                      </div>
                      <span class="dl-r">
                        {t.due_date ? (t.due_date === kpi.today ? 'heute' : dateDe(t.due_date)) : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {todo.deadlines.length > 0 && (
                <>
                  <div class="dl-sub" style="margin:10px 0 4px">
                    Ausschreibungen – Termine (14 Tage)
                  </div>
                  <ul class="dash-list">
                    {todo.deadlines.slice(0, 5).map((o) => (
                      <li>
                        <span class={`dot ${o.days_left <= 2 ? 'err' : o.days_left <= 7 ? 'warn' : ''}`} />
                        <div class="dl-main">
                          <a href={`/ausschreibungen/${o.id}`}>
                            {o.kind}
                            {o.kind === 'Ortsbesichtigung' && o.required ? ' (Pflicht)' : ''}: {o.title}
                          </a>
                          <div class="dl-sub">
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
                        <span class="dl-r">
                          {o.days_left === 0
                            ? 'heute'
                            : o.days_left === 1
                              ? 'morgen'
                              : `in ${o.days_left} T.`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {tasks.length > 7 && (
                <a class="dash-more" href="/aufgaben">
                  + {tasks.length - 7} weitere
                </a>
              )}
            </section>
          ),
          akquise: (
            <section class="card dash-card">
              <DashHead
                title="Wiedervorlagen Akquise"
                count={todo.followups.due.length + todo.followups.week.length}
                href="/akquise"
                more="Akquise"
              />
              {todo.followups.due.length + todo.followups.week.length === 0 ? (
                <div class="dash-empty">Keine Wiedervorlagen in den nächsten 7 Tagen.</div>
              ) : (
                <ul class="dash-list">
                  {todo.followups.due.slice(0, 4).map((f) => (
                    <li>
                      <span class="dot warn" />
                      <div class="dl-main">
                        <a href={`/akquise/${f.id}`}>Wiedervorlage: {f.company}</a>
                        <div class="dl-sub">Akquise</div>
                      </div>
                      <span class="dl-r">{f.followup_on < kpi.today ? 'überfällig' : 'heute'}</span>
                    </li>
                  ))}
                  {todo.followups.week.slice(0, 3).map((f) => (
                    <li>
                      <span class="dot" />
                      <div class="dl-main">
                        <a href={`/akquise/${f.id}`}>Wiedervorlage: {f.company}</a>
                        <div class="dl-sub">Akquise</div>
                      </div>
                      <span class="dl-r">{dateDe(f.followup_on)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {todo.followups.due.length > 4 && (
                <a class="dash-more" href="/akquise?filter=due">
                  + {todo.followups.due.length - 4} weitere Wiedervorlagen fällig
                </a>
              )}
            </section>
          ),
          entwuerfe: (
            <section class="card dash-card">
              <DashHead
                title="Rechnungsentwürfe"
                count={drafts.length}
                href="/rechnungen/entwuerfe"
                more="Vorfaktura"
              />
              {drafts.length === 0 ? (
                <div class="dash-empty">Keine offenen Entwürfe.</div>
              ) : (
                <ul class="dash-list">
                  {drafts.slice(0, 5).map((d) => (
                    <li>
                      <span class="dot" />
                      <div class="dl-main">
                        <a href={`/rechnungen/${d.id}`}>{d.customer_name}</a>
                        <div class="dl-sub">
                          {d.period_start
                            ? `Leistung ab ${dateDe(d.period_start)}`
                            : 'ohne Leistungszeitraum'}
                        </div>
                      </div>
                      <span class="dl-r num">{euro(d.gross_cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <form method="post" action="/monatslauf" class="dash-run">
                <span>Monatslauf</span>
                <input type="month" name="month" value={month} required aria-label="Abrechnungsmonat" />
                <button class="btn sm">Entwürfe erstellen</button>
              </form>
            </section>
          ),
          offeneposten: (
            <section class="card dash-card">
              <DashHead title="Offene Posten" href="/offene-posten" more="Details" />
              {balances.length === 0 ? (
                <div class="dash-empty">Keine offenen Posten.</div>
              ) : (
                <table class="op-table">
                  <thead>
                    <tr>
                      <th>Kunde</th>
                      <th class="r" title="Tage bis zur nächsten Fälligkeit (negativ = überfällig)">
                        Tage
                      </th>
                      <th class="r">Offen</th>
                      <th class="r">Überfällig</th>
                      <th class="r">Summe</th>
                    </tr>
                    <tr class="op-tot">
                      <th></th>
                      <th></th>
                      <th class="r">
                        <span class="pill-ok">{euro(balances.reduce((s, b) => s + b.due_cents, 0n))}</span>
                      </th>
                      <th class="r">
                        <span class="pill-bad">
                          {euro(balances.reduce((s, b) => s + b.overdue_cents, 0n))}
                        </span>
                      </th>
                      <th class="r">
                        <span class="pill-sum">{euro(total)}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...balances]
                      .sort((a, b) => a.customer_name.localeCompare(b.customer_name, 'de'))
                      .map((b) => (
                        <tr>
                          <td title={b.customer_name}>
                            <span class="mut">{b.customer_no}</span>{' '}
                            <a href={`/kunden/${b.customer_id}/offene-posten`}>
                              {b.customer_name.split('\n')[0]}
                            </a>
                          </td>
                          <td class={`r ${b.days < 0 ? 'bad' : 'ok'}`} data-l="Tage">
                            {b.days}
                          </td>
                          <td class="r num" data-l="Offen">
                            {b.due_cents ? euro(b.due_cents) : '–'}
                          </td>
                          <td class="r num" data-l="Überfällig">
                            {b.overdue_cents ? euro(b.overdue_cents) : '–'}
                          </td>
                          <td class="r num" data-l="Summe">
                            <b>{euro(b.open_cents)}</b>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
              {overdue.length > 0 && (
                <div class="dash-more">
                  {overdue.length} Kunde{overdue.length === 1 ? '' : 'n'} im Verzug
                </div>
              )}
              {todo.proposals > 0 && (
                <a class="dash-more" href="/mahnungen">
                  {todo.proposals} Mahnvorschläge ansehen →
                </a>
              )}
            </section>
          ),
          unversendet: (
            <section class="card dash-card">
              <DashHead title="Noch nicht versendet" />
              <ul class="dash-list">
                <li>
                  <span class={`dot ${unsent.invoices ? 'warn' : 'ok'}`} />
                  <div class="dl-main">
                    <a href="/rechnungen?filter=unversendet">Rechnungen</a>
                  </div>
                  <span class="dl-r num">{unsent.invoices}</span>
                </li>
                <li>
                  <span class={`dot ${unsent.corrections ? 'warn' : 'ok'}`} />
                  <div class="dl-main">
                    <a href="/rechnungen?filter=unversendet">Stornos &amp; Rechnungskorrekturen</a>
                  </div>
                  <span class="dl-r num">{unsent.corrections}</span>
                </li>
                <li>
                  <span class={`dot ${todo.unsentDunnings ? 'warn' : 'ok'}`} />
                  <div class="dl-main">
                    <a href="/mahnungen/liste">Mahnungen</a>
                  </div>
                  <span class="dl-r num">{todo.unsentDunnings}</span>
                </li>
              </ul>
            </section>
          ),
          abwesend: <AbsentCard absent={absent} today={kpi.today} href={absentHref} />,
          hinweise: (
            <>
              {hints.length > 0 && (
                <section class="card dash-card">
                  <DashHead title="Hinweise" count={hints.length} />
                  <ul class="dash-list">
                    {hints.slice(0, 6).map((h) => (
                      <li>
                        <span class={`dot ${h.tone}`} />
                        <div class="dl-main">
                          <a href={h.href}>{h.text}</a>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {hints.length > 6 && <div class="dash-more">+ {hints.length - 6} weitere Hinweise</div>}
                </section>
              )}
            </>
          ),
          ampel: ampel ? (
            <section class="card dash-card">
              <DashHead title={`Nachkalkulation ${ampel.month.slice(5)}/${ampel.month.slice(0, 4)}`} />
              <div style="display:flex;gap:8px;margin:4px 0 10px">
                <a class="badge ok" href={`/auswertungen/nachkalkulation?monat=${ampel.month}`}>
                  {ampel.green} ≥ Ziel
                </a>
                <a class="badge warn" href={`/auswertungen/nachkalkulation?monat=${ampel.month}`}>
                  {ampel.yellow} unter Ziel
                </a>
                <a class="badge err" href={`/auswertungen/nachkalkulation?monat=${ampel.month}`}>
                  {ampel.red} Verlust
                </a>
              </div>
              {ampel.worst.length > 0 ? (
                <ul class="dash-list">
                  {ampel.worst.map((w) => (
                    <li>
                      <span class={`badge ${w.margin < 0n ? 'err' : 'warn'}`}>
                        {w.margin_bp == null ? '–' : `${(w.margin_bp / 100).toFixed(0)} %`}
                      </span>
                      <div class="dl-main">
                        <a href={`/objekte/${w.site_id}`}>
                          {w.site_no} · {w.site_name}
                        </a>
                        <div class="dl-sub">Deckungsbeitrag {euro(w.margin)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div class="dash-empty">
                  {ampel.green
                    ? 'Alle Objekte mit Erlös erreichen das Ziel.'
                    : 'Im Monat keine Objekte mit Erlös.'}
                </div>
              )}
            </section>
          ) : null,
          geburtstage: (
            <section class="card dash-card">
              <DashHead title="Geburtstage & Jubiläen" count={people.length || undefined} />
              {people.length === 0 ? (
                <div class="dash-empty">In den nächsten 14 Tagen keine.</div>
              ) : (
                <ul class="dash-list">
                  {people.slice(0, 5).map((p) => (
                    <li>
                      <span class="avatar">{initials(p.name)}</span>
                      <div class="dl-main">
                        <a href={`/personal/${p.id}`}>{p.name}</a>
                        <div class="dl-sub">{p.sub}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {people.length > 5 && <div class="dash-more">+ {people.length - 5} weitere</div>}
            </section>
          ),
        };
        const lay = layout ?? DEFAULT_DASH;
        const col = (n: 1 | 2) =>
          lay
            .filter((x) => x.col === n && !x.hidden && (x.key !== 'akquise' || showAkquise))
            .map((x) => cards[x.key]);
        return (
          <div class="dash-grid">
            <div class="dash-col">{col(1)}</div>
            <div class="dash-col">{col(2)}</div>
          </div>
        );
      })()}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Suche
// ---------------------------------------------------------------------------

/** Fundstellen im Text fett (alle Suchwörter, ohne Groß-/Kleinschreibung). */
export const Mark: FC<{ text: string; q: string }> = ({ text, q }) => {
  const words = q
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 === 1 ? <mark>{p}</mark> : p))}</>;
};

export const SearchResults: FC<{ result: SearchResult; type: string | null }> = ({ result, type }) => {
  const total = result.groups.reduce((n, g) => n + g.hits.length, 0);
  const q = result.q;
  return (
    <>
      <PageHead
        title={`Suche: „${q}“`}
        crumbs={type ? [['alle Bereiche', `/suche?q=${encodeURIComponent(q)}`]] : []}
      />
      <form class="actions" action="/suche" method="get" style="margin-top:0">
        <input name="q" value={q} style="max-width:420px" aria-label="Suchbegriff" autofocus />
        {type && <input type="hidden" name="typ" value={type} />}
        <button class="btn">Suchen</button>
        <span class="small mut">
          Mehrere Wörter = alle müssen vorkommen. Durchsucht auch Rechnungs- und Angebotstexte, Leistungen,
          Notizen und Dateinamen.
        </span>
      </form>
      {q.length < 2 && <div class="empty">Bitte mindestens 2 Zeichen eingeben.</div>}
      {q.length >= 2 && total === 0 && <div class="empty">Nichts gefunden.</div>}
      {result.groups.length > 1 && (
        <div class="pills" style="margin:4px 0 14px">
          {result.groups.map((g) => (
            <a class="pill" href={`#g-${g.type}`}>
              {g.type}{' '}
              <span>
                {g.hits.length}
                {g.more ? '+' : ''}
              </span>
            </a>
          ))}
        </div>
      )}
      {result.groups.map((g) => (
        <div class="card search-grp" id={`g-${g.type}`}>
          <h3 style="margin-top:0">
            {g.type}{' '}
            <span class="mut small" style="font-weight:400">
              ({g.hits.length}
              {g.more ? '+' : ''})
            </span>
          </h3>
          <div class="search-hits">
            {g.hits.map((h) => (
              <div class="search-hit">
                <a href={h.href}>
                  <b>
                    <Mark text={h.label} q={q} />
                  </b>
                </a>
                {h.sub && <span class="small"> {h.sub}</span>}
                <div class="small mut">
                  <Mark text={h.snippet} q={q} />
                </div>
              </div>
            ))}
          </div>
          {g.more && !type && (
            <a class="small" href={`/suche?q=${encodeURIComponent(q)}&typ=${encodeURIComponent(g.type)}`}>
              … alle Treffer bei „{g.type}“ anzeigen
            </a>
          )}
          {g.more && type && <div class="small mut">Es gibt noch mehr Treffer – bitte genauer suchen.</div>}
        </div>
      ))}
    </>
  );
};

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
