/**
 * Gefährdungsbeurteilung je Objekt (§§ 5, 6 ArbSchG; Ahmed 05.11.2026: „zu jedem Objekt automatisch, abhängig von der
 * Leistungsart, im Objektordner“).
 *
 * Vorlage = Bausteine: ein Grundbaustein (gilt immer) und je Tätigkeit ein Baustein, der über die Leistungsarten bzw.
 * Leistungstitel des Objekts, die Nutzungsarten im Raumbuch und Merkmale des Objekts (Schule, Tiefgarage, Arbeit am
 * Abend/früh) ausgewählt wird. Maßnahmen nach dem STOP-Prinzip: T = technisch, O = organisatorisch, P = persönlich.
 * Risiko vor und nach den Maßnahmen: hoch / mittel / gering.
 *
 * Die Vorlage ersetzt nicht die Begehung vor Ort: Objektbesonderheiten ergänzt die Objektleitung (Wirksamkeitskontrolle
 * auf dem Blatt), fachlich mit der Fachkraft für Arbeitssicherheit abstimmen.
 */

export type Risk = 'hoch' | 'mittel' | 'gering';

export interface Hazard {
  /** Gefährdungsfaktor (DGUV-Gliederung) */
  factor: string;
  hazard: string;
  /** „T …“, „O …“, „P …“ */
  measures: string[];
  risk: Risk;
  rest?: Risk;
}

export interface RiskModule {
  key: string;
  title: string;
  /** Tätigkeiten, für die der Baustein gilt */
  activities: string;
  /** Treffer in Leistungsart/-titel (Kleinschreibung, Umlaute als ae/oe/ue) */
  match?: RegExp;
  /** Treffer in den Nutzungsarten des Raumbuchs */
  rooms?: RegExp;
  psa: string[];
  hazards: Hazard[];
}

export const RISK_MODULES: RiskModule[] = [
  {
    key: 'allgemein',
    title: 'Allgemeine Reinigungstätigkeiten',
    activities:
      'Unterhaltsreinigung von Böden, Mobiliar und Oberflächen, Abfall entleeren, Umgang mit Reinigungsmitteln',
    psa: ['Rutschhemmende, geschlossene Arbeitsschuhe', 'Schutzhandschuhe (Nitril) bei Reinigungsmitteln'],
    hazards: [
      {
        factor: 'Mechanisch',
        hazard: 'Ausrutschen auf nassen Böden, Stolpern über Kabel, Eimer, Schläuche',
        measures: [
          'T Warnschilder „Rutschgefahr“ aufstellen, Kabel am Rand führen',
          'O Nass nur abschnittsweise wischen, Laufwege frei halten, Wagen nicht in Fluchtwegen abstellen',
          'P Rutschhemmende, geschlossene Arbeitsschuhe',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Körperliche Belastung',
        hazard: 'Heben und Tragen (Eimer, Müllsäcke), Zwangshaltungen, gleichförmige Bewegungen',
        measures: [
          'T Reinigungswagen, Teleskopstiele, Fahreimer mit Presse',
          'O Eimer nur halb füllen, schwere Säcke teilen, Tätigkeiten abwechseln',
          'P Unterweisung rückengerechtes Arbeiten',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Gefahrstoffe',
        hazard: 'Reizungen/Verätzungen von Haut und Augen, Einatmen von Sprühnebel, Reaktion beim Mischen',
        measures: [
          'T Dosiersystem bzw. Dosierhilfe, Schaum statt Sprühnebel, Originalgebinde mit Etikett',
          'O Betriebsanweisungen und Sicherheitsdatenblätter im Putzraum, nie Reiniger mischen, Gefahrstoffverzeichnis',
          'P Schutzhandschuhe, beim Ab- und Umfüllen Schutzbrille',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Haut',
        hazard: 'Feuchtarbeit (Hände lange nass oder in Handschuhen), Hautschäden',
        measures: [
          'O Hautschutzplan aushängen, Feuchtarbeit über den Tag verteilen',
          'P Hautschutz vor, Hautpflege nach der Arbeit; Baumwoll-Unterziehhandschuhe',
          'O Arbeitsmedizinische Vorsorge anbieten (Feuchtarbeit > 2 Std./Tag, ArbMedVV)',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Elektrisch',
        hazard: 'Stromschlag durch beschädigte Kabel/Stecker an Staubsaugern und Maschinen',
        measures: [
          'T Ortsveränderliche Geräte regelmäßig prüfen (DGUV Vorschrift 3), nur geprüfte Geräte',
          'O Sichtprüfung vor jeder Benutzung, defekte Geräte sofort aussortieren und melden',
          'O Steckdosen nicht mit nassen Händen bedienen, Kabel nicht durch Wasser ziehen',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Mechanisch',
        hazard: 'Schnitt- und Stichverletzungen beim Abfall (Glas, Nadeln, Klingen)',
        measures: [
          'O Müllsäcke nicht mit der Hand zusammendrücken, am oberen Rand anfassen, vom Körper weg tragen',
          'P Schutzhandschuhe',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Brand / Notfall',
        hazard: 'Brand, Unfall oder Erkrankung im Objekt',
        measures: [
          'O Fluchtwege und Sammelplatz bekannt, Notrufnummern und Notfallaushang im Putzraum',
          'O Erste Hilfe: Ersthelfer/Verbandkasten bekannt, Unfälle ins Verbandbuch',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Psychisch',
        hazard: 'Zeitdruck, unklare Aufgaben, Konflikte mit Nutzern',
        measures: [
          'O Leistungsumfang und Zeitvorgabe passend zum Raumbuch, Revierplan im Objekt',
          'O Ansprechpartner Objektleitung erreichbar, Beschwerden an die Objektleitung weitergeben',
        ],
        risk: 'gering',
      },
    ],
  },
  {
    key: 'alleinarbeit',
    title: 'Alleinarbeit, Arbeit am Abend / früh am Morgen',
    activities: 'Reinigung außerhalb der Nutzungszeiten, häufig allein im Gebäude',
    psa: [],
    hazards: [
      {
        factor: 'Organisation',
        hazard: 'Keine Hilfe bei Unfall oder Unwohlsein, Überfall, schlechte Beleuchtung',
        measures: [
          'O Mobiltelefon dabei, Notrufnummern und Objektleitung eingespeichert',
          'O Keine gefährlichen Arbeiten allein (Leiter über 2 m, Maschinen mit hohem Risiko, Gruben)',
          'O Eingangstüren nach Absprache verschlossen halten, Licht in Laufwegen einschalten',
          'O Ausbleiben fällt auf: Zeiterfassung mit Start/Ende, Objektleitung fragt nach',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'sanitaer',
    title: 'Reinigung von Sanitärräumen',
    activities: 'WC, Urinale, Waschbecken, Duschen, Umkleiden',
    match: /sanit|wc|toilett|dusch|umkleid/,
    rooms: /sanit|wc|toilett|dusch|umkleid|bad/,
    psa: ['Schutzhandschuhe (Farbe Rot nur für WC/Urinal)', 'Schutzbrille bei Spritzgefahr'],
    hazards: [
      {
        factor: 'Biologisch',
        hazard: 'Kontakt mit Fäkalien, Urin, Blut, Erbrochenem – Infektionen',
        measures: [
          'O Farbsystem: Rot nur WC/Urinal, getrennte Tücher und Handschuhe',
          'O Nach der Arbeit Hände waschen/desinfizieren, nicht im Sanitärbereich essen oder trinken',
          'O Impfangebot nach Beurteilung durch den Betriebsarzt (z. B. Hepatitis A/B)',
          'P Schutzhandschuhe, bei grober Verschmutzung Einmalschürze',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Gefahrstoffe',
        hazard: 'Saure Sanitärreiniger und Entkalker, Chlorgas beim Mischen mit chlorhaltigen Mitteln',
        measures: [
          'O Keine chlorhaltigen Mittel zusammen mit sauren Reinigern, Räume lüften',
          'P Schutzbrille und Schutzhandschuhe beim Arbeiten mit Säure',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'treppen',
    title: 'Treppenhaus- und Hausreinigung',
    activities: 'Treppen, Podeste, Geländer, Eingangsbereiche in Wohn- und Geschäftshäusern',
    match: /treppen|hausreinig|wohnanlag|hausflur|eingangsbereich/,
    rooms: /treppe|flur/,
    psa: ['Rutschhemmende Schuhe'],
    hazards: [
      {
        factor: 'Mechanisch',
        hazard: 'Sturz auf Treppen, Tragen von Eimer und Gerät über Treppen',
        measures: [
          'O Von oben nach unten arbeiten, Eimer nicht auf Stufen abstellen, immer eine Hand frei',
          'O Treppenlicht einschalten, nasse Stufen kennzeichnen, Hausbewohner nicht über nasse Stufen schicken',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'glas',
    title: 'Glas- und Fensterreinigung',
    activities: 'Fenster, Rahmen, Glasflächen innen und außen, Oberlichter',
    match: /glas|fenster|rahmen|oberlicht|wintergarten/,
    psa: ['Schnittschutzhandschuhe bei beschädigtem Glas', 'ggf. PSA gegen Absturz (nur mit Unterweisung)'],
    hazards: [
      {
        factor: 'Absturz',
        hazard: 'Absturz von Leiter, Tritt oder aus dem geöffneten Fenster',
        measures: [
          'T Teleskopstangen/Wasserstangen statt Leiter; Leitern nur geprüft und bis 2 m Standhöhe kurzzeitig (TRBS 2121-2)',
          'T Höhere Arbeiten mit Hubarbeitsbühne bzw. Gerüst, Hubarbeitsbühne nur mit Befähigung',
          'O Nicht auf Fensterbänke oder Möbel steigen, nicht aus dem Fenster lehnen; Arbeiten in der Höhe nie allein',
          'P PSA gegen Absturz nur an geprüften Anschlagpunkten und nach Unterweisung',
        ],
        risk: 'hoch',
      },
      {
        factor: 'Mechanisch',
        hazard: 'Schnittverletzungen durch Glasbruch, Klingen von Glasschabern',
        measures: [
          'O Beschädigte Scheiben nicht reinigen, melden; Schaber mit Klingenschutz',
          'P Schnittschutzhandschuhe',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Umgebung',
        hazard: 'Wind, Nässe, Kälte und Fußgänger bei Außenarbeiten',
        measures: ['O Bei Sturm/Glätte keine Außenarbeiten, Arbeitsbereich unten absperren'],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'grund',
    title: 'Grundreinigung, Einpflege und Sonderreinigung mit Maschinen',
    activities: 'Bodengrundreinigung, Beschichten, Einscheibenmaschine, Scheuersaugmaschine, Sprühextraktion',
    match: /grundrein|einpfleg|beschicht|versiegel|sonderrein|maschin|teppich|polster|sprueh|shampo/,
    psa: ['Schutzbrille', 'Chemikalienschutzhandschuhe', 'Gehörschutz bei lauten Maschinen'],
    hazards: [
      {
        factor: 'Gefahrstoffe',
        hazard: 'Stark alkalische Grundreiniger, Lösemittel in Beschichtungen – Verätzung, Dämpfe',
        measures: [
          'T Mittel mit geringerer Gefährdung wählen (Ersatzstoffprüfung, § 6 GefStoffV)',
          'O Gut lüften, Betriebsanweisung beachten, Mittel nur nach Herstellerangabe verdünnen',
          'P Schutzbrille, Chemikalienschutzhandschuhe, Knieschoner',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
      {
        factor: 'Mechanisch',
        hazard: 'Extreme Rutschgefahr durch Reinigungsflotte; Einscheibenmaschine schlägt aus, Quetschen',
        measures: [
          'O Bereich absperren, Flotte sofort absaugen, nur eingewiesene Personen an der Maschine',
          'P Rutschhemmende Schuhe (Sicherheitsschuhe bei schweren Maschinen)',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
      {
        factor: 'Elektrisch / Lärm',
        hazard: 'Netzbetriebene Maschinen in nasser Umgebung, Lärm',
        measures: [
          'T Geräte geprüft, Kabel nie durch die Flotte, Fehlerstromschutz (FI) nutzen',
          'P Gehörschutz bei lauten Maschinen',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'bau',
    title: 'Bau- und Bauendreinigung',
    activities: 'Reinigung auf Baustellen und nach Bauarbeiten',
    match: /bauend|baureinig|bauschluss|bauzwischen|baustelle|baufein|baugrob/,
    psa: ['Schutzhelm', 'Sicherheitsschuhe S3', 'Atemschutz FFP2 bei Staub', 'Warnweste'],
    hazards: [
      {
        factor: 'Baustelle',
        hazard: 'Herabfallende Teile, offene Kanten, Baustellenverkehr, Nägel und Scherben',
        measures: [
          'O Einweisung durch die Bauleitung/SiGeKo, nur freigegebene Bereiche betreten',
          'P Schutzhelm, Sicherheitsschuhe S3, Warnweste, Schutzhandschuhe',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
      {
        factor: 'Gefahrstoffe',
        hazard: 'Baustaub (Quarz, Zement), Zementschleier-Entferner (sauer)',
        measures: [
          'T Saugen mit Staubklasse M/H statt Kehren',
          'P Atemschutz FFP2, Schutzbrille und Schutzhandschuhe bei sauren Mitteln',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'tiefgarage',
    title: 'Tiefgaragen- und Parkhausreinigung',
    activities: 'Kehren, Scheuersaugen, Reinigung von Gruben und Duplex-Stellplätzen',
    match: /tiefgarag|parkhaus|garage|duplex|grube|kehrsaug|scheuersaug/,
    psa: ['Warnweste', 'Sicherheitsschuhe', 'Gehörschutz bei Kehrmaschine'],
    hazards: [
      {
        factor: 'Verkehr',
        hazard: 'Angefahren werden durch ein- und ausfahrende Fahrzeuge',
        measures: [
          'O Termin vorher aushängen (Aushang 14 Tage vorher), Bereiche absperren',
          'P Warnweste, Fahrzeuge vorbeilassen, nicht hinter rangierenden Fahrzeugen arbeiten',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
      {
        factor: 'Gefahrstoffe',
        hazard: 'Abgase, Öl- und Kraftstoffreste, Staub',
        measures: [
          'T Lüftung einschalten, akkubetriebene Maschinen statt Verbrenner',
          'O Öl mit Ölbinder aufnehmen und getrennt entsorgen',
          'P Atemschutz FFP2 beim Kehren stark staubiger Flächen',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Absturz / Quetschen',
        hazard: 'Gruben von Duplex-Parkern, bewegliche Plattformen',
        measures: [
          'O Anlage vor der Reinigung außer Betrieb nehmen (Hausmeister/Betreiber), Grube nicht allein betreten',
          'O Maschinen nur nach Einweisung bedienen',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
    ],
  },
  {
    key: 'desinfektion',
    title: 'Desinfektion und Reinigung im Gesundheitsbereich',
    activities: 'Praxen, Pflegeeinrichtungen, Labore, Flächendesinfektion',
    match: /desinf|praxis|klinik|krankenh|pflegeheim|pflegeeinr|labor|hygien/,
    psa: ['Schutzhandschuhe (desinfektionsmittelbeständig)', 'Schutzkittel/Schürze nach Hygieneplan'],
    hazards: [
      {
        factor: 'Biologisch',
        hazard: 'Krankheitserreger, Stichverletzung durch Kanülen',
        measures: [
          'O Hygieneplan des Kunden beachten, spitze Gegenstände nur in Abwurfbehältern, nie anfassen',
          'O Arbeitsmedizinische Vorsorge und Impfangebot durch den Betriebsarzt (BioStoffV, ArbMedVV)',
          'P Schutzhandschuhe, Schutzkleidung nach Hygieneplan',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
      {
        factor: 'Gefahrstoffe',
        hazard: 'Desinfektionsmittel – Haut- und Atemwegsreizung, Allergien',
        measures: [
          'T Wischdesinfektion statt Sprühen, Dosiergerät',
          'P Geeignete Schutzhandschuhe, Hautschutzplan',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'kueche',
    title: 'Küchen-, Kantinen- und Spülbereich',
    activities: 'Reinigung von Küchen, Spülen von Geschirr, Fettentfernung',
    match: /kuech|kantin|mensa|spuel|geschirr/,
    rooms: /kueche|teekueche/,
    psa: ['Rutschhemmende Schuhe', 'Schutzhandschuhe'],
    hazards: [
      {
        factor: 'Thermisch',
        hazard: 'Verbrühen durch heißes Wasser/Dampf, Verbrennen an heißen Geräten',
        measures: [
          'O Geräte vor der Reinigung abschalten und abkühlen lassen, Spülmaschine erst nach Programmende öffnen',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Mechanisch / Gefahrstoffe',
        hazard: 'Schnitt an Messern und Geräten, Rutschen auf Fett, alkalische Fettlöser',
        measures: [
          'O Messer nicht ins Spülwasser legen, Geräte vom Strom trennen',
          'P Schutzhandschuhe, Schutzbrille bei Fettlösern, rutschhemmende Schuhe',
        ],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'aussen',
    title: 'Außenanlagen, Hausmeister- und Grünpflege',
    activities: 'Kehren von Außenflächen, Laub, Grünpflege, kleine Hausmeisterarbeiten',
    match: /aussen|gruen|garten|gehweg|hofreinig|laub|unkraut|hausmeist|hauswart|muelltonn/,
    psa: ['Sicherheitsschuhe', 'Gehörschutz bei Laubbläser/Motorgeräten', 'Sonnenschutz'],
    hazards: [
      {
        factor: 'Physikalisch',
        hazard: 'Hitze und UV-Strahlung, Kälte und Nässe',
        measures: [
          'O Arbeiten in der Mittagshitze vermeiden, Trinkwasser, Pausen im Schatten',
          'P Sonnenschutz (Kopfbedeckung, Sonnencreme), wetterfeste Kleidung',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Mechanisch / Lärm',
        hazard: 'Motorgeräte (Laubbläser, Heckenschere), Werkzeuge, Verkehr am Gehweg',
        measures: [
          'O Geräte nur nach Einweisung, Schutzeinrichtungen nicht entfernen',
          'P Gehörschutz, Schutzbrille, Schnittschutz nach Gerät, Warnweste am Straßenrand',
        ],
        risk: 'mittel',
      },
      {
        factor: 'Biologisch',
        hazard: 'Zecken, Insektenstiche, Hundekot',
        measures: ['P Lange Kleidung, Handschuhe; nach der Arbeit auf Zecken prüfen'],
        risk: 'gering',
      },
    ],
  },
  {
    key: 'winter',
    title: 'Winterdienst',
    activities: 'Schnee räumen, Streuen',
    match: /winter|schnee|streu|raeumdienst|glaett/,
    psa: ['Schuhe mit Spikes/Grödel', 'Warnkleidung', 'Kälteschutzkleidung'],
    hazards: [
      {
        factor: 'Mechanisch',
        hazard: 'Ausrutschen auf Eis, Verkehr bei Dunkelheit, Heben von nassem Schnee',
        measures: [
          'O Zuerst Laufwege streuen, dann räumen; Schaufel nur halb füllen, schieben statt heben',
          'P Grödel/Spikes, Warnkleidung',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
      {
        factor: 'Physikalisch / Gefahrstoffe',
        hazard: 'Kälte, Streusalz an Haut und Augen',
        measures: ['O Aufwärmpausen', 'P Handschuhe, Kälteschutz, ggf. Schutzbrille beim Streuen'],
        risk: 'mittel',
      },
    ],
  },
  {
    key: 'hochdruck',
    title: 'Hochdruckreinigung und Fassadenreinigung',
    activities: 'Hochdruckreiniger, Graffiti-Entfernung, Fassaden',
    match: /hochdruck|fassad|graffit|dampfstrahl/,
    psa: ['Schutzbrille/Gesichtsschutz', 'Gehörschutz', 'Wasserdichte Kleidung'],
    hazards: [
      {
        factor: 'Mechanisch',
        hazard: 'Verletzung durch Wasserstrahl, Rückstoß, umherfliegende Teile',
        measures: [
          'O Nur unterwiesene Personen, Strahl nie auf Personen richten, Bereich absperren',
          'P Gesichtsschutz, Gehörschutz, feste Schuhe',
        ],
        risk: 'hoch',
        rest: 'mittel',
      },
    ],
  },
  {
    key: 'schule',
    title: 'Schulen und Kindertagesstätten',
    activities: 'Reinigung in Einrichtungen, in denen sich Kinder aufhalten',
    match: /schul|kita|kindergart|hort|gymnas|realschul|kinderkrippe/,
    psa: [],
    hazards: [
      {
        factor: 'Gefahrstoffe / Dritte',
        hazard: 'Kinder kommen an Reinigungsmittel oder Geräte',
        measures: [
          'O Reinigungswagen nie unbeaufsichtigt, Mittel im verschlossenen Putzraum',
          'O Sanitär- und Bodenreinigung möglichst außerhalb der Betreuungszeiten',
        ],
        risk: 'mittel',
        rest: 'gering',
      },
    ],
  },
];

/** Kleinschreibung, Umlaute als ae/oe/ue, ß als ss – für die Suche in Leistungsarten. */
export const normKey = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

export interface RiskInput {
  /** Leistungsarten und Titel der aktiven Leistungen */
  services: string[];
  /** Nutzungsarten im Raumbuch */
  roomTypes: string[];
  siteName: string;
  school: boolean;
  garage: boolean;
  /** Einsätze vor 7 oder ab 18 Uhr */
  offHours: boolean;
}

export interface SelectedModule {
  module: RiskModule;
  reason: string;
}

/** Welche Bausteine gelten für das Objekt – mit Begründung („Leistung Glasreinigung“). */
export function selectModules(input: RiskInput): SelectedModule[] {
  const out: SelectedModule[] = [];
  for (const m of RISK_MODULES) {
    if (m.key === 'allgemein') {
      out.push({ module: m, reason: 'gilt immer' });
      continue;
    }
    if (m.key === 'alleinarbeit') {
      if (input.offHours) out.push({ module: m, reason: 'Einsätze am Abend bzw. früh am Morgen' });
      continue;
    }
    const svc = m.match ? input.services.find((s) => m.match!.test(normKey(s))) : undefined;
    if (svc) {
      out.push({ module: m, reason: `Leistung „${svc}“` });
      continue;
    }
    const room = m.rooms ? input.roomTypes.find((r) => m.rooms!.test(normKey(r))) : undefined;
    if (room) {
      out.push({ module: m, reason: `Raumbuch „${room}“` });
      continue;
    }
    if (m.key === 'tiefgarage' && input.garage) {
      out.push({ module: m, reason: 'Objekt unter Tiefgaragenreinigung' });
      continue;
    }
    if (m.key === 'schule' && (input.school || (m.match && m.match.test(normKey(input.siteName))))) {
      out.push({ module: m, reason: input.school ? 'Objekt als Schule markiert' : 'Objektname' });
      continue;
    }
    if (m.key === 'tiefgarage' && /^(tg|tiefgarage)\b/i.test(input.siteName.trim())) {
      out.push({ module: m, reason: 'Objektname' });
    }
  }
  return out;
}

export const RISK_LABEL: Record<Risk, string> = { hoch: 'hoch', mittel: 'mittel', gering: 'gering' };

/** Maßnahme „T …“ → { kind: 'T', text } */
export function splitMeasure(m: string): { kind: 'T' | 'O' | 'P' | ''; text: string } {
  const r = /^([TOP]) (.*)$/s.exec(m);
  return r ? { kind: r[1] as 'T' | 'O' | 'P', text: r[2]! } : { kind: '', text: m };
}
