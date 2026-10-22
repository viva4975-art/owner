import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import {
  getFeedSettings,
  hitCounts,
  inRegion,
  listHits,
  matchService,
  parseBundExport,
  parseTedNotice,
  runTenderFeed,
  setHitsStatus,
  takeOverHit,
  tedQuery,
} from './tender-feed.js';
import { getTender, tenderTaskId } from './tenders.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const today = todayBerlin();
const inTwoWeeks = addDays(today, 14);

const release = (o: {
  ocid: string;
  title: string;
  cpv: string;
  city: string;
  pc: string;
  nuts?: string;
  end?: string;
  tag?: string[];
}) => ({
  ocid: o.ocid,
  id: `${o.ocid}-1`,
  date: `${today}T08:00:00+02:00`,
  tag: o.tag ?? ['tender'],
  buyer: { id: 'org-1', name: 'Landratsamt Freising' },
  parties: [
    {
      id: 'org-1',
      name: 'Landratsamt Freising',
      roles: ['buyer'],
      address: { locality: 'Freising', postalCode: '85354', region: 'DE21B' },
    },
  ],
  tender: {
    title: o.title,
    description: `${o.title} – Leistungsbeschreibung`,
    procurementMethodDetails: 'Offenes Verfahren',
    classification: { scheme: 'CPV', id: o.cpv },
    tenderPeriod: { endDate: o.end ?? `${inTwoWeeks}T10:00:00+01:00` },
    items: [
      { id: '1', deliveryAddresses: [{ locality: o.city, postalCode: o.pc, region: o.nuts ?? 'DE21B' }] },
    ],
    lots: [{ id: 'LOT-0001', value: { amount: 250000, currency: 'EUR' } }],
    documents: [
      { id: 'd1', url: 'https://www.dtvp.de/Center/notice/CXP4YYY/documents' },
      {
        id: 'd2',
        url: 'https://oeffentlichevergabe.de/ui/de/search/details?noticeId=11111111-2222-3333-4444-555555555555',
      },
    ],
  },
});

const bundZip = () =>
  zipSync({
    'a.json': strToU8(
      JSON.stringify({
        releases: [
          release({
            ocid: 'ocds-1',
            title: 'Unterhaltsreinigung Schulen Freising',
            cpv: '90919300',
            city: 'Freising',
            pc: '85354',
          }),
          release({
            ocid: 'ocds-2',
            title: 'Straßenbau B 13',
            cpv: '45233000',
            city: 'Freising',
            pc: '85354',
          }),
          release({
            ocid: 'ocds-3',
            title: 'Glasreinigung Rathaus Hamburg',
            cpv: '90911300',
            city: 'Hamburg',
            pc: '20095',
            nuts: 'DE600',
          }),
          release({
            ocid: 'ocds-4',
            title: 'Gebäudereinigung Zuschlag',
            cpv: '90911200',
            city: 'Freising',
            pc: '85354',
            tag: ['award'],
          }),
        ],
      }),
    ),
    'b.json': strToU8(
      JSON.stringify(
        release({
          ocid: 'ocds-5',
          title: 'Reinigungsleistungen Polizei Stuttgart',
          cpv: '79000000',
          city: 'Stuttgart',
          pc: '70173',
          nuts: 'DE111',
        }),
      ),
    ),
  });

const tedNotice = {
  'publication-number': '700123-2026',
  'publication-date': [`${today}+01:00`],
  'notice-title': { deu: 'Deutschland – Reinigung von Gebäuden – Unterhaltsreinigung Klinikum' },
  'buyer-name': { deu: ['Klinikum Ingolstadt GmbH'] },
  'buyer-city': { deu: ['Ingolstadt'] },
  'buyer-country': ['DEU'],
  'classification-cpv': ['90911200'],
  'deadline-receipt-tender-date-lot': [`${inTwoWeeks}+01:00`],
  'estimated-value-proc': [1200000],
  links: { html: { DEU: 'https://ted.europa.eu/de/notice/-/detail/700123-2026' } },
};

const coords: Record<string, [number, number]> = {
  freising: [48.4, 11.75],
  hamburg: [53.55, 10.0],
  stuttgart: [48.7758, 9.1829],
  ingolstadt: [48.77, 11.42],
};

function fakeFetch(calls: string[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (url.includes('notice-exports')) {
      if (url.includes(`pubDay=${addDays(today, -1)}`)) return new Response(bundZip(), { status: 200 });
      return new Response('', { status: 404 });
    }
    if (url.includes('api.ted.europa.eu')) {
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain('buyer-country IN (DEU)');
      return Response.json({ notices: [tedNotice], totalNoticeCount: 1 });
    }
    if (url.includes('nominatim')) {
      const city = new URL(url).searchParams.get('city')?.toLowerCase() ?? '';
      const c = coords[city];
      return Response.json(c ? [{ lat: String(c[0]), lon: String(c[1]) }] : []);
    }
    return new Response('', { status: 404 });
  };
}

describe('Ausschreibungssuche – Lesen und Filtern', () => {
  it('liest OCDS-Export (ZIP, Paket und Einzelrelease), nur laufende Ausschreibungen', () => {
    const list = parseBundExport(bundZip());
    expect(list.map((n) => n.externalId).sort()).toEqual(['ocds-1', 'ocds-2', 'ocds-3', 'ocds-5']);
    const n = list.find((x) => x.externalId === 'ocds-1')!;
    expect(n).toMatchObject({
      authority: 'Landratsamt Freising',
      place: 'Freising',
      postalCode: '85354',
      nuts: 'DE21B',
      cpv: ['90919300'],
      valueCents: 25000000n,
      docsUrl: 'https://www.dtvp.de/Center/notice/CXP4YYY/documents',
      url: 'https://oeffentlichevergabe.de/ui/de/search/details?noticeId=11111111-2222-3333-4444-555555555555',
    });
    expect(n.deadline).toBe(`${inTwoWeeks}T10:00:00+01:00`);
  });

  it('liest TED-Bekanntmachung', () => {
    const n = parseTedNotice(tedNotice)!;
    expect(n).toMatchObject({
      externalId: '700123-2026',
      authority: 'Klinikum Ingolstadt GmbH',
      place: 'Ingolstadt',
      cpv: ['90911200'],
      valueCents: 120000000n,
      url: 'https://ted.europa.eu/de/notice/-/detail/700123-2026',
    });
  });

  it('Leistung über CPV oder Stichwort, Umkreis über Entfernung', () => {
    const s = {
      enabled: true,
      cpv_prefixes: ['9091'],
      keywords: ['Reinigungsleistungen'],
      regions: [{ name: 'München', lat: 48.1374, lng: 11.5755, km: 100 }],
      keep_unknown: true,
    };
    const [a, b, , d] = parseBundExport(bundZip());
    expect(matchService(a!, s)).toBe('CPV 90919300');
    expect(matchService(b!, s)).toBeNull();
    expect(matchService(d!, s)).toBe('Stichwort „Reinigungsleistungen“');
    expect(inRegion({ lat: 48.4, lng: 11.75 }, null, s)).toMatchObject({ keep: true, region: 'München' });
    expect(inRegion({ lat: 53.55, lng: 10 }, 'DE600', s).keep).toBe(false);
    expect(inRegion(null, 'DE212', s)).toMatchObject({ keep: true, region: 'Ort prüfen' });
    expect(inRegion(null, 'DE600', s).keep).toBe(false);
    expect(tedQuery(s, '2026-10-15')).toContain('classification-cpv=9091*');
    expect(tedQuery(s, '2026-10-15')).toContain('publication-date>=20261015');
  });
});

describe.skipIf(!available)('Ausschreibungssuche – Abruf und Eingang', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
  });

  it('holt Bund + TED, filtert, speichert ohne Dubletten, übernimmt als Ausschreibung', async () => {
    const s = await getFeedSettings(sql);
    expect(s.regions.map((r) => r.name)).toEqual(['München', 'Stuttgart']);
    const calls: string[] = [];
    const r = await runTenderFeed(sql, { fetcher: fakeFetch(calls) });
    expect(r.errors).toEqual([]);
    expect(r.bundDays).toBe(1);
    const hits = await listHits(sql, 'neu');
    // Freising (CPV), Stuttgart (Stichwort, 0 km), Ingolstadt (TED); Hamburg zu weit, Straßenbau keine Leistung
    expect(hits.map((h) => h.title).sort()).toEqual([
      'Deutschland – Reinigung von Gebäuden – Unterhaltsreinigung Klinikum',
      'Reinigungsleistungen Polizei Stuttgart',
      'Unterhaltsreinigung Schulen Freising',
    ]);
    const fr = hits.find((h) => h.title.includes('Freising'))!;
    expect(fr.region).toBe('München');
    expect(Number(fr.distance_km)).toBeGreaterThan(20);
    expect(Number(fr.distance_km)).toBeLessThan(40);
    // zweiter Lauf: Tag schon geholt, TED heute schon geholt, Orte zwischengespeichert → nichts doppelt
    const calls2: string[] = [];
    const r2 = await runTenderFeed(sql, { fetcher: fakeFetch(calls2) });
    expect(r2.added).toBe(0);
    expect(calls2.filter((u) => u.includes('nominatim'))).toEqual([]);
    expect((await hitCounts(sql)).neu).toBe(3);

    const tenderId = await takeOverHit(sql, fr.id, 'test');
    expect(await takeOverHit(sql, fr.id, 'test')).toBe(tenderId);
    const t = (await getTender(sql, tenderId))!;
    expect(t).toMatchObject({
      title: 'Unterhaltsreinigung Schulen Freising',
      authority: 'Landratsamt Freising',
      platform: 'DTVP',
      status: 'neu',
    });
    expect(t.estimated_cents).toBe(25000000n);
    const [task] =
      await sql`select due_date::text as due from app.tasks where id = ${tenderTaskId(tenderId)}`;
    expect(task?.due).toBe(inTwoWeeks);

    const st = hits.find((h) => h.title.includes('Stuttgart'))!;
    expect(await setHitsStatus(sql, [st.id], 'verworfen', 'test')).toBe(1);
    expect(await hitCounts(sql)).toMatchObject({ neu: 1, uebernommen: 1, verworfen: 1 });
  }, 60_000);
});
