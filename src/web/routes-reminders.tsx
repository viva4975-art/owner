import { todayBerlin } from '../domain/invoice/calc.js';
import { collectReminders, getReminderSettings, saveReminderSettings } from '../services/reminders.js';
import type { Ctx } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';

/** Erinnerungen: alle Fristen an einer Stelle + tägliche Sammel-Mail (Einstellungen → Erinnerungen). */
export function registerReminderRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/erinnerungen', async (c) => {
    const [list, s] = await Promise.all([collectReminders(sql), getReminderSettings(sql)]);
    const areas = [...new Set(list.map((r) => r.area))];
    return page(
      c,
      'Erinnerungen',
      'home',
      <>
        <PageHead title="Erinnerungen">
          <a class="btn sec" href="/einstellungen/erinnerungen" style="margin-left:auto">
            Tägliche E-Mail {s.enabled ? 'an' : 'aus'}
          </a>
        </PageHead>
        <p class="small mut" style="margin-top:0">
          {list.filter((r) => r.level === 'rot').length} dringend · {list.length} gesamt · Stand{' '}
          {todayBerlin().split('-').reverse().join('.')}
        </p>
        {list.length === 0 && <div class="empty">Keine offenen Fristen – alles erledigt.</div>}
        {areas.map((a) => (
          <div class="card">
            <h3 style="margin-top:0">{a}</h3>
            <ul class="list" style="margin:0">
              {list
                .filter((r) => r.area === a)
                .map((r) => (
                  <li style="display:flex;gap:10px;align-items:center">
                    <span class={`badge ${r.level === 'rot' ? 'err' : 'warn'}`}>
                      {r.level === 'rot' ? 'dringend' : 'bald'}
                    </span>
                    <a href={r.href}>{r.text}</a>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </>,
    );
  });

  app.get('/einstellungen/erinnerungen', async (c) => {
    const s = await getReminderSettings(sql);
    return page(
      c,
      'Erinnerungen',
      'einstellungen',
      <>
        <PageHead title="Erinnerungen per E-Mail" crumbs={[['Einstellungen', '/einstellungen']]} />
        <form method="post" action="/einstellungen/erinnerungen" class="card">
          <p class="small mut" style="margin-top:0">
            Einmal täglich eine Sammel-Mail mit allen Fristen: Aufenthaltstitel/Arbeitserlaubnis (60 Tage),
            Nachunternehmer-Nachweise, HU/Inspektion (30 Tage), Ausschreibungen (7 Tage), Eigen-Compliance,
            fällige Aufgaben, Skonto im Rechnungseingang (3 Tage) und Einsätze von gestern ohne erfasste Zeit.
            Ohne Fristen keine Mail. Im Testbetrieb geht die Mail nur an die Testadresse.
          </p>
          <div class="grid">
            <div class="chk">
              <input type="checkbox" id="enabled" name="enabled" checked={s.enabled} />
              <label for="enabled">Tägliche Erinnerung senden</label>
            </div>
            <div>
              <label for="emails">an (mehrere mit Komma)</label>
              <input
                id="emails"
                name="emails"
                value={s.emails.join(', ')}
                placeholder="buchhaltung@viva-deluxe-reinigung.de"
              />
            </div>
            <div>
              <label for="hour">ab Uhrzeit</label>
              <select id="hour" name="hour">
                {[5, 6, 7, 8, 9, 10, 12, 14, 16].map((h) => (
                  <option value={String(h)} selected={h === s.send_hour}>
                    {String(h).padStart(2, '0')}:00 Uhr
                  </option>
                ))}
              </select>
            </div>
          </div>
          {s.last_sent && (
            <p class="small mut">Zuletzt gesendet: {s.last_sent.split('-').reverse().join('.')}</p>
          )}
          <div class="actions form-foot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href="/erinnerungen">
              Erinnerungen ansehen
            </a>
          </div>
        </form>
      </>,
    );
  });

  app.post('/einstellungen/erinnerungen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveReminderSettings(
      sql,
      {
        enabled: str(b, 'enabled') != null,
        emails: (str(b, 'emails') ?? '')
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        sendHour: Number(str(b, 'hour') ?? 7),
      },
      c.get('actor'),
    );
    return back(c, '/einstellungen/erinnerungen', { ok: 'Gespeichert.' });
  });
}
