/**
 * Objekt- und Personalübersicht für Kunden als PDF (Ahmed 05.11.2026: „viele Kunden wollen solche Listen – eingesetzte
 * Mitarbeitende, Ansprechpartner, Schlüssel/Transponder, Vertretungen, Schweigepflicht, Schulung der Objektleitung,
 * Sicherheits-/Hygieneregeln, Notfallkontakte, Zugang, erste Einweisung – die Sachen, die da sind“).
 *
 * Nur, was in der App vorhanden ist; fehlt etwas, steht „nicht hinterlegt“ (nichts wird erfunden). Datenschutz: an den
 * Kunden gehen nur Name, Funktion und Einsatz der Mitarbeitenden – keine Anschrift, kein Geburtsdatum, keine privaten
 * Telefonnummern. Führungszeugnisse werden nicht mitgeschickt, nur „liegt vor (Datum)“.
 */
import type { Sql } from '../db/client.js';
import { addDays, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type FolderInfo, folderFacts } from './site-folder.js';
import type { Deps } from './workflow.js';

export const DOSSIER_PARTS = [
  { key: 'kontakte', label: 'Ansprechpartner (Viva-Deluxe und Kunde)' },
  {
    key: 'personal',
    label: 'Eingesetzte Mitarbeitende mit Einsatzzeiten, Schlüsseln/Transpondern, erstem Einsatz',
  },
  { key: 'nachweise', label: 'Nachweise: Schweigepflicht, Unterweisung, Führungszeugnis (nur „liegt vor“)' },
  { key: 'vertretung', label: 'Vertretungen / Stellvertretungen' },
  { key: 'sicherheit', label: 'Sicherheits- und Hygieneregeln, Notfallkontakte, Zugang' },
  { key: 'schulung', label: 'Ausbildung und Schulungen der Objektleitung' },
  { key: 'gbu', label: 'Gefährdungsbeurteilung je Objekt anhängen (Querformat)' },
] as const;
export type DossierPart = (typeof DOSSIER_PARTS)[number]['key'];

const DAYS = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const CONFIDENTIAL = /verschwieg|schweige|vertraulich|datengeheim|datenschutz/i;
const CERT = /f(ü|ue)hrungszeugnis/i;
const TRAINING =
  /schulung|zertifikat|lehrgang|fortbildung|ausbildung|meister|qualifikation|seminar|sachkunde/i;

interface Person {
  id: string;
  name: string;
  role: string;
  times: string;
  since: string | null;
  keys: string[];
  confidential: string | null;
  instruction: string | null;
  certificate: string | null;
}

interface SiteBlock {
  id: string;
  site_no: string;
  name: string;
  address: string;
  manager: { name: string; phone: string | null; email: string | null; employee_id: string | null } | null;
  info: FolderInfo;
  people: Person[];
  substitutes: { date: string; for: string; by: string }[];
}

/** Funktion aus den Tags bzw. der Beschäftigungsart */
function roleOf(tags: string[]): string {
  const t = tags.map((x) => x.toLowerCase());
  if (t.some((x) => x.includes('objektleitung') || x.includes('objektleiter'))) return 'Objektleitung';
  if (t.some((x) => x.includes('vorarbeit'))) return 'Vorarbeiter/in';
  if (t.some((x) => x.includes('glas'))) return 'Glasreiniger/in';
  if (t.some((x) => x.includes('hausmeister'))) return 'Hausmeister/in';
  return 'Reinigungskraft';
}

/** „Mo, Mi, Fr 17:00–21:30“ – gleiche Zeiten zusammengefasst */
function timesOf(rows: { weekday: number; t: string }[]): string {
  const byTime = new Map<string, Set<number>>();
  for (const r of rows) byTime.set(r.t, (byTime.get(r.t) ?? new Set()).add(r.weekday));
  return [...byTime]
    .map(
      ([t, ds]) =>
        `${[...ds]
          .sort()
          .map((d) => DAYS[d])
          .join(', ')} ${t}`,
    )
    .join('; ');
}

async function loadSite(sql: Sql, siteId: string, today: string): Promise<SiteBlock> {
  const f = await folderFacts(sql, siteId);
  const [mp] = await sql<{ user_id: string | null; employee_id: string | null }[]>`
    select s.manager_user_id as user_id,
           coalesce(p.employee_id, (select e.id from app.employees e
              where e.status = 'aktiv' and lower(trim(e.first_name || ' ' || e.last_name)) = lower(trim(p.display_name))
              order by e.personnel_no limit 1)) as employee_id
      from app.sites s left join app.profiles p on p.user_id = s.manager_user_id where s.id = ${siteId}`;
  const plans = await sql<
    {
      employee_id: string;
      name: string;
      tags: string[];
      weekday: number;
      t: string;
      since: string;
    }[]
  >`
    select p.employee_id, e.first_name || ' ' || e.last_name as name, e.tags, p.weekday,
           to_char(p.start_time, 'HH24:MI') || '–' || to_char(p.end_time, 'HH24:MI') as t,
           to_char(min(p.valid_from) over (partition by p.employee_id), 'YYYY-MM-DD') as since
      from app.shift_plans p join app.employees e on e.id = p.employee_id
     where p.site_id = ${siteId} and p.employee_id is not null
       and (p.valid_until is null or p.valid_until >= ${today}::date)
       and (e.exit_date is null or e.exit_date >= ${today}::date)
     order by e.last_name, e.first_name, p.weekday`;
  // „seit“ = erster Einsatz am Objekt überhaupt (auch beendete Einsätze)
  const first = new Map(
    (
      await sql<{ employee_id: string; d: string }[]>`
        select employee_id, to_char(min(valid_from), 'YYYY-MM-DD') as d from app.shift_plans
         where site_id = ${siteId} and employee_id is not null group by employee_id`
    ).map((x) => [x.employee_id, x.d]),
  );
  const ids = [...new Set(plans.map((p) => p.employee_id))];
  if (mp?.employee_id && !ids.includes(mp.employee_id)) ids.push(mp.employee_id);
  const keys = await sql<{ holder: string; k: string }[]>`
    select holder_employee_id as holder, key_no || ' (' || description || ')' as k from app.keys
     where site_id = ${siteId} and deleted_at is null and holder_employee_id = any(${ids}::uuid[])
     order by key_no`;
  const signed = await sql<{ employee_id: string; title: string; category: string; d: string }[]>`
    select r.employee_id, d.title, d.category::text as category, to_char(r.signed_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d
      from app.sign_requests r join app.sign_documents d on d.id = r.document_id
     where r.status = 'unterschrieben' and r.employee_id = any(${ids}::uuid[])
     order by r.signed_at`;
  const files = await sql<{ employee_id: string; name: string; d: string }[]>`
    select l.entity_id as employee_id, coalesce(l.display_name, f.original_name) as name,
           to_char(l.linked_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d
      from app.file_links l join app.files f on f.id = l.file_id
     where l.entity_type = 'employee' and l.entity_id = any(${ids}::uuid[]) and l.archived_at is null
       and f.status = 'complete'
     order by l.linked_at`;
  const people: Person[] = [];
  for (const id of ids) {
    const own = plans.filter((p) => p.employee_id === id);
    let name = own[0]?.name;
    let tags = own[0]?.tags ?? [];
    if (!name) {
      const [e] = await sql<{ name: string; tags: string[] }[]>`
        select first_name || ' ' || last_name as name, tags from app.employees where id = ${id}`;
      if (!e) continue;
      name = e.name;
      tags = e.tags;
    }
    const sig = signed.filter((s) => s.employee_id === id);
    const fil = files.filter((x) => x.employee_id === id);
    const conf =
      sig.find((s) => s.category === 'datenschutz' || CONFIDENTIAL.test(s.title))?.d ??
      fil.find((x) => CONFIDENTIAL.test(x.name))?.d ??
      null;
    const isMgr = id === mp?.employee_id;
    people.push({
      id,
      name,
      role: isMgr ? 'Objektleitung' : roleOf(tags),
      times: own.length ? timesOf(own) : isMgr ? 'Betreuung des Objekts' : '–',
      since: first.get(id) ?? null,
      keys: keys.filter((k) => k.holder === id).map((k) => k.k),
      confidential: conf,
      instruction: sig.find((s) => s.category === 'unterweisung')?.d ?? sig[0]?.d ?? null,
      certificate: fil.find((x) => CERT.test(x.name))?.d ?? null,
    });
  }
  people.sort((a, b) => Number(b.role === 'Objektleitung') - Number(a.role === 'Objektleitung'));
  const subs = await sql<{ date: string; for: string; by: string }[]>`
    select to_char(x.work_date, 'YYYY-MM-DD') as date, a.first_name || ' ' || a.last_name as for,
           b.first_name || ' ' || b.last_name as by
      from app.shift_exceptions x join app.shift_plans p on p.id = x.shift_plan_id
      join app.employees a on a.id = p.employee_id join app.employees b on b.id = x.substitute_employee_id
     where p.site_id = ${siteId} and x.kind = 'vertretung'
       and x.work_date between ${today}::date and ${addDays(today, 60)}::date
     order by x.work_date limit 40`;
  return {
    id: siteId,
    site_no: f.site.site_no,
    name: f.site.name,
    address: [f.site.street, [f.site.postal_code, f.site.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', '),
    manager: f.manager ? { ...f.manager, employee_id: mp?.employee_id ?? null } : null,
    info: f.info,
    people,
    substitutes: subs,
  };
}

const d8 = (s: string | null) => (s ? formatDateDe(s) : 'nicht hinterlegt');

/** PDF: Objekt- und Personalübersicht für einen Kunden (alle bzw. gewählte aktive Objekte). */
export async function buildCustomerDossierPdf(
  deps: Deps,
  customerId: string,
  o: { siteIds?: string[] | undefined; parts?: DossierPart[] | undefined } = {},
) {
  const { sql } = deps;
  const today = todayBerlin();
  const parts = new Set<DossierPart>(
    o.parts?.length ? o.parts : DOSSIER_PARTS.map((p) => p.key).filter((k) => k !== 'gbu'),
  );
  const [cu] = await sql<{ name: string; customer_no: string }[]>`
    select name, customer_no from app.customers where id = ${customerId}`;
  if (!cu) throw new Error('Kunde nicht gefunden');
  let siteIds = (
    await sql<
      { id: string }[]
    >`select id from app.sites where customer_id = ${customerId} and active order by site_no`
  ).map((x) => x.id);
  if (o.siteIds?.length) siteIds = siteIds.filter((x) => o.siteIds!.includes(x));
  const sites: SiteBlock[] = [];
  for (const id of siteIds) sites.push(await loadSite(sql, id, today));
  const contacts = await sql<
    { name: string; position: string | null; phone: string | null; email: string | null }[]
  >`
    select trim(coalesce(salutation || ' ', '') || coalesce(first_name || ' ', '') || last_name) as name, position,
           coalesce(nullif(phone, ''), mobile) as phone, email
      from app.contacts where customer_id = ${customerId} order by created_at`;
  const [co] = await sql<{ managing_director: string | null; phone: string | null; email: string }[]>`
    select managing_director, phone, email from app.company limit 1`;

  const { FormDoc, FORM_X } = await import('../pdf/form-doc.js');
  const tag = `${cu.customer_no} ${cu.name}`;
  const d = await FormDoc.create({
    title: `Objekt- und Personalübersicht ${tag}`,
    sideRef: `Objekt- und Personalübersicht ${tag} · Stand ${formatDateDe(today)}`,
    date: today,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  const W = FORM_X.R - FORM_X.L;
  d.title('Objekt- und Personalübersicht', `Stand ${formatDateDe(today)}`);
  d.infoGrid(
    [
      ['Auftraggeber', `${cu.name} (${cu.customer_no})`],
      [
        'Umfang',
        `${sites.length} ${sites.length === 1 ? 'Objekt' : 'Objekte'} · ${
          new Set(sites.flatMap((s) => s.people.map((p) => p.id))).size
        } eingesetzte Mitarbeitende`,
      ],
    ],
    2,
  );
  d.muted(
    'Vertraulich – nur zur Verwendung für den Reinigungsauftrag (Zutritt, Schlüssel-/Transponderverwaltung). Personenbezogene Angaben auf das Nötige beschränkt (Art. 5 Abs. 1 c DSGVO); Führungszeugnisse werden nicht weitergegeben, nur ob sie vorliegen.',
  );

  if (parts.has('kontakte')) {
    d.section('Ansprechpartner');
    const rows: string[][] = [
      [co?.managing_director ?? '–', 'Geschäftsführung', co?.phone ?? '–', co?.email ?? '–', 'alle'],
      ['Büro Viva-Deluxe', 'Zentrale / Disposition', co?.phone ?? '–', co?.email ?? '–', 'alle'],
    ];
    const mgrs = new Map<string, { m: NonNullable<SiteBlock['manager']>; nos: string[] }>();
    for (const s of sites)
      if (s.manager) {
        const e = mgrs.get(s.manager.name) ?? { m: s.manager, nos: [] };
        e.nos.push(s.site_no);
        mgrs.set(s.manager.name, e);
      }
    for (const { m, nos } of mgrs.values())
      rows.push([m.name, 'Objektleitung', m.phone ?? '–', m.email ?? '–', nos.join(', ')]);
    const bls = new Map<string, { tel: string; nos: string[] }>();
    for (const s of sites)
      if (s.info.bereichsleitung) {
        const e = bls.get(s.info.bereichsleitung) ?? { tel: s.info.bereichsleitung_tel ?? '–', nos: [] };
        e.nos.push(s.site_no);
        bls.set(s.info.bereichsleitung, e);
      }
    for (const [n, e] of bls)
      rows.push([n, 'Bereichsleitung (Stellvertretung)', e.tel, '–', e.nos.join(', ')]);
    d.heading('Viva-Deluxe Gebäudereinigung GmbH', 10);
    d.y += 14;
    d.table(
      [
        { label: 'Name', width: 120 },
        { label: 'Funktion', width: 110 },
        { label: 'Telefon', width: 85 },
        { label: 'E-Mail', width: 125 },
        { label: 'Objekte', width: W - 440 },
      ],
      rows,
      { size: 7.8 },
    );
    const kRows: string[][] = contacts.map((c) => [
      c.name,
      c.position ?? '–',
      c.phone ?? '–',
      c.email ?? '–',
      'alle',
    ]);
    for (const s of sites) {
      if (s.info.ansprechpartner)
        kRows.push([
          s.info.ansprechpartner,
          'Ansprechpartner Objekt',
          s.info.ansprechpartner_tel ?? '–',
          '–',
          s.site_no,
        ]);
      if (s.info.hausmeister)
        kRows.push([s.info.hausmeister, 'Hausmeister / Haustechnik', '–', '–', s.site_no]);
    }
    d.heading(`Auftraggeber ${cu.name}`, 10);
    d.y += 14;
    if (kRows.length)
      d.table(
        [
          { label: 'Name', width: 120 },
          { label: 'Funktion', width: 110 },
          { label: 'Telefon', width: 85 },
          { label: 'E-Mail', width: 125 },
          { label: 'Objekte', width: W - 440 },
        ],
        kRows,
        { size: 7.8 },
      );
    else d.muted('Keine Ansprechpartner hinterlegt (Kunde → Kontakte bzw. Objekt → Objektordner).');
  }

  for (const s of sites) {
    d.newPage();
    d.title(`${s.name}`, s.site_no);
    d.muted(s.address || 'Adresse nicht hinterlegt');
    if (parts.has('personal')) {
      d.section('Eingesetzte Mitarbeitende und Einsatzorte');
      if (s.people.length)
        d.table(
          [
            { label: 'Name', width: 115 },
            { label: 'Funktion', width: 80 },
            { label: 'Einsatztage / -zeiten', width: 112 },
            { label: 'Erster Einsatz', width: 72 },
            { label: 'Schlüssel / Transponder', width: W - 379 },
          ],
          s.people.map((p) => [p.name, p.role, p.times, d8(p.since), p.keys.join('\n') || '–']),
          { size: 7.8 },
        );
      else d.muted('Derzeit keine Einsätze geplant.');
      d.muted(
        'Erster Einsatz = erster Tag laut Einsatzplanung; die Einweisung vor Ort erfolgt durch die Objektleitung vor bzw. am ersten Einsatz im Objekt.',
      );
    }
    if (parts.has('nachweise') && s.people.length) {
      d.section('Nachweise');
      d.table(
        [
          { label: 'Name', width: 125 },
          { label: 'Schweigepflicht am', width: 125 },
          { label: 'Unterweisung am', width: 125 },
          { label: 'Führungszeugnis', width: W - 375 },
        ],
        s.people.map((p) => [
          p.name,
          d8(p.confidential),
          d8(p.instruction),
          p.certificate ? `liegt vor (seit ${formatDateDe(p.certificate)})` : 'nicht hinterlegt',
        ]),
        { size: 7.8 },
      );
      d.muted(
        'Schweigepflicht/Unterweisung: digital unterschrieben in der App bzw. als Scan in der Personalakte. Führungszeugnisse werden nur mit Einwilligung der Person eingeholt und nicht weitergegeben.',
      );
    }
    if (parts.has('vertretung')) {
      d.section('Vertretung / Stellvertretung');
      const lines = [
        `Stellvertretung der Objektleitung: ${
          s.info.bereichsleitung
            ? [s.info.bereichsleitung, s.info.bereichsleitung_tel].filter(Boolean).join(', ')
            : `Büro Viva-Deluxe${co?.phone ? `, ${co.phone}` : ''}`
        }`,
        'Bei Urlaub oder Krankheit plant die Objektleitung eine eingewiesene Vertretung ein.',
      ];
      d.para(lines.join('\n'), { size: 8.5 });
      if (s.substitutes.length)
        d.table(
          [
            { label: 'Datum', width: 80 },
            { label: 'Vertretung für', width: 200 },
            { label: 'durch', width: W - 280 },
          ],
          s.substitutes.map((x) => [formatDateDe(x.date), x.for, x.by]),
          { size: 7.8 },
        );
    }
    if (parts.has('sicherheit')) {
      d.section('Sicherheit, Hygiene, Notfall und Zugang');
      const i = s.info;
      const kv: [string, string][] = [
        ['Notruf / Feuerwehr', '112 · Polizei 110 · Giftnotruf 089 19240'],
        ['Büro Viva-Deluxe', co?.phone ?? '–'],
        ['Objektleitung', s.manager ? [s.manager.name, s.manager.phone].filter(Boolean).join(', ') : '–'],
        ['Ersthelfer', i.ersthelfer || 'nicht hinterlegt'],
        ['Nächstes Krankenhaus', i.krankenhaus || 'nicht hinterlegt'],
        ['Sammelplatz', i.sammelplatz || 'nicht hinterlegt'],
        ['Notausgang', i.notausgang || 'nicht hinterlegt'],
        ['Zugang / Schlüssel', i.zugang || 'nicht hinterlegt'],
        ['Putzraum', i.putzraum || 'nicht hinterlegt'],
      ];
      d.table(
        [
          { label: 'Angabe', width: 140 },
          { label: '', width: W - 140 },
        ],
        kv.map(([k, v]) => [k, v]),
        { size: 8 },
      );
      d.para(
        [
          '• Zutritt nur für eingewiesene, eingeplante Mitarbeitende; Schlüssel/Transponder werden quittiert ausgegeben (Schlüsselbuch) und bei Austritt zurückgenommen.',
          '• Bereiche mit Zugangsbeschränkung nur nach Vorgabe des Auftraggebers betreten; Türen und Fenster nach der Reinigung verschließen, Alarmanlage nach Absprache.',
          '• Hygiene: Farbsystem für Tücher (rot WC/Urinal, gelb Sanitär, blau Büro, grün Küche), Handschuhe und Hautschutz, Reinigungsmittel nur aus gekennzeichneten Originalgebinden nach Dosierplan.',
          '• Arbeitsschutz nach Gefährdungsbeurteilung; Unterweisung vor Aufnahme der Tätigkeit und jährlich (§ 12 ArbSchG).',
          ...(i.besonderheiten ? [`• Besonderheiten im Objekt: ${i.besonderheiten}`] : []),
        ].join('\n'),
        { size: 8.3 },
      );
    }
    if (parts.has('schulung') && s.manager?.employee_id) {
      const { manager } = s;
      const sig = await sql<{ title: string; d: string }[]>`
        select d.title, to_char(r.signed_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d
          from app.sign_requests r join app.sign_documents d on d.id = r.document_id
         where r.employee_id = ${manager.employee_id} and r.status = 'unterschrieben' order by r.signed_at`;
      const fil = (
        await sql<{ name: string; d: string }[]>`
          select coalesce(l.display_name, f.original_name) as name,
                 to_char(l.linked_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d
            from app.file_links l join app.files f on f.id = l.file_id
           where l.entity_type = 'employee' and l.entity_id = ${manager.employee_id} and l.archived_at is null
             and f.status = 'complete' order by l.linked_at`
      ).filter((x) => TRAINING.test(x.name));
      d.section(`Ausbildung und Schulungen der Objektleitung (${manager.name})`);
      const rows = [
        ...fil.map((x) => [
          x.name.replace(/\.[a-z0-9]{2,4}$/i, ''),
          'Nachweis in der Personalakte',
          formatDateDe(x.d),
        ]),
        ...sig.map((x) => [x.title, 'Unterweisung, unterschrieben', formatDateDe(x.d)]),
      ];
      if (rows.length)
        d.table(
          [
            { label: 'Schulung / Nachweis', width: 260 },
            { label: 'Art', width: 150 },
            { label: 'Datum', width: W - 410 },
          ],
          rows,
          { size: 7.8 },
        );
      else d.muted('Keine Schulungsnachweise hinterlegt (Personalakte der Objektleitung).');
    }
  }

  if (parts.has('gbu') && sites.length) {
    const { riskFacts, drawRiskAssessment } = await import('./risk-assessment.js');
    await d.loadLogo();
    for (const s of sites) {
      d.newPage({ landscape: true });
      drawRiskAssessment(d, await folderFacts(sql, s.id), await riskFacts(sql, s.id), today);
    }
    d.landscape = false;
  }
  const safe = (t: string) => t.replace(/[^\w.-]+/g, '_');
  return { pdf: await d.save(), name: `Objekt-Personaluebersicht_${safe(cu.customer_no)}_${today}.pdf` };
}
