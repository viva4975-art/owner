import { randomUUID } from 'node:crypto';
import { monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  DOC_CATEGORIES,
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
import { listFiles } from '../services/uploads.js';
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
      const [files, templates, signs] = await Promise.all([
        listFiles(sql, { type: 'employee', id: e.id }),
        listTemplates(sql),
        requestsForEmployee(sql, e.id),
      ]);
      const groups = DOC_CATEGORIES.map(
        (k) => [k, files.filter((f) => (f.category ?? 'Sonstiges') === k)] as const,
      )
        .concat([
          ['Weitere', files.filter((f) => f.category && !DOC_CATEGORIES.includes(f.category))] as const,
        ])
        .filter(([, list]) => list.length);
      return (
        <div class="cols">
          <div>
            <div class="card">
              <h3>Dokumente ({files.length})</h3>
              {groups.length === 0 && <div class="empty">Noch keine Dokumente.</div>}
              {groups.map(([k, list]) => (
                <>
                  <h4 style="margin:12px 0 4px">{k}</h4>
                  <FileArea link={{ type: 'employee', id: e.id }} files={list} maxBytes={0} listOnly />
                </>
              ))}
            </div>
            <div class="card">
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
      'Lohnstufen',
      'personal',
      <>
        <PageHead title="Lohnstufen" crumbs={[['Mitarbeiter', '/personal']]} />
        <p class="mut" style="max-width:820px">
          Stundenlohn je Lohnstufe (z. B. Tarif Gebäudereinigung Lohngruppe 1). Gilt für alle Mitarbeitenden
          der Stufe, außer bei individuellem Stundenlohn. Verwendet in Nachkalkulation und
          Mindestlohn-Prüfung.
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
                        placeholder="neue Lohnstufe"
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
    return back(c, '/personal/lohnstufen', { ok: 'Lohnstufe gespeichert.' });
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
