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
  type BudgetPerson,
  budgetData,
  budgetPersons,
  budgetStale,
  deleteAdjustment,
  deleteCostRow,
  ensureBudget,
  getBudget,
  listBudgets,
  resetCostRow,
  saveAdjustment,
  defaultHourRate,
  saveBudgetSettings,
  saveCostRow,
  setBudgetStatus,
  setPersonCategory,
  setSiteExcluded,
  startBudgetCompute,
  startBudgetAuto,
} from '../services/budget.js';
import { BusinessError } from '../services/errors.js';
import type { AppEnv, Ctx } from './app.js';
import { centsToInput } from './forms.js';
import { PageHead, Tabs, euro } from './layout.js';
import { ShareCard, StatBars } from './routes-reports.js';
import { budgetOverviewPdf, mergePdfs } from '../pdf/budget-overview.js';
import { renderTablePdf, type PdfRow } from '../pdf/table.js';

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
const fmtDays = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
const bpTxt = (bp: number) => `${(bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
const hours = (min: number) => `${Math.round(min / 60).toLocaleString('de-DE')} Std.`;
const VIEWS = ['uebersicht', 'objekt', 'kunde', 'monat', 'kosten', 'sollist'] as const;
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
  vacation: bigint;
  sick: bigint;
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
    vacation: 0n,
    sick: 0n,
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
      a.vacation += r.vacation[i]!;
      a.sick += r.sick[i]!;
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

const CAT_LABEL: Record<BudgetPerson['category'], string> = {
  lead: 'Objektleitung',
  office: 'Büro',
  gf: 'Geschäftsführer',
  none: 'nicht berücksichtigen',
};

/** Personen hinter einer Personal-Kostenart: Stunden, Brutto, Arbeitgeberkosten, Kosten – Zuordnung änderbar. */
const PersonTable = ({
  list,
  year,
  back,
  canChange,
  manual,
}: {
  list: BudgetPerson[];
  year: number;
  back: string;
  canChange: boolean;
  manual: boolean;
}) => {
  if (!list.length) return <div class="empty small">Keine Personen.</div>;
  const t = (a: bigint[]) => a.reduce((x, y) => x + y, 0n);
  const sumMin = list.reduce((a, p) => a + p.minutes.reduce((x, y) => x + y, 0), 0);
  return (
    <div class="table-wrap" style="margin-top:6px">
      {manual && (
        <p class="small warn" style="margin:4px 0">
          Die Kostenart ist von Hand geändert – die Personen zeigen den Vorschlag.
        </p>
      )}
      <table class="keep">
        <thead>
          <tr>
            <th>Person</th>
            <th>Vergütung</th>
            <th class="r">Stunden {year}</th>
            <th class="r">Lohn/Gehalt</th>
            <th class="r">AG-Kosten</th>
            <th class="r">Kosten</th>
            <th>zählt als</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr>
              <td>
                <a href={`/personal/${p.employee_id}`}>{p.name}</a>
                {p.personnel_no && <span class="small mut"> · {p.personnel_no}</span>}
              </td>
              <td class="small">{p.pay ?? '–'}</td>
              <td class="r">{hours(p.minutes.reduce((x, y) => x + y, 0))}</td>
              <td class="r">{eur0(t(p.gross))}</td>
              <td class="r">{eur0(t(p.employer))}</td>
              <td class="r">
                <b>{eur0(t(p.amounts))}</b>
              </td>
              <td>
                {canChange ? (
                  <form method="post" action={`/auswertungen/budget/${year}/person/${p.employee_id}`}>
                    <input type="hidden" name="zurueck" value={back} />
                    <select name="kategorie" data-autosubmit aria-label="zählt als">
                      {(['lead', 'office', 'gf', 'none'] as const).map((k) => (
                        <option value={k} selected={p.category === k}>
                          {CAT_LABEL[k]}
                          {k === p.auto_category ? ' (automatisch)' : ''}
                        </option>
                      ))}
                    </select>
                  </form>
                ) : (
                  CAT_LABEL[p.category]
                )}
              </td>
            </tr>
          ))}
          <tr class="sum">
            <td colspan={2}>
              <b>Summe</b>
            </td>
            <td class="r">{hours(sumMin)}</td>
            <td class="r">{eur0(list.reduce((a, p) => a + t(p.gross), 0n))}</td>
            <td class="r">{eur0(list.reduce((a, p) => a + t(p.employer), 0n))}</td>
            <td class="r">
              <b>{eur0(list.reduce((a, p) => a + t(p.amounts), 0n))}</b>
            </td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <p class="small mut" style="margin:4px 0 0">
        Stunden und Lohn aus Einsatzplanung bzw. Lohnarten (Festgehalt = Monatsgehalt), ab dem Monat der
        Tariferhöhung erhöht. Geschäftsführer ohne Arbeitgeberkosten. Fehlt jemand (z. B. ohne Vergütung in
        der App), unter „bearbeiten“ den Betrag von Hand eintragen.
      </p>
    </div>
  );
};

/** Kopfzeile der Beträge (Spalten gleich in allen Ansichten) */
const AmountHead = ({ first }: { first: string }) => (
  <tr>
    <th style="min-width:220px">{first}</th>
    <th class="r">Umsatz</th>
    <th class="r">Lohn inkl. AG</th>
    <th class="r" title="Ausfallzeiten: bezahlter Urlaub und Krankheit als Zuschlag auf den Lohn">
      Urlaub / Krank
    </th>
    <th class="r">Nachunter&shy;nehmer</th>
    <th class="r">Material</th>
    <th class="r" title="Deckungsbeitrag = Umsatz − direkte Kosten, vor Gemeinkosten">
      DB vor Gemein&shy;kosten
    </th>
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
    <td class="r nw" data-sort={String(a.vacation + a.sick)}>
      {eur0(a.vacation + a.sick)}
      {a.vacation + a.sick > 0n && (
        <div class="small mut" style="white-space:nowrap">
          U {eur0(a.vacation)} · K {eur0(a.sick)}
        </div>
      )}
    </td>
    <td class="r nw" data-sort={String(a.sub)}>
      {eur0(a.sub)}
    </td>
    <td class="r nw" data-sort={String(a.material + a.adjCost)}>
      {eur0(a.material + a.adjCost)}
    </td>
    <td class={a.db < 0n ? 'r nw neg' : 'r nw'} data-sort={String(a.db)}>
      <b>{eur0(a.db)}</b>
      <div class="small mut">{a.revenue ? pct(a.db, a.revenue) : '–'}</div>
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

const pctOf = (v: bigint, of: bigint) => pct(v, of);

interface MonthChart {
  label: string;
  revenue: bigint;
  prev: bigint;
  labor: bigint;
  absence: bigint;
  sub: bigint;
  material: bigint;
  overhead: bigint;
  result: bigint;
}

/** Daten für Diagramme und PDF-Übersicht (mit Filter: Gemeinkosten = verteilter Anteil). */
const chartData = (d: BudgetData, rows: BudgetRow[], filtered: boolean) => {
  const months: MonthChart[] = M12.map((i) => {
    const a = agg(rows, [i]);
    const oh = filtered ? a.overhead : d.overhead[i]!;
    return {
      label: MON[i]!,
      revenue: a.revenue,
      prev: a.prev,
      labor: a.labor,
      absence: a.vacation + a.sick,
      sub: a.sub,
      material: a.material + a.adjCost,
      overhead: oh,
      result: a.db - oh,
    };
  });
  const tot = (f: (m: MonthChart) => bigint) => months.reduce((x, m) => x + f(m), 0n);
  const a = agg(rows);
  const result = tot((m) => m.result);
  const structure = [
    { label: 'Lohn inkl. AG-Kosten', href: null, cents: tot((m) => m.labor) },
    { label: 'Ausfall Urlaub / Krank', href: null, cents: tot((m) => m.absence) },
    { label: 'Nachunternehmer', href: null, cents: tot((m) => m.sub) },
    { label: 'Material', href: null, cents: tot((m) => m.material) },
    { label: 'Gemeinkosten', href: null, cents: tot((m) => m.overhead) },
    { label: result >= 0n ? 'Ergebnis' : 'Ergebnis (Verlust)', href: null, cents: result > 0n ? result : 0n },
  ].filter((x) => x.cents !== 0n);
  const kinds = [
    { label: 'Laufende Leistungen / Turnus', href: null, cents: a.regular },
    { label: 'Sonderleistungen wie Vorjahr', href: null, cents: a.extra },
    { label: 'Preiserhöhung (Lohnanteil)', href: null, cents: a.increase },
    { label: 'Neugeschäft / Anpassungen', href: null, cents: a.adj },
  ].filter((k) => k.cents !== 0n);
  const byCust = new Map<string, { label: string; href: string | null; cents: bigint }>();
  for (const r of rows) {
    if (total(r.revenue) === 0n) continue;
    const k = r.customer_id ?? `neu:${r.key}`;
    const e = byCust.get(k) ?? {
      label: r.customer_id ? r.customer_name : `Neugeschäft: ${r.name}`,
      href: null,
      cents: 0n,
    };
    e.cents += total(r.revenue);
    byCust.set(k, e);
  }
  const customers = [...byCust.values()].sort((x, y) => (y.cents > x.cents ? 1 : y.cents < x.cents ? -1 : 0));
  const overhead = d.costs
    .filter((c) => !c.invest)
    .map((c) => ({ label: c.label, href: null, cents: total(c.amounts) }))
    .filter((c) => c.cents > 0n)
    .sort((x, y) => (y.cents > x.cents ? 1 : y.cents < x.cents ? -1 : 0));
  return { months, structure, kinds, customers, overhead };
};

/** Gestapelte Säulen je Monat: Lohn, NU, Material, Gemeinkosten, darüber Ergebnis (grün) bzw. Verlust (rot). */
const StackBars = ({ months }: { months: MonthChart[] }) => {
  const W = 960;
  const H = 300;
  const L = 78;
  const B = 40;
  const max = months.reduce((m, r) => {
    const cost = r.labor + r.absence + r.sub + r.material + r.overhead;
    const v = cost > r.revenue ? cost : r.revenue;
    return v > m ? v : m;
  }, 1n);
  const maxE = Number(max) / 100;
  const step = (() => {
    const raw = maxE / 4;
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
  })();
  const top = Math.ceil(maxE / step) * step || 1;
  const y = (e: number) => H - B - ((H - B - 22) * Math.max(0, e)) / top;
  const bw = (W - L - 10) / months.length;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const colors = ['#7d1435', '#b35a7a', '#c2185b', '#e07a5f', '#98c1d9'];
  const short = (e: number) =>
    Math.abs(e) >= 1e6
      ? `${(e / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio`
      : Math.abs(e) >= 1000
        ? `${Math.round(e / 1000).toLocaleString('de-DE')} T`
        : Math.round(e).toLocaleString('de-DE');
  return (
    <svg class="stat-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Kosten und Ergebnis je Monat">
      {ticks.map((t) => (
        <g>
          <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} class="grid" />
          <text x={L - 8} y={y(t) + 4} text-anchor="end" class="ax">
            {`${t.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`}
          </text>
        </g>
      ))}
      {months.map((m, i) => {
        const w = bw * 0.6;
        const x = L + i * bw + (bw - w) / 2;
        let acc = 0;
        const parts = [m.labor, m.absence, m.sub, m.material, m.overhead].map((v, k) => {
          const e = Number(v) / 100;
          const y1 = y(acc + e);
          const h = y(acc) - y1;
          acc += e;
          return h > 0 ? <rect x={x} y={y1} width={w} height={h} fill={colors[k]} /> : null;
        });
        const rev = Number(m.revenue) / 100;
        const res = Number(m.result) / 100;
        return (
          <g class="bar">
            <rect x={L + i * bw} y={10} width={bw} height={H - B - 10} class="hit" />
            {parts}
            {res > 0 && <rect x={x} y={y(rev)} width={w} height={y(acc) - y(rev)} fill="#2e7d4f" rx={2} />}
            {res < 0 && (
              <line x1={x - 3} x2={x + w + 3} y1={y(rev)} y2={y(rev)} stroke="#b3261e" stroke-width={2.5} />
            )}
            <text
              x={x + w / 2}
              y={y(Math.max(rev, acc)) - 5}
              text-anchor="middle"
              class="val"
              style={res < 0 ? 'fill:#b3261e' : 'fill:#2e7d4f'}
            >
              {short(res)}
            </text>
            <title>{`${m.label}: Umsatz ${euro(m.revenue)} · Lohn ${euro(m.labor)} · Urlaub/Krank ${euro(m.absence)} · NU ${euro(m.sub)} · Material ${euro(m.material)} · Gemeinkosten ${euro(m.overhead)} · Ergebnis ${euro(m.result)}`}</title>
            <text x={x + w / 2} y={H - B + 18} text-anchor="middle" class="ax">
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

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
      : 'uebersicht';
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
    const ab = d.absence;
    const draft = b.status === 'entwurf';
    // neue Kunden/Leistungen, geänderte Objekte oder Einsätze seit der Berechnung → automatisch neu rechnen
    let autoStarted = false;
    if (draft && !b.computing && (await budgetStale(sql, b)))
      try {
        autoStarted = await startBudgetAuto(sql, b.id);
      } catch {
        /* läuft schon */
      }
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
        if (v && !(k === 'ansicht' && v === 'uebersicht')) p.set(k, String(v));
      return `/auswertungen/budget?${p.toString()}`;
    };
    const exportQs = (() => {
      const p = new URLSearchParams({ jahr: String(year) });
      for (const [k, v] of Object.entries({ ...q, verlust: q.verlust ? '1' : '' }))
        if (v) p.set(k, String(v));
      return p.toString();
    })();
    const resultAll = filtered ? sum.result : sum.db - overheadYear;
    const hourRate = await defaultHourRate(sql);
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
      { key: 'uebersicht', label: 'Übersicht', href: keep({ ansicht: 'uebersicht' }) },
      { key: 'objekt', label: 'Objekte', href: keep({ ansicht: 'objekt' }) },
      { key: 'kunde', label: 'Kunden', href: keep({ ansicht: 'kunde' }) },
      { key: 'monat', label: 'Monate', href: keep({ ansicht: 'monat' }) },
      { key: 'kosten', label: 'Gemeinkosten', href: keep({ ansicht: 'kosten' }) },
      { key: 'sollist', label: 'Soll / Ist', href: keep({ ansicht: 'sollist' }) },
    ];

    // ---------- Inhalt je Ansicht
    let body: unknown;
    if (view === 'uebersicht') {
      const ch = chartData(d, rows, filtered);
      const best = [...rows].filter((r) => !r.newBusiness && total(r.revenue) > 0n);
      best.sort((x, y) =>
        total(y.result) > total(x.result) ? 1 : total(y.result) < total(x.result) ? -1 : 0,
      );
      const TopList = ({ title, list }: { title: string; list: BudgetRow[] }) => (
        <div class="card">
          <h3 style="margin-top:0">{title}</h3>
          <table>
            <tbody>
              {list.map((r) => {
                const a = agg([r]);
                return (
                  <tr>
                    <td>
                      <a href={`/auswertungen/budget/objekt/${r.key}?jahr=${year}`}>
                        {r.site_no} · {r.name}
                      </a>
                      <div class="small mut">{r.customer_name}</div>
                    </td>
                    <td class={a.result < 0n ? 'r nw neg' : 'r nw'}>{eur0(a.result)}</td>
                    <td class="r nw">
                      <MarginBadge num={a.result} den={a.revenue} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
      body = (
        <>
          <div class="card">
            <div class="stat-head">
              <h3 style="margin:0">Umsatz je Monat</h3>
              <span class="legend">
                <i class="lg-now" /> Plan {year} <i class="lg-prev" /> Vorjahr (Ist)
              </span>
            </div>
            <StatBars rows={ch.months.map((m) => ({ label: m.label, cents: m.revenue, prev: m.prev }))} />
          </div>
          <div class="card" style="margin-top:14px">
            <div class="stat-head">
              <h3 style="margin:0">Kosten und Ergebnis je Monat</h3>
              <span class="legend">
                <i style="background:#7d1435" /> Lohn <i style="background:#b35a7a" /> Urlaub/Krank{' '}
                <i style="background:#c2185b" /> Nachunternehmer <i style="background:#e07a5f" /> Material{' '}
                <i style="background:#98c1d9" /> Gemeinkosten <i style="background:#2e7d4f" /> Ergebnis
              </span>
            </div>
            <StackBars months={ch.months} />
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px;margin-top:14px">
            <ShareCard title="Wohin geht der Umsatz?" rows={ch.structure} total={sum.revenue} pct={pctOf} />
            <ShareCard title="Umsatz nach Art" rows={ch.kinds} total={sum.revenue} pct={pctOf} />
            <ShareCard title="Umsatz je Kunde" rows={ch.customers} total={sum.revenue} pct={pctOf} />
            {!filtered && (
              <ShareCard
                title="Gemeinkosten nach Kostenart"
                rows={ch.overhead}
                total={overheadYear}
                pct={pctOf}
              />
            )}
            <TopList title="Beste Objekte (Ergebnis)" list={best.slice(0, 6)} />
            <TopList title="Schwächste Objekte (Ergebnis)" list={best.slice(-6).reverse()} />
          </div>
        </>
      );
    } else if (view === 'objekt') {
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
                      {r.key === 'vj:rest' ? (
                        <span class="mut">{r.name}</span>
                      ) : r.newBusiness ? (
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
          {d.excluded.length > 0 && (
            <div class="card" style="margin-top:16px">
              <h2>Herausgenommene Objekte ({d.excluded.length})</h2>
              <p class="small mut">
                Zählen im Budget nicht (Umsatz und direkte Kosten), z. B. abgeschlossene Baureinigung.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Objekt</th>
                    <th>Grund</th>
                    <th class="r">Umsatz laut Berechnung</th>
                    <th class="r">direkte Kosten</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {d.excluded.map((x) => (
                    <tr>
                      <td>
                        {x.site_no} · {x.name}
                        <div class="small mut">{x.customer_name}</div>
                      </td>
                      <td class="small">{x.reason ?? '–'}</td>
                      <td class="r">{eur0(x.revenue)}</td>
                      <td class="r">{eur0(x.direct)}</td>
                      <td class="r">
                        {draft && edit && (
                          <form
                            method="post"
                            action={`/auswertungen/budget/${year}/objekt/${x.site_id}/ausschluss`}
                          >
                            <input type="hidden" name="aktion" value="aufnehmen" />
                            <input type="hidden" name="zurueck" value={keep()} />
                            <button class="btn ghost sm">Wieder aufnehmen</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                        <td class="r">
                          {euro(a.cost_month)}
                          {a.hours_month > 0 && (
                            <div class="small mut">
                              + {a.hours_month.toLocaleString('de-DE')} Std. × {euro(a.wage_cents)}
                              {a.replace_plan ? ' (statt Plan)' : ''}
                            </div>
                          )}
                        </td>
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
                <AdjustmentForm year={year} back={keep()} customers={customers} rate={hourRate} />
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
          <table data-nosort>
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
      const persons = await budgetPersons(sql, b.id);
      const autoOf = (cat: string) => COST_CATS.find((x) => x.key === cat)?.auto;
      const none = persons.filter((p) => p.category === 'none');
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
                      {(() => {
                        const auto = autoOf(r.category);
                        if (auto !== 'lead' && auto !== 'office' && auto !== 'gf') return null;
                        const ps = persons.filter((p) => p.category === auto);
                        return (
                          <details>
                            <summary class="small">
                              Wer steckt dahinter? ({ps.length} {ps.length === 1 ? 'Person' : 'Personen'})
                            </summary>
                            <PersonTable
                              list={ps}
                              year={year}
                              back={keep()}
                              canChange={draft && edit}
                              manual={r.manual}
                            />
                          </details>
                        );
                      })()}
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
          {none.length > 0 && (
            <details class="card" style="margin-top:14px">
              <summary>Nicht berücksichtigte Personen ({none.length})</summary>
              <PersonTable list={none} year={year} back={keep()} canChange={draft && edit} manual={false} />
            </details>
          )}
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
            <div class="card" style="margin-bottom:14px">
              <div class="stat-head">
                <h3 style="margin:0">Umsatz Ist gegen Plan</h3>
                <span class="legend">
                  <i class="lg-now" /> Ist <i class="lg-prev" /> Plan
                </span>
              </div>
              <StatBars
                prevLabel="Plan"
                rows={lines.map((l) => ({ label: MON[l.i]!, cents: l.iRev, prev: l.sRev }))}
              />
            </div>
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
                    <th class="r">DB Plan</th>
                    <th class="r">DB Ist</th>
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
                    <th class="r">DB Plan</th>
                    <th class="r">DB Ist</th>
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

    const refresh = b.computing || autoStarted ? <meta http-equiv="refresh" content="5" /> : null;
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
              {autoStarted
                ? 'Leistungen, Objekte oder Einsätze haben sich geändert – wird automatisch neu berechnet …'
                : b.computing
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
            <a class="btn sec" href={`/auswertungen/budget/export.pdf?${exportQs}`} target="_blank">
              PDF
            </a>
            <a class="btn sec" href={`/auswertungen/budget/export.xlsx?${exportQs}`}>
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
            <div class="v">
              {eur0(sum.labor + sum.vacation + sum.sick + sum.sub + sum.material + sum.adjCost)}
            </div>
            <div class="s">
              Lohn {eur0(sum.labor)} · Urlaub/Krank {eur0(sum.vacation + sum.sick)} · NU {eur0(sum.sub)} ·
              Material {eur0(sum.material + sum.adjCost)}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Deckungsbeitrag (vor Gemeinkosten)</div>
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
            <div class="v" style={resultAll < 0n ? 'color:var(--c-err)' : ''}>
              {eur0(resultAll)}
            </div>
            <div class="s">
              {pct(resultAll, sum.revenue)} Marge
              {!filtered && investYear > 0n && ` · nach Investitionen ${eur0(resultAll - investYear)}`}
            </div>
          </div>
        </div>
        <details class="card" style="margin-bottom:14px">
          <summary>
            Annahmen: Tariferhöhung {(b.wage_increase_bp / 100).toLocaleString('de-DE')} % ab{' '}
            {MON_LONG[b.wage_increase_month - 1]}
            {b.pass_on ? ', an Kunden weitergegeben' : ', nicht weitergegeben'}
            {b.extra_like_prev ? ', Sonderleistungen wie Vorjahr' : ''} · Urlaub {fmtDays(ab.vacation_days)}{' '}
            Tage (+{bpTxt(ab.vacation_bp)}) · Krank {fmtDays(ab.sick_days)} Tage (+{bpTxt(ab.sick_bp)})
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
                Urlaubstage je Vollzeit-Jahr
                <input
                  name="vacation_days"
                  inputmode="decimal"
                  value={fmtDays(ab.vacation_days)}
                  disabled={!draft || !edit}
                />
              </label>
              <label>
                Kranktage je Vollzeit-Jahr (leer = Durchschnitt)
                <input
                  name="sick_days"
                  inputmode="decimal"
                  value={b.sick_days == null ? '' : fmtDays(Number(b.sick_days))}
                  placeholder={ab.sick_auto == null ? 'kein Wert' : fmtDays(ab.sick_auto)}
                  disabled={!draft || !edit}
                />
                <span class="small mut">
                  {ab.sick_auto == null
                    ? 'Kein Durchschnitt aus den Vorjahren vorhanden – bitte eintragen.'
                    : `Durchschnitt ${fmtDays(ab.sick_auto)} Tage (${ab.basis ?? 'Vorjahr'}, Auswertungen → Ausfallzeiten)`}
                </span>
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
            Lohn = Einsatzplanung {year} wie Lohnarten (Feiertag, Zuschläge, schon eingetragene Abwesenheiten)
            + Arbeitgeberkosten nach Lohnhöhe (Minijob/Midijob/regulär, Sätze unter Plan-Kalkulation). Urlaub
            und Krankheit separat als Zuschlag auf den Lohn: Ausfalltage ÷ Anwesenheitstage ({ab.workdays}{' '}
            Tage Mo–Fr − {ab.holidays} Feiertage − Urlaub − Krank = {fmtDays(ab.present)} Tage).
            Nachunternehmer laut erteilten Bestellungen. Material {''}pauschal in % vom Umsatz. Einsätze, die
            erst später geplant werden, fehlen – dann Lohn über eine Anpassung am Objekt ergänzen.
          </p>
        </details>
        <Tabs tabs={tabs} active={view} />
        {view !== 'kosten' && (
          <form method="get" action="/auswertungen/budget" class="actions" style="margin:8px 0 12px">
            <input type="hidden" name="jahr" value={String(year)} />
            {view !== 'uebersicht' && <input type="hidden" name="ansicht" value={view} />}
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
    const ex = d.excluded.find((x) => x.site_id === c.req.param('key'));
    if (!r && ex)
      return page(
        c,
        `Budget ${year} – ${ex.name}`,
        'auswertungen',
        <>
          <PageHead
            title={`${ex.site_no} · ${ex.name}`}
            crumbs={[
              ['Auswertungen', '/auswertungen'],
              [`Budget ${year}`, base(year)],
            ]}
          />
          <div class="card" style="max-width:720px">
            <p>
              <span class="badge grey">herausgenommen</span> Dieses Objekt zählt im Budget {year} nicht
              {ex.reason ? ` (${ex.reason})` : ''}. Laut Berechnung: Umsatz {eur0(ex.revenue)}, direkte Kosten{' '}
              {eur0(ex.direct)}.
            </p>
            {d.budget.status === 'entwurf' && canEdit(c) && (
              <form method="post" action={`/auswertungen/budget/${year}/objekt/${ex.site_id}/ausschluss`}>
                <input type="hidden" name="aktion" value="aufnehmen" />
                <input
                  type="hidden"
                  name="zurueck"
                  value={`/auswertungen/budget/objekt/${ex.site_id}?jahr=${year}`}
                />
                <button class="btn">Wieder ins Budget aufnehmen</button>
              </form>
            )}
          </div>
        </>,
      );
    if (!r) return c.redirect(base(year));
    const draft = d.budget.status === 'entwurf';
    const edit = canEdit(c);
    const hourRate = await defaultHourRate(sql);
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
      ['Ausfall Urlaub', r.vacation],
      ['Ausfall Krank', r.sick],
      ['Nachunternehmer', r.sub],
      ['Material', r.material],
      ['Anpassung Kosten', r.adjCost],
      ['Deckungsbeitrag (vor Gemeinkosten)', r.db, true],
      ['Gemeinkosten-Anteil', r.overhead],
      ['Ergebnis', r.result, true],
    ];
    const bold = new Set(['Umsatz', 'Deckungsbeitrag (vor Gemeinkosten)', 'Ergebnis']);
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
          {r.site_id && (
            <>
              {' '}
              ·{' '}
              <a
                href={`/auswertungen/plankalkulation/detail?objekt=${r.site_id}&von=${year}-01&bis=${year}-12`}
                target="_blank"
              >
                Kosten und Stunden je Person / Bestellung ansehen
              </a>
            </>
          )}
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
        {r.site_id && draft && edit && (
          <details class="card" style="margin-bottom:14px">
            <summary>Objekt aus dem Budget nehmen (z. B. abgeschlossene Baureinigung)</summary>
            <form method="post" action={`/auswertungen/budget/${year}/objekt/${r.site_id}/ausschluss`}>
              <input type="hidden" name="aktion" value="ausnehmen" />
              <input type="hidden" name="zurueck" value={`${base(year)}&ansicht=objekt`} />
              <div class="grid">
                <label>
                  Grund (optional)
                  <input
                    name="grund"
                    maxlength={300}
                    placeholder="z. B. einmalige Baureinigung, abgeschlossen"
                  />
                </label>
              </div>
              <p class="small mut">
                Umsatz und direkte Kosten dieses Objekts zählen im Budget {year} nicht mehr. Wieder aufnehmen
                unter Budget → Objekte → „Herausgenommene Objekte“.
              </p>
              <button class="btn sec">Aus dem Budget nehmen</button>
            </form>
          </details>
        )}
        <div class="card" style="margin-bottom:14px">
          <div class="stat-head">
            <h3 style="margin:0">Umsatz, Kosten und Ergebnis je Monat</h3>
            <span class="legend">
              <i style="background:#7d1435" /> Lohn <i style="background:#b35a7a" /> Urlaub/Krank{' '}
              <i style="background:#c2185b" /> Nachunternehmer <i style="background:#e07a5f" /> Material{' '}
              <i style="background:#98c1d9" /> Gemeinkosten <i style="background:#2e7d4f" /> Ergebnis
            </span>
          </div>
          <StackBars
            months={M12.map((i) => ({
              label: MON[i]!,
              revenue: r.revenue[i]!,
              prev: r.prev[i]!,
              labor: r.labor[i]!,
              absence: r.vacation[i]! + r.sick[i]!,
              sub: r.sub[i]!,
              material: r.material[i]! + r.adjCost[i]!,
              overhead: r.overhead[i]!,
              result: r.result[i]!,
            }))}
          />
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
                    <td class="r">
                      {euro(x.cost_month)}
                      {x.hours_month > 0 && (
                        <div class="small mut">
                          + {x.hours_month.toLocaleString('de-DE')} Std. × {euro(x.wage_cents)}
                          {x.replace_plan ? ' (statt Plan)' : ''}
                        </div>
                      )}
                    </td>
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
            <AdjustmentForm year={year} back={back2} siteId={r.site_id!} rate={hourRate} />
          ) : (
            !draft && <p class="small mut">Budget ist freigegeben – Änderungen erst nach „Wieder öffnen“.</p>
          )}
        </div>
      </>,
    );
  });

  // ---------------------------------------------------------------- Excel
  /** Export-Daten mit denselben Filtern wie die Seite */
  const exportData = async (c: Context<AppEnv>) => {
    const year = yearOf(c.req.query('jahr'));
    const d = await budgetData(sql, year);
    if (!d) return null;
    const q = {
      kunde: c.req.query('kunde') ?? '',
      objekt: c.req.query('objekt') ?? '',
      ol: c.req.query('ol') ?? '',
      verlust: c.req.query('verlust') === '1',
    };
    const rows = filterRows(d, q);
    const filtered = !!(q.kunde || q.objekt || q.ol || q.verlust);
    const ch = chartData(d, rows, filtered);
    const byCust = new Map<string, BudgetRow[]>();
    for (const r of rows) {
      const k = r.customer_id ?? `neu:${r.key}`;
      byCust.set(k, [...(byCust.get(k) ?? []), r]);
    }
    const custs = [...byCust.values()]
      .map((rs) => ({ rs, a: agg(rs) }))
      .sort((x, y) => (y.a.revenue > x.a.revenue ? 1 : y.a.revenue < x.a.revenue ? -1 : 0));
    let filterText = '';
    if (filtered) {
      const parts: string[] = [];
      if (q.kunde)
        parts.push(`Kunde: ${d.rows.find((r) => r.customer_id === q.kunde)?.customer_name ?? '–'}`);
      if (q.objekt) parts.push(`Objekt: ${d.rows.find((r) => r.key === q.objekt)?.name ?? '–'}`);
      if (q.ol) parts.push(q.ol === 'ohne' ? 'ohne Objektleitung' : 'Objektleitung gewählt');
      if (q.verlust) parts.push('nur Verlust');
      filterText = parts.join(' · ');
    }
    return { year, d, rows, filtered, ch, custs, filterText };
  };

  // ---------------------------------------------------------------- Excel
  app.get('/auswertungen/budget/export.xlsx', async (c) => {
    const x = await exportData(c);
    if (!x) return c.redirect(base(yearOf(c.req.query('jahr'))));
    const { year, d, rows, ch, custs, filterText } = x;
    const n = (v: bigint): XlsxCell => ({ n: Number(v) / 100, fmt: 'eur' });
    const hrs = (min: number): XlsxCell => ({ n: Math.round(min / 60), fmt: 'int' });
    const pc = (v: bigint, of: bigint): XlsxCell =>
      of === 0n ? '' : { n: Number((v * 10000n) / of) / 10000, fmt: 'pct' };
    const amountRow = (a: Agg) => [
      n(a.revenue),
      n(a.prev),
      hrs(a.minutes),
      n(a.labor),
      n(a.vacation + a.sick),
      n(a.sub),
      n(a.material + a.adjCost),
      n(a.db),
      n(a.overhead),
      n(a.result),
      pc(a.result, a.revenue),
    ];
    const amountHead = [
      'Umsatz',
      'Vorjahr Ist',
      'Stunden',
      'Lohn inkl. AG',
      'Urlaub/Krank',
      'Nachunternehmer',
      'Material/Sonst.',
      'DB vor Gemeinkosten',
      'Gemeinkosten',
      'Ergebnis',
      'Marge',
    ];
    const all = agg(rows);
    const title = [
      `Budget ${year} (${d.budget.status === 'freigegeben' ? 'freigegeben' : 'Entwurf'})`,
      ...(filterText ? [`Filter: ${filterText}`] : []),
    ];
    const sheets = [
      {
        name: 'Monate',
        title,
        header: [
          'Monat',
          'Umsatz',
          'Vorjahr Ist',
          'Lohn',
          'Urlaub/Krank',
          'Nachunternehmer',
          'Material/Sonst.',
          'DB vor Gemeinkosten',
          'Gemeinkosten',
          'Ergebnis',
          'Marge',
        ],
        rows: ch.months.map((m, i) => [
          MON_LONG[i]!,
          n(m.revenue),
          n(m.prev),
          n(m.labor),
          n(m.absence),
          n(m.sub),
          n(m.material),
          n(m.revenue - m.labor - m.absence - m.sub - m.material),
          n(m.overhead),
          n(m.result),
          pc(m.result, m.revenue),
        ]),
        footer: [
          [
            'Jahr',
            n(ch.months.reduce((a, m) => a + m.revenue, 0n)),
            n(ch.months.reduce((a, m) => a + m.prev, 0n)),
            n(ch.months.reduce((a, m) => a + m.labor, 0n)),
            n(ch.months.reduce((a, m) => a + m.absence, 0n)),
            n(ch.months.reduce((a, m) => a + m.sub, 0n)),
            n(ch.months.reduce((a, m) => a + m.material, 0n)),
            n(ch.months.reduce((a, m) => a + m.revenue - m.labor - m.absence - m.sub - m.material, 0n)),
            n(ch.months.reduce((a, m) => a + m.overhead, 0n)),
            n(ch.months.reduce((a, m) => a + m.result, 0n)),
            pc(
              ch.months.reduce((a, m) => a + m.result, 0n),
              ch.months.reduce((a, m) => a + m.revenue, 0n),
            ),
          ],
        ],
        widths: [14, 14, 14, 14, 14, 14, 16, 14, 14, 9],
      },
      {
        name: 'Kunden',
        title,
        header: ['Kunde', 'Objekte', ...amountHead],
        rows: custs.map(({ rs, a }) => [
          rs[0]!.customer_id
            ? `${rs[0]!.customer_no ? `${rs[0]!.customer_no} · ` : ''}${rs[0]!.customer_name}`
            : 'Neugeschäft',
          { n: rs.length, fmt: 'int' } as XlsxCell,
          ...amountRow(a),
        ]),
        footer: [['Gesamt', { n: rows.length, fmt: 'int' } as XlsxCell, ...amountRow(all)]],
        widths: [36, 8, 14, 14, 9, 14, 14, 14, 14, 14, 14, 9],
      },
      {
        name: 'Objekte',
        title,
        header: [
          'Nr.',
          'Objekt',
          'Kunde',
          ...amountHead,
          'davon laufend/Turnus',
          'Sonder wie Vorjahr',
          'Erhöhung/Anpassung',
        ],
        rows: rows.map((r) => {
          const a = agg([r]);
          return [
            r.newBusiness ? 'NEU' : r.site_no,
            r.name,
            r.customer_name,
            ...amountRow(a),
            n(a.regular),
            n(a.extra),
            n(a.increase + a.adj),
          ];
        }),
        footer: [
          ['Gesamt', '', '', ...amountRow(all), n(all.regular), n(all.extra), n(all.increase + all.adj)],
        ],
        widths: [10, 34, 28, 14, 14, 9, 14, 14, 14, 14, 14, 14, 9, 14, 14, 14],
      },
      {
        name: 'Objekte je Monat',
        title,
        header: ['Nr.', 'Objekt', 'Kunde', 'Wert', ...MON, 'Jahr'],
        rows: rows.flatMap((r) =>
          (
            [
              ['Umsatz', r.revenue],
              ['Direkte Kosten', r.direct],
              ['DB vor Gemeinkosten', r.db],
              ['Ergebnis', r.result],
            ] as const
          ).map(([l, v]) => [
            r.newBusiness ? 'NEU' : r.site_no,
            r.name,
            r.customer_name,
            l,
            ...v.map(n),
            n(total(v)),
          ]),
        ),
        widths: [10, 30, 24, 14, ...M12.map(() => 11), 13],
      },
      {
        name: 'Gemeinkosten',
        title: [`Budget ${year} – Gemeinkosten (gesamt, ohne Filter)`],
        header: ['Kostenart', ...MON, 'Jahr', 'Herkunft'],
        rows: d.costs.map((r) => [r.label, ...r.amounts.map(n), n(total(r.amounts)), r.source ?? '']),
        footer: [
          ['Gemeinkosten (verteilt)', ...d.overhead.map(n), n(total(d.overhead)), ''],
          ['Investitionen (nicht verteilt)', ...d.invest.map(n), n(total(d.invest)), ''],
        ],
        widths: [40, ...M12.map(() => 11), 14, 40],
      },
    ];
    return xlsxFile(c, writeXlsx(sheets), `Budget_${year}${filterText ? '_Auswahl' : ''}.xlsx`);
  });

  // ---------------------------------------------------------------- PDF (Übersicht mit Diagrammen + Tabellen)
  app.get('/auswertungen/budget/export.pdf', async (c) => {
    const x = await exportData(c);
    if (!x) return c.redirect(base(yearOf(c.req.query('jahr'))));
    const { year, d, rows, filtered, ch, custs, filterText } = x;
    const all = agg(rows);
    const overheadSum = ch.months.reduce((a, m) => a + m.overhead, 0n);
    const result = ch.months.reduce((a, m) => a + m.result, 0n);
    const invest = total(d.invest);
    const status = d.budget.status === 'freigegeben' ? 'freigegeben' : 'Entwurf';
    const subtitle = [
      `Stand ${status}`,
      d.budget.computed_at
        ? `berechnet ${new Date(d.budget.computed_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}`
        : '',
      `Tariferhöhung ${(d.budget.wage_increase_bp / 100).toLocaleString('de-DE')} % ab ${MON_LONG[d.budget.wage_increase_month - 1]}`,
      filterText && `Filter: ${filterText}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const overview = await budgetOverviewPdf({
      title: `Budgetplanung ${year}`,
      subtitle,
      kpis: [
        {
          label: `Umsatz ${year}`,
          value: eur0(all.revenue),
          sub: `Vorjahr ${eur0(all.prev)}${all.prev > 0n ? ` (${pct(all.revenue - all.prev, all.prev)})` : ''}`,
        },
        {
          label: 'Direkte Kosten',
          value: eur0(all.labor + all.vacation + all.sick + all.sub + all.material + all.adjCost),
          sub: `Lohn ${eur0(all.labor)} · Urlaub/Krank ${eur0(all.vacation + all.sick)} · NU ${eur0(all.sub)}`,
        },
        {
          label: 'Deckungsbeitrag (vor GK)',
          value: eur0(all.db),
          sub: `${pct(all.db, all.revenue)} vom Umsatz`,
          neg: all.db < 0n,
        },
        {
          label: filtered ? 'Gemeinkosten (Anteil)' : 'Gemeinkosten',
          value: eur0(overheadSum),
          sub: `${pct(overheadSum, all.revenue)} vom Umsatz`,
        },
        {
          label: 'Ergebnis',
          value: eur0(result),
          sub: `${pct(result, all.revenue)} Marge${!filtered && invest > 0n ? ` · nach Invest. ${eur0(result - invest)}` : ''}`,
          neg: result < 0n,
        },
      ],
      months: ch.months.map((m) => ({
        label: m.label,
        revenue: m.revenue,
        prev: m.prev,
        costs: m.labor + m.absence + m.sub + m.material + m.overhead,
        result: m.result,
      })),
      structure: ch.structure.map((s) => ({
        label: s.label,
        cents: s.cents,
        color: s.label.startsWith('Lohn')
          ? '#7d1435'
          : s.label === 'Nachunternehmer'
            ? '#c2185b'
            : s.label === 'Material'
              ? '#e07a5f'
              : s.label === 'Gemeinkosten'
                ? '#98c1d9'
                : '#2e7d4f',
      })),
      customers: ch.customers,
      overhead: filtered ? [] : ch.overhead,
    });
    const cols = [
      { label: 'Bezeichnung', width: 190, wrap: true },
      { label: 'Umsatz', width: 70, align: 'right' as const },
      { label: 'Vorjahr', width: 64, align: 'right' as const },
      { label: 'Lohn inkl. AG', width: 66, align: 'right' as const },
      { label: 'Urlaub/Krank', width: 60, align: 'right' as const },
      { label: 'NU', width: 58, align: 'right' as const },
      { label: 'Material', width: 56, align: 'right' as const },
      { label: 'DB vor GK', width: 66, align: 'right' as const },
      { label: 'Gemeinkosten', width: 66, align: 'right' as const },
      { label: 'Ergebnis', width: 66, align: 'right' as const },
      { label: 'Marge', width: 44, align: 'right' as const },
    ];
    const red: [number, number, number] = [0.7, 0.15, 0.12];
    const cells = (label: string, a: Agg, bold = false): PdfRow => [
      bold ? { text: label, bold: true } : label,
      bold ? { text: eur0(a.revenue), bold: true } : eur0(a.revenue),
      a.prev ? eur0(a.prev) : '–',
      eur0(a.labor),
      eur0(a.vacation + a.sick),
      eur0(a.sub),
      eur0(a.material + a.adjCost),
      a.db < 0n ? { text: eur0(a.db), color: red } : eur0(a.db),
      eur0(a.overhead),
      { text: eur0(a.result), bold: true, ...(a.result < 0n ? { color: red } : {}) },
      a.result < 0n ? { text: pct(a.result, a.revenue), color: red } : pct(a.result, a.revenue),
    ];
    const monthAgg = (i: number): Agg => {
      const a = agg(rows, [i]);
      const m = ch.months[i]!;
      return { ...a, overhead: m.overhead, result: m.result };
    };
    const tableRows: PdfRow[] = [
      { section: 'Monate' },
      ...M12.map((i) => cells(MON_LONG[i]!, monthAgg(i))),
      cells('Jahr', { ...all, overhead: overheadSum, result }, true),
      { section: 'Kunden' },
      ...custs.map(({ rs, a }) =>
        cells(
          rs[0]!.customer_id
            ? `${rs[0]!.customer_no ? `${rs[0]!.customer_no} · ` : ''}${rs[0]!.customer_name} (${rs.length} ${rs.length === 1 ? 'Objekt' : 'Objekte'})`
            : `Neugeschäft: ${rs[0]!.name}`,
          a,
        ),
      ),
      { section: 'Objekte' },
      ...rows.map((r) =>
        cells(
          r.newBusiness ? `Neugeschäft: ${r.name}` : `${r.site_no} · ${r.name} – ${r.customer_name}`,
          agg([r]),
        ),
      ),
    ];
    const main = await renderTablePdf({
      title: `Budgetplanung ${year} – Monate, Kunden, Objekte`,
      subtitle,
      columns: cols,
      rows: tableRows,
      fontSize: 7.5,
      footnote:
        'Planwerte netto. Umsatz aus den Leistungen (monatlich, Turnus, einmalig), Sonderleistungen wie Vorjahr, Preiserhöhung über den Lohnanteil; Lohn laut Einsatzplanung inkl. Arbeitgeberkosten; Gemeinkosten nach Umsatz verteilt.',
    });
    const parts = [overview, main];
    if (!filtered) {
      const costs = await renderTablePdf({
        title: `Budgetplanung ${year} – Gemeinkosten`,
        subtitle,
        columns: [
          { label: 'Kostenart', width: 200, wrap: true },
          ...MON.map((m) => ({ label: m, width: 40, align: 'right' as const })),
          { label: 'Jahr', width: 58, align: 'right' as const },
        ],
        rows: d.costs.map((r) => [
          r.label,
          ...r.amounts.map((v) => num0(v)),
          { text: num0(total(r.amounts)), bold: true },
        ]),
        totals: ['Gemeinkosten (verteilt)', ...d.overhead.map((v) => num0(v)), num0(total(d.overhead))],
        fontSize: 7,
        footnote: 'Beträge in €. Investitionen sind nicht in den Gemeinkosten und werden nicht verteilt.',
      });
      parts.push(costs);
    }
    const pdf = await mergePdfs(parts);
    return c.body(pdf as unknown as ArrayBuffer, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Budget_${year}${filterText ? '_Auswahl' : ''}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
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

  app.post('/auswertungen/budget/:year/person/:emp', async (c) => {
    const year = yearOf(c.req.param('year'));
    const body = await c.req.parseBody();
    const to = backTo(body, year);
    try {
      guard(c);
      await setPersonCategory(
        sql,
        await budgetIdOf(year),
        c.req.param('emp'),
        String(body['kategorie'] ?? ''),
        c.get('actor'),
      );
      return back(c, to, { ok: 'Zuordnung geändert' });
    } catch (e) {
      return back(c, to, { fehler: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/auswertungen/budget/:year/objekt/:site/ausschluss', async (c) => {
    const year = yearOf(c.req.param('year'));
    const body = await c.req.parseBody();
    const to = backTo(body, year);
    try {
      guard(c);
      const ex = body['aktion'] !== 'aufnehmen';
      await setSiteExcluded(
        sql,
        await budgetIdOf(year),
        c.req.param('site'),
        ex,
        String(body['grund'] ?? '') || null,
        c.get('actor'),
      );
      return back(c, to, { ok: ex ? 'Objekt aus dem Budget genommen' : 'Objekt wieder im Budget' });
    } catch (e) {
      return back(c, to, { fehler: e instanceof Error ? e.message : String(e) });
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
      const dayIn = (v: unknown, what: string) => {
        const t = String(v ?? '')
          .replace(',', '.')
          .trim();
        if (!t) return null;
        const n = Number(t);
        if (!Number.isFinite(n)) throw new BusinessError(`${what}: bitte Zahl`);
        return Math.round(n * 10) / 10;
      };
      const vac = dayIn(b.vacation_days, 'Urlaubstage');
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
          vacation_days: vac ?? 30,
          sick_days: dayIn(b.sick_days, 'Kranktage'),
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
      const hTxt = String(b.hours ?? '')
        .replace(',', '.')
        .trim();
      const hoursIn = hTxt ? Math.round(Number(hTxt) * 100) / 100 : 0;
      if (!Number.isFinite(hoursIn)) throw new BusinessError('Stunden je Monat: bitte Zahl');
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
          hours_month: hoursIn,
          wage_cents: hoursIn > 0 ? moneyIn(b.wage) : 0n,
          replace_plan: b.replace_plan === '1',
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
  rate,
}: {
  year: number;
  back: string;
  siteId?: string;
  customers?: [string, string][];
  /** Vorschlag Stundensatz inkl. AG-Kosten (Cent) */
  rate: bigint;
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
        Stunden je Monat (eigene Leute)
        <input name="hours" inputmode="decimal" placeholder="z. B. 86,5" />
        <span class="small mut">
          für neue Objekte ohne Einsatzplanung – zählt als Lohn, dazu Urlaub/Krank
        </span>
      </label>
      <label>
        Stundensatz € inkl. AG-Kosten
        <input
          name="wage"
          inputmode="decimal"
          value={rate > 0n ? (Number(rate) / 100).toFixed(2).replace('.', ',') : ''}
        />
        <span class="small mut">Vorschlag: niedrigster Tariflohn + Arbeitgeberkosten</span>
      </label>
      {siteId && (
        <label class="chk">
          <input type="checkbox" name="replace_plan" value="1" /> Stunden ersetzen die Einsatzplanung in
          diesen Monaten (sonst zusätzlich)
        </label>
      )}
      <label>
        Sonstige Kosten je Monat € (NU, Material)
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
