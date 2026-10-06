import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  EC_CHECKS,
  EC_DOCS,
  addSlot,
  ecOverview,
  expiresOf,
  finishReview,
  getVersion,
  reportPdf,
  saveChecks,
  setValidity,
  statusOf,
  templatePdf,
  uploadVersion,
} from './eigen-compliance.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const pdf = (s: string) => ({
  bytes: new TextEncoder().encode(`%PDF-1.4 ${s}`),
  name: `${s}.pdf`,
  type: 'application/pdf',
});
const dt = (id: string) => EC_DOCS.find((d) => d.id === id)!;

describe('Gültigkeit', () => {
  it('rechnet Ablauf aus Ausstellung + Monaten, manuell und ohne Ablauf', () => {
    const v = { validity: 'standard', issued_on: '2026-01-31', expires_on: null };
    expect(expiresOf(v, dt('ub_fa'))).toBe('2026-07-31');
    expect(expiresOf({ ...v, validity: '3' }, dt('ub_fa'))).toBe('2026-04-30');
    expect(expiresOf({ ...v, validity: 'manuell', expires_on: '2027-01-01' }, dt('ub_fa'))).toBe(
      '2027-01-01',
    );
    expect(expiresOf({ ...v, validity: '0' }, dt('ub_fa'))).toBeNull();
    const base = { id: 'x', validity: 'standard', expires_on: null } as never;
    expect(
      statusOf({ ...(base as object), issued_on: '2026-01-01' } as never, dt('ub_fa'), '2026-10-06'),
    ).toBe('expired');
    expect(
      statusOf({ ...(base as object), issued_on: '2026-09-01' } as never, dt('ub_fa'), '2026-10-06'),
    ).toBe('valid');
    expect(
      statusOf({ ...(base as object), issued_on: '2026-05-01' } as never, dt('ub_fa'), '2026-10-06'),
    ).toBe('expiring');
    expect(statusOf(undefined, dt('ub_fa'))).toBe('missing');
  });
});

describe.skipIf(!available)('Eigen-Compliance', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Versionen: Ersetzen archiviert, nie löschbar, Mehrfach-Nachweise', async () => {
    const a = await uploadVersion(deps, { key: 'ub_fa', slot: '', file: pdf('fa1') }, 'test');
    const b = await uploadVersion(deps, { key: 'ub_fa', slot: '', file: pdf('fa2') }, 'test');
    let o = await ecOverview(sql);
    const fa = o.entries.find((e) => e.dt.id === 'ub_fa')!;
    expect(fa.items[0]!.current!.id).toBe(b);
    expect(fa.items[0]!.archive.map((x) => x.id)).toEqual([a]);
    expect(fa.status).toBe('valid');
    await expect(sql`delete from app.ec_versions where id = ${a}`).rejects.toThrow(/nicht gelöscht/);
    await expect(
      setValidity(sql, a, { issuedOn: null, validity: '0', expiresOn: null, expectedVersion: null }, 't'),
    ).rejects.toThrow(/unveränderlich/);
    await setValidity(
      sql,
      b,
      { issuedOn: null, validity: 'manuell', expiresOn: '2020-01-01', expectedVersion: null },
      't',
    );
    o = await ecOverview(sql);
    expect(o.entries.find((e) => e.dt.id === 'ub_fa')!.bucket).toBe('crit');
    expect((await getVersion(sql, b))!.expires_on).toBe('2020-01-01');
    // Krankenkassen
    await expect(uploadVersion(deps, { key: 'ub_kk', slot: 'AOK', file: pdf('aok') }, 't')).rejects.toThrow(
      /nicht gefunden/,
    );
    await addSlot(sql, 'ub_kk', 'AOK');
    await addSlot(sql, 'ub_kk', 'TK');
    await uploadVersion(deps, { key: 'ub_kk', slot: 'AOK', file: pdf('aok') }, 't');
    o = await ecOverview(sql);
    const kk = o.entries.find((e) => e.dt.id === 'ub_kk')!;
    expect(kk.items.map((i) => [i.slot, i.status])).toEqual([
      ['AOK', 'valid'],
      ['TK', 'missing'],
    ]);
    expect(kk.status).toBe('expired'); // eine Kasse fehlt → schlechtester Status
    await expect(
      uploadVersion(
        deps,
        { key: 'ub_bg', slot: '', file: { bytes: new Uint8Array(3), name: 'x.exe', type: 'application/x' } },
        't',
      ),
    ).rejects.toThrow(/Nur PDF/);
  });

  it('Prüfung erst abschließbar, wenn alles beantwortet; Report und Vorlagen', async () => {
    await saveChecks(sql, [{ id: 'c1', status: 'ja', note: 'ok' }], 't');
    await expect(finishReview(sql, 't')).rejects.toThrow(/offen/);
    await saveChecks(
      sql,
      EC_CHECKS.map((c) => ({ id: c.id, status: 'na', note: null })),
      't',
    );
    await finishReview(sql, 't');
    expect((await sql`select count(*)::int as n from app.ec_reviews`)[0]!.n).toBe(1);
    expect((await reportPdf(sql)).length).toBeGreaterThan(1000);
    expect((await templatePdf(sql, 'milog')).length).toBeGreaterThan(1000);
    await expect(templatePdf(sql, 'hr')).rejects.toThrow(/keine Vorlage/);
  });
});
