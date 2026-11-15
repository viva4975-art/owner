import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { BusinessError } from './errors.js';
import { getSupplier } from './inventory.js';
import { getSeller } from './masterdata.js';
import { attnLine, FREQUENCY } from './subcontractors.js';
import { storeFile } from './uploads.js';

/*
 * Einzelne Bestellung an einen Nachunternehmer kündigen (Ahmed 15.11.) – die Zusammenarbeit bleibt, nur dieser Auftrag
 * endet zum Datum. Kündigungsschreiben als PDF (Briefpapier), write-once beim Nachunternehmer unter Dokumente
 * „Schriftverkehr“. Zurücknehmen stellt Ende und Status wieder her (das Schreiben bleibt im Archiv).
 */

export async function cancelSubcontract(
  deps: { sql: Sql; filesDir: string; maxBytes: number },
  id: string,
  p: { date: string; reason: string | null; reasonInLetter: boolean; note: string | null },
  actor: string,
) {
  const { sql } = deps;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date))
    throw new BusinessError('Bitte das Datum angeben, zu dem gekündigt wird');
  const [sc] = await sql<
    {
      number: string;
      status: string;
      valid_from: string;
      valid_to: string | null;
      cancelled_on: string | null;
      supplier_id: string;
    }[]
  >`select number, status, valid_from::text, valid_to::text, cancelled_on::text, supplier_id
      from app.subcontracts where id = ${id}`;
  if (!sc) throw new BusinessError('Bestellung nicht gefunden');
  if (sc.cancelled_on) throw new BusinessError(`Bestellung ${sc.number} ist schon gekündigt`);
  if (sc.status !== 'erteilt')
    throw new BusinessError('Kündigen geht nur bei erteilten Bestellungen (Entwurf: stornieren)');
  if (p.date < sc.valid_from) throw new BusinessError('Kündigungsdatum liegt vor dem Beginn der Bestellung');
  const today = todayBerlin();
  await sql.begin(async (tx) => {
    await tx`
      update app.subcontracts
         set cancel_prev_valid_to = valid_to, cancel_prev_status = status,
             valid_to = case when valid_to is null or valid_to > ${p.date}::date then ${p.date}::date else valid_to end,
             status = case when ${p.date}::date < ${today}::date then 'beendet' else status end,
             cancelled_on = ${p.date}, cancel_reason = ${p.reason?.trim() || null}, cancelled_at = now(),
             cancelled_by = ${actor}
       where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'cancel', 'subcontract', ${id},
                     ${tx.json({ date: p.date, reason: p.reason, valid_to_alt: sc.valid_to, status_alt: sc.status })})`;
  });
  const pdf = await cancellationPdf(sql, id, { reasonInLetter: p.reasonInLetter, note: p.note });
  const f = await storeFile(
    sql,
    { dir: deps.filesDir, maxBytes: deps.maxBytes },
    {
      id: randomUUID(),
      name: `Kuendigung_${sc.number}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link: { type: 'supplier', id: sc.supplier_id },
      category: 'Schriftverkehr',
    },
    actor,
  );
  await sql`update app.subcontracts set cancel_file_id = ${f.id} where id = ${id}`;
  return f.id;
}

export async function revokeCancellation(sql: Sql, id: string, actor: string) {
  const [sc] = await sql<{ cancelled_on: string | null; number: string }[]>`
    select cancelled_on::text, number from app.subcontracts where id = ${id}`;
  if (!sc?.cancelled_on) throw new BusinessError('Keine Kündigung erfasst');
  await sql.begin(async (tx) => {
    await tx`
      update app.subcontracts
         set valid_to = cancel_prev_valid_to, status = coalesce(cancel_prev_status, status),
             cancelled_on = null, cancel_reason = null, cancelled_at = null, cancelled_by = null,
             cancel_prev_valid_to = null, cancel_prev_status = null
       where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'cancel_revoke', 'subcontract', ${id}, ${tx.json({ number: sc.number })})`;
  });
}

/** Kündigungsschreiben einer Bestellung. */
export async function cancellationPdf(
  sql: Sql,
  id: string,
  o: { reasonInLetter: boolean; note: string | null },
) {
  const [sc] = await sql<
    {
      number: string;
      supplier_id: string;
      service_kind: string;
      frequency: string;
      valid_from: string;
      issued_at: Date | null;
      cancelled_on: string | null;
      cancel_reason: string | null;
      site_no: string;
      site_name: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
      n_sites: number;
    }[]
  >`
    select sc.number, sc.supplier_id, sc.service_kind, sc.frequency, sc.valid_from::text, sc.issued_at,
           sc.cancelled_on::text, sc.cancel_reason, s.site_no, s.name as site_name, s.street, s.postal_code, s.city,
           (select count(*)::int from app.subcontract_sites x where x.subcontract_id = sc.id) as n_sites
      from app.subcontracts sc join app.sites s on s.id = sc.site_id where sc.id = ${id}`;
  if (!sc?.cancelled_on) throw new BusinessError('Keine Kündigung erfasst');
  const s = await getSupplier(sql, sc.supplier_id);
  if (!s) throw new BusinessError('Nachunternehmer nicht gefunden');
  const issued = sc.issued_at
    ? formatDateDe(sc.issued_at.toISOString().slice(0, 10))
    : formatDateDe(sc.valid_from);
  const objekt =
    sc.n_sites > 1 ? `Sammelbestellung (${sc.n_sites} Objekte)` : `${sc.site_name} (${sc.site_no})`;
  return renderLetterPdf({
    title: `Kündigung der Bestellung ${sc.number}`,
    date: todayBerlin(),
    info: [
      ['Bestellung', sc.number],
      ['Lieferanten-Nr.', s.supplier_no],
    ],
    seller: await getSeller(sql),
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
    objekt:
      sc.n_sites > 1
        ? { title: objekt }
        : {
            title: objekt,
            address:
              [sc.street, [sc.postal_code, sc.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') ||
              null,
          },
    intro:
      `hiermit kündigen wir unsere Bestellung ${sc.number} vom ${issued} ` +
      `(${sc.service_kind}, ${FREQUENCY[sc.frequency] ?? sc.frequency}) fristgerecht zum ${formatDateDe(sc.cancelled_on)}, ` +
      'hilfsweise zum nächstmöglichen Termin.',
    columns: [],
    rows: [],
    sums: [],
    total: null,
    paragraphs: [
      ...(o.reasonInLetter && sc.cancel_reason ? [`Grund: ${sc.cancel_reason}`] : []),
      ...(o.note?.trim() ? [o.note.trim()] : []),
      'Die Zusammenarbeit im Übrigen sowie andere Bestellungen bleiben davon unberührt.',
      'Bitte geben Sie überlassene Schlüssel, Zugangskarten und Arbeitsmittel für dieses Objekt bis zum ' +
        `${formatDateDe(sc.cancelled_on)} zurück und rechnen Sie Leistungen bis zu diesem Tag ab.`,
      'Mit freundlichen Grüßen',
    ],
    signature: null,
  });
}
