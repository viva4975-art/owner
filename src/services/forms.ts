import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { storeFile, type UploadConfig } from './uploads.js';

/*
 * Formular-Baukasten (Ahmed 13.11., Vorbild Blink Check): Vorlagen mit Seiten und Feldern. Ausgefüllt wird am PC oder
 * am Handy; das Ergebnis wird als PDF write-once abgelegt (bei Mitarbeiter bzw. Objekt in der Akte) und der Eintrag
 * mit dem damaligen Stand der Vorlage unveränderbar gespeichert.
 */

export const FIELD_TYPES = {
  text: 'Text (eine Zeile)',
  textarea: 'Text (mehrere Zeilen)',
  number: 'Zahl',
  date: 'Datum',
  select: 'Auswahl (eine)',
  multi: 'Auswahl (mehrere)',
  yesno: 'Ja / Nein',
  check: 'Häkchen',
  photo: 'Foto(s)',
  signature: 'Unterschrift',
  info: 'Hinweistext (kein Feld)',
} as const;
export type FieldType = keyof typeof FIELD_TYPES;

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required?: boolean;
  options?: string[];
}
export interface FormPage {
  title: string;
  fields: FormField[];
}
export interface FormSchema {
  pages: FormPage[];
}
export interface FormTemplate {
  id: string;
  name: string;
  description: string | null;
  target: 'mitarbeiter' | 'objekt' | 'keins';
  file_category: string | null;
  schema: FormSchema;
  active: boolean;
  version: number;
}

export const TARGET_LABEL = {
  mitarbeiter: 'je Mitarbeiter (Personalakte)',
  objekt: 'je Objekt (Objekt → Dokumente)',
  keins: 'ohne Zuordnung',
} as const;

export async function listFormTemplates(sql: Sql, all = false) {
  return sql<(FormTemplate & { n: number; last: Date | null })[]>`
    select t.*, (select count(*)::int from app.form_submissions s where s.template_id = t.id) as n,
           (select max(s.created_at) from app.form_submissions s where s.template_id = t.id) as last
      from app.form_templates t where ${all ? sql`true` : sql`t.active`} order by t.name`;
}

export async function getFormTemplate(sql: Sql, id: string) {
  const [t] = await sql<FormTemplate[]>`select * from app.form_templates where id = ${id}`;
  return t;
}

/** Feldkennung aus der Bezeichnung (stabil, damit alte Einträge lesbar bleiben) */
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30) || 'feld';

/** Prüft und bereinigt das Schema aus dem Editor */
export function cleanSchema(raw: unknown): FormSchema {
  const pages = (raw as FormSchema | null)?.pages;
  if (!Array.isArray(pages) || !pages.length)
    throw new BusinessError('Bitte mindestens eine Seite mit Feldern anlegen');
  const used = new Set<string>();
  const out: FormPage[] = [];
  for (const p of pages.slice(0, 20)) {
    const fields: FormField[] = [];
    for (const f of (p.fields ?? []).slice(0, 60)) {
      const label = String(f.label ?? '')
        .trim()
        .slice(0, 300);
      if (!label) continue;
      const type = (f.type in FIELD_TYPES ? f.type : 'text') as FieldType;
      let id = /^[a-z0-9_]{1,40}$/.test(String(f.id ?? '')) ? String(f.id) : slug(label);
      while (used.has(id)) id = `${id}_2`;
      used.add(id);
      const options =
        type === 'select' || type === 'multi'
          ? (f.options ?? [])
              .map((o) => String(o).trim().slice(0, 100))
              .filter(Boolean)
              .slice(0, 30)
          : undefined;
      if ((type === 'select' || type === 'multi') && !options?.length)
        throw new BusinessError(`„${label}“: bitte Auswahlmöglichkeiten angeben (eine je Zeile)`);
      fields.push({
        id,
        type,
        label,
        ...(f.required && type !== 'info' ? { required: true } : {}),
        ...(options ? { options } : {}),
      });
    }
    if (fields.length)
      out.push({
        title:
          String(p.title ?? '')
            .trim()
            .slice(0, 80) || `Seite ${out.length + 1}`,
        fields,
      });
  }
  if (!out.length) throw new BusinessError('Bitte mindestens ein Feld anlegen');
  return { pages: out };
}

export async function saveFormTemplate(
  sql: Sql,
  id: string,
  p: {
    name: string;
    description: string | null;
    target: string;
    fileCategory: string | null;
    schema: FormSchema;
    active: boolean;
    expectedVersion: number | null;
  },
  actor: string,
) {
  const name = p.name.trim();
  if (!name) throw new BusinessError('Bitte einen Namen angeben');
  if (!(p.target in TARGET_LABEL)) throw new BusinessError('Zuordnung ungültig');
  const [cur] = await sql<{ version: number }[]>`select version from app.form_templates where id = ${id}`;
  if (cur && p.expectedVersion !== null && cur.version !== p.expectedVersion)
    throw new BusinessError('Die Vorlage wurde inzwischen geändert – bitte neu laden.');
  await sql`
    insert into app.form_templates (id, name, description, target, file_category, schema, active, created_by)
    values (${id}, ${name.slice(0, 80)}, ${p.description?.trim() || null}, ${p.target}, ${p.fileCategory?.trim() || null},
            ${sql.json(p.schema as never)}, ${p.active}, ${actor})
    on conflict (id) do update set name = excluded.name, description = excluded.description, target = excluded.target,
           file_category = excluded.file_category, schema = excluded.schema, active = excluded.active,
           updated_at = now()`;
}

export type Answers = Record<string, string | string[]>;

/** Prüft Pflichtfelder; Fotos/Unterschrift kommen getrennt */
export function checkAnswers(
  schema: FormSchema,
  a: Answers,
  photos: Record<string, Uint8Array[]>,
  sigs: Record<string, Uint8Array>,
) {
  for (const p of schema.pages)
    for (const f of p.fields) {
      if (!f.required) continue;
      const v = a[f.id];
      const empty =
        f.type === 'photo'
          ? !photos[f.id]?.length
          : f.type === 'signature'
            ? !sigs[f.id]
            : Array.isArray(v)
              ? v.length === 0
              : !String(v ?? '').trim();
      if (empty) throw new BusinessError(`Bitte „${f.label}“ ausfüllen`);
    }
}

export async function submitForm(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    id: string;
    template: FormTemplate;
    employeeId: string | null;
    siteId: string | null;
    answers: Answers;
    photos: Record<string, Uint8Array[]>;
    sigs: Record<string, Uint8Array>;
    filledBy: string;
  },
  actor: string,
) {
  const [had] = await sql`select 1 from app.form_submissions where id = ${p.id}`;
  if (had) return p.id; // doppelt gesendet
  const t = p.template;
  if (t.target === 'mitarbeiter' && !p.employeeId) throw new BusinessError('Bitte Mitarbeiter/in wählen');
  if (t.target === 'objekt' && !p.siteId) throw new BusinessError('Bitte Objekt wählen');
  checkAnswers(t.schema, p.answers, p.photos, p.sigs);
  const [who] = p.employeeId
    ? await sql<{ name: string; no: string }[]>`
        select first_name || ' ' || last_name as name, personnel_no as no from app.employees where id = ${p.employeeId}`
    : [];
  const [site] = p.siteId
    ? await sql<
        { name: string; no: string }[]
      >`select name, site_no as no from app.sites where id = ${p.siteId}`
    : [];
  const pdf = await formPdf(t, p.answers, p.photos, p.sigs, {
    who: who ? `${who.name} (${who.no})` : null,
    site: site ? `${site.name} (${site.no})` : null,
    filledBy: p.filledBy,
  });
  const date = todayBerlin();
  const base = `${t.name}_${date}${who ? `_${who.name}` : site ? `_${site.name}` : ''}`.replace(
    /[^\p{L}\p{N}_ .-]+/gu,
    '',
  );
  const link = p.employeeId
    ? { type: 'employee' as const, id: p.employeeId }
    : p.siteId
      ? { type: 'site' as const, id: p.siteId }
      : null;
  const file = await storeFile(
    sql,
    cfg,
    {
      id: randomUUID(),
      name: `${base}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link,
      category: link ? (t.file_category ?? (p.employeeId ? 'Personalunterlagen' : 'Protokolle')) : null,
    },
    actor,
  );
  await sql`
    insert into app.form_submissions (id, template_id, template_name, schema, employee_id, site_id, data, file_id, created_by)
    values (${p.id}, ${t.id}, ${t.name}, ${sql.json(t.schema as never)}, ${p.employeeId}, ${p.siteId},
            ${sql.json(p.answers as never)}, ${file.id}, ${actor})
    on conflict (id) do nothing`;
  return p.id;
}

/** Fotos verkleinern (1600 px, JPEG) – auch HEIC/PNG vom Handy */
export async function normalizePhoto(b: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await sharp(b)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer(),
    );
  } catch {
    throw new BusinessError('Ein Foto ließ sich nicht lesen (bitte JPG oder PNG)');
  }
}

async function formPdf(
  t: FormTemplate,
  a: Answers,
  photos: Record<string, Uint8Array[]>,
  sigs: Record<string, Uint8Array>,
  meta: { who: string | null; site: string | null; filledBy: string },
) {
  const date = todayBerlin();
  const d = await FormDoc.create({
    title: t.name,
    sideRef: `Formular ${t.name}`,
    date,
    author: 'Viva-Deluxe',
  });
  d.title(t.name, formatDateDe(date));
  d.kvBox([
    ...(meta.who ? [{ k: 'Mitarbeiter/in', v: meta.who }] : []),
    ...(meta.site ? [{ k: 'Objekt', v: meta.site }] : []),
    { k: 'Ausgefüllt von', v: meta.filledBy },
    { k: 'Datum', v: formatDateDe(date) },
  ]);
  for (const p of t.schema.pages) {
    d.section(p.title);
    const rows: string[][] = [];
    const flush = () => {
      if (rows.length) {
        const w = d.R - 48.5;
        d.table(
          [
            { label: 'Frage', width: w * 0.45 },
            { label: 'Antwort', width: w * 0.55 },
          ],
          rows.splice(0),
        );
      }
    };
    for (const f of p.fields) {
      if (f.type === 'info') {
        flush();
        d.muted(f.label);
        continue;
      }
      if (f.type === 'photo' || f.type === 'signature') {
        flush();
        const imgs = f.type === 'photo' ? (photos[f.id] ?? []) : sigs[f.id] ? [sigs[f.id]!] : [];
        d.ensure(f.type === 'photo' ? 260 : 100); // Überschrift nicht allein am Seitenende
        d.heading(f.label, 10);
        if (!imgs.length) d.muted('–');
        for (const b of imgs) {
          const img = f.type === 'photo' ? await d.pdf.embedJpg(b) : await d.pdf.embedPng(b);
          const maxW = f.type === 'photo' ? 300 : 180;
          const maxH = f.type === 'photo' ? 220 : 60;
          const s = Math.min(maxW / img.width, maxH / img.height, 1);
          d.ensure(img.height * s + 10);
          d.page.drawImage(img, {
            x: 48.5,
            y: d.H - d.y - img.height * s,
            width: img.width * s,
            height: img.height * s,
          });
          d.y += img.height * s + 10;
        }
        continue;
      }
      const v = a[f.id];
      const txt =
        f.type === 'yesno'
          ? v === 'ja'
            ? 'Ja'
            : v === 'nein'
              ? 'Nein'
              : '–'
          : f.type === 'check'
            ? v === '1'
              ? '✓'
              : '–'
            : f.type === 'date' && typeof v === 'string' && v
              ? formatDateDe(v)
              : Array.isArray(v)
                ? v.join(', ') || '–'
                : String(v ?? '').trim() || '–';
      rows.push([f.label, txt]);
    }
    flush();
  }
  return d.save();
}

export async function listSubmissions(sql: Sql, f: { templateId?: string; limit?: number } = {}) {
  return sql<
    {
      id: string;
      template_name: string;
      employee_name: string | null;
      site_name: string | null;
      file_id: string | null;
      created_by: string;
      created_at: Date;
    }[]
  >`
    select s.id, s.template_name, e.first_name || ' ' || e.last_name as employee_name, st.name as site_name,
           s.file_id, s.created_by, s.created_at
      from app.form_submissions s left join app.employees e on e.id = s.employee_id
      left join app.sites st on st.id = s.site_id
     where ${f.templateId ? sql`s.template_id = ${f.templateId}` : sql`true`}
     order by s.created_at desc limit ${f.limit ?? 50}`;
}
