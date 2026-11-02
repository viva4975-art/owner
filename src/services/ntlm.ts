/**
 * NTLMv2-Anmeldung für Exchange Web Services (Ahmed 02.11.: IONOS lehnt die Basic-Anmeldung ab).
 * Ablauf (MS-NLMP): Typ 1 (Aushandeln) → Typ 2 (Challenge vom Server) → Typ 3 (Antwort) – alles auf derselben
 * Verbindung, deshalb eigener Agent mit genau einer offenen Verbindung. MD4 selbst geschrieben, weil OpenSSL 3 es
 * in Node nicht mehr anbietet.
 */
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

// ---------------------------------------------------------------- MD4 (RFC 1320)
export function md4(input: Buffer): Buffer {
  const len = input.length;
  const padLen = ((len + 8) >> 6) * 64 + 64;
  const buf = Buffer.alloc(padLen);
  input.copy(buf);
  buf[len] = 0x80;
  buf.writeUInt32LE((len * 8) >>> 0, padLen - 8);
  buf.writeUInt32LE(Math.floor((len * 8) / 0x100000000), padLen - 4);
  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476;
  const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const X = new Array<number>(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = buf.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
    const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
    const Hh = (x: number, y: number, z: number) => x ^ y ^ z;
    const r1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) {
      const t = (a + F(b, c, d) + X[i]!) >>> 0;
      [a, b, c, d] = [d, rotl(t, r1[i % 4]!), b, c];
    }
    const r2 = [3, 5, 9, 13];
    const o2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    for (let i = 0; i < 16; i++) {
      const t = (a + G(b, c, d) + X[o2[i]!]! + 0x5a827999) >>> 0;
      [a, b, c, d] = [d, rotl(t, r2[i % 4]!), b, c];
    }
    const r3 = [3, 9, 11, 15];
    const o3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i++) {
      const t = (a + Hh(b, c, d) + X[o3[i]!]! + 0x6ed9eba1) >>> 0;
      [a, b, c, d] = [d, rotl(t, r3[i % 4]!), b, c];
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((v, i) => out.writeUInt32LE(v, i * 4));
  return out;
}

const hmac = (key: Buffer, ...data: Buffer[]) => {
  const h = createHmac('md5', key);
  data.forEach((d) => h.update(d));
  return h.digest();
};
const u16 = (s: string) => Buffer.from(s, 'utf16le');

/** NTOWFv2 = HMAC-MD5(MD4(Passwort), GROSS(Benutzer) + Domäne) */
export function ntowfv2(user: string, domain: string, password: string): Buffer {
  return hmac(md4(u16(password)), u16(user.toUpperCase() + domain));
}

const FLAGS =
  0x00000001 | // Unicode
  0x00000004 | // Request target
  0x00000200 | // NTLM
  0x00008000 | // Always sign
  0x00080000 | // Extended session security
  0x00800000 | // Target info
  0x20000000 | // 128
  0x80000000; // 56

export function type1(): string {
  const b = Buffer.alloc(32);
  b.write('NTLMSSP\0', 0, 'latin1');
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(FLAGS >>> 0, 12);
  return b.toString('base64');
}

export function parseType2(b64: string): { challenge: Buffer; targetInfo: Buffer; flags: number } {
  const b = Buffer.from(b64, 'base64');
  if (b.toString('latin1', 0, 8) !== 'NTLMSSP\0' || b.readUInt32LE(8) !== 2)
    throw new Error('ungültige NTLM-Antwort');
  const flags = b.readUInt32LE(20);
  const challenge = b.subarray(24, 32);
  let targetInfo = Buffer.alloc(0);
  if (b.length >= 48) {
    const l = b.readUInt16LE(40);
    const o = b.readUInt32LE(44);
    if (l && o + l <= b.length) targetInfo = b.subarray(o, o + l);
  }
  return { challenge, targetInfo, flags };
}

/** Benutzer „name@firma.de“ → als UPN ohne Domäne; „DOMÄNE\\name“ → getrennt. */
export function splitUser(login: string): { user: string; domain: string } {
  const i = login.indexOf('\\');
  return i > 0 ? { domain: login.slice(0, i), user: login.slice(i + 1) } : { domain: '', user: login };
}

export function type3(
  t2: { challenge: Buffer; targetInfo: Buffer },
  login: string,
  password: string,
  opts: { clientChallenge?: Buffer; time?: Buffer } = {},
): string {
  const { user, domain } = splitUser(login);
  const key = ntowfv2(user, domain, password);
  const cc = opts.clientChallenge ?? randomBytes(8);
  // Zeit in 100-ns-Schritten seit 1601
  const time =
    opts.time ??
    (() => {
      const t = Buffer.alloc(8);
      t.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
      return t;
    })();
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    time,
    cc,
    Buffer.alloc(4),
    t2.targetInfo,
    Buffer.alloc(4),
  ]);
  const ntProof = hmac(key, t2.challenge, blob);
  const nt = Buffer.concat([ntProof, blob]);
  const lm = Buffer.concat([hmac(key, t2.challenge, cc), cc]);
  const dom = u16(domain);
  const usr = u16(user);
  const ws = u16('VIVA-APP');
  const base = 64;
  const parts = [lm, nt, dom, usr, ws, Buffer.alloc(0)];
  const head = Buffer.alloc(base);
  head.write('NTLMSSP\0', 0, 'latin1');
  head.writeUInt32LE(3, 8);
  let off = base;
  [12, 20, 28, 36, 44, 52].forEach((pos, i) => {
    const p = parts[i]!;
    head.writeUInt16LE(p.length, pos);
    head.writeUInt16LE(p.length, pos + 2);
    head.writeUInt32LE(off, pos + 4);
    off += p.length;
  });
  head.writeUInt32LE((FLAGS & ~0x00000004) >>> 0, 60);
  return Buffer.concat([head, ...parts]).toString('base64');
}

export interface NtlmResult {
  status: number;
  body: string;
  wwwAuth: string;
}

function send(
  agent: http.Agent,
  url: URL,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<NtlmResult & { raw: http.IncomingMessage }> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        agent,
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)), Connection: 'keep-alive' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            wwwAuth: ([] as string[]).concat(res.headers['www-authenticate'] ?? []).join(', '),
            raw: res,
          }),
        );
      },
    );
    req.on('timeout', () =>
      req.destroy(Object.assign(new Error('Zeitüberschreitung'), { name: 'TimeoutError' })),
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Ein POST mit NTLM-Anmeldung (drei Schritte auf einer Verbindung). */
export async function ntlmPost(
  urlStr: string,
  login: string,
  password: string,
  body: string,
  contentType: string,
  timeoutMs = 20_000,
): Promise<NtlmResult> {
  const url = new URL(urlStr);
  const mod = url.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const r1 = await send(
      agent,
      url,
      { Authorization: `NTLM ${type1()}`, 'Content-Type': contentType },
      '',
      timeoutMs,
    );
    const m = /NTLM\s+([A-Za-z0-9+/=]+)/.exec(r1.wwwAuth);
    if (r1.status !== 401 || !m) return { status: r1.status, body: r1.body, wwwAuth: r1.wwwAuth };
    const t3 = type3(parseType2(m[1]!), login, password);
    const r2 = await send(
      agent,
      url,
      { Authorization: `NTLM ${t3}`, 'Content-Type': contentType },
      body,
      timeoutMs,
    );
    return { status: r2.status, body: r2.body, wwwAuth: r2.wwwAuth };
  } finally {
    agent.destroy();
  }
}
