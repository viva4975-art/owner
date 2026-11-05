import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { buildCustomerDossierPdf } from './customer-dossier.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const ok = await dbAvailable();

describe.skipIf(!ok)('Objekt- und Personalübersicht für Kunden', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it(
    'Mitarbeitende, Schlüssel, Ansprechpartner; nur Vorhandenes, keine privaten Daten',
    { timeout: 30_000 },
    async () => {
      const emp = '00000000-0000-4000-8000-00000000d001';
      await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, phone)
              values (${emp}, '8801', 'Anna', 'Beispiel', '2026-01-01', '0176 999')`;
      await sql`insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, valid_from)
              values ('00000000-0000-4000-8000-00000000d002', ${emp}, ${DEMO.siteSchool}, 1, '17:00', '21:30', '2026-02-01'),
                     ('00000000-0000-4000-8000-00000000d003', ${emp}, ${DEMO.siteSchool}, 3, '17:00', '21:30', '2026-02-01')`;
      await sql`insert into app.keys (id, key_no, site_id, description, holder_employee_id, issued_at)
              values ('00000000-0000-4000-8000-00000000d004', 'S-2990101-01', ${DEMO.siteSchool}, 'Transponder Haupteingang', ${emp}, '2026-02-01')`;
      await sql`insert into app.contacts (customer_id, first_name, last_name, position, email)
              values (${DEMO.authority}, 'Karl', 'Kunde', 'Hausverwaltung', 'karl@example.org')`;
      const r = await buildCustomerDossierPdf(deps, DEMO.authority, { findHospital: false });
      const doc = await getDocumentProxy(r.pdf.slice());
      const all = (await extractText(doc, { mergePages: true })).text.replace(/\s+/g, ' ');
      expect(all).toContain('Anna Beispiel');
      expect(all).not.toContain('17:00');
      expect(all).toContain('01.01.2026 (Vertragsbeginn)');
      expect(all).toContain('S-2990101-01');
      expect(all).toContain('Karl Kunde');
      expect(all).toContain('nicht hinterlegt');
      expect(all).not.toContain('0176 999'); // private Telefonnummer geht nicht an den Kunden
      if (process.env.DOSSIER_OUT) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(process.env.DOSSIER_OUT, r.pdf);
      }
    },
  );
  it('Wirksamkeitskontrolle für alle Objekte des Kunden', async () => {
    const { saveRiskCheckForCustomer } = await import('./site-folder.js');
    const n = await saveRiskCheckForCustomer(sql, DEMO.authority, null, '2026-10-01', 'Erna Prüf', 'test');
    const rows = await sql<{ am: string | null; durch: string | null }[]>`
      select folder_info ->> 'gbu_am' as am, folder_info ->> 'gbu_durch' as durch
        from app.sites where customer_id = ${DEMO.authority} and active`;
    expect(n).toBe(rows.length);
    expect(rows.every((r) => r.am === '2026-10-01' && r.durch === 'Erna Prüf')).toBe(true);
    await expect(
      saveRiskCheckForCustomer(sql, DEMO.authority, null, '2999-01-01', 'X', 'test'),
    ).rejects.toThrow(/Zukunft/);
  });
});
