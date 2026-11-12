/**
 * Liquiditätsnachweis (Ahmed 12.11.2026, Antrag/Verlängerung der Erlaubnis zur Arbeitnehmerüberlassung bei der
 * Bundesagentur für Arbeit): A4 hoch, alle eigenen Konten zusammen – Übersicht der Kontostände zum Stichtag, je Konto
 * ein Kontoauszug des Zeitraums mit Anfangs- und Endsaldo, je Bank ein Blatt „Bankbestätigung“ zum Ausfüllen durch die Bank.
 * Grundlage sind die per Bankabruf (Enable Banking) bzw. CAMT/CSV eingelesenen Umsätze und der Kontostand der Bank.
 * Die Aufstellung ist eine Eigenerklärung – als Nachweis „von der Bank“ gilt nur die von der Bank unterschriebene
 * Bestätigung bzw. ein Kontoauszug der Bank selbst.
 */
import type { Sql } from '../db/client.js';
import { addDays, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, formatEuro } from '../domain/money/money.js';
import { FORM_COLORS, FORM_X, FormDoc } from '../pdf/form-doc.js';
import { accountOverview, statement } from './bank-feed.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';

export interface LiquidityInput {
  /** Stichtag (Saldo am Ende des Tages) */
  date: string;
  /** Zeitraum der Kontoauszüge (Standard: 3 Monate bis Stichtag) */
  from: string;
  /** Anzahl Leiharbeitnehmer (für den Mindestbetrag; 0 = ohne Vergleich) */
  workers: number;
  ibans: string[];
  parts: ('uebersicht' | 'auszug' | 'bestaetigung')[];
  /** Auftraggeber/Empfänger und Verwendungszweck im Kontoauszug schwärzen (Datenschutz, Ahmed 12.11.) */
  redact?: boolean;
}

/** Mindestbetrag laut Fachlicher Weisung AÜG: 2.000 € je Leiharbeitnehmer, mindestens 10.000 € */
export const requiredLiquidity = (workers: number): bigint =>
  workers > 0 ? BigInt(Math.max(10_000_00, workers * 2_000_00)) : 0n;

const eur = (c: bigint) => formatEuro(c as Cents);
const d = (x: string) => formatDateDe(x);
const ibanFmt = (i: string) => i.replace(/(.{4})/g, '$1 ').trim();

export interface LiquidityAccount {
  iban: string;
  name: string;
  bic: string | null;
  bank: string | null;
  /** Saldo am Stichtag (null = kein Kontostand der Bank bekannt) */
  balance: bigint | null;
  /** niedrigster Tagesendsaldo im Zeitraum */
  min: bigint | null;
  minDate: string | null;
  start: bigint | null;
  income: bigint;
  outgo: bigint;
  rows: { date: string; name: string; purpose: string; amount: bigint; saldo: bigint | null }[];
  bankBalanceAt: Date | null;
}

export async function liquidityData(sql: Sql, i: LiquidityInput) {
  if (i.from > i.date) throw new BusinessError('„Auszug ab“ liegt nach dem Stichtag');
  if (i.date > todayBerlin()) throw new BusinessError('Stichtag liegt in der Zukunft');
  const seller = await getSeller(sql);
  const all = await accountOverview(sql);
  const chosen = all.filter((a) => !i.ibans.length || i.ibans.includes(a.iban));
  if (!chosen.length) throw new BusinessError('Bitte mindestens ein Konto wählen');
  const conns = await sql<{ iban: string; bank: string | null }[]>`
    select a.iban, c.aspsp_name as bank from app.bank_feed_accounts a
      join app.bank_connections c on c.id = a.connection_id where a.active`;
  const accounts: LiquidityAccount[] = [];
  for (const a of chosen) {
    const st = await statement(sql, { iban: a.iban, from: i.from, to: i.date });
    // laufender Saldo: aufsteigend ab Anfangssaldo
    const asc = [...st.rows].reverse();
    let bal = st.start;
    let min: bigint | null = st.start;
    let minDate: string | null = st.start != null ? addDays(i.from, -1) : null;
    const rows = asc.map((t, k) => {
      if (bal != null) bal += t.amount_cents;
      const lastOfDay = asc[k + 1]?.booking_date !== t.booking_date;
      if (bal != null && lastOfDay && (min == null || bal < min)) {
        min = bal;
        minDate = t.booking_date;
      }
      return {
        date: t.booking_date,
        name: t.counterparty_name ?? '',
        purpose: t.purpose,
        amount: t.amount_cents,
        saldo: bal,
      };
    });
    const sb = seller.bankAccounts.find((b) => b.iban.replace(/\s/g, '').toUpperCase() === a.iban);
    accounts.push({
      iban: a.iban,
      name: a.name,
      bic: sb?.bic ?? null,
      bank: conns.find((c) => c.iban === a.iban)?.bank ?? sb?.name ?? null,
      balance: st.end,
      min,
      minDate,
      start: st.start,
      income: st.income,
      outgo: st.outgo,
      rows,
      bankBalanceAt: a.balance_at,
    });
  }
  const known = accounts.filter((a) => a.balance != null);
  const total = known.reduce((s, a) => s + a.balance!, 0n);
  const required = requiredLiquidity(i.workers);
  return { seller, accounts, total, complete: known.length === accounts.length, required };
}

export async function liquidityPdf(sql: Sql, i: LiquidityInput) {
  const k = await liquidityData(sql, i);
  const s = k.seller;
  const doc = await FormDoc.create({
    title: `Liquiditätsnachweis ${d(i.date)}`,
    sideRef: `Liquiditätsnachweis · Stichtag ${d(i.date)}`,
    date: todayBerlin(),
    author: s.legalName,
    plain: true,
  });
  const L = FORM_X.L;
  const firm = `${s.legalName} · ${s.street} · ${s.postalCode} ${s.city}`;
  let first = true;
  const page = () => {
    if (!first) doc.newPage();
    first = false;
  };

  if (i.parts.includes('uebersicht')) {
    page();
    doc.title('LIQUIDITÄTSNACHWEIS', `Stichtag ${d(i.date)}`);
    doc.placeDate(`${s.city}, den ${d(todayBerlin())}`);
    doc.para(firm, { size: 10, bold: true });
    doc.para(
      'Aufstellung der Guthaben auf den Geschäftskonten zur Vorlage bei der Bundesagentur für Arbeit ' +
        '(Erlaubnis zur Arbeitnehmerüberlassung, § 3 Abs. 1 Nr. 1 AÜG).',
      { size: 10 },
    );
    doc.y += 6;
    doc.table(
      [
        { label: 'Bank / Konto', width: 140 },
        { label: 'IBAN', width: 176 },
        { label: `Saldo ${d(i.date)}`, width: 92, align: 'right' },
        { label: 'Niedrigster Stand', width: 90, align: 'right' },
      ],
      [
        ...k.accounts.map((a) => [
          a.bank && a.bank !== a.name ? `${a.bank} – ${a.name}` : (a.bank ?? a.name),
          ibanFmt(a.iban),
          a.balance != null ? eur(a.balance) : 'nicht bekannt',
          a.min != null ? `${eur(a.min)}\n${d(a.minDate!)}` : '–',
        ]),
        { sum: ['Summe aller Konten', '', eur(k.total), ''], strong: true },
      ],
      { size: 10 },
    );
    doc.para(`Niedrigster Stand = niedrigster Tagesendsaldo vom ${d(i.from)} bis ${d(i.date)}.`, {
      size: 8.5,
      color: FORM_COLORS.MUT,
    });
    if (k.required > 0n) {
      doc.y += 6;
      const ok = k.total >= k.required;
      doc.kvBox([
        { k: 'Leiharbeitnehmer', v: `${i.workers} (geplant)` },
        { k: 'Mindestbetrag', v: eur(k.required) },
        { k: 'Guthaben', v: eur(k.total), strong: true },
        {
          k: 'Ergebnis',
          v: ok ? 'Mindestbetrag erreicht' : `Fehlbetrag ${eur(k.required - k.total)}`,
          accent: true,
        },
      ]);
      doc.para(
        'Mindestbetrag laut Bundesagentur für Arbeit: 2.000 € je Leiharbeitnehmer, mindestens 10.000 €.',
        {
          size: 8.5,
          color: FORM_COLORS.MUT,
        },
      );
    }
    if (!k.complete)
      doc.para(
        'Hinweis: Für mindestens ein Konto liegt kein Kontostand der Bank vor – Saldo nicht enthalten.',
        { size: 9, bold: true },
      );
    doc.y += 8;
    doc.section('Grundlage');
    doc.para(
      'Die Salden sind aus dem elektronisch abgerufenen Kontostand der Bank und den gebuchten Umsätzen ' +
        'errechnet (Kontoauszüge anbei). Eine Bestätigung der Bank wird auf Anforderung nachgereicht.',
      { size: 9 },
    );
    doc.signatures('Stempel und Unterschrift Arbeitgeber', '');
  }

  if (i.parts.includes('auszug'))
    for (const a of k.accounts) {
      page();
      doc.title('KONTOAUSZUG', `${d(i.from)} – ${d(i.date)}`);
      doc.kvBox([
        { k: 'Kontoinhaber', v: s.legalName },
        { k: 'Bank', v: [a.bank, a.bic].filter(Boolean).join(' · ') || '–' },
        { k: 'IBAN', v: ibanFmt(a.iban), strong: true },
        { k: `Anfangssaldo ${d(addDays(i.from, -1))}`, v: a.start != null ? eur(a.start) : '–' },
        { k: 'Eingänge / Ausgänge', v: `${eur(a.income)} / ${eur(a.outgo)}` },
        { k: `Endsaldo ${d(i.date)}`, v: a.balance != null ? eur(a.balance) : '–', accent: true },
      ]);
      doc.y += 4;
      if (i.redact)
        doc.table(
          [
            { label: 'Datum', width: 62 },
            { label: 'Auftraggeber / Empfänger', width: 150, redact: true },
            { label: 'Verwendungszweck', width: 196, redact: true },
            { label: 'Betrag', width: 90, align: 'right' },
          ],
          a.rows.length
            ? a.rows.map((r) => [d(r.date), r.name ? 'x' : '', r.purpose ? 'x' : '', eur(r.amount)])
            : [['', '', '', '']],
          { size: 8.5 },
        );
      else
        doc.table(
          [
            { label: 'Datum', width: 62 },
            { label: 'Auftraggeber / Empfänger · Verwendungszweck', width: 346 },
            { label: 'Betrag', width: 90, align: 'right' },
          ],
          a.rows.length
            ? a.rows.map((r) => [
                d(r.date),
                [r.name, r.purpose].filter(Boolean).join('\n').slice(0, 300),
                eur(r.amount),
              ])
            : [['', 'Keine Umsätze im Zeitraum', '']],
          { size: 8.5 },
        );
      if (!a.rows.length && i.redact) doc.para('Keine Umsätze im Zeitraum.', { size: 9 });
      if (i.redact && a.rows.length)
        doc.para('Auftraggeber/Empfänger und Verwendungszweck aus Datenschutzgründen geschwärzt.', {
          size: 8,
          color: FORM_COLORS.MUT,
        });
      if (a.bankBalanceAt)
        doc.para(
          `Kontostand laut Bank abgerufen am ${a.bankBalanceAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}; ` +
            'Salden rückwärts über die gebuchten Umsätze errechnet.',
          { size: 8, color: FORM_COLORS.MUT },
        );
    }

  if (i.parts.includes('bestaetigung'))
    for (const a of k.accounts) {
      page();
      doc.title('BANKBESTÄTIGUNG', 'zur Vorlage bei der Bundesagentur für Arbeit');
      doc.para(`An: ${a.bank ?? 'die kontoführende Bank'}`, { size: 10.5, bold: true });
      doc.y += 4;
      doc.para(
        `Wir bitten um Bestätigung des Kontoguthabens zum Stichtag ${d(i.date)} für den Antrag auf ` +
          'Erteilung bzw. Verlängerung der Erlaubnis zur Arbeitnehmerüberlassung (§ 2 AÜG).',
        { size: 10 },
      );
      doc.y += 6;
      doc.kvBox([
        { k: 'Kontoinhaber', v: s.legalName },
        { k: 'Anschrift', v: `${s.street}, ${s.postalCode} ${s.city}` },
        { k: 'IBAN', v: ibanFmt(a.iban), strong: true },
        { k: 'BIC', v: a.bic ?? '–' },
      ]);
      doc.y += 10;
      doc.section('Von der Bank auszufüllen');
      const line = (label: string) => {
        doc.ensure(34);
        doc.y += 22;
        doc.text(label, L, doc.y, { size: 10 });
        doc.line(L + 230, doc.R, doc.y + 2, FORM_COLORS.INK, 0.6);
        doc.y += 8;
      };
      line(`Guthaben am ${d(i.date)} (EUR)`);
      line('Eingeräumte Kreditlinie (EUR)');
      line('davon frei verfügbar (EUR)');
      line('Bestehen Pfändungen/Sperren? (ja/nein)');
      doc.y += 10;
      doc.para('Wir bestätigen die Richtigkeit der vorstehenden Angaben nach unseren Unterlagen.', {
        size: 10,
      });
      doc.signatures('Ort, Datum, Stempel und Unterschrift der Bank', '', {});
    }

  if (first) throw new BusinessError('Bitte mindestens einen Teil wählen');
  return { pdf: await doc.save(), name: `Liquiditaetsnachweis_${i.date}.pdf` };
}

/** Kontoauszug eines Kontos als PDF (A4 hoch) – für den Knopf am Kontoauszug */
export async function statementPdf(sql: Sql, p: { iban: string; from: string; to: string }) {
  const to = p.to > todayBerlin() ? todayBerlin() : p.to;
  const from = p.from > to ? to : p.from;
  const r = await liquidityPdf(sql, { date: to, from, workers: 0, ibans: [p.iban], parts: ['auszug'] });
  return { ...r, name: `Kontoauszug_${p.iban.slice(-6)}_${from}_${to}.pdf` };
}
