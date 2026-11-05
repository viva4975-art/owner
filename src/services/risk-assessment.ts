/**
 * Gefährdungsbeurteilung je Objekt als PDF – eigenständig (Objekt → Objektordner) und als Abschnitt im Objektordner-PDF
 * (Ahmed 05.11.2026). Bausteine und Begründung siehe src/domain/safety/risk-assessment.ts.
 */
import type { Sql } from '../db/client.js';
import { addDays, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import {
  MATERNITY,
  type Risk,
  type SelectedModule,
  selectModules,
  splitMeasure,
} from '../domain/safety/risk-assessment.js';
import { FORM_X, type FormDoc } from '../pdf/form-doc.js';
import { listSafetySheets } from './safety-sheets.js';
import { type FolderFacts, folderFacts, folderValues } from './site-folder.js';
import type { Deps } from './workflow.js';

export interface RiskFacts {
  modules: SelectedModule[];
  services: string[];
  workers: number;
  /** Einsatzzeiten laut Einsatzplanung (z. B. „17:00–21:30“) */
  times: string[];
  sheets: { product: string; manufacturer: string | null; issued_on: string | null }[];
}

export async function riskFacts(sql: Sql, siteId: string): Promise<RiskFacts> {
  const svc = await sql<{ type: string | null; title: string }[]>`
    select t.name as type, ss.description as title from app.site_services ss
      left join app.service_types t on t.id = ss.service_type_id
     where ss.site_id = ${siteId} and ss.active and (ss.valid_to is null or ss.valid_to >= current_date)`;
  const rooms = await sql<{ name: string }[]>`
    select distinct rt.name from app.rooms r join app.room_types rt on rt.id = r.room_type_id
     where r.site_id = ${siteId} and r.active`;
  const [s] = await sql<
    { name: string; school: boolean; garage: boolean; off_hours: boolean; workers: number }[]
  >`
    select s.name, coalesce(s.school_closure, false) as school,
           exists (select 1 from app.tg_objects g where g.site_id = s.id) as garage,
           exists (select 1 from app.shift_plans p where p.site_id = s.id
                    and (p.valid_until is null or p.valid_until >= current_date)
                    and (p.start_time < '07:00' or p.end_time > '18:00' or p.start_time >= '18:00')) as off_hours,
           (select count(distinct employee_id)::int from app.shift_plans p where p.site_id = s.id
               and p.employee_id is not null and (p.valid_until is null or p.valid_until >= current_date)) as workers
      from app.sites s where s.id = ${siteId}`;
  const times = (
    await sql<{ t: string }[]>`
      select distinct to_char(p.start_time, 'HH24:MI') || '–' || to_char(p.end_time, 'HH24:MI') as t
        from app.shift_plans p
       where p.site_id = ${siteId} and (p.valid_until is null or p.valid_until >= current_date)
       order by 1 limit 6`
  ).map((x) => x.t);
  const names = [...new Set(svc.flatMap((r) => [r.type ?? '', r.title]).filter(Boolean))];
  const types = [...new Set(svc.map((r) => r.type ?? r.title).filter(Boolean))];
  const modules = selectModules({
    services: names,
    roomTypes: rooms.map((r) => r.name),
    siteName: s?.name ?? '',
    school: !!s?.school,
    garage: !!s?.garage,
    offHours: !!s?.off_hours,
  });
  const sheets = (await listSafetySheets(sql)).map((x) => ({
    product: x.product,
    manufacturer: x.manufacturer,
    issued_on: x.issued_on,
  }));
  return { modules, services: types, workers: s?.workers ?? 0, times, sheets };
}

const RISK_TXT: Record<Risk, string> = { hoch: 'hoch', mittel: 'mittel', gering: 'gering' };
const MAT: Record<'ok' | 'limited' | 'no', string> = {
  ok: 'ohne Einschränkung',
  limited: 'nur mit Umgestaltung',
  no: 'unzulässig',
};

/**
 * Gefährdungsbeurteilung ab der aktuellen Seite in ein FormDoc zeichnen (Objektordner oder eigenes PDF).
 * Querformat (Ahmed 05.11.2026), Aufbau nach den 7 Schritten der DGUV/GDA: Geltungsbereich → Vorgehen und Maßstab →
 * Gefährdungen und Maßnahmen → Gefahrstoffe → PSA → besondere Personengruppen (§ 10 MuSchG) → Organisation →
 * Objektbesonderheiten → Wirksamkeitskontrolle und Fortschreibung (§ 6 ArbSchG).
 */
export function drawRiskAssessment(d: FormDoc, f: FolderFacts, r: RiskFacts, today: string) {
  const values = folderValues(f);
  const L = FORM_X.L;
  const R = d.R;
  const width = R - L;
  const bullets = (lines: string[], size = 8.3) => d.para(lines.map((l) => `• ${l}`).join('\n'), { size });
  let sec = 0;
  const section = (t: string) => {
    d.ensure(110); // Abschnittsüberschrift nie allein am Seitenende
    d.section(`${++sec}  ${t}`);
  };

  d.title('Gefährdungsbeurteilung nach §§ 5, 6 ArbSchG', f.site.site_no);

  section('Geltungsbereich');
  d.infoGrid(
    [
      ['Objekt', `${f.site.name} (${f.site.site_no})`],
      ['Adresse', values.adresse || '–'],
      ['Auftraggeber (Kunde)', `${f.customer.name} (${f.customer.customer_no})`],
      [
        'Ansprechpartner Kunde',
        [values.ansprechpartner, values['ansprechpartner|tel']].filter(Boolean).join(', ') || '–',
      ],
      ['Arbeitgeber', 'Viva-Deluxe Gebäudereinigung GmbH'],
      ['Objektleitung', f.manager ? [f.manager.name, f.manager.phone].filter(Boolean).join(', ') : '–'],
      ['Beschäftigte am Objekt', r.workers ? `${r.workers} laut Einsatzplanung` : '–'],
      ['Arbeitszeiten', r.times.length ? r.times.join(', ') : '–'],
      ['Erstellt am', formatDateDe(today)],
      ['Nächste Überprüfung', `spätestens ${formatDateDe(addDays(today, 365))}`],
      ['Beurteilte Tätigkeiten', String(r.modules.length)],
      ['Grundlage', 'ArbSchG · GefStoffV · BetrSichV · MuSchG'],
    ],
    3,
  );
  d.para(
    `Leistungen am Objekt: ${r.services.length ? r.services.join(', ') : '– keine aktiven Leistungen –'}`,
    {
      size: 8.3,
    },
  );
  d.para(
    `Beurteilte Tätigkeiten: ${r.modules.map((m, i) => `${sec + 2}.${i + 1} ${m.module.title}`).join(' · ')}`,
    { size: 8.3, bold: true },
  );

  section('Vorgehen und Bewertungsmaßstab');
  d.para(
    'Die Tätigkeiten ergeben sich aus den Leistungen des Objekts, dem Raumbuch und den Einsatzzeiten. Je Tätigkeit werden die Gefährdungen ermittelt und beurteilt, Schutzmaßnahmen nach der Rangfolge des § 4 ArbSchG festgelegt (STOP: Substitution, technisch, organisatorisch, persönlich) und das verbleibende Risiko bewertet. Die Objektleitung prüft bei der Begehung, ob die Maßnahmen umgesetzt und wirksam sind (Spalte „Wirksam“, Abschnitt 9).',
    { size: 8.3 },
  );
  d.table(
    [
      { label: 'Risiko', width: 90 },
      { label: 'Bedeutung', width: 330 },
      { label: 'Handlungsbedarf', width: width - 420 },
    ],
    [
      [
        'hoch',
        'Schaden wahrscheinlich oder schwer (z. B. Absturz, Verätzung, Infektion)',
        'Tätigkeit erst nach Maßnahmen beginnen',
      ],
      [
        'mittel',
        'Schaden möglich, meist leichte bis mittlere Verletzung oder Erkrankung',
        'Maßnahmen kurzfristig umsetzen und unterweisen',
      ],
      [
        'gering',
        'Schaden unwahrscheinlich bzw. nur geringfügig',
        'keine weiteren Maßnahmen, Wirksamkeit beobachten',
      ],
    ],
    { size: 7.8 },
  );

  d.ensure(170); // Überschrift nicht allein am Seitenende
  section('Gefährdungen und Schutzmaßnahmen je Tätigkeit');
  d.muted(
    'Maßnahmen: T = technisch · O = organisatorisch · P = persönlich (Schutzausrüstung). Spalte „Wirksam“ füllt die Objektleitung bei der Begehung aus.',
  );
  const fixed = 30 + 95 + 165 + 62 + 62 + 64;
  const cols = [
    { label: 'Nr.', width: 30 },
    { label: 'Faktor', width: 95 },
    { label: 'Gefährdung', width: 165 },
    { label: 'Risiko vor', width: 62 },
    { label: 'Schutzmaßnahmen (T · O · P)', width: width - fixed },
    { label: 'Risiko nach', width: 62 },
    { label: 'Wirksam', width: 64 },
  ];
  const mod = sec;
  r.modules.forEach(({ module: m, reason }, i) => {
    d.ensure(90);
    d.heading(`${mod}.${i + 1}  ${m.title}`, 10);
    d.y += 14;
    d.muted(`Tätigkeiten: ${m.activities} · ausgewählt wegen: ${reason}`);
    d.table(
      cols,
      m.hazards.map((h, j) => [
        `${mod}.${i + 1}.${j + 1}`,
        h.factor,
        h.hazard,
        RISK_TXT[h.risk],
        h.measures
          .map(splitMeasure)
          .map((x) => (x.kind ? `${x.kind}  ${x.text}` : x.text))
          .join('\n'),
        RISK_TXT[h.rest ?? 'gering'],
        '☐ ja  ☐ nein',
      ]),
      { size: 7.6 },
    );
  });

  section('Gefahrstoffe (Gefahrstoffverzeichnis, § 6 Abs. 12 GefStoffV)');
  const dos = f.defaults.dosierung ?? [];
  if (dos.length || r.sheets.length) {
    const rows = new Map<string, [string, string, string, string]>();
    for (const x of dos) rows.set(x.produkt.toLowerCase(), [x.produkt, '–', x.dosierung || '–', 'fehlt']);
    for (const s of r.sheets) {
      const k = s.product.toLowerCase();
      const sdb = `vorhanden${s.issued_on ? ` (Stand ${formatDateDe(s.issued_on)})` : ''}`;
      const old = rows.get(k);
      rows.set(k, [old?.[0] ?? s.product, s.manufacturer || '–', old?.[2] ?? '–', sdb]);
    }
    d.table(
      [
        { label: 'Produkt', width: 240 },
        { label: 'Hersteller', width: 160 },
        { label: 'Dosierung', width: 150 },
        { label: 'Sicherheitsdatenblatt', width: width - 550 },
      ],
      [...rows.values()],
      { size: 8 },
    );
    d.muted(
      'Betriebsanweisungen (§ 14 GefStoffV) und Sicherheitsdatenblätter liegen im Objektordner bzw. Putzraum aus. Ersatzprüfung: weniger gefährliche Produkte bevorzugen (§ 7 Abs. 3 GefStoffV).',
    );
  } else
    d.noteBox('Noch nicht hinterlegt', [
      'Reinigungsmittel mit Dosierung und Sicherheitsdatenblätter unter Einstellungen → Objektordner-Vorlagen eintragen – sie erscheinen dann hier als Gefahrstoffverzeichnis (§ 6 Abs. 12 GefStoffV).',
    ]);

  const psa = new Map<string, string[]>();
  r.modules.forEach(({ module: m }) => {
    for (const p of m.psa) psa.set(p, [...(psa.get(p) ?? []), m.title]);
  });
  section('Persönliche Schutzausrüstung');
  if (psa.size)
    d.table(
      [
        { label: 'Schutzausrüstung', width: 300 },
        { label: 'erforderlich bei', width: width - 300 },
      ],
      [...psa].map(([p, ms]) => [p, ms.join(', ')]),
      { size: 8 },
    );
  d.muted(
    'Wird vom Arbeitgeber kostenlos gestellt (§ 3 Abs. 3 ArbSchG); Tragepflicht bei den genannten Tätigkeiten.',
  );

  section('Besondere Personengruppen');
  d.para(
    'Mutterschutz (§ 10 MuSchG): Für jede Tätigkeit ist vorab beurteilt, ob Schwangere oder Stillende sie ausüben dürfen. Teilt eine Beschäftigte die Schwangerschaft mit, werden die Schutzmaßnahmen sofort umgesetzt, ein Gespräch angeboten (§ 10 Abs. 2) und die Aufsichtsbehörde benachrichtigt (§ 27 MuSchG).',
    { size: 8.3 },
  );
  d.table(
    [
      { label: 'Tätigkeit', width: 230 },
      { label: 'Schwangere / Stillende', width: 120 },
      { label: 'Erforderliche Schutzmaßnahme', width: width - 350 },
    ],
    r.modules.map(({ module: m }) => {
      const x = MATERNITY[m.key];
      return [m.title, x ? MAT[x.verdict] : 'Einzelfall prüfen', x?.text ?? 'mit dem Betriebsarzt abstimmen'];
    }),
    { size: 7.8 },
  );
  bullets([
    'Jugendliche unter 18 Jahren: nur nach eigener Beurteilung vor Beschäftigungsbeginn (§ 28a JArbSchG); keine Gefahrstoffe, Absturzgefahr oder Akkordarbeit (§§ 22, 23 JArbSchG).',
    'Beschäftigte mit Behinderung oder gesundheitlichen Einschränkungen: Tätigkeit im Einzelfall mit dem Betriebsarzt abstimmen.',
  ]);

  section('Organisation, Unterweisung und Erste Hilfe');
  bullets([
    `Zusammenarbeit mit dem Auftraggeber (§ 8 ArbSchG): Gefährdungen aus dem Objekt (Baustellen, Technikräume, Nutzerbetrieb) und Notfallregeln des Hauses mit ${values.ansprechpartner || 'dem Ansprechpartner des Kunden'} abstimmen; Änderungen meldet die Objektleitung.`,
    'Unterweisung vor Aufnahme der Tätigkeit und mindestens jährlich (§ 12 ArbSchG, § 14 GefStoffV) anhand dieser Beurteilung, der Betriebsanweisungen und Aushänge; Nachweis mit Unterschrift (App: Unterweisungen).',
    'Arbeitsmittel: Leitern, Tritte, Maschinen und Elektrogeräte vor Gebrauch sichtprüfen, wiederkehrend prüfen lassen (§§ 3, 14 BetrSichV, DGUV Vorschrift 3); Defekte sofort melden.',
    'Arbeitsmedizinische Vorsorge nach ArbMedVV durch den Betriebsarzt anbieten (z. B. Feuchtarbeit, Biostoffe); Impfangebote nach dessen Beurteilung.',
    'Erste Hilfe (DGUV Vorschrift 1 §§ 24–26): Ersthelfer, Verbandkasten und Notrufnummern laut Objektstammblatt; jede Erste-Hilfe-Leistung ins Verbandbuch.',
  ]);

  section('Objektbesonderheiten');
  d.para(
    f.info.besonderheiten
      ? f.info.besonderheiten
      : 'Keine Besonderheiten hinterlegt (Objekt → Übersicht → Besonderheiten). Zusätzliche Gefährdungen vor Ort bei der Begehung unten eintragen.',
    { size: 8.3 },
  );

  d.ensure(170); // Abschnitt mit den Eintragszeilen zusammenhalten
  section('Wirksamkeitskontrolle und Fortschreibung');
  bullets([
    'Überprüfung bei jeder Begehung, spätestens jährlich, und sofort bei neuer Leistung oder Tätigkeit, neuen Reinigungsmitteln oder Geräten, nach Unfällen bzw. Beinaheunfällen und bei Hinweisen der Beschäftigten.',
    'Die Beurteilung wird aus den aktuellen Daten der App erzeugt; diese Fassung gilt mit dem Erstellungsdatum oben (Dokumentation § 6 ArbSchG).',
  ]);
  // Zeilen zum Eintragen bei der Begehung: Beschriftung + gezeichnete Linie (keine Unterstriche)
  const fill = (parts: [string, number][]) => {
    d.ensure(26);
    const y = d.y + 18;
    let x = L;
    for (const [label, w] of parts) {
      if (label) d.text(label, x, y, { size: 9 });
      const lx = x + (label ? d.width(label, 9) + 4 : 0);
      const end = w ? Math.min(R, lx + w) : R;
      d.line(lx, end, y + 2);
      x = end + 14;
    }
    d.y += 26;
  };
  fill([
    ['Begehung am:', 120],
    ['durch:', 260],
    ['nächste Überprüfung:', 0],
  ]);
  d.ensure(26);
  d.text('☐ Maßnahmen umgesetzt und wirksam', L, d.y + 18, { size: 9 });
  d.text('☐ Ergänzung nötig:', L + 230, d.y + 18, { size: 9 });
  d.line(L + 230 + d.width('☐ Ergänzung nötig:', 9) + 4, R, d.y + 20);
  d.y += 26;
  fill([['Zusätzliche Gefährdungen / Maßnahmen / verantwortlich / bis:', 0]]);
  fill([['', 0]]);
}

/** Eigenständiges PDF der Gefährdungsbeurteilung (ohne Objektordner). */
export async function buildRiskAssessmentPdf(deps: Deps, siteId: string) {
  const { FormDoc } = await import('../pdf/form-doc.js');
  const f = await folderFacts(deps.sql, siteId);
  const r = await riskFacts(deps.sql, siteId);
  const today = todayBerlin();
  const d = await FormDoc.create({
    landscape: true,
    title: `Gefährdungsbeurteilung ${f.site.site_no} ${f.site.name}`,
    sideRef: `Gefährdungsbeurteilung ${f.site.site_no} ${f.site.name}`,
    date: today,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  drawRiskAssessment(d, f, r, today);
  return { pdf: await d.save(), name: `Gefaehrdungsbeurteilung_${f.site.site_no}_${today}.pdf` };
}
