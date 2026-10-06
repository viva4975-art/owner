import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  applyPlan,
  buildPlan,
  detectTable,
  parseCsv,
  parsePaymentTerms,
  planCounts,
  stageFtFile,
} from './fortytools-export-import.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();
const enc = (s: string) => new TextEncoder().encode('\uFEFF' + s);

// Aufbau wie die echten Fortytools-Exporte, Inhalte erfunden
const KUNDEN = [
  '"{one: ""Kundenstatus"", other: ""Kundenstatus""}";"Kundennummer";"Kurzname";"Name";"Straße";"PLZ";"Ort";"Zusatz";"Telefon";"Fax";"Mobilnummer";"E-Mail";"Homepage";"{one: ""Zahlungsbedingung"", other: ""Zahlungsbedingungen""}";"IBAN";"Kontoinhaber";"BIC";"Kurzinfo";"Einsatzort-Notizen";"Anrede";"Vorname";"Nachname";"E-Mail";"Telefon";"Mobil"',
  '"Kunde";"30001";"SCHULE A";"Stadt Musterhausen\nSchulreferat";"Amtsweg 1";"80331";"München";"";"089 1";"";"";"rechnung@example.org";"";"7 Tage 3%, 20 Tage netto";"DE02120300000000202051";"Stadt Musterhausen";"BYLADEM1001";"";"";"Frau";"Erika";"Muster";"erika@example.org";"";""',
  '"Kunde";"30001";"SCHULE A";"Stadt Musterhausen\nSchulreferat";"Amtsweg 1";"80331";"München";"";"089 1";"";"";"rechnung@example.org";"";"7 Tage 3%, 20 Tage netto";"DE02120300000000202051";"Stadt Musterhausen";"BYLADEM1001";"";"";"Herr";"Max";"Beispiel";"";"";""',
  '"Kunde";"30002";"REINIGER B";"Reiniger B GmbH";"Weg 2";"1067";"Dresden";"";"";"";"";"keine-mail";"";"7 Tage 3%, 20 Tage netto SUBUNTERNEHMER";"";"";"";"";""',
  '"Interessent";"";"INTERESSENT C";"Interessent C AG";"Platz 3";"80333";"München";"";"";"";"";"";"";"";"";"";"";"";""',
  '"Ehemaliger Kunde";"";"OHNE ADRESSE";"Ohne Adresse KG";"";"";"";"";"";"";"";"";"";"";"";"";"";"";""',
].join('\r\n');

const OBJEKTE = [
  '"Kundennummer";"{one: ""Kunde"", other: ""Kunden""}";"Name";"Straße";"PLZ";"Ort";"Zusatz";"Status"',
  '"30001";"SCHULE A";"Grundschule Nord";"Nordstr. 1";"80331";"München";"";"aktiv"',
  '"30001";"SCHULE A";"Turnhalle";"Nordstr. 2";"80331";"München";"";"aktiv"',
  '"30001";"SCHULE A";"Turnhalle";"Südstr. 9";"80331";"München";"";"aktiv"',
  '"";"REINIGER B";"Lager";"Weg 2";"01067";"Dresden";"";"aktiv"',
].join('\r\n');

const LEISTUNGEN = [
  'Kundennummer;Kundenname;Straße;PLZ;Ort;Zusatz;Objektname;Auftragsnummer;Link zum Auftrag;Leistungsart;Titel;Beschreibung;Menge;Betrag;Anfangsdatum;Enddatum',
  '30001;Stadt Musterhausen;Amtsweg 1;80331;München;;Grundschule Nord;;https://ft.example/contracts/1;Unterhaltsreinigung;Grundschule Nord;Mo–Fr;1,0;1.447,50;01.01.2026;',
  '30001;Stadt Musterhausen;Amtsweg 1;80331;München;;Grundschule Nord;;https://ft.example/contracts/1;Glasreinigung mit Rahmen;;inkl. Rahmen;1,0;980,0;01.01.2026;',
  '30001;Stadt Musterhausen;Amtsweg 1;80331;München;;Turnhalle;;https://ft.example/contracts/2;Tiefgaragenreinigung;;;1.110,0;0,47;04.06.2025;31.12.2026',
  '30001;Stadt Musterhausen;Amtsweg 1;80331;München;;;200004;https://ft.example/contracts/3;Sonderreinigung;Intensivreinigung;;1,0;200,0;01.02.2026;',
].join('\r\n');

const MITARBEITER = [
  'Personalnummer,Anrede,Nachname,Vorname,Geburtsdatum,Email,Telefon,Mobil,Straße,PLZ,Ort,Information,Staff groups,Wochenstunden,Tags,Eintrittsdatum,Austrittsdatum',
  '8001,Frau,Muster,Anna,01.02.1980,anna@example.org,,0170 1,Weg 1,80331,München,,,9.0,Minijob,01.10.2024,',
  '8002,Herr,Beispiel,Bernd,,kaputt@,,,,,,,,39.0,"Vollzeit, Objektleitung",01.12.2023,31.01.2025',
  '8003,Herr,Ohne,Tag,,,,,,,,,,32.0,,01.03.2024,',
  '8004,Frau,Kein,Eintritt,,,,,,,,,,20.0,Teilzeit,,',
].join('\r\n');

describe('Fortytools-Exporte: Lesen', () => {
  it('CSV mit Zeilenumbruch im Feld und doppelten Anführungszeichen', () => {
    expect(parseCsv('a;"b\nc";"d ""x"""\r\n1;2;3')).toEqual([
      ['a', 'b\nc', 'd "x"'],
      ['1', '2', '3'],
    ]);
  });
  it('Zahlungsbedingung', () => {
    expect(parsePaymentTerms('7 Tage 3%, 20 Tage netto')).toEqual({
      days: 20,
      skontoDays: 7,
      skontoPercent: '3',
      subcontractor: false,
    });
    expect(parsePaymentTerms('10 Tage netto').days).toBe(10);
    expect(parsePaymentTerms('7 Tage 3%, 20 Tage netto SUBUNTERNEHMER').subcontractor).toBe(true);
  });
  it('erkennt die Dateien an der Kopfzeile', () => {
    expect([KUNDEN, OBJEKTE, LEISTUNGEN, MITARBEITER].map((t) => detectTable(enc(t)).kind)).toEqual([
      'kunden',
      'objekte',
      'leistungen',
      'mitarbeiter',
    ]);
    expect(() => detectTable(enc('a;b\n1;2'))).toThrow(/nicht erkannt/);
  });
});

describe.skipIf(!available)('Fortytools-Gesamtimport', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const files = async () => {
    const out = [];
    for (const [name, t] of [
      ['Kunden.csv', KUNDEN],
      ['Objekte.csv', OBJEKTE],
      ['Leistungen.csv', LEISTUNGEN],
      ['Mitarbeiter.csv', MITARBEITER],
    ] as const)
      out.push({ ...(await stageFtFile(deps, enc(t))), name });
    return out;
  };

  it('Vorschau: Zahlen und Probleme', async () => {
    const plan = await buildPlan(
      sql,
      [KUNDEN, OBJEKTE, LEISTUNGEN, MITARBEITER].map((t) => detectTable(enc(t))),
    );
    const n = planCounts(plan);
    expect(n.kunden).toEqual({ neu: 3, vorhanden: 0, fehler: 1 });
    // 4 Objekte + „Allgemein“ für die Leistung ohne Objekt
    expect(n.objekte).toEqual({ neu: 5, vorhanden: 0, fehler: 0 });
    expect(n.leistungen).toEqual({ neu: 4, vorhanden: 0, fehler: 0 });
    expect(n.mitarbeiter).toEqual({ neu: 3, vorhanden: 0, fehler: 1 });
    expect(n.kontakte).toBe(2);
    expect(n.bankkonten).toBe(1);
    const texts = plan.issues.map((i) => i.text).join('\n');
    expect(texts).toMatch(/SUBUNTERNEHMER/);
    expect(texts).toMatch(/mehrdeutig/);
    expect(texts).toMatch(/Eintrittsdatum fehlt/);
    expect(texts).toMatch(/ohne Tag/);
  });

  it('Übernahme legt alles an, zweiter Lauf nichts doppelt', async () => {
    const f = await files();
    const r = await applyPlan(deps, { id: randomUUID(), files: f, update: false, actor: 't' });
    expect(r.created).toBe(3 + 5 + 4 + 3);
    const [k] = await sql`
      select name, name2, payment_terms_days, skonto_percent_bp, skonto_days, invoice_emails, invoice_format::text
        from app.customers where customer_no = '30001'`;
    expect(k).toMatchObject({
      name: 'Stadt Musterhausen',
      name2: 'Schulreferat',
      payment_terms_days: 20,
      skonto_percent_bp: 300,
      skonto_days: 7,
      invoice_emails: ['rechnung@example.org'],
      invoice_format: 'zugferd',
    });
    const [b] = await sql`select postal_code, warning from app.customers where customer_no = '30002'`;
    expect(b!.postal_code).toBe('01067');
    expect(b!.warning).toMatch(/§ 13b/);
    // Interessent ohne Nummer bekommt die nächste freie Nummer
    const [c] = await sql`select customer_no, status, active from app.customers where name = 'Interessent C AG'`;
    expect(c).toMatchObject({ customer_no: '30003', status: 'interessent', active: true });
    const sites = await sql<{ site_no: string; name: string }[]>`
      select site_no, name from app.sites where site_no like '300%' order by site_no`;
    expect(sites.map((s) => s.site_no)).toEqual(['3000101', '3000102', '3000103', '3000104', '3000201']);
    expect(sites.find((s) => s.site_no === '3000104')!.name).toMatch(/Allgemein/);
    const svc = await sql`
      select s.site_no, ss.description, ss.billing_cycle::text, ss.kind::text, ss.unit_code, ss.quantity_milli,
             ss.unit_price_cents, ss.valid_to::text, t.name as type
        from app.site_services ss join app.sites s on s.id = ss.site_id
        left join app.service_types t on t.id = ss.service_type_id
       where s.site_no like '300%' order by s.site_no, ss.description`;
    expect(svc.find((x) => x.type === 'Unterhaltsreinigung')).toMatchObject({
      site_no: '3000101',
      billing_cycle: 'monatlich',
      kind: 'monthly_flat',
      unit_price_cents: 144750n,
    });
    expect(svc.find((x) => x.type === 'Tiefgaragenreinigung')).toMatchObject({
      site_no: '3000102',
      billing_cycle: 'je_ausfuehrung',
      unit_code: 'MTK',
      quantity_milli: 1110000n,
      unit_price_cents: 47n,
      valid_to: '2026-12-31',
    });
    expect(svc.find((x) => x.type === 'Glasreinigung mit Rahmen')!.description).toBe(
      'Glasreinigung mit Rahmen',
    );
    const contacts = await sql`
      select last_name, email from app.contacts ct join app.customers c on c.id = ct.customer_id
       where c.customer_no like '300%' order by last_name`;
    expect(contacts).toEqual([
      { last_name: 'Beispiel', email: null },
      { last_name: 'Muster', email: 'erika@example.org' },
    ]);
    const emps = await sql`
      select personnel_no, employment_type::text, status::text, weekly_hours, email, tags
        from app.employees where personnel_no like '800%' order by personnel_no`;
    expect(emps).toMatchObject([
      { personnel_no: '8001', employment_type: 'minijob', status: 'aktiv', tags: ['Minijob'] },
      { personnel_no: '8002', employment_type: 'vollzeit', status: 'ausgetreten', email: null },
      { personnel_no: '8003', employment_type: 'vollzeit' },
    ]);
    const [p] = await sql`
      select p.birth_date::text from app.employee_private p join app.employees e on e.id = p.employee_id
       where e.personnel_no = '8001'`;
    expect(p!.birth_date).toBe('1980-02-01');

    const again = await applyPlan(deps, { id: randomUUID(), files: f, update: false, actor: 't' });
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(15);
    const [cnt] = await sql`
      select (select count(*)::int from app.customers where customer_no like '300%') k,
             (select count(*)::int from app.sites where site_no like '300%') o,
             (select count(*)::int from app.site_services ss join app.sites s on s.id = ss.site_id
               where s.site_no like '300%') l,
             (select count(*)::int from app.contacts ct join app.customers c on c.id = ct.customer_id
               where c.customer_no like '300%') c,
             (select count(*)::int from app.customer_bank_accounts) b`;
    expect(cnt).toEqual({ k: 3, o: 5, l: 4, c: 2, b: 1 });
  });

  it('Aktualisieren behält Nummern und vertrauliche Felder', async () => {
    const [e] = await sql<{ id: string }[]>`select id from app.employees where personnel_no = '8001'`;
    await sql`update app.employee_private set tax_id = '12345678901' where employee_id = ${e!.id}`;
    await sql`update app.customers set name = 'geändert' where customer_no = '30001'`;
    const r = await applyPlan(deps, { id: randomUUID(), files: await files(), update: true, actor: 't' });
    expect(r.created).toBe(0);
    expect(r.updated).toBe(15);
    const [k] = await sql`select name from app.customers where customer_no = '30001'`;
    expect(k!.name).toBe('Stadt Musterhausen');
    const [p] = await sql`select tax_id from app.employee_private where employee_id = ${e!.id}`;
    expect(p!.tax_id).toBe('12345678901');
    const [c] = await sql`select customer_no from app.customers where name = 'Interessent C AG'`;
    expect(c!.customer_no).toBe('30003');
  });

  it('gleiche Import-ID wird nur einmal ausgeführt', async () => {
    const id = randomUUID();
    const f = await files();
    await applyPlan(deps, { id, files: f, update: true, actor: 't' });
    const second = await applyPlan(deps, { id, files: f, update: true, actor: 't' });
    expect(second.updated).toBe(15);
    const [n] = await sql`select count(*)::int as n from app.data_imports where id = ${id}`;
    expect(n!.n).toBe(1);
  });
});
