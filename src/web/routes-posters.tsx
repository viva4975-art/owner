/**
 * Einstellungen → Objektordner-Vorlagen → Aushänge (Ahmed 14.10.: „wo man den Text ändern, Sachen löschen oder
 * hinzufügen kann“). Firmenweit: Texte der Aushänge ändern, Schritte löschen/hinzufügen, Aushänge ausschalten,
 * eigene Aushänge anlegen; Vorschau mit dem ersten aktiven Objekt.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_POSTERS,
  PICTO_LABELS,
  PICTO_NAMES,
  POSTER_PLACEHOLDERS,
  type PosterColor,
  type PosterDef,
  type PosterStep,
} from '../pdf/posters.js';
import type { PictoName } from '../pdf/pictos.js';
import { BusinessError } from '../services/errors.js';
import { buildPostersPdf, getPosters, savePosters } from '../services/site-folder.js';
import { type Ctx } from './app.js';
import { PageHead } from './layout.js';

const BASE = '/einstellungen/objektordner/aushaenge';
const KEY = '[a-z0-9-]{2,40}';

const COLOR_LABEL = { rot: 'Rot', gelb: 'Gelb', blau: 'Blau', gruen: 'Grün' } as const;

export function registerPosterRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get(BASE, async (c) => {
    const list = await getPosters(sql);
    return page(
      c,
      'Aushänge',
      '',
      <>
        <PageHead
          title="Aushänge für den Putzraum"
          crumbs={[
            ['Einstellungen', '/einstellungen'],
            ['Objektordner-Vorlagen', '/einstellungen/objektordner'],
          ]}
        />
        <div class="card" style="max-width:980px">
          <p class="small mut" style="margin-top:0">
            Die Aushänge stehen je Objekt unter Objekt → Objektordner („Aushänge Putzraum“) und vorne im
            Objektordner-PDF. Texte gelten für alle Objekte; Objektdaten (Adresse, Objektleitung, Krankenhaus
            …) setzt die App selbst ein. Ausgeschaltete Aushänge werden nicht gedruckt.
          </p>
          <table>
            <thead>
              <tr>
                <th>Aushang</th>
                <th>Schritte</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr>
                  <td>
                    <a href={`${BASE}/${p.key}`}>
                      <b>{p.title}</b>
                    </a>
                    {!p.builtin && <span class="tag">eigener</span>}
                  </td>
                  <td>{p.steps.length}</td>
                  <td>
                    {p.active ? <span class="tag ok">wird gedruckt</span> : <span class="tag">aus</span>}
                  </td>
                  <td style="text-align:right;white-space:nowrap">
                    <a class="btn sec sm" href={`${BASE}/${p.key}/vorschau.pdf`} target="_blank">
                      Vorschau
                    </a>{' '}
                    <a class="btn sec sm" href={`${BASE}/${p.key}`}>
                      Bearbeiten
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form method="post" action={`${BASE}/neu`} class="actions">
            <button class="btn">+ Eigenen Aushang anlegen</button>
          </form>
        </div>
      </>,
    );
  });

  app.post(`${BASE}/neu`, async (c) => {
    const list = await getPosters(sql);
    const key = `eigen-${randomUUID().slice(0, 8)}`;
    list.push({
      key,
      kind: 'text',
      title: 'Neuer Aushang',
      icon: 'doc',
      intro: '',
      steps: [{ icon: 'check', title: 'Erster Schritt', text: '' }],
      dos: [],
      donts: [],
      note: '',
      active: false,
      builtin: false,
    });
    await savePosters(sql, list, c.get('actor'));
    return back(c, `${BASE}/${key}`, { ok: 'Aushang angelegt – Texte eintragen und einschalten.' });
  });

  app.get(`${BASE}/:key{${KEY}}`, async (c) => {
    const p = (await getPosters(sql)).find((x) => x.key === c.req.param('key'));
    if (!p) return c.notFound();
    const rows = [...p.steps];
    for (let i = 0; i < 3; i++) rows.push({ icon: 'check', title: '', text: '' });
    const iconSelect = (name: string, value: PictoName) => (
      <select name={name} aria-label="Symbol">
        {PICTO_NAMES.map((n) => (
          <option value={n} selected={n === value}>
            {PICTO_LABELS[n] ?? n}
          </option>
        ))}
      </select>
    );
    return page(
      c,
      p.title,
      '',
      <>
        <PageHead
          title={p.title}
          crumbs={[
            ['Einstellungen', '/einstellungen'],
            ['Objektordner-Vorlagen', '/einstellungen/objektordner'],
            ['Aushänge', BASE],
          ]}
        />
        <form method="post" action={`${BASE}/${p.key}`} class="card" style="max-width:1080px">
          <div class="grid">
            <label>
              Titel
              <input name="title" value={p.title} required maxlength={80} />
            </label>
            <label>
              Symbol im Kopf
              {iconSelect('icon', p.icon)}
            </label>
            <label>
              Einleitung
              <textarea name="intro" rows={2} maxlength={400}>
                {p.intro}
              </textarea>
            </label>
            <label>
              <input type="checkbox" name="active" value="1" checked={p.active} /> Aushang drucken (im
              Objektordner und bei „Aushänge Putzraum“)
            </label>
          </div>
          <h3>Schritte</h3>
          <p class="small mut">
            Leere Überschrift = Schritt wird gelöscht. Unten sind drei freie Zeilen zum Hinzufügen.
            Platzhalter:{' '}
            {POSTER_PLACEHOLDERS.map(([k, v]) => (
              <span title={v}>
                <code>{k}</code>{' '}
              </span>
            ))}
            – fehlt die Angabe beim Objekt, fällt die Zeile weg.
          </p>
          <table>
            <thead>
              <tr>
                <th style="width:30px">Nr.</th>
                <th style="width:150px">Symbol</th>
                <th style="width:230px">Überschrift</th>
                <th>Text</th>
                {p.kind === 'farben' && <th style="width:80px">Farbe</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((st, i) => (
                <tr>
                  <td>{i < p.steps.length ? i + 1 : '+'}</td>
                  <td>{iconSelect('s_icon', st.icon)}</td>
                  <td>
                    <input name="s_title" value={st.title} maxlength={80} aria-label="Überschrift" />
                  </td>
                  <td>
                    <textarea name="s_text" rows={2} maxlength={300} aria-label="Text">
                      {st.text}
                    </textarea>
                  </td>
                  {p.kind === 'farben' && (
                    <td>
                      <select name="s_color" aria-label="Farbe">
                        <option value="">–</option>
                        {Object.entries(COLOR_LABEL).map(([k, v]) => (
                          <option value={k} selected={st.color === k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:12px">
            <label>
              „So ist es richtig“ (eine Zeile je Punkt)
              <textarea name="dos" rows={4}>
                {p.dos.join('\n')}
              </textarea>
            </label>
            <label>
              „Niemals“ (eine Zeile je Punkt)
              <textarea name="donts" rows={4}>
                {p.donts.join('\n')}
              </textarea>
            </label>
          </div>
          <label>
            Hinweis unten
            <textarea name="note" rows={2} maxlength={500}>
              {p.note}
            </textarea>
          </label>
          {p.kind === 'notfall' && (
            <p class="small mut">
              Notrufnummern, Adresse und Kontakte (Objektleitung, Ersthelfer, Krankenhaus …) kommen aus den
              Objektangaben – die Schritte oben sind „Bei einem Unfall“.
            </p>
          )}
          {p.kind === 'farben' && (
            <p class="small mut">
              Die Dosiertabelle kommt aus den Angaben unter Objektordner-Vorlagen („Reinigungsmittel mit
              Dosierung“).
            </p>
          )}
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href={`${BASE}/${p.key}/vorschau.pdf`} target="_blank">
              Vorschau (PDF)
            </a>
          </div>
        </form>
        <form
          method="post"
          action={`${BASE}/${p.key}/zuruecksetzen`}
          class="actions"
          style="max-width:1080px"
        >
          {p.builtin ? (
            <button class="btn sec sm" data-confirm="Alle Änderungen an diesem Aushang verwerfen?">
              Auf Standardtext zurücksetzen
            </button>
          ) : (
            <button class="btn danger sm" data-confirm="Diesen Aushang löschen?">
              Aushang löschen
            </button>
          )}
        </form>
      </>,
    );
  });

  app.post(`${BASE}/:key{${KEY}}`, async (c) => {
    const key = c.req.param('key');
    const list = await getPosters(sql);
    const p = list.find((x) => x.key === key);
    if (!p) return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    const all = (k: string) => ([] as unknown[]).concat(b[k] ?? []).map((x) => String(x));
    const icons = all('s_icon');
    const texts = all('s_text');
    const colors = all('s_color');
    const icon = (v: string | undefined): PictoName =>
      PICTO_NAMES.includes(v as PictoName) ? (v as PictoName) : 'check';
    const isColor = (v: string | undefined): v is PosterColor =>
      v === 'rot' || v === 'gelb' || v === 'blau' || v === 'gruen';
    const steps: PosterStep[] = all('s_title')
      .map((title, i): PosterStep => {
        const color = colors[i];
        const st: PosterStep = { icon: icon(icons[i]), title, text: texts[i] ?? '' };
        if (isColor(color)) st.color = color;
        return st;
      })
      .filter((s) => s.title.trim());
    if (!one('title').trim()) throw new BusinessError('Titel fehlt');
    const lines = (k: string) => one(k).split(/\r?\n/);
    const next: PosterDef = {
      ...p,
      title: one('title'),
      icon: icon(one('icon')),
      intro: one('intro'),
      note: one('note'),
      active: one('active') === '1',
      steps,
      dos: lines('dos'),
      donts: lines('donts'),
    };
    await savePosters(
      sql,
      list.map((x) => (x.key === key ? next : x)),
      c.get('actor'),
    );
    return back(c, `${BASE}/${key}`, { ok: 'Aushang gespeichert.' });
  });

  app.post(`${BASE}/:key{${KEY}}/zuruecksetzen`, async (c) => {
    const key = c.req.param('key');
    const list = await getPosters(sql);
    const def = DEFAULT_POSTERS.find((x) => x.key === key);
    const next = def ? list.map((x) => (x.key === key ? { ...def } : x)) : list.filter((x) => x.key !== key);
    await savePosters(sql, next, c.get('actor'));
    return def
      ? back(c, `${BASE}/${key}`, { ok: 'Standardtext wiederhergestellt.' })
      : back(c, BASE, { ok: 'Aushang gelöscht.' });
  });

  app.get(`${BASE}/:key{${KEY}}/vorschau.pdf`, async (c) => {
    const key = c.req.param('key');
    const [s] = await sql<{ id: string }[]>`
      select s.id from app.sites s join app.customers cu on cu.id = s.customer_id
       where s.active and not cu.is_internal order by s.site_no limit 1`;
    if (!s) throw new BusinessError('Für die Vorschau wird mindestens ein aktives Objekt gebraucht');
    const r = await buildPostersPdf(deps, s.id, key);
    return c.body(r.pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      'Cache-Control': 'private, no-store',
    });
  });
}
