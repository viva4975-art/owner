import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { clock, getEntry, listEntries, officeSave } from '../services/time.js';
import { linkedEmployee } from '../services/users.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { PageHead, dateDe } from './layout.js';
import { EmployeeCalendarView } from './pages-employee-calendar.js';
import { employeeCalendarData } from './employee-calendar-data.js';
import { holidayName } from '../domain/time/holidays.js';
import { SiteOptions } from './site-options.js';

/*
 * Meine Zeiten (Büro, Objektleitung, Admin am PC): eigene Arbeitszeit ansehen, nachtragen und ändern.
 * Gespeichert wird wie eine Büro-Korrektur (officeSave): Begründung Pflicht bei Änderungen, alter/neuer Stand im
 * Protokoll (§ 17 MiLoG). Nur der eigene, verknüpfte Mitarbeiter-Datensatz.
 */
export function registerMyTimeRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const me = async (c: Context<AppEnv>) => {
    const id = await linkedEmployee(sql, c.get('user').id);
    if (!id) return null;
    const [e] = await sql<{ id: string; name: string; personnel_no: string }[]>`
      select id, first_name || ' ' || last_name as name, personnel_no from app.employees where id = ${id}`;
    return e ?? null;
  };

  app.get('/zeiterfassung/meine', async (c) => {
    const e = await me(c);
    if (!e)
      return page(
        c,
        'Meine Zeiten',
        'personal',
        <>
          <PageHead title="Meine Zeiten" />
          <div class="card">
            <p style="margin-top:0">
              Ihr Benutzer ist noch mit keinem Mitarbeiter verknüpft. Bitte unter{' '}
              <b>Einstellungen → Benutzer → „Mitarbeiter (eigene Zeiterfassung)“</b> zuordnen lassen.
            </p>
          </div>
        </>,
      );
    const month = /^\d{4}-\d{2}$/.test(c.req.query('monat') ?? '')
      ? c.req.query('monat')!
      : todayBerlin().slice(0, 7);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const from = `${month}-01`;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const editId = c.req.query('id');
    const cal = await employeeCalendarData(sql, e.id, c.req.query(), { defaultView: 'monat' });
    const pre = c.req.query();
    const [entries, sites, cur] = await Promise.all([
      listEntries(sql, { from, to, employeeId: e.id }),
      sql<
        {
          id: string;
          site_no: string;
          name: string;
          street: string | null;
          city: string | null;
          customer_name: string;
        }[]
      >`
        select s.id, s.site_no, s.name, s.street, s.city, c.name as customer_name
          from app.sites s join app.customers c on c.id = s.customer_id
         where s.active order by (s.site_no = 'INT-BUERO') desc, c.name, s.name`,
      editId && /^[0-9a-f-]{36}$/.test(editId) ? getEntry(sql, editId) : Promise.resolve(undefined),
    ]);
    const edit = cur && cur.employee_id === e.id ? cur : undefined;
    const valid = entries.filter((x) => x.status !== 'abgelehnt');
    const defaultSite =
      edit?.site_id ??
      (pre.objekt && /^[0-9a-f-]{36}$/.test(pre.objekt) ? pre.objekt : undefined) ??
      valid[0]?.site_id ??
      sites.find((s) => s.site_no === 'INT-BUERO')?.id;
    return page(
      c,
      'Meine Zeiten',
      'personal',
      <>
        <PageHead title="Meine Zeiten" no={`${e.name} · Nr. ${e.personnel_no}`} />
        <EmployeeCalendarView
          employeeId={e.id}
          today={todayBerlin()}
          holiday={holidayName}
          canEdit={false}
          self
          base="/zeiterfassung/meine"
          confirmAction="/zeiterfassung/plan-als-ist"
          {...cal}
        />
        <div class="cols" style="margin-top:16px">
          <form
            method="post"
            action={`/zeiterfassung/meine/${edit?.id ?? randomUUID()}`}
            class="card"
            id="form"
          >
            <h3 style="margin-top:0">
              {edit ? `Zeit ändern · ${dateDe(edit.work_date)}` : 'Zeit nachtragen'}
            </h3>
            <input type="hidden" name="version" value={String(edit?.version ?? '')} />
            <input type="hidden" name="monat" value={month} />
            <div class="grid">
              <div>
                <label for="date">Datum</label>
                <input
                  id="date"
                  name="date"
                  type="date"
                  value={
                    edit?.work_date ??
                    (/^\d{4}-\d{2}-\d{2}$/.test(pre.datum ?? '') ? pre.datum : todayBerlin())
                  }
                  required
                />
              </div>
              <div>
                <label for="site">Objekt / Einsatzort</label>
                <select id="site" name="site_id" required>
                  <SiteOptions sites={sites} selected={defaultSite} />
                </select>
              </div>
              <div>
                <label for="start">Beginn</label>
                <input
                  id="start"
                  name="start"
                  type="time"
                  value={edit ? clock(edit.start_at) : (pre.von ?? '')}
                  required
                />
              </div>
              <div>
                <label for="end">Ende</label>
                <input
                  id="end"
                  name="end"
                  type="time"
                  value={edit?.end_at ? clock(edit.end_at) : (pre.bis ?? '')}
                  required
                />
              </div>
              <div>
                <label for="brk">Pause (Minuten)</label>
                <input
                  id="brk"
                  name="break_minutes"
                  type="number"
                  min={0}
                  value={String(edit?.break_minutes ?? (Number(pre.pause) || 0))}
                />
              </div>
              <div>
                <label for="reason">{edit ? 'Grund der Änderung (Pflicht)' : 'Bemerkung'}</label>
                <input
                  id="reason"
                  name="reason"
                  required={!!edit}
                  placeholder={edit ? 'z. B. Ende vergessen' : ''}
                />
              </div>
            </div>
            <p class="small mut">
              Änderungen werden mit altem und neuem Stand protokolliert (§ 17 MiLoG). Pause ab 6 Std.
              mindestens 30 Min., ab 9 Std. 45 Min. (§ 4 ArbZG).
            </p>
            <div class="actions">
              <button class="btn">{edit ? 'Änderung speichern' : 'Zeit speichern'}</button>
              {edit && (
                <a class="btn ghost" href={`/zeiterfassung/meine?monat=${month}`}>
                  Abbrechen
                </a>
              )}
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/zeiterfassung/meine/:id{${UUID}}`, async (c) => {
    const e = await me(c);
    if (!e) throw new BusinessError('Benutzer ist mit keinem Mitarbeiter verknüpft');
    const id = c.req.param('id');
    const b = (await c.req.parseBody()) as Record<string, string>;
    const cur = await getEntry(sql, id);
    if (cur && cur.employee_id !== e.id) throw new BusinessError('Nur eigene Zeiten');
    const reason = (b.reason ?? '').trim();
    if (cur && !reason) throw new BusinessError('Bitte Grund der Änderung angeben');
    await officeSave(sql, {
      id,
      employeeId: e.id,
      siteId: b.site_id ?? '',
      date: b.date ?? '',
      start: b.start ?? '',
      end: b.end ?? '',
      breakMinutes: Number(b.break_minutes ?? 0) || 0,
      reason: reason || 'selbst nachgetragen',
      expectedVersion: cur && b.version ? Number(b.version) : null,
      actor: c.get('actor'),
    });
    const month = /^\d{4}-\d{2}$/.test(b.monat ?? '') ? b.monat : (b.date ?? '').slice(0, 7);
    return back(c, `/zeiterfassung/meine?monat=${month}`, { ok: 'Zeit gespeichert und protokolliert.' });
  });
}
