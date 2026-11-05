/**
 * Schulungsnachweis Objektleitung / internes Zeugnis (Ahmed 05.11.2026: „Vorlage für die Schulung des Objektleiters von mir
 * als Gebäudereinigermeister, oder ein internes Zeugnis“).
 *
 * Bescheinigt eine interne Schulung durch die Geschäftsführung (Gebäudereinigermeister) mit den behandelten Modulen und
 * optional einer kurzen internen Beurteilung. Keine öffentlich-rechtliche Qualifikation und kein Arbeitszeugnis nach
 * § 109 GewO. Abgelegt in der Personalakte zählt es (Dateiname „Schulungsnachweis …“) in der Kundenübersicht als
 * Schulungsnachweis der Objektleitung.
 */
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';

export const TRAINING_MODULES: { key: string; title: string; content: string }[] = [
  {
    key: 'technik',
    title: 'Reinigungstechnik und -verfahren',
    content:
      'Unterhalts-, Grund- und Sonderreinigung, Glasreinigung; Bodenbeläge und Oberflächen; Reinigungsmittel, pH-Wert, Dosierung; Maschinen und Geräte',
  },
  {
    key: 'hygiene',
    title: 'Hygiene und Desinfektion',
    content:
      'Farbsystem, Sanitärreinigung, Desinfektion nach Hygieneplan des Auftraggebers, Vermeidung von Keimverschleppung',
  },
  {
    key: 'arbeitsschutz',
    title: 'Arbeitsschutz und Gefahrstoffe',
    content:
      'Gefährdungsbeurteilung und Unterweisung (§§ 5, 12 ArbSchG), Betriebsanweisungen und Sicherheitsdatenblätter (GefStoffV), PSA, Hautschutz, Leitern und Tritte, Erste Hilfe und Verbandbuch, Mutterschutz',
  },
  {
    key: 'planung',
    title: 'Leistungsverzeichnis, Raumbuch und Einsatzplanung',
    content:
      'Leistungsverzeichnis und Turnus lesen, Raumbuch und Leistungswerte, Revier- und Einsatzplanung, Vertretung bei Urlaub und Krankheit',
  },
  {
    key: 'qualitaet',
    title: 'Qualitätssicherung',
    content:
      'Qualitätskontrollen und Audits, Mängelbeseitigung und Nachbesserung, Reklamationen, Dokumentation nach ISO 9001 / 14001',
  },
  {
    key: 'fuehrung',
    title: 'Personalführung',
    content:
      'Einarbeitung neuer Mitarbeitender, Anleitung und Kontrolle, Gesprächsführung, Umgang mit Konflikten, Motivation',
  },
  {
    key: 'recht',
    title: 'Arbeitszeit und Recht',
    content:
      'Zeiterfassung nach § 17 MiLoG, Pausen und Höchstarbeitszeit (ArbZG), Mindestlohn und Rahmentarifvertrag, Urlaub und Krankmeldung, Datenschutz und Verschwiegenheit',
  },
  {
    key: 'kunde',
    title: 'Kundenbetreuung',
    content:
      'Begehungen mit dem Auftraggeber, Abstimmung von Zusatzarbeiten, Schlüssel- und Zugangsregeln, Auftreten im Objekt',
  },
  {
    key: 'umwelt',
    title: 'Umweltschutz und Abfall',
    content: 'Abfalltrennung, sparsamer Einsatz von Wasser, Energie und Reinigungsmitteln',
  },
  {
    key: 'app',
    title: 'Viva-Deluxe-App',
    content:
      'Einsatzplanung, Zeiterfassung und Nachträge, Arbeitsscheine, Übergaben und Unterweisungen, Qualitätskontrolle am Handy',
  },
];

export const TRAINING_RESULTS = [
  'mit sehr gutem Erfolg teilgenommen',
  'mit gutem Erfolg teilgenommen',
  'mit Erfolg teilgenommen',
  'teilgenommen',
] as const;

export const RATING_TOPICS = [
  'Fachkenntnisse Reinigungstechnik',
  'Arbeitsschutz und Hygiene',
  'Führung des Teams',
  'Planung und Organisation',
  'Kundenorientierung',
  'Zuverlässigkeit',
] as const;
export const RATINGS = ['sehr gut', 'gut', 'befriedigend', 'ausreichend'] as const;

export interface TrainingCertInput {
  from: string;
  to: string;
  hours: string;
  place: string;
  trainer: string;
  trainerTitle: string;
  modules: string[];
  extra: string;
  result: string;
  /** internes Zeugnis: Bewertung je Bereich (leer = nicht bewertet) und freier Text */
  ratings: Record<string, string>;
  remark: string;
  date: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function trainingCertPdf(sql: Sql, employeeId: string, i: TrainingCertInput) {
  const [e] = await sql<
    {
      first_name: string;
      last_name: string;
      salutation: string | null;
      personnel_no: string;
      entry_date: string;
    }[]
  >`select first_name, last_name, salutation, personnel_no, to_char(entry_date, 'YYYY-MM-DD') as entry_date
      from app.employees where id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  if (!isDate(i.from)) throw new BusinessError('Bitte das Datum der Schulung angeben');
  const to = isDate(i.to) && i.to >= i.from ? i.to : i.from;
  const mods = TRAINING_MODULES.filter((m) => i.modules.includes(m.key));
  const extra = i.extra
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!mods.length && !extra.length) throw new BusinessError('Bitte mindestens ein Schulungsthema wählen');
  const seller = await getSeller(sql);
  const [co] = await sql<
    { managing_director: string | null }[]
  >`select managing_director from app.company where id = 1`;
  const trainer = i.trainer.trim() || co?.managing_director || seller.legalName;
  const trainerTitle = i.trainerTitle.trim() || 'Gebäudereinigermeister';
  const date = isDate(i.date) ? i.date : todayBerlin();
  const name = `${e.first_name} ${e.last_name}`;
  const pron = e.salutation === 'Frau' ? 'Frau' : e.salutation === 'Herr' ? 'Herr' : '';
  const ratings = RATING_TOPICS.map((t) => [t, i.ratings[t] ?? ''] as const).filter(([, v]) => v);
  const zeugnis = ratings.length > 0 || i.remark.trim() !== '';

  const d = await FormDoc.create({
    title: `Schulungsnachweis Objektleitung – ${name}`,
    sideRef: `VD-SN Schulungsnachweis Objektleitung · ${e.personnel_no} · Stand ${formatDateDe(date)}`,
    date,
    author: seller.legalName,
  });
  d.title(zeugnis ? 'Schulungsnachweis und interne Beurteilung' : 'Schulungsnachweis', 'Objektleitung');
  d.kvBox([
    { k: 'Teilnehmer/in', v: `${pron ? `${pron} ` : ''}${name}`, strong: true },
    { k: 'Personal-Nr.', v: e.personnel_no },
    {
      k: 'Schulungszeitraum',
      v: to === i.from ? formatDateDe(i.from) : `${formatDateDe(i.from)} – ${formatDateDe(to)}`,
    },
    ...(i.hours.trim() ? [{ k: 'Umfang', v: `${i.hours.trim()} Stunden` }] : []),
    { k: 'Ort', v: i.place.trim() || `${seller.legalName}, ${seller.city}` },
    { k: 'Schulungsleitung', v: `${trainer}, ${trainerTitle}` },
  ]);
  d.para(
    `${pron ? `${pron} ${e.last_name}` : name} hat an der internen Schulung für Objektleitungen der ${seller.legalName} ` +
      `${i.result || TRAINING_RESULTS[2]}. Die Schulung wurde von ${trainer} (${trainerTitle}) durchgeführt und ` +
      'umfasste folgende Inhalte:',
    { size: 9.5 },
  );
  d.table(
    [
      { label: 'Modul', width: 170 },
      { label: 'Inhalte', width: 328 },
    ],
    [...mods.map((m) => [m.title, m.content]), ...extra.map((x) => ['Weiteres Thema', x])],
    { size: 8.6 },
  );
  if (zeugnis) {
    d.section('Interne Beurteilung');
    if (ratings.length)
      d.table(
        [
          { label: 'Bereich', width: 250 },
          { label: 'Bewertung', width: 248 },
        ],
        ratings.map(([t, v]) => [t, v]),
        { size: 8.8 },
      );
    if (i.remark.trim()) d.para(i.remark.trim(), { size: 9.3 });
  }
  d.muted(
    'Interner Nachweis der Viva-Deluxe Gebäudereinigung GmbH über eine betriebliche Schulung (Meisterbetrieb). ' +
      'Er ersetzt keine öffentlich-rechtliche Prüfung und ist kein Arbeitszeugnis nach § 109 GewO.',
  );
  d.y += 6;
  d.signatures(`${trainer} · ${trainerTitle} · Geschäftsführung`, `Teilnehmer/in · ${name}`, {
    leftText: `${seller.city}, den ${formatDateDe(date)}`,
  });
  const safe = name.replace(/[^\p{L}\p{N}]+/gu, '_');
  return {
    pdf: await d.save(),
    name: `Schulungsnachweis_Objektleitung_${e.personnel_no}_${safe}_${i.from}.pdf`,
  };
}
