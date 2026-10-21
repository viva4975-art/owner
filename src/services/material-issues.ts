import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import { uuidFrom } from './photo-stamp.js';
import { nextYearNumber } from './purchasing.js';

/*
 * Interner Lieferschein / Materialausgabe an ein Objekt (Ahmed 21.10.): Artikel aus dem Lager an ein Objekt ausgeben.
 * Bestand wird abgebucht, der Einkaufspreis des Artikels am Ausgabetag wird eingefroren und zählt in der
 * Nachkalkulation als Material auf die Kostenstelle (= Objekt) im Monat der Ausgabe. Nummer MA-JJJJ-NNNN, nur anhängen;
 * Storno bucht Bestand und Kosten über Gegenbuchungen zurück. Feste ID je Formular → doppelt absenden bucht nichts doppelt.
 */

export interface MaterialLineInput {
  articleId: string;
  quantityMilli: bigint;
}

export interface MaterialIssue {
  id: string;
  issue_no: string;
  site_id: string;
  issue_date: string;
  received_by: string | null;
  note: string | null;
  total_cents: bigint;
  created_by: string;
  created_at: Date;
  site_name: string;
  site_no: string;
  customer_name: string;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

/** Menge (×1000) × Preis in Cent, kaufmännisch gerundet. */
export const lineNet = (qtyMilli: bigint, cents: bigint) => (qtyMilli * cents * 2n + 1000n) / 2000n;

export async function createMaterialIssue(
  sql: Sql,
  id: string,
  p: {
    siteId: string;
    date: string;
    receivedBy?: string | null;
    note?: string | null;
    lines: MaterialLineInput[];
    /** fehlenden Bestand vorher als Inventurkorrektur zubuchen (Bestand war nicht erfasst) */
    fillShortage?: boolean;
  },
  actor: string,
): Promise<string> {
  const [done] = await sql<{ issue_no: string }[]>`select issue_no from app.material_issues where id = ${id}`;
  if (done) return done.issue_no;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum ungültig');
  if (p.date > todayBerlin()) throw new BusinessError('Ausgabedatum darf nicht in der Zukunft liegen');
  const lines = p.lines.filter((l) => l.quantityMilli !== 0n);
  if (lines.length === 0) throw new BusinessError('Bitte mindestens einen Artikel mit Menge eintragen');
  if (lines.some((l) => l.quantityMilli < 0n)) throw new BusinessError('Mengen bitte ohne Minus angeben');
  const [site] = await sql<{ id: string }[]>`select id from app.sites where id = ${p.siteId}`;
  if (!site) throw new BusinessError('Bitte ein Objekt wählen');

  return sql.begin(async (tx) => {
    const [again] = await tx<{ issue_no: string }[]>`
      select issue_no from app.material_issues where id = ${id}`;
    if (again) return again.issue_no;
    // gleiche Artikel zusammenfassen, Artikel sperren (Bestand)
    const qty = new Map<string, bigint>();
    for (const l of lines) qty.set(l.articleId, (qty.get(l.articleId) ?? 0n) + l.quantityMilli);
    const arts = await tx<
      {
        id: string;
        article_no: string;
        name: string;
        unit: string;
        stock_milli: bigint;
        purchase_price_cents: bigint | null;
      }[]
    >`select id, article_no, name, unit, stock_milli, purchase_price_cents from app.articles
       where id = any(${[...qty.keys()]}::uuid[]) for update`;
    const byId = new Map(arts.map((a) => [a.id, a]));
    const problems: string[] = [];
    for (const [aid, q] of qty) {
      const a = byId.get(aid);
      if (!a) {
        problems.push('Artikel nicht gefunden');
        continue;
      }
      if (a.purchase_price_cents === null)
        problems.push(`${a.name} (${a.article_no}): Einkaufspreis fehlt – bitte am Artikel eintragen`);
      if (a.stock_milli < q && !p.fillShortage)
        problems.push(
          `${a.name} (${a.article_no}): nur ${fmtQty(a.stock_milli)} ${a.unit} am Lager, ausgegeben ${fmtQty(q)} – ` +
            '„Fehlenden Bestand zubuchen“ ankreuzen, wenn der Bestand nicht erfasst war',
        );
    }
    if (problems.length) throw new BusinessError(problems.join('\n'));

    const number = await nextYearNumber(tx, 'material', 'MA-', p.date.slice(0, 4), 4);
    let total = 0n;
    const rows = [...qty].map(([aid, q], i) => {
      const a = byId.get(aid)!;
      const net = lineNet(q, a.purchase_price_cents!);
      total += net;
      return { a, q, net, pos: i + 1 };
    });
    await tx`insert into app.material_issues (id, issue_no, site_id, issue_date, received_by, note, total_cents, created_by)
             values (${id}, ${number}, ${p.siteId}, ${p.date}, ${p.receivedBy?.trim() || null},
                     ${p.note?.trim() || null}, ${total}, ${actor})`;
    for (const r of rows) {
      await tx`insert into app.material_issue_lines
                 (issue_id, position, article_id, description, unit, quantity_milli, unit_cost_cents, net_cents)
               values (${id}, ${r.pos}, ${r.a.id}, ${r.a.name}, ${r.a.unit}, ${r.q}, ${r.a.purchase_price_cents},
                       ${r.net})`;
      if (r.a.stock_milli < r.q) {
        const fix = r.q - r.a.stock_milli;
        await tx`insert into app.stock_movements (id, article_id, delta_milli, reason, site_id, created_by, booked_on)
                 values (${uuidFrom(`material-fix:${id}:${r.pos}`)}, ${r.a.id}, ${fix},
                         ${`Inventurkorrektur (Fehlbestand vor Materialausgabe ${number})`}, null, ${actor}, ${p.date})`;
      }
      await tx`insert into app.stock_movements
                 (id, article_id, delta_milli, reason, site_id, created_by, unit_cost_cents, booked_on, material_issue_id)
               values (${uuidFrom(`material:${id}:${r.pos}`)}, ${r.a.id}, ${-r.q}, ${`Materialausgabe ${number}`},
                       ${p.siteId}, ${actor}, ${r.a.purchase_price_cents}, ${p.date}, ${id})`;
      await tx`update app.articles set stock_milli = greatest(stock_milli, ${r.q}) - ${r.q}, updated_at = now()
                where id = ${r.a.id}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'create', 'material_issue', ${id},
                     ${tx.json({ number, site_id: p.siteId, total_cents: String(total) })})`;
    return number;
  });
}

/** Storno: Bestand zurück, Kosten über Gegenbuchung am Ausgabedatum heraus (Ausgabe bleibt sichtbar). */
export async function cancelMaterialIssue(sql: Sql, id: string, reason: string, actor: string) {
  if (!reason.trim()) throw new BusinessError('Bitte einen Grund für das Storno angeben');
  await sql.begin(async (tx) => {
    const [mi] = await tx<{ issue_no: string; site_id: string; issue_date: string }[]>`
      select issue_no, site_id, issue_date::text from app.material_issues where id = ${id}`;
    if (!mi) throw new BusinessError('Materialausgabe nicht gefunden');
    const [c] = await tx`select 1 from app.material_issue_cancellations where issue_id = ${id}`;
    if (c) return;
    await tx`insert into app.material_issue_cancellations (issue_id, reason, cancelled_by)
             values (${id}, ${reason.trim()}, ${actor})`;
    const lines = await tx<
      { position: number; article_id: string; quantity_milli: bigint; unit_cost_cents: bigint }[]
    >`
      select position, article_id, quantity_milli, unit_cost_cents from app.material_issue_lines
       where issue_id = ${id} order by position`;
    for (const l of lines) {
      await tx`insert into app.stock_movements
                 (id, article_id, delta_milli, reason, site_id, created_by, unit_cost_cents, booked_on, material_issue_id)
               values (${uuidFrom(`material-storno:${id}:${l.position}`)}, ${l.article_id}, ${l.quantity_milli},
                       ${`Storno Materialausgabe ${mi.issue_no}`}, ${mi.site_id}, ${actor}, ${l.unit_cost_cents},
                       ${mi.issue_date}, ${id})`;
      await tx`update app.articles set stock_milli = stock_milli + ${l.quantity_milli}, updated_at = now()
                where id = ${l.article_id}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'cancel', 'material_issue', ${id}, ${tx.json({ reason: reason.trim() })})`;
  });
}

export async function listMaterialIssues(
  sql: Sql,
  f: { siteId?: string | null; from?: string | null; to?: string | null } = {},
) {
  return sql<MaterialIssue[]>`
    select m.*, m.issue_date::text as issue_date, s.name as site_name, s.site_no, c.name as customer_name,
           x.cancelled_at, x.reason as cancel_reason
      from app.material_issues m
      join app.sites s on s.id = m.site_id join app.customers c on c.id = s.customer_id
      left join app.material_issue_cancellations x on x.issue_id = m.id
     where ${f.siteId ? sql`m.site_id = ${f.siteId}` : sql`true`}
       and ${f.from ? sql`m.issue_date >= ${f.from}` : sql`true`}
       and ${f.to ? sql`m.issue_date <= ${f.to}` : sql`true`}
     order by m.issue_date desc, m.issue_no desc
     limit 500`;
}

export async function getMaterialIssue(sql: Sql, id: string) {
  const [mi] = await sql<MaterialIssue[]>`
    select m.*, m.issue_date::text as issue_date, s.name as site_name, s.site_no, c.name as customer_name,
           x.cancelled_at, x.reason as cancel_reason
      from app.material_issues m
      join app.sites s on s.id = m.site_id join app.customers c on c.id = s.customer_id
      left join app.material_issue_cancellations x on x.issue_id = m.id
     where m.id = ${id}`;
  if (!mi) return null;
  const lines = await sql<
    {
      position: number;
      article_id: string;
      article_no: string;
      description: string;
      unit: string;
      quantity_milli: bigint;
      unit_cost_cents: bigint;
      net_cents: bigint;
    }[]
  >`select l.*, a.article_no from app.material_issue_lines l join app.articles a on a.id = l.article_id
     where l.issue_id = ${id} order by l.position`;
  return { issue: mi, lines };
}

const fmtQty = (m: bigint) =>
  (Number(m) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/** Lieferschein als PDF; ohne Preise z. B. zum Unterschreiben am Objekt. */
export async function materialIssuePdf(
  sql: Sql,
  id: string,
  withPrices: boolean,
): Promise<Uint8Array | null> {
  const data = await getMaterialIssue(sql, id);
  if (!data) return null;
  const { issue: m, lines } = data;
  const [site] = await sql<
    {
      name: string;
      site_no: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`select name, site_no, street, postal_code, city from app.sites where id = ${m.site_id}`;
  const eur = (c: bigint) => formatEuro(c as Cents);
  const address = [site?.street, [site?.postal_code, site?.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return renderLetterPdf({
    title: `Lieferschein ${m.issue_no}`,
    date: m.issue_date,
    info: [
      ['Datum', formatDateDe(m.issue_date)],
      ['Kostenstelle', m.site_no],
      ['Art', 'Interne Materialausgabe'],
    ],
    objekt: { title: `${m.site_name} (${m.site_no})`, address: address || null },
    ...(m.cancelled_at ? { watermark: 'STORNIERT' } : {}),
    seller: await getSeller(sql),
    buyer: {
      customerNo: '',
      name: m.site_name,
      name2: m.customer_name,
      street: site?.street ?? '',
      postalCode: site?.postal_code ?? '',
      city: site?.city ?? '',
      countryCode: 'DE',
      vatId: null,
      leitwegId: null,
      supplierNo: null,
      email: null,
      contactName: m.received_by,
      site: null,
    },
    greeting: null,
    intro: 'Folgendes Material wurde aus dem Lager an das Objekt geliefert:',
    columns: withPrices
      ? [
          { label: 'Pos', x: 62.3, align: 'left' },
          { label: 'Artikel', x: 90, align: 'left' },
          { label: 'Menge', x: 372 },
          { label: 'Einheit', x: 384, align: 'left' },
          { label: 'EK', x: 482 },
          { label: 'Betrag', x: 538.8 },
        ]
      : [
          { label: 'Pos', x: 62.3, align: 'left' },
          { label: 'Artikel', x: 90, align: 'left' },
          { label: 'Menge', x: 470 },
          { label: 'Einheit', x: 538.8 },
        ],
    rows: lines.map((l) =>
      withPrices
        ? [
            String(l.position),
            `${l.description} (${l.article_no})`,
            fmtQty(l.quantity_milli),
            l.unit,
            eur(l.unit_cost_cents),
            eur(l.net_cents),
          ]
        : [String(l.position), `${l.description} (${l.article_no})`, fmtQty(l.quantity_milli), l.unit],
    ),
    sums: [],
    total: withPrices ? ['Materialkosten (netto, EK)', eur(m.total_cents)] : null,
    paragraphs: [
      ...(m.note ? [m.note] : []),
      'Interner Beleg – wird nicht an den Kunden berechnet. Die Kosten werden der Kostenstelle des Objekts zugeordnet.',
      ...(m.cancelled_at ? [`Storniert: ${m.cancel_reason ?? ''}`] : []),
    ],
    signature: {
      label: 'Empfangen:',
      png: null,
      name: m.received_by ? `Datum, ${m.received_by}` : 'Datum, Name, Unterschrift',
      at: '',
    },
  });
}
