import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  berlinToDate,
  connectAccount,
  createEvent,
  dateToBerlin,
  deleteEvent,
  getAccount,
  getEvent,
  listEvents,
  normalizeEvent,
  setExchangeFetcher,
  updateEvent,
} from './exchange-calendar.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const env = { SESSION_SECRET: 'test-secret-exchange-0123456789abcdef', APP_BASIC_AUTH: 'x:y' };
const EWS = 'https://mail.example.test/EWS/Exchange.asmx';

describe('Exchange-Kalender: Zeit', () => {
  it('Ortszeit Berlin ↔ UTC inkl. Sommer-/Winterzeit', () => {
    expect(berlinToDate('2026-07-01', '09:00').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(berlinToDate('2026-12-01', '09:00').toISOString()).toBe('2026-12-01T08:00:00.000Z');
    // Tag der Umstellung (25.10.2026, 03:00 → 02:00)
    expect(berlinToDate('2026-10-25', '12:00').toISOString()).toBe('2026-10-25T11:00:00.000Z');
    expect(dateToBerlin(new Date('2026-10-24T22:30:00Z'))).toEqual({ date: '2026-10-25', time: '00:30' });
  });
  it('Eingabe: ganztägig bis Mitternacht danach, Ende vor Beginn abgelehnt', () => {
    const base = {
      subject: 'Begehung',
      date: '2026-11-03',
      start: '10:00',
      endDate: '2026-11-03',
      end: '11:30',
      allDay: false,
      location: '',
      body: '',
      reminder: 15,
      busy: 'Busy' as const,
    };
    expect(normalizeEvent(base).end.toISOString()).toBe('2026-11-03T10:30:00.000Z');
    const all = normalizeEvent({ ...base, allDay: true, endDate: '2026-11-04' });
    expect(all.start.toISOString()).toBe('2026-11-02T23:00:00.000Z');
    expect(all.end.toISOString()).toBe('2026-11-04T23:00:00.000Z');
    expect(() => normalizeEvent({ ...base, end: '09:00' })).toThrow(/nach dem Beginn/);
    expect(() => normalizeEvent({ ...base, subject: ' ' })).toThrow(/Betreff/);
  });
});

describe.skipIf(!available)('Exchange-Kalender: Konto und Termine', () => {
  let sql: Sql;
  const userId = randomUUID();
  // kleiner nachgebauter Exchange-Server
  const items = new Map<string, { xml: string; ck: number }>();
  const requests: string[] = [];
  const ok = (inner: string) =>
    new Response(
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`,
      { status: 200 },
    );
  const field = (x: string, t: string) =>
    new RegExp(`<t:${t}[^>]*>([\\s\\S]*?)</t:${t}>`).exec(x)?.[1] ?? null;

  beforeAll(async () => {
    sql = await freshDatabase();
    setExchangeFetcher(async (url, init) => {
      const body = String(init.body);
      const auth = Buffer.from(
        String((init.headers as Record<string, string>).Authorization).replace('Basic ', ''),
        'base64',
      ).toString();
      if (url.includes('autodiscover')) {
        if (!url.startsWith('https://autodiscover.viva.test')) return new Response('', { status: 404 });
        return new Response(
          `<Autodiscover><Response><Account><Protocol><Type>EXCH</Type><EwsUrl>${EWS}</EwsUrl></Protocol></Account></Response></Autodiscover>`,
        );
      }
      if (url !== EWS) return new Response('', { status: 404 });
      if (auth !== 'ahmed@viva.test:geheim') return new Response('', { status: 401 });
      requests.push(body);
      if (body.includes('<m:GetFolder>'))
        return ok('<m:GetFolderResponseMessage ResponseClass="Success"></m:GetFolderResponseMessage>');
      if (body.includes('<m:CreateItem')) {
        const id = `AAMk${items.size + 1}/+=`;
        const xml = /<t:CalendarItem>([\s\S]*)<\/t:CalendarItem>/.exec(body)![1]!;
        items.set(id, { xml, ck: 1 });
        return ok(
          `<m:CreateItemResponseMessage ResponseClass="Success"><m:Items><t:CalendarItem><t:ItemId Id="${id.replace(/&/g, '&amp;')}" ChangeKey="ck1"/></t:CalendarItem></m:Items></m:CreateItemResponseMessage>`,
        );
      }
      const render = (id: string, it: { xml: string; ck: number }) =>
        `<t:CalendarItem><t:ItemId Id="${id}" ChangeKey="ck${it.ck}"/>${it.xml.replace(/<t:StartTimeZone[^>]*\/>|<t:EndTimeZone[^>]*\/>/g, '')}<t:IsRecurring>false</t:IsRecurring><t:Organizer><t:Mailbox><t:Name>Ahmed</t:Name></t:Mailbox></t:Organizer></t:CalendarItem>`;
      if (body.includes('<m:FindItem')) {
        const from = /StartDate="([^"]+)"/.exec(body)![1]!;
        const to = /EndDate="([^"]+)"/.exec(body)![1]!;
        const list = [...items]
          .filter(([, it]) => field(it.xml, 'Start')! < to && field(it.xml, 'End')! > from)
          .map(([id, it]) => render(id, it))
          .join('');
        return ok(
          `<m:FindItemResponseMessage ResponseClass="Success"><m:RootFolder><t:Items>${list}</t:Items></m:RootFolder></m:FindItemResponseMessage>`,
        );
      }
      const id = /<t:ItemId Id="([^"]+)"/.exec(body)?.[1]?.replace(/&amp;/g, '&') ?? '';
      const it = items.get(id);
      if (!it)
        return ok(
          '<m:X ResponseClass="Error"><m:MessageText>not found</m:MessageText><m:ResponseCode>ErrorItemNotFound</m:ResponseCode></m:X>',
        );
      if (body.includes('<m:GetItem'))
        return ok(
          `<m:GetItemResponseMessage ResponseClass="Success"><m:Items>${render(id, it)}</m:Items></m:GetItemResponseMessage>`,
        );
      if (body.includes('<m:UpdateItem')) {
        for (const m of body.matchAll(
          /<t:SetItemField>[\s\S]*?<t:CalendarItem>([\s\S]*?)<\/t:CalendarItem><\/t:SetItemField>/g,
        )) {
          const tag = /<t:(\w+)/.exec(m[1]!)![1]!;
          it.xml = it.xml.replace(new RegExp(`<t:${tag}[^>]*?(/>|>[\\s\\S]*?</t:${tag}>)`), m[1]!);
        }
        for (const m of body.matchAll(/<t:DeleteItemField><t:FieldURI FieldURI="\w+:(\w+)"\/>/g))
          it.xml = it.xml.replace(new RegExp(`<t:${m[1]}[^>]*?(/>|>[\\s\\S]*?</t:${m[1]}>)`), '');
        it.ck++;
        return ok('<m:UpdateItemResponseMessage ResponseClass="Success"></m:UpdateItemResponseMessage>');
      }
      if (body.includes('<m:DeleteItem')) {
        items.delete(id);
        return ok('<m:DeleteItemResponseMessage ResponseClass="Success"></m:DeleteItemResponseMessage>');
      }
      throw new Error(`unerwartet: ${body.slice(0, 200)}`);
    });
  });
  afterAll(async () => {
    setExchangeFetcher(null);
    await sql?.end();
  });

  it('Verbinden: falsches Passwort abgelehnt, Adresse per Autodiscover, Passwort nur verschlüsselt', async () => {
    await expect(
      connectAccount(sql, env, { userId, email: 'ahmed@viva.test', password: 'falsch', url: EWS }),
    ).rejects.toThrow(/Passwort falsch/);
    expect(await getAccount(sql, userId)).toBeNull();
    const url = await connectAccount(sql, env, { userId, email: 'Ahmed@Viva.test', password: 'geheim' });
    expect(url).toBe(EWS);
    const acc = await getAccount(sql, userId);
    expect(acc?.email).toBe('ahmed@viva.test');
    const [raw] = await sql<{ secret_enc: string }[]>`select secret_enc from app.exchange_accounts`;
    expect(raw!.secret_enc).not.toContain('geheim');
  });

  it('Termin anlegen, im Zeitraum finden, ändern, löschen', async () => {
    const id = await createEvent(sql, env, userId, {
      subject: 'Begehung Grundschule <A&B>',
      date: '2026-11-03',
      start: '10:00',
      endDate: '2026-11-03',
      end: '11:30',
      allDay: false,
      location: 'Neubiberg',
      body: 'Schlüssel mitnehmen',
      reminder: 30,
      busy: 'Busy',
    });
    expect(id).toMatch(/^AAMk/);
    const create = requests.find((r) => r.includes('<m:CreateItem'))!;
    expect(create).toContain('<t:Start>2026-11-03T09:00:00Z</t:Start>');
    expect(create).toContain('Begehung Grundschule &lt;A&amp;B&gt;');
    expect(create).toContain('<t:ReminderMinutesBeforeStart>30</t:ReminderMinutesBeforeStart>');
    expect(create).toContain('SendMeetingInvitations="SendToNone"');

    const week = await listEvents(sql, env, userId, '2026-11-02', '2026-11-09');
    expect(week).toHaveLength(1);
    expect(week[0]!.subject).toBe('Begehung Grundschule <A&B>');
    expect(dateToBerlin(week[0]!.start)).toEqual({ date: '2026-11-03', time: '10:00' });
    expect(week[0]!.reminder).toBe(30);
    expect(await listEvents(sql, env, userId, '2026-11-09', '2026-11-16')).toHaveLength(0);

    const ev = await getEvent(sql, env, userId, id);
    expect(ev.body).toBe('Schlüssel mitnehmen');
    expect(ev.organizer).toBe('Ahmed');
    await updateEvent(sql, env, userId, id, ev.changeKey, {
      subject: 'Begehung verschoben',
      date: '2026-11-04',
      start: '08:00',
      endDate: '2026-11-04',
      end: '09:00',
      allDay: false,
      location: '',
      body: '',
      reminder: null,
      busy: 'Tentative',
    });
    const after = await getEvent(sql, env, userId, id);
    expect(after.subject).toBe('Begehung verschoben');
    expect(dateToBerlin(after.start)).toEqual({ date: '2026-11-04', time: '08:00' });
    expect(after.reminder).toBeNull();
    expect(after.location).toBe('');
    expect(after.busy).toBe('Tentative');

    await deleteEvent(sql, env, userId, id);
    await expect(getEvent(sql, env, userId, id)).rejects.toThrow(/nicht gefunden/);
  });

  it('ohne verbundenes Konto: klare Meldung', async () => {
    await expect(listEvents(sql, env, randomUUID(), '2026-11-01', '2026-11-02')).rejects.toThrow(
      /Kein Outlook-Konto/,
    );
  });
});
