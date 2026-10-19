import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { randomUUID } from 'node:crypto';
import {
  type FirstAidEntry,
  FIRST_AID_KEEP_YEARS,
  deleteFirstAid,
  employeesOfSites,
  getFirstAid,
  listFirstAid,
  saveFirstAid,
} from '../services/first-aid.js';
import { BusinessError } from '../services/errors.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';
import { SiteOptions, type SiteOpt } from './site-options.js';

/*
 * Verbandbuch (Ahmed 19.10.): Einträge je Mitarbeiter. Büro (Admin/Personal) über Personal → Verbandbuch und beim
 * Mitarbeiter (Reiter unter „Mehr“), Objektleitung über Personal → Verbandbuch nur für ihre Objekte.
 */

const when = (d: Date) =>
  d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const local = (d: Date) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(d)
    .replace(' ', 'T');

const Hint = () => (
  <p class="mut small">
    Jede Erste-Hilfe-Leistung wird eingetragen (DGUV Vorschrift 1 § 24 Abs. 6) und {FIRST_AID_KEEP_YEARS}{' '}
    Jahre aufbewahrt. Die Einträge enthalten Gesundheitsdaten – nur sachlich, keine Diagnosen. Bei mehr als 3
    Tagen Arbeitsunfähigkeit: Unfallanzeige an die BG (§ 193 SGB VII) über das Büro.
  </p>
);

const EntryList: FC<{ rows: FirstAidEntry[]; showEmployee: boolean; base: string }> = ({
  rows,
  showEmployee,
  base,
}) =>
  rows.length ? (
    <div class="tbl-wrap">
      <table class="list">
        <thead>
          <tr>
            <th>Datum</th>
            {showEmployee && <th>Mitarbeiter</th>}
            <th>Objekt / Ort</th>
            <th>Hergang</th>
            <th>Verletzung</th>
            <th>Erste Hilfe</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td data-l="Datum">{when(r.occurred_at)}</td>
              {showEmployee && (
                <td data-l="Mitarbeiter">
                  {r.employee_name} <span class="mut small">{r.personnel_no}</span>
                </td>
              )}
              <td data-l="Objekt / Ort">
                {r.site_name ? `${r.site_no} · ${r.site_name}` : '–'}
                {r.place && <div class="mut small">{r.place}</div>}
              </td>
              <td data-l="Hergang" style="white-space:pre-line">
                {r.what_happened}
              </td>
              <td data-l="Verletzung" style="white-space:pre-line">
                {r.injury}
                {r.doctor && <div class="badge">Arzt aufgesucht</div>}
                {r.lost_days && <div class="badge err">Ausfall &gt; 3 Tage</div>}
              </td>
              <td data-l="Erste Hilfe" style="white-space:pre-line">
                {r.measures}
                {r.first_aider && <div class="mut small">durch {r.first_aider}</div>}
              </td>
              <td>
                <a class="btn sm sec" href={`/verbandbuch/${r.id}?zurueck=${encodeURIComponent(base)}`}>
                  Bearbeiten
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p class="empty">Noch keine Einträge.</p>
  );

export function registerFirstAidRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql } = deps;
  const scope = (c: Context<AppEnv>) => c.get('sites') ?? null;
  const siteOpts = async (c: Context<AppEnv>) => {
    const ids = scope(c);
    return sql<SiteOpt[]>`
      select s.id, s.site_no, s.name, s.street, s.city, cu.name as customer_name
        from app.sites s join app.customers cu on cu.id = s.customer_id
       where s.active and ${ids ? sql`s.id = any(${ids}::uuid[])` : sql`true`}
       order by cu.name, s.site_no`;
  };
  const safeBack = (v: string | null | undefined, dflt: string) =>
    v && v.startsWith('/') && !v.startsWith('//') ? v : dflt;

  app.get('/verbandbuch', async (c) => {
    const ids = scope(c);
    const emp = c.req.query('mitarbeiter') ?? '';
    const year = Number(c.req.query('jahr')) || null;
    const q = c.req.query('q') ?? '';
    const [rows, emps] = await Promise.all([
      listFirstAid(sql, { siteIds: ids, employeeId: /^[0-9a-f-]{36}$/.test(emp) ? emp : null, year, q }),
      employeesOfSites(sql, ids),
    ]);
    const cur = new Date().getFullYear();
    return page(
      c,
      'Verbandbuch',
      'personal',
      <>
        <PageHead title="Verbandbuch">
          <a class="btn" href={`/verbandbuch/neu${emp ? `?mitarbeiter=${emp}` : ''}`}>
            + Eintrag
          </a>
        </PageHead>
        <Hint />
        <form method="get" class="row filters" style="gap:8px;flex-wrap:wrap;margin:8px 0">
          <select name="mitarbeiter" aria-label="Mitarbeiter">
            <option value="">alle Mitarbeitenden</option>
            {emps.map((e) => (
              <option value={e.id} selected={e.id === emp}>
                {e.name} ({e.personnel_no})
              </option>
            ))}
          </select>
          <select name="jahr" aria-label="Jahr" data-nosearch>
            <option value="">alle Jahre</option>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <option value={String(cur - i)} selected={year === cur - i}>
                {cur - i}
              </option>
            ))}
          </select>
          <input name="q" value={q} placeholder="Suche" aria-label="Suche" />
          <button class="btn sec">Anzeigen</button>
        </form>
        <EntryList rows={rows} showEmployee={true} base={c.req.url.replace(/^https?:\/\/[^/]+/, '')} />
      </>,
    );
  });

  // Beim Mitarbeiter (Büro) – Reiter unter „Mehr“
  app.get(`/personal/:id{${UUID}}/verbandbuch`, (c) =>
    shells.employee!(c, 'verbandbuch', async (e) => {
      const rows = await listFirstAid(sql, { employeeId: e.id });
      return (
        <section>
          <div class="row" style="justify-content:space-between;align-items:center">
            <h2 class="panel-title">Verbandbuch</h2>
            <a
              class="btn"
              href={`/verbandbuch/neu?mitarbeiter=${e.id}&zurueck=/personal/${e.id}/verbandbuch`}
            >
              + Eintrag
            </a>
          </div>
          <Hint />
          <EntryList rows={rows} showEmployee={false} base={`/personal/${e.id}/verbandbuch`} />
        </section>
      );
    }),
  );

  const form = async (c: Context<AppEnv>, r: FirstAidEntry | null) => {
    const [emps, sites] = await Promise.all([employeesOfSites(sql, scope(c)), siteOpts(c)]);
    const pre = r?.employee_id ?? c.req.query('mitarbeiter') ?? '';
    const ret = safeBack(c.req.query('zurueck'), '/verbandbuch');
    const isAdmin = c.get('user').role === 'admin';
    return page(
      c,
      r ? 'Verbandbuch-Eintrag' : 'Neuer Verbandbuch-Eintrag',
      'personal',
      <>
        <PageHead title={r ? 'Verbandbuch-Eintrag bearbeiten' : 'Neuer Verbandbuch-Eintrag'} />
        <form method="post" action={r ? `/verbandbuch/${r.id}` : '/verbandbuch/neu'} style="max-width:760px">
          <input type="hidden" name="id" value={r?.id ?? randomUUID()} />
          {r && <input type="hidden" name="version" value={String(r.version)} />}
          <input type="hidden" name="zurueck" value={ret} />
          <div class="grid">
            <label for="va-emp">Verletzte Person *</label>
            <select id="va-emp" name="employee_id" required>
              <option value="">– wählen –</option>
              {emps.map((e) => (
                <option value={e.id} selected={e.id === pre}>
                  {e.name} ({e.personnel_no})
                </option>
              ))}
              {r && !emps.some((e) => e.id === r.employee_id) && (
                <option value={r.employee_id} selected>
                  {r.employee_name} ({r.personnel_no})
                </option>
              )}
            </select>
            <label for="va-site">Objekt{scope(c) ? ' *' : ''}</label>
            <select id="va-site" name="site_id" required={!!scope(c)}>
              <option value="">– ohne Objekt –</option>
              <SiteOptions sites={sites} selected={r?.site_id ?? null} />
            </select>
            <label for="va-at">Datum und Uhrzeit *</label>
            <input
              id="va-at"
              type="datetime-local"
              name="occurred_at"
              required
              value={r ? local(r.occurred_at) : local(new Date())}
            />
            <label for="va-place">Ort (Raum, Bereich)</label>
            <input id="va-place" name="place" value={r?.place ?? ''} placeholder="z. B. Treppenhaus 2. OG" />
            <label for="va-what">Hergang *</label>
            <textarea id="va-what" name="what_happened" rows={3} required>
              {r?.what_happened ?? ''}
            </textarea>
            <label for="va-inj">Art und Umfang der Verletzung *</label>
            <textarea
              id="va-inj"
              name="injury"
              rows={2}
              required
              placeholder="z. B. Schnittwunde Finger links"
            >
              {r?.injury ?? ''}
            </textarea>
            <label for="va-meas">Erste-Hilfe-Maßnahmen *</label>
            <textarea
              id="va-meas"
              name="measures"
              rows={2}
              required
              placeholder="z. B. Wunde gereinigt, Pflaster"
            >
              {r?.measures ?? ''}
            </textarea>
            <label for="va-fa">Ersthelfer/in</label>
            <input id="va-fa" name="first_aider" value={r?.first_aider ?? ''} />
            <label for="va-wit">Zeugen</label>
            <input id="va-wit" name="witnesses" value={r?.witnesses ?? ''} />
            <span>Weiteres</span>
            <div>
              <label class="chk">
                <input type="checkbox" name="doctor" value="1" checked={!!r?.doctor} /> Arzt / Durchgangsarzt
                aufgesucht
              </label>
              <label class="chk">
                <input type="checkbox" name="lost_days" value="1" checked={!!r?.lost_days} /> Arbeitsunfähig
                mehr als 3 Tage (Unfallanzeige an die BG)
              </label>
            </div>
            <label for="va-note">Bemerkung</label>
            <textarea id="va-note" name="note" rows={2}>
              {r?.note ?? ''}
            </textarea>
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
            <a class="btn ghost" href={ret}>
              Abbrechen
            </a>
            {r && (
              <span class="mut small">
                angelegt von {r.created_by} am {when(r.created_at)}
                {r.updated_by && r.updated_at
                  ? ` · geändert von ${r.updated_by} am ${when(r.updated_at)}`
                  : ''}
              </span>
            )}
          </div>
        </form>
        {r && isAdmin && (
          <form
            method="post"
            action={`/verbandbuch/${r.id}/loeschen`}
            data-confirm="Eintrag wirklich löschen? Nur bei Falscheintrag – sonst 5 Jahre aufbewahren."
            style="margin-top:16px"
          >
            <input type="hidden" name="zurueck" value={ret} />
            <button class="btn sm danger">Eintrag löschen (Falscheintrag)</button>
          </form>
        )}
      </>,
    );
  };

  const load = async (c: Context<AppEnv>) => {
    const r = await getFirstAid(sql, c.req.param('id')!);
    const ids = scope(c);
    if (!r || (ids && (!r.site_id || !ids.includes(r.site_id))))
      throw new BusinessError('Eintrag nicht gefunden');
    return r;
  };

  app.get('/verbandbuch/neu', (c) => form(c, null));
  app.get(`/verbandbuch/:id{${UUID}}`, async (c) => form(c, await load(c)));

  const save = async (c: Context<AppEnv>, existing: FirstAidEntry | null) => {
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    const id = existing?.id ?? str(b, 'id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BusinessError('Formular ungültig – bitte neu laden');
    const ret = safeBack(str(b, 'zurueck'), '/verbandbuch');
    const emp = str(b, 'employee_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(emp)) throw new BusinessError('Bitte die verletzte Person wählen');
    const site = str(b, 'site_id');
    await saveFirstAid(
      sql,
      {
        id,
        employeeId: emp,
        siteId: site && /^[0-9a-f-]{36}$/.test(site) ? site : null,
        occurredAt: str(b, 'occurred_at') ?? '',
        place: str(b, 'place'),
        whatHappened: str(b, 'what_happened') ?? '',
        injury: str(b, 'injury') ?? '',
        measures: str(b, 'measures') ?? '',
        firstAider: str(b, 'first_aider'),
        witnesses: str(b, 'witnesses'),
        doctor: b.doctor === '1',
        lostDays: b.lost_days === '1',
        note: str(b, 'note'),
        version: existing ? Number(str(b, 'version')) || existing.version : null,
      },
      c.get('actor'),
      scope(c),
    );
    return back(c, ret, { ok: 'Verbandbuch-Eintrag gespeichert.' });
  };
  app.post('/verbandbuch/neu', (c) => save(c, null));
  app.post(`/verbandbuch/:id{${UUID}}`, async (c) => save(c, await load(c)));
  app.post(`/verbandbuch/:id{${UUID}}/loeschen`, async (c) => {
    if (c.get('user').role !== 'admin') throw new BusinessError('Löschen nur durch einen Admin');
    const r = await load(c);
    const b = (await c.req.parseBody()) as Record<string, string | File>;
    await deleteFirstAid(sql, r.id, c.get('actor'));
    return back(c, safeBack(str(b, 'zurueck'), '/verbandbuch'), { ok: 'Eintrag gelöscht.' });
  });
}
