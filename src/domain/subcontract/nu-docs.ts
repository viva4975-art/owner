/**
 * Vorlagen für Nachunternehmer (Ahmed 19.10.: „Selbstauskunft, Vertrag usw. automatisch erstellen wie in der alten
 * App, anpassen, verbessern“). Texte aus der alten App (VD-NU-01 Rahmenvertrag, Selbstauskunft, Mindestlohn-,
 * Tariferklärung, Bewertungsbogen), überarbeitet:
 * - Arbeitszeitgesetz statt „Arbeitszeitordnung“, keine SOKA-BAU (gilt nicht für die Gebäudereinigung),
 * - Kundenschutz nach Vertragsende 2 statt 5 Jahre (längere Fristen hält die Rechtsprechung für unwirksam),
 * - kein „Verzicht auf den Fortsetzungszusammenhang“ (in AGB unwirksam), Vertragsstrafen gedeckelt,
 * - Pauschale 500 € bei Straftaten nur mit Nachweis eines geringeren Schadens (§ 309 Nr. 5 BGB),
 * - Abwerbeverbot nur aktives Abwerben, 2 Jahre (§ 75f HGB),
 * - Textform statt „doppelter Schriftform“ (in AGB unwirksam, § 305b BGB),
 * - neu: § 13b UStG, Ausschluss nach § 19 MiLoG / § 21 SchwarzArbG (öffentliche Auftraggeber), Wettbewerbsregister.
 * Platzhalter: {ag} = unsere Firma, {start} = Vertragsbeginn.
 */

export type DocBlock =
  | { h: string; t?: string }
  | { p: string; bold?: boolean }
  | { list: string[]; num?: boolean }
  | { table: [string, string][] };

export const RAHMENVERTRAG: DocBlock[] = [
  { h: 'Präambel' },
  {
    p: '{ag} erbringt Dienstleistungen im Bereich der Gebäudereinigung und setzt hierfür in einzelnen Objekten Nachunternehmer ein. Dieser Rahmenvertrag regelt die Mindestanforderungen, die für alle Einzelaufträge (Bestellungen) zwischen den Parteien gelten. Jeder Einzelauftrag wird gesondert per Bestellschein erteilt; bei Widersprüchen geht die Bestellung diesem Rahmenvertrag vor.',
  },
  { h: '§ 1', t: 'Einhaltung der rechtlichen Bestimmungen, Garantie' },
  {
    p: 'Der Auftragnehmer garantiert, dass alle Arbeitsverhältnisse der von ihm eingesetzten Personen den einschlägigen Bestimmungen entsprechen, insbesondere dem Mindestlohngesetz, dem Arbeitnehmer-Entsendegesetz, dem allgemeinverbindlichen Tarifvertrag für das Gebäudereinigerhandwerk, dem Bundesurlaubsgesetz, dem Entgeltfortzahlungsgesetz, dem Mutterschutzgesetz, dem Arbeitszeitgesetz und dem Jugendarbeitsschutzgesetz. Er stellt dies durch geeignete organisatorische Maßnahmen sicher.',
  },
  { p: 'Der Auftragnehmer garantiert insbesondere:' },
  {
    num: true,
    list: [
      'Er rechnet Lohn und Gehalt monatlich ab und zahlt den fälligen Lohn spätestens zum gesetzlichen Fälligkeitstag (§ 2 MiLoG) aus.',
      'Er zahlt mindestens den gesetzlichen Mindestlohn und den jeweils geltenden tariflichen Mindestlohn der Gebäudereinigung (Lohngruppe 1, Glas- und Fassadenreinigung Lohngruppe 6).',
      'Die Arbeitsverträge seiner Beschäftigten entsprechen den gesetzlichen Mindestbedingungen; die wesentlichen Vertragsbedingungen sind nach dem Nachweisgesetz dokumentiert.',
      'Beginn, Ende und Dauer der täglichen Arbeitszeit werden spätestens bis zum Ablauf des siebten auf den Arbeitstag folgenden Kalendertages aufgezeichnet und mindestens zwei Jahre aufbewahrt (§ 17 MiLoG).',
      'Alle Beschäftigten sind ordnungsgemäß zur Sozialversicherung gemeldet; Lohnsteuer und Sozialversicherungsbeiträge werden vollständig und fristgerecht abgeführt.',
      'Beschaffung, Auswahl, Einstellung und Führung des eingesetzten Personals liegen ausschließlich beim Auftragnehmer.',
      'Es werden ausschließlich die vereinbarten Leistungen erbracht; vertragsfremde Nebentätigkeiten sind ausgeschlossen.',
      'Die Unfallverhütungsvorschriften der Berufsgenossenschaft und die Vorgaben des Arbeitsschutzes (insbesondere Gefährdungsbeurteilung und Unterweisung, § 5 und § 12 ArbSchG) erfüllt der Auftragnehmer in eigener Verantwortung.',
    ],
  },
  {
    p: 'Setzt der Auftragnehmer Personen ein, die einen Aufenthaltstitel mit Erlaubnis zur Beschäftigung benötigen, besitzen diese einen gültigen Titel. Der Auftragnehmer prüft dies vor Arbeitsbeginn und bewahrt eine Kopie für die Dauer der Beschäftigung auf (§ 4a Abs. 5 AufenthG).',
  },
  {
    p: 'Der Einsatz eigener Nachunternehmer durch den Auftragnehmer ist nicht gestattet. Ausnahmen bedürfen im Einzelfall der vorherigen Zustimmung des Auftraggebers in Textform; die Garantien dieses Paragraphen gelten dann auch für den weiteren Nachunternehmer.',
  },
  {
    p: 'Wird gegen den Auftraggeber wegen eines Verstoßes des Auftragnehmers oder eines von ihm eingesetzten Nachunternehmers gegen die vorstehenden Pflichten ein Bußgeld festgesetzt, erstattet der Auftragnehmer dem Auftraggeber das Bußgeld und die Kosten des Verfahrens.',
  },
  {
    p: 'Der Auftragnehmer stellt den Auftraggeber von allen Ansprüchen frei, die gegen den Auftraggeber aus der Haftung des Auftraggebers nach § 13 MiLoG in Verbindung mit § 14 AEntG oder nach § 28e Abs. 3a SGB IV geltend gemacht werden, einschließlich Nachforderungen von Sozialversicherungsträgern und Finanzbehörden sowie angemessener Kosten der Rechtsverteidigung.',
  },
  {
    p: 'Der Auftragnehmer erbringt die Leistungen als selbstständiges Unternehmen in eigener Organisation, mit eigenem Personal und eigenen Betriebsmitteln. Eine Arbeitnehmerüberlassung ist nicht Gegenstand dieses Vertrages. Weisungen gegenüber den Beschäftigten des Auftragnehmers erteilt allein der Auftragnehmer; die fachliche Abstimmung der Leistung bleibt unberührt. Die Vergütung erfolgt objekt- und leistungsbezogen laut Bestellung.',
  },
  { h: '§ 2', t: 'Laufzeit, ordentliche Kündigung' },
  {
    p: 'Der Vertrag beginnt am {start} und läuft auf unbestimmte Zeit. Er kann von beiden Parteien mit einer Frist von einem Monat zum Monatsende gekündigt werden. Die Kündigung bedarf der Textform.',
  },
  {
    p: 'Wird dieser Vertrag gekündigt, enden zum selben Zeitpunkt auch alle laufenden Einzelaufträge, ohne dass es einer gesonderten Kündigung bedarf.',
  },
  { h: '§ 3', t: 'Außerordentliche Kündigung' },
  { p: 'Beide Parteien können den Vertrag aus wichtigem Grund fristlos kündigen, insbesondere wenn' },
  {
    list: [
      'die andere Partei ihre Zahlungen einstellt oder über ihr Vermögen ein Insolvenzverfahren beantragt, eröffnet oder mangels Masse abgelehnt wird;',
      'die andere Partei erheblich gegen Pflichten aus diesem Vertrag verstößt und den Verstoß trotz Abmahnung nicht innerhalb angemessener Frist abstellt;',
      'der Auftragnehmer gegen § 1 (Mindestlohn, Sozialversicherung, Aufenthaltsrecht), § 5 (Auftreten gegenüber Kunden), § 6 (Personal, Zutritt und Schlüssel), § 11 (Kundenschutz) oder § 12 (Abwerbeverbot) verstößt; einer Abmahnung bedarf es in diesen Fällen nicht.',
    ],
  },
  { p: 'Die fristlose Kündigung beendet zugleich alle Einzelaufträge. Sie bedarf der Textform.' },
  { h: '§ 4', t: 'Vorlage von Unterlagen' },
  { p: 'Der Auftragnehmer legt bei Vertragsabschluss vor:' },
  {
    list: [
      'Gewerbeanmeldung und, bei eingetragenen Unternehmen, einen aktuellen Handelsregisterauszug; Änderungen (Gewerbeummeldung) legt er unaufgefordert vor,',
      'Eintragung in die Handwerksrolle bzw. das Verzeichnis zulassungsfreier Handwerke (Anlage B Abschnitt 1 HwO),',
      'bei Einzelunternehmen: Ausweis des Inhabers, bei Bedarf mit Aufenthaltstitel,',
      'Nachweis der Betriebshaftpflichtversicherung nach § 9,',
      'Unbedenklichkeitsbescheinigungen der Krankenkassen, der Berufsgenossenschaft (BG BAU), der Minijob-Zentrale (sofern Minijobber beschäftigt sind) und des Finanzamts (Bescheinigung in Steuersachen),',
      'Freistellungsbescheinigung nach § 48b EStG, soweit Bauleistungen beauftragt werden,',
      'die unterschriebene Selbstauskunft und die Mindestlohnerklärung des Auftraggebers.',
    ],
  },
  {
    p: 'Die Unbedenklichkeitsbescheinigungen legt der Auftragnehmer mindestens halbjährlich, alle übrigen Nachweise vor Ablauf ihrer Gültigkeit unaufgefordert erneut vor. Solange Nachweise fehlen, ist der Auftraggeber berechtigt, fällige Zahlungen bis zur Vorlage zurückzubehalten.',
  },
  { h: '§ 5', t: 'Auftreten gegenüber Kunden, Werbe- und Kontaktverbot' },
  {
    p: 'Die Leistungen werden gegenüber den Kunden des Auftraggebers im Namen des Auftraggebers erbracht. Der Auftragnehmer und sein Personal treten gegenüber Kunden, deren Mitarbeitern, Mietern, Besuchern und sonstigen Dritten im Objekt einheitlich für den Auftraggeber auf. Werbung für das eigene Unternehmen ist im Zusammenhang mit den Objekten untersagt, insbesondere',
  },
  {
    list: [
      'Firmennamen, Logos, Visitenkarten, Flyer, Aufkleber, Aushänge oder Preislisten des Auftragnehmers,',
      'Arbeitskleidung mit Namen oder Logo des Auftragnehmers oder eines Dritten,',
      'beschriftete Fahrzeuge des Auftragnehmers im Sicht- oder Zufahrtsbereich des Objekts,',
      'Angebote, Preisauskünfte oder Leistungszusagen gegenüber Kunden des Auftraggebers sowie die Weitergabe eigener Kontaktdaten.',
    ],
  },
  {
    p: 'Das Personal trägt neutrale Arbeitskleidung ohne Aufdruck oder die vom Auftraggeber beigestellte Kleidung. Es führt einen Ausweis mit, der den Namen der Person und ihres tatsächlichen Arbeitgebers nennt, und zeigt ihn auf Verlangen vor.',
  },
  {
    p: 'Gegenüber Behörden und Prüfstellen, insbesondere der Finanzkontrolle Schwarzarbeit, Polizei, Sozialversicherungsträgern und Aufsichtsbehörden, sowie gegenüber dem Auftraggeber ist der tatsächliche Arbeitgeber stets vollständig und wahrheitsgemäß anzugeben. Der Auftragnehmer belehrt sein Personal über die Pflicht, Ausweispapiere mitzuführen (§ 2a SchwarzArbG), und hält den Nachweis der Belehrung bereit.',
  },
  {
    p: 'Geschäftlicher Kontakt zum Kunden erfolgt ausschließlich über den Auftraggeber. Reklamationen, Leistungsänderungen, Zusatzwünsche und Terminänderungen meldet der Auftragnehmer unverzüglich dem Auftraggeber; unmittelbare Absprachen mit dem Kunden binden den Auftraggeber nicht.',
  },
  {
    p: 'Foto-, Film- und Tonaufnahmen in den Objekten sind nur zulässig, soweit sie der Leistungsdokumentation dienen und der Auftraggeber zugestimmt hat; eine Veröffentlichung ist untersagt. Der Auftragnehmer darf den Auftraggeber und dessen Kunden nicht als Referenz verwenden.',
  },
  {
    p: 'Der Auftragnehmer verpflichtet sein Personal vor dem ersten Einsatz in Textform auf diese Regeln und legt die Belehrung auf Verlangen vor.',
  },
  { h: '§ 6', t: 'Personal, Arbeitskleidung, Zutritt und Schlüssel' },
  {
    p: 'Der Auftragnehmer meldet die im Objekt eingesetzten Personen vor Einsatzbeginn namentlich; Änderungen meldet er vor dem ersten Einsatz der neuen Person. Der Auftraggeber kann den Einsatz einzelner Personen aus sachlichem Grund ablehnen; der Auftragnehmer stellt dann unverzüglich gleichwertigen Ersatz.',
  },
  {
    p: 'Das Personal des Auftragnehmers wird nicht in die Arbeitsorganisation des Auftraggebers eingegliedert: keine gemischten Teams am selben Arbeitsplatz, keine Führung in Zeiterfassung oder Dienstplanung des Auftraggebers; Urlaubs-, Schicht- und Vertretungsregelungen trifft allein der Auftragnehmer. Hinweise des Auftraggebers richten sich an die Leitung des Auftragnehmers.',
  },
  {
    p: 'Beigestellte Arbeitskleidung wird dem Auftragnehmer gegen Quittung übergeben, bleibt Eigentum des Auftraggebers und ist nach Vertragsende gereinigt zurückzugeben; nicht zurückgegebene Teile werden zum Zeitwert berechnet.',
  },
  {
    p: 'Schlüssel, Transponder und Codes werden gegen Quittung übergeben, sind sorgfältig zu verwahren und dürfen weder weitergegeben noch vervielfältigt werden. Ein Verlust ist unverzüglich zu melden. Die Kosten eines dadurch erforderlichen Austauschs der Schließanlage trägt der Auftragnehmer, wenn er den Verlust zu vertreten hat.',
  },
  {
    p: 'Betriebsfremde Personen dürfen nicht in die Objekte mitgebracht werden. Alkohol und Betäubungsmittel sind vor und während der Arbeit verboten. Hausordnung und Sicherheitsregeln des Kunden sind einzuhalten.',
  },
  { h: '§ 7', t: 'Kontroll- und Nachweispflichten' },
  {
    p: 'Der Auftraggeber darf die Einhaltung der vertraglichen und gesetzlichen Pflichten prüfen. Der Auftragnehmer legt auf Verlangen Einsatz- und Stundennachweise, Aufzeichnungen nach § 17 MiLoG sowie Nachweise über die Zahlung der Löhne und Sozialversicherungsbeiträge vor; für die Prüfung nicht erforderliche personenbezogene Daten dürfen geschwärzt werden.',
  },
  {
    p: 'Der Auftraggeber darf die Leistung im Objekt kontrollieren und die Identität der eingesetzten Personen feststellen. Kommt der Auftragnehmer den Nachweispflichten trotz Fristsetzung nicht nach, darf der Auftraggeber fällige Zahlungen bis zur Vorlage zurückbehalten.',
  },
  { h: '§ 8', t: 'Haftung' },
  {
    p: 'Der Auftragnehmer haftet für alle Schäden, die er oder sein Personal bei der Ausführung schuldhaft verursacht. Schäden und Mängel an Gebäuden und Einrichtungen, die bei der Arbeit entstehen oder entdeckt werden, meldet er unverzüglich dem Auftraggeber und, soweit möglich, dem Hausherrn.',
  },
  {
    p: 'Begeht der Auftragnehmer oder sein Personal im Objekt eine Straftat, erhält die betreffende Person Hausverbot; der Auftraggeber kann eine Aufwandspauschale von 500,00 € verlangen. Dem Auftragnehmer bleibt der Nachweis vorbehalten, dass kein oder ein wesentlich geringerer Aufwand entstanden ist. Weitergehende Ansprüche bleiben unberührt; die Pauschale wird angerechnet.',
  },
  { h: '§ 9', t: 'Versicherung' },
  {
    p: 'Der Auftragnehmer unterhält für die Dauer des Vertrages eine Betriebshaftpflichtversicherung für sich und sein Personal mit einer Deckungssumme von mindestens',
  },
  { p: '3.000.000 € pauschal für Personen-, Sach- und Vermögensschäden', bold: true },
  {
    p: 'einschließlich Schlüsselverlust und Tätigkeitsschäden, und weist sie auf Verlangen nach. Eine Kündigung oder Einschränkung des Versicherungsschutzes teilt er unverzüglich mit.',
  },
  { h: '§ 10', t: 'Geheimhaltung und Datenschutz' },
  {
    p: 'Der Auftragnehmer behandelt alle Angelegenheiten des Auftraggebers und der Kunden, von denen er bei der Tätigkeit Kenntnis erlangt, vertraulich, macht sie Dritten nicht zugänglich und verwendet sie nicht für eigene Zwecke. Die Pflicht gilt über das Vertragsende hinaus.',
  },
  {
    p: 'Der Auftragnehmer verpflichtet sein Personal vor Aufnahme der Tätigkeit nachweislich auf Vertraulichkeit und Datenschutz. Personenbezogene Daten, von denen das Personal im Objekt Kenntnis erlangt, dürfen nur zur Vertragserfüllung genutzt und nicht kopiert, gespeichert oder weitergegeben werden. Unterlagen und Datenträger des Auftraggebers oder der Kunden sind nach Ende des Einsatzes herauszugeben.',
  },
  { h: '§ 11', t: 'Kundenschutz' },
  {
    p: 'Der Auftragnehmer führt bei Kunden des Auftraggebers, die er durch diesen Vertrag kennengelernt hat, keine Tätigkeiten des Gebäudereinigerhandwerks auf eigene oder fremde Rechnung aus und beteiligt sich auch nicht mittelbar daran. Dies gilt während der Laufzeit und zwei Jahre nach Vertragsende, jeweils für die Kunden, für die der Auftragnehmer in den letzten zwölf Monaten vor Vertragsende tätig war.',
  },
  {
    p: 'Für jeden Verstoß ist eine Vertragsstrafe fällig, die sich nach dem Auftragswert beim Kunden richtet:',
  },
  {
    table: [
      ['Auftragswert bis 25.000,00 € netto/Jahr', '4.000,00 €'],
      ['Auftragswert bis 50.000,00 € netto/Jahr', '6.000,00 €'],
      ['Auftragswert über 50.000,00 € netto/Jahr', '8.000,00 €'],
    ],
  },
  { h: '§ 12', t: 'Abwerbeverbot' },
  {
    p: 'Der Auftragnehmer wirbt während der Laufzeit und zwei Jahre nach Vertragsende weder unmittelbar noch mittelbar Beschäftigte des Auftraggebers aktiv ab. Das Recht der Beschäftigten, ihren Arbeitsplatz frei zu wählen, bleibt unberührt.',
  },
  { h: '§ 13', t: 'Vertragsstrafe' },
  { p: 'Für schuldhafte Verstöße gelten je Einzelfall folgende Vertragsstrafen:' },
  {
    table: [
      ['§ 5 Auftreten, Werbe- und Kontaktverbot', '1.500,00 €'],
      ['§ 6 Personalmeldung, eigene Nachunternehmer, Schlüssel', '2.500,00 €'],
      ['§ 10 Geheimhaltung und Datenschutz', '2.500,00 €'],
      ['§ 12 Abwerbeverbot, je abgeworbene Person', '5.000,00 €'],
    ],
  },
  {
    p: 'Die Vertragsstrafen nach §§ 11 und 13 sind je Kalenderjahr insgesamt auf 5 % der Netto-Auftragssumme dieses Jahres, mindestens jedoch auf 5.000,00 €, begrenzt. Der Auftraggeber kann sie mit fälligen Forderungen des Auftragnehmers verrechnen. Weitergehende Ansprüche auf Schadenersatz und Unterlassung bleiben unberührt; verwirkte Vertragsstrafen werden auf den Schadenersatz angerechnet.',
  },
  { h: '§ 14', t: 'Abrechnung' },
  {
    p: 'Der Auftragnehmer rechnet je Bestellung und Leistungszeitraum ab und gibt die Bestellnummer auf jeder Rechnung an. Soweit die Leistungen der Steuerschuldnerschaft des Leistungsempfängers unterliegen (§ 13b Abs. 2 Nr. 8 UStG, Gebäudereinigung an einen Gebäudereiniger), stellt er Rechnungen ohne Umsatzsteuer mit dem Hinweis „Steuerschuldnerschaft des Leistungsempfängers“ aus.',
  },
  {
    p: 'Der Auftragnehmer versichert, dass gegen ihn keine Ausschlussgründe nach § 19 MiLoG, § 21 AEntG oder § 21 SchwarzArbG vorliegen und keine Eintragung im Wettbewerbsregister besteht; Änderungen teilt er unverzüglich mit, da öffentliche Auftraggeber dies auch für Nachunternehmer prüfen.',
  },
  { h: '§ 15', t: 'Schlussbestimmungen' },
  {
    p: 'Änderungen und Ergänzungen dieses Vertrages bedürfen der Textform; individuelle Absprachen haben Vorrang (§ 305b BGB). Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam; an ihre Stelle tritt die gesetzliche Regelung. Gerichtsstand ist München, soweit beide Parteien Kaufleute sind. Es gilt deutsches Recht.',
  },
];

/** Selbstauskunft: Erklärungen zum Ankreuzen (Abschnitt → Punkte) */
export const SELBSTAUSKUNFT: { title: string; items: string[] }[] = [
  {
    title: 'Gewerbe und Zulassung',
    items: [
      'Das Unternehmen ist gewerberechtlich angemeldet und in die Handwerksrolle bzw. das Verzeichnis zulassungsfreier Handwerke (Anlage B Abschnitt 1 HwO, Gebäudereiniger) eingetragen.',
      'Es verfügt über alle für die beauftragten Leistungen erforderlichen Genehmigungen und Erlaubnisse.',
    ],
  },
  {
    title: 'Personal',
    items: [
      'Alle eingesetzten Personen sind bei der zuständigen Krankenkasse bzw. der Minijob-Zentrale und bei der Berufsgenossenschaft (BG BAU) angemeldet.',
      'Alle eingesetzten Personen erhalten mindestens den gesetzlichen Mindestlohn und den tariflichen Mindestlohn der Gebäudereinigung.',
      'Lohnsteuer und Sozialversicherungsbeiträge werden vollständig und fristgerecht abgeführt.',
      'Alle eingesetzten Personen besitzen, soweit erforderlich, einen Aufenthaltstitel, der die Beschäftigung erlaubt.',
      'Die Arbeitszeit wird nach § 17 MiLoG aufgezeichnet (Beginn, Ende, Dauer binnen 7 Tagen) und 2 Jahre aufbewahrt.',
    ],
  },
  {
    title: 'Keine Weitergabe von Aufträgen',
    items: [
      'Wir setzen für Aufträge von {ag} keine eigenen Nachunternehmer ein und geben keine Aufträge an Dritte weiter.',
      'Wir übernehmen keine Aufträge anderer Nachunternehmer von {ag} und stellen ihnen keine Rechnungen für Leistungen in deren Objekten.',
      'Uns ist bekannt: Jede Weitergabe, Personalstellung oder gegenseitige Beauftragung zwischen Nachunternehmern bedarf der vorherigen Zustimmung von {ag} in Textform.',
    ],
  },
  {
    title: 'Ausschlussgründe',
    items: [
      'Gegen das Unternehmen und seine vertretungsberechtigten Personen wurde in den letzten zwei Jahren keine Geldbuße von mindestens 2.500 € nach § 21 MiLoG, § 23 AEntG oder § 21 SchwarzArbG verhängt und keine Freiheits- oder Geldstrafe von mehr als drei Monaten bzw. 90 Tagessätzen nach diesen Gesetzen verhängt.',
      'Für das Unternehmen besteht keine Eintragung im Wettbewerbsregister; es befindet sich nicht in Insolvenz oder Liquidation.',
    ],
  },
];

export const SELBSTAUSKUNFT_DOCS = [
  'Gewerbeanmeldung bzw. Handelsregisterauszug',
  'Eintragung Handwerksrolle / Anlage B1 HwO',
  'Betriebshaftpflichtversicherung (mind. 3.000.000 €)',
  'Unbedenklichkeitsbescheinigungen Krankenkasse(n), BG BAU, Minijob-Zentrale (falls Minijobber)',
  'Bescheinigung in Steuersachen (Finanzamt); Freistellungsbescheinigung § 48b EStG bei Bauleistungen',
  'Mindestlohnerklärung; auf Verlangen Personaleinsatzliste',
];

export const SELBSTAUSKUNFT_END = [
  'Wir bestätigen, dass alle Angaben wahrheitsgemäß sind, und teilen jede Änderung innerhalb von 14 Tagen in Textform mit. Wir stellen {ag} von Ansprüchen Dritter, Bußgeldern und Nachforderungen von Sozialversicherungsträgern, Finanzbehörden und Beschäftigten frei, die aus unrichtigen Angaben oder der Verletzung dieser Erklärung entstehen.',
  'Unrichtige Angaben berechtigen {ag} zur fristlosen Kündigung des Rahmenvertrages und zur Zurückbehaltung fälliger Zahlungen bis zur Klärung.',
];

export const MINDESTLOHN = [
  'Wir zahlen allen Beschäftigten, die wir für Aufträge von {ag} einsetzen, mindestens den gesetzlichen Mindestlohn (§ 1 MiLoG) und den jeweils geltenden tariflichen Mindestlohn der Gebäudereinigung nach dem Arbeitnehmer-Entsendegesetz. Der Lohn wird spätestens zum gesetzlichen Fälligkeitstag gezahlt (§ 2 MiLoG).',
  'Wir zeichnen Beginn, Ende und Dauer der täglichen Arbeitszeit spätestens bis zum Ablauf des siebten auf den Arbeitstag folgenden Kalendertages auf und bewahren die Aufzeichnungen mindestens zwei Jahre auf (§ 17 MiLoG).',
  'Wir führen Lohnsteuer und Sozialversicherungsbeiträge vollständig und fristgerecht ab (Krankenkassen, Minijob-Zentrale, Berufsgenossenschaft).',
  'Wir setzen ohne vorherige Zustimmung von {ag} keine eigenen Nachunternehmer ein. Mit Zustimmung verpflichten wir sie in Textform auf dieselben Pflichten und lassen uns diese Erklärung von ihnen geben.',
  'Wir gewähren {ag} auf Verlangen Einsicht in Lohnabrechnungen, Arbeitszeitaufzeichnungen und Personaleinsatzlisten; nicht erforderliche personenbezogene Daten dürfen geschwärzt werden.',
  'Uns ist bekannt, dass {ag} für die Zahlung des Mindestlohns an unsere Beschäftigten wie ein Bürge haftet (§ 13 MiLoG, § 14 AEntG) und für die Sozialversicherungsbeiträge (§ 28e Abs. 3a SGB IV). Wir stellen {ag} von solchen Ansprüchen frei.',
];

export const BEWERTUNG = [
  'Reinigungsqualität / Ausführung',
  'Termintreue / Pünktlichkeit',
  'Zuverlässigkeit des Personals',
  'Kommunikation / Erreichbarkeit',
  'Reaktionszeit bei Reklamationen',
  'Arbeitsschutz und Hygiene',
  'Leistungsnachweise / Dokumentation',
  'Abrechnung (richtig, pünktlich, mit Bestellnummer)',
  'Nachweise vollständig und aktuell (MiLoG, Unbedenklichkeit)',
  'Auftreten / Erscheinungsbild',
];

export const fillAg = (t: string, vars: Record<string, string>) =>
  t.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
