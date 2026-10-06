import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  customerRevenue,
  deleteCustomerBankAccount,
  listCustomerBankAccounts,
  saveCustomerBankAccount,
} from './customer-overview.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Kundenübersicht', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Bankkonten: IBAN-Prüfziffer, keine Dublette, entfernen', async () => {
    await expect(
      saveCustomerBankAccount(
        sql,
        DEMO.authority,
        { holder: 'X', iban: 'DE02120300000000202052', bic: null },
        't',
      ),
    ).rejects.toThrow(/IBAN ungültig/);
    await saveCustomerBankAccount(
      sql,
      DEMO.authority,
      { holder: 'Stadtkasse', iban: 'DE02 1203 0000 0000 2020 51', bic: 'byladem1001' },
      't',
    );
    await expect(
      saveCustomerBankAccount(
        sql,
        DEMO.authority,
        { holder: 'Y', iban: 'DE02120300000000202051', bic: null },
        't',
      ),
    ).rejects.toThrow(/schon hinterlegt/);
    const [a] = await listCustomerBankAccounts(sql, DEMO.authority);
    expect(a).toMatchObject({ holder: 'Stadtkasse', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' });
    await deleteCustomerBankAccount(sql, DEMO.authority, a!.id, 't');
    expect(await listCustomerBankAccounts(sql, DEMO.authority)).toHaveLength(0);
  });

  it('Netto-Umsatz: jeder Monat ab Januar des gewählten Jahres bis heute', async () => {
    const year = new Date().getFullYear();
    const rows = await customerRevenue(sql, DEMO.authority, 'rechnung', year);
    expect(rows[0]!.month).toBe(`${year}-01`);
    expect(rows.length).toBe(new Date().getMonth() + 1);
    expect(await customerRevenue(sql, randomUUID(), 'leistung', year)).toHaveLength(rows.length);
  });
});
