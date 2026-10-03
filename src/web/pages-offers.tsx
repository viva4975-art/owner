import type { Child, FC } from 'hono/jsx';
import type { Customer, Site } from '../services/masterdata.js';
import { OFFER_STATUS, type OfferLineRow, type OfferRow, type OfferStatus } from '../services/offers.js';
import { centsToInput, milliToInput } from './forms.js';
import { Icon } from './icons.js';
import { NEW_OPTIONS, PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';
import { type EditorLine, LineEditor } from './pages-invoices.js';

export type OfferListRow = OfferRow & {
  customer_name: string;
  customer_no: string;
  file_count: number;
  days_left: number | null;
};

const STATUS_CLASS: Record<OfferStatus, string> = {
  entwurf: 'draft',
  versendet: 'info',
  angenommen: 'ok',
  abgelehnt: 'err',
  zurueckgezogen: '',
};

export const OfferBadge: FC<{ s: OfferStatus }> = ({ s }) => (
  <span class={`badge ${STATUS_CLASS[s]}`}>{OFFER_STATUS[s]}</span>
);

/** Abgabefrist als „Mi, 14.10.2026, 10:00 Uhr“ (deutsche Zeit). */
export function deadlineDe(d: Date | null): string {
  if (!d) return '–';
  return `${d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} Uhr`;
}

/** Date → Wert für <input type="datetime-local"> in deutscher Zeit. */
export function deadlineInput(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 16).replace(' ', 'T');
}

export const DeadlineBadge: FC<{ days: number | null; status: OfferStatus }> = ({ days, status }) => {
  if (days === null || status !== 'entwurf') return <></>;
  if (days < 0) return <span class="badge">abgelaufen</span>;
  if (days === 0) return <span class="badge err">heute</span>;
  if (days <= 7)
    return (
      <span class="badge err">
        noch {days} {days === 1 ? 'Tag' : 'Tage'}
      </span>
    );
  if (days <= 14) return <span class="badge warn">noch {days} Tage</span>;
  return <span class="badge">noch {days} Tage</span>;
};

export const OfferTable: FC<{ rows: OfferListRow[]; showCustomer?: boolean }> = ({
  rows,
  showCustomer = true,
}) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Nr.</th>
          <th>Titel / Ausschreibung</th>
          {showCustomer && <th>Kunde / Interessent</th>}
          <th>Abgabefrist</th>
          <th class="r">Netto</th>
          <th class="r">davon monatl.</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={7}>
              <div class="empty">Keine Angebote in dieser Ansicht.</div>
            </td>
          </tr>
        )}
        {rows.map((o) => (
          <tr>
            <td>
              <a href={`/angebote/${o.id}`}>
                <b>{o.number}</b>
              </a>
            </td>
            <td>
              <a href={`/angebote/${o.id}`} style="color:inherit">
                {o.title}
              </a>
              <div class="small mut">
                {[o.tender_reference && `Vergabe-Nr. ${o.tender_reference}`, o.tender_platform]
                  .filter(Boolean)
                  .join(' · ')}
                {o.file_count > 0 && (
                  <span title="Unterlagen">
                    {' '}
                    <Icon name="clip" size={12} /> {o.file_count}
                  </span>
                )}
              </div>
            </td>
            {showCustomer && (
              <td>
                <a href={`/kunden/${o.customer_id}`}>{o.customer_name}</a>
                <div class="small mut">{o.customer_no}</div>
              </td>
            )}
            <td>
              <div class="small">{deadlineDe(o.submission_deadline)}</div>
              <DeadlineBadge days={o.days_left} status={o.status} />
            </td>
            <td class="r">{euro(o.net_cents)}</td>
            <td class="r">{o.monthly_net_cents > 0n ? euro(o.monthly_net_cents) : '–'}</td>
            <td>
              <OfferBadge s={o.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const OfferList: FC<{ rows: OfferListRow[]; all: OfferListRow[]; active: string; title: string }> = ({
  rows,
  all,
  active,
  title,
}) => {
  const count = (s: OfferStatus) => all.filter((o) => o.status === s).length;
  const urgent = all.filter(
    (o) => o.status === 'entwurf' && o.days_left !== null && o.days_left >= 0 && o.days_left <= 7,
  );
  const tabs: Tab[] = [
    { key: 'offen', label: 'Offen', href: '/angebote', count: count('entwurf') + count('versendet') },
    { key: 'fristen', label: 'Abgabefristen', href: '/angebote?ansicht=fristen', count: urgent.length },
    { key: 'entwurf', label: 'Entwürfe', href: '/angebote?status=entwurf', count: count('entwurf') },
    { key: 'versendet', label: 'Versendet', href: '/angebote?status=versendet', count: count('versendet') },
    {
      key: 'angenommen',
      label: 'Angenommen',
      href: '/angebote?status=angenommen',
      count: count('angenommen'),
    },
    { key: 'alle', label: 'Alle', href: '/angebote?status=alle', count: all.length },
  ];
  const pipeline = all.filter((o) => o.status === 'versendet').reduce((s, o) => s + o.monthly_net_cents, 0n);
  const won = all.filter((o) => o.status === 'angenommen').length;
  const decided = won + count('abgelehnt');
  return (
    <>
      <PageHead title={title} create={{ options: NEW_OPTIONS, selected: 'angebot' }} />
      <div class="kpis">
        <div class="kpi">
          <div class="l">In Arbeit</div>
          <div class="v">{count('entwurf')}</div>
          <div class="s">Angebote im Entwurf</div>
        </div>
        <div class="kpi">
          <div class="l">Fristen ≤ 7 Tage</div>
          <div class="v" style={urgent.length ? 'color:var(--err)' : ''}>
            {urgent.length}
          </div>
          <div class="s">
            <a href="/angebote?ansicht=fristen">Abgabefristen ansehen →</a>
          </div>
        </div>
        <div class="kpi">
          <div class="l">Abgegeben, Entscheidung offen</div>
          <div class="v">{euro(pipeline)}</div>
          <div class="s">monatlich netto ({count('versendet')} Angebote)</div>
        </div>
        <div class="kpi">
          <div class="l">Zuschlagsquote</div>
          <div class="v">{decided ? `${Math.round((won / decided) * 100)} %` : '–'}</div>
          <div class="s">
            {won} von {decided} entschiedenen
          </div>
        </div>
      </div>
      <Tabs tabs={tabs} active={active} />
      <OfferTable rows={rows} />
    </>
  );
};

export const toOfferEditorLine = (l: OfferLineRow): EditorLine => ({
  desc: l.description,
  detail: l.detail ?? '',
  qty: milliToInput(l.quantity_milli),
  unit: l.unit_code,
  price: centsToInput(l.unit_price_cents),
  vat: String(l.vat_rate_bp),
  src: '',
  rec: l.recurring ? '1' : '0',
});

export const OfferEditor: FC<{
  id: string;
  o: Partial<OfferRow>;
  lines: EditorLine[];
  customers: Customer[];
  sites: Site[];
  isNew: boolean;
}> = ({ id, o, lines, customers, sites, isNew }) => {
  const prospects = customers.filter((c) => c.status === 'interessent');
  const clients = customers.filter((c) => c.status !== 'interessent');
  return (
    <>
      <PageHead
        title={isNew ? 'Neues Angebot' : `Angebot ${o.number} bearbeiten`}
        crumbs={[
          ['Angebote', '/angebote'],
          ...(isNew ? [] : ([[`Angebot ${o.number}`, `/angebote/${id}`]] as [string, string][])),
        ]}
      />
      <form method="get" action={`/angebote/${id}/bearbeiten`} class="card">
        <div class="grid">
          <div>
            <label for="kunde">Kunde oder Interessent</label>
            <select id="kunde" name="kunde" onchange="this.form.submit()">
              <option value="">– bitte wählen –</option>
              <optgroup label="Kunden">
                {clients.map((c) => (
                  <option value={c.id} selected={c.id === o.customer_id}>
                    {c.customer_no} · {c.name}
                  </option>
                ))}
              </optgroup>
              {prospects.length > 0 && (
                <optgroup label="Interessenten">
                  {prospects.map((c) => (
                    <option value={c.id} selected={c.id === o.customer_id}>
                      {c.customer_no} · {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <div class="small mut" style="margin-top:4px">
              Neuer Auftraggeber? <a href="/kunden/neu?interessent=1">Interessent anlegen</a>
            </div>
          </div>
          <div>
            <label for="objekt">Objekt (falls vorhanden)</label>
            <select id="objekt" name="objekt" onchange="this.form.submit()" disabled={!o.customer_id}>
              <option value="">– neues / noch kein Objekt –</option>
              {sites.map((s) => (
                <option value={s.id} selected={s.id === o.site_id}>
                  {s.site_no} · {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </form>
      {o.customer_id && (
        <form
          method="post"
          action={`/angebote/${id}`}
          class="card"
          data-autosave={`/angebote/${id}`}
          data-version={String(o.version ?? '')}
        >
          <input type="hidden" name="version" value={String(o.version ?? '')} />
          <input type="hidden" name="customer_id" value={o.customer_id} />
          <input type="hidden" name="site_id" value={o.site_id ?? ''} />
          <h2 style="margin-top:0">Ausschreibung</h2>
          <div class="grid">
            <div style="grid-column:1/-1">
              <label for="title">Titel</label>
              <input
                id="title"
                name="title"
                value={o.title ?? ''}
                placeholder="z. B. Unterhaltsreinigung Grundschule an der Musterstraße"
                required
              />
            </div>
            <div>
              <label for="tender_reference">Vergabenummer</label>
              <input
                id="tender_reference"
                name="tender_reference"
                value={o.tender_reference ?? ''}
                placeholder="z. B. 2026-V-0815"
              />
            </div>
            <div>
              <label for="tender_platform">Vergabeplattform</label>
              <input
                id="tender_platform"
                name="tender_platform"
                list="platforms"
                value={o.tender_platform ?? ''}
              />
              <datalist id="platforms">
                <option value="Bayerischer Vergabemarktplatz" />
                <option value="Vergabeplattform Landeshauptstadt München" />
                <option value="DTVP Deutsches Vergabeportal" />
                <option value="e-Vergabe Bund" />
                <option value="Direktanfrage" />
              </datalist>
            </div>
            <div>
              <label for="submission_deadline">Abgabefrist (Datum, Uhrzeit)</label>
              <input
                id="submission_deadline"
                type="datetime-local"
                name="submission_deadline"
                value={deadlineInput(o.submission_deadline ?? null)}
              />
            </div>
          </div>
          <h2>Angebot</h2>
          <div class="grid">
            <div>
              <label for="offer_date">Angebotsdatum</label>
              <input id="offer_date" type="date" name="offer_date" value={o.offer_date ?? ''} required />
            </div>
            <div>
              <label for="valid_until">Gültig bis (Bindefrist)</label>
              <input id="valid_until" type="date" name="valid_until" value={o.valid_until ?? ''} />
            </div>
          </div>
          <div style="margin:14px 0">
            <label for="intro_text">Einleitungstext</label>
            <textarea
              id="intro_text"
              name="intro_text"
              placeholder="Leer = „wir danken für Ihre Anfrage und bieten Ihnen … an:“"
            >
              {o.intro_text ?? ''}
            </textarea>
          </div>
          <div class="hint" style="margin-bottom:12px">
            Positionen mit <b>monatlich</b> werden bei Zuschlag als Monatspauschale ins Objekt übernommen
            (Monatslauf rechnet sie dann automatisch ab). <b>Einmalig</b> = Sonderleistung, z. B.
            Grundreinigung.
          </div>
          <LineEditor lines={lines} recurring />
          <div style="margin:14px 0 0">
            <label for="closing_text">Schlusstext</label>
            <textarea id="closing_text" name="closing_text">
              {o.closing_text ?? ''}
            </textarea>
          </div>
          <div class="formfoot">
            <a class="btn sec" href={isNew ? '/angebote' : `/angebote/${id}`}>
              Abbrechen
            </a>
            <button class="btn">
              <Icon name="check" /> Angebot speichern
            </button>
          </div>
        </form>
      )}
    </>
  );
};

export const OfferDetail: FC<{
  o: OfferRow;
  lines: OfferLineRow[];
  customer: Customer;
  site: Site | null;
  sites: Site[];
  files: Child;
  fileCount: number;
  history: { at: Date; actor: string; action: string; details: unknown }[];
  invoices: { id: string; number: string | null; status: string; gross_cents: bigint }[];
  today: string;
}> = ({ o, lines, customer, site, sites, files, fileCount, history, invoices, today }) => {
  const recurring = lines.filter((l) => l.recurring);
  const once = lines.filter((l) => !l.recurring);
  const daysLeft = o.submission_deadline
    ? Math.floor((o.submission_deadline.getTime() - Date.now()) / 86400000)
    : null;
  const post = (
    action: string,
    label: Child,
    opts: { cls?: string; hidden?: Record<string, string>; confirm?: string } = {},
  ) => (
    <form
      method="post"
      action={`/angebote/${o.id}/${action}`}
      onsubmit={opts.confirm ? `return confirm(${JSON.stringify(opts.confirm)})` : undefined}
    >
      {Object.entries(opts.hidden ?? {}).map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
      <button class={`btn ${opts.cls ?? 'sec'}`}>{label}</button>
    </form>
  );
  return (
    <>
      <PageHead title={o.title} no={`Angebot ${o.number}`} crumbs={[['Angebote', '/angebote']]}>
        <OfferBadge s={o.status} />
      </PageHead>
      <div class="actions" style="margin-top:-8px">
        {o.status === 'entwurf' && (
          <a class="btn" href={`/angebote/${o.id}/bearbeiten`}>
            Bearbeiten
          </a>
        )}
        <a class="btn sec" href={`/angebote/${o.id}/angebot.pdf`} target="_blank">
          <Icon name="pdf" /> PDF {o.status === 'entwurf' ? '(Entwurf)' : ''}
        </a>
        {o.status === 'entwurf' &&
          post(
            'status',
            <>
              <Icon name="mail" /> Als abgegeben markieren
            </>,
            {
              cls: 'sec',
              hidden: { status: 'versendet' },
              confirm: 'Angebot als abgegeben markieren? Danach ist es nicht mehr änderbar.',
            },
          )}
        {o.status === 'versendet' && (
          <>
            {post(
              'status',
              <>
                <Icon name="check" /> Zuschlag erhalten
              </>,
              { cls: '', hidden: { status: 'angenommen' } },
            )}
            {post('status', 'Absage', {
              hidden: { status: 'abgelehnt' },
              confirm: 'Angebot als abgelehnt markieren?',
            })}
          </>
        )}
        {post('kopieren', 'Als neues Angebot kopieren')}
        {['entwurf', 'versendet'].includes(o.status) &&
          post('status', 'Zurückziehen', {
            cls: 'ghost',
            hidden: { status: 'zurueckgezogen' },
            confirm: 'Angebot zurückziehen?',
          })}
      </div>

      {o.status === 'entwurf' && daysLeft !== null && daysLeft <= 7 && (
        <div class={daysLeft < 0 ? 'warnbox' : 'flash err'} style="display:flex">
          <Icon name="clock" />
          <span>
            {daysLeft < 0 ? 'Abgabefrist ist abgelaufen: ' : 'Abgabefrist läuft bald ab: '}
            <b>{deadlineDe(o.submission_deadline)}</b>
          </span>
        </div>
      )}

      {o.status === 'angenommen' && (
        <div class="card" style="border-color:#bbf7d0;background:var(--ok-50)">
          <h3>Zuschlag – jetzt übernehmen</h3>
          <div class="cols" style="gap:24px">
            <form method="post" action={`/angebote/${o.id}/objekt`}>
              <p class="small" style="margin:0 0 10px">
                {recurring.length} monatliche Position(en) werden <b>Monatspauschalen</b>, {once.length}{' '}
                einmalige werden <b>Sonderleistungen</b> im Objekt. Mehrfaches Ausführen legt nichts doppelt
                an.
              </p>
              <div class="grid">
                <div>
                  <label for="site_id">Objekt</label>
                  <select id="site_id" name="site_id" required>
                    {sites.length === 0 && <option value="">– erst Objekt anlegen –</option>}
                    {sites.map((s) => (
                      <option value={s.id} selected={s.id === o.site_id}>
                        {s.site_no} · {s.name}
                      </option>
                    ))}
                  </select>
                  <div class="small" style="margin-top:4px">
                    <a href={`/neu?typ=objekt&kunde=${o.customer_id}`}>+ Neues Objekt anlegen</a>
                  </div>
                </div>
                <div>
                  <label for="valid_from">Leistungsbeginn</label>
                  <input id="valid_from" type="date" name="valid_from" value={today} required />
                </div>
              </div>
              <div class="actions" style="margin-bottom:0">
                <button class="btn" disabled={sites.length === 0}>
                  Ins Objekt übernehmen
                </button>
              </div>
            </form>
            <div>
              <p class="small" style="margin:0 0 10px">
                Einmalige Leistung (z. B. Grundreinigung)? Direkt einen Rechnungsentwurf mit allen Positionen
                erzeugen.
              </p>
              <div class="actions" style="margin:0">
                {post('auftrag', 'Auftrag anlegen (mit Arbeitsschein)', { cls: '' })}
                {post('rechnung', 'Direkt Rechnungsentwurf')}
              </div>
              {invoices.length > 0 && (
                <div class="small" style="margin-top:8px">
                  Bereits erzeugt:{' '}
                  {invoices.map((i) => (
                    <a href={`/rechnungen/${i.id}`} style="margin-right:8px">
                      {i.number ?? 'Entwurf'} ({euro(i.gross_cents)})
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div class="cols">
        <div>
          <div class="card">
            <h3>
              Ausschreibungsunterlagen <span class="cnt">({fileCount})</span>
            </h3>
            {files}
          </div>
          <div class="card flush">
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Pos.</th>
                    <th>Leistung</th>
                    <th class="r">Menge</th>
                    <th class="r">Einzelpreis</th>
                    <th>Abrechnung</th>
                    <th class="r">Gesamt netto</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr>
                      <td>{l.position}</td>
                      <td>
                        {l.description}
                        {l.detail && (
                          <div class="small mut" style="white-space:pre-line">
                            {l.detail}
                          </div>
                        )}
                      </td>
                      <td class="r">{milliToInput(l.quantity_milli)}</td>
                      <td class="r">{euro(l.unit_price_cents)}</td>
                      <td>
                        {l.recurring ? (
                          <span class="badge kind">monatlich</span>
                        ) : (
                          <span class="badge">einmalig</span>
                        )}
                      </td>
                      <td class="r">{euro(l.net_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <table class="totals" style="margin:8px 0 12px auto">
              <tbody>
                {o.monthly_net_cents > 0n && (
                  <tr>
                    <td class="mut">davon monatlich wiederkehrend</td>
                    <td class="r mut">{euro(o.monthly_net_cents)}</td>
                  </tr>
                )}
                <tr>
                  <td>Summe netto</td>
                  <td class="r">{euro(o.net_cents)}</td>
                </tr>
                <tr>
                  <td>Umsatzsteuer</td>
                  <td class="r">{euro(o.vat_cents)}</td>
                </tr>
                <tr class="sum">
                  <td>Gesamt brutto</td>
                  <td class="r">{euro(o.gross_cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="card">
            <h3>Angaben</h3>
            <dl class="kv">
              <dt>Auftraggeber</dt>
              <dd>
                <a href={`/kunden/${customer.id}`}>{customer.name}</a>
                {customer.status === 'interessent' && (
                  <>
                    {' '}
                    <span class="badge info">Interessent</span>
                  </>
                )}
              </dd>
              <dt>Objekt</dt>
              <dd>{site ? <a href={`/objekte/${site.id}`}>{site.name}</a> : '–'}</dd>
              <dt>Vergabe-Nr.</dt>
              <dd>{o.tender_reference ?? '–'}</dd>
              <dt>Plattform</dt>
              <dd>{o.tender_platform ?? '–'}</dd>
              <dt>Abgabefrist</dt>
              <dd>{deadlineDe(o.submission_deadline)}</dd>
              <dt>Angebotsdatum</dt>
              <dd>{dateDe(o.offer_date)}</dd>
              <dt>Gültig bis</dt>
              <dd>{dateDe(o.valid_until)}</dd>
              <dt>Erstellt</dt>
              <dd>
                {o.created_by}, {o.created_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
              </dd>
            </dl>
          </div>
          <div class="card">
            <h3>Verlauf</h3>
            {history.map((h) => (
              <div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)">
                <span class="mut">
                  {h.at.toLocaleString('de-DE', {
                    timeZone: 'Europe/Berlin',
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>{' '}
                · {h.actor} · {historyText(h.action, h.details)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
};

function historyText(action: string, details: unknown): string {
  const d = (details ?? {}) as Record<string, unknown>;
  switch (action) {
    case 'create':
      return 'angelegt';
    case 'update':
      return 'geändert';
    case 'status':
      return `Status → ${OFFER_STATUS[d.status as OfferStatus] ?? String(d.status)}`;
    case 'accept_into_site':
      return `ins Objekt übernommen (${String(d.services)} neue Leistungen)`;
    case 'to_invoice':
      return 'Rechnungsentwurf erstellt';
    case 'copy':
      return 'kopiert';
    default:
      return action;
  }
}
