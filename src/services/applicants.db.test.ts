import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import {
  addDocument,
  deleteApplicant,
  deletionDue,
  getApplicant,
  importLegacyApplicants,
  listApplicants,
  matches,
  saveApplicant,
  savePosting,
  score,
  workdaysText,
} from './applicants.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();
const base = {
  city: 'München',
  postal_code: '81375',
  hours: 20,
  language: 'Deutsch',
  job_type: 'Reinigungskraft',
  time_of_day: 'morgens',
};

describe('Matching und Arbeitstage', () => {
  it('Gewichte wie alte App, Vokabular passt jetzt zusammen', () => {
    expect(score(base, base).score).toBe(100);
    expect(score({ ...base, hours: 27 }, base).score).toBe(90);
    expect(score({ ...base, hours: 40 }, base).score).toBe(80);
    expect(score({ ...base, postal_code: '81241' }, base).score).toBe(100); // gleicher PLZ-Bereich 81
    expect(score({ ...base, postal_code: '90402' }, base).miss).toContain('PLZ');
    expect(score({ ...base, time_of_day: 'flexibel' }, base).score).toBe(100);
    expect(score({ ...base, job_type: 'Bürokraft' }, { ...base, job_type: 'Bürokraft' }).score).toBe(100);
  });
  it('fasst gleiche Tage zusammen', () => {
    const fest = { mode: 'fest' as const, from: '06:00', to: '10:00' };
    expect(workdaysText({ Mo: fest, Di: fest, Mi: fest, Do: fest, Fr: fest, Sa: { mode: 'flexibel' } })).toBe(
      'Mo–Fr: 06:00–10:00 · Sa: flexibel',
    );
    expect(workdaysText({ Mo: fest, Mi: fest })).toBe('Mo: 06:00–10:00 · Mi: 06:00–10:00');
  });
});

describe.skipIf(!available)('Bewerber', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('Bewerber, Unterlagen, Stelle mit Treffern, Löschen inkl. Unterlagen, Löschfrist', async () => {
    const id = randomUUID();
    const inp = {
      name: 'Test Person',
      phone: null,
      email: null,
      postalCode: '81379',
      city: 'München',
      language: 'Deutsch',
      jobType: 'Reinigungskraft',
      hours: 22,
      timeOfDay: 'morgens',
      experience: 'viel',
      available: 'sofort',
      drivingLicence: false,
      note: null,
      expectedVersion: null,
    };
    await expect(saveApplicant(sql, id, { ...inp, postalCode: '813' }, 't')).rejects.toThrow(/PLZ/);
    await saveApplicant(sql, id, inp, 't');
    await addDocument(
      sql,
      id,
      { bytes: new TextEncoder().encode('%PDF'), name: 'lebenslauf.pdf', type: 'application/pdf' },
      't',
    );
    await expect(
      addDocument(sql, id, { bytes: new Uint8Array(3), name: 'x.exe', type: 'application/x' }, 't'),
    ).rejects.toThrow(/nur PDF/);
    expect((await getApplicant(sql, id))!.docs).toHaveLength(1);
    const pid = randomUUID();
    await savePosting(
      sql,
      pid,
      {
        title: 'Reinigungskraft Schule',
        jobType: 'Reinigungskraft',
        objectType: 'Schule',
        hours: 20,
        wageCents: 1500n,
        timeOfDay: 'morgens',
        city: 'München',
        postalCode: '81375',
        street: null,
        startOn: null,
        language: 'Deutsch',
        tasks: null,
        requirements: null,
        workdays: { Mo: { mode: 'fest', from: '06:00', to: '10:00' } },
        website: false,
        expectedVersion: null,
      },
      't',
    );
    const m = matches(await listApplicants(sql), { ...base });
    expect(m.map((x) => [x.a.name, x.score])).toEqual([['Test Person', 100]]);
    await sql`update app.applicants set status = 'Abgelehnt', status_changed_at = now() - interval '7 months' where id = ${id}`;
    expect((await deletionDue(sql)).map((d) => d.id)).toEqual([id]);
    await deleteApplicant(sql, id, 't');
    expect((await sql`select count(*)::int as n from app.applicant_documents`)[0]!.n).toBe(0);
  });

  it('Import alte App: Vokabular, Status, idempotent', async () => {
    const rows = [
      {
        id: 1,
        name: 'Alt Eins',
        art: 'Vollzeit',
        zeit: 'morgen',
        sprache: 'Deutsch ausreichend',
        erfahrung: '3–5 Jahre',
        status: 'Warteliste',
        plz: '81375',
        stunden: 30,
        fuehrerschein: true,
      },
      { id: 2, name: 'Alt Zwei', art: 'Objektleiter', zeit: 'tag', status: 'Neu' },
    ];
    expect(await importLegacyApplicants(sql, rows, 't')).toBe(2);
    expect(await importLegacyApplicants(sql, rows, 't')).toBe(0);
    const l = await listApplicants(sql);
    const a1 = l.find((a) => a.name === 'Alt Eins')!;
    expect(a1).toMatchObject({
      job_type: 'Reinigungskraft',
      time_of_day: 'morgens',
      language: 'Deutsch',
      experience: 'viel',
      status: 'In Prüfung',
    });
    expect(a1.note).toContain('Art (alt): Vollzeit');
    expect(l.find((a) => a.name === 'Alt Zwei')).toMatchObject({
      job_type: 'Vorarbeiter / Objektleitung',
      time_of_day: 'tagsüber',
    });
  });
});
