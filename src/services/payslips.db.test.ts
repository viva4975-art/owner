import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { findPersonnelNo, importPayslips, listPayslips, releasePayslips } from './payslips.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

async function pdf(pages: string[]) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of pages) d.addPage([595, 842]).drawText(t, { x: 50, y: 780, size: 12, font: f });
  return d.save();
}

describe('Personalnummer finden', () => {
  it('beschriftet, führende Null, sonst eindeutige bekannte Nummer', () => {
    const known = new Set(['7701', '7702']);
    expect(findPersonnelNo('Abrechnung Oktober Pers.-Nr. 07701 Brutto 1.234', known)).toBe('7701');
    expect(findPersonnelNo('Personalnummer: 7702', known)).toBe('7702');
    expect(findPersonnelNo('Lohn 7701 und 7702', known)).toBeNull();
    expect(findPersonnelNo('nichts', known)).toBeNull();
  });
});

describe.skipIf(!available)('Lohnabrechnungen einlesen (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const a = randomUUID();
  const b = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'lohn-'));
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date)
              values (${a}, '7701', 'Ana', 'Eins', '2024-01-01'), (${b}, '7702', 'Bo', 'Zwei', '2024-01-01')`;
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('Sammel-PDF: Folgeseite gehört zur vorigen Person, Unbekanntes wird gemeldet; erneut einlesen ohne Dubletten', async () => {
    const bytes = await pdf(['Lohnabrechnung Pers.-Nr. 7701', 'Seite 2 Lohnkonto', 'Personalnummer 7702']);
    const cfg = { dir, maxBytes: 5e7 };
    const r = await importPayslips(sql, cfg, {
      name: 'Sammel.pdf',
      bytes,
      month: '2026-09',
      release: false,
      actor: 't',
    });
    expect(r.assigned.map((x) => [x.personnel_no, x.pages])).toEqual([
      ['7701', 2],
      ['7702', 1],
    ]);
    expect(r.unassigned).toEqual([]);
    await new Promise((res) => setTimeout(res, 1100)); // PDF-Zeitstempel ändern sich je Sekunde
    await importPayslips(sql, cfg, {
      name: 'Sammel.pdf',
      bytes,
      month: '2026-09',
      release: false,
      actor: 't',
    });
    expect(await listPayslips(sql, { month: '2026-09' })).toHaveLength(2);
    expect(await releasePayslips(sql, '2026-09', 't')).toBe(2);
    expect(await listPayslips(sql, { employeeId: a, releasedOnly: true })).toHaveLength(1);
    const bad = await importPayslips(sql, cfg, {
      name: 'x.pdf',
      bytes: await pdf(['ohne Nummer']),
      month: '2026-09',
      release: false,
      actor: 't',
    });
    expect(bad.unassigned[0]).toMatch(/keine Personalnummer/);
  }, 30_000); // PDF-Textauslese ist unter Volllast der Testsuite langsam

  it('ZIP mit Einzel-PDFs: Nummer aus dem Dateinamen', async () => {
    const zip = zipSync({
      'Lohn_7702_2026-10.pdf': await pdf(['Lohnabrechnung Oktober']),
      'Lohn_7701.pdf': await pdf(['Pers.-Nr. 7701']),
    });
    const r = await importPayslips(
      sql,
      { dir, maxBytes: 5e7 },
      { name: 'lohn.zip', bytes: zip, month: '2026-10', release: true, actor: 't' },
    );
    expect(r.assigned.map((x) => x.personnel_no).sort()).toEqual(['7701', '7702']);
  });
});
