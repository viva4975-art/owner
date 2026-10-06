import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client.js';
import { canAccess, homeFor } from '../web/permissions.js';
import { DEMO } from './seed.js';
import { dbAvailable, freshDatabase } from './testing.js';
import {
  authenticate,
  changePassword,
  checkPassword,
  createUser,
  bootstrapLogin,
  ensureBootstrapAdmin,
  getUser,
  listUsers,
  managedSites,
  oneTimePassword,
  resetPassword,
  updateUser,
} from './users.js';

describe('Rechte je Rolle', () => {
  it('Objektleitung: Zeiten und eigene Objekte, keine Preise/Rechnungen/Personal', () => {
    expect(canAccess('objektleitung', '/zeiterfassung')).toBe(true);
    expect(canAccess('objektleitung', '/zeiterfassung/freigaben')).toBe(true);
    expect(canAccess('objektleitung', '/einsatzplanung')).toBe(true);
    expect(canAccess('objektleitung', `/objekte/${DEMO.siteSchool}/einsaetze`)).toBe(true);
    expect(canAccess('objektleitung', `/objekte/${DEMO.siteSchool}/leistungen`)).toBe(false);
    expect(canAccess('objektleitung', '/rechnungen')).toBe(false);
    expect(canAccess('objektleitung', '/kunden')).toBe(false);
    expect(canAccess('objektleitung', '/personal')).toBe(false);
    expect(canAccess('objektleitung', '/zeiterfassung/pruefbericht')).toBe(false);
    expect(canAccess('objektleitung', '/datev')).toBe(false);
    expect(homeFor('objektleitung')).toBe('/zeiterfassung');
  });
  it('Buchhaltung ohne Personal, Personal ohne Rechnungen, Benutzer nur Admin', () => {
    expect(canAccess('buchhaltung', '/rechnungen/neu')).toBe(true);
    expect(canAccess('buchhaltung', '/datev')).toBe(true);
    expect(canAccess('buchhaltung', '/personal')).toBe(false);
    expect(canAccess('personal', '/personal/123/bearbeiten')).toBe(true);
    expect(canAccess('personal', '/zeiterfassung/pruefbericht')).toBe(true);
    expect(canAccess('personal', '/rechnungen')).toBe(false);
    expect(canAccess('personal', '/zahlungslauf')).toBe(false);
    expect(canAccess('buchhaltung', '/benutzer')).toBe(false);
    expect(canAccess('admin', '/benutzer')).toBe(true);
  });
  it('Passwortregeln und Einmal-Passwort', () => {
    expect(() => checkPassword('kurz1')).toThrow(/10 Zeichen/);
    expect(() => checkPassword('nurbuchstaben')).toThrow(/Ziffern/);
    expect(() => checkPassword(oneTimePassword())).not.toThrow();
  });
});

const available = await dbAvailable();

describe.skipIf(!available)('Benutzerkonten (Datenbank)', () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = await freshDatabase();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('erster Start legt Admin aus APP_BASIC_AUTH an (nur einmal)', async () => {
    expect(bootstrapLogin('Ahmed Chomontek')).toBe('ahmed.chomontek');
    expect(() => bootstrapLogin(' ')).toThrow(/ungültig/);
    expect(await ensureBootstrapAdmin(sql, 'ahmed:geheim12345')).toBe(true);
    expect(await ensureBootstrapAdmin(sql, 'ahmed:geheim12345')).toBe(false);
    const u = await authenticate(sql, 'Ahmed', 'geheim12345');
    expect(u.role).toBe('admin');
    expect(u.must_change_password).toBe(false);
  });

  it('Anmeldung: gleiche Meldung, Sperre nach 5 Fehlversuchen, Einmal-Passwort hebt Sperre auf', async () => {
    const { id } = await createUser(
      sql,
      {
        login: 'maria.ol',
        name: 'Maria Objektleitung',
        email: null,
        role: 'objektleitung',
        password: 'Start12345x',
        mustChange: true,
      },
      'ahmed',
    );
    await expect(authenticate(sql, 'gibtsnicht', 'x')).rejects.toThrow('Benutzername oder Passwort falsch');
    for (let i = 0; i < 5; i++)
      await expect(authenticate(sql, 'maria.ol', 'falsch123456')).rejects.toThrow(
        'Benutzername oder Passwort falsch',
      );
    await expect(authenticate(sql, 'maria.ol', 'Start12345x')).rejects.toThrow(/Fehlversuche/);
    const pw = await resetPassword(sql, id, 'ahmed');
    const u = await authenticate(sql, 'maria.ol', pw);
    expect(u.must_change_password).toBe(true);
    await expect(changePassword(sql, id, 'falsch', 'NeuesPasswort1')).rejects.toThrow(/Aktuelles Passwort/);
    await changePassword(sql, id, pw, 'NeuesPasswort1');
    expect((await authenticate(sql, 'maria.ol', 'NeuesPasswort1')).must_change_password).toBe(false);
    const [h] = await sql`select password_hash from app.user_accounts where id = ${id}`;
    expect(String(h!.password_hash)).not.toContain('NeuesPasswort1');
  });

  it('Objektleitung bekommt Objekte zugeordnet, sieht nur diese', async () => {
    const u = (await listUsers(sql)).find((x) => x.login === 'maria.ol')!;
    await updateUser(
      sql,
      u.id,
      {
        name: u.name,
        email: null,
        role: 'objektleitung',
        active: true,
        siteIds: [DEMO.siteSchool],
        expectedVersion: null,
      },
      'ahmed',
    );
    expect(await managedSites(sql, u)).toEqual([DEMO.siteSchool]);
    // Rollenwechsel entfernt die Zuordnung
    await updateUser(
      sql,
      u.id,
      { name: u.name, email: null, role: 'buchhaltung', active: true, siteIds: [], expectedVersion: null },
      'ahmed',
    );
    expect(await managedSites(sql, { id: u.id, role: 'objektleitung' })).toEqual([]);
    expect(await managedSites(sql, { id: u.id, role: 'buchhaltung' })).toBeNull();
  });

  it('der letzte Admin kann nicht entfernt werden; deaktivierte Benutzer können sich nicht anmelden', async () => {
    const admin = (await listUsers(sql)).find((x) => x.role === 'admin')!;
    await expect(
      updateUser(
        sql,
        admin.id,
        {
          name: admin.name,
          email: null,
          role: 'buchhaltung',
          active: true,
          siteIds: [],
          expectedVersion: null,
        },
        'ahmed',
      ),
    ).rejects.toThrow(/aktiver Admin/);
    const { id } = await createUser(
      sql,
      {
        login: 'tmp',
        name: 'Tmp',
        email: null,
        role: 'personal',
        password: 'Start12345x',
        mustChange: false,
      },
      'ahmed',
    );
    await updateUser(
      sql,
      id,
      { name: 'Tmp', email: null, role: 'personal', active: false, siteIds: [], expectedVersion: null },
      'ahmed',
    );
    await expect(authenticate(sql, 'tmp', 'Start12345x')).rejects.toThrow(/falsch/);
    expect((await getUser(sql, id))!.active).toBe(false);
    // doppelt abgeschickt → kein zweites Konto
    const again = await createUser(
      sql,
      {
        id,
        login: 'tmp',
        name: 'Tmp',
        email: null,
        role: 'personal',
        password: 'Start12345x',
        mustChange: false,
      },
      'ahmed',
    );
    expect(again.created).toBe(false);
    await expect(
      createUser(
        sql,
        {
          id: randomUUID(),
          login: 'tmp',
          name: 'X',
          email: null,
          role: 'personal',
          password: 'Start12345x',
          mustChange: false,
        },
        'ahmed',
      ),
    ).rejects.toThrow(/vergeben/);
  });
});
