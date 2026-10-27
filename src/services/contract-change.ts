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

/** Inhalt der Vertragsänderung – gemeinsam für PDF und Word */
async function contractChangeContent(sql: Sql, employeeId: string, i: ContractChangeInput) {
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
  const since = isDate(i.contractDate) ? i.contractDate : emp.entry_date;
  const safe = name.replace(/[^\p{L}\p{N}]+/gu, '_');
  return {
    emp,
    seller,
    name,
    today,
    rows,
    file: `Vertragsaenderung_${emp.personnel_no}_${safe}_${i.validFrom}`,
    title: 'Änderung des Arbeitsvertrags',
    subtitle: `gültig ab ${formatDateDe(i.validFrom)}`,
    employer: [seller.legalName, seller.street, `${seller.postalCode} ${seller.city}`],
    employeeLabel: `Mitarbeiter/in · Personal-Nr. ${emp.personnel_no}`,
    employee: [
      name,
      ...(priv?.street ? [priv.street] : []),
      ...(priv?.postal_code || priv?.city ? [`${priv?.postal_code ?? ''} ${priv?.city ?? ''}`.trim()] : []),
    ],
    greeting: personGreeting({
      salutation: emp.salutation,
      first_name: emp.first_name,
      last_name: emp.last_name,
    }),
    intro:
      `wir vereinbaren folgende Änderung Ihres Arbeitsvertrags vom ${formatDateDe(since)}` +
      ` (${EMPLOYMENT_TYPES[emp.employment_type]}). Die Änderung gilt ab dem ${formatDateDe(i.validFrom)}.`,
    outro: [
      'Alle übrigen Regelungen des Arbeitsvertrags gelten unverändert weiter, insbesondere Kündigungsfristen und der ' +
        'Rahmentarifvertrag für die gewerblichen Beschäftigten in der Gebäudereinigung. Die Betriebszugehörigkeit läuft ' +
        'ununterbrochen weiter; eine neue Probezeit gibt es nicht.',
      'Diese Vereinbarung ist zugleich die schriftliche Mitteilung der geänderten Arbeitsbedingungen nach § 3 NachwG. ' +
        'Jede Seite erhält ein unterschriebenes Exemplar.',
    ],
    place: `${seller.city}, den ${formatDateDe(today)}`,
    signLeft: `Arbeitgeber · ${seller.legalName}`,
    signRight: `Mitarbeiter/in · ${name}`,
  };
}

export async function contractChangePdf(sql: Sql, employeeId: string, i: ContractChangeInput) {
  const k = await contractChangeContent(sql, employeeId, i);
  const d = await FormDoc.create({
    title: `Vertragsänderung – ${k.name}`,
    sideRef: `VD-VA Vertragsänderung · ${k.emp.personnel_no} · Stand ${formatDateDe(k.today)}`,
    date: k.today,
    author: k.seller.legalName,
  });
  d.title(k.title, k.subtitle);
  d.twoCols({ label: 'Arbeitgeber', lines: k.employer }, { label: k.employeeLabel, lines: k.employee });
  d.y += 4;
  d.para(k.greeting, { size: 9.5 });
  d.para(k.intro, { size: 9.5 });
  d.y += 4;
  d.table(
    [
      { label: 'Was ändert sich', width: 140 },
      { label: 'Bisher', width: 170 },
      { label: 'Neu', width: 200 },
    ],
    k.rows.map((r) => [r.label, r.old, r.neu]),
    { size: 9.5 },
  );
  for (const t of k.outro) d.para(t, { size: 9 });
  d.y += 6;
  d.signatures(k.signLeft, k.signRight, { leftText: k.place, mark: 'right' });
  return { pdf: await d.save(), name: `${k.file}.pdf`, rows: k.rows };
}

/** Dieselbe Vertragsänderung als Word-Datei (Ahmed 22.10.: „als Word oder als PDF“) – schlicht, zum Weiterbearbeiten. */
export async function contractChangeDocx(sql: Sql, employeeId: string, i: ContractChangeInput) {
  const k = await contractChangeContent(sql, employeeId, i);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
    `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz ?? 20}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const par = (inner: string, after = 120) =>
    `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr>${inner}</w:p>`;
  const lines = (ls: string[], o?: { b?: boolean }) =>
    ls.map((l, n) => par(run(l, n === 0 && o?.b ? { b: true } : {}), 0)).join('');
  const cell = (inner: string, w: number, fill?: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${inner || par('', 0)}</w:tc>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFB8BB"/>`;
  const tbl = (rows: string[][], widths: number[], head?: string[], raw = false) =>
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${['top', 'bottom', 'insideH'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    (head
      ? `<w:tr>${head.map((h, n) => cell(par(run(h, { b: true, sz: 16, color: '6B6266' }), 0), widths[n]!, 'F4F1F2')).join('')}</w:tr>`
      : '') +
    rows
      .map(
        (r) =>
          `<w:tr>${r.map((c, n) => cell(raw ? c : par(run(c, n === 0 ? { b: true } : {}), 0), widths[n]!)).join('')}</w:tr>`,
      )
      .join('') +
    '</w:tbl>';
  const body =
    par(run(k.title, { b: true, sz: 32 }), 40) +
    par(run(k.subtitle, { b: true, color: '7D1435' }), 240) +
    tbl(
      [
        [
          lines(['Arbeitgeber', ...k.employer], { b: true }),
          lines([k.employeeLabel, ...k.employee], { b: true }),
        ],
      ],
      [4600, 4600],
      undefined,
      true,
    ) +
    par('', 120) +
    par(run(k.greeting)) +
    par(run(k.intro), 200) +
    tbl(
      k.rows.map((r) => [r.label, r.old, r.neu]),
      [2600, 3200, 3400],
      ['Was ändert sich', 'Bisher', 'Neu'],
    ) +
    par('', 120) +
    k.outro.map((t) => par(run(t, { sz: 18 }))).join('') +
    par('', 600) +
    tbl(
      [
        [k.place, ''],
        [k.signLeft, k.signRight],
      ],
      [4600, 4600],
    ) +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const { strToU8, zipSync } = await import('fflate');
  const data = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(doc),
  });
  return { data, name: `${k.file}.docx` };
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
