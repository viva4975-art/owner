import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { HEALTH_INSURERS, LANGUAGES } from '../domain/hr/lists.js';
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
import { PageHead, type Tab, Tabs, dateDe, euro, initials } from './layout.js';
import { Field } from './pages-masterdata.js';

// ---------------------------------------------------------------------------
// Personal
// ---------------------------------------------------------------------------

type EmployeeRow = Employee & { residence_permit_until: string | null; site_count: number };

export const TagChips: FC<{ tags: string[] }> = ({ tags }) => (
  <>
    {tags.map((t) => (
      <span class="badge tag" style="margin-right:4px">
        {t}
      </span>
    ))}
  </>
);

export const EmployeeList: FC<{
  rows: EmployeeRow[];
  status: string;
  q: string | null;
  canExport: boolean;
  tag?: string | null;
  tags?: { tag: string; n: number }[];
  templates?: { id: string; title: string }[];
}> = ({ rows, status, q, canExport, tag = null, tags = [], templates = [] }) => {
  const mails = rows.map((e) => e.email).filter((x): x is string => !!x);
  const qs = new URLSearchParams({ status, ...(q ? { q } : {}), ...(tag ? { tag } : {}) }).toString();
  return (
    <>
      <PageHead title="Mitarbeiter">
        <a class="btn sec" href="/personal/dokumente#neu">
          Unterweisung an alle freigeben
        </a>
        <a class="btn" href="/neu?typ=mitarbeiter">
          + Mitarbeiter anlegen
        </a>
      </PageHead>
      <div class="cols" style="grid-template-columns:minmax(0,4fr) minmax(0,1.3fr)">
        <div class="card">
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
            {tag && <input type="hidden" name="tag" value={tag} />}
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
                      <td>
                        {EMPLOYMENT_TYPES[e.employment_type]}
                        {e.status === 'aktiv' && !e.pay_model && (
                          <span
                            class="badge warn"
                            style="margin-left:6px"
                            title="Tariflohn, Stundenlohn oder Festgehalt festlegen"
                          >
                            Vergütung fehlt
                          </span>
                        )}
                        {e.status === 'aktiv' &&
                          ['teilzeit', 'minijob'].includes(e.employment_type) &&
                          !e.weekly_hours && (
                            <span class="badge warn" style="margin-left:6px">
                              Std./Woche fehlt
                            </span>
                          )}
                        {e.tags.length > 0 && (
                          <div>
                            <TagChips tags={e.tags} />
                          </div>
                        )}
                      </td>
                      <td>{dateDe(e.entry_date)}</td>
                      <td class="r">
                        {e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '–'}
                      </td>
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
    { key: 'notizen', label: 'Notizen', href: `${base}/notizen`, count: notes },
    { key: 'dokumente', label: 'Dokumente', href: `${base}/dokumente` },
    { key: 'zeiten', label: 'Zeiten', href: `${base}/zeiten` },
    { key: 'stundenzettel', label: 'Stundenliste', href: `${base}/stundenzettel` },
    { key: 'einsaetze', label: 'Einsätze', href: `${base}/einsaetze` },
    { key: 'abwesenheiten', label: 'Urlaub & Krank', href: `${base}/abwesenheiten` },
  ];
  const more: Tab[] = [
    { key: 'aufgaben', label: 'Aufgaben', href: `${base}/aufgaben`, count: tasks },
    { key: 'app', label: 'Handy-Zugang (PIN)', href: `${base}/app-zugang` },
    { key: 'kalender', label: 'Einsatzkalender', href: `${base}/kalender` },
    { key: 'uebergaben', label: 'Übergaben (Kleidung, Geräte …)', href: `${base}/uebergaben` },
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
  wage?: { level: string | null; cents: bigint | null };
  month?: Child;
  /** direkt unter dem Kopf (z. B. Aktuelle Einsätze) */
  afterHead?: Child;
  /** ganz unten (z. B. Beschäftigungszeiten) */
  footer?: Child;
  employment?: Child;
  /** Verlauf der Wochenstunden (neueste zuerst) */
  hours?: { valid_from: string; weekly_hours: string | null; recorded_by: string }[];
}> = ({ e, priv, sites, showPrivate, wage, month, afterHead, footer, employment, hours = [] }) => (
  <>
    {e.warning_note && (
      <div class="flash err" style="white-space:pre-line">
        <b>Warnhinweis:</b> {e.warning_note}
      </div>
    )}
    <div class="card person-head">
      <span class="avatar">{initials(`${e.first_name} ${e.last_name}`)}</span>
      <div class="ph-n">
        <b>
          {e.first_name} {e.last_name}
        </b>
        <div class="small mut">
          Personalnr. {e.personnel_no} · {EMPLOYMENT_TYPES[e.employment_type]}
          {e.weekly_hours ? ` · ${String(Number(e.weekly_hours)).replace('.', ',')} Std./Woche` : ''}
        </div>
        <span class={`badge ${e.status === 'aktiv' ? 'ok' : 'bad'}`}>
          {e.status === 'aktiv' ? 'aktiv' : 'ausgetreten'}
        </span>
      </div>
      <a class="btn sec ph-edit" href={`/personal/${e.id}/bearbeiten`}>
        Stammdaten bearbeiten
      </a>
    </div>
    {afterHead}
    <div class="cols">
      <div class="card">
        <h3>Stammdaten</h3>
        <dl class="kv">
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
          {employment && (
            <>
              <dt></dt>
              <dd>
                <details id="beschaeftigung" class="emp-periods">
                  <summary class="btn sm sec">Beschäftigungszeiten / Austritt</summary>
                  <div style="margin-top:10px">{employment}</div>
                </details>
              </dd>
            </>
          )}
          <dt>Std./Woche</dt>
          <dd>
            {e.weekly_hours ? String(Number(e.weekly_hours)).replace('.', ',') : '–'}
            {hours.length > 1 && (
              <details class="hours-hist">
                <summary class="small">Verlauf ({hours.length})</summary>
                <div class="small" style="margin-top:4px">
                  {hours.map((h) => (
                    <div style="padding:2px 0" class={h.valid_from > todayBerlin() ? 'mut' : ''}>
                      ab {dateDe(h.valid_from)}:{' '}
                      <b>
                        {h.weekly_hours != null ? String(Number(h.weekly_hours)).replace('.', ',') : '–'} Std.
                      </b>
                      <span class="mut">
                        {' '}
                        · {h.valid_from > todayBerlin() ? 'geplant · ' : ''}
                        {h.recorded_by}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </dd>
          <dt>Urlaubsanspruch</dt>
          <dd>{String(Number(e.annual_leave_days)).replace('.', ',')} Tage/Jahr</dd>
          {wage && (
            <>
              <dt>Vergütung</dt>
              <dd>
                {e.pay_model === 'festgehalt' ? (
                  <>
                    Festgehalt {euro(e.monthly_salary_cents ?? 0n)}/Monat
                    {wage.cents != null && <span class="small mut"> (≈ {euro(wage.cents)}/Std.)</span>}
                  </>
                ) : (
                  <>
                    {wage.cents != null ? `${euro(wage.cents)}/Std.` : '–'}
                    <span class="small mut">
                      {' '}
                      ({e.pay_model === 'individuell' ? 'individuell' : (wage.level ?? 'Tarif')})
                    </span>
                  </>
                )}
                {!e.pay_model && <span class="badge warn">bitte festlegen</span>}
              </dd>
            </>
          )}
          <dt>Telefon</dt>
          <dd>{e.phone ?? '–'}</dd>
          {e.mobile && (
            <>
              <dt>Mobil</dt>
              <dd>{e.mobile}</dd>
            </>
          )}
          <dt>E-Mail</dt>
          <dd>{e.email ?? '–'}</dd>
          {e.tags.length > 0 && (
            <>
              <dt>Tags</dt>
              <dd>
                <TagChips tags={e.tags} />
              </dd>
            </>
          )}
          <dt>Sprachen</dt>
          <dd>{e.languages.length ? e.languages.join(', ') : '–'}</dd>
        </dl>
        {e.info && (
          <p class="small" style="white-space:pre-line">
            {e.info}
          </p>
        )}
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
              <dt>Geburtsort</dt>
              <dd>{[priv.birth_place, priv.birth_country].filter(Boolean).join(', ') || '–'}</dd>
              <dt>Familienstand</dt>
              <dd>{priv.marital_status ?? '–'}</dd>
              <dt>Staatsangehörigkeit</dt>
              <dd>{priv.nationality ?? '–'}</dd>
              <dt>Aufenthaltstitel bis</dt>
              <dd>
                {dateDe(priv.residence_permit_until)}
                {priv.residence_permit_info && <div class="small mut">{priv.residence_permit_info}</div>}
              </dd>
              <dt>Arbeitserlaubnis bis</dt>
              <dd>
                {dateDe(priv.work_permit_until)}
                {priv.work_permit_info && <div class="small mut">{priv.work_permit_info}</div>}
              </dd>
              <dt>Krankenkasse</dt>
              <dd>{priv.health_insurance ?? '–'}</dd>
            </dl>
            <p class="mut small" style="margin-bottom:0">
              Steuer-ID, SV-Nummer und IBAN nur unter „Stammdaten“.
            </p>
          </div>
        )}
        {month}
      </div>
    </div>
    {footer}
  </>
);

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
        <small class="mut">
          Stundensatz für Nachkalkulation/Mindestlohn = Gehalt × 3 ÷ 13 ÷ Wochenstunden
        </small>
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
      <Field name="nationality" label="Staatsangehörigkeit" value={priv.nationality} />
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
