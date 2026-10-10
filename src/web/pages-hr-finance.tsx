import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  FREE_MOVEMENT_COUNTRIES,
  HEALTH_INSURERS,
  LANGUAGES,
  OTHER_COUNTRIES,
  countryOf,
} from '../domain/hr/lists.js';
import {
  EMPLOYMENT_TYPES,
  type Employee,
  type EmployeePrivate,
  MARITAL_STATUS,
  TAG_SUGGESTIONS,
  type WageLevel,
} from '../services/employees.js';
import { type OpenItem, PAYMENT_METHODS, type PaymentRow } from '../services/payments.js';
import { centsToInput } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro, initials } from './layout.js';
import { Field } from './pages-masterdata.js';

// ---------------------------------------------------------------------------
// Personal
// ---------------------------------------------------------------------------

type EmployeeRow = Employee & {
  residence_permit_until: string | null;
  site_count: number;
  has_shift?: boolean;
  work_permit_until?: string | null;
  street?: string | null;
  postal_code?: string | null;
  city?: string | null;
  birth_date?: string | null;
  nationality?: string | null;
  site_names?: string[] | null;
};

export const TagChips: FC<{ tags: string[] }> = ({ tags }) => (
  <>
    {tags.map((t) => (
      <span class="badge tag" style="margin-right:4px">
        {t}
      </span>
    ))}
  </>
);

const PER_PAGE = 25;

/** Alter bzw. Jahre seit einem Datum (JJJJ-MM-TT), Stichtag heute (Berlin). */
function yearsSince(d: string): number {
  const t = todayBerlin();
  let y = Number(t.slice(0, 4)) - Number(d.slice(0, 4));
  if (t.slice(5) < d.slice(5, 10)) y--;
  return Math.max(0, y);
}

/** Mitarbeiter-Karte in der Liste (wie Fortytools: Foto/Initialen, Name, Tags, Kontakt, Eckdaten). */
const EmployeeCard: FC<{ e: EmployeeRow }> = ({ e }) => {
  const soon = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const today = todayBerlin();
  const permit = (label: string, d: string | null | undefined) =>
    d ? (
      <div class={d < today ? 'err' : d <= soon ? 'warn' : ''}>
        {label} bis {dateDe(d)}
        {d < today ? ' – abgelaufen' : ''}
      </div>
    ) : null;
  const addr = [e.street, [e.postal_code, e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const phone = e.mobile || e.phone;
  const sites = e.site_names ?? [];
  return (
    <article class={`emp-card${e.status === 'ausgetreten' ? ' out' : ''}`}>
      <a class="emp-av" href={`/personal/${e.id}`} aria-hidden="true">
        {initials(`${e.first_name} ${e.last_name}`)}
      </a>
      <div class="emp-body">
        <div class="emp-head">
          <a class="emp-name" href={`/personal/${e.id}`}>
            {e.last_name}, {e.first_name}
          </a>
          <span class="emp-no">{e.personnel_no}</span>
        </div>
        <div class="emp-tags">
          {(e.tags.length ? e.tags : [EMPLOYMENT_TYPES[e.employment_type]]).map((t) => (
            <span class="badge tag">{t}</span>
          ))}
          {e.status === 'ausgetreten' && (
            <span class="badge">ausgetreten{e.exit_date ? ` ${dateDe(e.exit_date)}` : ''}</span>
          )}
          {e.status === 'aktiv' && e.has_shift === false && (
            <a class="badge warn" href={`/personal/${e.id}/einsaetze`}>
              kein Einsatz
            </a>
          )}
          {e.status === 'aktiv' && !e.pay_model && <span class="badge warn">Vergütung fehlt</span>}
          {e.status === 'aktiv' && ['teilzeit', 'minijob'].includes(e.employment_type) && !e.weekly_hours && (
            <span class="badge warn">Std./Woche fehlt</span>
          )}
        </div>
        {e.warning_note && <div class="emp-warn">{e.warning_note}</div>}
        <ul class="emp-contact">
          {addr && (
            <li>
              <Icon name="home" size={15} />
              <span>
                {addr}{' '}
                <a
                  class="emp-map"
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`}
                  target="_blank"
                  rel="noopener"
                >
                  Karte
                </a>
              </span>
            </li>
          )}
          {phone && (
            <li>
              <Icon name="phone" size={15} />
              <a href={`tel:${phone.replace(/[^\d+]/g, '')}`}>{phone}</a>
            </li>
          )}
          {e.email && (
            <li>
              <Icon name="mail" size={15} />
              <a href={`mailto:${e.email}`}>{e.email}</a>
            </li>
          )}
          {sites.length > 0 && (
            <li>
              <Icon name="building" size={15} />
              <span>
                {sites.slice(0, 3).join(', ')}
                {sites.length > 3 ? ` und ${sites.length - 3} weitere` : ''}
              </span>
            </li>
          )}
        </ul>
        <div class="emp-meta">
          {e.birth_date && (
            <div>
              Geboren: {dateDe(e.birth_date)} ({yearsSince(e.birth_date)} Jahre)
            </div>
          )}
          <div>
            Betriebszugehörigkeit: seit {dateDe(e.entry_date)}
            {yearsSince(e.entry_date) > 0 ? ` (${yearsSince(e.entry_date)} J.)` : ''}
            {e.weekly_hours ? ` · ${String(Number(e.weekly_hours)).replace('.', ',')} Wochenstunden` : ''}
          </div>
          {e.nationality && <div>Staatsangehörigkeit: {e.nationality}</div>}
          {permit('Aufenthaltstitel', e.residence_permit_until)}
          {permit('Arbeitserlaubnis', e.work_permit_until)}
        </div>
      </div>
    </article>
  );
};

export const EmployeeList: FC<{
  rows: EmployeeRow[];
  status: string;
  q: string | null;
  canExport: boolean;
  tag?: string | null;
  tags?: { tag: string; n: number }[];
  templates?: { id: string; title: string }[];
  /** Filter „ohne Einsatz“ aktiv / Anzahl aktiver Mitarbeitender ohne laufenden Einsatz */
  ohne?: boolean;
  noShift?: number;
  page?: number;
  sort?: string;
}> = ({
  rows,
  status,
  q,
  canExport,
  tag = null,
  tags = [],
  templates = [],
  ohne = false,
  noShift = 0,
  page: wanted = 1,
  sort = 'name',
}) => {
  const sorted = [...rows].sort((a, b) =>
    sort === 'nr'
      ? a.personnel_no.localeCompare(b.personnel_no, 'de', { numeric: true })
      : sort === 'eintritt'
        ? b.entry_date.localeCompare(a.entry_date)
        : `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'de'),
  );
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(1, wanted), pages);
  const from = (page - 1) * PER_PAGE;
  const shown = sorted.slice(from, from + PER_PAGE);
  const mails = rows.map((e) => e.email).filter((x): x is string => !!x);
  const qs = new URLSearchParams({
    status,
    ...(q ? { q } : {}),
    ...(tag ? { tag } : {}),
    ...(ohne ? { einsatz: 'ohne' } : {}),
  }).toString();
  return (
    <>
      <PageHead title="Mitarbeiter">
        <a class="btn sec" href="/personal/dokumente?alle=1#neu">
          Unterweisung an alle freigeben
        </a>
        <a class="btn" href="/neu?typ=mitarbeiter">
          + Mitarbeiter anlegen
        </a>
      </PageHead>
      <div class="cols" style="grid-template-columns:minmax(0,4fr) minmax(0,1.3fr)">
        <div class="card">
          {(noShift > 0 || ohne) && (
            <div class="flash warn" style="margin:0 0 10px">
              <span>
                {ohne ? (
                  <>
                    Gefiltert: <b>ohne laufenden Einsatz</b> ({rows.length}).{' '}
                    <a href={`/personal?status=${status}`}>Filter aufheben</a>
                  </>
                ) : (
                  <>
                    <b>{noShift}</b> aktive Mitarbeitende ohne laufenden Einsatz –{' '}
                    <a href="/personal?status=aktiv&einsatz=ohne">anzeigen</a>
                  </>
                )}
              </span>
            </div>
          )}
          {tags.length > 0 && (
            <div class="actions" style="margin-top:0;gap:6px">
              <a class={`badge ${!tag ? 'info' : 'tag'}`} href={`/personal?status=${status}`}>
                alle
              </a>
              {tags.map((t) => (
                <a
                  class={`badge ${tag === t.tag ? 'info' : 'tag'}`}
                  href={`/personal?status=${status}&tag=${encodeURIComponent(t.tag)}`}
                >
                  {t.tag} ({t.n})
                </a>
              ))}
            </div>
          )}
          <form class="actions" method="get" action="/personal" style="margin-top:0">
            <select name="status" style="max-width:180px" aria-label="Status">
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
            {tag && <input type="hidden" name="tag" value={tag} />}
            {ohne && <input type="hidden" name="einsatz" value="ohne" />}
            <button class="btn sec sm">Filtern</button>
            {canExport && (
              <a class="btn sm" href="/personal/export.csv" style="margin-left:auto">
                Export Lexware Lohn (CSV)
              </a>
            )}
          </form>
          <div class="emp-pager">
            <span>
              <b>
                {total ? from + 1 : 0}–{Math.min(from + PER_PAGE, total)}
              </b>{' '}
              von <b>{total}</b>
            </span>
            <form method="get" action="/personal" class="emp-sort">
              {[...new URLSearchParams(qs)]
                .filter(([k]) => k !== 'sortierung' && k !== 'seite')
                .map(([k, v]) => (
                  <input type="hidden" name={k} value={v} />
                ))}
              <select name="sortierung" aria-label="Sortierung" onchange="this.form.submit()">
                {[
                  ['name', 'Name A–Z'],
                  ['nr', 'Personalnummer'],
                  ['eintritt', 'Eintritt (neueste zuerst)'],
                ].map(([v, l]) => (
                  <option value={v} selected={sort === v}>
                    {l}
                  </option>
                ))}
              </select>
            </form>
          </div>
          {total === 0 && <div class="empty">Keine Mitarbeiter.</div>}
          <div class="emp-cards">
            {shown.map((e) => (
              <EmployeeCard e={e} />
            ))}
          </div>
          {pages > 1 && (
            <nav class="emp-pages" aria-label="Seiten">
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <a
                  class={n === page ? 'on' : ''}
                  href={`/personal?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(qs)), sortierung: sort, seite: String(n) })}`}
                >
                  {n}
                </a>
              ))}
            </nav>
          )}
        </div>
        <div>
          <div class="card">
            <h3>Serienbriefe</h3>
            <p class="small mut" style="margin-top:0">
              Für alle {rows.length} gefilterten Mitarbeitenden ein Brief aus einer Vorlage (ein PDF zum
              Drucken).
            </p>
            <form method="get" action="/personal/serienbrief.pdf" target="_blank">
              {[...new URLSearchParams(qs)].map(([k, v]) => (
                <input type="hidden" name={k} value={v} />
              ))}
              <select name="vorlage" required aria-label="Vorlage">
                {templates.map((t) => (
                  <option value={t.id}>{t.title}</option>
                ))}
              </select>
              <div class="actions" style="margin-bottom:0">
                <button class="btn sm sec" disabled={!rows.length || !templates.length}>
                  Jetzt erstellen
                </button>
                <a class="small" href="/personal/vorlagen">
                  Vorlagen
                </a>
              </div>
            </form>
          </div>
          <div class="card">
            <h3>E-Mail-Verteiler</h3>
            <p class="small mut" style="margin-top:0">
              {mails.length} von {rows.length} gefilterten Mitarbeitenden haben eine E-Mail-Adresse.
            </p>
            {mails.length > 0 ? (
              <a class="btn sm sec" href={`mailto:?bcc=${encodeURIComponent(mails.join(','))}`}>
                Gefilterte anschreiben (BCC)
              </a>
            ) : (
              <button class="btn sm sec" disabled>
                Gefilterte anschreiben (BCC)
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

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
    { key: 'kalender', label: 'Kalender & Zeiten', href: `${base}/kalender` },
    { key: 'einsaetze', label: 'Einsätze', href: `${base}/einsaetze` },
    { key: 'stundenzettel', label: 'Stundenliste', href: `${base}/stundenzettel` },
    { key: 'abwesenheiten', label: 'Urlaub & Krank', href: `${base}/abwesenheiten` },
    { key: 'dokumente', label: 'Dokumente', href: `${base}/dokumente` },
    { key: 'uebergaben', label: 'Übergaben', href: `${base}/uebergaben` },
    { key: 'app', label: 'Handy-Zugang', href: `${base}/app-zugang` },
  ];
  const more: Tab[] = [
    { key: 'notizen', label: 'Notizen', href: `${base}/notizen`, count: notes },
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: tasks },
  ];
  return (
    <>
      <PageHead title={`${e.first_name} ${e.last_name}`} no={e.personnel_no} />
      <Tabs tabs={tabs} more={more} active={active === 'zeiten' ? 'kalender' : active} />
      <div class="tabbody">{children}</div>
    </>
  );
};

export const EmployeeOverview: FC<{
  e: Employee;
  priv: EmployeePrivate | undefined;
  sites: { id: string; site_no: string; name: string }[];
  showPrivate: boolean;
  wage?: { level: string | null; cents: bigint | null };
  month?: Child;
  /** direkt unter dem Kopf (z. B. Aktuelle Einsätze) */
  afterHead?: Child;
  /** ganz unten (z. B. Beschäftigungszeiten) */
  footer?: Child;
  employment?: Child;
  /** Verlauf der Wochenstunden (neueste zuerst) */
  hours?: { valid_from: string; weekly_hours: string | null; recorded_by: string }[];
}> = ({ e, priv, sites, showPrivate, wage, month, afterHead, footer, employment, hours = [] }) => {
  // Neu gestaltet (Ahmed 10.10.: „Mitarbeiterübersicht designtechnisch nicht schön“): Kopf mit Kennzahlen und
  // Schnellaktionen, darunter Beschäftigung | Kontakt, rechts Objekte, Vertrauliches, Plan/Ist.
  const today = todayBerlin();
  const num = (v: string | number | null | undefined) =>
    v == null ? '–' : String(Number(v)).replace('.', ',');
  const tenure = (() => {
    if (!e.entry_date) return null;
    const [y, m] = e.entry_date.split('-').map(Number) as [number, number];
    const [ty, tm] = (e.exit_date && e.exit_date < today ? e.exit_date : today).split('-').map(Number) as [
      number,
      number,
    ];
    const months = (ty - y) * 12 + (tm - m);
    if (months < 1) return 'neu';
    if (months < 12) return `${months} Monat${months === 1 ? '' : 'e'}`;
    const yrs = Math.floor(months / 12);
    return `${yrs} Jahr${yrs === 1 ? '' : 'e'}`;
  })();
  const tel = (v: string) => `tel:${v.replace(/[^+\d]/g, '')}`;
  const wa = e.mobile ? `https://wa.me/${e.mobile.replace(/\D/g, '').replace(/^0/, '49')}` : null;
  const expiry = (d: string | null | undefined) => {
    if (!d) return null;
    const days = Math.round((Date.parse(d) - Date.parse(today)) / 86400000);
    if (days < 0) return <span class="badge bad">abgelaufen</span>;
    if (days <= 60) return <span class="badge warn">noch {days} Tage</span>;
    return null;
  };
  const pay =
    wage &&
    (e.pay_model === 'festgehalt'
      ? `${euro(e.monthly_salary_cents ?? 0n)}/Monat`
      : wage.cents != null
        ? `${euro(wage.cents)}/Std.`
        : null);
  return (
    <>
      {e.warning_note && (
        <div class="flash err" style="white-space:pre-line">
          <b>Warnhinweis:</b> {e.warning_note}
        </div>
      )}
      <section class="card emp-hero">
        <div class="eh-top">
          <span class="eh-av">{initials(`${e.first_name} ${e.last_name}`)}</span>
          <div class="eh-name">
            <h2>
              {e.first_name} {e.last_name}
            </h2>
            <div class="eh-sub">
              Personalnr. <b>{e.personnel_no}</b> · {EMPLOYMENT_TYPES[e.employment_type]}
              {e.weekly_hours ? ` · ${num(e.weekly_hours)} Std./Woche` : ''}
            </div>
            <div class="eh-chips">
              <span class={`badge ${e.status === 'aktiv' ? 'ok' : 'bad'}`}>
                {e.status === 'aktiv' ? 'aktiv' : 'ausgetreten'}
              </span>
              {e.tags
                .filter((t) => t !== EMPLOYMENT_TYPES[e.employment_type])
                .map((t) => (
                  <span class="eh-tag">{t}</span>
                ))}
            </div>
          </div>
          <div class="eh-acts">
            {(e.mobile || e.phone) && (
              <a class="btn sec sm" href={tel((e.mobile || e.phone)!)}>
                <Icon name="phone" /> Anrufen
              </a>
            )}
            {wa && (
              <a class="btn sec sm" href={wa} target="_blank" rel="noopener">
                WhatsApp
              </a>
            )}
            {e.email && (
              <a class="btn sec sm" href={`mailto:${e.email}`}>
                <Icon name="mail" /> E-Mail
              </a>
            )}
            <a class="btn sm" href={`/personal/${e.id}/bearbeiten`}>
              <Icon name="pencil" /> Bearbeiten
            </a>
          </div>
        </div>
        <div class="eh-facts">
          <div>
            <span>Im Betrieb seit</span>
            <b>{dateDe(e.entry_date)}</b>
            <small>{e.exit_date ? `Austritt ${dateDe(e.exit_date)}` : tenure}</small>
          </div>
          <div>
            <span>Wochenstunden</span>
            <b>{e.weekly_hours ? `${num(e.weekly_hours)} Std.` : '–'}</b>
            <small>
              {e.weekly_hours
                ? `≈ ${num(Math.round(Number(e.weekly_hours) * 4.33 * 10) / 10)} Std./Monat`
                : 'nicht hinterlegt'}
            </small>
          </div>
          <div>
            <span>Vergütung</span>
            <b>{pay ?? <span class="badge warn">fehlt</span>}</b>
            <small>
              {e.pay_model === 'festgehalt'
                ? wage?.cents != null
                  ? `≈ ${euro(wage.cents)}/Std.`
                  : 'Festgehalt'
                : e.pay_model === 'individuell'
                  ? 'individuell'
                  : (wage?.level ?? 'Tarif')}
            </small>
          </div>
          <div>
            <span>Urlaub</span>
            <b>{num(e.annual_leave_days)} Tage</b>
            <small>
              <a href={`/personal/${e.id}/abwesenheiten`}>Urlaubskonto →</a>
            </small>
          </div>
          <div>
            <span>Aktuelle Objekte</span>
            <b>{sites.length}</b>
            <small>
              <a href={`/personal/${e.id}/einsaetze`}>Einsätze →</a>
            </small>
          </div>
        </div>
      </section>
      {afterHead}
      <div class="emp-grid">
        <div class="emp-main">
          <section class="card">
            <h3>Beschäftigung</h3>
            <dl class="kv">
              <dt>Art</dt>
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
              <dd>
                {e.weekly_hours ? num(e.weekly_hours) : '–'}
                {hours.length > 1 && (
                  <details class="hours-hist">
                    <summary class="small">Verlauf ({hours.length})</summary>
                    <div class="small" style="margin-top:4px">
                      {hours.map((h) => (
                        <div style="padding:2px 0" class={h.valid_from > today ? 'mut' : ''}>
                          ab {dateDe(h.valid_from)}: <b>{num(h.weekly_hours)} Std.</b>
                          <span class="mut">
                            {' '}
                            · {h.valid_from > today ? 'geplant · ' : ''}
                            {h.recorded_by}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </dd>
              <dt>Urlaubsanspruch</dt>
              <dd>{num(e.annual_leave_days)} Tage/Jahr</dd>
              {wage && (
                <>
                  <dt>Vergütung</dt>
                  <dd>
                    {pay ?? '–'}
                    <span class="small mut">
                      {' '}
                      (
                      {e.pay_model === 'festgehalt'
                        ? 'Festgehalt'
                        : e.pay_model === 'individuell'
                          ? 'individuell'
                          : (wage.level ?? 'Tarif')}
                      )
                    </span>
                    {!e.pay_model && <span class="badge warn">bitte festlegen</span>}
                  </dd>
                </>
              )}
            </dl>
            {employment && (
              <details id="beschaeftigung" class="emp-periods">
                <summary class="btn sm sec">Beschäftigungszeiten / Austritt</summary>
                <div style="margin-top:10px">{employment}</div>
              </details>
            )}
          </section>
          <section class="card">
            <h3>Kontakt</h3>
            <dl class="kv">
              <dt>Telefon</dt>
              <dd>{e.phone ? <a href={tel(e.phone)}>{e.phone}</a> : '–'}</dd>
              <dt>Mobil</dt>
              <dd>{e.mobile ? <a href={tel(e.mobile)}>{e.mobile}</a> : '–'}</dd>
              <dt>E-Mail</dt>
              <dd>{e.email ? <a href={`mailto:${e.email}`}>{e.email}</a> : '–'}</dd>
              <dt>Sprachen</dt>
              <dd>{e.languages.length ? e.languages.join(', ') : '–'}</dd>
            </dl>
            {e.info && (
              <p class="small eh-info" style="white-space:pre-line">
                {e.info}
              </p>
            )}
          </section>
        </div>
        <div class="emp-side">
          <section class="card">
            <h3>Aktuelle Objekte</h3>
            {sites.length ? (
              <ul class="eh-sites">
                {sites.map((s) => (
                  <li>
                    <Icon name="building" />
                    <a href={`/objekte/${s.id}`}>{s.name}</a>
                    <span class="mut small">{s.site_no}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div class="empty">Derzeit an keinem Objekt eingeplant.</div>
            )}
          </section>
          {showPrivate && priv && (
            <section class="card">
              <h3>
                Vertraulich <span class="mut small">nur Geschäftsführung/Personal</span>
              </h3>
              <dl class="kv">
                <dt>Geburtsdatum</dt>
                <dd>{dateDe(priv.birth_date)}</dd>
                <dt>Geburtsort</dt>
                <dd>{[priv.birth_place, priv.birth_country].filter(Boolean).join(', ') || '–'}</dd>
                <dt>Familienstand</dt>
                <dd>{priv.marital_status ?? '–'}</dd>
                <dt>Staatsangehörigkeit</dt>
                <dd>{priv.nationality ?? '–'}</dd>
                <dt>Aufenthaltstitel</dt>
                <dd>
                  {priv.residence_permit_until ? `bis ${dateDe(priv.residence_permit_until)} ` : '–'}
                  {expiry(priv.residence_permit_until)}
                  {priv.residence_permit_info && <div class="small mut">{priv.residence_permit_info}</div>}
                </dd>
                <dt>Arbeitserlaubnis</dt>
                <dd>
                  {priv.work_permit_until ? `bis ${dateDe(priv.work_permit_until)} ` : '–'}
                  {expiry(priv.work_permit_until)}
                  {priv.work_permit_info && <div class="small mut">{priv.work_permit_info}</div>}
                </dd>
                <dt>Krankenkasse</dt>
                <dd>{priv.health_insurance ?? '–'}</dd>
              </dl>
              <p class="mut small" style="margin-bottom:0">
                Steuer-ID, SV-Nummer und IBAN unter „Bearbeiten“.
              </p>
            </section>
          )}
          {month}
        </div>
      </div>
      {footer}
    </>
  );
};

export const EmployeeForm: FC<{
  id: string;
  e: Partial<Employee>;
  priv: Partial<EmployeePrivate>;
  isNew: boolean;
  wageLevels?: WageLevel[];
}> = ({ id, e, priv, isNew, wageLevels = [] }) => (
  <form
    method="post"
    action={`/personal/${id}`}
    data-autosave={`/personal/${id}`}
    data-version={`${e.version ?? ''}/${priv.version ?? ''}`}
  >
    <input type="hidden" name="version" value={String(e.version ?? '')} />
    <input type="hidden" name="private_version" value={String(priv.version ?? '')} />
    <h3>Personendaten</h3>
    <div class="grid">
      <div>
        <label for="salutation">Anrede</label>
        <select id="salutation" name="salutation">
          <option value="">–</option>
          {['Herr', 'Frau', 'divers'].map((a) => (
            <option value={a} selected={e.salutation === a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <Field name="first_name" label="Vorname *" value={e.first_name} required />
      <Field name="last_name" label="Nachname *" value={e.last_name} required />
      <Field name="phone" label="Telefon" value={e.phone} />
      <Field name="mobile" label="Mobil" value={e.mobile} />
      <Field name="email" label="E-Mail" type="email" value={e.email} />
      <Field name="email_private" label="Weitere E-Mail" type="email" value={e.email_private} />
      <div>
        <label for="tag-in">Tags</label>
        <div class="chipin" data-chips="tags">
          <span class="chip fixed" data-emp-chip title="Beschäftigungsart – wird automatisch gesetzt">
            {e.employment_type ? EMPLOYMENT_TYPES[e.employment_type] : 'Beschäftigungsart'}
          </span>
          {(e.tags ?? [])
            .filter((t) => !(Object.values(EMPLOYMENT_TYPES) as string[]).includes(t))
            .map((t) => (
              <span class="chip">
                {t}
                <button type="button" aria-label={`${t} entfernen`}>
                  ×
                </button>
                <input type="hidden" name="tags" value={t} />
              </span>
            ))}
          <input id="tag-in" list="tag-list" placeholder="Tag eingeben, Enter" autocomplete="off" />
        </div>
        <datalist id="tag-list">
          {TAG_SUGGESTIONS.filter((t) => !(Object.values(EMPLOYMENT_TYPES) as string[]).includes(t)).map(
            (t) => (
              <option value={t} />
            ),
          )}
        </datalist>
        <small class="mut">
          Schlagwörter, um Mitarbeitende nach beliebigen Kriterien zu ordnen. Die Beschäftigungsart wird
          automatisch als Tag übernommen.
        </small>
      </div>
      <div>
        <label for="lang-in">Sprachen (die erste, die die App kann, wird App-Sprache)</label>
        <div class="chipin" data-chips="languages" data-strict>
          {(e.languages ?? []).map((t) => (
            <span class="chip">
              {t}
              <button type="button" aria-label={`${t} entfernen`}>
                ×
              </button>
              <input type="hidden" name="languages" value={t} />
            </span>
          ))}
          <input id="lang-in" list="lang-list" placeholder="Sprache wählen" autocomplete="off" />
        </div>
        <datalist id="lang-list">
          {LANGUAGES.map((l) => (
            <option value={l.name}>{l.app ? 'auch App-Sprache' : ''}</option>
          ))}
        </datalist>
      </div>
    </div>
    <label for="warning_note">Warnhinweis (besonders hervorgehoben)</label>
    <input
      id="warning_note"
      name="warning_note"
      value={e.warning_note ?? ''}
      placeholder="z. B. kein Einsatz in Schulen"
    />
    <label for="info">Information</label>
    <textarea id="info" name="info" rows={2}>
      {e.info ?? ''}
    </textarea>
    <h3 style="margin-top:20px">Beschäftigung</h3>
    <div class="grid">
      <Field name="personnel_no" label="Personalnummer *" value={e.personnel_no} required />
      <div>
        <label for="employment_type">Beschäftigungsart *</label>
        <select id="employment_type" name="employment_type" required>
          <option value="" disabled selected={!e.employment_type}>
            – bitte wählen –
          </option>
          {Object.entries(EMPLOYMENT_TYPES).map(([k, v]) => (
            <option value={k} selected={e.employment_type === k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <Field name="entry_date" label="Eintritt *" type="date" value={e.entry_date} required />
      <input type="hidden" name="exit_date" value={e.exit_date ?? ''} />
      <Field
        name="weekly_hours"
        label="Stunden/Woche"
        value={e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : ''}
      />
      {!isNew && (
        <div>
          <label for="hours_valid_from">Stunden gültig ab</label>
          <input id="hours_valid_from" name="hours_valid_from" type="date" />
          <div class="small mut">
            Nur bei geänderten Stunden: ab wann sie gelten (leer = heute). Der alte Wert bleibt im Verlauf
            sichtbar.
          </div>
        </div>
      )}
      <Field
        name="annual_leave_days"
        label="Urlaubsanspruch (Tage/Jahr)"
        value={e.annual_leave_days != null ? String(Number(e.annual_leave_days)).replace('.', ',') : '30'}
      />
    </div>
    <h3 style="margin-top:20px">Vergütung *</h3>
    <div class="pay-pick" data-pay>
      {(
        [
          ['tarif', 'Tariflohn', 'Lohngruppe laut Tarif, Betrag unter Einstellungen → Tariflöhne'],
          ['individuell', 'Individueller Stundenlohn', 'abweichender Stundenlohn für diese Person'],
          ['festgehalt', 'Festgehalt', 'fester Monatslohn brutto (z. B. Büro, Objektleitung)'],
        ] as const
      ).map(([k, l, d]) => (
        <label class="pay-opt">
          <input type="radio" name="pay_model" value={k} required checked={e.pay_model === k} />
          <span>
            <b>{l}</b>
            <small>{d}</small>
          </span>
        </label>
      ))}
    </div>
    <div class="grid">
      <div data-pay-for="tarif" hidden={e.pay_model !== 'tarif'}>
        <label for="wage_level_id">Tariflohn *</label>
        <select id="wage_level_id" name="wage_level_id" data-nosearch>
          <option value="">– Lohngruppe wählen –</option>
          {wageLevels.map((w) => (
            <option value={w.id} selected={w.id === e.wage_level_id}>
              {w.name} ({euro(w.hourly_wage_cents)}/Std.)
            </option>
          ))}
        </select>
      </div>
      <div data-pay-for="individuell" hidden={e.pay_model !== 'individuell'}>
        <label for="hourly_wage">Stundenlohn (€) *</label>
        <input
          id="hourly_wage"
          name="hourly_wage"
          placeholder="z. B. 16,50"
          value={e.hourly_wage_cents != null ? centsToInput(e.hourly_wage_cents) : ''}
        />
      </div>
      <div data-pay-for="festgehalt" hidden={e.pay_model !== 'festgehalt'}>
        <label for="monthly_salary">Festgehalt brutto/Monat (€) *</label>
        <input
          id="monthly_salary"
          name="monthly_salary"
          placeholder="z. B. 2.800,00"
          value={e.monthly_salary_cents != null ? centsToInput(e.monthly_salary_cents) : ''}
        />
        <small class="mut">Stundensatz für Nachkalkulation/Mindestlohn = Gehalt ÷ 4,33 ÷ Wochenstunden</small>
      </div>
    </div>
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){var box=document.currentScript.previousElementSibling.previousElementSibling;var f=box.closest('form');function upd(){var v=(f.querySelector('input[name=pay_model]:checked')||{}).value;f.querySelectorAll('[data-pay-for]').forEach(function(d){var on=d.getAttribute('data-pay-for')===v;d.hidden=!on;d.querySelectorAll('input,select').forEach(function(x){x.disabled=!on})})}box.addEventListener('change',upd);upd()})();`,
      }}
    />
    <input type="hidden" name="planning_group" value={e.planning_group ?? ''} />
    <input type="hidden" name="planning_notes" value={e.planning_notes ?? ''} />
    <div class="chk" style="margin-top:8px">
      <input
        type="checkbox"
        id="carry_over_leave"
        name="carry_over_leave"
        checked={e.carry_over_leave ?? true}
      />
      <label for="carry_over_leave">Resturlaub ins Folgejahr übertragen (verfällt zum 31.03.)</label>
    </div>
    <h3 style="margin-top:20px">
      Vertrauliche Daten <span class="mut small">(nur Geschäftsführung/Personal sichtbar)</span>
    </h3>
    <div class="grid">
      <Field name="birth_date" label="Geburtsdatum" type="date" value={priv.birth_date} />
      <Field name="birth_place" label="Geburtsort" value={priv.birth_place} />
      <Field name="birth_country" label="Geburtsland" value={priv.birth_country} />
      <div>
        <label for="marital_status">Familienstand</label>
        <select id="marital_status" name="marital_status">
          <option value="">–</option>
          {MARITAL_STATUS.map((m) => (
            <option value={m} selected={priv.marital_status === m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <Field name="street" label="Straße" value={priv.street} />
      <Field name="postal_code" label="PLZ" value={priv.postal_code} />
      <Field name="city" label="Ort" value={priv.city} />
      <div>
        <label for="nationality">Staatsangehörigkeit</label>
        <select id="nationality" name="nationality" data-combo>
          <option value="">– bitte wählen –</option>
          {priv.nationality && !countryOf(priv.nationality) && (
            <option value={priv.nationality} selected>
              {priv.nationality} (bisher, bitte aus der Liste wählen)
            </option>
          )}
          <optgroup label="EU / EWR / Schweiz – kein Aufenthaltstitel nötig">
            {FREE_MOVEMENT_COUNTRIES.map((c) => (
              <option value={c} selected={countryOf(priv.nationality) === c}>
                {c}
              </option>
            ))}
          </optgroup>
          <optgroup label="Andere Staaten – Aufenthaltstitel mit Arbeitserlaubnis nötig">
            {OTHER_COUNTRIES.map((c) => (
              <option value={c} selected={countryOf(priv.nationality) === c}>
                {c}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <Field
        name="residence_permit_until"
        label="Aufenthaltstitel gültig bis"
        type="date"
        value={priv.residence_permit_until}
      />
      <Field
        name="residence_permit_info"
        label="Aufenthaltstitel Info"
        value={priv.residence_permit_info}
        placeholder="z. B. Art, Nummer"
      />
      <Field
        name="work_permit_until"
        label="Arbeitserlaubnis gültig bis"
        type="date"
        value={priv.work_permit_until}
      />
      <Field
        name="work_permit_info"
        label="Arbeitserlaubnis Info"
        value={priv.work_permit_info}
        placeholder="z. B. Auflagen, Beschränkung auf Arbeitgeber"
      />
      <Field name="tax_id" label="Steuer-ID (11 Ziffern)" value={priv.tax_id} />
      <Field name="social_security_no" label="SV-Nummer" value={priv.social_security_no} />
      <div>
        <label for="health_insurance">Krankenkasse</label>
        <select id="health_insurance" name="health_insurance">
          <option value="">– bitte wählen –</option>
          {priv.health_insurance && !HEALTH_INSURERS.includes(priv.health_insurance) && (
            <option value={priv.health_insurance} selected>
              {priv.health_insurance}
            </option>
          )}
          {HEALTH_INSURERS.map((k) => (
            <option value={k} selected={priv.health_insurance === k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <Field name="iban" label="IBAN" value={priv.iban} />
    </div>
    <div class="flash warn" style="margin-top:12px">
      <b>Bitte auf die Fristen achten:</b> Ohne gültigen Aufenthaltstitel bzw. Arbeitserlaubnis darf nicht
      beschäftigt werden (§ 4a AufenthG; Bußgeld bis 500.000 € nach § 404 SGB III). Eine Kopie gehört in die
      Personalakte (§ 4a Abs. 5 AufenthG). Die Startseite warnt 60 Tage vor Ablauf.
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
              {(['ueberweisung', 'bar', 'skonto', 'verrechnung'] as const).map((m) => (
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
