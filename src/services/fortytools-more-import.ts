/**
 * Weitere Fortytools-Exporte (Runde 23): Artikel (items.csv) und erfasste Zeiten (Zeiten.csv).
 *
 * - Artikel: Nummer, Name, Beschreibung, Hersteller-Nr., EK, VK, Bestand. Fortytools lässt negativen Bestand zu –
 *   bei uns nicht (Bestand nie negativ) → negativer Bestand wird als 0 übernommen, Hinweis „Inventur“.
 *   Bestand wird als Buchung „Übernahme aus Fortytools“ gesetzt (Bestandsbuchungen sind nur anhängbar).
 * - Zeiten: je Zeile eine freigegebene Zeit (Quelle Büro, Hinweis „aus Fortytools“ + Link zum Servicebericht).
 *   Mitarbeiter über Personalnummer, Objekt über Kundennummer + Objektname. Bestimmte Personalnummern lassen sich
 *   ausschließen (Ahmed: Zeiten von 1013 nicht übernehmen). Überschneidungen mit vorhandenen Zeiten → übersprungen.
 *   Daraus abgeleitet: wiederkehrende Einsätze (wöchentlich) für Mitarbeiter + Objekt + Wochentag + Beginn, die im
 *   Export mindestens zweimal vorkommen – gültig ab dem Tag nach der letzten Zeit im Export.
 * Feste IDs aus dem Inhalt → erneut importieren legt nichts doppelt an.
 */
import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { readSheet } from '../domain/sheet/sheet.js';
import { addDays, isoWeekday, workingDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { parseCsv, uuidOf } from './fortytools-export-import.js';
import { saveSite } from './masterdata.js';
import type { Deps } from './workflow.js';

export type MoreKind = 'artikel' | 'zeiten' | 'zeitbericht';

const decode = (bytes: Uint8Array) => {
  const utf = new TextDecoder('utf-8').decode(bytes);
  return (utf.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(bytes) : utf).replace(
    /^\uFEFF/,
    '',
  );
};
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

export interface MoreTable {
  kind: MoreKind;
  head: string[];
  rows: Record<string, string>[];
}

export function detectMore(bytes: Uint8Array): MoreTable {
  // Fortytools liefert den Zeitbericht als Excel-Datei, auch wenn sie „.csv“ heißt
  const all = bytes[0] === 0x50 && bytes[1] === 0x4b ? readSheet(bytes).rows : parseCsv(decode(bytes));
  const head = (all[0] ?? []).map((h) => h.trim());
  const has = (...k: string[]) => k.every((x) => head.includes(x));
  const kind: MoreKind | null = has('Mitarbeiternummer', 'Einsatzort', 'Start', 'Ende', 'Datum')
    ? 'zeiten'
    : has('Art', 'Mitarbeiter', 'Einsatzort', 'Datum', 'Beginn', 'Ende')
      ? 'zeitbericht'
      : has('Artikelnummer', 'Name', 'Einkaufspreis', 'Bestand')
        ? 'artikel'
        : null;
  if (!kind)
    throw new BusinessError(
      'Datei nicht erkannt – erwartet wird der Fortytools-Export „Artikel“ (items.csv), „Zeiten“ (Zeiten.csv) oder der Zeitbericht (Art, Mitarbeiter, Einsatzort, Datum, Beginn, Ende)',
    );
  const rows = all
    .slice(1)
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { kind, head, rows };
}

const morePath = (sha: string) => `importe/${sha.slice(0, 2)}/${sha}.csv`;
export async function stageMore(deps: Deps, bytes: Uint8Array) {
  if (bytes.length > 20 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 20 MB)');
  const t = detectMore(bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  await deps.archive.put(morePath(sha), bytes);
  return { sha, kind: t.kind };
}
export async function stagedMore(deps: Deps, sha: string) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new BusinessError('Datei ungültig');
  try {
    return detectMore(await deps.archive.get(morePath(sha)));
  } catch (e) {
    if (e instanceof BusinessError) throw e;
    throw new BusinessError('Datei nicht mehr vorhanden – bitte erneut hochladen');
  }
}

/** „17.0“, „0.62“, „3,50“ → Cent (exakt über Text, kein Gleitkomma). */
export function centsOf(v: string): bigint | null {
  const t = v.trim().replace(/\s|€/g, '');
  if (!t) return null;
  const m = /^(-?)(\d+)(?:[.,](\d{1,2})\d*)?$/.exec(t.includes(',') ? t.replace(/\.(?=\d{3}\b)/g, '') : t);
  if (!m) return null;
  const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '0').padEnd(2, '0'));
  return m[1] ? -c : c;
}

export interface MoreIssue {
  ref: string;
  level: 'fehler' | 'hinweis';
  text: string;
}

// ------------------------------------------------------------------ Artikel

export interface ArticlePlanRow {
  id: string;
  article_no: string;
  name: string;
  description: string | null;
  maker_no: string | null;
  purchase_cents: bigint | null;
  sales_cents: bigint | null;
  stock_milli: bigint;
  status: 'neu' | 'vorhanden';
}

export async function planArticles(sql: Sql, t: MoreTable) {
  const issues: MoreIssue[] = [];
  const existing = new Map(
    (await sql<{ id: string; article_no: string }[]>`select id, article_no from app.articles`).map((a) => [
      a.article_no,
      a.id,
    ]),
  );
  const rows: ArticlePlanRow[] = [];
  const seen = new Set<string>();
  for (const r of t.rows) {
    const no = (r.Artikelnummer ?? '').trim();
    const name = (r.Name ?? '').trim().replace(/\s+/g, ' ');
    const ref = `${no || '?'} ${name}`.trim();
    if (!no || !name) {
      issues.push({ ref, level: 'fehler', text: 'Artikelnummer oder Name fehlt' });
      continue;
    }
    if (seen.has(no)) {
      issues.push({ ref, level: 'fehler', text: 'Artikelnummer doppelt in der Datei' });
      continue;
    }
    seen.add(no);
    const stockRaw = (r.Bestand ?? '0').replace(',', '.');
    let stock = /^-?\d+(\.\d+)?$/.test(stockRaw) ? BigInt(Math.round(Number(stockRaw) * 1000)) : 0n;
    if (stock < 0n) {
      issues.push({
        ref: `${ref} (${stockRaw})`,
        level: 'hinweis',
        text: 'negativer Bestand in Fortytools → 0 übernommen, bitte Inventur',
      });
      stock = 0n;
    }
    const desc = [(r.Beschreibung ?? '').trim(), (r.Notizen ?? '').trim()].filter(Boolean).join('\n');
    rows.push({
      id: existing.get(no) ?? uuidOf(`ft-article:${no}`),
      article_no: no,
      name,
      description: desc || null,
      maker_no: (r['Artikel-Nr.'] ?? '').trim() || null,
      purchase_cents: centsOf(r.Einkaufspreis ?? ''),
      sales_cents: centsOf(r.Verkaufspreis ?? ''),
      stock_milli: stock,
      status: existing.has(no) ? 'vorhanden' : 'neu',
    });
  }
  return { rows, issues };
}

export async function applyArticles(sql: Sql, t: MoreTable, opts: { update: boolean; actor: string }) {
  const { rows } = await planArticles(sql, t);
  let created = 0;
  let updated = 0;
  let booked = 0;
  for (const a of rows) {
    if (a.status === 'vorhanden' && !opts.update) continue;
    await sql.begin(async (tx) => {
      const [cur] = await tx<{ stock_milli: bigint }[]>`
        insert into app.articles (id, article_no, name, unit, purchase_price_cents, sales_price_cents, description,
                                  maker_no)
        values (${a.id}, ${a.article_no}, ${a.name}, 'Stk.', ${a.purchase_cents}, ${a.sales_cents}, ${a.description},
                ${a.maker_no})
        on conflict (id) do update set name = excluded.name, purchase_price_cents = excluded.purchase_price_cents,
          sales_price_cents = excluded.sales_price_cents, description = excluded.description,
          maker_no = excluded.maker_no, updated_at = now()
        returning stock_milli`;
      if (a.status === 'neu') created++;
      else updated++;
      // Bestand nur beim ersten Mal setzen (spätere Importe überschreiben keine Buchungen der App)
      const moveId = uuidOf(`ft-article-stock:${a.article_no}`);
      const [done] = await tx`select 1 from app.stock_movements where id = ${moveId}`;
      const delta = a.stock_milli - (cur?.stock_milli ?? 0n);
      if (!done && delta !== 0n) {
        await tx`insert into app.stock_movements (id, article_id, delta_milli, reason, created_by)
                 values (${moveId}, ${a.id}, ${delta}, 'Übernahme Bestand aus Fortytools', ${opts.actor})`;
        await tx`update app.articles set stock_milli = stock_milli + ${delta} where id = ${a.id}`;
        booked++;
      }
    });
  }
  return { created, updated, booked };
}

// ------------------------------------------------------------------ Zeiten

const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2})$/;
const toIso = (d: string) => {
  const m = DATE.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const minutesOf = (t: string) => {
  const m = TIME.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export interface TimePlanRow {
  id: string;
  employee_id: string;
  employee: string;
  personnel_no: string;
  site_id: string;
  site: string;
  date: string;
  start: string;
  end: string;
  end_next_day: boolean;
  break_minutes: number;
  note: string;
  exists: boolean;
  /** geplante Zeit (Zeitbericht „Soll Beginn/Ende“) – für die abgeleiteten Einsätze */
  plan_start: string;
  plan_end: string;
}
export interface NewSite {
  id: string;
  customer_id: string;
  site_no: string;
  name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
}
export interface ShiftPlanRow {
  id: string;
  employee_id: string;
  employee: string;
  site_id: string;
  site: string;
  weekday: number;
  start: string;
  end: string;
  break_minutes: number;
  count: number;
  /** gültig ab dem ersten Vorkommen im Export – so hängen die importierten Zeiten als „bestätigt“ am Einsatz */
  valid_from: string;
  /** endet mit dem letzten Vorkommen, wenn es länger als zwei Wochen vor dem Ende des Exports liegt */
  valid_until: string | null;
  exists: boolean;
}

export async function planTimes(sql: Sql, t: MoreTable, opts: { exclude: string[] }) {
  const issues: MoreIssue[] = [];
  const report = t.kind === 'zeitbericht' ? await convertReport(sql, t) : null;
  if (report) issues.push(...report.issues);
  const src = report ? report.rows : t.rows;
  const emps = await sql<{ id: string; personnel_no: string; name: string }[]>`
    select id, personnel_no, first_name || ' ' || last_name as name from app.employees`;
  const empBy = new Map(emps.map((e) => [e.personnel_no.trim(), e]));
  const sites = await sql<{ id: string; name: string; customer_no: string; is_internal: boolean }[]>`
    select s.id, s.name, c.customer_no, c.is_internal from app.sites s join app.customers c on c.id = s.customer_id`;
  const byCustName = new Map<string, (typeof sites)[number]>();
  const byName = new Map<string, (typeof sites)[number][]>();
  const siteById = new Map(sites.map((x) => [x.id, x]));
  for (const s of sites) {
    byCustName.set(`${s.customer_no}|${norm(s.name)}`, s);
    const k = norm(s.name);
    byName.set(k, [...(byName.get(k) ?? []), s]);
  }
  const internal = sites.find((s) => s.is_internal && norm(s.name) === 'buero') ?? null;
  const custs = await sql<
    {
      id: string;
      customer_no: string;
      name: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`select id, customer_no, name, street, postal_code, city from app.customers`;
  const custBy = new Map(custs.map((k) => [k.customer_no.trim(), k]));
  const siteNos = new Set(
    (await sql<{ site_no: string }[]>`select site_no from app.sites`).map((x) => x.site_no),
  );
  // Buchungen ohne Objekt (Einsatzort = Kundenname) → Objekt „Allgemein (aus Fortytools)“ des Kunden
  const newSites = new Map<string, NewSite>();
  const generalSite = (custNo: string) => {
    const k = custBy.get(custNo);
    if (!k) return null;
    const own = sites.filter((x) => x.customer_no === custNo);
    // feste ID zuerst: das Objekt darf im Büro umbenannt werden (z. B. in den Kundennamen)
    const genId = uuidOf(`ft-site:ft:o:${custNo}|allgemein`);
    const gen =
      own.find((x) => x.id === genId) ??
      own.find((x) => ['allgemein', norm('Allgemein (aus Fortytools)')].includes(norm(x.name)));
    if (gen) return gen;
    let ns = newSites.get(custNo);
    if (!ns) {
      let n = 1;
      while (siteNos.has(`${custNo}${String(n).padStart(2, '0')}`)) n++;
      const no = `${custNo}${String(n).padStart(2, '0')}`;
      siteNos.add(no);
      ns = {
        id: uuidOf(`ft-site:ft:o:${custNo}|allgemein`),
        customer_id: k.id,
        site_no: no,
        name: 'Allgemein',
        street: k.street,
        postal_code: k.postal_code,
        city: k.city,
      };
      newSites.set(custNo, ns);
    }
    return { id: ns.id, name: ns.name, customer_no: custNo, is_internal: false };
  };
  const existingIds = new Set(
    (
      await sql<
        { id: string }[]
      >`select id from app.time_entries where created_by like 'ft-import%' or note like 'aus Fortytools%'`
    ).map((r) => r.id),
  );
  const exclude = new Set(opts.exclude.map((x) => x.trim()).filter(Boolean));
  const rows: TimePlanRow[] = [];
  let excluded = 0;
  for (const r of src) {
    const pno = (r.Mitarbeiternummer ?? '').trim();
    const place = (r.Einsatzort ?? '').split('\n')[0]!.trim();
    const ref = `${r.Datum ?? ''} ${r.Mitarbeiter ?? ''} – ${place}`;
    if (exclude.has(pno)) {
      excluded++;
      continue;
    }
    const e = empBy.get(pno);
    if (!e) {
      issues.push({ ref, level: 'fehler', text: `Personalnummer ${pno || '–'} nicht gefunden` });
      continue;
    }
    const custNo = (r.Kundennummer ?? '').trim();
    // Zeitbericht: Objekt schon zugeordnet (__site) bzw. Buchung auf den Kunden (__cust)
    let site = r.__site ? (siteById.get(r.__site) ?? null) : r.__cust ? generalSite(r.__cust) : null;
    if (!site) site = byCustName.get(`${custNo}|${norm(place)}`) ?? null;
    if (!site) {
      const cand = byName.get(norm(place)) ?? [];
      if (cand.length === 1) site = cand[0]!;
    }
    if (!site && /viva-deluxe/i.test(place) && internal) site = internal;
    if (!site && custBy.has(custNo)) {
      site = generalSite(custNo);
      if (site) issues.push({ ref, level: 'hinweis', text: `ohne Objekt → Objekt „Allgemein“ des Kunden` });
    }
    if (!site) {
      issues.push({ ref, level: 'fehler', text: `Objekt „${place}“ (Kunde ${custNo}) nicht gefunden` });
      continue;
    }
    const date = toIso(r.Datum ?? '');
    const s = minutesOf(r.Start ?? '');
    const en = minutesOf(r.Ende ?? '');
    const pause = minutesOf(r['Dauer Pause'] ?? '0:00') ?? 0;
    if (!date || s == null || en == null) {
      issues.push({ ref, level: 'fehler', text: 'Datum oder Uhrzeit fehlt/ungültig' });
      continue;
    }
    if (en === s) {
      issues.push({ ref: `${ref} ${r.Start}`, level: 'hinweis', text: 'Dauer 0 Minuten – übersprungen' });
      continue;
    }
    const next = en < s;
    const dur = (next ? en + 1440 : en) - s;
    if (dur > 16 * 60) {
      issues.push({ ref, level: 'fehler', text: 'länger als 16 Stunden' });
      continue;
    }
    const ps = minutesOf(r['Soll Beginn'] ?? '');
    const pe = minutesOf(r['Soll Ende'] ?? '');
    const planned = ps != null && pe != null && pe > ps;
    const link = (r.Servicebericht ?? '').trim();
    const desc = (r.Einsatzbeschreibung ?? '').replace(/\s+/g, ' ').trim();
    const id = uuidOf(`ft-time:${pno}|${date}|${r.Start}|${r.Ende}|${site.id}`);
    rows.push({
      id,
      employee_id: e.id,
      employee: e.name,
      personnel_no: pno,
      site_id: site.id,
      site: site.name,
      date,
      start: r.Start!,
      end: r.Ende!,
      end_next_day: next,
      break_minutes: Math.min(240, Math.max(0, pause)),
      note: [desc, link].filter(Boolean).join(' · ').slice(0, 900),
      exists: existingIds.has(id),
      plan_start: planned ? hhmm(ps) : r.Start!,
      plan_end: planned ? hhmm(pe) : r.Ende!,
    });
  }
  // Einsätze ableiten: gleicher Mitarbeiter, Objekt, Wochentag und Beginn mindestens zweimal
  const groups = new Map<string, TimePlanRow[]>();
  for (const x of rows) {
    const k = `${x.employee_id}|${x.site_id}|${isoWeekday(x.date)}|${x.plan_start}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const last = rows.reduce((m, x) => (x.date > m ? x.date : m), '');
  const validFrom = last ? addDays(last, 1) : null;
  const existingPlans = await sql<{ employee_id: string; site_id: string; weekday: number }[]>`
    select employee_id, site_id, weekday from app.shift_plans
     where employee_id is not null and (valid_until is null or valid_until >= ${validFrom ?? '2000-01-01'})`;
  const planKey = new Set(existingPlans.map((p) => `${p.employee_id}|${p.site_id}|${p.weekday}`));
  // Wiederkehrend = mindestens zweimal; umfasst der Export weniger als zwei Wochen, reicht einmal.
  const first = rows.reduce((m, x) => (!m || x.date < m ? x.date : m), '');
  const minCount = first && last && addDays(first, 14) > last ? 1 : 2;
  const shifts: ShiftPlanRow[] = [];
  for (const [k, xs] of groups) {
    if (xs.length < minCount) continue;
    const [empId, siteId, wd] = k.split('|');
    const durs = xs
      .map((x) => {
        const a = minutesOf(x.plan_start)!;
        const b = minutesOf(x.plan_end)!;
        return (b < a ? b + 1440 : b) - a;
      })
      .sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)]!;
    const dur = Math.max(15, Math.round(med / 15) * 15);
    const start = minutesOf(xs[0]!.plan_start)!;
    if (start + dur >= 1440) continue; // über Mitternacht → als zwei Einsätze anlegen (von Hand)
    const pauses = xs.map((x) => x.break_minutes).sort((a, b) => a - b);
    shifts.push({
      id: uuidOf(`ft-shift:${k}`),
      employee_id: empId!,
      employee: xs[0]!.employee,
      site_id: siteId!,
      site: xs[0]!.site,
      weekday: Number(wd),
      start: xs[0]!.plan_start.padStart(5, '0'),
      end: hhmm(start + dur),
      break_minutes: Math.min(180, pauses[Math.floor(pauses.length / 2)]!),
      count: xs.length,
      valid_from: xs.reduce((m, x) => (x.date < m ? x.date : m), xs[0]!.date),
      valid_until: (() => {
        const lastSeen = xs.reduce((m, x) => (x.date > m ? x.date : m), xs[0]!.date);
        return addDays(lastSeen, 14) < last ? lastSeen : null;
      })(),
      exists: planKey.has(`${empId}|${siteId}|${wd}`),
    });
  }
  shifts.sort((a, b) => a.employee.localeCompare(b.employee, 'de') || a.weekday - b.weekday);
  return {
    rows,
    shifts,
    issues,
    excluded,
    validFrom,
    newSites: [...newSites.values()],
    absences: report ? await planAbsences(sql, report.absences, exclude) : [],
    skippedKinds: report?.skippedKinds ?? [],
  };
}

export async function applyTimes(
  sql: Sql,
  t: MoreTable,
  opts: { exclude: string[]; shifts: boolean; actor: string },
) {
  const plan = await planTimes(sql, t, opts);
  for (const ns of plan.newSites) {
    const [has] = await sql`select 1 from app.sites where id = ${ns.id}`;
    if (!has)
      await saveSite(
        sql,
        ns.id,
        {
          customer_id: ns.customer_id,
          site_no: ns.site_no,
          name: ns.name,
          street: ns.street,
          postal_code: ns.postal_code,
          city: ns.city,
        } as never,
        opts.actor,
      );
  }
  // In Blöcken übernehmen (Zeitbericht: ~20.000 Zeilen): Überschneidungen vorab im Speicher prüfen
  const seen = new Set<string>();
  const todo = plan.rows.filter((x) => !x.exists && !seen.has(x.id) && (seen.add(x.id), true));
  const done = new Set<string>();
  for (let i = 0; i < todo.length; i += 5000) {
    const ids = todo.slice(i, i + 5000).map((x) => x.id);
    for (const r of await sql<
      { id: string }[]
    >`select id from app.time_entries where id = any(${ids}::uuid[])`)
      done.add(r.id);
  }
  const local = (d: string, min: number) => Date.parse(`${d}T00:00:00Z`) / 60000 + min;
  const spans = new Map<string, [number, number][]>();
  if (todo.length) {
    const dates = todo.map((x) => x.date).sort();
    const ex = await sql<{ employee_id: string; s: string; e: string }[]>`
      select employee_id, to_char(start_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as s,
             to_char(end_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as e
        from app.time_entries
       where status <> 'abgelehnt' and end_at is not null
         and work_date between ${addDays(dates[0]!, -1)} and ${addDays(dates[dates.length - 1]!, 1)}
         and employee_id = any(${[...new Set(todo.map((x) => x.employee_id))]}::uuid[])`;
    const toMin = (t: string) => local(t.slice(0, 10), minutesOf(t.slice(11))!);
    for (const x of ex) {
      if (!spans.has(x.employee_id)) spans.set(x.employee_id, []);
      spans.get(x.employee_id)!.push([toMin(x.s), toMin(x.e)]);
    }
  }
  let skipped = 0;
  const overlaps: string[] = [];
  const insert: TimePlanRow[] = [];
  for (const x of todo) {
    if (done.has(x.id)) continue;
    const a = local(x.date, minutesOf(x.start)!);
    const b = local(x.date, minutesOf(x.end)! + (x.end_next_day ? 1440 : 0));
    const list = spans.get(x.employee_id) ?? [];
    if (list.some(([s0, e0]) => s0 < b && a < e0)) {
      skipped++;
      overlaps.push(`${x.date} ${x.employee} ${x.start}–${x.end}`);
      continue;
    }
    list.push([a, b]);
    spans.set(x.employee_id, list);
    insert.push(x);
  }
  let created = 0;
  for (let i = 0; i < insert.length; i += 1000) {
    const ch = insert.slice(i, i + 1000);
    const r = await sql`
      insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source,
                                    status, note, recorded_at, created_by, decided_by, decided_at)
      select x.id, x.emp, x.site, x.d, (x.d + x.s) at time zone 'Europe/Berlin',
             ((x.d + x.nd) + x.e) at time zone 'Europe/Berlin', x.br, 'buero', 'freigegeben', nullif(x.note, ''),
             ((x.d + x.nd) + x.e) at time zone 'Europe/Berlin', ${`ft-import:${opts.actor}`}, ${opts.actor}, now()
        from unnest(${ch.map((x) => x.id)}::uuid[], ${ch.map((x) => x.employee_id)}::uuid[],
                    ${ch.map((x) => x.site_id)}::uuid[], ${ch.map((x) => x.date)}::date[],
                    ${ch.map((x) => x.start)}::time[], ${ch.map((x) => x.end)}::time[],
                    ${ch.map((x) => (x.end_next_day ? 1 : 0))}::int[], ${ch.map((x) => x.break_minutes)}::int[],
                    ${ch.map((x) => x.note)}::text[]) as x(id, emp, site, d, s, e, nd, br, note)
      on conflict (id) do nothing`;
    created += r.count;
  }
  const abs = await applyAbsences(sql, plan.absences, opts.actor);
  let shiftsCreated = 0;
  let shiftsUpdated = 0;
  if (opts.shifts && plan.validFrom) {
    for (const s of plan.shifts) {
      // Früher abgeleitete Einsätze galten erst ab dem Tag nach der letzten Zeit → auf das erste Vorkommen
      // vorziehen (nur unsere eigenen, unveränderten Ableitungen), damit die Zeiten daran hängen.
      const fixed = await sql`
        update app.shift_plans
           set valid_from = ${s.valid_from},
               created_at = least(created_at, (${s.valid_from}::date)::timestamp at time zone 'Europe/Berlin')
         where id = ${s.id} and note in ('aus Fortytools-Zeiten abgeleitet', 'aus erfassten Zeiten abgeleitet') and valid_from > ${s.valid_from}`;
      shiftsUpdated += fixed.count;
      // Zuordnung Mitarbeiter ↔ Objekt (Liste „Mitarbeitende“, Stempeln nur an zugeordneten Objekten)
      await sql`insert into app.employee_sites (employee_id, site_id)
                values (${s.employee_id}, ${s.site_id}) on conflict do nothing`;
      if (s.exists) {
        // vorhandener abgeleiteter Einsatz mit gleicher Zeit → ebenfalls auf das erste Vorkommen vorziehen
        const moved = await sql`
          update app.shift_plans
             set valid_from = ${s.valid_from},
                 created_at = least(created_at, (${s.valid_from}::date)::timestamp at time zone 'Europe/Berlin')
           where employee_id = ${s.employee_id} and site_id = ${s.site_id} and weekday = ${s.weekday}
             and start_time = ${s.start}::time and valid_from > ${s.valid_from}
             and note in ('aus Fortytools-Zeiten abgeleitet', 'aus erfassten Zeiten abgeleitet')`;
        shiftsUpdated += moved.count;
        continue;
      }
      const r = await sql`
        insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes,
                                     valid_from, valid_until, note, series_id, created_at)
        values (${s.id}, ${s.employee_id}, ${s.site_id}, ${s.weekday}, ${s.start}, ${s.end}, ${s.break_minutes},
                ${s.valid_from}, ${s.valid_until}, 'aus erfassten Zeiten abgeleitet', ${s.id},
                (${s.valid_from}::date)::timestamp at time zone 'Europe/Berlin')
        on conflict (id) do nothing`;
      shiftsCreated += r.count;
    }
  }
  return {
    created,
    skipped,
    overlaps,
    shiftsCreated,
    shiftsUpdated,
    excluded: plan.excluded,
    absencesCreated: abs.created,
    absencesSkipped: abs.skipped,
  };
}

/** Objekt „Allgemein (aus Fortytools)“ eines Kunden holen oder anlegen (für Buchungen ohne Objekt). */
export async function ensureGeneralSite(sql: Sql, customerNo: string, actor: string): Promise<string | null> {
  const [k] = await sql<
    { id: string; street: string | null; postal_code: string | null; city: string | null }[]
  >`select id, street, postal_code, city from app.customers where customer_no = ${customerNo}`;
  if (!k) return null;
  const [gen] = await sql<{ id: string }[]>`
    select id from app.sites
     where customer_id = ${k.id}
       and (id = ${uuidOf(`ft-site:ft:o:${customerNo}|allgemein`)} or name in ('Allgemein', 'Allgemein (aus Fortytools)'))
     order by (id = ${uuidOf(`ft-site:ft:o:${customerNo}|allgemein`)}) desc limit 1`;
  if (gen) return gen.id;
  const nos = new Set(
    (
      await sql<{ site_no: string }[]>`select site_no from app.sites where site_no like ${`${customerNo}%`}`
    ).map((x) => x.site_no),
  );
  let n = 1;
  while (nos.has(`${customerNo}${String(n).padStart(2, '0')}`)) n++;
  const id = uuidOf(`ft-site:ft:o:${customerNo}|allgemein`);
  await saveSite(
    sql,
    id,
    {
      customer_id: k.id,
      site_no: `${customerNo}${String(n).padStart(2, '0')}`,
      name: 'Allgemein',
      street: k.street,
      postal_code: k.postal_code,
      city: k.city,
    } as never,
    actor,
  );
  return id;
}

// ------------------------------------------------------------------ Zeitbericht (Excel, Ahmed 09.10.)
/*
 * Fortytools-Zeitbericht: je Zeile Art (Einsatzzeit, Pause, Urlaub …, Krankheit …, Unbezahlte Abwesenheit,
 * Feiertagslohnfortzahlung), Soll- und Ist-Zeit, Mitarbeiter als „Nachname, Vorname“, Einsatzort nur mit Namen.
 * - Einsatzzeit → erfasste Zeit (Ist = Beginn/Ende), Pausen-Zeilen innerhalb der Zeit → Pause; Soll-Zeit → Einsätze.
 * - Urlaub/Krankheit/Unbezahlt → genehmigte Abwesenheit, Stunden je Tag aus „Dauer“ (bezahlt laut Art).
 * - Feiertagslohnfortzahlung wird nicht übernommen (rechnet die App aus Plan + Feiertag selbst).
 * Mitarbeiter über den Namen, Objekt über den Namen (mehrdeutig → das Objekt, an dem die Person eingesetzt ist).
 */

export interface ReportAbsenceDay {
  employee_id: string;
  employee: string;
  personnel_no: string;
  kind: 'urlaub' | 'krank' | 'kind_krank' | 'unbezahlt';
  paid: boolean;
  date: string;
  minutes: number;
  site_id: string | null;
}

function absenceKind(art: string): { kind: ReportAbsenceDay['kind']; paid: boolean } | null {
  const a = art.toLowerCase();
  if (a.startsWith('urlaub')) return { kind: 'urlaub', paid: true };
  if (a.includes('kind') && a.includes('krank')) return { kind: 'kind_krank', paid: false };
  if (a.startsWith('krank')) return { kind: 'krank', paid: !a.includes('ohne abrechnung') };
  if (a.includes('unbezahlt')) return { kind: 'unbezahlt', paid: false };
  return null;
}

const hours100 = (v: string) => {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(v.trim());
  if (!m) return null;
  return Math.round(Number(`${m[1]}.${m[2] ?? '0'}`) * 60);
};

async function convertReport(sql: Sql, t: MoreTable) {
  const issues: MoreIssue[] = [];
  const emps = await sql<{ id: string; personnel_no: string; first_name: string; last_name: string }[]>`
    select id, personnel_no, first_name, last_name from app.employees`;
  const empCache = new Map<string, (typeof emps)[number] | 'mehrdeutig' | null>();
  const findEmp = (raw: string) => {
    if (empCache.has(raw)) return empCache.get(raw)!;
    const i = raw.indexOf(',');
    const L = norm(i >= 0 ? raw.slice(0, i) : raw);
    const F = i >= 0 ? raw.slice(i + 1).trim() : '';
    const nf = norm(F);
    const f1 = norm(F.split(/\s+/)[0] ?? '');
    const full = norm(raw);
    // mehrteilige Nachnamen sind in den Stammdaten oft anders aufgeteilt → alle Namensteile vergleichen
    const parts = (x: string) =>
      x
        .split(/[\s,-]+/)
        .map(norm)
        .filter(Boolean)
        .sort()
        .join(' ');
    const all = parts(raw);
    const tries: ((e: (typeof emps)[number]) => boolean)[] = [
      (e) => norm(e.last_name) === L && norm(e.first_name) === nf,
      (e) =>
        norm(e.last_name) === L &&
        !!f1 &&
        (norm(e.first_name).startsWith(f1) || nf.startsWith(norm(e.first_name))),
      (e) => norm(e.last_name + e.first_name) === full || norm(e.first_name + e.last_name) === full,
      (e) => parts(`${e.first_name} ${e.last_name}`) === all,
    ];
    let hit: (typeof emps)[number] | 'mehrdeutig' | null = null;
    for (const f of tries) {
      const c = emps.filter(f);
      if (c.length === 1) {
        hit = c[0]!;
        break;
      }
      if (c.length > 1) {
        hit = 'mehrdeutig';
        break;
      }
    }
    empCache.set(raw, hit);
    return hit;
  };

  const sites = await sql<
    { id: string; name: string; site_no: string; customer_no: string; is_internal: boolean }[]
  >`select s.id, s.name, s.site_no, c.customer_no, c.is_internal
      from app.sites s join app.customers c on c.id = s.customer_id`;
  const byName = new Map<string, (typeof sites)[number][]>();
  for (const x of sites) byName.set(norm(x.name), [...(byName.get(norm(x.name)) ?? []), x]);
  const custs = await sql<
    { customer_no: string; name: string }[]
  >`select customer_no, name from app.customers`;
  const custByName = new Map<string, string[]>();
  for (const k of custs)
    custByName.set(norm(k.name), [...(custByName.get(norm(k.name)) ?? []), k.customer_no]);
  const internal = sites.find((x) => x.is_internal && norm(x.name) === 'buero') ?? null;
  // wo ist die Person eingesetzt (für gleichnamige Objekte)
  const links = await sql<
    { employee_id: string; site_id: string; weekday: number | null; start: string | null }[]
  >`
    select employee_id, site_id, null::int as weekday, null::text as start from app.employee_sites
    union all
    select employee_id, site_id, weekday, to_char(start_time, 'HH24:MI') from app.shift_plans where employee_id is not null`;
  const empSites = new Map<string, Set<string>>();
  const empShift = new Set<string>();
  for (const l of links) {
    if (!empSites.has(l.employee_id)) empSites.set(l.employee_id, new Set());
    empSites.get(l.employee_id)!.add(l.site_id);
    if (l.weekday) empShift.add(`${l.employee_id}|${l.site_id}|${l.weekday}|${l.start}`);
  }
  type Place = { site?: string; cust?: string; guess?: string } | 'mehrdeutig' | null;
  const findPlace = (raw: string, empId: string, date: string, start: string): Place => {
    const text = raw.replace(/\r/g, '').trim();
    if (!text) return null;
    const keys = [...new Set([norm(text), norm(text.split('\n')[0]!), norm(text.replace(/\n/g, ' '))])];
    const cand = [...new Map(keys.flatMap((k) => byName.get(k) ?? []).map((x) => [x.id, x])).values()];
    if (cand.length === 1) return { site: cand[0]!.id };
    if (cand.length > 1) {
      const wd = isoWeekday(date);
      const byShift = cand.filter((x) => empShift.has(`${empId}|${x.id}|${wd}|${start}`));
      if (byShift.length === 1) return { site: byShift[0]!.id };
      const mine = cand.filter((x) => empSites.get(empId)?.has(x.id));
      if (mine.length === 1) return { site: mine[0]!.id };
      // gleichnamige Objekte desselben Kunden (z. B. zwei Hausnummern): das erste nehmen, Hinweis
      if (new Set(cand.map((x) => x.customer_no)).size === 1) {
        const first = [...cand].sort((a, b) => a.site_no.localeCompare(b.site_no))[0]!;
        return { site: first.id, guess: `${first.name} (${first.site_no})` };
      }
      return 'mehrdeutig';
    }
    if (/viva-deluxe/i.test(text) && internal) return { site: internal.id };
    const kn = keys.flatMap((k) => custByName.get(k) ?? []);
    if (kn.length === 1) return { cust: kn[0]! };
    // Fortytools kürzt Kundennamen („Landeshauptstadt München, Dire“) → eindeutiger Anfang des Kundennamens
    const k0 = keys[0]!;
    if (k0.length >= 10) {
      const pre = custs.filter((k) => norm(k.name).startsWith(k0));
      if (pre.length === 1) return { cust: pre[0]!.customer_no };
    }
    return null;
  };

  // Pausen-Zeilen je Person + Tag sammeln
  const pauses = new Map<string, [number, number][]>();
  for (const r of t.rows) {
    if ((r.Art ?? '').trim().toLowerCase() !== 'pause') continue;
    const a = minutesOf(r.Beginn ?? '');
    const b = minutesOf(r.Ende ?? '');
    if (a == null || b == null || b <= a) continue;
    const k = `${r.Mitarbeiter}|${r.Datum}`;
    pauses.set(k, [...(pauses.get(k) ?? []), [a, b]]);
  }

  const rows: Record<string, string>[] = [];
  const absences: ReportAbsenceDay[] = [];
  const skipped = new Map<string, number>();
  for (const r of t.rows) {
    const art = (r.Art ?? '').trim();
    const artL = art.toLowerCase();
    if (artL === 'pause') continue;
    const name = (r.Mitarbeiter ?? '').trim();
    const placeRaw = (r.Einsatzort ?? '').trim();
    const ref = `${r.Datum ?? ''} ${name} – ${placeRaw.split(/\r?\n/)[0]}`;
    const abs = absenceKind(art);
    if (artL !== 'einsatzzeit' && !abs) {
      skipped.set(art || '(ohne Art)', (skipped.get(art || '(ohne Art)') ?? 0) + 1);
      continue;
    }
    const e = findEmp(name);
    if (!e || e === 'mehrdeutig') {
      issues.push({
        ref,
        level: 'fehler',
        text: e ? `Mitarbeiter „${name}“ mehrdeutig` : `Mitarbeiter „${name}“ nicht gefunden`,
      });
      continue;
    }
    const date = toIso(r.Datum ?? '');
    if (!date) {
      issues.push({ ref, level: 'fehler', text: 'Datum fehlt/ungültig' });
      continue;
    }
    const place = findPlace(placeRaw, e.id, date, (r['Soll Beginn'] || r.Beginn || '').padStart(5, '0'));
    if (abs) {
      const min = hours100(r.Dauer ?? '') ?? 0;
      if (min <= 0) continue;
      absences.push({
        employee_id: e.id,
        employee: `${e.first_name} ${e.last_name}`,
        personnel_no: e.personnel_no,
        kind: abs.kind,
        paid: abs.paid,
        date,
        minutes: min,
        site_id: place && place !== 'mehrdeutig' && place.site ? place.site : null,
      });
      continue;
    }
    if (place === 'mehrdeutig') {
      issues.push({ ref, level: 'fehler', text: `Objekt „${placeRaw.split(/\r?\n/)[0]}“ mehrdeutig` });
      continue;
    }
    if (!place) {
      issues.push({
        ref,
        level: 'fehler',
        text: placeRaw ? `Objekt „${placeRaw.split(/\r?\n/)[0]}“ nicht gefunden` : 'Einsatzort fehlt',
      });
      continue;
    }
    if (place.cust)
      issues.push({ ref, level: 'hinweis', text: 'ohne Objekt → Objekt „Allgemein“ des Kunden' });
    if (place.guess)
      issues.push({
        ref,
        level: 'hinweis',
        text: `mehrere Objekte „${placeRaw}“ beim Kunden → ${place.guess} genommen, bitte prüfen`,
      });
    const a = minutesOf(r.Beginn ?? '');
    const b = minutesOf(r.Ende ?? '');
    let pause = 0;
    if (a != null && b != null) {
      for (const [x, y] of pauses.get(`${r.Mitarbeiter}|${r.Datum}`) ?? [])
        if (x >= a && y <= b) pause += y - x;
      // „Dauer“ ist netto – Fortytools zieht die geplante Pause schon ab (06:00–12:30 → 6 Std.)
      const net = hours100(r.Dauer ?? '');
      const span = (b < a ? b + 1440 : b) - a;
      if (net != null && net > 0 && span - net > pause) pause = span - net;
    }
    rows.push({
      Mitarbeiternummer: e.personnel_no,
      Mitarbeiter: name,
      Einsatzort: placeRaw,
      Kundennummer: '',
      Datum: r.Datum ?? '',
      Start: r.Beginn ?? '',
      Ende: r.Ende ?? '',
      'Dauer Pause': hhmm(pause),
      'Soll Beginn': r['Soll Beginn'] ?? '',
      'Soll Ende': r['Soll Ende'] ?? '',
      ...(place.site ? { __site: place.site } : { __cust: place.cust! }),
    });
  }
  return {
    rows,
    absences,
    issues,
    skippedKinds: [...skipped.entries()].sort((x, y) => y[1] - x[1]),
  };
}

export interface AbsencePlan {
  id: string;
  employee_id: string;
  employee: string;
  personnel_no: string;
  kind: ReportAbsenceDay['kind'];
  start: string;
  end: string;
  days: { date: string; minutes: number; paid: boolean; site_id: string | null }[];
  /** schon übernommen (gleiche ID) bzw. überschneidet eine vorhandene Abwesenheit */
  status: 'neu' | 'vorhanden' | 'ueberschneidung';
}

/** Tage je Person + Art zu Abwesenheiten zusammenfassen (Lücken nur über Wochenende/Feiertage). */
async function planAbsences(sql: Sql, days: ReportAbsenceDay[], exclude: Set<string>) {
  const byKey = new Map<string, Map<string, ReportAbsenceDay & { n: number }>>();
  for (const d of days) {
    if (exclude.has(d.personnel_no)) continue;
    const k = `${d.employee_id}|${d.kind}`;
    if (!byKey.has(k)) byKey.set(k, new Map());
    const m = byKey.get(k)!;
    const cur = m.get(d.date);
    if (cur) {
      cur.minutes += d.minutes;
      cur.paid = cur.paid || d.paid;
      cur.site_id = cur.site_id ?? d.site_id;
    } else m.set(d.date, { ...d, n: 1 });
  }
  const plans: AbsencePlan[] = [];
  for (const m of byKey.values()) {
    const list = [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
    let run: typeof list = [];
    const flush = () => {
      if (!run.length) return;
      const f = run[0]!;
      const id = uuidOf(`ft-abs:${f.employee_id}|${f.kind}|${f.date}`);
      plans.push({
        id,
        employee_id: f.employee_id,
        employee: f.employee,
        personnel_no: f.personnel_no,
        kind: f.kind,
        start: f.date,
        end: run[run.length - 1]!.date,
        days: run.map((x) => ({
          date: x.date,
          minutes: Math.min(960, x.minutes),
          paid: x.paid,
          site_id: x.site_id,
        })),
        status: 'neu',
      });
      run = [];
    };
    for (const d of list) {
      const prev = run[run.length - 1];
      // Lücke mit Arbeitstagen → neue Abwesenheit
      if (
        prev &&
        d.date > addDays(prev.date, 1) &&
        workingDays(addDays(prev.date, 1), addDays(d.date, -1)) > 0
      )
        flush();
      run.push(d);
    }
    flush();
  }
  if (plans.length) {
    const ids = new Set(
      (
        await sql<
          { id: string }[]
        >`select id from app.absences where id = any(${plans.map((p) => p.id)}::uuid[])`
      ).map((r) => r.id),
    );
    const empIds = [...new Set(plans.map((p) => p.employee_id))];
    const existing = await sql<{ id: string; employee_id: string; start_date: string; end_date: string }[]>`
      select id, employee_id, start_date, end_date from app.absences
       where employee_id = any(${empIds}::uuid[]) and status in ('beantragt', 'genehmigt')`;
    for (const p of plans) {
      if (ids.has(p.id)) p.status = 'vorhanden';
      else if (
        existing.some(
          (x) => x.employee_id === p.employee_id && x.start_date <= p.end && x.end_date >= p.start,
        )
      )
        p.status = 'ueberschneidung';
    }
  }
  plans.sort((a, b) => a.employee.localeCompare(b.employee, 'de') || a.start.localeCompare(b.start));
  return plans;
}

async function applyAbsences(sql: Sql, plans: AbsencePlan[], actor: string) {
  let created = 0;
  let skipped = 0;
  for (const p of plans) {
    if (p.status === 'vorhanden') continue;
    if (p.status === 'ueberschneidung') {
      skipped++;
      continue;
    }
    const ok = await sql.begin(async (tx) => {
      // erneut prüfen (zwei Tabs / parallel)
      const [ov] = await tx`
        select 1 from app.absences where employee_id = ${p.employee_id} and status in ('beantragt', 'genehmigt')
           and start_date <= ${p.end} and end_date >= ${p.start}`;
      if (ov) return false;
      await tx`
        insert into app.absences (id, employee_id, kind, start_date, end_date, half_day, status, note, requested_by,
                                  decided_by, decided_at)
        values (${p.id}, ${p.employee_id}, ${p.kind}, ${p.start}, ${p.end}, false, 'genehmigt', null, ${actor},
                ${actor}, now())
        on conflict (id) do nothing`;
      await tx`
        insert into app.absence_hours (id, absence_id, employee_id, work_date, site_id, minutes, paid, manual)
        select x.id, ${p.id}, ${p.employee_id}, x.d, x.site, x.m, x.paid = 1, true
          from unnest(${p.days.map((d) => uuidOf(`abs-h:${p.id}:${d.date}:-`))}::uuid[],
                      ${p.days.map((d) => d.date)}::date[], ${p.days.map((d) => d.site_id)}::uuid[],
                      ${p.days.map((d) => d.minutes)}::int[], ${p.days.map((d) => (d.paid ? 1 : 0))}::int[])
               as x(id, d, site, m, paid)
        on conflict do nothing`;
      return true;
    });
    if (ok) created++;
    else skipped++;
  }
  return { created, skipped };
}
