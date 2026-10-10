import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { buildBuyerSnapshot, getSeller } from './masterdata.js';
import { storeFile, type UploadConfig } from './uploads.js';
import {
  CYCLE_LABEL,
  CYCLE_MONTHS,
  type BillingCycle,
  formatDateDe,
  isPeriodic,
  todayBerlin,
} from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Preisanpassung bei Tariflohnerhöhung (Ahmed 08.10.: „nicht bei jedem gleich wegen dem Lohnkostenanteil“):
 * je Leistung neuer Preis = alt + alt × Lohnkostenanteil × Lohnerhöhung (kaufmännisch auf Cent gerundet).
 * Übernahme ab einem Monatsersten: alte Leistung endet am Vortag, Kopie mit neuem Preis ab Stichtag (feste ID je
 * Leistung + Stichtag → doppelt absenden ändert nichts doppelt). Rechtlich nur zulässig, wenn der Vertrag eine
 * Preisgleitklausel enthält oder der Kunde zustimmt – das prüft das Büro vor dem Anschreiben.
 */

const fmtPct = (bp: number) => `${(bp / 100).toFixed(2).replace('.', ',')} %`;
const fmtEuro = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${(a % 100n).toString().padStart(2, '0')}`;
  return `${neg ? '-' : ''}${s} €`;
};

/**
 * alt + alt × Lohnanteil × Lohnerhöhung + alt × (1 − Lohnanteil) × Sachkostenerhöhung (alles Basispunkte),
 * einmal am Ende half-up weg von 0 gerundet.
 */
export function adjustedPrice(price: bigint, laborBp: number, raiseBp: number, otherBp = 0): bigint {
  const num = price * (BigInt(laborBp) * BigInt(raiseBp) + BigInt(10000 - laborBp) * BigInt(otherBp));
  const den = 100_000_000n;
  const abs = num < 0n ? -num : num;
  let inc = abs / den;
  if ((abs % den) * 2n >= den) inc += 1n;
  return price + (num < 0n ? -inc : inc);
}

/** wirksame Preiserhöhung in Basispunkten, z. B. 80 % × 5 % = 4,00 %; mit Sachkosten 20 % × 3 % = +0,60 % */
export const effectiveBp = (laborBp: number, raiseBp: number, otherBp = 0) =>
  Math.round((laborBp * raiseBp + (10000 - laborBp) * otherBp) / 10000);

export interface AdjRow {
  id: string;
  site_id: string;
  site_no: string;
  site_name: string;
  customer_id: string;
  customer_no: string;
  customer_name: string;
  description: string;
  type_name: string | null;
  billing_cycle: BillingCycle;
  kind: string;
  quantity_milli: bigint;
  unit_price_cents: bigint;
  labor_share_bp: number | null;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
  /** verwendeter Lohnanteil (hinterlegt oder angenommen) */
  used_labor_bp: number | null;
  labor_assumed: boolean;
  /** berechnet */
  new_price_cents: bigint | null;
  /** Grund, warum nicht anpassbar */
  blocked: string | null;
}

export interface AdjFilter {
  from: string;
  raiseBp: number;
  /** Erhöhung der übrigen Kosten (Material, Sachkosten …) in Basispunkten */
  otherBp?: number;
  /** angenommener Lohnanteil für Leistungen ohne hinterlegten Anteil (null = nicht anpassbar) */
  defaultLaborBp?: number | null;
  customerId?: string | null;
  serviceTypeId?: string | null;
}

const monthIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

export function checkFrom(from: string) {
  if (!/^\d{4}-\d{2}-01$/.test(from)) throw new BusinessError('Stichtag muss ein Monatserster sein');
}

/** Leistungen, die am Stichtag laufen und vorher begonnen haben (Kandidaten der Anpassung). */
export async function adjustmentCandidates(sql: Sql, f: AdjFilter): Promise<AdjRow[]> {
  checkFrom(f.from);
  const rows = await sql<Omit<AdjRow, 'new_price_cents' | 'blocked' | 'used_labor_bp' | 'labor_assumed'>[]>`
    select ss.id, ss.site_id, s.site_no, s.name as site_name, c.id as customer_id, c.customer_no,
           c.name as customer_name, ss.description, t.name as type_name, ss.billing_cycle, ss.kind, ss.quantity_milli,
           ss.unit_price_cents, ss.labor_share_bp, ss.valid_from::text, ss.valid_to::text, ss.note
      from app.site_services ss
      join app.sites s on s.id = ss.site_id
      join app.customers c on c.id = s.customer_id
      left join app.service_types t on t.id = ss.service_type_id
     where ss.active and s.active and c.active and not coalesce(c.is_internal, false)
       and (ss.valid_to is null or ss.valid_to >= ${f.from})
       and ${f.customerId ? sql`c.id = ${f.customerId}` : sql`true`}
       and ${f.serviceTypeId ? sql`ss.service_type_id = ${f.serviceTypeId}` : sql`true`}
       and not exists (select 1 from app.price_adjustment_items i where i.new_service_id = ss.id
                         and ss.valid_from = ${f.from})
     order by c.name, s.site_no, ss.sort_order, ss.description`;
  const def = f.defaultLaborBp ?? null;
  return rows.map((r) => {
    const used = r.labor_share_bp ?? def;
    let blocked: string | null = null;
    if (used == null) blocked = 'Lohnkostenanteil fehlt';
    else if (r.valid_from >= f.from) blocked = 'beginnt erst am/nach dem Stichtag – Preis direkt ändern';
    else if (r.unit_price_cents <= 0n) blocked = 'kein Preis';
    else if (r.kind === 'monthly_flat' && isPeriodic(r.billing_cycle)) {
      const n = CYCLE_MONTHS[r.billing_cycle];
      if (n > 1 && (monthIdx(f.from) - monthIdx(r.valid_from)) % n !== 0)
        blocked = `Stichtag liegt mitten im Abrechnungszeitraum (${r.billing_cycle}) – Preis von Hand ändern`;
    }
    return {
      ...r,
      blocked,
      used_labor_bp: used,
      labor_assumed: r.labor_share_bp == null && used != null,
      new_price_cents:
        used != null ? adjustedPrice(r.unit_price_cents, used, f.raiseBp, f.otherBp ?? 0) : null,
    };
  });
}

/** Zusatztext wie Fortytools: „3.099,86 € + 4,00 % Tariflohnerhöhung ab 01.01.2027“ (alte Zeile wird ersetzt). */
export function adjustedNote(
  note: string | null,
  oldPrice: bigint,
  effBp: number,
  from: string,
  withOther = false,
) {
  const lines = (note ?? '')
    .split('\n')
    .filter((l) => l.trim() && !/(Tariflohnerhöhung|Preisanpassung) ab/i.test(l));
  lines.push(
    `${fmtEuro(oldPrice)} + ${fmtPct(effBp)} ${withOther ? 'Preisanpassung' : 'Tariflohnerhöhung'} ab ${formatDateDe(from)}`,
  );
  return lines.join('\n');
}

export async function applyPriceAdjustment(
  sql: Sql,
  p: {
    runId: string;
    from: string;
    raiseBp: number;
    otherBp?: number;
    otherLabel?: string | null;
    defaultLaborBp?: number | null;
    serviceIds: string[];
    noteText: boolean;
    actor: string;
  },
): Promise<{ changed: number; skipped: string[] }> {
  checkFrom(p.from);
  const otherBp = p.otherBp ?? 0;
  const def = p.defaultLaborBp ?? null;
  if (!(p.raiseBp >= 0 && p.raiseBp <= 5000)) throw new BusinessError('Lohnerhöhung bitte in % (0–50)');
  if (!(otherBp >= 0 && otherBp <= 5000)) throw new BusinessError('Sachkostenerhöhung bitte in % (0–50)');
  if (p.raiseBp === 0 && otherBp === 0) throw new BusinessError('Bitte eine Erhöhung angeben');
  if (def != null && !(def >= 0 && def <= 10000))
    throw new BusinessError('Angenommener Lohnanteil bitte in % (0–100)');
  if (!p.serviceIds.length) throw new BusinessError('Keine Leistung ausgewählt');
  const skipped: string[] = [];
  let changed = 0;
  await sql.begin(async (tx) => {
    await tx`insert into app.price_adjustments (id, effective_from, raise_bp, other_raise_bp, other_label,
                                                default_labor_bp, created_by)
             values (${p.runId}, ${p.from}, ${p.raiseBp}, ${otherBp}, ${p.otherLabel || null}, ${def}, ${p.actor})
             on conflict (id) do nothing`;
    const [run] = await tx<
      { effective_from: string; raise_bp: number; other_raise_bp: number; default_labor_bp: number | null }[]
    >`select effective_from::text, raise_bp, other_raise_bp, default_labor_bp
        from app.price_adjustments where id = ${p.runId}`;
    if (
      run!.effective_from !== p.from ||
      run!.raise_bp !== p.raiseBp ||
      run!.other_raise_bp !== otherBp ||
      run!.default_labor_bp !== def
    )
      throw new BusinessError('Dieser Lauf wurde schon mit anderen Werten gespeichert – Seite neu laden');
    const cand = new Map(
      (
        await adjustmentCandidates(tx as unknown as Sql, {
          from: p.from,
          raiseBp: p.raiseBp,
          otherBp,
          defaultLaborBp: def,
        })
      ).map((r) => [r.id, r]),
    );
    for (const sid of p.serviceIds) {
      const newId = uuidOf(`preisanpassung:${sid}:${p.from}`);
      const [done] = await tx`select 1 from app.site_services where id = ${newId}`;
      if (done) continue; // schon angepasst (doppelt abgeschickt)
      const r = cand.get(sid);
      if (!r) {
        skipped.push(`${sid}: nicht (mehr) anpassbar`);
        continue;
      }
      if (r.blocked || r.new_price_cents == null || r.used_labor_bp == null) {
        skipped.push(`${r.site_no} · ${r.description}: ${r.blocked}`);
        continue;
      }
      const eff = effectiveBp(r.used_labor_bp, p.raiseBp, otherBp);
      const note = p.noteText ? adjustedNote(r.note, r.unit_price_cents, eff, p.from, otherBp > 0) : r.note;
      await tx`update app.site_services set valid_to = ${addDays(p.from, -1)}, updated_at = now() where id = ${sid}`;
      await tx`
        insert into app.site_services
        select (jsonb_populate_record(null::app.site_services,
          to_jsonb(s) || jsonb_build_object('id', ${newId}::uuid, 'unit_price_cents', ${r.new_price_cents}::bigint,
            'valid_from', ${p.from}::date, 'valid_to', ${r.valid_to}::date, 'note', ${note}::text, 'version', 1,
            'created_at', now(), 'updated_at', now()))).*
          from app.site_services s where s.id = ${sid}`;
      await tx`insert into app.price_adjustment_items (adjustment_id, old_service_id, new_service_id, customer_id,
                 labor_share_bp, old_price_cents, new_price_cents, labor_assumed)
               values (${p.runId}, ${sid}, ${newId}, ${r.customer_id}, ${r.used_labor_bp}, ${r.unit_price_cents},
                       ${r.new_price_cents}, ${r.labor_assumed})`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${p.actor}, 'price_adjustment', 'site_service', ${sid},
                       ${tx.json({ new: newId, from: p.from, old: String(r.unit_price_cents), neu: String(r.new_price_cents), raise_bp: p.raiseBp, other_bp: otherBp, labor_bp: r.used_labor_bp, assumed: r.labor_assumed })})`;
      changed++;
    }
  });
  return { changed, skipped };
}

export async function listAdjustments(sql: Sql) {
  return sql<
    {
      id: string;
      effective_from: string;
      raise_bp: number;
      other_raise_bp: number;
      other_label: string | null;
      default_labor_bp: number | null;
      created_by: string;
      created_at: Date;
      items: number;
      customers: number;
      old_sum: bigint;
      new_sum: bigint;
    }[]
  >`
    select a.id, a.effective_from::text, a.raise_bp, a.other_raise_bp, a.other_label, a.default_labor_bp,
           a.created_by, a.created_at,
           count(i.*)::int as items, count(distinct i.customer_id)::int as customers,
           coalesce(sum(i.old_price_cents), 0)::bigint as old_sum, coalesce(sum(i.new_price_cents), 0)::bigint as new_sum
      from app.price_adjustments a left join app.price_adjustment_items i on i.adjustment_id = a.id
     group by a.id order by a.created_at desc`;
}

export async function adjustmentItems(sql: Sql, runId: string, customerId?: string) {
  return sql<
    {
      customer_id: string;
      customer_no: string;
      customer_name: string;
      site_no: string;
      site_name: string;
      description: string;
      billing_cycle: BillingCycle;
      labor_share_bp: number;
      old_price_cents: bigint;
      new_price_cents: bigint;
    }[]
  >`
    select c.id as customer_id, c.customer_no, c.name as customer_name, s.site_no, s.name as site_name,
           ss.description, ss.billing_cycle, i.labor_share_bp, i.old_price_cents, i.new_price_cents
      from app.price_adjustment_items i
      join app.site_services ss on ss.id = i.new_service_id
      join app.sites s on s.id = ss.site_id
      join app.customers c on c.id = i.customer_id
     where i.adjustment_id = ${runId} and ${customerId ? sql`c.id = ${customerId}` : sql`true`}
     order by c.name, s.site_no, ss.description`;
}

export { fmtEuro as formatEuroText, fmtPct as formatPercent };

/** Anschreiben an einen Kunden: Leistungen mit bisherigem und neuem Preis (netto). */
export async function renderAdjustmentLetter(
  sql: Sql,
  runId: string,
  customerId: string,
): Promise<Uint8Array> {
  const [run] = await sql<
    { effective_from: string; raise_bp: number; other_raise_bp: number; other_label: string | null }[]
  >`
    select effective_from::text, raise_bp, other_raise_bp, other_label from app.price_adjustments where id = ${runId}`;
  if (!run) throw new BusinessError('Preisanpassung nicht gefunden');
  const otherName = run.other_label?.trim() || 'Material- und Sachkosten';
  const items = await adjustmentItems(sql, runId, customerId);
  if (!items.length) throw new BusinessError('Für diesen Kunden gibt es in diesem Lauf keine Anpassung');
  const oldSum = items.reduce((a, i) => a + i.old_price_cents, 0n);
  const newSum = items.reduce((a, i) => a + i.new_price_cents, 0n);
  const from = formatDateDe(run.effective_from);
  return renderLetterPdf({
    title: 'Preisanpassung',
    date: todayBerlin(),
    info: [
      ['Datum', formatDateDe(todayBerlin())],
      ['Kundennr.', items[0]!.customer_no],
      ['gültig ab', from],
    ],
    seller: await getSeller(sql),
    buyer: await buildBuyerSnapshot(sql, customerId, null),
    intro:
      (run.raise_bp > 0
        ? `durch die Erhöhung des allgemeinverbindlichen Tariflohns im Gebäudereiniger-Handwerk um ${fmtPct(run.raise_bp)} ` +
          `steigen unsere Lohnkosten` +
          (run.other_raise_bp > 0
            ? `, zudem sind die ${otherName} um ${fmtPct(run.other_raise_bp)} gestiegen. `
            : '. ') +
          `Entsprechend dem Lohnkostenanteil der jeweiligen Leistung passen wir die Preise `
        : `durch gestiegene ${otherName} (${fmtPct(run.other_raise_bp)}) passen wir die Preise entsprechend dem ` +
          `Kostenanteil der jeweiligen Leistung `) +
      `ab dem ${from} wie folgt an (Beträge netto zzgl. gesetzlicher Umsatzsteuer):`,
    columns: [
      { label: 'Objekt / Leistung', x: 62.3, align: 'left' },
      { label: 'Lohnanteil', x: 380 },
      { label: 'bisher', x: 460 },
      { label: `ab ${from}`, x: 538.8 },
    ],
    rows: items.map((i) => [
      `${i.site_name} (${i.site_no}) – ${i.description} (${CYCLE_LABEL[i.billing_cycle]})`.slice(0, 70),
      fmtPct(i.labor_share_bp),
      fmtEuro(i.old_price_cents),
      fmtEuro(i.new_price_cents),
    ]),
    sums: [
      ['Summe bisher', fmtEuro(oldSum)],
      ['Summe neu', fmtEuro(newSum)],
    ],
    total: ['Veränderung', fmtEuro(newSum - oldSum)],
    paragraphs: [
      (run.other_raise_bp > 0
        ? `Lohnanteil und übrige Kosten (${otherName}) wurden getrennt angepasst. `
        : 'Die Anpassung betrifft ausschließlich den Lohnanteil; Material- und sonstige Kosten bleiben unverändert. ') +
        'Gerne erläutern wir Ihnen die Berechnung im Einzelnen.',
      'Wir bedanken uns für die vertrauensvolle Zusammenarbeit.',
      'Mit freundlichen Grüßen',
      'Viva-Deluxe Gebäudereinigung GmbH',
    ],
  });
}

/** Alle Anschreiben eines Laufs als ein PDF; jedes zusätzlich write-once in der Kundenakte (Schriftverkehr). */
export async function adjustmentLetters(
  sql: Sql,
  cfg: UploadConfig,
  runId: string,
  actor: string,
): Promise<Uint8Array> {
  const customers = [...new Set((await adjustmentItems(sql, runId)).map((i) => i.customer_id))];
  if (!customers.length) throw new BusinessError('Keine angepassten Leistungen in diesem Lauf');
  const out = await PDFDocument.create();
  for (const id of customers) {
    const pdf = await renderAdjustmentLetter(sql, runId, id);
    await storeFile(
      sql,
      cfg,
      {
        id: uuidOf(`preisanpassung-brief:${runId}:${id}`),
        name: `Preisanpassung_${todayBerlin()}.pdf`,
        type: 'application/pdf',
        data: pdf,
        link: { type: 'customer', id },
        category: 'Schriftverkehr',
      },
      actor,
    );
    const one = await PDFDocument.load(pdf);
    for (const pg of await out.copyPages(one, one.getPageIndices())) out.addPage(pg);
  }
  out.setTitle('Preisanpassung');
  return out.save({ useObjectStreams: false });
}

/** Laufende Leistungen ohne Lohnkostenanteil (Pflichtfeld seit 08.10.; Altbestand/Import nachtragen). */
export async function servicesWithoutLaborShare(sql: Sql) {
  return sql<
    {
      id: string;
      site_id: string;
      site_no: string;
      site_name: string;
      customer_name: string;
      description: string;
      type_name: string | null;
      type_labor_bp: number | null;
      unit_price_cents: bigint;
      version: number;
    }[]
  >`
    select ss.id, s.id as site_id, s.site_no, s.name as site_name, c.name as customer_name, ss.description,
           t.name as type_name, t.labor_share_bp as type_labor_bp, ss.unit_price_cents, ss.version
      from app.site_services ss
      join app.sites s on s.id = ss.site_id
      join app.customers c on c.id = s.customer_id
      left join app.service_types t on t.id = ss.service_type_id
     where ss.active and s.active and ss.labor_share_bp is null and not coalesce(c.is_internal, false)
       and (ss.valid_to is null or ss.valid_to >= (now() at time zone 'Europe/Berlin')::date)
     order by c.name, s.site_no, ss.description`;
}

/** Lohnkostenanteile gesammelt nachtragen (nur leere Felder, mit Protokoll). */
export async function setLaborShares(sql: Sql, values: { id: string; bp: number }[], actor: string) {
  let n = 0;
  await sql.begin(async (tx) => {
    for (const v of values) {
      if (!Number.isInteger(v.bp) || v.bp < 0 || v.bp > 10000)
        throw new BusinessError('Lohnkostenanteil bitte in % (0–100)');
      const r = await tx`update app.site_services set labor_share_bp = ${v.bp}, updated_at = now()
                          where id = ${v.id} and labor_share_bp is null returning id`;
      if (r.length) {
        n++;
        await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
                 values (${actor}, 'labor_share', 'site_service', ${v.id}, ${tx.json({ bp: v.bp })})`;
      }
    }
  });
  return n;
}
