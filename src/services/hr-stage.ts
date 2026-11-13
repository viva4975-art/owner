import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';
import { holdings } from './handovers.js';
import { freeMovement } from './hr-required-docs.js';

/*
 * Status je Mitarbeiter und Checklisten für Ein- und Austritt (Ahmed 13.11., Vorbild Blink).
 * Der Status ist eine Anzeige für Personal/Büro; maßgeblich für Planung, Lohn und App bleibt employees.status
 * (aktiv/ausgetreten) mit Ein- und Austrittsdatum. Gekündigt/ausgeschieden ergeben sich aus dem Austrittsdatum.
 */

export const HR_STAGE = {
  bewerber: { label: 'Bewerber', tone: 'grey' },
  einstellung: { label: 'In Einstellung', tone: 'warn' },
  vertrag: { label: 'Vertrag unterschrieben', tone: 'info' },
  aktiv: { label: 'Aktiv', tone: 'ok' },
  ruhend: { label: 'Ruhend', tone: 'grey' },
  gekuendigt: { label: 'Gekündigt', tone: 'err' },
  freigestellt: { label: 'Freigestellt', tone: 'err' },
  ausgeschieden: { label: 'Ausgeschieden', tone: 'grey' },
} as const;
export type HrStage = keyof typeof HR_STAGE;
/** von Hand wählbar (gekündigt/ausgeschieden kommen aus dem Austrittsdatum) */
export const HR_STAGE_SELECTABLE: HrStage[] = [
  'bewerber',
  'einstellung',
  'vertrag',
  'aktiv',
  'ruhend',
  'freigestellt',
];

export function stageOf(
  e: { status: string; exit_date: string | null; hr_stage?: string | null },
  today = todayBerlin(),
): HrStage {
  if (e.status === 'ausgetreten' || (e.exit_date && e.exit_date < today)) return 'ausgeschieden';
  if (e.hr_stage === 'freigestellt') return 'freigestellt';
  if (e.exit_date) return 'gekuendigt';
  return (e.hr_stage as HrStage | null) ?? 'aktiv';
}

export interface CheckItem {
  key: string;
  label: string;
  done: boolean;
  /** automatisch erkannt (nicht abhakbar) */
  auto: boolean;
  /** Hinweis rechts (z. B. „automatisch“, Datum) */
  info?: string | undefined;
  /** Weg zum Erledigen */
  href?: string | undefined;
  hrefLabel?: string | undefined;
  /** eigener Punkt (löschbar) */
  own?: boolean;
}

const MANUAL_IN: [string, string, string?][] = [
  ['sofortmeldung', 'Sofortmeldung erledigt (Lexware / sv.net)'],
  ['lexware', 'In Lexware Lohn angelegt'],
  ['app', 'Handy-App: Anmeldung erklärt (Personalnr. + PIN)'],
];
const MANUAL_OUT: [string, string][] = [
  ['abmeldung', 'Abmeldung Sozialversicherung (Lexware)'],
  ['letzte_abrechnung', 'Letzte Lohnabrechnung inkl. Resturlaub'],
  ['bescheinigung', 'Arbeitsbescheinigung / Zeugnis (falls verlangt)'],
];

/** Einstellungs-Checkliste anzeigen? (Status in Einstellung/Vertrag oder Eintritt ≤ 60 Tage bzw. in der Zukunft) */
export function showEntryList(stage: HrStage, entry: string | null, today = todayBerlin()) {
  return (
    stage === 'einstellung' ||
    stage === 'vertrag' ||
    stage === 'bewerber' ||
    (!!entry && entry >= addDays(today, -60))
  );
}

export async function checklist(sql: Sql, employeeId: string, phase: 'ein' | 'aus'): Promise<CheckItem[]> {
  const base = `/personal/${employeeId}`;
  const [row] = await sql<
    {
      cats: string[] | null;
      ho: string[] | null;
      not_needed: string[];
      signed_instruction: boolean;
      data_missing: string[] | null;
      nationality: string | null;
      permit: string | null;
      plans: number;
      forms: number;
    }[]
  >`
    select e.docs_not_needed as not_needed, p.nationality,
           least(p.residence_permit_until, p.work_permit_until)::text as permit,
           array_remove(array[
             case when coalesce(p.tax_id, '') = '' then 'Steuer-ID' end,
             case when coalesce(p.social_security_no, '') = '' then 'SV-Nummer' end,
             case when coalesce(p.iban, '') = '' then 'IBAN' end,
             case when coalesce(p.health_insurance, '') = '' then 'Krankenkasse' end,
             case when p.birth_date is null then 'Geburtsdatum' end,
             case when coalesce(p.street, '') = '' or coalesce(p.city, '') = '' then 'Anschrift' end
           ], null) as data_missing,
           (select array_agg(distinct l.category) from app.file_links l join app.files f on f.id = l.file_id
             where l.entity_type = 'employee' and l.entity_id = e.id and f.status = 'complete' and l.archived_at is null) as cats,
           exists (select 1 from app.sign_requests sr join app.sign_documents sd on sd.id = sr.document_id
                    where sr.employee_id = e.id and sr.status = 'unterschrieben' and sd.category = 'unterweisung') as signed_instruction,
           (select array_agg(distinct h.kind) from app.handovers h
             where h.employee_id = e.id and h.status in ('unterschrieben', 'ohne_unterschrift') and h.direction = 'ausgabe') as ho,
           (select count(*)::int from app.shift_plans sp where sp.employee_id = e.id
              and (sp.valid_until is null or sp.valid_until >= current_date)) as plans,
           (select count(*)::int from app.personnel_forms f where f.employee_id = e.id) as forms
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     where e.id = ${employeeId}`;
  if (!row) return [];
  const manual = await sql<
    { key: string; label: string | null; done_at: Date | null; done_by: string | null }[]
  >`
    select key, label, done_at, done_by from app.employee_checklist
     where employee_id = ${employeeId} and phase = ${phase} order by created_at`;
  const m = new Map(manual.map((x) => [x.key, x]));
  const doneInfo = (k: string) => {
    const x = m.get(k);
    return x?.done_at ? `${x.done_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}` : undefined;
  };
  const items: CheckItem[] = [];
  const cats = new Set(row.cats ?? []);
  const ho = new Set(row.ho ?? []);
  const nn = (d: string) => row.not_needed.includes(d);
  if (phase === 'ein') {
    items.push({
      key: 'personalbogen',
      label: 'Personalbogen / Personalunterlagen',
      done: row.forms > 0 || cats.has('Personalunterlagen'),
      auto: true,
      href: `${base}/dokumente#hochladen`,
      hrefLabel: 'Hochladen',
    });
    items.push({
      key: 'stammdaten',
      label: row.data_missing?.length
        ? `Stammdaten vollständig (fehlt: ${row.data_missing.join(', ')})`
        : 'Stammdaten vollständig (Steuer-ID, SV-Nr., IBAN, Krankenkasse …)',
      done: !row.data_missing?.length,
      auto: true,
      href: `${base}/bearbeiten`,
      hrefLabel: 'Ergänzen',
    });
    const nat = row.nationality ?? '';
    if (!nat.trim() || !freeMovement(nat))
      items.push({
        key: 'aufenthalt',
        label: 'Aufenthaltstitel / Arbeitserlaubnis gültig',
        done: !!nat.trim() && !!row.permit && row.permit >= todayBerlin(),
        auto: true,
        href: `${base}/bearbeiten`,
        hrefLabel: 'Eintragen',
      });
    items.push({
      key: 'vertrag',
      label: 'Arbeitsvertrag unterschrieben (Scan in der Akte)',
      done: cats.has('Arbeitsvertrag'),
      auto: true,
      href: `${base}/dokumente#hochladen`,
      hrefLabel: 'Hochladen',
    });
    for (const [k, label] of MANUAL_IN)
      items.push({ key: k, label, done: !!m.get(k)?.done_at, auto: false, info: doneInfo(k) });
    if (!nn('Unterweisung'))
      items.push({
        key: 'unterweisung',
        label: 'Unterweisung unterschrieben',
        done: row.signed_instruction || cats.has('Unterweisung'),
        auto: true,
        href: `${base}/uebergaben/unterweisung`,
        hrefLabel: 'In App senden',
      });
    if (!nn('Arbeitskleidung'))
      items.push({
        key: 'kleidung',
        label: 'Arbeitskleidung ausgegeben',
        done: ho.has('kleidung') || cats.has('Arbeitskleidung'),
        auto: true,
        href: `${base}/uebergaben/kleidung`,
        hrefLabel: 'Übergabe',
      });
    if (!nn('Schlüssel'))
      items.push({
        key: 'schluessel',
        label: 'Schlüssel ausgegeben (falls nötig)',
        done: ho.has('schluessel') || cats.has('Schlüssel'),
        auto: true,
        href: `${base}/uebergaben/schluessel`,
        hrefLabel: 'Ausgeben',
      });
    items.push({
      key: 'einsatz',
      label: 'Einsatz geplant',
      done: row.plans > 0,
      auto: true,
      href: `/einsatzplanung/${randomUUID()}?mitarbeiter=${employeeId}&zurueck=${encodeURIComponent(base)}`,
      hrefLabel: 'Planen',
    });
  } else {
    const h = await holdings(sql, employeeId);
    items.push({
      key: 'r_kleidung',
      label: h.clothing.length
        ? `Arbeitskleidung zurück (offen: ${h.clothing.map((x) => `${x.qty}× ${x.name}`).join(', ')})`
        : 'Arbeitskleidung zurück',
      done: h.clothing.length === 0,
      auto: true,
      href: `${base}/uebergaben/kleidung`,
      hrefLabel: 'Rückgabe',
    });
    items.push({
      key: 'r_schluessel',
      label: h.keys.length
        ? `Schlüssel zurück (offen: ${h.keys.map((k) => k.key_no).join(', ')})`
        : 'Schlüssel zurück',
      done: h.keys.length === 0,
      auto: true,
      href: `${base}/uebergaben/schluessel`,
      hrefLabel: 'Rückgabe',
    });
    if (h.devices.length)
      items.push({
        key: 'r_geraete',
        label: `Geräte zurück (offen: ${h.devices.map((d) => d.label).join(', ')})`,
        done: false,
        auto: true,
        href: `${base}/uebergaben`,
        hrefLabel: 'Rückgabe',
      });
    for (const [k, label] of MANUAL_OUT)
      items.push({ key: k, label, done: !!m.get(k)?.done_at, auto: false, info: doneInfo(k) });
  }
  for (const x of manual.filter((x) => x.key.startsWith('eigen:')))
    items.push({
      key: x.key,
      label: x.label ?? 'Eigener Punkt',
      done: !!x.done_at,
      auto: false,
      own: true,
      info: x.done_at ? doneInfo(x.key) : undefined,
    });
  return items;
}

export async function setCheck(
  sql: Sql,
  employeeId: string,
  phase: 'ein' | 'aus',
  key: string,
  done: boolean,
  actor: string,
) {
  if (!/^[a-z_]{2,40}$|^eigen:[0-9a-f-]{36}$/.test(key)) throw new BusinessError('Punkt unbekannt');
  await sql`
    insert into app.employee_checklist (employee_id, key, phase, done_at, done_by, created_by)
    values (${employeeId}, ${key}, ${phase}, ${done ? sql`now()` : null}, ${done ? actor : null}, ${actor})
    on conflict (employee_id, key) do update set done_at = excluded.done_at, done_by = excluded.done_by`;
}

export async function addOwnCheck(
  sql: Sql,
  employeeId: string,
  phase: 'ein' | 'aus',
  label: string,
  id: string,
  actor: string,
) {
  const l = label.trim();
  if (!l) throw new BusinessError('Bitte den Punkt beschreiben');
  if (l.length > 200) throw new BusinessError('Höchstens 200 Zeichen');
  await sql`
    insert into app.employee_checklist (employee_id, key, phase, label, created_by)
    values (${employeeId}, ${'eigen:' + id}, ${phase}, ${l}, ${actor}) on conflict do nothing`;
}

export async function deleteOwnCheck(sql: Sql, employeeId: string, key: string) {
  if (!key.startsWith('eigen:')) throw new BusinessError('Nur eigene Punkte lassen sich löschen');
  await sql`delete from app.employee_checklist where employee_id = ${employeeId} and key = ${key}`;
}

/** Status setzen (Protokoll). „Aktiv“ = Standard (Spalte leer). */
export async function setStage(sql: Sql, employeeId: string, stage: string, actor: string) {
  if (!(HR_STAGE_SELECTABLE as string[]).includes(stage)) throw new BusinessError('Status ungültig');
  const [old] = await sql<
    { hr_stage: string | null }[]
  >`select hr_stage from app.employees where id = ${employeeId}`;
  if (!old) throw new BusinessError('Mitarbeiter nicht gefunden');
  await sql`update app.employees set hr_stage = ${stage === 'aktiv' ? null : stage} where id = ${employeeId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'hr_stage', 'employee', ${employeeId}, ${sql.json({ alt: old.hr_stage ?? 'aktiv', neu: stage })})`;
}

/** Ist die Einstellungs-Checkliste komplett, wird „In Einstellung“/„Vertrag unterschrieben“ automatisch „Aktiv“. */
export async function autoActivate(
  sql: Sql,
  employeeId: string,
  stage: HrStage,
  items: CheckItem[],
  actor = 'automatisch',
) {
  if ((stage === 'einstellung' || stage === 'vertrag') && items.length && items.every((i) => i.done)) {
    await setStage(sql, employeeId, 'aktiv', actor);
    return true;
  }
  return false;
}
