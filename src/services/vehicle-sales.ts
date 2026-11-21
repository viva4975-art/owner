/**
 * Fahrzeugverkauf (Ahmed 27.10.): Punkte zum Ausfüllen → Kaufvertrag über ein gebrauchtes Kraftfahrzeug mit
 * Übergabeangaben und Rechnung (19 % USt oder steuerfrei mit Grund) als ein PDF im Stil „edel“.
 * Abschließen vergibt die Nummer FV-JJJJ-NNN, legt das PDF write-once am Fahrzeug ab (Kategorie „Verkauf“) und setzt
 * das Fahrzeug auf verkauft. Storno = eigene Nummer mit Verweis, Fahrzeug wieder im Bestand.
 */
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, divRoundHalfUp, formatEuro, parseEuro } from '../domain/money/money.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import { uuidFrom } from './photo-stamp.js';
import { storeFile, type UploadConfig } from './uploads.js';
import { FUEL, getVehicle, type Vehicle } from './vehicles.js';

export const TAX_MODES = {
  ust19: 'Umsatzsteuerpflichtig – 19 % USt (Inland)',
  ig: 'Steuerfrei – innergemeinschaftliche Lieferung an ein Unternehmen in einem anderen EU-Land',
  export: 'Steuerfrei – Ausfuhr in ein Land außerhalb der EU',
  frei28: 'Steuerfrei nach § 4 Nr. 28 UStG (nur bei ausschließlich steuerfreier Nutzung)',
} as const;
export type TaxMode = keyof typeof TAX_MODES;

/** Pflichthinweis auf der Rechnung bei steuerfreien Verkäufen (§ 14 Abs. 4 Nr. 8, § 14a Abs. 3 UStG) */
const TAX_NOTE: Record<TaxMode, string> = {
  ust19: '',
  ig: 'Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG).',
  export: 'Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG).',
  frei28: 'Steuerfreie Lieferung nach § 4 Nr. 28 UStG.',
};

export const DOCS = {
  zb1: 'Zulassungsbescheinigung Teil I (Fahrzeugschein)',
  zb2: 'Zulassungsbescheinigung Teil II (Fahrzeugbrief)',
  coc: 'COC-Papier / Übereinstimmungsbescheinigung',
  service: 'Serviceheft / Wartungsnachweise',
  hu: 'Letzter HU-Bericht',
  manual: 'Bordbuch / Bedienungsanleitung',
} as const;

export const WARRANTY = {
  ausgeschlossen: 'Gekauft wie gesehen – Gewährleistung ausgeschlossen (nur an Unternehmer)',
  einjahr: 'Gewährleistung auf 1 Jahr verkürzt (Privatkäufer, gesondert vereinbart)',
  gesetzlich: 'Gesetzliche Gewährleistung (2 Jahre)',
} as const;

export const PAYMENT = {
  bar: 'Barzahlung bei Übergabe',
  ueberweisung: 'Überweisung vor Übergabe',
} as const;

export const REGISTRATION = {
  abgemeldet: 'Fahrzeug wird abgemeldet übergeben',
  angemeldet: 'Fahrzeug wird zugelassen übergeben – Käufer meldet um',
} as const;

/** Export (Ausfuhr in ein Drittland, Ahmed 21.11.) */
export const EXPORT_TRANSPORT = {
  eigene_achse: 'Käufer fährt das Fahrzeug selbst aus (mit Ausfuhrkennzeichen)',
  abholung: 'Käufer bzw. sein Beauftragter holt ab und transportiert es (Anhänger, Transporter)',
  spedition: 'Spedition im Auftrag des Käufers holt ab',
  versand: 'Wir bringen bzw. versenden das Fahrzeug selbst ins Zielland',
} as const;

export const ID_TYPES = {
  pass: 'Reisepass',
  ausweis: 'Personalausweis / ID-Karte',
  aufenthalt: 'Aufenthaltstitel',
  sonstiges: 'sonstiges amtliches Dokument',
} as const;

export const DECLARANT = {
  wir: 'wir (Viva-Deluxe, mit unserer EORI-Nummer, z. B. über IAA+ beim Zoll)',
  zollagent: 'Zollagent / Spedition',
  kaeufer: 'Käufer bzw. sein Beauftragter',
} as const;

export const DEPOSIT = {
  ust: 'Kaution in Höhe der Umsatzsteuer (19 % des Kaufpreises) – empfohlen',
  betrag: 'Kaution mit anderem Betrag',
  keine: 'keine Kaution (Risiko: bei fehlendem Nachweis zahlen wir die USt)',
} as const;

export interface ExportInput {
  destCountry: string;
  birthDate: string | null;
  nationality: string | null;
  idType: keyof typeof ID_TYPES;
  idIssuer: string | null;
  idValidUntil: string | null;
  representative: string | null;
  residenceConfirmed: boolean;
  transport: keyof typeof EXPORT_TRANSPORT;
  agentName: string | null;
  agentId: string | null;
  exportPlate: string | null;
  exitOffice: string | null;
  deadlineDays: string;
  deposit: keyof typeof DEPOSIT;
  depositInput: string | null;
  declarant: keyof typeof DECLARANT;
  eori: string | null;
}

export interface ExportData extends ExportInput {
  deadline: string;
  depositCents: string;
}

export interface SaleInput {
  saleDate: string;
  handoverDate: string;
  handoverTime: string | null;
  buyerType: 'privat' | 'unternehmen';
  buyerName: string;
  buyerAddress: string;
  buyerCountry: string;
  buyerVatId: string | null;
  buyerId: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
  mileage: string;
  keys: string;
  docs: string[];
  accessories: string | null;
  accidentFree: 'ja' | 'nein' | 'unbekannt';
  damages: string | null;
  defects: string | null;
  priceInput: string;
  priceIs: 'brutto' | 'netto';
  taxMode: TaxMode;
  payment: keyof typeof PAYMENT;
  warranty: keyof typeof WARRANTY;
  registration: keyof typeof REGISTRATION;
  reregisterDays: string | null;
  note: string | null;
  export?: ExportInput | null;
}

export interface SaleData extends Omit<SaleInput, 'export'> {
  export?: ExportData | null;
  vehicle: {
    plate: string;
    make: string | null;
    model: string | null;
    vin: string | null;
    first_registration: string | null;
    fuel: string | null;
    hu_due: string | null;
  };
  mileageKm: number;
  keysN: number;
}

export interface SaleRow {
  id: string;
  sale_no: string;
  kind: 'verkauf' | 'storno';
  original_id: string | null;
  vehicle_id: string;
  sale_date: string;
  tax_mode: TaxMode;
  net_cents: bigint;
  vat_cents: bigint;
  gross_cents: bigint;
  buyer_name: string;
  data: SaleData;
  reason: string | null;
  file_id: string | null;
  created_by: string;
  created_at: Date;
}

export async function listVehicleSales(sql: Sql, vehicleId: string) {
  return sql<SaleRow[]>`
    select id, sale_no, kind, original_id, vehicle_id, sale_date::text as sale_date, tax_mode, net_cents, vat_cents,
           gross_cents, buyer_name, data, reason, file_id, created_by, created_at
      from app.vehicle_sales where vehicle_id = ${vehicleId} order by created_at`;
}

/** Laufender (nicht stornierter) Verkauf des Fahrzeugs */
export async function currentSale(sql: Sql, vehicleId: string) {
  const all = await listVehicleSales(sql, vehicleId);
  const cancelled = new Set(all.filter((s) => s.kind === 'storno').map((s) => s.original_id));
  return all.filter((s) => s.kind === 'verkauf' && !cancelled.has(s.id)).pop() ?? null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const EU = new Set(
  'AT BE BG CY CZ DK EE ES FI FR GR EL HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '),
);

/** Beträge: Brutto ↔ Netto bei 19 % (kaufmännisch gerundet, Cent-genau, USt = Brutto − Netto) */
export function saleAmounts(price: bigint, priceIs: 'brutto' | 'netto', mode: TaxMode) {
  if (mode !== 'ust19') return { net: price, vat: 0n, gross: price };
  if (priceIs === 'netto') {
    const vat = divRoundHalfUp(price * 19n, 100n);
    return { net: price, vat, gross: price + vat };
  }
  const net = divRoundHalfUp(price * 100n, 119n);
  return { net, vat: price - net, gross: price };
}

/** Eingaben prüfen und mit Fahrzeugdaten zum Schnappschuss machen */
export function checkSale(v: Vehicle, i: SaleInput, today = todayBerlin()) {
  if (!ISO.test(i.saleDate)) throw new BusinessError('Bitte das Verkaufsdatum angeben');
  if (i.saleDate > today) throw new BusinessError('Verkaufsdatum liegt in der Zukunft');
  if (!ISO.test(i.handoverDate)) throw new BusinessError('Bitte das Übergabedatum angeben');
  if (i.handoverDate < i.saleDate) throw new BusinessError('Übergabe liegt vor dem Verkaufsdatum');
  if (i.handoverTime && !/^\d{2}:\d{2}$/.test(i.handoverTime))
    throw new BusinessError('Uhrzeit der Übergabe bitte als HH:MM');
  if (v.purchase_date && i.saleDate < v.purchase_date)
    throw new BusinessError('Verkaufsdatum liegt vor dem Kaufdatum');
  if (!i.buyerName.trim()) throw new BusinessError('Bitte Name bzw. Firma des Käufers angeben');
  if (
    i.buyerAddress
      .trim()
      .split('\n')
      .filter((l) => l.trim()).length < 2
  )
    throw new BusinessError('Bitte die vollständige Anschrift des Käufers angeben (Straße, PLZ Ort)');
  if (!(i.taxMode in TAX_MODES)) throw new BusinessError('Steuer: Auswahl ungültig');
  if (!(i.payment in PAYMENT)) throw new BusinessError('Zahlungsart ungültig');
  if (!(i.warranty in WARRANTY)) throw new BusinessError('Gewährleistung: Auswahl ungültig');
  if (!(i.registration in REGISTRATION)) throw new BusinessError('Zulassung: Auswahl ungültig');
  const country = (i.buyerCountry || 'DE').trim().toUpperCase();
  const vatId = i.buyerVatId?.replace(/\s/g, '').toUpperCase() || null;
  if (i.taxMode === 'ig') {
    if (i.buyerType !== 'unternehmen')
      throw new BusinessError('Innergemeinschaftliche Lieferung nur an Unternehmen mit USt-IdNr.');
    if (!vatId || !/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(vatId) || vatId.startsWith('DE'))
      throw new BusinessError('Bitte die USt-IdNr. des Käufers aus dem anderen EU-Land angeben');
    if (!EU.has(country) || country === 'DE')
      throw new BusinessError(
        'Innergemeinschaftliche Lieferung: Land des Käufers muss ein anderes EU-Land sein',
      );
  }
  if (i.taxMode === 'export' && (EU.has(country) || country === 'DE'))
    throw new BusinessError('Ausfuhr: Land des Käufers muss außerhalb der EU liegen');
  if (i.taxMode === 'export' && !i.buyerId?.trim())
    throw new BusinessError('Ausfuhr: Bitte die Ausweis-/Pass-Nr. des Käufers angeben');
  if (i.taxMode === 'export' && i.registration !== 'abgemeldet')
    throw new BusinessError(
      'Ausfuhr: Das Fahrzeug wird abgemeldet übergeben (Zulassung „abgemeldet“ wählen)',
    );
  if (i.warranty === 'ausgeschlossen' && i.buyerType === 'privat')
    throw new BusinessError(
      'An Privatpersonen darf die Gewährleistung nicht ausgeschlossen werden (§ 476 BGB) – „auf 1 Jahr verkürzt“ oder „gesetzlich“ wählen',
    );
  const km = i.mileage.replace(/[.\s]/g, '');
  if (!/^\d{1,7}$/.test(km)) throw new BusinessError('Kilometerstand bei Übergabe bitte als ganze Zahl');
  const keys = i.keys.trim();
  if (!/^\d{1,2}$/.test(keys) || Number(keys) < 1) throw new BusinessError('Anzahl Schlüssel bitte angeben');
  if (i.registration === 'angemeldet') {
    const d = i.reregisterDays?.trim() ?? '';
    if (!/^\d{1,2}$/.test(d) || Number(d) < 1)
      throw new BusinessError('Bitte angeben, binnen wie vieler Tage der Käufer ummeldet');
  }
  if (i.accidentFree === 'nein' && !i.damages?.trim())
    throw new BusinessError('Bitte die bekannten Unfallschäden beschreiben');
  let price: bigint;
  try {
    let t = i.priceInput.replace(/[€\s]/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    price = parseEuro(t);
  } catch {
    throw new BusinessError('Kaufpreis ungültig');
  }
  if (price <= 0n) throw new BusinessError('Bitte den Kaufpreis angeben');
  const amounts = saleAmounts(price, i.priceIs, i.taxMode);
  const exp = i.taxMode === 'export' ? checkExport(i, country, price, i.handoverDate) : null;
  const { export: _ignored, ...rest } = i;
  void _ignored;
  const data: SaleData = {
    ...rest,
    export: exp,
    buyerCountry: country,
    buyerVatId: vatId,
    docs: i.docs.filter((d) => d in DOCS),
    vehicle: {
      plate: v.plate,
      make: v.make,
      model: v.model,
      vin: v.vin,
      first_registration: v.first_registration,
      fuel: v.fuel,
      hu_due: v.hu_due,
    },
    mileageKm: Number(km),
    keysN: Number(keys),
  };
  return { data, amounts };
}

function addDaysIso(d: string, n: number) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Angaben zur Ausfuhr prüfen (Abnehmer-, Ausfuhr- und Kautionsangaben) */
function checkExport(i: SaleInput, buyerCountry: string, price: bigint, handover: string): ExportData {
  const e = i.export;
  if (!e) throw new BusinessError('Ausfuhr: Bitte die Angaben zur Ausfuhr ausfüllen');
  const dest = (e.destCountry || buyerCountry).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(dest))
    throw new BusinessError('Ausfuhr: Zielland bitte als Länderkürzel (z. B. RS, UA, TR)');
  if (EU.has(dest) || dest === 'DE')
    throw new BusinessError(
      'Ausfuhr: Zielland muss außerhalb der EU liegen (sonst innergemeinschaftliche Lieferung)',
    );
  if (!(e.idType in ID_TYPES)) throw new BusinessError('Ausfuhr: Art des Ausweises wählen');
  if (!(e.transport in EXPORT_TRANSPORT)) throw new BusinessError('Ausfuhr: Art der Ausfuhr wählen');
  if (!(e.declarant in DECLARANT)) throw new BusinessError('Ausfuhr: Wer meldet beim Zoll an?');
  if (!(e.deposit in DEPOSIT)) throw new BusinessError('Ausfuhr: Kaution wählen');
  if (i.buyerType === 'privat') {
    if (!e.birthDate || !ISO.test(e.birthDate))
      throw new BusinessError('Ausfuhr: Geburtsdatum des Käufers angeben');
    if (!e.nationality?.trim()) throw new BusinessError('Ausfuhr: Staatsangehörigkeit des Käufers angeben');
  } else if (!e.representative?.trim())
    throw new BusinessError('Ausfuhr: Name der Person angeben, die für die Firma handelt (Vertreter)');
  if (e.transport !== 'versand' && !e.residenceConfirmed)
    throw new BusinessError(
      'Ausfuhr: Bestätigen, dass der Käufer seinen Wohnsitz bzw. Sitz außerhalb der EU hat (Pflicht, wenn der Käufer selbst abholt – § 6 Abs. 1 Nr. 2 UStG)',
    );
  if (e.idValidUntil && ISO.test(e.idValidUntil) && e.idValidUntil < handover)
    throw new BusinessError('Ausfuhr: Der Ausweis des Käufers ist am Übergabetag abgelaufen');
  if (e.agentName?.trim() && !e.agentId?.trim())
    throw new BusinessError('Ausfuhr: Ausweis-Nr. der abholenden Person angeben');
  const days = e.deadlineDays.trim();
  if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 180)
    throw new BusinessError('Ausfuhr: Frist für die Ausfuhr in Tagen (1–180)');
  let dep = 0n;
  if (e.deposit === 'ust') dep = divRoundHalfUp(price * 19n, 100n);
  else if (e.deposit === 'betrag') {
    try {
      let t = (e.depositInput ?? '').replace(/[€\s]/g, '');
      if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
      dep = parseEuro(t);
    } catch {
      throw new BusinessError('Ausfuhr: Kaution ungültig');
    }
    if (dep <= 0n) throw new BusinessError('Ausfuhr: Bitte den Betrag der Kaution angeben');
  }
  const eori = e.eori?.replace(/\s/g, '').toUpperCase() || null;
  if (eori && !/^[A-Z]{2}[0-9A-Z]{1,15}$/.test(eori))
    throw new BusinessError('EORI-Nummer ungültig (z. B. DE1234567)');
  return {
    ...e,
    destCountry: dest,
    eori,
    exportPlate: e.exportPlate?.trim().toUpperCase() || null,
    deadline: addDaysIso(handover, Number(days)),
    depositCents: String(dep),
  };
}

export interface ChecklistItem {
  text: string;
  who: 'Käufer' | 'wir' | 'Zoll';
  hint?: string | undefined;
}

/** Unterlagen und Schritte bei einer Ausfuhr – für Formular und Verkauf (Ahmed 21.11.) */
export function exportChecklist(d: {
  buyerType: 'privat' | 'unternehmen';
  payment: string;
  grossCents: bigint;
  export: ExportData | ExportInput | null;
}) {
  const e = d.export;
  const out: ChecklistItem[] = [];
  out.push({
    text: 'Gültigen Reisepass bzw. Personalausweis des Käufers vorlegen lassen, Kopie (Vorder- und Rückseite) zur Akte',
    who: 'Käufer',
    hint: 'Nummer, Ausstellungsland und Gültigkeit stehen dann im Vertrag',
  });
  out.push({
    text: 'Nachweis über den Wohnsitz außerhalb der EU (z. B. ausländischer Ausweis mit Anschrift, Meldebescheinigung des Heimatlandes)',
    who: 'Käufer',
    hint: 'Pflicht, wenn der Käufer selbst abholt („ausländischer Abnehmer“). Wer in Deutschland gemeldet ist, ist kein ausländischer Abnehmer.',
  });
  if (d.buyerType === 'unternehmen')
    out.push({
      text: 'Bei Firmen: Handelsregisterauszug bzw. Gewerbenachweis aus dem Heimatland, Vollmacht/Vertretungsnachweis und Ausweis der handelnden Person',
      who: 'Käufer',
    });
  if (e?.agentName?.trim())
    out.push({
      text: `Vollmacht des Käufers für ${e.agentName.trim()} (liegt im PDF bei, unterschreiben lassen) und Ausweiskopie der abholenden Person`,
      who: 'Käufer',
    });
  out.push({
    text: 'Abnehmer- und Ausfuhrerklärung (liegt im PDF bei) vom Käufer unterschreiben lassen',
    who: 'Käufer',
  });
  if (!e || e.transport === 'eigene_achse')
    out.push({
      text: 'Ausfuhrkennzeichen (Zollkennzeichen) bei der Zulassungsstelle: Zulassungsbescheinigung Teil I und II, Kaufvertrag, Pass des Käufers, eVB-Nummer einer Kfz-Versicherung für Ausfuhrkennzeichen; die HU muss für die Zulassungsdauer gültig sein',
      who: 'Käufer',
      hint: 'Fahrzeug vorher abmelden. Die Zulassungsstelle trägt den Käufer als Halter ein – Kopie der Zulassung (ZB I Ausfuhr) zur Akte.',
    });
  out.push({
    text:
      !e || e.declarant === 'wir'
        ? 'Ausfuhranmeldung beim Zoll im ATLAS-Verfahren (z. B. „Internetausfuhranmeldung Plus“, IAA+) mit unserer EORI-Nummer – MRN notieren und dem Käufer mitgeben'
        : 'Ausfuhranmeldung beim Zoll (ATLAS) durch Zollagent/Käufer – MRN und Kopie der Anmeldung geben lassen',
    who: e?.declarant === 'wir' || !e ? 'wir' : 'Käufer',
    hint:
      e?.declarant === 'wir' && !e.eori
        ? 'EORI-Nummer fehlt – beim Zoll beantragen (kostenlos, ca. 1–2 Wochen)'
        : undefined,
  });
  out.push({
    text: 'Fahrzeug bei der Ausgangszollstelle an der EU-Grenze vorführen lassen (bei Ausfuhr über ein anderes EU-Land dort)',
    who: 'Käufer',
  });
  out.push({
    text: 'Ausgangsvermerk (elektronischer Ausgangsvermerk aus ATLAS, PDF) bekommen und hier am Verkauf hochladen – das ist der Ausfuhrnachweis (§ 9 UStDV)',
    who: 'wir',
    hint: 'Ohne Ausgangsvermerk ist die Lieferung steuerpflichtig: wir müssten 19 % USt an das Finanzamt zahlen.',
  });
  if (e && e.deposit !== 'keine')
    out.push({
      text: 'Kaution bei Übergabe kassieren (Quittung im PDF) und nach Eingang des Ausgangsvermerks zurückzahlen',
      who: 'wir',
    });
  if (
    d.payment === 'bar' &&
    d.grossCents + BigInt(e && 'depositCents' in e ? e.depositCents : '0') >= 1_000_000n
  )
    out.push({
      text: 'Barzahlung ab 10.000 €: Käufer identifizieren (Ausweis prüfen, Kopie aufbewahren, 5 Jahre) – Geldwäschegesetz',
      who: 'wir',
      hint: 'Bei Auffälligkeiten (z. B. Herkunft des Geldes unklar) Verdachtsmeldung an die FIU.',
    });
  out.push({
    text: 'Zahlungsnachweis, Kaufvertrag, Rechnung, Ausweiskopie, Ausgangsvermerk 10 Jahre aufbewahren (Buchnachweis § 13 UStDV)',
    who: 'wir',
  });
  return out;
}

const de = (d: string | null) => (d ? formatDateDe(d) : '–');
const eur = (c: bigint) => formatEuro(c as Cents);

/** PDF: Kaufvertrag (mit Übergabe) + Rechnung bzw. Stornorechnung */
export async function renderSalePdf(
  sql: Sql,
  p: {
    no: string | null;
    data: SaleData;
    amounts: { net: bigint; vat: bigint; gross: bigint };
    storno?: { originalNo: string; originalDate: string; reason: string; date: string } | null;
  },
) {
  const seller = await getSeller(sql);
  const d0 = p.data;
  const v = d0.vehicle;
  const date = p.storno?.date ?? d0.saleDate;
  const no = p.no ?? 'FV-…';
  const doc = await FormDoc.create({
    title: `${p.storno ? 'Stornorechnung' : 'Kaufvertrag'} ${no} – ${v.plate}`,
    sideRef: `Fahrzeugverkauf ${no} · ${v.plate}`,
    date,
    author: seller.legalName,
    ...(p.no ? {} : { watermark: 'ENTWURF' }),
  });
  const sellerLines = [seller.legalName, seller.street, `${seller.postalCode} ${seller.city}`];
  const buyerLines = [
    d0.buyerName,
    ...d0.buyerAddress
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    ...(d0.buyerCountry !== 'DE' ? [d0.buyerCountry] : []),
  ];
  const vehicleName = [v.make, v.model].filter(Boolean).join(' ');
  const sign = p.storno ? -1n : 1n;
  const bank = seller.bankAccounts.find((b) => b.primary) ?? seller.bankAccounts[0];
  const ex = d0.taxMode === 'export' ? (d0.export ?? null) : null;
  const dep = ex ? BigInt(ex.depositCents) : 0n;
  let secNo = 5;
  const sec = (t: string) => doc.section(`§ ${++secNo} ${t}`);

  if (!p.storno) {
    doc.y += 4;
    doc.title('Kaufvertrag über ein gebrauchtes Kraftfahrzeug', no);
    doc.twoCols(
      { label: 'Verkäufer', lines: sellerLines },
      {
        label: `Käufer · ${d0.buyerType === 'unternehmen' ? 'Unternehmen' : 'Privatperson'}`,
        lines: [
          ...buyerLines,
          ...(d0.buyerVatId ? [`USt-IdNr. ${d0.buyerVatId}`] : []),
          ...(ex?.representative?.trim() ? [`vertreten durch ${ex.representative.trim()}`] : []),
          ...(ex?.birthDate
            ? [`geb. ${de(ex.birthDate)}${ex.nationality ? ` · ${ex.nationality}` : ''}`]
            : []),
          ...(d0.buyerId
            ? [
                `${ex ? ID_TYPES[ex.idType] : 'Ausweis'}-Nr. ${d0.buyerId}${ex?.idIssuer ? ` (${ex.idIssuer})` : ''}${
                  ex?.idValidUntil ? `, gültig bis ${de(ex.idValidUntil)}` : ''
                }`,
              ]
            : []),
          ...[d0.buyerPhone, d0.buyerEmail].filter((x): x is string => !!x),
        ],
      },
    );
    const sz = 8.8;
    const P = (t: string, o: { bold?: boolean; indent?: number } = {}) => doc.para(t, { size: sz, ...o });
    const gross = eur(p.amounts.gross);
    doc.section('§ 1 Kaufgegenstand');
    doc.kvBox([
      { k: 'Fahrzeug', v: vehicleName || '–', strong: true },
      { k: 'Kennzeichen', v: v.plate, k2: 'Erstzulassung', v2: de(v.first_registration) },
      {
        k: 'Fahrgestellnummer',
        v: v.vin ?? '–',
        k2: 'Kraftstoff',
        v2: v.fuel ? (FUEL[v.fuel] ?? v.fuel) : '–',
      },
      {
        k: 'km-Stand (Tacho)',
        v: `${d0.mileageKm.toLocaleString('de-DE')} km`,
        k2: 'Nächste HU',
        v2: v.hu_due ? v.hu_due.slice(5, 7) + '/' + v.hu_due.slice(0, 4) : '–',
      },
      { k: 'Schlüssel', v: `${d0.keysN} Stück` },
    ]);
    if (d0.accessories?.trim()) P(`Mitverkauftes Zubehör: ${d0.accessories.trim()}`);

    doc.section('§ 2 Kaufpreis und Zahlung');
    doc.kvBox([
      ...(p.amounts.vat > 0n
        ? [
            { k: 'Kaufpreis netto', v: eur(p.amounts.net) },
            { k: 'zzgl. 19 % USt', v: eur(p.amounts.vat) },
          ]
        : []),
      { k: p.amounts.vat > 0n ? 'Kaufpreis brutto' : 'Kaufpreis', v: gross, strong: true },
      { k: 'Zahlung', v: PAYMENT[d0.payment] },
    ]);
    if (TAX_NOTE[d0.taxMode]) P(TAX_NOTE[d0.taxMode], { bold: true });
    P(
      d0.payment === 'bar'
        ? `Der Kaufpreis von ${gross} wird bei Übergabe in bar gezahlt. Der Verkäufer bestätigt den Empfang mit seiner Unterschrift unter der Quittung am Ende dieses Vertrags.`
        : `Der Kaufpreis ist vor Übergabe auf das Konto des Verkäufers zu überweisen${
            bank ? ` (${bank.name} · IBAN ${bank.iban})` : ''
          }. Das Fahrzeug wird erst nach Zahlungseingang übergeben.`,
    );
    if (dep > 0n)
      P(
        `Zusätzlich zum Kaufpreis leistet der Käufer bei Übergabe eine Sicherheit (Kaution) von ${eur(dep)} für die Ausfuhr (§ 6 und Kautionsvereinbarung in der Anlage).`,
        { bold: true },
      );
    P(
      'Das Fahrzeug bleibt bis zur vollständigen Zahlung des Kaufpreises Eigentum des Verkäufers (Eigentumsvorbehalt). Nebenabreden bestehen nicht.',
    );

    doc.section('§ 3 Sachmängelhaftung (Gewährleistung)');
    if (d0.warranty === 'ausgeschlossen')
      P(
        'Das Fahrzeug wird verkauft wie besichtigt und probegefahren („gekauft wie gesehen“) – unter Ausschluss jeglicher Sachmängelhaftung (Gewährleistung).',
        { bold: true },
      );
    else if (d0.warranty === 'einjahr')
      P(
        'Ansprüche des Käufers wegen Sachmängeln verjähren abweichend vom Gesetz in einem Jahr ab Übergabe des Fahrzeugs. Der Käufer wurde vor Abgabe seiner Vertragserklärung eigens auf diese Verkürzung hingewiesen; sie wird ausdrücklich und gesondert vereinbart (§ 476 Abs. 2 BGB).',
        { bold: true },
      );
    else P('Es gelten die gesetzlichen Rechte des Käufers bei Sachmängeln.');
    if (d0.warranty !== 'gesetzlich')
      P(
        'Der Ausschluss bzw. die Verkürzung gilt nicht für Schadensersatzansprüche aus der Verletzung von Leben, Körper oder Gesundheit, für Schäden, die auf Vorsatz oder grober Fahrlässigkeit des Verkäufers beruhen, sowie für arglistig verschwiegene Mängel.',
      );
    P(
      'Keine Garantie: Der Verkäufer übernimmt keine Garantie (§ 443 BGB) – weder für die Beschaffenheit noch für die Haltbarkeit des Fahrzeugs. Die Angaben in § 4 sind Beschaffenheitsangaben nach bestem Wissen des Verkäufers, keine Garantie.',
    );
    if (d0.warranty === 'einjahr') {
      doc.y += 2;
      doc.signatures('Verkürzung gesondert vereinbart · Unterschrift Käufer', 'Verkäufer', {});
    }

    doc.section('§ 4 Erklärungen des Verkäufers');
    P('Der Verkäufer erklärt nach bestem Wissen:');
    P(
      '☒  Er ist Eigentümer des Fahrzeugs; das Fahrzeug ist frei von Rechten Dritter (z. B. Sicherungsübereignung).',
      { indent: 8 },
    );
    P(
      d0.accidentFree === 'ja'
        ? '☒  Das Fahrzeug hat – soweit dem Verkäufer bekannt – keine Unfallschäden.'
        : d0.accidentFree === 'nein'
          ? `☒  Das Fahrzeug hat folgende Unfallschäden: ${d0.damages ?? ''}`
          : '☒  Ob das Fahrzeug Unfallschäden hat, ist dem Verkäufer nicht bekannt.',
      { indent: 8 },
    );
    P(
      d0.defects?.trim()
        ? `☒  Bekannte Mängel / Schäden: ${d0.defects.trim()}`
        : '☒  Weitere Mängel sind dem Verkäufer nicht bekannt.',
      { indent: 8 },
    );
    P(
      `☒  Der km-Stand wurde bei Übergabe abgelesen (${d0.mileageKm.toLocaleString('de-DE')} km). Die Gesamtlaufleistung ist nur insoweit bekannt, als das Fahrzeug seit ${de(v.first_registration)} im Betrieb bzw. Besitz des Verkäufers ist.`,
      { indent: 8 },
    );
    P('☒  Das Fahrzeug wurde gewerblich genutzt (Reinigungsbetrieb).', { indent: 8 });

    doc.section('§ 5 Erklärungen des Käufers');
    P(
      'Der Käufer hatte Gelegenheit, das Fahrzeug zu besichtigen und Probe zu fahren, und hat es in diesem Zustand gekauft.',
    );
    P(
      d0.registration === 'abgemeldet'
        ? 'Das Fahrzeug ist abgemeldet. Der Käufer lässt es auf eigene Kosten zu.'
        : `Das Fahrzeug wird zugelassen übergeben. Der Käufer meldet es binnen ${d0.reregisterDays} Tagen auf sich um. Ab Übergabe trägt er Kosten, Steuer, Bußgelder und Schäden aus dem Betrieb und stellt den Verkäufer davon frei. Die Kfz-Haftpflichtversicherung geht nach § 95 VVG auf den Käufer über; beide zeigen den Verkauf dem Versicherer an (§ 97 VVG).`,
    );

    if (ex) {
      const tax19 = divRoundHalfUp(p.amounts.net * 19n, 100n);
      sec('Ausfuhr in ein Land außerhalb der EU');
      P(
        `(1) Der Käufer hat seinen ${d0.buyerType === 'unternehmen' ? 'Sitz' : 'Wohnsitz'} in ${countryName(d0.buyerCountry)} (außerhalb der Europäischen Union). Das Fahrzeug wird zur Ausfuhr nach ${countryName(ex.destCountry)} verkauft. Der Kaufpreis enthält deshalb keine Umsatzsteuer (steuerfreie Ausfuhrlieferung, § 4 Nr. 1 Buchst. a i. V. m. § 6 UStG).`,
      );
      P(
        `(2) Der Käufer verpflichtet sich, das Fahrzeug unverzüglich, spätestens bis ${de(ex.deadline)}, unmittelbar aus der Europäischen Union auszuführen. Bis dahin darf er es in der EU nur für die Fahrt zur Ausgangszollstelle nutzen und weder verkaufen noch überlassen. Art der Ausfuhr: ${EXPORT_TRANSPORT[ex.transport]}.`,
      );
      P(
        `(3) Die Ausfuhranmeldung beim Zoll (ATLAS) übernimmt: ${DECLARANT[ex.declarant].replace(/ \(.*\)$/, '')}. Der Käufer stellt das Fahrzeug bei der Ausgangszollstelle${
          ex.exitOffice ? ` (geplant: ${ex.exitOffice})` : ''
        } und sorgt dafür, dass dort der Ausgang bestätigt wird. Er übergibt dem Verkäufer unverzüglich den Ausgangsvermerk bzw. alle Unterlagen, die der Verkäufer als Ausfuhrnachweis (§ 9 UStDV) braucht.`,
      );
      if (ex.transport === 'eigene_achse')
        P(
          `(4) Das Fahrzeug wird abgemeldet übergeben. Ausfuhrkennzeichen und Versicherung beschafft der Käufer auf eigene Kosten und auf eigenen Namen${
            ex.exportPlate ? ` (Ausfuhrkennzeichen ${ex.exportPlate})` : ''
          }; ab Übergabe trägt er alle Kosten, Steuern, Bußgelder und Schäden aus dem Betrieb.`,
        );
      P(
        `(${ex.transport === 'eigene_achse' ? 5 : 4}) Liegt der Ausfuhrnachweis nicht bis ${de(addDaysIso(ex.deadline, 30))} vor oder sind die Angaben des Käufers unrichtig, gilt der Kaufpreis als Nettopreis: Der Käufer schuldet dann zusätzlich die gesetzliche Umsatzsteuer von 19 % (${eur(tax19)}) sowie den Ersatz weiterer Schäden des Verkäufers.${
          dep > 0n ? ' Der Verkäufer darf die Kaution damit verrechnen.' : ''
        }`,
        { bold: true },
      );
    }

    sec('Übergabe');
    P(
      `Übergabe am ${de(d0.handoverDate)}${d0.handoverTime ? ` um ${d0.handoverTime} Uhr` : ''} mit ${d0.keysN} Schlüssel${
        d0.keysN === 1 ? '' : 'n'
      } und folgenden Unterlagen:`,
    );
    for (const [k, l] of Object.entries(DOCS)) P(`${d0.docs.includes(k) ? '☒' : '☐'}  ${l}`, { indent: 10 });
    P('Mit der Übergabe gehen Gefahr, Nutzen und Lasten auf den Käufer über.');

    sec('Sonstiges');
    if (d0.note?.trim()) P(`Sonstige Vereinbarungen: ${d0.note.trim()}`);
    P(
      'Änderungen und Ergänzungen dieses Vertrags bedürfen der Textform. Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam.',
    );
    doc.y += 4;
    doc.signatures('Verkäufer · Unterschrift / Stempel', 'Käufer · Unterschrift', {
      leftText: `${seller.city}, den ${de(d0.saleDate)}`,
      rightText: 'Ort, Datum',
    });
    doc.section(d0.payment === 'bar' ? 'Übergabe und Quittung' : 'Übergabe bestätigt');
    P(`Käufer: Fahrzeug, ${d0.keysN} Schlüssel und die angekreuzten Unterlagen erhalten.`);
    if (d0.payment === 'bar')
      P(`Verkäufer: Kaufpreis von ${gross} in bar vollständig erhalten.`, { bold: true });
    doc.signatures(
      'Datum, Uhrzeit · Unterschrift Käufer',
      d0.payment === 'bar' ? 'Betrag erhalten · Unterschrift Verkäufer' : 'Verkäufer',
    );
    doc.newPage();
    if (ex) renderExportPages(doc, { no, d: d0, ex, dep, seller, vehicleName, buyerLines });
  }

  // ---------------------------------------------------------------- Rechnung / Stornorechnung
  doc.y += 4;
  doc.title(p.storno ? 'Stornorechnung' : 'Rechnung', no);
  doc.twoCols(
    { label: 'Rechnungsempfänger', lines: buyerLines },
    { label: 'Rechnungssteller', lines: sellerLines },
  );
  doc.infoGrid([
    ['Rechnungsnummer', no],
    ['Rechnungsdatum', de(date)],
    ['Liefertag (Übergabe)', de(d0.handoverDate)],
    ['Unsere USt-IdNr.', seller.vatId ?? '–'],
    ['Steuernummer', seller.taxNumber ?? '–'],
    ['USt-IdNr. Käufer', d0.buyerVatId ?? '–'],
  ]);
  if (p.storno)
    doc.para(
      `Storno zu Rechnung ${p.storno.originalNo} vom ${de(p.storno.originalDate)}. Grund: ${p.storno.reason}`,
      { size: 9, bold: true },
    );
  doc.table(
    [
      { label: 'Pos.', width: 34 },
      { label: 'Bezeichnung', width: 300 },
      { label: 'Menge', width: 50, align: 'right' },
      { label: 'Betrag netto', width: 111, align: 'right' },
    ],
    [
      [
        '1',
        `Gebrauchtfahrzeug${vehicleName ? ` ${vehicleName}` : ''}, Kennzeichen ${v.plate}${v.vin ? `, FIN ${v.vin}` : ''}${
          v.first_registration ? `, EZ ${de(v.first_registration)}` : ''
        }, km-Stand ${d0.mileageKm.toLocaleString('de-DE')}`,
        '1',
        eur(sign * p.amounts.net),
      ],
      { sum: ['', 'Summe netto', '', eur(sign * p.amounts.net)] },
      {
        sum: [
          '',
          d0.taxMode === 'ust19' ? 'Umsatzsteuer 19 %' : 'Umsatzsteuer 0 % (steuerfrei)',
          '',
          eur(sign * p.amounts.vat),
        ],
      },
      { sum: ['', 'Rechnungsbetrag', '', eur(sign * p.amounts.gross)], strong: true },
    ],
  );
  if (TAX_NOTE[d0.taxMode]) doc.para(TAX_NOTE[d0.taxMode], { bold: true });
  if (ex)
    doc.para(
      `Bestimmungsland: ${countryName(ex.destCountry)}. Ausfuhrnachweis: Ausgangsvermerk der Ausgangszollstelle (ATLAS).`,
    );
  if (!p.storno)
    doc.para(
      d0.payment === 'bar'
        ? 'Zahlung: in bar bei Übergabe.'
        : `Zahlung: per Überweisung vor Übergabe, Verwendungszweck ${no}.`,
    );
  else doc.para('Ein bereits gezahlter Kaufpreis wird erstattet.');
  return doc.save();
}

/** Verkauf abschließen: Nummer, PDF, Fahrzeug verkauft. Feste ID je Formular → doppelt absenden ändert nichts. */
export async function completeVehicleSale(
  sql: Sql,
  cfg: UploadConfig,
  p: { id: string; vehicleId: string; input: SaleInput },
  actor: string,
) {
  const [done] = await sql<SaleRow[]>`select * from app.vehicle_sales where id = ${p.id}`;
  if (done) return done;
  const v = await getVehicle(sql, p.vehicleId);
  if (!v) throw new BusinessError('Fahrzeug nicht gefunden');
  if (await currentSale(sql, v.id))
    throw new BusinessError('Das Fahrzeug ist schon verkauft – erst stornieren');
  if (v.ownership !== 'eigentum')
    throw new BusinessError(
      'Nur Fahrzeuge im Eigentum können verkauft werden (Leasing/Miete: an den Geber zurück)',
    );
  const { data, amounts } = checkSale(v, p.input);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('app.vehicle_sales'))`;
    const no = await nextNo(tx as unknown as Sql, data.saleDate);
    const pdf = await renderSalePdf(tx as unknown as Sql, { no, data, amounts });
    if (data.export?.eori)
      await tx`update app.company set eori_no = ${data.export.eori} where id = 1 and eori_no is distinct from ${data.export.eori}`;
    const fileId = uuidFrom(`${p.id}:fahrzeugverkauf-pdf`);
    await storeFile(
      sql,
      cfg,
      {
        id: fileId,
        name: `Fahrzeugverkauf_${no}_${v.plate.replace(/\s/g, '')}.pdf`,
        type: 'application/pdf',
        data: pdf,
        link: { type: 'vehicle', id: v.id },
        category: 'Verkauf',
      },
      actor,
    );
    const [row] = await tx<SaleRow[]>`
      insert into app.vehicle_sales (id, sale_no, vehicle_id, sale_date, tax_mode, net_cents, vat_cents, gross_cents,
                                     buyer_name, data, file_id, created_by)
      values (${p.id}, ${no}, ${v.id}, ${data.saleDate}, ${data.taxMode}, ${amounts.net}, ${amounts.vat},
              ${amounts.gross}, ${data.buyerName.trim()}, ${tx.json(data as never)}, ${fileId}, ${actor})
      returning *`;
    await tx`
      update app.vehicles set sold_on = ${data.saleDate}, sale_price_cents = ${amounts.gross},
             buyer = ${data.buyerName.trim()}, active = false, estimated_value_cents = null, estimated_on = null,
             version = version + 1
       where id = ${v.id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'vehicle_sale', 'vehicle', ${v.id}, ${tx.json({ sale_no: no, gross: String(amounts.gross) })})`;
    return row!;
  });
}

/** Verkauf stornieren: Stornorechnung mit eigener Nummer, Fahrzeug wieder im Bestand */
export async function cancelVehicleSale(
  sql: Sql,
  cfg: UploadConfig,
  p: { id: string; saleId: string; reason: string },
  actor: string,
) {
  const [done] = await sql<SaleRow[]>`select * from app.vehicle_sales where id = ${p.id}`;
  if (done) return done;
  const reason = p.reason.trim();
  if (!reason) throw new BusinessError('Bitte den Grund für das Storno angeben');
  const [orig] = await sql<SaleRow[]>`
    select id, sale_no, kind, vehicle_id, sale_date::text as sale_date, tax_mode, net_cents, vat_cents, gross_cents,
           buyer_name, data from app.vehicle_sales where id = ${p.saleId}`;
  if (!orig || orig.kind !== 'verkauf') throw new BusinessError('Verkauf nicht gefunden');
  const [already] = await sql`select 1 from app.vehicle_sales where original_id = ${orig.id}`;
  if (already) throw new BusinessError('Dieser Verkauf ist schon storniert');
  const date = todayBerlin();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('app.vehicle_sales'))`;
    const no = await nextNo(tx as unknown as Sql, date);
    const amounts = { net: orig.net_cents, vat: orig.vat_cents, gross: orig.gross_cents };
    const pdf = await renderSalePdf(tx as unknown as Sql, {
      no,
      data: orig.data,
      amounts,
      storno: { originalNo: orig.sale_no, originalDate: orig.sale_date, reason, date },
    });
    const fileId = uuidFrom(`${p.id}:fahrzeugverkauf-storno-pdf`);
    await storeFile(
      sql,
      cfg,
      {
        id: fileId,
        name: `Fahrzeugverkauf_Storno_${no}_${orig.data.vehicle.plate.replace(/\s/g, '')}.pdf`,
        type: 'application/pdf',
        data: pdf,
        link: { type: 'vehicle', id: orig.vehicle_id },
        category: 'Verkauf',
      },
      actor,
    );
    const [row] = await tx<SaleRow[]>`
      insert into app.vehicle_sales (id, sale_no, kind, original_id, vehicle_id, sale_date, tax_mode, net_cents,
                                     vat_cents, gross_cents, buyer_name, data, reason, file_id, created_by)
      values (${p.id}, ${no}, 'storno', ${orig.id}, ${orig.vehicle_id}, ${date}, ${orig.tax_mode},
              ${-orig.net_cents}, ${-orig.vat_cents}, ${-orig.gross_cents}, ${orig.buyer_name},
              ${tx.json(orig.data as never)}, ${reason}, ${fileId}, ${actor})
      returning *`;
    await tx`
      update app.vehicles set sold_on = null, sale_price_cents = null, buyer = null, active = true,
             version = version + 1
       where id = ${orig.vehicle_id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'vehicle_sale_cancel', 'vehicle', ${orig.vehicle_id},
                     ${tx.json({ sale_no: orig.sale_no, storno_no: no, reason })})`;
    return row!;
  });
}

async function nextNo(tx: Sql, date: string) {
  const year = date.slice(0, 4);
  const [{ n }] = (await tx`
    select coalesce(max(substring(sale_no from 9)::int), 0) + 1 as n from app.vehicle_sales
     where sale_no like ${`FV-${year}-%`}`) as unknown as [{ n: number }];
  return `FV-${year}-${String(n).padStart(3, '0')}`;
}

const COUNTRY: Record<string, string> = {
  AL: 'Albanien',
  BA: 'Bosnien und Herzegowina',
  BY: 'Belarus',
  CH: 'Schweiz',
  GB: 'Vereinigtes Königreich',
  GE: 'Georgien',
  IS: 'Island',
  LI: 'Liechtenstein',
  MD: 'Moldau',
  ME: 'Montenegro',
  MK: 'Nordmazedonien',
  NO: 'Norwegen',
  RS: 'Serbien',
  RU: 'Russland',
  TR: 'Türkei',
  UA: 'Ukraine',
  XK: 'Kosovo',
  AM: 'Armenien',
  AZ: 'Aserbaidschan',
  KZ: 'Kasachstan',
  MA: 'Marokko',
  TN: 'Tunesien',
  DZ: 'Algerien',
  EG: 'Ägypten',
  LB: 'Libanon',
  JO: 'Jordanien',
  SY: 'Syrien',
  IQ: 'Irak',
  IR: 'Iran',
  AE: 'Vereinigte Arabische Emirate',
  SA: 'Saudi-Arabien',
  NG: 'Nigeria',
  GH: 'Ghana',
  SN: 'Senegal',
  BJ: 'Benin',
  TG: 'Togo',
  CM: 'Kamerun',
  US: 'USA',
  CA: 'Kanada',
  AF: 'Afghanistan',
  PK: 'Pakistan',
  IN: 'Indien',
  DE: 'Deutschland',
};
export const countryName = (c: string) => (COUNTRY[c] ? `${COUNTRY[c]} (${c})` : c);

/** Anlagen beim Export: Abnehmer-/Ausfuhrerklärung, Kautionsvereinbarung + Quittung, Vollmacht */
function renderExportPages(
  doc: FormDoc,
  p: {
    no: string;
    d: SaleData;
    ex: ExportData;
    dep: bigint;
    seller: { legalName: string; city: string };
    vehicleName: string;
    buyerLines: string[];
  },
) {
  const { d, ex, dep, seller } = p;
  const v = d.vehicle;
  const sz = 8.8;
  const P = (t: string, o: { bold?: boolean; indent?: number } = {}) => doc.para(t, { size: sz, ...o });
  const vehicleRow = `${p.vehicleName || 'Fahrzeug'}, FIN ${v.vin ?? '–'}`;

  // Abnehmer- und Ausfuhrerklärung
  doc.y += 4;
  doc.title('Abnehmer- und Ausfuhrerklärung', `Anlage zu ${p.no}`);
  doc.kvBox([
    { k: 'Käufer', v: d.buyerName, strong: true },
    ...(ex.representative?.trim() ? [{ k: 'vertreten durch', v: ex.representative.trim() }] : []),
    ...(ex.birthDate
      ? [{ k: 'Geburtsdatum', v: de(ex.birthDate), k2: 'Staatsangeh.', v2: ex.nationality ?? '–' }]
      : []),
    { k: 'Wohnsitz / Sitz', v: p.buyerLines.slice(1).join(', ') },
    {
      k: ID_TYPES[ex.idType],
      v: `${d.buyerId ?? '–'}${ex.idIssuer ? ` · ${ex.idIssuer}` : ''}`,
      k2: 'gültig bis',
      v2: de(ex.idValidUntil),
    },
    { k: 'Fahrzeug', v: vehicleRow, k2: 'Kennz. bisher', v2: v.plate },
    { k: 'Zielland', v: countryName(ex.destCountry), k2: 'Ausfuhr bis', v2: de(ex.deadline) },
    {
      k: 'Ausfuhrkennzeichen',
      v: ex.exportPlate ?? '______________________',
      k2: 'Ausgangszollst.',
      v2: ex.exitOffice ?? '–',
    },
  ]);
  P('Ich erkläre / Wir erklären gegenüber dem Verkäufer:');
  const items = [
    `Mein / unser ${d.buyerType === 'unternehmen' ? 'Sitz' : 'Wohnsitz'} liegt außerhalb der Europäischen Union; ich habe / wir haben keinen Wohnsitz bzw. keine Niederlassung in Deutschland oder einem anderen EU-Land.`,
    `Das Fahrzeug wird nach ${countryName(ex.destCountry)} ausgeführt und bis ${de(ex.deadline)} unmittelbar aus der EU verbracht (${EXPORT_TRANSPORT[ex.transport]}).`,
    'Bis zur Ausfuhr wird das Fahrzeug in der EU nicht genutzt (außer für die Fahrt zur Ausgangszollstelle), nicht weiterverkauft und keinem Dritten überlassen.',
    'Ich lasse den Ausgang bei der Ausgangszollstelle bestätigen und übergebe dem Verkäufer unverzüglich den Ausgangsvermerk bzw. die Ausfuhrpapiere.',
    'Meine Angaben sind richtig und vollständig. Mir ist bekannt, dass ich bei unrichtigen Angaben oder fehlender Ausfuhr die gesetzliche Umsatzsteuer (19 %) und weitere Schäden des Verkäufers trage.',
  ];
  items.forEach((t, i) => P(`${i + 1}.  ${t}`, { indent: 8 }));
  doc.y += 2;
  doc.signatures('Verkäufer', 'Ort, Datum · Unterschrift Käufer', {
    leftText: `${seller.city}, den ${de(d.handoverDate)}`,
    rightText: ' ',
    mark: 'right',
  });

  if (dep > 0n || ex.agentName?.trim()) {
    doc.newPage();
    doc.y += 4;
  }
  if (dep > 0n) {
    doc.section('Kautionsvereinbarung');
    P(
      `Der Käufer übergibt dem Verkäufer bei Übergabe des Fahrzeugs eine Kaution von ${eur(dep)} als Sicherheit für die Ausfuhr (Kaufvertrag ${p.no}, § 6). Sie wird nicht verzinst.`,
    );
    P(
      `Der Verkäufer zahlt die Kaution binnen 10 Tagen zurück, nachdem ihm der Ausgangsvermerk der Ausgangszollstelle vorliegt, und zwar auf folgendes Konto des Käufers:`,
    );
    P(
      'Kontoinhaber: ________________________________   IBAN: ____________________________________   BIC: ______________',
      {
        indent: 8,
      },
    );
    P(
      `Liegt der Ausfuhrnachweis nicht bis ${de(addDaysIso(ex.deadline, 30))} vor, verrechnet der Verkäufer die Kaution mit der dann geschuldeten Umsatzsteuer und weiteren Schäden; ein Rest wird zurückgezahlt.`,
    );
    doc.signatures('Kaution erhalten · Verkäufer', 'Käufer', {
      leftText: `${seller.city}, den ${de(d.handoverDate)} · ${eur(dep)}`,
      rightText: ' ',
      mark: 'right',
    });
  }

  if (ex.agentName?.trim()) {
    doc.section('Vollmacht zur Abholung');
    P(
      `Ich / Wir, ${d.buyerName}, bevollmächtige(n) ${ex.agentName.trim()} (Ausweis-Nr. ${ex.agentId ?? '–'}), das oben genannte Fahrzeug mit Schlüsseln und Unterlagen beim Verkäufer in Empfang zu nehmen, die Übergabe zu bestätigen${
        dep > 0n ? ', die Kaution zu leisten' : ''
      } und das Fahrzeug zur Ausfuhr zu bringen. Eine Kopie des Ausweises der bevollmächtigten Person ist beigefügt.`,
    );
    doc.signatures('Ort, Datum · Unterschrift Käufer (Vollmachtgeber)', 'Unterschrift Bevollmächtigte/r', {
      mark: 'left',
    });
  }
  doc.newPage();
}

// ---------------------------------------------------------------- Ausfuhrnachweis und Kaution
export interface ExportEvent {
  id: string;
  sale_id: string;
  kind: 'nachweis' | 'kaution_zurueck' | 'kaution_verrechnet';
  event_date: string;
  mrn: string | null;
  note: string | null;
  file_id: string | null;
  created_by: string;
  created_at: Date;
}

export async function listExportEvents(sql: Sql, saleId: string) {
  return sql<ExportEvent[]>`
    select id, sale_id, kind, event_date::text as event_date, mrn, note, file_id, created_by, created_at
      from app.vehicle_export_events where sale_id = ${saleId} order by created_at`;
}

/** Ausgangsvermerk bzw. Kautionsabschluss festhalten (nur anhängen, feste ID je Formular) */
export async function recordExportEvent(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    id: string;
    saleId: string;
    kind: ExportEvent['kind'];
    date: string;
    mrn: string | null;
    note: string | null;
    file: { name: string; type: string; data: Uint8Array } | null;
  },
  actor: string,
) {
  const [done] = await sql<ExportEvent[]>`select * from app.vehicle_export_events where id = ${p.id}`;
  if (done) return done;
  const [sale] = await sql<SaleRow[]>`
    select id, sale_no, kind, vehicle_id, tax_mode from app.vehicle_sales where id = ${p.saleId}`;
  if (!sale || sale.kind !== 'verkauf' || sale.tax_mode !== 'export')
    throw new BusinessError('Ausfuhr-Verkauf nicht gefunden');
  const [storno] = await sql`select 1 from app.vehicle_sales where original_id = ${sale.id}`;
  if (storno) throw new BusinessError('Der Verkauf ist storniert');
  if (!ISO.test(p.date)) throw new BusinessError('Bitte das Datum angeben');
  if (p.date > todayBerlin()) throw new BusinessError('Datum liegt in der Zukunft');
  const events = await listExportEvents(sql, sale.id);
  const mrn = p.mrn?.replace(/\s/g, '').toUpperCase() || null;
  if (p.kind === 'nachweis') {
    if (events.some((e) => e.kind === 'nachweis'))
      throw new BusinessError('Ausfuhrnachweis ist schon erfasst');
    if (!p.file) throw new BusinessError('Bitte den Ausgangsvermerk (PDF oder Foto) hochladen');
    if (mrn && !/^\d{2}[A-Z]{2}[0-9A-Z]{14}$/.test(mrn))
      throw new BusinessError('MRN bitte wie auf dem Ausgangsvermerk (18 Zeichen, z. B. 26DE…)');
  } else {
    if (events.some((e) => e.kind !== 'nachweis'))
      throw new BusinessError('Die Kaution ist schon abgeschlossen');
    if (p.kind === 'kaution_verrechnet' && !p.note?.trim())
      throw new BusinessError('Bitte den Grund für die Verrechnung angeben');
  }
  let fileId: string | null = null;
  if (p.file) {
    fileId = uuidFrom(`${p.id}:ausfuhr-datei`);
    await storeFile(
      sql,
      cfg,
      {
        id: fileId,
        name: `Ausgangsvermerk_${sale.sale_no}_${p.file.name}`,
        type: p.file.type || 'application/octet-stream',
        data: p.file.data,
        link: { type: 'vehicle', id: sale.vehicle_id },
        category: 'Verkauf',
      },
      actor,
    );
  }
  const [row] = await sql<ExportEvent[]>`
    insert into app.vehicle_export_events (id, sale_id, kind, event_date, mrn, note, file_id, created_by)
    values (${p.id}, ${sale.id}, ${p.kind}, ${p.date}, ${mrn}, ${p.note?.trim() || null}, ${fileId}, ${actor})
    on conflict (id) do nothing returning *`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, ${`vehicle_export_${p.kind}`}, 'vehicle', ${sale.vehicle_id},
                    ${sql.json({ sale_no: sale.sale_no, mrn, date: p.date })})`;
  return row!;
}

/** Offene Ausfuhren (Nachweis fehlt bzw. Kaution offen) – für Erinnerungen */
export async function openExports(sql: Sql) {
  const rows = await sql<
    {
      id: string;
      sale_no: string;
      vehicle_id: string;
      data: SaleData;
      has_proof: boolean;
      deposit_done: boolean;
    }[]
  >`
    select s.id, s.sale_no, s.vehicle_id, s.data,
           exists (select 1 from app.vehicle_export_events e where e.sale_id = s.id and e.kind = 'nachweis') as has_proof,
           exists (select 1 from app.vehicle_export_events e where e.sale_id = s.id and e.kind <> 'nachweis') as deposit_done
      from app.vehicle_sales s
     where s.kind = 'verkauf' and s.tax_mode = 'export'
       and not exists (select 1 from app.vehicle_sales x where x.original_id = s.id)`;
  return rows.filter(
    (r) => !r.has_proof || (!r.deposit_done && BigInt(r.data.export?.depositCents ?? '0') > 0n),
  );
}
