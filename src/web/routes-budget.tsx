import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { writeXlsx, type XlsxCell } from '../domain/sheet/xlsx-write.js';
import {
  type BudgetData,
  type BudgetRow,
  COST_CATS,
  COST_LABEL,
  budgetActuals,
  budgetData,
  deleteAdjustment,
  deleteCostRow,
  ensureBudget,
  getBudget,
  listBudgets,
  resetCostRow,
  saveAdjustment,
  saveBudgetSettings,
  saveCostRow,
  setBudgetStatus,
  startBudgetCompute,
} from '../services/budget.js';
import { BusinessError } from '../services/errors.js';
import type { AppEnv, Ctx } from './app.js';
import { centsToInput } from './forms.js';
import { PageHead, Tabs, euro } from './layout.js';

/*
 * Budgetplanung (Ahmed 22.11.): Jahresplan je Objekt (Umsatz aus Leistungen, direkte Kosten), Gemeinkosten je
 * Kostenart, Ansichten je Objekt / Kunde / Monat, Soll/Ist mit der Nachkalkulation. Berechnung siehe services/budget.ts.
 */

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MON_LONG = [
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
const M12 = Array.from({ length: 12 }, (_, i) => i);
const total = (a: bigint[]) => a.reduce((x, y) => x + y, 0n);
/** Beträge ohne Cent (Übersicht) */
const eur0 = (c: bigint) =>
  `${(Number(c) / 100).toLocaleString('de-DE', { maximumFractionDigits: 0, minimumFractionDigits: 0 })} €`;
/** nur Zahl (Monatstabelle, Spaltenkopf sagt „in €“) */
const num0 = (c: bigint) => (Number(c) / 100).toLocaleString('de-DE', { maximumFractionDigits: 0 });
const pct = (num: bigint, den: bigint) =>
  den === 0n
    ? '–'
    : `${(Number((num * 10000n) / den) / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
const marginBp = (num: bigint, den: bigint) => (den === 0n ? null : Number((num * 10000n) / den));
const hours = (min: number) => `${Math.round(min / 60).toLocaleString('de-DE')} Std.`;
const VIEWS = ['objekt', 'kunde', 'monat', 'kosten', 'sollist'] as const;
type View = (typeof VIEWS)[number];

const moneyIn = (v: unknown): bigint => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return 0n;
  return BigInt(parseEuro(s));
};

const xlsxFile = (c: Context<AppEnv>, bytes: Uint8Array, name: string) =>
  c.body(bytes as unknown as ArrayBuffer, 200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'private, no-store',
  });

interface Agg {
  revenue: bigint;
  regular: bigint;
  extra: bigint;
  increase: bigint;
  adj: bigint;
  prev: bigint;
  minutes: number;
  labor: bigint;
  sub: bigint;
  material: bigint;
  adjCost: bigint;
  db: bigint;
  overhead: bigint;
  result: bigint;
}
const agg = (rows: BudgetRow[], months: number[] = M12): Agg => {
  const a: Agg = {
    revenue: 0n,
    regular: 0n,
    extra: 0n,
    increase: 0n,
    adj: 0n,
    prev: 0n,
    minutes: 0,
    labor: 0n,
    sub: 0n,
    material: 0n,
    adjCost: 0n,
    db: 0n,
    overhead: 0n,
    result: 0n,
  };
  for (const r of rows)
    for (const i of months) {
      a.revenue += r.revenue[i]!;
      a.regular += r.flat[i]! + r.cycle[i]!;
      a.extra += r.extra[i]!;
      a.increase += r.increase[i]!;
      a.adj += r.adjRevenue[i]!;
      a.prev += r.prev[i]!;
      a.minutes += r.minutes[i]!;
      a.labor += r.labor[i]!;
      a.sub += r.sub[i]!;
      a.material += r.material[i]!;
      a.adjCost += r.adjCost[i]!;
      a.db += r.db[i]!;
      a.overhead += r.overhead[i]!;
      a.result += r.result[i]!;
    }
  return a;
};

const MarginBadge = ({ num, den }: { num: bigint; den: bigint }) => {
  const bp = marginBp(num, den);
  return bp === null ? (
    <span class="mut">–</span>
  ) : (
    <span class={`badge ${bp < 0 ? 'err' : bp < 1000 ? 'warn' : 'ok'}`}>{pct(num, den)}</span>
  );
};

/** Kopfzeile der Beträge (Spalten gleich in allen Ansichten) */
const AmountHead = ({ first }: { first: string }) => (
  <tr>
    <th style="min-width:220px">{first}</th>
    <th class="r">Umsatz</th>
    <th class="r">Lohn inkl. AG</th>
    <th class="r">Nachunter&shy;nehmer</th>
    <th class="r">Material</th>
    <th class="r">DB I</th>
    <th class="r">Gemein&shy;kosten</th>
    <th class="r">Ergebnis</th>
    <th class="r">Marge</th>
  </tr>
);
const breakdown = (a: Agg) =>
  [
    `laufend/Turnus ${eur0(a.regular)}`,
    a.extra > 0n && `Sonderleistungen wie Vorjahr ${eur0(a.extra)}`,
    a.increase > 0n && `Preiserhöhung ${eur0(a.increase)}`,
    a.adj !== 0n && `Anpassung/Neugeschäft ${eur0(a.adj)}`,
  ]
    .filter(Boolean)
    .join(' · ');
const AmountCells = ({ a }: { a: Agg }) => (
  <>
    <td class="r nw" data-sort={String(a.revenue)} title={breakdown(a)}>
      <b>{eur0(a.revenue)}</b>
      <div class="small mut" style="white-space:nowrap">
        {a.prev ? `Vj. ${eur0(a.prev)}` : 'Vj. –'}
      </div>
    </td>
    <td class="r nw" data-sort={String(a.labor)}>
      {eur0(a.labor)}
      {a.minutes > 0 && <div class="small mut">{hours(a.minutes)}</div>}
    </td>
    <td class="r nw" data-sort={String(a.sub)}>
      {eur0(a.sub)}
    </td>
    <td class="r nw" data-sort={String(a.material + a.adjCost)}>
      {eur0(a.material + a.adjCost)}
    </td>
    <td class={a.db < 0n ? 'r nw neg' : 'r nw'} data-sort={String(a.db)}>
      {eur0(a.db)}
    </td>
    <td class="r nw" data-sort={String(a.overhead)}>
      {eur0(a.overhead)}
    </td>
    <td class={a.result < 0n ? 'r nw neg' : 'r nw'} data-sort={String(a.result)}>
      <b>{eur0(a.result)}</b>
    </td>
    <td class="r nw" data-sort={String(marginBp(a.result, a.revenue) ?? -99999)}>
      <MarginBadge num={a.result} den={a.revenue} />
    </td>
  </>
);

export function registerBudgetRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const canEdit = (c: Context<AppEnv>) => ['admin', 'buchhaltung'].includes(c.get('user').role);
  const isAdmin = (c: Context<AppEnv>) => c.get('user').role === 'admin';
  const thisYear = () => Number(todayBerlin().slice(0, 4));
  const yearOf = (q: string | undefined) => {
    const y = Number(q);
    // Standard: das nächste Jahr (Planung läuft im Herbst für das Folgejahr)
    return Number.isInteger(y) && y >= 2020 && y <= thisYear() + 2 ? y : thisYear() + 1;
  };
  const base = (year: number) => `/auswertungen/budget?jahr=${year}`;
  const guard = (c: Context<AppEnv>) => {
    if (!canEdit(c)) throw new BusinessError('Nur Admin oder Buchhaltung dürfen das Budget ändern');
  };
  const budgetIdOf = async (year: number) => {
    const b = await getBudget(sql, year);
    if (!b) throw new BusinessError('Budget nicht gefunden');
    return b.id;
  };

  const filterRows = (d: BudgetData, q: { kunde: string; objekt: string; ol: string; verlust: boolean }) =>
    d.rows.filter(
      (r) =>
        (!q.kunde || r.customer_id === q.kunde) &&
        (!q.objekt || r.key === q.objekt) &&
        (!q.ol || (q.ol === 'ohne' ? !r.manager_user_id : r.manager_user_id === q.ol)) &&
        (!q.verlust || total(r.result) < 0n),
    );

  // ---------------------------------------------------------------- Übersicht
  app.get('/auswertungen/budget', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const view: View = (VIEWS as readonly string[]).includes(c.req.query('ansicht') ?? '')
      ? (c.req.query('ansicht') as View)
      : 'objekt';
    const q = {
      kunde: c.req.query('kunde') ?? '',
      objekt: c.req.query('objekt') ?? '',
      ol: c.req.query('ol') ?? '',
      verlust: c.req.query('verlust') === '1',
    };
    const [d, list] = await Promise.all([budgetData(sql, year), listBudgets(sql)]);
    const years = [...new Set([thisYear(), thisYear() + 1, ...list.map((b) => b.year)])].sort();
    const edit = canEdit(c);
    const YearChips = () => (
      <div class="chips" style="margin-bottom:12px;align-items:center">
        {years.map((y) => {
          const b = list.find((x) => x.year === y);
          return (
            <a href={base(y)} class={y === year ? 'on' : ''}>
              Budget {y}{' '}
              {b && <span class="cnt">{b.status === 'freigegeben' ? 'freigegeben' : 'Entwurf'}</span>}
            </a>
          );
        })}
      </div>
    );
    if (!d)
      return page(
        c,
        `Budget ${year}`,
        'auswertungen',
        <>
          <PageHead title={`Budgetplanung ${year}`} crumbs={[['Auswertungen', '/auswertungen']]} />
          <YearChips />
          <div class="card" style="max-width:720px">
            <h2>Budget {year} anlegen</h2>
            <p>
              Die App schlägt das Budget aus den Daten vor: Umsatz je Objekt aus den Leistungen (monatlich,
              Turnus, einmalig, Sonderleistungen wie im Vorjahr), Lohn aus der Einsatzplanung, Nachunternehmer
              laut Bestellung, Gemeinkosten aus wiederkehrenden Zahlungen und Eingangsrechnungen. Danach lässt
              sich alles anpassen und am Ende freigeben.
            </p>
            {edit ? (
              <form method="post" action="/auswertungen/budget/anlegen">
                <input type="hidden" name="jahr" value={String(year)} />
                <button class="btn">Budget {year} anlegen und berechnen</button>
              </form>
            ) : (
              <p class="mut">Anlegen dürfen Admin und Buchhaltung.</p>
            )}
          </div>
        </>,
      );
    const b = d.budget;
    const draft = b.status === 'entwurf';
    const rows = filterRows(d, q);
    const filtered = !!(q.kunde || q.objekt || q.ol || q.verlust);
    const sum = agg(rows);
    const allSum = agg(d.rows);
    const overheadYear = total(d.overhead);
    const investYear = total(d.invest);
    const keep = (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ jahr: String(year) });
      const all = { ansicht: view, ...q, verlust: q.verlust ? '1' : '', ...extra };
      for (const [k, v] of Object.entries(all))
        if (v && !(k === 'ansicht' && v === 'objekt')) p.set(k, String(v));
      return `/auswertungen/budget?${p.toString()}`;
    };
    const customers = [
      ...new Map(
        d.rows
          .filter((r) => r.customer_id)
          .map((r) => [
            r.customer_id!,
            r.customer_no ? `${r.customer_no} · ${r.customer_name}` : r.customer_name,
          ]),
      ).entries(),
    ].sort((x, y) => x[1].localeCompare(y[1], 'de'));
    const managerIds = [...new Set(d.rows.map((r) => r.manager_user_id).filter((x): x is string => !!x))];
    const managers = managerIds.length
      ? await sql<{ user_id: string; name: string }[]>`
          select user_id, name from app.manager_contacts where user_id = any(${managerIds}::uuid[]) order by name`
      : [];
    const tabs = [
      { key: 'objekt', label: 'Objekte', href: keep({ ansicht: 'objekt' }) },
      { key: 'kunde', label: 'Kunden', href: keep({ ansicht: 'kunde' }) },
      { key: 'monat', label: 'Monate', href: keep({ ansicht: 'monat' }) },
      { key: 'kosten', label: 'Gemeinkosten', href: keep({ ansicht: 'kosten' }) },
      { key: 'sollist', label: 'Soll / Ist', href: keep({ ansicht: 'sollist' }) },
    ];

    // ---------- Inhalt je Ansicht
    let body: unknown;
    if (view === 'objekt') {
      body = (
        <>
          <div class="table-wrap">
            <table data-xfilter>
              <thead>
                <AmountHead first="Objekt" />
              </thead>
              <tbody>
                <tr class="sum">
                  <td>
                    <b>Gesamt</b> <span class="small mut">({rows.length} Zeilen)</span>
                  </td>
                  <AmountCells a={sum} />
                </tr>
                {rows.map((r) => (
                  <tr>
                    <td>
                      {r.newBusiness ? (
                        <>
                          <span class="badge info">Neugeschäft</span> <b>{r.name}</b>
                        </>
                      ) : (
                        <a href={`/auswertungen/budget/objekt/${r.key}?jahr=${year}`}>
                          {r.site_no} · {r.name}
                        </a>
                      )}
                      <div class="small mut">{r.customer_name}</div>
                      {total(r.revenue) === 0n && total(r.direct) > 0n && (
                        <div class="cost-flag">Kosten ohne Umsatz</div>
                      )}
                      {total(r.revenue) > 0n &&
                        total(r.minutes.map(BigInt)) === 0n &&
                        total(r.sub) === 0n && <div class="cost-flag">keine Einsätze/NU geplant</div>}
                    </td>
                    <AmountCells a={agg([r])} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="card" style="margin-top:16px">
            <h2>Neugeschäft / weitere Umsätze</h2>
            <p class="small mut">
              Erwartete neue Aufträge (z. B. Ausschreibung), die noch nicht als Objekt angelegt sind: Umsatz
              und Kosten je Monat ab dem erwarteten Start. Stehen in der Liste als eigene Zeile.
            </p>
            {d.adjustments.filter((a) => !a.site_id).length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Bezeichnung</th>
                    <th>Monate</th>
                    <th class="r">Umsatz / Monat</th>
                    <th class="r">Kosten / Monat</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {d.adjustments
                    .filter((a) => !a.site_id)
                    .map((a) => (
                      <tr>
                        <td>
                          {a.label}
                          {a.note && <div class="small mut">{a.note}</div>}
                        </td>
                        <td>
                          {MON[a.from_month - 1]}–{MON[a.to_month - 1]}
                        </td>
                        <td class="r">{euro(a.revenue_month)}</td>
                        <td class="r">{euro(a.cost_month)}</td>
                        <td class="r">
                          {draft && edit && (
                            <form
                              method="post"
                              action={`/auswertungen/budget/${year}/anpassung/${a.id}/loeschen`}
                              data-confirm="Eintrag löschen?"
                            >
                              <input type="hidden" name="zurueck" value={keep()} />
                              <button class="btn ghost sm danger">Löschen</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            {draft && edit && (
              <details>
                <summary>+ Neugeschäft hinzufügen</summary>
                <AdjustmentForm year={year} back={keep()} customers={customers} />
              </details>
            )}
          </div>
        </>
      );
    } else if (view === 'kunde') {
      const groups = new Map<string, BudgetRow[]>();
      for (const r of rows) {
        const k = r.customer_id ?? 'neu';
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      const list2 = [...groups.entries()]
        .map(([k, rs]) => ({ k, rs, a: agg(rs) }))
        .sort((x, y) => (y.a.revenue > x.a.revenue ? 1 : y.a.revenue < x.a.revenue ? -1 : 0));
      body = (
        <div class="table-wrap">
          <table>
            <thead>
              <AmountHead first="Kunde" />
            </thead>
            <tbody>
              <tr class="sum">
                <td>
                  <b>Gesamt</b> <span class="small mut">({list2.length} Kunden)</span>
                </td>
                <AmountCells a={sum} />
              </tr>
              {list2.map(({ k, rs, a }) => (
                <tr>
                  <td>
                    {k === 'neu' ? (
                      <b>Neugeschäft</b>
                    ) : (
                      <a href={keep({ ansicht: 'objekt', kunde: k })}>
                        {rs[0]!.customer_no ? `${rs[0]!.customer_no} · ` : ''}
                        {rs[0]!.customer_name}
                      </a>
                    )}
                    <div class="small mut">
                      {rs.length} {rs.length === 1 ? 'Objekt' : 'Objekte'}
                    </div>
                  </td>
                  <AmountCells a={a} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (view === 'monat') {
      const showOverhead = !filtered;
      body = (
        <div class="table-wrap">
          <table>
            <thead>
              <AmountHead first="Monat" />
            </thead>
            <tbody>
              <tr class="sum">
                <td>
                  <b>Jahr {year}</b>
                </td>
                <AmountCells a={sum} />
              </tr>
              {M12.map((i) => (
                <tr>
                  <td>{MON_LONG[i]}</td>
                  <AmountCells a={agg(rows, [i])} />
                </tr>
              ))}
            </tbody>
          </table>
          {showOverhead && investYear > 0n && (
            <p class="small mut" style="margin-top:8px">
              Dazu Investitionen {eur0(investYear)} im Jahr (nicht verteilt, siehe Gemeinkosten).
            </p>
          )}
        </div>
      );
    } else if (view === 'kosten') {
      const sumOf = (cat: (typeof d.costs)[number]) => total(cat.amounts);
      body = (
        <>
          <p class="small mut" style="margin-top:0">
            Vorschläge kommen aus der Berechnung: Objektleitung, Büro und Geschäftsführer aus Einsatzplanung
            und Lohnarten (mit Tariferhöhung), Sachkosten aus wiederkehrenden Zahlungen ({year}) und dem Ø der
            Eingangsrechnungen an allgemeinen Kostenstellen der letzten 12 Monate. Geänderte Beträge bleiben
            beim nächsten Berechnen stehen. Gemeinkosten werden nach Umsatz auf die Objekte verteilt,
            Investitionen nicht.
          </p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kostenart</th>
                  <th class="r">Plan {year}</th>
                  <th class="r">je Monat Ø</th>
                  <th class="r">Vorschlag</th>
                  <th>Herkunft</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr class="sum">
                  <td>
                    <b>Gemeinkosten gesamt</b>
                  </td>
                  <td class="r">
                    <b>{eur0(overheadYear)}</b>
                  </td>
                  <td class="r">{eur0(overheadYear / 12n)}</td>
                  <td colspan={3} class="small mut">
                    {pct(overheadYear, allSum.revenue)} vom Umsatz
                  </td>
                </tr>
                {d.costs.map((r) => (
                  <tr>
                    <td>
                      <b>{r.label}</b>
                      {r.invest && <span class="badge grey">nicht verteilt</span>}
                      {r.manual && r.suggested && <span class="badge warn">von Hand</span>}
                      {r.note && <div class="small mut">{r.note}</div>}
                      {draft && edit && (
                        <details>
                          <summary class="small">bearbeiten</summary>
                          <CostForm year={year} row={r} back={keep()} />
                        </details>
                      )}
                    </td>
                    <td class="r">
                      <b>{eur0(sumOf(r))}</b>
                    </td>
                    <td class="r">{eur0(sumOf(r) / 12n)}</td>
                    <td class="r mut">{r.suggested ? eur0(total(r.suggested)) : '–'}</td>
                    <td class="small mut">{r.source ?? (r.invest ? 'von Hand eintragen' : '')}</td>
                    <td class="r">
                      {draft && edit && r.manual && r.suggested && (
                        <form method="post" action={`/auswertungen/budget/${year}/kosten/${r.id}/vorschlag`}>
                          <input type="hidden" name="zurueck" value={keep()} />
                          <button class="btn ghost sm">Vorschlag übernehmen</button>
                        </form>
                      )}
                      {draft && edit && r.sort >= 100 && (
                        <form
                          method="post"
                          action={`/auswertungen/budget/${year}/kosten/${r.id}/loeschen`}
                          data-confirm="Kostenposition löschen?"
                        >
                          <input type="hidden" name="zurueck" value={keep()} />
                          <button class="btn ghost sm danger">Löschen</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
                {investYear > 0n && (
                  <tr class="sum">
                    <td>
                      <b>Investitionen</b>
                    </td>
                    <td class="r">
                      <b>{eur0(investYear)}</b>
                    </td>
                    <td colspan={4} class="small mut">
                      nicht in den Gemeinkosten – Liquidität; steuerlich Abschreibung (Steuerberater)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {draft && edit && (
            <details class="card" style="margin-top:14px">
              <summary>+ Weitere Kostenposition</summary>
              <CostForm year={year} row={null} back={keep()} />
            </details>
          )}
        </>
      );
    } else {
      // Soll / Ist
      const act = await budgetActuals(sql, year, todayBerlin());
      if (!act.lastFull)
        body = (
          <div class="empty">
            Soll/Ist gibt es ab dem ersten abgeschlossenen Monat {year} (also ab Februar {year} für den
            Januar).
          </div>
        );
      else {
        const siteKeys = new Set(rows.map((r) => r.key));
        const istOf = (i: number) => {
          if (!filtered) return act.months[i]!;
          let rev = 0n;
          let dir = 0n;
          for (const [s, p] of act.perSite)
            if (siteKeys.has(s)) {
              rev += p.revenue[i]!;
              dir += p.direct[i]!;
            }
          return { month: i + 1, revenue: rev, direct: dir, overhead: 0n };
        };
        const months = M12.slice(0, act.lastFull);
        const Dev = ({ ist, soll }: { ist: bigint; soll: bigint }) => {
          const dv = ist - soll;
          return <td class={dv < 0n ? 'r neg' : 'r'}>{(dv > 0n ? '+' : '') + num0(dv)}</td>;
        };
        const lines = months.map((i) => {
          const s = agg(rows, [i]);
          const t = istOf(i);
          const ohSoll = filtered ? 0n : d.overhead[i]!;
          return {
            i,
            sRev: s.revenue,
            iRev: t.revenue,
            sDb: s.db,
            iDb: t.revenue - t.direct,
            sOh: ohSoll,
            iOh: t.overhead,
            sRes: s.db - ohSoll,
            iRes: t.revenue - t.direct - t.overhead,
          };
        });
        const tot = lines.reduce(
          (a, l) => ({
            sRev: a.sRev + l.sRev,
            iRev: a.iRev + l.iRev,
            sDb: a.sDb + l.sDb,
            iDb: a.iDb + l.iDb,
            sOh: a.sOh + l.sOh,
            iOh: a.iOh + l.iOh,
            sRes: a.sRes + l.sRes,
            iRes: a.iRes + l.iRes,
          }),
          { sRev: 0n, iRev: 0n, sDb: 0n, iDb: 0n, sOh: 0n, iOh: 0n, sRes: 0n, iRes: 0n },
        );
        const Line = ({ l, label }: { l: typeof tot; label: unknown }) => (
          <>
            <td>{label}</td>
            <td class="r">{num0(l.sRev)}</td>
            <td class="r">{num0(l.iRev)}</td>
            <Dev ist={l.iRev} soll={l.sRev} />
            <td class="r">{num0(l.sDb)}</td>
            <td class={l.iDb < 0n ? 'r neg' : 'r'}>{num0(l.iDb)}</td>
            <Dev ist={l.iDb} soll={l.sDb} />
            {!filtered && (
              <>
                <td class="r">{num0(l.sRes)}</td>
                <td class={l.iRes < 0n ? 'r neg' : 'r'}>
                  <b>{num0(l.iRes)}</b>
                </td>
                <Dev ist={l.iRes} soll={l.sRes} />
              </>
            )}
          </>
        );
        // je Objekt bis zum letzten abgeschlossenen Monat
        const perObj = rows
          .filter((r) => !r.newBusiness)
          .map((r) => {
            const s = agg([r], months);
            const p = act.perSite.get(r.key);
            const iRev = p ? total(p.revenue.slice(0, act.lastFull)) : 0n;
            const iDir = p ? total(p.direct.slice(0, act.lastFull)) : 0n;
            return { r, sRev: s.revenue, iRev, sDb: s.db, iDb: iRev - iDir };
          })
          .sort((x, y) => (x.iDb - x.sDb < y.iDb - y.sDb ? -1 : 1));
        body = (
          <>
            <p class="small mut" style="margin-top:0">
              Ist aus der Nachkalkulation (Rechnungen nach Leistungszeitraum, Lohn laut Lohnarten,
              Eingangsrechnungen). Bis einschließlich {MON_LONG[act.lastFull - 1]} {year}. Rot = schlechter
              als geplant bzw. Verlust.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      Monat <span class="small mut">(in €)</span>
                    </th>
                    <th class="r">Umsatz Plan</th>
                    <th class="r">Umsatz Ist</th>
                    <th class="r">Abw.</th>
                    <th class="r">DB I Plan</th>
                    <th class="r">DB I Ist</th>
                    <th class="r">Abw.</th>
                    {!filtered && (
                      <>
                        <th class="r">Ergebnis Plan</th>
                        <th class="r">Ergebnis Ist</th>
                        <th class="r">Abw.</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  <tr class="sum">
                    <Line l={tot} label={<b>bis {MON[act.lastFull - 1]}</b>} />
                  </tr>
                  {lines.map((l) => (
                    <tr>
                      <Line l={l} label={MON_LONG[l.i]} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2 style="margin-top:20px">Je Objekt (bis {MON_LONG[act.lastFull - 1]})</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      Objekt <span class="small mut">(in €)</span>
                    </th>
                    <th class="r">Umsatz Plan</th>
                    <th class="r">Umsatz Ist</th>
                    <th class="r">Abw.</th>
                    <th class="r">DB I Plan</th>
                    <th class="r">DB I Ist</th>
                    <th class="r">Abw.</th>
                  </tr>
                </thead>
                <tbody>
                  {perObj.map((o) => (
                    <tr>
                      <td>
                        <a href={`/auswertungen/budget/objekt/${o.r.key}?jahr=${year}`}>
                          {o.r.site_no} · {o.r.name}
                        </a>
                        <div class="small mut">{o.r.customer_name}</div>
                      </td>
                      <td class="r">{num0(o.sRev)}</td>
                      <td class="r">{num0(o.iRev)}</td>
                      <Dev ist={o.iRev} soll={o.sRev} />
                      <td class="r">{num0(o.sDb)}</td>
                      <td class={o.iDb < 0n ? 'r neg' : 'r'}>{num0(o.iDb)}</td>
                      <Dev ist={o.iDb} soll={o.sDb} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      }
    }

    const refresh = b.computing ? <meta http-equiv="refresh" content="5" /> : null;
    return page(
      c,
      `Budget ${year}`,
      'auswertungen',
      <>
        {refresh}
        <style>{'td.nw{white-space:nowrap}'}</style>
        <PageHead title={`Budgetplanung ${year}`} crumbs={[['Auswertungen', '/auswertungen']]} />
        <YearChips />
        <div
          class="card"
          style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between"
        >
          <div>
            <span class={`badge ${draft ? 'warn' : 'ok'}`}>{draft ? 'Entwurf' : 'Freigegeben'}</span>{' '}
            <span class="small mut">
              {b.computing
                ? 'Berechnung läuft … (Seite aktualisiert sich selbst)'
                : b.computed_at
                  ? `berechnet ${new Date(b.computed_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} von ${b.computed_by}`
                  : 'noch nicht berechnet'}
              {!draft &&
                b.approved_at &&
                ` · freigegeben ${new Date(b.approved_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} von ${b.approved_by}`}
            </span>
            {b.compute_error && <div class="err small">Fehler bei der Berechnung: {b.compute_error}</div>}
          </div>
          <div class="actions" style="margin:0">
            {draft && edit && !b.computing && (
              <form method="post" action={`/auswertungen/budget/${year}/berechnen`}>
                <button class={b.computed_at ? 'btn sec' : ''}>
                  {b.computed_at ? 'Neu berechnen' : 'Berechnen'}
                </button>
              </form>
            )}
            <a class="btn sec" href={`/auswertungen/budget/export.xlsx?jahr=${year}`}>
              Excel
            </a>
            {isAdmin(c) && draft && b.computed_at && !b.computing && (
              <form
                method="post"
                action={`/auswertungen/budget/${year}/status`}
                data-confirm={`Budget ${year} freigeben? Danach ist es gesperrt und gilt als Soll.`}
              >
                <input type="hidden" name="status" value="freigegeben" />
                <button class="btn">Freigeben</button>
              </form>
            )}
            {isAdmin(c) && !draft && (
              <form
                method="post"
                action={`/auswertungen/budget/${year}/status`}
                data-confirm="Budget wieder öffnen (Entwurf)? Danach lässt es sich ändern und neu berechnen."
              >
                <input type="hidden" name="status" value="entwurf" />
                <button class="btn sec">Wieder öffnen</button>
              </form>
            )}
          </div>
        </div>
        <div class="kpis" style="margin:14px 0">
          <div class="kpi">
            <div class="l">Umsatz {year}</div>
            <div class="v">{eur0(sum.revenue)}</div>
            <div class="s">
              Vorjahr Ist {eur0(sum.prev)}
              {sum.prev > 0n &&
                ` (${sum.revenue >= sum.prev ? '+' : ''}${pct(sum.revenue - sum.prev, sum.prev)})`}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Direkte Kosten</div>
            <div class="v">{eur0(sum.labor + sum.sub + sum.material + sum.adjCost)}</div>
            <div class="s">
              Lohn {eur0(sum.labor)} · NU {eur0(sum.sub)} · Material {eur0(sum.material + sum.adjCost)}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Deckungsbeitrag I</div>
            <div class="v" style={sum.db < 0n ? 'color:var(--c-err)' : ''}>
              {eur0(sum.db)}
            </div>
            <div class="s">{pct(sum.db, sum.revenue)} vom Umsatz</div>
          </div>
          <div class="kpi">
            <div class="l">Gemeinkosten{filtered ? ' (Anteil)' : ''}</div>
            <div class="v">{eur0(filtered ? sum.overhead : overheadYear)}</div>
            <div class="s">
              <a href={keep({ ansicht: 'kosten' })}>{pct(overheadYear, allSum.revenue)} vom Umsatz →</a>
            </div>
          </div>
          <div class="kpi">
            <div class="l">Ergebnis</div>
            <div class="v" style={sum.result < 0n ? 'color:var(--c-err)' : ''}>
              {eur0(sum.result)}
            </div>
            <div class="s">
              {pct(sum.result, sum.revenue)} Marge
              {!filtered && investYear > 0n && ` · nach Investitionen ${eur0(sum.result - investYear)}`}
            </div>
          </div>
        </div>
        <details class="card" style="margin-bottom:14px">
          <summary>
            Annahmen: Tariferhöhung {(b.wage_increase_bp / 100).toLocaleString('de-DE')} % ab{' '}
            {MON_LONG[b.wage_increase_month - 1]}
            {b.pass_on ? ', an Kunden weitergegeben' : ', nicht weitergegeben'}
            {b.extra_like_prev ? ', Sonderleistungen wie Vorjahr' : ''}
          </summary>
          <form method="post" action={`/auswertungen/budget/${year}/einstellungen`} data-noback>
            <div class="grid">
              <label>
                Tariflohnerhöhung in %
                <input
                  name="wage_increase"
                  inputmode="decimal"
                  value={String(b.wage_increase_bp / 100).replace('.', ',')}
                  disabled={!draft || !edit}
                />
              </label>
              <label>
                gilt ab Monat
                <select name="wage_month" disabled={!draft || !edit}>
                  {M12.map((i) => (
                    <option value={String(i + 1)} selected={b.wage_increase_month === i + 1}>
                      {MON_LONG[i]}
                    </option>
                  ))}
                </select>
              </label>
              <label class="chk">
                <input
                  type="checkbox"
                  name="pass_on"
                  value="1"
                  checked={b.pass_on}
                  disabled={!draft || !edit}
                />{' '}
                Erhöhung über den Lohnkostenanteil an die Kunden weitergeben (Preisanpassung)
              </label>
              <label class="chk">
                <input
                  type="checkbox"
                  name="extra"
                  value="1"
                  checked={b.extra_like_prev}
                  disabled={!draft || !edit}
                />{' '}
                Sonder- und Einzelleistungen wie im Vorjahr (Ist-Umsatz über den regelmäßigen Leistungen)
              </label>
              <label class="chk">
                <input
                  type="checkbox"
                  name="allocate"
                  value="1"
                  checked={b.allocate}
                  disabled={!draft || !edit}
                />{' '}
                Gemeinkosten nach Umsatz auf die Objekte verteilen
              </label>
              <label>
                Notiz
                <textarea name="note" rows={2} disabled={!draft || !edit}>
                  {b.note ?? ''}
                </textarea>
              </label>
            </div>
            {draft && edit && (
              <div class="actions">
                <button class="btn">Speichern und neu berechnen</button>
              </div>
            )}
          </form>
          <p class="small mut">
            Lohn = Einsatzplanung {year} wie Lohnarten (Urlaub, Krank, Feiertag, Zuschläge) +
            Arbeitgeberkosten nach Lohnhöhe (Minijob/Midijob/regulär, Sätze unter Plan-Kalkulation).
            Nachunternehmer laut erteilten Bestellungen. Material {''}pauschal in % vom Umsatz. Einsätze, die
            erst später geplant werden, fehlen – dann Lohn über eine Anpassung am Objekt ergänzen.
          </p>
        </details>
        <Tabs tabs={tabs} active={view} />
        {view !== 'kosten' && (
          <form method="get" action="/auswertungen/budget" class="actions" style="margin:8px 0 12px">
            <input type="hidden" name="jahr" value={String(year)} />
            {view !== 'objekt' && <input type="hidden" name="ansicht" value={view} />}
            <select name="kunde" aria-label="Kunde" style="max-width:280px">
              <option value="">Alle Kunden</option>
              {customers.map(([id, name]) => (
                <option value={id} selected={id === q.kunde}>
                  {name}
                </option>
              ))}
            </select>
            <select name="objekt" aria-label="Objekt" style="max-width:320px">
              <option value="">Alle Objekte</option>
              {d.rows
                .filter((r) => !q.kunde || r.customer_id === q.kunde)
                .map((r) => (
                  <option value={r.key} selected={r.key === q.objekt}>
                    {r.newBusiness
                      ? `Neugeschäft: ${r.name}`
                      : `${r.site_no} · ${r.name} (${r.customer_name})`}
                  </option>
                ))}
            </select>
            <select name="ol" aria-label="Objektleitung" style="max-width:220px">
              <option value="">Alle Objektleitungen</option>
              <option value="ohne" selected={q.ol === 'ohne'}>
                ohne Objektleitung
              </option>
              {managers.map((m) => (
                <option value={m.user_id} selected={m.user_id === q.ol}>
                  {m.name}
                </option>
              ))}
            </select>
            <label class="chk">
              <input type="checkbox" name="verlust" value="1" checked={q.verlust} /> nur Verlust
            </label>
            <button class="btn sec">Filtern</button>
          </form>
        )}
        {body}
      </>,
    );
  });

  // ---------------------------------------------------------------- Objekt im Detail
  app.get('/auswertungen/budget/objekt/:key', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const d = await budgetData(sql, year);
    if (!d) return c.redirect(base(year));
    const r = d.rows.find((x) => x.key === c.req.param('key'));
    if (!r) return c.redirect(base(year));
    const draft = d.budget.status === 'entwurf';
    const edit = canEdit(c);
    const a = agg([r]);
    const adj = d.adjustments.filter((x) => x.site_id === r.site_id);
    const back2 = `/auswertungen/budget/objekt/${r.key}?jahr=${year}`;
    const Cell = ({ v, neg }: { v: bigint; neg?: boolean | undefined }) => (
      <td class={neg && v < 0n ? 'r neg' : 'r'}>{v ? num0(v) : '–'}</td>
    );
    const lines: [string, bigint[], boolean?][] = [
      ['Laufende Leistungen', r.flat],
      ['Turnus / einmalig', r.cycle],
      ['Sonderleistungen wie Vorjahr', r.extra],
      ['Preiserhöhung (Lohnanteil)', r.increase],
      ['Anpassung Umsatz', r.adjRevenue],
      ['Umsatz', r.revenue],
      ['Vorjahr (Ist)', r.prev],
      ['Lohn inkl. AG-Kosten', r.labor],
      ['Nachunternehmer', r.sub],
      ['Material', r.material],
      ['Anpassung Kosten', r.adjCost],
      ['Deckungsbeitrag I', r.db, true],
      ['Gemeinkosten-Anteil', r.overhead],
      ['Ergebnis', r.result, true],
    ];
    const bold = new Set(['Umsatz', 'Deckungsbeitrag I', 'Ergebnis']);
    return page(
      c,
      `Budget ${year} – ${r.name}`,
      'auswertungen',
      <>
        <PageHead
          title={`${r.site_no} · ${r.name}`}
          crumbs={[
            ['Auswertungen', '/auswertungen'],
            [`Budget ${year}`, base(year)],
          ]}
        />
        <p class="small mut" style="margin-top:-6px">
          {r.customer_name} · <a href={`/objekte/${r.site_id}`}>Objekt öffnen</a> ·{' '}
          <a href={`/objekte/${r.site_id}/leistungen`}>Leistungen & Preise</a>
        </p>
        <div class="kpis kpis-sm" style="margin:10px 0 14px">
          <div class="kpi">
            <div class="l">Umsatz {year}</div>
            <div class="v">{eur0(a.revenue)}</div>
            <div class="s">Vorjahr {eur0(a.prev)}</div>
          </div>
          <div class="kpi">
            <div class="l">Deckungsbeitrag I</div>
            <div class="v">{eur0(a.db)}</div>
            <div class="s">{pct(a.db, a.revenue)}</div>
          </div>
          <div class="kpi">
            <div class="l">Ergebnis</div>
            <div class="v" style={a.result < 0n ? 'color:var(--c-err)' : ''}>
              {eur0(a.result)}
            </div>
            <div class="s">{pct(a.result, a.revenue)} Marge</div>
          </div>
          <div class="kpi">
            <div class="l">Stunden geplant</div>
            <div class="v">{hours(a.minutes)}</div>
            <div class="s">
              {a.minutes > 0
                ? `Umsatz je Std. ${euro((a.revenue * 60n) / BigInt(a.minutes))}`
                : 'keine Einsätze'}
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table data-nostick style="font-size:13px">
            <thead>
              <tr>
                <th class="small mut">in €</th>
                {MON.map((m) => (
                  <th class="r">{m}</th>
                ))}
                <th class="r">Jahr</th>
              </tr>
            </thead>
            <tbody>
              {lines
                .filter(([l, v]) => v.some((x) => x !== 0n) || bold.has(l))
                .map(([l, v, neg]) => (
                  <tr class={bold.has(l) ? 'sum' : ''}>
                    <td style="white-space:nowrap">{bold.has(l) ? <b>{l}</b> : l}</td>
                    {M12.map((i) => (
                      <Cell v={v[i]!} neg={neg} />
                    ))}
                    <td class={neg && total(v) < 0n ? 'r neg' : 'r'}>
                      <b>{num0(total(v))}</b>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div class="card" style="margin-top:16px;max-width:900px">
          <h2>Anpassungen für dieses Objekt</h2>
          <p class="small mut">
            Was die Daten noch nicht kennen: z. B. Preiserhöhung vereinbart, Kündigung zum 30.06., zusätzliche
            Sonderreinigung, noch nicht geplante Einsätze. Betrag je Monat, Minus für weniger.
          </p>
          {adj.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Bezeichnung</th>
                  <th>Monate</th>
                  <th class="r">Umsatz / Monat</th>
                  <th class="r">Kosten / Monat</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {adj.map((x) => (
                  <tr>
                    <td>
                      {x.label}
                      {x.note && <div class="small mut">{x.note}</div>}
                    </td>
                    <td>
                      {MON[x.from_month - 1]}–{MON[x.to_month - 1]}
                    </td>
                    <td class="r">{euro(x.revenue_month)}</td>
                    <td class="r">{euro(x.cost_month)}</td>
                    <td class="r">
                      {draft && edit && (
                        <form
                          method="post"
                          action={`/auswertungen/budget/${year}/anpassung/${x.id}/loeschen`}
                          data-confirm="Anpassung löschen?"
                        >
                          <input type="hidden" name="zurueck" value={back2} />
                          <button class="btn ghost sm danger">Löschen</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {draft && edit ? (
            <AdjustmentForm year={year} back={back2} siteId={r.site_id!} />
          ) : (
            !draft && <p class="small mut">Budget ist freigegeben – Änderungen erst nach „Wieder öffnen“.</p>
          )}
        </div>
      </>,
    );
  });

  // ---------------------------------------------------------------- Excel
  app.get('/auswertungen/budget/export.xlsx', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const d = await budgetData(sql, year);
    if (!d) return c.redirect(base(year));
    const n = (v: bigint): XlsxCell => ({ n: Number(v) / 100, fmt: 'eur' });
    const objRows = d.rows.map((r) => {
      const a = agg([r]);
      return [
        r.newBusiness ? 'NEU' : r.site_no,
        r.name,
        r.customer_name,
        n(a.revenue),
        n(a.regular),
        n(a.extra),
        n(a.increase + a.adj),
        n(a.prev),
        { n: Math.round(a.minutes / 60), fmt: 'int' } as XlsxCell,
        n(a.labor),
        n(a.sub),
        n(a.material + a.adjCost),
        n(a.db),
        n(a.overhead),
        n(a.result),
      ];
    });
    const all = agg(d.rows);
    const sheets = [
      {
        name: 'Objekte',
        title: [`Budget ${year} (${d.budget.status === 'freigegeben' ? 'freigegeben' : 'Entwurf'})`],
        header: [
          'Nr.',
          'Objekt',
          'Kunde',
          'Umsatz',
          'davon laufend/Turnus',
          'Sonder wie Vorjahr',
          'Erhöhung/Anpassung',
          'Vorjahr Ist',
          'Stunden',
          'Lohn inkl. AG',
          'Nachunternehmer',
          'Material/Sonst.',
          'DB I',
          'Gemeinkosten',
          'Ergebnis',
        ],
        rows: objRows,
        footer: [
          [
            'Gesamt',
            '',
            '',
            n(all.revenue),
            n(all.regular),
            n(all.extra),
            n(all.increase + all.adj),
            n(all.prev),
            { n: Math.round(all.minutes / 60), fmt: 'int' } as XlsxCell,
            n(all.labor),
            n(all.sub),
            n(all.material + all.adjCost),
            n(all.db),
            n(all.overhead),
            n(all.result),
          ],
        ],
        widths: [10, 34, 28, 14, 14, 14, 14, 14, 9, 14, 14, 14, 14, 14, 14],
      },
      {
        name: 'Monate',
        header: [
          'Monat',
          'Umsatz',
          'Lohn',
          'Nachunternehmer',
          'Material/Sonst.',
          'DB I',
          'Gemeinkosten',
          'Investitionen',
          'Ergebnis',
        ],
        rows: M12.map((i) => {
          const a = agg(d.rows, [i]);
          return [
            MON_LONG[i]!,
            n(a.revenue),
            n(a.labor),
            n(a.sub),
            n(a.material + a.adjCost),
            n(a.db),
            n(d.overhead[i]!),
            n(d.invest[i]!),
            n(a.db - d.overhead[i]!),
          ];
        }),
        widths: [14, 14, 14, 14, 14, 14, 14, 14, 14],
      },
      {
        name: 'Gemeinkosten',
        header: ['Kostenart', ...MON, 'Jahr', 'Herkunft'],
        rows: d.costs.map((r) => [r.label, ...r.amounts.map(n), n(total(r.amounts)), r.source ?? '']),
        widths: [40, ...M12.map(() => 11), 14, 40],
      },
    ];
    return xlsxFile(c, writeXlsx(sheets), `Budget_${year}.xlsx`);
  });

  // ---------------------------------------------------------------- Aktionen
  const backTo = (b: Record<string, unknown>, year: number) =>
    typeof b.zurueck === 'string' && b.zurueck.startsWith('/auswertungen/budget') ? b.zurueck : base(year);

  app.post('/auswertungen/budget/anlegen', async (c) => {
    const b = await c.req.parseBody();
    const year = yearOf(String(b.jahr ?? ''));
    try {
      guard(c);
      const bud = await ensureBudget(sql, year, c.get('actor'));
      if (!bud.computed_at) await startBudgetCompute(sql, bud.id, c.get('actor'));
      return back(c, base(year), { ok: `Budget ${year} angelegt – Berechnung läuft` });
    } catch (e) {
      return back(c, base(year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/berechnen', async (c) => {
    const year = yearOf(c.req.param('year'));
    try {
      guard(c);
      await startBudgetCompute(sql, await budgetIdOf(year), c.get('actor'));
      return back(c, base(year), { ok: 'Berechnung läuft – die Seite aktualisiert sich selbst' });
    } catch (e) {
      return back(c, base(year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/einstellungen', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    try {
      guard(c);
      const id = await budgetIdOf(year);
      const pctIn =
        String(b.wage_increase ?? '0')
          .replace(',', '.')
          .trim() || '0';
      const bp = Math.round(Number(pctIn) * 100);
      if (!Number.isFinite(bp)) throw new BusinessError('Tariferhöhung: bitte Zahl in %');
      await saveBudgetSettings(
        sql,
        id,
        {
          wage_increase_bp: bp,
          wage_increase_month: Number(b.wage_month ?? 1),
          pass_on: b.pass_on === '1',
          extra_like_prev: b.extra === '1',
          allocate: b.allocate === '1',
          note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 2000) : null,
        },
        c.get('actor'),
      );
      await startBudgetCompute(sql, id, c.get('actor'));
      return back(c, base(year), { ok: 'Annahmen gespeichert – Berechnung läuft' });
    } catch (e) {
      return back(c, base(year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/status', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    try {
      if (!isAdmin(c)) throw new BusinessError('Freigeben darf nur der Admin');
      const status = b.status === 'freigegeben' ? 'freigegeben' : 'entwurf';
      await setBudgetStatus(sql, await budgetIdOf(year), status, c.get('actor'));
      return back(c, base(year), {
        ok: status === 'freigegeben' ? `Budget ${year} freigegeben` : `Budget ${year} wieder geöffnet`,
      });
    } catch (e) {
      return back(c, base(year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/kosten', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    const to = backTo(b, year);
    try {
      guard(c);
      const same = typeof b.gleich === 'string' && b.gleich.trim() ? moneyIn(b.gleich) : null;
      const yearly =
        typeof b.jahr_betrag === 'string' && b.jahr_betrag.trim() ? moneyIn(b.jahr_betrag) : null;
      let amounts: bigint[];
      if (yearly !== null) {
        const base12 = yearly / 12n;
        amounts = M12.map((i) => base12 + (BigInt(i) < yearly - base12 * 12n ? 1n : 0n));
      } else if (same !== null) amounts = M12.map(() => same);
      else amounts = M12.map((i) => moneyIn(b[`m${i + 1}`]));
      const cat = String(b.category ?? 'sonstiges');
      await saveCostRow(
        sql,
        await budgetIdOf(year),
        {
          id: typeof b.id === 'string' && /^[0-9a-f-]{36}$/i.test(b.id) ? b.id : randomUUID(),
          label: String(b.label ?? COST_LABEL[cat] ?? '').slice(0, 200),
          category: cat,
          amounts,
          note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null,
        },
        c.get('actor'),
      );
      return back(c, to, { ok: 'Kostenposition gespeichert' });
    } catch (e) {
      return back(c, to, { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/kosten/:row/vorschlag', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    try {
      guard(c);
      await resetCostRow(sql, await budgetIdOf(year), c.req.param('row'), c.get('actor'));
      return back(c, backTo(b, year), { ok: 'Vorschlag übernommen' });
    } catch (e) {
      return back(c, backTo(b, year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/kosten/:row/loeschen', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    try {
      guard(c);
      await deleteCostRow(sql, await budgetIdOf(year), c.req.param('row'), c.get('actor'));
      return back(c, backTo(b, year), { ok: 'Kostenposition gelöscht' });
    } catch (e) {
      return back(c, backTo(b, year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/anpassung', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    const to = backTo(b, year);
    try {
      guard(c);
      const site = typeof b.site_id === 'string' && /^[0-9a-f-]{36}$/i.test(b.site_id) ? b.site_id : null;
      const cust =
        typeof b.customer_id === 'string' && /^[0-9a-f-]{36}$/i.test(b.customer_id) ? b.customer_id : null;
      await saveAdjustment(
        sql,
        await budgetIdOf(year),
        {
          id: typeof b.id === 'string' && /^[0-9a-f-]{36}$/i.test(b.id) ? b.id : randomUUID(),
          site_id: site,
          customer_id: site ? null : cust,
          label: String(b.label ?? '').slice(0, 200),
          from_month: Number(b.from_month ?? 1),
          to_month: Number(b.to_month ?? 12),
          revenue_month: moneyIn(b.revenue),
          cost_month: moneyIn(b.cost),
          note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null,
        },
        c.get('actor'),
      );
      return back(c, to, { ok: 'Gespeichert' });
    } catch (e) {
      return back(c, to, { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/anpassung/:aid/loeschen', async (c) => {
    const year = yearOf(c.req.param('year'));
    const b = await c.req.parseBody();
    try {
      guard(c);
      await deleteAdjustment(sql, await budgetIdOf(year), c.req.param('aid'), c.get('actor'));
      return back(c, backTo(b, year), { ok: 'Gelöscht' });
    } catch (e) {
      return back(c, backTo(b, year), { fehler: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Formular Neugeschäft (ohne Objekt) bzw. Anpassung am Objekt */
const AdjustmentForm = ({
  year,
  back,
  siteId,
  customers,
}: {
  year: number;
  back: string;
  siteId?: string;
  customers?: [string, string][];
}) => (
  <form method="post" action={`/auswertungen/budget/${year}/anpassung`} style="margin-top:10px" data-noback>
    <input type="hidden" name="id" value={randomUUID()} />
    <input type="hidden" name="zurueck" value={back} />
    {siteId && <input type="hidden" name="site_id" value={siteId} />}
    <div class="grid">
      <label>
        Bezeichnung
        <input
          name="label"
          required
          maxlength={200}
          placeholder={
            siteId
              ? 'z. B. Preiserhöhung vereinbart, Kündigung zum 30.06.'
              : 'z. B. Ausschreibung Schulen Los 2'
          }
        />
      </label>
      {!siteId && customers && (
        <label>
          Kunde (optional)
          <select name="customer_id">
            <option value="">– noch kein Kunde –</option>
            {customers.map(([id, name]) => (
              <option value={id}>{name}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        von Monat
        <select name="from_month">
          {M12.map((i) => (
            <option value={String(i + 1)}>{MON_LONG[i]}</option>
          ))}
        </select>
      </label>
      <label>
        bis Monat
        <select name="to_month">
          {M12.map((i) => (
            <option value={String(i + 1)} selected={i === 11}>
              {MON_LONG[i]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Umsatz je Monat € (netto, Minus = weniger)
        <input name="revenue" inputmode="decimal" placeholder="0,00" />
      </label>
      <label>
        Kosten je Monat € (Lohn, NU, Material)
        <input name="cost" inputmode="decimal" placeholder="0,00" />
      </label>
      <label>
        Notiz
        <input name="note" maxlength={500} />
      </label>
    </div>
    <div class="actions">
      <button class="btn">{siteId ? 'Anpassung speichern' : 'Neugeschäft speichern'}</button>
    </div>
  </form>
);

/** Formular Kostenposition: gleicher Betrag je Monat, Jahresbetrag oder je Monat einzeln */
const CostForm = ({
  year,
  row,
  back,
}: {
  year: number;
  row: { id: string; category: string; label: string; amounts: bigint[]; note: string | null } | null;
  back: string;
}) => {
  const same = row && row.amounts.every((v) => v === row.amounts[0]) ? row.amounts[0]! : null;
  return (
    <form method="post" action={`/auswertungen/budget/${year}/kosten`} style="margin-top:8px" data-noback>
      <input type="hidden" name="id" value={row?.id ?? randomUUID()} />
      <input type="hidden" name="zurueck" value={back} />
      <div class="grid">
        {row ? (
          <input type="hidden" name="category" value={row.category} />
        ) : (
          <label>
            Kostenart
            <select name="category">
              {COST_CATS.filter((c) => c.auto === 'cost' || c.auto === 'none').map((c) => (
                <option value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Bezeichnung
          <input
            name="label"
            required
            maxlength={200}
            value={row?.label ?? ''}
            placeholder="z. B. Neues Firmenfahrzeug"
          />
        </label>
        <label>
          Gleicher Betrag je Monat €
          <input
            name="gleich"
            inputmode="decimal"
            placeholder={same !== null ? `bisher ${centsToInput(same)}` : 'z. B. 850,00'}
          />
        </label>
        <label>
          oder Jahresbetrag € (gleichmäßig verteilt)
          <input name="jahr_betrag" inputmode="decimal" placeholder="z. B. 12.000,00" />
        </label>
        <label>
          Notiz
          <input name="note" maxlength={500} value={row?.note ?? ''} />
        </label>
      </div>
      <details style="margin-top:6px">
        <summary class="small">je Monat einzeln (z. B. Investition nur im März)</summary>
        <p class="small mut">Gilt nur, wenn „gleicher Betrag“ und „Jahresbetrag“ leer sind.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px">
          {M12.map((i) => (
            <label>
              {MON[i]}
              <input
                name={`m${i + 1}`}
                inputmode="decimal"
                value={row ? centsToInput(row.amounts[i]!) : ''}
              />
            </label>
          ))}
        </div>
      </details>
      <div class="actions">
        <button class="btn">Speichern</button>
      </div>
    </form>
  );
};
