import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { type WarningInput, warningLetterDocx, warningLetterPdf } from './warning-letter.js';

const available = await dbAvailable();

const inc = (o: Partial<WarningInput['incidents'][number]>) => ({
  reason: '',
  date: '2026-11-10',
  siteId: '',
  plan: '',
  actual: '',
  detail: '',
  ...o,
});
const base: WarningInput = {
  incidents: [],
  level: 'normal',
  previous: '',
  receipt: true,
  place: '',
  date: '2026-11-20',
};

describe.skipIf(!available)('Abmahnung', () => {
  let sql: Sql;
  const emp = randomUUID();
  beforeAll(async () => {
    sql = await freshDatabase();
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, employment_type, salutation)
              values (${emp}, '9871', 'Paul', 'Spät', '2025-01-01', 'teilzeit', 'Herr')`;
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('prüft Grund, Uhrzeit und Pflicht-Ergänzung', async () => {
    await expect(warningLetterPdf(sql, emp, base)).rejects.toThrow(/mindestens einen Grund/);
    await expect(
      warningLetterPdf(sql, emp, { ...base, incidents: [inc({ reason: 'verspaetung' })] }),
    ).rejects.toThrow(/Arbeitsbeginn laut Plan/);
    await expect(
      warningLetterPdf(sql, emp, { ...base, incidents: [inc({ reason: 'alkohol' })] }),
    ).rejects.toThrow(/genau beschreiben/);
    await expect(
      warningLetterPdf(sql, emp, { ...base, incidents: [inc({ reason: 'fehlen', date: '2099-01-01' })] }),
    ).rejects.toThrow(/Zukunft/);
  });

  it('erstellt PDF und Word mit mehreren Vorfällen', async () => {
    const input: WarningInput = {
      ...base,
      level: 'letzte',
      incidents: [
        inc({ reason: 'verspaetung', plan: '06:00', actual: '07:15' }),
        inc({
          reason: 'mangelhaft',
          date: '2026-11-12',
          detail: 'Sanitärräume EG nicht gereinigt, Beanstandung Kunde.',
        }),
      ],
    };
    const p = await warningLetterPdf(sql, emp, input);
    expect(p.name).toMatch(/^Abmahnung_9871_Paul_Sp/);
    expect(p.pdf.length).toBeGreaterThan(1000);
    const w = await warningLetterDocx(sql, emp, input);
    const { unzipSync, strFromU8 } = await import('fflate');
    const xml = strFromU8(unzipSync(w.data)['word/document.xml']!);
    expect(xml).toContain('LETZTE ABMAHNUNG');
    expect(xml).toContain('erst um 07:15 Uhr');
    expect(xml).toContain('Sehr geehrter Herr Spät,');
    expect(xml).toContain('Sanitärräume EG');
    expect(xml).toContain('werden wir das Arbeitsverhältnis kündigen');
    expect(xml).toContain('Empfangsbestätigung');
  });
});
