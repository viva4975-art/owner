import { strFromU8, unzipSync } from 'fflate';
import type { Sql } from '../db/client.js';
import { unescapeXml } from '../domain/xml.js';
import { BusinessError } from './errors.js';
import { keyActionTx, nextKeyNo } from './inventory.js';
import { uuidFrom } from './photo-stamp.js';

/**
 * Schlüsselübergabeprotokoll (Word, Vorlage der App/Objektordner) einlesen: Kopf (Mitarbeiter, Personal-Nr., Datum)
 * und Tabelle „Nr. | Ort | Art | Anzahl | Kennung“. Jede Zeile wird ein Schlüssel im Schlüsselbuch beim Objekt
 * (Objektnummer in „Ort“) und gleich an den Mitarbeiter ausgegeben. Das Protokoll liegt danach beim Mitarbeiter
 * (Kategorie „Schlüssel“) und bei jedem betroffenen Objekt. Feste IDs → erneut einlesen legt nichts doppelt an.
 */

export interface KeyProtocolRow {
  nr: string;
  ort: string;
  art: string;
  qty: number;
  kennung: string;
}
export interface KeyProtocol {
  employeeName: string | null;
  personnelNo: string | null;
  date: string | null; // JJJJ-MM-TT
  rows: KeyProtocolRow[];
}

const cellText = (xml: string) =>
  unescapeXml(
    [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map((p) => [...p[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
      .join(' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const deDate = (s: string) => {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
};

export function parseKeyProtocol(data: Uint8Array): KeyProtocol {
  let xml: string;
  try {
    const f = unzipSync(data, { filter: (x) => x.name === 'word/document.xml' })['word/document.xml'];
    if (!f) throw new Error();
    xml = strFromU8(f);
  } catch {
    throw new BusinessError('Keine Word-Datei (.docx)');
  }
  if (/<!DOCTYPE/i.test(xml)) throw new BusinessError('Datei abgelehnt (DOCTYPE)');
  const out: KeyProtocol = { employeeName: null, personnelNo: null, date: null, rows: [] };
  for (const tbl of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
    const rows = [...tbl[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
      [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => cellText(c[0])),
    );
    const head = rows[0]?.map((h) => h.toLowerCase()) ?? [];
    const iOrt = head.findIndex((h) => h === 'ort' || h.startsWith('objekt'));
    const iKen = head.findIndex((h) => h.startsWith('kennung') || h.includes('nummer'));
    if (iOrt >= 0 && iKen >= 0 && head.some((h) => h === 'art')) {
      const iNr = head.findIndex((h) => h.startsWith('nr'));
      const iArt = head.findIndex((h) => h === 'art');
      const iQty = head.findIndex((h) => h.startsWith('anzahl'));
      for (const r of rows.slice(1)) {
        const ort = r[iOrt] ?? '';
        const kennung = r[iKen] ?? '';
        if (!ort && !kennung) continue;
        out.rows.push({
          nr: (iNr >= 0 ? r[iNr] : '') || String(out.rows.length + 1),
          ort,
          art: (iArt >= 0 ? r[iArt] : '') || 'Schlüssel',
          qty: Math.max(1, parseInt((iQty >= 0 ? r[iQty] : '') || '1', 10) || 1),
          kennung,
        });
      }
      continue;
    }
    for (const r of rows) {
      const [k, v] = [(r[0] ?? '').toLowerCase(), r[1] ?? ''];
      if (!v) continue;
      if (k === 'mitarbeiter' || k === 'mitarbeiterin' || k === 'name') out.employeeName = v;
      else if (k.startsWith('personal')) out.personnelNo = v.replace(/\D/g, '') || null;
      else if (k.includes('datum der übergabe') || k === 'datum') out.date = deDate(v);
    }
  }
  if (!out.date) {
    const m = /München, den (\d{1,2}\.\d{1,2}\.\d{4})/.exec(cellText(xml));
    if (m) out.date = deDate(m[1]!);
  }
  if (!out.rows.length)
    throw new BusinessError('Keine Schlüsseltabelle gefunden (Spalten Ort, Art, Kennung)');
  return out;
}

/** Objektnummer im Ort: „Büro INT-BUERO“, „Wilhelmsgymnasium2010021“, „20186001“. */
export function siteNoCandidates(ort: string): string[] {
  const c = [...ort.matchAll(/[A-Z]{2,}-[A-Z0-9-]+|\d{5,}/g)].map((m) => m[0]);
  return c.length ? c : [ort.trim()];
}

export interface KeyProtocolPlan {
  proto: KeyProtocol;
  employee: { id: string; name: string; personnel_no: string | null } | null;
  rows: (KeyProtocolRow & {
    site: { id: string; site_no: string; name: string } | null;
    keyId: string | null;
    status: 'neu' | 'vorhanden' | 'schon_bei_ihm' | 'bei_anderem' | 'kein_objekt';
    note: string | null;
  })[];
}

export const protocolKeyId = (employeeId: string, siteId: string, nr: string, kennung: string) =>
  uuidFrom(`schluesselprotokoll:${employeeId}:${siteId}:${nr}:${kennung}`);

export async function planKeyProtocol(
  sql: Sql,
  proto: KeyProtocol,
  employeeId: string,
  sites: string[] | null,
): Promise<KeyProtocolPlan> {
  const [employee] = await sql<{ id: string; name: string; personnel_no: string | null }[]>`
    select id, first_name || ' ' || last_name as name, personnel_no from app.employees where id = ${employeeId}`;
  const all = await sql<{ id: string; site_no: string; name: string }[]>`
    select id, site_no, name from app.sites`;
  const bySiteNo = new Map(all.map((s) => [s.site_no.toUpperCase(), s]));
  const rows: KeyProtocolPlan['rows'] = [];
  for (const r of proto.rows) {
    const site =
      siteNoCandidates(r.ort)
        .map((n) => bySiteNo.get(n.toUpperCase()))
        .find(Boolean) ?? null;
    if (!site || !employee || (sites && !sites.includes(site.id))) {
      rows.push({
        ...r,
        site: null,
        keyId: null,
        status: 'kein_objekt',
        note: `Objekt „${r.ort}“ nicht gefunden – Zeile wird nicht übernommen`,
      });
      continue;
    }
    const desc = `${r.art}: ${r.kennung}`;
    const fixed = protocolKeyId(employee.id, site.id, r.nr, r.kennung);
    // Schon eingelesen (feste ID) oder vorher von Hand mit gleicher Beschreibung erfasst
    const [k] = await sql<
      { id: string; holder_employee_id: string | null; holder_supplier_id: string | null }[]
    >`
      select id, holder_employee_id, holder_supplier_id from app.keys
       where (id = ${fixed} and deleted_at is null) or (site_id = ${site.id} and deleted_at is null and lower(description) in (lower(${desc}), lower(${r.kennung})))
       order by (id = ${fixed}) desc limit 1`;
    const status: KeyProtocolPlan['rows'][number]['status'] = !k
      ? 'neu'
      : k.holder_employee_id === employee.id
        ? 'schon_bei_ihm'
        : k.holder_employee_id || k.holder_supplier_id
          ? 'bei_anderem'
          : 'vorhanden';
    rows.push({
      ...r,
      site,
      keyId: k?.id ?? fixed,
      status,
      note:
        status === 'bei_anderem'
          ? 'Schlüssel ist bei jemand anderem ausgegeben – zuerst Rückgabe buchen'
          : status === 'schon_bei_ihm'
            ? 'bereits ausgegeben'
            : null,
    });
  }
  return { proto, employee: employee ?? null, rows };
}

/**
 * Übernimmt alle übernehmbaren Zeilen in einer Transaktion und verknüpft das (schon write-once abgelegte) Protokoll
 * mit dem Mitarbeiter und den Objekten.
 */
export async function importKeyProtocol(
  sql: Sql,
  p: { employeeId: string; fileId: string; data: Uint8Array; sites: string[] | null },
  actor: string,
) {
  const proto = parseKeyProtocol(p.data);
  const plan = await planKeyProtocol(sql, proto, p.employeeId, p.sites);
  if (!plan.employee) throw new BusinessError('Mitarbeiter nicht gefunden');
  if (proto.personnelNo && plan.employee.personnel_no && proto.personnelNo !== plan.employee.personnel_no)
    throw new BusinessError(
      `Protokoll gehört zu Personal-Nr. ${proto.personnelNo}, nicht zu ${plan.employee.personnel_no}`,
    );
  const at = proto.date ?? new Date().toISOString().slice(0, 10);
  let created = 0;
  let issued = 0;
  const siteIds = new Set<string>();
  await sql.begin(async (tx) => {
    for (const r of plan.rows) {
      if (!r.site || !r.keyId) continue;
      siteIds.add(r.site.id);
      if (r.status === 'neu') {
        const keyNo = await nextKeyNo(tx, r.site.id);
        await tx`insert into app.keys (id, key_no, site_id, description, quantity, notes)
                 values (${r.keyId}, ${keyNo}, ${r.site.id}, ${`${r.art}: ${r.kennung}`}, ${r.qty},
                         ${`aus Übergabeprotokoll vom ${at.split('-').reverse().join('.')} (Nr. ${r.nr})`})
                 on conflict (id) do nothing`;
        created++;
      }
      if (r.status === 'neu' || r.status === 'vorhanden') {
        await keyActionTx(tx, r.keyId, 'ausgabe', plan.employee!.id, at, 'Übergabeprotokoll (Word)', actor);
        issued++;
      }
    }
    await tx`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
             values (${p.fileId}, 'employee', ${plan.employee!.id}, 'Schlüssel', ${actor}) on conflict do nothing`;
    for (const sid of siteIds)
      await tx`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
               values (${p.fileId}, 'site', ${sid}, 'Schlüssel', ${actor}) on conflict do nothing`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'key_protocol', 'employee', ${plan.employee!.id},
                     ${tx.json({ file_id: p.fileId, created, issued, sites: [...siteIds] })})`;
  });
  return {
    created,
    issued,
    skipped: plan.rows.filter((r) => r.status === 'kein_objekt' || r.status === 'bei_anderem').length,
    sites: siteIds.size,
  };
}
