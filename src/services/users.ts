import { ensureAuthUser } from './auth-users.js';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Benutzerkonten fürs Büro (Prototyp, bis Supabase Auth übernimmt).
 * Passwort mind. 10 Zeichen, scrypt; 5 Fehlversuche → 15 Minuten gesperrt; Erstpasswort muss geändert werden.
 */

export type Role = 'admin' | 'buchhaltung' | 'personal' | 'objektleitung';
export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Geschäftsführung / Admin',
  buchhaltung: 'Büro / Buchhaltung',
  personal: 'Personalabteilung',
  objektleitung: 'Objektleitung',
};
export const ROLE_HINT: Record<Role, string> = {
  admin: 'Alles, inkl. Benutzer und Einstellungen.',
  buchhaltung:
    'Kunden, Angebote, Rechnungen, Mahnwesen, Einkauf, Zahlungslauf, DATEV, Auswertungen. Keine vertraulichen Personaldaten.',
  personal:
    'Mitarbeiter inkl. vertraulicher Daten, Zeiterfassung, Prüfbericht, Urlaub, Einsatzplanung. Keine Rechnungen/Preise.',
  objektleitung:
    'Nur eigene Objekte: Einsatzplanung, Zeiten, Nachträge freigeben, Schlüssel, Geräte. Keine Preise.',
};

export interface User {
  id: string;
  login: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  active: boolean;
  must_change_password: boolean;
  locked_until: Date | null;
  last_login_at: Date | null;
  version: number;
}

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export function checkPassword(pw: string) {
  if (pw.length < 10) throw new BusinessError('Passwort: mindestens 10 Zeichen');
  if (!/[a-zA-ZäöüÄÖÜß]/.test(pw) || !/\d/.test(pw))
    throw new BusinessError('Passwort: Buchstaben und Ziffern verwenden');
}

async function hash(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(pw, salt, 32)).toString('hex')}`;
}

async function verify(pw: string, stored: string) {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  return timingSafeEqual(await scrypt(pw, Buffer.from(s, 'hex'), 32), Buffer.from(h, 'hex'));
}

const userSelect = (sql: Sql) => sql`
  select a.id, a.login, p.display_name as name, p.email, p.phone, p.role::text as role, a.active, a.must_change_password,
         a.locked_until, a.last_login_at, a.version
    from app.user_accounts a join app.profiles p on p.user_id = a.id`;

export async function listUsers(sql: Sql) {
  return sql<(User & { sites: number })[]>`
    select u.*, (select count(*)::int from app.sites s where s.manager_user_id = u.id) as sites
      from (${userSelect(sql)}) u order by u.active desc, u.name`;
}

export async function getUser(sql: Sql, id: string) {
  const [u] = await sql<User[]>`${userSelect(sql)} where a.id = ${id}`;
  return u;
}

export async function countUsers(sql: Sql) {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from app.user_accounts`;
  return r!.n;
}

export async function createUser(
  sql: Sql,
  p: {
    id?: string;
    login: string;
    name: string;
    email: string | null;
    role: Role;
    password: string;
    mustChange: boolean;
  },
  actor: string,
) {
  const login = p.login.trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,64}$/.test(login))
    throw new BusinessError('Benutzername: 3–64 Zeichen, nur a–z, 0–9, . _ @ -');
  if (!p.name.trim()) throw new BusinessError('Name fehlt');
  if (!(p.role in ROLE_LABEL)) throw new BusinessError('Rolle ungültig');
  checkPassword(p.password);
  const id = p.id ?? randomUUID();
  const h = await hash(p.password);
  let created = false;
  const [dup0] = await sql`select 1 from app.user_accounts where login = ${login} and id <> ${id}`;
  if (dup0) throw new BusinessError('Benutzername ist vergeben');
  await ensureAuthUser(sql, id, p.email);
  await sql.begin(async (tx) => {
    const [dup] = await tx`select 1 from app.user_accounts where login = ${login} and id <> ${id}`;
    if (dup) throw new BusinessError('Benutzername ist vergeben');
    const [exists] = await tx`select 1 from app.user_accounts where id = ${id}`;
    if (exists) return; // gleiches Formular zweimal gesendet
    await tx`insert into app.profiles (user_id, display_name, role, email) values (${id}, ${p.name.trim()}, ${p.role}, ${p.email})
             on conflict (user_id) do update set display_name = excluded.display_name, role = excluded.role, email = excluded.email`;
    await tx`insert into app.user_accounts (id, login, password_hash, must_change_password, created_by)
             values (${id}, ${login}, ${h}, ${p.mustChange}, ${actor})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'create', 'user', ${id}, ${tx.json({ login, role: p.role })})`;
    created = true;
  });
  return { id, created };
}

/** Einmal-Passwort im Format xxxx-xxxx-xxxx7 (ohne verwechselbare Zeichen). */
export function oneTimePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pw = '';
  for (const b of randomBytes(12)) pw += alphabet[b % alphabet.length];
  return `${pw.slice(0, 4)}-${pw.slice(4, 8)}-${pw.slice(8)}7`;
}

export async function updateUser(
  sql: Sql,
  id: string,
  p: {
    name: string;
    email: string | null;
    phone?: string | null;
    role: Role;
    active: boolean;
    siteIds: string[];
    expectedVersion: number | null;
  },
  actor: string,
) {
  if (!(p.role in ROLE_LABEL)) throw new BusinessError('Rolle ungültig');
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ version: number; role: Role }[]>`
      select a.version, p.role::text as role from app.user_accounts a join app.profiles p on p.user_id = a.id where a.id = ${id} for update of a`;
    if (!cur) throw new BusinessError('Benutzer nicht gefunden');
    if (p.expectedVersion !== null && cur.version !== p.expectedVersion)
      throw new BusinessError('Der Benutzer wurde zwischenzeitlich geändert – bitte neu laden.');
    if (cur.role === 'admin' && (p.role !== 'admin' || !p.active)) {
      const [{ n }] = (await tx`
        select count(*)::int as n from app.user_accounts a join app.profiles p on p.user_id = a.id
         where p.role = 'admin' and a.active and a.id <> ${id}`) as unknown as [{ n: number }];
      if (n === 0) throw new BusinessError('Mindestens ein aktiver Admin muss bleiben');
    }
    await tx`update app.profiles set display_name = ${p.name.trim()}, role = ${p.role}, email = ${p.email} where user_id = ${id}`;
    if (p.phone !== undefined) await tx`update app.profiles set phone = ${p.phone} where user_id = ${id}`;
    await tx`update app.user_accounts set active = ${p.active} where id = ${id}`;
    // Objekt-Zuordnung (nur Objektleitung)
    await tx`update app.sites set manager_user_id = null where manager_user_id = ${id}
              and ${p.role === 'objektleitung' ? tx`id not in ${tx(p.siteIds.length ? p.siteIds : ['00000000-0000-0000-0000-000000000000'])}` : tx`true`}`;
    if (p.role === 'objektleitung' && p.siteIds.length) {
      await tx`update app.sites set manager_user_id = ${id} where id in ${tx(p.siteIds)}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'update', 'user', ${id}, ${tx.json({ role: p.role, active: p.active, sites: p.siteIds.length })})`;
  });
}

/** Neues Einmal-Passwort (Admin): Benutzer muss es bei der nächsten Anmeldung ändern. */
export async function resetPassword(sql: Sql, id: string, actor: string): Promise<string> {
  const pw = oneTimePassword();
  await sql`update app.user_accounts set password_hash = ${await hash(pw)}, must_change_password = true, failed_attempts = 0, locked_until = null
             where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'reset_password', 'user', ${id})`;
  return pw;
}

export async function changePassword(sql: Sql, id: string, current: string, next: string) {
  const [a] = await sql<
    { password_hash: string }[]
  >`select password_hash from app.user_accounts where id = ${id}`;
  if (!a || !(await verify(current, a.password_hash)))
    throw new BusinessError('Aktuelles Passwort ist falsch');
  if (current === next) throw new BusinessError('Neues Passwort muss sich unterscheiden');
  checkPassword(next);
  await sql`update app.user_accounts set password_hash = ${await hash(next)}, must_change_password = false where id = ${id}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${id}, 'change_password', 'user', ${id})`;
}

/** Anmeldung. Einheitliche Meldung bei unbekanntem Namen und falschem Passwort. */
export async function authenticate(sql: Sql, login: string, password: string): Promise<User> {
  const generic = new BusinessError('Benutzername oder Passwort falsch');
  const [a] = await sql<{ id: string; password_hash: string; active: boolean; locked_until: Date | null }[]>`
    select id, password_hash, active, locked_until from app.user_accounts where login = ${login.trim().toLowerCase()}`;
  if (!a || !a.active) {
    await scrypt(password, Buffer.alloc(16), 32);
    throw generic;
  }
  if (a.locked_until && a.locked_until > new Date())
    throw new BusinessError(`Zu viele Fehlversuche – bitte in ${LOCK_MINUTES} Minuten erneut versuchen`);
  if (!(await verify(password, a.password_hash))) {
    await sql`update app.user_accounts set failed_attempts = failed_attempts + 1,
                locked_until = case when failed_attempts + 1 >= ${MAX_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) end
              where id = ${a.id}`;
    throw generic;
  }
  await sql`update app.user_accounts set failed_attempts = 0, locked_until = null, last_login_at = now() where id = ${a.id}`;
  return (await getUser(sql, a.id))!;
}

/** Benutzername aus APP_BASIC_AUTH: klein, Leerzeichen → Punkt, nur erlaubte Zeichen („Ahmed Chomontek“ → „ahmed.chomontek“). */
export function bootstrapLogin(raw: string): string {
  const login = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._@-]/g, '');
  if (!/^[a-z0-9._@-]{3,64}$/.test(login))
    throw new Error(`APP_BASIC_AUTH: Benutzername „${raw}“ ungültig (3–64 Zeichen, z. B. ahmed)`);
  return login;
}

/** Erster Start: Admin aus APP_BASIC_AUTH anlegen (Passwort danach unter „Mein Konto“ ändern). */
export async function ensureBootstrapAdmin(sql: Sql, basicAuth: string) {
  if (await hasActiveAdmin(sql)) return false;
  const [rawLogin, ...pw] = basicAuth.split(':');
  const password = pw.join(':');
  const login = bootstrapLogin(rawLogin ?? '');
  const raw = (rawLogin ?? '').trim();
  const displayName = raw.charAt(0).toUpperCase() + raw.slice(1);
  const id = randomUUID();
  const h = await hash(password);
  let created = false;
  await ensureAuthUser(sql, id, null);
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('bootstrap-admin'))`;
    if (await hasActiveAdmin(tx as unknown as Sql)) return;
    const [taken] = await tx`select 1 from app.user_accounts where login = ${login}`;
    if (taken)
      throw new Error(
        `Kein aktiver Admin vorhanden und Benutzername „${login}“ ist belegt – bitte in der Datenbank prüfen`,
      );
    await tx`insert into app.profiles (user_id, display_name, role) values (${id}, ${displayName}, 'admin')`;
    await tx`insert into app.user_accounts (id, login, password_hash, must_change_password, created_by)
             values (${id}, ${login}, ${h}, false, 'system')`;
    created = true;
  });
  return created;
}

async function hasActiveAdmin(sql: Sql) {
  const [r] = await sql`
    select 1 from app.user_accounts a join app.profiles p on p.user_id = a.id where p.role = 'admin' and a.active limit 1`;
  return !!r;
}

/** Objekte, die eine Objektleitung sehen darf (null = alle). */
export async function managedSites(sql: Sql, user: Pick<User, 'id' | 'role'>): Promise<string[] | null> {
  if (user.role !== 'objektleitung') return null;
  const rows = await sql<{ id: string }[]>`select id from app.sites where manager_user_id = ${user.id}`;
  return rows.map((r) => r.id);
}

/** Anzeigename: voller Name statt Benutzername (aus „ahmed.chomontek“ wird „Ahmed Chomontek“). */
export function fullName(u: { name?: string | null; login: string }): string {
  const n = (u.name ?? '').trim();
  if (n && n.toLowerCase() !== u.login.toLowerCase()) return n;
  return (n || u.login)
    .split(/[._\s-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Mitarbeiter-Datensatz zum Benutzerkonto (eigene Zeiterfassung für Büro/Objektleitung): fest verknüpft
 * (Einstellungen → Benutzer) oder – solange nichts verknüpft ist – genau ein aktiver Mitarbeiter mit gleichem Namen.
 */
export async function linkedEmployee(sql: Sql, userId: string): Promise<string | null> {
  const [r] = await sql<{ id: string | null }[]>`
    select coalesce(p.employee_id,
                    (select min(e.id::text)::uuid from app.employees e
                      where e.status = 'aktiv'
                        and lower(e.first_name || ' ' || e.last_name) = lower(p.display_name)
                     having count(*) = 1)) as id
      from app.profiles p where p.user_id = ${userId}`;
  return r?.id ?? null;
}

/** Benutzer ↔ Mitarbeiter verknüpfen (jeder Mitarbeiter höchstens einem Benutzer). */
export async function saveEmployeeLink(sql: Sql, userId: string, employeeId: string | null, actor: string) {
  const [cur] = await sql<{ employee_id: string | null }[]>`
    select employee_id from app.profiles where user_id = ${userId}`;
  if ((cur?.employee_id ?? null) === employeeId) return;
  if (employeeId) {
    const [other] = await sql<{ display_name: string }[]>`
      select display_name from app.profiles where employee_id = ${employeeId} and user_id <> ${userId}`;
    if (other) throw new BusinessError(`Dieser Mitarbeiter ist schon mit ${other.display_name} verknüpft.`);
  }
  await sql`update app.profiles set employee_id = ${employeeId} where user_id = ${userId}`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'employee_link', 'user', ${userId}, ${sql.json({ employee_id: employeeId })})`;
}
