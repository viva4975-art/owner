import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { encodeCp1252 } from '../services/datev.js';
import {
  DEUEV_GROUPS,
  TARIFF_BINDING,
  getWageStatSettings,
  saveWageStatKeys,
  saveWageStatSettings,
  wageStatCsv,
  wageStatRows,
  type WageStatRow,
} from '../services/wage-statistics.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';

const BASE = '/personal/lohnabrechnungen/verdiensterhebung';
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
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const prevMonth = () => {
  const d = new Date(`${todayBerlin().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const dec = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')}`;
};
/** „1.234,56“ / „1234,5“ / „1234.56“ → Cent */
export function parseDec(v: string, label: string): bigint {
  const t = v.trim().replace(/\s/g, '');
  if (!t) return 0n;
  const norm = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(norm)) throw new BusinessError(`${label}: „${v}“ ist keine Zahl`);
  const [i, f = ''] = norm.replace('-', '').split('.');
  const c = BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2));
  return norm.startsWith('-') ? -c : c;
}

/** Verdiensterhebung (Statistisches Bundesamt) – monatliche CSV für IDEV/CORE (Ahmed 09.11.). */
export function registerWageStatRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;

  app.get(BASE, async (c) => {
    const q = c.req.query('monat');
    const month = q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : prevMonth();
    const [st, rows] = await Promise.all([getWageStatSettings(sql), wageStatRows(sql, month)]);
    const warn = rows.filter((r) => r.warnings.length).length;
    const months = Array.from({ length: 13 }, (_, i) => {
      const d = new Date(`${todayBerlin().slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - i);
      return d.toISOString().slice(0, 7);
    });
    const cell = 'width:7.5em;text-align:right';
    const R: (r: WageStatRow) => unknown = (r) => (
      <tr>
        <td data-l="Mitarbeiter/in">
          <a href={`/personal/${r.employee_id}`}>{r.name}</a>
          <div class="small muted">
            Nr. {r.personnel_no} · geb. {r.birth ? `${r.birth.slice(0, 2)}/${r.birth.slice(2)}` : '–'} ·
            Eintritt {r.entry.slice(0, 2)}/{r.entry.slice(2)}
          </div>
          {r.warnings.map((w) => (
            <div class="small" style="color:#9a6700">
              {w}
            </div>
          ))}
        </td>
        <td data-l="Personengruppe">
          <input
            name={`dg_${r.employee_id}`}
            value={r.deuev_group}
            list="deuev"
            inputmode="numeric"
            maxlength={3}
            style="width:4.5em"
            title="DEÜV-Personengruppe (wie in der SV-Meldung)"
          />
          {!r.stored.deuev && <div class="small muted">Vorschlag</div>}
        </td>
        <td data-l="Tätigkeitsschlüssel">
          <input
            name={`ak_${r.employee_id}`}
            value={r.activity_key}
            inputmode="numeric"
            maxlength={9}
            style="width:8.5em"
            title="9-stelliger Tätigkeitsschlüssel aus der SV-Meldung (Lexware)"
          />
          {!r.stored.activity && <div class="small muted">Vorschlag</div>}
        </td>
        <td data-l="Staatsang.">
          <input
            name={`nk_${r.employee_id}`}
            value={r.nationality_key}
            inputmode="numeric"
            maxlength={3}
            style="width:4em"
            title={r.nationality || 'Staatsangehörigkeit'}
          />
          <div class="small muted">{r.nationality || '–'}</div>
        </td>
        <td data-l="Std. bezahlt">
          <input name={`std_${r.employee_id}`} value={dec(r.hours_cents)} style={cell} />
        </td>
        <td data-l="Überstd.">
          <input name={`ust_${r.employee_id}`} value={dec(r.overtime_hours_cents)} style={cell} />
        </td>
        <td data-l="Brutto gesamt €">
          <input name={`br_${r.employee_id}`} value={dec(r.gross_cents)} style={cell} />
        </td>
        <td data-l="davon sonst. Bezüge €">
          <input name={`sb_${r.employee_id}`} value={dec(r.other_cents)} style={cell} />
        </td>
        <td data-l="davon Überstd. €">
          <input name={`ub_${r.employee_id}`} value={dec(r.overtime_cents)} style={cell} />
        </td>
        <td data-l="davon Zuschläge €">
          <input name={`zu_${r.employee_id}`} value={dec(r.surcharge_cents)} style={cell} />
        </td>
        <td data-l="davon Entgeltumw. €">
          <input name={`eu_${r.employee_id}`} value={dec(r.conversion_cents)} style={cell} />
        </td>
      </tr>
    );
    return page(
      c,
      'Verdiensterhebung',
      'transfer',
      <>
        <PageHead
          title={`Verdiensterhebung ${monthLabel(month)}`}
          crumbs={[['Lohnabrechnungen', '/personal/lohnabrechnungen']]}
        />
        <form method="get" action={BASE} class="actions" style="margin-top:0">
          <label for="monat">Berichtsmonat</label>
          <select id="monat" name="monat" data-autosubmit style="width:auto;min-width:200px">
            {months.map((m) => (
              <option value={m} selected={m === month}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </form>
        <details class="card" open={!st.report_unit_id}>
          <summary>
            Betriebsangaben: Tarifbindung {st.tariff_binding} ·{' '}
            {st.report_unit_id
              ? `Statistik-Betriebsnr. ${st.report_unit_id}`
              : 'Statistik-Betriebsnr. fehlt (nur für CORE)'}
          </summary>
          <form
            method="post"
            action={`${BASE}/einstellungen`}
            style="margin-top:10px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:end"
          >
            <input type="hidden" name="monat" value={month} />
            <div style="min-width:260px">
              <label for="bid">Statistik-Betriebsnummer (BerichtseinheitID, nur CORE)</label>
              <input
                id="bid"
                name="report_unit_id"
                value={st.report_unit_id ?? ''}
                placeholder="aus dem Schreiben des Statistikamts"
                style="width:100%"
              />
            </div>
            <div style="min-width:320px">
              <label for="tb">Tarifbindung</label>
              <select id="tb" name="tariff_binding" style="width:100%">
                {Object.entries(TARIFF_BINDING).map(([k, v]) => (
                  <option value={k} selected={Number(k) === st.tariff_binding}>
                    {k} = {v}
                  </option>
                ))}
              </select>
            </div>
            <button>Speichern</button>
          </form>
        </details>
        <form method="post" action={`${BASE}/csv`} data-noback data-noskip>
          <input type="hidden" name="monat" value={month} />
          <div class="card">
            <h3 style="margin-top:0">Betrieb im {monthLabel(month)}</h3>
            <p class="small muted" style="margin-top:0">
              Wurde die Beschäftigten- bzw. Lohnentwicklung beeinflusst durch …
            </p>
            <div class="actions" style="flex-wrap:wrap;gap:14px">
              {[
                ['fusion', 'Fusion/Aufspaltung'],
                ['konj', 'konjunkturelle Kurzarbeit'],
                ['saison', 'saisonale Kurzarbeit'],
                ['streik', 'Streik'],
                ['sonst', 'sonstige Gründe'],
              ].map(([n, l]) => (
                <label style="font-weight:normal">
                  <input type="checkbox" name={n} value="1" /> {l}
                </label>
              ))}
            </div>
            <label for="bem">Bemerkungen (max. 250 Zeichen)</label>
            <input id="bem" name="bemerkung" maxlength={250} style="width:100%" />
          </div>
          <div class="flash">
            <div>
              {rows.length} Beschäftigte im Monat
              {warn ? ` · bei ${warn} bitte prüfen (gelb)` : ''}. Stunden und Beträge sind aus Stundenliste &
              Lohnarten gerechnet („Ist, sonst Plan“) –{' '}
              <b>vor dem Senden mit der Lohnabrechnung aus Lexware abgleichen</b> (Brutto gesamt laut
              Entgeltbescheinigung, sonstige Bezüge wie Weihnachts-/Urlaubsgeld, Entgeltumwandlung).
              Änderungen hier gelten nur für die Datei; Personengruppe, Tätigkeitsschlüssel und
              Staatsangehörigkeits-Schlüssel werden beim Erstellen je Mitarbeiter gespeichert.
            </div>
          </div>
          <datalist id="deuev">
            {Object.entries(DEUEV_GROUPS).map(([k, v]) => (
              <option value={k}>{v}</option>
            ))}
          </datalist>
          <div class="card" style="padding:0">
            <table data-nostick>
              <thead>
                <tr>
                  <th>Mitarbeiter/in</th>
                  <th>Pers.-gruppe</th>
                  <th>Tätigkeitsschl.</th>
                  <th>Staatsang.</th>
                  <th class="r">Std. bezahlt</th>
                  <th class="r">Überstd.</th>
                  <th class="r">Brutto gesamt €</th>
                  <th class="r">sonst. Bezüge €</th>
                  <th class="r">Überstd. €</th>
                  <th class="r">Zuschläge €</th>
                  <th class="r">Entgeltumw. €</th>
                </tr>
              </thead>
              <tbody>{rows.map(R)}</tbody>
            </table>
          </div>
          <div class="formfoot">
            <button name="format" value="idev">
              CSV für IDEV erstellen
            </button>
            <button name="format" value="core" class="secondary">
              CSV für CORE erstellen
            </button>
          </div>
          <p class="small muted">
            Datei: Semikolon, Dezimalkomma, Zeichensatz ISO-8859-1, ohne Kopfzeile – in IDEV unter
            „Importieren“ mit Trennzeichen Semikolon und Zeichensatz ISO-8859-1. Tätigkeitsschlüssel und
            Personengruppe bitte einmal mit den SV-Meldungen in Lexware abgleichen (Vorschlag: Reinigung
            54101, Objektleitung/Vorarbeit 54193, Schul-/Berufsabschluss unbekannt, keine
            Arbeitnehmerüberlassung, unbefristet). Bei Personengruppe 800/900 geht der Schlüssel als
            Berufsschlüssel in die Datei.
          </p>
        </form>
      </>,
    );
  });

  app.post(`${BASE}/einstellungen`, async (c) => {
    const b = await c.req.parseBody();
    const month = String(b.monat ?? '');
    await saveWageStatSettings(
      sql,
      { report_unit_id: String(b.report_unit_id ?? ''), tariff_binding: Number(b.tariff_binding) },
      c.get('actor'),
    );
    return back(c, `${BASE}?monat=${encodeURIComponent(month)}`, { ok: 'Betriebsangaben gespeichert.' });
  });

  app.post(`${BASE}/csv`, async (c) => {
    const b = await c.req.parseBody();
    const month = String(b.monat ?? '');
    const s = (k: string) => String(b[k] ?? '');
    try {
      const rows = await wageStatRows(sql, month);
      for (const r of rows) {
        const id = r.employee_id;
        const who = `${r.name}`;
        r.deuev_group = s(`dg_${id}`).trim() || r.deuev_group;
        r.activity_key = s(`ak_${id}`).replace(/\s/g, '') || r.activity_key;
        r.nationality_key = s(`nk_${id}`).trim();
        if (!r.nationality_key) throw new BusinessError(`${who}: Staatsangehörigkeits-Schlüssel fehlt`);
        if (!r.birth) throw new BusinessError(`${who}: Geburtsdatum fehlt (Stammdaten)`);
        r.hours_cents = parseDec(s(`std_${id}`), `${who}, Stunden`);
        r.overtime_hours_cents = parseDec(s(`ust_${id}`), `${who}, Überstunden`);
        r.gross_cents = parseDec(s(`br_${id}`), `${who}, Brutto`);
        r.other_cents = parseDec(s(`sb_${id}`), `${who}, sonstige Bezüge`);
        r.overtime_cents = parseDec(s(`ub_${id}`), `${who}, Überstunden €`);
        r.surcharge_cents = parseDec(s(`zu_${id}`), `${who}, Zuschläge`);
        r.conversion_cents = parseDec(s(`eu_${id}`), `${who}, Entgeltumwandlung`);
        const parts = r.other_cents + r.overtime_cents + r.surcharge_cents + r.conversion_cents;
        if (parts > r.gross_cents && r.gross_cents >= 0n)
          throw new BusinessError(`${who}: „davon“-Beträge sind größer als das Brutto gesamt`);
      }
      await saveWageStatKeys(
        sql,
        rows.map((r) => ({
          employee_id: r.employee_id,
          deuev_group: r.deuev_group,
          activity_key: r.activity_key,
          nationality_key: r.nationality_key,
        })),
      );
      const st = await getWageStatSettings(sql);
      const format = s('format') === 'core' ? 'core' : 'idev';
      const csv = wageStatCsv(rows, {
        ...st,
        format,
        fusion: !!b.fusion,
        konjunkturKurz: !!b.konj,
        saisonKurz: !!b.saison,
        streik: !!b.streik,
        sonstige: !!b.sonst,
        remarks: s('bemerkung'),
      });
      await sql`insert into app.audit_log (actor, action, entity, details)
                values (${c.get('actor')}, 'export', 'verdiensterhebung', ${sql.json({ month, format, rows: rows.length })})`;
      return new Response(encodeCp1252(csv), {
        headers: {
          'Content-Type': 'text/csv; charset=iso-8859-1',
          'Content-Disposition': `attachment; filename="verdiensterhebung-${month}-${format}.csv"`,
        },
      });
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `${BASE}?monat=${encodeURIComponent(month)}`, { fehler: e.message });
      throw e;
    }
  });
}
