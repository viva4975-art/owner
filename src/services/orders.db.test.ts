import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { saveOffer, setOfferStatus } from './offers.js';
import {
  cancelWorkReport,
  closeWithoutSignature,
  deleteWorkReport,
  getOrder,
  getWorkReport,
  orderFromOffer,
  orderToInvoice,
  reportsToInvoice,
  saveOrder,
  saveWorkReport,
  signWorkReport,
  workReportPdf,
} from './orders.js';
import { DEMO } from './seed.js';
import { type FakeMailer, dbAvailable, freshDatabase, testDeps } from './testing.js';
import type { Deps } from './workflow.js';

const available = await dbAvailable();

describe.skipIf(!available)('Aufträge und Arbeitsscheine', () => {
  let sql: Sql;
  let deps: Deps & { mailer: FakeMailer };
  let png: Uint8Array;
  beforeAll(async () => {
    sql = await freshDatabase();
    deps = await testDeps(sql);
    png = new Uint8Array(await QRCode.toBuffer('Unterschrift', { type: 'png', width: 200 }));
  });
  afterAll(async () => {
    await sql?.end();
  });

  const report = (over: Partial<Parameters<typeof saveWorkReport>[2]> = {}) => ({
    orderId: null,
    siteId: DEMO.siteSchool,
    workDate: '2026-10-02',
    startTime: '08:00',
    endTime: '11:30',
    employeeIds: [],
    description: 'Grundreinigung Turnhalle nach Umbau',
    materials: 'Grundreiniger 5 l',
    remarks: null,
    lines: [
      { description: 'Regiestunden', quantity: parseQuantity('7'), unitCode: 'HUR' },
      { description: 'Entsorgung Bauschutt', quantity: parseQuantity('1'), unitCode: 'LS' },
    ],
    expectedVersion: null,
    ...over,
  });

  it('Auftrag mit Nummer AU-JJJJ-NNNN, Arbeitsschein AS-JJJJ-NNNN; Auftrag geht auf „in Arbeit“', async () => {
    const oid = randomUUID();
    await saveOrder(
      sql,
      oid,
      {
        customerId: DEMO.authority,
        siteId: DEMO.siteSchool,
        offerId: null,
        title: 'Grundreinigung Turnhalle',
        description: null,
        orderReference: 'BE-77',
        plannedDate: '2026-10-02',
        lines: [
          {
            description: 'Grundreinigung Turnhalle pauschal',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('1.840,00'),
            vatRate: 1900,
          },
        ],
        expectedVersion: null,
      },
      'test',
    );
    const o = (await getOrder(sql, oid))!.order;
    expect(o.number).toMatch(/^AU-\d{4}-0001$/);
    const wid = randomUUID();
    await saveWorkReport(sql, wid, report({ orderId: oid }), 'test');
    const w = (await getWorkReport(sql, wid))!.report;
    expect(w.number).toMatch(/^AS-2026-\d{4}$/);
    expect((await getOrder(sql, oid))!.order.status).toBe('in_arbeit');

    // Rechnung erst nach Unterschrift
    await expect(orderToInvoice(deps, oid, 'test')).rejects.toThrow(/noch nicht unterschrieben/);
    await expect(
      signWorkReport(deps, wid, { name: 'Hausmeister Maier', png: new Uint8Array([1, 2, 3]) }, 'test'),
    ).rejects.toThrow(/Unterschrift fehlt/);
    await signWorkReport(deps, wid, { name: 'Hausmeister Maier', png }, 'objektleitung');
    await signWorkReport(deps, wid, { name: 'Jemand anderes', png }, 'objektleitung'); // doppelt → nichts
    const signed = (await getWorkReport(sql, wid))!.report;
    expect(signed.status).toBe('unterschrieben');
    expect(signed.signed_by_name).toBe('Hausmeister Maier');
    expect(signed.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    const pdf = await workReportPdf(deps, wid);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');

    // unveränderbar
    await expect(
      saveWorkReport(sql, wid, report({ orderId: oid, description: 'geändert' }), 'test'),
    ).rejects.toThrow(/unveränderbar/);
    await expect(sql`update app.work_reports set description = 'x' where id = ${wid}`).rejects.toThrow(
      /abgeschlossen/,
    );
    await expect(sql`delete from app.work_report_lines where work_report_id = ${wid}`).rejects.toThrow(
      /unveränderbar/,
    );

    // Abrechnung: Entwurf mit Auftragspositionen + Arbeitsschein als Anlage, nur einmal
    const inv = await orderToInvoice(deps, oid, 'buero');
    expect(await orderToInvoice(deps, oid, 'buero')).toBe(inv);
    const [i] = await sql<
      { net_cents: bigint; order_reference: string }[]
    >`select net_cents, order_reference from app.invoices where id = ${inv}`;
    expect(i!.net_cents).toBe(184000n);
    expect(i!.order_reference).toBe('BE-77');
    const docs = await sql<
      { filename: string }[]
    >`select filename from app.invoice_documents where invoice_id = ${inv} and kind = 'attachment'`;
    expect(docs.map((d) => d.filename)).toEqual([`Arbeitsschein_${signed.number}.pdf`]);
    expect((await getOrder(sql, oid))!.order.status).toBe('abgerechnet');
    expect((await getWorkReport(sql, wid))!.report.invoice_id).toBe(inv);
  });

  it('Regiearbeiten ohne Auftrag: Stunden mit Regiesatz des Objekts, Schein ohne Unterschrift mit Grund', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await saveWorkReport(sql, a, report({ workDate: '2026-09-29' }), 'test');
    await saveWorkReport(
      sql,
      b,
      report({
        workDate: '2026-09-30',
        lines: [{ description: 'Regiestunden', quantity: parseQuantity('2,5'), unitCode: 'HUR' }],
      }),
      'test',
    );
    await signWorkReport(deps, a, { name: 'Frau Huber', png }, 'test');
    // Runde 23: „PDF erstellen“ schließt ohne Grund ab (Vermerk wird gesetzt), zweiter Aufruf ändert nichts
    await closeWithoutSignature(deps, b, ' ', 'test');
    await closeWithoutSignature(deps, b, 'Kein Ansprechpartner vor Ort', 'test');
    const [cb] = await sql<
      { no_signature_reason: string }[]
    >`select no_signature_reason from app.work_reports where id = ${b}`;
    expect(cb!.no_signature_reason).toMatch(/PDF erstellt/);
    const inv = await reportsToInvoice(deps, DEMO.siteSchool, [a, b], 'buero');
    const lines = await sql<
      { description: string; quantity_milli: bigint; unit_price_cents: bigint; detail: string }[]
    >`
      select description, quantity_milli, unit_price_cents, detail from app.invoice_lines where invoice_id = ${inv} order by position`;
    expect(lines).toHaveLength(3);
    expect(lines[0]!.unit_price_cents).toBe(2980n); // Regiesatz Demo-Schule
    expect(lines[1]!.unit_price_cents).toBe(0n); // Pauschale zum Ausfüllen
    expect(lines[2]!.quantity_milli).toBe(2500n);
    expect(lines[0]!.detail).toContain('Arbeitsschein AS-');
    await expect(reportsToInvoice(deps, DEMO.siteSchool, [a], 'buero')).rejects.toThrow(/schon abgerechnet/);
  });

  it('Auftrag aus angenommenem Angebot (nur einmalige Positionen, nur einmal)', async () => {
    const offer = randomUUID();
    await saveOffer(
      sql,
      offer,
      {
        customerId: DEMO.company,
        siteId: DEMO.siteHq,
        title: 'Sonderreinigung Lager',
        tenderReference: null,
        tenderPlatform: null,
        submissionDeadline: null,
        offerDate: '2026-10-01',
        validUntil: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Unterhalt',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('500,00'),
            vatRate: 1900,
            recurring: true,
          },
          {
            description: 'Sonderreinigung',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('900,00'),
            vatRate: 1900,
            recurring: false,
          },
        ],
      },
      'test',
    );
    await expect(orderFromOffer(sql, offer, 'test')).rejects.toThrow(/angenommenen/);
    await setOfferStatus(sql, offer, 'versendet', 'test');
    await setOfferStatus(sql, offer, 'angenommen', 'test');
    const o1 = await orderFromOffer(sql, offer, 'test');
    const o2 = await orderFromOffer(sql, offer, 'test');
    expect(o1).toBe(o2);
    const o = (await getOrder(sql, o1))!;
    expect(o.lines.map((l) => l.description)).toEqual(['Sonderreinigung']);
    expect(o.order.net_cents).toBe(90000n);
  });

  it('mehrtägig von–bis, Stunden je Datum; Entwurf löschen, Abgeschlossenen stornieren', async () => {
    const id = randomUUID();
    const multi = report({
      workDate: '2026-10-05',
      workDateTo: '2026-10-07',
      lines: [
        {
          description: 'Regiestunden',
          quantity: parseQuantity('4'),
          unitCode: 'HUR',
          person: 'Ana',
          lineDate: '2026-10-05',
        },
        {
          description: 'Regiestunden',
          quantity: parseQuantity('3'),
          unitCode: 'HUR',
          person: 'Ana',
          lineDate: '2026-10-06',
        },
      ],
    });
    await saveWorkReport(sql, id, multi, 'test');
    let r = (await getWorkReport(sql, id))!;
    expect(r.report.work_date_to).toBe('2026-10-07');
    expect(r.lines.map((l) => l.line_date)).toEqual(['2026-10-05', '2026-10-06']);
    // Datum außerhalb von–bis abgelehnt
    await expect(
      saveWorkReport(
        sql,
        id,
        {
          ...multi,
          lines: [
            {
              description: 'Regiestunden',
              quantity: parseQuantity('1'),
              unitCode: 'HUR',
              person: 'Ana',
              lineDate: '2026-10-09',
            },
          ],
          expectedVersion: r.report.version,
        },
        'test',
      ),
    ).rejects.toThrow(/außerhalb/);
    await expect(
      saveWorkReport(sql, randomUUID(), report({ workDate: '2026-10-05', workDateTo: '2026-10-01' }), 'test'),
    ).rejects.toThrow(/bis/);
    expect(Buffer.from((await workReportPdf(deps, id)).slice(0, 5)).toString()).toBe('%PDF-');

    // Entwurf löschen
    const draft = randomUUID();
    await saveWorkReport(sql, draft, report(), 'test');
    await deleteWorkReport(sql, draft, 'test');
    expect(await getWorkReport(sql, draft)).toBeUndefined();

    // abgeschlossen: löschen verboten, stornieren mit Grund; danach nicht abrechenbar
    await closeWithoutSignature(deps, id, '', 'test');
    await expect(deleteWorkReport(sql, id, 'test')).rejects.toThrow(/Admin/);
    await expect(cancelWorkReport(sql, id, ' ', 'test')).rejects.toThrow(/Grund/);
    await cancelWorkReport(sql, id, 'doppelt erfasst', 'test');
    r = (await getWorkReport(sql, id))!;
    expect(r.report.cancel_reason).toBe('doppelt erfasst');
    await expect(reportsToInvoice(deps, DEMO.siteSchool, [id], 'buero')).rejects.toThrow(
      /schon abgerechnet|nicht abgeschlossen/,
    );
    await expect(sql`update app.work_reports set remarks = 'x' where id = ${id}`).rejects.toThrow(
      /storniert/,
    );
  });
});
