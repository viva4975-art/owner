import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { type EntityType, type Note, getNote, listNotes, saveNote } from '../services/crm.js';
import { listFiles } from '../services/uploads.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { dateDe } from './layout.js';

type Shell = (
  c: Context<AppEnv>,
  active: string,
  body: (e: { id: string }) => Promise<Child> | Child,
) => Promise<Response> | Response;

const short = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n).trimEnd()} …` : t);

/** Notizen wie Fortytools: Datum, Erfasser, Titel, Details, Anhänge, „+ Aufgabe“. */
export const NotesList: FC<{ base: string; notes: Note[] }> = ({ base, notes }) => (
  <>
    <div class="toolbar" style="margin-bottom:10px">
      <a class="btn" href={`${base}/notizen/neu`}>
        <Icon name="plus" size={14} /> Notiz anlegen
      </a>
    </div>
    <div class="tbl">
      <table class="notes-table">
        <thead>
          <tr>
            <th style="width:95px">Datum</th>
            <th style="width:150px">Erfasser</th>
            <th>Titel / Details</th>
            <th style="width:80px">Anhänge</th>
            <th style="width:150px" />
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => (
            <tr>
              <td>{dateDe(n.note_date)}</td>
              <td>
                {n.author}
                {n.updated_by && (
                  <div
                    class="small faint"
                    title={n.updated_at?.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
                  >
                    geändert: {n.updated_by}
                  </div>
                )}
              </td>
              <td>
                <a href={`${base}/notizen/${n.id}`}>
                  <b>{n.title ?? short(n.body, 60)}</b>
                </a>
                {n.title && n.body && (
                  <div class="small mut" style="white-space:pre-wrap">
                    {short(n.body)}
                  </div>
                )}
              </td>
              <td>
                {n.files > 0 ? (
                  <span title="Anhänge" class="ic-t">
                    <Icon name="clip" size={13} /> {n.files}
                  </span>
                ) : (
                  <span class="faint">–</span>
                )}
              </td>
              <td class="right">
                <a
                  class="small"
                  href={`${base}/aufgaben?titel=${encodeURIComponent(n.title ?? short(n.body, 60))}`}
                >
                  + Aufgabe hinzufügen
                </a>
              </td>
            </tr>
          ))}
          {!notes.length && (
            <tr>
              <td colspan={5} class="mut">
                Noch keine Notizen.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </>
);

/**
 * Routen für Notizen eines Datensatzes (Kunde, Objekt, Mitarbeiter): Liste, Anlegen/Ändern, Anhänge.
 * `base` z. B. „/objekte“, die Seiten liegen dann unter /objekte/:id/notizen[/:nid].
 */
export function registerNoteRoutes(ctx: Ctx, base: string, type: EntityType, shell: Shell) {
  const { app, deps, back } = ctx;
  const { sql, env } = deps;

  app.get(`${base}/:id{${UUID}}/notizen`, (c) =>
    shell(c, 'notizen', async (e) => (
      <NotesList base={`${base}/${e.id}`} notes={await listNotes(sql, type, e.id)} />
    )),
  );

  app.get(`${base}/:id{${UUID}}/notizen/neu`, (c) =>
    c.redirect(`${base}/${c.req.param('id')}/notizen/${randomUUID()}`),
  );

  app.get(`${base}/:id{${UUID}}/notizen/:nid{${UUID}}`, (c) =>
    shell(c, 'notizen', async (e) => {
      const nid = c.req.param('nid');
      const n = await getNote(sql, nid);
      if (n && (n.entity_type !== type || n.entity_id !== e.id))
        return <div class="empty">Notiz nicht gefunden.</div>;
      const self = `${base}/${e.id}/notizen/${nid}`;
      const files = n ? await listFiles(sql, { type: 'note', id: nid }) : [];
      return (
        <>
          <p>
            <a href={`${base}/${e.id}/notizen`}>‹ alle Notizen</a>
          </p>
          <form method="post" action={self} data-autosave={self}>
            <h3 class="panel-title">{n ? 'Notiz bearbeiten' : 'Neue Notiz'}</h3>
            <input type="hidden" name="version" value={n ? String(n.version) : ''} />
            <div class="grid">
              <div>
                <label for="note_date">Datum</label>
                <input
                  id="note_date"
                  name="note_date"
                  type="date"
                  value={n?.note_date ?? todayBerlin()}
                  required
                />
              </div>
              <div>
                <label>Erfasser</label>
                <div>
                  {n ? n.author : <span class="mut">{c.get('actor')} (Sie)</span>}
                  {n?.updated_by && <span class="small faint"> · zuletzt geändert von {n.updated_by}</span>}
                </div>
              </div>
              <div>
                <label for="title">Titel</label>
                <input
                  id="title"
                  name="title"
                  value={n?.title ?? ''}
                  placeholder="z. B. Telefonat Hausverwaltung"
                />
              </div>
              <div>
                <label for="body">Details</label>
                <textarea id="body" name="body" rows={6}>
                  {n?.body ?? ''}
                </textarea>
              </div>
            </div>
            <div class="actions">
              <button class="btn">{n ? 'Speichern' : 'Notiz anlegen'}</button>
              {n && (
                <a
                  class="btn sec"
                  href={`${base}/${e.id}/aufgaben?titel=${encodeURIComponent(n.title ?? short(n.body, 60))}`}
                >
                  + Aufgabe hinzufügen
                </a>
              )}
            </div>
          </form>
          <h3 class="panel-title" style="margin-top:18px">
            Anhänge
          </h3>
          {n ? (
            <FileArea
              link={{ type: 'note', id: nid }}
              files={files}
              maxBytes={env.UPLOAD_MAX_BYTES}
              title="Anhänge hierher ziehen"
            />
          ) : (
            <p class="mut">Anhänge können nach dem Anlegen der Notiz hinzugefügt werden.</p>
          )}
        </>
      );
    }),
  );

  app.post(`${base}/:id{${UUID}}/notizen/:nid{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const nid = c.req.param('nid');
    const body = await c.req.parseBody({ all: true });
    const v = str(body, 'version');
    const existed = !!(await getNote(sql, nid));
    await saveNote(
      sql,
      nid,
      type,
      id,
      {
        date: str(body, 'note_date') ?? todayBerlin(),
        title: str(body, 'title'),
        body: str(body, 'body') ?? '',
        expectedVersion: v ? Number(v) : null,
      },
      c.get('actor'),
    );
    return back(c, `${base}/${id}/notizen/${nid}`, {
      ok: existed ? 'Notiz gespeichert.' : 'Notiz angelegt – Anhänge können jetzt hinzugefügt werden.',
    });
  });
}
