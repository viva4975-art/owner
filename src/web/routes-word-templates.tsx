import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { BusinessError } from '../services/errors.js';
import {
  AUDIENCE_LABEL,
  type Audience,
  PLACEHOLDERS,
  PLACEHOLDER_HINT,
  getTemplateFor,
  isDateKey,
  isoOfDe,
  templateValues,
  type WordTarget,
  type WordTemplate,
  generateFromWordTemplate,
  importWordTemplates,
  listWordTemplates,
  updateWordTemplate,
} from '../services/word-templates.js';
import type { Context } from 'hono';
import { type AppEnv, type Ctx, UUID } from './app.js';
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
  <form method="get" action="/word-vorlagen/ausfuellen" class="card">
    <h3 style="margin-top:0">Aus Word-Vorlage erstellen</h3>
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
          Name, Anschrift, Personalnummer usw. werden eingesetzt. Im nächsten Schritt Daten wie Beginn,
          Unterschriftsdatum oder neue Stunden prüfen bzw. auswählen; danach wird die Word-Datei hier
          abgelegt.
        </p>
        <div class="actions" style="margin-bottom:0">
          <button class="btn sm">Weiter: Angaben prüfen</button>
          <a class="small" href="/einstellungen/word-vorlagen">
            Vorlagen verwalten
          </a>
        </div>
      </>
    )}
  </form>
);

const GroupFields: FC<{ g: string; keys: string[]; values: Record<string, string> }> = ({
  g,
  keys,
  values,
}) => (
  <>
    <h3 style="margin:16px 0 6px">{g}</h3>
    <div class="grid">
      {keys
        .filter((k) => k.startsWith(`${g}.`))
        .map((k) => {
          const v = values[k] ?? '';
          return (
            <div>
              <label for={`f-${k}`}>{k.slice(g.length + 1)}</label>
              {isDateKey(k) ? (
                <input id={`f-${k}`} type="date" name={`v:${k}`} value={isoOfDe(v)} />
              ) : (
                <input id={`f-${k}`} name={`v:${k}`} value={v} />
              )}
              {PLACEHOLDER_HINT[k] && <div class="small mut">{PLACEHOLDER_HINT[k]}</div>}
            </div>
          );
        })}
    </div>
  </>
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
      ok: `${r.created.length} Vorlage(n) übernommen${r.replaced.length ? `, ${r.replaced.length} ältere Fassung(en) deaktiviert` : ''}${r.existing.length ? `, ${r.existing.length} schon vorhanden` : ''}${r.skipped.length ? `, übersprungen: ${r.skipped.join(', ')}` : ''}.`,
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

  // Zugriff wie die Akte selbst (Personalakte nur Personal/Admin, Objekt der Objektleitung nur eigene)
  const allowed = (c: Context<AppEnv>, type: WordTarget['type'], id: string) => {
    const user = c.get('user');
    if (!user || !canAccess(user.role, TARGET_PAGE[type](id))) return false;
    const scope = c.get('sites');
    return !(type === 'site' && scope && !scope.includes(id));
  };

  // ------------------------------------------------------------ Schritt 2: Angaben prüfen / Daten auswählen
  app.get('/word-vorlagen/ausfuellen', async (c) => {
    const type = (c.req.query('target_type') ?? '') as WordTarget['type'];
    const id = c.req.query('target_id') ?? '';
    const templateId = c.req.query('template_id') ?? '';
    if (!(type in TARGET_PAGE) || !/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(templateId))
      throw new BusinessError('Bitte Vorlage und Datensatz wählen');
    if (!allowed(c, type, id)) return c.text('Keine Berechtigung', 403);
    const t = await getTemplateFor(sql, templateId, { type, id });
    const fileId = randomUUID();
    const { values } = await templateValues(sql, { type, id }, { actorName: c.get('user')!.name, fileId });
    const keys = t.placeholders;
    const ret = TARGET_PAGE[type](id);
    const title =
      type === 'employee'
        ? `${values['Mitarbeiter.Vorname']} ${values['Mitarbeiter.Nachname']}`
        : type === 'customer'
          ? values['Kunde.Name']
          : values['Objekt.Name'];
    // zuerst, was je Dokument gewählt wird (Daten, Vertrag, neue Werte), Stammdaten eingeklappt darunter
    const MASTER = new Set(['Mitarbeiter', 'Kunde', 'Objekt', 'Firma']);
    const ORDER = ['Dokument', 'Vertrag', 'Neu', 'Bisher'];
    const all = [...new Set(keys.map((k) => k.split('.')[0]!))];
    const rank = (g: string) => (ORDER.includes(g) ? ORDER.indexOf(g) : 10);
    const groups = all.filter((g) => !MASTER.has(g)).sort((a, b) => rank(a) - rank(b));
    const master = all.filter((g) => MASTER.has(g));
    return page(
      c,
      t.name,
      type === 'employee' ? 'personal' : type === 'customer' ? 'kunden' : 'objekte',
      <>
        <PageHead
          title={t.name}
          crumbs={[
            [title ?? 'Akte', ret],
            ['Vorlagen', '/vorlagen'],
          ]}
        />
        <form method="post" action="/word-vorlagen/erzeugen" class="card" style="max-width:860px">
          <input type="hidden" name="file_id" value={fileId} />
          <input type="hidden" name="target_type" value={type} />
          <input type="hidden" name="target_id" value={id} />
          <input type="hidden" name="template_id" value={t.id} />
          <p class="small mut" style="margin-top:0">
            Vorbelegt aus den Stammdaten – hier nur für dieses Dokument ändern (die Stammdaten bleiben
            unverändert). Leere Felder erscheinen im Dokument als Linie „__________“ zum Ausfüllen von Hand.
            Word-Datumsfelder werden fest auf das Dokumentdatum gesetzt (ändern sich beim Öffnen nicht mehr).
          </p>
          {keys.length === 0 && (
            <div class="empty">Diese Vorlage hat keine Platzhalter – sie wird unverändert abgelegt.</div>
          )}
          {groups.map((g) => (
            <GroupFields g={g} keys={keys} values={values} />
          ))}
          {master.length > 0 && (
            <details open={groups.length === 0}>
              <summary style="margin-top:14px">
                <b>Stammdaten</b>{' '}
                <span class="small mut">(vorbelegt: {master.join(', ')} – nur bei Bedarf ändern)</span>
              </summary>
              {master.map((g) => (
                <GroupFields g={g} keys={keys} values={values} />
              ))}
            </details>
          )}
          <div class="actions">
            <button class="btn">Dokument erstellen und ablegen</button>
            <a class="btn sec" href={ret}>
              Abbrechen
            </a>
          </div>
        </form>
      </>,
    );
  });

  // ------------------------------------------------------------ Vorlagen separat aufrufen
  app.get('/vorlagen', async (c) => {
    const role = c.get('user')!.role;
    const all = await listWordTemplates(sql);
    const aud = (Object.keys(AUDIENCE_LABEL) as Audience[]).filter((a) =>
      a === 'mitarbeiter' ? canAccess(role, '/personal') : a === 'nachunternehmer' ? false : true,
    );
    const [emps, custs, sites] = await Promise.all([
      aud.includes('mitarbeiter')
        ? sql<{ id: string; label: string }[]>`
            select id, last_name || ', ' || first_name || ' (' || personnel_no || ')' as label
              from app.employees order by status, last_name, first_name`
        : [],
      sql<{ id: string; label: string }[]>`
        select id, name || ' (' || customer_no || ')' as label from app.customers where not is_internal order by name`,
      sql<{ id: string; label: string }[]>`
        select s.id, s.name || ' (' || s.site_no || ') – ' || c.name as label
          from app.sites s join app.customers c on c.id = s.customer_id where s.active order by s.name`,
    ]);
    const recent = await sql<
      {
        at: Date;
        actor: string;
        entity: string;
        entity_id: string;
        details: { template?: string; file?: string };
      }[]
    >`
      select at, actor, entity, entity_id, details from app.audit_log where action = 'word_template'
       order by at desc limit 15`;
    const pick: Record<
      Audience,
      { type: WordTarget['type']; list: { id: string; label: string }[]; what: string }
    > = {
      mitarbeiter: { type: 'employee', list: emps, what: 'Mitarbeiter' },
      kunde: { type: 'customer', list: custs, what: 'Kunde' },
      objekt: { type: 'site', list: sites, what: 'Objekt' },
      nachunternehmer: { type: 'customer', list: [], what: 'Nachunternehmer' },
    };
    return page(
      c,
      'Vorlagen',
      'personal',
      <>
        <PageHead title="Vorlagen">
          {canAccess(role, '/einstellungen/word-vorlagen') && (
            <a class="btn sec" href="/einstellungen/word-vorlagen">
              Vorlagen verwalten / hochladen
            </a>
          )}
        </PageHead>
        <p class="mut" style="margin-top:-6px;max-width:900px">
          Vorlage wählen, Person bzw. Kunde/Objekt wählen, dann Daten (Beginn, Unterschriftsdatum, neue
          Stunden …) prüfen. Das fertige Dokument liegt danach in der Akte (Dokumente).
        </p>
        <div class="cols">
          <div>
            {aud.map((a) => {
              const list = all.filter((t) => t.audience === a);
              if (!list.length) return null;
              const p = pick[a];
              return (
                <form method="get" action="/word-vorlagen/ausfuellen" class="card">
                  <h3 style="margin-top:0">
                    {AUDIENCE_LABEL[a]} <span class="small mut">({list.length})</span>
                  </h3>
                  <input type="hidden" name="target_type" value={p.type} />
                  <label class="small" style="margin:0 0 4px">
                    Für {p.what}
                  </label>
                  <select name="target_id" required aria-label={p.what} style="max-width:420px">
                    <option value="">{p.what} wählen …</option>
                    {p.list.map((x) => (
                      <option value={x.id}>{x.label}</option>
                    ))}
                  </select>
                  <div style="margin-top:10px">
                    {list.map((t) => (
                      <div class="tpl-row">
                        <div class="tpl-n">
                          <b>{t.name}</b>
                          <div class="small mut">
                            {t.category}
                            {t.code ? ` · ${t.code}` : ''} ·{' '}
                            <a href={`/dateien/${t.file_id}`}>Original öffnen</a>
                          </div>
                        </div>
                        <button class="btn sm" name="template_id" value={t.id}>
                          Ausfüllen
                        </button>
                      </div>
                    ))}
                  </div>
                </form>
              );
            })}
            {all.length === 0 && <div class="empty">Noch keine Vorlagen hochgeladen.</div>}
          </div>
          <div>
            <div class="card">
              <h3 style="margin-top:0">Zuletzt erstellt</h3>
              {recent.length === 0 && <div class="small mut">Noch nichts erstellt.</div>}
              {recent
                .filter((r) =>
                  canAccess(role, TARGET_PAGE[r.entity as WordTarget['type']]?.(r.entity_id) ?? '/'),
                )
                .map((r) => (
                  <div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)">
                    <a href={`/dateien/${r.details.file}`}>{r.details.template}</a>
                    <div class="mut">
                      {r.at.toLocaleString('de-DE', {
                        timeZone: 'Europe/Berlin',
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}{' '}
                      · {r.actor} ·{' '}
                      <a href={TARGET_PAGE[r.entity as WordTarget['type']]?.(r.entity_id) ?? '#'}>Akte</a>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </>,
    );
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
    const overrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(b))
      if (k.startsWith('v:') && typeof v === 'string' && k.length < 90) overrides[k.slice(2)] = v;
    const { file, missing } = await generateFromWordTemplate(
      sql,
      cfg,
      {
        templateId: String(b.template_id ?? ''),
        target: { type, id },
        fileId,
        actorName: user.name,
        overrides,
      },
      c.get('actor'),
    );
    return back(c, ret, {
      ok: `„${file.original_name}“ erstellt und abgelegt${missing.length ? ` – ohne Wert (als Linie): ${missing.join(', ')}` : ''}.`,
    });
  });
}
