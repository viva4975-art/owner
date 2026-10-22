/**
 * Vertragsänderung einfach (Ahmed 22.10.: „unsere Vertragsänderung ist kompliziert“): statt Word-Vorlage mit
 * neun Ankreuz-Zeilen nur die Punkte eingeben, die sich ändern. „Bisher“ kommt aus den Stammdaten, im PDF stehen
 * nur die geänderten Punkte (bisher → neu). Auf Wunsch werden Wochenstunden/Arbeitstage ab Stichtag vorgemerkt und
 * die Vergütung übernommen (ab heute sofort, in der Zukunft als Aufgabe zum Stichtag).
 */
import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { personGreeting } from '../domain/letter/greeting.js';
import { FormDoc } from '../pdf/form-doc.js';
import { recordHoursChange } from './employee-hours.js';
import { EMPLOYMENT_TYPES, type Employee, getEmployee, listWageLevels } from './employees.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';

/** Minijob-Verdienstgrenze 2026 (Mindestlohn 13,90 € × 130 ÷ 3, aufgerundet) – nur für den Hinweis. */
export const MINIJOB_LIMIT_CENTS = 60300n;

export type PayChange =
  | { model: 'tarif'; levelId: string }
  | { model: 'individuell'; wageCents: bigint }
  | { model: 'festgehalt'; salaryCents: bigint };

export interface ContractChangeInput {
  validFrom: string;
  contractDate: string | null;
  weeklyHours: number | null;
  daysPerWeek: number | null;
  pay: PayChange | null;
  siteOld: string | null;
  siteNew: string | null;
  taskOld: string | null;
  taskNew: string | null;
  other: string | null;
  signDate: string | null;
}

const num = (n: number) => String(n).replace('.', ',');
const isDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Vergütung als Text („Tariflohn 1 – 15,00 € / Std.“, „2.500,00 € / Monat“) */
export async function payText(sql: Sql, p: PayChange | null, e?: Employee): Promise<string> {
  const levels = await listWageLevels(sql, true);
  if (!p && e) {
    if (e.pay_model === 'festgehalt' && e.monthly_salary_cents)
      return `Festgehalt ${formatEuro(BigInt(e.monthly_salary_cents) as Cents)} brutto / Monat`;
    if (e.pay_model === 'individuell' && e.hourly_wage_cents)
      return `${formatEuro(BigInt(e.hourly_wage_cents) as Cents)} brutto / Std.`;
    const l = levels.find((x) => x.id === e.wage_level_id);
    if (l) return `${l.name} – ${formatEuro(BigInt(l.hourly_wage_cents) as Cents)} brutto / Std.`;
    return '–';
  }
  if (!p) return '–';
  if (p.model === 'festgehalt') return `Festgehalt ${formatEuro(p.salaryCents as Cents)} brutto / Monat`;
  if (p.model === 'individuell') return `${formatEuro(p.wageCents as Cents)} brutto / Std.`;
  const l = levels.find((x) => x.id === p.levelId);
  if (!l) throw new BusinessError('Tariflohn nicht gefunden');
  return `${l.name} – ${formatEuro(BigInt(l.hourly_wage_cents) as Cents)} brutto / Std.`;
}

/** Aktuelle Einsatzorte (laufende/künftige Einsätze) für „bisher“ */
export async function currentSites(sql: Sql, employeeId: string): Promise<string> {
  const rows = await sql<{ name: string }[]>`
    select distinct s.name from app.shift_plans p join app.sites s on s.id = p.site_id
     where p.employee_id = ${employeeId} and (p.valid_until is null or p.valid_until >= current_date)
       and s.active order by s.name`;
  return rows.map((r) => r.name).join(', ');
}

/** Stundenlohn für die Minijob-Prüfung (neu bzw. bisher) */
async function wageOf(sql: Sql, p: PayChange | null, e: Employee): Promise<bigint | null> {
  if (p?.model === 'individuell') return p.wageCents;
  if (p?.model === 'tarif') {
    const [l] = await sql<
      { c: bigint }[]
    >`select hourly_wage_cents as c from app.wage_levels where id = ${p.levelId}`;
    return l ? BigInt(l.c) : null;
  }
  if (p?.model === 'festgehalt') return null;
  const [r] = await sql<{ c: bigint | null }[]>`
    select app.effective_wage_cents(e) as c from app.employees e where e.id = ${e.id}`;
  return r?.c != null ? BigInt(r.c) : null;
}

export interface ChangeRow {
  label: string;
  old: string;
  neu: string;
}

/** Geänderte Punkte + Hinweise (Minijob-Grenze) */
export async function contractChangeRows(sql: Sql, e: Employee, i: ContractChangeInput) {
  const rows: ChangeRow[] = [];
  const hints: string[] = [];
  const oldHours = e.weekly_hours != null ? Number(e.weekly_hours) : null;
  if (i.weeklyHours != null && i.weeklyHours !== oldHours)
    rows.push({
      label: 'Wöchentliche Arbeitszeit',
      old: oldHours != null ? `${num(oldHours)} Std.` : '–',
      neu: `${num(i.weeklyHours)} Std.`,
    });
  const oldDays = Number(e.days_per_week || 5);
  if (i.daysPerWeek != null && i.daysPerWeek !== oldDays)
    rows.push({
      label: 'Arbeitstage pro Woche',
      old: `${num(oldDays)} Tage`,
      neu: `${num(i.daysPerWeek)} Tage`,
    });
  if (i.pay) {
    const o = await payText(sql, null, e);
    const n = await payText(sql, i.pay);
    if (o !== n) rows.push({ label: 'Vergütung', old: o, neu: n });
  }
  if (i.siteNew && i.siteNew !== i.siteOld)
    rows.push({ label: 'Einsatzort / Objekt', old: i.siteOld || '–', neu: i.siteNew });
  if (i.taskNew && i.taskNew !== i.taskOld)
    rows.push({ label: 'Tätigkeit', old: i.taskOld || '–', neu: i.taskNew });
  if (i.other) rows.push({ label: 'Weitere Änderung', old: '', neu: i.other });

  if (e.employment_type === 'minijob') {
    const hours = i.weeklyHours ?? oldHours;
    const wage = await wageOf(sql, i.pay, e);
    const monthly =
      i.pay?.model === 'festgehalt'
        ? i.pay.salaryCents
        : hours != null && wage != null
          ? (wage * BigInt(Math.round(hours * 433))) / 100n
          : null;
    if (monthly != null && monthly > MINIJOB_LIMIT_CENTS)
      hints.push(
        `Minijob: ca. ${formatEuro(monthly as Cents)} im Monat liegt über der Verdienstgrenze von ${formatEuro(MINIJOB_LIMIT_CENTS as Cents)} – dann ist es kein Minijob mehr (Ummeldung zur Krankenkasse, Beschäftigungsart in den Stammdaten ändern).`,
      );
  }
  return { rows, hints };
}

export async function contractChangePdf(sql: Sql, employeeId: string, i: ContractChangeInput) {
  const e = await getEmployee(sql, employeeId);
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  if (!isDate(i.validFrom)) throw new BusinessError('Bitte angeben, ab wann die Änderung gilt');
  const { rows } = await contractChangeRows(sql, e.employee, i);
  if (!rows.length)
    throw new BusinessError('Es ist nichts geändert – bitte mindestens einen neuen Wert eintragen');
  const seller = await getSeller(sql);
  const emp = e.employee;
  const priv = e.priv;
  const today = isDate(i.signDate) ? i.signDate : todayBerlin();
  const name = `${emp.first_name} ${emp.last_name}`;
  const d = await FormDoc.create({
    title: `Vertragsänderung – ${name}`,
    sideRef: `VD-VA Vertragsänderung · ${emp.personnel_no} · Stand ${formatDateDe(today)}`,
    date: today,
    author: seller.legalName,
  });
  d.title('Änderung des Arbeitsvertrags', `gültig ab ${formatDateDe(i.validFrom)}`);
  d.twoCols(
    { label: 'Arbeitgeber', lines: [seller.legalName, seller.street, `${seller.postalCode} ${seller.city}`] },
    {
      label: `Mitarbeiter/in · Personal-Nr. ${emp.personnel_no}`,
      lines: [
        name,
        ...(priv?.street ? [priv.street] : []),
        ...(priv?.postal_code || priv?.city ? [`${priv?.postal_code ?? ''} ${priv?.city ?? ''}`.trim()] : []),
      ],
    },
  );
  d.y += 4;
  d.para(
    personGreeting({ salutation: emp.salutation, first_name: emp.first_name, last_name: emp.last_name }),
    {
      size: 9.5,
    },
  );
  const since = isDate(i.contractDate) ? i.contractDate : emp.entry_date;
  d.para(
    `wir vereinbaren folgende Änderung Ihres Arbeitsvertrags vom ${formatDateDe(since)}` +
      ` (${EMPLOYMENT_TYPES[emp.employment_type]}). Die Änderung gilt ab dem ${formatDateDe(i.validFrom)}.`,
    { size: 9.5 },
  );
  d.y += 4;
  d.table(
    [
      { label: 'Was ändert sich', width: 140 },
      { label: 'Bisher', width: 170 },
      { label: 'Neu', width: 200 },
    ],
    rows.map((r) => [r.label, r.old, r.neu]),
    { size: 9.5 },
  );
  d.para(
    'Alle übrigen Regelungen des Arbeitsvertrags gelten unverändert weiter, insbesondere Kündigungsfristen und der ' +
      'Rahmentarifvertrag für die gewerblichen Beschäftigten in der Gebäudereinigung. Die Betriebszugehörigkeit läuft ' +
      'ununterbrochen weiter; eine neue Probezeit gibt es nicht.',
    { size: 9 },
  );
  d.para(
    'Diese Vereinbarung ist zugleich die schriftliche Mitteilung der geänderten Arbeitsbedingungen nach § 3 NachwG. ' +
      'Jede Seite erhält ein unterschriebenes Exemplar.',
    { size: 9 },
  );
  d.y += 6;
  d.signatures(`Arbeitgeber · ${seller.legalName}`, `Mitarbeiter/in · ${name}`, {
    leftText: `${seller.city}, den ${formatDateDe(today)}`,
  });
  const safe = name.replace(/[^\p{L}\p{N}]+/gu, '_');
  return {
    pdf: await d.save(),
    name: `Vertragsaenderung_${emp.personnel_no}_${safe}_${i.validFrom}.pdf`,
    rows,
  };
}

/**
 * Stammdaten übernehmen: Wochenstunden/Arbeitstage ab Stichtag (Verlauf), Vergütung ab heute direkt bzw. als
 * Aufgabe zum Stichtag (die Vergütung hat keinen Verlauf). Doppelt absenden legt keine zweite Aufgabe an.
 */
export async function applyContractChange(
  sql: Sql,
  employeeId: string,
  i: ContractChangeInput,
  actor: string,
): Promise<string[]> {
  const done: string[] = [];
  const e = await getEmployee(sql, employeeId);
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const emp = e.employee;
  await sql.begin(async (tx) => {
    const oldHours = emp.weekly_hours != null ? Number(emp.weekly_hours) : null;
    const hoursChanged = i.weeklyHours != null && i.weeklyHours !== oldHours;
    const daysChanged = i.daysPerWeek != null && i.daysPerWeek !== Number(emp.days_per_week || 5);
    if (hoursChanged || daysChanged) {
      await recordHoursChange(
        tx,
        employeeId,
        i.weeklyHours ?? oldHours,
        i.validFrom,
        actor,
        'Vertragsänderung',
        daysChanged ? i.daysPerWeek : null,
      );
      if (daysChanged) await tx`update app.employees set days_auto = false where id = ${employeeId}`;
      done.push(`Stunden/Arbeitstage ab ${formatDateDe(i.validFrom)} vorgemerkt`);
    }
    if (i.pay) {
      const next = {
        pay_model: i.pay.model,
        wage_level_id: i.pay.model === 'tarif' ? i.pay.levelId : null,
        hourly_wage_cents: i.pay.model === 'individuell' ? i.pay.wageCents : null,
        monthly_salary_cents: i.pay.model === 'festgehalt' ? i.pay.salaryCents : null,
      };
      if (i.validFrom <= todayBerlin()) {
        await tx`update app.employees set ${tx(next)}, version = version + 1, updated_at = now() where id = ${employeeId}`;
        done.push('Vergütung in den Stammdaten geändert');
      } else {
        const id = (() => {
          const h = createHash('md5').update(`vertragsaenderung:${employeeId}:${i.validFrom}`).digest('hex');
          return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
        })();
        await tx`
          insert into app.tasks (id, title, description, due_date, entity_type, entity_id, created_by)
          values (${id}, ${`Vergütung ändern: ${emp.first_name} ${emp.last_name}`},
                  ${`Laut Vertragsänderung ab ${formatDateDe(i.validFrom)}: ${await payText(sql, i.pay)}. Am Stichtag unter Stammdaten bearbeiten → Vergütung eintragen.`},
                  ${i.validFrom}, 'employee', ${employeeId}, ${actor})
          on conflict (id) do update set description = excluded.description`;
        done.push(`Aufgabe „Vergütung ändern“ zum ${formatDateDe(i.validFrom)} angelegt`);
      }
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'contract_change', 'employee', ${employeeId},
                     ${tx.json({ valid_from: i.validFrom, hours: i.weeklyHours, days: i.daysPerWeek, pay: i.pay?.model ?? null, applied: done } as never)})`;
  });
  return done;
}
