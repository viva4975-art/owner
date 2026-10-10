import { describe, expect, it } from 'vitest';
import { objectPath, signV4 } from './s3.js';

describe('S3 Signatur V4', () => {
  it('stimmt mit dem AWS-Beispiel (GET Object mit Range) überein', () => {
    const h = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('kodiert Objektschlüssel je Pfadteil', () => {
    expect(objectPath('archiv', 'invoices/2026/RE 1 ä.pdf')).toBe(
      '/archiv/invoices/2026/RE%201%20%C3%A4.pdf',
    );
  });
});
