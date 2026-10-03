import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import {
  type Cents,
  type Quantity,
  divRoundHalfUp,
  formatEuro,
  lineNet,
  toXmlDecimal,
} from '../domain/money/money.js';
import { renderLetterPdf } from '../pdf/render.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Einkauf: Bestellungen (BE-JJJJ-NNNN), Rechnungseingang mit Freigabe, SEPA-Zahlungslauf (pain.001.001.09).
 *
 * - Eingangsrechnungen sind je Lieferant + Rechnungsnummer eindeutig → nichts doppelt bezahlen.
 * - Bezahlen nur nach Freigabe; jede Rechnung höchstens einmal in einem Zahlungslauf (DB-Index).
 * - § 13b UStG: Leistungen von Nachunternehmern (Gebäudereinigung an Gebäudereiniger) → Rechnung ohne USt,
 *   wir schulden die Umsatzsteuer und ziehen sie als Vorsteuer ab. Kennzeichen „reverse_charge“.
 */

export type PoStatus = 'entwurf' | 'bestellt' | 'geliefert' | 'storniert';
export const PO_STATUS: Record<PoStatus, string> = {
  entwurf: 'Entwurf',
  bestellt: 'bestellt',
  geliefert: 'geliefert',
  storniert: 'storniert',
};

export type IncomingStatus = 'erfasst' | 'freigegeben' | 'bezahlt' | 'abgelehnt';
export const INCOMING_STATUS: Record<IncomingStatus, string> = {
  erfasst: 'zu prüfen',
  freigegeben: 'freigegeben',
  bezahlt: 'bezahlt',
  abgelehnt: 'abgelehnt',
};
export type CostCategory = 'material' | 'nachunternehmer' | 'geraete' | 'fahrzeuge' | 'miete' | 'sonstiges';
export const COST_CATEGORY: Record<CostCategory, string> = {
  material: 'Material / Reinigungsmittel',
  nachunternehmer: 'Nachunternehmer',
  geraete: 'Geräte / Wartung',
  fahrzeuge: 'Fahrzeuge',
  miete: 'Miete / Büro',
  sonstiges: 'Sonstiges',
};

const eur = (c: bigint) => formatEuro(c as Cents);

/** Fortlaufende Nummer je Jahr, z. B. BE-2026-0001 (Zeilensperre, lückenlos). */
export async function nextYearNumber(
  tx: Tx,
  base: string,
  prefix: string,
  year: string,
  width: number,
): Promise<string> {
  const key = `${base}-${year}`;
  await tx`insert into app.number_ranges (key, prefix, next_value) values (${key}, ${`${prefix}${year}-`}, 1) on conflict (key) do nothing`;
  const [n] = await tx<{ v: bigint; prefix: string }[]>`
    update app.number_ranges set next_value = next_value + 1, updated_at = now() where key = ${key}
    returning next_value - 1 as v, prefix`;
  return `${n!.prefix}${String(n!.v).padStart(width, '0')}`;
}

// ---------------------------------------------------------------------------
// Bestellungen
// ---------------------------------------------------------------------------

export interface PurchaseOrder {
  id: string;
  number: string;
  supplier_id: string;
  site_id: string | null;
  order_date: string;
  delivery_date: string | null;
  status: PoStatus;
  note: string | null;
  net_cents: bigint;
  created_by: string;
  created_at: Date;
  ordered_at: Date | null;
  received_at: Date | null;
  version: number;
}
export interface PoLine {
  id: string;
  position: number;
  article_id: string | null;
  description: string;
  quantity_milli: bigint;
  unit: string;
  unit_price_cents: bigint;
  net_cents: bigint;
}

export async function listOrders(sql: Sql, f: { status?: PoStatus[]; supplierId?: string } = {}) {
  return sql<(PurchaseOrder & { supplier_name: string; site_name: string | null; lines: number })[]>`
    select o.*, s.name as supplier_name, st.name as site_name,
           (select count(*)::int from app.purchase_order_lines l where l.order_id = o.id) as lines
      from app.purchase_orders o join app.suppliers s on s.id = o.supplier_id left join app.sites st on st.id = o.site_id
     where ${f.status?.length ? sql`o.status in ${sql(f.status)}` : sql`true`}
       and ${f.supplierId ? sql`o.supplier_id = ${f.supplierId}` : sql`true`}
     order by o.created_at desc`;
}

export async function getOrder(sql: Sql | Tx, id: string) {
  const [o] = await sql<PurchaseOrder[]>`select * from app.purchase_orders where id = ${id}`;
  if (!o) return undefined;
  const lines = await sql<
    PoLine[]
  >`select * from app.purchase_order_lines where order_id = ${id} order by position`;
  return { order: o, lines };
}

export interface PoInput {
  supplierId: string;
  siteId: string | null;
  orderDate: string;
  deliveryDate: string | null;
  note: string | null;
  lines: {
    articleId: string | null;
    description: string;
    quantity: Quantity;
    unit: string;
    unitPrice: Cents;
  }[];
  expectedVersion: number | null;
}

export async function saveOrder(sql: Sql, id: string, input: PoInput, actor: string) {
  if (!input.lines.length) throw new BusinessError('Bitte mindestens eine Position erfassen');
  if (input.lines.some((l) => l.quantity <= 0n)) throw new BusinessError('Mengen müssen größer 0 sein');
  const net = input.lines.reduce((s, l) => s + lineNet(l.quantity, l.unitPrice), 0n);
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number; status: PoStatus }[]
    >`select version, status from app.purchase_orders where id = ${id} for update`;
    if (cur && input.expectedVersion !== null && cur.version !== input.expectedVersion) {
      throw new BusinessError('Die Bestellung wurde zwischenzeitlich geändert – bitte neu laden.');
    }
    if (cur && cur.status !== 'entwurf') throw new BusinessError('Nur Entwürfe können geändert werden');
    const row = {
      supplier_id: input.supplierId,
      site_id: input.siteId,
      order_date: input.orderDate,
      delivery_date: input.deliveryDate,
      note: input.note,
      net_cents: net,
    };
    if (cur) await tx`update app.purchase_orders set ${tx(row)} where id = ${id}`;
    else {
      const number = await nextYearNumber(tx, 'po', 'BE-', input.orderDate.slice(0, 4), 4);
      await tx`insert into app.purchase_orders ${tx({ id, number, created_by: actor, ...row })}`;
    }
    await tx`delete from app.purchase_order_lines where order_id = ${id}`;
    await tx`insert into app.purchase_order_lines ${tx(
      input.lines.map((l, i) => ({
        order_id: id,
        position: i + 1,
        article_id: l.articleId,
        description: l.description,
        quantity_milli: l.quantity,
        unit: l.unit,
        unit_price_cents: l.unitPrice,
        net_cents: lineNet(l.quantity, l.unitPrice),
      })),
    )}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'purchase_order', ${id})`;
  });
}

export async function setOrderStatus(sql: Sql, id: string, status: 'bestellt' | 'storniert', actor: string) {
  const [o] = await sql<{ status: PoStatus }[]>`select status from app.purchase_orders where id = ${id}`;
  if (!o) throw new BusinessError('Bestellung nicht gefunden');
  if (o.status === status) return;
  const ok =
    (o.status === 'entwurf' && (status === 'bestellt' || status === 'storniert')) ||
    (o.status === 'bestellt' && status === 'storniert');
  if (!ok) throw new BusinessError(`„${PO_STATUS[o.status]}“ kann nicht zu „${PO_STATUS[status]}“ werden`);
  await sql`update app.purchase_orders set status = ${status}, ordered_at = ${status === 'bestellt' ? sql`now()` : sql`ordered_at`} where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details) values (${actor}, 'status', 'purchase_order', ${id}, ${sql.json({ status })})`;
}

/** Wareneingang: Positionen mit Artikel werden als Zugang ins Lager gebucht (feste IDs → nur einmal). */
export async function receiveOrder(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [o] = await tx<{ status: PoStatus; number: string; site_id: string | null }[]>`
      select status, number, site_id from app.purchase_orders where id = ${id} for update`;
    if (!o) throw new BusinessError('Bestellung nicht gefunden');
    if (o.status === 'geliefert') return;
    if (o.status !== 'bestellt') throw new BusinessError('Wareneingang nur für bestellte Ware');
    const lines = await tx<
      PoLine[]
    >`select * from app.purchase_order_lines where order_id = ${id} and article_id is not null`;
    for (const l of lines) {
      const [{ mid }] = (await tx`select md5(${'po-receive:' + l.id})::uuid as mid`) as unknown as [
        { mid: string },
      ];
      await tx`insert into app.stock_movements (id, article_id, delta_milli, reason, site_id, created_by)
               values (${mid}, ${l.article_id}, ${l.quantity_milli}, ${`Wareneingang ${o.number}`}, null, ${actor})
               on conflict (id) do nothing`;
      await tx`update app.articles set stock_milli = stock_milli + ${l.quantity_milli}, updated_at = now() where id = ${l.article_id}`;
      // Einkaufspreis aktuell halten
      await tx`update app.articles set purchase_price_cents = ${l.unit_price_cents} where id = ${l.article_id}`;
    }
    await tx`update app.purchase_orders set status = 'geliefert', received_at = now() where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'receive', 'purchase_order', ${id})`;
  });
}

/** Bestellung als PDF auf dem Briefpapier. */
export async function renderOrderPdf(sql: Sql, id: string) {
  const data = await getOrder(sql, id);
  if (!data) throw new BusinessError('Bestellung nicht gefunden');
  const { order: o, lines } = data;
  const seller = await getSeller(sql);
  const [s] = await sql<
    {
      name: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      supplier_no: string;
      contact_name: string | null;
    }[]
  >`
    select name, street, postal_code, city, supplier_no, contact_name from app.suppliers where id = ${o.supplier_id}`;
  const [site] = o.site_id
    ? await sql<{ name: string; street: string | null; postal_code: string | null; city: string | null }[]>`
        select name, street, postal_code, city from app.sites where id = ${o.site_id}`
    : [];
  const qty = (m: bigint) => (Number(m) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });
  const pdf = await renderLetterPdf({
    title: `Bestellung ${o.number}`,
    date: o.order_date,
    info: [
      ['Datum', formatDateDe(o.order_date)],
      ['Lieferanten-Nr.', s!.supplier_no],
      ...(o.delivery_date ? ([['Liefertermin', formatDateDe(o.delivery_date)]] as [string, string][]) : []),
    ],
    seller,
    buyer: {
      customerNo: s!.supplier_no,
      name: s!.name,
      name2: null,
      street: s!.street ?? '',
      postalCode: s!.postal_code ?? '',
      city: s!.city ?? '',
      countryCode: 'DE',
      contactName: s!.contact_name,
      email: null,
      leitwegId: null,
      supplierNo: null,
      vatId: null,
      site: null,
    } as never,
    intro: 'hiermit bestellen wir zu den vereinbarten Konditionen:',
    columns: [
      { label: 'Pos', x: 62.3, align: 'left' },
      { label: 'Artikel', x: 85, align: 'left' },
      { label: 'Menge', x: 390 },
      { label: 'Einzelpreis', x: 465 },
      { label: 'Gesamt', x: 538.8 },
    ],
    rows: lines.map((l) => [
      String(l.position),
      l.description.slice(0, 48),
      `${qty(l.quantity_milli)} ${l.unit}`,
      eur(l.unit_price_cents),
      eur(l.net_cents),
    ]),
    sums: [],
    total: ['Summe netto', eur(o.net_cents)],
    paragraphs: [
      site
        ? `Lieferadresse: ${site.name}, ${[site.street, `${site.postal_code ?? ''} ${site.city ?? ''}`.trim()].filter(Boolean).join(', ')}.`
        : `Lieferadresse: ${seller.legalName}, ${seller.street}, ${seller.postalCode} ${seller.city}.`,
      ...(o.note ? [o.note] : []),
      `Bitte geben Sie auf Lieferschein und Rechnung unsere Bestellnummer ${o.number} an.`,
      'Mit freundlichen Grüßen\nViva-Deluxe Gebäudereinigung GmbH',
    ],
    girocode: null,
    ...(o.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  return { pdf, filename: `Bestellung_${o.number}.pdf` };
}

// ---------------------------------------------------------------------------
// Rechnungseingang
// ---------------------------------------------------------------------------

export interface IncomingInvoice {
  id: string;
  supplier_id: string;
  invoice_no: string;
  invoice_date: string;
  due_date: string;
  service_month: string | null;
  net_cents: bigint;
  vat_cents: bigint;
  gross_cents: bigint;
  reverse_charge: boolean;
  category: CostCategory;
  site_id: string | null;
  purchase_order_id: string | null;
  skonto_until: string | null;
  skonto_percent_bp: number | null;
  status: IncomingStatus;
  note: string | null;
  created_by: string;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  paid_at: string | null;
  version: number;
}
export type IncomingRow = IncomingInvoice & {
  supplier_name: string;
  supplier_no: string;
  supplier_kind: string;
  iban: string | null;
  site_name: string | null;
  po_number: string | null;
  file_count: number;
};

export async function listIncoming(
  sql: Sql,
  f: { status?: IncomingStatus[]; supplierId?: string; siteId?: string } = {},
) {
  return sql<IncomingRow[]>`
    select i.*, s.name as supplier_name, s.supplier_no, s.kind as supplier_kind, s.iban, st.name as site_name, o.number as po_number,
           (select count(*)::int from app.file_links l join app.files f on f.id = l.file_id
             where l.entity_type = 'incoming_invoice' and l.entity_id = i.id and f.status = 'complete') as file_count
      from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
      left join app.sites st on st.id = i.site_id left join app.purchase_orders o on o.id = i.purchase_order_id
     where ${f.status?.length ? sql`i.status in ${sql(f.status)}` : sql`true`}
       and ${f.supplierId ? sql`i.supplier_id = ${f.supplierId}` : sql`true`}
       and ${f.siteId ? sql`i.site_id = ${f.siteId}` : sql`true`}
     order by i.due_date, i.invoice_date desc`;
}

export async function getIncoming(sql: Sql, id: string) {
  const [i] = await sql<IncomingRow[]>`
    select i.*, s.name as supplier_name, s.supplier_no, s.kind as supplier_kind, s.iban, st.name as site_name, o.number as po_number, 0 as file_count
      from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
      left join app.sites st on st.id = i.site_id left join app.purchase_orders o on o.id = i.purchase_order_id
     where i.id = ${id}`;
  return i;
}

export interface IncomingInput {
  supplierId: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  serviceMonth: string | null; // 'YYYY-MM'
  net: Cents;
  vat: Cents;
  reverseCharge: boolean;
  category: CostCategory;
  siteId: string | null;
  purchaseOrderId: string | null;
  skontoUntil: string | null;
  skontoPercentBp: number | null;
  note: string | null;
  expectedVersion: number | null;
}

export async function saveIncoming(sql: Sql, id: string, input: IncomingInput, actor: string) {
  if (!input.invoiceNo.trim()) throw new BusinessError('Rechnungsnummer des Lieferanten fehlt');
  if (input.net === 0n) throw new BusinessError('Nettobetrag fehlt');
  if (input.reverseCharge && input.vat !== 0n)
    throw new BusinessError('§ 13b: Rechnung enthält keine Umsatzsteuer – USt-Betrag muss 0 sein');
  if (!input.reverseCharge && input.vat !== 0n) {
    // Plausibilität: 19 % oder 7 % (auch gemischt) – Cent-Rundung zulassen
    const r = Number(input.vat) / Number(input.net);
    if (r < 0.065 || r > 0.195)
      throw new BusinessError('USt passt weder zu 7 % noch zu 19 % – bitte Beträge prüfen');
  }
  if ((input.skontoUntil === null) !== (input.skontoPercentBp === null))
    throw new BusinessError('Skonto: Datum und Prozent zusammen angeben');
  const [sup] = await sql<
    { payment_terms_days: number }[]
  >`select payment_terms_days from app.suppliers where id = ${input.supplierId}`;
  if (!sup) throw new BusinessError('Bitte Lieferant wählen');
  const due =
    input.dueDate ??
    (() => {
      const d = new Date(`${input.invoiceDate}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + sup.payment_terms_days);
      return d.toISOString().slice(0, 10);
    })();
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number; status: IncomingStatus }[]
    >`select version, status from app.incoming_invoices where id = ${id} for update`;
    if (cur && input.expectedVersion !== null && cur.version !== input.expectedVersion) {
      throw new BusinessError('Die Rechnung wurde zwischenzeitlich geändert – bitte neu laden.');
    }
    if (cur && cur.status !== 'erfasst')
      throw new BusinessError('Freigegebene Rechnungen können nicht mehr geändert werden');
    const [dup] = await tx<{ id: string }[]>`
      select id from app.incoming_invoices where supplier_id = ${input.supplierId} and invoice_no = ${input.invoiceNo.trim()} and id <> ${id}`;
    if (dup) throw new BusinessError(`Rechnung ${input.invoiceNo} dieses Lieferanten ist schon erfasst`);
    const row = {
      supplier_id: input.supplierId,
      invoice_no: input.invoiceNo.trim(),
      invoice_date: input.invoiceDate,
      due_date: due,
      service_month: input.serviceMonth ? `${input.serviceMonth}-01` : `${input.invoiceDate.slice(0, 7)}-01`,
      net_cents: input.net,
      vat_cents: input.vat,
      gross_cents: input.net + input.vat,
      reverse_charge: input.reverseCharge,
      category: input.category,
      site_id: input.siteId,
      purchase_order_id: input.purchaseOrderId,
      skonto_until: input.skontoUntil,
      skonto_percent_bp: input.skontoPercentBp,
      note: input.note,
    };
    if (cur)
      await tx`update app.incoming_invoices set ${tx(row as Record<string, unknown>)} where id = ${id}`;
    else
      await tx`insert into app.incoming_invoices ${tx({ id, created_by: actor, ...row } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'incoming_invoice', ${id})`;
  });
}

export async function decideIncoming(
  sql: Sql,
  id: string,
  status: 'freigegeben' | 'abgelehnt' | 'erfasst',
  actor: string,
) {
  const [i] = await sql<
    { status: IncomingStatus }[]
  >`select status from app.incoming_invoices where id = ${id}`;
  if (!i) throw new BusinessError('Rechnung nicht gefunden');
  if (i.status === status) return;
  const ok =
    (i.status === 'erfasst' && (status === 'freigegeben' || status === 'abgelehnt')) ||
    ((i.status === 'freigegeben' || i.status === 'abgelehnt') && status === 'erfasst');
  if (!ok)
    throw new BusinessError(
      `„${INCOMING_STATUS[i.status]}“ kann nicht zu „${INCOMING_STATUS[status]}“ werden`,
    );
  await sql`update app.incoming_invoices set status = ${status},
              approved_by = ${status === 'freigegeben' ? actor : null}, approved_at = ${status === 'freigegeben' ? sql`now()` : null}
             where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details) values (${actor}, 'status', 'incoming_invoice', ${id}, ${sql.json({ status })})`;
}

/** Skonto, wenn bis zum Ausführungstag gezahlt wird (auf den Bruttobetrag). */
export function skontoFor(
  i: Pick<IncomingInvoice, 'gross_cents' | 'skonto_until' | 'skonto_percent_bp'>,
  executionDate: string,
): bigint {
  if (!i.skonto_until || !i.skonto_percent_bp || executionDate > i.skonto_until) return 0n;
  return divRoundHalfUp(i.gross_cents * BigInt(i.skonto_percent_bp), 10000n);
}

// ---------------------------------------------------------------------------
// SEPA-Zahlungslauf
// ---------------------------------------------------------------------------

/** SEPA-Zeichensatz (DK): Umlaute umschreiben, Unzulässiges ersetzen. */
export function sepaText(s: string, max: number): string {
  const map: Record<string, string> = {
    ä: 'ae',
    ö: 'oe',
    ü: 'ue',
    Ä: 'Ae',
    Ö: 'Oe',
    Ü: 'Ue',
    ß: 'ss',
    '&': '+',
    '–': '-',
    '„': '',
    '“': '',
    '"': '',
  };
  return s
    .replace(/[äöüÄÖÜß&–„“"]/g, (c) => map[c] ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function validIbanFormat(iban: string): boolean {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const d of r) mod = (mod * 10 + Number(d)) % 97;
  return mod === 1;
}

export interface PaymentRunItem {
  invoice: IncomingRow;
  amount: bigint;
  skonto: bigint;
}

export function buildPain001(p: {
  messageId: string;
  createdAt: Date;
  executionDate: string;
  debtorName: string;
  debtorIban: string;
  debtorBic: string;
  items: {
    endToEnd: string;
    amount: bigint;
    name: string;
    iban: string;
    bic: string | null;
    remittance: string;
  }[];
}): string {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const total = p.items.reduce((s, i) => s + i.amount, 0n);
  const amt = (c: bigint) => toXmlDecimal(c as Cents);
  const tx = p.items
    .map(
      (i) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${x(i.endToEnd)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${amt(i.amount)}</InstdAmt></Amt>${
          i.bic ? `\n        <CdtrAgt><FinInstnId><BICFI>${x(i.bic)}</BICFI></FinInstnId></CdtrAgt>` : ''
        }
        <Cdtr><Nm>${x(sepaText(i.name, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${x(i.iban)}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${x(sepaText(i.remittance, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`,
    )
    .join('\n');
  const created = p.createdAt.toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${x(p.messageId)}</MsgId>
      <CreDtTm>${created}</CreDtTm>
      <NbOfTxs>${p.items.length}</NbOfTxs>
      <CtrlSum>${amt(total)}</CtrlSum>
      <InitgPty><Nm>${x(sepaText(p.debtorName, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${x(p.messageId)}-1</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${p.items.length}</NbOfTxs>
      <CtrlSum>${amt(total)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt><Dt>${p.executionDate}</Dt></ReqdExctnDt>
      <Dbtr><Nm>${x(sepaText(p.debtorName, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${x(p.debtorIban)}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BICFI>${x(p.debtorBic)}</BICFI></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

/** Vorschau: freigegebene, unbezahlte Rechnungen mit Zahlbetrag (Skonto) zum Ausführungstag. */
export async function paymentProposal(sql: Sql, executionDate: string) {
  const list = await listIncoming(sql, { status: ['freigegeben'] });
  return list.map((i) => {
    const skonto = skontoFor(i, executionDate);
    return { invoice: i, skonto, amount: i.gross_cents - skonto };
  });
}

/**
 * Zahlungslauf anlegen: SEPA-Datei erzeugen, unveränderbar archivieren, Rechnungen als bezahlt markieren.
 * Feste ID → doppelter Klick erzeugt keinen zweiten Lauf; jede Rechnung nur einmal (Unique-Index).
 */
export async function createPaymentRun(
  deps: Deps,
  p: { id: string; invoiceIds: string[]; executionDate: string; debtorIban: string; actor: string },
) {
  const { sql } = deps;
  const [exists] = await sql`select 1 from app.payment_runs where id = ${p.id}`;
  if (exists) return p.id;
  if (!p.invoiceIds.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
  if (p.executionDate < todayBerlin()) throw new BusinessError('Ausführungstag liegt in der Vergangenheit');
  const seller = await getSeller(sql);
  const acct = seller.bankAccounts.find((b) => b.iban.replace(/\s/g, '') === p.debtorIban.replace(/\s/g, ''));
  if (!acct) throw new BusinessError('Auftraggeberkonto unbekannt');
  const proposal = (await paymentProposal(sql, p.executionDate)).filter((x) =>
    p.invoiceIds.includes(x.invoice.id),
  );
  if (proposal.length !== new Set(p.invoiceIds).size)
    throw new BusinessError('Mindestens eine Rechnung ist nicht (mehr) freigegeben – bitte neu laden');
  const missing = proposal.filter((x) => !x.invoice.iban || !validIbanFormat(x.invoice.iban));
  if (missing.length) {
    throw new BusinessError(
      `Keine gültige IBAN hinterlegt: ${missing.map((m) => m.invoice.supplier_name).join(', ')}`,
    );
  }
  const negative = proposal.filter((x) => x.amount <= 0n);
  if (negative.length)
    throw new BusinessError('Rechnungskorrekturen/Gutschriften des Lieferanten bitte manuell verrechnen');
  const ibanOf = await sql<
    { id: string; bic: string | null }[]
  >`select id, bic from app.suppliers where id in ${sql(proposal.map((x) => x.invoice.supplier_id))}`;
  const year = p.executionDate.slice(0, 4);
  const xmlPath = `zahlungslaeufe/${year}/${p.id}.xml`;
  let runNumber = '';
  await sql.begin(async (tx) => {
    runNumber = await nextYearNumber(tx, 'payment_run', 'ZL-', year, 3);
    const messageId = `VD-${runNumber}-${p.id.slice(0, 8)}`.slice(0, 35);
    const total = proposal.reduce((s, x) => s + x.amount, 0n);
    await tx`
      insert into app.payment_runs (id, number, execution_date, debtor_iban, debtor_bic, total_cents, item_count, message_id, created_by)
      values (${p.id}, ${runNumber}, ${p.executionDate}, ${acct.iban.replace(/\s/g, '')}, ${acct.bic}, ${total}, ${proposal.length}, ${messageId}, ${p.actor})`;
    for (const x of proposal) {
      const lock = await tx`update app.incoming_invoices set status = 'bezahlt', paid_at = ${p.executionDate}
                              where id = ${x.invoice.id} and status = 'freigegeben' returning id`;
      if (!lock.length)
        throw new BusinessError(`Rechnung ${x.invoice.invoice_no} wurde zwischenzeitlich geändert`);
      await tx`insert into app.payment_run_items (run_id, incoming_invoice_id, amount_cents, skonto_cents, creditor_name, creditor_iban, creditor_bic, remittance)
               values (${p.id}, ${x.invoice.id}, ${x.amount}, ${x.skonto}, ${x.invoice.supplier_name}, ${x.invoice.iban!.replace(/\s/g, '').toUpperCase()},
                       ${ibanOf.find((s) => s.id === x.invoice.supplier_id)?.bic ?? null},
                       ${`Rechnung ${x.invoice.invoice_no} vom ${formatDateDe(x.invoice.invoice_date)}${x.skonto > 0n ? ` abzgl. Skonto ${eur(x.skonto)}` : ''}`})`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'create', 'payment_run', ${p.id}, ${tx.json({ number: runNumber, items: proposal.length, total: String(total) })})`;
  });
  const xml = await paymentRunXml(sql, p.id);
  const { sha256 } = await deps.archive.put(xmlPath, new TextEncoder().encode(xml));
  await sql`update app.payment_runs set xml_path = ${xmlPath}, xml_sha256 = ${sha256} where id = ${p.id} and xml_path is null`;
  return p.id;
}

export async function paymentRunXml(sql: Sql, id: string): Promise<string> {
  const [run] = await sql<
    {
      message_id: string;
      created_at: Date;
      execution_date: string;
      debtor_iban: string;
      debtor_bic: string;
    }[]
  >`
    select message_id, created_at, execution_date, debtor_iban, debtor_bic from app.payment_runs where id = ${id}`;
  if (!run) throw new BusinessError('Zahlungslauf nicht gefunden');
  const items = await sql<
    {
      incoming_invoice_id: string;
      amount_cents: bigint;
      creditor_name: string;
      creditor_iban: string;
      creditor_bic: string | null;
      remittance: string;
    }[]
  >`
    select * from app.payment_run_items where run_id = ${id} order by creditor_name`;
  const seller = await getSeller(sql);
  return buildPain001({
    messageId: run.message_id,
    createdAt: run.created_at,
    executionDate: run.execution_date,
    debtorName: seller.legalName,
    debtorIban: run.debtor_iban,
    debtorBic: run.debtor_bic,
    items: items.map((i) => ({
      endToEnd: i.incoming_invoice_id.replace(/-/g, '').slice(0, 35),
      amount: i.amount_cents,
      name: i.creditor_name,
      iban: i.creditor_iban,
      bic: i.creditor_bic,
      remittance: i.remittance,
    })),
  });
}

export async function listPaymentRuns(sql: Sql) {
  return sql<
    {
      id: string;
      number: string;
      execution_date: string;
      total_cents: bigint;
      item_count: number;
      created_by: string;
      created_at: Date;
      debtor_iban: string;
      xml_sha256: string | null;
    }[]
  >`
    select id, number, execution_date, total_cents, item_count, created_by, created_at, debtor_iban, xml_sha256
      from app.payment_runs order by created_at desc`;
}

export async function paymentRunItems(sql: Sql, id: string) {
  return sql<
    {
      incoming_invoice_id: string;
      amount_cents: bigint;
      skonto_cents: bigint;
      creditor_name: string;
      creditor_iban: string;
      remittance: string;
    }[]
  >`
    select * from app.payment_run_items where run_id = ${id} order by creditor_name`;
}

export const newId = () => randomUUID();
