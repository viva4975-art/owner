import { feedIcs, feedToken } from '../services/calendar-feed.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';

/** Kalender-Abo: öffentlicher ICS-Link (Token = Zugang) und Seite „Kalender abonnieren“ für Büro-Benutzer. */
export function registerCalendarFeedRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/kalender/abo/:file', async (c) => {
    const token = c.req.param('file').replace(/\.ics$/, '');
    const r = await feedIcs(sql, token);
    if (!r) return c.text('Kalender nicht gefunden', 404);
    return c.body(r.ics, 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="viva-deluxe.ics"',
      'Cache-Control': 'private, max-age=300',
    });
  });

  app.get('/kalender/abonnieren', async (c) => {
    const user = c.get('user');
    const token = await feedToken(sql, { userId: user.id });
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'app.viva-deluxe-reinigung.de';
    const https = `https://${host}/kalender/abo/${token}.ics`;
    const webcal = `webcal://${host}/kalender/abo/${token}.ics`;
    return page(
      c,
      'Kalender abonnieren',
      'start',
      <>
        <PageHead title="Kalender abonnieren" />
        <div class="card" style="max-width:820px">
          <p style="margin-top:0">
            Ihre Termine aus der App im eigenen Kalender (iPhone, Outlook, Google): eigene Einsätze, Aufgaben,
            Ausschreibungs-Fristen{user.role !== 'objektleitung' && ', Glas- und Tiefgaragen-Termine'}. Der
            Kalender aktualisiert sich selbst (etwa stündlich) – ändern bitte weiter in der App.
          </p>
          <div class="actions">
            <a class="btn" href={webcal}>
              Auf diesem Gerät abonnieren
            </a>
          </div>
          <label for="feed">Link zum Kopieren</label>
          <input id="feed" readonly value={https} onclick="this.select()" />
          <h3>So geht’s</h3>
          <ul class="small">
            <li>
              <b>iPhone/iPad:</b> Link auf dem Gerät öffnen („Auf diesem Gerät abonnieren“) → „Abonnieren“.
              Oder Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo hinzufügen
              → Link einfügen.
            </li>
            <li>
              <b>Outlook (Exchange/IONOS):</b> Kalender → Kalender hinzufügen → Aus dem Internet abonnieren →
              Link einfügen. Damit erscheint er auch auf allen Geräten mit diesem Postfach.
            </li>
            <li>
              <b>Google Kalender:</b> Weitere Kalender → Per URL → Link einfügen.
            </li>
          </ul>
          <p class="small mut">
            Der Link ist wie ein Passwort: Wer ihn hat, sieht die Termine. Nicht weitergeben. Bei Verdacht
            hier neu erzeugen – der alte Link funktioniert dann nicht mehr.
          </p>
          <form
            method="post"
            action="/kalender/abonnieren/neu"
            onsubmit="return confirm('Neuen Link erzeugen? Der alte funktioniert dann nicht mehr.')"
          >
            <button class="btn sec sm">Neuen Link erzeugen</button>
          </form>
        </div>
      </>,
    );
  });

  app.post('/kalender/abonnieren/neu', async (c) => {
    await feedToken(sql, { userId: c.get('user').id }, true);
    return back(c, '/kalender/abonnieren', { ok: 'Neuer Link erzeugt – bitte im Kalender neu abonnieren.' });
  });
}
