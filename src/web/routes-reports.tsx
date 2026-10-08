import type { Context } from 'hono';
import { SiteOptions } from './site-options.js';
import type { Child } from 'hono/jsx';
import { monthLabelDe, todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { planningGroups } from '../services/employees.js';
import {
  dutyList,
  hourlyRates,
  hoursControl,
  leaveAccounts,
  nextMonth,
  revenueForecast,
  sickDays,
  toCsv,
} from '../services/reports.js';
import { hm, WEEKDAYS_SHORT } from '../services/time.js';
import { type StatBasis, type StatGroup, revenueStats, statKpis } from '../services/statistics.js';
import type { AppEnv, Ctx } from './app.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';
import { canOpen } from './permissions.js';

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monShort = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const isMonth = (m: string | undefined): m is string => !!m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const isDate = (d: string | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const yearOf = (q: string | undefined) => {
  const y = Number(q);
  const now = Number(todayBerlin().slice(0, 4));
  return Number.isInteger(y) && y >= 2000 && y <= now + 1 ? y : now;
};
const daysDe = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
const csvResponse = (c: Context<AppEnv>, name: string, body: string) =>
  c.body(body, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });

export const REPORTS: (Tab & { text: string })[] = [
  {
    key: 'statistik',
    label: 'Statistiken',
    href: '/auswertungen/statistik',
    text: 'Umsatz je Monat/Quartal/Jahr, pro Kunde und nach Leistungsart (wie Fortytools)',
  },
  {
    key: 'vorschau',
    label: 'Umsatz-Vorschau',
    href: '/auswertungen/vorschau',
    text: 'Erwarteter Umsatz aus den regelmäßigen Leistungen',
  },
  {
    key: 'kostenstellen',
    label: 'Kostenstellen',
    href: '/auswertungen/kostenstellen',
    text: 'Eingangsrechnungen (auch Nachunternehmer) je Kostenstelle und Kostenart',
  },
  {
    key: 'nachkalkulation',
    label: 'Nachkalkulation',
    href: '/auswertungen/nachkalkulation',
    text: 'Deckungsbeitrag je Objekt und Monat',
  },
  {
    key: 'stundensaetze',
    label: 'Ø Stundensätze',
    href: '/auswertungen/stundensaetze',
    text: 'Erlös je Ist-/Plan-Stunde und Ø Lohn je Objekt',
  },
  {
    key: 'stunden',
    label: 'Stundenkontrolle',
    href: '/auswertungen/stunden',
    text: 'Soll / Plan / Ist aller Mitarbeitenden',
  },
  {
    key: 'urlaub',
    label: 'Urlaubskonten',
    href: '/auswertungen/urlaub',
    text: 'Anspruch, Übertrag, genommen, Rest',
  },
  {
    key: 'krankheit',
    label: 'Krankheitstage',
    href: '/auswertungen/krankheit',
    text: 'Arbeitstage krank je Monat',
  },
  {
    key: 'dienste',
    label: 'Dienste-Liste',
    href: '/auswertungen/dienste',
    text: 'Alle Einsätze eines Zeitraums, zum Drucken/Export',
  },
];

/** Reiter aller Auswertungen, die die Rolle öffnen darf. */
export const ReportTabs = ({ c, active }: { c: Context<AppEnv>; active: string }) => (
  <Tabs tabs={REPORTS.filter((r) => canOpen(c.get('user').role, r.href))} active={active} />
);

export function registerReportRoutes({ app, deps, page }: Ctx) {
  const { sql } = deps;

  const shell = (c: Context<AppEnv>, active: string, title: string, body: Child, actions?: Child) => {
    void active; // Auswertungen stehen links im Menü (keine doppelte Reiterzeile)
    return page(
      c,
      title,
      'auswertungen',
      <>
        <PageHead title={title} crumbs={[['Auswertungen', '/auswertungen']]}>
          {actions}
        </PageHead>
        {body}
      </>,
    );
  };

  app.get('/auswertungen', (c) => {
    const role = c.get('user').role;
    return page(
      c,
      'Auswertungen',
      'auswertungen',
      <>
        <PageHead title="Auswertungen" />
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
          {REPORTS.filter((r) => canOpen(role, r.href)).map((r) => (
            <a class="card" href={r.href} style="text-decoration:none;color:var(--ink)">
              <b>{r.label}</b>
              <div class="small mut">{r.text}</div>
            </a>
          ))}
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Statistiken (wie Fortytools, eine Seite)
  app.get('/auswertungen/statistik', async (c) => {
    const q = (k: string) => c.req.query(k);
    const today = todayBerlin();
    const d0 = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    d0.setUTCMonth(d0.getUTCMonth() - 11);
    const d1 = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    d1.setUTCMonth(d1.getUTCMonth() + 1, 0);
    const preset = q('zeitraum');
    const y = Number(today.slice(0, 4));
    let from = isDate(q('von')) ? q('von')! : d0.toISOString().slice(0, 10);
    let to = isDate(q('bis')) ? q('bis')! : d1.toISOString().slice(0, 10);
    if (preset === 'jahr') [from, to] = [`${y}-01-01`, `${y}-12-31`];
    if (preset === 'vorjahr') [from, to] = [`${y - 1}-01-01`, `${y - 1}-12-31`];
    if (to < from) to = from;
    const basis: StatBasis = q('grundlage') === 'rechnung' ? 'rechnung' : 'leistung';
    const group: StatGroup =
      q('gruppe') === 'quartal' ? 'quartal' : q('gruppe') === 'jahr' ? 'jahr' : 'monat';
    const customerId = /^[0-9a-f-]{36}$/.test(q('kunde') ?? '') ? q('kunde')! : null;
    const shiftY = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace('-02-29', '-02-28');
    const [st, prev, kpi, customers] = await Promise.all([
      revenueStats(sql, { from, to, basis, group, customerId }),
      revenueStats(sql, { from: shiftY(from), to: shiftY(to), basis, group, customerId }),
      statKpis(sql, { from, to, customerId }),
      sql<{ id: string; customer_no: string; name: string }[]>`
        select id, customer_no, name from app.customers where not is_internal order by name`,
    ]);
    const prevBy = new Map(
      prev.periods.map((p) => [`${Number(p.key.slice(0, 4)) + 1}${p.key.slice(4)}`, p.cents]),
    );
    const label = (k: string) =>
      group === 'monat'
        ? `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`
        : group === 'quartal'
          ? `${k.slice(5)} ${k.slice(0, 4)}`
          : k;
    const pct = (v: bigint, of: bigint) =>
      of === 0n
        ? '–'
        : `${(Number((v * 10000n) / of) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 })} %`;
    const delta = (now: bigint, before: bigint | undefined) => {
      if (!before || before <= 0n) return null;
      return Number(((now - before) * 1000n) / before) / 10;
    };
    const totalDelta = delta(st.total, prev.total);
    const qs = new URLSearchParams({
      von: from,
      bis: to,
      grundlage: basis,
      gruppe: group,
      ...(customerId ? { kunde: customerId } : {}),
    });
    const presetHref = (p: string) => {
      const u = new URLSearchParams(qs);
      u.delete('von');
      u.delete('bis');
      if (p) u.set('zeitraum', p);
      return `/auswertungen/statistik?${u}`;
    };
    return shell(
      c,
      'statistik',
      'Statistiken',
      <>
        <form method="get" action="/auswertungen/statistik" class="card stat-filter">
          <div>
            <label for="von">von</label>
            <input type="date" id="von" name="von" value={from} />
          </div>
          <div>
            <label for="bis">bis</label>
            <input type="date" id="bis" name="bis" value={to} />
          </div>
          <div>
            <label for="kunde">Kunde</label>
            <select id="kunde" name="kunde">
              <option value="">Alle Kunden</option>
              {customers.map((k) => (
                <option value={k.id} selected={k.id === customerId}>
                  {k.name} ({k.customer_no})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="gruppe">Gruppieren</label>
            <select id="gruppe" name="gruppe">
              <option value="monat" selected={group === 'monat'}>
                Monat
              </option>
              <option value="quartal" selected={group === 'quartal'}>
                Quartal
              </option>
              <option value="jahr" selected={group === 'jahr'}>
                Jahr
              </option>
            </select>
          </div>
          <div>
            <label for="grundlage">Grundlage</label>
            <select id="grundlage" name="grundlage">
              <option value="leistung" selected={basis === 'leistung'}>
                Leistungszeitraum
              </option>
              <option value="rechnung" selected={basis === 'rechnung'}>
                Rechnungsdatum
              </option>
            </select>
          </div>
          <div style="align-self:end">
            <button class="btn">Aktualisieren</button>
          </div>
          <div class="stat-presets">
            <a href={presetHref('')}>Letzte 12 Monate</a>
            <a href={presetHref('jahr')}>{y}</a>
            <a href={presetHref('vorjahr')}>{y - 1}</a>
          </div>
        </form>

        <div class="stat-kpis">
          <div class="skpi c1">
            <div class="l">Umsatz netto</div>
            <div class="v">{euro(st.total)}</div>
            <div class="s">
              {totalDelta == null ? (
                'Vorjahr: –'
              ) : (
                <span class={totalDelta >= 0 ? 'up' : 'down'}>
                  {totalDelta >= 0 ? '▲' : '▼'} {Math.abs(totalDelta).toLocaleString('de-DE')} % zum Vorjahr
                </span>
              )}
            </div>
          </div>
          <div class="skpi c2">
            <div class="l">Rechnungen</div>
            <div class="v">{kpi.invoices.toLocaleString('de-DE')}</div>
            <div class="s">
              {kpi.reversals} Storno/Korrektur · {kpi.customers} Kunden
            </div>
          </div>
          <div class="skpi c3">
            <div class="l">Ø Rechnungsbetrag</div>
            <div class="v">{euro(kpi.avg_invoice_cents)}</div>
            <div class="s">netto je Rechnung</div>
          </div>
          <div class="skpi c4">
            <div class="l">Ø Zahlungsdauer</div>
            <div class="v">{kpi.avg_days == null ? '–' : `${kpi.avg_days} Tage`}</div>
            <div class="s">
              {kpi.paid} bezahlt, davon {kpi.late} nach Fälligkeit
            </div>
          </div>
          <div class="skpi c5">
            <div class="l">Offen heute</div>
            <div class="v">{euro(kpi.open_cents)}</div>
            <div class="s">
              davon überfällig <b>{euro(kpi.overdue_cents)}</b>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="stat-head">
            <h3 style="margin:0">
              Umsatz je {group === 'monat' ? 'Monat' : group === 'quartal' ? 'Quartal' : 'Jahr'}
            </h3>
            <span class="legend">
              <i class="lg-now" /> Zeitraum <i class="lg-prev" /> Vorjahr
            </span>
          </div>
          <StatBars
            rows={st.periods.map((p) => ({
              label: label(p.key),
              cents: p.cents,
              prev: prevBy.get(p.key) ?? 0n,
            }))}
          />
          <div class="tbl" style="margin-top:10px">
            <table>
              <thead>
                <tr>
                  <th>{group === 'monat' ? 'Monat' : group === 'quartal' ? 'Quartal' : 'Jahr'}</th>
                  <th class="r">Netto</th>
                  <th class="r">Vorjahr</th>
                  <th class="r">Veränderung</th>
                </tr>
              </thead>
              <tbody>
                {st.periods.map((p) => {
                  const pv = prevBy.get(p.key);
                  const dv = delta(p.cents, pv);
                  return (
                    <tr>
                      <td>{label(p.key)}</td>
                      <td class="r num">{euro(p.cents)}</td>
                      <td class="r num mut">{pv ? euro(pv) : '–'}</td>
                      <td class={`r num ${dv == null ? 'mut' : dv >= 0 ? 'up' : 'down'}`}>
                        {dv == null ? '–' : `${dv >= 0 ? '+' : ''}${dv.toLocaleString('de-DE')} %`}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td>
                    <b>Summe</b>
                  </td>
                  <td class="r num">
                    <b>{euro(st.total)}</b>
                  </td>
                  <td class="r num mut">{euro(prev.total)}</td>
                  <td class={`r num ${totalDelta == null ? 'mut' : totalDelta >= 0 ? 'up' : 'down'}`}>
                    {totalDelta == null
                      ? '–'
                      : `${totalDelta >= 0 ? '+' : ''}${totalDelta.toLocaleString('de-DE')} %`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Netto, alle ausgestellten Rechnungen (auch aus Fortytools), Stornos und Korrekturen abgezogen.
            {basis === 'leistung'
              ? ' Nach Leistungszeitraum: Beträge über mehrere Monate werden tageweise verteilt.'
              : ' Nach Rechnungsdatum.'}{' '}
            <a href={`/auswertungen/statistik.csv?${qs}`}>CSV herunterladen</a>
          </p>
        </div>
        <div class="cols">
          <ShareCard
            title="Umsatz pro Kunde"
            rows={st.customers.map((k) => ({
              label: k.name,
              href: k.id ? `/kunden/${k.id}` : null,
              cents: k.cents,
            }))}
            total={st.shareTotal}
            pct={pct}
          />
          <ShareCard
            title="Umsatz nach Leistungsart"
            rows={st.types.map((t) => ({ label: t.name, href: null, cents: t.cents }))}
            total={st.shareTotal}
            pct={pct}
          />
        </div>
        <p class="small mut">
          „Pro Kunde“ und „nach Leistungsart“ rechnen nach Rechnungsdatum (wie Fortytools). Kennzahlen
          „Rechnungen“ und „Zahlungsdauer“ nach Rechnungsdatum im Zeitraum; „Offen heute“ ist der aktuelle
          Stand.
        </p>
      </>,
    );
  });

  app.get('/auswertungen/statistik.csv', async (c) => {
    const q = (k: string) => c.req.query(k);
    const today = todayBerlin();
    const from = isDate(q('von')) ? q('von')! : `${today.slice(0, 4)}-01-01`;
    const to = isDate(q('bis')) && q('bis')! >= from ? q('bis')! : today;
    const basis: StatBasis = q('grundlage') === 'rechnung' ? 'rechnung' : 'leistung';
    const group: StatGroup =
      q('gruppe') === 'quartal' ? 'quartal' : q('gruppe') === 'jahr' ? 'jahr' : 'monat';
    const customerId = /^[0-9a-f-]{36}$/.test(q('kunde') ?? '') ? q('kunde')! : null;
    const st = await revenueStats(sql, { from, to, basis, group, customerId });
    const e = (v: bigint) => (Number(v) / 100).toFixed(2).replace('.', ',');
    const lines: string[][] = [
      ...st.periods.map((p) => [p.key, e(p.cents)]),
      ['Summe', e(st.total)],
      [],
      ['Kunde', 'Netto (nach Rechnungsdatum)'],
      ...st.customers.map((k) => [k.name, e(k.cents)]),
      [],
      ['Leistungsart', 'Netto (nach Rechnungsdatum)'],
      ...st.types.map((t) => [t.name, e(t.cents)]),
    ];
    return csvResponse(c, `statistik_${from}_${to}.csv`, toCsv(['Zeitraum', 'Netto'], lines));
  });

  // Rechnungs-Statistik ist in den Statistiken aufgegangen (Ahmed: nur eine Statistik)
  app.get('/auswertungen/rechnungen', (c) => c.redirect('/auswertungen/statistik', 301));

  // ------------------------------------------------------------------ Umsatz-Vorschau
  app.get('/auswertungen/vorschau', async (c) => {
    const q = c.req.query('ab');
    const from = isMonth(q) ? q : todayBerlin().slice(0, 7);
    const f = await revenueForecast(sql, from, 12);
    return shell(
      c,
      'vorschau',
      'Umsatz-Vorschau',
      <>
        <form method="get" class="actions" style="margin-top:0">
          <label for="ab" style="margin:0">
            ab
          </label>
          <input
            id="ab"
            type="month"
            name="ab"
            value={from}
            style="max-width:180px"
            onchange="this.form.submit()"
          />
          <span class="small mut">
            12 Monate: <b>{euro(f.total)}</b> netto
          </span>
        </form>
        <div class="card">
          <div class="tbl">
            <table class="small">
              <thead>
                <tr>
                  <th>Kunde</th>
                  {f.months.map((m) => (
                    <th class="r">{monShort(m)}</th>
                  ))}
                  <th class="r">Summe</th>
                </tr>
              </thead>
              <tbody>
                {f.rows.map((r) => (
                  <tr>
                    <td>
                      <a href={`/kunden/${r.customer_id}`}>{r.customer_name}</a>
                    </td>
                    {r.months.map((v) => (
                      <td class="r">{v ? euro(v) : ''}</td>
                    ))}
                    <td class="r">
                      <b>{euro(r.total)}</b>
                    </td>
                  </tr>
                ))}
                <tr style="font-weight:600;background:#f7f7f9">
                  <td>Summe</td>
                  {f.totals.map((v) => (
                    <td class="r">{euro(v)}</td>
                  ))}
                  <td class="r">{euro(f.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Aus den aktiven regelmäßigen Leistungen (Pauschalen) mit Abrechnungszyklus und Gültigkeit – so,
            wie der Abrechnungslauf sie berechnen würde. Regiestunden, Sonderleistungen und Preisänderungen
            ohne hinterlegte Leistung sind nicht enthalten.
          </p>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Ø Stundensätze
  app.get('/auswertungen/stundensaetze', async (c) => {
    const to = isMonth(c.req.query('bis')) ? c.req.query('bis')! : nextMonth(todayBerlin().slice(0, 7), -1);
    const from =
      isMonth(c.req.query('von')) && c.req.query('von')! <= to ? c.req.query('von')! : nextMonth(to, -2);
    const rows = await hourlyRates(sql, from, to);
    const tot = rows.reduce(
      (a, r) => ({ rev: a.rev + r.revenue, min: a.min + r.minutes, plan: a.plan + r.plan_minutes }),
      { rev: 0n, min: 0, plan: 0 },
    );
    return shell(
      c,
      'stundensaetze',
      'Ø Stundensätze je Objekt',
      <>
        <form method="get" class="actions" style="margin-top:0">
          <input type="month" name="von" value={from} style="max-width:170px" aria-label="von" />
          <input type="month" name="bis" value={to} style="max-width:170px" aria-label="bis" />
          <button class="btn sm sec">Anzeigen</button>
          <span class="small mut">
            {monthLabelDe(from)} – {monthLabelDe(to)} · gesamt{' '}
            {tot.min ? euro((tot.rev * 60n) / BigInt(tot.min)) : '–'} je Ist-Stunde
          </span>
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Objekt</th>
                  <th class="r">Erlös netto</th>
                  <th class="r">Plan-Std.</th>
                  <th class="r">Ist-Std.</th>
                  <th class="r">Erlös je Plan-Std.</th>
                  <th class="r">Erlös je Ist-Std.</th>
                  <th class="r">Ø Stundenlohn</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      <a href={`/objekte/${r.site_id}`}>{r.site_name}</a>
                      <div class="small mut">
                        {r.site_no} · {r.customer_name}
                      </div>
                    </td>
                    <td class="r">{euro(r.revenue)}</td>
                    <td class="r">{hm(r.plan_minutes)}</td>
                    <td class="r">{hm(r.minutes)}</td>
                    <td class="r">{r.per_plan_hour == null ? '–' : euro(r.per_plan_hour)}</td>
                    <td
                      class="r"
                      style={
                        r.per_hour != null && r.wage_avg != null && r.per_hour < r.wage_avg * 2n
                          ? 'background:#fde2e2'
                          : ''
                      }
                    >
                      <b>{r.per_hour == null ? '–' : euro(r.per_hour)}</b>
                    </td>
                    <td class="r">{r.wage_avg == null ? '–' : euro(r.wage_avg)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={7} class="mut">
                      Keine Erlöse oder Stunden im Zeitraum.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Erlös nach Leistungszeitraum (Rechnungspositionen je Objekt, inkl. Sammelrechnungen und Storno).
            Rot: Erlös je Ist-Stunde unter dem doppelten Ø Stundenlohn – grober Hinweis, die genaue Rechnung
            steht in der Nachkalkulation.
          </p>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Stundenkontrolle
  app.get('/auswertungen/stunden', async (c) => {
    const month = isMonth(c.req.query('monat')) ? c.req.query('monat')! : todayBerlin().slice(0, 7);
    const group = c.req.query('gruppe') || null;
    const [rows, groups] = await Promise.all([hoursControl(sql, month, group), planningGroups(sql)]);
    return shell(
      c,
      'stunden',
      `Stundenkontrolle ${monthLabelDe(month)}`,
      <>
        <form method="get" class="actions" style="margin-top:0">
          <a class="btn sm sec" href={`/auswertungen/stunden?monat=${nextMonth(month, -1)}`}>
            ←
          </a>
          <input
            type="month"
            name="monat"
            value={month}
            style="max-width:180px"
            onchange="this.form.submit()"
          />
          <a class="btn sm sec" href={`/auswertungen/stunden?monat=${nextMonth(month, 1)}`}>
            →
          </a>
          <select name="gruppe" onchange="this.form.submit()" style="max-width:220px">
            <option value="">Alle Einsatzgruppen</option>
            {groups.map((g) => (
              <option value={g} selected={g === group}>
                {g}
              </option>
            ))}
          </select>
          <a
            class="btn sm sec"
            href={`/auswertungen/stunden.csv?monat=${month}${group ? `&gruppe=${encodeURIComponent(group)}` : ''}`}
          >
            CSV
          </a>
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th class="r">Wochenstd.</th>
                  <th class="r">Soll</th>
                  <th class="r">Plan</th>
                  <th class="r">Ist</th>
                  <th class="r">Ist − Soll</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const diff = r.soll == null ? null : r.ist - r.soll;
                  return (
                    <tr>
                      <td>
                        <a href={`/personal/${r.id}/kalender?monat=${month}`}>{r.name}</a>{' '}
                        <span class="small mut">{r.personnel_no}</span>
                      </td>
                      <td class="r">
                        {r.weekly_hours ? Number(r.weekly_hours).toLocaleString('de-DE') : '–'}
                      </td>
                      <td class="r">{r.soll == null ? '–' : hm(r.soll)}</td>
                      <td
                        class="r"
                        style={r.soll != null && Math.abs(r.plan - r.soll) > 60 ? 'background:#fff4c2' : ''}
                      >
                        {hm(r.plan)}
                      </td>
                      <td class="r">{hm(r.ist)}</td>
                      <td
                        class="r"
                        style={
                          diff != null && diff < -60
                            ? 'color:var(--err)'
                            : diff != null && diff > 60
                              ? 'color:var(--ok)'
                              : ''
                        }
                      >
                        {diff == null ? '–' : `${diff > 0 ? '+' : ''}${hm(diff)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Soll = Wochenstunden ÷ 5 × Arbeitstage (ohne Feiertage Bayern); Plan = Einsätze ohne
            Feiertage/Abwesenheit, mit Vertretungen; Ist = erfasste Zeiten netto. Gelb: Plan weicht über 1
            Std. vom Soll ab.
          </p>
        </div>
      </>,
    );
  });

  app.get('/auswertungen/stunden.csv', async (c) => {
    const month = isMonth(c.req.query('monat')) ? c.req.query('monat')! : todayBerlin().slice(0, 7);
    const rows = await hoursControl(sql, month, c.req.query('gruppe') || null);
    const h = (m: number | null) => (m == null ? '' : (m / 60).toFixed(2).replace('.', ','));
    return csvResponse(
      c,
      `stundenkontrolle-${month}.csv`,
      toCsv(
        [
          'Personalnummer',
          'Name',
          'Wochenstunden',
          'Soll (Std.)',
          'Plan (Std.)',
          'Ist (Std.)',
          'Ist − Soll (Std.)',
        ],
        rows.map((r) => [
          r.personnel_no,
          r.name,
          r.weekly_hours?.replace('.', ',') ?? '',
          h(r.soll),
          h(r.plan),
          h(r.ist),
          h(r.soll == null ? null : r.ist - r.soll),
        ]),
      ),
    );
  });

  // ------------------------------------------------------------------ Urlaubskonten
  app.get('/auswertungen/urlaub', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const rows = await leaveAccounts(sql, year);
    return shell(
      c,
      'urlaub',
      `Urlaubskonten ${year}`,
      <>
        <YearNav base="/auswertungen/urlaub" year={year} />
        {rows.some((r) => r.openingAsOf) && (
          <p class="small mut">
            Bei {rows.filter((r) => r.openingAsOf).length} Mitarbeitenden ist der Stand aus Fortytools
            übernommen (
            {[...new Set(rows.map((r) => r.openingAsOf).filter(Boolean))].map((d) => dateDe(d!)).join(', ')}).
          </p>
        )}
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th class="r">Anspruch</th>
                  <th class="r">Übertrag</th>
                  <th class="r">verfallen</th>
                  <th class="r">genommen</th>
                  <th class="r">beantragt</th>
                  <th class="r">Rest</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      <a href={`/personal/${r.id}`}>{r.name}</a>{' '}
                      <span class="small mut">{r.personnel_no}</span>
                    </td>
                    <td class="r">{daysDe(r.entitlement)}</td>
                    <td class="r">{r.carried ? daysDe(r.carried) : '–'}</td>
                    <td class="r">{r.carriedExpired ? daysDe(r.carriedExpired) : '–'}</td>
                    <td class="r">{daysDe(r.taken)}</td>
                    <td class="r">{r.requested ? daysDe(r.requested) : '–'}</td>
                    <td class="r" style={r.rest < 0 ? 'color:var(--err)' : ''}>
                      <b>{daysDe(r.rest)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Arbeitstage. Übertrag aus dem Vorjahr nur bei „Resturlaub übertragen“; nicht bis 31.03. genommener
            Übertrag verfällt rechnerisch. Rechtlich nur, wenn rechtzeitig auf Urlaub und Verfall hingewiesen
            wurde (BAG 9 AZR 541/15). „Stand …“ = Urlaubskonto aus Fortytools übernommen (Anspruch,
            Resturlaub, genommen bis zum Stichtag); Urlaub in der App zählt ab dem Folgetag dazu.
          </p>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Krankheitstage
  app.get('/auswertungen/krankheit', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const rows = await sickDays(sql, year);
    const months = [...Array(12).keys()];
    const anyImported = rows.some((r) => r.importedAsOf);
    const cutDates = [...new Set(rows.map((r) => r.importedAsOf).filter(Boolean))] as string[];
    return shell(
      c,
      'krankheit',
      `Krankheitstage ${year}`,
      <>
        <YearNav base="/auswertungen/krankheit" year={year} />
        <div class="card">
          <div class="tbl">
            <table class="small">
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  {anyImported && (
                    <th class="r" title="aus Fortytools übernommen (bis Stichtag)">
                      übernommen
                    </th>
                  )}
                  {months.map((m) => (
                    <th class="r">{MON[m]}</th>
                  ))}
                  <th class="r">Summe</th>
                  <th class="r">davon Kind</th>
                  <th class="r">Fälle</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      <a href={`/personal/${r.id}`}>{r.name}</a>
                    </td>
                    {anyImported && (
                      <td class="r" title={r.importedAsOf ? `bis ${dateDe(r.importedAsOf)}` : ''}>
                        {r.imported ? daysDe(r.imported) : ''}
                      </td>
                    )}
                    {r.months.map((d) => (
                      <td class="r">{d ? daysDe(d) : ''}</td>
                    ))}
                    <td class="r">
                      <b>{daysDe(r.total)}</b>
                    </td>
                    <td class="r">{r.child ? daysDe(r.child) : '–'}</td>
                    <td class="r">{r.cases}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={17} class="mut">
                      Keine Krankmeldungen in {year}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Arbeitstage (Mo–Fr ohne Feiertage) aus genehmigten Abwesenheiten „{ABSENCE_LABEL.krank}“ und „
            {ABSENCE_LABEL.kind_krank}“. Mehr als 6 Wochen in 12 Monaten → betriebliches
            Eingliederungsmanagement anbieten (§ 167 Abs. 2 SGB IX).
            {cutDates.length > 0 && (
              <>
                {' '}
                „übernommen“ = Krankheitstage aus Fortytools bis {cutDates.map(dateDe).join(', ')} (nur als
                Summe, ohne Monate); Krankmeldungen in der App zählen erst ab dem Folgetag.
              </>
            )}
          </p>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Dienste-Liste
  const dutyRange = (c: Context<AppEnv>) => {
    const today = todayBerlin();
    const from = isDate(c.req.query('von')) ? c.req.query('von')! : today;
    const toQ = c.req.query('bis');
    const to = isDate(toQ) && toQ >= from ? toQ : addDays(from, 6);
    return { from, to, siteId: c.req.query('objekt') || undefined };
  };

  app.get('/auswertungen/dienste', async (c) => {
    const r = dutyRange(c);
    const scope = c.get('sites');
    const [rows, sites] = await Promise.all([
      dutyList(sql, { from: r.from, to: r.to, ...(r.siteId ? { siteId: r.siteId } : {}), scope }),
      sql<
        { id: string; site_no: string; name: string; customer_name: string }[]
      >`select s.id, s.site_no, s.name, s.street, s.city, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id where s.active order by s.name`,
    ]);
    const visibleSites = scope ? sites.filter((s) => scope.includes(s.id)) : sites;
    const days = [...new Set(rows.map((s) => s.date))];
    const total = rows.filter((s) => !s.absence && !s.holiday).reduce((a, s) => a + s.minutes, 0);
    const qs = `von=${r.from}&bis=${r.to}${r.siteId ? `&objekt=${r.siteId}` : ''}`;
    return shell(
      c,
      'dienste',
      'Dienste-Liste',
      <>
        <form method="get" class="actions" style="margin-top:0">
          <input type="date" name="von" value={r.from} style="max-width:170px" aria-label="von" />
          <input type="date" name="bis" value={r.to} style="max-width:170px" aria-label="bis" />
          <select name="objekt" style="max-width:240px" aria-label="Objekt">
            <option value="">Alle Objekte</option>
            <SiteOptions sites={visibleSites} selected={r.siteId} />
          </select>
          <button class="btn sm sec">Anzeigen</button>
          <a class="btn sm sec" href={`/auswertungen/dienste.csv?${qs}`}>
            CSV
          </a>
          <button type="button" class="btn sm sec" onclick="window.print()">
            Drucken
          </button>
          <span class="small mut">
            {rows.length} Dienste · {hm(total)} Std. ·{' '}
            <a href={`/einsatzplanung?ansicht=monat&datum=${r.from}`}>als Kalender</a>
          </span>
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Zeit</th>
                  <th>Objekt</th>
                  <th>Mitarbeiter</th>
                  <th>Hinweis</th>
                </tr>
              </thead>
              <tbody>
                {days.flatMap((d) =>
                  rows
                    .filter((s) => s.date === d)
                    .map((s, i) => (
                      <tr style={i === 0 ? 'border-top:2px solid var(--line)' : ''}>
                        <td>{i === 0 ? `${WEEKDAYS_SHORT[isoWeekday(d)]} ${dateDe(d)}` : ''}</td>
                        <td>
                          {s.plan.start_time}–{s.plan.end_time}
                        </td>
                        <td>{s.plan.site_name}</td>
                        <td>
                          {s.plan.employee_name}
                          {s.exception?.kind === 'vertretung' && (
                            <span class="small mut"> (Vertretung für {s.exception.original})</span>
                          )}
                        </td>
                        <td class="small">
                          {s.holiday && <span class="badge warn">{s.holiday}</span>}{' '}
                          {s.absence && (
                            <span class="badge err">
                              {ABSENCE_LABEL[s.absence as AbsenceKind] ?? s.absence}
                            </span>
                          )}{' '}
                          {s.exception?.kind === 'umgeplant' && <span class="badge info">umgeplant</span>}{' '}
                          {s.entry && <span class="badge ok">erfasst</span>}
                        </td>
                      </tr>
                    )),
                )}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={5} class="mut">
                      Keine Dienste im Zeitraum.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>,
    );
  });

  app.get('/auswertungen/dienste.csv', async (c) => {
    const r = dutyRange(c);
    const rows = await dutyList(sql, {
      from: r.from,
      to: r.to,
      ...(r.siteId ? { siteId: r.siteId } : {}),
      scope: c.get('sites'),
    });
    return csvResponse(
      c,
      `dienste-${r.from}-${r.to}.csv`,
      toCsv(
        [
          'Datum',
          'Wochentag',
          'Beginn',
          'Ende',
          'Objekt-Nr.',
          'Objekt',
          'Personalnummer',
          'Mitarbeiter',
          'Hinweis',
        ],
        rows.map((s) => [
          dateDe(s.date),
          WEEKDAYS_SHORT[isoWeekday(s.date)]!,
          s.plan.start_time,
          s.plan.end_time,
          s.plan.site_no,
          s.plan.site_name,
          s.plan.personnel_no,
          s.plan.employee_name,
          [
            s.holiday,
            s.absence ? (ABSENCE_LABEL[s.absence as AbsenceKind] ?? s.absence) : null,
            s.exception?.kind === 'vertretung' ? `Vertretung für ${s.exception.original}` : null,
            s.exception?.kind === 'umgeplant' ? 'umgeplant' : null,
          ]
            .filter(Boolean)
            .join(', '),
        ]),
      ),
    );
  });
}

const YearNav = ({ base, year }: { base: string; year: number }) => (
  <div class="actions" style="margin-top:0">
    <a class="btn sm sec" href={`${base}?jahr=${year - 1}`}>
      ← {year - 1}
    </a>
    <b>{year}</b>
    {year < Number(todayBerlin().slice(0, 4)) + 1 && (
      <a class="btn sm sec" href={`${base}?jahr=${year + 1}`}>
        {year + 1} →
      </a>
    )}
  </div>
);

/** Farben für Anteile (Bordeaux zuerst, dann gut unterscheidbare ruhige Töne). */
const PALETTE = [
  '#7d1435',
  '#c2185b',
  '#e07a5f',
  '#f2b134',
  '#81b29a',
  '#3d5a80',
  '#98c1d9',
  '#6d597a',
  '#b56576',
  '#a3a380',
];

/** Säulen: Zeitraum (Bordeaux-Verlauf) + Vorjahr (hell), Achse mit runden Werten, Werte über den Säulen. */
const StatBars = ({ rows }: { rows: { label: string; cents: bigint; prev?: bigint }[] }) => {
  const W = 960;
  const H = 320;
  const L = 78;
  const B = 56;
  const max = rows.reduce((m, r) => {
    const v = r.cents > (r.prev ?? 0n) ? r.cents : (r.prev ?? 0n);
    return v > m ? v : m;
  }, 0n);
  const maxE = Math.max(1, Number(max) / 100);
  const step = (() => {
    const raw = maxE / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
  })();
  const top = Math.ceil(maxE / step) * step;
  const y = (e: number) => H - B - ((H - B - 22) * Math.max(0, e)) / top;
  const bw = (W - L - 10) / Math.max(1, rows.length);
  const fmt = (e: number) => `${e.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`;
  const short = (e: number) =>
    e >= 1e6
      ? `${(e / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio`
      : e >= 1000
        ? `${Math.round(e / 1000).toLocaleString('de-DE')} T`
        : Math.round(e).toLocaleString('de-DE');
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const hasPrev = rows.some((r) => (r.prev ?? 0n) > 0n);
  const showVal = rows.length <= 16;
  return (
    <svg class="stat-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Umsatz je Zeitraum">
      <defs>
        <linearGradient id="sbg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#a3214a" />
          <stop offset="1" stop-color="#6c1130" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g>
          <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} class="grid" />
          <text x={L - 8} y={y(t) + 4} text-anchor="end" class="ax">
            {fmt(t)}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const e = Number(r.cents) / 100;
        const pe = Number(r.prev ?? 0n) / 100;
        const gw = bw * 0.74;
        const x0 = L + i * bw + (bw - gw) / 2;
        const w1 = hasPrev ? gw * 0.58 : gw;
        const w0 = gw - w1 - (hasPrev ? 2 : 0);
        const h = Math.max(0, y(0) - y(e));
        const hp = Math.max(0, y(0) - y(pe));
        const cx = x0 + gw / 2;
        return (
          <g class="bar">
            <rect x={L + i * bw} y={10} width={bw} height={H - B - 10} class="hit" />
            {hasPrev && hp > 0 && <rect x={x0} y={y(0) - hp} width={w0} height={hp} rx={2} class="prev" />}
            {h > 0 && (
              <rect x={x0 + (hasPrev ? w0 + 2 : 0)} y={y(0) - h} width={w1} height={h} rx={3} class="fill" />
            )}
            {showVal && e > 0 && (
              <text x={x0 + (hasPrev ? w0 + 2 : 0) + w1 / 2} y={y(e) - 5} text-anchor="middle" class="val">
                {short(e)}
              </text>
            )}
            <title>{`${r.label}: ${euro(r.cents)}${hasPrev ? ` · Vorjahr ${euro(r.prev ?? 0n)}` : ''}`}</title>
            <text
              x={cx}
              y={H - B + 16}
              text-anchor="end"
              transform={`rotate(-30 ${cx} ${H - B + 16})`}
              class="ax"
            >
              {r.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

/** Ringdiagramm: die größten 8 Anteile farbig, Rest „Sonstige“ grau. */
const Donut = ({ rows, total }: { rows: { label: string; cents: bigint }[]; total: bigint }) => {
  const pos = rows.filter((r) => r.cents > 0n);
  const sum = total > 0n ? total : pos.reduce((a, r) => a + r.cents, 0n);
  if (sum <= 0n) return null;
  const head = pos.slice(0, 8);
  const rest = pos.slice(8).reduce((a, r) => a + r.cents, 0n);
  const parts = [...head.map((r, i) => ({ ...r, color: PALETTE[i]! }))];
  if (rest > 0n) parts.push({ label: 'Sonstige', cents: rest, color: '#d6d3d1' });
  const R = 70;
  const C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div class="donut">
      <svg viewBox="0 0 180 180" width="170" height="170" role="img" aria-label="Anteile">
        <circle cx="90" cy="90" r={R} fill="none" stroke="#f1eeec" stroke-width="26" />
        {parts.map((p) => {
          const len = (Number(p.cents) / Number(sum)) * C;
          const el = (
            <circle
              cx="90"
              cy="90"
              r={R}
              fill="none"
              stroke={p.color}
              stroke-width="26"
              stroke-dasharray={`${Math.max(0, len - 1)} ${C}`}
              stroke-dashoffset={-off}
              transform="rotate(-90 90 90)"
            >
              <title>{`${p.label}: ${euro(p.cents)}`}</title>
            </circle>
          );
          off += len;
          return el;
        })}
        <text x="90" y="86" text-anchor="middle" class="dn-l">
          gesamt
        </text>
        <text x="90" y="104" text-anchor="middle" class="dn-v">
          {Math.round(Number(sum) / 100000).toLocaleString('de-DE')} T€
        </text>
      </svg>
      <ul class="dn-legend">
        {parts.map((p) => (
          <li>
            <i style={`background:${p.color}`} />
            <span>{p.label}</span>
            <b>
              {((Number(p.cents) / Number(sum)) * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })}{' '}
              %
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Anteile: Ringdiagramm + Liste mit farbigen Balken (bei 40 Kunden lesbarer als nur Torte). */
const ShareCard = ({
  title,
  rows,
  total,
  pct,
}: {
  title: string;
  rows: { label: string; href: string | null; cents: bigint }[];
  total: bigint;
  pct: (v: bigint, of: bigint) => string;
}) => {
  const max = rows.reduce((m, r) => (r.cents > m ? r.cents : m), 1n);
  return (
    <div class="card">
      <h3 style="margin-top:0">{title}</h3>
      <Donut rows={rows} total={total} />
      <div class="tbl">
        <table class="share">
          <tbody>
            {rows.map((r, i) => (
              <tr class={i >= 20 ? 'share-more' : ''}>
                <td>
                  {r.href ? <a href={r.href}>{r.label}</a> : r.label}
                  <div class="sharebar">
                    <span
                      style={`background:${i < 8 ? PALETTE[i] : '#b8b2ae'};width:${r.cents > 0n ? Math.max(0.5, Number((r.cents * 1000n) / max) / 10) : 0}%`}
                    />
                  </div>
                </td>
                <td class="r num small mut">{pct(r.cents, total)}</td>
                <td class="r num">{euro(r.cents)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td class="mut">Kein Umsatz im Zeitraum.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 20 && (
        <button
          type="button"
          class="btn ghost sm"
          onclick="this.closest('.card').classList.add('share-all');this.remove()"
        >
          alle {rows.length} anzeigen
        </button>
      )}
    </div>
  );
};
