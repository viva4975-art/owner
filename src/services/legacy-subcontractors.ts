import { createHash } from 'node:crypto';
import { uuidOf } from './fortytools-export-import.js';
import { ensureGeneralSite } from './fortytools-more-import.js';
import { type UploadConfig, storeFile } from './uploads.js';
import type { Deps } from './workflow.js';

/*
 * Nachunternehmer aus der alten App übernehmen: Firmen (Kreditor-Nr. = Lieferantennummer), Ansprechpartner,
 * Nachweise (gleiche Nachweisarten, jede Datei eine Version, als „gültig“ mit dem Ablaufdatum der alten App) und die
 * Auftragsscheine/Scans der alten Aufträge als Dokumente „Verträge“ am Nachunternehmer.
 * Runde 23 (Ahmed: „übernimm alles daraus“): die alten Aufträge werden zusätzlich als Nachunternehmer-Aufträge
 * angelegt. Objekt über die Kostenstelle (Objektnummer, auch 8-stellig wie 20200001 → 2020001), Objektnummern im
 * Objekttext, Adresse/Objektname; sonst Objekt „Allgemein (aus Fortytools)“ des Kunden (Kundennummer in der
 * Kostenstelle). Ohne jeden Treffer bleibt nur das Dokument (Hinweis in der Rückmeldung).
 */

const LEGAL = new Set([
  'einzelunternehmen',
  'kleingewerbe',
  'freiberufler',
  'gbr',
  'ek',
  'ohg',
  'kg',
  'gmbh_co_kg',
  'gmbh',
  'ug',
  'ag',
  'kgaa',
  'eg',
  'sonstige',
]);
const s = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const mime = (p: string) =>
  /\.pdf$/i.test(p) ? 'application/pdf' : /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';

export async function importLegacySubcontractors(
  deps: Deps,
  cfg: UploadConfig,
  data: { subs: Record<string, unknown>[]; orders: Record<string, unknown>[] },
  file: (path: string) => Uint8Array | undefined,
  actor: string,
) {
  const { sql } = deps;
  const types = new Set(
    (await sql<{ id: string }[]>`select id from app.supplier_doc_types`).map((r) => r.id),
  );
  let subs = 0;
  let docs = 0;
  let orderFiles = 0;
  let missing = 0;
  const idOf = new Map<string, string>();
  for (const r of data.subs) {
    const legacy = `sub:${String(r.id)}`;
    const no = s(r.kreditor_nr) ?? s(r.sub_nummer) ?? legacy.slice(0, 20);
    const [byNo] = await sql<{ id: string; legacy_id: string | null }[]>`
      select id, legacy_id from app.suppliers where legacy_id = ${legacy} or supplier_no = ${no} limit 1`;
    let id = byNo?.id;
    if (!id) {
      id = uuidOf(legacy);
      const code = s(r.kuerzel);
      const [codeTaken] = code ? await sql`select 1 from app.suppliers where short_code = ${code}` : [];
      const legal = s(r.rechtsform);
      await sql`insert into app.suppliers ${sql({
        id,
        supplier_no: no,
        name: s(r.firma) ?? '(ohne Name)',
        kind: 'nachunternehmer',
        street: s(r.strasse),
        postal_code: s(r.plz),
        city: s(r.ort),
        email: s(r.email),
        phone: s(r.telefon),
        contact_name: s(r.ansprechpartner),
        legal_form: legal && LEGAL.has(legal) ? legal : null,
        short_code: codeTaken ? null : code,
        terminated_on: iso(r.kuendigung_am),
        termination_reason: s(r.kuendigung_grund),
        active: r.status === 'aktiv',
        notes:
          [s(r.notiz), s(r.sub_nummer) ? `NU-Nr. (alte App): ${s(r.sub_nummer)}` : null]
            .filter(Boolean)
            .join('\n') || null,
        legacy_id: legacy,
      } as never)} on conflict do nothing`;
      subs++;
      for (const [i, c] of (
        (Array.isArray(r.ansprechpartner_liste) ? r.ansprechpartner_liste : []) as Record<string, unknown>[]
      ).entries()) {
        if (!s(c.name)) continue;
        await sql`insert into app.supplier_contacts (id, supplier_id, name, phone, email, is_primary)
                  values (${uuidOf(`${legacy}:ap:${i}`)}, ${id}, ${s(c.name)}, ${s(c.telefon)}, ${s(c.email)}, ${i === 0})
                  on conflict do nothing`;
      }
    } else if (!byNo!.legacy_id)
      await sql`update app.suppliers set legacy_id = ${legacy} where id = ${id} and legacy_id is null`;
    idOf.set(String(r.id), id);
    // Nachweise (aktuelle Datei + frühere Versionen aus „history“)
    for (const [key, d] of Object.entries((r.documents ?? {}) as Record<string, Record<string, unknown>>)) {
      if (!types.has(key) || !d || typeof d !== 'object') continue;
      const versions = [...((Array.isArray(d.history) ? d.history : []) as Record<string, unknown>[]), d];
      for (const v of versions) {
        const fp = s(v.file_path);
        if (!fp) continue;
        const bytes = file(`subdocs/${fp}`);
        if (!bytes) {
          missing++;
          continue;
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        const ext = fp.split('.').pop()?.toLowerCase() ?? 'pdf';
        const path = `nachweise/${sha.slice(0, 2)}/${sha}.${ext}`;
        await deps.archive.put(path, bytes);
        const res = await sql`insert into app.supplier_documents ${sql({
          id: uuidOf(`subdoc:${fp}`),
          supplier_id: id,
          doc_type: key,
          file_name: s(v.file_name) ?? fp.split('/').pop()!,
          content_type: mime(fp),
          path,
          sha256: sha,
          size_bytes: bytes.length,
          valid_until: iso(v.expires) ?? iso(v.gueltig_bis),
          source: 'buero',
          status: 'gueltig',
          reviewed_by: actor,
          reviewed_at: new Date(),
          uploaded_by: actor,
          created_at: v.uploaded_at ? new Date(String(v.uploaded_at)) : new Date(),
        } as never)} on conflict do nothing`;
        docs += res.count;
      }
    }
  }
  // Auftragsscheine und unterschriebene Scans der alten Aufträge → Dokumente „Verträge“
  for (const o of data.orders) {
    const sid = idOf.get(String(o.sub_id));
    if (!sid) continue;
    const label = [s(o.auftragsnummer), s(o.objekt)].filter(Boolean).join(' ').slice(0, 80);
    for (const [kind, p] of [
      ['Auftrag', s(o.pdf_path)],
      ['Auftrag unterschrieben', s(o.scan_path)],
    ] as const) {
      if (!p) continue;
      const bytes = file(`subdocs/${p}`);
      if (!bytes) {
        missing++;
        continue;
      }
      const ext = p.split('.').pop()?.toLowerCase() ?? 'pdf';
      const fid = uuidOf(`suborder:${p}`);
      const [exists] = await sql`select 1 from app.files where id = ${fid}`;
      if (exists) continue;
      await storeFile(
        sql,
        cfg,
        {
          id: fid,
          name: `${kind} ${label}.${ext}`.replace(/[\\/:*?"<>|]/g, '_'),
          type: mime(p),
          data: bytes,
          link: { type: 'supplier', id: sid },
          category: 'Verträge',
        },
        actor,
      );
      orderFiles++;
    }
  }
  const orders = await importLegacyOrders(sql, data.orders, idOf, actor);
  return { subs, docs, orderFiles, missing, ...orders };
}

const normT = (x: string | null) =>
  (x ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

const FREQ: Record<string, string> = {
  einmalig: 'einmalig',
  monatlich: 'monatlich',
  laufend: 'monatlich',
  jaehrlich1: 'jaehrlich',
  jaehrlich2: 'halbjaehrlich',
  jaehrlich3: 'quartalsweise',
  jaehrlich4: 'quartalsweise',
};
const STATUS: Record<string, string> = {
  abgeschlossen: 'beendet',
  offen: 'erteilt',
  aktiv: 'erteilt',
  storniert: 'storniert',
};

/** Euro-Betrag aus JSON-Zahl exakt in Cent (über Text, kein Gleitkomma-Fehler). */
const centsOfNum = (v: unknown): bigint | null => {
  if (v == null || v === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(String(v));
  if (!m) return null;
  return BigInt(m[2]!) * 100n + BigInt((m[3] ?? '0').padEnd(2, '0'));
};

export async function importLegacyOrders(
  sql: Deps['sql'],
  orders: Record<string, unknown>[],
  idOf: Map<string, string>,
  actor: string,
) {
  const sites = await sql<{ id: string; site_no: string; name: string; street: string | null }[]>`
    select id, site_no, name, street from app.sites`;
  const byNo = new Map(sites.map((x) => [x.site_no, x.id]));
  let created = 0;
  let general = 0;
  const unmatched: string[] = [];
  for (const o of orders) {
    const supplierId = idOf.get(String(o.sub_id));
    const number = s(o.auftragsnummer);
    if (!supplierId || !number) continue;
    const id = uuidOf(`suborder-row:${String(o.id)}`);
    const [done] = await sql`select 1 from app.subcontracts where id = ${id} or number = ${number}`;
    if (done) continue;
    const ks = s(o.kostenstelle) ?? '';
    const text = `${ks} ${s(o.objekt) ?? ''}`;
    let siteId: string | null = null;
    for (const tok of text.match(/\d{5,8}/g) ?? []) {
      const t = tok.length === 8 && tok[5] === '0' && !byNo.has(tok) ? tok.slice(0, 5) + tok.slice(6) : tok;
      if (byNo.has(t)) {
        siteId = byNo.get(t)!;
        break;
      }
    }
    if (!siteId) {
      const a = normT(s(o.adresse));
      const ob = normT(s(o.objekt));
      const hs = sites.filter(
        (x) => a && normT(x.street) && (a.includes(normT(x.street)) || normT(x.street).includes(a)),
      );
      if (hs.length === 1) siteId = hs[0]!.id;
      else {
        const hn = sites.filter((x) => ob && normT(x.name) === ob);
        if (hn.length === 1) siteId = hn[0]!.id;
      }
    }
    if (!siteId) {
      const cust = (ks.match(/\b\d{5}\b/) ?? [])[0];
      if (cust) {
        siteId = await ensureGeneralSite(sql, cust, actor);
        if (siteId) general++;
      }
    }
    if (!siteId) {
      unmatched.push(number);
      continue;
    }
    const freq = FREQ[String(o.auftragstyp)] ?? 'einmalig';
    const abr = String(o.abrechnungsart ?? '');
    const total = centsOfNum(o.netto_betrag) ?? 0n;
    const note = s(o.notiz);
    // Stundensatz aus „18 Regiestunden x 25,00 €“, sonst Pauschale
    const rate = /x\s*(\d+(?:[.,]\d{1,2})?)\s*€/i.exec(note ?? '');
    let billing =
      abr === 'pro_std'
        ? 'stunde'
        : abr === 'taeglich'
          ? 'tag'
          : abr === 'monatlich' || (abr === 'pauschale' && freq === 'monatlich')
            ? 'pauschale_monat'
            : 'pauschale_einsatz';
    let price = total;
    if (billing === 'stunde') {
      if (rate) price = centsOfNum(rate[1]!.replace(',', '.')) ?? total;
      else billing = 'pauschale_einsatz';
    }
    const from = iso(o.zeitraum_von) ?? iso(o.erteilt_am) ?? iso(o.created_at) ?? '2026-01-01';
    let to = iso(o.zeitraum_bis);
    const status = STATUS[String(o.status)] ?? 'erteilt';
    if (!to && status === 'beendet') to = iso(o.updated_at);
    if (to && to < from) to = from;
    const meta = (o.objekt_meta ?? {}) as Record<string, unknown>;
    const maxH = typeof meta._max_stunden === 'number' ? meta._max_stunden : null;
    await sql`
      insert into app.subcontracts (id, number, supplier_id, site_id, service_kind, frequency, billing, price_cents,
                                    max_hours_month, valid_from, valid_to, description, note, status, issued_at,
                                    created_by, created_at)
      values (${id}, ${number}, ${supplierId}, ${siteId}, ${s(o.leistungsart) ?? 'Sonstiges'}, ${freq}, ${billing},
              ${price}, ${maxH}, ${from}, ${to},
              ${[s(o.objekt), s(o.adresse)].filter(Boolean).join('\n') || null},
              ${[note, ks ? `Kostenstelle (alte App): ${ks}` : null, 'aus der alten App übernommen'].filter(Boolean).join('\n')},
              ${status}, ${status === 'entwurf' ? null : iso(o.erteilt_am) ? new Date(`${iso(o.erteilt_am)}T12:00:00Z`) : null},
              ${actor}, ${o.created_at ? new Date(String(o.created_at)) : new Date()})
      on conflict do nothing`;
    created++;
  }
  return { orders: created, ordersGeneral: general, ordersUnmatched: unmatched };
}

// ------------------------------------------------------------------ Schriftverkehr und Arbeitskleidung

/** Briefe der alten App als PDF in den Dokumenteneingang (Kategorie „Schriftverkehr (alte App)“). */
export async function importLegacyLetters(
  deps: Deps,
  cfg: UploadConfig,
  rows: Record<string, unknown>[],
  file: (path: string) => Uint8Array | undefined,
  inboxId: string,
  actor: string,
) {
  let n = 0;
  for (const r of rows) {
    const p = s(r.pdf_path);
    if (!p) continue;
    const bytes = file(`schriftverkehr/${p}`);
    if (!bytes) continue;
    const id = uuidOf(`sv:${p}`);
    const [exists] = await deps.sql`select 1 from app.files where id = ${id}`;
    if (exists) continue;
    const name = [s(r.dok_id), s(r.betreff), s(r.empf_name)].filter(Boolean).join(' – ').slice(0, 120);
    await storeFile(
      deps.sql,
      cfg,
      {
        id,
        name: `${name.replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
        type: 'application/pdf',
        data: bytes,
        link: { type: 'inbox', id: inboxId },
        category: 'Schriftverkehr (alte App)',
      },
      actor,
    );
    n++;
  }
  return n;
}

/** Kleiderbestand als Inventur buchen (je Artikel/Größe), Ausgabe-Protokolle an die Personalakte. */
export async function importLegacyClothing(
  deps: Deps,
  cfg: UploadConfig,
  data: {
    stock: Record<string, unknown>[];
    issues: Record<string, unknown>[];
    prices: Record<string, unknown>[];
  },
  file: (path: string) => Uint8Array | undefined,
  inboxId: string,
  actor: string,
) {
  const { sql } = deps;
  const price = new Map(
    data.prices.map((p) => [String(p.artikel ?? '').toLowerCase(), Math.round(Number(p.preis ?? 0) * 100)]),
  );
  let moves = 0;
  let protocols = 0;
  const unmatched: string[] = [];
  for (const r of data.stock) {
    const name = s(r.artikel);
    if (!name) continue;
    const size = s(r.groesse) ?? '';
    let [a] = await sql<{ id: string; sizes: string[] }[]>`
      select id, sizes from app.clothing_articles where lower(name) = lower(${name})`;
    if (!a) {
      const id = uuidOf(`kl-art:${name.toLowerCase()}`);
      await sql`insert into app.clothing_articles (id, name, unit_price_cents, sizes)
                values (${id}, ${name}, ${price.get(name.toLowerCase()) ?? 0}, ${size ? [size] : []}) on conflict do nothing`;
      [a] = await sql<
        { id: string; sizes: string[] }[]
      >`select id, sizes from app.clothing_articles where lower(name) = lower(${name})`;
    }
    if (size && !a!.sizes.includes(size))
      await sql`update app.clothing_articles set sizes = array_append(sizes, ${size}) where id = ${a!.id}`;
    const moveId = uuidOf(`kl-best:${String(r.id)}`);
    const [done] = await sql`select 1 from app.clothing_moves where id = ${moveId}`;
    if (done) continue;
    const [{ qty }] = (await sql`
      select coalesce(sum(delta), 0)::int as qty from app.clothing_moves where article_id = ${a!.id} and size = ${size}`) as unknown as [
      { qty: number },
    ];
    const delta = Math.round(Number(r.bestand ?? 0)) - qty;
    if (delta !== 0) {
      await sql`insert into app.clothing_moves (id, article_id, size, delta, reason, note, created_by)
                values (${moveId}, ${a!.id}, ${size}, ${delta}, 'inventur', 'Bestand aus der alten App', ${actor})`;
      moves++;
    }
  }
  for (const r of data.issues) {
    const p = s(r.pdf_path);
    const no = s(r.personalnummer);
    const [e] = no
      ? await sql<{ id: string }[]>`select id from app.employees where personnel_no = ${no}`
      : [];
    if (!e) unmatched.push(s(r.mitarbeiter_name) ?? '?');
    const bytes = p ? file(`arbeitskleidung/${p}`) : undefined;
    if (!bytes) continue;
    const id = uuidOf(`kl-aus:${p}`);
    const [exists] = await sql`select 1 from app.files where id = ${id}`;
    if (exists) continue;
    await storeFile(
      sql,
      cfg,
      {
        id,
        name: p!.split('/').pop()!,
        type: 'application/pdf',
        data: bytes,
        // ohne Personalnummer-Treffer in den Dokumenteneingang (dort einer Personalakte zuordnen)
        link: e ? { type: 'employee', id: e.id } : { type: 'inbox', id: inboxId },
        category: 'Arbeitskleidung (alte App)',
      },
      actor,
    );
    protocols++;
  }
  return { moves, protocols, unmatched };
}
