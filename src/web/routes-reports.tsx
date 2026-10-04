import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { monthLabelDe, todayBerlin } from '../domain/invoice/calc.js';
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import { planningGroups } from '../services/employees.js';
import {
  dutyList,
  hourlyRates,
  hoursControl,
  invoiceStatistics,
  leaveAccounts,
  nextMonth,
  revenueForecast,
  sickDays,
  toCsv,
} from '../services/reports.js';
import { hm, WEEKDAYS_SHORT } from '../services/time.js';
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
    key: 'rechnungen',
    label: 'Rechnungs-Statistik',
    href: '/auswertungen/rechnungen',
    text: 'Belege je Monat, Kunden nach Umsatz, Zahlungsdauer',
  },
  {
    key: 'umsatz',
    label: 'Netto-Umsatz',
    href: '/auswertungen/umsatz',
    text: 'Netto-Umsatz der letzten 16 Monate',
  },
  {
    key: 'vorschau',
    label: 'Umsatz-Vorschau',
    href: '/auswertungen/vorschau',
    text: 'Erwarteter Umsatz aus den regelmäßigen Leistungen',
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
    const role = c.get('user').role;
    return page(
      c,
      title,
      'auswertungen',
      <>
        <PageHead title={title} crumbs={[['Auswertungen', '/auswertungen']]}>
          {actions}
        </PageHead>
        <Tabs tabs={REPORTS.filter((r) => canOpen(role, r.href))} active={active} />
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

  // ------------------------------------------------------------------ Rechnungs-Statistik
  app.get('/auswertungen/rechnungen', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const s = await invoiceStatistics(sql, year);
    const max = s.months.reduce((m, r) => (r.net > m ? r.net : m), 1n);
    return shell(
      c,
      'rechnungen',
      `Rechnungs-Statistik ${year}`,
      <>
        <YearNav base="/auswertungen/rechnungen" year={year} />
        <div class="kpis">
          <div class="kpi">
            <div class="l">Netto-Umsatz {year}</div>
            <div class="v">{euro(s.total)}</div>
          </div>
          <div class="kpi">
            <div class="l">Rechnungen</div>
            <div class="v">{s.months.reduce((a, m) => a + m.invoices, 0)}</div>
          </div>
          <div class="kpi">
            <div class="l">Ø Zahlungsdauer</div>
            <div class="v">{s.payment.avg_days == null ? '–' : `${s.payment.avg_days} Tage`}</div>
          </div>
          <div class="kpi">
            <div class="l">offen / davon überfällig</div>
            <div class="v">
              {euro(s.payment.open_cents)} / {euro(s.payment.overdue_cents)}
            </div>
          </div>
        </div>
        <div class="cols">
          <div class="card">
            <h3>Je Monat (nach Rechnungsdatum)</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Monat</th>
                    <th class="r">Rechnungen</th>
                    <th class="r">Netto</th>
                    <th class="r">Storno/Korr.</th>
                    <th class="r">Netto gesamt</th>
                    <th style="width:30%"></th>
                  </tr>
                </thead>
                <tbody>
                  {s.months.map((m) => (
                    <tr>
                      <td>{monShort(m.month)}</td>
                      <td class="r">{m.invoices}</td>
                      <td class="r">{euro(m.invoice_net)}</td>
                      <td class="r">{m.reversals ? `${m.reversals} · ${euro(m.reversal_net)}` : '–'}</td>
                      <td class="r">
                        <b>{euro(m.net)}</b>
                      </td>
                      <td>
                        <div
                          style={`height:10px;border-radius:3px;background:var(--brand);width:${m.net > 0n ? Math.max(1, Number((m.net * 100n) / max)) : 0}%`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <h3>Kunden nach Umsatz</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th class="r">Rechn.</th>
                    <th class="r">Netto</th>
                  </tr>
                </thead>
                <tbody>
                  {s.customers.map((k) => (
                    <tr>
                      <td>
                        <a href={`/kunden/${k.id}`}>{k.name}</a>{' '}
                        <span class="small mut">{k.customer_no}</span>
                      </td>
                      <td class="r">{k.count}</td>
                      <td class="r">{euro(k.net)}</td>
                    </tr>
                  ))}
                  {s.customers.length === 0 && (
                    <tr>
                      <td colspan={3} class="mut">
                        Keine Rechnungen in {year}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p class="small mut">
              Bezahlte Rechnungen {year}: {s.payment.paid}, davon nach Fälligkeit bezahlt: {s.payment.late}.
            </p>
          </div>
        </div>
      </>,
    );
  });

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
            wurde (BAG 9 AZR 541/15).
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
                    <td colspan={16} class="mut">
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
        { id: string; site_no: string; name: string }[]
      >`select id, site_no, name from app.sites where active order by name`,
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
            {visibleSites.map((s) => (
              <option value={s.id} selected={s.id === r.siteId}>
                {s.name} ({s.site_no})
              </option>
            ))}
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
            <a href={`/einsatzplanung/monat?monat=${r.from.slice(0, 7)}`}>als Kalender</a>
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
