import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { addDays } from '../domain/time/holidays.js';
import { saveOffer } from './offers.js';
import { DEMO } from './seed.js';
import {
  getTender,
  linkOffer,
  listTenders,
  offerTarget,
  saveTender,
  setTenderStatus,
  tenderTaskId,
  type TenderInput,
  upcomingEvents,
} from './tenders.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

describe.skipIf(!available)('Ausschreibungen', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });
  const today = todayBerlin();
  const input = (over: Partial<TenderInput> = {}): TenderInput => ({
    title: 'Unterhaltsreinigung Grundschulen Los 2',
    authority: 'Landeshauptstadt München, Vergabestelle 1',
    customerId: null,
    referenceNo: 'VGSt1-2026-0815',
    platform: 'Vergabe.bayern',
    url: 'https://www.vergabe.bayern.de/x',
    procedure: 'offenes Verfahren',
    location: 'München',
    services: null,
    contractStart: '2027-01-01',
    contractTerm: '2 Jahre + 2 × 1 Jahr',
    estimatedCents: parseEuro('180.000,00'),
    deadline: `${addDays(today, 5)}T10:00`,
    questionsUntil: `${addDays(today, 2)}T12:00`,
    siteVisit: `${addDays(today, 1)}T09:30`,
    siteVisitRequired: true,
    bindingUntil: addDays(today, 90),
    responsible: 'Ahmed',
    notes: null,
    ...over,
  });

  it('Termine als Berliner Ortszeit, nächste Termine, Status-Regeln, Angebot verknüpfen', async () => {
    const id = randomUUID();
    await expect(
      saveTender(sql, randomUUID(), input({ questionsUntil: `${addDays(today, 9)}T12:00` }), 't'),
    ).rejects.toThrow(/vor der Abgabefrist/);
    await expect(saveTender(sql, randomUUID(), input({ url: 'javascript:alert(1)' }), 't')).rejects.toThrow(
      /https/,
    );
    await saveTender(sql, id, input(), 't');
    // Abgabefrist erscheint als Aufgabe (Fälligkeit = Abgabetag)
    const [task] =
      await sql`select status, due_date::text as due, entity_type::text as et from app.tasks where id = ${tenderTaskId(id)}`;
    expect(task).toEqual({ status: 'open', due: addDays(today, 5), et: 'tender' });
    const t = (await getTender(sql, id))!;
    expect(
      t.deadline_at!.toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
      }),
    ).toBe('10:00');
    expect(t.days_left).toBe(5);
    const ev = await upcomingEvents(sql, 14);
    expect(ev.filter((e) => e.tender_id === id).map((e) => e.kind)).toEqual([
      'Ortsbesichtigung',
      'Bieterfragen',
      'Abgabe',
    ]);
    expect(ev.find((e) => e.kind === 'Ortsbesichtigung')!.required).toBe(true);

    await expect(offerTarget(sql, id)).rejects.toThrow(/Kunde oder Interessent/);
    await saveTender(sql, id, input({ customerId: DEMO.authority, version: t.version }), 't');
    expect(await offerTarget(sql, id)).toEqual({ customerId: DEMO.authority, offerId: null });
    const offerId = randomUUID();
    await saveOffer(
      sql,
      offerId,
      {
        customerId: DEMO.authority,
        siteId: null,
        title: t.title,
        tenderReference: t.reference_no,
        tenderPlatform: t.platform,
        submissionDeadline: null,
        offerDate: today,
        validUntil: null,
        introText: null,
        closingText: null,
        lines: [
          {
            description: 'Reinigung',
            quantity: parseQuantity('1'),
            unitCode: 'LS',
            unitPrice: parseEuro('1000,00'),
            vatRate: 1900,
            recurring: true,
          },
        ],
      },
      't',
    );
    await linkOffer(sql, id, offerId);
    const linked = (await getTender(sql, id))!;
    expect(linked).toMatchObject({ offer_id: offerId, status: 'bearbeitung' });

    await expect(setTenderStatus(sql, id, 'verloren', null, 't')).rejects.toThrow(/Grund/);
    await setTenderStatus(sql, id, 'abgegeben', null, 't');
    expect((await getTender(sql, id))!.submitted_at).not.toBeNull();
    const [done] = await sql`select status from app.tasks where id = ${tenderTaskId(id)}`;
    expect(done!.status).toBe('done');
    expect((await upcomingEvents(sql, 14)).some((e) => e.tender_id === id)).toBe(false); // abgegeben → keine Erinnerung mehr
    await setTenderStatus(sql, id, 'gewonnen', 'Zuschlag 03.11.', 't');
    expect((await listTenders(sql, { view: 'abgeschlossen' })).map((x) => x.id)).toContain(id);
    expect((await listTenders(sql, { view: 'aktiv' })).map((x) => x.id)).not.toContain(id);
  });
});
