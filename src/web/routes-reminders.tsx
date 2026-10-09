import { randomUUID } from 'node:crypto';
import type { Child } from 'hono/jsx';
import { isMailRedirected } from '../config/env.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { MAILER_MISSING, resolveRecipients } from '../mail/mailer.js';
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

  // E-Mail-Versand prüfen (Ahmed 09.10.: „wie kann ich es testen“) – zeigt den Stand ohne Passwort, sendet eine Test-Mail
  app.get('/einstellungen/email', (c) => {
    const e = deps.env;
    const redirected = isMailRedirected(e);
    const row = (k: string, v: Child) => (
      <>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </>
    );
    return page(
      c,
      'E-Mail-Versand',
      'einstellungen',
      <>
        <PageHead title="E-Mail-Versand prüfen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <div class="card">
          <dl class="kv">
            {row(
              'Mail-Zugang (SMTP)',
              deps.mailer.configured === false ? (
                <span class="badge err">fehlt – in .env.live eintragen</span>
              ) : (
                <span class="badge ok">eingetragen</span>
              ),
            )}
            {row('Server', e.SMTP_HOST ? `${e.SMTP_HOST}:${e.SMTP_PORT}` : '–')}
            {row('Benutzer', e.SMTP_USER ?? '–')}
            {row('Passwort', e.SMTP_PASS ? 'hinterlegt (wird nicht angezeigt)' : '–')}
            {row('Absender', e.MAIL_FROM)}
            {row('Betrieb', e.APP_ENV === 'live' ? 'live' : `${e.APP_ENV} (Testbetrieb)`)}
            {row(
              'Empfänger',
              redirected ? (
                <span class="badge warn">
                  Alle Mails gehen nur an die Testadresse {e.MAIL_TEST_RECIPIENT ?? '(fehlt)'}
                </span>
              ) : (
                <span class="badge ok">echte Empfänger (Kunden bekommen Rechnungen)</span>
              ),
            )}
          </dl>
        </div>
        <form method="post" action="/einstellungen/email" class="card">
          <h3 style="margin-top:0">Test-E-Mail senden</h3>
          <div class="grid">
            <div>
              <label for="to">an</label>
              <input id="to" name="to" type="email" required value={e.MAIL_TEST_RECIPIENT ?? ''} />
            </div>
          </div>
          <p class="small mut">
            {redirected
              ? `Im Testbetrieb geht auch diese Mail an ${e.MAIL_TEST_RECIPIENT ?? 'die Testadresse'}.`
              : 'Geht an die eingetragene Adresse.'}{' '}
            Kommt sie an, funktioniert der Versand. Fehlermeldung „Invalid login“ = Benutzer/Passwort falsch,
            „timeout“ = Server/Port falsch.
          </p>
          <div class="formfoot">
            <button class="btn">Test-E-Mail senden</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/einstellungen/email', async (c) => {
    const to = str(await c.req.parseBody(), 'to') ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
      return back(c, '/einstellungen/email', { fehler: 'Bitte E-Mail-Adresse angeben' });
    if (deps.mailer.configured === false) return back(c, '/einstellungen/email', { fehler: MAILER_MISSING });
    try {
      const { actual } = isMailRedirected(deps.env) ? resolveRecipients(deps.env, [to]) : { actual: [to] };
      await deps.mailer.send({
        from: deps.env.MAIL_FROM,
        to: actual,
        subject: 'Test-E-Mail aus der Viva-Deluxe-App',
        text: `Diese Test-E-Mail wurde am ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} aus der App gesendet.\nDer E-Mail-Versand funktioniert.\n\nGewünschter Empfänger: ${to}`,
        attachments: [],
        messageId: `<test-${randomUUID()}@viva-deluxe-reinigung.de>`,
      });
      return back(c, '/einstellungen/email', {
        ok: `Test-E-Mail an ${actual.join(', ')} gesendet – bitte Postfach prüfen.`,
      });
    } catch (err) {
      return back(c, '/einstellungen/email', {
        fehler: `Versand fehlgeschlagen: ${(err as Error).message}`,
      });
    }
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
