import { contactGreeting, stripGreeting } from '../domain/letter/greeting.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { FORM_COLORS, FORM_X, FormDoc, type FormCol } from './form-doc.js';
import type { LetterPdfInput } from './render.js';

/**
 * Briefe im selben Aufbau wie die Schreiben an Mitarbeitende (Kündigung, Abmahnung, Vertragsänderung –
 * Ahmed 26.11.: „NU-Kündigung, Schriftverkehr usw. im selben Format wie die Kündigung beim Mitarbeiter“):
 * Briefpapier, Titel groß mit Linie (rechts die Kennung, z. B. Bestellnummer), „Ort, den …“ rechts,
 * Anschrift, Anrede, Text, Grußformel, Unterschriftslinie.
 */
export interface FormLetterInput extends LetterPdfInput {
  /** Beschriftung unter der Unterschriftslinie (Standard: „Stempel und Unterschrift“) */
  signLabel?: string;
  /** Kennung rechts neben dem Titel (Standard: erster Eintrag in `info` außer dem Datum) */
  ref?: string | null;
}

const GRUSS = /^mit freundlichen grüßen/i;

export async function renderFormLetter(p: FormLetterInput): Promise<Uint8Array> {
  const title = p.title.replace(/\s*\n\s*/g, ' – ');
  const info = p.info.filter(([k]) => k !== 'Datum');
  const ref = p.ref === undefined ? (info[0] ? `${info[0][0]} ${info[0][1]}` : '') : (p.ref ?? '');
  const doc = await FormDoc.create({
    title,
    sideRef: `${title}${ref ? ` · ${ref}` : ''} · ${formatDateDe(p.date)}`,
    date: p.date,
    author: p.seller.legalName,
    ...(p.watermark ? { watermark: p.watermark } : {}),
  });
  // Titel: kurze Titel in Großbuchstaben wie „KÜNDIGUNG“, lange Betreffzeilen umbrochen in normaler Schreibweise
  const lines = p.title
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 1 && lines[0]!.length <= 34) doc.title(lines[0]!.toUpperCase(), ref || undefined);
  else {
    const all = lines.flatMap((l) => doc.wrap(l, FORM_X.R - FORM_X.L - (ref ? 150 : 0), 14, true));
    for (const [i, l] of all.entries()) {
      doc.text(l, FORM_X.L, doc.y + 13, { size: 14, bold: true });
      if (i === 0 && ref)
        doc.right(ref, doc.R, doc.y + 11, { size: 11, bold: true, color: FORM_COLORS.BORDEAUX });
      doc.y += 18;
    }
    doc.y += 4;
    doc.line(FORM_X.L, doc.R, doc.y, FORM_COLORS.INK, 0.5);
    doc.y += 12;
  }
  doc.placeDate(`${p.seller.city}, den ${formatDateDe(p.date)}`);
  for (const [k, v] of info.slice(p.ref === undefined ? 1 : 0))
    doc.right(`${k}: ${v}`, doc.R, (doc.y += 11), { size: 8.5, color: FORM_COLORS.MUT });
  if (info.length > (p.ref === undefined ? 1 : 0)) doc.y += 6;
  const b = p.buyer;
  const addr = [
    b.name,
    ...(b.name2 ?? '').split('\n'),
    b.contactName ? `z. Hd. ${b.contactName}` : null,
    b.street,
    [b.postalCode, b.city].filter(Boolean).join(' '),
  ]
    .map((x) => (x ?? '').trim())
    .filter(Boolean);
  for (const l of addr) doc.para(l, { size: 10 });
  doc.y += 10;
  if (p.objekt?.title) {
    doc.para(`Objekt: ${p.objekt.title}${p.objekt.address ? `, ${p.objekt.address}` : ''}`, {
      size: 10.5,
      bold: true,
    });
    doc.y += 2;
  }
  const greeting = p.greeting === undefined ? contactGreeting(b.contactName) : p.greeting;
  if (greeting) {
    doc.para(greeting, { size: 10.5 });
    doc.y += 4;
  }
  const intro = greeting ? stripGreeting(p.intro) : p.intro;
  if (intro) doc.para(intro, { size: 10.5 });

  if (p.columns.length) {
    doc.y += 4;
    const W = doc.R - FORM_X.L;
    const xs = p.columns.map((c) => c.x);
    const raw = p.columns.map((c, i) =>
      i + 1 < xs.length ? Math.max(40, xs[i + 1]! - xs[i]!) : Math.max(60, 539 - xs[i]!),
    );
    const scale = W / raw.reduce((a, x) => a + x, 0);
    const cols: FormCol[] = p.columns.map((c, i) => ({
      label: c.label,
      width: raw[i]! * scale,
      ...(c.align === 'left' || i === 0 ? { align: 'left' as const } : { align: 'right' as const }),
    }));
    const n = cols.length;
    const pad = (a: string, b: string) => [a, ...Array(Math.max(0, n - 2)).fill(''), b];
    doc.table(cols, [
      ...p.rows.map((r) =>
        Array.isArray(r) ? r : 'group' in r ? { group: r.group } : { sum: pad(r.subtotal[0], r.subtotal[1]) },
      ),
      ...p.sums.map(([k, v]) => ({ sum: pad(k, v) })),
      ...(p.total ? [{ sum: pad(p.total[0], p.total[1]), strong: true }] : []),
    ]);
    doc.y += 4;
  }

  // Grußformel abtrennen: „Mit freundlichen Grüßen“ (+ Name/Firma) steht über bzw. unter der Unterschriftslinie
  const paras = [...p.paragraphs];
  let closing: string[] = [];
  const gi = paras.findIndex((x) => GRUSS.test(x.trim()));
  if (gi >= 0) {
    closing = paras
      .slice(gi)
      .join('\n')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    paras.splice(gi);
  }
  for (const t of paras) for (const part of t.split('\n')) doc.para(part, { size: 10.5 });
  doc.y += 4;
  doc.para(closing[0] ?? 'Mit freundlichen Grüßen', { size: 10.5 });
  const below = closing.slice(1).join(', ');
  doc.signatures(below || p.signLabel || 'Stempel und Unterschrift', '');
  return doc.save();
}
