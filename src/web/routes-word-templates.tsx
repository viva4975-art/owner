import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { BusinessError } from '../services/errors.js';
import {
  AUDIENCE_LABEL,
  type Audience,
  PLACEHOLDERS,
  type WordTarget,
  type WordTemplate,
  generateFromWordTemplate,
  importWordTemplates,
  listWordTemplates,
  updateWordTemplate,
} from '../services/word-templates.js';
import { type Ctx, UUID } from './app.js';
import { PageHead } from './layout.js';
import { canAccess } from './permissions.js';
import { uploadConfig } from './routes-files.js';

const TARGET_PAGE: Record<WordTarget['type'], (id: string) => string> = {
  employee: (id) => `/personal/${id}/dokumente`,
  customer: (id) => `/kunden/${id}/dokumente`,
  site: (id) => `/objekte/${id}/dokumente`,
};

/** Kasten „Aus Word-Vorlage erstellen“ für Mitarbeiter-, Kunden- und Objekt-Dokumente. */
export const WordTemplateBox: FC<{ templates: WordTemplate[]; target: WordTarget }> = ({
  templates,
  target,
}) => (
  <form method="post" action="/word-vorlagen/erzeugen" class="card">
    <h3 style="margin-top:0">Aus Word-Vorlage erstellen</h3>
    <input type="hidden" name="file_id" value={randomUUID()} />
    <input type="hidden" name="target_type" value={target.type} />
    <input type="hidden" name="target_id" value={target.id} />
    {templates.length === 0 ? (
      <p class="small mut" style="margin:0">
        Noch keine Word-Vorlagen. Unter{' '}
        <a href="/einstellungen/word-vorlagen">Einstellungen → Word-Vorlagen</a> hochladen (einzelne .docx
        oder die ZIP mit allen Vorlagen).
      </p>
    ) : (
      <>
        <select name="template_id" required aria-label="Word-Vorlage">
          {templates.map((t) => (
            <option value={t.id}>
              {t.name} ({t.category})
            </option>
          ))}
        </select>
        <p class="small mut" style="margin:6px 0 0">
          Name, Anschrift, Personalnummer, Datum usw. werden eingesetzt; die Word-Datei wird hier abgelegt und
          kann geöffnet, gedruckt und unterschrieben werden.
        </p>
        <div class="actions" style="margin-bottom:0">
          <button class="btn sm">Erstellen und ablegen</button>
          <a class="small" href="/einstellungen/word-vorlagen">
            Vorlagen verwalten
          </a>
        </div>
      </>
    )}
  </form>
);

export function registerWordTemplateRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;
  const cfg = uploadConfig(ctx);

  app.get('/einstellungen/word-vorlagen', async (c) => {
    const all = await listWordTemplates(sql, undefined, true);
    const groups = (Object.keys(AUDIENCE_LABEL) as Audience[])
      .map((a) => [a, all.filter((t) => t.audience === a)] as const)
      .filter(([, l]) => l.length);
    return page(
      c,
      'Word-Vorlagen',
      '',
      <>
        <PageHead title="Word-Vorlagen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <div class="cols">
          <div>
            {all.length === 0 && <div class="empty">Noch keine Vorlagen hochgeladen.</div>}
            {groups.map(([a, list]) => (
              <div class="card">
                <h3 style="margin-top:0">
                  {AUDIENCE_LABEL[a]} <span class="mut small">({list.length})</span>
                </h3>
                <div class="tbl">
                  <table class="stack-m">
                    <thead>
                      <tr>
                        <th>Vorlage</th>
                        <th>für</th>
                        <th>Ablage als</th>
                        <th>aktiv</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((t) => (
                        <tr style={t.active ? '' : 'opacity:.55'}>
                          <td data-l="Vorlage">
                            <form
                              method="post"
                              action={`/einstellungen/word-vorlagen/${t.id}`}
                              id={`wt-${t.id}`}
                            />
                            <input
                              form={`wt-${t.id}`}
                              name="name"
                              value={t.name}
                              aria-label="Name"
                              style="min-width:240px;width:100%"
                            />
                            <div class="small mut">
                              {t.code ?? ''}
                              {t.placeholders.length
                                ? ` · ${t.placeholders.length} Platzhalter`
                                : ' · ohne Platzhalter (leeres Formular)'}{' '}
                              · <a href={`/dateien/${t.file_id}`}>Original</a>
                            </div>
                          </td>
                          <td data-l="für">
                            <select
                              form={`wt-${t.id}`}
                              name="audience"
                              aria-label="für"
                              data-nosearch
                              style="min-width:140px"
                            >
                              {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((x) => (
                                <option value={x} selected={x === t.audience}>
                                  {AUDIENCE_LABEL[x]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td data-l="Ablage als">
                            <input
                              form={`wt-${t.id}`}
                              name="category"
                              value={t.category}
                              aria-label="Ablage als"
                            />
                          </td>
                          <td data-l="aktiv">
                            <input
                              form={`wt-${t.id}`}
                              type="checkbox"
                              name="active"
                              checked={t.active}
                              aria-label="aktiv"
                            />
                          </td>
                          <td class="acts">
                            <button form={`wt-${t.id}`} class="btn sm sec">
                              Speichern
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
          <div>
            <form
              method="post"
              action="/einstellungen/word-vorlagen"
              enctype="multipart/form-data"
              class="card"
            >
              <h3 style="margin-top:0">Vorlagen hochladen</h3>
              <p class="small mut" style="margin-top:0">
                Einzelne Word-Dateien (.docx) oder eine ZIP mit Ordnern (z. B. „01_Vorlagen_Mitarbeiter“,
                „02_Vorlagen_Kunden“, „04_Vorlagen_Objekt“). Zielgruppe und Ablage werden aus Ordner,
                Dateiname und Platzhaltern erkannt und lassen sich danach ändern. Gleiche Datei zweimal =
                nichts doppelt.
              </p>
              <input type="file" name="dateien" multiple accept=".docx,.zip" required />
              <div class="actions">
                <button class="btn">Hochladen</button>
              </div>
            </form>
            <div class="card">
              <h3 style="margin-top:0">Platzhalter</h3>
              <p class="small mut" style="margin-top:0">
                Schreibweise wie in Fortytools, z. B. <code>{'${Mitarbeiter.Vorname}'}</code>. Unbekannte
                Platzhalter werden als Linie „__________“ ausgegeben.
              </p>
              {Object.entries(PLACEHOLDERS).map(([g, list]) => (
                <div class="small" style="margin-bottom:6px">
                  <b>{g}:</b> {list.map((k) => `\${${g}.${k}}`).join(' · ')}
                </div>
              ))}
              <p class="small mut">
                Hinweis: Kündigung, Aufhebungsvertrag und Befristung brauchen die Schriftform mit
                Originalunterschrift (§ 623 BGB, § 14 Abs. 4 TzBfG) – ausdrucken und auf Papier
                unterschreiben, nicht digital.
              </p>
            </div>
          </div>
        </div>
      </>,
    );
  });

  app.post('/einstellungen/word-vorlagen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const raw = b.dateien;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
    if (!list.length) throw new BusinessError('Bitte Dateien auswählen');
    const uploads = await Promise.all(
      list.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
    );
    const r = await importWordTemplates(sql, cfg, uploads, c.get('actor'));
    return back(c, '/einstellungen/word-vorlagen', {
      ok: `${r.created.length} Vorlage(n) übernommen${r.existing.length ? `, ${r.existing.length} schon vorhanden` : ''}${r.skipped.length ? `, übersprungen: ${r.skipped.join(', ')}` : ''}.`,
    });
  });

  app.post(`/einstellungen/word-vorlagen/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody();
    await updateWordTemplate(sql, c.req.param('id'), {
      name: String(b.name ?? ''),
      audience: String(b.audience ?? '') as Audience,
      category: String(b.category ?? ''),
      active: b.active === 'on',
    });
    return back(c, '/einstellungen/word-vorlagen', { ok: 'Gespeichert.' });
  });

  app.post('/word-vorlagen/erzeugen', async (c) => {
    const b = await c.req.parseBody();
    const type = String(b.target_type ?? '') as WordTarget['type'];
    const id = String(b.target_id ?? '');
    const fileId = String(b.file_id ?? '');
    if (!(type in TARGET_PAGE) || !/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(fileId))
      throw new BusinessError('Ungültige Anfrage');
    const ret = TARGET_PAGE[type](id);
    const user = c.get('user');
    // Rechte wie die Akte selbst (Personalakte nur Personal/Admin, Objekt der Objektleitung nur eigene)
    if (!user || !canAccess(user.role, ret)) return c.text('Keine Berechtigung', 403);
    const scope = c.get('sites');
    if (type === 'site' && scope && !scope.includes(id)) return c.text('Keine Berechtigung', 403);
    const { file, missing } = await generateFromWordTemplate(
      sql,
      cfg,
      { templateId: String(b.template_id ?? ''), target: { type, id }, fileId, actorName: user.name },
      c.get('actor'),
    );
    return back(c, ret, {
      ok: `„${file.original_name}“ erstellt und abgelegt${missing.length ? ` – ohne Wert (als Linie): ${missing.join(', ')}` : ''}.`,
    });
  });
}
