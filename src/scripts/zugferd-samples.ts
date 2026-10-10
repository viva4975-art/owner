import { writeFile } from 'node:fs/promises';
import { sampleCancellation, sampleDocument, sampleFinal } from '../einvoice/fixtures.js';
import { generateZugferd } from '../einvoice/generate.js';
import { renderInvoicePdf } from '../pdf/invoice-pdf.js';

/** Beispiel-ZUGFeRD-Dateien für die PDF/A-Prüfung (scripts/check-pdfa.sh). Aufruf: tsx … <Zielverzeichnis> */
const out = process.argv[2];
if (!out) throw new Error('Zielverzeichnis fehlt');
const d = sampleDocument();
const docs = {
  rechnung: d,
  storno: sampleCancellation(),
  schluss: sampleFinal(),
  lastschrift: {
    ...d,
    buyer: {
      ...d.buyer,
      directDebit: {
        mandateRef: 'M-1',
        iban: 'DE02120300000000202051',
        creditorId: 'DE98ZZZ09999999999',
        scheme: 'CORE' as const,
      },
    },
  },
};
for (const [n, doc] of Object.entries(docs)) {
  await writeFile(
    `${out}/${n}.pdf`,
    await generateZugferd(doc, await renderInvoicePdf(doc), `${doc.number}.pdf`),
  );
}
