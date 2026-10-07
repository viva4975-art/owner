import { randomUUID } from 'node:crypto';
import { listWordTemplates } from '../services/word-templates.js';
import { WordTemplateBox } from './routes-word-templates.js';
import { monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  DOC_CATEGORIES,
  DOC_CHECKLIST,
  TEMPLATE_FIELDS,
  listEmployees,
  listTemplates,
  listWageLevels,
  saveTemplate,
  saveWageLevel,
} from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import { createFromTemplate, serialLetter } from '../services/hr-docs.js';
import { employeeCalendar } from '../services/hr-month.js';
import { requestsForEmployee } from '../services/sign-documents.js';
import { archiveLink, listFiles } from '../services/uploads.js';
import { type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { centsToInput, str } from './forms.js';
import { PageHead, euro } from './layout.js';
import { EmployeeCalendar } from './pages-hr.js';
import { uploadConfig } from './routes-files.js';

const shiftMonth = (m: string, n: number) => {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

/** Personal wie Fortytools: Dokumente je Mitarbeiter, Vorlagen/Serienbrief, Lohnstufen, Einsatzkalender. */
export function registerHrRoutes(ctx: Ctx) {
  const { app, deps, page, back, shells } = ctx;
  const { sql, env } = deps;
  const cfg = uploadConfig(ctx);

  // ------------------------------------------------------------ Dokumente je Mitarbeiter
  app.get(`/personal/:id{${UUID}}/dokumente`, (c) =>
    shells.employee!(c, 'dokumente', async (e) => {
      const kat = c.req.query('kategorie');
      const category = kat && DOC_CATEGORIES.includes(kat) ? kat : 'Personalunterlagen';
      const [files, templates, signs, wordTemplates] = await Promise.all([
        listFiles(sql, { type: 'employee', id: e.id }),
        listTemplates(sql),
        requestsForEmployee(sql, e.id),
        listWordTemplates(sql, 'mitarbeiter'),
      ]);
      // vorne nur aktuelle Unterlagen, ältere Fassungen im Archiv je Kategorie (abrufbar, nie gelöscht)
      const current = files.filter((f) => !f.archived_at);
      const catOf = (f: (typeof files)[number]) =>
        f.category && DOC_CATEGORIES.includes(f.category) ? f.category : f.category ? 'Weitere' : 'Sonstiges';
      const groups = [...DOC_CATEGORIES, 'Weitere']
        .map((k) => ({
          k,
          now: current.filter((f) => catOf(f) === k),
          old: files
            .filter((f) => f.archived_at && catOf(f) === k)
            .sort((a, b) => +b.archived_at! - +a.archived_at!),
        }))
        .filter((g) => g.now.length || g.old.length);
      const archForm = (fileId: string, aktion: 'archivieren' | 'zurueck', label: string) => (
        <form method="post" action={`/personal/${e.id}/dokumente/archiv`} style="display:inline">
          <input type="hidden" name="file_id" value={fileId} />
          <input type="hidden" name="aktion" value={aktion} />
          <button class="btn sm sec">{label}</button>
        </form>
      );
      const handovers = await sql<{ kind: string; n: number }[]>`
        select kind, count(*)::int as n from app.handovers
         where employee_id = ${e.id} and status in ('unterschrieben', 'ohne_unterschrift') group by kind`;
      const hoCount = (k: string) => handovers.find((h) => h.kind === k)?.n ?? 0;
      const has = (name: string) =>
        current.some((f) => f.category === name) ||
        (name === 'Arbeitskleidung' && hoCount('kleidung') > 0) ||
        (name === 'Schlüssel' && hoCount('schluessel') > 0);
      return (
        <div class="cols">
          <div>
            <div class="card">
              <h3 style="margin-top:0">Personalakte – Checkliste</h3>
              <div class="doc-check">
                {DOC_CHECKLIST.map((d) => (
                  <a
                    href={`/personal/${e.id}/dokumente?kategorie=${encodeURIComponent(d.name)}#hochladen`}
                    class={`dc ${has(d.name) ? 'ok' : d.required ? 'missing' : 'open'}`}
                  >
                    <span class="dc-i">{has(d.name) ? '✓' : d.required ? '!' : '–'}</span>
                    <span>
                      <b>{d.name}</b>{' '}
                      {d.required ? (
                        <span class="badge err">Pflicht</span>
                      ) : (
                        <span class="badge">optional</span>
                      )}
                      <div class="small mut">{has(d.name) ? 'vorhanden' : d.hint}</div>
                    </span>
                  </a>
                ))}
              </div>
            </div>
            <div class="card">
              <h3>Dokumente ({current.length})</h3>
              <p class="small mut" style="margin-top:-4px">
                Vorne stehen die aktuellen Unterlagen. Ändert sich etwas (z. B. neuer Vertrag, neuer
                Aufenthaltstitel): neue Fassung hochladen und die alte „ins Archiv“ legen – sie bleibt
                unverändert abrufbar.
              </p>
              {groups.length === 0 && <div class="empty">Noch keine Dokumente.</div>}
              {groups.map(({ k, now, old }) => (
                <>
                  <h4 style="margin:14px 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    {k}
                    {now.length > 1 && (
                      <form
                        method="post"
                        action={`/personal/${e.id}/dokumente/archiv`}
                        style="display:inline"
                      >
                        <input type="hidden" name="kategorie" value={k} />
                        <input type="hidden" name="aktion" value="aeltere" />
                        <button
                          class="btn sm sec"
                          onclick={`return confirm(${JSON.stringify(`Alle bis auf die neueste Datei in „${k}“ ins Archiv legen?`)})`}
                        >
                          ältere ins Archiv ({now.length - 1})
                        </button>
                      </form>
                    )}
                  </h4>
                  {now.length > 0 ? (
                    <FileArea
                      link={{ type: 'employee', id: e.id }}
                      files={now}
                      maxBytes={0}
                      listOnly
                      action={(f) => archForm(f.id, 'archivieren', 'ins Archiv')}
                    />
                  ) : (
                    <div class="small mut">Keine aktuelle Fassung – nur Archiv.</div>
                  )}
                  {old.length > 0 && (
                    <details class="doc-archive">
                      <summary class="small">Archiv ({old.length})</summary>
                      <FileArea
                        link={{ type: 'employee', id: e.id }}
                        files={old}
                        maxBytes={0}
                        listOnly
                        action={(f) => (
                          <>
                            <span class="small mut" style="white-space:nowrap">
                              archiviert{' '}
                              {(f as (typeof old)[number]).archived_at!.toLocaleDateString('de-DE', {
                                timeZone: 'Europe/Berlin',
                              })}
                            </span>
                            {archForm(f.id, 'zurueck', 'zurückholen')}
                          </>
                        )}
                      />
                    </details>
                  )}
                </>
              ))}
            </div>
            <div class="card" id="hochladen">
              <form method="get" action={`/personal/${e.id}/dokumente`} class="actions" style="margin-top:0">
                <label for="kategorie" class="small" style="margin:0">
                  Hochladen als
                </label>
                <select id="kategorie" name="kategorie" onchange="this.form.submit()" style="max-width:240px">
                  {DOC_CATEGORIES.map((k) => (
                    <option value={k} selected={k === category}>
                      {k}
                    </option>
                  ))}
                </select>
              </form>
              <FileArea
                link={{ type: 'employee', id: e.id }}
                files={[]}
                category={category}
                title={`${category} hierher ziehen`}
                maxBytes={env.UPLOAD_MAX_BYTES}
              />
            </div>
          </div>
          <div>
            <form method="post" action={`/personal/${e.id}/dokumente/vorlage`} class="card">
              <h3>Neu aus Vorlage</h3>
              <input type="hidden" name="file_id" value={randomUUID()} />
              <select name="vorlage" required aria-label="Vorlage">
                {templates.map((t) => (
                  <option value={t.id}>
                    {t.title} ({t.category})
                  </option>
                ))}
              </select>
              <div class="actions" style="margin-bottom:0">
                <button class="btn sm" disabled={!templates.length}>
                  Erstellen und ablegen
                </button>
                <a class="small" href="/personal/vorlagen">
                  Vorlagen bearbeiten
                </a>
              </div>
            </form>
            <WordTemplateBox templates={wordTemplates} target={{ type: 'employee', id: e.id }} />
            <div class="card">
              <h3>Zur Unterschrift (App)</h3>
              {signs.length === 0 && <div class="small mut">Keine Dokumente zur digitalen Unterschrift.</div>}
              {signs.map((r) => (
                <div class="small" style="padding:3px 0">
                  <a href={`/personal/dokumente/${r.document_id}`}>{r.title}</a> –{' '}
                  {r.status === 'unterschrieben'
                    ? `unterschrieben ${r.signed_at!.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}`
                    : 'offen'}
                </div>
              ))}
              <div class="small" style="margin-top:6px">
                <a href="/personal/dokumente">Dokument zur Unterschrift verteilen →</a>
              </div>
            </div>
          </div>
        </div>
      );
    }),
  );

  app.post(`/personal/:id{${UUID}}/dokumente/archiv`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const link = { type: 'employee', id } as const;
    const aktion = str(b, 'aktion');
    const actor = c.get('actor');
    if (aktion === 'aeltere') {
      const k = str(b, 'kategorie') ?? '';
      const files = (await listFiles(sql, link)).filter((f) => !f.archived_at);
      const inCat = files.filter((f) =>
        k === 'Weitere'
          ? f.category && !DOC_CATEGORIES.includes(f.category)
          : k === 'Sonstiges'
            ? (f.category ?? 'Sonstiges') === 'Sonstiges'
            : f.category === k,
      );
      // listFiles ist nach Fertigstellung absteigend sortiert → die erste ist die neueste
      for (const f of inCat.slice(1)) await archiveLink(sql, link, f.id, true, actor);
      return back(c, `/personal/${id}/dokumente`, {
        ok: `${Math.max(inCat.length - 1, 0)} ältere Datei(en) in „${k}“ ins Archiv gelegt.`,
      });
    }
    const fileId = str(b, 'file_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(fileId) || (aktion !== 'archivieren' && aktion !== 'zurueck'))
      throw new BusinessError('Ungültige Anfrage');
    const done = await archiveLink(sql, link, fileId, aktion === 'archivieren', actor);
    return back(c, `/personal/${id}/dokumente`, {
      ok: done
        ? aktion === 'archivieren'
          ? 'Ins Archiv gelegt – weiter abrufbar unter „Archiv“.'
          : 'Aus dem Archiv zurückgeholt.'
        : 'Keine Änderung.',
    });
  });

  app.post(`/personal/:id{${UUID}}/dokumente/vorlage`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const fileId = str(b, 'file_id') ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new BusinessError('Ungültige Anfrage');
    const f = await createFromTemplate(deps, cfg, fileId, str(b, 'vorlage') ?? '', id, c.get('actor'));
    return back(c, `/personal/${id}/dokumente`, { ok: `„${f.original_name}“ erstellt und abgelegt.` });
  });

  // ------------------------------------------------------------ Serienbrief
  app.get('/personal/serienbrief.pdf', async (c) => {
    const status = c.req.query('status') ?? 'aktiv';
    const q = c.req.query('q')?.trim() || null;
    const tag = c.req.query('tag')?.trim() || null;
    const rows = await listEmployees(sql, {
      ...(status === 'aktiv' || status === 'ausgetreten' ? { status } : {}),
      ...(q ? { q } : {}),
      ...(tag ? { tag } : {}),
    });
    const pdf = await serialLetter(
      deps,
      c.req.query('vorlage') ?? '',
      rows.map((r) => r.id),
    );
    await sql`insert into app.audit_log (actor, action, entity, details)
              values (${c.get('actor')}, 'serial_letter', 'employees', ${sql.json({ count: rows.length, tag, status })})`;
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Serienbrief_${todayBerlin()}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // ------------------------------------------------------------ Einsatzkalender
  app.get(`/personal/:id{${UUID}}/kalender`, (c) =>
    shells.employee!(c, 'kalender', async (e) => {
      const qm = c.req.query('monat');
      const month = qm && /^\d{4}-\d{2}$/.test(qm) ? qm : todayBerlin().slice(0, 7);
      monthBounds(month);
      const days = await employeeCalendar(sql, e.id, month);
      return (
        <div class="card">
          <EmployeeCalendar
            employeeId={e.id}
            month={month}
            days={days}
            prev={shiftMonth(month, -1)}
            next={shiftMonth(month, 1)}
          />
        </div>
      );
    }),
  );

  // ------------------------------------------------------------ Lohnstufen
  app.get('/personal/lohnstufen', async (c) => {
    const levels = await listWageLevels(sql, true);
    return page(
      c,
      'Tariflöhne',
      'personal',
      <>
        <PageHead title="Tariflöhne" crumbs={[['Einstellungen', '/einstellungen']]} />
        <p class="mut" style="max-width:820px">
          Stundenlohn je Lohngruppe (Tarifvertrag Gebäudereinigung). Bei jedem Mitarbeiter wird unter
          „Vergütung“ ein Tariflohn, ein individueller Stundenlohn oder ein Festgehalt gewählt. Eine Änderung
          hier gilt sofort für alle Mitarbeitenden der Lohngruppe (Nachkalkulation, Mindestlohn-Prüfung) – bei
          Tariferhöhung „gültig ab“ eintragen.
        </p>
        <div class="tbl" style="max-width:900px">
          <table>
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th class="r">€/Std.</th>
                <th>gültig ab</th>
                <th class="r">Mitarbeitende</th>
                <th>aktiv</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...levels, null].map((w) => {
                const wid = w?.id ?? randomUUID();
                const f = `wl-${wid.slice(0, 8)}`;
                return (
                  <tr>
                    <td>
                      <form id={f} method="post" action={`/personal/lohnstufen/${wid}`}></form>
                      <input type="hidden" form={f} name="version" value={String(w?.version ?? '')} />
                      <input
                        form={f}
                        name="name"
                        value={w?.name ?? ''}
                        placeholder="neue Lohngruppe, z. B. Tariflohn 2"
                        aria-label="Bezeichnung"
                      />
                    </td>
                    <td style="width:120px">
                      <input
                        form={f}
                        name="wage"
                        class="right"
                        value={w ? centsToInput(w.hourly_wage_cents) : ''}
                        placeholder="14,25"
                        aria-label="Stundenlohn"
                      />
                    </td>
                    <td style="width:160px">
                      <input
                        form={f}
                        type="date"
                        name="valid_from"
                        value={w?.valid_from ?? ''}
                        aria-label="gültig ab"
                      />
                    </td>
                    <td class="r">{w?.employees ?? ''}</td>
                    <td style="width:60px">
                      <input
                        type="checkbox"
                        form={f}
                        name="active"
                        checked={w ? w.active : true}
                        aria-label="aktiv"
                      />
                    </td>
                    <td style="width:110px">
                      <button class="btn sm sec" form={f}>
                        {w ? 'Speichern' : 'Anlegen'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {levels.length > 0 && (
          <p class="small mut">
            Aktuell niedrigste Stufe:{' '}
            {euro(
              levels.reduce(
                (a, w) => (w.hourly_wage_cents < a ? w.hourly_wage_cents : a),
                levels[0]!.hourly_wage_cents,
              ),
            )}{' '}
            – mit dem Branchen-Mindestlohn abgleichen.
          </p>
        )}
      </>,
    );
  });

  app.post(`/personal/lohnstufen/:wid{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    let cents: bigint;
    try {
      cents = parseEuro(str(b, 'wage') ?? '');
    } catch {
      throw new BusinessError('Stundenlohn bitte als Betrag, z. B. 14,25');
    }
    await saveWageLevel(sql, c.req.param('wid'), {
      name: str(b, 'name') ?? '',
      wageCents: cents,
      validFrom: str(b, 'valid_from'),
      note: null,
      active: b.active === 'on',
      expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
    });
    return back(c, '/personal/lohnstufen', { ok: 'Tariflohn gespeichert.' });
  });

  // ------------------------------------------------------------ Dokumentvorlagen
  app.get('/personal/vorlagen', async (c) => {
    const list = await listTemplates(sql, true);
    const editId = c.req.query('bearbeiten');
    const t = list.find((x) => x.id === editId) ?? null;
    const formId = t?.id ?? randomUUID();
    return page(
      c,
      'Dokumentvorlagen',
      'personal',
      <>
        <PageHead title="Dokumentvorlagen" crumbs={[['Mitarbeiter', '/personal']]} />
        <div class="cols">
          <div class="card">
            <h3>Vorlagen</h3>
            {list.map((x) => (
              <div style="padding:4px 0;border-bottom:1px solid var(--line)">
                <a href={`/personal/vorlagen?bearbeiten=${x.id}`}>{x.title}</a>{' '}
                <span class="small mut">
                  {x.category}
                  {!x.active && ' · inaktiv'}
                </span>
              </div>
            ))}
            <p class="small mut">
              Kündigungen, Aufhebungsverträge und Befristungen brauchen die Schriftform: ausdrucken und
              eigenhändig unterschreiben – nicht per App oder E-Mail.
            </p>
          </div>
          <form
            method="post"
            action={`/personal/vorlagen/${formId}`}
            class="card"
            data-version={String(t?.version ?? '')}
          >
            <h3 style="margin-top:0">{t ? `„${t.title}“ bearbeiten` : 'Neue Vorlage'}</h3>
            <input type="hidden" name="version" value={String(t?.version ?? '')} />
            <label for="title">Titel (Betreff)</label>
            <input id="title" name="title" value={t?.title ?? ''} required />
            <label for="category">Kategorie</label>
            <select id="category" name="category">
              {DOC_CATEGORIES.map((k) => (
                <option value={k} selected={k === (t?.category ?? 'Sonstiges')}>
                  {k}
                </option>
              ))}
            </select>
            <label for="body">
              Text (Anrede und Gruß werden automatisch gesetzt; Leerzeile = neuer Absatz)
            </label>
            <textarea id="body" name="body" rows={12} required>
              {t?.body ?? ''}
            </textarea>
            <p class="small mut">
              Platzhalter:{' '}
              {TEMPLATE_FIELDS.map(([k, v]) => (
                <span title={v} style="margin-right:6px">
                  <code>{`{{${k}}}`}</code>
                </span>
              ))}
            </p>
            <div class="chk">
              <input type="checkbox" id="active" name="active" checked={t ? t.active : true} />
              <label for="active">aktiv</label>
            </div>
            <div class="formfoot">
              {t && (
                <a class="btn sec" href="/personal/vorlagen">
                  Neue Vorlage
                </a>
              )}
              <button class="btn">Speichern</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/personal/vorlagen/:tid{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const cat = str(b, 'category') ?? 'Sonstiges';
    await saveTemplate(sql, c.req.param('tid'), {
      title: str(b, 'title') ?? '',
      category: DOC_CATEGORIES.includes(cat) ? cat : 'Sonstiges',
      body: typeof b.body === 'string' ? b.body : '',
      active: b.active === 'on',
      expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
    });
    return back(c, `/personal/vorlagen?bearbeiten=${c.req.param('tid')}`, { ok: 'Vorlage gespeichert.' });
  });
}
