import type { Child, FC } from 'hono/jsx';
import { contactGreeting } from '../domain/letter/greeting.js';
import { SiteOptions } from './site-options.js';
import type { Customer, Site } from '../services/masterdata.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import {
  OFFER_CLOSING_DEFAULT,
  OFFER_INTRO_DEFAULT,
  OFFER_STATUS,
  type OfferLineRow,
  type OfferRow,
  type OfferStats,
  OFFER_PERIODS,
  type OfferPeriod,
  type OfferStatus,
} from '../services/offers.js';
import { centsToInput, milliToInput } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro, anz } from './layout.js';
import { type EditorLine, LineEditor, type ServiceTypeOption } from './pages-invoices.js';

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
  aufgehoben: 'warn',
  zurueckgezogen: '',
};

/** Farbe am linken Rand der Listenzeile: Zusage grün, Absage rot, aufgehoben gelb */
const ROW_COLOR: Partial<Record<OfferStatus, string>> = {
  angenommen: '#3b6b4d',
  abgelehnt: '#b42318',
  aufgehoben: '#d4a017',
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

export const OfferTable: FC<{ rows: OfferListRow[]; showCustomer?: boolean; ret?: string }> = ({
  rows,
  showCustomer = true,
  ret,
}) => (
  <div class="tbl offer-list">
    <table>
      <thead>
        <tr>
          <th>Angebot</th>
          <th>{showCustomer ? 'Kunde / Leistung' : 'Leistung'}</th>
          <th class="r">Netto</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={4}>
              <div class="empty">Keine Angebote in dieser Ansicht.</div>
            </td>
          </tr>
        )}
        {rows.map((o) => {
          const sub = [
            o.tender_reference && `Vergabe-Nr. ${o.tender_reference}`,
            o.submission_deadline && o.status === 'entwurf' && `Frist ${deadlineDe(o.submission_deadline)}`,
          ].filter(Boolean);
          return (
            <tr
              class={ROW_COLOR[o.status] ? 'offer-decided' : undefined}
              style={ROW_COLOR[o.status] ? `box-shadow:inset 3px 0 0 ${ROW_COLOR[o.status]}` : undefined}
            >
              <td class="ol-no">
                <a href={`/angebote/${o.id}`}>
                  <b>{o.number}</b>
                </a>
                <div class="small mut">
                  {dateDe(o.offer_date)}
                  {o.file_count > 0 && (
                    <span title="Unterlagen">
                      {' '}
                      <Icon name="clip" size={11} />
                      {o.file_count}
                    </span>
                  )}
                </div>
              </td>
              <td class="ol-main">
                {showCustomer && (
                  <a class="ol-cust" href={`/kunden/${o.customer_id}`} title={o.customer_name}>
                    {o.customer_name}
                  </a>
                )}
                <a class="ol-title" href={`/angebote/${o.id}`} title={o.title}>
                  {o.title}
                </a>
                {sub.length > 0 && (
                  <div class="small mut">
                    {sub.join(' · ')} <DeadlineBadge days={o.days_left} status={o.status} />
                  </div>
                )}
              </td>
              <td class="r ol-sum">
                {euro(o.net_cents)}
                {o.monthly_net_cents > 0n && (
                  <div class="small mut">davon {euro(o.monthly_net_cents)} mtl.</div>
                )}
              </td>
              <td class="ol-st">
                <OfferBadge s={o.status} />
                {ret && ['entwurf', 'versendet'].includes(o.status) && (
                  <form method="post" action={`/angebote/${o.id}/status`} class="offer-quick">
                    <input type="hidden" name="zurueck" value={ret} />
                    {o.status === 'versendet' && (
                      <>
                        <button
                          name="status"
                          value="angenommen"
                          class="q-ok"
                          title="Zusage (Zuschlag erhalten)"
                          data-confirm={`Zusage für Angebot ${o.number} erfassen?`}
                        >
                          Zusage
                        </button>
                        <button
                          name="status"
                          value="abgelehnt"
                          class="q-err"
                          title="Absage"
                          data-confirm={`Absage für Angebot ${o.number} erfassen?`}
                        >
                          Absage
                        </button>
                      </>
                    )}
                    <button
                      name="status"
                      value="aufgehoben"
                      class="q-warn"
                      title="Ausschreibung/Anfrage vom Auftraggeber aufgehoben"
                      data-confirm={`Angebot ${o.number} als aufgehoben markieren?`}
                    >
                      Aufgehoben
                    </button>
                  </form>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export const OfferList: FC<{
  rows: OfferListRow[];
  all: OfferListRow[];
  active: string;
  title: string;
  stats: OfferStats;
  period?: OfferPeriod;
  tenders?: number;
  /** Adresse der Liste für den Rücksprung nach einer Schnellmarkierung */
  ret?: string;
  q?: string;
  page?: number;
}> = ({ rows, all, active, title, stats, tenders, period = '12m', ret = '/angebote', q = '', page = 1 }) => {
  const PER = 25;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const cur = Math.min(Math.max(1, page), pages);
  const shown = rows.slice((cur - 1) * PER, cur * PER);
  const pageUrl = (n: number) => {
    const u = new URL(ret, 'http://x');
    if (n > 1) u.searchParams.set('seite', String(n));
    else u.searchParams.delete('seite');
    return u.pathname + u.search;
  };
  const plabel = OFFER_PERIODS[period];
  const count = (s: OfferStatus) => all.filter((o) => o.status === s).length;
  const tabs: Tab[] = [
    { key: 'offen', label: 'Offen', href: '/angebote', count: count('entwurf') + count('versendet') },
    { key: 'fristen', label: 'Ausschreibungen', href: '/ausschreibungen', count: tenders ?? 0 },
    { key: 'entwurf', label: 'Entwürfe', href: '/angebote?status=entwurf', count: count('entwurf') },
    { key: 'versendet', label: 'Versendet', href: '/angebote?status=versendet', count: count('versendet') },
    {
      key: 'angenommen',
      label: 'Angenommen',
      href: '/angebote?status=angenommen',
      count: count('angenommen'),
    },
    { key: 'abgelehnt', label: 'Abgelehnt', href: '/angebote?status=abgelehnt', count: count('abgelehnt') },
    {
      key: 'aufgehoben',
      label: 'Aufgehoben',
      href: '/angebote?status=aufgehoben',
      count: count('aufgehoben'),
    },
    { key: 'alle', label: 'Alle', href: '/angebote?status=alle', count: all.length },
  ];
  const pipeline = all.filter((o) => o.status === 'versendet').reduce((s, o) => s + o.monthly_net_cents, 0n);
  return (
    <>
      <PageHead title={title}>
        <a class="btn" href="/angebote/neu">
          + Angebot anlegen
        </a>
      </PageHead>
      <div class="kpis">
        <div class="kpi">
          <div class="l">In Arbeit</div>
          <div class="v">{count('entwurf')}</div>
          <div class="s">Angebote im Entwurf</div>
        </div>
        <div class="kpi">
          <div class="l">Ausschreibungen</div>
          <div class="v">{tenders ?? 0}</div>
          <div class="s">
            <a href="/ausschreibungen">Abgabefristen, Besichtigungen, Bieterfragen →</a>
          </div>
        </div>
        <div class="kpi">
          <div class="l">Abgegeben, Entscheidung offen</div>
          <div class="v">{euro(pipeline)}</div>
          <div class="s">monatlich netto ({count('versendet')} Angebote)</div>
        </div>
        <div class="kpi">
          <div class="l">Zuschlagsquote ({plabel})</div>
          <div class="v">{stats.rate == null ? '–' : `${stats.rate} %`}</div>
          <div class="s">
            nach Anzahl ({stats.accepted.count} von {stats.accepted.count + stats.rejected.count}) ·{' '}
            <b>
              nach Umsatz {stats.rateValue == null ? '–' : `${String(stats.rateValue).replace('.', ',')} %`}
            </b>
          </div>
        </div>
      </div>
      <details class="card offer-stats" style="margin-bottom:16px">
        <summary>
          Statistik: {plabel} · {stats.accepted.count} angenommen, {stats.rejected.count} abgelehnt
        </summary>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0">
          <span style="flex:1" />
          {(Object.keys(OFFER_PERIODS) as OfferPeriod[]).map((k) => (
            <a class={`chip ${k === period ? 'on' : ''}`} href={`/angebote?zeitraum=${k}`}>
              {OFFER_PERIODS[k]}
            </a>
          ))}
        </div>
        <p class="small mut" style="margin-top:0">
          Angenommen/abgelehnt/aufgehoben nach dem Tag der Entscheidung, offene nach Angebotsdatum.
        </p>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th class="r">Anzahl</th>
                <th class="r">Summe netto</th>
                <th class="r">davon monatlich</th>
                <th style="width:35%"></th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['offen (Entwurf/versendet)', stats.open, '#9aa1ad', '/angebote'],
                  ['angenommen', stats.accepted, '#3b6b4d', '/angebote?status=angenommen'],
                  ['abgelehnt', stats.rejected, '#b42318', '/angebote?status=abgelehnt'],
                  [
                    'aufgehoben (nicht in der Quote)',
                    stats.cancelled,
                    '#d4a017',
                    '/angebote?status=aufgehoben',
                  ],
                ] as const
              ).map(([label, v, color, href]) => {
                const total =
                  stats.open.count + stats.accepted.count + stats.rejected.count + stats.cancelled.count || 1;
                return (
                  <tr>
                    <td>
                      <a href={href}>{label}</a>
                    </td>
                    <td class="r">{v.count}</td>
                    <td class="r">{euro(v.net)}</td>
                    <td class="r">{euro(v.monthly)}</td>
                    <td>
                      <div
                        style={`height:10px;border-radius:3px;background:${color};width:${Math.round((v.count * 100) / total)}%`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {stats.withdrawn > 0 && (
          <p class="small mut" style="margin-bottom:0">
            Zurückgezogen bzw. durch Folgeangebot ersetzt: {stats.withdrawn} (nicht in der Quote).
          </p>
        )}
      </details>
      <Tabs tabs={tabs} active={active} />
      <form method="get" action="/angebote" class="offer-search">
        {active !== 'offen' && <input type="hidden" name="status" value={active} />}
        <input
          type="search"
          name="q"
          value={q}
          placeholder="Suchen: Nr., Kunde, Leistung …"
          aria-label="Angebote durchsuchen"
        />
        <button class="btn sec sm">Suchen</button>
        {q && (
          <a class="btn ghost sm" href={active === 'offen' ? '/angebote' : `/angebote?status=${active}`}>
            Suche aufheben
          </a>
        )}
        <span class="small mut" style="margin-left:auto">
          {rows.length === 0
            ? 'keine Treffer'
            : `${(cur - 1) * PER + 1}–${(cur - 1) * PER + shown.length} von ${rows.length}`}
        </span>
      </form>
      <OfferTable rows={shown} ret={ret} />
      {pages > 1 && (
        <div class="pager">
          {cur > 1 && <a href={pageUrl(cur - 1)}>‹ Zurück</a>}
          {Array.from({ length: pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === pages || Math.abs(n - cur) <= 2)
            .map((n, i, arr) => (
              <>
                {i > 0 && n - arr[i - 1]! > 1 && <span class="gap">…</span>}
                <a href={pageUrl(n)} class={n === cur ? 'on' : ''}>
                  {n}
                </a>
              </>
            ))}
          {cur < pages && <a href={pageUrl(cur + 1)}>Vor ›</a>}
        </div>
      )}
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
  rec: String((l.recurring ? 1 : 0) + (l.alternative ? 2 : 0)),
  stype: l.service_type_id ?? '',
});

export const OfferEditor: FC<{
  id: string;
  o: Partial<OfferRow>;
  lines: EditorLine[];
  customers: Customer[];
  recent?: { id: string; name: string; customer_no: string }[];
  sites: Site[];
  isNew: boolean;
  tenderId?: string | null;
  types?: ServiceTypeOption[];
}> = ({ id, o, lines, customers, sites, isNew, recent = [], tenderId = null, types }) => {
  const prospects = customers.filter((c) => c.status === 'interessent' && c.active);
  const clients = customers.filter((c) => c.status !== 'interessent' && c.active);
  const former = customers.filter((c) => !c.active);
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
        {tenderId && <input type="hidden" name="ausschreibung" value={tenderId} />}
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
              {former.length > 0 && (
                <optgroup label="Ehemalige Kunden">
                  {former.map((c) => (
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
            {!o.customer_id && recent.length > 0 && (
              <div class="small" style="margin-top:8px">
                Zuletzt bearbeitet:{' '}
                {recent.map((r) => (
                  <a
                    class="badge info"
                    style="margin:2px 4px 2px 0;text-decoration:none"
                    href={`/angebote/${id}/bearbeiten?kunde=${r.id}`}
                  >
                    {r.name}
                  </a>
                ))}
              </div>
            )}
          </div>
          <div>
            <label for="objekt">Objekt (falls vorhanden)</label>
            <select id="objekt" name="objekt" onchange="this.form.submit()" disabled={!o.customer_id}>
              <option value="">– neues / noch kein Objekt –</option>
              <SiteOptions sites={sites} selected={o.site_id} />
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
          {tenderId && <input type="hidden" name="tender_id" value={tenderId} />}
          <input type="hidden" name="customer_id" value={o.customer_id} />
          <input type="hidden" name="site_id" value={o.site_id ?? ''} />
          {!o.site_id && (
            <div class="grid">
              <div>
                <label for="object_text">Objekt (Freitext)</label>
                <input
                  id="object_text"
                  name="object_text"
                  maxlength={500}
                  value={o.object_text ?? ''}
                  placeholder="z. B. Bürogebäude Musterstr. 5, 80331 München"
                />
                <p class="help">Nur als Angabe auf dem Angebot – es wird kein Objekt angelegt.</p>
              </div>
            </div>
          )}
          {(tenderId || o.tender_reference || o.tender_platform || o.submission_deadline) && (
            <>
              <h2 style="margin-top:0">Ausschreibung</h2>
              <p class="help" style="margin-top:0">
                Fristen und Unterlagen verwalten Sie unter Angebote → Ausschreibungen.
              </p>
              <div class="grid">
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
            </>
          )}
          <h2>Angebot</h2>
          <div class="grid">
            {/* kein Titel/Betreff mehr (Ahmed 15.10.) – Titel ergibt sich aus der ersten Position */}
            <input type="hidden" id="title" name="title" value={o.title ?? ''} />

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
          <LineEditor lines={lines} recurring types={types} />
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
  contact: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  split?: { label: string; net: bigint; vat: bigint; gross: bigint }[] | null;
  related?: {
    predecessor: { id: string; number: string } | null;
    successor: { id: string; number: string } | null;
  };
}> = ({
  o,
  lines,
  customer,
  site,
  sites,
  files,
  fileCount,
  history,
  invoices,
  today,
  contact,
  contactPhone,
  contactEmail,
  split,
  related,
}) => {
  const recurring = lines.filter((l) => l.recurring && !l.alternative);
  const once = lines.filter((l) => !l.recurring && !l.alternative);
  const alternatives = lines.filter((l) => l.alternative);
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
  const accepted = o.status === 'angenommen';
  const vatRates = [...new Set(lines.map((l) => l.vat_rate_bp))];
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LETTER_CSS }} />
      <PageHead
        title={`Angebot ${o.number}`}
        no={o.title}
        crumbs={[
          ['Angebote', '/angebote'],
          [`${customer.customer_no} ${customer.name}`, `/kunden/${customer.id}`],
        ]}
      >
        <OfferBadge s={o.status} />
      </PageHead>

      {o.status === 'entwurf' && daysLeft !== null && daysLeft <= 7 && (
        <div class={daysLeft < 0 ? 'warnbox' : 'flash err'} style="display:flex">
          <Icon name="clock" />
          <span>
            {daysLeft < 0 ? 'Abgabefrist ist abgelaufen: ' : 'Abgabefrist läuft bald ab: '}
            <b>{deadlineDe(o.submission_deadline)}</b>
          </span>
        </div>
      )}

      <div class="cols">
        <div>
          {/* Briefansicht wie im PDF */}
          <div class="card letter">
            <div class="addr">
              <b>{customer.name}</b>
              {customer.name2 && <div>{customer.name2}</div>}
              {customer.contact_name && <div>z. Hd. {customer.contact_name}</div>}
              <div>{customer.street}</div>
              <div>
                {customer.postal_code} {customer.city}
              </div>
            </div>
            <div class="band">
              <div class="t">Angebot {o.number}</div>
              <dl>
                <dt>Datum</dt>
                <dd>{dateDe(o.offer_date)}</dd>
                <dt>Kundennummer</dt>
                <dd>
                  <a href={`/kunden/${customer.id}`}>{customer.customer_no}</a>
                </dd>
                <dt>Ansprechpartner</dt>
                <dd>
                  {contact}
                  {contactPhone && <div class="small">Tel. {contactPhone}</div>}
                  {contactEmail && <div class="small">{contactEmail}</div>}
                </dd>
                {o.tender_reference && (
                  <>
                    <dt>Vergabe-Nr.</dt>
                    <dd>{o.tender_reference}</dd>
                  </>
                )}
                {o.valid_until && (
                  <>
                    <dt>Gültig bis</dt>
                    <dd>{dateDe(o.valid_until)}</dd>
                  </>
                )}
              </dl>
            </div>
            {(site || o.object_text) && (
              <p>
                <b>
                  Objekt:{' '}
                  {site
                    ? `${site.name} (${site.site_no})${[
                        site.street,
                        [site.postal_code, site.city].filter(Boolean).join(' '),
                      ]
                        .filter(Boolean)
                        .map((x) => `, ${x}`)
                        .join('')}`
                    : o.object_text}
                </b>
              </p>
            )}
            <p>{contactGreeting(customer.contact_name)}</p>
            <p style="white-space:pre-line">{o.intro_text ?? OFFER_INTRO_DEFAULT}</p>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Pos</th>
                    <th>Text</th>
                    <th class="r">Menge</th>
                    <th>Einheit</th>
                    <th class="r">Einzelpreis</th>
                    <th class="r">Gesamtpreis</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr class={l.alternative ? 'alt' : ''}>
                      <td>{l.position}</td>
                      <td>
                        {l.alternative && <span class="badge warn">Alternative</span>} <b>{l.description}</b>
                        {l.detail && (
                          <div class="small" style="white-space:pre-line">
                            {l.detail}
                          </div>
                        )}
                        <div class="small mut">{l.recurring ? 'monatlich' : 'einmalig'}</div>
                      </td>
                      <td class="r">{milliToInput(l.quantity_milli)}</td>
                      <td>{l.unit_code === 'LS' ? 'pauschal' : (UNIT_LABELS[l.unit_code] ?? l.unit_code)}</td>
                      <td class="r">{euro(l.unit_price_cents)}</td>
                      <td class="r">{l.alternative ? `(${euro(l.net_cents)})` : euro(l.net_cents)}</td>
                    </tr>
                  ))}
                  {!lines.length && (
                    <tr>
                      <td colspan={6} class="mut">
                        Noch keine Positionen.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <table class="totals" style="margin:8px 0 12px auto">
              <tbody>
                {split ? (
                  split.map((t) => (
                    <>
                      <tr>
                        <td>
                          <b>{t.label} netto</b>
                        </td>
                        <td class="r">{euro(t.net)}</td>
                      </tr>
                      <tr>
                        <td>zzgl. MwSt {vatRates.length === 1 ? `(${vatRates[0]! / 100}%)` : ''}</td>
                        <td class="r">{euro(t.vat)}</td>
                      </tr>
                      <tr class="sum">
                        <td>{t.label} brutto</td>
                        <td class="r">
                          <span class="hl">{euro(t.gross)}</span>
                        </td>
                      </tr>
                    </>
                  ))
                ) : (
                  <>
                    <tr>
                      <td>Gesamt netto</td>
                      <td class="r">{euro(o.net_cents)}</td>
                    </tr>
                    <tr>
                      <td>zzgl. MwSt {vatRates.length === 1 ? `(${vatRates[0]! / 100}%)` : ''}</td>
                      <td class="r">{euro(o.vat_cents)}</td>
                    </tr>
                    <tr class="sum">
                      <td>Gesamtbetrag</td>
                      <td class="r">
                        <span class="hl">{euro(o.gross_cents)}</span>
                      </td>
                    </tr>
                  </>
                )}
                {alternatives.length > 0 && (
                  <tr>
                    <td class="mut small" colspan={2}>
                      {anz(alternatives.length, 'Alternativposition', 'Alternativpositionen')} – nicht in der
                      Summe
                    </td>
                  </tr>
                )}
                {o.monthly_net_cents > 0n && !split && (
                  <tr>
                    <td class="mut small">davon monatlich wiederkehrend (netto)</td>
                    <td class="r mut small">{euro(o.monthly_net_cents)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p style="white-space:pre-line">{o.closing_text ?? OFFER_CLOSING_DEFAULT}</p>
            <p class="meta">
              Erstellt von {contact} (
              {o.created_at.toLocaleString('de-DE', {
                timeZone: 'Europe/Berlin',
                dateStyle: 'short',
                timeStyle: 'short',
              })}
              )
            </p>
          </div>

          {accepted && (
            <form method="post" action={`/angebote/${o.id}/objekt`} class="card">
              <h3>Leistungen ins Objekt übernehmen</h3>
              <p class="small mut" style="margin-top:0">
                {anz(
                  recurring.length,
                  'monatliche Position wird Monatspauschale',
                  'monatliche Positionen werden Monatspauschalen',
                )}
                , {anz(once.length, 'einmalige wird Sonderleistung', 'einmalige werden Sonderleistungen')} im
                Objekt
                {alternatives.length
                  ? `; ${anz(alternatives.length, 'Alternative wird', 'Alternativen werden')} nicht übernommen`
                  : ''}
                . Mehrfaches Ausführen legt nichts doppelt an.
              </p>
              <div class="grid">
                <div>
                  <label for="site_id">Objekt</label>
                  <select id="site_id" name="site_id" required>
                    {sites.length === 0 && <option value="">– erst Objekt anlegen –</option>}
                    <SiteOptions sites={sites} selected={o.site_id} />
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
                <button class="btn sec" disabled={sites.length === 0}>
                  Ins Objekt übernehmen
                </button>
              </div>
            </form>
          )}
        </div>
        <div>
          {/* Aktionen wie in Fortytools: ein Block rechts oben */}
          <div class="actstack">
            {o.status === 'entwurf' && <a href={`/angebote/${o.id}/bearbeiten`}>Bearbeiten</a>}
            <a href={`/angebote/${o.id}/angebot.pdf`} target="_blank">
              <Icon name="pdf" /> PDF herunterladen
            </a>
            {['entwurf', 'versendet'].includes(o.status) &&
              !related?.successor &&
              post('folgeangebot', 'Folgeangebot erstellen (überarbeitete Fassung)')}
            {post('kopieren', 'Kopieren (neues Angebot)')}
            {o.status === 'entwurf' &&
              post('status', 'Als abgegeben markieren', {
                hidden: { status: 'versendet' },
                confirm: 'Angebot als abgegeben markieren? Danach ist es nicht mehr änderbar.',
              })}
            {o.status === 'versendet' && (
              <>
                {post('status', 'Zuschlag erhalten (angenommen)', { hidden: { status: 'angenommen' } })}
                {post('status', 'Absage (abgelehnt)', {
                  hidden: { status: 'abgelehnt' },
                  confirm: 'Angebot als abgelehnt markieren?',
                })}
              </>
            )}
            {['entwurf', 'versendet'].includes(o.status) &&
              post('status', 'Aufgehoben (Vergabe/Anfrage aufgehoben)', {
                hidden: { status: 'aufgehoben' },
                confirm: 'Angebot als aufgehoben markieren? Es zählt dann nicht in der Zuschlagsquote.',
              })}
            {['abgelehnt', 'aufgehoben'].includes(o.status) && (
              <>
                {o.status === 'abgelehnt'
                  ? post('status', 'Korrektur: war aufgehoben', { hidden: { status: 'aufgehoben' } })
                  : post('status', 'Korrektur: war eine Absage', { hidden: { status: 'abgelehnt' } })}
                {post('status', 'Korrektur: doch Zusage', {
                  hidden: { status: 'angenommen' },
                  confirm: 'Angebot als angenommen markieren?',
                })}
                {post('status', 'Entscheidung zurücknehmen (wieder offen)', {
                  cls: 'quiet',
                  hidden: { status: 'versendet' },
                  confirm: 'Entscheidung zurücknehmen? Das Angebot ist dann wieder „versendet“.',
                })}
              </>
            )}
            {accepted && post('auftrag', 'Auftrag erstellen (mit Arbeitsschein)')}
            {accepted && post('rechnung', 'Rechnung erstellen (Entwurf)')}
            {['entwurf', 'versendet'].includes(o.status) &&
              post('status', 'Zurückziehen', {
                cls: 'quiet',
                hidden: { status: 'zurueckgezogen' },
                confirm: 'Angebot zurückziehen?',
              })}
          </div>
          {(related?.predecessor || related?.successor || invoices.length > 0) && (
            <div class="actstack-note">
              {related?.predecessor && (
                <div>
                  Folgeangebot zu{' '}
                  <a href={`/angebote/${related.predecessor.id}`}>Angebot {related.predecessor.number}</a>
                </div>
              )}
              {related?.successor && (
                <div>
                  Ersetzt durch Folgeangebot{' '}
                  <a href={`/angebote/${related.successor.id}`}>Angebot {related.successor.number}</a>
                </div>
              )}
              {invoices.length > 0 && (
                <div>
                  Rechnungen aus diesem Angebot:{' '}
                  {invoices.map((i) => (
                    <a href={`/rechnungen/${i.id}`} style="margin-right:8px">
                      {i.number ?? 'Entwurf'} ({euro(i.gross_cents)})
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          <div class="card">
            <h3>Ausschreibung</h3>
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
              <dd>{site ? <a href={`/objekte/${site.id}`}>{site.name}</a> : (o.object_text ?? '–')}</dd>
              <dt>Bezeichnung</dt>
              <dd>{o.title}</dd>
              <dt>Vergabe-Nr.</dt>
              <dd>{o.tender_reference ?? '–'}</dd>
              <dt>Plattform</dt>
              <dd>{o.tender_platform ?? '–'}</dd>
              <dt>Abgabefrist</dt>
              <dd>{deadlineDe(o.submission_deadline)}</dd>
            </dl>
          </div>
          <div class="card">
            <h3>
              Anhänge / Ausschreibungsunterlagen <span class="cnt">({fileCount})</span>
            </h3>
            {files}
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

/** Briefansicht: angelehnt an Fortytools und unser PDF (Adresse, grauer Titelbalken, Tabelle, Summen). */
const LETTER_CSS = `.letter tr.alt td{color:var(--mut)}

.letter{padding:28px 32px}
.letter .addr{font-size:14px;line-height:1.5;margin-bottom:22px}
.letter .band{background:#eef0f3;margin:0 -32px 20px;padding:16px 32px;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.letter .band .t{font-size:28px;font-weight:600;letter-spacing:-.01em}
.letter .band dl{display:grid;grid-template-columns:auto auto;gap:2px 18px;margin:0;font-size:13px}
.letter .band dt{color:var(--mut)}.letter .band dd{margin:0;font-weight:600}
.letter p{font-size:14px;margin:0 0 12px}
.letter .hl{background:var(--brand-50);color:var(--brand);padding:2px 8px;border-radius:6px}
.letter .meta{font-size:12px;color:var(--mut);text-align:right;margin-top:18px}
@media (max-width:700px){.letter{padding:18px}.letter .band{margin:0 -18px 16px;padding:12px 18px}}
`;

function historyText(action: string, details: unknown): string {
  const d = (details ?? {}) as Record<string, unknown>;
  switch (action) {
    case 'create':
      return 'angelegt';
    case 'update':
      return 'geändert';
    case 'status':
      return `Status → ${OFFER_STATUS[d.status as OfferStatus] ?? String(d.status)}${d.replaced_by ? ' (durch Folgeangebot ersetzt)' : ''}`;
    case 'accept_into_site':
      return `ins Objekt übernommen (${String(d.services)} neue Leistungen)`;
    case 'to_invoice':
      return 'Rechnungsentwurf erstellt';
    case 'copy':
      return 'kopiert';
    case 'follow_up':
      return 'Folgeangebot erstellt';
    case 'to_order':
      return 'Auftrag erstellt';
    default:
      return action;
  }
}
