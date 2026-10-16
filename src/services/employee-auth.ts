import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Anmeldung der Mitarbeitenden in der Handy-Ansicht: Personalnummer + PIN (4–6 Ziffern).
 * PIN nur als scrypt-Hash, nach 5 Fehlversuchen 15 Minuten gesperrt. Sitzung als signiertes Cookie
 * (HMAC-SHA256), kein Zugriff auf Büro-Funktionen.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const MAX_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const SESSION_DAYS = 14;

const TRIVIAL = new Set([
  '0000',
  '1111',
  '1234',
  '12345',
  '123456',
  '4321',
  '2222',
  '9999',
  '000000',
  '111111',
]);

export function checkPinRules(pin: string) {
  if (!/^\d{4,6}$/.test(pin)) throw new BusinessError('PIN muss aus 4 bis 6 Ziffern bestehen');
  if (TRIVIAL.has(pin) || /^(\d)\1+$/.test(pin))
    throw new BusinessError('PIN ist zu einfach (z. B. 1234 oder 0000)');
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

export async function verifyHash(pin: string, stored: string): Promise<boolean> {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = await scrypt(pin, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}

/** Standard-PIN aus dem Geburtsdatum: TTMMJJ (15.03.1985 → 150385). */
export function birthPin(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `${d}${m}${y!.slice(2)}`;
}

/** Büro setzt/ändert die PIN (z. B. beim Einstellen oder wenn vergessen). Entsperrt zugleich. */
export async function setPin(sql: Sql, employeeId: string, pin: string, actor: string) {
  checkPinRules(pin);
  const hash = await hashPin(pin);
  await sql`
    insert into app.employee_pins (employee_id, pin_hash, set_by) values (${employeeId}, ${hash}, ${actor})
    on conflict (employee_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null,
      set_at = now(), set_by = excluded.set_by, must_change = false`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, 'set_pin', 'employee', ${employeeId})`;
}

/** Muss die Person zuerst eine eigene PIN festlegen? (Anmeldung mit dem Geburtsdatum) */
export async function pinMustChange(sql: Sql, employeeId: string) {
  const [r] = await sql<{ must_change: boolean }[]>`
    select must_change from app.employee_pins where employee_id = ${employeeId}`;
  return !!r?.must_change;
}

/** Mitarbeitende legen ihre eigene PIN fest (nicht das Geburtsdatum, keine einfache Folge). */
export async function changeOwnPin(sql: Sql, employeeId: string, pin: string, repeat: string) {
  checkPinRules(pin);
  if (pin !== repeat) throw new BusinessError('Die beiden PINs stimmen nicht überein');
  const [e] = await sql<{ birth_date: string | null }[]>`
    select birth_date::text from app.employee_private where employee_id = ${employeeId}`;
  if (e?.birth_date && pin === birthPin(e.birth_date))
    throw new BusinessError('Bitte nicht das Geburtsdatum als PIN verwenden');
  const hash = await hashPin(pin);
  await sql`
    insert into app.employee_pins (employee_id, pin_hash, set_by) values (${employeeId}, ${hash}, 'selbst')
    on conflict (employee_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null,
      set_at = now(), set_by = 'selbst', must_change = false`;
  await sql`insert into app.audit_log (actor, action, entity, entity_id)
            values ('mitarbeiter', 'set_own_pin', 'employee', ${employeeId})`;
}

export async function hasPin(sql: Sql, employeeId: string) {
  const [r] = await sql<{ locked_until: Date | null; failed_attempts: number }[]>`
    select locked_until, failed_attempts from app.employee_pins where employee_id = ${employeeId}`;
  return r ? { locked: !!r.locked_until && r.locked_until > new Date(), failed: r.failed_attempts } : null;
}

/** Prüft Personalnummer + PIN. Gleiche Fehlermeldung für „unbekannt“ und „falsch“ (kein Ausprobieren von Nummern). */
export async function login(
  sql: Sql,
  personnelNo: string,
  pin: string,
): Promise<{ id: string; language: string; name: string; mustChange: boolean }> {
  const generic = new BusinessError('Personalnummer oder PIN falsch');
  const [e] = await sql<
    {
      id: string;
      status: string;
      app_language: string;
      first_name: string;
      pin_hash: string | null;
      failed_attempts: number | null;
      locked_until: Date | null;
      birth_date: string | null;
    }[]
  >`
    select e.id, e.status, e.app_language, e.first_name, p.pin_hash, p.failed_attempts, p.locked_until,
           ep.birth_date::text
      from app.employees e left join app.employee_pins p on p.employee_id = e.id
      left join app.employee_private ep on ep.employee_id = e.id
     where e.personnel_no = ${personnelNo.trim()}`;
  // Ohne eigene PIN gilt das Geburtsdatum TTMMJJ (Ahmed 07.10.). Wird beim ersten Versuch als PIN hinterlegt –
  // damit greifen Fehlversuchszähler und Sperre wie bei einer gesetzten PIN.
  if (e && !e.pin_hash && e.birth_date && e.status === 'aktiv') {
    const pinFromBirth = birthPin(e.birth_date);
    const hash = await hashPin(pinFromBirth);
    await sql`
      insert into app.employee_pins (employee_id, pin_hash, set_by, must_change)
      values (${e.id}, ${hash}, 'Geburtsdatum (automatisch)', true)
      on conflict (employee_id) do nothing`;
    const [p] = await sql<{ pin_hash: string; failed_attempts: number; locked_until: Date | null }[]>`
      select pin_hash, failed_attempts, locked_until from app.employee_pins where employee_id = ${e.id}`;
    if (p) Object.assign(e, p);
  }
  if (!e || !e.pin_hash || e.status !== 'aktiv') {
    await scrypt(pin, Buffer.alloc(16), 32); // gleiche Antwortzeit
    throw generic;
  }
  if (e.locked_until && e.locked_until > new Date()) {
    throw new BusinessError(
      `Zu viele Fehlversuche – bitte in ${LOCK_MINUTES} Minuten erneut versuchen oder im Büro melden`,
    );
  }
  if (!(await verifyHash(pin, e.pin_hash))) {
    await sql`
      update app.employee_pins set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= ${MAX_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) end
       where employee_id = ${e.id}`;
    throw generic;
  }
  // Mit dem Geburtsdatum angemeldet → eigene PIN festlegen (kennen Kolleginnen und Kollegen sonst; Ahmed 17.10.)
  const viaBirth = !!e.birth_date && pin === birthPin(e.birth_date);
  const [r] = await sql<{ must_change: boolean }[]>`
    update app.employee_pins set failed_attempts = 0, locked_until = null, must_change = must_change or ${viaBirth}
     where employee_id = ${e.id} returning must_change`;
  return { id: e.id, language: e.app_language, name: e.first_name, mustChange: !!r?.must_change };
}

// ---------------------------------------------------------------- Sitzung (Cookie)

export function signSession(
  secret: string,
  employeeId: string,
  now = Date.now(),
  days = SESSION_DAYS,
): string {
  const exp = Math.floor(now / 1000) + Math.round(days * 86400);
  const payload = `${employeeId}.${exp}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) * 1000 < now) return null;
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
