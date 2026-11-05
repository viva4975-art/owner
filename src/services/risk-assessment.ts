/**
 * Gefährdungsbeurteilung je Objekt als PDF – eigenständig (Objekt → Objektordner) und als Abschnitt im Objektordner-PDF
 * (Ahmed 05.11.2026). Bausteine und Begründung siehe src/domain/safety/risk-assessment.ts.
 */
import type { Sql } from '../db/client.js';
import { addDays, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import {
  type Risk,
  type SelectedModule,
  selectModules,
  splitMeasure,
} from '../domain/safety/risk-assessment.js';
import type { FormDoc } from '../pdf/form-doc.js';
import { listSafetySheets } from './safety-sheets.js';
import { type FolderFacts, folderFacts, folderValues } from './site-folder.js';
import type { Deps } from './workflow.js';

export interface RiskFacts {
  modules: SelectedModule[];
  services: string[];
  workers: number;
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
  return { modules, services: types, workers: s?.workers ?? 0, sheets };
}

const RISK_TXT = (r: Risk, rest: Risk) => (r === rest ? r : `${r} → ${rest}`);

/** Gefährdungsbeurteilung ab der aktuellen Seite in ein FormDoc zeichnen (Objektordner oder eigenes PDF). */
export function drawRiskAssessment(d: FormDoc, f: FolderFacts, r: RiskFacts, today: string) {
  const values = folderValues(f);
  d.title('Gefährdungsbeurteilung', f.site.site_no);
  d.kvBox([
    { k: 'Objekt', v: `${f.site.name} (${f.site.site_no})`, strong: true },
    { k: 'Adresse', v: values.adresse || '–' },
    { k: 'Kunde', v: `${f.customer.name} (${f.customer.customer_no})` },
    { k: 'Eingesetzte Beschäftigte', v: r.workers ? `${r.workers} laut Einsatzplanung` : '–' },
    { k: 'Objektleitung', v: f.manager ? [f.manager.name, f.manager.phone].filter(Boolean).join(', ') : '–' },
    { k: 'Erstellt', v: `${formatDateDe(today)} · Viva-Deluxe Gebäudereinigung GmbH` },
    {
      k: 'Nächste Überprüfung',
      v: `${formatDateDe(addDays(today, 365))} oder bei Änderung von Leistung/Objekt`,
    },
  ]);
  d.para(
    `Leistungen am Objekt: ${r.services.length ? r.services.join(', ') : '– keine aktiven Leistungen –'}`,
    {
      size: 8.5,
    },
  );
  d.para(`Beurteilte Tätigkeiten: ${r.modules.map((m) => m.module.title).join(', ')}`, {
    size: 8.5,
    bold: true,
  });
  d.noteBox('So ist diese Gefährdungsbeurteilung aufgebaut', [
    'Grundlage: §§ 5, 6 Arbeitsschutzgesetz, § 6 Gefahrstoffverordnung, § 3 Betriebssicherheitsverordnung, DGUV Vorschrift 1. Je Tätigkeit sind die Gefährdungen, die Schutzmaßnahmen und das Risiko vor → nach den Maßnahmen genannt.',
    'Maßnahmen nach dem STOP-Prinzip: T = technisch, O = organisatorisch, P = persönlich (Schutzausrüstung). Die Tätigkeiten ergeben sich aus den Leistungen des Objekts.',
  ]);
  for (const { module: m, reason } of r.modules) {
    d.section(m.title);
    d.muted(`${m.activities} · Grund: ${reason}`);
    d.table(
      [
        { label: 'Gefährdung', width: 150 },
        { label: 'Schutzmaßnahmen', width: 278 },
        { label: 'Risiko', width: 70 },
      ],
      m.hazards.map((h) => [
        `${h.factor}: ${h.hazard}`,
        h.measures
          .map(splitMeasure)
          .map((x) => (x.kind ? `${x.kind}: ${x.text}` : x.text))
          .join('\n'),
        RISK_TXT(h.risk, h.rest ?? 'gering'),
      ]),
      { size: 7.8 },
    );
  }
  const psa = [...new Set(r.modules.flatMap((m) => m.module.psa))];
  if (psa.length) {
    d.section('Persönliche Schutzausrüstung');
    d.para(psa.map((p) => `• ${p}`).join('\n'), { size: 8.5 });
    d.muted(
      'Wird vom Arbeitgeber kostenlos gestellt (§ 3 Abs. 3 ArbSchG); Tragepflicht bei den genannten Tätigkeiten.',
    );
  }
  d.section('Eingesetzte Reinigungsmittel und Gefahrstoffe');
  const dos = f.defaults.dosierung ?? [];
  if (dos.length || r.sheets.length) {
    const rows = new Map<string, [string, string, string]>();
    for (const x of dos) rows.set(x.produkt.toLowerCase(), [x.produkt, x.dosierung || '–', '–']);
    for (const s of r.sheets) {
      const k = s.product.toLowerCase();
      const sdb = `vorhanden${s.issued_on ? ` (Stand ${formatDateDe(s.issued_on)})` : ''}`;
      const old = rows.get(k);
      rows.set(k, [old?.[0] ?? s.product, old?.[1] ?? '–', sdb]);
    }
    d.table(
      [
        { label: 'Produkt', width: 210 },
        { label: 'Dosierung', width: 130 },
        { label: 'Sicherheitsdatenblatt', width: 158 },
      ],
      [...rows.values()],
      { size: 8 },
    );
  } else
    d.noteBox('Noch nicht hinterlegt', [
      'Reinigungsmittel mit Dosierung und Sicherheitsdatenblätter unter Einstellungen → Objektordner-Vorlagen eintragen – sie erscheinen dann hier (Gefahrstoffverzeichnis, § 6 Abs. 12 GefStoffV).',
    ]);
  d.section('Unterweisung und arbeitsmedizinische Vorsorge');
  d.para(
    [
      '• Unterweisung vor Aufnahme der Tätigkeit und mindestens jährlich (§ 12 ArbSchG), anhand dieser Beurteilung, der Betriebsanweisungen und Aushänge im Putzraum; Nachweis mit Unterschrift (App: Unterweisungen).',
      '• Arbeitsmedizinische Vorsorge nach ArbMedVV durch den Betriebsarzt anbieten (z. B. Feuchtarbeit, Biostoffe); Impfangebote nach dessen Beurteilung.',
      '• Erste Hilfe: Ersthelfer, Verbandkasten und Notrufnummern laut Objektstammblatt; jeder Unfall ins Verbandbuch.',
    ].join('\n'),
    { size: 8.5 },
  );
  d.ensure(190); // Abschnitt mit den Eintragszeilen zusammenhalten
  d.section('Objektbesonderheiten und Wirksamkeitskontrolle');
  d.para(
    f.info.besonderheiten
      ? `Besonderheiten laut Objekt: ${f.info.besonderheiten}`
      : 'Keine Besonderheiten hinterlegt (Objekt → Übersicht → Besonderheiten).',
    { size: 8.5 },
  );
  d.para(
    'Die Objektleitung prüft bei der Begehung vor Ort, ob die Maßnahmen umgesetzt und ausreichend sind, und trägt zusätzliche Gefährdungen ein:',
    { size: 8.5 },
  );
  // Zeilen zum Eintragen bei der Begehung: Beschriftung + gezeichnete Linie (keine Unterstriche)
  const L = 48.5;
  const R = 546.5;
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
    ['durch:', 0],
  ]);
  d.ensure(26);
  d.text('☐ Maßnahmen ausreichend', L, d.y + 18, { size: 9 });
  d.text('☐ Ergänzung nötig:', L + 170, d.y + 18, { size: 9 });
  d.line(L + 170 + d.width('☐ Ergänzung nötig:', 9) + 4, R, d.y + 20);
  d.y += 26;
  fill([['Zusätzliche Gefährdungen / Maßnahmen:', 0]]);
  fill([['', 0]]);
}

/** Eigenständiges PDF der Gefährdungsbeurteilung (ohne Objektordner). */
export async function buildRiskAssessmentPdf(deps: Deps, siteId: string) {
  const { FormDoc } = await import('../pdf/form-doc.js');
  const f = await folderFacts(deps.sql, siteId);
  const r = await riskFacts(deps.sql, siteId);
  const today = todayBerlin();
  const d = await FormDoc.create({
    title: `Gefährdungsbeurteilung ${f.site.site_no} ${f.site.name}`,
    sideRef: `Gefährdungsbeurteilung ${f.site.site_no} ${f.site.name}`,
    date: today,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  drawRiskAssessment(d, f, r, today);
  return { pdf: await d.save(), name: `Gefaehrdungsbeurteilung_${f.site.site_no}_${today}.pdf` };
}
