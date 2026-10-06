import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';
import { importLegacyEc } from './eigen-compliance.js';
import { uuidOf } from './fortytools-export-import.js';
import { type UploadConfig, filePath } from './uploads.js';
import type { Deps } from './workflow.js';

/*
 * Import aus dem Backup der alten App (ZIP „Viva-Deluxe Backup“: data/*.json + files/…).
 * Der Benutzer lädt die ZIP-Datei (oder die Teile backup-teil-aa, -ab …) in der App hoch; hier wird gelesen, geprüft
 * und übernommen. Jede Übernahme ist idempotent (legacy_id = alte ID) – zweimal übernehmen legt nichts doppelt an.
 * Dateien kommen write-once ins Archiv.
 */

/** Feste ID der Verknüpfung „Altdaten-Import“ für hochgeladene Backup-Dateien. */
export const LEGACY_IMPORT_ID = '00000000-0000-4000-8000-00000000a1d0';

export interface Backup {
  data: Record<string, Record<string, unknown>[]>;
  /** Datei aus files/… lesen (lazy, nur angeforderte Ordner werden entpackt) */
  file: (path: string) => Uint8Array | undefined;
  created: string | null;
}

/** Teile (…-teil-aa, -ab …) nach Namen sortiert zusammensetzen, sonst die eine ZIP-Datei. */
export async function loadBackupBytes(
  sql: Sql,
  cfg: UploadConfig,
  ids: string[],
): Promise<{ bytes: Uint8Array; names: string[] }> {
  if (!ids.length) throw new BusinessError('Bitte die Backup-Datei(en) auswählen');
  const rows = await sql<
    { id: string; original_name: string; storage_path: string | null; status: string; size_bytes: string }[]
  >`
    select f.* from app.files f join app.file_links l on l.file_id = f.id
     where f.id = any(${ids}::uuid[]) and l.entity_type = 'legacy_import' and f.status = 'complete'`;
  if (rows.length !== ids.length)
    throw new BusinessError('Datei nicht gefunden oder noch nicht vollständig hochgeladen');
  rows.sort((a, b) => a.original_name.localeCompare(b.original_name));
  const parts = await Promise.all(rows.map((r) => readFile(filePath(cfg, r as never))));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return { bytes, names: rows.map((r) => r.original_name) };
}

export function openBackup(bytes: Uint8Array, folders: string[] = []): Backup {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) =>
        f.name.startsWith('data/') ||
        f.name === 'README.txt' ||
        folders.some((d) => f.name.startsWith(`files/${d}/`)),
    });
  } catch {
    throw new BusinessError(
      'Die Datei ist keine gültige ZIP-Datei. Bei geteilten Dateien (backup-teil-aa, -ab …) bitte alle Teile hochladen und gemeinsam auswählen.',
    );
  }
  const data: Backup['data'] = {};
  for (const [name, buf] of Object.entries(entries)) {
    const m = /^data\/([a-z0-9_]+)\.json$/.exec(name);
    if (!m) continue;
    const j = JSON.parse(new TextDecoder().decode(buf)) as unknown;
    data[m[1]!] = Array.isArray(j) ? (j as Record<string, unknown>[]) : [j as Record<string, unknown>];
  }
  if (!Object.keys(data).length)
    throw new BusinessError('Im ZIP fehlt der Ordner data/ – ist das ein Backup der alten App?');
  const readme = entries['README.txt'] ? new TextDecoder().decode(entries['README.txt']) : '';
  return {
    data,
    file: (p) => entries[`files/${p}`],
    created: /Erstellt:\s*([^\n]+)/.exec(readme)?.[1]?.trim() ?? null,
  };
}

/** Euro-Gleitkomma der alten App → Cent (über Text, kein Rundungsfehler). */
export function centsOf(v: unknown): bigint {
  const s =
    typeof v === 'number'
      ? v.toFixed(2)
      : String(v ?? '')
          .trim()
          .replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new BusinessError(`Betrag „${String(v)}“ ungültig`);
  const [i, f = ''] = s.split('.');
  const neg = i!.startsWith('-');
  const frac = `${f}00`.slice(0, 3);
  let c = BigInt(i!.replace('-', '')) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1n;
  return neg ? -c : c;
}

const txt = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const mime = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext === 'pdf'
    ? 'application/pdf'
    : ext === 'png'
      ? 'image/png'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'heic'
          ? 'image/heic'
          : 'image/jpeg';
};

async function archiveFile(deps: Deps, folder: string, bytes: Uint8Array, name: string) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const ext =
    (name.split('.').pop() ?? 'bin')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 5) || 'bin';
  const path = `${folder}/${sha.slice(0, 2)}/${sha}.${ext}`;
  await deps.archive.put(path, bytes);
  return { path, sha };
}

export interface Section {
  key: string;
  label: string;
  total: number;
  neu: number;
  vorhanden: number;
  notes: string[];
  ready: boolean;
}

// ------------------------------------------------------------------ Kasse

async function analyzeKasse(sql: Sql, b: Backup): Promise<Section> {
  const kb = b.data.kassenbuch ?? [];
  const kk = b.data.kasse_kartenbelege ?? [];
  const ab = b.data.kasse_anfangsbestand ?? [];
  const legacy = new Set(
    (
      await sql<{ legacy_id: string }[]>`
        select legacy_id from app.cash_entries where legacy_id is not null
        union all select legacy_id from app.card_receipts where legacy_id is not null`
    ).map((r) => r.legacy_id),
  );
  const keys = [...kb.map((r) => `kb:${r.id}`), ...kk.map((r) => `kk:${r.id}`)];
  const vorhanden = keys.filter((k) => legacy.has(k)).length;
  const notes: string[] = [];
  const dates = kb
    .map((r) => String(r.datum ?? ''))
    .filter(Boolean)
    .sort();
  if (dates.length) notes.push(`Kasse: ${kb.length} Buchungen vom ${dates[0]} bis ${dates.at(-1)}`);
  notes.push(`Karten-Belege: ${kk.length}, Anfangsbestände: ${ab.length} Monate`);
  const closed = await sql`select 1 from app.cash_closings limit 1`;
  if (closed.length)
    notes.push(
      'Achtung: Es gibt schon abgeschlossene Monate – Buchungen in diesen Monaten werden übersprungen.',
    );
  return {
    key: 'kasse',
    label: 'Kassenbuch (Kasse, Karten-Belege, Anfangsbestände)',
    total: keys.length,
    neu: keys.length - vorhanden,
    vorhanden,
    notes,
    ready: kb.length + kk.length + ab.length > 0,
  };
}

async function applyKasse(deps: Deps, b: Backup, actor: string): Promise<string[]> {
  const { sql } = deps;
  const out: string[] = [];
  const closed = new Set(
    (await sql<{ month: string }[]>`select month from app.cash_closings`).map((r) => r.month),
  );
  // Anfangsbestände (nur Monate ohne eigenen Wert)
  let ob = 0;
  for (const a of b.data.kasse_anfangsbestand ?? []) {
    const month = String(a.monat ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || closed.has(month)) continue;
    const r = await sql`insert into app.cash_openings (month, amount_cents, set_by)
                        values (${month}, ${centsOf(a.betrag)}, ${actor}) on conflict (month) do nothing`;
    ob += r.count;
  }
  // Buchungen chronologisch → fortlaufende Belegnummern
  const rows = [...(b.data.kassenbuch ?? [])].sort(
    (x, y) =>
      String(x.datum).localeCompare(String(y.datum)) ||
      String(x.created_at ?? '').localeCompare(String(y.created_at ?? '')),
  );
  let n = 0;
  let files = 0;
  const missing: string[] = [];
  const skipped: string[] = [];
  await sql.begin(async (tx) => {
    await tx`lock table app.cash_entries in share row exclusive mode`;
    const [{ max }] =
      (await tx`select coalesce(max(entry_no), 0)::int as max from app.cash_entries`) as unknown as [
        { max: number },
      ];
    let no = max;
    for (const r of rows) {
      const legacyId = `kb:${r.id}`;
      const [exists] = await tx`select 1 from app.cash_entries where legacy_id = ${legacyId}`;
      if (exists) continue;
      const date = String(r.datum ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        skipped.push(`${txt(r.beschreibung) ?? '?'}: Datum fehlt`);
        continue;
      }
      if (closed.has(date.slice(0, 7))) {
        skipped.push(`${date} ${txt(r.beschreibung) ?? ''}: Monat abgeschlossen`);
        continue;
      }
      const amount = centsOf(r.betrag);
      const kind = r.typ === 'einnahme' ? 'einnahme' : 'ausgabe';
      if (amount <= 0n) {
        skipped.push(`${date} ${txt(r.beschreibung) ?? ''}: Betrag ${String(r.betrag)}`);
        continue;
      }
      let file: { path: string; sha: string; name: string; type: string } | null = null;
      const bp = txt(r.beleg_path);
      if (bp) {
        const bytes = b.file(`kassenbelege/${bp}`);
        if (bytes) {
          const a = await archiveFile(deps, 'kasse', bytes, bp);
          file = { ...a, name: bp.split('/').pop()!, type: txt(r.beleg_typ) ?? mime(bp) };
          files++;
        } else missing.push(bp);
      }
      no++;
      const uuid = uuidOf(`legacy-cash:${String(r.id)}`);
      await tx`insert into app.cash_entries ${tx({
        id: uuid,
        entry_no: no,
        kind,
        entry_date: date,
        description: txt(r.beschreibung) ?? '(ohne Beschreibung)',
        amount_cents: amount,
        receipt_ref: txt(r.beleg),
        category: txt(r.kategorie),
        note: txt(r.notiz),
        receipt_path: file?.path ?? null,
        receipt_sha256: file?.sha ?? null,
        receipt_name: file?.name ?? null,
        receipt_type: file?.type ?? null,
        legacy_id: legacyId,
        created_by: actor,
        created_at: r.created_at ? new Date(String(r.created_at)) : new Date(),
      } as Record<string, unknown>)}`;
      await tx`insert into app.cash_log (entry_id, action, new, actor)
               values (${uuid}, 'importiert (alte App)', ${tx.json({ alt_id: String(r.id), betrag: String(amount), datum: date })}, ${actor})`;
      n++;
    }
  });
  // Karten-Belege
  let k = 0;
  for (const r of b.data.kasse_kartenbelege ?? []) {
    const legacyId = `kk:${r.id}`;
    const [exists] = await sql`select 1 from app.card_receipts where legacy_id = ${legacyId}`;
    if (exists) continue;
    const bp = txt(r.beleg_path);
    const bytes = bp ? b.file(`kassenbelege/${bp}`) : undefined;
    if (!bp || !bytes) {
      missing.push(bp ?? `Karten-Beleg ${String(r.datum)}`);
      continue;
    }
    const a = await archiveFile(deps, 'kartenbelege', bytes, bp);
    await sql`insert into app.card_receipts ${sql({
      id: uuidOf(`legacy-card:${String(r.id)}`),
      receipt_date: String(r.datum),
      amount_cents: centsOf(r.betrag),
      note: txt(r.notiz),
      receipt_path: a.path,
      receipt_sha256: a.sha,
      receipt_name: bp.split('/').pop()!,
      receipt_type: mime(bp),
      legacy_id: legacyId,
      created_by: actor,
    } as Record<string, unknown>)} on conflict (legacy_id) do nothing`;
    k++;
  }
  out.push(`Kasse: ${n} Buchungen übernommen (${files} Belege), ${k} Karten-Belege, ${ob} Anfangsbestände.`);
  if (skipped.length)
    out.push(
      `Übersprungen: ${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? ` … (+${skipped.length - 5})` : ''}`,
    );
  if (missing.length) out.push(`${missing.length} Beleg-Dateien fehlen im Backup.`);
  return out;
}

// ------------------------------------------------------------------ Eigen-Compliance

async function analyzeEc(sql: Sql, b: Backup): Promise<Section> {
  const row = b.data.eigen_compliance?.[0];
  const docs = (row?.documents ?? {}) as Record<string, Record<string, unknown>>;
  let files = 0;
  for (const d of Object.values(docs)) {
    if (!d || typeof d !== 'object') continue;
    const items = (Array.isArray(d.items) ? d.items : Array.isArray(d.kassen) ? d.kassen : [d]) as Record<
      string,
      unknown
    >[];
    for (const it of items)
      files += (it.file_path ? 1 : 0) + (Array.isArray(it.archiv) ? it.archiv.length : 0);
  }
  const [{ n }] =
    (await sql`select count(*)::int as n from app.ec_versions where legacy_id like 'ec:%'`) as unknown as [
      { n: number },
    ];
  return {
    key: 'eigen',
    label: 'Eigen-Compliance (Nachweise mit Archiv, Checkliste)',
    total: files,
    neu: Math.max(0, files - n),
    vorhanden: Math.min(n, files),
    notes: [`${Object.keys(docs).length} Nachweisarten mit Dateien`],
    ready: !!row,
  };
}

async function applyEc(deps: Deps, b: Backup, actor: string): Promise<string[]> {
  const row = b.data.eigen_compliance?.[0];
  if (!row) return [];
  const r = await importLegacyEc(deps, row, b.file, actor);
  return [
    `Eigen-Compliance: ${r.n} Dateien übernommen${r.missing ? `, ${r.missing} fehlen im Backup` : ''}.`,
  ];
}

// ------------------------------------------------------------------ Registry

export type LegacyModule = {
  key: string;
  /** Tabellen aus data/, die das Modul übernimmt */
  tables: string[];
  /** Datei-Ordner unter files/, die entpackt werden müssen */
  folders: string[];
  analyze: (sql: Sql, b: Backup) => Promise<Section>;
  apply: (deps: Deps, b: Backup, actor: string) => Promise<string[]>;
};

const MODULES: LegacyModule[] = [
  {
    key: 'kasse',
    tables: ['kassenbuch', 'kasse_kartenbelege', 'kasse_anfangsbestand'],
    folders: ['kassenbelege'],
    analyze: analyzeKasse,
    apply: applyKasse,
  },
  {
    key: 'eigen',
    tables: ['eigen_compliance'],
    folders: ['eigencompliance'],
    analyze: analyzeEc,
    apply: applyEc,
  },
];

/** Weitere Module melden sich hier an (Eigen-Compliance, Akquise, Bewerber, Glasreinigung …). */
export function registerLegacyModule(m: LegacyModule) {
  if (!MODULES.some((x) => x.key === m.key)) MODULES.push(m);
}

export async function analyzeBackup(sql: Sql, bytes: Uint8Array) {
  const b = openBackup(bytes);
  const sections = await Promise.all(MODULES.map((m) => m.analyze(sql, b)));
  const used = new Set(MODULES.flatMap((m) => m.tables));
  const tables = Object.entries(b.data)
    .map(([name, rows]) => ({ name, count: rows.length, used: used.has(name) }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return { created: b.created, sections: sections.filter((s) => s.ready), tables };
}

export async function applyBackup(deps: Deps, bytes: Uint8Array, keys: string[], actor: string) {
  const mods = MODULES.filter((m) => keys.includes(m.key));
  if (!mods.length) throw new BusinessError('Bitte mindestens einen Bereich auswählen');
  const b = openBackup(bytes, [...new Set(mods.flatMap((m) => m.folders))]);
  const out: string[] = [];
  for (const m of mods) out.push(...(await m.apply(deps, b, actor)));
  await deps.sql`insert into app.audit_log (actor, action, entity, details)
                 values (${actor}, 'import', 'altdaten', ${deps.sql.json({ bereiche: keys, ergebnis: out })})`;
  return out;
}
