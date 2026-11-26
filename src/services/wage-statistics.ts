import type { Sql } from '../db/client.js';
import { isManagingDirector } from '../domain/hr/employer-cost.js';
import { countryOf } from '../domain/hr/lists.js';
import { surchargeCents } from '../domain/time/surcharges.js';
import { BusinessError } from './errors.js';
import { payrollMonth, SURCHARGES } from './payroll.js';

/*
 * Verdiensterhebung (Statistisches Bundesamt, monatlich; Ahmed 09.11.): CSV zum Import in IDEV bzw. CORE.
 * Aufbau laut Beispieldateien des Amts: eine Zeile „B“ (Betrieb), je Beschäftigte/r eine Zeile „P“; bei CORE vorab
 * eine Zeile mit der Statistik-Betriebsnummer (BerichtseinheitID). Ohne Kopfzeile, Semikolon, Dezimalkomma,
 * Datumsangaben MMJJJJ, Zeichensatz ISO-8859-1/Windows-1252.
 * Stunden und Beträge kommen aus derselben Rechnung wie Stundenliste & Lohnarten („Ist, sonst Plan“); sie sind ein
 * Vorschlag und werden vor dem Export auf der Seite geprüft bzw. mit der Lohnabrechnung (Lexware) abgeglichen.
 */

/** Staatsangehörigkeitsschlüssel des Statistischen Bundesamtes (Liste „Staatsangehörigkeits- und Gebiets-
 *  schlüssel“, Stand 01.01.2011; Sudan/Südsudan nach der Teilung 2011: 277/278). Schlüssel = Staatsangehörigkeit. */
export const NATIONALITY_KEYS: Record<string, string> = {
  Deutschland: '000',
  Afghanistan: '423',
  Ägypten: '287',
  Albanien: '121',
  Algerien: '221',
  Andorra: '123',
  Angola: '223',
  'Antigua und Barbuda': '320',
  Äquatorialguinea: '274',
  Argentinien: '323',
  Armenien: '422',
  Aserbaidschan: '425',
  Äthiopien: '225',
  Australien: '523',
  Bahamas: '324',
  Bahrain: '424',
  Bangladesch: '460',
  Barbados: '322',
  Belarus: '169',
  Belgien: '124',
  Belize: '330',
  Benin: '229',
  Bhutan: '426',
  Bolivien: '326',
  'Bosnien und Herzegowina': '122',
  Botsuana: '227',
  Brasilien: '327',
  Brunei: '429',
  Bulgarien: '125',
  'Burkina Faso': '258',
  Burundi: '291',
  Chile: '332',
  China: '479',
  'Costa Rica': '334',
  'Côte d’Ivoire': '231',
  Dänemark: '126',
  Dominica: '333',
  'Dominikanische Republik': '335',
  Dschibuti: '230',
  Ecuador: '336',
  'El Salvador': '337',
  Eritrea: '224',
  Estland: '127',
  Eswatini: '281',
  Fidschi: '526',
  Finnland: '128',
  Frankreich: '129',
  Gabun: '236',
  Gambia: '237',
  Georgien: '430',
  Ghana: '238',
  Grenada: '340',
  Griechenland: '134',
  Guatemala: '345',
  Guinea: '261',
  'Guinea-Bissau': '259',
  Guyana: '328',
  Haiti: '346',
  Honduras: '347',
  Indien: '436',
  Indonesien: '437',
  Irak: '438',
  Iran: '439',
  Irland: '135',
  Island: '136',
  Israel: '441',
  Italien: '137',
  Jamaika: '355',
  Japan: '442',
  Jemen: '421',
  Jordanien: '445',
  Kambodscha: '446',
  Kamerun: '262',
  Kanada: '348',
  'Kap Verde': '242',
  Kasachstan: '444',
  Katar: '447',
  Kenia: '243',
  Kirgisistan: '450',
  Kiribati: '530',
  Kolumbien: '349',
  Komoren: '244',
  Kongo: '245',
  'Kongo, Demokratische Republik': '246',
  'Korea, Republik (Südkorea)': '467',
  'Korea, Demokratische Volksrepublik (Nordkorea)': '434',
  Kosovo: '150',
  Kroatien: '130',
  Kuba: '351',
  Kuwait: '448',
  Laos: '449',
  Lesotho: '226',
  Lettland: '139',
  Libanon: '451',
  Liberia: '247',
  Libyen: '248',
  Liechtenstein: '141',
  Litauen: '142',
  Luxemburg: '143',
  Madagaskar: '249',
  Malawi: '256',
  Malaysia: '482',
  Malediven: '454',
  Mali: '251',
  Malta: '145',
  Marokko: '252',
  Marshallinseln: '544',
  Mauretanien: '239',
  Mauritius: '253',
  Mexiko: '353',
  Mikronesien: '545',
  Moldau: '146',
  Monaco: '147',
  Mongolei: '457',
  Montenegro: '140',
  Mosambik: '254',
  Myanmar: '427',
  Namibia: '267',
  Nauru: '531',
  Nepal: '458',
  Neuseeland: '536',
  Nicaragua: '354',
  Niederlande: '148',
  Niger: '255',
  Nigeria: '232',
  Nordmazedonien: '144',
  Norwegen: '149',
  Oman: '456',
  Österreich: '151',
  Pakistan: '461',
  'Palästinensische Gebiete': '499',
  Palau: '537',
  Panama: '357',
  'Papua-Neuguinea': '538',
  Paraguay: '359',
  Peru: '361',
  Philippinen: '462',
  Polen: '152',
  Portugal: '153',
  Ruanda: '265',
  Rumänien: '154',
  Russland: '160',
  Salomonen: '524',
  Sambia: '257',
  Samoa: '543',
  'San Marino': '156',
  'São Tomé und Príncipe': '268',
  'Saudi-Arabien': '472',
  Schweden: '157',
  Schweiz: '158',
  Senegal: '269',
  Serbien: '170',
  Seychellen: '271',
  'Sierra Leone': '272',
  Simbabwe: '233',
  Singapur: '474',
  Slowakei: '155',
  Slowenien: '131',
  Somalia: '273',
  Spanien: '161',
  'Sri Lanka': '431',
  'St. Kitts und Nevis': '370',
  'St. Lucia': '366',
  'St. Vincent und die Grenadinen': '369',
  Südafrika: '263',
  Sudan: '277',
  Südsudan: '278',
  Suriname: '364',
  Syrien: '475',
  Tadschikistan: '470',
  Taiwan: '465',
  Tansania: '282',
  Thailand: '476',
  'Timor-Leste': '483',
  Togo: '283',
  Tonga: '541',
  'Trinidad und Tobago': '371',
  Tschad: '284',
  Tschechien: '164',
  Tunesien: '285',
  Türkei: '163',
  Turkmenistan: '471',
  Tuvalu: '540',
  Uganda: '286',
  Ukraine: '166',
  Ungarn: '165',
  Uruguay: '365',
  Usbekistan: '477',
  Vanuatu: '532',
  Vatikanstadt: '167',
  Venezuela: '367',
  'Vereinigte Arabische Emirate': '469',
  'Vereinigte Staaten': '368',
  'Vereinigtes Königreich': '168',
  Vietnam: '432',
  'Zentralafrikanische Republik': '289',
  Zypern: '181',
  staatenlos: '997',
  ungeklärt: '998',
};

export const TARIFF_BINDING: Record<number, string> = {
  1: 'Branchentarifvertrag',
  2: 'Firmentarifvertrag',
  3: 'Kein Tarifvertrag, Orientierung an einem Branchentarifvertrag',
  4: 'Kein Tarifvertrag, freie Verdienstvereinbarung',
};

/** DEÜV-Personengruppen, die in der App vorkommen (Vorschlag; maßgeblich ist die SV-Meldung in Lexware). */
export const DEUEV_GROUPS: Record<string, string> = {
  '101': '101 – sozialversicherungspflichtig beschäftigt',
  '106': '106 – Werkstudent/in',
  '109': '109 – geringfügig entlohnt (Minijob)',
  '110': '110 – kurzfristig beschäftigt',
  '900': '900 – sonstige Arbeitnehmer (z. B. Gesellschafter-Geschäftsführer)',
};

export interface WageStatSettings {
  report_unit_id: string | null;
  tariff_binding: number;
}

export async function getWageStatSettings(sql: Sql): Promise<WageStatSettings> {
  const [s] = await sql<
    WageStatSettings[]
  >`select report_unit_id, tariff_binding from app.wage_stat_settings`;
  return s ?? { report_unit_id: null, tariff_binding: 1 };
}

export async function saveWageStatSettings(sql: Sql, s: WageStatSettings, actor: string) {
  const id = (s.report_unit_id ?? '').replace(/\s/g, '');
  if (id && !/^[0-9A-Za-z]{1,20}$/.test(id))
    throw new BusinessError('Statistik-Betriebsnummer: nur Ziffern/Buchstaben, ohne Leerzeichen');
  if (![1, 2, 3, 4].includes(s.tariff_binding)) throw new BusinessError('Tarifbindung bitte auswählen');
  await sql`insert into app.wage_stat_settings (id, report_unit_id, tariff_binding, updated_by)
            values (true, ${id || null}, ${s.tariff_binding}, ${actor})
            on conflict (id) do update set report_unit_id = excluded.report_unit_id,
              tariff_binding = excluded.tariff_binding, updated_at = now(), updated_by = excluded.updated_by`;
}

export interface WageStatRow {
  employee_id: string;
  personnel_no: string;
  name: string;
  /** 1 männlich, 2 weiblich, 3 divers, 4 ohne Angabe */
  gender: string;
  birth: string; // MMJJJJ
  nationality: string;
  nationality_key: string;
  entry: string; // MMJJJJ
  deuev_group: string;
  activity_key: string;
  /** Berufsschlüssel nur bei 800/900 (= Tätigkeitsschlüssel) */
  hours_cents: bigint; // Stunden × 100
  overtime_hours_cents: bigint;
  gross_cents: bigint;
  other_cents: bigint;
  overtime_cents: bigint;
  surcharge_cents: bigint;
  conversion_cents: bigint;
  /** gespeicherte Schlüssel (sonst Vorschlag) */
  stored: { deuev: boolean; activity: boolean; nationality: boolean };
  warnings: string[];
}

const mmyyyy = (d: string | null) => (d ? `${d.slice(5, 7)}${d.slice(0, 4)}` : '');

/** Vorschlag Tätigkeitsschlüssel (9 Stellen): KldB 2010 (5) + Schulabschluss 9 + Ausbildung 9 (unbekannt) + keine
 *  Arbeitnehmerüberlassung 1 + Vertragsform 1 Vollzeit/2 Teilzeit unbefristet. Reinigung Helfer 54101, Aufsicht 54193. */
export function suggestActivityKey(tags: string[] | null, employmentType: string | null): string {
  const lead = (tags ?? []).some((t) => /objektleit|vorarbeit|bereichsleit/i.test(t));
  const kldb = lead ? '54193' : '54101';
  return `${kldb}991${employmentType === 'vollzeit' ? '1' : '2'}`;
}

export function suggestDeuev(tags: string[] | null, employmentType: string | null, isMd: boolean): string {
  if (isMd) return '900';
  if (employmentType === 'minijob') return '109';
  if (employmentType === 'aushilfe') return '110';
  if (employmentType === 'werkstudent') return '106';
  return '101';
}

export async function wageStatRows(sql: Sql, month: string): Promise<WageStatRow[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Monat ungültig');
  const from = `${month}-01`;
  const [co] = await sql<{ md: string | null }[]>`select managing_director as md from app.company limit 1`;
  const [mw] = await sql<
    { w: bigint | null }[]
  >`select min(hourly_wage_cents)::bigint as w from app.wage_levels where active`;
  const emps = await sql<
    {
      id: string;
      personnel_no: string;
      name: string;
      full_name: string;
      salutation: string | null;
      birth_date: string | null;
      nationality: string | null;
      entry_date: string;
      employment_type: string | null;
      weekly_hours: number | null;
      tags: string[] | null;
      deuev_group: string | null;
      activity_key: string | null;
      nationality_key: string | null;
    }[]
  >`
    select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, e.first_name || ' ' || e.last_name as full_name,
           e.salutation, p.birth_date::text, p.nationality, e.entry_date::text, e.employment_type::text,
           e.weekly_hours::float as weekly_hours, e.tags, e.deuev_group, e.activity_key, e.nationality_key
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     where e.entry_date <= (${from}::date + interval '1 month' - interval '1 day')::date
       and (e.exit_date is null or e.exit_date >= ${from}::date)
     order by e.last_name, e.first_name`;
  const pay = new Map(
    (await payrollMonth(sql, month, undefined, { fillPlan: true })).map((r) => [r.employee_id, r]),
  );
  return emps.map((e) => {
    const warnings: string[] = [];
    const r = pay.get(e.id);
    const isMd = isManagingDirector(e.tags, { name: e.full_name, managingDirector: co?.md });
    const country = countryOf(e.nationality);
    const natKey = e.nationality_key ?? (country ? NATIONALITY_KEYS[country] : undefined) ?? '';
    if (!natKey)
      warnings.push(
        e.nationality ? `Schlüssel für „${e.nationality}“ eintragen` : 'Staatsangehörigkeit fehlt',
      );
    if (!e.birth_date) warnings.push('Geburtsdatum fehlt');
    const gender =
      e.salutation === 'Herr' ? '1' : e.salutation === 'Frau' ? '2' : e.salutation === 'divers' ? '3' : '4';
    if (gender === '4') warnings.push('Anrede fehlt – Geschlecht „ohne Angabe“');
    let hours = 0n;
    let overtimeH = 0n;
    let gross = 0n;
    let overtime = 0n;
    let surcharge = 0n;
    if (!r) warnings.push('keine Lohnarten im Monat');
    else {
      const wage = r.wage_cents ?? mw?.w ?? 0n;
      if (!r.salary && r.wage_cents === null)
        warnings.push('Stundenlohn fehlt – niedrigster Tariflohn angenommen');
      const m = r.minutes;
      const paid = m.normal + m.aushilfslohn + m.urlaub + m.krank + m.feiertag_lfz;
      const over = Math.min(m.mehrarbeit ?? 0, paid);
      for (const k of SURCHARGES)
        surcharge += r.wage_cents ? r.surchargeCents[k] : surchargeCents(m[k], wage, r.bp[k]);
      if (r.salary) {
        // nicht nach Stunden bezahlt → monatliche Sollarbeitszeit (Wochenstunden × 4,33)
        hours = BigInt(Math.round((e.weekly_hours ?? 0) * 433));
        if (!e.weekly_hours) warnings.push('Wochenstunden fehlen (Sollarbeitszeit)');
        gross = r.salary.cents - r.unpaidDeductionCents + surcharge;
      } else {
        const base = (BigInt(paid) * wage * 2n + 60n) / 120n;
        hours = BigInt(Math.round(((paid - over) * 100) / 60));
        overtimeH = BigInt(Math.round((over * 100) / 60));
        overtime = (BigInt(over) * wage * 2n + 60n) / 120n + (r.wage_cents ? r.overtimeCents : 0n);
        gross = base + surcharge + (r.wage_cents ? r.overtimeCents : 0n);
      }
    }
    return {
      employee_id: e.id,
      personnel_no: e.personnel_no,
      name: e.name,
      gender,
      birth: mmyyyy(e.birth_date),
      nationality: e.nationality ?? '',
      nationality_key: natKey,
      entry: mmyyyy(e.entry_date),
      deuev_group: e.deuev_group ?? suggestDeuev(e.tags, e.employment_type, isMd),
      activity_key: e.activity_key ?? suggestActivityKey(e.tags, e.employment_type),
      hours_cents: hours,
      overtime_hours_cents: overtimeH,
      gross_cents: gross,
      other_cents: 0n,
      overtime_cents: overtime,
      surcharge_cents: surcharge,
      conversion_cents: 0n,
      stored: { deuev: !!e.deuev_group, activity: !!e.activity_key, nationality: !!e.nationality_key },
      warnings,
    };
  });
}

/** Schlüssel je Mitarbeiter dauerhaft speichern (nur geänderte/gültige Werte). */
export async function saveWageStatKeys(
  sql: Sql,
  keys: { employee_id: string; deuev_group: string; activity_key: string; nationality_key: string }[],
) {
  for (const k of keys) {
    if (!/^\d{3}$/.test(k.deuev_group))
      throw new BusinessError(`Personengruppe „${k.deuev_group}“: 3 Ziffern`);
    if (!/^\d{9}$/.test(k.activity_key))
      throw new BusinessError(`Tätigkeitsschlüssel „${k.activity_key}“: 9 Ziffern`);
    if (k.nationality_key && !/^\d{3}$/.test(k.nationality_key))
      throw new BusinessError(`Staatsangehörigkeit „${k.nationality_key}“: 3 Ziffern`);
  }
  await sql.begin(async (tx) => {
    for (const k of keys)
      await tx`update app.employees set deuev_group = ${k.deuev_group}, activity_key = ${k.activity_key},
                      nationality_key = ${k.nationality_key || null}
                where id = ${k.employee_id}`;
  });
}

const dec = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')}`;
};
const clean = (s: string) =>
  s
    .replace(/[;\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

export function wageStatCsv(
  rows: WageStatRow[],
  s: WageStatSettings & {
    format: 'idev' | 'core';
    fusion: boolean;
    konjunkturKurz: boolean;
    saisonKurz: boolean;
    streik: boolean;
    sonstige: boolean;
    remarks: string;
  },
): string {
  const lines: string[] = [];
  if (s.format === 'core') {
    if (!s.report_unit_id)
      throw new BusinessError('Für CORE fehlt die Statistik-Betriebsnummer (BerichtseinheitID)');
    lines.push(s.report_unit_id);
  }
  const b = (x: boolean) => (x ? '1' : '0');
  lines.push(
    [
      'B',
      String(s.tariff_binding),
      b(s.fusion),
      b(s.konjunkturKurz),
      b(s.saisonKurz),
      b(s.streik),
      b(s.sonstige),
      clean(s.remarks).slice(0, 250),
    ].join(';'),
  );
  for (const r of rows) {
    const other = r.deuev_group === '800' || r.deuev_group === '900';
    lines.push(
      [
        'P',
        clean(r.personnel_no).slice(0, 20),
        r.gender,
        r.birth,
        r.nationality_key,
        r.entry,
        r.deuev_group,
        other ? '' : r.activity_key,
        other ? r.activity_key : '',
        dec(r.hours_cents),
        dec(r.overtime_hours_cents),
        dec(r.gross_cents),
        dec(r.other_cents),
        dec(r.overtime_cents),
        dec(r.surcharge_cents),
        dec(r.conversion_cents),
      ].join(';'),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
