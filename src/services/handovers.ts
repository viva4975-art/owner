import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql, Tx } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import type { BuyerSnapshot } from '../domain/invoice/types.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { renderLetterPdf } from '../pdf/invoice-pdf.js';
import { clipInfo } from '../pdf/render.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { keyActionTx } from './inventory.js';
import { getSeller } from './masterdata.js';
import { assertSignaturePng } from './orders.js';
import { nextYearNumber } from './purchasing.js';
import type { Deps } from './workflow.js';

/*
 * Übergaben mit Unterschrift vor Ort: Arbeitskleidung, Schlüssel, Geräte, Dokumente/Unterweisungen, Sonstiges –
 * an Mitarbeitende oder Nachunternehmer. Die Objektleitung legt an und lässt am eigenen Handy/Tablet unterschreiben.
 * Erst mit der Unterschrift (oder „ohne Unterschrift“ mit Grund) wird gebucht: Kleiderbestand, Schlüsselbuch.
 * Danach unveränderbar (DB-Trigger), Protokoll-PDF write-once im Archiv. Rückgabe = eigene Übergabe mit Verweis.
 */

export type HandoverKind = 'kleidung' | 'schluessel' | 'geraet' | 'dokument' | 'sonstiges';
export const HANDOVER_KIND: Record<HandoverKind, string> = {
  kleidung: 'Arbeitskleidung',
  schluessel: 'Schlüssel',
  geraet: 'Geräte / Maschinen',
  dokument: 'Dokument / Unterweisung',
  sonstiges: 'Sonstiges',
};
export type HandoverStatus = 'entwurf' | 'unterschrieben' | 'ohne_unterschrift' | 'storniert';
export const HANDOVER_STATUS: Record<HandoverStatus, string> = {
  entwurf: 'zur Unterschrift',
  unterschrieben: 'unterschrieben',
  ohne_unterschrift: 'ohne Unterschrift',
  storniert: 'storniert',
};
export type Direction = 'ausgabe' | 'rueckgabe';

export interface HandoverItem {
  label: string;
  size?: string;
  qty: number;
  unit_price_cents?: number;
  article_id?: string;
  key_id?: string;
  device_id?: string;
  ppe?: boolean;
}

export interface Handover {
  id: string;
  number: string;
  kind: HandoverKind;
  direction: Direction;
  employee_id: string | null;
  supplier_id: string | null;
  recipient_name: string;
  site_id: string | null;
  handover_date: string;
  title: string;
  items: HandoverItem[];
  body_text: string | null;
  document_name: string | null;
  document_path: string | null;
  document_sha256: string | null;
  wage_deduction: boolean;
  related_id: string | null;
  note: string | null;
  status: HandoverStatus;
  signed_name: string | null;
  signed_at: Date | null;
  signature_path: string | null;
  signature_sha256: string | null;
  issuer_name: string | null;
  no_signature_reason: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  created_by: string;
  created_at: Date;
  version: number;
}
export type HandoverRow = Handover & {
  site_name: string | null;
  site_no: string | null;
  personnel_no: string | null;
  supplier_no: string | null;
  related_number: string | null;
};

/** Erklärungstext je Art und Richtung (steht über der Unterschrift und im PDF). */
export function declaration(kind: HandoverKind, dir: Direction): string {
  if (dir === 'rueckgabe') {
    return kind === 'dokument'
      ? 'Die aufgeführten Unterlagen wurden zurückgegeben.'
      : 'Die aufgeführten Gegenstände wurden vollständig zurückgegeben; Zustand siehe Bemerkung.';
  }
  switch (kind) {
    case 'kleidung':
      return (
        'Ich bestätige den Empfang der aufgeführten Arbeitskleidung. Ich trage sie während der Arbeit, behandle sie ' +
        'pfleglich und gebe sie bei Ende des Arbeitsverhältnisses gereinigt zurück.'
      );
    case 'schluessel':
      return (
        'Ich bestätige den Empfang der aufgeführten Schlüssel/Transponder. Ich bewahre sie sorgfältig auf, gebe sie ' +
        'nicht an Dritte weiter, lasse keine Nachschlüssel anfertigen und melde einen Verlust sofort der Objektleitung. ' +
        'Bei Ende meines Einsatzes im Objekt gebe ich sie zurück.'
      );
    case 'geraet':
      return (
        'Ich bestätige den Empfang der aufgeführten Geräte in ordnungsgemäßem Zustand und die Einweisung in die ' +
        'Bedienung. Schäden und Störungen melde ich sofort; die Geräte nutze ich nur für dienstliche Zwecke.'
      );
    case 'dokument':
      return 'Ich habe das Dokument erhalten, gelesen und verstanden.';
    case 'sonstiges':
      return 'Ich bestätige den Empfang der aufgeführten Gegenstände.';
  }
}

/** Lohnabzug nur ausdrücklich, nur Kleidung, nie für persönliche Schutzausrüstung (§ 3 Abs. 3 ArbSchG). */
export const WAGE_DEDUCTION_TEXT =
  'Vereinbarung: Gebe ich die oben aufgeführte Arbeitskleidung bei Ende des Arbeitsverhältnisses nicht zurück, darf ' +
  'der angegebene Wert (höchstens der Zeitwert) mit meinem Lohn verrechnet werden – nur im Rahmen der ' +
  'Pfändungsfreigrenzen (§ 394 BGB, § 850c ZPO), der gesetzliche Mindestlohn bleibt unberührt. Persönliche ' +
  'Schutzausrüstung ist ausgenommen.';

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

const SELECT = (sql: Sql) => sql`
  select h.*, s.name as site_name, s.site_no, e.personnel_no, sp.supplier_no, r.number as related_number
    from app.handovers h
    left join app.sites s on s.id = h.site_id
    left join app.employees e on e.id = h.employee_id
    left join app.suppliers sp on sp.id = h.supplier_id
    left join app.handovers r on r.id = h.related_id`;

export async function listHandovers(
  sql: Sql,
  f: {
    scope: string[] | null;
    kind?: HandoverKind | null;
    status?: HandoverStatus | null;
    employeeId?: string | null;
    supplierId?: string | null;
    q?: string | null;
  },
) {
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  return sql<HandoverRow[]>`
    ${SELECT(sql)}
     where (${f.scope === null} or h.site_id = any(${f.scope ?? []}::uuid[]))
       and (${f.kind ?? null}::text is null or h.kind = ${f.kind ?? null})
       and (${f.status ?? null}::text is null or h.status = ${f.status ?? null})
       and (${f.employeeId ?? null}::uuid is null or h.employee_id = ${f.employeeId ?? null})
       and (${f.supplierId ?? null}::uuid is null or h.supplier_id = ${f.supplierId ?? null})
       and (${q}::text is null or h.recipient_name ilike ${q} or h.title ilike ${q} or h.number ilike ${q})
     order by h.handover_date desc, h.number desc
     limit 500`;
}

export async function getHandover(sql: Sql, id: string) {
  const [h] = await sql<HandoverRow[]>`${SELECT(sql)} where h.id = ${id}`;
  return h;
}

/** Was hat jemand derzeit? Schlüssel laut Schlüsselbuch, Kleidung = Ausgaben − Rückgaben (abgeschlossene Übergaben). */
export async function holdings(sql: Sql, employeeId: string) {
  const keys = await sql<
    { id: string; key_no: string; description: string; site_name: string; issued_at: string }[]
  >`
    select k.id, k.key_no, k.description, s.name as site_name, k.issued_at
      from app.keys k join app.sites s on s.id = k.site_id
     where k.holder_employee_id = ${employeeId} order by k.key_no`;
  const clothing = await sql<
    { article_id: string; name: string; size: string; qty: number; unit_price_cents: bigint }[]
  >`
    select (i ->> 'article_id')::uuid as article_id, a.name, coalesce(i ->> 'size', '') as size,
           sum(case when h.direction = 'ausgabe' then 1 else -1 end * (i ->> 'qty')::int)::int as qty,
           a.unit_price_cents
      from app.handovers h, jsonb_array_elements(h.items) i, app.clothing_articles a
     where h.employee_id = ${employeeId} and h.kind = 'kleidung'
       and h.status in ('unterschrieben', 'ohne_unterschrift')
       and a.id = (i ->> 'article_id')::uuid
     group by 1, 2, 3, 5 having sum(case when h.direction = 'ausgabe' then 1 else -1 end * (i ->> 'qty')::int) > 0
     order by 2, 3`;
  const devices = await sql<{ device_id: string; label: string }[]>`
    select (i ->> 'device_id') as device_id, max(i ->> 'label') as label
      from app.handovers h, jsonb_array_elements(h.items) i
     where h.employee_id = ${employeeId} and h.kind = 'geraet' and h.status in ('unterschrieben', 'ohne_unterschrift')
       and i ? 'device_id'
     group by 1 having sum(case when h.direction = 'ausgabe' then 1 else -1 end) > 0`;
  return { keys, clothing, devices };
}

// ---------------------------------------------------------------------------
// Anlegen / Bearbeiten (nur Entwurf)
// ---------------------------------------------------------------------------

export interface HandoverInput {
  kind: HandoverKind;
  direction: Direction;
  employeeId: string | null;
  supplierId: string | null;
  recipientName: string | null;
  siteId: string | null;
  date: string;
  title: string | null;
  items: HandoverItem[];
  bodyText: string | null;
  wageDeduction: boolean;
  relatedId: string | null;
  note: string | null;
  issuerName: string | null;
  document?: { name: string; data: Uint8Array } | null;
  version?: number | null;
}

function defaultTitle(kind: HandoverKind, dir: Direction) {
  return `${dir === 'rueckgabe' ? 'Rückgabe' : 'Ausgabe'} ${HANDOVER_KIND[kind]}`;
}

export async function saveHandover(deps: Deps, id: string, p: HandoverInput, actor: string) {
  const { sql } = deps;
  if (!(p.kind in HANDOVER_KIND)) throw new BusinessError('Unbekannte Art');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Bitte Datum angeben');
  if (p.date > todayBerlin()) throw new BusinessError('Datum liegt in der Zukunft');
  if (p.employeeId && p.supplierId)
    throw new BusinessError('Bitte entweder Mitarbeiter oder Nachunternehmer wählen');

  let recipient = p.recipientName?.trim() || '';
  if (p.employeeId) {
    const [e] = await sql<{ first_name: string; last_name: string }[]>`
      select first_name, last_name from app.employees where id = ${p.employeeId}`;
    if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
    recipient = `${e.first_name} ${e.last_name}`;
  } else if (p.supplierId) {
    const [s] = await sql<{ name: string }[]>`select name from app.suppliers where id = ${p.supplierId}`;
    if (!s) throw new BusinessError('Nachunternehmer nicht gefunden');
    recipient = recipient ? `${recipient} (${s.name})` : s.name;
  }
  if (!recipient) throw new BusinessError('Bitte Empfänger wählen');
  if (!p.employeeId && !p.supplierId && p.kind !== 'sonstiges')
    throw new BusinessError('Bitte Mitarbeiter oder Nachunternehmer wählen');
  if (p.kind === 'schluessel' && !p.employeeId)
    throw new BusinessError(
      'Schlüssel werden im Schlüsselbuch je Mitarbeiter geführt – bitte Mitarbeiter wählen',
    );
  if (p.kind === 'schluessel' && !p.siteId) throw new BusinessError('Bitte Objekt wählen');

  const items = await normalizeItems(sql, p);
  if (p.kind !== 'dokument' && !items.length)
    throw new BusinessError('Bitte mindestens eine Position angeben');
  if (p.wageDeduction) {
    if (p.kind !== 'kleidung' || p.direction !== 'ausgabe' || !p.employeeId)
      throw new BusinessError(
        'Lohnabzug-Vereinbarung gibt es nur bei der Ausgabe von Arbeitskleidung an Mitarbeitende',
      );
    if (items.some((i) => i.ppe))
      throw new BusinessError(
        'Persönliche Schutzausrüstung (z. B. Sicherheitsschuhe, Warnweste) zahlt der Arbeitgeber (§ 3 Abs. 3 ArbSchG) – ' +
          'bitte ohne Lohnabzug-Vereinbarung ausgeben oder PSA in eine eigene Übergabe legen',
      );
  }
  if (p.relatedId) {
    const [r] = await sql<{ status: HandoverStatus; direction: Direction }[]>`
      select status, direction from app.handovers where id = ${p.relatedId}`;
    if (!r || r.direction !== 'ausgabe') throw new BusinessError('Bezug: Ausgabe nicht gefunden');
  }

  let doc: { name: string; path: string; sha256: string } | null = null;
  if (p.document) {
    const head = new TextDecoder().decode(p.document.data.slice(0, 5));
    if (head !== '%PDF-') throw new BusinessError('Bitte ein PDF hochladen');
    if (p.document.data.byteLength > 20 * 1024 * 1024) throw new BusinessError('PDF ist größer als 20 MB');
    await PDFDocument.load(p.document.data, { updateMetadata: false }).catch(() => {
      throw new BusinessError('PDF ist beschädigt oder verschlüsselt');
    });
    const sha = createHash('sha256').update(p.document.data).digest('hex');
    const path = `uebergaben/dokumente/${sha}.pdf`;
    await deps.archive.put(path, p.document.data); // inhaltsadressiert: gleiche Datei = kein Fehler
    doc = { name: p.document.name.slice(0, 200), path, sha256: sha };
  }

  await sql.begin(async (tx) => {
    const [cur] = await tx<Handover[]>`select * from app.handovers where id = ${id} for update`;
    assertVersion(cur?.version, p.version, 'Die Übergabe');
    if (cur && cur.status !== 'entwurf')
      throw new BusinessError('Abgeschlossene Übergaben sind unveränderbar');
    const title = p.title?.trim() || defaultTitle(p.kind, p.direction);
    const docName = doc?.name ?? cur?.document_name ?? null;
    const docPath = doc?.path ?? cur?.document_path ?? null;
    const docSha = doc?.sha256 ?? cur?.document_sha256 ?? null;
    if (p.kind === 'dokument' && !docPath && !p.bodyText?.trim())
      throw new BusinessError('Bitte PDF hochladen oder den Text der Unterweisung eingeben');
    const row = {
      kind: p.kind,
      direction: p.direction,
      employee_id: p.employeeId,
      supplier_id: p.supplierId,
      recipient_name: recipient,
      site_id: p.siteId,
      handover_date: p.date,
      title,
      items: tx.json(items as never),
      body_text: p.bodyText?.trim() || null,
      document_name: docName,
      document_path: docPath,
      document_sha256: docSha,
      wage_deduction: p.wageDeduction,
      related_id: p.relatedId,
      note: p.note?.trim() || null,
      issuer_name: p.issuerName?.trim() || null,
    };
    if (cur) {
      await tx`update app.handovers set ${tx(row)} where id = ${id}`;
    } else {
      const number = await nextYearNumber(tx, 'handover', 'UE-', p.date.slice(0, 4), 4);
      await tx`insert into app.handovers ${tx({ id, number, created_by: actor, ...row })}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id)
             values (${actor}, ${cur ? 'update' : 'create'}, 'handover', ${id})`;
  });
}

async function normalizeItems(sql: Sql, p: HandoverInput): Promise<HandoverItem[]> {
  const out: HandoverItem[] = [];
  for (const raw of p.items) {
    const qty = Math.trunc(Number(raw.qty));
    if (p.kind === 'kleidung') {
      if (!raw.article_id) continue;
      if (!(qty > 0 && qty <= 99)) throw new BusinessError('Menge je Position zwischen 1 und 99');
      const [a] = await sql<{ name: string; unit_price_cents: bigint; is_ppe: boolean; sizes: string[] }[]>`
        select name, unit_price_cents, is_ppe, sizes from app.clothing_articles where id = ${raw.article_id}`;
      if (!a) throw new BusinessError('Artikel nicht gefunden');
      const size = (raw.size ?? '').trim();
      if (a.sizes.length && !a.sizes.includes(size))
        throw new BusinessError(`${a.name}: Bitte Größe wählen (${a.sizes.join(', ')})`);
      out.push({
        label: a.name,
        size,
        qty,
        unit_price_cents: Number(a.unit_price_cents),
        article_id: raw.article_id,
        ppe: a.is_ppe,
      });
    } else if (p.kind === 'schluessel') {
      if (!raw.key_id) continue;
      const [k] = await sql<{ key_no: string; description: string; site_id: string; quantity: number }[]>`
        select key_no, description, site_id, quantity from app.keys where id = ${raw.key_id}`;
      if (!k) throw new BusinessError('Schlüssel nicht gefunden');
      if (k.site_id !== p.siteId)
        throw new BusinessError(`Schlüssel ${k.key_no} gehört zu einem anderen Objekt`);
      out.push({ label: `${k.key_no} – ${k.description}`, qty: k.quantity, key_id: raw.key_id });
    } else if (p.kind === 'geraet' && raw.device_id) {
      const [d] = await sql<{ inventory_no: string; name: string; site_id: string | null }[]>`
        select inventory_no, name, site_id from app.devices where id = ${raw.device_id}`;
      if (!d) throw new BusinessError('Gerät nicht gefunden');
      out.push({ label: `${d.inventory_no} – ${d.name}`, qty: 1, device_id: raw.device_id });
    } else {
      const label = raw.label?.trim();
      if (!label) continue;
      if (!(qty > 0 && qty <= 9999)) throw new BusinessError(`${label}: Menge fehlt`);
      out.push({ label: label.slice(0, 120), ...(raw.size?.trim() ? { size: raw.size.trim() } : {}), qty });
    }
  }
  const ids = out.map((i) => i.key_id ?? i.device_id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new BusinessError('Ein Schlüssel/Gerät ist doppelt aufgeführt');
  return out;
}

export async function deleteDraft(sql: Sql, id: string, actor: string) {
  const res = await sql`delete from app.handovers where id = ${id} and status = 'entwurf' returning id`;
  if (res.length)
    await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'delete', 'handover', ${id})`;
}

// ---------------------------------------------------------------------------
// Abschluss: Unterschrift oder ohne Unterschrift → Buchungen in einer Transaktion
// ---------------------------------------------------------------------------

const moveId = (handoverId: string, i: number) => {
  const h = createHash('md5').update(`handover-move:${handoverId}:${i}`).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};

async function applyEffects(tx: Tx, h: Handover, actor: string) {
  if (h.kind === 'kleidung') {
    const sign = h.direction === 'ausgabe' ? -1 : 1;
    let i = 0;
    for (const it of h.items) {
      await tx`insert into app.clothing_moves (id, article_id, size, delta, reason, handover_id, note, created_by)
               values (${moveId(h.id, i++)}, ${it.article_id!}, ${it.size ?? ''}, ${sign * it.qty},
                       ${h.direction}, ${h.id}, ${`${h.number} ${h.recipient_name}`}, ${actor})
               on conflict (id) do nothing`;
    }
  }
  if (h.kind === 'schluessel') {
    for (const it of h.items) {
      if (!it.key_id) continue;
      if (h.direction === 'rueckgabe') {
        const [k] = await tx<{ holder_employee_id: string | null; key_no: string }[]>`
          select holder_employee_id, key_no from app.keys where id = ${it.key_id}`;
        if (k?.holder_employee_id !== h.employee_id)
          throw new BusinessError(
            `Schlüssel ${k?.key_no ?? ''} ist laut Schlüsselbuch nicht bei ${h.recipient_name}`,
          );
      }
      await keyActionTx(
        tx,
        it.key_id,
        h.direction,
        h.employee_id,
        h.handover_date,
        `Übergabe ${h.number}`,
        actor,
      );
    }
  }
}

async function finish(deps: Deps, id: string, actor: string, set: (tx: Tx, h: Handover) => Promise<boolean>) {
  const done = await deps.sql.begin(async (tx) => {
    const [h] = await tx<Handover[]>`select * from app.handovers where id = ${id} for update`;
    if (!h) throw new BusinessError('Übergabe nicht gefunden');
    if (h.status !== 'entwurf') return false; // doppelt gesendet → nichts doppelt buchen
    if (h.kind !== 'dokument' && !h.items.length) throw new BusinessError('Keine Positionen');
    await applyEffects(tx, h, actor);
    return set(tx, h);
  });
  if (done) await archivePdf(deps, id);
}

export async function signHandover(
  deps: Deps,
  id: string,
  p: { name: string; png: Uint8Array },
  actor: string,
) {
  if (!p.name.trim()) throw new BusinessError('Bitte Namen des Unterzeichners angeben');
  assertSignaturePng(p.png);
  const [h] = await deps.sql<{ number: string; handover_date: string; status: string }[]>`
    select number, handover_date, status from app.handovers where id = ${id}`;
  if (!h) throw new BusinessError('Übergabe nicht gefunden');
  if (h.status !== 'entwurf') return;
  const path = `uebergaben/${h.handover_date.slice(0, 4)}/${h.number}/unterschrift-${randomUUID()}.png`;
  const { sha256 } = await deps.archive.put(path, p.png);
  await finish(deps, id, actor, async (tx) => {
    await tx`update app.handovers set status = 'unterschrieben', signed_name = ${p.name.trim()}, signed_at = now(),
                    signature_path = ${path}, signature_sha256 = ${sha256} where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'sign', 'handover', ${id}, ${tx.json({ signed_by: p.name.trim(), sha256 })})`;
    return true;
  });
}

export async function closeHandoverWithoutSignature(deps: Deps, id: string, reason: string, actor: string) {
  if (!reason.trim())
    throw new BusinessError('Bitte Grund angeben (z. B. „Mitarbeiter verweigert Unterschrift“)');
  await finish(deps, id, actor, async (tx) => {
    await tx`update app.handovers set status = 'ohne_unterschrift', no_signature_reason = ${reason.trim()} where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'close_unsigned', 'handover', ${id}, ${tx.json({ reason: reason.trim() })})`;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Protokoll-PDF
// ---------------------------------------------------------------------------

async function recipientSnapshot(sql: Sql, h: Handover): Promise<BuyerSnapshot> {
  let street = '';
  let postalCode = '';
  let city = '';
  let no = '';
  if (h.employee_id) {
    const [e] = await sql<
      { personnel_no: string; street: string | null; postal_code: string | null; city: string | null }[]
    >`
      select e.personnel_no, p.street, p.postal_code, p.city
        from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${h.employee_id}`;
    no = e?.personnel_no ?? '';
    street = e?.street ?? '';
    postalCode = e?.postal_code ?? '';
    city = e?.city ?? '';
  } else if (h.supplier_id) {
    const [s] = await sql<
      { supplier_no: string; street: string | null; postal_code: string | null; city: string | null }[]
    >`
      select supplier_no, street, postal_code, city from app.suppliers where id = ${h.supplier_id}`;
    no = s?.supplier_no ?? '';
    street = s?.street ?? '';
    postalCode = s?.postal_code ?? '';
    city = s?.city ?? '';
  }
  return {
    customerNo: no,
    name: h.recipient_name,
    name2: null,
    street,
    postalCode,
    city,
    countryCode: 'DE',
    vatId: null,
    leitwegId: null,
    supplierNo: null,
    email: null,
    contactName: null,
    site: null,
  };
}

export async function renderHandoverPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const { sql } = deps;
  const h = await getHandover(sql, id);
  if (!h) throw new BusinessError('Übergabe nicht gefunden');
  const seller = await getSeller(sql);
  const buyer = await recipientSnapshot(sql, h);
  const png = h.signature_path ? await deps.archive.get(h.signature_path) : null;
  const withValue = h.kind === 'kleidung';
  const total = h.items.reduce((s, i) => s + BigInt(i.unit_price_cents ?? 0) * BigInt(i.qty), 0n);
  const isReturn = h.direction === 'rueckgabe';
  const protocol = await renderLetterPdf({
    title: `${isReturn ? 'Rückgabeprotokoll' : 'Übergabeprotokoll'} ${h.number}`,
    date: h.handover_date,
    info: [
      ['Datum', formatDateDe(h.handover_date)],
      ['Art', HANDOVER_KIND[h.kind]],
      ...(h.site_name
        ? ([
            ['Objekt', clipInfo(h.site_name)],
            ['Objekt-Nr.', h.site_no],
          ] as [string, string][])
        : []),
      ...(h.personnel_no ? ([['Personalnr.', h.personnel_no]] as [string, string][]) : []),
      ...(h.related_number ? ([['zu Ausgabe', h.related_number]] as [string, string][]) : []),
    ],
    seller,
    buyer,
    greeting: null,
    intro: [h.title, declaration(h.kind, h.direction)].join('\n'),
    columns: [
      { label: 'Pos', x: 62.3, align: 'left' },
      { label: 'Gegenstand', x: 90, align: 'left' },
      { label: 'Größe', x: withValue ? 380 : 450 },
      { label: 'Menge', x: withValue ? 440 : 538.8 },
      ...(withValue ? [{ label: 'Wert', x: 538.8 }] : []),
    ],
    rows: h.items.map((i, n) => [
      String(n + 1),
      `${i.label}${i.ppe ? ' (PSA)' : ''}`.slice(0, withValue ? 44 : 56),
      i.size ?? '',
      String(i.qty),
      ...(withValue ? [formatEuro((BigInt(i.unit_price_cents ?? 0) * BigInt(i.qty)) as Cents)] : []),
    ]),
    sums: [],
    total: withValue && total > 0n ? ['Gesamtwert', formatEuro(total as Cents)] : null,
    paragraphs: [
      ...(h.document_name
        ? [
            `Dokument: ${h.document_name} (SHA-256 ${h.document_sha256!.slice(0, 16)}…) – liegt diesem Protokoll bei.`,
          ]
        : []),
      ...(h.body_text ? [h.body_text] : []),
      ...(h.wage_deduction ? [WAGE_DEDUCTION_TEXT] : []),
      ...(h.items.some((i) => i.ppe)
        ? ['Persönliche Schutzausrüstung (PSA) wird kostenlos gestellt (§ 3 Abs. 3 ArbSchG).']
        : []),
      ...(h.note ? [`Bemerkung: ${h.note}`] : []),
      ...(h.issuer_name ? [`${isReturn ? 'Entgegengenommen' : 'Übergeben'} durch: ${h.issuer_name}`] : []),
      ...(h.status === 'ohne_unterschrift'
        ? [`Ohne Unterschrift abgeschlossen: ${h.no_signature_reason}`]
        : []),
    ],
    signature:
      h.status === 'unterschrieben'
        ? {
            label: isReturn ? 'Rückgabe bestätigt:' : 'Erhalten:',
            png,
            name: h.signed_name ?? '',
            at:
              h.signed_at!.toLocaleString('de-DE', {
                timeZone: 'Europe/Berlin',
                dateStyle: 'medium',
                timeStyle: 'short',
              }) + ' Uhr',
          }
        : h.status === 'entwurf'
          ? { label: isReturn ? 'Rückgabe bestätigt:' : 'Erhalten:', png: null, name: 'Name, Datum', at: '' }
          : null,
    ...(h.status === 'entwurf' ? { watermark: 'ENTWURF' } : {}),
  });
  if (!h.document_path) return protocol;
  // Dokument + Protokoll in einer Datei (Nachweis, was genau unterschrieben wurde)
  const out = await PDFDocument.load(protocol, { updateMetadata: false });
  const original = await PDFDocument.load(await deps.archive.get(h.document_path), { updateMetadata: false });
  const pages = await out.copyPages(original, original.getPageIndices());
  pages.forEach((pg, i) => out.insertPage(i, pg));
  return out.save();
}

async function archivePdf(deps: Deps, id: string) {
  const [h] = await deps.sql<{ number: string; handover_date: string; pdf_path: string | null }[]>`
    select number, handover_date, pdf_path from app.handovers where id = ${id}`;
  if (!h || h.pdf_path) return;
  const pdf = await renderHandoverPdf(deps, id);
  const path = `uebergaben/${h.handover_date.slice(0, 4)}/${h.number}/Protokoll_${h.number}.pdf`;
  const { sha256 } = await deps.archive.put(path, pdf);
  await deps.sql`update app.handovers set pdf_path = ${path}, pdf_sha256 = ${sha256} where id = ${id} and pdf_path is null`;
}

export async function handoverPdf(deps: Deps, id: string): Promise<Uint8Array> {
  const [h] = await deps.sql<
    { pdf_path: string | null }[]
  >`select pdf_path from app.handovers where id = ${id}`;
  if (!h) throw new BusinessError('Übergabe nicht gefunden');
  return h.pdf_path ? deps.archive.get(h.pdf_path) : renderHandoverPdf(deps, id);
}

// ---------------------------------------------------------------------------
// Arbeitskleidung: Artikel und Bestand
// ---------------------------------------------------------------------------

export interface ClothingArticle {
  id: string;
  name: string;
  unit_price_cents: bigint;
  is_ppe: boolean;
  sizes: string[];
  min_stock: number;
  active: boolean;
  version: number;
}

export async function listArticles(sql: Sql, activeOnly = true) {
  return sql<ClothingArticle[]>`
    select * from app.clothing_articles where (${!activeOnly} or active) order by name`;
}

/** Bestand je Artikel + Größe (alle Größen des Artikels, auch 0). */
export async function stock(sql: Sql) {
  return sql<
    { article_id: string; name: string; size: string; qty: number; min_stock: number; is_ppe: boolean }[]
  >`
    with sz as (
      select a.id, a.name, a.min_stock, a.is_ppe, unnest(case when cardinality(a.sizes) = 0 then array[''] else a.sizes end) as size
        from app.clothing_articles a where a.active
    ), mv as (
      select article_id, size, sum(delta)::int as qty from app.clothing_moves group by 1, 2
    )
    select sz.id as article_id, sz.name, sz.size, coalesce(mv.qty, 0)::int as qty, sz.min_stock, sz.is_ppe
      from sz left join mv on mv.article_id = sz.id and mv.size = sz.size
    union all
    select mv.article_id, a.name, mv.size, mv.qty, a.min_stock, a.is_ppe
      from mv join app.clothing_articles a on a.id = mv.article_id
     where a.active and not (mv.size = any(case when cardinality(a.sizes) = 0 then array[''] else a.sizes end))
    order by 2, 3`;
}

export async function bookStock(
  sql: Sql,
  p: {
    id: string;
    articleId: string;
    size: string;
    delta: number;
    reason: 'zugang' | 'korrektur' | 'inventur';
    note: string | null;
  },
  actor: string,
) {
  if (!Number.isInteger(p.delta) || p.delta === 0 || Math.abs(p.delta) > 9999)
    throw new BusinessError('Bitte Menge angeben (z. B. 10 oder −2)');
  if (p.reason === 'zugang' && p.delta < 0) throw new BusinessError('Zugang muss positiv sein');
  if (p.reason !== 'zugang' && !p.note?.trim())
    throw new BusinessError('Bei Korrektur/Inventur bitte Grund angeben');
  await sql`insert into app.clothing_moves (id, article_id, size, delta, reason, note, created_by)
            values (${p.id}, ${p.articleId}, ${p.size}, ${p.delta}, ${p.reason}, ${p.note?.trim() || null}, ${actor})
            on conflict (id) do nothing`;
}

export async function saveArticle(
  sql: Sql,
  id: string,
  p: {
    name: string;
    priceCents: bigint;
    isPpe: boolean;
    sizes: string[];
    minStock: number;
    active: boolean;
    version?: number | null;
  },
  actor: string,
) {
  if (!p.name.trim()) throw new BusinessError('Bitte Bezeichnung angeben');
  await sql
    .begin(async (tx) => {
      const [cur] = await tx<
        ClothingArticle[]
      >`select * from app.clothing_articles where id = ${id} for update`;
      assertVersion(cur?.version, p.version, 'Der Artikel');
      const row = {
        name: p.name.trim(),
        unit_price_cents: p.priceCents,
        is_ppe: p.isPpe,
        sizes: p.sizes.map((s) => s.trim()).filter(Boolean),
        min_stock: Math.max(0, Math.trunc(p.minStock)),
        active: p.active,
      };
      if (cur) await tx`update app.clothing_articles set ${tx(row)} where id = ${id}`;
      else await tx`insert into app.clothing_articles ${tx({ id, ...row })}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id)
             values (${actor}, ${cur ? 'update' : 'create'}, 'clothing_article', ${id})`;
    })
    .catch((e: { code?: string }) => {
      if (e.code === '23505') throw new BusinessError('Diesen Artikel gibt es schon');
      throw e;
    });
}

export async function articleMoves(sql: Sql, articleId: string) {
  return sql<
    {
      size: string;
      delta: number;
      reason: string;
      note: string | null;
      created_by: string;
      created_at: Date;
      handover_id: string | null;
    }[]
  >`
    select size, delta, reason, note, created_by, created_at, handover_id
      from app.clothing_moves where article_id = ${articleId} order by created_at desc limit 300`;
}
