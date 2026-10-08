import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  BOOKING_KIND,
  type BookingKind,
  bookTimeAccount,
  listBookings,
  setStartMonth,
  timeAccount,
} from '../services/time-account.js';
import { toCsv } from '../services/reports.js';
import type { Ctx } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';

/** Minuten → „+12:30“ / „−3:15“ */
export const hhmm = (m: number | null, sign = true) => {
  if (m == null) return '–';
  const a = Math.abs(m);
  return `${m < 0 ? '−' : sign && m > 0 ? '+' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};
/** „-3,5“ / „2:30“ / „-1:15“ → Minuten */
const parseHours = (s: string): number => {
  const t = s.trim().replace('−', '-');
  const m = /^(-?)(\d{1,4}):(\d{2})$/.exec(t);
  if (m) return (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n)) throw new BusinessError('Stunden bitte als 2,5 oder 2:30 eingeben');
  return Math.round(n * 60);
};

export function registerTimeAccountRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const monthOf = (q: string | undefined) => {
    if (q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q)) return q;
    const d = new Date(`${todayBerlin().slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };

  app.get('/zeiterfassung/arbeitszeitkonto', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const q = (c.req.query('q') ?? '').toLowerCase();
    const [{ rows, start }, bookings] = await Promise.all([timeAccount(sql, month), listBookings(sql)]);
    const list = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.personnel_no.includes(q));
    const warn = list.filter((r) => r.warn).length;
    return page(
      c,
      'Arbeitszeitkonto',
      'zeit',
      <>
        <PageHead title="Arbeitszeitkonto" crumbs={[['Zeiterfassung', '/zeiterfassung']]} />
        <form method="get" class="actions" style="margin-top:0">
          <input type="month" name="monat" value={month} style="max-width:170px" />
          <input
            name="q"
            value={c.req.query('q') ?? ''}
            placeholder="Name oder Personalnr."
            style="max-width:220px"
          />
          <button class="btn sec sm">Anzeigen</button>
          <a class="btn sec sm" href={`/zeiterfassung/arbeitszeitkonto.csv?monat=${month}`}>
            CSV
          </a>
          <span class="small mut" style="margin-left:auto">
            Kontostand ab {start.slice(5)}/{start.slice(0, 4)} (Startmonat unten änderbar)
          </span>
        </form>
        <div class="flash warn">
          <span>
            Ist = gearbeitet + bezahlte Abwesenheit (Urlaub, Krank, Sonstige); Soll = Wochenstunden × 4,33 je
            Monat (anteilig).
            <b> § 2 Abs. 2 MiLoG:</b> Plusstunden höchstens 50 % der vereinbarten Monatsarbeitszeit und
            innerhalb von 12 Monaten ausgleichen (Freizeit oder Auszahlung).
            {warn ? ` ${warn} Mitarbeitende liegen darüber (rot).` : ''}
          </span>
        </div>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Pers.-Nr.</th>
                  <th>Name</th>
                  <th class="r">Soll</th>
                  <th class="r">gearbeitet</th>
                  <th class="r">bez. Abwesenheit</th>
                  <th class="r">Ist</th>
                  <th class="r">Saldo Monat</th>
                  <th class="r">Buchungen</th>
                  <th class="r">Kontostand</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr style={r.warn ? 'background:var(--err-50)' : ''}>
                    <td>{r.personnel_no}</td>
                    <td>
                      <a href={`/personal/${r.employee_id}/stundenzettel?monat=${month}`}>{r.name}</a>
                    </td>
                    <td class="r">
                      {r.soll == null ? <span class="mut small">keine Wochenstd.</span> : hhmm(r.soll, false)}
                    </td>
                    <td class="r">{hhmm(r.worked, false)}</td>
                    <td class="r">{hhmm(r.paidAbsence, false)}</td>
                    <td class="r">{hhmm(r.ist, false)}</td>
                    <td class="r" style={r.saldo != null && r.saldo < 0 ? 'color:var(--err)' : ''}>
                      {hhmm(r.saldo)}
                    </td>
                    <td class="r">{r.bookings ? hhmm(r.bookings) : ''}</td>
                    <td class="r">
                      <b style={r.balance != null && r.balance < 0 ? 'color:var(--err)' : ''}>
                        {hhmm(r.balance)}
                      </b>
                    </td>
                  </tr>
                ))}
                {list.length === 0 && (
                  <tr>
                    <td colspan={9}>
                      <div class="empty">Keine Mitarbeitenden im Monat.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <form method="post" action="/zeiterfassung/arbeitszeitkonto/buchung" class="card">
          <h3 style="margin-top:0">Buchung erfassen</h3>
          <input type="hidden" name="id" value={randomUUID()} />
          <div class="grid">
            <div>
              <label for="emp">Mitarbeiter</label>
              <select id="emp" name="employee_id" required>
                <option value="">– wählen –</option>
                {rows.map((r) => (
                  <option value={r.employee_id}>
                    {r.personnel_no} · {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="kind">Art</label>
              <select id="kind" name="kind">
                {(Object.keys(BOOKING_KIND) as BookingKind[]).map((k) => (
                  <option value={k}>{BOOKING_KIND[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label for="bmonth">Monat</label>
              <input id="bmonth" type="month" name="monat" value={month} required />
            </div>
            <div>
              <label for="hours">Stunden (+/−, z. B. -8 oder 12:30)</label>
              <input id="hours" name="hours" required />
            </div>
            <div>
              <label for="note">Begründung</label>
              <input id="note" name="note" required placeholder="z. B. Auszahlung mit Lohn Oktober" />
            </div>
          </div>
          <div class="actions form-foot">
            <button class="btn">Buchen</button>
            <span class="small mut">
              Buchungen sind nicht änderbar – Fehler mit einer Gegenbuchung (Korrektur) ausgleichen.
            </span>
          </div>
        </form>
        {bookings.length > 0 && (
          <details class="card">
            <summary>
              <b>Buchungen</b> ({bookings.length})
            </summary>
            <ul class="list small">
              {bookings.map((b) => (
                <li>
                  {b.month} · {b.name} · {BOOKING_KIND[b.kind]} {hhmm(b.minutes)} Std. · „{b.note}“ ·{' '}
                  {b.actor}, {b.created_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
                </li>
              ))}
            </ul>
          </details>
        )}
        <form method="post" action="/zeiterfassung/arbeitszeitkonto/start" class="actions">
          <label class="small" for="start" style="margin:0">
            Konto zählt ab
          </label>
          <input id="start" type="month" name="start" value={start} style="max-width:170px" />
          <button class="btn sec sm">Startmonat speichern</button>
          <span class="small mut">
            Ältere Stände als Startsaldo buchen (z. B. Übernahme aus Fortytools/Lexware).
          </span>
        </form>
      </>,
    );
  });

  app.get('/zeiterfassung/arbeitszeitkonto.csv', async (c) => {
    const month = monthOf(c.req.query('monat'));
    const { rows } = await timeAccount(sql, month);
    const h = (m: number | null) => (m == null ? '' : (m / 60).toFixed(2).replace('.', ','));
    const csv = toCsv(
      [
        'Personalnummer',
        'Name',
        'Soll Std.',
        'gearbeitet Std.',
        'bez. Abwesenheit Std.',
        'Ist Std.',
        'Saldo Monat',
        'Buchungen',
        'Kontostand',
        'über 50 % (MiLoG)',
      ],
      rows.map((r) => [
        r.personnel_no,
        r.name,
        h(r.soll),
        h(r.worked),
        h(r.paidAbsence),
        h(r.ist),
        h(r.saldo),
        h(r.bookings),
        h(r.balance),
        r.warn ? 'ja' : '',
      ]),
    );
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Arbeitszeitkonto_${month}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.post('/zeiterfassung/arbeitszeitkonto/buchung', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const month = str(b, 'monat') ?? '';
    const emp = str(b, 'employee_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(emp)) throw new BusinessError('Bitte Mitarbeiter wählen');
    await bookTimeAccount(sql, {
      id: /^[0-9a-f-]{36}$/.test(str(b, 'id') ?? '') ? str(b, 'id')! : randomUUID(),
      employeeId: emp,
      month,
      minutes: parseHours(str(b, 'hours') ?? ''),
      kind: (str(b, 'kind') ?? '') as BookingKind,
      note: str(b, 'note') ?? '',
      actor: c.get('actor'),
    });
    return back(c, `/zeiterfassung/arbeitszeitkonto?monat=${month}`, { ok: 'Gebucht.' });
  });

  app.post('/zeiterfassung/arbeitszeitkonto/start', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setStartMonth(sql, str(b, 'start') ?? '', c.get('actor'));
    return back(c, '/zeiterfassung/arbeitszeitkonto', { ok: 'Startmonat gespeichert.' });
  });
}
