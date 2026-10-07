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
import { addDays, isoWeekday } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { parseCsv, uuidOf } from './fortytools-export-import.js';
import { saveSite } from './masterdata.js';
import type { Deps } from './workflow.js';

export type MoreKind = 'artikel' | 'zeiten';

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
  const all = parseCsv(decode(bytes));
  const head = (all[0] ?? []).map((h) => h.trim());
  const has = (...k: string[]) => k.every((x) => head.includes(x));
  const kind: MoreKind | null = has('Mitarbeiternummer', 'Einsatzort', 'Start', 'Ende', 'Datum')
    ? 'zeiten'
    : has('Artikelnummer', 'Name', 'Einkaufspreis', 'Bestand')
      ? 'artikel'
      : null;
  if (!kind)
    throw new BusinessError(
      'Datei nicht erkannt – erwartet wird der Fortytools-Export „Artikel“ (items.csv) oder „Zeiten“ (Zeiten.csv)',
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
  exists: boolean;
}

export async function planTimes(sql: Sql, t: MoreTable, opts: { exclude: string[] }) {
  const issues: MoreIssue[] = [];
  const emps = await sql<{ id: string; personnel_no: string; name: string }[]>`
    select id, personnel_no, first_name || ' ' || last_name as name from app.employees`;
  const empBy = new Map(emps.map((e) => [e.personnel_no.trim(), e]));
  const sites = await sql<{ id: string; name: string; customer_no: string; is_internal: boolean }[]>`
    select s.id, s.name, c.customer_no, c.is_internal from app.sites s join app.customers c on c.id = s.customer_id`;
  const byCustName = new Map<string, (typeof sites)[number]>();
  const byName = new Map<string, (typeof sites)[number][]>();
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
      own.find((x) => x.id === genId) ?? own.find((x) => norm(x.name) === norm('Allgemein (aus Fortytools)'));
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
        name: 'Allgemein (aus Fortytools)',
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
  for (const r of t.rows) {
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
    let site = byCustName.get(`${custNo}|${norm(place)}`) ?? null;
    if (!site) {
      const cand = byName.get(norm(place)) ?? [];
      if (cand.length === 1) site = cand[0]!;
    }
    if (!site && /viva-deluxe/i.test(place) && internal) site = internal;
    if (!site && custBy.has(custNo)) {
      site = generalSite(custNo);
      if (site)
        issues.push({ ref, level: 'hinweis', text: `ohne Objekt → Objekt „Allgemein (aus Fortytools)“` });
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
      issues.push({ ref, level: 'hinweis', text: `Dauer 0 Minuten (${r.Start}–${r.Ende}) – übersprungen` });
      continue;
    }
    const next = en < s;
    const dur = (next ? en + 1440 : en) - s;
    if (dur > 16 * 60) {
      issues.push({ ref, level: 'fehler', text: 'länger als 16 Stunden' });
      continue;
    }
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
      note: ['aus Fortytools', desc, link].filter(Boolean).join(' · ').slice(0, 900),
      exists: existingIds.has(id),
    });
  }
  // Einsätze ableiten: gleicher Mitarbeiter, Objekt, Wochentag und Beginn mindestens zweimal
  const groups = new Map<string, TimePlanRow[]>();
  for (const x of rows) {
    const k = `${x.employee_id}|${x.site_id}|${isoWeekday(x.date)}|${x.start}`;
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
        const a = minutesOf(x.start)!;
        const b = minutesOf(x.end)!;
        return (x.end_next_day ? b + 1440 : b) - a;
      })
      .sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)]!;
    const dur = Math.max(15, Math.round(med / 15) * 15);
    const start = minutesOf(xs[0]!.start)!;
    if (start + dur >= 1440) continue; // über Mitternacht → als zwei Einsätze anlegen (von Hand)
    const pauses = xs.map((x) => x.break_minutes).sort((a, b) => a - b);
    shifts.push({
      id: uuidOf(`ft-shift:${k}`),
      employee_id: empId!,
      employee: xs[0]!.employee,
      site_id: siteId!,
      site: xs[0]!.site,
      weekday: Number(wd),
      start: xs[0]!.start.padStart(5, '0'),
      end: hhmm(start + dur),
      break_minutes: Math.min(180, pauses[Math.floor(pauses.length / 2)]!),
      count: xs.length,
      valid_from: xs.reduce((m, x) => (x.date < m ? x.date : m), xs[0]!.date),
      exists: planKey.has(`${empId}|${siteId}|${wd}`),
    });
  }
  shifts.sort((a, b) => a.employee.localeCompare(b.employee, 'de') || a.weekday - b.weekday);
  return { rows, shifts, issues, excluded, validFrom, newSites: [...newSites.values()] };
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
  let created = 0;
  let skipped = 0;
  const overlaps: string[] = [];
  for (const x of plan.rows) {
    if (x.exists) continue;
    const res = await sql.begin(async (tx) => {
      const [dup] = await tx`select 1 from app.time_entries where id = ${x.id}`;
      if (dup) return 'dup';
      const [ov] = await tx`
        select 1 from app.time_entries
         where employee_id = ${x.employee_id} and status <> 'abgelehnt' and end_at is not null
           and tstzrange(start_at, end_at) && tstzrange(
             ((${x.date}::date + ${x.start}::time) at time zone 'Europe/Berlin'),
             ((${x.date}::date + ${x.end_next_day ? 1 : 0}::int + ${x.end}::time) at time zone 'Europe/Berlin'))`;
      if (ov) return 'ov';
      await tx`
        insert into app.time_entries (id, employee_id, site_id, work_date, start_at, end_at, break_minutes, source,
                                      status, note, recorded_at, created_by, decided_by, decided_at)
        values (${x.id}, ${x.employee_id}, ${x.site_id}, ${x.date},
                ((${x.date}::date + ${x.start}::time) at time zone 'Europe/Berlin'),
                ((${x.date}::date + ${x.end_next_day ? 1 : 0}::int + ${x.end}::time) at time zone 'Europe/Berlin'),
                ${x.break_minutes}, 'buero', 'freigegeben', ${x.note},
                ((${x.date}::date + ${x.end_next_day ? 1 : 0}::int + ${x.end}::time) at time zone 'Europe/Berlin'),
                ${`ft-import:${opts.actor}`}, ${opts.actor}, now())`;
      return 'ok';
    });
    if (res === 'ok') created++;
    else if (res === 'ov') {
      skipped++;
      overlaps.push(`${x.date} ${x.employee} ${x.start}–${x.end}`);
    }
  }
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
         where id = ${s.id} and note = 'aus Fortytools-Zeiten abgeleitet' and valid_from > ${s.valid_from}`;
      shiftsUpdated += fixed.count;
      if (s.exists) continue;
      const r = await sql`
        insert into app.shift_plans (id, employee_id, site_id, weekday, start_time, end_time, break_minutes,
                                     valid_from, note, series_id, created_at)
        values (${s.id}, ${s.employee_id}, ${s.site_id}, ${s.weekday}, ${s.start}, ${s.end}, ${s.break_minutes},
                ${s.valid_from}, 'aus Fortytools-Zeiten abgeleitet', ${s.id},
                (${s.valid_from}::date)::timestamp at time zone 'Europe/Berlin')
        on conflict (id) do nothing`;
      shiftsCreated += r.count;
    }
  }
  return { created, skipped, overlaps, shiftsCreated, shiftsUpdated, excluded: plan.excluded };
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
       and (id = ${uuidOf(`ft-site:ft:o:${customerNo}|allgemein`)} or name = 'Allgemein (aus Fortytools)')
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
      name: 'Allgemein (aus Fortytools)',
      street: k.street,
      postal_code: k.postal_code,
      city: k.city,
    } as never,
    actor,
  );
  return id;
}
