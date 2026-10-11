import webpush from 'web-push';
import type { Env } from '../config/env.js';
import type { Sql } from '../db/client.js';
import { decryptKey, encryptKey } from './bank-feed.js';
import { BusinessError } from './errors.js';

/*
 * Push-Nachrichten aufs Handy (Web Push, Ahmed 11.10.: „wichtig“). Funktioniert ohne Firebase direkt mit der
 * installierten App: Android (Chrome) immer, iPhone ab iOS 16.4, wenn die App über „Zum Home-Bildschirm“ installiert
 * ist. Die Person muss Benachrichtigungen einmal erlauben (Knopf in der App). Inhalte bewusst knapp – keine
 * Gesundheitsdaten oder Beträge in der Nachricht, sie erscheint auf dem Sperrbildschirm.
 */

type KeyEnv = Pick<Env, 'SESSION_SECRET' | 'APP_BASIC_AUTH'>;
let cached: { publicKey: string; privateKey: string } | null = null;

export async function vapidKeys(sql: Sql, env: KeyEnv) {
  if (cached) return cached;
  const [row] = await sql<{ public_key: string; private_key_enc: string }[]>`
    select public_key, private_key_enc from app.push_config where id = 1`;
  if (row) {
    cached = { publicKey: row.public_key, privateKey: decryptKey(env, row.private_key_enc) };
    return cached;
  }
  const k = webpush.generateVAPIDKeys();
  await sql`insert into app.push_config (id, public_key, private_key_enc)
            values (1, ${k.publicKey}, ${encryptKey(env, k.privateKey)}) on conflict (id) do nothing`;
  cached = null;
  return vapidKeys(sql, env);
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function savePushSubscription(
  sql: Sql,
  sub: unknown,
  who: { employeeId?: string | null; userId?: string | null },
  userAgent: string | null,
) {
  const s = sub as Partial<PushSub>;
  if (
    !s ||
    typeof s.endpoint !== 'string' ||
    !/^https:\/\//.test(s.endpoint) ||
    s.endpoint.length > 2000 ||
    typeof s.keys?.p256dh !== 'string' ||
    typeof s.keys?.auth !== 'string'
  )
    throw new BusinessError('Ungültiges Push-Abo');
  if (!who.employeeId && !who.userId) throw new BusinessError('Nicht angemeldet');
  await sql`
    insert into app.push_subscriptions (endpoint, p256dh, auth, employee_id, user_id, user_agent)
    values (${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth}, ${who.employeeId ?? null}, ${who.userId ?? null},
            ${userAgent?.slice(0, 300) ?? null})
    on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
      employee_id = coalesce(excluded.employee_id, push_subscriptions.employee_id),
      user_id = coalesce(excluded.user_id, push_subscriptions.user_id), user_agent = excluded.user_agent,
      failures = 0`;
}

export async function deletePushSubscription(sql: Sql, endpoint: string) {
  await sql`delete from app.push_subscriptions where endpoint = ${endpoint}`;
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Sendet an alle Geräte der Personen. `once`: Schlüssel, unter dem die Nachricht nur einmal geht. */
export async function sendPush(
  sql: Sql,
  env: KeyEnv & Pick<Env, 'APP_ENV'>,
  to: { employeeIds?: string[]; userIds?: string[] },
  msg: PushMessage,
  once?: string,
) {
  const emp = to.employeeIds?.filter(Boolean) ?? [];
  const usr = to.userIds?.filter(Boolean) ?? [];
  if (!emp.length && !usr.length) return 0;
  if (once) {
    const [fresh] =
      await sql`insert into app.push_sent (key) values (${once}) on conflict do nothing returning key`;
    if (!fresh) return 0;
  }
  const subs = await sql<{ endpoint: string; p256dh: string; auth: string }[]>`
    select endpoint, p256dh, auth from app.push_subscriptions
     where (employee_id = any(${emp}::uuid[]) or user_id = any(${usr}::uuid[])) and failures < 5`;
  if (!subs.length) return 0;
  const keys = await vapidKeys(sql, env);
  const [co] = await sql<{ email: string | null }[]>`select email from app.company limit 1`;
  const subject = `mailto:${co?.email || 'info@viva-deluxe-reinigung.de'}`;
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url ?? '/app', tag: msg.tag });
  let ok = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          {
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: 12 * 3600,
            timeout: 10_000,
          },
        );
        ok++;
        await sql`update app.push_subscriptions set last_ok_at = now(), failures = 0 where endpoint = ${s.endpoint}`;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: Abo gibt es nicht mehr (App gelöscht, Erlaubnis entzogen)
        if (code === 404 || code === 410) await deletePushSubscription(sql, s.endpoint);
        else
          await sql`update app.push_subscriptions set failures = failures + 1 where endpoint = ${s.endpoint}`;
      }
    }),
  );
  return ok;
}

/** Fehler beim Senden dürfen den eigentlichen Vorgang nie stören. */
export function pushLater(p: Promise<unknown>) {
  p.catch((e: unknown) => console.error('Push fehlgeschlagen:', e instanceof Error ? e.message : e));
}

/** Büro-Benutzer, die eine Nachricht zu einem Objekt bekommen: Objektleitung des Objekts + Admin/Personal. */
export async function officeRecipients(sql: Sql, siteIds: string[]) {
  const rows = await sql<{ id: string }[]>`
    select a.id from app.user_accounts a join app.profiles p on p.user_id = a.id
     where a.active and (p.role in ('admin', 'personal')
        or a.id in (select manager_user_id from app.sites where id = any(${siteIds}::uuid[])))`;
  return rows.map((r) => r.id);
}

/** Pausen-Hinweis (§ 4 ArbZG): laufende Stempelung seit 5:50 Std. → einmal „nach 6 Std. Pause Pflicht“. */
export async function pushBreakReminders(sql: Sql, env: KeyEnv & Pick<Env, 'APP_ENV'>) {
  const rows = await sql<{ id: string; employee_id: string }[]>`
    select t.id, t.employee_id from app.time_entries t
     where t.end_at is null and t.status <> 'abgelehnt'
       and t.start_at <= now() - interval '350 minutes' and t.start_at > now() - interval '8 hours'
       and exists (select 1 from app.push_subscriptions s where s.employee_id = t.employee_id)
       and not exists (select 1 from app.push_sent p where p.key = 'pause:' || t.id)`;
  for (const r of rows)
    await sendPush(
      sql,
      env,
      { employeeIds: [r.employee_id] },
      {
        title: 'Pause nicht vergessen',
        body: 'Du arbeitest seit fast 6 Stunden. Ab 6 Stunden sind 30 Minuten Pause Pflicht.',
        url: '/m',
        tag: 'pause',
      },
      `pause:${r.id}`,
    );
  return rows.length;
}

const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
const hm = (t: string) => t.slice(0, 5);

/**
 * Benachrichtigungen aus dem laufenden Betrieb, jede Minute geprüft (nur Neues der letzten 30 Minuten, jede Nachricht
 * genau einmal über `push_sent`): Dokument zum Unterschreiben, Einsatzplan/Vertretung (Mitarbeitende), Urlaubs- und
 * Nachtragsanträge (Objektleitung des Objekts + Admin/Personal), Entscheidung über den eigenen Antrag, Pausen-Hinweis.
 */
export async function runPushNotifier(sql: Sql, env: KeyEnv & Pick<Env, 'APP_ENV'>) {
  const [any] = await sql`select 1 from app.push_subscriptions limit 1`;
  if (!any) return;
  const win = sql`now() - interval '30 minutes'`;

  for (const r of await sql<{ id: string; employee_id: string; title: string }[]>`
    select r.id, r.employee_id, d.title from app.sign_requests r join app.sign_documents d on d.id = r.document_id
     where r.status = 'offen' and r.created_at > ${win}`)
    await sendPush(
      sql,
      env,
      { employeeIds: [r.employee_id] },
      { title: 'Neues Dokument zum Unterschreiben', body: r.title, url: '/m/dokumente', tag: `sign-${r.id}` },
      `sign:${r.id}`,
    );

  // Einsatzplan: neu oder geändert, noch gültig – je Person eine Nachricht
  const plans = await sql<
    {
      id: string;
      version: number;
      employee_id: string;
      weekday: number;
      start_time: string;
      end_time: string;
      valid_from: string;
      site: string;
    }[]
  >`
    select p.id, p.version, p.employee_id, p.weekday, p.start_time::text, p.end_time::text, p.valid_from::text, s.name as site
      from app.shift_plans p join app.sites s on s.id = p.site_id
     where p.employee_id is not null and (p.created_at > ${win} or p.updated_at > ${win})
       and (p.valid_until is null or p.valid_until >= (now() at time zone 'Europe/Berlin')::date)
       and not exists (select 1 from app.push_sent x where x.key = 'shift:' || p.id || ':' || p.version)`;
  type Plan = (typeof plans)[number];
  const byEmp = new Map<string, Plan[]>();
  for (const p of plans) byEmp.set(p.employee_id, [...(byEmp.get(p.employee_id) ?? []), p]);
  for (const [emp, list] of byEmp) {
    for (const p of list)
      await sql`insert into app.push_sent (key) values (${`shift:${p.id}:${p.version}`}) on conflict do nothing`;
    const f = list[0]!;
    const days = [...new Set(list.filter((x) => x.site === f.site).map((x) => x.weekday))]
      .sort()
      .map((d) => WD[d]);
    await sendPush(
      sql,
      env,
      { employeeIds: [emp] },
      {
        title: 'Einsatzplan geändert',
        body: `${f.site}: ${days.join(', ')} ${hm(f.start_time)}–${hm(f.end_time)} ab ${dm(f.valid_from)}${
          list.some((x) => x.site !== f.site) ? ' und weitere' : ''
        }`,
        url: '/m/kalender',
        tag: 'plan',
      },
    );
  }

  for (const x of await sql<
    { id: string; emp: string; work_date: string; start_time: string; end_time: string; site: string }[]
  >`
    select e.id, e.substitute_employee_id as emp, e.work_date::text, coalesce(e.start_time, p.start_time)::text as start_time,
           coalesce(e.end_time, p.end_time)::text as end_time, s.name as site
      from app.shift_exceptions e join app.shift_plans p on p.id = e.shift_plan_id join app.sites s on s.id = p.site_id
     where e.substitute_employee_id is not null and e.created_at > ${win}`)
    await sendPush(
      sql,
      env,
      { employeeIds: [x.emp] },
      {
        title: 'Vertretung',
        body: `${dm(x.work_date)} ${hm(x.start_time)}–${hm(x.end_time)}: ${x.site}`,
        url: '/m/kalender',
        tag: `vt-${x.id}`,
      },
      `vertretung:${x.id}`,
    );

  // Anträge aus der App ans Büro / die Objektleitung (ohne Art der Abwesenheit – Sperrbildschirm)
  for (const a of await sql<
    { id: string; name: string; start_date: string; end_date: string; sites: string[] }[]
  >`
    select a.id, e.first_name || ' ' || e.last_name as name, a.start_date::text, a.end_date::text,
           coalesce((select array_agg(es.site_id) from app.employee_sites es where es.employee_id = a.employee_id), '{}') as sites
      from app.absences a join app.employees e on e.id = a.employee_id
     where a.status = 'beantragt' and a.requested_at > ${win}`)
    await sendPush(
      sql,
      env,
      { userIds: await officeRecipients(sql, a.sites) },
      {
        title: 'Neuer Antrag',
        body: `${a.name}: ${dm(a.start_date)}–${dm(a.end_date)}`,
        url: '/qm/team',
        tag: `abs-${a.id}`,
      },
      `absreq:${a.id}`,
    );
  for (const t of await sql<{ id: string; name: string; work_date: string; site_id: string }[]>`
    select t.id, e.first_name || ' ' || e.last_name as name, t.work_date::text, t.site_id
      from app.time_entries t join app.employees e on e.id = t.employee_id
     where t.status = 'beantragt' and t.recorded_at > ${win}`)
    await sendPush(
      sql,
      env,
      { userIds: await officeRecipients(sql, [t.site_id]) },
      {
        title: 'Nachtrag zur Freigabe',
        body: `${t.name}, ${dm(t.work_date)}`,
        url: '/qm/zeiten',
        tag: `nt-${t.id}`,
      },
      `nachtrag:${t.id}`,
    );

  // Entscheidung über den eigenen Antrag (nur echte Anträge, nicht sofort im Büro eingetragene)
  for (const a of await sql<
    { id: string; employee_id: string; status: string; start_date: string; end_date: string }[]
  >`
    select id, employee_id, status::text, start_date::text, end_date::text from app.absences
     where status in ('genehmigt', 'abgelehnt') and decided_at > ${win}
       and requested_at is not null and decided_at > requested_at + interval '1 minute'`)
    await sendPush(
      sql,
      env,
      { employeeIds: [a.employee_id] },
      {
        title: a.status === 'genehmigt' ? 'Antrag genehmigt' : 'Antrag abgelehnt',
        body: `${dm(a.start_date)}–${dm(a.end_date)}`,
        url: '/m/abwesenheit',
        tag: `absdec-${a.id}`,
      },
      `absdec:${a.id}`,
    );

  await pushBreakReminders(sql, env);
}
