/** Einstellungen → Datenschutz: Verzeichnis der Verarbeitungstätigkeiten (Art. 30 DSGVO), nur Admin (Ahmed 25.10.). */
import { VVT_ACTIVITIES, vvtPdf, vvtStatus } from '../services/vvt.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';

export function registerPrivacyRoutes({ app, deps, page }: Ctx) {
  const { sql, env } = deps;

  app.get('/einstellungen/datenschutz', async (c) => {
    const st = await vvtStatus(sql, env);
    const yn = (b: boolean) => (b ? 'eingerichtet' : 'nicht eingerichtet');
    return page(
      c,
      'Datenschutz',
      'einstellungen',
      <>
        <PageHead
          title="Verzeichnis der Verarbeitungstätigkeiten"
          crumbs={[['Einstellungen', '/einstellungen']]}
        />
        <div class="card" style="max-width:980px">
          <p style="margin-top:0">
            Das Verzeichnis nach Art. 30 DSGVO beschreibt, welche personenbezogenen Daten die App verarbeitet
            – mit Zweck, Rechtsgrundlage, Empfängern und Löschfristen. Firmendaten kommen aus den
            Einstellungen.
          </p>
          <div class="actions">
            <a class="btn" href="/einstellungen/datenschutz/verzeichnis.pdf" target="_blank">
              Verzeichnis als PDF
            </a>
            <a class="btn ghost" href="/m/datenschutz" target="_blank">
              Datenschutzhinweise für Mitarbeitende (App)
            </a>
          </div>
          <p class="small mut">
            Mailversand {yn(st.smtp)} · Archiv-Kopie S3 {yn(st.s3)} · Kontoabruf {yn(st.bank)} ·
            Push-Nachrichten {st.push ? 'in Benutzung' : 'noch nicht in Benutzung'}
          </p>
          <div class="flash warn">
            Bitte von Datenschutzberater/Anwalt prüfen lassen und bei Änderungen neu erzeugen. Offen:
            Datenschutzbeauftragter (Pflicht ab 20 Personen, die ständig mit personenbezogenen Daten arbeiten
            – § 38 BDSG); Beschäftigte über Standort beim Stempeln und Fotos informieren (Art. 13 DSGVO);
            Betriebsrat beteiligen, falls vorhanden.
          </div>
        </div>
        <div class="card" style="max-width:980px">
          <h3 style="margin-top:0">Enthaltene Verarbeitungstätigkeiten ({VVT_ACTIVITIES.length})</h3>
          {VVT_ACTIVITIES.map((a, i) => (
            <details>
              <summary>
                {i + 1}. {a.title}
              </summary>
              <dl class="small">
                <dt>Zweck</dt>
                <dd>{a.zweck}</dd>
                <dt>Rechtsgrundlage</dt>
                <dd>{a.rechtsgrundlage}</dd>
                <dt>Daten</dt>
                <dd>{a.daten}</dd>
                <dt>Empfänger</dt>
                <dd>{a.empfaenger}</dd>
                <dt>Löschfristen</dt>
                <dd>{a.loeschung}</dd>
                {a.hinweis && (
                  <>
                    <dt>Hinweis</dt>
                    <dd>{a.hinweis}</dd>
                  </>
                )}
              </dl>
            </details>
          ))}
        </div>
      </>,
    );
  });

  app.get('/einstellungen/datenschutz/verzeichnis.pdf', async () => {
    const pdf = await vvtPdf(sql, env);
    return new Response(pdf, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="Verzeichnis_Verarbeitungstaetigkeiten.pdf"',
      },
    });
  });
}
