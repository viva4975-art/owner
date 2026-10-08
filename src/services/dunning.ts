import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { MAILER_MISSING, resolveRecipients } from '../mail/mailer.js';
import { renderLetterPdf } from '../pdf/render.js';
import { BusinessError } from './errors.js';
import { buildBuyerSnapshot, effectiveBilling, getSeller } from './masterdata.js';
import type { Deps } from './workflow.js';

/*
 * Mahnwesen (wie Fortytools): Vorschlagsliste aus überfälligen offenen Posten, drei Stufen.
 *
 * Rechtlich (B2B):
 * - Verzug tritt spätestens 30 Tage nach Fälligkeit und Zugang der Rechnung ein (§ 286 Abs. 3 BGB) –
 *   eine Mahnung ist dafür nicht nötig, macht den Verzug aber eindeutig.
 * - Mahngebühren sind Schadensersatz → OHNE Umsatzsteuer. Gerichte erkennen meist nur tatsächliche Kosten
 *   (Porto/Material, ca. 1–3 €) an; die erste, verzugsbegründende Mahnung ist nicht ersatzfähig.
 * - Verzugspauschale 40 € (§ 288 Abs. 5 BGB): je Rechnung einmal, nur wenn der Kunde kein Verbraucher ist, ab der
 *   Stufe mit `late_fee`. Sie wird auf Rechtsverfolgungskosten angerechnet (§ 288 Abs. 5 S. 3 BGB) → sobald für eine
 *   Rechnung der Mahnung die Pauschale verlangt wird/wurde, entfällt die Mahngebühr dieser Mahnung.
 * - Verzugszinsen 9 %-Punkte über Basiszinssatz (§ 288 Abs. 2 BGB): Basiszinssatz ändert sich halbjährlich → nicht
 *   fest einprogrammiert.
 */

export interface DunningSetting {
  level: number;
  title: string;
  fee_cents: bigint;
  min_days_overdue: number;
  payment_days: number;
  text: string;
  late_fee: boolean;
}

/** Verzugspauschale § 288 Abs. 5 BGB je Rechnung (Cent). */
export const LATE_FEE_CENTS = 4000n;

export interface DunningRow {
  id: string;
  number: string;
  customer_id: string;
  level: number;
  issue_date: string;
  pay_until: string;
  fee_cents: bigint;
  late_fee_cents: bigint;
  total_cents: bigint;
  status: 'erstellt' | 'versendet';
  pdf_sha256: string | null;
  pdf_path: string | null;
  created_by: string;
  created_at: Date;
  sent_at: Date | null;
  sent_to: string[] | null;
}

export interface ProposalItem {
  invoice_id: string;
  number: string;
  issue_date: string;
  due_date: string;
  open_cents: bigint;
  overdue_days: number;
  last_level: number;
  last_dunning_date: string | null;
  next_level: number;
  dunning_count?: number;
}

export interface Proposal {
  customer_id: string;
  customer_no: string;
  customer_name: string;
  level: number;
  open_cents: bigint;
  items: ProposalItem[];
}

/** Mindestabstand zwischen zwei Mahnungen zur selben Rechnung (Tage). */
export const MIN_GAP_DAYS = 10;

export async function getSettings(sql: Sql): Promise<DunningSetting[]> {
  return sql<DunningSetting[]>`select * from app.dunning_settings order by level`;
}

export async function saveSettings(
  sql: Sql,
  rows: {
    level: number;
    title: string;
    fee_cents: bigint;
    min_days_overdue: number;
    payment_days: number;
    text: string;
    late_fee?: boolean;
  }[],
  actor: string,
) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.min_days_overdue <= rows[i - 1]!.min_days_overdue) {
      throw new BusinessError('Die Tage Verzug müssen von Stufe zu Stufe steigen');
    }
  }
  await sql.begin(async (tx) => {
    for (const r of rows) {
      if (!r.title.trim() || !r.text.trim())
        throw new BusinessError(`Stufe ${r.level}: Titel und Text dürfen nicht leer sein`);
      await tx`update app.dunning_settings set title = ${r.title.trim()}, fee_cents = ${r.fee_cents},
                 min_days_overdue = ${r.min_days_overdue}, payment_days = ${r.payment_days}, text = ${r.text.trim()}
               where level = ${r.level}`;
      if (r.late_fee !== undefined)
        await tx`update app.dunning_settings set late_fee = ${r.late_fee} where level = ${r.level}`;
    }
    await tx`insert into app.audit_log (actor, action, entity) values (${actor}, 'save', 'dunning_settings')`;
  });
}

/** Offene, überfällige Posten mit bisheriger Mahnstufe. */
async function overdueItems(sql: Sql, customerId?: string) {
  return sql<
    (ProposalItem & {
      customer_id: string;
      customer_no: string;
      customer_name: string;
      dunning_block: boolean;
      is_consumer: boolean;
      late_fee_charged: boolean;
    })[]
  >`
    with o as (
      select invoice_id, number, issue_date, due_date, open_cents, customer_id from app.open_items
       where open_cents > 0 and kind in ('invoice', 'partial', 'final')
      union all
      -- Rechnungen aus Fortytools (bis zur Umstellung dort geschrieben) – Storno/Korrektur verrechnet
      select invoice_id, number, issue_date, due_date, open_cents, customer_id from app.legacy_open_items
       where open_cents > 0 and customer_id is not null and due_date is not null
    )
    select o.invoice_id, o.number, o.issue_date, o.due_date, o.open_cents, o.customer_id,
           c.customer_no, c.name as customer_name, c.dunning_block, c.is_consumer,
           exists (select 1 from app.dunning_items lf where lf.invoice_id = o.invoice_id and lf.late_fee_cents > 0)
             as late_fee_charged,
           ((now() at time zone 'Europe/Berlin')::date - o.due_date)::int as overdue_days,
           coalesce(last.level, 0)::int as last_level, last.issue_date as last_dunning_date,
           0 as next_level,
           (select count(*)::int from app.dunning_items di2 where di2.invoice_id = o.invoice_id) as dunning_count
      from o
      join app.customers c on c.id = o.customer_id
      left join lateral (
        select d.level, d.issue_date from app.dunning_items di join app.dunnings d on d.id = di.dunning_id
         where di.invoice_id = o.invoice_id order by d.level desc, d.issue_date desc limit 1
      ) last on true
     where o.due_date < (now() at time zone 'Europe/Berlin')::date
       and ${customerId ? sql`o.customer_id = ${customerId}` : sql`true`}
     order by c.name, o.due_date`;
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Mahnvorschläge je Kunde (Mahnsperre und zu frische Mahnungen ausgenommen). */
export async function proposals(sql: Sql): Promise<{
  proposals: Proposal[];
  blocked: { customer_id: string; customer_name: string; open_cents: bigint }[];
}> {
  const settings = await getSettings(sql);
  const today = todayBerlin();
  const items = await overdueItems(sql);
  const by = new Map<string, Proposal>();
  const blocked = new Map<string, { customer_id: string; customer_name: string; open_cents: bigint }>();
  for (const it of items) {
    if (it.dunning_block) {
      const b = blocked.get(it.customer_id) ?? {
        customer_id: it.customer_id,
        customer_name: it.customer_name,
        open_cents: 0n,
      };
      b.open_cents += it.open_cents;
      blocked.set(it.customer_id, b);
      continue;
    }
    const next = Math.min(3, it.last_level + 1);
    const s = settings.find((x) => x.level === next)!;
    if (it.last_level >= 3) continue; // letzte Stufe erreicht → Inkasso/Mahnbescheid (außerhalb der App)
    if (it.overdue_days < s.min_days_overdue) continue;
    if (it.last_dunning_date && daysBetween(it.last_dunning_date, today) < MIN_GAP_DAYS) continue;
    const p = by.get(it.customer_id) ?? {
      customer_id: it.customer_id,
      customer_no: it.customer_no,
      customer_name: it.customer_name,
      level: 0,
      open_cents: 0n,
      items: [],
    };
    p.items.push({ ...it, next_level: next });
    p.level = Math.max(p.level, next);
    p.open_cents += it.open_cents;
    by.set(it.customer_id, p);
  }
  return { proposals: [...by.values()], blocked: [...blocked.values()] };
}

/**
 * Mahnung erstellen (feste ID → zweimal Absenden legt nur eine an). Die Stufe ist die höchste nächste
 * Stufe der enthaltenen Rechnungen. Gebühr ohne USt.
 */
export async function createDunning(
  deps: Deps,
  id: string,
  customerId: string,
  invoiceIds: string[],
  actor: string,
): Promise<string> {
  const { sql } = deps;
  const [exists] = await sql`select 1 from app.dunnings where id = ${id}`;
  if (exists) return id;
  if (!invoiceIds.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
  const settings = await getSettings(sql);
  const today = todayBerlin();
  const all = await overdueItems(sql, customerId);
  const items = all.filter((i) => invoiceIds.includes(i.invoice_id));
  if (items.length !== new Set(invoiceIds).size) {
    throw new BusinessError(
      'Mindestens eine Rechnung ist nicht (mehr) überfällig oder bereits bezahlt – bitte Liste neu laden',
    );
  }
  if (items[0]!.dunning_block) throw new BusinessError('Für diesen Kunden ist eine Mahnsperre gesetzt');
  const level = Math.min(3, Math.max(...items.map((i) => i.last_level + 1)));
  const s = settings.find((x) => x.level === level)!;
  const open = items.reduce((a, i) => a + i.open_cents, 0n);
  const lateFeeOn = s.late_fee && !items[0]!.is_consumer;
  const lateFees = new Map(
    items.map((i) => [i.invoice_id, lateFeeOn && !i.late_fee_charged ? LATE_FEE_CENTS : 0n]),
  );
  const lateFee = [...lateFees.values()].reduce((a, v) => a + v, 0n);
  // Anrechnung (§ 288 Abs. 5 S. 3 BGB): mit Pauschale keine zusätzliche Mahngebühr
  const fee = lateFee > 0n || items.some((i) => i.late_fee_charged) ? 0n : s.fee_cents;
  await sql.begin(async (tx) => {
    const [n] = await tx<{ v: bigint; prefix: string }[]>`
      update app.number_ranges set next_value = next_value + 1 where key = 'dunning' returning next_value - 1 as v, prefix`;
    await tx`
      insert into app.dunnings (id, number, customer_id, level, issue_date, pay_until, fee_cents, late_fee_cents,
                                total_cents, created_by)
      values (${id}, ${`${n!.prefix}${today.slice(0, 4)}-${String(n!.v).padStart(4, '0')}`}, ${customerId}, ${level}, ${today},
              (${today}::date + ${s.payment_days}::int), ${fee}, ${lateFee}, ${open + fee + lateFee}, ${actor})`;
    await tx`insert into app.dunning_items ${tx(
      items.map((i) => ({
        dunning_id: id,
        invoice_id: i.invoice_id,
        open_cents: i.open_cents,
        days_overdue: i.overdue_days,
        late_fee_cents: lateFees.get(i.invoice_id)!,
      })),
    )}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'create', 'dunning', ${id}, ${tx.json({ level, invoices: items.map((i) => i.number) })})`;
  });
  // PDF sofort erzeugen und unveränderbar ablegen
  const pdf = await renderDunningPdf(sql, id);
  const path = `mahnungen/${today.slice(0, 4)}/${id}.pdf`;
  const { sha256 } = await deps.archive.put(path, pdf.pdf);
  await sql`update app.dunnings set pdf_path = ${path}, pdf_sha256 = ${sha256} where id = ${id} and pdf_path is null`;
  return id;
}

export async function listDunnings(sql: Sql, customerId?: string) {
  return sql<(DunningRow & { customer_name: string; customer_no: string; items: number; title: string })[]>`
    select d.*, c.name as customer_name, c.customer_no, s.title,
           (select count(*)::int from app.dunning_items i where i.dunning_id = d.id) as items
      from app.dunnings d join app.customers c on c.id = d.customer_id
      join app.dunning_settings s on s.level = d.level
     where ${customerId ? sql`d.customer_id = ${customerId}` : sql`true`}
     order by d.created_at desc`;
}

export async function getDunning(sql: Sql, id: string) {
  const [d] = await sql<(DunningRow & { title: string; text: string })[]>`
    select d.*, s.title, s.text from app.dunnings d join app.dunning_settings s on s.level = d.level where d.id = ${id}`;
  if (!d) return undefined;
  const items = await sql<
    {
      invoice_id: string;
      number: string;
      issue_date: string;
      due_date: string;
      open_cents: bigint;
      days_overdue: number;
    }[]
  >`
    select di.invoice_id, i.number, i.issue_date, i.due_date, di.open_cents, di.days_overdue
      from app.dunning_items di
      join (select id, number, issue_date, due_date from app.invoices
            union all select id, number, issue_date, due_date from app.legacy_invoices) i on i.id = di.invoice_id
     where di.dunning_id = ${id} order by i.due_date`;
  return { dunning: d, items };
}

const eur = (c: bigint) => formatEuro(c as Cents);

interface DunningLetter {
  customer_id: string;
  title: string;
  text: string;
  number: string;
  issue_date: string;
  pay_until: string;
  fee_cents: bigint;
  late_fee_cents: bigint;
  total_cents: bigint;
  items: { number: string; issue_date: string; due_date: string; days_overdue: number; open_cents: bigint }[];
}

async function renderDunningLetter(sql: Sql, d: DunningLetter, watermark?: string) {
  const items = d.items;
  const seller = await getSeller(sql);
  const buyer = await buildBuyerSnapshot(sql, d.customer_id, null);
  const open = items.reduce((a, i) => a + i.open_cents, 0n);
  const sums: [string, string][] = [['Offener Rechnungsbetrag', eur(open)]];
  if (d.fee_cents > 0n) sums.push(['Mahngebühr (nicht umsatzsteuerbar)', eur(d.fee_cents)]);
  if (d.late_fee_cents > 0n) {
    const n = Number(d.late_fee_cents / LATE_FEE_CENTS);
    sums.push([`Verzugspauschale${n > 1 ? ` ${n} × ${eur(LATE_FEE_CENTS)}` : ''}`, eur(d.late_fee_cents)]);
  }
  return renderLetterPdf({
    title: d.title,
    date: d.issue_date,
    info: [
      ['Datum', formatDateDe(d.issue_date)],
      ['Kundennummer', buyer.customerNo],
      ['Mahnung Nr.', d.number],
      ...(buyer.leitwegId ? ([['Leitweg-ID', buyer.leitwegId]] as [string, string][]) : []),
    ],
    seller,
    buyer,
    intro: d.text,
    columns: [
      { label: 'Rechnung', x: 62.3, align: 'left' },
      { label: 'Rechnungsdatum', x: 150, align: 'left' },
      { label: 'Fällig am', x: 245, align: 'left' },
      { label: 'Tage überfällig', x: 400 },
      { label: 'Offener Betrag', x: 538.8 },
    ],
    rows: items.map((i) => [
      i.number,
      formatDateDe(i.issue_date),
      formatDateDe(i.due_date),
      String(i.days_overdue),
      eur(i.open_cents),
    ]),
    sums,
    total: ['Zu zahlen', eur(d.total_cents)],
    paragraphs: [
      `Bitte überweisen Sie den Betrag von ${eur(d.total_cents)} bis spätestens ${formatDateDe(d.pay_until)} unter Angabe der Rechnungsnummer(n) auf unser Konto.`,
      ...(d.late_fee_cents > 0n
        ? [
            'Die Verzugspauschale von 40,00 € je Rechnung berechnen wir nach § 288 Abs. 5 BGB; sie ist nicht umsatzsteuerbar.',
          ]
        : []),
      'Haben Sie in den letzten Tagen bereits gezahlt, betrachten Sie dieses Schreiben bitte als gegenstandslos. Bei Fragen zu den Rechnungen erreichen Sie uns jederzeit.',
      'Mit freundlichen Grüßen\nViva-Deluxe Gebäudereinigung GmbH',
    ],
    girocode: watermark
      ? null
      : { amount: d.total_cents, reference: `${d.number} ${items.map((i) => i.number).join(' ')}` },
    ...(watermark ? { watermark } : {}),
  });
}

export async function renderDunningPdf(sql: Sql, id: string): Promise<{ pdf: Uint8Array; filename: string }> {
  const data = await getDunning(sql, id);
  if (!data) throw new BusinessError('Mahnung nicht gefunden');
  const { dunning: d, items } = data;
  const pdf = await renderDunningLetter(sql, { ...d, items });
  return { pdf, filename: `${d.title.replace(/[^\wäöüÄÖÜß.-]+/g, '_')}_${d.number}.pdf` };
}

/**
 * Vorschau (Ahmed 08.10.): Mahnungen, wie sie entstehen würden – gleiche Stufe, Gebühren und Pauschale wie beim
 * Erstellen, aber ohne Nummer, ohne Speichern, mit Wasserzeichen „ENTWURF“. Ein PDF für alle Kunden der Auswahl.
 */
export async function previewDunnings(
  sql: Sql,
  entries: { customerId: string; invoiceIds: string[] }[],
): Promise<Uint8Array> {
  const settings = await getSettings(sql);
  const today = todayBerlin();
  const out = await PDFDocument.create();
  for (const e of entries) {
    const items = (await overdueItems(sql, e.customerId)).filter((i) => e.invoiceIds.includes(i.invoice_id));
    if (!items.length) continue;
    const level = Math.min(3, Math.max(...items.map((i) => i.last_level + 1)));
    const st = settings.find((x) => x.level === level)!;
    const open = items.reduce((a, i) => a + i.open_cents, 0n);
    const lateFeeOn = st.late_fee && !items[0]!.is_consumer;
    const lateFee = items.reduce((a, i) => a + (lateFeeOn && !i.late_fee_charged ? LATE_FEE_CENTS : 0n), 0n);
    const fee = lateFee > 0n || items.some((i) => i.late_fee_charged) ? 0n : st.fee_cents;
    const pay = new Date(`${today}T12:00:00Z`);
    pay.setUTCDate(pay.getUTCDate() + st.payment_days);
    const bytes = await renderDunningLetter(
      sql,
      {
        customer_id: e.customerId,
        title: st.title,
        text: st.text,
        number: 'ENTWURF',
        issue_date: today,
        pay_until: pay.toISOString().slice(0, 10),
        fee_cents: fee,
        late_fee_cents: lateFee,
        total_cents: open + fee + lateFee,
        items: items.map((i) => ({
          number: i.number,
          issue_date: i.issue_date,
          due_date: i.due_date,
          days_overdue: i.overdue_days,
          open_cents: i.open_cents,
        })),
      },
      'ENTWURF',
    );
    const src = await PDFDocument.load(bytes);
    for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
  }
  if (!out.getPageCount()) throw new BusinessError('Keine mahnbaren Rechnungen in der Auswahl');
  return out.save();
}

/** Versand genau einmal: Übernahme per bedingtem Update vor dem SMTP-Versand. */
export async function sendDunning(deps: Deps, id: string, actor: string) {
  const { sql, env } = deps;
  const data = await getDunning(sql, id);
  if (!data) throw new BusinessError('Mahnung nicht gefunden');
  const d = data.dunning;
  if (d.status === 'versendet') return { alreadySent: true, to: d.sent_to ?? [] };
  if (!d.pdf_path) throw new BusinessError('PDF fehlt noch – bitte Seite neu laden');
  if (deps.mailer.configured === false) throw new BusinessError(MAILER_MISSING);
  const [c] = await sql<
    { invoice_emails: string[]; name: string }[]
  >`select invoice_emails, name from app.customers where id = ${d.customer_id}`;
  // Empfänger: Rechnungs-E-Mails der Rechnungsgruppen der gemahnten Rechnungen (sonst die des Kunden)
  const invs = await sql<{ site_id: string | null; invoice_group_id: string | null }[]>`
    select distinct i.site_id, i.invoice_group_id from app.dunning_items di join app.invoices i on i.id = di.invoice_id
     where di.dunning_id = ${id}`;
  const fromGroups = new Set<string>();
  for (const i of invs) {
    // eigene Mahn-E-Mails der Rechnungsgruppe vor den Rechnungs-E-Mails
    const [g] = await sql<{ dunning_emails: string[] | null }[]>`
      select g.dunning_emails from app.invoice_groups g
       where g.id = coalesce(${i.invoice_group_id}::uuid, (select invoice_group_id from app.sites where id = ${i.site_id}))`;
    const list = g?.dunning_emails?.length
      ? g.dunning_emails
      : (await effectiveBilling(sql, d.customer_id, i.site_id, i.invoice_group_id)).emails;
    for (const e of list) fromGroups.add(e);
  }
  c!.invoice_emails = fromGroups.size ? [...fromGroups] : c!.invoice_emails;
  const { actual, redirected } = resolveRecipients(env, c!.invoice_emails);
  const [claimed] =
    await sql`update app.dunnings set status = 'versendet', sent_at = now(), sent_to = ${actual}
                               where id = ${id} and status = 'erstellt' returning id`;
  if (!claimed) return { alreadySent: true, to: [] };
  try {
    const pdf = await deps.archive.get(d.pdf_path);
    const subject = `${redirected ? '[TEST] ' : ''}${d.title} ${d.number} – Viva-Deluxe Gebäudereinigung GmbH`;
    await deps.mailer.send({
      from: env.MAIL_FROM,
      to: actual,
      subject,
      text:
        (redirected
          ? `TESTVERSAND – eigentliche Empfänger: ${c!.invoice_emails.join(', ') || '(keine hinterlegt)'}\n\n`
          : '') +
        `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unser Schreiben ${d.number} (${d.title}) zu offenen Rechnungen über ${eur(d.total_cents)}.\n` +
        `Bitte überweisen Sie den Betrag bis ${formatDateDe(d.pay_until)}.\n\nMit freundlichen Grüßen\nViva-Deluxe Gebäudereinigung GmbH`,
      attachments: [
        {
          filename: `${d.title.replace(/\s+/g, '_')}_${d.number}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        },
      ],
      messageId: `<dunning-${id}@viva-deluxe-app>`,
    });
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'send', 'dunning', ${id}, ${sql.json({ to: actual, redirected })})`;
    return { alreadySent: false, to: actual };
  } catch (err) {
    await sql`update app.dunnings set status = 'erstellt', sent_at = null, sent_to = null where id = ${id}`;
    throw new BusinessError(`Versand fehlgeschlagen: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Stapelverarbeitung (wie Fortytools): alle überfälligen Rechnungen je Kunde, Auswahl, Mahnungen in einem Lauf
// ---------------------------------------------------------------------------

export interface BatchItem extends ProposalItem {
  dunning_count: number;
  /** wählbar: Stufe erreicht, Mindestabstand eingehalten, keine Sperre, nicht schon letzte Stufe */
  eligible: boolean;
  reason: string | null;
}
export interface BatchCustomer {
  customer_id: string;
  customer_no: string;
  customer_name: string;
  dunning_block: boolean;
  open_cents: bigint;
  items: BatchItem[];
}

export async function batchCandidates(sql: Sql): Promise<BatchCustomer[]> {
  const settings = await getSettings(sql);
  const today = todayBerlin();
  const items = await overdueItems(sql);
  const by = new Map<string, BatchCustomer>();
  for (const it of items) {
    const next = Math.min(3, it.last_level + 1);
    const s = settings.find((x) => x.level === next)!;
    let reason: string | null = null;
    if (it.dunning_block) reason = 'Mahnsperre';
    else if (it.last_level >= 3) reason = 'letzte Stufe erreicht';
    else if (it.overdue_days < s.min_days_overdue) reason = `${s.title} ab ${s.min_days_overdue} Tagen`;
    else if (it.last_dunning_date && daysBetween(it.last_dunning_date, today) < MIN_GAP_DAYS)
      reason = `zuletzt gemahnt am ${formatDateDe(it.last_dunning_date)}`;
    const c = by.get(it.customer_id) ?? {
      customer_id: it.customer_id,
      customer_no: it.customer_no,
      customer_name: it.customer_name,
      dunning_block: it.dunning_block,
      open_cents: 0n,
      items: [],
    };
    c.items.push({
      ...it,
      next_level: next,
      dunning_count: it.dunning_count ?? 0,
      eligible: !reason,
      reason,
    });
    c.open_cents += it.open_cents;
    by.set(it.customer_id, c);
  }
  return [...by.values()];
}

export interface BatchResult {
  created: { id: string; customer: string; number: string; sent: string[] | null }[];
  failed: { customer: string; error: string }[];
}

/**
 * Mahnungen für mehrere Kunden in einem Lauf. Feste IDs je Kunde (aus dem Formular) → doppeltes Absenden legt
 * nichts doppelt an. Fehler bei einem Kunden brechen den Lauf nicht ab; sie werden gesammelt gemeldet.
 */
export async function createDunningBatch(
  deps: Deps,
  entries: { id: string; customerId: string; invoiceIds: string[] }[],
  send: boolean,
  actor: string,
): Promise<BatchResult> {
  const result: BatchResult = { created: [], failed: [] };
  const candidates = new Map(
    (await batchCandidates(deps.sql)).flatMap((c) => c.items.map((i) => [i.invoice_id, i] as const)),
  );
  for (const e of entries) {
    if (!e.invoiceIds.length) continue;
    const [c] = await deps.sql<{ name: string }[]>`select name from app.customers where id = ${e.customerId}`;
    const name = c?.name ?? e.customerId;
    try {
      const [exists] = await deps.sql`select 1 from app.dunnings where id = ${e.id}`;
      if (!exists) {
        // serverseitig dieselben Regeln wie in der Auswahl (Stufe erreicht, Mindestabstand, keine Sperre)
        for (const inv of e.invoiceIds) {
          const it = candidates.get(inv);
          if (!it) throw new BusinessError('Rechnung ist nicht (mehr) überfällig oder bereits bezahlt');
          if (!it.eligible)
            throw new BusinessError(`Rechnung ${it.number} ist noch nicht mahnbar (${it.reason})`);
        }
      }
      await createDunning(deps, e.id, e.customerId, e.invoiceIds, actor);
      const [d] = await deps.sql<{ number: string }[]>`select number from app.dunnings where id = ${e.id}`;
      let sent: string[] | null = null;
      if (send) sent = (await sendDunning(deps, e.id, actor)).to;
      result.created.push({ id: e.id, customer: name, number: d!.number, sent });
    } catch (err) {
      if (!(err instanceof BusinessError)) throw err;
      result.failed.push({ customer: name, error: err.message });
    }
  }
  return result;
}
