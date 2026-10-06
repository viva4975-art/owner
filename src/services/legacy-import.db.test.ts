import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { monthView } from './cashbook.js';
import { analyzeBackup, applyBackup, centsOf } from './legacy-import.js';
import { dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Kleines Beispiel-Backup im Aufbau der alten App (keine echten Daten). */
const backup = () =>
  zipSync({
    'README.txt': new TextEncoder().encode('Viva-Deluxe Backup\nErstellt: 6.10.2026, 14:30:44\n'),
    'data/kassenbuch.json': enc([
      {
        id: 'a1',
        typ: 'ausgabe',
        datum: '2026-05-03',
        beschreibung: 'Putzmittel',
        betrag: 20.06,
        beleg: '',
        beleg_path: 'kasse/a1.pdf',
        kategorie: '',
        notiz: '',
        created_at: '2026-05-03T10:00:00Z',
      },
      {
        id: 'a2',
        typ: 'einnahme',
        datum: '2026-05-02',
        beschreibung: 'Einlage',
        betrag: 100,
        beleg: 'Q-1',
        beleg_path: null,
        kategorie: '',
        notiz: 'bar',
        created_at: '2026-05-02T10:00:00Z',
      },
    ]),
    'data/kasse_anfangsbestand.json': enc([{ id: 'x', monat: '2026-05', betrag: 89.6 }]),
    'data/kasse_kartenbelege.json': enc([
      { id: 'k1', datum: '2026-05-04', betrag: 869.76, beleg_path: 'karten/k1.pdf', notiz: 'Tanken' },
    ]),
    'data/audit_log.json': enc([{ id: 1 }]),
    'data/subunternehmer.json': enc([
      {
        id: 's1',
        firma: 'Test Reinigung',
        kreditor_nr: '70099',
        kuerzel: 'TR',
        status: 'aktiv',
        rechtsform: 'gmbh',
        ansprechpartner_liste: [{ name: 'Frau Sub', telefon: '089 1', email: 'sub@example.org' }],
        documents: { milog: { file_path: 's1/milog.pdf', file_name: 'milog.pdf', expires: '2027-01-31' } },
      },
    ]),
    'data/sub_einsaetze.json': enc([
      { id: 'e1', sub_id: 's1', auftragsnummer: '2026-TR-001', objekt: 'Schule', pdf_path: 's1/auftrag.pdf' },
    ]),
    'data/kleidung_bestand.json': enc([{ id: 'k1', artikel: 'Poloshirt', groesse: 'L', bestand: 7 }]),
    'data/kleidung_preise.json': enc([{ artikel: 'Poloshirt', preis: 12.5 }]),
    'files/subdocs/s1/milog.pdf': new TextEncoder().encode('%PDF-1.4 milog'),
    'files/subdocs/s1/auftrag.pdf': new TextEncoder().encode('%PDF-1.4 auftrag'),
    'files/kassenbelege/kasse/a1.pdf': new TextEncoder().encode('%PDF-1.4 a1'),
    'files/kassenbelege/karten/k1.pdf': new TextEncoder().encode('%PDF-1.4 k1'),
  });

describe('centsOf', () => {
  it('rechnet Gleitkomma der alten App cent-genau um', () => {
    expect(centsOf(869.76)).toBe(86976n);
    expect(centsOf(4)).toBe(400n);
    expect(centsOf('9847.81')).toBe(984781n);
    expect(centsOf(0.1 + 0.2)).toBe(30n);
    expect(() => centsOf('abc')).toThrow();
  });
});

describe.skipIf(!available)('Import aus der alten App', () => {
  let sql: Sql;
  let deps: Deps;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('übernimmt Kasse mit Belegen genau einmal', async () => {
    const a = await analyzeBackup(sql, backup());
    expect(a.created).toBe('6.10.2026, 14:30:44');
    expect(a.sections.find((s) => s.key === 'kasse')).toMatchObject({ total: 3, neu: 3, vorhanden: 0 });
    expect(a.tables.find((t) => t.name === 'audit_log')).toMatchObject({ used: false });
    const out = await applyBackup(deps, backup(), ['kasse'], 'test');
    expect(out[0]).toMatch(/2 Buchungen übernommen \(1 Belege\), 1 Karten-Belege, 1 Anfangsbestände/);
    const v = await monthView(sql, '2026-05');
    expect(v.opening).toBe(8960n);
    expect(v.rows.map((r) => [r.entry_no, r.description, r.saldo])).toEqual([
      [1, 'Einlage', 18960n],
      [2, 'Putzmittel', 16954n],
    ]);
    expect(new TextDecoder().decode(await deps.archive.get(v.rows[1]!.receipt_path!))).toBe('%PDF-1.4 a1');
    // zweites Mal: nichts doppelt
    await applyBackup(deps, backup(), ['kasse'], 'test');
    expect((await sql`select count(*)::int as n from app.cash_entries`)[0]!.n).toBe(2);
    expect((await sql`select count(*)::int as n from app.card_receipts`)[0]!.n).toBe(1);
    expect((await analyzeBackup(sql, backup())).sections[0]).toMatchObject({ neu: 0, vorhanden: 3 });
  });

  it('übernimmt Nachunternehmer mit Nachweisen und Arbeitskleidung idempotent', async () => {
    const out = await applyBackup(deps, backup(), ['nachunternehmer', 'sonstiges'], 'test');
    expect(out[0]).toMatch(/1 angelegt, 1 Nachweise, 1 Auftragsdokumente/);
    await applyBackup(deps, backup(), ['nachunternehmer', 'sonstiges'], 'test');
    const [sup] = await sql<{ id: string; kind: string; supplier_no: string }[]>`
      select id, kind, supplier_no from app.suppliers where legacy_id = 'sub:s1'`;
    expect(sup).toMatchObject({ kind: 'nachunternehmer', supplier_no: '70099' });
    const docs = await sql<{ doc_type: string; valid_until: string; status: string }[]>`
      select doc_type, valid_until::text, status from app.supplier_documents where supplier_id = ${sup!.id}`;
    expect(docs).toEqual([{ doc_type: 'milog', valid_until: '2027-01-31', status: 'gueltig' }]);
    const [{ qty }] = (await sql`
      select sum(m.delta)::int as qty from app.clothing_moves m join app.clothing_articles a on a.id = m.article_id
       where a.name = 'Poloshirt' and m.size = 'L'`) as unknown as [{ qty: number }];
    expect(qty).toBe(7);
  });

  it('lehnt Nicht-ZIP ab', async () => {
    await expect(analyzeBackup(sql, new Uint8Array([1, 2, 3]))).rejects.toThrow(/keine gültige ZIP/);
  });
});
