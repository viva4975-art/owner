/**
 * Vorlagen für Nachunternehmer automatisch ausfüllen (Ahmed 19.10., wie die alte App, verbessert): Rahmenvertrag,
 * Selbstauskunft (angekreuzt oder leer), Mindestlohnerklärung, Tariftreue-Erklärung, Bewertungsbogen und
 * Personaleinsatzliste (Excel). Firmen- und NU-Daten kommen aus den Stammdaten; auf Wunsch wird das PDF in den
 * Dokumenten des Nachunternehmers abgelegt (Kategorie „Verträge“, write-once, feste ID je Tag und Vorlage).
 */
import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { writeXlsx } from '../domain/sheet/xlsx-write.js';
import {
  BEWERTUNG,
  type DocBlock,
  fillAg,
  MINDESTLOHN,
  RAHMENVERTRAG,
  SELBSTAUSKUNFT,
  SELBSTAUSKUNFT_DOCS,
  SELBSTAUSKUNFT_END,
} from '../domain/subcontract/nu-docs.js';
import { FORM_COLORS, FORM_X, FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { getSupplier } from './inventory.js';
import { getSeller } from './masterdata.js';
import { LEGAL_FORMS } from './subcontractors.js';
import { storeFile, type UploadConfig } from './uploads.js';

export const NU_DOCS = {
  rahmenvertrag: {
    label: 'Rahmenvertrag',
    ref: 'VD-NU-01 Rahmenvertrag',
    file: 'Rahmenvertrag',
    nachweis: 'vertrag',
  },
  selbstauskunft: {
    label: 'Selbstauskunft & Compliance-Erklärung',
    ref: 'VD-NU-03 Selbstauskunft',
    file: 'Selbstauskunft',
    nachweis: 'selbstauskunft',
  },
  mindestlohn: {
    label: 'Mindestlohnerklärung',
    ref: 'VD-NU-04 Mindestlohnerklärung',
    file: 'Mindestlohnerklaerung',
    nachweis: 'milog',
  },
  tarif: { label: 'Tariftreue-Erklärung', ref: 'VD-NU-05 Tariftreue', file: 'Tariftreue', nachweis: 'tarif' },
  bewertung: {
    label: 'Bewertungsbogen (ISO 9001)',
    ref: 'VD-NU-06 Bewertungsbogen',
    file: 'Bewertungsbogen',
    nachweis: null,
  },
} as const;
export type NuDocKind = keyof typeof NU_DOCS;
export const isNuDoc = (k: string): k is NuDocKind => k in NU_DOCS;

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

async function context(sql: Sql, supplierId: string) {
  const s = await getSupplier(sql, supplierId);
  if (!s) throw new BusinessError('Nachunternehmer nicht gefunden');
  const seller = await getSeller(sql);
  const [contact] = await sql<
    { name: string; phone: string | null; email: string | null; role: string | null }[]
  >`
    select name, coalesce(phone, mobile) as phone, email, role from app.supplier_contacts
     where supplier_id = ${supplierId} order by is_primary desc, name limit 1`;
  const sellerAddr = `${seller.street}, ${seller.postalCode} ${seller.city}`;
  return {
    s,
    seller,
    sellerAddr,
    contact: contact?.name ?? s.contact_name ?? '',
    phone: contact?.phone ?? s.phone ?? '',
    email: contact?.email ?? s.email ?? '',
    vars: { ag: seller.legalName },
  };
}

type Ctx = Awaited<ReturnType<typeof context>>;

function header(d: FormDoc, title: string, sub: string) {
  d.y += 4;
  d.title(title);
  d.muted(sub);
  d.y += 2;
}

function blocks(d: FormDoc, list: DocBlock[], vars: Record<string, string>) {
  for (const b of list) {
    if ('h' in b) {
      d.y += 4;
      d.ensure(44);
      d.heading(b.t ? `${b.h}   ${b.t}` : b.h, 10);
    } else if ('p' in b) d.para(fillAg(b.p, vars), { bold: !!b.bold, size: 8.8 });
    else if ('list' in b)
      b.list.forEach((t, i) => {
        d.ensure(14);
        d.text(b.num ? `${i + 1}.` : '–', FORM_X.L + 2, d.y + 8.8, { size: 8.8 });
        d.para(fillAg(t, vars), { indent: 16, size: 8.8 });
      });
    else
      d.table(
        [
          { label: 'Fall', width: 360 },
          { label: 'Betrag', width: 135, align: 'right' },
        ],
        b.table,
      );
  }
}

/** Kästchen mit Text; `checked` = vom Büro vorab angekreuzt */
function check(d: FormDoc, t: string, checked: boolean) {
  const lines = d.wrap(t, FORM_X.R - FORM_X.L - 20, 8.8);
  d.ensure(lines.length * 12.4 + 4);
  d.rect(FORM_X.L + 2, d.y + 1.5, 9, 9, FORM_COLORS.BOX, FORM_COLORS.MUT);
  if (checked) d.text('✓', FORM_X.L + 3.4, d.y + 9.6, { size: 9, bold: true, color: FORM_COLORS.BORDEAUX });
  lines.forEach((l, i) => d.text(l, FORM_X.L + 20, d.y + 9 + i * 12.4, { size: 8.8 }));
  d.y += lines.length * 12.4 + 5;
}

/** Feld mit Beschriftung links und (vorbelegtem) Wert auf einer Linie */
function field(d: FormDoc, label: string, value: string) {
  d.ensure(22);
  d.cap(label, FORM_X.L, d.y + 12, { size: 6 });
  d.text(d.fit(value, 330, 9.5), FORM_X.L + 150, d.y + 12, { size: 9.5 });
  d.line(FORM_X.L + 148, FORM_X.R, d.y + 16);
  d.y += 22;
}

function nuFields(d: FormDoc, c: Ctx) {
  const s = c.s;
  field(d, 'Firma', s.name);
  field(d, 'Rechtsform', s.legal_form ? (LEGAL_FORMS[s.legal_form] ?? s.legal_form) : '');
  field(
    d,
    'Anschrift',
    [s.street, `${s.postal_code ?? ''} ${s.city ?? ''}`.trim()].filter(Boolean).join(', '),
  );
  field(d, 'Inhaber / Geschäftsführer', c.contact);
  field(d, 'Telefon · E-Mail', [c.phone, c.email].filter(Boolean).join(' · '));
  field(d, 'Registergericht / HRB', '');
  field(d, 'Steuernummer', '');
  field(d, 'USt-IdNr.', s.vat_id ?? '');
  field(d, 'Betriebsnr. (Arbeitsagentur)', '');
  field(d, 'Mitglieds-Nr. BG BAU', '');
  field(d, 'Zahl der Beschäftigten', '');
}

export async function nuDocPdf(
  sql: Sql,
  supplierId: string,
  kind: NuDocKind,
  o: { start?: string | null; checked?: boolean; actorName?: string } = {},
): Promise<{ pdf: Uint8Array; name: string }> {
  const c = await context(sql, supplierId);
  const meta = NU_DOCS[kind];
  const today = todayBerlin();
  const dateDe = formatDateDe(today);
  const d = await FormDoc.create({
    title: `${meta.label} – ${c.s.name}`,
    sideRef: `${meta.ref} · Rev. 2.0 · Stand: ${dateDe}`,
    date: today,
    author: c.seller.legalName,
  });
  const nuSig = 'Ort, Datum · Unterschrift / Stempel Nachunternehmer';

  if (kind === 'rahmenvertrag') {
    if (!c.s.street || !c.s.postal_code || !c.s.city)
      throw new BusinessError(
        'Anschrift des Nachunternehmers fehlt – bitte zuerst in den Stammdaten eintragen.',
      );
    const start = o.start && /^\d{4}-\d{2}-\d{2}$/.test(o.start) ? o.start : today;
    header(d, 'Rahmenvertrag', 'über Reinigungsleistungen als Nachunternehmer');
    d.twoCols(
      {
        label: 'Auftraggeber (AG)',
        lines: [c.seller.legalName, c.seller.street, `${c.seller.postalCode} ${c.seller.city}`],
      },
      {
        label: `Auftragnehmer (AN) · Nr. ${c.s.supplier_no}`,
        lines: [c.s.name, c.s.street, `${c.s.postal_code} ${c.s.city}`],
      },
    );
    d.y += 4;
    blocks(d, RAHMENVERTRAG, { ...c.vars, start: formatDateDe(start) });
    d.y += 6;
    d.ensure(90);
    d.signatures(`Auftraggeber · ${c.seller.legalName}`, `Auftragnehmer · ${c.s.name}`, {
      leftText: `${c.seller.city}, den ${dateDe}`,
    });
  } else if (kind === 'selbstauskunft') {
    header(
      d,
      'Selbstauskunft & Compliance-Erklärung',
      'des Nachunternehmers – § 13 MiLoG, § 14 AEntG, § 28e Abs. 3a SGB IV',
    );
    d.para(`gegenüber ${c.seller.legalName}, ${c.sellerAddr}`, { size: 8.8 });
    d.section('1. Angaben zum Unternehmen');
    nuFields(d, c);
    let n = 2;
    for (const sec of SELBSTAUSKUNFT) {
      d.section(`${n++}. ${sec.title}`);
      for (const t of sec.items) check(d, fillAg(t, c.vars), !!o.checked);
    }
    d.section(`${n++}. Unterlagen (liegen bei bzw. werden vor Ablauf erneuert)`);
    for (const t of SELBSTAUSKUNFT_DOCS) check(d, t, false);
    d.section(`${n}. Bestätigung`);
    for (const t of SELBSTAUSKUNFT_END) d.para(fillAg(t, c.vars), { size: 8.8 });
    d.signatures('Ort, Datum', 'Unterschrift Inhaber / Geschäftsführer, Stempel');
  } else if (kind === 'mindestlohn') {
    header(d, 'Mindestlohnerklärung', 'nach § 13 MiLoG und § 14 AEntG');
    d.para(`gegenüber ${c.seller.legalName}, ${c.sellerAddr}`, { size: 8.8 });
    d.y += 4;
    field(d, 'Firma', c.s.name);
    field(
      d,
      'Anschrift',
      [c.s.street, `${c.s.postal_code ?? ''} ${c.s.city ?? ''}`.trim()].filter(Boolean).join(', '),
    );
    field(d, 'Inhaber / Geschäftsführer', c.contact);
    d.y += 4;
    d.para('Wir erklären verbindlich:', { bold: true, size: 9 });
    MINDESTLOHN.forEach((t, i) => {
      d.ensure(14);
      d.text(`${i + 1}.`, FORM_X.L + 2, d.y + 8.8, { size: 8.8 });
      d.para(fillAg(t, c.vars), { indent: 16, size: 8.8 });
    });
    d.signatures('Ort, Datum', nuSig.replace('Ort, Datum · ', ''));
  } else if (kind === 'tarif') {
    const wages = await sql<{ name: string; hourly_wage_cents: number }[]>`
      select name, hourly_wage_cents from app.wage_levels where active and name ilike 'Tariflohn%' order by name`;
    header(d, 'Tariftreue-Erklärung', 'Allgemeinverbindlicher Tarifvertrag für das Gebäudereinigerhandwerk');
    d.para(`gegenüber ${c.seller.legalName}, ${c.sellerAddr}`, { size: 8.8 });
    d.y += 4;
    field(d, 'Firma', c.s.name);
    d.y += 4;
    d.para(
      'Wir beschäftigen und entlohnen alle Personen, die wir für Aufträge des Auftraggebers einsetzen, mindestens nach dem allgemeinverbindlichen Tarifvertrag für das Gebäudereinigerhandwerk und gruppieren sie entsprechend ihrer Tätigkeit ein. Wir zahlen stets die jeweils geltenden Tariflöhne, auch nach Tariferhöhungen.',
      { size: 8.8 },
    );
    d.para('Eingesetzte Beschäftigte je Lohngruppe:', { bold: true, size: 9 });
    d.table(
      [
        { label: 'Lohngruppe / Tätigkeit', width: 300 },
        { label: 'derzeit (Stand Auftraggeber)', width: 120, align: 'right' },
        { label: 'Anzahl', width: 75, align: 'right' },
      ],
      [
        ...wages.map((w) => [w.name, `${formatEuro(BigInt(w.hourly_wage_cents) as Cents)} / Std.`, '']),
        ['Vorarbeiter / Objektleitung (betrieblich)', '', ''],
      ],
    );
    d.muted(
      'Die Beträge zeigen den Stand laut Lohntabelle des Auftraggebers; maßgeblich ist der jeweils geltende Tarifvertrag.',
    );
    d.signatures('Ort, Datum', 'Unterschrift / Stempel Nachunternehmer');
  } else {
    header(d, 'Bewertungsbogen Nachunternehmer', 'Lieferantenbewertung nach ISO 9001 (Abschnitt 8.4)');
    d.kvBox([
      { k: 'Nachunternehmer', v: `${c.s.name} (Nr. ${c.s.supplier_no})`, strong: true },
      { k: 'Bewertungszeitraum', v: '' },
      { k: 'Bewertet von', v: o.actorName ?? '' },
    ]);
    d.para('Bewertung je Kriterium: 5 = sehr gut … 1 = mangelhaft', { bold: true, size: 9 });
    d.table(
      [
        { label: 'Kriterium', width: 275 },
        { label: '5', width: 44, align: 'right' },
        { label: '4', width: 44, align: 'right' },
        { label: '3', width: 44, align: 'right' },
        { label: '2', width: 44, align: 'right' },
        { label: '1', width: 44, align: 'right' },
      ],
      BEWERTUNG.map((k) => [k, '○', '○', '○', '○', '○']),
    );
    d.para('Bemerkungen / Verbesserungen:', { bold: true, size: 9 });
    for (let i = 0; i < 3; i++) {
      d.y += 16;
      d.line(FORM_X.L, FORM_X.R, d.y);
    }
    d.y += 12;
    d.para('Ergebnis:', { bold: true, size: 9 });
    for (const t of [
      'Weiter beauftragen',
      'Nur eingeschränkt beauftragen (siehe Bemerkungen)',
      'Nicht weiter beauftragen',
    ])
      check(d, t, false);
    d.signatures('Ort, Datum', 'Unterschrift Bewerter');
  }
  const safe = c.s.name.replace(/[^\wäöüÄÖÜß-]+/g, '_').slice(0, 40);
  return { pdf: await d.save(), name: `${meta.file}_${c.s.supplier_no}_${safe}.pdf` };
}

/** PDF in den Dokumenten des Nachunternehmers ablegen (gleiche Vorlage am selben Tag = dieselbe Datei) */
export async function storeNuDoc(
  sql: Sql,
  cfg: UploadConfig,
  supplierId: string,
  kind: NuDocKind,
  doc: { pdf: Uint8Array; name: string },
  actor: string,
) {
  const id = uuidFrom(
    `nu-doc:${supplierId}:${kind}:${todayBerlin()}:${createHash('md5').update(doc.pdf).digest('hex')}`,
  );
  await storeFile(
    sql,
    cfg,
    {
      id,
      name: doc.name,
      type: 'application/pdf',
      data: doc.pdf,
      link: { type: 'supplier', id: supplierId },
      category: 'Verträge',
    },
    actor,
  );
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'nu_doc', 'supplier', ${supplierId}, ${sql.json({ kind, file: id })})`;
  return id;
}

/** Personaleinsatzliste zum Ausfüllen (§ 17 MiLoG, nur Initialen) */
export async function personnelListXlsx(sql: Sql, supplierId: string) {
  const c = await context(sql, supplierId);
  const data = writeXlsx([
    {
      name: 'Personaleinsatz',
      title: [
        'Personaleinsatzliste Nachunternehmer (§ 17 MiLoG)',
        `Nachunternehmer: ${c.s.name} (Nr. ${c.s.supplier_no}) · Auftraggeber: ${c.seller.legalName}`,
        'Monat: ____________   Bitte nur Initialen oder Personalnummer, keine Klarnamen.',
      ],
      header: [
        'Nr.',
        'Initialen / Pers.-Nr.',
        'Tätigkeit',
        'Objekt',
        'Datum',
        'Beginn',
        'Ende',
        'Pause (Min.)',
        'Stunden',
        'Stundenlohn brutto',
        'Lohngruppe',
      ],
      rows: Array.from({ length: 25 }, (_, i) => [i + 1, '', '', '', '', '', '', '', '', '', '']),
      footer: [['Aufzeichnungen nach § 17 MiLoG: binnen 7 Tagen erstellen, 2 Jahre aufbewahren.']],
      widths: [6, 18, 20, 26, 12, 9, 9, 11, 9, 16, 12],
    },
  ]);
  const safe = c.s.name.replace(/[^\wäöüÄÖÜß-]+/g, '_').slice(0, 40);
  return { data, name: `Personaleinsatzliste_${c.s.supplier_no}_${safe}.xlsx` };
}
