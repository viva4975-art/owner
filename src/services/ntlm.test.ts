import { describe, expect, it } from 'vitest';
import { md4, ntowfv2, type3 } from './ntlm.js';

describe('NTLMv2 (Prüfwerte aus MS-NLMP 4.2.4)', () => {
  it('MD4 und NTOWFv2', () => {
    expect(md4(Buffer.alloc(0)).toString('hex')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0');
    expect(md4(Buffer.from('abc')).toString('hex')).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(md4(Buffer.from('Password', 'utf16le')).toString('hex')).toBe('a4f49c406510bdcab6824ee7c30fd852');
    expect(ntowfv2('User', 'Domain', 'Password').toString('hex')).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
  });
  it('NTProofStr im Typ-3-Paket', () => {
    const av = Buffer.concat([
      Buffer.from([2, 0, 12, 0]),
      Buffer.from('Domain', 'utf16le'),
      Buffer.from([1, 0, 12, 0]),
      Buffer.from('Server', 'utf16le'),
      Buffer.alloc(4),
    ]);
    const msg = Buffer.from(
      type3(
        { challenge: Buffer.from('0123456789abcdef', 'hex'), targetInfo: av },
        'Domain\\User',
        'Password',
        {
          clientChallenge: Buffer.alloc(8, 0xaa),
          time: Buffer.alloc(8),
        },
      ),
      'base64',
    );
    const ntOff = msg.readUInt32LE(24);
    expect(msg.subarray(ntOff, ntOff + 16).toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c');
  });
});

describe('NTLM-Ablauf gegen einen nachgebauten Server', () => {
  it('drei Schritte auf einer Verbindung, richtiges Passwort angenommen, falsches abgelehnt', async () => {
    const http = await import('node:http');
    const { createHmac } = await import('node:crypto');
    const challenge = Buffer.from('1122334455667788', 'hex');
    const t2 = (() => {
      const b = Buffer.alloc(48);
      b.write('NTLMSSP\0', 0, 'latin1');
      b.writeUInt32LE(2, 8);
      b.writeUInt32LE(0xa2898205, 20);
      challenge.copy(b, 24);
      return b.toString('base64');
    })();
    const sockets = new Set<unknown>();
    const srv = http.createServer((req, res) => {
      sockets.add(req.socket);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const a = String(req.headers.authorization ?? '');
        const msg = Buffer.from(a.replace(/^NTLM /, ''), 'base64');
        if (!a.startsWith('NTLM ') || msg.readUInt32LE(8) === 1) {
          res.writeHead(401, { 'WWW-Authenticate': a ? `NTLM ${t2}` : 'NTLM' });
          return res.end();
        }
        const ntL = msg.readUInt16LE(20),
          ntO = msg.readUInt32LE(24);
        const uL = msg.readUInt16LE(36),
          uO = msg.readUInt32LE(40);
        const user = msg.subarray(uO, uO + uL).toString('utf16le');
        const nt = msg.subarray(ntO, ntO + ntL);
        const key = ntowfv2(user, '', 'geheim');
        const proof = createHmac('md5', key).update(challenge).update(nt.subarray(16)).digest();
        const ok = proof.equals(nt.subarray(0, 16)) && body === '<x/>';
        res.writeHead(ok ? 200 : 401);
        res.end(ok ? 'gut' : '');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/EWS/Exchange.asmx`;
    const { ntlmPost } = await import('./ntlm.js');
    const good = await ntlmPost(url, 'ahmed@viva.test', 'geheim', '<x/>', 'text/xml');
    expect(good.status).toBe(200);
    expect(good.body).toBe('gut');
    expect(sockets.size).toBe(1);
    const bad = await ntlmPost(url, 'ahmed@viva.test', 'falsch', '<x/>', 'text/xml');
    expect(bad.status).toBe(401);
    srv.close();
  });
});
