// Aushang „App installieren“ (Ahmed 23.11.): Seite mit Vorschau, QR-Links und Download als PDF (Druck) und JPEG (Handy,
// WhatsApp). Für alle angemeldeten Rollen.
import { APP_STORE_URL, appPosterJpeg, appPosterPdf, webAppUrl } from '../services/app-poster.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';

export function registerAppPosterRoutes(ctx: Ctx) {
  const { app, deps, page } = ctx;
  const base = () => deps.env.PUBLIC_URL ?? null;

  app.get('/app-aushang', (c) =>
    page(
      c,
      'App installieren – Aushang',
      'verwaltung',
      <>
        <PageHead title="App installieren – Aushang" />
        <div class="card" style="max-width:900px">
          <p>
            QR-Codes zum Installieren der App: <b>iPhone</b> über den App Store (nicht öffentlich gelistet –
            nur über diesen Link zu finden), <b>Android</b> als Web-App über Chrome. Zum Aushängen im Büro,
            Putzraum oder zum Verschicken per WhatsApp.
          </p>
          <div class="actions" style="margin:12px 0">
            <a class="btn" href="/app-aushang.pdf" target="_blank" rel="noopener">
              PDF zum Drucken (A4)
            </a>
            <a class="btn sec" href="/app-aushang.jpg?download=1">
              Als Bild (JPEG) herunterladen
            </a>
          </div>
          <dl class="kv">
            <dt>iPhone (App Store)</dt>
            <dd>
              <a href={APP_STORE_URL} target="_blank" rel="noopener">
                {APP_STORE_URL}
              </a>
            </dd>
            <dt>Android / Browser</dt>
            <dd>
              <a href={webAppUrl(base())} target="_blank" rel="noopener">
                {webAppUrl(base())}
              </a>
            </dd>
          </dl>
          <p class="small mut">
            Der App-Store-Link nur an Mitarbeitende weitergeben. Schutz vor Fremden ist die Anmeldung
            (Personalnummer + PIN bzw. Benutzer + Passwort).
          </p>
          <img
            src="/app-aushang.jpg"
            alt="Aushang App installieren mit QR-Codes für iPhone und Android"
            style="width:100%;max-width:560px;border:1px solid #e5e5ea;border-radius:12px;margin-top:12px"
          />
        </div>
      </>,
    ),
  );

  app.get('/app-aushang.jpg', async (c) => {
    const jpg = await appPosterJpeg(base());
    c.header('Content-Type', 'image/jpeg');
    c.header('Cache-Control', 'private, max-age=600');
    if (c.req.query('download'))
      c.header('Content-Disposition', 'attachment; filename="Viva-Deluxe-App-Aushang.jpg"');
    return c.body(new Uint8Array(jpg));
  });

  app.get('/app-aushang.pdf', async (c) => {
    const pdf = await appPosterPdf(base());
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', 'inline; filename="Viva-Deluxe-App-Aushang.pdf"');
    return c.body(new Uint8Array(pdf));
  });
}
