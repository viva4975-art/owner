import type { Sql } from '../db/client.js';
import { type AccountingSettings, type Booking } from './datev.js';

/*
 * Export für Lexware buchhaltung pro/premium (Financial Office) über die ASCII/ANSI-Schnittstelle (Ahmed 11.10.,
 * Schnittstellenbeschreibung von Lexware): Buchungsdaten und Personenkonten als Windows-1252-Text, Semikolon,
 * Dezimalkomma, Datum TT.MM.JJJJ, erste Zeile = Feldnamen (im Import „Feldnamen in erster Zeile“ ankreuzen und die
 * Felder einmal zuordnen – die Namen entsprechen der Lexware-Beschreibung). Grundlage sind dieselben Buchungen wie der
 * DATEV-Export; Steuerschlüssel sind DATEV-Schlüssel (laut Beschreibung auch in Lexware gültig).
 */

const clean = (v: string | null | undefined, max: number) =>
  (v ?? '')
    .replace(/[;\r\n\t"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const dateDe = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const amount = (c: bigint) => `${c / 100n},${String(c % 100n).padStart(2, '0')}`;

const NUMBER_RANGE: Record<Booking['kind'], string> = {
  ausgang: 'AR',
  eingang: 'ER',
  zahlungseingang: 'ZE',
  zahlungsausgang: 'ZA',
};

/** Buchungsperiode = Monat im Wirtschaftsjahr (1–12; Wirtschaftsjahr laut DATEV-Einstellungen) */
function period(date: string, fyStart: string) {
  const m = Number(date.slice(5, 7));
  const start = Number(fyStart.slice(0, 2)) || 1;
  return ((m - start + 12) % 12) + 1;
}

export function lexwareBookings(bookings: Booking[], s: AccountingSettings): string {
  const head = [
    'Belegdatum',
    'Buchungsdatum',
    'Buchungsperiode',
    'Belegnummernkreis',
    'Belegnummer',
    'Buchungstext',
    'Buchungsbetrag',
    'Sollkonto',
    'Habenkonto',
    'Steuerschlüssel',
    'Kostenstelle',
    'Kostenträger',
    'Zusatzangaben',
    'Leistungsdatum',
    'EU Land',
    'EU %',
    'USt-IDNr.',
  ];
  const lines = [head.join(';')];
  for (const b of bookings) {
    const [soll, haben] = b.sh === 'S' ? [b.account, b.contra] : [b.contra, b.account];
    // § 13b: Zusatzangabe 10 = Reinigung von Gebäuden (Lexware-Tabelle „Zusatzangaben“)
    const rc = b.taxKey && b.taxKey === s.rc_tax_key;
    lines.push(
      [
        dateDe(b.date),
        dateDe(b.date),
        String(period(b.date, s.fiscal_year_start)),
        NUMBER_RANGE[b.kind],
        clean(b.doc, 20),
        clean(b.text, 79),
        amount(b.amount),
        soll,
        haben,
        b.taxKey ?? '',
        '',
        '',
        rc ? '10' : '',
        '',
        '',
        '',
        '',
      ].join(';'),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Straße und Hausnummer trennen („Würmtalstr. 10a“ → „Würmtalstr.“, „10a“) */
function splitStreet(street: string | null) {
  const m = /^(.*?)\s+(\d+\s*[a-zA-Z]?(?:\s*[-/]\s*\d+\s*[a-zA-Z]?)?)$/.exec((street ?? '').trim());
  return m ? [m[1]!, m[2]!.replace(/\s+/g, '')] : [street ?? '', ''];
}

/** Personenkonten: Kunden (Debitoren = Kundennummer) und Lieferanten (Kreditoren = Lieferantennummer). */
export async function lexwareAccounts(sql: Sql): Promise<string> {
  const head = [
    'Kontonummer',
    'Kontobezeichnung',
    'Kundennummer',
    'Lieferantennummer',
    'Anrede',
    'Firma',
    'Name',
    'Vorname',
    'Zusatz',
    'Land',
    'Straße',
    'Hausnummer',
    'Postleitzahl',
    'Ort',
    'Ansprechpartner',
    'Telefon 1',
    'Telefon 2',
    'Telefax',
    'E-Mail',
    'Bankleitzahl',
    'Bankkonto',
    'Bankbezeichnung',
    'BIC',
    'IBAN',
    'Zahlungsziel',
    'Skonto %',
    'Skonto Ziel',
    'Skonto2 %',
    'Skonto2 Ziel',
    'Zahlungsart',
    'Einzugsermächtigung',
    'Zahlart',
    'UStIDNr.',
  ];
  const customers = await sql<
    {
      customer_no: string;
      name: string;
      name2: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      email: string | null;
      payment_terms_days: number | null;
      skonto_percent_bp: number | null;
      skonto_days: number | null;
      vat_id: string | null;
    }[]
  >`
    select customer_no, name, name2, street, postal_code, city, contact_name, contact_phone,
           coalesce(contact_email, invoice_emails[1]) as email, payment_terms_days, skonto_percent_bp, skonto_days,
           vat_id
      from app.customers where customer_no ~ '^[0-9]{4,9}$' and not coalesce(is_internal, false)
     order by customer_no`;
  const suppliers = await sql<
    {
      supplier_no: string;
      name: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      contact_name: string | null;
      phone: string | null;
      email: string | null;
      iban: string | null;
      bic: string | null;
      payment_terms_days: number | null;
      vat_id: string | null;
    }[]
  >`
    select supplier_no, name, street, postal_code, city, contact_name, phone, email, iban, bic, payment_terms_days, vat_id
      from app.suppliers where supplier_no ~ '^[0-9]{4,9}$' order by supplier_no`;
  const pct = (bp: number | null) => (bp ? (bp / 100).toFixed(2).replace('.', ',') : '');
  const lines = [head.join(';')];
  for (const c of customers) {
    const [st, no] = splitStreet(c.street);
    lines.push(
      [
        c.customer_no,
        clean(c.name, 80),
        c.customer_no,
        '',
        'Firma',
        clean(c.name, 59),
        '',
        '',
        clean(c.name2, 59),
        'Deutschland',
        clean(st, 34),
        clean(no, 5),
        clean(c.postal_code, 9),
        clean(c.city, 34),
        clean(c.contact_name, 59),
        clean(c.contact_phone, 19),
        '',
        '',
        clean(c.email, 59),
        '',
        '',
        '',
        '',
        '',
        c.payment_terms_days != null ? String(c.payment_terms_days) : '',
        pct(c.skonto_percent_bp),
        c.skonto_percent_bp && c.skonto_days ? String(c.skonto_days) : '',
        '',
        '',
        'Überweisung',
        '',
        '',
        clean(c.vat_id, 20),
      ].join(';'),
    );
  }
  for (const s of suppliers) {
    const [st, no] = splitStreet(s.street);
    lines.push(
      [
        s.supplier_no,
        clean(s.name, 80),
        '',
        s.supplier_no,
        'Firma',
        clean(s.name, 59),
        '',
        '',
        '',
        'Deutschland',
        clean(st, 34),
        clean(no, 5),
        clean(s.postal_code, 9),
        clean(s.city, 34),
        clean(s.contact_name, 59),
        clean(s.phone, 19),
        '',
        '',
        clean(s.email, 59),
        '',
        '',
        '',
        clean(s.bic, 11),
        (s.iban ?? '').replace(/\s/g, '').slice(0, 30),
        s.payment_terms_days != null ? String(s.payment_terms_days) : '',
        '',
        '',
        '',
        '',
        'Überweisung',
        '',
        '',
        clean(s.vat_id, 20),
      ].join(';'),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
