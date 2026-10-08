import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { closeMonth, listClosings, monthCloseSteps } from '../services/month-close.js';
import type { Ctx } from './app.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead } from './layout.js';
import { lastMonth } from './routes-invoices.js';

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
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shift = (m: string, d: number) => {
  const x = new Date(`${m}-01T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + d);
  return x.toISOString().slice(0, 7);
};

/** Monatsabschluss-Assistent: Schritte mit Zählern und Links, Abschluss festhalten. */
export function registerMonthCloseRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/monatsabschluss', async (c) => {
    const q = c.req.query('monat');
    const month = q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : lastMonth();
    const [steps, closings] = await Promise.all([monthCloseSteps(sql, month), listClosings(sql, month)]);
    const open = steps.filter((s) => s.open > 0).length;
    const groups = [...new Set(steps.map((s) => s.group))];
    return page(
      c,
      'Monatsabschluss',
      'rechnungen',
      <>
        <PageHead title={`Monatsabschluss ${label(month)}`}>
          <div class="actions" style="margin:0 0 0 auto">
            <a class="btn sec sm" href={`/monatsabschluss?monat=${shift(month, -1)}`}>
              ← {label(shift(month, -1))}
            </a>
            {month < todayBerlin().slice(0, 7) && (
              <a class="btn sec sm" href={`/monatsabschluss?monat=${shift(month, 1)}`}>
                {label(shift(month, 1))} →
              </a>
            )}
          </div>
        </PageHead>
        <div class={`flash ${open ? 'warn' : 'ok'}`}>
          <span>
            {open
              ? `${open} von ${steps.filter((s) => !s.manual).length} Schritten haben noch offene Punkte – der Reihe nach abarbeiten.`
              : 'Alle prüfbaren Schritte erledigt. Exporte (Lohn, DATEV) erledigen und Monat abschließen.'}
            {closings[0] &&
              ` Zuletzt abgeschlossen am ${closings[0].closed_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} von ${closings[0].closed_by}.`}
          </span>
        </div>
        {groups.map((g) => (
          <div class="card">
            <h3 style="margin-top:0">{g}</h3>
            <ul class="list" style="margin:0">
              {steps
                .filter((s) => s.group === g)
                .map((s) => (
                  <li style="display:flex;gap:12px;align-items:center">
                    <span
                      class={`badge ${s.manual ? '' : s.open ? 'warn' : 'ok'}`}
                      style="min-width:74px;text-align:center"
                    >
                      {s.manual ? 'von Hand' : s.open ? `${s.open} offen` : 'erledigt'}
                    </span>
                    <div style="flex:1;min-width:0">
                      <b>{s.title}</b>
                      <div class="small mut">{s.detail}</div>
                    </div>
                    <a class="btn sec sm" href={s.href}>
                      öffnen
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        <form method="post" action="/monatsabschluss" class="card">
          <input type="hidden" name="id" value={randomUUID()} />
          <input type="hidden" name="monat" value={month} />
          <h3 style="margin-top:0">Monat abschließen</h3>
          <p class="small mut" style="margin-top:0">
            Hält den Stand aller Schritte mit Datum und Namen fest (nicht änderbar). Sperrt nichts – spätere
            Nachbuchungen bleiben möglich und können erneut abgeschlossen werden.
          </p>
          <div class="grid">
            <div>
              <label for="note">Notiz {open ? '(Pflicht bei offenen Punkten)' : ''}</label>
              <input id="note" name="note" required={open > 0} />
            </div>
          </div>
          <div class="actions form-foot">
            <button class="btn">
              <Icon name="check" /> {label(month)} abschließen
            </button>
          </div>
        </form>
        {closings.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Abschlüsse {label(month)}</h3>
            <ul class="list small" style="margin:0">
              {closings.map((x) => (
                <li>
                  {x.closed_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} · {x.closed_by} ·{' '}
                  {x.open_points ? `${x.open_points} offene Punkte` : 'alles erledigt'}
                  {x.note ? ` · „${x.note}“` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>,
    );
  });

  app.post('/monatsabschluss', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const month = str(b, 'monat') ?? '';
    const id = str(b, 'id') ?? randomUUID();
    await closeMonth(sql, {
      id: /^[0-9a-f-]{36}$/.test(id) ? id : randomUUID(),
      month,
      note: str(b, 'note'),
      actor: c.get('actor'),
    });
    return back(c, `/monatsabschluss?monat=${month}`, { ok: `${label(month)} abgeschlossen.` });
  });
}
