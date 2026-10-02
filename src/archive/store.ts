import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';

export interface ArchiveStore {
  /** Schreibt einmalig. Existiert der Pfad bereits mit identischem Inhalt → ok (idempotent), sonst Fehler. */
  put(path: string, bytes: Uint8Array): Promise<{ sha256: string; size: number }>;
  get(path: string): Promise<Uint8Array>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Lokales Archiv (dev/test): Dateien werden exklusiv angelegt (O_EXCL) und schreibgeschützt.
 * Für den Live-Betrieb: Supabase Storage + Kopie in S3-kompatiblen Speicher mit Object Lock
 * (Compliance-Modus, 10 Jahre) – siehe CLAUDE.md.
 */
export class LocalArchiveStore implements ArchiveStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private abs(path: string): string {
    const p = normalize(join(this.root, path));
    if (!p.startsWith(this.root + '/')) throw new Error(`Ungültiger Archivpfad: ${path}`);
    return p;
  }

  async put(path: string, bytes: Uint8Array) {
    const file = this.abs(path);
    await mkdir(dirname(file), { recursive: true });
    const hash = sha256(bytes);
    try {
      const fh = await open(file, 'wx', 0o444);
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await chmod(file, 0o444);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await readFile(file);
      if (sha256(existing) !== hash) {
        throw new Error(
          `Archivdatei ${path} existiert bereits mit anderem Inhalt – Überschreiben nicht erlaubt`,
          { cause: err },
        );
      }
    }
    return { sha256: hash, size: bytes.byteLength };
  }

  async get(path: string) {
    return new Uint8Array(await readFile(this.abs(path)));
  }
}
