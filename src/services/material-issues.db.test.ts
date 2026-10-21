import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { siteCosting } from './costing.js';
import { bookStock, saveArticle } from './inventory.js';
import { cancelMaterialIssue, createMaterialIssue, materialIssuePdf } from './material-issues.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Materialausgabe an Objekt (interner Lieferschein)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('bucht Bestand ab, friert EK ein, zählt in der Nachkalkulation, Storno bucht zurück', async () => {
    const [site] = await sql<{ id: string }[]>`select id from app.sites where site_no = 'INT-BUERO'`;
    const art = randomUUID();
    await saveArticle(
      sql,
      art,
      {
        article_no: 'A-1',
        name: 'Müllbeutel 120 l',
        unit: 'Rolle',
        purchase_price: '3,35',
        min_stock: '0',
        active: 'on',
      },
      null,
      't',
    );
    await bookStock(sql, randomUUID(), art, 10_000n, 'Lieferung', null, 't');
    const today = todayBerlin();
    const id = randomUUID();
    const no = await createMaterialIssue(
      sql,
      id,
      { siteId: site!.id, date: today, lines: [{ articleId: art, quantityMilli: 3_000n }] },
      't',
    );
    expect(no).toMatch(/^MA-\d{4}-0001$/);
    // doppelt absenden: nichts doppelt
    expect(
      await createMaterialIssue(
        sql,
        id,
        { siteId: site!.id, date: today, lines: [{ articleId: art, quantityMilli: 3_000n }] },
        't',
      ),
    ).toBe(no);
    const [a] = await sql<{ stock_milli: bigint }[]>`select stock_milli from app.articles where id = ${art}`;
    expect(a!.stock_milli).toBe(7_000n);
    // späterer Preis ändert die Kosten nicht
    await sql`update app.articles set purchase_price_cents = 999 where id = ${art}`;
    const month = today.slice(0, 7);
    const cost = async () =>
      (await siteCosting(sql, { from: month, to: month })).rows.find((r) => r.site_id === site!.id)
        ?.material ?? 0n;
    expect(await cost()).toBe(1005n);
    // zu wenig Bestand → Fehler, mit Häkchen Fehlbestand zubuchen
    const id2 = randomUUID();
    await expect(
      createMaterialIssue(
        sql,
        id2,
        { siteId: site!.id, date: today, lines: [{ articleId: art, quantityMilli: 9_000n }] },
        't',
      ),
    ).rejects.toThrow(/am Lager/);
    await createMaterialIssue(
      sql,
      id2,
      {
        siteId: site!.id,
        date: today,
        lines: [{ articleId: art, quantityMilli: 9_000n }],
        fillShortage: true,
      },
      't',
    );
    const [b] = await sql<{ stock_milli: bigint }[]>`select stock_milli from app.articles where id = ${art}`;
    expect(b!.stock_milli).toBe(0n);
    expect(await cost()).toBe(1005n + 8991n);
    expect((await materialIssuePdf(sql, id, true))!.length).toBeGreaterThan(1000);
    await cancelMaterialIssue(sql, id, 'falsches Objekt', 't');
    await cancelMaterialIssue(sql, id, 'nochmal', 't');
    expect(await cost()).toBe(8991n);
    const [c] = await sql<{ stock_milli: bigint }[]>`select stock_milli from app.articles where id = ${art}`;
    expect(c!.stock_milli).toBe(3_000n);
  });
});
