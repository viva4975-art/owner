import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import type { Mailer, OutgoingMail } from '../mail/mailer.js';
import {
  birthPassword,
  encryptPdf,
  payslipMailPreview,
  payslipMailStatus,
  payslipMonths,
  sendPayslip,
  setPayslipMailSkip,
} from './payslip-mail.js';
import { importPayslips, listPayslips, monthFromName, syncPayslipsFromFiles } from './payslips.js';
import { storeFile } from './uploads.js';
import { dbAvailable, freshDatabase } from './testing.js';

const available = await dbAvailable();

async function pdf(text: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font: f });
  return d.save();
}

describe('Passwort und Verschlüsselung', () => {
  it('Geburtsdatum → TTMMJJ', () => {
    expect(birthPassword('1985-03-05')).toBe('050385');
    expect(birthPassword(new Date('2001-12-31T00:00:00Z'))).toBe('311201');
    expect(birthPassword(null)).toBeNull();
  });
  it('PDF öffnet nur mit dem Passwort', async () => {
    const enc = await encryptPdf(await pdf('Lohn Oktober 7701'), '050385');
    await expect(getDocumentProxy(enc.slice())).rejects.toThrow();
    const doc = await getDocumentProxy(enc.slice(), { password: '050385' });
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toContain('Lohn Oktober 7701');
  });
});

describe('Monat aus dem Dateinamen', () => {
  it('erkennt die üblichen Schreibweisen', () => {
    expect(monthFromName('Lohnabrechnung_2025_August_1234_Ozog_Jakub.pdf')).toBe('2025-08');
    expect(monthFromName('Lohnabrechnung 2026-10 Oktober 2026 – Ana Eins (7701).pdf')).toBe('2026-10');
    expect(monthFromName('Abrechnung_10.2026.pdf')).toBe('2026-10');
    expect(monthFromName('Lohn Maerz 2026.pdf')).toBe('2026-03');
    expect(monthFromName('Scan0001.pdf')).toBeNull();
  });
});

describe.skipIf(!available)('Lohnabrechnung per E-Mail (Datenbank)', () => {
  let sql: Sql;
  let dir: string;
  const a = randomUUID();
  const b = randomUUID();
  const sent: OutgoingMail[] = [];
  const mailer: Mailer = { send: async (m) => (sent.push(m), { messageId: m.messageId }) };
  const env = { APP_ENV: 'live', MAIL_FROM: 'buchhaltung@viva-deluxe-reinigung.de' } as Env;
  beforeAll(async () => {
    sql = await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'lohnmail-'));
    await sql`insert into app.employees (id, personnel_no, first_name, last_name, entry_date, email, salutation)
              values (${a}, '7701', 'Ana', 'Eins', '2024-01-01', 'ana@example.org', 'Frau'),
                     (${b}, '7702', 'Bo', 'Zwei', '2024-01-01', 'bo@example.org', null)`;
    await sql`insert into app.employee_private (employee_id, birth_date) values (${a}, '1990-07-21')`;
  });
  afterAll(async () => {
    await sql?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('sendet verschlüsselt von der Buchhaltung, genau einmal; ohne Geburtsdatum nicht', async () => {
    const cfg = { dir, maxBytes: 5e7 };
    const r = await importPayslips(sql, cfg, {
      name: 'x.pdf',
      bytes: await pdf('Pers.-Nr. 7701'),
      month: '2026-10',
      release: false,
      actor: 't',
    });
    const r2 = await importPayslips(sql, cfg, {
      name: 'y.pdf',
      bytes: await pdf('Pers.-Nr. 7702'),
      month: '2026-10',
      release: false,
      actor: 't',
    });
    const fa = r.assigned[0]!.fileId;
    const fb = r2.assigned[0]!.fileId;
    await sendPayslip({ sql, env, mailer }, cfg, fa, 't');
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.from).toBe('Viva-Deluxe Buchhaltung <buchhaltung@viva-deluxe-reinigung.de>');
    expect(m.to).toEqual(['ana@example.org']);
    expect(m.subject).toBe('Ihre Lohnabrechnung Oktober 2026');
    expect(m.text).toContain('Sehr geehrte Frau Eins');
    expect(m.text).not.toContain('210790');
    const att = m.attachments[0]!.content;
    await expect(getDocumentProxy(att.slice())).rejects.toThrow();
    await getDocumentProxy(att.slice(), { password: '210790' });
    await expect(sendPayslip({ sql, env, mailer }, cfg, fa, 't')).rejects.toThrow(/schon gesendet/);
    await sendPayslip({ sql, env, mailer }, cfg, fa, 't', 'form-1');
    await sendPayslip({ sql, env, mailer }, cfg, fa, 't', 'form-1'); // doppelt abgeschickt
    expect(sent).toHaveLength(2);
    // „erneut senden“ bei einer noch nie gesendeten = erster Versand (danach nicht noch einmal ohne Absicht)
    expect((await payslipMailStatus(sql, [fa])).get(fa)?.status).toBe('gesendet');
    await expect(sendPayslip({ sql, env, mailer }, cfg, fb, 't')).rejects.toThrow(/Geburtsdatum fehlt/);
    expect(sent).toHaveLength(2);
  });

  it('nimmt Abrechnungen aus der Personalakte (Dokumente → Lohn) in die Liste', async () => {
    const cfg = { dir, maxBytes: 5e7 };
    const named = randomUUID();
    const byText = randomUUID();
    const unknown = randomUUID();
    await storeFile(
      sql,
      cfg,
      {
        id: named,
        name: 'Lohnabrechnung_2026_November_7701_Eins_Ana.pdf',
        type: 'application/pdf',
        data: await pdf('Pers.-Nr. 7701'),
        link: { type: 'employee', id: a },
        category: 'Lohnabrechnung',
      },
      't',
    );
    await storeFile(
      sql,
      cfg,
      {
        id: byText,
        name: 'Scan1.pdf',
        type: 'application/pdf',
        data: await pdf('Abrechnungsmonat: November 2026'),
        link: { type: 'employee', id: b },
        category: 'Lohnabrechnung',
      },
      't',
    );
    await storeFile(
      sql,
      cfg,
      {
        id: unknown,
        name: 'Scan2.pdf',
        type: 'application/pdf',
        data: await pdf('ohne Monat'),
        link: { type: 'employee', id: b },
        category: 'Lohnabrechnung',
      },
      't',
    );
    const r = await syncPayslipsFromFiles(sql, cfg);
    expect(r.added).toBe(2);
    expect(r.unknown.map((u) => u.file_id)).toEqual([unknown]);
    const list = await listPayslips(sql, { month: '2026-11' });
    expect(list.map((x) => x.file_id).sort()).toEqual([named, byText].sort());
    expect((await syncPayslipsFromFiles(sql, cfg)).added).toBe(0);
    await sendPayslip({ sql, env, mailer }, cfg, named, 't');
    expect(sent.at(-1)!.subject).toBe('Ihre Lohnabrechnung November 2026');
    await expect(sendPayslip({ sql, env, mailer }, cfg, named, 't')).rejects.toThrow(/schon gesendet/);
    const pv = await payslipMailPreview(sql, env, named);
    expect(pv.subject).toBe('Ihre Lohnabrechnung November 2026');
    expect(pv.to).toBe('ana@example.org');
    expect(pv.html).toContain('TTMMJJ');
  });

  it('ausgeblendete bekommen keine Mail, Monate mit offen/gesamt', async () => {
    const cfg = { dir, maxBytes: 5e7 };
    const f = randomUUID();
    await storeFile(
      sql,
      cfg,
      {
        id: f,
        name: 'Lohnabrechnung 2026-12 Dezember 2026.pdf',
        type: 'application/pdf',
        data: await pdf('x'),
        link: { type: 'employee', id: a },
        category: 'Lohnabrechnung',
      },
      't',
    );
    await syncPayslipsFromFiles(sql, cfg);
    expect((await payslipMonths(sql)).find((m) => m.month === '2026-12')).toEqual({
      month: '2026-12',
      total: 1,
      open: 1,
    });
    expect(await setPayslipMailSkip(sql, [f], true, 't', 'auf Papier')).toBe(1);
    await expect(sendPayslip({ sql, env, mailer }, cfg, f, 't')).rejects.toThrow(/ausgeblendet.*auf Papier/);
    expect((await payslipMonths(sql)).find((m) => m.month === '2026-12')!.open).toBe(0);
    expect(await setPayslipMailSkip(sql, [f], false, 't')).toBe(1);
    const n = sent.length;
    await sendPayslip({ sql, env, mailer }, cfg, f, 't');
    expect(sent).toHaveLength(n + 1);
    expect((await payslipMonths(sql)).find((m) => m.month === '2026-12')!.open).toBe(0);
  });
});
