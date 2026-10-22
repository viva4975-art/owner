import {
  getFeedSettings,
  hitCounts,
  lastRuns,
  listHits,
  type Region,
  runTenderFeed,
  saveFeedSettings,
  setHitsStatus,
  takeOverHit,
} from '../services/tender-feed.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { PageHead, euro } from './layout.js';

/*
 * Gefundene Ausschreibungen (Ahmed 22.10.): Eingang der automatischen Suche, Übernehmen / Verwerfen, Einstellungen.
 */

const fmtDl = (d: Date | null) =>
  d
    ? d.toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }) + ' Uhr'
    : 'ohne Frist';

let running: Promise<unknown> | null = null;

export function registerTenderFeedRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/ausschreibungen/eingang', async (c) => {
    const v = c.req.query('ansicht');
    const view = v === 'uebernommen' || v === 'verworfen' || v === 'alle' ? v : 'neu';
    const [hits, k, runs, s] = await Promise.all([
      listHits(sql, view),
      hitCounts(sql),
      lastRuns(sql),
      getFeedSettings(sql),
    ]);
    const lastOk = runs.find((r) => !r.error);
    const errors = runs.filter((r) => r.error).slice(0, 2);
    return page(
      c,
      'Gefundene Ausschreibungen',
      'angebote',
      <>
        <PageHead title="Gefundene Ausschreibungen" crumbs={[['Ausschreibungen', '/ausschreibungen']]}>
          <form method="post" action="/ausschreibungen/eingang/abrufen" style="margin-left:auto">
            <button class="btn sec">Jetzt abrufen</button>
          </form>
          <a class="btn sec" href="/einstellungen/ausschreibungssuche">
            Suche einstellen
          </a>
        </PageHead>
        <p class="mut" style="margin-top:-8px;max-width:860px">
          Jeden Morgen holt die App neue Bekanntmachungen aus dem Bekanntmachungsservice des Bundes und von
          TED (EU) und filtert sie nach euren Leistungen und Umkreisen (
          {s.regions.map((r) => `${r.name} + ${r.km} km`).join(', ')}). „Übernehmen“ legt die Ausschreibung
          mit Abgabefrist als Aufgabe an. Unterlagen herunterladen und abgeben geht weiter auf der
          Vergabeplattform.
          {!s.enabled && <b style="color:var(--err)"> Die automatische Suche ist ausgeschaltet.</b>}
        </p>
        {errors.length > 0 && (
          <div class="flash err">
            Letzter Abruf mit Fehler:{' '}
            {errors.map((e) => `${e.source === 'ted' ? 'TED' : 'Bund'} ${e.day}: ${e.error}`).join(' · ')} –
            wird beim nächsten Lauf wiederholt.
          </div>
        )}
        <form method="post" action="/ausschreibungen/eingang/status">
          <div class="actions">
            <div class="chips" style="margin:0">
              <a href="/ausschreibungen/eingang" class={view === 'neu' ? 'on' : ''}>
                Neu<span class="n">{k.neu}</span>
              </a>
              <a
                href="/ausschreibungen/eingang?ansicht=uebernommen"
                class={view === 'uebernommen' ? 'on' : ''}
              >
                Übernommen<span class="n">{k.uebernommen}</span>
              </a>
              <a href="/ausschreibungen/eingang?ansicht=verworfen" class={view === 'verworfen' ? 'on' : ''}>
                Verworfen<span class="n">{k.verworfen}</span>
              </a>
              <a href="/ausschreibungen/eingang?ansicht=alle" class={view === 'alle' ? 'on' : ''}>
                Alle
              </a>
            </div>
            <span class="small mut" style="margin-left:auto">
              {lastOk
                ? `Zuletzt abgerufen: ${lastOk.fetched_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })} Uhr`
                : 'Noch nicht abgerufen'}
            </span>
          </div>
          <div class="card">
            <div class="list" style="border-top:0;margin-top:-22px;margin-bottom:-22px">
              {hits.map((h) => {
                const past = h.days_left !== null && h.days_left < 0;
                return (
                  <div class="row" style={past ? 'opacity:.55' : ''}>
                    {(h.status === 'neu' || h.status === 'verworfen') && (
                      <input
                        type="checkbox"
                        name="ids"
                        value={h.id}
                        aria-label="auswählen"
                        style="flex:none"
                      />
                    )}
                    <div style="width:70px;flex:none;text-align:center">
                      {h.days_left !== null && !past ? (
                        <>
                          <div
                            style={`font-size:20px;font-weight:700;color:${h.days_left <= 7 ? 'var(--err)' : h.days_left <= 14 ? 'var(--warn)' : 'var(--ink)'}`}
                          >
                            {h.days_left}
                          </div>
                          <div class="small faint">Tage</div>
                        </>
                      ) : (
                        <span class="small faint">{past ? 'vorbei' : '–'}</span>
                      )}
                    </div>
                    <div class="main">
                      <b style="color:var(--ink)">{h.title}</b>
                      <div class="small mut">
                        {h.authority ?? 'Auftraggeber unbekannt'}
                        {(h.postal_code || h.place) &&
                          ` · ${[h.postal_code, h.place].filter(Boolean).join(' ')}`}
                        {h.distance_km !== null
                          ? ` · ${String(Number(h.distance_km)).replace('.', ',')} km von ${h.region}`
                          : h.region
                            ? ` · ${h.region}`
                            : ''}
                      </div>
                      <div class="small faint">
                        {h.source === 'ted' ? 'TED (EU)' : 'Bund'}
                        {h.matched && ` · ${h.matched}`}
                        {h.procedure && ` · ${h.procedure}`}
                        {h.value_cents !== null && ` · geschätzt ${euro(h.value_cents)}`}
                        {h.url && (
                          <>
                            {' · '}
                            <a href={h.url} target="_blank" rel="noopener">
                              Bekanntmachung
                            </a>
                          </>
                        )}
                        {h.docs_url && (
                          <>
                            {' · '}
                            <a href={h.docs_url} target="_blank" rel="noopener">
                              Vergabeunterlagen
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                    <div class="side">
                      <span class="when">Abgabe {fmtDl(h.deadline_at)}</span>
                      {h.status === 'uebernommen' && h.tender_id ? (
                        <a class="badge ok" href={`/ausschreibungen/${h.tender_id}`}>
                          übernommen
                        </a>
                      ) : h.status === 'verworfen' ? (
                        <span class="badge">verworfen</span>
                      ) : (
                        <span style="display:flex;gap:6px">
                          <button
                            class="btn sm"
                            formaction={`/ausschreibungen/eingang/${h.id}/uebernehmen`}
                            name="x"
                            value="1"
                          >
                            Übernehmen
                          </button>
                          <button
                            class="btn sec sm"
                            formaction={`/ausschreibungen/eingang/${h.id}/verwerfen`}
                            name="x"
                            value="1"
                          >
                            Verwerfen
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {!hits.length && (
                <div class="row">
                  <div class="main mut">
                    {view === 'neu'
                      ? 'Keine neuen Ausschreibungen. Die Suche läuft jeden Morgen; neue Treffer kommen auch mit der täglichen Erinnerungs-Mail.'
                      : 'Keine Einträge in dieser Auswahl.'}
                  </div>
                </div>
              )}
            </div>
          </div>
          {(view === 'neu' || view === 'verworfen') && hits.length > 0 && (
            <div class="actions form-foot">
              {view === 'neu' ? (
                <button class="btn sec" name="status" value="verworfen" data-confirm="Markierte verwerfen?">
                  Markierte verwerfen
                </button>
              ) : (
                <button class="btn sec" name="status" value="neu">
                  Markierte wieder als neu
                </button>
              )}
            </div>
          )}
        </form>
      </>,
    );
  });

  app.post(`/ausschreibungen/eingang/:id{${UUID}}/uebernehmen`, async (c) => {
    const id = await takeOverHit(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/ausschreibungen/${id}`, {
      ok: 'Als Ausschreibung übernommen – Abgabefrist steht als Aufgabe drin. Bitte Kunde/Interessent zuordnen.',
    });
  });

  app.post(`/ausschreibungen/eingang/:id{${UUID}}/verwerfen`, async (c) => {
    await setHitsStatus(sql, [c.req.param('id')], 'verworfen', c.get('actor'));
    return back(c, '/ausschreibungen/eingang', { ok: 'Verworfen.' });
  });

  app.post('/ausschreibungen/eingang/status', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = ([] as unknown[])
      .concat(b.ids ?? [])
      .map(String)
      .filter((x) => new RegExp(`^${UUID}$`).test(x));
    const status = str(b, 'status') === 'neu' ? 'neu' : 'verworfen';
    const n = await setHitsStatus(sql, ids, status, c.get('actor'));
    return back(c, `/ausschreibungen/eingang${status === 'neu' ? '?ansicht=verworfen' : ''}`, {
      ok: n ? `${n} ${status === 'neu' ? 'wieder als neu markiert' : 'verworfen'}.` : 'Nichts ausgewählt.',
    });
  });

  app.post('/ausschreibungen/eingang/abrufen', async (c) => {
    if (!running)
      running = runTenderFeed(sql, { force: true })
        .catch((e) => console.error('Ausschreibungssuche:', e))
        .finally(() => (running = null));
    const r = (await Promise.race([
      running,
      new Promise((res) => setTimeout(() => res('weiter'), 25_000)),
    ])) as { added: number; errors: string[] } | 'weiter' | undefined;
    if (r === 'weiter' || !r)
      return back(c, '/ausschreibungen/eingang', {
        ok: 'Abruf läuft noch im Hintergrund – Seite in einer Minute neu laden.',
      });
    return back(c, '/ausschreibungen/eingang', {
      ok: `Abruf fertig: ${r.added} neue Treffer.${r.errors.length ? ` Fehler: ${r.errors.join('; ')}` : ''}`,
    });
  });

  // ---------------------------------------------------------------- Einstellungen
  app.get('/einstellungen/ausschreibungssuche', async (c) => {
    const s = await getFeedSettings(sql);
    const rows: (Region | null)[] = [...s.regions, null, null];
    return page(
      c,
      'Ausschreibungssuche',
      'einstellungen',
      <>
        <PageHead title="Ausschreibungssuche" crumbs={[['Einstellungen', '/einstellungen']]} />
        <form method="post" action="/einstellungen/ausschreibungssuche" class="card">
          <p class="small mut" style="margin-top:0;max-width:820px">
            Quellen: Bekanntmachungsservice des Bundes (oeffentlichevergabe.de, dort laufen die
            Bekanntmachungen von DTVP, Vergabe.bayern, eVergabe, iTWO, Vergabe München usw. zusammen) und TED
            (EU-weite Ausschreibungen). Ausschreibungen, die eine Plattform nur selbst veröffentlicht, fehlen
            – dafür die Suchagenten der Plattformen weiter nutzen. Eine Bekanntmachung zählt, wenn ein
            CPV-Code <b>oder</b> ein Stichwort passt und der Ort im Umkreis liegt.
          </p>
          <div class="grid">
            <div class="chk">
              <input type="checkbox" id="enabled" name="enabled" checked={s.enabled} />
              <label for="enabled">Jeden Morgen automatisch suchen</label>
            </div>
            <div>
              <label for="cpv">CPV-Codes (Anfang, einer je Zeile)</label>
              <textarea id="cpv" name="cpv" rows={6}>
                {s.cpv_prefixes.join('\n')}
              </textarea>
              <div class="small faint">
                9091 = alle Reinigungsdienste (Gebäude, Fenster, Büro, Schule, Parkplätze …) · 90921
                Desinfektion · 90620/90630 Winterdienst · 98341140 Hausmeisterdienste · 90911300 nur
                Fensterreinigung
              </div>
            </div>
            <div>
              <label for="kw">Stichwörter (eines je Zeile)</label>
              <textarea id="kw" name="kw" rows={8}>
                {s.keywords.join('\n')}
              </textarea>
              <div class="small faint">
                Gesucht im Titel und in der Beschreibung, ohne Groß-/Kleinschreibung.
              </div>
            </div>
            <div>
              <label>Umkreise</label>
              <div>
                {rows.map((r, i) => (
                  <div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
                    <input
                      name={`r${i}_name`}
                      value={r?.name ?? ''}
                      placeholder="Ort oder PLZ"
                      aria-label="Ort oder PLZ"
                      style="max-width:220px"
                    />
                    <span class="small mut">+</span>
                    <input
                      name={`r${i}_km`}
                      value={r ? String(r.km) : ''}
                      inputmode="numeric"
                      aria-label="Kilometer"
                      style="max-width:80px"
                    />
                    <span class="small mut">km</span>
                    <input type="hidden" name={`r${i}_lat`} value={r ? String(r.lat) : ''} />
                    <input type="hidden" name={`r${i}_lng`} value={r ? String(r.lng) : ''} />
                  </div>
                ))}
                <div class="small faint">
                  Leer lassen = Umkreis entfernen. Entfernung Luftlinie bis zum Ort der Leistung.
                </div>
              </div>
            </div>
            <div class="chk">
              <input type="checkbox" id="keep_unknown" name="keep_unknown" checked={s.keep_unknown} />
              <label for="keep_unknown">
                Bekanntmachungen ohne erkennbaren Ort trotzdem zeigen (wenn die Region in Bayern/Stuttgart
                liegt oder unbekannt ist)
              </label>
            </div>
          </div>
          <div class="actions form-foot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href="/ausschreibungen/eingang">
              Gefundene Ausschreibungen
            </a>
          </div>
        </form>
      </>,
    );
  });

  app.post('/einstellungen/ausschreibungssuche', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const old = await getFeedSettings(sql);
    const regions: Region[] = [];
    for (let i = 0; i < 10; i++) {
      const name = str(b, `r${i}_name`)?.trim();
      if (!name) continue;
      const km = Number((str(b, `r${i}_km`) ?? '').replace(',', '.'));
      const prev = old.regions.find((r) => r.name.toLowerCase() === name.toLowerCase());
      let pos = prev ? { lat: prev.lat, lng: prev.lng } : null;
      if (!pos) {
        try {
          const r = await fetch(
            `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: `${name}, Deutschland`, format: 'json', limit: '1' })}`,
            {
              headers: { 'User-Agent': 'Viva-Deluxe-App/1.0 (info@viva-deluxe-reinigung.de)' },
              signal: AbortSignal.timeout(8000),
            },
          );
          const j = r.ok ? ((await r.json()) as { lat: string; lon: string }[]) : [];
          if (j[0]) pos = { lat: Number(j[0].lat), lng: Number(j[0].lon) };
        } catch {
          /* ohne Verbindung: Meldung „Ort nicht gefunden“ */
        }
      }
      regions.push({ name, km, lat: pos?.lat ?? NaN, lng: pos?.lng ?? NaN });
    }
    const lines = (k: string) =>
      (str(b, k) ?? '')
        .split(/[\n,;]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    await saveFeedSettings(
      sql,
      {
        enabled: str(b, 'enabled') != null,
        cpv_prefixes: lines('cpv'),
        keywords: lines('kw'),
        regions,
        keep_unknown: str(b, 'keep_unknown') != null,
      },
      c.get('actor'),
    );
    return back(c, '/einstellungen/ausschreibungssuche', { ok: 'Gespeichert.' });
  });
}
