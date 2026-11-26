/**
 * Abmahnung mit vorauswählbaren Gründen (Ahmed 26.11.2026: „Felder nicht beschriftet, man weiß nicht, was man
 * reinschreiben soll – auswählen können: zu spät gekommen, alkoholisiert, macht Arbeit nicht usw.“).
 *
 * Je Vorfall: Grund aus der Liste, Datum, Objekt, bei Verspätung/zu früh gegangen Uhrzeit laut Plan und tatsächlich,
 * dazu eine Ergänzung („Was genau ist passiert?“). Der Text des Vorfalls (Sachverhalt + verletzte Pflicht) wird aus dem
 * Grund gebaut; Rüge, Aufforderung und Warnung (Kündigung im Wiederholungsfall) stehen immer drin – sonst ist es keine
 * wirksame Abmahnung. Ausgabe als PDF (Briefpapier „edel“) oder Word, optional in der Personalakte ablegen.
 */
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { personGreeting } from '../domain/letter/greeting.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';

export interface WarningReason {
  key: string;
  label: string;
  /** Uhrzeit laut Plan / tatsächlich abfragen */
  times?: { plan: string; actual: string };
  /** Ergänzung ist Pflicht (ohne konkrete Angaben wäre die Abmahnung zu ungenau) */
  detailRequired?: boolean;
  /** Was soll in die Ergänzung? (Hinweis im Formular) */
  hint: string;
  /** Sachverhalt; {datum} {objekt} {plan} {ist} werden ersetzt */
  fact: string;
  /** verletzte Pflicht */
  duty: string;
  /** Aufforderung für die Zukunft */
  future: string;
}

export const WARNING_REASONS: WarningReason[] = [
  {
    key: 'verspaetung',
    label: 'Zu spät zur Arbeit gekommen',
    times: { plan: 'Arbeitsbeginn laut Plan', actual: 'tatsächlich angefangen um' },
    hint: 'optional: z. B. „ohne vorher anzurufen“, „bereits zum dritten Mal in diesem Monat“',
    fact: 'Am {datum} haben Sie Ihre Arbeit{objekt} erst um {ist} Uhr aufgenommen, obwohl Ihr Arbeitsbeginn laut Einsatzplan {plan} Uhr war.',
    duty: 'Damit haben Sie gegen Ihre arbeitsvertragliche Pflicht verstoßen, die Arbeit pünktlich zu Beginn der vereinbarten Arbeitszeit aufzunehmen.',
    future: 'Ihre Arbeit pünktlich zu beginnen und uns eine absehbare Verspätung vorher mitzuteilen',
  },
  {
    key: 'frueh',
    label: 'Zu früh gegangen / Arbeitsplatz unerlaubt verlassen',
    times: { plan: 'Arbeitsende laut Plan', actual: 'tatsächlich gegangen um' },
    hint: 'optional: z. B. „ohne Rücksprache mit der Objektleitung“, „Arbeiten im 2. OG blieben liegen“',
    fact: 'Am {datum} haben Sie den Arbeitsplatz{objekt} bereits um {ist} Uhr verlassen, obwohl Ihre Arbeitszeit laut Einsatzplan bis {plan} Uhr ging. Eine Erlaubnis dafür lag nicht vor.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, während der vereinbarten Arbeitszeit vollständig zu arbeiten.',
    future:
      'die vereinbarte Arbeitszeit vollständig einzuhalten und den Arbeitsplatz nur mit Erlaubnis vorzeitig zu verlassen',
  },
  {
    key: 'fehlen',
    label: 'Unentschuldigt gefehlt',
    hint: 'optional: z. B. „telefonisch nicht erreichbar“, „Vertretung musste kurzfristig einspringen“',
    fact: 'Am {datum} sind Sie nicht zur Arbeit{objekt} erschienen, ohne sich abzumelden oder uns eine Arbeitsunfähigkeit oder einen anderen Grund mitzuteilen.',
    duty: 'Damit haben Sie gegen Ihre Hauptpflicht aus dem Arbeitsvertrag verstoßen, die vereinbarte Arbeitsleistung zu erbringen.',
    future:
      'zu den eingeplanten Einsätzen zu erscheinen und eine Verhinderung sofort vor Arbeitsbeginn mitzuteilen',
  },
  {
    key: 'krankmeldung',
    label: 'Krankmeldung zu spät / nicht gemeldet',
    hint: 'z. B. „Mitteilung erst am 14.11. um 11 Uhr, Einsatz begann um 6 Uhr“ oder „AU-Bescheinigung nicht vorgelegt“',
    detailRequired: true,
    fact: 'Ihre Arbeitsunfähigkeit ab dem {datum} haben Sie uns nicht unverzüglich, das heißt vor Beginn Ihres Einsatzes{objekt}, mitgeteilt.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, uns eine Arbeitsunfähigkeit und deren voraussichtliche Dauer unverzüglich mitzuteilen (§ 5 Abs. 1 Entgeltfortzahlungsgesetz).',
    future:
      'eine Arbeitsunfähigkeit sofort, spätestens vor Arbeitsbeginn, telefonisch zu melden und ab dem vierten Tag eine ärztliche Bescheinigung vorzulegen',
  },
  {
    key: 'alkohol',
    label: 'Unter Alkohol- oder Drogeneinfluss gearbeitet',
    hint: 'Pflicht: woran erkannt (z. B. Alkoholgeruch, unsicherer Gang, lallende Sprache, Flasche im Putzraum), wer es gesehen hat (Zeugen), wann',
    detailRequired: true,
    fact: 'Am {datum} sind Sie{objekt} erkennbar unter Alkohol- bzw. Rauschmitteleinfluss zur Arbeit erschienen bzw. haben in diesem Zustand gearbeitet.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, die Arbeit nüchtern und ohne Gefährdung von sich und anderen auszuführen (§ 15 Abs. 2 DGUV Vorschrift 1).',
    future: 'nicht unter Einfluss von Alkohol oder anderen Rauschmitteln zur Arbeit zu erscheinen',
  },
  {
    key: 'verweigerung',
    label: 'Arbeit nicht ausgeführt / verweigert',
    hint: 'Pflicht: welche Arbeiten (z. B. „Sanitärräume EG nicht gereinigt, obwohl von der Objektleitung angewiesen“), wer hat angewiesen',
    detailRequired: true,
    fact: 'Am {datum} haben Sie die Ihnen übertragenen Arbeiten{objekt} nicht ausgeführt.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, die Ihnen zugewiesenen Arbeiten vollständig auszuführen.',
    future: 'die Ihnen übertragenen Arbeiten vollständig auszuführen',
  },
  {
    key: 'mangelhaft',
    label: 'Reinigung mangelhaft ausgeführt',
    hint: 'Pflicht: welche Räume/Arbeiten, was war nicht in Ordnung, wer hat es festgestellt (Kunde, Objektleitung, Qualitätskontrolle)',
    detailRequired: true,
    fact: 'Am {datum} wurden die Ihnen übertragenen Reinigungsarbeiten{objekt} mangelhaft ausgeführt.',
    duty: 'Damit haben Sie Ihre Arbeitsleistung nicht in der geschuldeten Sorgfalt und Qualität erbracht.',
    future:
      'die Reinigungsarbeiten sorgfältig und vollständig nach Leistungsverzeichnis bzw. Einweisung auszuführen',
  },
  {
    key: 'zeiterfassung',
    label: 'Arbeitszeit falsch erfasst',
    hint: 'Pflicht: erfasste Zeit und tatsächliche Zeit, z. B. „gestempelt 6:00–10:00, laut Kunde/Objektleitung erst ab 7:15 vor Ort“',
    detailRequired: true,
    fact: 'Am {datum} haben Sie in der Zeiterfassung{objekt} eine Arbeitszeit angegeben, die Sie tatsächlich nicht geleistet haben.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, Ihre Arbeitszeit wahrheitsgemäß zu erfassen.',
    future: 'Ihre Arbeitszeit ausschließlich wahrheitsgemäß zu erfassen',
  },
  {
    key: 'anweisung',
    label: 'Arbeitsanweisung nicht befolgt',
    hint: 'Pflicht: welche Anweisung, von wem, wann – z. B. „Dosierung laut Aushang nicht eingehalten“',
    detailRequired: true,
    fact: 'Am {datum} haben Sie eine Arbeitsanweisung{objekt} nicht befolgt.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, die berechtigten Weisungen des Arbeitgebers zu befolgen (§ 106 Gewerbeordnung).',
    future: 'die Arbeitsanweisungen der Objektleitung und der Geschäftsleitung zu befolgen',
  },
  {
    key: 'handy',
    label: 'Private Tätigkeiten / Handy während der Arbeit',
    hint: 'Pflicht: was genau, wie lange, wer hat es gesehen – z. B. „ca. 40 Minuten am Handy im Aufenthaltsraum“',
    detailRequired: true,
    fact: 'Am {datum} haben Sie sich während der Arbeitszeit{objekt} mit privaten Dingen beschäftigt, statt zu arbeiten.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, die Arbeitszeit für die vereinbarte Arbeit zu nutzen.',
    future: 'während der Arbeitszeit keine privaten Tätigkeiten auszuführen',
  },
  {
    key: 'verhalten',
    label: 'Unangemessenes Verhalten (Kunde, Kolleg/innen)',
    hint: 'Pflicht: was wurde gesagt oder getan, gegenüber wem, wer war dabei',
    detailRequired: true,
    fact: 'Am {datum} haben Sie sich{objekt} unangemessen verhalten.',
    duty: 'Damit haben Sie gegen Ihre Pflicht zur Rücksichtnahme gegenüber Kunden, Kolleginnen und Kollegen verstoßen (§ 241 Abs. 2 BGB).',
    future: 'sich gegenüber Kunden, Kolleginnen und Kollegen respektvoll zu verhalten',
  },
  {
    key: 'sicherheit',
    label: 'Sicherheit: Schlüssel, Türen, Alarmanlage',
    hint: 'Pflicht: z. B. „Haupteingang nicht abgeschlossen“, „Alarmanlage nicht scharf geschaltet“, „Schlüssel an Dritte weitergegeben“',
    detailRequired: true,
    fact: 'Am {datum} haben Sie die Sicherheitsvorgaben{objekt} nicht eingehalten.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, die Schließ- und Sicherheitsvorgaben des Objekts einzuhalten.',
    future:
      'Schlüssel sorgfältig zu verwahren, nicht weiterzugeben und das Objekt nach Arbeitsende ordnungsgemäß zu verschließen',
  },
  {
    key: 'arbeitsschutz',
    label: 'Arbeitsschutz / Schutzausrüstung nicht beachtet',
    hint: 'Pflicht: was genau, z. B. „ohne Schutzhandschuhe mit Sanitärreiniger gearbeitet, trotz Unterweisung vom …“',
    detailRequired: true,
    fact: 'Am {datum} haben Sie die Vorgaben zum Arbeitsschutz{objekt} nicht beachtet.',
    duty: 'Damit haben Sie gegen Ihre Pflicht verstoßen, die Arbeitsschutzvorschriften und die Unterweisungen einzuhalten (§ 15 Arbeitsschutzgesetz).',
    future: 'die vorgeschriebene Schutzausrüstung zu tragen und die Unterweisungen einzuhalten',
  },
  {
    key: 'sonstiges',
    label: 'Sonstiges',
    hint: 'Pflicht: genau beschreiben, was passiert ist (wann, wo, was, wer war dabei)',
    detailRequired: true,
    fact: 'Am {datum} ist es{objekt} zu folgendem Pflichtverstoß gekommen:',
    duty: 'Damit haben Sie gegen Ihre Pflichten aus dem Arbeitsverhältnis verstoßen.',
    future: 'Ihre arbeitsvertraglichen Pflichten ordnungsgemäß zu erfüllen',
  },
];

export const WARNING_LEVELS = [
  ['normal', 'Abmahnung'],
  ['letzte', 'Letzte Abmahnung (bei erneutem Verstoß folgt die Kündigung)'],
] as const;

export interface WarningIncident {
  reason: string;
  date: string;
  /** Objekt-ID oder leer */
  siteId: string;
  plan: string;
  actual: string;
  detail: string;
}

export interface WarningInput {
  incidents: WarningIncident[];
  level: string;
  /** frühere Abmahnungen (Text) */
  previous: string;
  receipt: boolean;
  place: string;
  date: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: string) => /^\d{1,2}:\d{2}$/.test(s);
export const reasonOf = (k: string) => WARNING_REASONS.find((r) => r.key === k);

/** Objekte der Person (zugeordnet oder eingeplant), für die Auswahl im Formular */
export async function warningSites(sql: Sql, employeeId: string) {
  return sql<{ id: string; site_no: string; name: string; city: string | null }[]>`
    select s.id, s.site_no, s.name, s.city from app.sites s
     where s.id in (select site_id from app.employee_sites where employee_id = ${employeeId}
                    union select site_id from app.shift_plans where employee_id = ${employeeId})
     order by s.active desc, s.name`;
}

/** Bisher in der App erstellte Abmahnungen (aus dem Protokoll) */
export async function previousWarnings(sql: Sql, employeeId: string) {
  const rows = await sql<{ at: string; details: { date?: string; reasons?: string[]; level?: string } }[]>`
    select to_char(at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as at, details from app.audit_log
     where action = 'warning_letter' and entity = 'employee' and entity_id = ${employeeId}
       and details->>'aktion' = 'ablegen'
     order by at desc limit 20`;
  return rows.map((r) => ({
    date: r.details.date ?? r.at,
    reasons: (r.details.reasons ?? []).map((k) => reasonOf(k)?.label ?? k),
    level: r.details.level ?? 'normal',
  }));
}

async function content(sql: Sql, employeeId: string, i: WarningInput) {
  const [e] = await sql<
    {
      first_name: string;
      last_name: string;
      salutation: string | null;
      personnel_no: string;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`select e.first_name, e.last_name, e.salutation, e.personnel_no, p.street, p.postal_code, p.city
      from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const inc = i.incidents.filter((x) => x.reason);
  if (inc.length === 0) throw new BusinessError('Bitte mindestens einen Grund (Vorfall) auswählen');
  const sites = await warningSites(sql, employeeId);
  const today = todayBerlin();
  const d = formatDateDe;
  const blocks = inc.map((x, n) => {
    const r = reasonOf(x.reason);
    const no = n + 1;
    if (!r) throw new BusinessError(`Vorfall ${no}: unbekannter Grund`);
    if (!isDate(x.date)) throw new BusinessError(`Vorfall ${no} (${r.label}): Bitte das Datum angeben`);
    if (x.date > today) throw new BusinessError(`Vorfall ${no} (${r.label}): Das Datum liegt in der Zukunft`);
    if (r.times && (!isTime(x.plan) || !isTime(x.actual)))
      throw new BusinessError(
        `Vorfall ${no} (${r.label}): Bitte „${r.times.plan}“ und „${r.times.actual}“ angeben`,
      );
    const detail = x.detail.trim();
    if (r.detailRequired && detail.length < 10)
      throw new BusinessError(
        `Vorfall ${no} (${r.label}): Bitte genau beschreiben, was passiert ist – ohne konkrete Angaben ist die Abmahnung unwirksam`,
      );
    const site = sites.find((s) => s.id === x.siteId);
    const text =
      r.fact
        .replace('{datum}', d(x.date))
        .replace('{objekt}', site ? ` im Objekt ${site.name} (${site.site_no})` : '')
        .replace('{plan}', x.plan)
        .replace('{ist}', x.actual) + (detail ? ` ${detail.replace(/\s*\n\s*/g, ' ')}` : '');
    return {
      head: `${no}. ${r.label} – ${d(x.date)}`,
      text: [text, r.duty],
      future: r.future,
      key: r.key,
    };
  });
  const seller = await getSeller(sql);
  const last = i.level === 'letzte';
  const futures = [...new Set(blocks.map((b) => b.future))];
  const many = blocks.length > 1;
  const intro = many
    ? 'wegen der nachfolgend beschriebenen Pflichtverletzungen mahnen wir Sie hiermit ab:'
    : 'wegen der nachfolgend beschriebenen Pflichtverletzung mahnen wir Sie hiermit ab:';
  const rebuke =
    `Wir weisen Sie ausdrücklich darauf hin, dass wir dieses Verhalten nicht hinnehmen. Wir fordern Sie auf, künftig ` +
    (futures.length === 1
      ? `${futures[0]}.`
      : `${futures.slice(0, -1).join(', ')} sowie ${futures[futures.length - 1]}.`);
  const warn = last
    ? 'Dies ist die letzte Abmahnung. Sollten Sie erneut gegen Ihre arbeitsvertraglichen Pflichten verstoßen, werden wir das Arbeitsverhältnis kündigen.'
    : 'Sollten Sie erneut gegen Ihre arbeitsvertraglichen Pflichten verstoßen, müssen Sie mit weiteren arbeitsrechtlichen Konsequenzen bis hin zur Kündigung des Arbeitsverhältnisses rechnen.';
  const prev = i.previous.trim()
    ? `Wir weisen außerdem auf ${/^(die|unsere|meine)\b/i.test(i.previous.trim()) ? '' : 'die '}${i.previous.trim().replace(/\.$/, '')} hin.`
    : '';
  const tail = [
    'Eine Ausfertigung dieser Abmahnung wird zu Ihrer Personalakte genommen. Sie haben das Recht, eine schriftliche ' +
      'Gegendarstellung abzugeben; diese wird ebenfalls zur Personalakte genommen.',
  ];
  const date = isDate(i.date) ? i.date : today;
  const name = `${e.first_name} ${e.last_name}`;
  const addr = [
    `${e.salutation === 'Frau' ? 'Frau' : e.salutation === 'Herr' ? 'Herrn' : ''} ${name}`.trim(),
    e.street ?? '',
    [e.postal_code, e.city].filter(Boolean).join(' '),
  ].filter(Boolean);
  return {
    seller,
    title: last ? 'Letzte Abmahnung' : 'Abmahnung',
    addr,
    greeting: personGreeting(e),
    intro,
    blocks,
    rebuke,
    warn,
    prev,
    tail,
    receipt: i.receipt,
    place: `${i.place.trim() || seller.city}, den ${d(date)}`,
    date,
    personnelNo: e.personnel_no,
    name,
    file: `Abmahnung_${e.personnel_no}_${name.replace(/[^\p{L}\p{N}]+/gu, '_')}_${date}`,
    reasons: blocks.map((b) => b.key),
  };
}

export async function warningLetterInfo(sql: Sql, employeeId: string, i: WarningInput) {
  const k = await content(sql, employeeId, i);
  return {
    file: k.file,
    reasons: k.reasons,
    date: k.date,
    level: i.level === 'letzte' ? 'letzte' : 'normal',
  };
}

export async function warningLetterPdf(sql: Sql, employeeId: string, i: WarningInput) {
  const k = await content(sql, employeeId, i);
  const doc = await FormDoc.create({
    title: `${k.title} – ${k.name}`,
    sideRef: `VD-ABM ${k.title} · ${k.personnelNo} · ${formatDateDe(k.date)}`,
    date: k.date,
    author: k.seller.legalName,
  });
  doc.title(k.title.toUpperCase(), `Personal-Nr. ${k.personnelNo}`);
  doc.placeDate(k.place);
  for (const l of k.addr) doc.para(l, { size: 10 });
  doc.y += 8;
  doc.para(k.greeting, { size: 10.5 });
  doc.para(k.intro, { size: 10.5 });
  doc.y += 2;
  for (const b of k.blocks) {
    doc.para(b.head, { size: 10.5, bold: true });
    for (const t of b.text) doc.para(t, { size: 10.5, indent: 12 });
    doc.y += 2;
  }
  doc.para(k.rebuke, { size: 10.5 });
  if (k.prev) doc.para(k.prev, { size: 10.5 });
  doc.para(k.warn, { size: 10.5, bold: true });
  for (const t of k.tail) doc.para(t, { size: 10.5 });
  doc.y += 4;
  doc.para('Mit freundlichen Grüßen', { size: 10.5 });
  doc.signatures('Stempel und Unterschrift Arbeitgeber', '');
  if (k.receipt) {
    doc.y += 10;
    doc.ensure(150);
    doc.section('Empfangsbestätigung');
    doc.para(
      `Ich habe die ${k.title} vom ${formatDateDe(k.date)} erhalten. Mit meiner Unterschrift bestätige ich nur den ` +
        'Erhalt, nicht die Richtigkeit des Inhalts.',
      { size: 10 },
    );
    doc.signatures('Ort, Datum', `Unterschrift ${k.name}`, { mark: 'right' });
  }
  return { pdf: await doc.save(), name: `${k.file}.pdf` };
}

export async function warningLetterDocx(sql: Sql, employeeId: string, i: WarningInput) {
  const k = await content(sql, employeeId, i);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
    `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz ?? 21}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const par = (inner: string, after = 160, ind = 0) =>
    `<w:p><w:pPr><w:spacing w:after="${after}"/>${ind ? `<w:ind w:left="${ind}"/>` : ''}</w:pPr>${inner}</w:p>`;
  const body =
    par(run(k.title.toUpperCase(), { b: true, sz: 32 }), 40) +
    par(run(`Personal-Nr. ${k.personnelNo} · ${k.seller.legalName}`, { b: true, color: '7D1435' }), 120) +
    `<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="200"/></w:pPr>${run(k.place)}</w:p>` +
    k.addr.map((l, n) => par(run(l), n === k.addr.length - 1 ? 320 : 0)).join('') +
    par(run(k.greeting)) +
    par(run(k.intro)) +
    k.blocks
      .map((b) => par(run(b.head, { b: true }), 60) + b.text.map((t) => par(run(t), 100, 240)).join(''))
      .join('') +
    par(run(k.rebuke)) +
    (k.prev ? par(run(k.prev)) : '') +
    par(run(k.warn, { b: true })) +
    k.tail.map((t) => par(run(t))).join('') +
    par(run('Mit freundlichen Grüßen'), 360) +
    par('', 700) +
    par(run('_______________________________________'), 0) +
    par(run('Stempel und Unterschrift Arbeitgeber', { sz: 16, color: '6B6266' }), 360) +
    (k.receipt
      ? par(run('Empfangsbestätigung', { b: true, color: '7D1435' }), 80) +
        par(
          run(
            `Ich habe die ${k.title} vom ${formatDateDe(k.date)} erhalten. Mit meiner Unterschrift bestätige ich nur den Erhalt, nicht die Richtigkeit des Inhalts.`,
          ),
          600,
        ) +
        par(run('_______________________          _______________________________________'), 0) +
        par(
          run(`Ort, Datum                                         Unterschrift ${k.name}`, {
            sz: 16,
            color: '6B6266',
          }),
          0,
        )
      : '') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const { strToU8, zipSync } = await import('fflate');
  const data = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(xml),
  });
  return { data, name: `${k.file}.docx` };
}
