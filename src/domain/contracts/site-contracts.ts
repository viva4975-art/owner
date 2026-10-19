/**
 * Verträge am Objekt (Ahmed 19.10.: „neben freiem Brief Arbeitnehmerüberlassungsvertrag und Reinigungsvertrag
 * erstellen“). Texte als Bausteine wie die Nachunternehmer-Vorlagen; Platzhalter in geschweiften Klammern werden aus
 * Firma, Kunde, Objekt und den Formularangaben gefüllt (`fillAg`).
 *
 * Reinigungsvertrag: Dienstleistungs-/Werkvertrag über die Unterhaltsreinigung, Leistungsverzeichnis aus den
 * Leistungen des Objekts, Preisgleitklausel als Kostenelementeklausel (§ 1 Abs. 2 Nr. 3 PrKG) über den
 * Lohnkostenanteil, Weisungsrecht ausdrücklich beim Auftragnehmer (Abgrenzung zur Arbeitnehmerüberlassung).
 *
 * Arbeitnehmerüberlassungsvertrag (§ 12 AÜG): Schriftform (auf Papier, beide Seiten unterschreiben, vor Beginn der
 * Überlassung), Bezeichnung als Arbeitnehmerüberlassung (§ 1 Abs. 1 S. 5), Konkretisierung der Leiharbeitnehmer vor
 * der Überlassung (§ 1 Abs. 1 S. 6), Erklärung über die Erlaubnis (§ 12 Abs. 1 S. 2), Angaben des Entleihers zu den
 * wesentlichen Arbeitsbedingungen (§ 12 Abs. 1 S. 3), Höchstüberlassungsdauer 18 Monate (§ 1 Abs. 1b), kein Einsatz
 * als Streikbrecher (§ 11 Abs. 5), Arbeitsschutz beim Entleiher (§ 11 Abs. 6).
 */
import type { DocBlock } from '../subcontract/nu-docs.js';

/** Vertragsbaustein; `eckdaten` = Kasten mit den Eckdaten der Überlassung */
export type ContractBlock = DocBlock | { eckdaten: true };

export const REINIGUNGSVERTRAG: ContractBlock[] = [
  { h: '§ 1', t: 'Vertragsgegenstand' },
  {
    p: 'Der Auftraggeber (AG) beauftragt den Auftragnehmer (AN) mit der Reinigung des Objekts {objekt}. Art, Umfang und Häufigkeit der Leistungen ergeben sich aus dem Leistungsverzeichnis (Anlage 1). Der AN führt die Leistungen fachgerecht nach den anerkannten Regeln des Gebäudereiniger-Handwerks aus.',
  },
  {
    p: 'Der AN erbringt die Leistungen als selbstständiges Unternehmen mit eigenem Personal, eigener Organisation und eigenen Betriebsmitteln. Die Auswahl, Einteilung, Aufsicht und Weisung gegenüber dem eingesetzten Personal liegen ausschließlich beim AN; Wünsche und Hinweise des AG richtet dieser an die Objektleitung des AN. Eine Arbeitnehmerüberlassung ist nicht Gegenstand dieses Vertrages.',
  },
  { h: '§ 2', t: 'Vertragsbeginn, Laufzeit, Kündigung' },
  { p: '{laufzeit}' },
  {
    p: 'Das Recht zur außerordentlichen Kündigung aus wichtigem Grund bleibt unberührt. Kündigungen bedürfen der Textform.',
  },
  { h: '§ 3', t: 'Vergütung und Abrechnung' },
  {
    p: 'Für die regelmäßigen Leistungen erhält der AN die im Leistungsverzeichnis genannten Pauschalen, zurzeit {monat} netto je Monat, zuzüglich der gesetzlichen Umsatzsteuer. Die Monatspauschale ist auf das Jahr gerechnet; Feiertage und Tage, an denen das Objekt auf Veranlassung des AG geschlossen ist, mindern sie nicht, sofern nichts anderes vereinbart ist.',
  },
  {
    p: 'Leistungen „je Ausführung“ und zusätzliche Leistungen auf Anforderung des AG (Sonder- und Grundreinigungen, Regiestunden) werden nach Ausführung zu den vereinbarten Preisen berechnet{regie}. Zusätzliche Leistungen werden vorher in Textform vereinbart; der AN weist sie auf einem Arbeitsschein nach.',
  },
  {
    p: 'Der AN stellt monatlich Rechnung, auf Wunsch als E-Rechnung (XRechnung oder ZUGFeRD). Rechnungen sind zahlbar {zahlung}.',
  },
  { h: '§ 4', t: 'Preisanpassung (Lohngleitklausel)' },
  {
    p: 'Die Vergütung beruht auf dem Lohnkostenanteil von {lohnanteil} und dem allgemeinverbindlichen Tarifvertrag für das Gebäudereiniger-Handwerk bzw. dem gesetzlichen Mindestlohn. Ändert sich der für die eingesetzten Beschäftigten maßgebliche Tarif- oder Mindestlohn, ändert sich die Vergütung ab dem Monat des Inkrafttretens im Umfang des Lohnkostenanteils um denselben Prozentsatz (Beispiel: Tariflohnerhöhung 4 % × Lohnkostenanteil {lohnanteil}). Gleiches gilt für Änderungen der gesetzlichen Sozialabgaben des Arbeitgebers. Der AN teilt die Anpassung in Textform mit und weist die Berechnung nach.',
  },
  {
    p: 'Die Anpassung wirkt in beide Richtungen; der übrige Anteil der Vergütung (Material, Geräte, Verwaltung) bleibt unberührt. Darüber hinausgehende Preisänderungen bedürfen einer Vereinbarung.',
  },
  { h: '§ 5', t: 'Pflichten des Auftragnehmers' },
  {
    num: true,
    list: [
      'Der AN setzt zuverlässiges, eingewiesenes Personal ein und zahlt mindestens den gesetzlichen Mindestlohn und die tariflichen Mindestlöhne der Gebäudereinigung. Arbeitszeiten werden nach § 17 MiLoG aufgezeichnet.',
      'Der AN benennt eine Objektleitung als Ansprechpartner des AG und kontrolliert die Qualität der Leistungen regelmäßig.',
      'Das Personal trägt Dienstkleidung mit Firmenbezeichnung und führt einen Ausweis mit sich.',
      'Überlassene Schlüssel und Zugangsmittel werden gegen Quittung übergeben, sorgfältig verwahrt und nur an eingewiesenes Personal ausgegeben. Ein Verlust wird dem AG unverzüglich gemeldet.',
      'Der AN verwendet Reinigungsmittel und Verfahren, die für die jeweiligen Oberflächen geeignet sind; Sicherheitsdatenblätter liegen im Objekt vor.',
      'Der AN und sein Personal behandeln alle Informationen über den AG, das Objekt und dessen Nutzer vertraulich, auch über das Vertragsende hinaus.',
    ],
  },
  { h: '§ 6', t: 'Mitwirkung des Auftraggebers' },
  {
    num: true,
    list: [
      'Der AG gewährt dem Personal des AN zu den vereinbarten Zeiten Zugang zum Objekt.',
      'Der AG stellt Wasser und Strom unentgeltlich sowie einen abschließbaren Raum für Reinigungsmittel und Geräte zur Verfügung.',
      'Der AG benennt einen Ansprechpartner und weist auf besondere Gefahren, Sicherheitsvorschriften und Hausregeln im Objekt hin (§ 8 ArbSchG).',
      'Änderungen der Nutzung, der Flächen oder der Öffnungszeiten teilt der AG rechtzeitig mit; wirken sie sich auf den Aufwand aus, passen die Parteien Leistungsverzeichnis und Vergütung an.',
    ],
  },
  { h: '§ 7', t: 'Mängel' },
  {
    p: 'Mängel der Reinigung rügt der AG unverzüglich, spätestens am folgenden Werktag, in Textform gegenüber der Objektleitung des AN. Der AN bessert berechtigte Mängel innerhalb eines Werktages nach. Erst wenn die Nachbesserung fehlschlägt oder verweigert wird, kann der AG die Vergütung für die betroffene Leistung angemessen mindern. Leistungen, die der AN aus von ihm zu vertretenden Gründen nicht erbringt, werden nachgeholt oder anteilig von der Vergütung abgezogen.',
  },
  { h: '§ 8', t: 'Haftung und Versicherung' },
  {
    p: 'Der AN unterhält eine Betriebshaftpflichtversicherung, die auch Schäden aus dem Verlust von Schlüsseln abdeckt, und weist sie auf Verlangen nach. Der AN haftet für Schäden, die er oder sein Personal vorsätzlich oder fahrlässig verursachen. Bei leichter Fahrlässigkeit haftet der AN nur bei Verletzung einer wesentlichen Vertragspflicht und begrenzt auf den vertragstypisch vorhersehbaren Schaden; dies gilt nicht für Schäden an Leben, Körper und Gesundheit. Schäden sind dem AN unverzüglich anzuzeigen.',
  },
  { h: '§ 9', t: 'Personal des Auftragnehmers' },
  {
    p: 'Beide Parteien verpflichten sich, während der Vertragslaufzeit und zwölf Monate danach keine Beschäftigten der jeweils anderen Partei, die im Objekt eingesetzt sind oder waren, aktiv abzuwerben.',
  },
  { h: '§ 10', t: 'Datenschutz' },
  {
    p: 'Soweit der AN bei der Reinigung Kenntnis von personenbezogenen Daten erhält, ist dies nicht Gegenstand des Auftrags; der AN behandelt solche Daten vertraulich und verwendet sie nicht. Die Parteien verarbeiten die Kontaktdaten der jeweils anderen Partei nur zur Durchführung dieses Vertrages.',
  },
  { h: '§ 11', t: 'Schlussbestimmungen' },
  {
    num: true,
    list: [
      'Änderungen und Ergänzungen dieses Vertrages bedürfen der Textform. Allgemeine Geschäftsbedingungen des AG gelten nicht, soweit sie diesem Vertrag widersprechen.',
      'Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam.',
      'Es gilt deutsches Recht. Sind beide Parteien Kaufleute oder ist der AG eine juristische Person des öffentlichen Rechts, ist Gerichtsstand {ort}.',
    ],
  },
  { p: 'Anlage 1: Leistungsverzeichnis', bold: true },
];

export const AUE_VERTRAG: ContractBlock[] = [
  { h: '§ 1', t: 'Gegenstand – Arbeitnehmerüberlassung' },
  {
    p: 'Die Parteien schließen diesen Vertrag ausdrücklich als Arbeitnehmerüberlassungsvertrag im Sinne des Arbeitnehmerüberlassungsgesetzes (§ 1 Abs. 1 Satz 5 AÜG). Der Verleiher überlässt dem Entleiher Arbeitnehmer (Leiharbeitnehmer) zur Arbeitsleistung im Betrieb des Entleihers.',
  },
  { eckdaten: true },
  { h: '§ 2', t: 'Erlaubnis des Verleihers' },
  {
    p: '{erlaubnis} Der Verleiher teilt dem Entleiher unverzüglich mit, wenn die Erlaubnis wegfällt, nicht verlängert, zurückgenommen oder widerrufen wird (§ 12 Abs. 2 AÜG).',
  },
  { h: '§ 3', t: 'Benennung der Leiharbeitnehmer' },
  {
    p: 'Der Verleiher benennt die zu überlassenden Leiharbeitnehmer namentlich vor Beginn der jeweiligen Überlassung in Textform (Anlage 1, § 1 Abs. 1 Satz 6 AÜG). Der Verleiher kann Leiharbeitnehmer austauschen; der Austausch wird vorher in gleicher Weise benannt.',
  },
  { h: '§ 4', t: 'Höchstüberlassungsdauer' },
  {
    p: 'Ein Leiharbeitnehmer wird demselben Entleiher höchstens 18 aufeinanderfolgende Monate überlassen (§ 1 Abs. 1b AÜG). Zeiten früherer Überlassungen an den Entleiher – auch durch andere Verleiher – werden angerechnet, wenn zwischen den Einsätzen nicht mehr als drei Monate liegen. Der Entleiher teilt dem Verleiher vor Beginn mit, ob ein benannter Leiharbeitnehmer in den letzten drei Monaten bei ihm eingesetzt war.',
  },
  { h: '§ 5', t: 'Arbeitsbedingungen beim Entleiher' },
  {
    p: 'Der Entleiher gibt in Anlage 2 an, welche wesentlichen Arbeitsbedingungen einschließlich des Arbeitsentgelts für vergleichbare Arbeitnehmer in seinem Betrieb gelten, oder dass er keine vergleichbaren Arbeitnehmer beschäftigt (§ 12 Abs. 1 Satz 3 AÜG). Änderungen teilt er unverzüglich mit. Der Entleiher gewährt den Leiharbeitnehmern Zugang zu Gemeinschaftseinrichtungen und -diensten wie seinen eigenen Beschäftigten (§ 13b AÜG) und informiert sie über freie Arbeitsplätze (§ 13a AÜG).',
  },
  { h: '§ 6', t: 'Weisungsrecht, Arbeitszeit, Arbeitsschutz' },
  {
    num: true,
    list: [
      'Der Entleiher erteilt den Leiharbeitnehmern die Weisungen zur Arbeitsausführung am Einsatzort und beaufsichtigt sie. Er setzt sie nur für die in § 1 genannten Tätigkeiten ein.',
      'Der Entleiher beachtet die Vorschriften des Arbeitszeitgesetzes; Arbeitszeiten über die vereinbarte Einsatzzeit hinaus bedürfen der vorherigen Abstimmung mit dem Verleiher.',
      'Die Tätigkeit unterliegt den für den Betrieb des Entleihers geltenden Vorschriften des Arbeitsschutzrechts; die daraus folgenden Pflichten des Arbeitgebers obliegen dem Entleiher unbeschadet der Pflichten des Verleihers (§ 11 Abs. 6 AÜG). Der Entleiher unterweist die Leiharbeitnehmer vor Arbeitsaufnahme über die Gefahren am Arbeitsplatz, stellt die erforderliche persönliche Schutzausrüstung bereit, soweit nicht anders vereinbart, und meldet Arbeitsunfälle unverzüglich dem Verleiher.',
      'Der Entleiher bestätigt die geleisteten Stunden wöchentlich auf dem Stundennachweis des Verleihers (Beginn, Ende, Pausen). Die Aufzeichnungspflicht nach § 17 MiLoG bleibt unberührt.',
    ],
  },
  { h: '§ 7', t: 'Arbeitskampf' },
  {
    p: 'Leiharbeitnehmer werden nicht tätig, soweit der Betrieb des Entleihers unmittelbar durch einen Arbeitskampf betroffen ist und sie Tätigkeiten streikender Arbeitnehmer übernehmen würden (§ 11 Abs. 5 AÜG). Der Entleiher unterrichtet den Verleiher unverzüglich über einen Arbeitskampf.',
  },
  { h: '§ 8', t: 'Vergütung' },
  {
    p: 'Der Entleiher zahlt für jede geleistete Arbeitsstunde den Verrechnungssatz von {satz} netto zuzüglich der gesetzlichen Umsatzsteuer. {zuschlaege} Abgerechnet wird {abrechnung} nach den bestätigten Stundennachweisen; Rechnungen sind zahlbar {zahlung}.',
  },
  {
    p: 'Erhöhen sich die Lohnkosten des Verleihers für die überlassenen Arbeitnehmer durch Tarif- oder Mindestlohnänderungen oder durch den Anspruch auf gleiches Arbeitsentgelt (§ 8 AÜG), ändert sich der Verrechnungssatz ab dem Zeitpunkt der Änderung um denselben Prozentsatz; der Verleiher teilt dies in Textform mit.',
  },
  { h: '§ 9', t: 'Ausfall, Haftung' },
  {
    p: 'Fällt ein Leiharbeitnehmer aus (z. B. Krankheit, Urlaub), stellt der Verleiher nach Möglichkeit Ersatz; nicht geleistete Stunden werden nicht berechnet. Der Verleiher haftet nur für die ordnungsgemäße Auswahl der Leiharbeitnehmer im Hinblick auf die vereinbarte Tätigkeit, nicht für die Ausführung der Arbeiten, die unter der Leitung des Entleihers erfolgen. Hinweis: Der Entleiher haftet für die Sozialversicherungsbeiträge der Leiharbeitnehmer wie ein selbstschuldnerischer Bürge (§ 28e Abs. 2 SGB IV).',
  },
  { h: '§ 10', t: 'Übernahme von Leiharbeitnehmern' },
  {
    p: 'Begründet der Entleiher während der Überlassung oder innerhalb von sechs Monaten danach ein Arbeitsverhältnis mit einem überlassenen Leiharbeitnehmer, zahlt er dem Verleiher eine Vermittlungsvergütung (§ 9 Abs. 1 Nr. 3 AÜG). Sie beträgt das {vermittlung}-fache des zuletzt gezahlten monatlichen Bruttoentgelts des Leiharbeitnehmers und vermindert sich für jeden vollen Monat der vorangegangenen Überlassung um ein Zwölftel; nach zwölf Monaten Überlassung entfällt sie.',
  },
  { h: '§ 11', t: 'Laufzeit und Kündigung' },
  { p: '{laufzeit}' },
  { h: '§ 12', t: 'Schlussbestimmungen' },
  {
    num: true,
    list: [
      'Dieser Vertrag und seine Änderungen bedürfen der Schriftform (§ 12 Abs. 1 Satz 1 AÜG); beide Parteien unterschreiben eigenhändig vor Beginn der Überlassung. Die Benennung der Leiharbeitnehmer (Anlage 1) erfolgt in Textform.',
      'Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam.',
      'Es gilt deutsches Recht. Sind beide Parteien Kaufleute oder ist der Entleiher eine juristische Person des öffentlichen Rechts, ist Gerichtsstand {ort}.',
    ],
  },
];
