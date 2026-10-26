import { PAY_BAND_LABEL } from '../domain/hr/employer-cost.js';
import { monthRange, siteCosting } from '../services/costing.js';
import {
  type CostBreakdown,
  type CostItem,
  costCenterBreakdown,
  siteCostBreakdown,
} from '../services/costing-detail.js';
import { planCosting } from '../services/plan-costing.js';
import { hm } from '../services/time.js';
import type { Ctx } from './app.js';
import { PageHead, dateDe, euro } from './layout.js';

/*
 * Aufschlüsselung einer Zeile der Nachkalkulation (Ist) und Plan-Kalkulation (Soll) – Ahmed 26.10.: „die einzelne
 * Position öffnen und sehen, welche Kosten genau dahinter stecken, z. B. bei Bürokosten“.
 */

const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const MONTHS = [
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
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const periodLabel = (von: string, bis: string) =>
  von === bis ? monthLabel(von) : `${monthLabel(von)} – ${monthLabel(bis)}`;
const pct = (bp: number) => `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
const total = (items: { amount: bigint }[]) => items.reduce((a, x) => a + x.amount, 0n);

const Items = ({
  id,
  title,
  items,
  empty,
}: {
  id: string;
  title: string;
  items: CostItem[];
  empty: string;
}) => (
  <div class="card" id={id}>
    <h3>
      {title} <span class="mut small">· {euro(total(items))}</span>
    </h3>
    {!items.length ? (
      <p class="small mut">{empty}</p>
    ) : (
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Beleg / Position</th>
              <th class="r">Netto</th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr>
                <td>{x.date ? dateDe(x.date) : '–'}</td>
                <td>
                  {x.href ? <a href={x.href}>{x.label}</a> : x.label}
                  {x.sub && <div class="small mut">{x.sub}</div>}
                </td>
                <td class="r">{euro(x.amount)}</td>
              </tr>
            ))}
            <tr style="background:var(--tint-2)">
              <td colspan={2}>
                <b>Summe</b>
              </td>
              <td class="r">
                <b>{euro(total(items))}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    )}
  </div>
);

const Summary = ({ parts }: { parts: [string, string, bigint][] }) => (
  <div class="kpis">
    {parts.map(([l, anchor, v]) => (
      <a class="kpi" href={`#${anchor}`} style="text-decoration:none;color:inherit">
        <div class="l">{l}</div>
        <div class="v" style={v < 0n ? 'color:var(--err)' : ''}>
          {euro(v)}
        </div>
      </a>
    ))}
  </div>
);

const CostSections = ({ b }: { b: CostBreakdown }) => (
  <>
    <Items id="material" title="Material" items={b.material} empty="Kein Material im Zeitraum." />
    <Items id="geraete" title="Geräte" items={b.equipment} empty="Keine Gerätekosten im Zeitraum." />
    <Items
      id="nu"
      title="Nachunternehmer"
      items={b.subcontractor}
      empty="Keine Nachunternehmer-Kosten im Zeitraum."
    />
    <Items id="sonstiges" title="Sonstiges" items={b.other} empty="Keine sonstigen Kosten im Zeitraum." />
  </>
);

export function registerCostingDetailRoutes(ctx: Ctx) {
  const { app, deps, page } = ctx;
  const { sql } = deps;

  app.get('/auswertungen/nachkalkulation/detail', async (c) => {
    const von = isMonth(c.req.query('von')) ? c.req.query('von')! : '';
    const bis = isMonth(c.req.query('bis')) && c.req.query('bis')! >= von ? c.req.query('bis')! : von;
    const siteId = c.req.query('objekt') ?? '';
    const ccId = c.req.query('kostenstelle') ?? '';
    if (!von || (!siteId && !ccId)) return c.redirect('/auswertungen/nachkalkulation');
    const back = `/auswertungen/nachkalkulation?von=${von}&bis=${bis}`;
    const crumbs: [string, string][] = [
      ['Auswertungen', '/auswertungen'],
      ['Nachkalkulation', back],
    ];
    const period = { from: von, to: bis };
    if (ccId) {
      const [cc] = await sql<{ number: string; name: string }[]>`
        select number, name from app.cost_centers where id = ${ccId}`;
      if (!cc) return c.notFound();
      const b = await costCenterBreakdown(sql, ccId, period);
      const all = total(b.material) + total(b.equipment) + total(b.subcontractor) + total(b.other);
      return page(
        c,
        `Kostenstelle ${cc.number} · ${cc.name}`,
        'auswertungen',
        <>
          <PageHead title={`Kostenstelle ${cc.number} · ${cc.name}`} crumbs={crumbs} />
          <p class="small mut" style="margin-top:-6px">
            {periodLabel(von, bis)} · Eingangsrechnungen mit dieser Kostenstelle (Leistungsmonat) und
            wiederkehrende Zahlungen (netto, auf die Monate des bezahlten Zeitraums verteilt). Gesamt{' '}
            <b>{euro(all)}</b>.
          </p>
          <Summary
            parts={[
              ['Material', 'material', total(b.material)],
              ['Geräte', 'geraete', total(b.equipment)],
              ['Nachunternehmer', 'nu', total(b.subcontractor)],
              ['Sonstiges', 'sonstiges', total(b.other)],
            ]}
          />
          <CostSections b={b} />
        </>,
      );
    }
    const [{ rows }, b] = await Promise.all([
      siteCosting(sql, period, siteId),
      siteCostBreakdown(sql, siteId, period),
    ]);
    const r = rows[0];
    if (!r) return c.notFound();
    const laborSum = b.labor.reduce((a, l) => a + l.cost, 0n);
    return page(
      c,
      `Nachkalkulation ${r.site_no} · ${r.site_name}`,
      'auswertungen',
      <>
        <PageHead title={`${r.site_no} · ${r.site_name}`} crumbs={crumbs} />
        <p class="small mut" style="margin-top:-6px">
          {r.customer_name} · Nachkalkulation (Ist) {periodLabel(von, bis)} ·{' '}
          <a href={`/objekte/${r.site_id}`}>Objekt öffnen</a> ·{' '}
          <a href={`/auswertungen/plankalkulation/detail?objekt=${r.site_id}&von=${von}&bis=${bis}`}>
            Plan (Soll) für diesen Zeitraum
          </a>
        </p>
        <Summary
          parts={[
            ['Erlös', 'erloes', r.revenue],
            ['Lohn', 'lohn', r.labor],
            ['Material', 'material', r.material],
            ['Geräte', 'geraete', r.equipment],
            ['Nachunternehmer', 'nu', r.subcontractor],
            ['Sonstiges', 'sonstiges', r.other],
            ['Deckungsbeitrag', 'erloes', r.margin],
          ]}
        />
        <Items
          id="erloes"
          title="Erlös"
          items={b.revenue}
          empty="Keine Rechnung mit Leistungszeitraum (sonst Rechnungsdatum) im Zeitraum."
        />
        <div class="card" id="lohn">
          <h3>
            Lohn <span class="mut small">· {euro(r.labor)}</span>
          </h3>
          {!b.labor.length ? (
            <p class="small mut">Keine erfassten Zeiten im Zeitraum.</p>
          ) : (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Mitarbeiter/in</th>
                    <th class="r">Ist-Std.</th>
                    <th class="r">Stundenlohn</th>
                    <th class="r">Zuschlag</th>
                    <th class="r">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {b.labor.map((l) => (
                    <tr>
                      <td>
                        <a href={`/personal/${l.employee_id}`}>{l.name}</a>
                        <span class="small mut"> · {l.personnel_no}</span>
                        {l.wage_assumed && (
                          <div class="small" style="color:var(--warn)">
                            Vergütung fehlt – niedrigster Tariflohn angenommen
                          </div>
                        )}
                      </td>
                      <td class="r">{hm(l.minutes)}</td>
                      <td class="r">{euro(l.wage_cents)}</td>
                      <td class="r">{pct(l.overhead_bp)}</td>
                      <td class="r">{euro(l.cost)}</td>
                    </tr>
                  ))}
                  <tr style="background:var(--tint-2)">
                    <td>
                      <b>Summe</b>
                    </td>
                    <td class="r">
                      <b>{hm(b.labor.reduce((a, l) => a + l.minutes, 0))}</b>
                    </td>
                    <td colspan={2} />
                    <td class="r">
                      <b>{euro(r.labor)}</b>
                      {laborSum !== r.labor && (
                        <div class="small mut" title="Rundung je Person">
                          je Person gerundet {euro(laborSum)}
                        </div>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p class="small mut">
            Lohn = Ist-Stunden × Stundenlohn × (1 + Zuschlag je Beschäftigungsart). Die einzelnen Zeiten
            stehen unter <a href={`/objekte/${r.site_id}/zeiten`}>Objekt → Erfasste Zeiten</a>.
          </p>
        </div>
        <CostSections b={b} />
      </>,
    );
  });

  app.get('/auswertungen/plankalkulation/detail', async (c) => {
    const von = isMonth(c.req.query('von')) ? c.req.query('von')! : '';
    const bis = isMonth(c.req.query('bis')) && c.req.query('bis')! >= von ? c.req.query('bis')! : von;
    const siteId = c.req.query('objekt') ?? '';
    if (!von || !siteId) return c.redirect('/auswertungen/plankalkulation');
    const plan = await planCosting(sql, { from: von, to: bis });
    const r = plan.rows.find((x) => x.site_id === siteId);
    if (!r) return c.notFound();
    const d = plan.details.get(siteId) ?? { revenue: [], labor: [], material_avg3: 0n };
    const orders = await sql<
      {
        id: string;
        number: string;
        supplier: string;
        billing: string;
        frequency: string;
        price: bigint | null;
      }[]
    >`
      select s.id, s.number, su.name as supplier, s.billing::text as billing, s.frequency::text as frequency,
             s.price_cents as price
        from app.subcontracts s join app.suppliers su on su.id = s.supplier_id
       where s.status in ('erteilt', 'beendet') and s.valid_from <= ${monthRange(bis).to}
         and (s.valid_to is null or s.valid_to >= ${monthRange(von).from})
         and (s.site_id = ${siteId} or exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id and x.site_id = ${siteId}))
       order by s.number`;
    const back = `/auswertungen/plankalkulation?von=${von}&bis=${bis}`;
    const cycle: Record<string, string> = {
      monatlich: 'monatlich',
      zweimonatlich: '2-monatlich (anteilig)',
      quartalsweise: 'quartalsweise (anteilig)',
      halbjaehrlich: 'halbjährlich (anteilig)',
      jaehrlich: 'jährlich (anteilig)',
    };
    return page(
      c,
      `Plan-Kalkulation ${r.site_no} · ${r.site_name}`,
      'auswertungen',
      <>
        <PageHead
          title={`${r.site_no} · ${r.site_name}`}
          crumbs={[
            ['Auswertungen', '/auswertungen'],
            ['Plan-Kalkulation', back],
          ]}
        />
        <p class="small mut" style="margin-top:-6px">
          {r.customer_name} · Plan-Kalkulation (Soll) {periodLabel(von, bis)} ·{' '}
          <a href={`/objekte/${r.site_id}`}>Objekt öffnen</a> ·{' '}
          <a href={`/auswertungen/nachkalkulation/detail?objekt=${r.site_id}&von=${von}&bis=${bis}`}>
            Ist für diesen Zeitraum
          </a>
        </p>
        <Summary
          parts={[
            ['Erlös', 'erloes', r.revenue],
            ['Lohn + AG-Kosten', 'lohn', r.labor],
            ['Nachunternehmer', 'nu', r.subcontractor],
            ['Material', 'material', r.material],
            ['Deckungsbeitrag', 'erloes', r.margin],
          ]}
        />
        <div class="card" id="erloes">
          <h3>
            Erlös <span class="mut small">· {euro(r.revenue)}</span>
          </h3>
          {!d.revenue.length ? (
            <p class="small mut">Keine laufenden Leistungen (Monatspauschalen) im Zeitraum.</p>
          ) : (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Leistung</th>
                    <th>Abrechnung</th>
                    <th class="r">Monate</th>
                    <th class="r">Netto</th>
                  </tr>
                </thead>
                <tbody>
                  {d.revenue.map((x) => (
                    <tr>
                      <td>
                        <a href={`/objekte/${r.site_id}/leistungen/${x.service_id}`}>{x.title}</a>
                      </td>
                      <td>{cycle[x.cycle] ?? x.cycle}</td>
                      <td class="r">{x.months}</td>
                      <td class="r">{euro(x.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div class="card" id="lohn">
          <h3>
            Lohn + Arbeitgeberkosten <span class="mut small">· {euro(r.labor)}</span>
          </h3>
          {!d.labor.length ? (
            <p class="small mut">Keine Einsätze geplant.</p>
          ) : (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Mitarbeiter/in</th>
                    <th class="r">Plan-Std.</th>
                    <th class="r">Lohn</th>
                    <th>Eingestuft als</th>
                    <th class="r">AG-Kosten</th>
                    <th class="r">Gesamt</th>
                  </tr>
                </thead>
                <tbody>
                  {d.labor.map((l) => (
                    <tr>
                      <td>
                        <a href={`/personal/${l.employee_id}`}>{l.name}</a>
                        <span class="small mut"> · {l.personnel_no}</span>
                        <div class="small mut">
                          {l.fixed
                            ? 'Festgehalt, nach Plan-Stunden verteilt'
                            : `${euro(l.wage_cents)} / Std.`}
                        </div>
                        {l.wage_assumed && (
                          <div class="small" style="color:var(--warn)">
                            Vergütung fehlt – niedrigster Tariflohn angenommen
                          </div>
                        )}
                      </td>
                      <td class="r">{hm(l.minutes)}</td>
                      <td class="r">{euro(l.gross)}</td>
                      <td>{l.bands.map((x) => PAY_BAND_LABEL[x]).join(' / ')}</td>
                      <td class="r">{euro(l.employer)}</td>
                      <td class="r">{euro(l.gross + l.employer)}</td>
                    </tr>
                  ))}
                  <tr style="background:var(--tint-2)">
                    <td>
                      <b>Summe</b>
                    </td>
                    <td class="r">
                      <b>{hm(r.minutes)}</b>
                    </td>
                    <td class="r">
                      <b>{euro(r.gross)}</b>
                    </td>
                    <td />
                    <td class="r">
                      <b>{euro(r.employer)}</b>
                    </td>
                    <td class="r">
                      <b>{euro(r.labor)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p class="small mut">
            Arbeitgeberkosten werden je Person aus dem gesamten geplanten Monatsentgelt berechnet und nach
            Stunden auf die Objekte verteilt.
          </p>
        </div>
        <div class="card" id="nu">
          <h3>
            Nachunternehmer <span class="mut small">· {euro(r.subcontractor)}</span>
          </h3>
          {!orders.length ? (
            <p class="small mut">Keine erteilte Bestellung für dieses Objekt im Zeitraum.</p>
          ) : (
            <>
              <ul class="small">
                {orders.map((o) => (
                  <li>
                    <a href={`/nachunternehmer/auftraege/${o.id}`}>
                      {o.number} · {o.supplier}
                    </a>{' '}
                    <span class="mut">
                      · {o.frequency} · {o.billing}
                      {o.price !== null ? ` · ${euro(o.price)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p class="small mut">
                Betrag laut Bestellung je Monat (Preisnachträge, je Tag/Stunde/m² und Sammelbestellungen wie
                in der Nachkalkulation).
              </p>
            </>
          )}
        </div>
        <div class="card" id="material">
          <h3>
            Material <span class="mut small">· {euro(r.material)}</span>
          </h3>
          <p class="small mut">
            {d.material_avg3 > 0n
              ? `Ø der Monate ${monthLabel(plan.materialFrom)} – ${monthLabel(plan.materialTo)} (Ist ${euro(d.material_avg3)} ÷ 3) × ${plan.months} Monat${plan.months === 1 ? '' : 'e'}.`
              : 'Kein Material in den letzten 3 Monaten.'}{' '}
            {d.material_avg3 > 0n && (
              <a
                href={`/auswertungen/nachkalkulation/detail?objekt=${r.site_id}&von=${plan.materialFrom}&bis=${plan.materialTo}#material`}
              >
                Belege dazu
              </a>
            )}
          </p>
        </div>
      </>,
    );
  });
}
