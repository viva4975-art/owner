import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { siteContractPdf, suggestedLaborPercent } from './site-contracts.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Verträge am Objekt', () => {
  let sql: Sql;
  let siteId: string;
  beforeAll(async () => {
    sql = await freshDatabase();
    const [s] = await sql<{ id: string }[]>`
      select s.id from app.sites s join app.customers c on c.id = s.customer_id
       where not c.is_internal and exists (select 1 from app.site_services ss where ss.site_id = s.id and ss.active)
       limit 1`;
    siteId = s!.id;
  });
  afterAll(async () => {
    await sql?.end();
  });
  const text = async (pdf: Uint8Array) =>
    (await extractText(await getDocumentProxy(pdf), { mergePages: true })).text;

  it('Reinigungsvertrag mit Leistungsverzeichnis und Lohngleitklausel', async () => {
    await suggestedLaborPercent(sql, siteId);
    await expect(siteContractPdf(sql, siteId, 'reinigung', {})).rejects.toThrow(/Lohnkostenanteil/);
    const r = await siteContractPdf(sql, siteId, 'reinigung', {
      start: '2026-11-01',
      laborPercent: '80',
      term: 'fest',
      end: '2027-10-31',
    });
    const t = await text(r.pdf);
    expect(t).toContain('Reinigungsvertrag');
    expect(t).toContain('Leistungsverzeichnis');
    expect(t).toContain('80 %');
    expect(t).toContain('31.10.2027');
    expect(t).not.toMatch(/Gutschrift|\{\w+\}/);
  });

  it('AÜ-Vertrag nur mit Erlaubnis, mit Pflichtangaben', async () => {
    const input = { start: '2026-11-01', activity: 'Reinigungskraft', rate: '32,50' };
    await sql`update app.company set aue_permit_date = null where id = 1`;
    await expect(siteContractPdf(sql, siteId, 'aue', input)).rejects.toThrow(/Erlaubnis/);
    await sql`update app.company set aue_permit_date = '2020-05-01', aue_permit_authority = 'Bundesagentur für Arbeit',
                aue_permit_file_no = 'AÜ-123', aue_permit_unlimited = true where id = 1`;
    const t = await text((await siteContractPdf(sql, siteId, 'aue', input)).pdf);
    expect(t).toContain('Arbeitnehmerüberlassung');
    expect(t).toContain('AÜ-123');
    expect(t).toContain('18');
    expect(t).toContain('32,50');
    expect(t).not.toMatch(/\{\w+\}/);
    const t0 = await text(
      (await siteContractPdf(sql, siteId, 'aue', { ...input, placementFactor: '0' })).pdf,
    );
    expect(t0).toContain('keine Vermittlungsvergütung');
  });
});
