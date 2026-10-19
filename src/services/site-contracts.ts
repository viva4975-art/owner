/**
 * Verträge am Objekt (Ahmed 19.10.): Reinigungsvertrag und Arbeitnehmerüberlassungsvertrag als PDF im Stil „edel“,
 * ausgefüllt aus Firma, Kunde (Vertragspartner), Objekt und – beim Reinigungsvertrag – den aktiven Leistungen des
 * Objekts als Leistungsverzeichnis. Auf Wunsch unter Objekt → Dokumente → „Vertrag“ abgelegt (write-once, feste ID je
 * Inhalt). Nur Büro (Preise).
 */
import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { AUE_VERTRAG, type ContractBlock, REINIGUNGSVERTRAG } from '../domain/contracts/site-contracts.js';
import { CYCLE_LABEL, formatDateDe, todayBerlin, type BillingCycle } from '../domain/invoice/calc.js';
import { unitLabel } from '../domain/invoice/types.js';
import { type Cents, formatEuro, parseEuro } from '../domain/money/money.js';
import { fillAg } from '../domain/subcontract/nu-docs.js';
import { FORM_X, FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { effectiveBilling, getCustomer, getSeller, getSite } from './masterdata.js';
import { storeFile, type UploadConfig } from './uploads.js';

export const SITE_CONTRACTS = {
  reinigung: { label: 'Reinigungsvertrag', file: 'Reinigungsvertrag', ref: 'VD-KV-01 Reinigungsvertrag' },
  aue: {
    label: 'Arbeitnehmerüberlassungsvertrag',
    file: 'Arbeitnehmerueberlassungsvertrag',
    ref: 'VD-KV-02 Arbeitnehmerüberlassung',
  },
} as const;
export type SiteContractKind = keyof typeof SITE_CONTRACTS;
export const isSiteContract = (k: string): k is SiteContractKind => k in SITE_CONTRACTS;

/** Kündigungsfristen zur Auswahl (Schlüssel = Formularwert) */
export const NOTICE: Record<string, string> = {
  '2w': 'zwei Wochen',
  '1': 'einem Monat zum Monatsende',
  '3': 'drei Monaten zum Monatsende',
  '6': 'sechs Monaten zum Monatsende',
};

export interface SiteContractInput {
  date?: string | null;
  start?: string | null;
  /** 'unbefristet' | 'fest' */
  term?: string | null;
  end?: string | null;
  notice?: string | null;
  /** Reinigung: Lohnkostenanteil in Prozent (z. B. „80“) */
  laborPercent?: string | null;
  /** Reinigung: Regiestundensatz (optional) */
  regieRate?: string | null;
  /** AÜ */
  activity?: string | null;
  qualification?: string | null;
  headcount?: string | null;
  workTime?: string | null;
  rate?: string | null;
  surcharges?: string | null;
  billing?: string | null;
  placementFactor?: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: string | null | undefined) => (v && ISO.test(v) ? v : null);

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

interface ServiceRow {
  description: string;
  type_name: string | null;
  unit_code: string;
  quantity_milli: string;
  unit_price_cents: string;
  billing_cycle: BillingCycle;
  labor_share_bp: number | null;
  execution_notes: string | null;
  note: string | null;
}

async function activeServices(sql: Sql, siteId: string, onDate: string) {
  return sql<ServiceRow[]>`
    select ss.description, st.name as type_name, ss.unit_code, ss.quantity_milli::text, ss.unit_price_cents::text,
           ss.billing_cycle, ss.labor_share_bp, ss.execution_notes, ss.note
      from app.site_services ss
      left join app.service_types st on st.id = ss.service_type_id
     where ss.site_id = ${siteId} and ss.active
       and (ss.valid_to is null or ss.valid_to >= ${onDate}::date)
     order by ss.billing_cycle = 'monatlich' desc, ss.sort_order, ss.description`;
}

const lineNet = (r: ServiceRow) => (BigInt(r.quantity_milli) * BigInt(r.unit_price_cents) + 500n) / 1000n;
const qtyDe = (milli: string) => (Number(milli) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });

/** Vorschlag für den Lohnkostenanteil: nach Monatsbetrag gewichteter Anteil der regelmäßigen Leistungen */
export async function suggestedLaborPercent(sql: Sql, siteId: string): Promise<string> {
  const rows = (await activeServices(sql, siteId, todayBerlin())).filter(
    (r) => r.billing_cycle === 'monatlich' && r.labor_share_bp != null,
  );
  let w = 0n;
  let sum = 0n;
  for (const r of rows) {
    const n = lineNet(r);
    w += n;
    sum += n * BigInt(r.labor_share_bp!);
  }
  if (w <= 0n) return '';
  return (Number(sum / w) / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

function paymentText(days: number, skonto: { percentBp: number; days: number } | null) {
  const net =
    days === 0
      ? 'sofort nach Erhalt ohne Abzug'
      : `innerhalb von ${days} Tagen nach Rechnungsdatum ohne Abzug`;
  return skonto
    ? `${net}; bei Zahlung innerhalb von ${skonto.days} Tagen mit ${String(skonto.percentBp / 100).replace('.', ',')} % Skonto`
    : net;
}

function termText(i: SiteContractInput, start: string) {
  const notice = NOTICE[i.notice ?? ''] ?? NOTICE['3']!;
  const end = iso(i.end);
  if (i.term === 'fest') {
    if (!end || end <= start)
      throw new BusinessError('Bitte ein Vertragsende nach dem Vertragsbeginn angeben.');
    return `Der Vertrag beginnt am ${formatDateDe(start)} und läuft fest bis zum ${formatDateDe(end)}. Er verlängert sich jeweils um zwölf Monate, wenn er nicht von einer Partei mit einer Frist von ${notice.replace(' zum Monatsende', '')} zum Ablauf gekündigt wird.`;
  }
  return `Der Vertrag beginnt am ${formatDateDe(start)} und läuft auf unbestimmte Zeit. Er kann von beiden Parteien mit einer Frist von ${notice} gekündigt werden.`;
}

function blocks(d: FormDoc, list: ContractBlock[], vars: Record<string, string>, eckdaten?: () => void) {
  for (const b of list) {
    if ('eckdaten' in b) eckdaten?.();
    else if ('h' in b) {
      d.y += 4;
      d.ensure(44);
      d.heading(b.t ? `${b.h}   ${b.t}` : b.h, 10);
    } else if ('p' in b) {
      const t = fillAg(b.p, vars)
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (t) d.para(t, { bold: !!b.bold, size: 8.8 });
    } else if ('list' in b)
      b.list.forEach((t, n) => {
        d.ensure(14);
        d.text(b.num ? `${n + 1}.` : '–', FORM_X.L + 2, d.y + 8.8, { size: 8.8 });
        d.para(fillAg(t, vars), { indent: 16, size: 8.8 });
      });
  }
}

/** Leere Linien zum Ausfüllen in einer Tabelle */
const blankRows = (n: number, cols: number) => Array.from({ length: n }, () => Array<string>(cols).fill(''));

export async function siteContractPdf(
  sql: Sql,
  siteId: string,
  kind: SiteContractKind,
  i: SiteContractInput = {},
): Promise<{ pdf: Uint8Array; name: string }> {
  const site = await getSite(sql, siteId);
  if (!site) throw new BusinessError('Objekt nicht gefunden');
  const customer = await getCustomer(sql, site.customer_id);
  if (!customer) throw new BusinessError('Kunde nicht gefunden');
  const seller = await getSeller(sql);
  const billing = await effectiveBilling(sql, site.customer_id, siteId);
  const date = iso(i.date) ?? todayBerlin();
  const start = iso(i.start) ?? date;
  const dateDe = formatDateDe(date);
  const meta = SITE_CONTRACTS[kind];
  const siteAddr = [site.street, `${site.postal_code ?? ''} ${site.city ?? ''}`.trim()]
    .filter(Boolean)
    .join(', ');
  const objekt = `${site.name} (Nr. ${site.site_no})${siteAddr ? `, ${siteAddr}` : ''}`;
  const vars: Record<string, string> = {
    objekt,
    laufzeit: termText(i, start),
    zahlung: paymentText(billing.paymentTermsDays, billing.skonto),
    ort: seller.city,
  };

  const d = await FormDoc.create({
    title: `${meta.label} – ${customer.name}`,
    sideRef: `${meta.ref} · Stand: ${dateDe}`,
    date,
    author: seller.legalName,
  });
  const custLines = [
    customer.name,
    customer.name2 ?? '',
    customer.street,
    `${customer.postal_code} ${customer.city}`,
  ].filter(Boolean);
  const sellerLines = [seller.legalName, seller.street, `${seller.postalCode} ${seller.city}`];

  if (kind === 'reinigung') {
    const services = await activeServices(sql, siteId, start);
    const monthly = services.filter((r) => r.billing_cycle === 'monatlich');
    const monthSum = monthly.reduce((s, r) => s + lineNet(r), 0n);
    const labor = (i.laborPercent ?? '').trim().replace(',', '.');
    const laborNum = Number(labor);
    if (!labor || !Number.isFinite(laborNum) || laborNum <= 0 || laborNum > 100)
      throw new BusinessError('Bitte den Lohnkostenanteil in Prozent angeben (z. B. 80).');
    let regie = '';
    if (i.regieRate?.trim()) {
      const r = parseEuro(i.regieRate.trim());
      if (r <= 0n) throw new BusinessError('Regiestundensatz ungültig');
      regie = `; Regiestunden zu ${formatEuro(r)} netto je Stunde und Person`;
    }
    vars.lohnanteil = `${laborNum.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
    vars.monat =
      monthSum > 0n ? formatEuro(monthSum as Cents) : 'die im Leistungsverzeichnis genannte Vergütung';
    vars.regie = regie;

    d.y += 4;
    d.title('Reinigungsvertrag');
    d.muted('Vertrag über die Unterhaltsreinigung');
    d.y += 2;
    d.twoCols(
      { label: `Auftraggeber (AG) · Kd.-Nr. ${customer.customer_no}`, lines: custLines },
      { label: 'Auftragnehmer (AN)', lines: sellerLines },
    );
    d.kvBox([
      { k: 'Objekt', v: `${site.name} (Nr. ${site.site_no})`, strong: true },
      { k: 'Anschrift', v: siteAddr || '–' },
      { k: 'Vertragsbeginn', v: formatDateDe(start) },
    ]);
    blocks(d, REINIGUNGSVERTRAG, vars);
    d.y += 6;
    d.ensure(90);
    d.signatures(`Auftraggeber · ${customer.name}`, `Auftragnehmer · ${seller.legalName}`, {
      rightText: `${seller.city}, den ${dateDe}`,
    });

    // Anlage 1: Leistungsverzeichnis aus den Leistungen des Objekts
    d.newPage();
    d.y += 4;
    d.title('Anlage 1 – Leistungsverzeichnis');
    d.muted(`${objekt} · Stand ${formatDateDe(start)} · Preise netto zzgl. Umsatzsteuer`);
    d.y += 2;
    if (!services.length) {
      d.para('Für dieses Objekt sind noch keine Leistungen hinterlegt (Objekt → Leistungen & Preise).', {
        size: 8.8,
      });
      d.table(
        [
          { label: 'Leistung', width: 245 },
          { label: 'Häufigkeit', width: 90 },
          { label: 'Menge', width: 70, align: 'right' },
          { label: 'Preis netto', width: 90, align: 'right' },
        ],
        blankRows(8, 4),
      );
    } else {
      d.table(
        [
          { label: 'Leistung', width: 215 },
          { label: 'Abrechnung', width: 80 },
          { label: 'Menge', width: 75, align: 'right' },
          { label: 'Einzelpreis', width: 60, align: 'right' },
          { label: 'Betrag', width: 65, align: 'right' },
        ],
        [
          ...services.map((r) => {
            const title = r.description || r.type_name || 'Leistung';
            const extra = [r.type_name && r.type_name !== title ? r.type_name : '', r.execution_notes ?? '']
              .filter(Boolean)
              .join(' – ');
            return [
              extra ? `${title}\n${extra}` : title,
              CYCLE_LABEL[r.billing_cycle] ?? r.billing_cycle,
              `${qtyDe(r.quantity_milli)} ${unitLabel(r.unit_code, BigInt(r.quantity_milli))}`.trim(),
              formatEuro(BigInt(r.unit_price_cents) as Cents),
              formatEuro(lineNet(r) as Cents),
            ];
          }),
          ...(monthSum > 0n
            ? [{ sum: ['Summe monatlich (netto)', '', '', '', formatEuro(monthSum as Cents)], strong: true }]
            : []),
        ],
      );
      d.muted(
        'Leistungen „je Ausführung“ und „einmalig“ werden nach Ausführung berechnet; Beträge dort je Ausführung.',
      );
    }
  } else {
    const c = (
      await sql<
        {
          aue_permit_date: string | null;
          aue_permit_file_no: string | null;
          aue_permit_authority: string | null;
          aue_permit_valid_until: string | null;
          aue_permit_unlimited: boolean;
        }[]
      >`select aue_permit_date::text, aue_permit_file_no, aue_permit_authority, aue_permit_valid_until::text,
             aue_permit_unlimited from app.company where id = 1`
    )[0];
    if (!c?.aue_permit_date || !c.aue_permit_authority)
      throw new BusinessError(
        'Erlaubnis zur Arbeitnehmerüberlassung fehlt – bitte unter Einstellungen → Firmendaten eintragen (Datum, Behörde, Aktenzeichen).',
      );
    if (!c.aue_permit_unlimited && c.aue_permit_valid_until && c.aue_permit_valid_until < start)
      throw new BusinessError(
        `Die Erlaubnis zur Arbeitnehmerüberlassung gilt nur bis ${formatDateDe(c.aue_permit_valid_until)} – Vertragsbeginn liegt danach.`,
      );
    const activity = i.activity?.trim();
    if (!activity) throw new BusinessError('Bitte die Tätigkeit der Leiharbeitnehmer angeben.');
    const rateTxt = i.rate?.trim();
    if (!rateTxt) throw new BusinessError('Bitte den Verrechnungssatz je Stunde angeben.');
    const rate = parseEuro(rateTxt);
    if (rate <= 0n) throw new BusinessError('Verrechnungssatz ungültig');
    const factor = Number((i.placementFactor ?? '2').replace(',', '.'));
    if (!Number.isFinite(factor) || factor < 0 || factor > 3)
      throw new BusinessError('Vermittlungsvergütung: 0 bis 3 Monatsentgelte');
    vars.erlaubnis = `Der Verleiher besitzt die Erlaubnis zur Arbeitnehmerüberlassung nach § 1 AÜG, erteilt am ${formatDateDe(c.aue_permit_date)} von der ${c.aue_permit_authority}${c.aue_permit_file_no ? ` (Aktenzeichen ${c.aue_permit_file_no})` : ''}, ${c.aue_permit_unlimited ? 'unbefristet' : c.aue_permit_valid_until ? `befristet bis ${formatDateDe(c.aue_permit_valid_until)}` : 'befristet'} (§ 12 Abs. 1 Satz 2 AÜG).`;
    vars.satz = formatEuro(rate);
    vars.zuschlaege =
      i.surcharges?.trim() ||
      'Für Arbeit in der Nacht (22–6 Uhr), an Sonn- und Feiertagen und für Mehrarbeit werden die tariflichen Zuschläge der Gebäudereinigung als Aufschlag auf den Verrechnungssatz berechnet.';
    vars.abrechnung = i.billing === 'woechentlich' ? 'wöchentlich' : 'monatlich';
    vars.vermittlung = factor.toLocaleString('de-DE', { maximumFractionDigits: 1 });

    d.y += 4;
    d.title('Arbeitnehmerüberlassungsvertrag');
    d.muted('nach § 12 AÜG – Schriftform: von beiden Parteien eigenhändig zu unterschreiben');
    d.y += 2;
    d.twoCols(
      { label: 'Verleiher', lines: sellerLines },
      { label: `Entleiher · Kd.-Nr. ${customer.customer_no}`, lines: custLines },
    );
    const eckdaten = () =>
      d.kvBox([
        { k: 'Einsatzort', v: `${site.name} (Nr. ${site.site_no})`, strong: true },
        { k: 'Anschrift', v: siteAddr || '–' },
        { k: 'Tätigkeit', v: activity },
        ...(i.qualification?.trim() ? [{ k: 'Erforderliche Qualifikation', v: i.qualification.trim() }] : []),
        { k: 'Anzahl Leiharbeitnehmer', v: i.headcount?.trim() || 'nach Abruf' },
        { k: 'Einsatzzeit', v: i.workTime?.trim() || 'nach Absprache' },
        { k: 'Beginn der Überlassung', v: formatDateDe(start) },
        { k: 'Verrechnungssatz', v: `${formatEuro(rate)} netto je Stunde` },
      ]);
    blocks(
      d,
      factor === 0
        ? AUE_VERTRAG.map((b) =>
            'p' in b && b.p.includes('{vermittlung}')
              ? {
                  p: 'Begründet der Entleiher ein Arbeitsverhältnis mit einem überlassenen Leiharbeitnehmer, schuldet er dem Verleiher keine Vermittlungsvergütung. Er teilt die Übernahme unverzüglich mit.',
                }
              : b,
          )
        : AUE_VERTRAG,
      vars,
      eckdaten,
    );
    d.y += 6;
    d.ensure(90);
    d.signatures(`Verleiher · ${seller.legalName}`, `Entleiher · ${customer.name}`, {
      leftText: `${seller.city}, den ${dateDe}`,
    });

    d.newPage();
    d.y += 4;
    d.title('Anlage 1 – Benennung der Leiharbeitnehmer');
    d.muted(`§ 1 Abs. 1 Satz 6 AÜG · vor Beginn der Überlassung · ${objekt}`);
    d.y += 2;
    d.table(
      [
        { label: 'Name, Vorname', width: 170 },
        { label: 'Tätigkeit', width: 110 },
        { label: 'Beginn', width: 70 },
        { label: 'Ende', width: 70 },
        { label: 'Bei AG in letzten 3 Mon.?', width: 75 },
      ],
      blankRows(10, 5),
      { size: 11 },
    );
    d.signatures('Ort, Datum · Verleiher', 'Kenntnisnahme Entleiher');

    d.y += 14;
    d.ensure(300);
    d.title('Anlage 2 – Angaben des Entleihers');
    d.muted('Wesentliche Arbeitsbedingungen vergleichbarer Arbeitnehmer (§ 12 Abs. 1 Satz 3 AÜG)');
    d.y += 2;
    const fieldLine = (label: string) => {
      d.ensure(24);
      d.cap(label, FORM_X.L, d.y + 12, { size: 6 });
      d.line(FORM_X.L + 170, FORM_X.R, d.y + 16);
      d.y += 24;
    };
    d.para('□  Im Betrieb des Entleihers werden keine vergleichbaren Arbeitnehmer beschäftigt.', { size: 9 });
    d.para('□  Für vergleichbare Arbeitnehmer gelten folgende Bedingungen:', { size: 9 });
    for (const l of [
      'Anwendbarer Tarifvertrag',
      'Arbeitsentgelt brutto je Stunde',
      'Zulagen / Zuschläge / Sonderzahlungen',
      'Wöchentliche Arbeitszeit',
      'Urlaubsanspruch (Arbeitstage/Jahr)',
      'Sonstiges',
    ])
      fieldLine(l);
    d.signatures('Ort, Datum', `Entleiher · ${customer.name}`);
  }

  const safe = customer.name.replace(/[^\wäöüÄÖÜß-]+/g, '_').slice(0, 40);
  return { pdf: await d.save(), name: `${meta.file}_${site.site_no}_${safe}.pdf` };
}

/** PDF unter Objekt → Dokumente → „Vertrag“ ablegen (gleicher Inhalt = dieselbe Datei) */
export async function storeSiteContract(
  sql: Sql,
  cfg: UploadConfig,
  siteId: string,
  kind: SiteContractKind,
  doc: { pdf: Uint8Array; name: string },
  actor: string,
) {
  const id = uuidFrom(`site-contract:${siteId}:${kind}:${createHash('md5').update(doc.pdf).digest('hex')}`);
  await storeFile(
    sql,
    cfg,
    {
      id,
      name: doc.name,
      type: 'application/pdf',
      data: doc.pdf,
      link: { type: 'site', id: siteId },
      category: 'Vertrag',
    },
    actor,
  );
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'site_contract', 'site', ${siteId}, ${sql.json({ kind, file: id })})`;
  return id;
}
