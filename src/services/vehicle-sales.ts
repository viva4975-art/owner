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
}

export interface SaleData extends SaleInput {
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
  const data: SaleData = {
    ...i,
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
          ...(d0.buyerId ? [`Ausweis-Nr. ${d0.buyerId}`] : []),
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

    doc.section('§ 6 Übergabe');
    P(
      `Übergabe am ${de(d0.handoverDate)}${d0.handoverTime ? ` um ${d0.handoverTime} Uhr` : ''} mit ${d0.keysN} Schlüssel${
        d0.keysN === 1 ? '' : 'n'
      } und folgenden Unterlagen:`,
    );
    for (const [k, l] of Object.entries(DOCS)) P(`${d0.docs.includes(k) ? '☒' : '☐'}  ${l}`, { indent: 10 });
    P('Mit der Übergabe gehen Gefahr, Nutzen und Lasten auf den Käufer über.');

    doc.section('§ 7 Sonstiges');
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
