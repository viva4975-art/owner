import type { Child, FC } from 'hono/jsx';
import type { FileRow, LinkTarget } from '../services/uploads.js';
import { Icon, iconSvg } from './icons.js';
import { fileSize } from './layout.js';
import { UPLOADER_JS } from './uploader.js';

const isZip = (n: string) => /\.(zip|7z|rar)$/i.test(n);
const isPdf = (n: string) => /\.pdf$/i.test(n);

/** Dateiliste + Upload-Bereich (Ziehen & Ablegen, große Dateien, fortsetzbar). */
export const FileArea: FC<{
  link: LinkTarget;
  files: (FileRow & { category?: string | null })[];
  category?: string;
  title?: string;
  hint?: string;
  maxBytes: number;
  /** nur Liste, ohne Upload-Bereich */
  listOnly?: boolean;
  /** zusätzliche Aktion je Datei (z. B. „ins Archiv“) */
  action?: (f: FileRow) => Child;
  /** ohne „Umbenennen“ (z. B. Anhänge ausgestellter Rechnungen) */
  noRename?: boolean;
}> = ({ link, files, category, title, hint, maxBytes, listOnly, action, noRename }) => (
  <div class="filearea">
    {files.length > 0 && (
      <ul class="files" style="margin:0 0 12px">
        {files.map((f) => (
          <li class="done">
            <span class="fic">
              <Icon name={isZip(f.original_name) ? 'zip' : isPdf(f.original_name) ? 'pdf' : 'file'} />
            </span>
            <div>
              <div class="nm">
                <a href={`/dateien/${f.id}`}>{f.original_name}</a>
              </div>
              <div class="meta">
                {fileSize(Number(f.size_bytes))}
                {f.category ? ` · ${f.category}` : ''} · {f.uploaded_by},{' '}
                {f.completed_at?.toLocaleString('de-DE', {
                  timeZone: 'Europe/Berlin',
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}{' '}
                · <span title={f.sha256 ?? ''}>SHA-256 {f.sha256?.slice(0, 12)}…</span>
              </div>
            </div>
            <div class="act">
              <a class="btn sm sec" href={`/dateien/${f.id}`}>
                <Icon name="download" size={14} /> Laden
              </a>
              {!noRename && <RenameForm link={link} f={f} />}
              {action?.(f)}
            </div>
          </li>
        ))}
      </ul>
    )}
    {!listOnly && (
      <div data-uploader data-link-type={link.type} data-link-id={link.id} data-category={category ?? ''}>
        <div class="drop-zone" tabindex={0} role="button" aria-label={title ?? 'Dateien hochladen'}>
          <Icon name="upload" size={22} />
          <div>
            <b>{title ?? 'Dateien hierher ziehen'}</b> oder <u>auswählen</u>
          </div>
          <div class="small">
            {hint ??
              `Auch große ZIP-Dateien bis ${fileSize(maxBytes)} – Upload setzt nach Unterbrechung fort.`}
          </div>
          <input type="file" multiple />
        </div>
        <ul class="files" />
      </div>
    )}
    <template id="vd-ic-zip" dangerouslySetInnerHTML={{ __html: iconSvg('zip', 18) }} />
    <template id="vd-ic-file" dangerouslySetInnerHTML={{ __html: iconSvg('file', 18) }} />
    <script dangerouslySetInnerHTML={{ __html: UPLOADER_JS }} />
  </div>
);

/** Endung („.pdf“) bzw. leer. */
const extOf = (n: string) => /\.[A-Za-z0-9]{1,8}$/.exec(n)?.[0] ?? '';

/**
 * Dokument direkt umbenennen (Ahmed 25.10.): klappt ein kleines Feld auf. Nur der angezeigte Name in dieser Akte
 * ändert sich, die Endung bleibt; die Datei selbst bleibt write-once.
 */
const RenameForm: FC<{ link: LinkTarget; f: FileRow }> = ({ link, f }) => {
  const ext = extOf(f.original_name);
  const base = ext ? f.original_name.slice(0, -ext.length) : f.original_name;
  return (
    <details class="ren">
      <summary class="btn sm ghost" title="Dokument umbenennen">
        Umbenennen
      </summary>
      <form method="post" action={`/dateien/${f.id}/umbenennen`} class="ren-form">
        <input type="hidden" name="typ" value={link.type} />
        <input type="hidden" name="eid" value={link.id} />
        <input name="name" value={base} maxLength={240} aria-label="Neuer Name" required />
        {ext && <span class="small mut">{ext}</span>}
        <button class="btn sm">Speichern</button>
      </form>
    </details>
  );
};

/** Knöpfe „Alle aufklappen / Alle zuklappen“ für die Dokument-Kategorien (details.doc-cat) einer Seite. */
export const DocFoldAll: FC = () => (
  <span class="doc-fold">
    <button
      type="button"
      class="btn sm ghost"
      onclick="document.querySelectorAll('details.doc-cat').forEach(function(d){d.open=true})"
    >
      Alle aufklappen
    </button>
    <button
      type="button"
      class="btn sm ghost"
      onclick="document.querySelectorAll('details.doc-cat').forEach(function(d){d.open=false})"
    >
      Alle zuklappen
    </button>
  </span>
);

/** Dokument-Kategorien starten immer zugeklappt (Ahmed 12.10.); Sprungmarken öffnen das Ziel im Browser. */
export const docOpen = (_n: number) => false;
