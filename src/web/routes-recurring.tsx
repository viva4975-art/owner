import type { FC } from 'hono/jsx';
import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { EXPENSE_CATEGORY } from '../services/bank.js';
import { BusinessError } from '../services/errors.js';
import {
  RECURRING_CYCLE,
  RECURRING_METHOD,
  type RecurringCycle,
  type RecurringDue,
  type RecurringMethod,
  type RecurringPayment,
  defaultCostCenter,
  dueRecurring,
  getRecurring,
  listRecurring,
  markRecurringPaid,
  purposeFor,
  coveredPeriod,
  RECURRING_APPLIES,
  type RecurringApplies,
  recentRecurringPaid,
  saveRecurring,
  undoRecurringPaid,
} from '../services/recurring-payments.js';
import { type Ctx, UUID } from './app.js';
import { arr, centsToInput, str } from './forms.js';
import { PageHead, type Tab, Tabs, anz, dateDe, euro } from './layout.js';

/*
 * Wiederkehrende Zahlungen (Ahmed 26.10.: „Finanzamt, Miete, BG BAU, damit wir nichts vergessen“): Verwaltung unter
 * Rechnungseingang → Reiter „Wiederkehrende Zahlungen“, Fälligkeiten stehen im jeweiligen Monat in der Zahlungsliste.
 */

const STEP_MONTHS: Record<RecurringCycle, number> = {
  monatlich: 1,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};
const monthDe = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

/**
 * Zeilen für die Tabelle der Zahlungsliste (zwischen den Eingangsrechnungen): Häkchen `rp` = „<id>|<Monat>“, bei
 * wechselndem Betrag ein Feld `betrag_<Schlüssel>`. Gleiche Spalten wie die Rechnungen.
 */
export const RecurringRows: FC<{ due: RecurringDue[]; today: string }> = ({ due, today }) => (
  <>
    {due.map((d, i) => {
      const p = d.payment;
      const key = `${p.id}|${d.period}`;
      const fuer = coveredPeriod(p, d.period).label;
      const zweck = purposeFor(p.purpose, d.period, fuer) || `${p.name} ${fuer}`;
      return (
        <tr id={i === 0 ? 'wiederkehrend' : undefined} class="rp-row">
          <td>
            <input
              type="checkbox"
              name="rp"
              value={key}
              data-amount={String(p.amount_cents ?? d.bank?.amount_cents ?? 0n)}
              checked={!!d.bank || d.due_date <= today}
              aria-label="auswählen"
              onchange="window.vdSum()"
            />
          </td>
          <td>
            {p.supplier_id ? (
              <a href={`/lieferanten/${p.supplier_id}`}>{p.supplier_name ?? p.payee}</a>
            ) : (
              p.payee
            )}
          </td>
          <td>
            <a href={`/zahlungsliste/wiederkehrend/${p.id}`}>{p.name}</a>
            <div class="small mut">
              <span class="pill">wiederkehrend</span> {RECURRING_CYCLE[p.cycle]} · für {fuer}
              {p.method !== 'ueberweisung' && ` · ${RECURRING_METHOD[p.method]}`}
            </div>
            {d.bank && (
              <div class="small" style="color:var(--ok)">
                Kontoumsatz gefunden: {dateDe(d.bank.date)} · {euro(d.bank.amount_cents)}
              </div>
            )}
          </td>
          <td style={d.due_date < today ? 'color:var(--err);font-weight:600' : ''}>{dateDe(d.due_date)}</td>
          <td>–</td>
          <td class="r">
            {p.amount_cents !== null ? (
              euro(p.amount_cents)
            ) : (
              <input
                name={`betrag_${key}`}
                inputmode="decimal"
                placeholder="Betrag"
                aria-label="Betrag"
                value={d.bank ? centsToInput(d.bank.amount_cents) : ''}
                style="max-width:110px;text-align:right"
                oninput="var c=this.closest('tr').querySelector('input[name=rp]');c.dataset.amount=String(Math.round(parseFloat(this.value.replace(/\./g,'').replace(',','.'))*100)||0);window.vdSum()"
              />
            )}
          </td>
          <td class="r">–</td>
          <td class="r">
            <b>{p.amount_cents !== null ? euro(p.amount_cents) : 'wechselt'}</b>
          </td>
          <td class="small">
            {p.iban ? (
              <code style="user-select:all">{p.iban.replace(/(.{4})/g, '$1 ').trim()}</code>
            ) : (
              <span class="mut">{p.method === 'ueberweisung' ? 'IBAN fehlt' : 'wird abgebucht'}</span>
            )}
            <div class="mut" style="user-select:all">
              {zweck}
            </div>
          </td>
        </tr>
      );
    })}
  </>
);

export function registerRecurringRoutes({ app, deps, page, back }: Ctx, tabs: () => Promise<Tab[]>) {
  const { sql } = deps;

  app.get('/zahlungsliste/wiederkehrend', async (c) => {
    const [list, recent, t] = await Promise.all([listRecurring(sql), recentRecurringPaid(sql), tabs()]);
    const monthly = list
      .filter((r) => r.active && r.amount_cents !== null)
      .reduce((a, r) => a + r.amount_cents! / BigInt(STEP_MONTHS[r.cycle]), 0n);
    return page(
      c,
      'Wiederkehrende Zahlungen',
      'lieferanten',
      <>
        <PageHead title="Rechnungseingang" crumbs={[['Rechnungseingang', '/rechnungseingang']]}>
          <a class="btn" href={`/zahlungsliste/wiederkehrend/${randomUUID()}`} style="margin-left:auto">
            + Wiederkehrende Zahlung
          </a>
        </PageHead>
        <Tabs tabs={t} active="wiederkehrend" />
        <p class="small mut" style="max-width:820px">
          Zahlungen ohne Eingangsrechnung, die regelmäßig anfallen – Gewerbesteuer- und
          Körperschaftsteuer-Vorauszahlungen, Miete, Versicherungen, Leasing … (Umsatzsteuer, Lohnsteuer und
          Krankenkassen kommen aus der Zahlungsliste von Lexware). Sie erscheinen im Fälligkeitsmonat in der{' '}
          <a href="/zahlungsliste#wiederkehrend">Zahlungsliste</a> und bleiben stehen, bis sie als bezahlt
          festgehalten sind. Das ist eine Merkliste: gebucht wird über den Kontoauszug (DATEV), nicht von
          hier.
        </p>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Zahlung</th>
                  <th>Turnus</th>
                  <th>fällig am</th>
                  <th class="r">Betrag</th>
                  <th>Zahlweg</th>
                  <th>Zeitraum</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr style={r.active ? '' : 'opacity:.55'}>
                    <td>
                      <a href={`/zahlungsliste/wiederkehrend/${r.id}`}>
                        <b>{r.name}</b>
                      </a>
                      <div class="small mut">
                        {r.payee}
                        {r.category && ` · ${EXPENSE_CATEGORY[r.category] ?? r.category}`}
                        {!r.active && ' · inaktiv'}
                      </div>
                    </td>
                    <td>
                      {RECURRING_CYCLE[r.cycle]}
                      <div class="small mut">{r.applies_to === 'vorher' ? 'nachträglich' : 'im Voraus'}</div>
                    </td>
                    <td>{r.due_day}. des Monats</td>
                    <td class="r">
                      {r.amount_cents !== null ? euro(r.amount_cents) : <span class="mut">wechselt</span>}
                    </td>
                    <td class="small">{RECURRING_METHOD[r.method]}</td>
                    <td class="small">
                      ab {monthDe(r.start_month)}
                      {r.end_month ? ` bis ${monthDe(r.end_month)}` : ''}
                    </td>
                  </tr>
                ))}
                {!list.length && (
                  <tr>
                    <td colspan={6}>
                      <div class="empty">
                        Noch keine wiederkehrenden Zahlungen.{' '}
                        <a href={`/zahlungsliste/wiederkehrend/${randomUUID()}`}>Erste anlegen</a>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {monthly > 0n && (
            <p class="small mut" style="margin-bottom:0">
              Feste Beträge im Schnitt ≈ {euro(monthly)} je Monat (ohne Zahlungen mit wechselndem Betrag).
            </p>
          )}
        </div>
        <div class="card">
          <h3>Zuletzt bezahlt (60 Tage)</h3>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>bezahlt am</th>
                  <th>Zahlung</th>
                  <th>für</th>
                  <th class="r">Betrag</th>
                  <th>festgehalten von</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr>
                    <td>{dateDe(r.paid_at)}</td>
                    <td>
                      {r.name}
                      <div class="small mut">{r.payee}</div>
                    </td>
                    <td>{monthDe(r.period)}</td>
                    <td class="r">{euro(r.amount_cents)}</td>
                    <td class="small">{r.paid_by}</td>
                    <td class="r">
                      <form
                        method="post"
                        action={`/zahlungsliste/wiederkehrend/zahlung/${r.id}/zuruecknehmen`}
                        style="margin:0"
                      >
                        <button
                          class="btn ghost sm"
                          onclick="return confirm('Zurücknehmen? Die Zahlung steht dann wieder in der Zahlungsliste.')"
                        >
                          zurücknehmen
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {!recent.length && (
                  <tr>
                    <td colspan={6} class="mut">
                      Noch nichts festgehalten.
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

  app.get(`/zahlungsliste/wiederkehrend/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [r, suppliers, ccs]: [
      RecurringPayment | null,
      { id: string; supplier_no: string; name: string }[],
      { id: string; number: string; name: string }[],
    ] = await Promise.all([
      getRecurring(sql, id),
      sql<{ id: string; supplier_no: string; name: string }[]>`
        select id, supplier_no, name from app.suppliers where active order by name`,
      sql<{ id: string; number: string; name: string }[]>`
        select id, number, name from app.cost_centers where active order by number`,
    ]);
    const ccSel = r ? r.cost_center_id : defaultCostCenter(null);
    const v = (k: keyof RecurringPayment) => (r ? r[k] : null);
    const thisMonth = todayBerlin().slice(0, 7);
    return page(
      c,
      r ? r.name : 'Neue wiederkehrende Zahlung',
      'lieferanten',
      <>
        <PageHead
          title={r ? r.name : 'Neue wiederkehrende Zahlung'}
          crumbs={[
            ['Rechnungseingang', '/rechnungseingang'],
            ['Wiederkehrende Zahlungen', '/zahlungsliste/wiederkehrend'],
          ]}
        />
        <form method="post" action={`/zahlungsliste/wiederkehrend/${id}`} style="max-width:760px">
          {r && <input type="hidden" name="version" value={String(r.version)} />}
          <div class="card">
            <div class="grid">
              <label for="rp-name">Bezeichnung *</label>
              <input
                id="rp-name"
                name="name"
                required
                maxlength={200}
                value={(v('name') as string) ?? ''}
                placeholder="z. B. Gewerbesteuer-Vorauszahlung, Körperschaftsteuer-Vorauszahlung, Büromiete"
              />
              <label for="rp-payee">Empfänger *</label>
              <input
                id="rp-payee"
                name="payee"
                required
                maxlength={200}
                value={(v('payee') as string) ?? ''}
                placeholder="z. B. Stadtkasse München, Finanzamt München, Vermieter"
              />
              <label for="rp-sup">Lieferant</label>
              <div>
                <select id="rp-sup" name="supplier_id">
                  <option value="">+ Empfänger als neuen Lieferanten anlegen</option>
                  {suppliers.map((x) => (
                    <option value={x.id} selected={r?.supplier_id === x.id}>
                      {x.name} ({x.supplier_no})
                    </option>
                  ))}
                </select>
                <div class="small mut">
                  Auch Finanzamt, Stadtkasse oder Vermieter werden als Lieferant geführt – der Kontoabgleich
                  erkennt die Zahlung dann über die IBAN.
                </div>
              </div>
              <label for="rp-amount">Betrag</label>
              <div>
                <input
                  id="rp-amount"
                  name="betrag"
                  inputmode="decimal"
                  value={r?.amount_cents ? centsToInput(r.amount_cents) : ''}
                  style="max-width:160px"
                  placeholder="0,00"
                />
                <div class="small mut">
                  Leer lassen, wenn der Betrag jedes Mal anders ist – dann beim Bezahlen eintragen.
                </div>
              </div>
              <label for="rp-cycle">Turnus *</label>
              <select id="rp-cycle" name="cycle" required>
                {(Object.keys(RECURRING_CYCLE) as RecurringCycle[]).map((k) => (
                  <option value={k} selected={(r?.cycle ?? 'monatlich') === k}>
                    {RECURRING_CYCLE[k]}
                  </option>
                ))}
              </select>
              <label for="rp-day">Fällig am Tag *</label>
              <div>
                <input
                  id="rp-day"
                  name="due_day"
                  type="number"
                  min={1}
                  max={31}
                  required
                  value={String(r?.due_day ?? 10)}
                  style="max-width:90px"
                />
                <span class="small mut"> des Monats (31 = letzter Tag)</span>
              </div>
              <label for="rp-start">Erster Fälligkeitsmonat *</label>
              <div>
                <input
                  id="rp-start"
                  name="start_month"
                  type="month"
                  required
                  value={r ? r.start_month.slice(0, 7) : thisMonth}
                  style="max-width:180px"
                />
                <div class="small mut">
                  Bei quartalsweise/halbjährlich/jährlich ab diesem Monat alle 3/6/12 Monate (z. B. 03/2026 →
                  März, Juni, September, Dezember).
                </div>
              </div>
              <label for="rp-applies">Zahlung gilt für *</label>
              <div>
                <select id="rp-applies" name="applies_to" required>
                  {(Object.keys(RECURRING_APPLIES) as RecurringApplies[]).map((k) => (
                    <option value={k} selected={(r?.applies_to ?? 'laufend') === k}>
                      {RECURRING_APPLIES[k]}
                    </option>
                  ))}
                </select>
                <div class="small mut">
                  Bestimmt {'{zeitraum}'} im Verwendungszweck und auf welche Monate die Kosten in der
                  Nachkalkulation verteilt werden. Gewerbesteuer (15.02./05./08./11.) und Körperschaftsteuer
                  (10.03./06./09./12.) sind Vorauszahlungen für das laufende Quartal.
                </div>
              </div>
              <label for="rp-end">Letzter Monat</label>
              <input
                id="rp-end"
                name="end_month"
                type="month"
                value={r?.end_month ? r.end_month.slice(0, 7) : ''}
                style="max-width:180px"
              />
              <label for="rp-method">Zahlweg *</label>
              <select id="rp-method" name="method" required>
                {(Object.keys(RECURRING_METHOD) as RecurringMethod[]).map((k) => (
                  <option value={k} selected={(r?.method ?? 'ueberweisung') === k}>
                    {RECURRING_METHOD[k]}
                  </option>
                ))}
              </select>
              <label for="rp-iban">IBAN des Empfängers</label>
              <input
                id="rp-iban"
                name="iban"
                value={r?.iban ? r.iban.replace(/(.{4})/g, '$1 ').trim() : ''}
                placeholder="Pflicht bei Überweisung von Hand"
              />
              <label for="rp-purpose">Verwendungszweck</label>
              <div>
                <input
                  id="rp-purpose"
                  name="purpose"
                  maxlength={140}
                  value={(v('purpose') as string) ?? ''}
                  placeholder="z. B. StNr 143/190/63154 GewSt-VZ {zeitraum}"
                />
                <div class="small mut">
                  Platzhalter: {'{zeitraum}'} (Zeitraum, für den gezahlt wird: 09/2026, Q2/2026, 2026),{' '}
                  {'{monat}'} (Fälligkeitsmonat 10/2026), {'{vormonat}'}, {'{quartal}'} (Q4/2026),{' '}
                  {'{vorquartal}'}, {'{jahr}'}.
                </div>
              </div>
              <label for="rp-cat">Kostenart</label>
              <select
                id="rp-cat"
                name="category"
                onchange="var m=JSON.parse(this.dataset.cc||'{}'),k=document.getElementById('rp-cc');if(k&&!k.dataset.touched)k.value=m[this.value]||''"
                data-cc={JSON.stringify(
                  Object.fromEntries(
                    Object.keys(EXPENSE_CATEGORY).map((k) => [k, defaultCostCenter(k) ?? '']),
                  ),
                )}
              >
                <option value="">–</option>
                {Object.entries(EXPENSE_CATEGORY).map(([k, l]) => (
                  <option value={k} selected={r?.category === k}>
                    {l}
                  </option>
                ))}
              </select>
              <label for="rp-cc">Kostenstelle (Nachkalkulation)</label>
              <div>
                <select id="rp-cc" name="cost_center_id" onchange="this.dataset.touched='1'">
                  <option value="" selected={!ccSel}>
                    keine – zählt nicht in der Nachkalkulation
                  </option>
                  {ccs.map((x) => (
                    <option value={x.id} selected={ccSel === x.id}>
                      {x.number} {x.name}
                    </option>
                  ))}
                </select>
                <div class="small mut">
                  Miete, Versicherungen, Telefon, Leasing → Verwaltung / Büro. <b>Keine Kostenstelle</b> für
                  Steuern (Gewerbe-/Körperschaftsteuer: Steuern vom Ertrag, keine Objekt-Kosten) und
                  Sozialabgaben/BG BAU (stecken schon im Lohnzuschlag der Nachkalkulation, sonst doppelt).
                </div>
              </div>
              <label for="rp-vat">darin Umsatzsteuer</label>
              <select id="rp-vat" name="vat_rate_bp" style="max-width:200px">
                {[
                  [0, 'keine (0 %)'],
                  [1900, '19 %'],
                  [700, '7 %'],
                ].map(([bp, l]) => (
                  <option value={String(bp)} selected={(r?.vat_rate_bp ?? 0) === bp}>
                    {l}
                  </option>
                ))}
              </select>
              <label for="rp-note">Notiz</label>
              <textarea id="rp-note" name="note" rows={2} maxlength={1000}>
                {(v('note') as string) ?? ''}
              </textarea>
              <label for="rp-active">Aktiv</label>
              <label class="chk">
                <input id="rp-active" type="checkbox" name="active" value="1" checked={r ? r.active : true} />{' '}
                erscheint in der Zahlungsliste
              </label>
            </div>
            <div class="formfoot">
              <button class="btn">Speichern</button>
            </div>
          </div>
        </form>
      </>,
    );
  });

  app.post(`/zahlungsliste/wiederkehrend/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const self = `/zahlungsliste/wiederkehrend/${id}`;
    try {
      const betrag = str(b, 'betrag');
      const ver = str(b, 'version');
      await saveRecurring(
        sql,
        id,
        {
          name: str(b, 'name') ?? '',
          payee: str(b, 'payee') ?? '',
          iban: str(b, 'iban'),
          purpose: str(b, 'purpose'),
          amount_cents: betrag ? parseEuro(betrag) : null,
          cycle: str(b, 'cycle') ?? '',
          due_day: Number(str(b, 'due_day')),
          start_month: str(b, 'start_month') ?? '',
          end_month: str(b, 'end_month'),
          method: str(b, 'method') ?? '',
          category: str(b, 'category'),
          supplier_id: str(b, 'supplier_id'),
          cost_center_id: str(b, 'cost_center_id'),
          vat_rate_bp: Number(str(b, 'vat_rate_bp') ?? 0),
          applies_to: str(b, 'applies_to') ?? 'laufend',
          note: str(b, 'note'),
          active: str(b, 'active') === '1',
        },
        ver ? Number(ver) : null,
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError || e instanceof RangeError) return back(c, self, { fehler: e.message });
      throw e;
    }
    return back(c, '/zahlungsliste/wiederkehrend', { ok: 'Gespeichert.' });
  });

  app.post('/zahlungsliste/wiederkehrend/bezahlt', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const date = str(b, 'datum') ?? '';
    const to = `/zahlungsliste?datum=${date}#wiederkehrend`;
    try {
      const items = arr(b, 'rp').map((key) => {
        const raw = str(b, `betrag_${key}`);
        return { key, amount_cents: raw ? parseEuro(raw) : null };
      });
      const n = await markRecurringPaid(sql, { items, date, note: str(b, 'notiz') }, c.get('actor'));
      return back(c, to, { ok: `${anz(n, 'Zahlung', 'Zahlungen')} als bezahlt festgehalten.` });
    } catch (e) {
      if (e instanceof BusinessError || e instanceof RangeError) return back(c, to, { fehler: e.message });
      throw e;
    }
  });

  app.post(`/zahlungsliste/wiederkehrend/zahlung/:id{${UUID}}/zuruecknehmen`, async (c) => {
    try {
      await undoRecurringPaid(sql, c.req.param('id'), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/zahlungsliste/wiederkehrend', { fehler: e.message });
      throw e;
    }
    return back(c, '/zahlungsliste/wiederkehrend', {
      ok: 'Zahlung zurückgenommen – steht wieder in der Zahlungsliste.',
    });
  });

  return { dueRecurring: (pay: string) => dueRecurring(sql, pay) };
}
