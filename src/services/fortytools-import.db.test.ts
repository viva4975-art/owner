import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { analyze, applyImport } from './fortytools-import.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode(s);
// Excel-Export in Windows-1252 mit Umlauten, PLZ ohne führende Null
const latin1 = (s: string) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0)));

const KUNDEN = [
  'Kd-Nr.;Firma;Straße;PLZ;Ort;Leitweg-ID;Rechnungs-E-Mail;Zahlungsziel;Skonto;Skontotage;Sonstiges',
  '20207;Landeshauptstadt München Baureferat;Friedenstraße 40;81660;München;09162000-12345-77;rechnung@muenchen.de;30;;;x',
  '20208;Kita Dresden gGmbH;Hauptstraße 1;1067;Dresden;;buchhaltung@kita.de;14;2;7;',
  '20209;Ohne Ort GmbH;Weg 1;80331;;;;30;;;',
].join('\r\n');

describe.skipIf(!available)('Import aus Fortytools (CSV)', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Kunden: Spalten erkannt, PLZ mit führender Null, Fehler je Zeile, Format aus Leitweg-ID', async () => {
    const a = await analyze(sql, 'kunden', latin1(KUNDEN));
    expect(a.columns.find((c) => c.field === 'customer_no')!.header).toBe('Kd-Nr.');
    expect(a.unknownHeaders).toEqual(['Sonstiges']);
    expect(a.rows.map((r) => r.status)).toEqual(['neu', 'neu', 'fehler']);
    expect(a.rows[2]!.errors.join()).toMatch(/city/);
    const r = await applyImport(deps, {
      id: randomUUID(),
      kind: 'kunden',
      filename: 'kunden.csv',
      bytes: latin1(KUNDEN),
      update: false,
      actor: 't',
    });
    expect(r).toEqual({ created: 2, updated: 0, skipped: 0, errors: 1 });
    const [c] =
      await sql`select name, postal_code, invoice_format::text, is_public_authority, skonto_percent_bp from app.customers where customer_no = '20207'`;
    expect(c).toMatchObject({
      name: 'Landeshauptstadt München Baureferat',
      invoice_format: 'xrechnung',
      is_public_authority: true,
    });
    const [d] =
      await sql`select postal_code, invoice_format::text, skonto_percent_bp, skonto_days from app.customers where customer_no = '20208'`;
    expect(d).toMatchObject({
      postal_code: '01067',
      invoice_format: 'zugferd',
      skonto_percent_bp: 200,
      skonto_days: 7,
    });
  });

  it('zweiter Import: vorhanden → übersprungen; mit „aktualisieren“ überschrieben; gleiche Import-ID nur einmal', async () => {
    const id = randomUUID();
    const r1 = await applyImport(deps, {
      id,
      kind: 'kunden',
      filename: 'k.csv',
      bytes: latin1(KUNDEN),
      update: false,
      actor: 't',
    });
    expect(r1).toMatchObject({ created: 0, skipped: 2 });
    const changed = KUNDEN.replace('Kita Dresden gGmbH', 'Kita Dresden gGmbH (neu)');
    const r2 = await applyImport(deps, {
      id: randomUUID(),
      kind: 'kunden',
      filename: 'k.csv',
      bytes: latin1(changed),
      update: true,
      actor: 't',
    });
    expect(r2).toMatchObject({ created: 0, updated: 2 });
    expect((await sql`select name from app.customers where customer_no = '20208'`)[0]!.name).toBe(
      'Kita Dresden gGmbH (neu)',
    );
    expect(
      await applyImport(deps, {
        id,
        kind: 'kunden',
        filename: 'k.csv',
        bytes: latin1(KUNDEN),
        update: true,
        actor: 't',
      }),
    ).toEqual(r1);
  });

  it('Objekte und Leistungen: Bezug über Nummern, Zyklus/Einheit/Art übersetzt, fehlender Bezug = Fehler', async () => {
    const objekte = [
      'Objektnummer,Kundennummer,Bezeichnung,Straße,PLZ,Ort',
      '2020701,20207,"Grundschule Am Park, Haus A",Parkstr. 1,81667,München',
      '2099901,29999,Unbekannt,,,',
    ].join('\n');
    const ra = await applyImport(deps, {
      id: randomUUID(),
      kind: 'objekte',
      filename: 'o.csv',
      bytes: enc(objekte),
      update: false,
      actor: 't',
    });
    expect(ra).toMatchObject({ created: 1, errors: 1 });
    expect((await sql`select name from app.sites where site_no = '2020701'`)[0]!.name).toBe(
      'Grundschule Am Park, Haus A',
    );

    const leistungen = [
      'Objekt-Nr;Leistung;Betrag;Einheit;MwSt;Beginn;Zyklus;Art;Zusatztext',
      '2020701;Unterhaltsreinigung;3.099,86 €;pauschal;19%;01.01.2026;monatlich;Pauschale;+ 5,07% Tariflohnerhöhung',
      '2020701;Glasreinigung;1.200,00;pauschal;19;01.03.2026;vierteljährlich;Pauschale;',
      '2020701;Regiestunde;29,80;Std;19;01.01.2026;;Regie;',
      '2020701;Falscher Satz;10,00;;16;01.01.2026;;;',
    ].join('\n');
    const a = await analyze(sql, 'leistungen', enc(leistungen));
    expect(a.rows.map((r) => r.status)).toEqual(['neu', 'neu', 'neu', 'fehler']);
    const rl = await applyImport(deps, {
      id: randomUUID(),
      kind: 'leistungen',
      filename: 'l.csv',
      bytes: enc(leistungen),
      update: false,
      actor: 't',
    });
    expect(rl).toMatchObject({ created: 3, errors: 1 });
    const rows = await sql<
      {
        description: string;
        kind: string;
        unit_code: string;
        unit_price_cents: bigint;
        billing_cycle: string;
        note: string | null;
      }[]
    >`
      select ss.description, ss.kind::text, ss.unit_code, ss.unit_price_cents, ss.billing_cycle::text, ss.note
        from app.site_services ss join app.sites s on s.id = ss.site_id where s.site_no = '2020701' order by ss.description`;
    expect(rows).toEqual([
      {
        description: 'Glasreinigung',
        kind: 'monthly_flat',
        unit_code: 'LS',
        unit_price_cents: 120000n,
        billing_cycle: 'quartalsweise',
        note: null,
      },
      {
        description: 'Regiestunde',
        kind: 'hourly',
        unit_code: 'HUR',
        unit_price_cents: 2980n,
        billing_cycle: 'je_ausfuehrung',
        note: null,
      },
      {
        description: 'Unterhaltsreinigung',
        kind: 'monthly_flat',
        unit_code: 'LS',
        unit_price_cents: 309986n,
        billing_cycle: 'monatlich',
        note: '+ 5,07% Tariflohnerhöhung',
      },
    ]);
    // erneut: nichts doppelt
    const again = await applyImport(deps, {
      id: randomUUID(),
      kind: 'leistungen',
      filename: 'l.csv',
      bytes: enc(leistungen),
      update: false,
      actor: 't',
    });
    expect(again).toMatchObject({ created: 0, skipped: 3 });
  });

  it('Pflichtspalte fehlt → klare Meldung', async () => {
    await expect(analyze(sql, 'objekte', enc('Bezeichnung;Ort\nX;Y'))).rejects.toThrow(
      /Objektnummer, Kundennummer/,
    );
  });
});
