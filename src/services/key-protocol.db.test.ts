import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { importKeyProtocol, parseKeyProtocol, planKeyProtocol, siteNoCandidates } from './key-protocol.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const EMP = '00000000-0000-4000-8000-00000000ce01';
const FILE = '00000000-0000-4000-8000-00000000ce02';

const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const row = (...c: string[]) => `<w:tr>${c.map(cell).join('')}</w:tr>`;
const tbl = (...r: string[]) => `<w:tbl>${r.join('')}</w:tbl>`;
const docx = () =>
  zipSync({
    'word/document.xml': strToU8(
      `<w:document><w:body>` +
        tbl(
          row('Mitarbeiter', 'Max Muster'),
          row('Personal-Nr.', '7781'),
          row('Datum der Übergabe', '20.10.2026'),
        ) +
        tbl(
          row('Nr.', 'Ort', 'Art', 'Anzahl', 'Kennung / Nummer'),
          row('1', 'Grundschule2990101', 'Schlüssel', '1', 'BKS 0815'),
          row('2', 'Grundschule2990101', 'Schlüssel', '2', 'Mauser M1'),
          row('3', '2990102', 'Transponder', '1', 'Chip 15 &amp; Hülle'),
          row('4', 'Unbekannt 1234567', 'Schlüssel', '1', 'X'),
        ) +
        `</w:body></w:document>`,
    ),
  });

describe.skipIf(!available)('Schlüsselprotokoll einlesen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type)
              values (${EMP}, '7781', 'Max', 'Muster', '2026-01-01', 'vollzeit')`;
    await sql`insert into app.files (id, original_name, content_type, size_bytes, chunk_size, total_chunks,
                                     uploaded_by, status, sha256, storage_path, completed_at)
              values (${FILE}, 'p.docx', 'x', 1, 1, 1, 't', 'complete', 'x', 'p.docx', now())`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('liest Kopf und Tabelle', () => {
    const p = parseKeyProtocol(docx());
    expect(p).toMatchObject({ employeeName: 'Max Muster', personnelNo: '7781', date: '2026-10-20' });
    expect(p.rows).toHaveLength(4);
    expect(p.rows[1]).toMatchObject({ qty: 2, kennung: 'Mauser M1' });
    expect(p.rows[2]!.kennung).toBe('Chip 15 & Hülle');
    expect(siteNoCandidates('Büro INT-BUERO')).toEqual(['INT-BUERO']);
    expect(siteNoCandidates('Wilhelmsgymnasium2010021')).toEqual(['2010021']);
  });

  it('legt Schlüssel an, gibt aus, verknüpft Protokoll – erneut nichts doppelt', async () => {
    const data = docx();
    const plan = await planKeyProtocol(sql, parseKeyProtocol(data), EMP, null);
    expect(plan.rows.map((r) => r.status)).toEqual(['neu', 'neu', 'neu', 'kein_objekt']);
    const r = await importKeyProtocol(sql, { employeeId: EMP, fileId: FILE, data, sites: null }, 't');
    expect(r).toMatchObject({ created: 3, issued: 3, skipped: 1, sites: 2 });
    const keys = await sql<
      { key_no: string; holder_employee_id: string; issued_at: string; quantity: number }[]
    >`
      select key_no, holder_employee_id, issued_at::text, quantity from app.keys
       where holder_employee_id = ${EMP} order by key_no`;
    expect(keys.map((k) => k.key_no)).toEqual(['S-2990101-01', 'S-2990101-02', 'S-2990102-01']);
    expect(keys.every((k) => k.issued_at === '2026-10-20')).toBe(true);
    const links =
      await sql`select entity_type, entity_id, category from app.file_links where file_id = ${FILE}`;
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.category === 'Schlüssel')).toBe(true);
    expect(links.some((l) => l.entity_id === DEMO.siteOffice)).toBe(true);
    // zweites Mal: alles schon ausgegeben
    const again = await importKeyProtocol(sql, { employeeId: EMP, fileId: FILE, data, sites: null }, 't');
    expect(again).toMatchObject({ created: 0, issued: 0 });
    const [{ n }] =
      (await sql`select count(*)::int as n from app.key_log where employee_id = ${EMP}`) as unknown as [
        { n: number },
      ];
    expect(n).toBe(3);
  });

  it('lehnt Protokoll eines anderen Mitarbeiters ab', async () => {
    await sql`update app.employees set personnel_no = '9999' where id = ${EMP}`;
    await expect(
      importKeyProtocol(sql, { employeeId: EMP, fileId: FILE, data: docx(), sites: null }, 't'),
    ).rejects.toThrow(/Personal-Nr. 7781/);
  });
});
