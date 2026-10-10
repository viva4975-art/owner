import { LEGACY_IMPORT_ID, analyzeBackup, applyBackup, loadBackupBytes } from '../services/legacy-import.js';
import { listFiles } from '../services/uploads.js';
import type { Ctx } from './app.js';
import { FileArea } from './files.js';
import { arr } from './forms.js';
import { fileSize } from './layout.js';
import { uploadConfig } from './routes-files.js';

const LINK = { type: 'legacy_import' as const, id: LEGACY_IMPORT_ID };

/** Transfer → Import aus der alten App (Backup-ZIP hochladen, prüfen, übernehmen). */
export function registerLegacyRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;
  const cfg = uploadConfig(ctx);

  app.get('/transfer/altdaten', async (c) => {
    const files = await listFiles(sql, LINK);
    return page(
      c,
      'Import aus alter App',
      'transfer',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Transfer</div>
            <h1>Import aus der alten App</h1>
            <div class="sub">
              Backup-ZIP hochladen, prüfen, Bereiche übernehmen – doppelt übernehmen legt nichts doppelt an.
            </div>
          </div>
        </div>
        <div class="cols">
          <div class="card">
            <h3>1. Backup hochladen</h3>
            <p class="small mut">
              In der alten App unter Einstellungen → Backup die ZIP-Datei erstellen und hier hochladen. Wurde
              sie in Teile zerlegt (backup-teil-aa, -ab …), alle Teile hochladen und unten gemeinsam
              auswählen.
            </p>
            <FileArea
              link={LINK}
              files={[]}
              title="Backup-ZIP hierher ziehen"
              maxBytes={deps.env.UPLOAD_MAX_BYTES}
            />
          </div>
          <form method="get" action="/transfer/altdaten/pruefen" class="card">
            <h3>2. Dateien auswählen und prüfen</h3>
            {files.length === 0 ? (
              <p class="small mut">Noch nichts hochgeladen.</p>
            ) : (
              <ul class="files" style="margin:0 0 12px">
                {files.map((f) => (
                  <li class="done">
                    <label style="display:flex;gap:10px;align-items:center;margin:0;width:100%">
                      <input type="checkbox" name="d" value={f.id} checked />
                      <span style="flex:1">
                        <b>{f.original_name}</b>
                        <span class="small mut">
                          {' '}
                          · {fileSize(Number(f.size_bytes))} ·{' '}
                          {f.completed_at?.toLocaleString('de-DE', {
                            timeZone: 'Europe/Berlin',
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div class="formfoot">
              <button class="btn" disabled={!files.length}>
                Prüfen
              </button>
            </div>
          </form>
        </div>
      </div>,
    );
  });

  app.get('/transfer/altdaten/pruefen', async (c) => {
    const ids = c.req.queries('d') ?? [];
    const { bytes, names } = await loadBackupBytes(sql, cfg, ids);
    const a = await analyzeBackup(sql, bytes);
    return page(
      c,
      'Import aus alter App – Prüfung',
      'transfer',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href="/transfer/altdaten">Import aus der alten App</a>
            </div>
            <h1>Prüfung</h1>
            <div class="sub">
              {names.join(' + ')} · {fileSize(bytes.length)}
              {a.created && ` · Backup vom ${a.created}`}
            </div>
          </div>
        </div>
        <form method="post" action="/transfer/altdaten/uebernehmen" class="card">
          {ids.map((id) => (
            <input type="hidden" name="d" value={id} />
          ))}
          <h3>Bereiche übernehmen</h3>
          {a.sections.length === 0 && (
            <p class="small mut">Im Backup ist nichts, was schon übernommen werden kann.</p>
          )}
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Bereich</th>
                  <th class="r">Datensätze</th>
                  <th class="r">neu</th>
                  <th class="r">schon übernommen</th>
                  <th>Hinweise</th>
                </tr>
              </thead>
              <tbody>
                {a.sections.map((s) => (
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        name="bereich"
                        value={s.key}
                        checked={s.neu > 0}
                        aria-label={s.label}
                      />
                    </td>
                    <td>
                      <b>{s.label}</b>
                    </td>
                    <td class="r">{s.total}</td>
                    <td class="r">{s.neu}</td>
                    <td class="r">{s.vorhanden}</td>
                    <td class="small">
                      {s.notes.map((n) => (
                        <div>{n}</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="formfoot">
            <button class="btn" disabled={!a.sections.length} data-confirm="Ausgewählte Bereiche übernehmen?">
              Übernehmen
            </button>
          </div>
        </form>
        <div class="card">
          <h3>Inhalt des Backups</h3>
          <div class="tbl">
            <table>
              <tbody>
                {a.tables.map((t) => (
                  <tr>
                    <td>{t.name}</td>
                    <td class="r">{t.count}</td>
                    <td>
                      {t.used ? (
                        <span class="badge ok">wird übernommen</span>
                      ) : (
                        <span class="badge">nicht übernommen</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>,
    );
  });

  app.post('/transfer/altdaten/uebernehmen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = arr(b, 'd');
    const { bytes } = await loadBackupBytes(sql, cfg, ids);
    const out = await applyBackup(deps, bytes, arr(b, 'bereich'), c.get('actor'));
    return back(c, `/transfer/altdaten/pruefen?${ids.map((i) => `d=${i}`).join('&')}`, { ok: out.join(' ') });
  });
}
