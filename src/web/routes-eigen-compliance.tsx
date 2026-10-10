import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  EC_CATS,
  EC_CHECKS,
  EC_DOCS,
  EC_MULTI,
  EC_STATUS_LABEL,
  type EcEntry,
  type EcStatus,
  type EcVersion,
  VALIDITY_OPTS,
  addSlot,
  ecOverview,
  expiresOf,
  finishReview,
  getChecks,
  getVersion,
  markChecked,
  removeSlot,
  reportPdf,
  saveChecks,
  setValidity,
  templatePdf,
  uploadVersion,
  validityOf,
} from '../services/eigen-compliance.js';
import { BusinessError } from '../services/errors.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { dateDe } from './layout.js';

const TONE: Record<EcStatus, string> = { valid: 'ok', expiring: 'warn', expired: 'err', missing: '' };

const EcTabs = ({ active }: { active: string }) => (
  <div class="tabs">
    <a href="/eigen-compliance" class={active === 'nachweise' ? 'on' : ''}>
      Nachweise
    </a>
    <a href="/eigen-compliance/pruefung" class={active === 'pruefung' ? 'on' : ''}>
      Prüfung
    </a>
    <a href="/eigen-compliance/report" class={active === 'report' ? 'on' : ''}>
      Report für Zoll
    </a>
  </div>
);

/** Upload-Knopf: Datei wählen sendet sofort. */
const UploadBtn = ({
  k,
  slot,
  label,
  primary,
}: {
  k: string;
  slot: string;
  label: string;
  primary?: boolean;
}) => (
  <form method="post" action={`/eigen-compliance/${k}/upload`} enctype="multipart/form-data" class="ec-up">
    <input type="hidden" name="slot" value={slot} />
    <label class={`btn sm${primary ? '' : ' sec'}`}>
      {label}
      <input type="file" name="datei" accept=".pdf,.jpg,.jpeg,.png" hidden onchange="this.form.submit()" />
    </label>
  </form>
);

function validText(v: EcVersion, e: EcEntry) {
  if (validityOf(v, e.dt) === '0') return 'kein Ablauf';
  const exp = expiresOf(v, e.dt);
  return exp ? `gültig bis ${dateDe(exp)}` : 'Datum offen';
}

function Row({
  e,
  slot,
  cur,
  archive,
  status,
  sub,
}: {
  e: EcEntry;
  slot: string;
  cur: EcVersion | undefined;
  archive: EcVersion[];
  status: EcStatus;
  sub?: boolean;
}) {
  const name = sub ? slot : e.dt.name;
  const missingTone = status === 'missing' && e.dt.critical && !sub ? 'err' : TONE[status];
  return (
    <div class={`ec-doc${sub ? ' sub' : ''}`}>
      <div class="ec-main">
        <div class="ec-name">
          {name}
          {!sub && e.dt.critical && <span class="ec-pflicht">Pflicht</span>}
        </div>
        <div class="ec-meta">
          {cur ? (
            <>
              <span class={`ec-valid ${TONE[status]}`}>{validText(cur, e)}</span>
              <a href={`/eigen-compliance/version/${cur.id}`}>ändern</a>
              <span>{cur.file_name}</span>
              {cur.checked_by ? (
                <span>
                  geprüft von {cur.checked_by} am {dateDe(cur.checked_on)}
                </span>
              ) : (
                <form
                  method="post"
                  action={`/eigen-compliance/version/${cur.id}/geprueft`}
                  class="inline-form"
                >
                  <button class="linkbtn">als geprüft markieren</button>
                </form>
              )}
            </>
          ) : (
            <span>noch nicht hochgeladen</span>
          )}
        </div>
        {archive.length > 0 && (
          <details class="ec-arch">
            <summary>Archiv ({archive.length})</summary>
            {archive.map((a) => (
              <div>
                <a href={`/eigen-compliance/datei/${a.id}`} target="_blank">
                  {a.file_name ?? 'Datei'}
                </a>
                {expiresOf(a, e.dt) && ` · war gültig bis ${dateDe(expiresOf(a, e.dt))}`}
                {a.superseded_at &&
                  ` · archiviert ${a.superseded_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })}`}
              </div>
            ))}
          </details>
        )}
      </div>
      <span class={`badge ${missingTone}`}>{EC_STATUS_LABEL[status]}</span>
      <div class="ec-acts">
        {!sub && e.dt.template && (
          <a
            class="btn sm sec"
            href={`/eigen-compliance/vorlage/${e.dt.id}.pdf`}
            target="_blank"
            title="Vorlage mit Briefkopf"
          >
            Vorlage
          </a>
        )}
        {cur && (
          <a class="btn sm sec" href={`/eigen-compliance/datei/${cur.id}`} target="_blank">
            Ansehen
          </a>
        )}
        <UploadBtn k={e.dt.id} slot={slot} label={cur ? 'Ersetzen' : 'Hochladen'} primary={!cur} />
        {sub && (
          <form method="post" action={`/eigen-compliance/${e.dt.id}/eintrag-entfernen`} class="inline-form">
            <input type="hidden" name="name" value={slot} />
            <button
              class="btn sm danger"
              data-confirm={`„${slot}“ entfernen? Hochgeladene Dateien bleiben im Archiv.`}
              title="entfernen"
            >
              ✕
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Eigen-Compliance wie die alte App: Nachweise, Prüfung, Report. */
export function registerEigenComplianceRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/eigen-compliance', async (c) => {
    const f = c.req.query('filter') ?? '';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const { entries, sum } = await ecOverview(sql);
    const fits = (e: EcEntry) =>
      (!f || e.bucket === f) &&
      (!q || e.dt.name.toLowerCase().includes(q) || e.dt.cat.toLowerCase().includes(q));
    const overall =
      sum.crit > 0
        ? ['err', `${sum.crit} kritisch`]
        : sum.warn > 0
          ? ['warn', `${sum.warn} Hinweis(e)`]
          : ['ok', 'Vollständig'];
    const tile = (key: string, num: number, lbl: string, tone: string, title: string) => (
      <a
        class={`stat-card${tone ? ` tone-${tone}` : ''}${f === key ? ' on' : ''}`}
        href={`/eigen-compliance${key && f !== key ? `?filter=${key}` : ''}`}
        title={title}
      >
        <div class="stat-num">{num}</div>
        <div class="stat-lbl">{lbl}</div>
      </a>
    );
    const shown = entries.filter(fits);
    return page(
      c,
      'Eigen-Compliance',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class={`eyebrow ec-${overall[0]}`}>
              ● {overall[1]} · {sum.ok}/{EC_DOCS.length} gültig
            </div>
            <h1>Eigen-Compliance – Nachweise</h1>
            <div class="sub">
              Eigene Bescheinigungen, Handelsregister &amp; Unbedenklichkeiten – wie beim Nachunternehmer, nur
              für uns selbst.
            </div>
          </div>
          <div class="acts">
            <a class="btn sec" href="/eigen-compliance/pruefung">
              Prüfung
            </a>
            <a class="btn" href="/eigen-compliance/report">
              Report für Zoll
            </a>
          </div>
        </div>
        <EcTabs active="nachweise" />
        <div class="stat-grid">
          {tile('', EC_DOCS.length, 'Nachweise', '', 'Alle anzeigen')}
          {tile('crit', sum.crit, 'Kritisch', 'err', 'Pflichtnachweis fehlt oder ist abgelaufen')}
          {tile('warn', sum.warn, 'Läuft ab', 'warn', 'Läuft demnächst ab oder Datum fehlt')}
          {tile('ok', sum.ok, 'Gültig', 'ok', 'Vorhanden und gültig')}
        </div>
        <form class="toolbar" method="get" action="/eigen-compliance">
          {f && <input type="hidden" name="filter" value={f} />}
          <input class="search-input" type="search" name="q" value={q} placeholder="Nachweis suchen …" />
        </form>
        {shown.length === 0 && <div class="empty">Kein Nachweis passt zu dieser Auswahl.</div>}
        {EC_CATS.map((cat) => {
          const list = shown.filter((e) => e.dt.cat === cat);
          if (!list.length) return null;
          const all = entries.filter((e) => e.dt.cat === cat);
          const okN = all.filter((e) => e.status === 'valid').length;
          const dot = all.some((e) => e.bucket === 'crit')
            ? 'err'
            : all.some((e) => e.bucket === 'warn')
              ? 'warn'
              : 'ok';
          return (
            <details class="ec-group" open>
              <summary>
                <span class="ec-cat">{cat}</span>
                <span class={`ec-dot ${dot}`} />
                <span class="small mut">
                  {okN}/{all.length}
                </span>
              </summary>
              {list.map((e) => {
                if (!e.dt.multi) {
                  const it = e.items[0]!;
                  return <Row e={e} slot="" cur={it.current} archive={it.archive} status={it.status} />;
                }
                const cfg = EC_MULTI[e.dt.multi];
                const quick = cfg.quick.filter(
                  (n) => !e.items.some((i) => i.slot.toLowerCase().includes(n.toLowerCase())),
                );
                return (
                  <div class="ec-multi">
                    <div class="ec-doc">
                      <div class="ec-main">
                        <div class="ec-name">
                          {e.dt.name}
                          {e.dt.critical && <span class="ec-pflicht">Pflicht</span>}
                        </div>
                      </div>
                      <span class={`badge ${e.items.length ? TONE[e.status] : 'err'}`}>
                        {e.items.length ? EC_STATUS_LABEL[e.status] : 'Fehlt'}
                      </span>
                      <div class="ec-acts" />
                    </div>
                    {e.items.map((i) => (
                      <Row e={e} slot={i.slot} cur={i.current} archive={i.archive} status={i.status} sub />
                    ))}
                    <div class="ec-add">
                      {quick.map((n) => (
                        <form
                          method="post"
                          action={`/eigen-compliance/${e.dt.id}/eintrag`}
                          class="inline-form"
                        >
                          <input type="hidden" name="name" value={n} />
                          <button class="btn sm sec">+ {n}</button>
                        </form>
                      ))}
                      <form method="post" action={`/eigen-compliance/${e.dt.id}/eintrag`} class="inline-form">
                        <input
                          name="name"
                          placeholder={`${cfg.label} (Name)`}
                          required
                          aria-label={cfg.label}
                        />
                        <button class="btn sm sec">+ {cfg.label}</button>
                      </form>
                    </div>
                  </div>
                );
              })}
            </details>
          );
        })}
      </div>,
    );
  });

  const file = async (b: Record<string, unknown>) => {
    const f = Array.isArray(b.datei) ? b.datei[0] : b.datei;
    if (!(f instanceof File) || !f.size) throw new BusinessError('Bitte eine Datei auswählen');
    return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name || 'nachweis', type: f.type };
  };

  app.post('/eigen-compliance/:key/upload', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const id = await uploadVersion(
      deps,
      { key: c.req.param('key'), slot: str(b, 'slot') ?? '', file: await file(b) },
      c.get('actor'),
    );
    // wie die alte App: nach dem Hochladen direkt „Datum & Gültigkeit“
    return back(c, `/eigen-compliance/version/${id}?neu=1`, {
      ok: 'Hochgeladen – bitte Ausstellungsdatum prüfen.',
    });
  });

  app.post('/eigen-compliance/:key/eintrag', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await addSlot(sql, c.req.param('key'), str(b, 'name') ?? '');
    return back(c, '/eigen-compliance', { ok: 'Eintrag angelegt.' });
  });

  app.post('/eigen-compliance/:key/eintrag-entfernen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await removeSlot(sql, c.req.param('key'), str(b, 'name') ?? '');
    return back(c, '/eigen-compliance', { ok: 'Eintrag entfernt (Dateien bleiben im Archiv).' });
  });

  app.get(`/eigen-compliance/version/:id{${UUID}}`, async (c) => {
    const v = await getVersion(sql, c.req.param('id'));
    if (!v) return c.notFound();
    const dt = EC_DOCS.find((d) => d.id === v.doc_key)!;
    const g = validityOf(v, dt);
    const preview = (() => {
      const exp = expiresOf(v, dt);
      return g === '0' ? 'Kein Ablaufdatum.' : exp ? `Gültig bis ${dateDe(exp)}` : '';
    })();
    return page(
      c,
      'Datum & Gültigkeit',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/eigen-compliance">Eigen-Compliance</a>
            </div>
            <h1>Datum &amp; Gültigkeit</h1>
            <div class="sub">
              Nachweis <b>{dt.name}</b>
              {v.slot && ` · ${v.slot}`} · {v.file_name}
            </div>
          </div>
        </div>
        <form method="post" action={`/eigen-compliance/version/${v.id}`} class="card" style="max-width:560px">
          <input type="hidden" name="version" value={String(v.version)} />
          <label for="ausstell">Ausgestellt am (von wann ist der Nachweis?)</label>
          <input
            id="ausstell"
            type="date"
            name="ausstell"
            max={todayBerlin()}
            value={v.issued_on ?? todayBerlin()}
          />
          <label for="guelt">Wie lange gültig?</label>
          <select id="guelt" name="guelt" data-nosearch>
            {VALIDITY_OPTS.map(([k, l]) => (
              <option value={k} selected={g === k}>
                {l}
                {String(dt.validMonths) === k ? ' (Standard)' : ''}
              </option>
            ))}
          </select>
          <div>
            <label for="bis">Gültig bis (Datum von Hand)</label>
            <input id="bis" type="date" name="bis" value={v.expires_on ?? ''} />
          </div>
          <p class="small" style="color:var(--brand);font-weight:600" id="ec-vorschau">
            {preview}
          </p>
          <div class="formfoot">
            <button class="btn">Übernehmen</button>
            <a class="btn sec" href="/eigen-compliance">
              {c.req.query('neu') ? 'Später' : 'Abbrechen'}
            </a>
          </div>
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var a=document.getElementById('ausstell'),g=document.getElementById('guelt'),m=document.getElementById('bis'),w=m.parentElement,p=document.getElementById('ec-vorschau');
function f(d){return d.split('-').reverse().join('.')}
function u(){w.hidden=g.value!=='manuell';if(g.value==='0'){p.textContent='Kein Ablaufdatum.';return}
if(g.value==='manuell'){p.textContent=m.value?'Gültig bis '+f(m.value):'';return}
if(!a.value){p.textContent='';return}var x=a.value.split('-').map(Number),d=new Date(Date.UTC(x[0],x[1]-1+Number(g.value),1)),l=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(x[2],l));p.textContent='Gültig bis '+f(d.toISOString().slice(0,10))}
[a,g,m].forEach(function(e){e.addEventListener('change',u)});u()})();`,
          }}
        />
      </div>,
    );
  });

  app.post(`/eigen-compliance/version/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await setValidity(
      sql,
      c.req.param('id'),
      {
        issuedOn: str(b, 'ausstell'),
        validity: str(b, 'guelt') ?? '12',
        expiresOn: str(b, 'bis'),
        expectedVersion: str(b, 'version') ? Number(str(b, 'version')) : null,
      },
      c.get('actor'),
    );
    return back(c, '/eigen-compliance', { ok: 'Datum übernommen.' });
  });

  app.post(`/eigen-compliance/version/:id{${UUID}}/geprueft`, async (c) => {
    await markChecked(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/eigen-compliance', { ok: 'Als geprüft markiert.' });
  });

  app.get(`/eigen-compliance/datei/:id{${UUID}}`, async (c) => {
    const v = await getVersion(sql, c.req.param('id'));
    if (!v) return c.notFound();
    return new Response(await deps.archive.get(v.file_path), {
      headers: {
        'Content-Type': v.file_type ?? 'application/octet-stream',
        'Content-Disposition': `inline; filename="${(v.file_name ?? 'nachweis').replace(/[^\w.\- ]/g, '_')}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  app.get('/eigen-compliance/vorlage/:file{[a-z]+\\.pdf}', async (c) => {
    const key = c.req.param('file').replace(/\.pdf$/, '');
    return new Response(await templatePdf(sql, key), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Vorlage_${key}.pdf"`,
      },
    });
  });

  // ------------------------------------------------------------------ Prüfung
  app.get('/eigen-compliance/pruefung', async (c) => {
    const { map, last } = await getChecks(sql);
    const done = EC_CHECKS.filter((x) => map.get(x.id)?.status).length;
    const meta = last
      ? `Zuletzt abgeschlossen von ${last.reviewed_by} am ${last.reviewed_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })}`
      : 'Noch nicht abgeschlossen';
    return page(
      c,
      'Eigen-Compliance – Prüfung',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              {done}/{EC_CHECKS.length} geprüft · {meta}
            </div>
            <h1>Eigen-Compliance – Prüfung</h1>
            <div class="sub">Checkliste für die interne Selbstprüfung – von Kollegen auszufüllen.</div>
          </div>
        </div>
        <EcTabs active="pruefung" />
        <form method="post" action="/eigen-compliance/pruefung" class="ec-checks">
          {EC_CHECKS.map((x) => {
            const r = map.get(x.id);
            return (
              <div class="ec-chk">
                <div class="ec-chk-txt">{x.text}</div>
                <div class="seg">
                  {(
                    [
                      ['ja', 'Ja'],
                      ['nein', 'Nein'],
                      ['na', 'N/A'],
                    ] as const
                  ).map(([v, l]) => (
                    <label class={`chk-${v}`}>
                      <input type="radio" name={`s_${x.id}`} value={v} checked={r?.status === v} />
                      <span>{l}</span>
                    </label>
                  ))}
                </div>
                <input
                  name={`n_${x.id}`}
                  value={r?.note ?? ''}
                  placeholder="Bemerkung"
                  aria-label="Bemerkung"
                />
              </div>
            );
          })}
          <div class="formfoot">
            <button class="btn sec" name="aktion" value="speichern">
              Speichern
            </button>
            <button
              class="btn"
              name="aktion"
              value="abschliessen"
              data-confirm="Prüfung abschließen? Der Stand wird festgehalten."
            >
              Prüfung abschließen
            </button>
          </div>
        </form>
      </div>,
    );
  });

  app.post('/eigen-compliance/pruefung', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveChecks(
      sql,
      EC_CHECKS.map((x) => ({ id: x.id, status: str(b, `s_${x.id}`), note: str(b, `n_${x.id}`) })),
      c.get('actor'),
    );
    if (str(b, 'aktion') === 'abschliessen') {
      await finishReview(sql, c.get('actor'));
      return back(c, '/eigen-compliance/pruefung', { ok: 'Prüfung abgeschlossen.' });
    }
    return back(c, '/eigen-compliance/pruefung', { ok: 'Gespeichert.' });
  });

  // ------------------------------------------------------------------ Report
  app.get('/eigen-compliance/report', async (c) => {
    const [{ sum }, { map }] = await Promise.all([ecOverview(sql), getChecks(sql)]);
    const done = EC_CHECKS.filter((x) => map.get(x.id)?.status).length;
    const row = (l: string, v: Child, tone = '') => (
      <div class="ec-rc">
        <span>{l}</span>
        <b class={tone}>{v}</b>
      </div>
    );
    return page(
      c,
      'Eigen-Compliance – Report',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Zur Vorlage bei Zoll / FKS und Auftraggebern</div>
            <h1>Eigen-Compliance – Report</h1>
            <div class="sub">Gebündeltes PDF mit Briefkopf: Nachweis-Status + Prüfergebnis.</div>
          </div>
          <div class="acts">
            <a class="btn" href="/eigen-compliance/report.pdf" target="_blank">
              Report-PDF erstellen
            </a>
          </div>
        </div>
        <EcTabs active="report" />
        <div class="card" style="max-width:640px">
          {row('Nachweise gültig', `${sum.ok} / ${EC_DOCS.length}`)}
          {row('Kritisch (Pflicht fehlt/abgelaufen)', sum.crit, sum.crit ? 'kb-neg' : 'kb-pos')}
          {row('Hinweise (läuft bald ab)', sum.warn, sum.warn ? 'ec-warn' : 'kb-pos')}
          {row('Checkliste geprüft', `${done} / ${EC_CHECKS.length}`)}
          <p class="small mut" style="margin:14px 0 0">
            Das PDF enthält Briefkopf, Firmenangaben, eine Tabelle aller Nachweise mit Status und „gültig bis“
            sowie das Ergebnis der Selbstprüfung mit Unterschriftsfeld. Geeignet zur Übergabe an die
            Finanzkontrolle Schwarzarbeit (Zoll) oder an Auftraggeber.
          </p>
        </div>
      </div>,
    );
  });

  app.get('/eigen-compliance/report.pdf', async (c) => {
    void c;
    return new Response(await reportPdf(sql), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Compliance-Nachweis_${todayBerlin()}.pdf"`,
      },
    });
  });
}
