import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { BusinessError } from '../services/errors.js';
import {
  CHUNK_SIZE,
  type FileRow,
  type LinkTarget,
  type UploadConfig,
  completeUpload,
  filePath,
  putChunk,
  startUpload,
  uploadStatus,
} from '../services/uploads.js';
import { addAttachment } from '../services/workflow.js';
import type { Context } from 'hono';
import { INBOX_ID } from '../services/documents.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { canAccess } from './permissions.js';
import { LEGACY_IMPORT_ID } from '../services/legacy-import.js';

const LINK_TYPES = [
  'offer',
  'invoice',
  'customer',
  'site',
  'employee',
  'supplier',
  'incoming_invoice',
  'purchase_order',
  'order',
  'work_report',
  'quality_check',
  'inbox',
  'tender',
  'note',
  'legacy_import',
  'vehicle',
] as const;
/** Anlagen, die per E-Mail mit der Rechnung rausgehen, dürfen nicht zu groß werden. */
const INVOICE_ATTACHMENT_MAX = 20 * 1024 * 1024;

/** Seite, deren Recht für eine Verknüpfung gilt (Personalakten nur Personal/Admin usw.). */
const LINK_PAGE: Record<string, (id: string) => string> = {
  offer: () => '/angebote',
  invoice: () => '/rechnungen',
  customer: (id) => `/kunden/${id}`,
  site: (id) => `/objekte/${id}`,
  employee: (id) => `/personal/${id}`,
  supplier: () => '/lieferanten',
  incoming_invoice: () => '/rechnungseingang',
  purchase_order: () => '/bestellungen',
  order: () => '/auftraege',
  work_report: () => '/arbeitsscheine',
  quality_check: () => '/qualitaet',
  inbox: () => '/transfer/dokumenteneingang',
  tender: () => '/ausschreibungen',
  legacy_import: () => '/transfer/altdaten',
  vehicle: () => '/fahrzeuge',
};

/** Darf der Benutzer die Verknüpfung sehen? Rolle (Seite) + bei Objektleitung das eigene Objekt. */
async function linkAllowed(
  c: Context<AppEnv>,
  sql: Ctx['deps']['sql'],
  type: string,
  id: string,
): Promise<boolean> {
  if (type === 'note') {
    // Anhang einer Notiz: Recht wie die Notizen des Kunden/Objekts/Mitarbeiters
    const [n] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type::text, entity_id from app.notes where id = ${id}::uuid`;
    return !!n && n.entity_type !== 'note' && linkAllowed(c, sql, n.entity_type, n.entity_id);
  }
  const user = c.get('user');
  const page = LINK_PAGE[type];
  if (!user || !page || !canAccess(user.role, page(id))) return false;
  const scope = c.get('sites');
  if (!scope) return true;
  const [row] = await sql<{ site_id: string | null }[]>`
    select case ${type}
             when 'site' then ${id}::uuid
             when 'work_report' then (select site_id from app.work_reports where id = ${id}::uuid)
             when 'quality_check' then (select site_id from app.quality_checks where id = ${id}::uuid)
             else null end as site_id`;
  return !!row?.site_id && scope.includes(row.site_id);
}

export function uploadConfig(ctx: Ctx): UploadConfig {
  return { dir: ctx.deps.env.FILES_DIR, maxBytes: ctx.deps.env.UPLOAD_MAX_BYTES };
}

export function registerFileRoutes(ctx: Ctx) {
  const { app, deps } = ctx;
  const { sql } = deps;
  const cfg = uploadConfig(ctx);

  // Alle Upload-Aufrufe brauchen den Kopf X-Upload (nur unser Skript setzt ihn; Fremdseiten können das nicht ohne CORS).
  app.use('/api/uploads/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.header('X-Upload') !== '1')
      return c.json({ fehler: 'Nicht erlaubt' }, 403);
    await next();
  });
  app.use('/api/uploads', async (c, next) => {
    if (c.req.header('X-Upload') !== '1') return c.json({ fehler: 'Nicht erlaubt' }, 403);
    await next();
  });

  const json = async <T,>(fn: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      if (err instanceof BusinessError) return { ok: false as const, error: err.message };
      throw err;
    }
  };

  app.post('/api/uploads', async (c) => {
    const b = await c.req.json<{
      id: string;
      name: string;
      size: number;
      type: string;
      linkType?: string;
      linkId?: string;
      category?: string;
    }>();
    const link: LinkTarget | null =
      b.linkType &&
      (LINK_TYPES as readonly string[]).includes(b.linkType) &&
      b.linkId &&
      /^[0-9a-f-]{36}$/.test(b.linkId)
        ? { type: b.linkType as LinkTarget['type'], id: b.linkId }
        : null;
    if (link?.type === 'inbox' && link.id !== INBOX_ID) return c.json({ fehler: 'Eingang ungültig' }, 400);
    if (link?.type === 'legacy_import' && link.id !== LEGACY_IMPORT_ID)
      return c.json({ fehler: 'Import ungültig' }, 400);
    if (link && !(await linkAllowed(c, sql, link.type, link.id))) {
      return c.json({ fehler: 'Keine Berechtigung für diesen Bereich' }, 403);
    }
    if (
      link?.type === 'invoice' &&
      !['application/pdf', 'image/png', 'image/jpeg'].includes(String(b.type))
    ) {
      return c.json({ fehler: 'Rechnungsanlagen bitte als PDF, PNG oder JPG.' }, 400);
    }
    if (link?.type === 'invoice' && b.size > INVOICE_ATTACHMENT_MAX) {
      return c.json(
        { fehler: 'Rechnungsanlagen gehen per E-Mail mit – bitte höchstens 20 MB (z. B. PDF statt Scan).' },
        400,
      );
    }
    const r = await json(() =>
      startUpload(
        sql,
        cfg,
        {
          id: b.id,
          name: String(b.name ?? ''),
          size: Number(b.size),
          type: String(b.type ?? ''),
          link,
          category: b.category || null,
        },
        c.get('actor'),
      ),
    );
    return r.ok ? c.json(r.value) : c.json({ fehler: r.error }, 400);
  });

  app.get(`/api/uploads/:id{${UUID}}`, async (c) => {
    const r = await json(() => uploadStatus(sql, cfg, c.req.param('id')));
    return r.ok ? c.json(r.value) : c.json({ fehler: r.error }, 404);
  });

  app.put(`/api/uploads/:id{${UUID}}/teile/:n{[0-9]+}`, async (c) => {
    const len = Number(c.req.header('Content-Length') ?? '0');
    if (len > CHUNK_SIZE) return c.json({ fehler: 'Teil zu groß' }, 413);
    const data = new Uint8Array(await c.req.arrayBuffer());
    const r = await json(() => putChunk(sql, cfg, c.req.param('id'), Number(c.req.param('n')), data));
    return r.ok ? c.json({ ok: true }) : c.json({ fehler: r.error }, 400);
  });

  app.post(`/api/uploads/:id{${UUID}}/abschluss`, async (c) => {
    const id = c.req.param('id');
    const r = await json(async () => {
      const f = await completeUpload(sql, cfg, id);
      // Rechnungsanlage: zusätzlich ins Rechnungsarchiv, damit sie mit der Rechnung versendet wird.
      const links = await sql<{ entity_type: string; entity_id: string }[]>`
        select entity_type, entity_id from app.file_links where file_id = ${id} and entity_type = 'invoice'`;
      for (const l of links) {
        const already = await sql`select 1 from app.invoice_documents where invoice_id = ${l.entity_id}
                                   and kind = 'attachment' and sha256 = ${f.sha256}`;
        if (!already.length) {
          const { readFile } = await import('node:fs/promises');
          await addAttachment(
            deps,
            l.entity_id,
            f.original_name,
            f.content_type,
            new Uint8Array(await readFile(filePath(cfg, f))),
            c.get('actor'),
          );
        }
      }
      return f;
    });
    return r.ok
      ? c.json({ id, sha256: r.value.sha256, size: Number(r.value.size_bytes) })
      : c.json({ fehler: r.error }, 400);
  });

  // Download als Datenstrom (auch mehrere GB ohne Arbeitsspeicher-Last)
  app.get(`/dateien/:id{${UUID}}`, async (c) => {
    const [f] = await sql<
      FileRow[]
    >`select * from app.files where id = ${c.req.param('id')} and status = 'complete'`;
    if (!f) return c.notFound();
    // Nur wer mindestens eine Verknüpfung sehen darf (Personalakten nur Personal/Admin, Objektleitung nur eigene
    // Objekte). Dateien ohne Verknüpfung nur der Hochlader.
    const links = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from app.file_links where file_id = ${f.id}`;
    let ok = !links.length && f.uploaded_by === c.get('actor');
    for (const l of links) if (!ok && (await linkAllowed(c, sql, l.entity_type, l.entity_id))) ok = true;
    if (!ok) return c.text('Kein Zugriff auf diese Datei', 403);
    const path = filePath(cfg, f);
    const st = await stat(path);
    const inline = /^(application\/pdf|image\/)/.test(f.content_type);
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(stream, {
      headers: {
        'Content-Type': f.content_type,
        'Content-Length': String(st.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
        'Cache-Control': 'private, max-age=0',
        'X-Content-SHA256': f.sha256 ?? '',
      },
    });
  });
}
