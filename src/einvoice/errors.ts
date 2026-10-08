/*
 * Verständliche Meldung, wenn die E-Rechnungs-Bibliothek das Datenmodell ablehnt („validation failed“).
 * Ahmed 08.10.: Meldung ohne Hinweis, was fehlt. Die Bibliothek liefert die fehlerhaften Felder als JSON-Pfade.
 */

const FIELDS: [RegExp, string][] = [
  [
    /AccountingCustomerParty\/cac:Party#cbc:EndpointID/,
    'Rechnungs-E-Mail bzw. Leitweg-ID des Kunden (Kunde → Rechnungsgruppen)',
  ],
  [
    /AccountingCustomerParty.*Country/,
    'Land der Rechnungsanschrift (Kunde) – bitte 2-stelligen Ländercode, z. B. DE',
  ],
  [
    /AccountingSupplierParty.*Country/,
    'Land in den Firmendaten (Einstellungen → Firma) – 2-stelliger Ländercode, z. B. DE',
  ],
  [/AccountingCustomerParty.*PostalZone/, 'PLZ der Rechnungsanschrift'],
  [/AccountingCustomerParty.*CityName/, 'Ort der Rechnungsanschrift'],
  [/AccountingCustomerParty.*StreetName/, 'Straße der Rechnungsanschrift'],
  [/AccountingCustomerParty.*RegistrationName|AccountingCustomerParty.*PartyName/, 'Name des Kunden'],
  [/AccountingCustomerParty.*ElectronicMail/, 'E-Mail-Adresse des Kunden'],
  [/AccountingCustomerParty.*CompanyID/, 'USt-IdNr. des Kunden'],
  [/AccountingSupplierParty/, 'Firmendaten (Einstellungen → Firma)'],
  [/InvoicedQuantity@unitCode/, 'Einheit einer Position'],
  [/InvoiceLine\/(\d+)\/.*Name/, 'Bezeichnung einer Position'],
  [/InvoiceLine/, 'eine Position'],
  [/PaymentMeans|PayeeFinancialAccount/, 'Bankverbindung in den Firmendaten'],
  [/DueDate/, 'Fälligkeitsdatum'],
  [/IssueDate/, 'Rechnungsdatum'],
  [/InvoicePeriod/, 'Leistungszeitraum'],
  [/BuyerReference/, 'Leitweg-ID / Käuferreferenz'],
  [/OrderReference/, 'Bestellnummer'],
];

export function describeEInvoiceError(err: unknown): string {
  const e = err as {
    message?: string;
    errors?: { instancePath?: string; message?: string; params?: { missingProperty?: string } }[];
  };
  const list = Array.isArray(e?.errors) ? e.errors : [];
  if (!list.length) return e?.message ?? String(err);
  const out = new Set<string>();
  for (const x of list) {
    const p = `${x.instancePath ?? ''}${x.params?.missingProperty ? `#${x.params.missingProperty}` : ''}`;
    const pos = /InvoiceLine\/(\d+)/.exec(p);
    const hit = FIELDS.find(([re]) => re.test(p));
    const label = hit ? hit[1] : p.replace(/^\/ubl:Invoice\//, '');
    out.add(`${label}${pos ? ` (Position ${Number(pos[1]) + 1})` : ''}`);
  }
  return `Folgende Angaben fehlen oder sind ungültig: ${[...out].join('; ')}`;
}

/** Ländercode für die E-Rechnung: „de“, „Deutschland“, leer → „DE“. */
export function countryCodeOf(v: string | null | undefined): string {
  const t = (v ?? '').trim();
  if (!t || /^(de|deu|deutschland|germany|brd)$/i.test(t)) return 'DE';
  if (/^(at|österreich|oesterreich|austria)$/i.test(t)) return 'AT';
  if (/^(ch|schweiz|switzerland)$/i.test(t)) return 'CH';
  return t.length === 2 ? t.toUpperCase() : t;
}

/** Einheit für die E-Rechnung (UN/ECE Rec. 20): bekannte Texte → Code. */
export function unitCodeOf(v: string | null | undefined): string {
  const t = (v ?? '').trim();
  const map: Record<string, string> = {
    '': 'C62',
    stk: 'C62',
    'stk.': 'C62',
    stück: 'C62',
    std: 'HUR',
    'std.': 'HUR',
    stunde: 'HUR',
    stunden: 'HUR',
    'm²': 'MTK',
    m2: 'MTK',
    qm: 'MTK',
    pauschal: 'LS',
    psch: 'LS',
    'psch.': 'LS',
    lfm: 'MTR',
    m: 'MTR',
    tag: 'DAY',
    tage: 'DAY',
    monat: 'MON',
  };
  return map[t.toLowerCase()] ?? t;
}
