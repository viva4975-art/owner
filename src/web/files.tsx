import type { FC } from 'hono/jsx';
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
}> = ({ link, files, category, title, hint, maxBytes }) => (
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
            </div>
          </li>
        ))}
      </ul>
    )}
    <div data-uploader data-link-type={link.type} data-link-id={link.id} data-category={category ?? ''}>
      <div class="drop-zone" tabindex={0} role="button" aria-label={title ?? 'Dateien hochladen'}>
        <Icon name="upload" size={22} />
        <div>
          <b>{title ?? 'Dateien hierher ziehen'}</b> oder <u>auswählen</u>
        </div>
        <div class="small">
          {hint ?? `Auch große ZIP-Dateien bis ${fileSize(maxBytes)} – Upload setzt nach Unterbrechung fort.`}
        </div>
        <input type="file" multiple />
      </div>
      <ul class="files" />
    </div>
    <template id="vd-ic-zip" dangerouslySetInnerHTML={{ __html: iconSvg('zip', 18) }} />
    <template id="vd-ic-file" dangerouslySetInnerHTML={{ __html: iconSvg('file', 18) }} />
    <script dangerouslySetInnerHTML={{ __html: UPLOADER_JS }} />
  </div>
);
