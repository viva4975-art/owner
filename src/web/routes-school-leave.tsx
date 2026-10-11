import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { SCHOOL_DATA_UNTIL } from '../domain/time/school-holidays.js';
import { BusinessError } from '../services/errors.js';
import { schoolLeave } from '../services/school-leave.js';
import type { AppEnv, Ctx } from './app.js';
import { dateDe } from './layout.js';

const UUID = '[0-9a-f-]{36}';
const mayEdit = (c: Context<AppEnv>) => ['admin', 'personal'].includes(c.get('user').role);
const days = (n: number) => `${n} ${n === 1 ? 'Tag' : 'Tage'}`;

/** Karte auf der Objekt-Übersicht: Schule ja/nein, Link zu Vorschau/Eintragen. */
export const SchoolCard: FC<{ siteId: string; on: boolean; canEdit: boolean }> = ({
  siteId,
  on,
  canEdit,
}) => (
  <section>
    <h2 class="panel-title">Schule / Schulferien</h2>
    <p class="small" style="margin-top:0">
      {on
        ? 'In den Schulferien geschlossen: Für alle Mitarbeitenden, die hier künftig eingeplant sind, trägt die App die Ferien (und Buß- und Bettag) automatisch ein – Resturlaub als Urlaub, den Rest als „Unbezahlt frei“.'
        : 'Keine Schule. Ist das Objekt in den Schulferien geschlossen, hier markieren – dann trägt die App Urlaub bzw. unbezahlte Tage für die Ferien automatisch ein.'}
    </p>
    <div class="actions" style="margin-top:0">
      {on && (
        <a class="btn sm" href={`/objekte/${siteId}/schulferien`}>
          Vorschau &amp; eintragen
        </a>
      )}
      {canEdit && (
        <form
          method="post"
          action={`/objekte/${siteId}/schulferien/markierung`}
          data-confirm={
            on
              ? 'Markierung „Schule“ entfernen? Bereits eingetragene Abwesenheiten bleiben stehen.'
              : 'Objekt als Schule markieren? Die Ferien werden dann für alle eingeplanten Mitarbeitenden automatisch eingetragen.'
          }
        >
          <input type="hidden" name="on" value={on ? '0' : '1'} />
          <button class="btn sm sec">{on ? 'Markierung „Schule“ entfernen' : 'Als Schule markieren'}</button>
        </form>
      )}
    </div>
  </section>
);

export function registerSchoolLeaveRoutes({ app, deps, shells, back }: Ctx) {
  const { sql } = deps;

  app.post(`/objekte/:id{${UUID}}/schulferien/markierung`, async (c) => {
    if (!mayEdit(c)) throw new BusinessError('Nur Büro (Admin/Personal) darf das ändern');
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const on = b.on === '1';
    await sql`update app.sites set school_closure = ${on} where id = ${id}`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${c.get('actor')}, 'update', 'site', ${id}, ${sql.json({ school_closure: on })})`;
    if (!on) return back(c, `/objekte/${id}`, { ok: 'Markierung „Schule“ entfernt.' });
    return back(c, `/objekte/${id}/schulferien`, {
      ok: 'Als Schule markiert. Bitte die Vorschau prüfen und „Jetzt eintragen“ – danach läuft es täglich automatisch.',
    });
  });

  app.get(`/objekte/:id{${UUID}}/schulferien`, (c) =>
    shells.site!(c, 'uebersicht', async (s) => {
      const [row] = await sql<{ school_closure: boolean }[]>`
        select school_closure from app.sites where id = ${s.id}`;
      if (!row?.school_closure)
        return (
          <div class="card">
            <p>Dieses Objekt ist nicht als Schule markiert.</p>
            <SchoolCard siteId={s.id} on={false} canEdit={mayEdit(c)} />
          </div>
        );
      const r = await schoolLeave(sql, { siteId: s.id, apply: false, actor: c.get('actor') });
      const longOnes = r.planned.filter((p) => p.longUnpaid);
      return (
        <>
          <div class="card">
            <h3 style="margin-top:0">Schulferien – noch einzutragen ({r.planned.length})</h3>
            {r.planned.length === 0 ? (
              <div class="empty-line">
                Nichts offen{r.done ? ` – ${r.done} Ferienzeiträume sind schon eingetragen` : ''}.
              </div>
            ) : (
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Mitarbeiter</th>
                      <th>Ferien</th>
                      <th>Zeitraum</th>
                      <th class="r">Urlaub</th>
                      <th class="r">unbezahlt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.planned.map((p) => (
                      <tr>
                        <td>
                          <a href={`/personal/${p.employee_id}/abwesenheiten`}>{p.name}</a>
                        </td>
                        <td>{p.period}</td>
                        <td class="nowrap">
                          {dateDe(p.from)} – {dateDe(p.to)}
                        </td>
                        <td class="r">{days(p.vacation)}</td>
                        <td class="r" style={p.longUnpaid ? 'color:var(--err)' : ''}>
                          {days(p.unpaid)}
                          {p.longUnpaid && ' *'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {longOnes.length > 0 && (
              <p class="small" style="color:var(--err)">
                * Mehr als ein Monat am Stück ohne Entgelt: Die Beschäftigung gilt dann nicht mehr als
                fortbestehend (§ 7 Abs. 3 SGB IV) – Abmeldung bei der Krankenkasse bzw. im Lohnprogramm
                prüfen.
              </p>
            )}
            {r.planned.length > 0 && mayEdit(c) && (
              <form
                method="post"
                action={`/objekte/${s.id}/schulferien`}
                data-confirm={`${r.planned.length} Ferienzeiträume jetzt als Urlaub/unbezahlt eintragen?`}
              >
                <button class="btn">Jetzt eintragen</button>
              </form>
            )}
          </div>
          {r.skipped.length > 0 && (
            <div class="card">
              <h3 style="margin-top:0">Nicht automatisch ({r.skipped.length})</h3>
              <ul class="small" style="margin:0">
                {r.skipped.map((x) => (
                  <li>
                    <a href={`/personal/${x.employee_id}/abwesenheiten`}>{x.name}</a> – {x.period}: {x.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div class="card">
            <p class="small mut" style="margin:0">
              So wird gerechnet: Je Kalenderjahr wird der Resturlaub anteilig auf die Ferien verteilt (in
              jedem Zeitraum in der Mitte, damit die unbezahlten Stücke kurz bleiben), der Rest ist „Unbezahlt
              frei“. Gezählt werden Arbeitstage Mo–Fr ohne Feiertage. Buß- und Bettag ist schulfrei und zählt
              mit. Ferientermine liegen bis {dateDe(SCHOOL_DATA_UNTIL)} vor – für Jahre mit noch fehlenden
              Terminen wird nur ein Teil des Urlaubs verplant. Die App prüft täglich neu (neue Mitarbeitende,
              neue Einsätze); schon eingetragene Zeiträume und Zeiträume mit anderer Abwesenheit bleiben
              unverändert. Einzelne Einträge lassen sich wie jede Abwesenheit ändern oder löschen.
              <br />
              <b>Rechtlich:</b> Unbezahlte Ferien nur, wenn der Arbeitsvertrag das Ruhen in den Schulferien
              vorsieht (Vorlagen ab V5). Urlaub muss gewährt werden – wer in den Ferien Urlaub nimmt, hat ihn
              damit verbraucht; Urlaubsanspruch bei Ruhen nur für Tage mit Arbeitspflicht.
            </p>
          </div>
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/schulferien`, async (c) => {
    if (!mayEdit(c)) throw new BusinessError('Nur Büro (Admin/Personal) darf das');
    const id = c.req.param('id');
    const r = await schoolLeave(sql, { siteId: id, apply: true, actor: c.get('actor') });
    return back(c, `/objekte/${id}/schulferien`, {
      ok: `${r.planned.length} Ferienzeiträume eingetragen (${r.planned.reduce((a, p) => a + p.vacation, 0)} Urlaubstage, ${r.planned.reduce((a, p) => a + p.unpaid, 0)} unbezahlte Tage).`,
    });
  });
}
