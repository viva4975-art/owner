import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { saveSupplier } from './inventory.js';
import { NU_DOCS, type NuDocKind, nuDocPdf, personnelListXlsx, storeNuDoc } from './nu-docs.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Vorlagen Nachunternehmer', () => {
  let sql: Sql;
  const nu = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await saveSupplier(
      sql,
      nu,
      {
        supplier_no: '70200',
        name: 'Glanz & Co. GmbH',
        kind: 'nachunternehmer',
        legal_form: 'gmbh',
        street: 'Musterweg 1',
        postal_code: '80331',
        city: 'München',
        payment_terms_days: '30',
        active: 'on',
      },
      null,
      't',
    );
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('erzeugt alle Vorlagen als PDF und legt sie einmal ab', async () => {
    for (const k of Object.keys(NU_DOCS) as NuDocKind[]) {
      const d = await nuDocPdf(sql, nu, k, { checked: true, start: '2026-11-01' });
      const pdf = await PDFDocument.load(d.pdf);
      expect(pdf.getPageCount()).toBeGreaterThan(0);
      expect(d.name).toContain('70200');
    }
    const cfg = { dir: await mkdtemp(join(tmpdir(), 'viva-nudoc-')), maxBytes: 10_000_000 };
    const d = await nuDocPdf(sql, nu, 'selbstauskunft', { checked: false });
    const a = await storeNuDoc(sql, cfg, nu, 'selbstauskunft', d, 't');
    const b = await storeNuDoc(sql, cfg, nu, 'selbstauskunft', d, 't');
    expect(a).toBe(b);
    const x = await personnelListXlsx(sql, nu);
    expect(x.data.byteLength).toBeGreaterThan(1000);
  });

  it('Rahmenvertrag braucht eine Anschrift', async () => {
    const id = randomUUID();
    await saveSupplier(
      sql,
      id,
      {
        supplier_no: '70201',
        name: 'Ohne Adresse',
        kind: 'nachunternehmer',
        payment_terms_days: '30',
        active: 'on',
      },
      null,
      't',
    );
    await expect(nuDocPdf(sql, id, 'rahmenvertrag')).rejects.toThrow(/Anschrift/);
  });
});
