import { createHash, randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import { ensureGeneralSite } from '../services/fortytools-more-import.js';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { getCookie, setCookie } from 'hono/cookie';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { signSession, verifySession } from '../services/employee-auth.js';
import { ADVANCE_METHOD, deleteAdvance, listAdvances, saveAdvance } from '../services/advances.js';
import { listIncoming } from '../services/purchasing.js';
import { BusinessError } from '../services/errors.js';
import { listHandovers } from '../services/handovers.js';
import {
  WEEKDAYS,
  addClosure,
  addSchoolClosures,
  dayAmounts,
  deleteClosure,
  listClosures,
  countDays,
  workDaysLabel,
} from '../services/subcontract-days.js';
import { SCHOOL_DATA_UNTIL } from '../domain/time/school-holidays.js';
import {
  addPriceChange,
  BILLING,
  complianceOverview,
  compliancePdf,
  createPortalAccess,
  type DocState,
  DOC_STATE as DOC_STATE_LABEL,
  docTypes,
  documentFile,
  evaluate,
  FREQUENCY,
  getSubcontract,
  getSubcontractor,
  LEGAL_FORMS,
  listSubcontracts,
  listSupplierContacts,
  saveSupplierContact,
  deleteSupplierContact,
  OVERALL,
  type Overall,
  portalLogin,
  portalSupplier,
  requestText,
  reviewDocument,
  revokePortal,
  revokeTermination,
  saveSubcontract,
  SC_STATUS,
  SERVICE_DESCRIPTIONS,
  setSubcontractStatus,
  subcontractPdf,
  type SupplierDocument,
  terminate,
  TERMINATION_REASONS,
  terminationPdf,
  uploadDocument,
  uploadSignedSubcontract,
  signSubcontract,
  subcontractTotal,
} from '../services/subcontractors.js';
import { type AppEnv, type Ctx, assertSite, officeSecret, UUID } from './app.js';
import { arr, centsToInput, str } from './forms.js';
import { CSS as MOBILE_CSS } from './m/routes-mobile.js';
import { HandoverTable } from './routes-handovers.js';
import { PageHead, Pager, Tabs, dateDe, euro, type Tab, anz } from './layout.js';
import { FileArea } from './files.js';
import {
  isNuDoc,
  NU_DOCS,
  type NuDocKind,
  nuDocPdf,
  personnelListXlsx,
  storeNuDoc,
} from '../services/nu-docs.js';
import {
  addSubcontractSites,
  saveSubcontractSites,
  objectCosts,
  sammelSummaries,
  sammelTotals,
  sqmCenti,
  subcontractSites,
} from '../services/subcontract-sites.js';
import { listFiles } from '../services/uploads.js';
import {
  OTHER_ORDER,
  billingTracking,
  isRecurringOrder,
  skipExpected,
  unskipExpected,
} from '../services/expected-invoices.js';
import { listServiceTypes } from '../services/masterdata.js';
import {
  addSubcontractHours,
  deleteSubcontractHours,
  hoursOfMonth,
  listSubcontractHours,
  type SubcontractHourRow,
} from '../services/subcontract-hours.js';
import { Icon } from './icons.js';
import { parseHours } from './routes-facility.js';
import { SIGN_JS } from './routes-orders.js';
import { fullName } from '../services/users.js';

/** Nachweis-Art → automatisch ausfüllbare Vorlage */
const NACHWEIS_TEMPLATE: Record<string, string> = {
  vertrag: 'rahmenvertrag',
  selbstauskunft: 'selbstauskunft',
  milog: 'mindestlohn',
  tarif: 'tarif',
  personal: 'personaleinsatzliste',
};

const pdfResponse = (pdf: Uint8Array, name: string) =>
  new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, no-cache',
    },
  });
// Bestellformular: Felder je nach Auswahl ein-/ausblenden (Ahmed 23.10.)
const SC_FORM_JS = `(function(){var b=document.getElementById('billing'),m=document.getElementById('sammel-art');if(!b)return;
function sh(el,on){if(!el)return;el.hidden=!on;}
function u(){var v=b.value,sam=m?m.value==='1':false;
sh(document.getElementById('wd-box'),v==='tag');sh(document.getElementById('maxh-box'),v==='stunde');sh(document.getElementById('margin-box'),v==='umsatz');
document.querySelectorAll('.sammel-only').forEach(function(e){sh(e,sam)});
var kun=m?m.value==='kunde':false;document.querySelectorAll('.kunde-only').forEach(function(e){sh(e,kun)});
document.querySelectorAll('.single-only').forEach(function(e){sh(e,!m||(!sam&&!kun))});
var st=document.getElementById('site');if(st&&m)st.required=!sam&&!kun&&st.required;
var bk=document.getElementById('bestell-kunde'),ba=document.getElementById('bestell-auftrag');
if(bk&&ba){Array.prototype.forEach.call(ba.options,function(o){if(o.value)o.hidden=!!bk.value&&o.getAttribute('data-kunde')!==bk.value;});
if(ba.selectedOptions[0]&&ba.selectedOptions[0].hidden)ba.value='';}
var pb=document.getElementById('price-box'),pi=document.getElementById('price');
var hideP=sam&&(v==='qm'||v==='pauschale_monat'||v==='umsatz');sh(pb,!hideP&&v!=='umsatz');if(pi)pi.required=!hideP&&v!=='umsatz'&&!pi.disabled;}
b.addEventListener('change',u);if(m)m.addEventListener('change',u);var bk0=document.getElementById('bestell-kunde');if(bk0)bk0.addEventListener('change',u);window.addEventListener('pageshow',u);u();setTimeout(u,300);})();`;

const PORTAL_COOKIE = 'vd_np';

export function registerSubcontractorRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const pendingCount = async () =>
    Number(
      (
        await sql<
          { n: number }[]
        >`select count(*)::int as n from app.supplier_documents where status = 'zu_pruefen'`
      )[0]!.n,
    );
  const portalUrl = (token: string | null) =>
    token ? `${(env.PUBLIC_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')}/np/${token}` : null;

  // Reiter eines Nachunternehmers (wie die alte App): Übersicht, Nachweise je Kategorie, Aufträge, Kontakte, Dokumente
  const CAT_SLUG: Record<string, string> = {
    Stammdokumente: 'stammdokumente',
    Unbedenklichkeit: 'unbedenklichkeit',
    Mindestlohn: 'mindestlohn',
  };
  const SLUG_CAT = Object.fromEntries(Object.entries(CAT_SLUG).map(([k, v]) => [v, k])) as Record<
    string,
    string
  >;
  const SubTabs: FC<{ id: string; active: string; counts?: Record<string, string> }> = ({
    id,
    active,
    counts,
  }) => (
    <Tabs
      active={active}
      tabs={
        [
          { key: 'uebersicht', label: 'Übersicht', href: `/lieferanten/${id}/nachweise` },
          ...Object.entries(CAT_SLUG).map(([label, slug]) => ({
            key: slug,
            label: counts?.[slug] ? `${label} ${counts[slug]}` : label,
            href: `/lieferanten/${id}/nachweise/${slug}`,
          })),
          { key: 'auftraege', label: 'Bestellungen', href: `/lieferanten/${id}/auftraege` },
          { key: 'vorschuesse', label: 'Vorschüsse', href: `/lieferanten/${id}/vorschuesse` },
          { key: 'ansprechpartner', label: 'Ansprechpartner', href: `/lieferanten/${id}/ansprechpartner` },
          { key: 'dokumente', label: 'Dokumente', href: `/lieferanten/${id}/dokumente` },
        ] as Tab[]
      }
    />
  );
  /** „5/6“ Pflicht je Kategorie für die Reiter */
  const catCounts = (rows: { type: { category: string }; required: boolean; state: DocState }[]) => {
    const out: Record<string, string> = {};
    for (const [label, slug] of Object.entries(CAT_SLUG)) {
      const req = rows.filter((r) => r.type.category === label && r.required);
      const fine = req.filter((r) => r.state === 'gueltig' || r.state === 'laeuft_ab').length;
      out[slug] = `${fine}/${req.length}`;
    }
    return out;
  };
  const subHead = (s: { id: string; name: string; supplier_no: string }) => (
    <PageHead title={s.name} no={s.supplier_no} crumbs={[['Nachunternehmer', '/nachunternehmer']]}>
      <a class="btn sec" href={`/lieferanten/${s.id}/bearbeiten`} style="margin-left:auto">
        Stammdaten bearbeiten
      </a>
    </PageHead>
  );

  // ------------------------------------------------------------------ Listen
  // Nachunternehmer und Lieferanten getrennt (Ahmed 10.10.): Nachunternehmer mit Nachweis-Ampel als kompakte
  // Tabelle, Lieferanten als einfache Liste. Alte Links /lieferanten?art=nachunternehmer leiten um.
  const supplierList = async (c: Context<AppEnv>, mode: 'nachunternehmer' | 'lieferant') => {
    const q = c.req.query();
    const nuMode = mode === 'nachunternehmer';
    const filter = nuMode && q.filter && q.filter in OVERALL ? (q.filter as Overall) : null;
    const showInactive = q.inaktiv === '1';
    const search = (q.q ?? '').trim().toLowerCase();
    const base = nuMode ? '/nachunternehmer' : '/lieferanten';
    const [compliance, suppliers, openOrders, pending] = await Promise.all([
      nuMode ? complianceOverview(sql) : Promise.resolve([]),
      sql<
        {
          id: string;
          supplier_no: string;
          name: string;
          kind: 'lieferant' | 'nachunternehmer';
          active: boolean;
          city: string | null;
          postal_code: string | null;
          phone: string | null;
          email: string | null;
          contact_name: string | null;
          terminated_on: string | null;
        }[]
      >`select id, supplier_no, name, kind, active, city, postal_code, phone, email, contact_name, terminated_on
          from app.suppliers where kind = ${mode} order by name`,
      sql<{ supplier_id: string; n: number }[]>`
        select supplier_id, count(*)::int as n from (
          select supplier_id from app.subcontracts where status in ('entwurf', 'erteilt')
          union all
          select supplier_id from app.purchase_orders where status in ('entwurf', 'bestellt')) x
         group by supplier_id`,
      nuMode ? pendingCount() : Promise.resolve(0),
    ]);
    const comp = new Map(compliance.map((r) => [r.supplier.id, r]));
    const orders = new Map(openOrders.map((r) => [r.supplier_id, r.n]));
    const statusOf = (s: (typeof suppliers)[number]): Overall =>
      !s.active ? 'inaktiv' : nuMode ? (comp.get(s.id)?.overall ?? 'kritisch') : 'ok';
    const active = suppliers.filter((s) => s.active);
    const n = (o: Overall) => active.filter((s) => statusOf(s) === o).length;
    const rank: Record<string, number> = { kritisch: 0, warnung: 1, ok: 2, inaktiv: 4 };
    const rows = suppliers
      .filter((s) => (showInactive || filter === 'inaktiv' ? true : s.active))
      .filter((s) => !filter || statusOf(s) === filter)
      .filter(
        (s) =>
          !search ||
          [s.name, s.supplier_no, s.contact_name, s.city].some((v) => v?.toLowerCase().includes(search)),
      )
      .sort((a, b) =>
        nuMode
          ? rank[statusOf(a)]! - rank[statusOf(b)]! || a.name.localeCompare(b.name, 'de')
          : a.name.localeCompare(b.name, 'de'),
      );
    const due = compliance
      .filter((r) => r.supplier.active && !r.supplier.terminated_on)
      .flatMap((r) => r.due.map((d) => ({ ...d, supplier: r.supplier })))
      .filter((d) => d.days <= 14)
      .sort((a, b) => a.days - b.days);
    const expired = due.filter((d) => d.days < 0).length;
    const link = (over: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const all: Record<string, string | null> = {
        filter,
        q: search || null,
        inaktiv: showInactive ? '1' : null,
        ...over,
      };
      for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
      const str = p.toString();
      return `${base}${str ? `?${str}` : ''}`;
    };
    const BADGE: Record<string, [string, string]> = {
      kritisch: ['err', 'Kritisch'],
      warnung: ['warn', 'Warnung'],
      ok: ['ok', 'Vollständig'],
      inaktiv: ['muted', 'Inaktiv'],
    };
    const PER_PAGE = 25;
    const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const cur = Math.min(pages, Math.max(1, Number(q.seite) || 1));
    const shown = rows.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
    const inactiveCount = suppliers.filter((s) => !s.active).length;
    const TABS: [Overall | null, string, number][] = nuMode
      ? [
          [null, 'Aktiv', active.length],
          ['kritisch', 'Kritisch', n('kritisch')],
          ['warnung', 'Läuft ab', n('warnung')],
          ['ok', 'Vollständig', n('ok')],
          ['inaktiv', 'Inaktiv', inactiveCount],
        ]
      : [
          [null, 'Aktiv', active.length],
          ['inaktiv', 'Inaktiv', inactiveCount],
        ];
    const title = nuMode ? 'Nachunternehmer' : 'Lieferanten';
    return page(
      c,
      title,
      'lieferanten',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Einkauf</div>
            <h1>{title}</h1>
            <div class="sub">
              {nuMode ? 'Nachweise, Fristen und Bestellungen je Firma' : 'Material und Dienstleister'} ·{' '}
              <a href={nuMode ? '/lieferanten' : '/nachunternehmer'}>
                {nuMode ? 'zu den Lieferanten' : 'zu den Nachunternehmern'}
              </a>
            </div>
          </div>
          <div class="acts">
            {pending > 0 && (
              <a class="btn sec" href="/nachunternehmer/pruefen">
                {pending} Uploads prüfen
              </a>
            )}
            <a class="btn" href={`/lieferanten/${randomUUID()}/bearbeiten?art=${mode}`}>
              {nuMode ? '+ Nachunternehmer anlegen' : '+ Lieferant anlegen'}
            </a>
          </div>
        </div>
        <div class="ls-tabs">
          {TABS.map(([k, l, v]) => (
            <a class={filter === k ? 'on' : ''} href={link({ filter: k, inaktiv: null, seite: null })}>
              {l} <span>{v}</span>
            </a>
          ))}
        </div>
        {nuMode && due.length > 0 && (
          <details class="ls-hint ls-due">
            <summary>
              <b>
                {expired > 0 && `${expired} Nachweis${expired === 1 ? '' : 'e'} abgelaufen`}
                {expired > 0 && due.length > expired && ' · '}
                {due.length > expired && `${due.length - expired} laufen in 14 Tagen ab`}
              </b>{' '}
              – anzeigen
            </summary>
            <ul>
              {due.slice(0, 12).map((d) => (
                <li>
                  <a href={`/lieferanten/${d.supplier.id}/nachweise`}>{d.supplier.name}</a>: {d.label} (
                  {d.days < 0 ? `seit ${-d.days} T. abgelaufen` : d.days === 0 ? 'heute' : `in ${d.days} T.`})
                </li>
              ))}
              {due.length > 12 && <li>… und {due.length - 12} weitere</li>}
            </ul>
          </details>
        )}
        <form class="ls-bar" method="get" action={base}>
          <input
            class="search-input"
            type="search"
            name="q"
            value={search}
            aria-label="Suche"
            placeholder="Firma, Nummer, Ansprechpartner, Ort …"
          />
          {filter && <input type="hidden" name="filter" value={filter} />}
          {showInactive && <input type="hidden" name="inaktiv" value="1" />}
          {(search || filter) && (
            <a class="btn ghost sm" href={base}>
              Filter zurücksetzen
            </a>
          )}
          <span class="small mut ls-count">
            {rows.length === 0
              ? 'keine Treffer'
              : `${(cur - 1) * PER_PAGE + 1}–${(cur - 1) * PER_PAGE + shown.length} von ${rows.length}`}
          </span>
        </form>
        <div class="card" style="padding:0">
          <div class="tbl stack-m">
            <table class="sup-tbl sup2">
              <thead>
                <tr>
                  <th>Firma</th>
                  <th>Kontakt</th>
                  {nuMode && <th>Nachweise</th>}
                  <th class="r">Offene Bestell.</th>
                  {nuMode && <th>Status</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const r = comp.get(s.id);
                  const st = statusOf(s);
                  const pct = r?.requiredTotal ? Math.round((r.requiredOk / r.requiredTotal) * 100) : 100;
                  const href = nuMode ? `/lieferanten/${s.id}/nachweise` : `/lieferanten/${s.id}`;
                  const o = orders.get(s.id) ?? 0;
                  return (
                    <tr class={s.active ? '' : 'mut'}>
                      <td data-label="Firma">
                        <a class="sup-name" href={href}>
                          {s.name}
                        </a>
                        <div class="small mut">
                          {[s.supplier_no, [s.postal_code, s.city].filter(Boolean).join(' ')]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                        {s.terminated_on && (
                          <span class="badge err">gekündigt zum {dateDe(s.terminated_on)}</span>
                        )}
                      </td>
                      <td class="small" data-label="Kontakt">
                        {s.contact_name && <div>{s.contact_name}</div>}
                        {s.phone && <a href={`tel:${s.phone.replace(/[^+\d]/g, '')}`}>{s.phone}</a>}
                        {!nuMode && s.email && (
                          <div>
                            <a href={`mailto:${s.email}`}>{s.email}</a>
                          </div>
                        )}
                        {!s.contact_name && !s.phone && !(!nuMode && s.email) && <span class="mut">–</span>}
                      </td>
                      {nuMode && (
                        <td data-label="Nachweise" class="sup-compl">
                          {r && s.active && !s.terminated_on ? (
                            <>
                              <div class="compl-head small">
                                <span>
                                  {r.requiredOk} von {r.requiredTotal} Pflicht
                                  {r.pending > 0 && ` · ${r.pending} zu prüfen`}
                                </span>
                              </div>
                              <div class={`progress ${pct >= 90 ? '' : pct >= 70 ? 'warn' : 'err'}`}>
                                <i style={`width:${pct}%`} />
                              </div>
                              {r.missing.length > 0 && (
                                <div class="lc-miss small" title={r.missing.join(', ')}>
                                  {r.missing.length} fehlen
                                </div>
                              )}
                              {r.expiring.length > 0 && (
                                <div class="lc-exp small" title={r.expiring.join(', ')}>
                                  {r.expiring.length} laufen ab
                                  {r.nextExpiry && ` (ab ${dateDe(r.nextExpiry)})`}
                                </div>
                              )}
                            </>
                          ) : (
                            <span class="small mut">–</span>
                          )}
                        </td>
                      )}
                      <td class="r" data-label="Offene Bestell.">
                        {o > 0 ? <a href={`/bestellungen?lieferant=${s.id}&ansicht=alle`}>{o}</a> : '–'}
                      </td>
                      {nuMode && (
                        <td data-label="Status">
                          <span class={`badge ${BADGE[st]![0]}`}>{BADGE[st]![1]}</span>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!shown.length && (
                  <tr>
                    <td colspan={nuMode ? 5 : 3} class="mut">
                      Keine Einträge in dieser Auswahl.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <Pager cur={cur} pages={pages} url={(p) => link({ seite: p > 1 ? String(p) : null })} />
        {nuMode && (
          <p class="small mut">
            Als Auftraggeber haften wir für Mindestlohn (§ 13 MiLoG, § 14 AEntG) und
            Sozialversicherungsbeiträge (§ 28e Abs. 3a SGB IV) der Beschäftigten des Nachunternehmers –
            fehlende Nachweise zeitnah nachfordern.
          </p>
        )}
      </div>,
    );
  };
  app.get('/nachunternehmer', (c) => supplierList(c, 'nachunternehmer'));
  app.get('/lieferanten', (c) => {
    if (c.req.query('art') === 'nachunternehmer') {
      const p = new URLSearchParams(c.req.query());
      p.delete('art');
      const str = p.toString();
      return c.redirect(`/nachunternehmer${str ? `?${str}` : ''}`);
    }
    return supplierList(c, 'lieferant');
  });

  // ------------------------------------------------------------------ Nachweise eines Nachunternehmers
  app.get(`/lieferanten/:id{${UUID}}/nachweise`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontractor(sql, id);
    if (!data || data.supplier.kind !== 'nachunternehmer') return c.redirect(`/lieferanten/${id}`);
    const s = data.supplier;
    const handovers = await listHandovers(sql, { scope: null, supplierId: id });
    const url = portalUrl(s.portal_token);
    const required = data.rows.filter((r) => r.required);
    const fine = required.filter((r) => r.state === 'gueltig' || r.state === 'laeuft_ab').length;
    const pct = required.length ? Math.round((fine / required.length) * 100) : 100;
    const categories = [...new Set(data.rows.map((r) => r.type.category))];
    const XL: Record<Overall, string> = { kritisch: 'err', warnung: 'warn', ok: 'ok', inaktiv: 'off' };
    return page(
      c,
      s.name,
      'lieferanten',
      <>
        {subHead(s)}
        <SubTabs id={id} active="uebersicht" counts={catCounts(data.rows)} />
        <div class="card hero">
          <span class={`status-xl ${XL[data.overall]}`}>{OVERALL[data.overall]}</span>
          <div style="flex:1;min-width:220px">
            <div class="small mut" style="margin-bottom:6px">
              Pflicht-Nachweise:{' '}
              <b style="color:var(--ink)">
                {fine} von {required.length}
              </b>
              {data.nextExpiry && <> · nächster Ablauf {dateDe(data.nextExpiry)}</>}
            </div>
            <div class={`progress ${pct === 100 ? '' : pct >= 70 ? 'warn' : 'err'}`}>
              <i style={`width:${pct}%`} />
            </div>
          </div>
          <div class="facts">
            <span>
              Rechtsform <b>{s.legal_form ? LEGAL_FORMS[s.legal_form] : '–'}</b>
            </span>
            {s.contact_name && (
              <span>
                Kontakt <b>{s.contact_name}</b>
              </span>
            )}
            {s.terminated_on && (
              <span style="color:var(--err)">
                gekündigt zum <b style="color:var(--err)">{dateDe(s.terminated_on)}</b>
              </span>
            )}
          </div>
          <div class="acts">
            <a class="btn sec sm" href={`/lieferanten/${id}/nachweise.pdf`} target="_blank">
              Compliance-Report (PDF)
            </a>
          </div>
        </div>

        <div class="cols">
          <div class="card">
            <h3>Stammdaten</h3>
            <dl class="kv">
              <dt>Anschrift</dt>
              <dd>
                {s.street}
                <br />
                {s.postal_code} {s.city}
              </dd>
              <dt>Hauptkontakt</dt>
              <dd>
                {s.contact_name ?? '–'}{' '}
                <a class="small" href={`/lieferanten/${id}/ansprechpartner`}>
                  alle Ansprechpartner
                </a>
              </dd>
              <dt>E-Mail</dt>
              <dd>{s.email ? <a href={`mailto:${s.email}`}>{s.email}</a> : '–'}</dd>
              <dt>Telefon</dt>
              <dd>{s.phone ?? '–'}</dd>
              <dt>USt-ID</dt>
              <dd>{s.vat_id ?? '–'}</dd>
              <dt>Bank</dt>
              <dd>{s.iban ? `${s.iban.replace(/(.{4})/g, '$1 ').trim()} ${s.bic ?? ''}` : '–'}</dd>
              <dt>Zahlungsziel</dt>
              <dd>{s.payment_terms_days} Tage</dd>
              <dt>Status</dt>
              <dd>{s.active ? 'aktiv' : 'inaktiv'}</dd>
            </dl>
            <h4 style="margin:14px 0 6px">Nachweise je Kategorie</h4>
            {categories.map((cat) => {
              const list = data.rows.filter((r) => r.type.category === cat);
              const bad = list.filter((r) => r.required && !['gueltig', 'laeuft_ab'].includes(r.state));
              const soon = list.filter((r) => r.state === 'laeuft_ab');
              return (
                <div class="row" style="display:flex;gap:10px;align-items:center;padding:4px 0">
                  <span class={`dot ${bad.length ? 'err' : soon.length ? 'warn' : 'ok'}`} />
                  <a href={`/lieferanten/${id}/nachweise/${CAT_SLUG[cat] ?? ''}`}>
                    <b>{cat}</b>
                  </a>
                  <span class="small mut">
                    {bad.length
                      ? `fehlt/abgelaufen: ${bad.map((r) => r.type.label).join(', ')}`
                      : soon.length
                        ? `läuft ab: ${soon.map((r) => r.type.label).join(', ')}`
                        : 'vollständig'}
                  </span>
                </div>
              );
            })}
          </div>

          <div>
            <div class="card">
              <h3>Fehlende Nachweise anfordern</h3>
              <textarea rows={9} readonly style="font-size:12.5px" id="req">
                {requestText(s, data.rows, url)}
              </textarea>
              <div class="actions" style="margin-bottom:0">
                {s.email && (
                  <a
                    class="btn sm"
                    href={`mailto:${s.email}?subject=${encodeURIComponent('Nachweise für die Zusammenarbeit')}&body=${encodeURIComponent(requestText(s, data.rows, url))}`}
                  >
                    Als E-Mail öffnen
                  </a>
                )}
                <button
                  type="button"
                  class="btn sec sm"
                  onclick="navigator.clipboard.writeText(document.getElementById('req').value);this.textContent='Kopiert ✓'"
                >
                  Text kopieren
                </button>
              </div>
            </div>
            <div class="card">
              <h3>Upload-Portal</h3>
              <p class="small mut" style="margin-top:0">
                Der Nachunternehmer lädt selbst hoch (Link + PIN). Jede Datei zählt erst nach Ihrer Prüfung.
              </p>
              {url ? (
                <p class="small" style="word-break:break-all">
                  <span class="badge ok">aktiv</span> <code>{url}</code>
                </p>
              ) : (
                <p class="small">
                  <span class="badge">nicht eingerichtet</span>
                </p>
              )}
              <div class="actions" style="margin-bottom:0">
                <form
                  method="post"
                  action={`/lieferanten/${id}/portal`}
                  onsubmit="return confirm('Neuen Link und PIN erzeugen? Der alte Zugang gilt dann nicht mehr.')"
                >
                  <button class={`btn ${url ? 'sec ' : ''}sm`}>
                    {url ? 'Neuen Link + PIN' : 'Zugang einrichten'}
                  </button>
                </form>
                {url && (
                  <form method="post" action={`/lieferanten/${id}/portal/sperren`}>
                    <button class="btn ghost sm">Sperren</button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;align-items:center;gap:12px">
            <h3 style="margin:0">Übergaben (Kleidung, Geräte, Dokumente)</h3>
            <a
              class="btn sec sm"
              href={`/uebergaben/${randomUUID()}?art=sonstiges&nachunternehmer=${id}`}
              style="margin-left:auto"
            >
              + Übergabe
            </a>
          </div>
          <div style="margin-top:14px">
            <HandoverTable rows={handovers} />
          </div>
        </div>

        {s.terminated_on ? (
          <div class="card danger-zone">
            <h3 style="color:var(--err)">Gekündigt zum {dateDe(s.terminated_on)}</h3>
            <p class="small mut" style="margin-top:0">
              {s.termination_reason}
            </p>
            <div class="actions" style="margin-bottom:0">
              <a class="btn sec sm" href={`/lieferanten/${id}/kuendigung.pdf`} target="_blank">
                Kündigungsschreiben (PDF)
              </a>
              <form method="post" action={`/lieferanten/${id}/kuendigung/aufheben`}>
                <button class="btn ghost sm" onclick="return confirm('Kündigung aufheben?')">
                  Kündigung aufheben
                </button>
              </form>
            </div>
          </div>
        ) : (
          <details class="card danger-zone">
            <summary>Zusammenarbeit beenden …</summary>
            <form method="post" action={`/lieferanten/${id}/kuendigung`} style="margin-top:14px">
              <div class="grid">
                <div>
                  <label for="kdate">Kündigung zum</label>
                  <input id="kdate" type="date" name="date" required />
                </div>
                <div>
                  <label for="knote">Bemerkung</label>
                  <input id="knote" name="note" />
                </div>
              </div>
              <label style="margin-top:14px">Gründe</label>
              <div class="chips">
                {TERMINATION_REASONS.map((r) => (
                  <label class="chk" style="margin:0 12px 0 0;font-weight:500">
                    <input type="checkbox" name="reason" value={r} /> {r}
                  </label>
                ))}
              </div>
              <p class="small mut">
                Laufende Aufträge enden zum Kündigungsdatum, Entwürfe werden storniert. Kündigungsfristen laut
                Vertrag beachten.
              </p>
              <button class="btn danger" onclick="return confirm('Nachunternehmer kündigen?')">
                Kündigen
              </button>
            </form>
          </details>
        )}
      </>,
    );
  });

  // Nachweise einer Kategorie (Stammdokumente, Unbedenklichkeit, Mindestlohn) – wie die alte App
  app.get(`/lieferanten/:id{${UUID}}/nachweise/:kat{[a-z]+}`, async (c) => {
    const id = c.req.param('id');
    const slug = c.req.param('kat');
    const cat = SLUG_CAT[slug];
    if (!cat) return c.redirect(`/lieferanten/${id}/nachweise`);
    const data = await getSubcontractor(sql, id);
    if (!data || data.supplier.kind !== 'nachunternehmer') return c.redirect(`/lieferanten/${id}`);
    const s = data.supplier;
    const rows = data.rows.filter((r) => r.type.category === cat);
    const req = rows.filter((r) => r.required);
    const opt = rows.filter((r) => !r.required);
    const ok = (r: (typeof rows)[number]) => r.state === 'gueltig' || r.state === 'laeuft_ab';
    const today = todayBerlin();
    const STATE_TAG: Record<DocState, string> = {
      gueltig: 'ok',
      laeuft_ab: 'warn',
      abgelaufen: 'err',
      fehlt: 'err',
      zu_pruefen: 'info',
    };
    return page(
      c,
      `${s.name} – ${cat}`,
      'lieferanten',
      <>
        {subHead(s)}
        <SubTabs id={id} active={slug} counts={catCounts(data.rows)} />
        <div class="tabbody">
          <div class="card" style="display:flex;align-items:center;gap:16px;background:var(--bg)">
            <div style="flex:1">
              <b style="font-size:16px">{cat}</b>
              <div class="small mut">
                {req.length} Pflicht · {opt.length} optional
              </div>
            </div>
            <div style="text-align:right">
              <b style="font-size:20px;color:var(--brand)">
                {req.filter(ok).length} / {req.length}
              </b>
              <div class="small mut">
                + {opt.filter(ok).length}/{opt.length} optional
              </div>
            </div>
          </div>
          {rows.map((r) => {
            const versions = data.docs.filter((d) => d.doc_type === r.type.id);
            const older = versions.filter((d) => d.id !== r.current?.id && d.id !== r.pending?.id);
            return (
              <section class="card doc-card">
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                  <span class={`tag ${r.required ? 'err' : ''}`} style="font-weight:700">
                    {r.required ? 'PFLICHT' : 'OPTIONAL'}
                  </span>
                  <b style="font-size:15px">{r.type.label}</b>
                  <span class={`tag ${STATE_TAG[r.state]}`} style="margin-left:auto">
                    {r.state === 'gueltig' ? 'Gültig' : DOC_STATE_LABEL[r.state]}
                  </span>
                </div>
                {r.type.hint && (
                  <div class="small mut" style="margin-top:4px">
                    {r.type.hint}
                  </div>
                )}
                {!r.required && (
                  <div class="small faint">Optionale Dokumente fließen nicht in die Vollständigkeit ein.</div>
                )}
                {NACHWEIS_TEMPLATE[r.type.id] && (
                  <form
                    method="get"
                    action={`/lieferanten/${id}/vorlage/${NACHWEIS_TEMPLATE[r.type.id]}`}
                    target="_blank"
                    class="small"
                    style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"
                  >
                    {NACHWEIS_TEMPLATE[r.type.id] !== 'personaleinsatzliste' && (
                      <label class="small" style="display:inline-flex;gap:5px;align-items:center;margin:0">
                        Datum <input type="date" name="datum" value={today} style="width:auto" />
                      </label>
                    )}
                    <button class="btn sec sm">Vorlage ausgefüllt erstellen</button>
                    <a href={`/lieferanten/${id}/dokumente#vorlagen`}>weitere Optionen</a>
                  </form>
                )}
                {r.current && (
                  <div style="margin-top:8px">
                    <a href={`/nachweise/${r.current.id}/datei`} target="_blank">
                      <i>{r.current.file_name}</i>
                    </a>{' '}
                    {r.current.valid_until ? (
                      <span
                        class={`tag ${r.state === 'abgelaufen' ? 'err' : r.state === 'laeuft_ab' ? 'warn' : 'ok'}`}
                      >
                        {r.state === 'abgelaufen' ? 'abgelaufen am' : 'gültig bis'}{' '}
                        {dateDe(r.current.valid_until)}
                        {r.days !== null && r.days >= 0 && r.days <= 60 && ` (noch ${r.days} Tage)`}
                      </span>
                    ) : (
                      <span class="tag">ohne Ablaufdatum</span>
                    )}
                  </div>
                )}
                {r.pending && (
                  <div class="small" style="margin-top:6px;color:var(--info)">
                    Neue Datei „{r.pending.file_name}“ wartet auf Prüfung –{' '}
                    <a href="/nachunternehmer/pruefen">jetzt prüfen</a>
                  </div>
                )}
                <form
                  method="post"
                  action={`/lieferanten/${id}/nachweise`}
                  enctype="multipart/form-data"
                  class="doc-upload"
                  style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:end"
                >
                  <input type="hidden" name="id" value={randomUUID()} />
                  <input type="hidden" name="doc_type" value={r.type.id} />
                  <input type="hidden" name="back" value={slug} />
                  {r.type.valid_months > 0 && (
                    <div>
                      <label class="small">gültig bis (steht auf dem Nachweis)</label>
                      <div style="display:flex;gap:6px">
                        <input type="date" name="valid_until" required />
                        <button
                          type="button"
                          class="btn sec sm"
                          title={`heute + ${r.type.valid_months} Monate`}
                          data-plus={String(r.type.valid_months)}
                          data-today={today}
                          onclick="var d=new Date(this.dataset.today+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+Number(this.dataset.plus));this.previousElementSibling.value=d.toISOString().slice(0,10)"
                        >
                          +{r.type.valid_months}M
                        </button>
                      </div>
                    </div>
                  )}
                  <div>
                    <label class="small">
                      {r.current ? 'Neue Version (PDF, JPG, PNG)' : 'Datei (PDF, JPG, PNG)'}
                    </label>
                    <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required />
                  </div>
                  <button class="btn sm">{r.current ? 'Neue Version hochladen' : 'Datei hochladen'}</button>
                </form>
                {older.length > 0 && (
                  <details style="margin-top:8px">
                    <summary class="small">
                      Frühere Versionen ({older.length}) – archiviert, werden nie gelöscht
                    </summary>
                    <ul class="small" style="margin:6px 0 0">
                      {older.map((d) => (
                        <li>
                          <a href={`/nachweise/${d.id}/datei`} target="_blank">
                            {d.file_name}
                          </a>{' '}
                          · hochgeladen{' '}
                          {d.created_at.toLocaleDateString('de-DE', {
                            timeZone: 'Europe/Berlin',
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                          })}
                          {d.valid_until && ` · gültig bis ${dateDe(d.valid_until)}`}
                          {d.status === 'abgelehnt' && ` · abgelehnt: ${d.reject_reason ?? ''}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            );
          })}
        </div>
      </>,
    );
  });

  // Aufträge eines Nachunternehmers
  app.get(`/lieferanten/:id{${UUID}}/auftraege`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontractor(sql, id);
    if (!data) return c.redirect(`/lieferanten/${id}`);
    const contracts = await listSubcontracts(sql, { supplierId: id });
    return page(
      c,
      `${data.supplier.name} – Aufträge`,
      'lieferanten',
      <>
        {subHead(data.supplier)}
        <SubTabs id={id} active="auftraege" counts={catCounts(data.rows)} />
        <div class="tabbody">
          <div class="actions" style="margin-top:0">
            <a class="btn sm" href={`/nachunternehmer/auftraege/${randomUUID()}?nu=${id}`}>
              + Auftrag
            </a>
          </div>
          <SubcontractTable
            rows={contracts}
            hours={await hoursOfMonth(
              sql,
              contracts.filter((x) => x.billing === 'stunde').map((x) => x.id),
              todayBerlin().slice(0, 7),
              contracts.filter((x) => !isRecurringOrder(x.frequency)).map((x) => x.id),
            )}
            days={await dayAmounts(sql, contracts, todayBerlin().slice(0, 7))}
            totals={await sammelTotals(sql, contracts)}
            sammelInfo={await sammelSummaries(
              sql,
              contracts.map((x) => x.id),
            )}
          />
        </div>
      </>,
    );
  });

  // Ansprechpartner (mehrere)
  // ------------------------------------------------------------------ Vorschüsse (Ahmed 09.10.)
  app.get(`/lieferanten/:id{${UUID}}/vorschuesse`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontractor(sql, id);
    if (!data) return c.redirect(`/lieferanten/${id}`);
    const [advances, contracts, openInv] = await Promise.all([
      listAdvances(sql, id),
      listSubcontracts(sql, { supplierId: id }),
      listIncoming(sql, { supplierId: id, status: ['erfasst', 'freigegeben'] }),
    ]);
    const total = advances.reduce((a, x) => a + x.amount_cents, 0n);
    const used = advances.reduce((a, x) => a + x.used_cents, 0n);
    const open = total - used;
    return page(
      c,
      `${data.supplier.name} – Vorschüsse`,
      'lieferanten',
      <>
        {subHead(data.supplier)}
        <SubTabs id={id} active="vorschuesse" counts={catCounts(data.rows)} />
        <div class="tabbody">
          <div class="kpis">
            <div class="kpi">
              <div class="l">Vorschüsse gesamt</div>
              <div class="v">{euro(total)}</div>
            </div>
            <div class="kpi">
              <div class="l">verrechnet</div>
              <div class="v">{euro(used)}</div>
            </div>
            <div class="kpi">
              <div class="l">offen (noch zu verrechnen)</div>
              <div class="v" style={open > 0n ? 'color:var(--warn)' : ''}>
                {euro(open)}
              </div>
            </div>
          </div>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Gezahlt am</th>
                  <th>Zweck / Bestellung</th>
                  <th>Zahlart</th>
                  <th class="r">Betrag</th>
                  <th class="r">verrechnet</th>
                  <th class="r">offen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {advances.length === 0 && (
                  <tr>
                    <td colspan={7}>
                      <div class="empty">Noch keine Vorschüsse.</div>
                    </td>
                  </tr>
                )}
                {advances.map((a) => (
                  <tr>
                    <td>{dateDe(a.paid_on)}</td>
                    <td>
                      {a.purpose ?? '–'}
                      {a.subcontract_number && <div class="small mut">Bestellung {a.subcontract_number}</div>}
                      {a.offsets.map((o) => (
                        <div class="small">
                          verrechnet mit <a href={`/rechnungseingang/${o.invoice_id}`}>{o.invoice_no}</a>:{' '}
                          {euro(o.amount_cents)}
                        </div>
                      ))}
                      {a.bank_transaction_id && <div class="small mut">aus Kontoumsatz</div>}
                    </td>
                    <td>{ADVANCE_METHOD[a.method] ?? a.method}</td>
                    <td class="r">{euro(a.amount_cents)}</td>
                    <td class="r">{a.used_cents ? euro(a.used_cents) : '–'}</td>
                    <td class="r">
                      <b>{euro(a.amount_cents - a.used_cents)}</b>
                    </td>
                    <td class="r">
                      {a.used_cents === 0n && (
                        <form
                          method="post"
                          action={`/lieferanten/${id}/vorschuesse/${a.id}/loeschen`}
                          onsubmit="return confirm('Vorschuss löschen?')"
                        >
                          <button class="btn sm ghost danger" title="löschen">
                            Löschen
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            method="post"
            action={`/lieferanten/${id}/vorschuesse`}
            class="card"
            style="max-width:640px;margin-top:16px"
          >
            <h3>Vorschuss erfassen</h3>
            <input type="hidden" name="form_id" value={randomUUID()} />
            <div class="grid">
              <div>
                <label for="paid_on">Gezahlt am</label>
                <input id="paid_on" type="date" name="paid_on" value={todayBerlin()} required />
              </div>
              <div>
                <label for="amount">Betrag (€)</label>
                <input id="amount" name="amount" inputmode="decimal" required placeholder="z. B. 1.500,00" />
              </div>
              <div>
                <label for="method">Zahlart</label>
                <select id="method" name="method">
                  {Object.entries(ADVANCE_METHOD).map(([k, v]) => (
                    <option value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label for="subcontract_id">Bestellung (optional)</label>
                <select id="subcontract_id" name="subcontract_id">
                  <option value="">–</option>
                  {contracts.map((k) => (
                    <option value={k.id}>
                      {k.number} · {k.site_name}
                    </option>
                  ))}
                </select>
              </div>
              <div style="grid-column:1/-1">
                <label for="purpose">Zweck / Notiz</label>
                <input id="purpose" name="purpose" placeholder="z. B. Abschlag Glasreinigung Oktober" />
              </div>
            </div>
            <p class="small mut" style="margin:12px 0 0">
              Kommt die Rechnung, unter Rechnungseingang → Rechnung → „Vorschuss verrechnen“: der Zahlbetrag
              sinkt um den Vorschuss. Per Überweisung gezahlte Vorschüsse am besten direkt im Kontoumsatz
              zuordnen (Lieferant → „als Vorschuss“) – dann nicht zusätzlich hier erfassen.
            </p>
            <div class="formfoot">
              <button class="btn">Vorschuss speichern</button>
            </div>
          </form>
          {open > 0n && openInv.length > 0 && (
            <div class="card">
              <h3>Offene Rechnungen zum Verrechnen</h3>
              {openInv.map((i) => (
                <div style="display:flex;gap:10px;align-items:center;margin:4px 0">
                  <a href={`/rechnungseingang/${i.id}`}>{i.invoice_no}</a>
                  <span class="small mut">{dateDe(i.invoice_date)}</span>
                  <span class="num">{euro(i.gross_cents - i.advance_offset_cents)}</span>
                  <form method="post" action={`/rechnungseingang/${i.id}/vorschuss`} style="margin-left:auto">
                    <input type="hidden" name="zurueck" value={`/lieferanten/${id}/vorschuesse`} />
                    <button class="btn sm sec">Vorschuss verrechnen</button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </div>
      </>,
    );
  });

  app.post(`/lieferanten/:id{${UUID}}/vorschuesse`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const formId = str(b, 'form_id');
    await saveAdvance(
      sql,
      formId && /^[0-9a-f-]{36}$/.test(formId) ? formId : randomUUID(),
      {
        supplierId: id,
        subcontractId: str(b, 'subcontract_id'),
        paidOn: str(b, 'paid_on') ?? '',
        amount: parseEuro(str(b, 'amount') ?? '') as bigint,
        method: str(b, 'method') ?? 'ueberweisung',
        purpose: str(b, 'purpose'),
      },
      c.get('actor'),
    );
    return back(c, `/lieferanten/${id}/vorschuesse`, { ok: 'Vorschuss gespeichert.' });
  });

  app.post(`/lieferanten/:id{${UUID}}/vorschuesse/:aid{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    await deleteAdvance(sql, c.req.param('aid'), c.get('actor'));
    return back(c, `/lieferanten/${id}/vorschuesse`, { ok: 'Vorschuss gelöscht (im Protokoll vermerkt).' });
  });

  app.get(`/lieferanten/:id{${UUID}}/ansprechpartner`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontractor(sql, id);
    if (!data) return c.redirect(`/lieferanten/${id}`);
    const contacts = await listSupplierContacts(sql, id);
    const editId = c.req.query('bearbeiten');
    const edit = contacts.find((k) => k.id === editId) ?? null;
    const formId = edit?.id ?? randomUUID();
    return page(
      c,
      `${data.supplier.name} – Ansprechpartner`,
      'lieferanten',
      <>
        {subHead(data.supplier)}
        <SubTabs id={id} active="ansprechpartner" counts={catCounts(data.rows)} />
        <div class="tabbody">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Funktion</th>
                  <th>Telefon / Mobil</th>
                  <th>E-Mail</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contacts.map((k) => (
                  <tr>
                    <td>
                      <b>{k.name}</b> {k.is_primary && <span class="tag ok">Hauptkontakt</span>}
                      {k.note && <div class="small mut">{k.note}</div>}
                    </td>
                    <td>{k.role ?? ''}</td>
                    <td>
                      {k.phone && <a href={`tel:${k.phone.replace(/\s/g, '')}`}>{k.phone}</a>}
                      {k.mobile && (
                        <div>
                          <a href={`tel:${k.mobile.replace(/\s/g, '')}`}>{k.mobile}</a>
                        </div>
                      )}
                    </td>
                    <td>{k.email && <a href={`mailto:${k.email}`}>{k.email}</a>}</td>
                    <td class="r" style="white-space:nowrap">
                      <a class="btn sm sec" href={`/lieferanten/${id}/ansprechpartner?bearbeiten=${k.id}`}>
                        Bearbeiten
                      </a>{' '}
                      <form
                        method="post"
                        action={`/lieferanten/${id}/ansprechpartner/${k.id}/loeschen`}
                        style="display:inline"
                      >
                        <button class="btn sm ghost" onclick="return confirm('Ansprechpartner löschen?')">
                          Löschen
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {!contacts.length && (
                  <tr>
                    <td colspan={5} class="mut">
                      Noch keine Ansprechpartner.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <form
            method="post"
            action={`/lieferanten/${id}/ansprechpartner/${formId}`}
            data-autosave={`/lieferanten/${id}/ansprechpartner/${formId}`}
            style="margin-top:16px"
          >
            <h3 class="panel-title">{edit ? `${edit.name} bearbeiten` : 'Ansprechpartner hinzufügen'}</h3>
            <input type="hidden" name="version" value={edit ? String(edit.version) : ''} />
            <div class="grid">
              <div>
                <label for="k_name">Name *</label>
                <input id="k_name" name="name" value={edit?.name ?? ''} required />
              </div>
              <div>
                <label for="k_role">Funktion</label>
                <input
                  id="k_role"
                  name="role"
                  value={edit?.role ?? ''}
                  placeholder="z. B. Geschäftsführer, Vorarbeiter"
                />
              </div>
              <div>
                <label for="k_phone">Telefon</label>
                <input id="k_phone" name="phone" value={edit?.phone ?? ''} />
              </div>
              <div>
                <label for="k_mobile">Mobil</label>
                <input id="k_mobile" name="mobile" value={edit?.mobile ?? ''} />
              </div>
              <div>
                <label for="k_email">E-Mail</label>
                <input id="k_email" name="email" type="email" value={edit?.email ?? ''} />
              </div>
              <div>
                <label for="k_note">Notiz</label>
                <input id="k_note" name="note" value={edit?.note ?? ''} />
              </div>
              <div class="chk">
                <input
                  type="checkbox"
                  id="k_primary"
                  name="is_primary"
                  checked={edit ? edit.is_primary : !contacts.length}
                />
                <label for="k_primary">Hauptkontakt (für Anschreiben und Nachforderungen)</label>
              </div>
            </div>
            <div class="actions">
              <button class="btn">Speichern</button>
              {edit && (
                <a class="btn sec" href={`/lieferanten/${id}/ansprechpartner`}>
                  Abbrechen
                </a>
              )}
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/lieferanten/:id{${UUID}}/ansprechpartner/:cid{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const v = str(b, 'version');
    await saveSupplierContact(
      sql,
      c.req.param('cid'),
      id,
      {
        name: str(b, 'name') ?? '',
        role: str(b, 'role'),
        phone: str(b, 'phone'),
        mobile: str(b, 'mobile'),
        email: str(b, 'email'),
        note: str(b, 'note'),
        is_primary: b.is_primary === 'on',
        expectedVersion: v ? Number(v) : null,
      },
      c.get('actor'),
    );
    return back(c, `/lieferanten/${id}/ansprechpartner`, { ok: 'Ansprechpartner gespeichert.' });
  });

  app.post(`/lieferanten/:id{${UUID}}/ansprechpartner/:cid{${UUID}}/loeschen`, async (c) => {
    await deleteSupplierContact(sql, c.req.param('cid'), c.get('actor'));
    return back(c, `/lieferanten/${c.req.param('id')}/ansprechpartner`, { ok: 'Ansprechpartner gelöscht.' });
  });

  // Weitere Dokumente (Schriftverkehr, Verträge, Rechnungen …) – unterteilt nach Kategorie, write-once
  const SUP_DOC_CATS = ['Verträge', 'Schriftverkehr', 'Rechnungen', 'Sonstiges'];
  app.get(`/lieferanten/:id{${UUID}}/dokumente`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontractor(sql, id);
    if (!data) return c.redirect(`/lieferanten/${id}`);
    const files = await listFiles(sql, { type: 'supplier', id });
    return page(
      c,
      `${data.supplier.name} – Dokumente`,
      'lieferanten',
      <>
        {subHead(data.supplier)}
        <SubTabs id={id} active="dokumente" counts={catCounts(data.rows)} />
        <div class="tabbody">
          <div class="actions" style="margin-top:0">
            <a class="btn sec sm" href={`/brief?an=lieferant&id=${id}`}>
              Brief schreiben (Briefpapier)
            </a>
          </div>
          {data.supplier.kind === 'nachunternehmer' && (
            <section class="card" id="vorlagen" style="margin-bottom:16px">
              <h3 class="panel-title" style="margin-top:0">
                Vorlagen erstellen (automatisch ausgefüllt)
              </h3>
              <p class="small mut" style="margin-top:0">
                Firmen- und Nachunternehmerdaten werden eingesetzt. „In Dokumente ablegen“ speichert das PDF
                unter „Verträge“; die unterschriebene Fassung danach beim Nachweis hochladen.
              </p>
              {(Object.keys(NU_DOCS) as NuDocKind[]).map((k) => (
                <form method="post" action={`/lieferanten/${id}/vorlage`} class="nu-tpl">
                  <input type="hidden" name="kind" value={k} />
                  <b class="nu-tpl-name">{NU_DOCS[k].label}</b>
                  {k === 'rahmenvertrag' && (
                    <label class="small">
                      Vertragsbeginn <input type="date" name="beginn" value={todayBerlin()} />
                    </label>
                  )}
                  {k === 'selbstauskunft' && (
                    <label class="small">
                      <input type="checkbox" name="ankreuzen" value="1" checked /> Punkte vorab angekreuzt
                    </label>
                  )}
                  <label class="small">
                    Datum <input type="date" name="datum" value={todayBerlin()} />
                  </label>
                  <label class="small">
                    <input type="checkbox" name="ablegen" value="1" /> in Dokumente ablegen
                  </label>
                  <button class="btn sm" formtarget="_blank">
                    PDF erstellen
                  </button>
                </form>
              ))}
              <div class="nu-tpl">
                <b class="nu-tpl-name">Personaleinsatzliste (Excel, § 17 MiLoG)</b>
                <a class="btn sec sm" href={`/lieferanten/${id}/vorlage/personaleinsatzliste.xlsx`}>
                  Excel herunterladen
                </a>
              </div>
            </section>
          )}
          {SUP_DOC_CATS.map((cat) => (
            <section style="margin-bottom:16px">
              <h3 class="panel-title">{cat}</h3>
              <FileArea
                link={{ type: 'supplier', id }}
                files={files.filter(
                  (f) =>
                    (f.category ?? 'Sonstiges') === cat ||
                    (cat === 'Sonstiges' && !SUP_DOC_CATS.includes(f.category ?? '')),
                )}
                category={cat}
                title={`${cat} hochladen`}
                maxBytes={env.UPLOAD_MAX_BYTES}
              />
            </section>
          ))}
          <p class="small mut">
            Dateien werden unveränderbar abgelegt (SHA-256). Nachweise mit Ablaufdatum bitte in den
            Nachweis-Reitern hochladen.
          </p>
        </div>
      </>,
    );
  });

  const nwBack = (id: string, b: Record<string, unknown>) =>
    typeof b.back === 'string' && SLUG_CAT[b.back]
      ? `/lieferanten/${id}/nachweise/${b.back}`
      : `/lieferanten/${id}/nachweise`;
  app.post(`/lieferanten/:id{${UUID}}/nachweise`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const file = b.file;
    try {
      if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte Datei wählen');
      await uploadDocument(deps, {
        id: str(b, 'id') ?? randomUUID(),
        supplierId: id,
        docType: str(b, 'doc_type') ?? '',
        fileName: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
        validUntil: str(b, 'valid_until'),
        source: 'buero',
        actor: c.get('actor'),
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, nwBack(id, b), { fehler: e.message });
      throw e;
    }
    return back(c, nwBack(id, b), { ok: 'Nachweis gespeichert – frühere Version bleibt archiviert.' });
  });

  app.get(`/nachweise/:id{${UUID}}/datei`, async (c) => {
    const { doc, data } = await documentFile(deps, c.req.param('id'));
    return new Response(data, {
      headers: {
        'Content-Type': doc.content_type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.file_name)}"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  // Vorlagen für Nachunternehmer automatisch ausgefüllt (Ahmed 19.10.)
  app.get(`/lieferanten/:id{${UUID}}/vorlage/personaleinsatzliste.xlsx`, async (c) => {
    const x = await personnelListXlsx(sql, c.req.param('id'));
    return new Response(x.data, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${x.name}"`,
      },
    });
  });
  app.get(`/lieferanten/:id{${UUID}}/vorlage/:kind`, async (c) => {
    const kind = c.req.param('kind');
    if (kind === 'personaleinsatzliste')
      return c.redirect(`/lieferanten/${c.req.param('id')}/vorlage/personaleinsatzliste.xlsx`);
    if (!isNuDoc(kind)) return c.notFound();
    const doc = await nuDocPdf(sql, c.req.param('id'), kind, {
      checked: true,
      date: c.req.query('datum') ?? null,
      actorName: c.get('user').name,
    });
    return pdfResponse(doc.pdf, doc.name);
  });
  app.post(`/lieferanten/:id{${UUID}}/vorlage`, async (c) => {
    const id = c.req.param('id');
    const f = await c.req.parseBody();
    const kind = String(f.kind ?? '');
    if (!isNuDoc(kind)) return c.notFound();
    const doc = await nuDocPdf(sql, id, kind, {
      start: typeof f.beginn === 'string' ? f.beginn : null,
      date: typeof f.datum === 'string' ? f.datum : null,
      checked: f.ankreuzen === '1',
      actorName: c.get('user').name,
    });
    if (f.ablegen === '1')
      await storeNuDoc(
        sql,
        { dir: env.FILES_DIR, maxBytes: env.UPLOAD_MAX_BYTES },
        id,
        kind,
        doc,
        c.get('actor'),
      );
    return pdfResponse(doc.pdf, doc.name);
  });

  app.get(`/lieferanten/:id{${UUID}}/nachweise.pdf`, async (c) =>
    pdfResponse(await compliancePdf(sql, c.req.param('id')), 'Nachweisuebersicht.pdf'),
  );

  // ------------------------------------------------------------------ Prüfen (Uploads aus dem Portal)
  app.get('/nachunternehmer/pruefen', async (c) => {
    const rows = await sql<
      (SupplierDocument & { supplier_name: string; label: string; valid_months: number })[]
    >`
      select d.*, s.name as supplier_name, t.label, t.valid_months
        from app.supplier_documents d join app.suppliers s on s.id = d.supplier_id
        join app.supplier_doc_types t on t.id = d.doc_type
       where d.status = 'zu_pruefen' order by d.created_at`;
    return page(
      c,
      'Nachweise prüfen',
      'lieferanten',
      <>
        <PageHead title="Hochgeladene Nachweise prüfen" crumbs={[['Nachunternehmer', '/nachunternehmer']]} />
        {!rows.length && <div class="card empty">Nichts zu prüfen.</div>}
        {rows.map((d) => (
          <form method="post" action={`/nachweise/${d.id}/pruefen`} class="card">
            <p style="margin-top:0">
              <b>{d.supplier_name}</b> · {d.label} ·{' '}
              <a href={`/nachweise/${d.id}/datei`} target="_blank">
                {d.file_name} öffnen
              </a>{' '}
              <span class="small mut">
                hochgeladen {d.created_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
              </span>
            </p>
            <div class="actions" style="margin:0">
              {d.valid_months > 0 && (
                <>
                  <label class="small" for={`v-${d.id}`} style="margin:0">
                    gültig bis (vom Nachweis)
                  </label>
                  <input
                    id={`v-${d.id}`}
                    type="date"
                    name="valid_until"
                    value={d.valid_until ?? ''}
                    style="max-width:160px"
                  />
                </>
              )}
              <button class="btn sm" name="decision" value="ok">
                Gültig
              </button>
              <input name="reason" placeholder="Grund bei Ablehnung" style="max-width:260px" />
              <button class="btn sec sm" name="decision" value="ablehnen">
                Ablehnen
              </button>
            </div>
          </form>
        ))}
      </>,
    );
  });

  app.post(`/nachweise/:id{${UUID}}/pruefen`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    try {
      await reviewDocument(
        sql,
        c.req.param('id'),
        { accept: str(b, 'decision') === 'ok', validUntil: str(b, 'valid_until'), reason: str(b, 'reason') },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/nachunternehmer/pruefen', { fehler: e.message });
      throw e;
    }
    return back(c, '/nachunternehmer/pruefen', { ok: 'Geprüft.' });
  });

  // ------------------------------------------------------------------ Portal-Zugang (Büro)
  app.post(`/lieferanten/:id{${UUID}}/portal`, async (c) => {
    const id = c.req.param('id');
    const { token, pin } = await createPortalAccess(sql, id, c.get('actor'));
    const res = await page(
      c,
      'Portal-Zugang',
      'lieferanten',
      <>
        <PageHead title="Zugang zum Upload-Portal" crumbs={[['Nachweise', `/lieferanten/${id}/nachweise`]]} />
        <div class="card" style="max-width:720px">
          <p>
            Link: <code>{portalUrl(token)}</code>
          </p>
          <p>
            PIN: <b style="font-family:monospace;font-size:20px">{pin}</b>
          </p>
          <p class="small mut">
            Jetzt notieren. Link und PIN bitte auf getrennten Wegen schicken (z. B. Link per E-Mail, PIN per
            Telefon/SMS). Die PIN wird nicht wieder angezeigt; nach 5 Fehlversuchen ist der Zugang 15 Minuten
            gesperrt.
          </p>
          <a class="btn" href={`/lieferanten/${id}/nachweise`}>
            Fertig
          </a>
        </div>
      </>,
    );
    res.headers.set('Cache-Control', 'no-store');
    return res;
  });

  app.post(`/lieferanten/:id{${UUID}}/portal/sperren`, async (c) => {
    const id = c.req.param('id');
    await revokePortal(sql, id, c.get('actor'));
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Zugang gesperrt.' });
  });

  // ------------------------------------------------------------------ Kündigung
  app.post(`/lieferanten/:id{${UUID}}/kuendigung`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    try {
      await terminate(
        sql,
        id,
        {
          date: str(b, 'date') ?? '',
          reasons: ([] as string[]).concat((b.reason as string | string[] | undefined) ?? []),
          note: str(b, 'note'),
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/lieferanten/${id}/nachweise`, { fehler: e.message });
      throw e;
    }
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Kündigung erfasst. Schreiben als PDF unten.' });
  });
  app.post(`/lieferanten/:id{${UUID}}/kuendigung/aufheben`, async (c) => {
    const id = c.req.param('id');
    await revokeTermination(sql, id, c.get('actor'));
    return back(c, `/lieferanten/${id}/nachweise`, { ok: 'Kündigung aufgehoben (Aufträge bitte prüfen).' });
  });
  app.get(`/lieferanten/:id{${UUID}}/kuendigung.pdf`, async (c) =>
    pdfResponse(await terminationPdf(sql, c.req.param('id')), 'Kuendigung.pdf'),
  );

  // ------------------------------------------------------------------ Aufträge
  // Aufträge an Nachunternehmer = Bestellungen (eine gemeinsame Liste unter /bestellungen)
  app.get('/nachunternehmer/auftraege', (c) => c.redirect('/bestellungen?art=nu'));

  app.get(`/nachunternehmer/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontract(sql, id);
    const sc = data?.contract;
    const [subs, sites] = await Promise.all([
      sql<{ id: string; supplier_no: string; name: string }[]>`
        select id, supplier_no, name from app.suppliers where kind = 'nachunternehmer' and (active or id = ${sc?.supplier_id ?? null}) order by name`,
      sql<
        { id: string; site_no: string; name: string; customer_name: string }[]
      >`select s.id, s.site_no, s.name, s.street, s.city, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id where s.active order by s.name`,
    ]);
    const draft = !sc || sc.status === 'entwurf';
    // Preis 0 bei erteilter Bestellung (z. B. Anfrage der Objektleitung): einmal nachtragen (Ahmed 20.10.)
    const priceOpen = !!sc && !draft && sc.status !== 'storniert';
    const priceMissing = priceOpen && BigInt(sc.price_cents) === 0n;
    const comp =
      sc && sc.status === 'entwurf'
        ? (await complianceOverview(sql)).find((r) => r.supplier.id === sc.supplier_id && r.requiredTotal > 0)
        : undefined;
    // Sammelbestellung: Objekte mit Fläche (Ahmed 19.10.)
    const sammel = sc ? await subcontractSites(sql, id) : [];
    // Unser Erlös je Objekt und Monat aus den laufenden Leistungen (Ahmed 23.10.: Preise sehen, die wir erhalten)
    const ourRevenue = new Map<string, bigint>();
    /** Objekte, an denen unser Auftrag je m² abgerechnet wird → Vorschlag „je m²“ */
    const ourSqm = new Set<string>();
    if (sammel.length) {
      const months: Record<string, number> = {
        zweimonatlich: 2,
        quartalsweise: 3,
        halbjaehrlich: 6,
        jaehrlich: 12,
      };
      const rows = await sql<
        {
          site_id: string;
          quantity_milli: bigint;
          unit_price_cents: bigint;
          billing_cycle: string;
          unit_code: string;
        }[]
      >`
        select site_id, quantity_milli, unit_price_cents, billing_cycle::text as billing_cycle, unit_code
          from app.site_services
         where active and site_id = any(${sammel.map((r) => r.site_id)}::uuid[])
           and (kind = 'monthly_flat' or billing_cycle in ('zweimonatlich','quartalsweise','halbjaehrlich','jaehrlich'))
           and valid_from <= current_date and (valid_to is null or valid_to >= current_date)`;
      for (const r of rows) {
        if (r.unit_code === 'MTK') ourSqm.add(r.site_id);
        const n = BigInt(months[r.billing_cycle] ?? 1);
        const amt = (BigInt(r.quantity_milli) * BigInt(r.unit_price_cents) + 500n) / 1000n;
        ourRevenue.set(r.site_id, (ourRevenue.get(r.site_id) ?? 0n) + (amt + n / 2n) / n);
      }
    }
    const customers = await sql<{ id: string; customer_no: string; name: string; n: number }[]>`
      select c.id, c.customer_no, c.name, count(s.id)::int as n from app.customers c
        join app.sites s on s.customer_id = c.id and s.active
       group by c.id having count(s.id) > 1 order by c.name`;
    // Bestellung für einen Kunden ohne festes Objekt (Ahmed 29.10.: Einzelaufträge): Kunden + offene Einzelaufträge
    const allCustomers = await sql<{ id: string; customer_no: string; name: string }[]>`
      select id, customer_no, name from app.customers
       where not coalesce(is_internal, false) and (active or id = (select customer_id from app.sites where id = ${sc?.site_id ?? null}))
       order by name`;
    const orders = await sql<
      {
        id: string;
        number: string;
        customer_id: string;
        title: string;
        place: string | null;
        planned_date: string | null;
      }[]
    >`select o.id, o.number, o.customer_id, o.title, coalesce(o.place, s.name) as place, o.planned_date::text
        from app.orders o left join app.sites s on s.id = o.site_id
       where (o.status in ('offen', 'in_arbeit', 'erledigt') and o.invoice_id is null) or o.id = ${sc?.order_id ?? null}
       order by o.number desc limit 500`;
    const scOrder = sc?.order_id ? (orders.find((o) => o.id === sc.order_id) ?? null) : null;
    const scCustomer = sc
      ? ((await sql<{ customer_id: string }[]>`select customer_id from app.sites where id = ${sc.site_id}`)[0]
          ?.customer_id ?? null)
      : null;
    const forCustomer = !!scOrder || (draft && c.req.query('kunde') ? true : false);
    const tracking = sc ? ((await billingTracking(sql, [id], { limit: 24 })).get(id) ?? []) : [];
    const hours: SubcontractHourRow[] = sc?.billing === 'stunde' ? await listSubcontractHours(sql, id) : [];
    // „je Tag“: Arbeitstage je Monat (Wochentage ohne Feiertage und Schließzeiten), Ahmed 22.10.
    const closures = sc?.billing === 'tag' ? await listClosures(sql, id) : [];
    const dayMonths = (() => {
      if (!sc || sc.billing !== 'tag') return [];
      const cur = todayBerlin().slice(0, 7);
      const shift = (m: string, n: number) => {
        const d = new Date(`${m}-15T12:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + n);
        return d.toISOString().slice(0, 7);
      };
      const priceOf = (m: string) =>
        [...(data?.prices ?? [])].reverse().find((p) => p.valid_from_month.slice(0, 7) <= m)?.price_cents ??
        sc.price_cents;
      return [-1, 0, 1, 2]
        .map((n) => shift(cur, n))
        .filter((m) => m >= sc.valid_from.slice(0, 7) && (!sc.valid_to || m <= sc.valid_to.slice(0, 7)))
        .map((m) => {
          const r = countDays(m, {
            workDays: sc.work_days,
            validFrom: sc.valid_from,
            validTo: sc.valid_to,
            closures,
          });
          const price = BigInt(priceOf(m));
          return { month: m, ...r, price, amount: price * BigInt(r.days), current: m === cur };
        });
    })();
    const hourMonths = new Map<string, { minutes: number; amount: bigint; rows: typeof hours }>();
    for (const h of hours) {
      const k = h.work_date.slice(0, 7);
      const m = hourMonths.get(k) ?? { minutes: 0, amount: 0n, rows: [] as typeof hours };
      m.minutes += h.total_minutes;
      m.amount += BigInt(h.amount_cents);
      m.rows.push(h);
      hourMonths.set(k, m);
    }
    const fmtH = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    const maxMin = sc?.max_hours_month ? Math.round(Number(sc.max_hours_month) * 60) : null;
    // Leistung = unsere Leistungsarten (Einstellungen → Leistungsarten), bisheriger Wert bleibt wählbar
    const kindOptions = [
      ...new Set([
        ...(await listServiceTypes(sql)).map((t) => t.name),
        ...(sc?.service_kind ? [sc.service_kind] : []),
      ]),
    ];
    const sammelPerObject =
      sammel.length > 0 && !!sc && (sc.billing === 'qm' || sc.billing === 'pauschale_monat');
    const sammelSum = sammelPerObject ? ((await sammelTotals(sql, [sc!])).get(sc!.id) ?? null) : null;
    const editForm = (
      <>
        <form
          method="post"
          action={`/nachunternehmer/auftraege/${id}`}
          class="card"
          data-autosave
          data-version={String(sc?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(sc?.version ?? '')} />
          {!draft && sc?.status !== 'storniert' && (
            <div class="flash" style="margin-top:0">
              <div>
                {priceMissing && <b>Preis fehlt noch – bitte jetzt eintragen und speichern. </b>}
                Bestellung ist {SC_STATUS[sc!.status]}: Objekt, Leistung, Häufigkeit, Abrechnung, Stunden,
                Zeitraum, Beschreibung und Preis lassen sich korrigieren (alter Stand im Protokoll). Der Preis
                gilt ab Beginn – ändert er sich erst ab einem bestimmten Monat, bitte unten als{' '}
                <b>Preisnachtrag ab Monat</b>
                erfassen.
                {sc?.signed_file_path || sc?.signed_external
                  ? ' Achtung: Die Bestellung ist bereits unterschrieben – bei inhaltlichen Änderungen neu unterschreiben lassen.'
                  : ''}
              </div>
            </div>
          )}
          {!draft && (
            <>
              <input type="hidden" name="supplier_id" value={sc!.supplier_id} />
              {!priceOpen && <input type="hidden" name="price" value={centsToInput(sc!.price_cents)} />}
            </>
          )}
          <fieldset disabled={sc?.status === 'storniert'} style="border:0;padding:0;margin:0">
            <div class="grid">
              <div>
                <label for="nu">Nachunternehmer</label>
                <select id="nu" name={draft ? 'supplier_id' : undefined} required disabled={!draft}>
                  <option value="">– bitte wählen –</option>
                  {subs.map((s) => (
                    <option value={s.id} selected={s.id === (sc?.supplier_id ?? c.req.query('nu'))}>
                      {s.name} ({s.supplier_no})
                    </option>
                  ))}
                </select>
              </div>
              {draft && (
                <div>
                  <label for="sammel-art">Bestellung für</label>
                  <select id="sammel-art" name="sammel">
                    <option value="">ein Objekt</option>
                    <option value="1" selected={sammel.length > 0}>
                      mehrere Objekte – eine Sammelbestellung (eine Nummer, eine Unterschrift)
                    </option>
                    {sammel.length === 0 && (
                      <option value="kunde" selected={forCustomer}>
                        einen Kunden ohne festes Objekt (z. B. Einzelaufträge)
                      </option>
                    )}
                  </select>
                  <div class="small mut sammel-only">
                    Objekte und Preise je Objekt stehen in der Liste „Sammelbestellung“ – der Gesamtpreis
                    ergibt sich daraus.
                  </div>
                </div>
              )}
              {draft && sammel.length === 0 && (
                <div class="sammel-only">
                  <label for="sammel-kunde">Objekte aufnehmen</label>
                  <select id="sammel-kunde" name="sammel_kunde">
                    <option value="">– alle Objekte eines Kunden … –</option>
                    {customers.map((k) => (
                      <option value={k.id}>
                        {k.name} ({k.customer_no}) · {k.n} Objekte
                      </option>
                    ))}
                  </select>
                  <div data-multi="more_sites" style="margin-top:6px">
                    <div
                      class="multi-chips"
                      style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px"
                    ></div>
                    <select id="more-sites" aria-label="einzelne Objekte">
                      <option value="">+ oder einzelne Objekte …</option>
                      <SiteOptions sites={sites} />
                    </select>
                  </div>
                  <div class="small mut">
                    Nach dem Speichern erscheinen die Objekte unten in der Liste – dort Preise je Objekt
                    eintragen und weitere hinzufügen.
                  </div>
                </div>
              )}
              {draft && sammel.length === 0 && (
                <div class="kunde-only">
                  <label for="bestell-kunde">Kunde</label>
                  <select id="bestell-kunde" name="bestell_kunde">
                    <option value="">– bitte wählen –</option>
                    {allCustomers.map((k) => (
                      <option value={k.id} selected={k.id === (scCustomer ?? c.req.query('kunde'))}>
                        {k.customer_no} · {k.name}
                      </option>
                    ))}
                  </select>
                  <label for="bestell-auftrag" style="margin-top:8px">
                    Einzelauftrag (optional)
                  </label>
                  <select id="bestell-auftrag" name="order_id">
                    <option value="">– kein bestimmter Einzelauftrag –</option>
                    {orders.map((o) => (
                      <option
                        value={o.id}
                        data-kunde={o.customer_id}
                        selected={o.id === (sc?.order_id ?? c.req.query('auftrag'))}
                      >
                        {o.number} · {o.title}
                        {o.place ? ` · ${o.place}` : ''}
                        {o.planned_date ? ` · ${dateDe(o.planned_date)}` : ''}
                      </option>
                    ))}
                  </select>
                  <div class="small mut">
                    Die Kosten laufen auf das Objekt des Einzelauftrags, sonst auf das Objekt „Allgemein“ des
                    Kunden (wird bei Bedarf angelegt).
                  </div>
                </div>
              )}
              {!draft && scOrder && (
                <div>
                  <label>Einzelauftrag</label>
                  <input type="hidden" name="order_id" value={scOrder.id} />
                  <div style="padding-top:8px">
                    {scOrder.number} · {scOrder.title}
                    {scOrder.place ? ` · ${scOrder.place}` : ''}
                  </div>
                </div>
              )}
              {sammel.length > 0 ? (
                <div>
                  <label>Objekte</label>
                  <input type="hidden" name="site_id" value={sc!.site_id} />
                  <div style="padding-top:8px">
                    Sammelbestellung – {anz(sammel.length, 'Objekt', 'Objekte')}{' '}
                    <a href="#sammel" class="small">
                      Liste ansehen
                    </a>
                  </div>
                </div>
              ) : (
                <div class="single-only">
                  <label for="site">Objekt</label>
                  <select id="site" name="site_id" required={!draft}>
                    <option value="">– bitte wählen –</option>
                    <SiteOptions sites={sites} selected={sc?.site_id ?? c.req.query('objekt')} />
                  </select>
                </div>
              )}
              <div>
                <label for="kind">Leistung</label>
                <select id="kind" name="service_kind">
                  {kindOptions.map((k) => (
                    <option value={k} selected={k === (sc?.service_kind ?? kindOptions[0])}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="freq">Häufigkeit</label>
                <select id="freq" name="frequency">
                  {Object.entries(FREQUENCY).map(([k, v]) => (
                    <option value={k} selected={k === (sc?.frequency ?? 'monatlich')}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="billing">Abrechnung</label>
                <select id="billing" name="billing">
                  {Object.entries(BILLING).map(([k, v]) => (
                    <option value={k} selected={k === sc?.billing}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              {sammelPerObject ? (
                <div>
                  <label>Preis netto</label>
                  {(draft || priceOpen) && (
                    <input type="hidden" name="price" value={sc ? centsToInput(sc.price_cents) : ''} />
                  )}
                  <div style="padding-top:8px">
                    {sammelSum !== null ? <b>{euro(sammelSum)} / Monat</b> : '–'}{' '}
                    <span class="small mut">Summe der Objekte (Liste unten)</span>
                  </div>
                </div>
              ) : (
                <div id="price-box">
                  <label for="price">Preis netto (€)</label>
                  <input
                    id="price"
                    name={draft || priceOpen ? 'price' : undefined}
                    inputmode="decimal"
                    value={sc ? centsToInput(sc.price_cents) : ''}
                    required
                    disabled={!draft && !priceOpen}
                  />
                </div>
              )}
              <div id="wd-box">
                <label>Arbeitstage (bei „je Tag“)</label>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                  {WEEKDAYS.map((w, i) => (
                    <label style="display:inline-flex;gap:4px;align-items:center;font-weight:400">
                      <input
                        type="checkbox"
                        name="work_days"
                        value={String(i + 1)}
                        checked={(sc?.work_days?.length ? sc.work_days : [1, 2, 3, 4, 5]).includes(i + 1)}
                      />
                      {w}
                    </label>
                  ))}
                </div>
                <div class="small mut">
                  Betrag je Monat = Preis × diese Tage, ohne Feiertage. Schließzeiten an der Bestellung
                  eintragen.
                </div>
              </div>
              <div id="maxh-box">
                <label for="maxh">Max. Stunden</label>
                <input
                  id="maxh"
                  name="max_hours"
                  inputmode="decimal"
                  value={sc?.max_hours_month?.replace('.', ',') ?? ''}
                />
              </div>
              <div id="margin-box">
                <label for="margin">Unsere Marge in %</label>
                <input
                  id="margin"
                  name="margin"
                  inputmode="decimal"
                  placeholder="z. B. 10"
                  value={sc?.margin_bp != null ? String(sc.margin_bp / 100).replace('.', ',') : ''}
                />
                <div class="small mut">Rest geht an den Nachunternehmer (z. B. 10 % Marge → 90 %).</div>
              </div>
              <div>
                <label for="from">Beginn</label>
                <input
                  id="from"
                  type="date"
                  name="valid_from"
                  value={sc?.valid_from ?? todayBerlin()}
                  required
                />
              </div>
            </div>
            <script dangerouslySetInnerHTML={{ __html: SC_FORM_JS }} />
            <label for="desc">Leistungsumfang</label>
            <textarea id="desc" name="description" rows={4}>
              {sc?.description ?? (sc ? '' : (SERVICE_DESCRIPTIONS[kindOptions[0] ?? ''] ?? ''))}
            </textarea>
            <script
              dangerouslySetInnerHTML={{
                __html: `(function(){var D=${JSON.stringify(SERVICE_DESCRIPTIONS).replace(/</g, '\\u003c')};var k=document.getElementById('kind'),d=document.getElementById('desc');if(!k||!d)return;var last=D[k.value]||'';k.addEventListener('change',function(){var n=D[k.value]||'';if(!d.value.trim()||d.value.trim()===last.trim())d.value=n;last=n;});})();`,
              }}
            />
            <div class="small mut">
              Beim Wechsel der Leistung wird die Standard-Beschreibung eingesetzt, solange nichts Eigenes
              eingetragen ist.
            </div>
          </fieldset>
          <div class="grid">
            <div>
              <label for="to">Ende (optional)</label>
              <input id="to" type="date" name="valid_to" value={sc?.valid_to ?? ''} />
            </div>
            {sc && !draft && (
              <div>
                <label for="issued">Bestelldatum</label>
                <input
                  id="issued"
                  type="date"
                  name="issued_on"
                  max={todayBerlin()}
                  value={
                    sc.issued_at
                      ? new Date(sc.issued_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
                      : ''
                  }
                />
              </div>
            )}
            <div>
              <label for="note">Notiz</label>
              <input id="note" name="note" value={sc?.note ?? ''} />
            </div>
          </div>
          <div class="formfoot">
            <a class="btn sec" href="/nachunternehmer/auftraege">
              Zurück
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>
    );
    const perObjectInfo =
      sc && ['qm', 'pauschale_monat'].includes(sc.billing)
        ? ' Je Objekt „je m²“ (Preis leer = Preis der Bestellung) oder „Pauschale“ wählen – vorgeschlagen wie unser Auftrag am Objekt. Kosten NU = Summe der Objekte.'
        : '';
    const sammelBlock = (
      <>
        {sc && sc.status !== 'storniert' && (sammel.length > 0 || ['qm', 'umsatz'].includes(sc.billing)) && (
          <section class="card" id="sammel">
            <h3 class="panel-title" style="margin-top:0">
              Sammelbestellung – {anz(sammel.length, 'Objekt', 'Objekte')}
            </h3>
            {(() => {
              const total = sammel.reduce((a, r) => a + (sqmCenti(r.sqm) ?? 0n), 0n);
              const price = BigInt(sc.price_cents);
              const umsatz = sc.billing === 'umsatz';
              // je Objekt wählbar: je m² oder Pauschale (Ahmed 23.10.: wie unser Auftrag am Objekt angelegt ist)
              const perObject = sc.billing === 'qm' || sc.billing === 'pauschale_monat';
              const modeOf = (r: (typeof sammel)[number]) =>
                r.mode ?? (sc.billing === 'qm' ? 'qm' : ourSqm.has(r.site_id) ? 'qm' : 'pauschale');
              const costs = perObject
                ? objectCosts(
                    sc.billing,
                    price,
                    sammel.map((r) => ({ ...r, mode: modeOf(r) })),
                  )
                : null;
              const costSum = costs ? costs.reduce((a, b) => a + b, 0n) : null;
              const centsDe = (v: string | null) =>
                v === null ? '' : (Number(v) / 100).toFixed(2).replace('.', ',');
              const priceDe = (Number(price) / 100).toFixed(2).replace('.', ',');
              return (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/objekte`}>
                  <table>
                    <thead>
                      <tr>
                        <th>Objekt</th>
                        {perObject && <th>Abrechnung</th>}
                        <th class="num">Fläche m²</th>
                        {perObject && <th class="num">€ je m² bzw. Pauschale €</th>}
                        <th class="num">{umsatz ? 'Nachunternehmer' : 'Kosten NU / Monat'}</th>
                        <th class="num">Unser Erlös / Monat</th>
                        <th>entfernen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sammel.map((r, i) => {
                        const m = modeOf(r);
                        const rev = ourRevenue.get(r.site_id);
                        const cost = costs?.[i];
                        return (
                          <tr>
                            <td>
                              <input type="hidden" name="site" value={r.site_id} />
                              <a href={`/objekte/${r.site_id}`}>
                                {r.site_no} {r.name}
                              </a>
                              <div class="small mut">
                                {[r.street, r.city].filter(Boolean).join(', ')} · {r.customer_name}
                              </div>
                            </td>
                            {perObject && (
                              <td>
                                <select
                                  name="mode"
                                  aria-label="Abrechnung"
                                  data-nosearch
                                  style="width:auto"
                                  onchange="var t=this.closest('tr');t.querySelector('[name=rate]').hidden=this.value!=='qm';t.querySelector('[name=betrag]').hidden=this.value!=='pauschale'"
                                >
                                  <option value="qm" selected={m === 'qm'}>
                                    je m²
                                  </option>
                                  <option value="pauschale" selected={m === 'pauschale'}>
                                    Pauschale
                                  </option>
                                </select>
                                {!r.mode && (
                                  <div class="small mut">
                                    {ourSqm.has(r.site_id) ? 'unser Auftrag: je m²' : 'Vorschlag'}
                                  </div>
                                )}
                              </td>
                            )}
                            <td class="num">
                              <input
                                name="sqm"
                                inputmode="decimal"
                                style="width:100px;text-align:right"
                                value={r.sqm ? r.sqm.replace('.', ',') : ''}
                                placeholder={r.sqm_hint ? r.sqm_hint.replace('.', ',') : ''}
                                aria-label="Fläche m²"
                              />
                            </td>
                            {perObject && (
                              <td class="num">
                                <input
                                  name="rate"
                                  inputmode="decimal"
                                  style="width:100px;text-align:right"
                                  value={centsDe(r.rate_cents)}
                                  placeholder={priceDe}
                                  aria-label="Preis je m² €"
                                  hidden={m !== 'qm'}
                                />
                                <input
                                  name="betrag"
                                  inputmode="decimal"
                                  style="width:100px;text-align:right"
                                  value={centsDe(r.share_cents)}
                                  placeholder="0,00"
                                  aria-label="Pauschale je Objekt €"
                                  hidden={m !== 'pauschale'}
                                />
                              </td>
                            )}
                            <td class="num">
                              {umsatz ? (
                                `${String((10000 - (sc.margin_bp ?? 0)) / 100).replace('.', ',')} % vom Umsatz`
                              ) : cost !== undefined ? (
                                m === 'qm' && sqmCenti(r.sqm) === null ? (
                                  <span class="tag warn">m² fehlt</span>
                                ) : m === 'pauschale' && !r.share_cents ? (
                                  <span class="tag warn">Betrag fehlt</span>
                                ) : (
                                  euro(cost)
                                )
                              ) : total > 0n && sqmCenti(r.sqm) !== null ? (
                                <span class="small">
                                  {euro((price * sqmCenti(r.sqm)! + total / 2n) / total)} (Anteil)
                                </span>
                              ) : (
                                ''
                              )}
                            </td>
                            <td class="num">
                              {rev ? (
                                <>
                                  {euro(rev)}
                                  {cost !== undefined && cost > 0n && (
                                    <div
                                      class="small"
                                      style={rev - cost < 0n ? 'color:var(--err)' : 'color:var(--mut)'}
                                    >
                                      DB {euro(rev - cost)}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span class="small mut">keine laufende Leistung</span>
                              )}
                            </td>
                            <td>
                              <input type="checkbox" name="remove" value={r.site_id} aria-label="entfernen" />
                            </td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td colspan={perObject ? 2 : 1}>
                          <b>Summe</b>
                        </td>
                        <td class="num">
                          <b>{(Number(total) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 })}</b>
                        </td>
                        {perObject && <td></td>}
                        <td class="num">
                          <b>{costSum !== null ? euro(costSum) : umsatz ? '' : euro(price)}</b>
                        </td>
                        <td class="num">
                          {(() => {
                            const rev = sammel.reduce((a, r) => a + (ourRevenue.get(r.site_id) ?? 0n), 0n);
                            if (!rev) return null;
                            const cost =
                              costSum ??
                              (umsatz ? (rev * BigInt(10000 - (sc.margin_bp ?? 0)) + 5000n) / 10000n : price);
                            const m = rev - cost;
                            return (
                              <>
                                <b>{euro(rev)}</b>
                                {!umsatz && (
                                  <div class="small" style={m < 0n ? 'color:var(--err)' : 'color:var(--mut)'}>
                                    DB {euro(m)}
                                    {` (${((Number(m) / Number(rev)) * 100).toFixed(0)} %)`}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                  <div class="actions">
                    <button class="btn sm">Speichern / markierte entfernen</button>
                  </div>
                </form>
              );
            })()}
            <details style="margin-top:10px">
              <summary>Objekte hinzufügen</summary>
              <form method="post" action={`/nachunternehmer/auftraege/${id}/objekte`} style="margin-top:8px">
                <input type="hidden" name="aktion" value="hinzufuegen" />
                <label for="add-kunde">Alle aktiven Objekte eines Kunden</label>
                <select id="add-kunde" name="kunde" style="max-width:520px">
                  <option value="">– kein Kunde –</option>
                  {customers.map((k) => (
                    <option value={k.id}>
                      {k.name} ({k.customer_no}) · {k.n} Objekte
                    </option>
                  ))}
                </select>
                <label for="add-sites" style="margin-top:8px">
                  oder einzelne Objekte
                </label>
                <div data-multi="add_sites">
                  <div
                    class="multi-chips"
                    style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px"
                  ></div>
                  <select id="add-sites" style="max-width:520px">
                    <option value="">+ Objekt hinzufügen …</option>
                    <SiteOptions sites={sites} />
                  </select>
                </div>
                <button class="btn sm" style="margin-top:8px">
                  Hinzufügen
                </button>
              </form>
            </details>
            <p class="small mut" style="margin-bottom:0">
              Fläche leer = Vorschlag aus Tiefgarage bzw. Raumbuch (grau). Eingangsrechnungen dieser
              Bestellung werden automatisch auf die Objekte verteilt –{' '}
              {sc.billing === 'umsatz'
                ? 'nach unserem Umsatz je Objekt im Leistungsmonat'
                : sc.billing !== 'qm' && sammel.some((r) => Number(r.share_cents ?? 0) > 0)
                  ? 'nach Betrag je Objekt'
                  : 'nach Fläche'}
              ; ohne Fläche gleichmäßig.
              {perObjectInfo}
            </p>
          </section>
        )}
      </>
    );
    const below = !!comp && comp.missing.length > 0 && comp.requiredOk * 2 < comp.requiredTotal;
    // Aktionen links in einer Reihe, Unterschrift als großer Kasten rechts (Ahmed 23.10.)
    const signBlock = (
      <>
        {sc && (
          <div class="sc-sign">
            {(draft || sc.status === 'erteilt') && (
              <div class="card sc-sign-act">
                <h3 class="panel-title" style="margin-top:0">
                  {sc.status === 'entwurf' ? 'Auftrag erteilen' : 'Preisnachtrag'}
                </h3>
                {sc.status === 'entwurf' && comp && comp.missing.length > 0 && (
                  <div class={below ? 'flash err' : 'flash warn'} style="margin:0 0 10px;display:block">
                    <strong>
                      Nachweise unvollständig: {comp.requiredOk} von {comp.requiredTotal} Pflicht-Nachweisen
                      gültig.
                    </strong>
                    <div class="small" style="margin-top:4px">
                      Fehlt: {comp.missing.join(', ')}. Als Auftraggeber haften wir für Mindestlohn und
                      SV-Beiträge des Nachunternehmers (§ 13 MiLoG, § 14 AEntG, § 28e Abs. 3a SGB IV) –
                      fehlende Nachweise zeitnah nachfordern.
                    </div>
                  </div>
                )}
                {sc.status === 'entwurf' && below && (
                  <label
                    class="chk"
                    style="margin:0 0 10px;display:flex;gap:8px;align-items:flex-start;font-weight:600"
                  >
                    <input
                      type="checkbox"
                      form="erteil-form"
                      name="hinweis_ok"
                      value="1"
                      required
                      style="width:auto;margin-top:3px"
                    />
                    <span>Hinweis zur Kenntnis genommen – Auftrag trotzdem erteilen</span>
                  </label>
                )}
                {draft && (
                  <div class="sc-btnrow">
                    {sc.status === 'entwurf' && (
                      <form
                        id="erteil-form"
                        method="post"
                        action={`/nachunternehmer/auftraege/${id}/status`}
                        style="margin:0"
                      >
                        <button class="btn" name="status" value="erteilt">
                          Auftrag erteilen
                        </button>
                      </form>
                    )}
                    <a class="btn sec" href={`/nachunternehmer/auftraege/${id}/auftrag.pdf`} target="_blank">
                      Bestellschein (PDF)
                    </a>
                    {sc.status === 'erteilt' && (sc.signed_file_path || sc.signed_external) && (
                      <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                        <button
                          class="btn sec"
                          name="status"
                          value="beendet"
                          onclick="return confirm('Auftrag als komplett erledigt markieren? Er gilt dann als beendet (Ende = heute, falls kein Ende eingetragen).')"
                        >
                          ✓ Als erledigt markieren
                        </button>
                      </form>
                    )}
                    {sc.status === 'entwurf' && (
                      <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                        <button
                          class="btn ghost"
                          name="status"
                          value="storniert"
                          onclick="return confirm('Bestellung stornieren?')"
                        >
                          Stornieren
                        </button>
                      </form>
                    )}
                  </div>
                )}
                {sc.status === 'entwurf' && (
                  <p class="small mut" style="margin:8px 0 0">
                    Änderungen unten vorher speichern.
                  </p>
                )}
                {draft && sc.status === 'erteilt' && !sc.signed_file_path && !sc.signed_external && (
                  <p class="small" style="color:var(--bad);margin:8px 0 0">
                    Erledigt erst mit unterschriebenem Auftrag (rechts: Handy oder Scan).
                  </p>
                )}
                {sc.status === 'erteilt' && (
                  <details style="margin-top:12px">
                    <summary>Preisnachtrag ab Monat</summary>
                    {data!.prices.map((p) => (
                      <div class="small">
                        ab {p.valid_from_month.slice(5, 7)}/{p.valid_from_month.slice(0, 4)}:{' '}
                        {euro(p.price_cents)} – {p.reason}
                      </div>
                    ))}
                    <form method="post" action={`/nachunternehmer/auftraege/${id}/nachtrag`} class="actions">
                      <input type="hidden" name="id" value={randomUUID()} />
                      <input type="month" name="month" required aria-label="ab Monat" />
                      <input
                        name="price"
                        inputmode="decimal"
                        placeholder="neuer Preis"
                        required
                        style="max-width:140px"
                      />
                      <input
                        name="reason"
                        placeholder="Grund, z. B. Tariflohnerhöhung"
                        required
                        style="max-width:280px"
                      />
                      <button class="btn sec sm">Nachtrag speichern</button>
                    </form>
                  </details>
                )}
              </div>
            )}
            <div class={`card sc-sign-box${sc.signed_file_path || sc.signed_external ? ' done' : ''}`}>
              <h3 class="panel-title" style="margin-top:0">
                Unterschrift des Nachunternehmers
              </h3>
              {sc.signed_file_path ? (
                <>
                  <p style="margin:0 0 8px">
                    <span class="badge ok">unterschrieben</span>{' '}
                    <span class="small mut">SHA-256 {sc.signed_file_sha256?.slice(0, 16)}…</span>
                  </p>
                  <a class="btn sec" href={`/nachunternehmer/auftraege/${id}/scan`} target="_blank">
                    Unterschriebenen Auftrag öffnen
                  </a>
                </>
              ) : (
                <>
                  {sc.signed_external && (
                    <p style="margin:0 0 8px">
                      <span class="badge ok">{sc.signed_external}</span>
                    </p>
                  )}
                  <div class="sc-sign-ways">
                    <div class="sc-sign-way">
                      <b>Am Handy / Tablet</b>
                      <div class="small mut">
                        Nachunternehmer unterschreibt mit dem Finger, PDF wird abgelegt.
                      </div>
                      {sc.status === 'erteilt' ? (
                        <a class="btn" href={`/nachunternehmer/auftraege/${id}/unterschreiben`}>
                          Jetzt unterschreiben lassen
                        </a>
                      ) : (
                        <div class="small" style="margin-top:6px">
                          möglich, sobald der Auftrag erteilt ist
                        </div>
                      )}
                    </div>
                    <div class="sc-sign-way">
                      <b>Auf Papier unterschrieben</b>
                      <div class="small mut">
                        Bestellschein drucken, unterschreiben lassen, Scan hochladen.
                      </div>
                      <form
                        method="post"
                        action={`/nachunternehmer/auftraege/${id}/scan`}
                        enctype="multipart/form-data"
                        style="margin:6px 0 0"
                      >
                        <input
                          type="file"
                          name="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          required
                          aria-label="Scan"
                        />
                        <button class="btn sec sm" style="margin-top:6px">
                          Scan hochladen
                        </button>
                      </form>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </>
    );
    const daysBlock = sc && sc.billing === 'tag' && (
      <div class="card" id="tage">
        <h3 style="margin-top:0">Arbeitstage & Schließzeiten</h3>
        <p class="small mut" style="margin-top:-6px">
          Betrag je Monat = Preis je Tag × Arbeitstage ({workDaysLabel(sc.work_days)}, ohne Feiertage in
          Bayern und ohne Schließzeiten). Wochentage ändern unter „Bestellung bearbeiten“.
        </p>
        <div class="tbl">
          <table class="keep">
            <thead>
              <tr>
                <th>Monat</th>
                <th class="r">Arbeitstage</th>
                <th class="r">Feiertage</th>
                <th class="r">geschlossen</th>
                <th class="r">Betrag netto</th>
              </tr>
            </thead>
            <tbody>
              {dayMonths.map((m) => (
                <tr style={m.current ? 'font-weight:600' : ''}>
                  <td>
                    {m.month.slice(5, 7)}/{m.month.slice(0, 4)}
                    {m.current && <span class="small mut"> · laufend</span>}
                  </td>
                  <td class="r">{m.days}</td>
                  <td class="r">{m.holidays || '–'}</td>
                  <td class="r">{m.closed || '–'}</td>
                  <td class="r">
                    {euro(m.amount)}{' '}
                    <span class="small mut">
                      ({m.days} × {euro(m.price)})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h4>Schließzeiten</h4>
        {closures.length === 0 ? (
          <p class="small mut">Keine eingetragen.</p>
        ) : (
          <ul class="plain">
            {closures.map((x) => (
              <li>
                {dateDe(x.date_from)}
                {x.date_to !== x.date_from && ` – ${dateDe(x.date_to)}`}
                {x.note && <span class="mut"> · {x.note}</span>}{' '}
                <form
                  method="post"
                  action={`/nachunternehmer/auftraege/${sc.id}/schliesszeit/${x.id}/loeschen`}
                  style="display:inline"
                >
                  <button class="btn ghost sm" data-confirm="Schließzeit entfernen?">
                    entfernen
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form
          method="post"
          action={`/nachunternehmer/auftraege/${sc.id}/schliesszeit`}
          class="actions"
          style="align-items:flex-end;flex-wrap:wrap"
        >
          <input type="hidden" name="id" value={randomUUID()} />
          <div>
            <label for="cl-from">von</label>
            <input id="cl-from" type="date" name="from" required />
          </div>
          <div>
            <label for="cl-to">bis</label>
            <input id="cl-to" type="date" name="to" />
          </div>
          <div style="flex:1;min-width:180px">
            <label for="cl-note">Grund (optional)</label>
            <input id="cl-note" name="note" placeholder="z. B. Herbstferien, Betriebsruhe" />
          </div>
          <button class="btn sec sm">Schließzeit eintragen</button>
        </form>
        <form method="post" action={`/nachunternehmer/auftraege/${sc.id}/schliesszeit/schulferien`}>
          <button
            class="btn ghost sm"
            data-confirm="Alle bekannten Schulferien Bayern (und Buß- und Bettag) als Schließzeiten eintragen?"
          >
            Schule: alle Schulferien eintragen
          </button>
          <span class="small mut"> Ferientermine Bayern bis {dateDe(SCHOOL_DATA_UNTIL)}</span>
        </form>
      </div>
    );
    const hoursBlock = (
      <>
        {sc && sc.billing === 'stunde' && sc.status !== 'entwurf' && (
          <div class="card" id="stunden">
            <h3 style="margin-top:0">Stundennachweis</h3>
            <p class="small mut" style="margin-top:-6px">
              Je Tag: wie viele Leute des Nachunternehmers wie viele Stunden gearbeitet haben. Betrag =
              Personen × Stunden × Stundensatz des Monats. Zum Prüfen der Rechnung; fehlt die Rechnung,
              rechnet die Nachkalkulation mit diesen Stunden.
            </p>
            {sc.status !== 'storniert' && (
              <form
                method="post"
                action={`/nachunternehmer/auftraege/${id}/stunden`}
                class="actions"
                style="align-items:end"
              >
                <input type="hidden" name="id" value={randomUUID()} />
                <div>
                  <label for="h-date">Datum</label>
                  <input id="h-date" type="date" name="work_date" value={todayBerlin()} required />
                </div>
                <div>
                  <label for="h-p">Personen</label>
                  <input
                    id="h-p"
                    type="number"
                    name="persons"
                    min="1"
                    max="200"
                    value="1"
                    required
                    style="max-width:90px"
                  />
                </div>
                <div>
                  <label for="h-h">Std. je Person</label>
                  <input
                    id="h-h"
                    name="hours"
                    inputmode="decimal"
                    placeholder="2,5 oder 2:30"
                    required
                    style="max-width:120px"
                  />
                </div>
                <div style="flex:1;min-width:160px">
                  <label for="h-n">Bemerkung</label>
                  <input id="h-n" name="note" placeholder="z. B. Treppenhaus, Sonderreinigung" />
                </div>
                <button class="btn sm">Stunden erfassen</button>
              </form>
            )}
            {maxMin !== null &&
              !isRecurringOrder(sc.frequency) &&
              hours.reduce((a, h) => a + h.total_minutes, 0) > maxMin && (
                <div class="alert warn">
                  Erfasst sind mehr als die max. {Number(sc.max_hours_month).toLocaleString('de-DE')} Std.
                  dieser Bestellung.
                </div>
              )}
            {hours.length === 0 ? (
              <div class="empty">Noch keine Stunden erfasst.</div>
            ) : (
              <div class="tablewrap">
                <table class="stack-m">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th class="r">Personen</th>
                      <th class="r">Std. je Person</th>
                      <th class="r">Std. gesamt</th>
                      <th class="r">Betrag netto</th>
                      <th>Bemerkung</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...hourMonths.entries()].map(([mon, m]) => (
                      <>
                        <tr style="background:var(--soft,#f6f6f6)">
                          <td colspan={3}>
                            <b>
                              {mon.slice(5, 7)}/{mon.slice(0, 4)}
                            </b>
                            {maxMin !== null && isRecurringOrder(sc.frequency) && m.minutes > maxMin && (
                              <span class="badge err" style="margin-left:8px">
                                über max. {Number(sc.max_hours_month).toLocaleString('de-DE')} Std.
                              </span>
                            )}
                          </td>
                          <td class="r">
                            <b>{fmtH(m.minutes)}</b>
                          </td>
                          <td class="r">
                            <b>{euro(m.amount)}</b>
                          </td>
                          <td colspan={2} />
                        </tr>
                        {m.rows.map((h) => (
                          <tr>
                            <td>{dateDe(h.work_date)}</td>
                            <td class="r">{h.persons}</td>
                            <td class="r">{fmtH(h.minutes_per_person)}</td>
                            <td class="r">{fmtH(h.total_minutes)}</td>
                            <td class="r">{euro(h.amount_cents)}</td>
                            <td class="small">
                              {h.note}
                              <div class="mut">{fullName({ login: h.created_by })}</div>
                            </td>
                            <td class="r">
                              <form
                                method="post"
                                action={`/nachunternehmer/auftraege/${id}/stunden/${h.id}/loeschen`}
                                onsubmit="return confirm('Eintrag löschen?')"
                              >
                                <button class="btn ghost sm" title="Löschen" aria-label="Löschen">
                                  <Icon name="trash" />
                                </button>
                              </form>
                            </td>
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </>
    );
    const trackBlock = (
      <>
        {sc && tracking.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Rechnungsverfolgung</h3>
            <p class="small mut" style="margin-top:-6px">
              Je Abrechnungszeitraum bis heute (laufender Zeitraum oben): ist die Rechnung des
              Nachunternehmers da? Zuordnung im Rechnungseingang („Aufträge / Zeiträume“).
            </p>
            <div class="tablewrap">
              <table class="stack-m">
                <thead>
                  <tr>
                    <th>Zeitraum</th>
                    <th>Status</th>
                    <th>Eingangsrechnung</th>
                    <th class="r">netto</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tracking.map((p) => (
                    <tr>
                      <td data-l="Zeitraum">
                        {p.start.slice(5, 7)}/{p.start.slice(0, 4)}
                        {p.end.slice(0, 7) !== p.start ? (
                          <span class="small mut"> – {dateDe(p.end)}</span>
                        ) : null}
                      </td>
                      <td data-l="Status">
                        {p.state === 'abgerechnet' ? (
                          <span class="badge ok">abgerechnet</span>
                        ) : p.state === 'keine' ? (
                          <span class="badge" title={p.skipReason ?? ''}>
                            keine Rechnung · {p.skipReason}
                          </span>
                        ) : p.state === 'laufend' ? (
                          <span class="badge info">läuft noch</span>
                        ) : p.state === 'bedarf' ? (
                          <span class="badge">nach Ausführung</span>
                        ) : (
                          <span class="badge warn">Rechnung fehlt</span>
                        )}
                      </td>
                      <td data-l="Rechnung">
                        {p.invoices.map((i, k) => (
                          <>
                            {k ? ', ' : ''}
                            <a href={`/rechnungseingang/${i.id}`}>{i.invoice_no}</a>
                            {i.loose && (
                              <span
                                class="small mut"
                                title="Nicht dieser Bestellung zugeordnet – nur über gleichen Nachunternehmer und gleiches Objekt erkannt"
                              >
                                {' '}
                                (ohne Zuordnung, vermutet)
                              </span>
                            )}
                          </>
                        ))}
                        {p.noted === OTHER_ORDER && (
                          <form
                            method="post"
                            action={`/nachunternehmer/auftraege/${id}/keine-rechnung/zuruecknehmen`}
                            class="small mut"
                            style="margin:0"
                          >
                            <input type="hidden" name="monat" value={p.start} />
                            vermutete Rechnung ausgeblendet ·{' '}
                            <button class="linkbtn small">wieder anzeigen</button>
                          </form>
                        )}
                        {p.state === 'abgerechnet' && p.invoices.some((i) => !i.loose) && (
                          <div class="small mut">
                            gehört zu einer anderen Bestellung? In der Eingangsrechnung unter „Zuordnung“ die
                            richtige Bestellung wählen.
                          </div>
                        )}
                      </td>
                      <td class="r" data-l="netto">
                        {p.invoices.some((i) => i.net != null)
                          ? euro(p.invoices.reduce((a, i) => a + (i.net ?? 0n), 0n))
                          : ''}
                      </td>
                      <td>
                        {p.state === 'abgerechnet' && p.invoices.every((i) => i.loose) ? (
                          <details style="display:inline-block">
                            <summary class="btn sm ghost">gehört nicht dazu …</summary>
                            <form
                              method="post"
                              action={`/nachunternehmer/auftraege/${id}/keine-rechnung`}
                              class="actions"
                              style="margin-top:6px"
                            >
                              <input type="hidden" name="monat" value={p.start} />
                              <input type="hidden" name="grund" value={OTHER_ORDER} />
                              <span class="small mut">
                                Vermutete Rechnung ausblenden – der Zeitraum bleibt offen.
                              </span>
                              <button class="btn sm">Ausblenden</button>
                            </form>
                          </details>
                        ) : p.noted && p.state === 'keine' ? (
                          <form
                            method="post"
                            action={`/nachunternehmer/auftraege/${id}/keine-rechnung/zuruecknehmen`}
                            style="display:inline"
                          >
                            <input type="hidden" name="monat" value={p.start} />
                            <button class="btn sm ghost">Vermerk zurücknehmen</button>
                          </form>
                        ) : p.state === 'offen' || p.state === 'laufend' ? (
                          <span class="actions" style="margin:0;flex-wrap:nowrap">
                            <a
                              class="btn sm sec"
                              href={`/rechnungseingang/${randomUUID()}?lieferant=${sc.supplier_id}&erwartet=${encodeURIComponent(`${id}:${p.start}`)}`}
                            >
                              Rechnung erfassen
                            </a>
                            <details style="display:inline-block">
                              <summary class="btn sm ghost">keine Rechnung …</summary>
                              <form
                                method="post"
                                action={`/nachunternehmer/auftraege/${id}/keine-rechnung`}
                                class="actions"
                                style="margin-top:6px"
                              >
                                <input type="hidden" name="monat" value={p.start} />
                                <input name="grund" required placeholder="Grund" style="max-width:200px" />
                                <button class="btn sm">Vermerken</button>
                              </form>
                            </details>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>
    );
    // Übersicht oben (Ahmed 20.10.: „unübersichtlich, Rechnung erfassen ganz unten“)
    const openPeriod =
      tracking.find((t) => t.state === 'offen') ?? tracking.find((t) => t.state === 'laufend');
    const siteRow = sites.find((x) => x.id === sc?.site_id) as
      ((typeof sites)[number] & { street?: string; city?: string }) | undefined;
    const signed = !!(sc?.signed_file_path || sc?.signed_external);
    const summary = sc ? (
      <div class="card sc-summary">
        <div class="sc-sum-grid">
          <div>
            <div class="l">Nachunternehmer</div>
            <a href={`/lieferanten/${sc.supplier_id}`}>
              <b>{sc.supplier_name}</b>
            </a>{' '}
            <span class="small mut">{sc.supplier_no}</span>
          </div>
          <div>
            <div class="l">{sammel.length > 0 ? 'Objekte' : 'Objekt'}</div>
            {sammel.length > 0 ? (
              <a href="#sammel">
                <b>Sammelbestellung · {anz(sammel.length, 'Objekt', 'Objekte')}</b>
              </a>
            ) : (
              <>
                <a href={`/objekte/${sc.site_id}`}>
                  <b>{sc.site_name}</b>
                </a>{' '}
                <span class="small mut">{sc.site_no}</span>
                {siteRow?.street && (
                  <div class="small mut">{[siteRow.street, siteRow.city].filter(Boolean).join(', ')}</div>
                )}
                {scOrder && (
                  <div class="small">
                    Einzelauftrag {scOrder.number}
                    {scOrder.place ? ` · ${scOrder.place}` : ''}
                  </div>
                )}
              </>
            )}
          </div>
          <div>
            <div class="l">Leistung</div>
            {sc.service_kind}
            <div class="small mut">
              {FREQUENCY[sc.frequency] ?? sc.frequency} · {BILLING[sc.billing] ?? sc.billing}
            </div>
          </div>
          <div>
            <div class="l">Preis netto</div>
            <b>{euro(sc.current_price_cents)}</b>
            {sc.billing === 'stunde' && sc.max_hours_month && (
              <div class="small mut">max. {sc.max_hours_month.replace('.', ',')} Std.</div>
            )}
          </div>
          <div>
            <div class="l">Zeitraum</div>
            {sc.valid_to || isRecurringOrder(sc.frequency)
              ? `${dateDe(sc.valid_from)} – ${sc.valid_to ? dateDe(sc.valid_to) : 'unbefristet'}`
              : `ab ${dateDe(sc.valid_from)}`}
          </div>
          <div>
            <div class="l">Status</div>
            <span class={`badge ${sc.status === 'erteilt' ? 'ok' : sc.status === 'storniert' ? 'err' : ''}`}>
              {SC_STATUS[sc.status]}
            </span>{' '}
            {sc.status !== 'storniert' &&
              (signed ? (
                <span class="badge ok">unterschrieben</span>
              ) : (
                <span class="badge warn">Unterschrift fehlt</span>
              ))}
          </div>
        </div>
        {openPeriod && (
          <p class="small" style="margin:10px 0 0">
            Rechnung {openPeriod.state === 'offen' ? 'fehlt' : 'läuft'} für{' '}
            <b>
              {openPeriod.start.slice(5, 7)}/{openPeriod.start.slice(0, 4)}
            </b>
          </p>
        )}
        {sc.status !== 'storniert' && (
          <div class="actions" style="margin-bottom:0">
            {(sc.status === 'erteilt' || sc.status === 'beendet') && (
              <a
                class="btn"
                href={`/rechnungseingang/${randomUUID()}?lieferant=${sc.supplier_id}&erwartet=${id}:${openPeriod?.start ?? todayBerlin().slice(0, 7)}`}
              >
                + Rechnung erfassen
              </a>
            )}
            <a class="btn sec" href={`/nachunternehmer/auftraege/${id}/auftrag.pdf`} target="_blank">
              Bestellschein (PDF)
            </a>
            {sc.status === 'erteilt' && !signed && (
              <a class="btn sec" href={`/nachunternehmer/auftraege/${id}/unterschreiben`}>
                Unterschreiben lassen
              </a>
            )}
            {sc.status === 'erteilt' && signed && (
              <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                <button
                  class="btn sec"
                  name="status"
                  value="beendet"
                  onclick="return confirm('Auftrag als komplett erledigt markieren? Er gilt dann als beendet (Ende = heute, falls kein Ende eingetragen).')"
                >
                  ✓ Als erledigt markieren
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    ) : null;
    return page(
      c,
      sc ? `Bestellung ${sc.number}` : 'Neue Bestellung',
      'lieferanten',
      <>
        <PageHead
          title={sc ? `Bestellung ${sc.number}` : 'Neue Bestellung an Nachunternehmer'}
          no={sc ? SC_STATUS[sc.status] : null}
          crumbs={[['Bestellungen', '/bestellungen?art=nu']]}
        />
        {sc?.requested_by && sc.status === 'entwurf' ? (
          <div class="flash warn">
            Angefragt von der Objektleitung ({fullName({ login: sc.requested_by })}) über die App – bitte
            prüfen, Preis ergänzen und erteilen.
            {sc.request_note ? <div style="white-space:pre-line">{sc.request_note}</div> : null}
          </div>
        ) : null}
        {draft ? (
          <>
            {/* Erteilen oben (Ahmed 23.10.: nicht erst nach unten scrollen) – Änderungen vorher speichern */}
            {signBlock}
            {editForm}
            {sammelBlock}
            {hoursBlock}
            {trackBlock}
          </>
        ) : (
          <>
            {summary}
            {trackBlock}
            {daysBlock}
            {sammelBlock}
            {hoursBlock}
            {signBlock}
            <details class="card sc-edit">
              <summary>
                <b>Bestellung bearbeiten</b>{' '}
                <span class="small mut">
                  Objekt, Leistung, Häufigkeit, Abrechnung, Zeitraum, Leistungsumfang
                </span>
              </summary>
              {editForm}
            </details>
          </>
        )}
      </>,
    );
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/keine-rechnung/zuruecknehmen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      await unskipExpected(sql, id, String(b.monat ?? ''), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, {
      ok: 'Vermerk zurückgenommen – Zeitraum wieder offen.',
    });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/keine-rechnung`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      await skipExpected(sql, id, String(b.monat ?? ''), String(b.grund ?? ''), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, {
      ok: 'Vermerkt: für diesen Zeitraum kommt keine Rechnung.',
    });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const cur = await getSubcontract(sql, id);
    const v = str(b, 'version');
    try {
      const sc = cur?.contract;
      const input = {
        supplierId: str(b, 'supplier_id') ?? sc?.supplier_id ?? '',
        siteId: str(b, 'site_id') ?? sc?.site_id ?? '',
        serviceKind: str(b, 'service_kind') ?? sc?.service_kind ?? '',
        frequency: str(b, 'frequency') ?? sc?.frequency ?? '',
        billing: str(b, 'billing') ?? sc?.billing ?? '',
        priceCents: str(b, 'price') ? parseEuro(str(b, 'price')!) : (sc?.price_cents ?? 0n),
        maxHours: str(b, 'max_hours'),
        workDays: arr(b, 'work_days').map(Number),
        marginBp: str(b, 'margin') ? Math.round(Number(str(b, 'margin')!.replace(',', '.')) * 100) : null,
        validFrom: str(b, 'valid_from') ?? sc?.valid_from ?? '',
        validTo: str(b, 'valid_to'),
        description: str(b, 'description'),
        note: str(b, 'note'),
        issuedOn: str(b, 'issued_on'),
        version: v ? Number(v) : null,
      };
      // Sammelbestellung ohne gewähltes Objekt: erstes weiteres Objekt bzw. erstes aktives Objekt des Kunden
      if (!input.siteId && str(b, 'sammel') === '1') {
        const firstMore = ([] as unknown[])
          .concat(b.more_sites ?? [])
          .map(String)
          .find((x) => /^[0-9a-f-]{36}$/.test(x));
        const kunde = str(b, 'sammel_kunde');
        const [first] = kunde
          ? await sql<{ id: string }[]>`
              select id from app.sites where customer_id = ${kunde} and active order by site_no limit 1`
          : [];
        input.siteId = firstMore ?? first?.id ?? '';
      }
      // Bestellung für einen Kunden ohne festes Objekt (Ahmed 29.10.): Objekt des Einzelauftrags, sonst „Allgemein“
      if (str(b, 'sammel') === 'kunde') {
        const orderId = str(b, 'order_id');
        const kunde = str(b, 'bestell_kunde');
        const [o] = orderId
          ? await sql<{ customer_id: string; site_id: string | null }[]>`
              select customer_id, site_id from app.orders where id = ${orderId}`
          : [];
        if (orderId && !o) throw new BusinessError('Einzelauftrag nicht gefunden');
        if (o && kunde && o.customer_id !== kunde)
          throw new BusinessError('Der Einzelauftrag gehört zu einem anderen Kunden');
        const custId = o?.customer_id ?? kunde;
        if (!custId) throw new BusinessError('Bitte einen Kunden wählen');
        const [k] = await sql<
          { customer_no: string }[]
        >`select customer_no from app.customers where id = ${custId}`;
        const siteId = o?.site_id ?? (k ? await ensureGeneralSite(sql, k.customer_no, c.get('actor')) : null);
        if (!siteId) throw new BusinessError('Kunde nicht gefunden');
        input.siteId = siteId;
        (input as typeof input & { orderId?: string | null }).orderId = orderId ?? null;
      } else if (cur?.contract.status === 'entwurf' || !cur) {
        (input as typeof input & { orderId?: string | null }).orderId = null;
      }
      if (!input.siteId)
        throw new BusinessError(
          'Bitte ein Objekt wählen (bei Sammelbestellung: weitere Objekte oder einen Kunden wählen)',
        );
      await saveSubcontract(sql, id, input, c.get('actor'));
      // weitere Objekte (nur Entwurf): je Objekt eine eigene Bestellung mit denselben Angaben, feste ID aus
      // Bestellung + Objekt → doppelt absenden legt nichts doppelt an
      const more = [...new Set(([] as unknown[]).concat(b.more_sites ?? []).map(String))].filter(
        (x) => /^[0-9a-f-]{36}$/.test(x) && x !== input.siteId,
      );
      // Sammelbestellung (Ahmed 19.10.): weitere Objekte in DIESER Bestellung statt je Objekt eine eigene
      if (str(b, 'sammel') === '1' && (more.length || str(b, 'sammel_kunde'))) {
        const n = await addSubcontractSites(
          sql,
          id,
          { siteIds: more, customerId: str(b, 'sammel_kunde') },
          c.get('actor'),
        );
        return back(c, `/nachunternehmer/auftraege/${id}#sammel`, {
          ok: `Gespeichert. Sammelbestellung: ${anz(n, 'Objekt', 'Objekte')} aufgenommen – Flächen bitte prüfen.`,
        });
      }
      if (more.length && (!sc || sc.status === 'entwurf')) {
        const made: string[] = [];
        for (const siteId of more) {
          const h = createHash('md5').update(`more-site:${id}:${siteId}`).digest('hex');
          const nid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
          const exists = await getSubcontract(sql, nid);
          if (!exists) await saveSubcontract(sql, nid, { ...input, siteId, version: null }, c.get('actor'));
          const n = await getSubcontract(sql, nid);
          if (n) made.push(n.contract.number);
        }
        return back(c, `/nachunternehmer/auftraege/${id}`, {
          ok: `Gespeichert. Weitere Bestellungen für ${anz(more.length, 'Objekt', 'Objekte')}: ${made.join(', ')}.`,
        });
      }
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Gespeichert.' });
  });

  // Objekte einer Sammelbestellung: hinzufügen (einzeln/alle eines Kunden), Flächen ändern, entfernen
  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/objekte`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    try {
      const list = (k: string) => ([] as unknown[]).concat(b[k] ?? []).map(String);
      if (str(b, 'aktion') === 'hinzufuegen') {
        const n = await addSubcontractSites(
          sql,
          id,
          {
            siteIds: list('add_sites').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
            customerId: str(b, 'kunde'),
          },
          c.get('actor'),
        );
        return back(c, `/nachunternehmer/auftraege/${id}#sammel`, {
          ok: `${anz(n, 'Objekt', 'Objekte')} aufgenommen.`,
        });
      }
      const ids = list('site');
      const sqm = list('sqm');
      const betrag = list('betrag');
      const modes = list('mode');
      const rates = list('rate');
      const rm = new Set(list('remove'));
      const shareOf = (v: string | undefined) => {
        if (v === undefined) return undefined;
        if (!v.trim()) return null;
        const c = sqmCenti(v); // gleiche Schreibweise wie Fläche: 1.234,56
        if (c === null) throw new BusinessError(`Betrag „${v}“ ungültig`);
        return c;
      };
      await saveSubcontractSites(
        sql,
        id,
        ids.map((siteId, i) => ({
          siteId,
          sqm: sqm[i] ?? '',
          share: betrag.length ? shareOf(betrag[i]) : undefined,
          mode: modes.length ? (modes[i] === 'qm' || modes[i] === 'pauschale' ? modes[i] : null) : undefined,
          rate: rates.length ? shareOf(rates[i]) : undefined,
          remove: rm.has(siteId),
        })),
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}#sammel`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}#sammel`, { ok: 'Objekte gespeichert.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const st = String(b.status ?? '');
    // Rücksprung zur Bestellliste (nur eigene Pfade)
    const ret = typeof b.zurueck === 'string' && /^\/bestellungen(\?|$)/.test(b.zurueck) ? b.zurueck : null;
    try {
      if (st !== 'erteilt' && st !== 'beendet' && st !== 'storniert')
        throw new BusinessError('Unbekannter Status');
      await setSubcontractStatus(sql, id, st, c.get('actor'), { acceptMissing: b.hinweis_ok === '1' });
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, ret ?? `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, ret ?? `/nachunternehmer/auftraege/${id}`, {
      ok: st === 'beendet' ? 'Auftrag als erledigt markiert.' : `Auftrag ${SC_STATUS[st]}.`,
    });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/nachtrag`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    try {
      await addPriceChange(
        sql,
        {
          id: str(b, 'id') ?? randomUUID(),
          subcontractId: id,
          month: str(b, 'month') ?? '',
          priceCents: parseEuro(str(b, 'price') ?? ''),
          reason: str(b, 'reason') ?? '',
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Nachtrag gespeichert.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/scan`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    try {
      const f = b.file;
      if (!(f instanceof File) || !f.size) throw new BusinessError('Bitte Datei wählen');
      await uploadSignedSubcontract(deps, id, new Uint8Array(await f.arrayBuffer()), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Scan gespeichert.' });
  });
  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/stunden`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody()) as Record<string, string>;
    await addSubcontractHours(sql, {
      id: /^[0-9a-f-]{36}$/i.test(b.id ?? '') ? b.id! : randomUUID(),
      subcontractId: id,
      workDate: b.work_date ?? '',
      persons: Number(b.persons),
      minutesPerPerson: parseHours(b.hours ?? '', 'Std. je Person'),
      note: b.note?.trim() || null,
      actor: c.get('actor'),
    });
    return back(c, `/nachunternehmer/auftraege/${id}#stunden`, { ok: 'Stunden erfasst.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/schliesszeit`, async (c) => {
    const id = c.req.param('id');
    const b = (await c.req.parseBody()) as Record<string, string>;
    await addClosure(
      sql,
      {
        id: /^[0-9a-f-]{36}$/i.test(b.id ?? '') ? b.id! : randomUUID(),
        subcontractId: id,
        from: b.from ?? '',
        to: b.to ?? '',
        note: b.note ?? null,
      },
      c.get('actor'),
    );
    return back(c, `/nachunternehmer/auftraege/${id}#tage`, { ok: 'Schließzeit eingetragen.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/schliesszeit/schulferien`, async (c) => {
    const id = c.req.param('id');
    const n = await addSchoolClosures(sql, id, c.get('actor'));
    return back(c, `/nachunternehmer/auftraege/${id}#tage`, {
      ok: n
        ? `${n} Ferienzeiträume als Schließzeit eingetragen.`
        : 'Alle Schulferien sind schon eingetragen.',
    });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/schliesszeit/:cid{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    await deleteClosure(sql, id, c.req.param('cid'), c.get('actor'));
    return back(c, `/nachunternehmer/auftraege/${id}#tage`, { ok: 'Schließzeit entfernt.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/stunden/:hid{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    await deleteSubcontractHours(sql, c.req.param('hid'), id, c.get('actor'));
    return back(c, `/nachunternehmer/auftraege/${id}#stunden`, { ok: 'Eintrag gelöscht.' });
  });

  app.get(`/nachunternehmer/auftraege/:id{${UUID}}/unterschreiben`, async (c) => {
    const id = c.req.param('id');
    const data = await getSubcontract(sql, id);
    const sc = data?.contract;
    if (!sc) return c.notFound();
    assertSite(c, sc.site_id);
    const ol = c.get('user').role === 'objektleitung';
    const fromApp = c.req.query('von') === 'app';
    const backTo = fromApp || ol ? '/qm/nu-unterschrift' : `/nachunternehmer/auftraege/${id}`;
    if (sc.signed_file_path || sc.signed_external || sc.status !== 'erteilt') return c.redirect(backTo);
    const [sup] = await sql<{ name: string; contact_name: string | null }[]>`
      select name, contact_name from app.suppliers where id = ${sc.supplier_id}`;
    const row = (k: string, v: unknown) => (
      <div class="nus-r">
        <span>{k}</span>
        <b>{v}</b>
      </div>
    );
    return page(
      c,
      'Bestellung unterschreiben',
      'lieferanten',
      <div class="nus">
        <a class="nus-back" href={backTo}>
          ← Zurück
        </a>
        <div class="nus-card">
          <div class="nus-k">Bestellung</div>
          <div class="nus-no">{sc.number}</div>
          <div class="nus-sup">{sup?.name}</div>
          {row('Objekt', sc.site_name)}
          {row('Leistung', sc.service_kind)}
          {row('Turnus', FREQUENCY[sc.frequency] ?? sc.frequency)}
          {!ol &&
            row(
              'Preis netto',
              `${euro(sc.current_price_cents)}${BILLING[sc.billing] ? ` · ${BILLING[sc.billing]}` : ''}`,
            )}
          {row('Beginn', `${dateDe(sc.valid_from)}${sc.valid_to ? ` – ${dateDe(sc.valid_to)}` : ''}`)}
          <a class="nus-pdf" href={`/nachunternehmer/auftraege/${id}/auftrag.pdf`} target="_blank">
            Bestellschein mit Bedingungen lesen (PDF)
          </a>
        </div>
        <form
          method="post"
          action={`/nachunternehmer/auftraege/${id}/unterschrift${fromApp ? '?von=app' : ''}`}
          class="nus-card"
        >
          <p class="nus-decl">
            Der Auftragnehmer nimmt die Bestellung {sc.number} an und erkennt die Auftragsbedingungen als
            verbindlichen Bestandteil an.
          </p>
          <label for="name" class="nus-l">
            Name des Unterzeichners
          </label>
          <input
            id="name"
            name="name"
            required
            minlength={3}
            value={sup?.contact_name ?? ''}
            class="nus-in"
          />
          <div class="nus-l" style="display:flex;justify-content:space-between;align-items:center">
            <span>Unterschrift</span>
            <button type="button" class="nus-clear" id="sig-clear">
              Löschen
            </button>
          </div>
          <canvas id="sig" class="nus-sig"></canvas>
          <input type="hidden" id="sig-png" name="png" />
          <span class="small" id="sig-hint" style="color:var(--err)" hidden>
            Bitte im Feld unterschreiben.
          </span>
          <button class="nus-go">Unterschreiben</button>
          <p class="nus-note">Wird mit der Unterschrift als PDF unveränderbar gespeichert.</p>
        </form>
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.nus{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}.nus-back{color:#7d1435;text-decoration:none;font-weight:600}.nus-card{background:#fff;border:1px solid #e7e1e4;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:6px}.nus-k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a7a80;font-weight:700}.nus-no{font-size:24px;font-weight:800;color:#1a171a}.nus-sup{font-size:16px;font-weight:600;color:#7d1435;margin-bottom:6px}.nus-r{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid #f0ebed;font-size:14px}.nus-r span{color:#8a7a80}.nus-r b{text-align:right;font-weight:600}.nus-pdf{margin-top:8px;display:block;text-align:center;padding:11px;border:1px solid #e3d6db;border-radius:10px;color:#7d1435;font-weight:600;text-decoration:none}.nus-decl{margin:0 0 6px;font-weight:600;font-size:15px;line-height:1.45}.nus-l{font-size:13px;font-weight:600;color:#5a4f53;margin-top:6px}.nus-in{font:inherit;font-size:17px;padding:12px;border:1px solid #e3d6db;border-radius:10px}.nus-sig{width:100%;height:200px;border:1.5px dashed #cdbfc5;border-radius:12px;background:#fff;touch-action:none;display:block}.nus-clear{font:inherit;font-size:13px;border:0;background:none;color:#7d1435;font-weight:600;padding:4px}.nus-go{margin-top:10px;font:inherit;font-size:17px;font-weight:700;padding:15px;border:0;border-radius:12px;background:#7d1435;color:#fff}.nus-note{margin:4px 0 0;font-size:12px;color:#8a7a80;text-align:center}',
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />
      </div>,
    );
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/unterschrift`, async (c) => {
    const id = c.req.param('id');
    const [own] = await sql<{ site_id: string }[]>`select site_id from app.subcontracts where id = ${id}`;
    if (!own) return c.notFound();
    assertSite(c, own.site_id);
    const viaApp = c.req.query('von') === 'app' || c.get('user').role === 'objektleitung';
    const b = await c.req.parseBody();
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png ?? ''));
    try {
      if (!m) throw new BusinessError('Unterschrift fehlt – bitte im Feld unterschreiben');
      await signSubcontract(
        deps,
        id,
        { name: String(b.name ?? ''), png: new Uint8Array(Buffer.from(m[1]!, 'base64')) },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}/unterschreiben${viaApp ? '?von=app' : ''}`, {
          fehler: e.message,
        });
      throw e;
    }
    if (viaApp)
      return c.redirect(
        `/qm/nu-unterschrift?ok=${encodeURIComponent(`Bestellung unterschrieben – Bestellschein gespeichert.`)}`,
        303,
      );
    return back(c, `/nachunternehmer/auftraege/${id}`, {
      ok: 'Unterschrieben. Der Bestellschein mit Unterschrift ist gespeichert.',
    });
  });

  app.get(`/nachunternehmer/auftraege/:id{${UUID}}/scan`, async (c) => {
    const data = await getSubcontract(sql, c.req.param('id'));
    if (!data?.contract.signed_file_path) return c.notFound();
    const bytes = await deps.archive.get(data.contract.signed_file_path);
    const pdf = data.contract.signed_file_path.endsWith('.pdf');
    return new Response(bytes, {
      headers: {
        'Content-Type': pdf
          ? 'application/pdf'
          : data.contract.signed_file_path.endsWith('.png')
            ? 'image/png'
            : 'image/jpeg',
        'Cache-Control': 'private, no-cache',
      },
    });
  });
  app.get(`/nachunternehmer/auftraege/:id{${UUID}}/auftrag.pdf`, async (c) => {
    if (c.get('sites')) {
      const [own] = await sql<
        { site_id: string }[]
      >`select site_id from app.subcontracts where id = ${c.req.param('id')}`;
      assertSite(c, own?.site_id);
    }
    return pdfResponse(await subcontractPdf(sql, c.req.param('id')), 'Auftrag.pdf');
  });

  // ------------------------------------------------------------------ Soll/Ist je Monat
  // Soll/Ist je Monat entfällt (Ahmed 06.10.)
  app.get('/nachunternehmer/monat', (c) => c.redirect('/bestellungen?art=nu'));

  // ================================================================== Upload-Portal (öffentlich, Link + PIN)
  const portalSecret = (token: string) => `${officeSecret(env)}:np:${token}`;
  const portalPage = (
    title: string,
    flash: { ok?: string | undefined; err?: string | undefined },
    body: unknown,
  ) =>
    `<!doctype html>${(
      <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>{`${title} · Viva-Deluxe`}</title>
          <style dangerouslySetInnerHTML={{ __html: MOBILE_CSS }} />
        </head>
        <body>
          <header>
            <img src="/static/logo.png" alt="Viva-Deluxe" width="149" height="30" />
            <span class="sp" />
          </header>
          <main>
            {flash.ok && <div class="flash ok">{flash.ok}</div>}
            {flash.err && <div class="flash err">{flash.err}</div>}
            {body}
          </main>
        </body>
      </html>
    ).toString()}`;
  const portalHtml = (c: Context<AppEnv>, html: string, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(html, status);
  };

  app.get('/np/:token', async (c) => {
    const token = c.req.param('token');
    const s = await portalSupplier(sql, token);
    const flash = { ok: c.req.query('ok'), err: c.req.query('fehler') };
    if (!s)
      return portalHtml(
        c,
        portalPage('Portal', {}, <div class="card">Link ungültig oder abgelaufen.</div>),
        404,
      );
    const sid = verifySession(portalSecret(token), getCookie(c, PORTAL_COOKIE));
    if (sid !== s.id) {
      return portalHtml(
        c,
        portalPage(
          'Anmeldung',
          flash,
          <form method="post" action={`/np/${token}/anmelden`} class="card">
            <h1 style="margin-top:0">Nachweise hochladen</h1>
            <p>{s.name}</p>
            <label for="pin">PIN</label>
            <input id="pin" name="pin" inputmode="numeric" autocomplete="one-time-code" required />
            <button class="big">Weiter</button>
          </form>,
        ),
      );
    }
    const [types, docs] = await Promise.all([
      docTypes(sql),
      sql<SupplierDocument[]>`select * from app.supplier_documents where supplier_id = ${s.id}`,
    ]);
    const ev = evaluate(s, types, docs);
    return portalHtml(
      c,
      portalPage(
        'Nachweise',
        flash,
        <>
          <h1>{s.name}</h1>
          <p class="mut">
            Bitte laden Sie die markierten Nachweise als PDF oder Foto hoch (max. 10 MB). Wir prüfen jede
            Datei; bis dahin steht sie auf „in Prüfung“.
          </p>
          {ev.rows.map((r) => (
            <form method="post" action={`/np/${token}/upload`} enctype="multipart/form-data" class="card">
              <b>{r.type.label}</b> {r.required ? '' : <span class="mut">(falls zutreffend)</span>}
              <div class="mut" style="margin:4px 0 8px">
                {r.pending
                  ? 'in Prüfung'
                  : r.state === 'gueltig'
                    ? `vorhanden${r.current?.valid_until ? `, gültig bis ${dateDe(r.current.valid_until)}` : ''}`
                    : r.state === 'laeuft_ab'
                      ? `läuft ab am ${dateDe(r.current?.valid_until)} – bitte erneuern`
                      : r.state === 'abgelaufen'
                        ? 'abgelaufen – bitte erneuern'
                        : 'fehlt'}
              </div>
              {NACHWEIS_TEMPLATE[r.type.id] && r.state !== 'gueltig' && !r.pending && (
                <p style="margin:0 0 8px">
                  <a href={`/np/${token}/vorlage/${NACHWEIS_TEMPLATE[r.type.id]}`} target="_blank">
                    Vorlage herunterladen (schon mit Ihren Daten ausgefüllt)
                  </a>
                  <br />
                  <span class="mut">ausdrucken, prüfen, unterschreiben und hier hochladen</span>
                </p>
              )}
              <input type="hidden" name="id" value={randomUUID()} />
              <input type="hidden" name="doc_type" value={r.type.id} />
              <input
                type="file"
                name="file"
                accept=".pdf,.jpg,.jpeg,.png,image/*"
                required
                aria-label="Datei"
              />
              {r.type.valid_months > 0 && (
                <>
                  <label>gültig bis (laut Nachweis)</label>
                  <input type="date" name="valid_until" />
                </>
              )}
              <button class="big">Hochladen</button>
            </form>
          ))}
        </>,
      ),
    );
  });

  // ausgefüllte Vorlagen im Portal (wie die alte App bei der Nachforderung)
  app.get('/np/:token/vorlage/:kind', async (c) => {
    const token = c.req.param('token');
    const s = await portalSupplier(sql, token);
    if (!s || verifySession(portalSecret(token), getCookie(c, PORTAL_COOKIE)) !== s.id)
      return c.redirect(`/np/${token}`);
    const kind = c.req.param('kind');
    if (kind === 'personaleinsatzliste') {
      const x = await personnelListXlsx(sql, s.id);
      return new Response(x.data, {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="${x.name}"`,
          'cache-control': 'no-store',
        },
      });
    }
    if (!isNuDoc(kind) || kind === 'bewertung') return c.notFound();
    const doc = await nuDocPdf(sql, s.id, kind, { checked: true });
    return pdfResponse(doc.pdf, doc.name);
  });

  app.post('/np/:token/anmelden', async (c) => {
    const token = c.req.param('token');
    const b = await c.req.parseBody();
    try {
      const id = await portalLogin(sql, token, String(b.pin ?? ''));
      setCookie(c, PORTAL_COOKIE, signSession(portalSecret(token), id, Date.now(), 2 / 24), {
        path: `/np/${token}`,
        httpOnly: true,
        sameSite: 'Strict',
        secure: env.APP_ENV !== 'dev',
      });
      return c.redirect(`/np/${token}`, 303);
    } catch (e) {
      if (e instanceof BusinessError)
        return c.redirect(`/np/${token}?fehler=${encodeURIComponent(e.message)}`, 303);
      throw e;
    }
  });

  app.post('/np/:token/upload', async (c) => {
    const token = c.req.param('token');
    const s = await portalSupplier(sql, token);
    if (!s || verifySession(portalSecret(token), getCookie(c, PORTAL_COOKIE)) !== s.id)
      return c.redirect(`/np/${token}`, 303);
    const b = await c.req.parseBody({ all: true });
    try {
      const f = b.file;
      if (!(f instanceof File) || !f.size) throw new BusinessError('Bitte Datei wählen');
      await uploadDocument(deps, {
        id: str(b, 'id') ?? randomUUID(),
        supplierId: s.id,
        docType: str(b, 'doc_type') ?? '',
        fileName: f.name,
        data: new Uint8Array(await f.arrayBuffer()),
        validUntil: str(b, 'valid_until'),
        source: 'portal',
        actor: `portal:${s.supplier_no}`,
      });
    } catch (e) {
      if (e instanceof BusinessError)
        return c.redirect(`/np/${token}?fehler=${encodeURIComponent(e.message)}`, 303);
      throw e;
    }
    return c.redirect(`/np/${token}?ok=${encodeURIComponent('Danke – die Datei wird geprüft.')}`, 303);
  });
}

function SubcontractTable({
  rows,
  showSupplier = false,
  hours = new Map(),
  days = new Map(),
  totals = new Map(),
  sammelInfo = new Map(),
}: {
  rows: Awaited<ReturnType<typeof listSubcontracts>>;
  /** Sammelbestellungen: Anzahl Objekte + Kunde/erste Objekte */
  sammelInfo?: Map<string, { n: number; text: string }>;
  /** Sammelbestellungen je Objekt: Summe der Objekte */
  totals?: Map<string, bigint>;
  showSupplier?: boolean;
  /** „je Tag“: Arbeitstage und Betrag des laufenden Monats */
  days?: Map<string, { days: number; amount: bigint }>;
  /** erfasste Stunden des laufenden Monats bei „je Stunde“ */
  hours?: Map<string, { minutes: number; amount: bigint }>;
}) {
  return (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Nr.</th>
            {showSupplier && <th>Nachunternehmer</th>}
            <th>Objekt</th>
            <th>Leistung</th>
            <th class="r">Gesamt / Preis</th>
            <th>Zeitraum</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>
                <a href={`/nachunternehmer/auftraege/${r.id}`} style="white-space:nowrap">
                  {r.number}
                </a>
              </td>
              {showSupplier && <td>{r.supplier_name}</td>}
              <td class="small">
                {sammelInfo.get(r.id) ? (
                  <>
                    <b>Sammelbestellung ({sammelInfo.get(r.id)!.n} Objekte)</b>
                    <div>{sammelInfo.get(r.id)!.text}</div>
                  </>
                ) : (
                  <>
                    {r.site_name} ({r.site_no})
                  </>
                )}
              </td>
              <td class="small">
                {r.service_kind} · {FREQUENCY[r.frequency]}
              </td>
              <td class="r">
                {(() => {
                  const total = subcontractTotal({ ...r, sammel_total: totals.get(r.id) });
                  const h = hours.get(r.id);
                  return r.billing === 'stunde' ? (
                    <>
                      {euro(h?.amount ?? 0n)}{' '}
                      <span class="small mut">
                        {isRecurringOrder(r.frequency) ? 'erfasst diesen Monat' : 'erfasst bisher'}
                      </span>
                      <div class="small mut">
                        {h ? (h.minutes / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '0'}{' '}
                        Std. × {euro(r.current_price_cents)}
                        {total !== null && ` · max. ${euro(total)}`}
                      </div>
                    </>
                  ) : r.billing === 'tag' ? (
                    <>
                      {euro(days.get(r.id)?.amount ?? 0n)} <span class="small mut">diesen Monat</span>
                      <div class="small mut">
                        {days.get(r.id)?.days ?? 0} Tage ({workDaysLabel(r.work_days)}) ×{' '}
                        {euro(r.current_price_cents)}
                      </div>
                    </>
                  ) : (
                    <>
                      {euro(r.current_price_cents)} <span class="small mut">{BILLING[r.billing]}</span>
                    </>
                  );
                })()}
              </td>
              <td class="small">
                {r.valid_to || isRecurringOrder(r.frequency)
                  ? `${dateDe(r.valid_from)} – ${r.valid_to ? dateDe(r.valid_to) : 'unbefristet'}`
                  : `ab ${dateDe(r.valid_from)}`}
              </td>
              <td>
                <span class={`badge ${r.status === 'erteilt' ? 'ok' : r.status === 'entwurf' ? 'warn' : ''}`}>
                  {SC_STATUS[r.status]}
                </span>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colspan={7}>
                <div class="empty">Keine Aufträge.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
