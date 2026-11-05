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
  { key: 'kontakte', label: 'Ansprechpartner (Viva-Deluxe und Kunde) mit Telefon und E-Mail' },
  {
    key: 'personal',
    label: 'Eingesetzte Mitarbeitende mit Funktion, Schlüsseln/Transpondern, erster Einweisung',
  },
  { key: 'nachweise', label: 'Nachweise: Schweigepflicht, Unterweisung, Führungszeugnis (nur „liegt vor“)' },
  { key: 'vertretung', label: 'Vertretung / Stellvertretung' },
  { key: 'sicherheit', label: 'Notfall (Ersthelfer, Krankenhaus), Sicherheits- und Hygieneregeln' },
  { key: 'schulung', label: 'Ausbildung und Schulungen der Objektleitung' },
  { key: 'gbu', label: 'Gefährdungsbeurteilung je Objekt anhängen (Querformat)' },
] as const;
export type DossierPart = (typeof DOSSIER_PARTS)[number]['key'];

const CONFIDENTIAL = /verschwieg|schweige|vertraulich|datengeheim|datenschutz/i;
const CERT = /f(ü|ue)hrungszeugnis/i;
const TRAINING =
  /schulung|zertifikat|lehrgang|fortbildung|ausbildung|meister|qualifikation|seminar|sachkunde/i;

interface Person {
  id: string;
  name: string;
  role: string;
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
  firstAider: string | null;
  keysTotal: number;
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
    firstAider: f.firstAider,
    keysTotal: f.keys,
    people,
    substitutes: subs,
  };
}

const d8 = (s: string | null) => (s ? formatDateDe(s) : 'nicht hinterlegt');
const contactOf = (m: { name: string; phone: string | null; email: string | null } | null) =>
  m ? [m.name, m.phone, m.email].filter(Boolean).join(' · ') : 'nicht zugeordnet';

/**
 * PDF: Objekt- und Personalübersicht für einen Kunden (alle bzw. gewählte aktive Objekte). A4 quer und kompakt
 * (Ahmed 05.11.2026: „kürzer, quer, nicht zu viele Infos, keine Tage/Zeiten“): oben Ansprechpartner, je Objekt eine Zeile
 * mit Objektleitung (Telefon, E-Mail), Stellvertretung, Ersthelfer, Krankenhaus, dann die Tabelle der Mitarbeitenden.
 */
export async function buildCustomerDossierPdf(
  deps: Deps,
  customerId: string,
  o: { siteIds?: string[] | undefined; parts?: DossierPart[] | undefined; findHospital?: boolean } = {},
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
  // Nächstes Krankenhaus fehlt → aus Adresse/PLZ selbst ermitteln und am Objekt speichern (ohne Internet bleibt es leer)
  if (parts.has('sicherheit') && o.findHospital !== false) {
    const { fillHospital } = await import('./hospital.js');
    for (const id of siteIds) await fillHospital(sql, id, 'automatisch').catch(() => null);
  }
  const sites: SiteBlock[] = [];
  for (const id of siteIds) sites.push(await loadSite(sql, id, today));
  const contacts = await sql<
    { name: string; position: string | null; phone: string | null; email: string | null }[]
  >`
    select trim(coalesce(salutation || ' ', '') || coalesce(first_name || ' ', '') || last_name) as name, position,
           coalesce(nullif(phone, ''), mobile) as phone, email
      from app.contacts where customer_id = ${customerId} order by created_at`;
  const [co] = await sql<
    {
      managing_director: string | null;
      managing_director_email: string | null;
      phone: string | null;
      email: string;
    }[]
  >`select managing_director, managing_director_email, phone, email from app.company limit 1`;

  const { FormDoc, FORM_X } = await import('../pdf/form-doc.js');
  const tag = `${cu.customer_no} ${cu.name}`;
  const d = await FormDoc.create({
    landscape: true,
    title: `Objekt- und Personalübersicht ${tag}`,
    sideRef: `Objekt- und Personalübersicht ${tag} · Stand ${formatDateDe(today)}`,
    date: today,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  const W = d.R - FORM_X.L;
  const people = new Set(sites.flatMap((s) => s.people.map((p) => p.id))).size;
  d.title('Objekt- und Personalübersicht', `Stand ${formatDateDe(today)}`);
  d.para(
    `Auftraggeber: ${cu.name} (${cu.customer_no}) · ${sites.length} ${sites.length === 1 ? 'Objekt' : 'Objekte'} · ${people} eingesetzte Mitarbeitende`,
    { size: 9, bold: true },
  );
  d.muted(
    'Vertraulich – nur für den Reinigungsauftrag (Zutritt, Schlüssel-/Transponderverwaltung). Personenbezogene Angaben auf das Nötige beschränkt (Art. 5 Abs. 1 c DSGVO); Führungszeugnisse werden nicht weitergegeben, nur ob sie vorliegen.',
  );

  const contactCols = [
    { label: 'Name', width: 170 },
    { label: 'Funktion', width: 170 },
    { label: 'Telefon', width: 120 },
    { label: 'E-Mail', width: 180 },
    { label: 'Objekte', width: W - 640 },
  ];
  if (parts.has('kontakte')) {
    d.section('Ansprechpartner');
    const rows: string[][] = [
      [
        co?.managing_director ?? '–',
        'Geschäftsführung',
        co?.phone ?? '–',
        co?.managing_director_email ?? co?.email ?? '–',
        'alle',
      ],
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
    for (const c of contacts)
      rows.push([
        c.name,
        `${c.position ?? 'Ansprechpartner'} (Kunde)`,
        c.phone ?? '–',
        c.email ?? '–',
        'alle',
      ]);
    for (const s of sites) {
      if (s.info.ansprechpartner)
        rows.push([
          s.info.ansprechpartner,
          'Ansprechpartner Objekt (Kunde)',
          s.info.ansprechpartner_tel ?? '–',
          '–',
          s.site_no,
        ]);
      if (s.info.hausmeister)
        rows.push([s.info.hausmeister, 'Hausmeister / Haustechnik', '–', '–', s.site_no]);
    }
    d.table(contactCols, rows, { size: 7.8 });
  }

  const showPeople = parts.has('personal') || parts.has('nachweise');
  const pCols = [
    { label: 'Name', width: 150 },
    { label: 'Funktion', width: 95 },
    ...(parts.has('personal')
      ? [
          { label: 'Schlüssel / Transponder', width: 160 },
          { label: 'Erste Einweisung', width: 75 },
        ]
      : []),
    ...(parts.has('nachweise')
      ? [
          { label: 'Schweigepflicht', width: 80 },
          { label: 'Unterweisung', width: 80 },
          { label: 'Führungszeugnis', width: 85 },
        ]
      : []),
  ];
  // letzte Spalte füllt die Breite
  const used = pCols.reduce((a, c) => a + c.width, 0);
  pCols[pCols.length - 1]!.width = Math.max(70, pCols[pCols.length - 1]!.width + W - used);

  d.section('Objekte und eingesetzte Mitarbeitende');
  for (const s of sites) {
    d.ensure(110);
    d.heading(`${s.site_no} · ${s.name}`, 10);
    d.y += 13;
    d.muted(s.address || 'Adresse nicht hinterlegt');
    const head: { label: string; width: number }[] = [{ label: 'Objektleitung', width: 0 }];
    const row: string[] = [contactOf(s.manager)];
    if (parts.has('vertretung')) {
      head.push({ label: 'Stellvertretung', width: 0 });
      row.push(
        s.info.bereichsleitung
          ? [s.info.bereichsleitung, s.info.bereichsleitung_tel].filter(Boolean).join(' · ')
          : `Büro Viva-Deluxe${co?.phone ? ` · ${co.phone}` : ''}`,
      );
    }
    if (parts.has('sicherheit')) {
      head.push({ label: 'Ersthelfer', width: 0 }, { label: 'Nächstes Krankenhaus', width: 0 });
      row.push(s.firstAider ?? 'nicht hinterlegt', s.info.krankenhaus ?? 'nicht hinterlegt');
    }
    head.forEach((h) => (h.width = Math.floor(W / head.length)));
    d.table(head, [row], { size: 7.8 });
    if (showPeople) {
      if (s.people.length)
        d.table(
          pCols,
          s.people.map((p) => [
            p.name,
            p.role,
            ...(parts.has('personal') ? [p.keys.join('\n') || '–', d8(p.since)] : []),
            ...(parts.has('nachweise')
              ? [
                  d8(p.confidential),
                  d8(p.instruction),
                  p.certificate ? `liegt vor (${formatDateDe(p.certificate)})` : 'nicht hinterlegt',
                ]
              : []),
          ]),
          { size: 7.8 },
        );
      else d.muted('Derzeit keine Mitarbeitenden eingeplant.');
    }
    if (parts.has('vertretung') && s.substitutes.length)
      d.muted(
        `Geplante Vertretungen: ${s.substitutes
          .slice(0, 8)
          .map((x) => `${formatDateDe(x.date)} ${x.by} für ${x.for}`)
          .join(' · ')}${s.substitutes.length > 8 ? ` · + ${s.substitutes.length - 8} weitere` : ''}`,
      );
    if (parts.has('sicherheit') && s.info.besonderheiten) d.muted(`Besonderheiten: ${s.info.besonderheiten}`);
  }
  if (parts.has('personal'))
    d.muted(
      'Schlüssel/Transponder laut Schlüsselbuch (quittiert ausgegeben, bei Austritt zurückgenommen). Erste Einweisung = erster Einsatz im Objekt laut Einsatzplanung, Einweisung vor Ort durch die Objektleitung.',
    );

  if (parts.has('sicherheit')) {
    d.ensure(80);
    d.section('Sicherheit, Hygiene und Notfall');
    d.para(
      [
        `• Notruf 112 · Polizei 110 · Giftnotruf 089 19240 · Büro Viva-Deluxe ${co?.phone ?? ''}`.trim(),
        '• Zutritt nur für eingewiesene, eingeplante Mitarbeitende; Bereiche mit Zugangsbeschränkung nur nach Vorgabe des Auftraggebers. Türen/Fenster nach der Reinigung verschließen.',
        '• Hygiene: Farbsystem für Tücher (rot WC/Urinal, gelb Sanitär, blau Büro, grün Küche), Handschuhe und Hautschutz, Reinigungsmittel nur aus gekennzeichneten Originalgebinden nach Dosierplan.',
        '• Arbeitsschutz nach Gefährdungsbeurteilung; Unterweisung vor Aufnahme der Tätigkeit und jährlich (§ 12 ArbSchG).',
      ].join('\n'),
      { size: 8.3 },
    );
  }

  if (parts.has('schulung')) {
    const seen = new Set<string>();
    const rows: string[][] = [];
    for (const s of sites) {
      const m = s.manager;
      if (!m?.employee_id || seen.has(m.employee_id)) continue;
      seen.add(m.employee_id);
      const sig = await sql<{ title: string; d: string }[]>`
        select d.title, to_char(r.signed_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d
          from app.sign_requests r join app.sign_documents d on d.id = r.document_id
         where r.employee_id = ${m.employee_id} and r.status = 'unterschrieben' order by r.signed_at`;
      const fil = (
        await sql<{ name: string; d: string }[]>`
          select coalesce(l.display_name, f.original_name) as name,
                 to_char(l.linked_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as d
            from app.file_links l join app.files f on f.id = l.file_id
           where l.entity_type = 'employee' and l.entity_id = ${m.employee_id} and l.archived_at is null
             and f.status = 'complete' order by l.linked_at`
      ).filter((x) => TRAINING.test(x.name));
      for (const x of fil)
        rows.push([
          m.name,
          x.name.replace(/\.[a-z0-9]{2,4}$/i, ''),
          'Nachweis in der Personalakte',
          formatDateDe(x.d),
        ]);
      for (const x of sig) rows.push([m.name, x.title, 'Unterweisung, unterschrieben', formatDateDe(x.d)]);
      if (!fil.length && !sig.length) rows.push([m.name, 'keine Nachweise hinterlegt', '–', '–']);
    }
    if (rows.length) {
      d.ensure(90);
      d.section('Ausbildung und Schulungen der Objektleitung');
      d.table(
        [
          { label: 'Objektleitung', width: 170 },
          { label: 'Schulung / Nachweis', width: 300 },
          { label: 'Art', width: 170 },
          { label: 'Datum', width: W - 640 },
        ],
        rows,
        { size: 7.8 },
      );
    }
  }

  if (parts.has('gbu') && sites.length) {
    const { riskFacts, drawRiskAssessment } = await import('./risk-assessment.js');
    for (const s of sites) {
      d.newPage({ landscape: true });
      drawRiskAssessment(d, await folderFacts(sql, s.id), await riskFacts(sql, s.id), today);
    }
  }
  const safe = (t: string) => t.replace(/[^\w.-]+/g, '_');
  return { pdf: await d.save(), name: `Objekt-Personaluebersicht_${safe(cu.customer_no)}_${today}.pdf` };
}
