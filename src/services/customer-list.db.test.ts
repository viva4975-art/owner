import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { customerSerialLetter, customersCsv, filteredCustomers } from './customer-list.js';
import { listTemplates } from './employees.js';
import { listFiles } from './uploads.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Kundenliste und Serienbrief', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    await sql`update app.customers set active = false where customer_no = (select min(customer_no) from app.customers)`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Status-Zählung, Filter nach Status/Buchstabe/Suche, CSV entschärft Formeln', async () => {
    const all = await filteredCustomers(sql, { status: null, letter: null, q: null });
    expect(all.counts.ehemalig).toBe(1);
    expect(all.counts.kunde + all.counts.interessent + all.counts.ehemalig).toBe(all.total);
    const ex = await filteredCustomers(sql, { status: 'ehemalig', letter: null, q: null });
    expect(ex.rows).toHaveLength(1);
    const first = all.rows[0]!;
    const byLetter = await filteredCustomers(sql, {
      status: null,
      letter: first.name[0]!.toUpperCase(),
      q: null,
    });
    expect(byLetter.rows.map((r) => r.id)).toContain(first.id);
    const byQ = await filteredCustomers(sql, { status: null, letter: null, q: first.customer_no });
    expect(byQ.rows.map((r) => r.id)).toEqual([first.id]);
    const csv = customersCsv([{ ...first, name: '=HYPERLINK("x")' }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('Serienbrief: nur Kundenvorlagen, ein PDF, je Kunde in der Akte, doppelt = nichts doppelt', async () => {
    const [t] = await listTemplates(sql, false, 'kunde');
    const [hr] = await listTemplates(sql, false, 'mitarbeiter');
    const ids = (await filteredCustomers(sql, { status: 'kunde', letter: null, q: null })).rows.map(
      (r) => r.id,
    );
    const cfg = { dir: mkdtempSync(join(tmpdir(), 'sb-')), maxBytes: 10_000_000 };
    await expect(
      customerSerialLetter(deps, cfg, {
        runId: randomUUID(),
        templateId: hr!.id,
        customerIds: ids,
        actor: 't',
      }),
    ).rejects.toThrow(/Vorlage für Kunden/);
    const run = randomUUID();
    const pdf = await customerSerialLetter(deps, cfg, {
      runId: run,
      templateId: t!.id,
      customerIds: ids,
      actor: 't',
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(ids.length);
    await customerSerialLetter(deps, cfg, { runId: run, templateId: t!.id, customerIds: ids, actor: 't' });
    const files = await listFiles(sql, { type: 'customer', id: ids[0]! });
    expect(files.filter((f) => f.original_name.startsWith(t!.title.slice(0, 10)))).toHaveLength(1);
  });
});
