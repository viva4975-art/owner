import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { nextYearNumber } from './purchasing.js';
import { storeFile, type UploadConfig } from './uploads.js';

/**
 * Interner Buchungsbeleg zur Forderungskürzung (Ahmed 15.10.2026): Zahlt ein Kunde weniger und wird der Rest
 * ausgebucht, entsteht ein Beleg KB-JJJJ-NNNN als PDF (write-once, in der Kundenakte unter „Rechnungen & Belege“,
 * zusätzlich revisionssicher kopiert). Er geht nicht an den Kunden – es ist keine Rechnung und keine „Gutschrift“.
 */
export interface ReductionVoucher {
  id: string;
  number: string;
  invoice_id: string | null;
  legacy_invoice_id: string | null;
  customer_id: string;
  customer_name?: string;
  customer_no?: string;
  invoice_number: string;
  invoice_date: string | null;
  voucher_date: string;
  gross_cents: bigint;
  net_cents: bigint;
  vat_cents: bigint;
  reason: string;
  file_id: string | null;
  created_by: string;
}

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/** Beleg zu einer gebuchten Kürzung anlegen (idempotent über den Schlüssel der Buchung). */
export async function createReductionVoucher(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    key: string;
    invoiceId: string;
    legacy: boolean;
    grossCents: bigint;
    date: string;
    reason: string;
    actor: string;
  },
): Promise<ReductionVoucher> {
  const id = uuidFrom(`kuerzung:${p.key}`);
  const [exists] = await sql<ReductionVoucher[]>`select * from app.reduction_vouchers where id = ${id}`;
  if (exists) return exists;
  if (p.grossCents <= 0n) throw new BusinessError('Kürzungsbetrag fehlt');
  const [inv] = p.legacy
    ? await sql<
        {
          number: string;
          issue_date: string | null;
          customer_id: string | null;
          net: bigint;
          gross: bigint;
        }[]
      >`
        select number, issue_date::text, customer_id, net_cents as net, gross_cents as gross
          from app.legacy_invoices where id = ${p.invoiceId}`
    : await sql<
        {
          number: string;
          issue_date: string | null;
          customer_id: string | null;
          net: bigint;
          gross: bigint;
        }[]
      >`
        select number, issue_date::text, customer_id, net_cents as net, gross_cents as gross
          from app.invoices where id = ${p.invoiceId}`;
  if (!inv?.customer_id) throw new BusinessError('Rechnung für den Kürzungsbeleg nicht gefunden');
  // Nettoanteil im Verhältnis der Rechnung (kaufmännisch gerundet)
  const net = inv.gross === 0n ? p.grossCents : (p.grossCents * inv.net * 2n + inv.gross) / (inv.gross * 2n);
  const vat = p.grossCents - net;
  const [cust] = await sql<
    { name: string; customer_no: string; street: string; postal_code: string; city: string }[]
  >`
    select name, customer_no, street, postal_code, city from app.customers where id = ${inv.customer_id}`;
  const number = await sql.begin((tx) => nextYearNumber(tx, 'reduction', 'KB-', p.date.slice(0, 4), 4));

  const doc = await FormDoc.create({
    title: `Interner Buchungsbeleg ${number}`,
    sideRef: `Interner Beleg ${number}`,
    date: p.date,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
    plain: true,
  });
  doc.title('Interner Buchungsbeleg – Forderungskürzung', number);
  doc.infoGrid([
    ['Belegdatum', formatDateDe(p.date)],
    ['Belegnummer', number],
    ['Erfasst von', p.actor],
    ['Kunde', `${cust?.name ?? ''}`],
    ['Kundennummer', cust?.customer_no ?? ''],
    ['Anschrift', cust ? `${cust.street}, ${cust.postal_code} ${cust.city}` : ''],
    ['Rechnung', inv.number],
    ['Rechnungsdatum', inv.issue_date ? formatDateDe(inv.issue_date) : '–'],
    ['Rechnungsbetrag brutto', formatEuro(inv.gross as Cents)],
  ]);
  doc.kvBox([
    { k: 'Ausgebuchter Betrag brutto', v: formatEuro(p.grossCents as Cents), strong: true, accent: true },
    { k: 'davon netto', v: formatEuro(net as Cents) },
    { k: 'davon Umsatzsteuer', v: formatEuro(vat as Cents) },
  ]);
  doc.section('Grund der Kürzung');
  doc.para(p.reason);
  doc.section('Hinweis für die Buchhaltung');
  doc.para(
    'Der Kunde hat die Rechnung nicht vollständig bezahlt. Der Restbetrag wird intern als Forderungskürzung ausgebucht. ' +
      'Dieser Beleg ist ein interner Buchungsbeleg und wird dem Kunden nicht zugesandt; er ist weder Rechnung noch ' +
      'Rechnungskorrektur.',
    { size: 8.5 },
  );
  doc.para(
    'Umsatzsteuer: Die Bemessungsgrundlage mindert sich erst, wenn die Kürzung endgültig feststeht (§ 17 Abs. 1 UStG, ' +
      'bei Uneinbringlichkeit § 17 Abs. 2 UStG). Bitte durch den Steuerberater prüfen und buchen.',
    { size: 8.5 },
  );
  doc.signatures('Datum, erfasst', 'Datum, geprüft / freigegeben (Geschäftsführung)', {
    leftText: `${formatDateDe(p.date)}, ${p.actor}`,
  });
  const pdf = await doc.save();
  const fileId = uuidFrom(`kuerzung-datei:${p.key}`);
  await storeFile(
    sql,
    cfg,
    {
      id: fileId,
      name: `Kuerzungsbeleg_${number}_Rechnung_${inv.number}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link: { type: 'customer', id: inv.customer_id },
      category: 'Rechnungen & Belege',
    },
    p.actor,
  );
  const [row] = await sql<ReductionVoucher[]>`
    insert into app.reduction_vouchers (id, number, invoice_id, legacy_invoice_id, customer_id, invoice_number,
                                        invoice_date, voucher_date, gross_cents, net_cents, vat_cents, reason,
                                        file_id, created_by)
    values (${id}, ${number}, ${p.legacy ? null : p.invoiceId}, ${p.legacy ? p.invoiceId : null}, ${inv.customer_id},
            ${inv.number}, ${inv.issue_date}, ${p.date}, ${p.grossCents}, ${net}, ${vat}, ${p.reason.trim()},
            ${fileId}, ${p.actor})
    on conflict (id) do nothing
    returning *`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${p.actor}, 'reduction_voucher', ${p.legacy ? 'legacy_invoice' : 'invoice'}, ${p.invoiceId},
                    ${sql.json({ number, gross_cents: String(p.grossCents), file: fileId })})`;
  return row ?? (await sql<ReductionVoucher[]>`select * from app.reduction_vouchers where id = ${id}`)[0]!;
}

export async function listReductionVouchers(sql: Sql, f: { from?: string; to?: string } = {}) {
  return sql<ReductionVoucher[]>`
    select v.*, c.name as customer_name, c.customer_no
      from app.reduction_vouchers v join app.customers c on c.id = v.customer_id
     where ${f.from ? sql`v.voucher_date >= ${f.from}` : sql`true`}
       and ${f.to ? sql`v.voucher_date <= ${f.to}` : sql`true`}
     order by v.voucher_date desc, v.number desc`;
}
