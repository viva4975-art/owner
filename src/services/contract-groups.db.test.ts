import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  contractGroupOfSite,
  deleteContractGroup,
  listContractGroups,
  saveContractGroup,
} from './contract-groups.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import { groupCostRows } from '../web/costing-groups.js';

const available = await dbAvailable();

describe.skipIf(!available)('Auftragsgruppen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('anlegen, jedes Objekt nur in einer Gruppe, Ansicht je Gruppe/Kunde, löschen', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await saveContractGroup(
      sql,
      {
        id: a,
        name: 'Ausschreibung A',
        note: null,
        tenderId: null,
        siteIds: [DEMO.siteSchool, DEMO.siteOffice],
      },
      't',
    );
    await expect(
      saveContractGroup(
        sql,
        { id: b, name: 'B', note: null, tenderId: null, siteIds: [DEMO.siteSchool] },
        't',
      ),
    ).rejects.toThrow(/anderen Auftragsgruppe/);
    // doppelt speichern ändert nichts doppelt
    await saveContractGroup(
      sql,
      {
        id: a,
        name: 'Ausschreibung A',
        note: 'x',
        tenderId: null,
        siteIds: [DEMO.siteSchool, DEMO.siteOffice],
      },
      't',
    );
    const list = await listContractGroups(sql);
    expect(list.find((g) => g.id === a)!.site_ids.length).toBe(2);
    const of = await contractGroupOfSite(sql);
    const rows = [DEMO.siteSchool, DEMO.siteOffice, DEMO.siteHq].map((site_id, i) => ({
      site_id,
      customer_id: i < 2 ? 'k1' : 'k2',
      customer_name: i < 2 ? 'Kunde 1' : 'Kunde 2',
    }));
    const byGroup = groupCostRows(rows, 'gruppe', of);
    expect(byGroup.map((g) => [g.name, g.rows.length])).toEqual([
      ['Ausschreibung A', 2],
      ['ohne Auftragsgruppe', 1],
    ]);
    expect(groupCostRows(rows, 'kunde', of).map((g) => g.rows.length)).toEqual([2, 1]);
    await deleteContractGroup(sql, a, 't');
    expect((await contractGroupOfSite(sql)).size).toBe(0);
  });
});
