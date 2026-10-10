import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/**
 * Minimaler S3-Zugang (AWS Signature V4, Pfad-Stil) für die revisionssichere Archiv-Kopie mit Object Lock.
 * Bewusst ohne SDK: wir brauchen nur PUT (mit Sperre), HEAD und die Abfrage der Bucket-Sperre.
 * Getestet gegen moto (S3-Nachbau) und die AWS-Beispielwerte; Ziel ist z. B. IONOS S3 Object Storage.
 */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const hex = (b: Buffer) => b.toString('hex');
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Objektschlüssel → kanonischer Pfad (jeder Teil kodiert, „/“ bleibt). */
export function objectPath(bucket: string, key: string) {
  return `/${enc(bucket)}/${key.split('/').map(enc).join('/')}`;
}

/** Signatur V4 (Header-Variante). Gibt die zu setzenden Header zurück (inkl. Authorization). */
export function signV4(p: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKey: string;
  secretKey: string;
  now?: Date;
  service?: string;
}): Record<string, string> {
  const service = p.service ?? 's3';
  const d = (p.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = d.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: p.url.host,
    'x-amz-date': d,
    'x-amz-content-sha256': p.payloadHash,
  };
  const names = Object.keys(headers).sort();
  const query = [...p.url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    p.method,
    p.url.pathname,
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    p.payloadHash,
  ].join('\n');
  const scope = `${date}/${p.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', d, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${p.secretKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, p.region), service), 'aws4_request');
  const signature = hex(hmac(kSigning, toSign));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${p.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

export class S3Client {
  constructor(private readonly cfg: S3Config) {}

  private url(key: string | null, query = '') {
    const base = this.cfg.endpoint.replace(/\/$/, '');
    const path = key === null ? `/${enc(this.cfg.bucket)}` : objectPath(this.cfg.bucket, key);
    return new URL(`${base}${path}${query}`);
  }

  private async request(
    method: string,
    url: URL,
    opts: {
      headers?: Record<string, string>;
      payloadHash?: string;
      body?: Readable | Buffer;
      timeoutMs?: number;
    } = {},
  ) {
    const payloadHash = opts.payloadHash ?? sha256hex('');
    const headers = signV4({
      method,
      url,
      headers: opts.headers ?? {},
      payloadHash,
      region: this.cfg.region,
      accessKey: this.cfg.accessKey,
      secretKey: this.cfg.secretKey,
    });
    delete headers.host;
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    };
    if (opts.body) {
      init.body = (opts.body instanceof Readable
        ? Readable.toWeb(opts.body)
        : opts.body) as unknown as NonNullable<RequestInit['body']>;
      init.duplex = 'half';
    }
    return fetch(url, init);
  }

  /**
   * Bucket-Sperre laut Bucket-Einstellung. `reason` erklärt einen Fehlschlag verständlich – wichtig, weil ein falscher
   * Bucket-Name oder eine falsche Region sonst wie „Object Lock nicht eingeschaltet“ aussähe (Fund 10.10.).
   */
  async lockConfiguration(): Promise<{ enabled: boolean; mode: string | null; reason: string | null }> {
    const r = await this.request('GET', this.url(null, '?object-lock='));
    const text = await r.text();
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    if (code === 'NoSuchBucket')
      throw new Error(`Bucket „${this.cfg.bucket}“ nicht gefunden – Name, Endpunkt und Region prüfen`);
    if (
      r.status === 403 ||
      code === 'AccessDenied' ||
      code === 'SignatureDoesNotMatch' ||
      code === 'InvalidAccessKeyId'
    )
      throw new Error(`Zugang abgelehnt (${code || r.status}) – Schlüssel und Region prüfen`);
    if (/ObjectLockConfigurationNotFound/.test(code) || r.status === 404)
      return {
        enabled: false,
        mode: null,
        reason: `Bucket meldet keine Object-Lock-Einstellung (${code || r.status})`,
      };
    if (!r.ok) throw new Error(`S3 ${r.status}: ${s3Error(text)}`);
    const enabled = /ObjectLockEnabled>\s*Enabled\s*</i.test(text);
    return {
      enabled,
      mode: /Mode>\s*(\w+)\s*</.exec(text)?.[1] ?? null,
      reason: enabled
        ? null
        : `Antwort ohne „ObjectLockEnabled=Enabled“: ${text.replace(/\s+/g, ' ').slice(0, 160)}`,
    };
  }

  private lockCache: { at: number; enabled: boolean; detail: string } | null = null;

  /**
   * Ist die Sperre wirklich wirksam? Meldet der Bucket sie nicht (manche Anbieter beantworten die Abfrage anders),
   * wird eine kleine Probedatei mit 1 Tag Compliance-Sperre hochgeladen und geprüft – das ist der echte Beweis.
   * Ergebnis 6 Std. (positiv) bzw. 10 Min. (negativ) gemerkt.
   */
  async lockStatus(): Promise<{ enabled: boolean; detail: string }> {
    const c = this.lockCache;
    if (c && Date.now() - c.at < (c.enabled ? 6 * 3_600_000 : 600_000)) return c;
    const cfg = await this.lockConfiguration();
    let res: { enabled: boolean; detail: string };
    if (cfg.enabled)
      res = { enabled: true, detail: `eingeschaltet${cfg.mode ? ` (Standard ${cfg.mode})` : ''}` };
    else {
      try {
        const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'lock-'));
        const f = join(dir, 'probe.txt');
        const now = new Date();
        await writeFile(f, `Pruefung Object Lock ${now.toISOString()}`);
        const until = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
        const key = `_pruefung/object-lock-${now.toISOString().slice(0, 10)}.txt`;
        try {
          await this.putLocked(key, f, until);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        const h = await this.head(key);
        res =
          h?.lockMode === 'COMPLIANCE'
            ? { enabled: true, detail: 'eingeschaltet (per Probedatei bestätigt)' }
            : { enabled: false, detail: `NICHT wirksam – Probedatei ohne Sperre (${cfg.reason ?? ''})` };
      } catch (e) {
        res = {
          enabled: false,
          detail: `NICHT eingeschaltet – ${cfg.reason ?? ''}; Probe: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    this.lockCache = { at: Date.now(), ...res };
    return res;
  }

  /**
   * Legt eine Datei mit Sperre im Compliance-Modus ab. Sperre bis `retainUntil` (Datum, 23:59:59 UTC).
   * Inhalt wird gestreamt; SHA-256 (signiert) und MD5 (von S3 bei Sperren verlangt) vorab berechnet.
   */
  async putLocked(key: string, file: string, retainUntil: string, meta: Record<string, string> = {}) {
    const { size } = await stat(file);
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    for await (const chunk of createReadStream(file)) {
      sha.update(chunk as Buffer);
      md5.update(chunk as Buffer);
    }
    const shaHex = sha.digest('hex');
    const headers: Record<string, string> = {
      'content-length': String(size),
      'content-md5': md5.digest('base64'),
      'content-type': 'application/octet-stream',
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': `${retainUntil}T23:59:59Z`,
      'x-amz-meta-sha256': shaHex,
      ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`x-amz-meta-${k}`, v])),
    };
    const r = await this.request('PUT', this.url(key), {
      headers,
      payloadHash: shaHex,
      body: size ? createReadStream(file) : Buffer.alloc(0),
      timeoutMs: Math.max(60_000, size / 50_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`S3 ${r.status}: ${s3Error(text)}`);
    return { sha256: shaHex, size, versionId: r.headers.get('x-amz-version-id') };
  }

  /** Prüft, ob das Objekt da ist und gesperrt ist; null = nicht vorhanden. */
  async head(key: string) {
    const r = await this.request('HEAD', this.url(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 ${r.status} beim Prüfen von ${key}`);
    return {
      size: Number(r.headers.get('content-length') ?? 0),
      sha256: r.headers.get('x-amz-meta-sha256'),
      lockMode: r.headers.get('x-amz-object-lock-mode'),
      retainUntil: r.headers.get('x-amz-object-lock-retain-until-date'),
    };
  }
}

function s3Error(xml: string) {
  const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
  const msg = /<Message>([^<]+)<\/Message>/.exec(xml)?.[1];
  return [code, msg].filter(Boolean).join(' – ') || xml.slice(0, 200);
}
