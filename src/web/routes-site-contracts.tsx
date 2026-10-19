/** Verträge am Objekt: Reinigungsvertrag und Arbeitnehmerüberlassungsvertrag (Ahmed 19.10.), nur Büro. */
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  NOTICE,
  SITE_CONTRACTS,
  isSiteContract,
  siteContractPdf,
  storeSiteContract,
  suggestedLaborPercent,
} from '../services/site-contracts.js';
import { type Ctx, UUID, assertSite } from './app.js';

const str = (v: unknown) => (typeof v === 'string' ? v : null);

export function registerSiteContractRoutes({ app, deps, shells }: Ctx) {
  const { sql, env } = deps;

  app.get(`/objekte/:id{${UUID}}/vertrag`, (c) =>
    shells.site!(c, 'dokumente', async (s) => {
      const art = c.req.query('art');
      const kind = art && isSiteContract(art) ? art : 'reinigung';
      const labor = kind === 'reinigung' ? await suggestedLaborPercent(sql, s.id) : '';
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n from app.site_services where site_id = ${s.id} and active`;
      const [perm] = await sql<{ ok: boolean }[]>`
        select aue_permit_date is not null and aue_permit_authority is not null as ok from app.company where id = 1`;
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a class="btn sm ghost" href={`/objekte/${s.id}/dokumente`}>
              ← Dokumente
            </a>
            {(['reinigung', 'aue'] as const).map((k) => (
              <a class={`btn sm ${k === kind ? '' : 'sec'}`} href={`/objekte/${s.id}/vertrag?art=${k}`}>
                {SITE_CONTRACTS[k].label}
              </a>
            ))}
          </div>
          <form method="post" action={`/objekte/${s.id}/vertrag`} target="_blank" class="card">
            <input type="hidden" name="kind" value={kind} />
            <h2 style="margin-top:0">{SITE_CONTRACTS[kind].label}</h2>
            {kind === 'reinigung' ? (
              <p class="help">
                Vertragspartner ist der Kunde des Objekts. Das Leistungsverzeichnis (Anlage 1) kommt aus den
                aktiven Leistungen des Objekts ({n}) – vorher unter{' '}
                <a href={`/objekte/${s.id}/leistungen`}>Leistungen &amp; Preise</a> prüfen. Mit
                Preisgleitklausel über den Lohnkostenanteil.
              </p>
            ) : (
              <>
                {!perm?.ok && (
                  <div class="flash err">
                    Die Erlaubnis zur Arbeitnehmerüberlassung fehlt in den{' '}
                    <a href="/einstellungen/firma">Firmendaten</a> – ohne sie wird kein Vertrag erstellt.
                  </div>
                )}
                <div class="flash warn">
                  <b>Schriftform (§ 12 AÜG):</b> ausdrucken und von beiden Seiten eigenhändig unterschreiben,{' '}
                  <b>bevor</b> die Überlassung beginnt; die Leiharbeitnehmer vorher namentlich benennen
                  (Anlage 1). Fehlt das, gilt ein Arbeitsverhältnis zwischen Leiharbeitnehmer und Kunde als
                  zustande gekommen (§ 9, § 10 AÜG). Eine Unterschrift in der App reicht hier nicht.
                </div>
              </>
            )}
            <div class="grid">
              <div>
                <label for="vt-datum">Datum des Vertrags</label>
                <input type="date" id="vt-datum" name="datum" value={todayBerlin()} />
              </div>
              <div>
                <label for="vt-beginn">{kind === 'aue' ? 'Beginn der Überlassung' : 'Vertragsbeginn'}</label>
                <input type="date" id="vt-beginn" name="beginn" value={todayBerlin()} required />
              </div>
              <div>
                <label for="vt-laufzeit">Laufzeit</label>
                <select id="vt-laufzeit" name="laufzeit">
                  <option value="unbefristet">unbefristet</option>
                  <option value="fest">fest bis … (verlängert sich um 12 Monate)</option>
                </select>
              </div>
              <div>
                <label for="vt-ende">Vertragsende (nur bei „fest bis“)</label>
                <input type="date" id="vt-ende" name="ende" />
              </div>
              <div>
                <label for="vt-frist">Kündigungsfrist</label>
                <select id="vt-frist" name="frist">
                  {Object.entries(NOTICE).map(([k, v]) => (
                    <option value={k} selected={k === (kind === 'aue' ? '2w' : '3')}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              {kind === 'reinigung' ? (
                <>
                  <div>
                    <label for="vt-lohn">Lohnkostenanteil in %</label>
                    <input id="vt-lohn" name="lohnanteil" value={labor} placeholder="z. B. 80" required />
                    <p class="help">
                      Vorschlag aus den Leistungen (nach Betrag gewichtet). Grundlage der Lohngleitklausel.
                    </p>
                  </div>
                  <div>
                    <label for="vt-regie">Regiestundensatz netto (optional)</label>
                    <input id="vt-regie" name="regie" placeholder="z. B. 38,50" />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label for="vt-taet">Tätigkeit</label>
                    <input
                      id="vt-taet"
                      name="taetigkeit"
                      value="Reinigungskraft (Unterhaltsreinigung)"
                      required
                    />
                  </div>
                  <div>
                    <label for="vt-quali">Erforderliche Qualifikation (optional)</label>
                    <input id="vt-quali" name="qualifikation" />
                  </div>
                  <div>
                    <label for="vt-anzahl">Anzahl Leiharbeitnehmer</label>
                    <input id="vt-anzahl" name="anzahl" placeholder="z. B. 2" />
                  </div>
                  <div>
                    <label for="vt-zeit">Einsatzzeit</label>
                    <input id="vt-zeit" name="arbeitszeit" placeholder="z. B. Mo–Fr 06:00–10:00" />
                  </div>
                  <div>
                    <label for="vt-satz">Verrechnungssatz je Stunde (netto)</label>
                    <input id="vt-satz" name="satz" placeholder="z. B. 32,50" required />
                  </div>
                  <div>
                    <label for="vt-abr">Abrechnung</label>
                    <select id="vt-abr" name="abrechnung">
                      <option value="monatlich">monatlich</option>
                      <option value="woechentlich">wöchentlich</option>
                    </select>
                  </div>
                  <div>
                    <label for="vt-verm">Vermittlungsvergütung bei Übernahme (Monatsentgelte)</label>
                    <select id="vt-verm" name="vermittlung">
                      {['2', '1,5', '1', '0'].map((v) => (
                        <option value={v}>{v === '0' ? 'keine' : `${v}-faches Monatsentgelt`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="vt-zuschl">Zuschläge (leer = tarifliche Zuschläge)</label>
                    <textarea id="vt-zuschl" name="zuschlaege" rows={2} />
                  </div>
                </>
              )}
            </div>
            <label class="small" style="display:block;margin:10px 0">
              <input type="checkbox" name="ablegen" value="1" checked /> unter Dokumente → „Vertrag“ ablegen
            </label>
            <div class="actions">
              <button class="btn">PDF erstellen</button>
            </div>
            <p class="help">
              Vor dem Einsatz bei einem neuen Kunden einmal von einem Anwalt prüfen lassen (Allgemeine
              Geschäftsbedingungen).
            </p>
          </form>
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/vertrag`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const f = await c.req.parseBody();
    const kind = String(f.kind ?? '');
    if (!isSiteContract(kind)) return c.notFound();
    const doc = await siteContractPdf(sql, id, kind, {
      date: str(f.datum),
      start: str(f.beginn),
      term: str(f.laufzeit),
      end: str(f.ende),
      notice: str(f.frist),
      laborPercent: str(f.lohnanteil),
      regieRate: str(f.regie),
      activity: str(f.taetigkeit),
      qualification: str(f.qualifikation),
      headcount: str(f.anzahl),
      workTime: str(f.arbeitszeit),
      rate: str(f.satz),
      surcharges: str(f.zuschlaege),
      billing: str(f.abrechnung),
      placementFactor: str(f.vermittlung),
    });
    if (f.ablegen === '1')
      await storeSiteContract(
        sql,
        { dir: env.FILES_DIR, maxBytes: env.UPLOAD_MAX_BYTES },
        id,
        kind,
        doc,
        c.get('actor'),
      );
    return c.body(doc.pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      'Cache-Control': 'private, no-store',
    });
  });
}
