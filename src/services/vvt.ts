/**
 * Verzeichnis der Verarbeitungstätigkeiten (Art. 30 Abs. 1 DSGVO), aus der App erzeugt (Ahmed 25.10.).
 * Die Texte beschreiben, was die App tatsächlich speichert; Firmendaten und eingerichtete Dienste kommen aus der
 * Datenbank bzw. der Konfiguration. Vor der Verwendung von Datenschutzberater/Anwalt prüfen lassen.
 */
import type { Sql } from '../db/client.js';
import type { Env } from '../config/env.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';

export interface VvtActivity {
  title: string;
  zweck: string;
  rechtsgrundlage: string;
  betroffene: string;
  daten: string;
  empfaenger: string;
  loeschung: string;
  hinweis?: string;
}

const IONOS =
  'IONOS SE (Server, Datenbank und Sicherung in Deutschland – Auftragsverarbeiter, AVV abgeschlossen)';

export const VVT_ACTIVITIES: VvtActivity[] = [
  {
    title: 'Personalverwaltung und Personalakte',
    zweck:
      'Begründung, Durchführung und Beendigung der Arbeitsverhältnisse: Stammdaten, Verträge, Personalunterlagen, Pflichtunterlagen-Prüfung, Übergaben (Kleidung, Schlüssel, Geräte), Briefe.',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. b und c DSGVO, § 26 BDSG; Aufenthaltstitel-Kopie § 4a Abs. 5 AufenthG; Steuer-/SV-Daten §§ 39 ff. EStG, § 28a SGB IV.',
    betroffene: 'Beschäftigte (auch ausgeschiedene), Minijobber.',
    daten:
      'Name, Anschrift, Kontakt, Geburtsdatum/-ort, Staatsangehörigkeit, Familienstand, Aufenthaltstitel/Arbeitserlaubnis, Steuer-ID, SV-Nummer, Krankenkasse, IBAN, Vergütung, Wochenstunden, Dokumente der Personalakte.',
    empfaenger: `Geschäftsführung, Personal, Buchhaltung (Lohn); Objektleitung nur Kontakt und ausgewählte Unterlagen der Mitarbeitenden ihrer Objekte („Mein Team“, keine Verträge/Lohn/Steuer-/SV-/Bankdaten); Steuerberater; ${IONOS}.`,
    loeschung:
      'Personalakte grundsätzlich 3 Jahre nach Austritt (Verjährung); lohn- und steuerrelevante Unterlagen 6 bzw. 10 Jahre (§ 147 AO, § 257 HGB, § 41 EStG).',
    hinweis:
      'Vertrauliche Daten (Steuer-ID, SV-Nr., IBAN, Aufenthalt) liegen in einer eigenen Tabelle, lesbar nur für Admin/Personal (Zeilen-Sicherheit in der Datenbank).',
  },
  {
    title: 'Arbeitszeiterfassung (Mitarbeiter-App, Stoppuhr, QR-Code, Büro)',
    zweck:
      'Aufzeichnung von Beginn, Ende und Dauer der Arbeitszeit, Pausen, Nachträge mit Freigabe, Stundenliste mit Unterschrift, Lohnarten und Zuschläge, Arbeitszeitkonto, Nachweis gegenüber Kunden (geschwärzter Stundennachweis).',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. c DSGVO i. V. m. § 17 MiLoG, § 16 Abs. 2 ArbZG; Art. 6 Abs. 1 lit. b DSGVO (Lohn).',
    betroffene: 'Beschäftigte.',
    daten:
      'Personalnummer, Objekt, Beginn/Ende/Pause, Erfassungszeitpunkt, Quelle (App, QR, Büro), Änderungsprotokoll mit altem/neuem Stand und Grund, Unterschriftsbild der Stundenliste.',
    empfaenger: `Personal, Buchhaltung, Objektleitung (nur eigene Objekte); Kunden nur als geschwärzter Stundennachweis ohne Namen; Hauptzollamt bei Prüfung; ${IONOS}.`,
    loeschung:
      'Mindestens 2 Jahre (§ 17 Abs. 1 MiLoG); als Lohnunterlage bis 6 Jahre. Löschung nur über das Löschprotokoll.',
  },
  {
    title: 'Standort beim Stempeln',
    zweck: 'Plausibilitätsprüfung, ob beim Ein-/Ausstempeln am Objekt gestempelt wurde.',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. f DSGVO, § 26 Abs. 1 BDSG (Nachweis der Arbeitszeit am Einsatzort, Missbrauchsschutz).',
    betroffene: 'Beschäftigte, die stempeln.',
    daten:
      'Nur Bewertung „am Objekt / nicht am Objekt / ungenau / kein Standort“, Entfernung und Genauigkeit. Keine Koordinaten, kein Bewegungsprofil; Abfrage nur im Moment des Stempelns. Stempeln wird nie verweigert.',
    empfaenger: 'Personal, Objektleitung (eigene Objekte) – Liste „Auffällige Zeiten“.',
    loeschung: 'Mit dem Zeiteintrag.',
    hinweis:
      'Beschäftigte vorher informieren (Art. 13 DSGVO, Datenschutzhinweise in der App); Betriebsrat, falls vorhanden, beteiligen (§ 87 Abs. 1 Nr. 6 BetrVG).',
  },
  {
    title: 'Abwesenheiten, Krankheit und Verbandbuch',
    zweck:
      'Urlaubs- und Abwesenheitsverwaltung, Entgeltfortzahlung, Vertretungsplanung, Ausfallzeiten-Auswertung für die Kalkulation, Dokumentation von Erste-Hilfe-Leistungen.',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. b und c, Art. 9 Abs. 2 lit. b DSGVO, § 26 Abs. 3 BDSG; BUrlG, EFZG; Verbandbuch § 24 Abs. 6 DGUV Vorschrift 1.',
    betroffene: 'Beschäftigte.',
    daten:
      'Art und Zeitraum der Abwesenheit („krank“, nie eine Diagnose), Krankheitstage, Urlaubskonto; Verbandbuch: Hergang, Verletzung, Erste Hilfe, Zeugen.',
    empfaenger:
      'Personal, Buchhaltung (Lohn), Objektleitung nur Art und Zeitraum der bei ihr eingeplanten Personen; Auswertungen zur Weitergabe nur geschwärzt (Namen ersetzt).',
    loeschung: 'Abwesenheiten als Lohnunterlage bis 6 Jahre; Verbandbuch 5 Jahre nach letzter Eintragung.',
  },
  {
    title: 'Einsatzplanung, Mitarbeiter-App und Push-Nachrichten',
    zweck:
      'Planung der Einsätze, Anzeige von Einsätzen, Dokumenten, Lohnabrechnungen und Anträgen in der App, Benachrichtigungen (neue Dokumente, Planänderung, Anträge, Pausen-Erinnerung), Kalender-Abo.',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. b DSGVO, § 26 BDSG; Benachrichtigungen nur nach Einwilligung im Browser/Gerät.',
    betroffene: 'Beschäftigte, Büro und Objektleitung.',
    daten:
      'Einsätze (Objekt, Zeit), Anmeldung (Personalnummer, PIN als Hash), Sprache, Push-Abonnement (Adresse des Browser-Push-Dienstes), geheimer Kalender-Link.',
    empfaenger:
      'Push-Inhalte werden über den Push-Dienst des Browsers/Geräts zugestellt (Google, Apple, Mozilla – ggf. Übermittlung in die USA, EU-US Data Privacy Framework); Inhalte bewusst knapp, keine Gesundheitsdaten oder Beträge.',
    loeschung: 'Planungen als Lohnunterlage bis 6 Jahre; Push-Abonnements beim Abmelden bzw. wenn ungültig.',
  },
  {
    title: 'Elektronische Unterschriften und Nachweise',
    zweck:
      'Nachweis von Unterweisungen, Dokumentenkenntnisnahme, Stundenlisten, Übergaben, Arbeitsscheinen (Kunde), NU-Bestellungen.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b, c und f DSGVO (Nachweis, § 12 ArbSchG).',
    betroffene: 'Beschäftigte, Ansprechpartner von Kunden und Nachunternehmern.',
    daten: 'Name, Unterschriftsbild, Zeitpunkt, IP-Adresse, Gerät, Prüfsumme des Dokuments.',
    empfaenger: `Büro; ${IONOS}.`,
    loeschung: 'Mit dem jeweiligen Vorgang; unveränderbar archiviert für die Dauer der Nachweispflicht.',
  },
  {
    title: 'Fotos (Qualitätskontrolle, Schadensfotos, Personalbogen, Geräte)',
    zweck:
      'Dokumentation der Reinigungsqualität und von Schäden, Unterlagen neuer Mitarbeitender (Ausweis, Karten), Gerätestandort.',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. b und f DSGVO; Ausweis-/Aufenthaltskopien nur soweit erforderlich (§ 4a AufenthG, § 26 BDSG).',
    betroffene:
      'Beschäftigte (Aufnehmende), zufällig abgebildete Personen, neue Mitarbeitende (Personalbogen).',
    daten:
      'Foto, Zeitpunkt, Name der aufnehmenden Person, Objekt, Standort-Bewertung und Koordinaten im Moment der Aufnahme bzw. des Geräte-Scans.',
    empfaenger:
      'Büro, Objektleitung (eigene Objekte), Kunde im Auswertungsbericht; Personalbogen-Fotos nur Admin/Personal.',
    loeschung:
      'QK-Fotos mit dem Prüfbericht; Schadensfotos nach Erledigung der Aufgabe ausblenden; nicht benötigte Ausweiskopien nicht aufbewahren.',
    hinweis: 'Keine Personen gezielt fotografieren.',
  },
  {
    title: 'Bewerbermanagement und Stellenanzeigen',
    zweck: 'Auswahl von Bewerberinnen und Bewerbern, Kontaktverlauf, Matching mit offenen Stellen.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b DSGVO, § 26 Abs. 1 BDSG.',
    betroffene: 'Bewerberinnen und Bewerber.',
    daten: 'Kontakt, Wohnort, Sprachen, Wunschzeiten, Unterlagen, interne Einschätzung, Kontaktverlauf.',
    empfaenger: 'Admin, Personal.',
    loeschung:
      '6 Monate nach Absage bzw. „hat etwas gefunden“ (AGG § 15 Abs. 4, § 61b ArbGG) – App zeigt Löschvorschlag, Löschung entfernt auch Unterlagen.',
  },
  {
    title: 'Kunden, Interessenten, Akquise und Ausschreibungen',
    zweck: 'Angebote, Verträge, Kommunikation, Wiedervorlagen, Teilnahme an Ausschreibungen.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b und f DSGVO.',
    betroffene: 'Ansprechpartner bei Kunden und Interessenten.',
    daten: 'Name, Funktion, Telefon, E-Mail, Notizen, Aktivitäten.',
    empfaenger: `Büro; ${IONOS}.`,
    loeschung:
      'Handelsbriefe/Angebote 6 Jahre (§ 257 HGB); Interessenten ohne Vertrag nach Ende der Geschäftsanbahnung bzw. Widerspruch.',
  },
  {
    title: 'Rechnungswesen, E-Mail-Versand, Mahnwesen und Archiv',
    zweck:
      'Rechnungen und E-Rechnungen, Versand per E-Mail, Offene Posten, Mahnungen, DATEV-Export, revisionssichere Archivierung.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b und c DSGVO; § 14 UStG, § 147 AO, § 257 HGB, GoBD.',
    betroffene: 'Kunden und deren Ansprechpartner (Rechnungs-E-Mail).',
    daten: 'Rechnungsanschrift, E-Mail, Leitweg-ID, Beträge, Zahlungen, Versandprotokoll.',
    empfaenger:
      'Kunden; Steuerberater (DATEV-Export); E-Mail über IONOS Exchange; Archiv-Kopie IONOS S3 mit Object Lock in Deutschland/EU (Auftragsverarbeiter).',
    loeschung:
      '10 Jahre (Rechnungen, Buchungsbelege), danach Löschung; Archiv-Sperre bis 31.12. des 10. Folgejahres.',
  },
  {
    title: 'Nachunternehmer und Lieferanten',
    zweck:
      'Beauftragung, Rechnungseingang, Zahlung; Nachweisprüfung wegen Auftraggeberhaftung (Mindestlohn, Sozialversicherung), Upload-Portal mit PIN.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b, c und f DSGVO (§ 13 MiLoG, § 14 AEntG, § 28e Abs. 3a SGB IV).',
    betroffene: 'Inhaber und Ansprechpartner von Nachunternehmern/Lieferanten.',
    daten: 'Kontakt, Bankverbindung, Nachweise (z. B. Unbedenklichkeitsbescheinigungen), Unterschriften.',
    empfaenger: `Büro; ${IONOS}.`,
    loeschung: 'Buchungsbelege 10 Jahre; Nachweise bis Ende der Haftungszeit, danach Löschung.',
  },
  {
    title: 'Kontoabruf (Bankumsätze)',
    zweck: 'Abruf der Umsätze eigener Geschäftskonten und Zuordnung zu Rechnungen.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b, c und f DSGVO.',
    betroffene: 'Zahlende und Zahlungsempfänger (Kunden, Lieferanten, Beschäftigte).',
    daten: 'Name, IBAN, Betrag, Verwendungszweck.',
    empfaenger:
      'Enable Banking Oy (Finnland, lizenzierter Kontoinformationsdienst nach PSD2 – eigene Verantwortlichkeit, Vertragsbedingungen prüfen); Banken.',
    loeschung: '10 Jahre als Buchungsunterlage.',
  },
  {
    title: 'Glückwünsche an Mitarbeitende',
    zweck: 'E-Mail zum Geburtstag und Firmenjubiläum.',
    rechtsgrundlage:
      'Art. 6 Abs. 1 lit. f DSGVO (Mitarbeiterbindung); Widerspruch jederzeit („keine Glückwünsche“).',
    betroffene: 'Beschäftigte mit E-Mail-Adresse.',
    daten: 'Name, E-Mail, Geburtstag, Eintrittsdatum (das Alter wird nie genannt).',
    empfaenger: 'Versand über IONOS Exchange.',
    loeschung: 'Versandvermerk je Jahr; mit den Stammdaten.',
  },
  {
    title: 'Fahrzeuge und Geräte',
    zweck: 'Fuhrpark (HU, Fahrer), Gerätestandort und Defektmeldungen per QR-Code.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. b und f DSGVO.',
    betroffene: 'Beschäftigte (Fahrer, Scannende).',
    daten:
      'Fahrer, Tankkarte; Geräte-Scan: Zeitpunkt, Person, Objekt, Koordinaten des Handys im Moment des Scans.',
    empfaenger: 'Büro, Objektleitung (eigene Objekte).',
    loeschung: 'Gerätescans nach Ende der Nutzung des Geräts bzw. spätestens nach 3 Jahren prüfen.',
    hinweis: 'Kein laufendes Tracking – Standort nur beim Scan.',
  },
  {
    title: 'Benutzerkonten, Protokolle, Sicherung und Überwachung',
    zweck: 'Zugriffsschutz, Nachvollziehbarkeit von Änderungen, Datensicherung, Ausfallmeldung.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. c und f, Art. 32 DSGVO.',
    betroffene: 'Benutzer der App.',
    daten: 'Benutzername, Rolle, Passwort-Hash, Anmeldeversuche, Änderungsprotokoll (wer, wann, was).',
    empfaenger:
      'IONOS Cloud Backup (verschlüsselt); externer Erreichbarkeits-Wächter erhält nur die Adresse der Statusseite, keine Personendaten.',
    loeschung: 'Sicherungen 14–30 Tage; Änderungsprotokoll mit dem Vorgang bzw. nach Aufbewahrungsfrist.',
  },
  {
    title: 'Objektdaten und Kartendienste',
    zweck: 'Ermittlung des nächsten Krankenhauses für den Objektordner, Karten-Links.',
    rechtsgrundlage: 'Art. 6 Abs. 1 lit. f DSGVO.',
    betroffene: 'Keine Personendaten – nur Objektadressen.',
    daten: 'Objektadresse.',
    empfaenger:
      'OpenStreetMap (Nominatim/Overpass); Google Maps lädt erst nach Klick (dann gelten die Bedingungen von Google).',
    loeschung: 'Keine Speicherung beim Dienst durch uns.',
  },
];

export const VVT_TOM: string[] = [
  'Server, Datenbank und Sicherung in Deutschland (IONOS), Verbindung nur über HTTPS.',
  'Rollen- und Rechtekonzept (Admin, Buchhaltung, Personal, Objektleitung), Zeilen-Sicherheit in der Datenbank, Objektleitung nur eigene Objekte.',
  'Passwörter und PINs nur als Hash (scrypt), Sperre nach 5 Fehlversuchen, eigene PIN Pflicht statt Geburtsdatum.',
  'Keine geheimen Schlüssel im Browser; Zugangsdaten nur auf dem Server.',
  'Änderungsprotokoll mit altem/neuem Stand; Belege unveränderbar (write-once), Archiv-Kopie mit Object Lock.',
  'Tägliche verschlüsselte Sicherung, Probe-Wiederherstellung vierteljährlich, Ausfallmeldung per E-Mail.',
  'Datensparsamkeit: Standort ohne Koordinaten, keine Diagnosen, geschwärzte Auswertungen zur Weitergabe.',
];

/** Ob ein Dienst eingerichtet ist (für die Anzeige „eingerichtet“). */
export async function vvtStatus(sql: Sql, env: Env) {
  const one = async (q: Promise<{ n: number }[]>) => {
    try {
      return ((await q)[0]?.n ?? 0) > 0;
    } catch {
      return false;
    }
  };
  return {
    bank: await one(sql<{ n: number }[]>`select count(*)::int as n from app.bank_feed_config`),
    push: await one(sql<{ n: number }[]>`select count(*)::int as n from app.push_subscriptions`),
    s3: !!env.S3_BUCKET,
    smtp: !!env.SMTP_HOST,
  };
}

export async function vvtPdf(sql: Sql, env: Env): Promise<Uint8Array> {
  const [co] = await sql<
    {
      legal_name: string;
      street: string;
      postal_code: string;
      city: string;
      phone: string | null;
      email: string;
      managing_director: string | null;
    }[]
  >`select legal_name, street, postal_code, city, phone, email, managing_director from app.company where id = 1`;
  const st = await vvtStatus(sql, env);
  const today = todayBerlin();
  const d = await FormDoc.create({
    title: 'Verzeichnis der Verarbeitungstätigkeiten',
    sideRef: `Verzeichnis der Verarbeitungstätigkeiten · Stand ${formatDateDe(today)}`,
    date: today,
    author: co?.legal_name ?? 'Viva-Deluxe',
  });
  d.title('Verzeichnis der Verarbeitungstätigkeiten', 'Art. 30 DSGVO');
  d.infoGrid(
    [
      ['Verantwortlicher', co?.legal_name ?? '–'],
      ['Anschrift', co ? `${co.street}, ${co.postal_code} ${co.city}` : '–'],
      ['Vertreten durch', co?.managing_director ?? '–'],
      ['Kontakt', [co?.phone, co?.email].filter(Boolean).join(' · ') || '–'],
      ['Datenschutzbeauftragter', 'nicht benannt – § 38 BDSG prüfen'],
      ['Stand', formatDateDe(today)],
    ],
    2,
  );
  d.muted(
    `Aus der Betriebs-App erzeugt. Eingerichtet: Mailversand ${st.smtp ? 'ja' : 'nein'}, Archiv-Kopie S3 ${st.s3 ? 'ja' : 'nein'}, Kontoabruf ${st.bank ? 'ja' : 'nein'}, Push-Nachrichten ${st.push ? 'ja' : 'nein'}. Vor Verwendung von Datenschutzberater/Anwalt prüfen lassen und bei Änderungen aktualisieren.`,
  );
  VVT_ACTIVITIES.forEach((a, i) => {
    d.section(`${i + 1}. ${a.title}`);
    const row = (k: string, v: string) => {
      d.para(k, { size: 8, bold: true });
      d.para(v, { size: 8.5, indent: 8 });
    };
    row('Zweck', a.zweck);
    row('Rechtsgrundlage', a.rechtsgrundlage);
    row('Betroffene Personen', a.betroffene);
    row('Datenkategorien', a.daten);
    row('Empfänger', a.empfaenger);
    row('Löschfristen', a.loeschung);
    if (a.hinweis) row('Hinweis', a.hinweis);
  });
  d.section('Technische und organisatorische Maßnahmen (Art. 32 DSGVO)');
  for (const t of VVT_TOM) d.para(`– ${t}`, { size: 8.5 });
  d.section('Drittländer');
  d.para(
    'Keine planmäßige Übermittlung in Drittländer. Ausnahme: Zustellung von Push-Nachrichten über die Push-Dienste der Browser-/Gerätehersteller (ggf. USA, EU-US Data Privacy Framework); Inhalte sind knapp und enthalten keine Gesundheitsdaten oder Beträge.',
    { size: 8.5 },
  );
  return d.save();
}
