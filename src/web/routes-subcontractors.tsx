import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { getCookie, setCookie } from 'hono/cookie';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { signSession, verifySession } from '../services/employee-auth.js';
import { BusinessError } from '../services/errors.js';
import { listHandovers } from '../services/handovers.js';
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
  SERVICE_KINDS,
  setSubcontractStatus,
  subcontractPdf,
  type SupplierDocument,
  terminate,
  TERMINATION_REASONS,
  terminationPdf,
  uploadDocument,
  uploadSignedSubcontract,
} from '../services/subcontractors.js';
import { type AppEnv, type Ctx, officeSecret, UUID } from './app.js';
import { centsToInput, str } from './forms.js';
import { CSS as MOBILE_CSS } from './m/routes-mobile.js';
import { HandoverTable } from './routes-handovers.js';
import { PageHead, Tabs, dateDe, euro, type Tab } from './layout.js';
import { FileArea } from './files.js';
import { listFiles } from '../services/uploads.js';
import { fullName } from '../services/users.js';

const pdfResponse = (pdf: Uint8Array, name: string) =>
  new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, no-cache',
    },
  });
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

  const short = (l: string[]) =>
    l.length > 3 ? `${l.slice(0, 3).join(', ')} +${l.length - 3} weitere` : l.join(', ');
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
    <PageHead
      title={s.name}
      no={s.supplier_no}
      crumbs={[['Lieferanten & Nachunternehmer', '/lieferanten?art=nachunternehmer']]}
    >
      <a class="btn sec" href={`/lieferanten/${s.id}/bearbeiten`} style="margin-left:auto">
        Stammdaten bearbeiten
      </a>
    </PageHead>
  );

  // ------------------------------------------------------------------ Liste wie im alten Portal
  // Lieferanten und Nachunternehmer in einer Liste (Karten), Nachweise/Fristen direkt sichtbar (Ahmed 06.10.)
  app.get('/nachunternehmer', (c) => {
    const f = c.req.query('filter');
    return c.redirect(`/lieferanten?art=nachunternehmer${f ? `&filter=${encodeURIComponent(f)}` : ''}`);
  });
  app.get('/lieferanten', async (c) => {
    const q = c.req.query();
    const art = q.art === 'lieferant' || q.art === 'nachunternehmer' ? q.art : '';
    const filter = q.filter && q.filter in OVERALL ? (q.filter as Overall) : null;
    const showInactive = q.inaktiv === '1';
    const search = (q.q ?? '').trim().toLowerCase();
    const [compliance, suppliers, openOrders, pending] = await Promise.all([
      complianceOverview(sql),
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
          contact_name: string | null;
          terminated_on: string | null;
        }[]
      >`select id, supplier_no, name, kind, active, city, postal_code, phone, contact_name, terminated_on
          from app.suppliers order by name`,
      sql<{ supplier_id: string; n: number }[]>`
        select supplier_id, count(*)::int as n from (
          select supplier_id from app.subcontracts where status in ('entwurf', 'erteilt')
          union all
          select supplier_id from app.purchase_orders where status in ('entwurf', 'bestellt')) x
         group by supplier_id`,
      pendingCount(),
    ]);
    const comp = new Map(compliance.map((r) => [r.supplier.id, r]));
    const orders = new Map(openOrders.map((r) => [r.supplier_id, r.n]));
    const statusOf = (s: (typeof suppliers)[number]): Overall | 'lieferant' =>
      s.kind === 'nachunternehmer'
        ? (comp.get(s.id)?.overall ?? 'kritisch')
        : s.active
          ? 'lieferant'
          : 'inaktiv';
    const active = suppliers.filter((s) => s.active);
    const nus = active.filter((s) => s.kind === 'nachunternehmer');
    const n = (o: Overall) => nus.filter((s) => statusOf(s) === o).length;
    const rank: Record<string, number> = { kritisch: 0, warnung: 1, ok: 2, lieferant: 3, inaktiv: 4 };
    const rows = suppliers
      .filter((s) => (showInactive || filter === 'inaktiv' ? true : s.active))
      .filter((s) => !art || s.kind === art)
      .filter((s) => !filter || statusOf(s) === filter)
      .filter(
        (s) =>
          !search ||
          [s.name, s.supplier_no, s.contact_name, s.city].some((v) => v?.toLowerCase().includes(search)),
      )
      .sort((a, b) => rank[statusOf(a)]! - rank[statusOf(b)]! || a.name.localeCompare(b.name, 'de'));
    // Fristen-Hinweis: abgelaufene oder in 14 Tagen ablaufende Pflicht-Nachweise aktiver Nachunternehmer
    const due = compliance
      .filter((r) => r.supplier.active && !r.supplier.terminated_on)
      .flatMap((r) => r.due.map((d) => ({ ...d, supplier: r.supplier })))
      .filter((d) => d.days <= 14)
      .sort((a, b) => a.days - b.days);
    const expired = due.filter((d) => d.days < 0).length;
    const link = (over: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const base: Record<string, string | null> = {
        art: art || null,
        filter,
        q: search || null,
        inaktiv: showInactive ? '1' : null,
        ...over,
      };
      for (const [k, v] of Object.entries(base)) if (v) p.set(k, v);
      const str = p.toString();
      return `/lieferanten${str ? `?${str}` : ''}`;
    };
    const BADGE: Record<string, [string, string]> = {
      kritisch: ['err', 'Kritisch'],
      warnung: ['warn', 'Warnung'],
      ok: ['ok', 'Vollständig'],
      inaktiv: ['muted', 'Inaktiv'],
      lieferant: ['muted', 'Lieferant'],
    };
    const stat = (key: Overall | null, label: string, value: number, tone: string, hint: string) => (
      <a
        class={`stat-card tone-${tone}${filter === key && (key || !filter) ? ' on' : ''}`}
        href={link({ filter: key, art: key ? 'nachunternehmer' : art || null })}
      >
        <span class="stat-lbl">{label}</span>
        <span class="stat-num">{value}</span>
        <span class="stat-hint">{hint}</span>
      </a>
    );
    return page(
      c,
      'Lieferanten & Nachunternehmer',
      'lieferanten',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Einkauf · Compliance</div>
            <h1>Lieferanten &amp; Nachunternehmer</h1>
            <div class="sub">
              {active.length} aktiv · {nus.length} Nachunternehmer · Status auf einen Blick
            </div>
          </div>
          <div class="acts">
            {pending > 0 && (
              <a class="btn sec" href="/nachunternehmer/pruefen">
                {pending} Uploads prüfen
              </a>
            )}
            <a class="btn" href={`/lieferanten/${randomUUID()}/bearbeiten`}>
              + Neu anlegen
            </a>
          </div>
        </div>
        {due.length > 0 && (
          <a
            class={`due-banner ${expired ? 'err' : 'warn'}`}
            href={link({ art: 'nachunternehmer', filter: expired ? 'kritisch' : 'warnung' })}
          >
            <span class="ico">!</span>
            <span>
              <b>
                {expired > 0 && `${expired} Nachweis${expired === 1 ? '' : 'e'} abgelaufen`}
                {expired > 0 && due.length > expired && ' · '}
                {due.length > expired && `${due.length - expired} laufen in 14 Tagen ab`}
              </b>
              <span class="lines">
                {due.slice(0, 4).map((d) => (
                  <span>
                    {d.supplier.name}: {d.label} (
                    {d.days < 0
                      ? `seit ${-d.days} T. abgelaufen`
                      : d.days === 0
                        ? 'heute'
                        : `in ${d.days} T.`}
                    )
                  </span>
                ))}
                {due.length > 4 && <span>… und {due.length - 4} weitere</span>}
              </span>
            </span>
          </a>
        )}
        <div class="stat-grid">
          {stat(null, 'Aktiv', active.length, 'brand', `${nus.length} Nachunternehmer`)}
          {stat('kritisch', 'Kritisch', n('kritisch'), 'err', 'Nachweise fehlen / abgelaufen')}
          {stat('warnung', 'Warnung', n('warnung'), 'warn', 'läuft in 60 Tagen ab')}
          {stat('ok', 'Vollständig', n('ok'), 'ok', 'alle Pflicht-Nachweise gültig')}
        </div>
        <form class="toolbar" method="get" action="/lieferanten">
          <input
            class="search-input"
            type="search"
            name="q"
            value={search}
            placeholder="Suche Firma, Nummer, Ansprechpartner oder Ort …"
          />
          {art && <input type="hidden" name="art" value={art} />}
          {filter && <input type="hidden" name="filter" value={filter} />}
          {showInactive && <input type="hidden" name="inaktiv" value="1" />}
          <div class="pills">
            <a class={`pill${!art ? ' on' : ''}`} href={link({ art: null, filter: null })}>
              Alle <span>{suppliers.filter((s) => s.active || showInactive).length}</span>
            </a>
            <a
              class={`pill${art === 'nachunternehmer' ? ' on' : ''}`}
              href={link({ art: 'nachunternehmer' })}
            >
              Nachunternehmer <span>{nus.length}</span>
            </a>
            <a
              class={`pill${art === 'lieferant' ? ' on' : ''}`}
              href={link({ art: 'lieferant', filter: null })}
            >
              Lieferanten <span>{active.filter((s) => s.kind === 'lieferant').length}</span>
            </a>
          </div>
          <a class="toggle" href={link({ inaktiv: showInactive ? null : '1' })}>
            <span class={`sw${showInactive ? ' on' : ''}`} /> Inaktive einbeziehen (
            {suppliers.filter((s) => !s.active).length})
          </a>
          {(search || filter || art) && (
            <a class="btn sec sm" href="/lieferanten">
              Filter zurücksetzen
            </a>
          )}
        </form>
        <div class="list-cards">
          {rows.map((s) => {
            const r = comp.get(s.id);
            const st = statusOf(s);
            const pct = r?.requiredTotal ? Math.round((r.requiredOk / r.requiredTotal) * 100) : 100;
            const href =
              s.kind === 'nachunternehmer' ? `/lieferanten/${s.id}/nachweise` : `/lieferanten/${s.id}`;
            const o = orders.get(s.id) ?? 0;
            return (
              <a class={`lc${s.active ? '' : ' lc-inactive'}`} href={href}>
                <div class="lc-head">
                  <div>
                    <span class="nu-tag">{s.supplier_no}</span>
                    <span class="lc-name">{s.name}</span>
                    {s.terminated_on && (
                      <span class="badge err" style="margin-left:6px">
                        gekündigt
                      </span>
                    )}
                    {s.contact_name && <div class="lc-sub">{s.contact_name}</div>}
                  </div>
                  <div class="lc-right">
                    {r && r.pending > 0 && <span class="badge info">{r.pending} zu prüfen</span>}
                    <span class={`badge ${BADGE[st]![0]}`}>{BADGE[st]![1]}</span>
                  </div>
                </div>
                <div class="lc-details">
                  <span>{s.kind === 'nachunternehmer' ? 'Nachunternehmer' : 'Lieferant'}</span>
                  {s.city && <span>{[s.postal_code, s.city].filter(Boolean).join(' ')}</span>}
                  {s.phone && <span>{s.phone}</span>}
                  <span>
                    {o} offene Bestellung{o === 1 ? '' : 'en'}
                  </span>
                </div>
                {s.kind === 'nachunternehmer' && r && s.active && !s.terminated_on && (
                  <div class="lc-foot">
                    <div class="compl-head">
                      <span>
                        Compliance · {r.requiredOk}/{r.requiredTotal} Pflicht
                      </span>
                      <b>{pct} %</b>
                    </div>
                    <div class={`progress ${pct >= 90 ? '' : pct >= 70 ? 'warn' : 'err'}`}>
                      <i style={`width:${pct}%`} />
                    </div>
                    {r.missing.length > 0 && <div class="lc-miss">Fehlt: {short(r.missing)}</div>}
                    {r.expiring.length > 0 && (
                      <div class="lc-exp">
                        Läuft ab: {short(r.expiring)}
                        {r.nextExpiry && ` (bis ${dateDe(r.nextExpiry)})`}
                      </div>
                    )}
                  </div>
                )}
                {s.terminated_on && (
                  <div class="lc-sub" style="margin-top:8px">
                    Gekündigt zum {dateDe(s.terminated_on)} · keine Nachweise mehr erforderlich
                  </div>
                )}
              </a>
            );
          })}
          {!rows.length && <div class="lc empty">Keine Einträge in dieser Auswahl.</div>}
        </div>
        <p class="small mut">
          Als Auftraggeber haften wir für Mindestlohn (§ 13 MiLoG, § 14 AEntG) und Sozialversicherungsbeiträge
          (§ 28e Abs. 3a SGB IV) der Beschäftigten des Nachunternehmers. Bei „Kritisch“ werden keine neuen
          Aufträge erteilt; in der Zahlungsliste sind die Rechnungen nicht vorausgewählt.
        </p>
      </div>,
    );
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
                          {d.created_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
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
          <SubcontractTable rows={contracts} />
        </div>
      </>,
    );
  });

  // Ansprechpartner (mehrere)
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
        <PageHead
          title="Hochgeladene Nachweise prüfen"
          crumbs={[['Lieferanten & Nachunternehmer', '/lieferanten?art=nachunternehmer']]}
        />
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
        <form
          method="post"
          action={`/nachunternehmer/auftraege/${id}`}
          class="card"
          data-autosave
          data-version={String(sc?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(sc?.version ?? '')} />
          <fieldset disabled={!draft} style="border:0;padding:0;margin:0">
            <div class="grid">
              <div>
                <label for="nu">Nachunternehmer</label>
                <select id="nu" name="supplier_id" required>
                  <option value="">– bitte wählen –</option>
                  {subs.map((s) => (
                    <option value={s.id} selected={s.id === (sc?.supplier_id ?? c.req.query('nu'))}>
                      {s.name} ({s.supplier_no})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="site">Objekt</label>
                <select id="site" name="site_id" required>
                  <option value="">– bitte wählen –</option>
                  <SiteOptions sites={sites} selected={sc?.site_id ?? c.req.query('objekt')} />
                </select>
              </div>
              <div>
                <label for="kind">Leistung</label>
                <select id="kind" name="service_kind">
                  {SERVICE_KINDS.map((k) => (
                    <option value={k} selected={k === sc?.service_kind}>
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
              <div>
                <label for="price">Preis netto (€)</label>
                <input
                  id="price"
                  name="price"
                  inputmode="decimal"
                  value={sc ? centsToInput(sc.price_cents) : ''}
                  required
                />
              </div>
              <div>
                <label for="maxh">Max. Stunden/Monat (bei Stunden)</label>
                <input
                  id="maxh"
                  name="max_hours"
                  inputmode="decimal"
                  value={sc?.max_hours_month?.replace('.', ',') ?? ''}
                />
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
            <label for="desc">Leistungsumfang</label>
            <textarea id="desc" name="description" rows={3}>
              {sc?.description ?? ''}
            </textarea>
          </fieldset>
          <div class="grid">
            <div>
              <label for="to">Ende (optional)</label>
              <input id="to" type="date" name="valid_to" value={sc?.valid_to ?? ''} />
            </div>
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
        {sc && (
          <div class="card">
            <div class="actions" style="margin-top:0">
              <a class="btn sec" href={`/nachunternehmer/auftraege/${id}/auftrag.pdf`} target="_blank">
                Auftrag (PDF)
              </a>
              {sc.status === 'entwurf' && (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                  <button class="btn" name="status" value="erteilt">
                    Auftrag erteilen
                  </button>
                </form>
              )}
              {sc.status === 'erteilt' && (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                  <button
                    class="btn sec"
                    name="status"
                    value="beendet"
                    onclick="return confirm('Auftrag beenden?')"
                  >
                    Beenden
                  </button>
                </form>
              )}
              {sc.status === 'entwurf' && (
                <form method="post" action={`/nachunternehmer/auftraege/${id}/status`} style="margin:0">
                  <button class="btn sec" name="status" value="storniert">
                    Stornieren
                  </button>
                </form>
              )}
            </div>
            <h3>Unterschriebener Auftrag (Scan)</h3>
            {sc.signed_file_path ? (
              <p>
                <a href={`/nachunternehmer/auftraege/${id}/scan`} target="_blank">
                  Scan öffnen
                </a>{' '}
                <span class="small mut">SHA-256 {sc.signed_file_sha256?.slice(0, 16)}…</span>
              </p>
            ) : (
              <form
                method="post"
                action={`/nachunternehmer/auftraege/${id}/scan`}
                enctype="multipart/form-data"
                class="actions"
              >
                <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required aria-label="Scan" />
                <button class="btn sec sm">Hochladen</button>
              </form>
            )}
            {sc.status === 'erteilt' && (
              <>
                <h3>Preisnachtrag</h3>
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
              </>
            )}
          </div>
        )}
      </>,
    );
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const cur = await getSubcontract(sql, id);
    const v = str(b, 'version');
    try {
      const sc = cur?.contract;
      await saveSubcontract(
        sql,
        id,
        {
          supplierId: str(b, 'supplier_id') ?? sc?.supplier_id ?? '',
          siteId: str(b, 'site_id') ?? sc?.site_id ?? '',
          serviceKind: str(b, 'service_kind') ?? sc?.service_kind ?? '',
          frequency: str(b, 'frequency') ?? sc?.frequency ?? '',
          billing: str(b, 'billing') ?? sc?.billing ?? '',
          priceCents: str(b, 'price') ? parseEuro(str(b, 'price')!) : (sc?.price_cents ?? 0n),
          maxHours: str(b, 'max_hours'),
          validFrom: str(b, 'valid_from') ?? sc?.valid_from ?? '',
          validTo: str(b, 'valid_to'),
          description: str(b, 'description'),
          note: str(b, 'note'),
          version: v ? Number(v) : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: 'Gespeichert.' });
  });

  app.post(`/nachunternehmer/auftraege/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const st = String(b.status ?? '');
    try {
      if (st !== 'erteilt' && st !== 'beendet' && st !== 'storniert')
        throw new BusinessError('Unbekannter Status');
      await setSubcontractStatus(sql, id, st, c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/nachunternehmer/auftraege/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/nachunternehmer/auftraege/${id}`, { ok: `Auftrag ${SC_STATUS[st]}.` });
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
  app.get(`/nachunternehmer/auftraege/:id{${UUID}}/auftrag.pdf`, async (c) =>
    pdfResponse(await subcontractPdf(sql, c.req.param('id')), 'Auftrag.pdf'),
  );

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
}: {
  rows: Awaited<ReturnType<typeof listSubcontracts>>;
  showSupplier?: boolean;
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
            <th class="r">Preis aktuell</th>
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
                {r.site_name} ({r.site_no})
              </td>
              <td class="small">
                {r.service_kind} · {FREQUENCY[r.frequency]}
              </td>
              <td class="r">
                {euro(r.current_price_cents)} <span class="small mut">{BILLING[r.billing]}</span>
              </td>
              <td class="small">
                {dateDe(r.valid_from)} – {r.valid_to ? dateDe(r.valid_to) : 'offen'}
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
