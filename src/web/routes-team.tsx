import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { TEAM_DOC_CATEGORIES } from '../services/employees.js';
import { employeesOfSites } from '../services/first-aid.js';
import { missingDocs } from '../services/hr-required-docs.js';
import { listFiles } from '../services/uploads.js';
import type { AppEnv, Ctx } from './app.js';
import { UUID } from './app.js';
import { FileArea } from './files.js';
import { uploadConfig } from './routes-files.js';
import { PageHead, dateDe } from './layout.js';

/*
 * Mein Team (Ahmed 19.10.: „Objektleiter brauchen vereinfacht die Personalübersicht, Personalunterlagen und die Suche“):
 * Mitarbeitende, die an den Objekten der Objektleitung eingesetzt sind (zugeordnet oder im letzten Jahr/künftig
 * eingeplant) – Kontakt, Objekte, Einsätze, fehlende Unterlagen und ausgewählte Unterlagen der Personalakte
 * (TEAM_DOC_CATEGORIES, ohne Vertrag/Lohn). Keine Steuer-ID, SV-Nummer, IBAN, Vergütung.
 */

const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function registerTeamRoutes(ctx: Ctx) {
  const { app, deps, page } = ctx;
  const { sql } = deps;
  const cfg = uploadConfig(ctx);
  const scope = (c: Context<AppEnv>) => c.get('sites') ?? null;

  const members = async (c: Context<AppEnv>, q: string) => {
    const ids = (await employeesOfSites(sql, scope(c))).map((e) => e.id);
    if (!ids.length) return [];
    const like = `%${q.trim()}%`;
    const sites = scope(c);
    return sql<
      {
        id: string;
        personnel_no: string;
        name: string;
        mobile: string | null;
        phone: string | null;
        email: string | null;
        employment_type: string | null;
        sites: string[] | null;
      }[]
    >`
      select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, e.mobile, e.phone, e.email,
             e.employment_type::text as employment_type,
             (select array_agg(distinct s.name order by s.name) from app.shift_plans p join app.sites s on s.id = p.site_id
               where p.employee_id = e.id and (p.valid_until is null or p.valid_until >= current_date)
                 and ${sites ? sql`p.site_id = any(${sites}::uuid[])` : sql`true`}) as sites
        from app.employees e
       where e.id = any(${ids}::uuid[])
         and ${q.trim() ? sql`(e.first_name || ' ' || e.last_name || ' ' || e.personnel_no || ' ' || coalesce(e.mobile, '') || ' ' || coalesce(e.phone, '')) ilike ${like}` : sql`true`}
       order by e.last_name, e.first_name`;
  };

  app.get('/team', async (c) => {
    const q = c.req.query('q') ?? '';
    const [list, missing] = await Promise.all([
      members(c, q),
      missingDocs(sql, { siteIds: scope(c), limited: true }),
    ]);
    const miss = new Map(missing.map((m) => [m.employee_id, m.missing]));
    return page(
      c,
      'Mein Team',
      'personal',
      <>
        <PageHead title="Mein Team">
          <a class="btn sec" href="/personal/unterlagen">
            Fehlende Unterlagen
          </a>
        </PageHead>
        <form method="get" class="row" style="gap:8px;margin:8px 0 12px">
          <input
            name="q"
            value={q}
            placeholder="Name, Personalnummer oder Telefon …"
            aria-label="Suche"
            style="min-width:280px"
            autofocus
          />
          <button class="btn sec">Suchen</button>
          {q && (
            <a class="btn ghost" href="/team">
              Suche aufheben
            </a>
          )}
        </form>
        {list.length === 0 ? (
          <p class="empty">Keine Mitarbeitenden gefunden.</p>
        ) : (
          <div class="tbl-wrap">
            <table class="list">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Telefon</th>
                  <th>Objekte</th>
                  <th>Unterlagen</th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => {
                  const tel = m.mobile || m.phone;
                  const mi = miss.get(m.id) ?? [];
                  return (
                    <tr>
                      <td data-l="Name">
                        <a href={`/team/${m.id}`}>
                          <b>{m.name}</b>
                        </a>{' '}
                        <span class="mut small">Nr. {m.personnel_no}</span>
                        {m.employment_type && <div class="mut small">{m.employment_type}</div>}
                      </td>
                      <td data-l="Telefon">
                        {tel ? <a href={`tel:${tel.replace(/[^\d+]/g, '')}`}>{tel}</a> : '–'}
                      </td>
                      <td data-l="Objekte" class="small">
                        {m.sites?.join(', ') || '–'}
                      </td>
                      <td data-l="Unterlagen">
                        {mi.length ? (
                          <a class="badge err" href={`/team/${m.id}#unterlagen`} title={mi.join(', ')}>
                            {mi.length} fehlt
                          </a>
                        ) : (
                          <span class="badge ok">vollständig</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p class="mut small">
          {list.length} Mitarbeitende an Ihren Objekten. Steuer-ID, SV-Nummer, Bankdaten, Vergütung und
          Verträge verwaltet das Büro.
        </p>
      </>,
    );
  });

  app.get(`/team/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [m] = (await members(c, '')).filter((x) => x.id === id);
    if (!m) return page(c, 'Mein Team', 'personal', <p class="empty">Nicht in Ihrem Team.</p>, 404);
    const today = todayBerlin();
    const sites = scope(c);
    const kat = c.req.query('kategorie');
    const category = kat && TEAM_DOC_CATEGORIES.includes(kat) ? kat : 'Personalunterlagen';
    const [plans, absences, files, missing] = await Promise.all([
      sql<{ weekday: number; start_time: string; end_time: string; site_name: string; site_no: string }[]>`
        select p.weekday, to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time,
               s.name as site_name, s.site_no
          from app.shift_plans p join app.sites s on s.id = p.site_id
         where p.employee_id = ${id} and p.valid_from <= ${addDays(today, 14)}
           and (p.valid_until is null or p.valid_until >= ${today})
           and ${sites ? sql`p.site_id = any(${sites}::uuid[])` : sql`true`}
         order by p.weekday, p.start_time`,
      sql<{ kind: string; start_date: string; end_date: string }[]>`
        select kind::text, start_date::text, end_date::text from app.absences
         where employee_id = ${id} and status = 'genehmigt' and end_date >= ${today}
         order by start_date limit 5`,
      listFiles(sql, { type: 'employee', id }),
      missingDocs(sql, { siteIds: sites, limited: true }),
    ]);
    const docs = files.filter(
      (f) => !f.archived_at && f.category && TEAM_DOC_CATEGORIES.includes(f.category),
    );
    const mi = missing.find((x) => x.employee_id === id)?.missing ?? [];
    const tel = m.mobile || m.phone;
    return page(
      c,
      m.name,
      'personal',
      <>
        <PageHead title={m.name} no={m.personnel_no}>
          <a class="btn sec" href="/team">
            ← Mein Team
          </a>
        </PageHead>
        <div class="cols">
          <div>
            <section class="card">
              <h3 style="margin-top:0">Kontakt</h3>
              <p>
                {tel ? <a href={`tel:${tel.replace(/[^\d+]/g, '')}`}>{tel}</a> : 'kein Telefon hinterlegt'}
                {m.email && (
                  <>
                    <br />
                    <a href={`mailto:${m.email}`}>{m.email}</a>
                  </>
                )}
              </p>
              {m.employment_type && <p class="mut small">{m.employment_type}</p>}
            </section>
            <section class="card">
              <h3 style="margin-top:0">Einsätze an Ihren Objekten</h3>
              {plans.length ? (
                <ul class="calm-list">
                  {plans.map((p) => (
                    <li>
                      {WD[p.weekday]} {p.start_time}–{p.end_time} · {p.site_no} {p.site_name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="mut">Keine laufenden Einsätze.</p>
              )}
              {absences.length > 0 && (
                <p class="small">
                  Abwesend:{' '}
                  {absences
                    .map(
                      (a) =>
                        `${a.kind === 'urlaub' ? 'Urlaub' : a.kind.startsWith('krank') ? 'krank' : 'abwesend'} ${dateDe(a.start_date)}${a.end_date !== a.start_date ? `–${dateDe(a.end_date)}` : ''}`,
                    )
                    .join(' · ')}
                </p>
              )}
            </section>
          </div>
          <div>
            <section class="card" id="unterlagen">
              <h3 style="margin-top:0">Unterlagen</h3>
              {mi.length > 0 && (
                <p>
                  {mi.map((x) => (
                    <span class="badge err" style="margin:0 4px 4px 0">
                      {x}
                    </span>
                  ))}
                </p>
              )}
              <form method="get" class="row" style="gap:8px;align-items:center;margin-bottom:8px">
                <label for="tm-kat" class="small">
                  Hochladen als
                </label>
                <select id="tm-kat" name="kategorie" data-nosearch onchange="this.form.submit()">
                  {TEAM_DOC_CATEGORIES.map((k) => (
                    <option value={k} selected={k === category}>
                      {k}
                    </option>
                  ))}
                </select>
              </form>
              <FileArea
                link={{ type: 'employee', id }}
                files={docs}
                category={category}
                title={`${category} hierher ziehen`}
                maxBytes={cfg.maxBytes}
              />
              <p class="mut small">
                Sichtbar: {TEAM_DOC_CATEGORIES.join(', ')}. Verträge und Lohnunterlagen nur im Büro.
              </p>
            </section>
          </div>
        </div>
      </>,
    );
  });
}
