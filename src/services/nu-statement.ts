import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { composeMail, loadSignature } from '../mail/compose.js';
import { MAILER_MISSING, resolveRecipients } from '../mail/mailer.js';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { formatEuro, type Cents } from '../domain/money/money.js';
import { FormDoc } from '../pdf/form-doc.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { invoiceOffsets, offsetAdvance } from './advances.js';
import { BusinessError } from './errors.js';
import { billingTracking, isRecurringOrder, skipExpected } from './expected-invoices.js';
import { getSupplier } from './inventory.js';
import { getSeller } from './masterdata.js';
import { decideIncoming, getIncoming, nextYearNumber, saveIncoming } from './purchasing.js';
import { countDays, orderClosures, workDaysLabel } from './subcontract-days.js';
import { hoursByMonth } from './subcontract-hours.js';
import {
  sammelMonthCost,
  sammelSqmCenti,
  sammelSummaries,
  sammelTotals,
  siteRevenueMonth,
  splitByWeights,
} from './subcontract-sites.js';
import { attnLine, BILLING, FREQUENCY } from './subcontractors.js';
import { filePath, storeFile } from './uploads.js';
import type { Deps } from './workflow.js';

/*
 * NU-Abrechnung je Monat (Ahmed 15.11.: „Bestellungen und Zahlungsliste zu kompliziert“): Je Nachunternehmer und Monat
 * ein Blatt mit allem, was laut Bestellungen anfällt – alle Abrechnungsarten wie bisher (Pauschale je Monat/Einsatz,
 * je m² inkl. Sammelbestellung mit Fläche/Betrag je Objekt, je Tag mit Arbeitstagen und Schließzeiten, je Stunde aus
 * dem Stundennachweis, Anteil am Umsatz) plus Regie. Daraus entweder die Rechnung des Nachunternehmers erfassen
 * (Beträge je Bestellung → Kostenstellen automatisch) oder – wenn vereinbart – eine Gutschrift erstellen
 * (§ 14 Abs. 2 S. 2 UStG). Ersetzt „Rechnung erwartet“ nicht, nutzt aber dieselbe Erkennung (abgerechnet/keine Rechnung).
 */

export type LineState = 'offen' | 'abgerechnet' | 'keine';
export interface StatementLine {
  /** `${subcontractId}|grund` bzw. `|regie` */
  key: string;
  subcontractId: string;
  number: string;
  /** Objekt bzw. „Sammelbestellung (n Objekte): …“ */
  where: string;
  /** Objekt wie auf unserer Rechnung: „Name (Nr.)“ und Adresse; Sammelbestellung: Objektliste als Adresse */
  objTitle: string;
  objAddress: string | null;
  serviceKind: string;
  billing: string;
  frequency: string;
  kind: 'grund' | 'regie';
  /** Rechenweg, z. B. „17 Tage (Mo–Fr) × 100,00 €“ */
  calc: string;
  /** null = ohne Menge nicht bestimmbar (Anteil am Umsatz ohne Erlös) */
  amount: bigint | null;
  state: LineState;
  invoices: { id: string; invoice_no: string }[];
  skipReason: string | null;
}
export interface Statement {
  supplierId: string;
  supplierName: string;
  supplierNo: string;
  selfBilling: boolean;
  lines: StatementLine[];
  /** Summe der offenen Zeilen */
  openTotal: bigint;
  billedTotal: bigint;
}

const euro = (c: bigint) => formatEuro(c as Cents);
const STEP_MONTHS: Record<string, number> = {
  einmalig: 0,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};
const MON = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const lastDay = (m: string) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const hrs = (min: number) => (min / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 });

interface OrderRow {
  id: string;
  number: string;
  supplier_id: string;
  supplier_name: string;
  supplier_no: string;
  self_billing_since: string | null;
  site_id: string;
  site_no: string;
  site_name: string;
  site_address: string | null;
  service_kind: string;
  frequency: string;
  billing: string;
  price_cents: bigint;
  max_hours_month: string | null;
  margin_bp: number | null;
  work_days: number[] | null;
  regie_rate_cents: bigint | null;
  valid_from: string;
  valid_to: string | null;
  month_price: bigint;
}

/** Abrechnungsblätter eines Monats (alle Nachunternehmer oder einer). */
export async function nuStatements(
  sql: Sql,
  month: string,
  opts: { supplierId?: string } = {},
): Promise<Statement[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Monat ungültig');
  const from = `${month}-01`;
  const to = lastDay(month);
  const orders = await sql<OrderRow[]>`
    select sc.id, sc.number, sc.supplier_id, sp.name as supplier_name, sp.supplier_no,
           sp.self_billing_since::text, sc.site_id, s.site_no, s.name as site_name,
           nullif(concat_ws(', ', s.street, nullif(concat_ws(' ', s.postal_code, s.city), '')), '') as site_address,
           sc.service_kind, sc.frequency,
           sc.billing, sc.price_cents, sc.max_hours_month::text, sc.margin_bp, sc.work_days, sc.regie_rate_cents,
           sc.valid_from::text, sc.valid_to::text,
           coalesce((select p.price_cents from app.subcontract_prices p
                      where p.subcontract_id = sc.id and p.valid_from_month <= ${from}::date
                      order by p.valid_from_month desc limit 1), sc.price_cents) as month_price
      from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id
      join app.sites s on s.id = sc.site_id
     where sc.status in ('erteilt', 'beendet') and sc.valid_from <= ${to}::date
       and (sc.valid_to is null or sc.valid_to >= ${from}::date)
       and ${opts.supplierId ? sql`sc.supplier_id = ${opts.supplierId}` : sql`true`}
     order by sp.name, sc.number`;
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const [hours, closures, sqm, totals, summaries, tracking] = await Promise.all([
    hoursByMonth(sql, ids),
    orderClosures(
      sql,
      orders.filter((o) => o.billing === 'tag').map((o) => o.id),
    ),
    sammelSqmCenti(sql, ids),
    sammelTotals(
      sql,
      orders.map((o) => ({ id: o.id, billing: o.billing, current_price_cents: BigInt(o.month_price) })),
    ),
    sammelSummaries(sql, ids),
    billingTracking(sql, ids, { today: to, limit: 600 }),
  ]);
  const endedSites = await sql<{ id: string; valid_to: string }[]>`
    select subcontract_id as id, valid_to::text from app.subcontract_sites
     where subcontract_id = any(${ids}::uuid[]) and valid_to is not null`;
  const byId = new Map<string, Statement>();
  for (const o of orders) {
    const price = BigInt(o.month_price);
    const rec = isRecurringOrder(o.frequency);
    const endMonth = (o.valid_to ?? o.valid_from).slice(0, 7);
    const sum = summaries.get(o.id);
    const where = sum ? `Sammelbestellung (${sum.n} Objekte): ${sum.text}` : `${o.site_no} ${o.site_name}`;
    const h = hours.filter((x) => x.id === o.id && x.month === month);
    const normal = h.find((x) => !x.regie);
    const regie = h.find((x) => x.regie);
    let amount: bigint | null;
    let calc: string;
    let base = true;
    if (o.billing === 'stunde') {
      amount = normal?.amount ?? 0n;
      calc = normal
        ? `${hrs(normal.minutes)} Std. × ${euro(price)} (Stundennachweis ${MON(month)})`
        : `keine Stunden erfasst (${euro(price)} / Std.)`;
    } else if (o.billing === 'tag') {
      const { days } = countDays(month, {
        workDays: o.work_days,
        validFrom: o.valid_from,
        validTo: o.valid_to,
        closures: closures.filter((c) => c.subcontract_id === o.id),
      });
      amount = price * BigInt(days);
      calc = `${days} Tage (${workDaysLabel(o.work_days)}) × ${euro(price)}`;
    } else if (o.billing === 'umsatz') {
      const keep = 10000 - (o.margin_bp ?? 0);
      const pct = `${String(keep / 100).replace('.', ',')} % von unserem Umsatz ${MON(month)}`;
      let cost: bigint;
      if (sum) {
        const parts = await sammelMonthCost(
          sql,
          { id: o.id, billing: o.billing, price_cents: price, margin_bp: o.margin_bp },
          month,
        );
        cost = parts.reduce((a, p) => a + p.cost, 0n);
      } else {
        const rev = (await siteRevenueMonth(sql, [o.site_id], month)).get(o.site_id) ?? 0n;
        cost = (rev * BigInt(keep) * 2n + 10000n) / 20000n;
      }
      amount = cost || null;
      calc = cost ? pct : `${pct} – noch kein Umsatz, Betrag bitte eintragen`;
    } else {
      // Pauschalen und je m²: regelmäßig jeden Monat, nach Ausführung im Monat des Endes
      // Turnus (quartalsweise …): im letzten Monat jedes Zeitraums ab Beginn bzw. im Monat des Endes
      const step = STEP_MONTHS[o.frequency] ?? 0;
      const diff =
        (Number(month.slice(0, 4)) - Number(o.valid_from.slice(0, 4))) * 12 +
        Number(month.slice(5, 7)) -
        Number(o.valid_from.slice(5, 7));
      base =
        rec ||
        (step === 0 ? endMonth === month : (diff + 1) % step === 0 || (!!o.valid_to && endMonth === month));
      let total =
        totals.get(o.id) ??
        (o.billing === 'qm' ? (sqm.get(o.id) ? (price * sqm.get(o.id)! + 50n) / 100n : null) : price);
      // Sammelbestellung: Betrag des Monats je Objekt – gekündigte Objekte anteilig bzw. ohne (Ahmed 26.11.)
      let ended = '';
      if (sum && base) {
        const parts = await sammelMonthCost(
          sql,
          { id: o.id, billing: o.billing, price_cents: price, margin_bp: o.margin_bp },
          month,
        );
        if (parts.length) {
          total = parts.reduce((a, p) => a + p.cost, 0n);
          const gone = endedSites.filter((e) => e.id === o.id && e.valid_to <= `${month}-31`);
          if (gone.length)
            ended = ` – ${gone.length === 1 ? '1 Objekt' : `${gone.length} Objekte`} gekündigt, anteilig gekürzt`;
        }
      }
      amount = total;
      calc =
        o.billing === 'qm'
          ? sqm.get(o.id)
            ? `${(Number(sqm.get(o.id)) / 100).toLocaleString('de-DE')} m² × ${euro(price)}`
            : 'Flächen fehlen – Betrag bitte eintragen'
          : o.billing === 'pauschale_einsatz'
            ? `Pauschale je Einsatz${sum ? ` (Summe der ${sum.n} Objekte)` : ''}${rec ? '' : (STEP_MONTHS[o.frequency] ?? 0) > 0 ? ` (${FREQUENCY[o.frequency] ?? o.frequency})` : `, ausgeführt bis ${formatDateDe(o.valid_to ?? o.valid_from)}`}`
            : rec
              ? `Pauschale ${MON(month)}${sum ? ` (Summe der ${sum.n} Objekte)` : ''}`
              : `Pauschale, ausgeführt bis ${formatDateDe(o.valid_to ?? o.valid_from)}`;
      if (!rec && o.billing === 'pauschale_monat' && o.valid_to) calc += ' (einmalig)';
      calc += ended;
    }
    // Zustand aus der Rechnungsverfolgung (gleicher Zeitraum wie „Rechnung erwartet“)
    const per = (tracking.get(o.id) ?? []).find((p) => p.start <= month && month <= p.end.slice(0, 7));
    const state: LineState =
      per?.state === 'abgerechnet' ? 'abgerechnet' : per?.state === 'keine' ? 'keine' : 'offen';
    const common = {
      subcontractId: o.id,
      number: o.number,
      where,
      objTitle: sum ? `Sammelbestellung (${sum.n} Objekte)` : `${o.site_name} (${o.site_no})`,
      objAddress: sum ? sum.text : o.site_address,
      serviceKind: o.service_kind,
      billing: o.billing,
      frequency: o.frequency,
      state,
      invoices: (per?.invoices ?? []).map((i) => ({ id: i.id, invoice_no: i.invoice_no })),
      skipReason: per?.skipReason ?? null,
    };
    const st =
      byId.get(o.supplier_id) ??
      ({
        supplierId: o.supplier_id,
        supplierName: o.supplier_name,
        supplierNo: o.supplier_no,
        selfBilling: !!o.self_billing_since && o.self_billing_since <= to,
        lines: [],
        openTotal: 0n,
        billedTotal: 0n,
      } satisfies Statement);
    // Stunden ohne Erfassung bei Bestellungen nach Ausführung: keine leere Zeile
    const showBase = base && !(o.billing === 'stunde' && !normal && !rec);
    if (showBase) st.lines.push({ ...common, key: `${o.id}|grund`, kind: 'grund', calc, amount });
    if (regie && regie.minutes > 0)
      st.lines.push({
        ...common,
        key: `${o.id}|regie`,
        kind: 'regie',
        calc: `Regie ${hrs(regie.minutes)} Std. × ${euro(BigInt(o.regie_rate_cents ?? 0))}`,
        amount: regie.amount,
      });
    byId.set(o.supplier_id, st);
  }
  const out = [...byId.values()].filter((s) => s.lines.length);
  for (const s of out) {
    for (const l of s.lines) {
      if (l.state === 'offen') s.openTotal += l.amount ?? 0n;
      if (l.state === 'abgerechnet') s.billedTotal += l.amount ?? 0n;
    }
  }
  return out;
}

export async function nuStatement(sql: Sql, supplierId: string, month: string) {
  const [s] = await nuStatements(sql, month, { supplierId });
  if (s) return s;
  const sup = await getSupplier(sql, supplierId);
  if (!sup) throw new BusinessError('Nachunternehmer nicht gefunden');
  return {
    supplierId,
    supplierName: sup.name,
    supplierNo: sup.supplier_no,
    selfBilling: !!sup.self_billing_since && sup.self_billing_since <= lastDay(month),
    lines: [],
    openTotal: 0n,
    billedTotal: 0n,
  } satisfies Statement;
}

// ---------------------------------------------------------------------------
// Aus dem Blatt abrechnen
// ---------------------------------------------------------------------------

export interface PickedLine {
  key: string;
  amount: bigint;
}
export interface ExtraLine {
  text: string;
  amount: bigint;
}

/** Beträge je Bestellung (Zeilen der gewählten Bestellungen + Zusatzzeilen anteilig verteilt) auf `total` bringen. */
function linksFor(
  statement: Statement,
  picked: PickedLine[],
  total: bigint,
  month: string,
): { subcontractId: string; month: string; net: bigint }[] {
  const per = new Map<string, bigint>();
  for (const p of picked) {
    const l = statement.lines.find((x) => x.key === p.key);
    if (!l) throw new BusinessError('Position gehört nicht zu diesem Nachunternehmer/Monat');
    per.set(l.subcontractId, (per.get(l.subcontractId) ?? 0n) + p.amount);
  }
  const ids = [...per.keys()];
  if (!ids.length) throw new BusinessError('Bitte mindestens eine Position wählen');
  const weights = ids.map((id) => (per.get(id)! > 0n ? per.get(id)! : 0n));
  const parts = weights.some((w) => w > 0n)
    ? splitByWeights(total, weights)
    : splitByWeights(
        total,
        ids.map(() => 1n),
      );
  return ids.map((id, i) => ({ subcontractId: id, month, net: parts[i]! }));
}

function checkPicked(statement: Statement, picked: PickedLine[]) {
  const seen = new Set<string>();
  for (const p of picked) {
    if (seen.has(p.key)) throw new BusinessError('Position doppelt');
    seen.add(p.key);
    const l = statement.lines.find((x) => x.key === p.key);
    if (!l) throw new BusinessError('Position gehört nicht zu diesem Nachunternehmer/Monat');
    if (l.state === 'abgerechnet') throw new BusinessError(`${l.number}: in diesem Monat schon abgerechnet`);
  }
}

/**
 * Rechnung des Nachunternehmers zum Blatt erfassen: Eingangsrechnung mit Verknüpfung je Bestellung (Beträge im Verhältnis
 * der Abrechnung, ergeben genau den Rechnungsbetrag) → Kostenstellen automatisch (auch Sammelbestellungen). Feste ID je
 * Formular (doppelt absenden legt nichts doppelt an).
 */
export async function invoiceFromStatement(
  deps: { sql: Sql; filesDir: string; maxBytes: number },
  p: {
    id: string;
    supplierId: string;
    month: string;
    picked: PickedLine[];
    invoiceNo: string;
    invoiceDate: string;
    dueDate: string | null;
    net: bigint;
    vat: bigint;
    reverseCharge: boolean;
    note: string | null;
    file: { name: string; type: string; data: Uint8Array } | null;
  },
  actor: string,
) {
  const { sql } = deps;
  const [exists] = await sql`select 1 from app.incoming_invoices where id = ${p.id}`;
  if (exists) return p.id;
  const st = await nuStatement(sql, p.supplierId, p.month);
  checkPicked(st, p.picked);
  if (p.net <= 0n) throw new BusinessError('Nettobetrag fehlt');
  const sum = p.picked.reduce((a, x) => a + x.amount, 0n);
  const diff = p.net - sum;
  await saveIncoming(
    sql,
    p.id,
    {
      supplierId: p.supplierId,
      invoiceNo: p.invoiceNo,
      invoiceDate: p.invoiceDate,
      dueDate: p.dueDate,
      serviceMonth: p.month,
      net: p.net as Cents,
      vat: p.vat as Cents,
      reverseCharge: p.reverseCharge,
      category: 'nachunternehmer',
      siteId: null,
      purchaseOrderId: null,
      links: linksFor(st, p.picked, p.net, p.month),
      skontoUntil: null,
      skontoPercentBp: null,
      note:
        [
          p.note?.trim() || null,
          diff !== 0n ? `Abweichung zur NU-Abrechnung ${MON(p.month)}: ${euro(diff)} netto` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      expectedVersion: null,
    },
    actor,
  );
  if (p.file)
    await storeFile(
      sql,
      { dir: deps.filesDir, maxBytes: deps.maxBytes },
      {
        id: randomUUID(),
        name: p.file.name,
        type: p.file.type || 'application/pdf',
        data: p.file.data,
        link: { type: 'incoming_invoice', id: p.id },
        category: 'Rechnung',
      },
      actor,
    );
  return p.id;
}

/** Monat (alle gewählten Positionen) „keine Rechnung“ vermerken. */
export async function skipStatement(
  sql: Sql,
  supplierId: string,
  month: string,
  keys: string[],
  reason: string,
  actor: string,
) {
  const st = await nuStatement(sql, supplierId, month);
  const ids = [
    ...new Set(
      st.lines.filter((l) => keys.includes(l.key) && l.state === 'offen').map((l) => l.subcontractId),
    ),
  ];
  if (!ids.length) throw new BusinessError('Bitte mindestens eine offene Position wählen');
  // Vermerk gilt für den Zeitraum, in dem der Monat liegt
  const tracking = await billingTracking(sql, ids, { today: lastDay(month), limit: 600 });
  for (const id of ids) {
    const per = (tracking.get(id) ?? []).find((x) => x.start <= month && month <= x.end.slice(0, 7));
    await skipExpected(sql, id, per?.start ?? month, reason, actor);
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Gutschrift (§ 14 Abs. 2 S. 2 UStG)
// ---------------------------------------------------------------------------

export const SELF_BILLING_VAT: Record<string, string> = {
  '13b': '§ 13b UStG – Steuerschuldnerschaft des Leistungsempfängers (ohne USt)',
  '19': 'mit 19 % Umsatzsteuer',
  klein: 'Kleinunternehmer nach § 19 UStG (ohne USt)',
};

/** Gutschriftverfahren am Nachunternehmer festhalten (leer = aus). */
export async function setSelfBilling(
  sql: Sql,
  supplierId: string,
  p: { since: string | null; vat: '13b' | '19' | 'klein' | null; taxNo: string | null; vatId: string | null },
  actor: string,
) {
  if (p.since && !/^\d{4}-\d{2}-\d{2}$/.test(p.since)) throw new BusinessError('Datum ungültig');
  if (p.since && !p.vat) throw new BusinessError('Bitte die Umsatzsteuer auf der Gutschrift wählen');
  if (p.since && !p.taxNo?.trim() && !p.vatId?.trim())
    throw new BusinessError(
      'Für Gutschriften ist die Steuernummer oder USt-IdNr. des Nachunternehmers Pflicht (§ 14 Abs. 4 Nr. 2 UStG)',
    );
  await sql`
    update app.suppliers set self_billing_since = ${p.since}, self_billing_vat = ${p.since ? p.vat : null},
           tax_no = ${p.taxNo?.trim() || null}, vat_id = ${p.vatId?.trim() || null}, updated_at = now()
     where id = ${supplierId} and kind = 'nachunternehmer'`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'self_billing', 'supplier', ${supplierId}, ${sql.json({ since: p.since, vat: p.vat })})`;
}

/** Vereinbarung über das Gutschriftverfahren als PDF (zum Unterschreiben). */
export async function selfBillingAgreementPdf(sql: Sql, supplierId: string, since: string | null) {
  const s = await getSupplier(sql, supplierId);
  if (!s) throw new BusinessError('Nachunternehmer nicht gefunden');
  const seller = await getSeller(sql);
  const today = todayBerlin();
  const start = since ? formatDateDe(since) : '______________';
  const vat = s.self_billing_vat ?? '13b';
  const d = await FormDoc.create({
    title: `Vereinbarung Gutschriftverfahren – ${s.name}`,
    sideRef: `Vereinbarung Gutschriftverfahren · ${s.supplier_no} · Stand ${formatDateDe(today)}`,
    date: today,
    author: seller.legalName,
  });
  d.title('Vereinbarung über die Abrechnung im Gutschriftverfahren');
  const ids = (taxNo: string | null | undefined, vatId: string | null | undefined) =>
    [taxNo ? `Steuernummer: ${taxNo}` : null, vatId ? `USt-IdNr.: ${vatId}` : null].filter(
      (x): x is string => !!x,
    );
  d.twoCols(
    {
      label: 'Auftraggeber (stellt die Gutschriften aus)',
      lines: [
        seller.legalName,
        seller.street,
        `${seller.postalCode} ${seller.city}`,
        ...ids(seller.taxNumber, seller.vatId),
      ],
    },
    {
      label: 'Nachunternehmer (leistet)',
      lines: [
        s.name,
        ...(s.street ? [s.street] : []),
        ...([s.postal_code, s.city].filter(Boolean).length
          ? [[s.postal_code, s.city].filter(Boolean).join(' ')]
          : []),
        ...(ids(s.tax_no, s.vat_id).length
          ? ids(s.tax_no, s.vat_id)
          : ['Steuernummer / USt-IdNr.: ______________']),
        `Lieferanten-Nr.: ${s.supplier_no}`,
      ],
    },
  );
  d.y += 6;
  const vatText: Record<string, string> = {
    '13b':
      'Die Leistungen sind Gebäudereinigungsleistungen (§ 13b Abs. 2 Nr. 8 UStG) an einen Auftraggeber, der selbst ' +
      'solche Leistungen erbringt. Die Umsatzsteuer schuldet der Auftraggeber (§ 13b Abs. 5 UStG); ' +
      'die Gutschriften werden ohne Umsatzsteuer und mit dem Hinweis „Steuerschuldnerschaft des Leistungsempfängers“ ' +
      'ausgestellt.',
    '19':
      'Die Gutschriften weisen die Umsatzsteuer mit dem gesetzlichen Steuersatz (derzeit 19 %) gesondert aus. Der ' +
      'Nachunternehmer schuldet die ausgewiesene Umsatzsteuer und führt sie ab.',
    klein:
      'Der Nachunternehmer ist Kleinunternehmer im Sinne von § 19 UStG. Die Gutschriften werden ohne Umsatzsteuer ' +
      'ausgestellt. Entfällt die Kleinunternehmerregelung, teilt der Nachunternehmer dies unverzüglich mit.',
  };
  const paras: [string, string][] = [
    [
      '§ 1 Gegenstand',
      `Ab dem ${start} rechnet der Auftraggeber die Leistungen des Nachunternehmers aus erteilten Bestellungen ` +
        'durch Gutschriften ab (Abrechnung durch den Leistungsempfänger nach § 14 Abs. 2 Satz 2 UStG). Die Gutschrift ' +
        'gilt als Rechnung des Nachunternehmers. Der Nachunternehmer stellt für diese Leistungen keine eigenen ' +
        'Rechnungen aus; tut er es doch, gilt allein die Gutschrift.',
    ],
    [
      '§ 2 Abrechnung',
      'Abgerechnet wird monatlich bzw. nach Ausführung auf Grundlage der erteilten Bestellungen, der dort ' +
        'vereinbarten Preise und der bestätigten Stunden- bzw. Leistungsnachweise. Jede Gutschrift enthält die ' +
        'Pflichtangaben nach § 14 Abs. 4 UStG, insbesondere die Bezeichnung „Gutschrift“, eine fortlaufende Nummer, den ' +
        'Leistungszeitraum, die Objekte und die Steuernummer bzw. USt-IdNr. des Nachunternehmers.',
    ],
    ['§ 3 Umsatzsteuer', vatText[vat] ?? vatText['13b']!],
    [
      '§ 4 Übermittlung, Prüfung und Widerspruch',
      `Die Gutschriften werden per E-Mail${s.email ? ` an ${s.email}` : ''} als PDF übermittelt. Der Nachunternehmer ` +
        'prüft jede Gutschrift unverzüglich und teilt Einwände innerhalb von 14 Tagen in Textform mit. Er kann einer ' +
        'Gutschrift jederzeit widersprechen; mit dem Widerspruch verliert sie die Wirkung als Rechnung ' +
        '(§ 14 Abs. 2 Satz 3 UStG). Der Auftraggeber stellt dann eine berichtigte Gutschrift aus.',
    ],
    [
      '§ 5 Zahlung',
      `Der Gutschriftbetrag wird innerhalb von ${s.payment_terms_days ?? 14} Tagen nach dem Datum der Gutschrift auf ` +
        `das vom Nachunternehmer genannte Konto${s.iban ? ` (IBAN ${s.iban.replace(/(.{4})/g, '$1 ').trim()})` : ''} ` +
        'überwiesen. Geleistete Vorschüsse und vereinbarte Abzüge werden verrechnet und auf der Gutschrift ausgewiesen. ' +
        'Änderungen von Name, Anschrift, Steuernummer bzw. USt-IdNr., Bankverbindung und umsatzsteuerlichem Status ' +
        'teilt der Nachunternehmer unverzüglich in Textform mit.',
    ],
    [
      '§ 6 Laufzeit',
      'Die Vereinbarung gilt auf unbestimmte Zeit. Sie kann von beiden Seiten mit einer Frist von einem Monat zum ' +
        'Monatsende in Textform gekündigt werden. Die übrigen Vereinbarungen (Rahmenvertrag, Bestellungen) bleiben ' +
        'unberührt.',
    ],
  ];
  for (const [h, t] of paras) {
    d.heading(h, 9);
    d.y -= 5;
    d.para(t, { size: 8.6 });
  }
  d.signatures(`Auftraggeber · ${seller.legalName}`, `Nachunternehmer · ${s.name}`, {
    leftText: `${seller.city}, den ${formatDateDe(today)}`,
    rightText: 'Ort, Datum',
  });
  return d.save();
}

/**
 * Gutschrift erstellen: Nummer GS-JJJJ-NNNN, Eingangsrechnung (freigegeben, Beträge je Bestellung → Kostenstellen),
 * PDF write-once am Nachunternehmer (Dokumente „Rechnungen“) und an der Eingangsrechnung. Feste ID je Formular.
 */
export async function createCreditNote(
  deps: { sql: Sql; filesDir: string; maxBytes: number },
  p: {
    id: string;
    supplierId: string;
    month: string;
    picked: PickedLine[];
    extras: ExtraLine[];
    date: string;
    note: string | null;
    /** offene Vorschüsse verrechnen (Betrag, älteste zuerst); null/0 = keine */
    advance?: bigint | null;
  },
  actor: string,
) {
  const { sql } = deps;
  const [done] = await sql<{ number: string }[]>`
    select number from app.nu_credit_notes where incoming_invoice_id = ${p.id}`;
  if (done) return { id: p.id, number: done.number };
  const sup = await getSupplier(sql, p.supplierId);
  if (!sup) throw new BusinessError('Nachunternehmer nicht gefunden');
  if (!sup.self_billing_since || sup.self_billing_since > lastDay(p.month))
    throw new BusinessError(
      'Mit diesem Nachunternehmer ist (für diesen Monat) kein Gutschriftverfahren vereinbart',
    );
  if (!sup.tax_no && !sup.vat_id)
    throw new BusinessError('Steuernummer oder USt-IdNr. des Nachunternehmers fehlt (Pflichtangabe)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum ungültig');
  const st = await nuStatement(sql, p.supplierId, p.month);
  checkPicked(st, p.picked);
  const net = p.picked.reduce((a, x) => a + x.amount, 0n) + p.extras.reduce((a, x) => a + x.amount, 0n);
  if (net <= 0n) throw new BusinessError('Gutschrift muss einen positiven Betrag haben');
  const mode = sup.self_billing_vat ?? '13b';
  const vat = mode === '19' ? (net * 19n * 2n + 100n) / 200n : 0n;
  const year = p.date.slice(0, 4);
  const number = await sql.begin((tx) => nextYearNumber(tx, 'gutschrift', 'GS-', year, 4));
  const lines = [
    ...p.picked.map((x) => {
      const l = st.lines.find((y) => y.key === x.key)!;
      return {
        text: `${l.serviceKind}${l.kind === 'regie' ? ' – Regie' : ''} (Bestellung ${l.number})`,
        calc: l.calc,
        amount: String(x.amount),
        object: l.objTitle,
        address: l.objAddress,
      };
    }),
    ...p.extras.map((x) => ({
      text: x.text,
      calc: '',
      amount: String(x.amount),
      object: null,
      address: null,
    })),
  ];
  await saveIncoming(
    sql,
    p.id,
    {
      supplierId: p.supplierId,
      invoiceNo: number,
      invoiceDate: p.date,
      dueDate: null,
      serviceMonth: p.month,
      net: net as Cents,
      vat: vat as Cents,
      reverseCharge: mode === '13b',
      category: 'nachunternehmer',
      siteId: null,
      purchaseOrderId: null,
      links: linksFor(st, p.picked, net, p.month),
      skontoUntil: null,
      skontoPercentBp: null,
      note: [`Gutschrift NU-Abrechnung ${MON(p.month)}`, p.note?.trim() || null].filter(Boolean).join(' · '),
      expectedVersion: null,
    },
    actor,
  );
  await decideIncoming(sql, p.id, 'freigegeben', actor);
  await sql`
    insert into app.nu_credit_notes (incoming_invoice_id, number, supplier_id, period_month, vat_mode, lines, created_by)
    values (${p.id}, ${number}, ${p.supplierId}, ${`${p.month}-01`}, ${mode}, ${sql.json(lines)}, ${actor})
    on conflict do nothing`;
  // Vorschüsse vor dem PDF verrechnen, damit die Gutschrift den Auszahlungsbetrag nennt (Ahmed 15.11.)
  if (p.advance && p.advance > 0n) await offsetAdvance(sql, p.id, p.advance, actor, `gutschrift:${p.id}`);
  const pdf = await creditNotePdf(sql, p.id);
  const f = await storeFile(
    sql,
    { dir: deps.filesDir, maxBytes: deps.maxBytes },
    {
      id: randomUUID(),
      name: `${number}_Gutschrift_${sup.name.replace(/[^\wäöüÄÖÜß -]+/g, '').trim()}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link: { type: 'incoming_invoice', id: p.id },
      category: 'Gutschrift',
    },
    actor,
  );
  await sql`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
            values (${f.id}, 'supplier', ${p.supplierId}, 'Rechnungen', ${actor}) on conflict do nothing`;
  await sql`update app.nu_credit_notes set file_id = ${f.id} where incoming_invoice_id = ${p.id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'credit_note', 'incoming_invoice', ${p.id}, ${sql.json({ number, month: p.month, net: String(net) })})`;
  return { id: p.id, number };
}

export async function getCreditNote(sql: Sql, incomingId: string) {
  const [c] = await sql<
    {
      incoming_invoice_id: string;
      number: string;
      supplier_id: string;
      period_month: string;
      vat_mode: string;
      lines: {
        text: string;
        calc: string;
        amount: string;
        object?: string | null;
        address?: string | null;
      }[];
      file_id: string | null;
      sent_at: Date | null;
      sent_to: string | null;
    }[]
  >`select incoming_invoice_id, number, supplier_id, period_month::text, vat_mode, lines, file_id, sent_at, sent_to
      from app.nu_credit_notes where incoming_invoice_id = ${incomingId}`;
  return c;
}

/** PDF der Gutschrift (Briefpapier „edel“, Pflichtangaben § 14 Abs. 4 UStG). */
export async function creditNotePdf(sql: Sql, incomingId: string) {
  const c = await getCreditNote(sql, incomingId);
  const inv = await getIncoming(sql, incomingId);
  if (!c || !inv) throw new BusinessError('Gutschrift nicht gefunden');
  const s = await getSupplier(sql, c.supplier_id);
  if (!s) throw new BusinessError('Nachunternehmer nicht gefunden');
  const seller = await getSeller(sql);
  const month = c.period_month.slice(0, 7);
  const net = BigInt(inv.net_cents);
  const vat = BigInt(inv.vat_cents);
  const adv = (await invoiceOffsets(sql, [incomingId])).get(incomingId) ?? 0n;
  return renderLetterPdf({
    title: `Gutschrift ${c.number}`,
    date: inv.invoice_date,
    info: [
      ['Datum', formatDateDe(inv.invoice_date)],
      ['Gutschrift-Nr.', c.number],
      ['Leistungszeitraum', `${formatDateDe(`${month}-01`)} – ${formatDateDe(lastDay(month))}`],
      ['Lieferanten-Nr.', s.supplier_no],
      [s.tax_no ? 'Ihre Steuernummer' : 'Ihre USt-IdNr.', (s.tax_no || s.vat_id) ?? ''],
    ],
    seller,
    buyer: {
      customerNo: s.supplier_no,
      name: s.name,
      name2: attnLine(s.contact_name),
      street: s.street ?? '',
      postalCode: s.postal_code ?? '',
      city: s.city ?? '',
      countryCode: 'DE',
      vatId: null,
      leitwegId: null,
      supplierNo: null,
      email: null,
      contactName: null,
      site: null,
    },
    intro:
      `wie vereinbart rechnen wir Ihre Leistungen für ${MON(month)} im Gutschriftverfahren ab ` +
      `(§ 14 Abs. 2 Satz 2 UStG). Diese Gutschrift gilt als Ihre Rechnung.`,
    columns: [
      { label: 'Pos.', x: 62.3, align: 'left' },
      { label: 'Leistung', x: 90, align: 'left' },
      { label: 'Betrag netto', x: 538.8 },
    ],
    rows: creditRows(c.lines),
    sums: [
      ['Summe netto', euro(net)],
      [c.vat_mode === '19' ? 'Umsatzsteuer 19 %' : 'Umsatzsteuer', euro(vat)],
    ],
    total: ['Gutschriftbetrag', euro(net + vat)],
    paragraphs: [
      ...(c.vat_mode === '13b'
        ? [
            'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) – die Umsatzsteuer schuldet die ' +
              `${seller.legalName}.`,
          ]
        : c.vat_mode === 'klein'
          ? ['Kein Ausweis der Umsatzsteuer: Kleinunternehmer nach § 19 UStG.']
          : []),
      ...(adv > 0n
        ? [
            `Verrechnet mit bereits gezahlten Vorschüssen: ${euro(adv)}. ` +
              `Auszahlungsbetrag: ${euro(net + vat - adv)}.`,
          ]
        : []),
      `Der ${adv > 0n ? 'Auszahlungsbetrag' : 'Betrag'} wird bis ${formatDateDe(inv.due_date)} auf Ihr Konto ${s.iban ? s.iban.replace(/(.{4})/g, '$1 ').trim() : '(bitte Bankverbindung mitteilen)'} überwiesen.`,
      'Bitte prüfen Sie die Gutschrift. Einwände teilen Sie uns bitte innerhalb von 14 Tagen in Textform mit.',
      'Mit freundlichen Grüßen',
    ],
    signature: null,
  });
}

/**
 * Positionen der Gutschrift je Objekt gruppiert wie auf unserer Rechnung (Ahmed 15.11.): Überschrift „Objekt (Nr.)“
 * mit Adresse, darunter die Positionen, ab zwei Positionen „Summe <Objekt>“. Ältere Gutschriften ohne Objekt-Angabe
 * und Zusatzzeilen (Abzüge) stehen am Ende ohne Überschrift.
 */
export function creditRows(
  lines: { text: string; calc: string; amount: string; object?: string | null; address?: string | null }[],
) {
  const groups = new Map<string, typeof lines>();
  for (const l of lines) {
    const k = l.object ?? '';
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : 0));
  const rows: LetterRow[] = [];
  let n = 0;
  for (const k of keys) {
    const ls = groups.get(k)!;
    if (k) rows.push({ group: `Objekt: ${k}`, sub: ls[0]!.address ?? null });
    else if (keys.length > 1) rows.push({ group: 'Weitere Positionen' });
    for (const l of ls)
      rows.push([String(++n), l.calc ? `${l.text}\n${l.calc}` : l.text, euro(BigInt(l.amount))]);
    if (k && ls.length > 1 && keys.length > 1)
      rows.push({
        subtotal: [`Summe ${k}`, euro(ls.reduce((a, l) => a + BigInt(l.amount), 0n))],
      });
  }
  return rows;
}
type LetterRow = Parameters<typeof renderLetterPdf>[0]['rows'][number];

export const statementLabel = (l: StatementLine) =>
  `${BILLING[l.billing] ?? l.billing} · ${FREQUENCY[l.frequency] ?? l.frequency}`;

/** Gutschrift per E-Mail an den Nachunternehmer (Anhang = abgelegtes PDF). Erneut senden ist möglich. */
export async function sendCreditNote(deps: Deps, incomingId: string, actor: string) {
  const { sql, env } = deps;
  const c = await getCreditNote(sql, incomingId);
  if (!c?.file_id) throw new BusinessError('Gutschrift nicht gefunden');
  if (deps.mailer.configured === false) throw new BusinessError(MAILER_MISSING);
  const s = await getSupplier(sql, c.supplier_id);
  if (!s?.email) throw new BusinessError('Beim Nachunternehmer ist keine E-Mail-Adresse hinterlegt');
  const [f] = await sql<Parameters<typeof filePath>[1][]>`select * from app.files where id = ${c.file_id}`;
  if (!f) throw new BusinessError('PDF der Gutschrift fehlt');
  const pdf = new Uint8Array(
    await readFile(filePath({ dir: env.FILES_DIR, maxBytes: env.UPLOAD_MAX_BYTES }, f)),
  );
  const { actual, redirected } = resolveRecipients(env, [s.email]);
  const month = c.period_month.slice(0, 7);
  await deps.mailer.send({
    from: env.MAIL_FROM,
    to: actual,
    subject: `${redirected ? '[TEST] ' : ''}Gutschrift ${c.number} – Abrechnung ${MON(month)} – Viva-Deluxe Gebäudereinigung GmbH`,
    ...composeMail({
      notice: redirected
        ? `*** TESTVERSAND – diese Mail ging NICHT an den Nachunternehmer. ***\nEigentlicher Empfänger: ${s.email}`
        : null,
      body:
        `Guten Tag,\n\nanbei erhalten Sie unsere Gutschrift ${c.number} über Ihre Leistungen im ${MON(month)} ` +
        `(Abrechnung im Gutschriftverfahren, § 14 Abs. 2 Satz 2 UStG). Sie gilt als Ihre Rechnung – bitte stellen ` +
        `Sie dafür keine eigene Rechnung aus.\n\nBitte prüfen Sie die Gutschrift; Einwände teilen Sie uns bitte ` +
        `innerhalb von 14 Tagen mit.`,
      signature: await loadSignature(sql),
    }),
    attachments: [{ filename: `Gutschrift_${c.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
    messageId: `<gutschrift-${incomingId}-${Date.now()}@viva-deluxe-app>`,
  });
  await sql`update app.nu_credit_notes set sent_at = now(), sent_to = ${actual.join(', ')}
             where incoming_invoice_id = ${incomingId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'send', 'nu_credit_note', ${incomingId}, ${sql.json({ to: actual, redirected })})`;
  return actual;
}

/** Gutschriften eines Nachunternehmers (neueste zuerst). */
export async function listCreditNotes(sql: Sql, opts: { supplierId?: string; month?: string } = {}) {
  return sql<
    {
      incoming_invoice_id: string;
      number: string;
      supplier_id: string;
      supplier_name: string;
      period_month: string;
      gross_cents: bigint;
      status: string;
      file_id: string | null;
      sent_at: Date | null;
    }[]
  >`
    select c.incoming_invoice_id, c.number, c.supplier_id, s.name as supplier_name, c.period_month::text,
           i.gross_cents, i.status, c.file_id, c.sent_at
      from app.nu_credit_notes c join app.incoming_invoices i on i.id = c.incoming_invoice_id
      join app.suppliers s on s.id = c.supplier_id
     where ${opts.supplierId ? sql`c.supplier_id = ${opts.supplierId}` : sql`true`}
       and ${opts.month ? sql`c.period_month = ${`${opts.month}-01`}::date` : sql`true`}
     order by c.created_at desc`;
}
