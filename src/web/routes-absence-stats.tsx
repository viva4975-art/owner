import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { type XlsxCell, type XlsxSheet, writeXlsx } from '../domain/sheet/xlsx-write.js';
import { type PdfColumn, type PdfRow, renderTablePdf } from '../pdf/table.js';
import { type AbsenceStatSum, EMPLOYMENT_LABEL, absenceStats, anonName } from '../services/absence-stats.js';
import { leaveAccounts, sickDays } from '../services/reports.js';
import type { AppEnv, Ctx } from './app.js';
import { PageHead, dateDe } from './layout.js';

/*
 * Ausfallzeiten (Urlaub + Krankheit) mit Durchschnitten für die Kalkulation, dazu PDF- und Excel-Export für
 * Ausfallzeiten, Urlaubskonten und Krankheitstage – wahlweise mit geschwärzten Namen (anonymisiert).
 * Datenschutz: Krankheitstage sind Gesundheitsdaten (Art. 9 DSGVO) – für Kalkulation/Weitergabe die anonyme Fassung.
 */

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const d1 = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const days = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
const pct = (n: number) =>
  `${(n * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const yearOf = (q: string | undefined) => {
  const y = Number(q);
  const now = Number(todayBerlin().slice(0, 4));
  return Number.isInteger(y) && y >= 2000 && y <= now + 1 ? y : now;
};
const anonOf = (c: Context<AppEnv>) => c.req.query('anonym') === '1';

const file = (c: Context<AppEnv>, bytes: Uint8Array, name: string, kind: 'pdf' | 'xlsx') =>
  c.body(bytes as unknown as ArrayBuffer, 200, {
    'Content-Type':
      kind === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `${kind === 'pdf' ? 'inline' : 'attachment'}; filename="${name}"`,
    'Cache-Control': 'private, no-store',
  });

/** Export-Leiste: PDF / Excel, Häkchen „Namen schwärzen“ */
export const ExportBar = ({ base, year }: { base: string; year: number }) => (
  <form method="get" action={`${base}.pdf`} class="actions" style="margin:0;align-items:center;gap:8px">
    <input type="hidden" name="jahr" value={String(year)} />
    <label class="small" style="display:flex;align-items:center;gap:6px;margin:0">
      <input type="checkbox" name="anonym" value="1" /> Namen schwärzen
    </label>
    <button class="btn sm sec" type="submit" formaction={`${base}.pdf`} formtarget="_blank">
      PDF
    </button>
    <button class="btn sm sec" type="submit" formaction={`${base}.xlsx`}>
      Excel
    </button>
  </form>
);

const YearNav = ({ base, year }: { base: string; year: number }) => (
  <div class="actions" style="margin-top:0">
    <a class="btn sm sec" href={`${base}?jahr=${year - 1}`}>
      ← {year - 1}
    </a>
    <b>{year}</b>
    {year < Number(todayBerlin().slice(0, 4)) && (
      <a class="btn sm sec" href={`${base}?jahr=${year + 1}`}>
        {year + 1} →
      </a>
    )}
  </div>
);

const SUM_COLS = [
  'Gruppe',
  'Köpfe',
  'Vollzeit-Jahre',
  'Feiertage',
  'Urlaub',
  'Krank',
  'Ø Urlaub je MA',
  'Ø Krank je MA',
  'Krankenquote',
  'Urlaubsquote',
  'Ausfallquote',
  'Ausfallzuschlag',
];
const sumCells = (s: AbsenceStatSum): string[] => [
  s.label,
  String(s.heads),
  d1(s.fte_years),
  days(s.holidays),
  days(s.vacation),
  days(s.sick),
  d1(s.vacation_per_head),
  d1(s.sick_per_head),
  pct(s.sick_rate),
  pct(s.vacation_rate),
  pct(s.outage_rate),
  pct(s.surcharge),
];
const sumXlsx = (s: AbsenceStatSum): XlsxCell[] => [
  s.label,
  { n: s.heads, fmt: 'int' },
  { n: s.fte_years, fmt: 'd1' },
  s.holidays,
  s.vacation,
  s.sick,
  { n: s.vacation_per_head, fmt: 'd1' },
  { n: s.sick_per_head, fmt: 'd1' },
  { n: s.sick_rate, fmt: 'pct' },
  { n: s.vacation_rate, fmt: 'pct' },
  { n: s.outage_rate, fmt: 'pct' },
  { n: s.surcharge, fmt: 'pct' },
];

const EXPLAIN =
  'Arbeitstage Mo–Fr (halbe Tage 0,5). Ø je MA = je Vollzeit-Jahr (Teiljahre anteilig). Krankenquote/Urlaubsquote = Tage ÷ ' +
  'Tage Mo–Fr. Ausfallquote = (Feiertage + Urlaub + Krank) ÷ Tage Mo–Fr. Ausfallzuschlag = (Feiertage + Urlaub + Krank) ÷ ' +
  'Anwesenheitstage – Aufschlag auf die tatsächlich gearbeitete Stunde für die Kalkulation. Krank inkl. Kind krank. ' +
  'Bei Teilzeit mit weniger als 5 Arbeitstagen je Woche Näherung.';

export function registerAbsenceStatsRoutes({ app, deps, page }: Ctx) {
  const { sql } = deps;

  app.get('/auswertungen/ausfallzeiten', async (c) => {
    const year = yearOf(c.req.query('jahr'));
    const st = await absenceStats(sql, year);
    const t = st.total;
    const title = 'Ausfallzeiten (Urlaub & Krankheit)';
    return page(
      c,
      title,
      'auswertungen',
      <>
        <PageHead title={title} crumbs={[['Auswertungen', '/auswertungen']]}>
          <ExportBar base="/auswertungen/ausfallzeiten" year={year} />
        </PageHead>
        <YearNav base="/auswertungen/ausfallzeiten" year={year} />
        {st.partial && (
          <p class="small mut">
            Laufendes Jahr: gerechnet vom {dateDe(st.from)} bis heute ({dateDe(st.to)}).
          </p>
        )}
        <div
          class="kpis"
          style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px"
        >
          {[
            ['Ø Krankheitstage je MA', d1(t.sick_per_head), 'je Vollzeit-Jahr'],
            ['Krankenquote', pct(t.sick_rate), `${days(t.sick)} Tage`],
            ['Ø Urlaubstage je MA', d1(t.vacation_per_head), 'je Vollzeit-Jahr'],
            ['Urlaubsquote', pct(t.vacation_rate), `${days(t.vacation)} Tage`],
            ['Ausfallquote', pct(t.outage_rate), 'Feiertage + Urlaub + Krank'],
            ['Ausfallzuschlag', pct(t.surcharge), 'auf die gearbeitete Stunde'],
          ].map(([l, v, s]) => (
            <div class="card" style="margin:0;padding:12px 14px">
              <div class="small mut">{l}</div>
              <div style="font-size:22px;font-weight:600">{v}</div>
              <div class="small mut">{s}</div>
            </div>
          ))}
        </div>
        <div class="card">
          <h3 style="margin-top:0">Durchschnitt je Beschäftigungsart</h3>
          <div class="tbl">
            <table class="small">
              <thead>
                <tr>
                  {SUM_COLS.map((h, i) => (
                    <th class={i ? 'r' : ''}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...st.groups, t].map((s) => (
                  <tr style={s === t ? 'font-weight:600;border-top:2px solid var(--line)' : ''}>
                    {sumCells(s).map((v, i) => (
                      <td class={i ? 'r' : ''}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            {EXPLAIN}
          </p>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Je Mitarbeiter/in ({st.rows.length})</h3>
          <div class="tbl">
            <table class="small">
              <thead>
                <tr>
                  <th>Pers.-Nr.</th>
                  <th>Name</th>
                  <th>Beschäftigung</th>
                  <th>Zeitraum</th>
                  <th class="r">Tage Mo–Fr</th>
                  <th class="r">Feiertage</th>
                  <th class="r">Urlaub</th>
                  <th class="r">Krank</th>
                  <th class="r">Fälle</th>
                  <th class="r">Krankenquote</th>
                  <th class="r">Ausfallquote</th>
                </tr>
              </thead>
              <tbody>
                {st.rows.map((r) => (
                  <tr>
                    <td>{r.personnel_no}</td>
                    <td>
                      <a href={`/personal/${r.id}`}>{r.name}</a>
                    </td>
                    <td>{EMPLOYMENT_LABEL[r.employment_type] ?? r.employment_type}</td>
                    <td class="small">
                      {dateDe(r.from)} – {dateDe(r.to)}
                    </td>
                    <td class="r">{r.weekdays}</td>
                    <td class="r">{r.holidays}</td>
                    <td class="r">{days(r.vacation)}</td>
                    <td class="r">{r.sick ? days(r.sick) : '–'}</td>
                    <td class="r">{r.sick_cases || '–'}</td>
                    <td class="r">{r.weekdays ? pct(r.sick / r.weekdays) : '–'}</td>
                    <td class="r">
                      {r.weekdays ? pct((r.holidays + r.vacation + r.sick) / r.weekdays) : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="small mut" style="margin-bottom:0">
            Krankheitstage sind Gesundheitsdaten (Art. 9 DSGVO): für Kalkulation oder Weitergabe
            (Steuerberater, Ausschreibung) bitte „Namen schwärzen“ verwenden.
          </p>
        </div>
      </>,
    );
  });

  const ausfallData = async (c: Context<AppEnv>) => {
    const year = yearOf(c.req.query('jahr'));
    const anon = anonOf(c);
    const st = await absenceStats(sql, year);
    const subtitle = `${dateDe(st.from)} – ${dateDe(st.to)}${st.partial ? ' (bis heute)' : ''} · ${st.rows.length} Mitarbeitende${anon ? ' · anonymisiert' : ''}`;
    return { year, anon, st, subtitle };
  };

  app.get('/auswertungen/ausfallzeiten.pdf', async (c) => {
    const { year, anon, st, subtitle } = await ausfallData(c);
    const sumColW = [92, 38, 52, 50, 50, 50, 58, 58, 62, 62, 62, 66];
    const rows: PdfRow[] = [{ section: 'Durchschnitt je Beschäftigungsart' }];
    for (const s of st.groups) rows.push(sumCells(s));
    rows.push(sumCells(st.total).map((t) => ({ text: t, bold: true })));
    rows.push({ section: 'Je Mitarbeiter/in' });
    rows.push(
      [
        'Name',
        'Beschäft.',
        'Tage Mo–Fr',
        'Feiertage',
        'Urlaub',
        'Krank',
        'Fälle',
        '',
        'Krankenquote',
        'Ausfallquote',
        '',
        '',
      ].map((t) => ({ text: t, bold: true, fill: [0.95, 0.95, 0.95] as [number, number, number] })),
    );
    st.rows.forEach((r, i) =>
      rows.push([
        anon ? anonName(i) : `${r.name} (${r.personnel_no})`,
        EMPLOYMENT_LABEL[r.employment_type] ?? r.employment_type,
        String(r.weekdays),
        String(r.holidays),
        days(r.vacation),
        days(r.sick),
        String(r.sick_cases),
        '',
        r.weekdays ? pct(r.sick / r.weekdays) : '–',
        r.weekdays ? pct((r.holidays + r.vacation + r.sick) / r.weekdays) : '–',
        '',
        '',
      ]),
    );
    const pdf = await renderTablePdf({
      title: `Ausfallzeiten ${year} – Urlaub & Krankheit`,
      subtitle,
      columns: SUM_COLS.map(
        (label, i) => ({ label, width: sumColW[i]!, align: i ? 'right' : 'left' }) as PdfColumn,
      ),
      rows,
      fontSize: 7.5,
      footnote: `${EXPLAIN}${anon ? '' : ' Vertraulich – enthält Gesundheitsdaten (Art. 9 DSGVO).'}`,
    });
    return file(c, pdf, `ausfallzeiten-${year}${anon ? '-anonym' : ''}.pdf`, 'pdf');
  });

  app.get('/auswertungen/ausfallzeiten.xlsx', async (c) => {
    const { year, anon, st, subtitle } = await ausfallData(c);
    const sheets: XlsxSheet[] = [
      {
        name: 'Durchschnitt',
        title: [`Ausfallzeiten ${year} – Urlaub & Krankheit`, subtitle],
        header: SUM_COLS,
        rows: st.groups.map(sumXlsx),
        footer: [sumXlsx(st.total), [], [EXPLAIN]],
        widths: [20, 8, 14, 10, 10, 10, 14, 14, 13, 13, 13, 15],
      },
      {
        name: 'Je Mitarbeiter',
        title: [`Ausfallzeiten ${year} je Mitarbeiter/in`, subtitle],
        header: [
          ...(anon ? ['Mitarbeiter/in'] : ['Pers.-Nr.', 'Name']),
          'Beschäftigung',
          'Wochenstunden',
          'von',
          'bis',
          'Tage Mo–Fr',
          'Feiertage',
          'Urlaub',
          'Krank',
          'davon Kind krank',
          'Fälle',
          'anwesend',
          'Krankenquote',
          'Ausfallquote',
        ],
        rows: st.rows.map((r, i) => [
          ...(anon ? [anonName(i)] : [r.personnel_no, r.name]),
          EMPLOYMENT_LABEL[r.employment_type] ?? r.employment_type,
          r.weekly_hours,
          dateDe(r.from),
          dateDe(r.to),
          { n: r.weekdays, fmt: 'int' as const },
          { n: r.holidays, fmt: 'int' as const },
          r.vacation,
          r.sick,
          r.child_sick,
          { n: r.sick_cases, fmt: 'int' as const },
          r.present,
          { n: r.weekdays ? r.sick / r.weekdays : 0, fmt: 'pct' as const },
          { n: r.weekdays ? (r.holidays + r.vacation + r.sick) / r.weekdays : 0, fmt: 'pct' as const },
        ]),
        widths: anon
          ? [18, 14, 14, 11, 11, 11, 10, 9, 9, 15, 7, 10, 13, 13]
          : [10, 28, 14, 14, 11, 11, 11, 10, 9, 9, 15, 7, 10, 13, 13],
      },
    ];
    return file(c, writeXlsx(sheets), `ausfallzeiten-${year}${anon ? '-anonym' : ''}.xlsx`, 'xlsx');
  });

  // ------------------------------------------------------------------ Urlaubskonten
  const urlaubData = async (c: Context<AppEnv>) => {
    const year = yearOf(c.req.query('jahr'));
    const anon = anonOf(c);
    const rows = await leaveAccounts(sql, year);
    const n = rows.length || 1;
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    return { year, anon, rows, n, sum };
  };
  const URLAUB_COLS = ['Anspruch', 'Übertrag', 'verfallen', 'genommen', 'beantragt', 'Rest'];
  app.get('/auswertungen/urlaub.pdf', async (c) => {
    const { year, anon, rows, n, sum } = await urlaubData(c);
    const body: PdfRow[] = rows.map((r, i) => [
      anon ? anonName(i) : `${r.name} (${r.personnel_no})`,
      days(r.entitlement),
      days(r.carried),
      days(r.carriedExpired),
      days(r.taken),
      days(r.requested),
      days(r.rest),
    ]);
    const pdf = await renderTablePdf({
      title: `Urlaubskonten ${year}`,
      subtitle: `${rows.length} Mitarbeitende${anon ? ' · anonymisiert' : ''} · Stand ${dateDe(todayBerlin())}`,
      columns: [
        { label: 'Mitarbeiter/in', width: 230 },
        ...URLAUB_COLS.map((label) => ({ label, width: 80, align: 'right' as const })),
      ],
      rows: body,
      totals: [
        'Summe',
        days(sum((r) => r.entitlement)),
        days(sum((r) => r.carried)),
        days(sum((r) => r.carriedExpired)),
        days(sum((r) => r.taken)),
        days(sum((r) => r.requested)),
        days(sum((r) => r.rest)),
      ],
      footnote: `Ø je Mitarbeiter/in: Anspruch ${d1(sum((r) => r.entitlement) / n)}, genommen ${d1(sum((r) => r.taken) / n)}, Rest ${d1(sum((r) => r.rest) / n)} Arbeitstage.`,
    });
    return file(c, pdf, `urlaubskonten-${year}${anon ? '-anonym' : ''}.pdf`, 'pdf');
  });
  app.get('/auswertungen/urlaub.xlsx', async (c) => {
    const { year, anon, rows, n, sum } = await urlaubData(c);
    const avg = (f: (r: (typeof rows)[number]) => number) => ({ n: sum(f) / n, fmt: 'd1' as const });
    const lead = (label: string): XlsxCell[] => (anon ? [label] : ['', label]);
    return file(
      c,
      writeXlsx([
        {
          name: `Urlaubskonten ${year}`,
          title: [`Urlaubskonten ${year}`, `${rows.length} Mitarbeitende${anon ? ' · anonymisiert' : ''}`],
          header: [...(anon ? ['Mitarbeiter/in'] : ['Pers.-Nr.', 'Name']), ...URLAUB_COLS],
          rows: rows.map((r, i) => [
            ...(anon ? [anonName(i)] : [r.personnel_no, r.name]),
            r.entitlement,
            r.carried,
            r.carriedExpired,
            r.taken,
            r.requested,
            r.rest,
          ]),
          footer: [
            [
              ...lead('Summe'),
              sum((r) => r.entitlement),
              sum((r) => r.carried),
              sum((r) => r.carriedExpired),
              sum((r) => r.taken),
              sum((r) => r.requested),
              sum((r) => r.rest),
            ],
            [
              ...lead('Ø je Mitarbeiter/in'),
              avg((r) => r.entitlement),
              avg((r) => r.carried),
              avg((r) => r.carriedExpired),
              avg((r) => r.taken),
              avg((r) => r.requested),
              avg((r) => r.rest),
            ],
          ],
          widths: anon ? [18, 11, 11, 11, 11, 11, 11] : [10, 28, 11, 11, 11, 11, 11, 11],
        },
      ]),
      `urlaubskonten-${year}${anon ? '-anonym' : ''}.xlsx`,
      'xlsx',
    );
  });

  // ------------------------------------------------------------------ Krankheitstage
  const krankData = async (c: Context<AppEnv>) => {
    const year = yearOf(c.req.query('jahr'));
    const anon = anonOf(c);
    const rows = await sickDays(sql, year);
    const st = await absenceStats(sql, year);
    return { year, anon, rows, st };
  };
  app.get('/auswertungen/krankheit.pdf', async (c) => {
    const { year, anon, rows, st } = await krankData(c);
    const body: PdfRow[] = rows.map((r, i) => [
      anon ? anonName(i) : r.name,
      r.imported ? days(r.imported) : '',
      ...r.months.map((d) => (d ? days(d) : '')),
      days(r.total),
      r.child ? days(r.child) : '',
      String(r.cases),
    ]);
    const tot = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    const pdf = await renderTablePdf({
      title: `Krankheitstage ${year}`,
      subtitle: `${rows.length} Mitarbeitende mit Krankheitstagen${anon ? ' · anonymisiert' : ''} · Stand ${dateDe(todayBerlin())}`,
      columns: [
        { label: 'Mitarbeiter/in', width: 150 },
        { label: 'übern.', width: 40, align: 'right' },
        ...MON.map((label) => ({ label, width: 36, align: 'right' as const })),
        { label: 'Summe', width: 44, align: 'right' },
        { label: 'Kind', width: 36, align: 'right' },
        { label: 'Fälle', width: 34, align: 'right' },
      ],
      rows: body,
      totals: [
        'Summe',
        days(tot((r) => r.imported)),
        ...MON.map((_, m) => days(tot((r) => r.months[m] ?? 0))),
        days(tot((r) => r.total)),
        days(tot((r) => r.child)),
        String(tot((r) => r.cases)),
      ],
      fontSize: 7.5,
      footnote:
        `Kennzahlen alle Mitarbeitenden (${st.total.heads}): Ø ${d1(st.total.sick_per_head)} Krankheitstage je Vollzeit-Jahr, ` +
        `Krankenquote ${pct(st.total.sick_rate)}. Arbeitstage Mo–Fr ohne Feiertage. ` +
        (anon ? '' : 'Vertraulich – Gesundheitsdaten (Art. 9 DSGVO).'),
    });
    return file(c, pdf, `krankheitstage-${year}${anon ? '-anonym' : ''}.pdf`, 'pdf');
  });
  app.get('/auswertungen/krankheit.xlsx', async (c) => {
    const { year, anon, rows, st } = await krankData(c);
    const tot = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    const lead = (label: string): XlsxCell[] => (anon ? [label] : ['', label]);
    return file(
      c,
      writeXlsx([
        {
          name: `Krankheitstage ${year}`,
          title: [
            `Krankheitstage ${year}`,
            `${rows.length} Mitarbeitende mit Krankheitstagen${anon ? ' · anonymisiert' : ''}`,
          ],
          header: [
            ...(anon ? ['Mitarbeiter/in'] : ['Pers.-Nr.', 'Name']),
            'übernommen',
            ...MON,
            'Summe',
            'davon Kind krank',
            'Fälle',
          ],
          rows: rows.map((r, i) => [
            ...(anon ? [anonName(i)] : [r.personnel_no, r.name]),
            r.imported || null,
            ...r.months.map((d) => d || null),
            r.total,
            r.child || null,
            { n: r.cases, fmt: 'int' as const },
          ]),
          footer: [
            [
              ...lead('Summe'),
              tot((r) => r.imported),
              ...MON.map((_, m) => tot((r) => r.months[m] ?? 0)),
              tot((r) => r.total),
              tot((r) => r.child),
              { n: tot((r) => r.cases), fmt: 'int' as const },
            ],
            [],
            [{ b: 'Kennzahlen (alle Mitarbeitenden)' }],
            ['Ø Krankheitstage je Vollzeit-Jahr', { n: st.total.sick_per_head, fmt: 'd1' }],
            ['Krankenquote', { n: st.total.sick_rate, fmt: 'pct' }],
            ['Mitarbeitende im Zeitraum', { n: st.total.heads, fmt: 'int' }],
          ],
          widths: [...(anon ? [18] : [10, 28]), 11, ...MON.map(() => 6), 9, 15, 7],
        },
      ]),
      `krankheitstage-${year}${anon ? '-anonym' : ''}.xlsx`,
      'xlsx',
    );
  });
}
