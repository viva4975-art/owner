import type { Sql } from '../db/client.js';
import { ROLE_LABEL } from '../services/users.js';
import type { Ctx } from './app.js';
import { PageHead } from './layout.js';
import {
  PERM_GROUPS,
  PERM_ROLES,
  defaultAreaAccess,
  permissionOverride,
  setPermissionOverrides,
} from './permissions.js';

/** Abweichungen der Rechte aus der Datenbank laden (beim Start und nach dem Speichern). */
export async function loadRolePermissions(sql: Sql) {
  try {
    setPermissionOverrides(
      await sql<{ role: string; area: string; allowed: boolean }[]>`
        select role, area, allowed from app.role_permissions`,
    );
  } catch (e) {
    console.error('Rechte der Benutzergruppen nicht geladen:', e);
  }
}

/** Einstellungen → Rechte der Benutzergruppen (nur Admin, Ahmed 21.10.). */
export function registerPermissionRoutes(ctx: Ctx) {
  const { app, deps, page } = ctx;
  const { sql } = deps;
  void loadRolePermissions(sql);

  app.get('/einstellungen/rechte', async (c) => {
    const changed = await sql<{ n: number }[]>`select count(*)::int as n from app.role_permissions`;
    return page(
      c,
      'Rechte der Benutzergruppen',
      'einstellungen',
      <>
        <PageHead title="Rechte der Benutzergruppen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <div class="card" style="max-width:980px">
          <p style="margin-top:0">
            Haken = die Gruppe darf den Bereich öffnen und dort arbeiten (Menüpunkt erscheint). Admin darf
            immer alles. <span class="perm-key">Hinterlegt</span> = von der Vorgabe abweichend.
          </p>
          <details class="small mut" style="margin:0 0 12px">
            <summary>Was ist nicht einstellbar?</summary>
            Nicht einstellbar (immer nur Admin): Benutzer, Firmendaten, Nummernkreise, Bankabruf,
            E-Mail-Versand, Systemzustand, Archiv und diese Seite. Einzelne Knöpfe in den Seiten (z. B.
            „endgültig löschen“) bleiben Admin vorbehalten. <b>Objektleitung:</b> In Objekte, Zeiterfassung,
            Planung, Arbeitsscheine, Schlüssel und Geräte sieht sie nur ihre Objekte – in anderen
            freigegebenen Bereichen (z. B. Rechnungen, Kunden) gibt es diese Einschränkung nicht, sie sieht
            dort alles.
          </details>
          <form method="post" action="/einstellungen/rechte">
            <div class="tablewrap">
              <table class="keep perm">
                <thead>
                  <tr>
                    <th>Bereich</th>
                    {PERM_ROLES.map((r) => (
                      <th style="text-align:center">{ROLE_LABEL[r]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERM_GROUPS.map((g) => (
                    <>
                      <tr class="perm-grp">
                        <td colspan={PERM_ROLES.length + 1}>{g.label}</td>
                      </tr>
                      {g.areas.map((a) => (
                        <tr>
                          <td>{a.label}</td>
                          {PERM_ROLES.map((r) => {
                            const def = defaultAreaAccess(r, a);
                            const o = permissionOverride(r, a.key);
                            const on = o ?? def;
                            return (
                              <td class={`perm-c${o !== undefined && o !== def ? ' dev' : ''}`}>
                                <label
                                  style="display:inline-flex;gap:4px;align-items:center"
                                  title={`Vorgabe: ${def ? 'erlaubt' : 'gesperrt'}`}
                                >
                                  <input
                                    type="checkbox"
                                    name={`p:${r}:${a.key}`}
                                    value="1"
                                    checked={on}
                                    aria-label={`${a.label} – ${ROLE_LABEL[r]}`}
                                  />
                                  {o !== undefined && o !== def && (
                                    <span class="small">{on ? 'ja' : 'nein'}</span>
                                  )}
                                </label>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="formfoot perm-foot">
              <button class="btn">Rechte speichern</button>
            </div>
          </form>
          {changed[0]!.n > 0 && (
            <form
              method="post"
              action="/einstellungen/rechte/zuruecksetzen"
              onsubmit="return confirm('Alle Rechte auf die Vorgabe zurücksetzen?')"
            >
              <button class="btn sec sm">
                Alles auf Vorgabe zurücksetzen ({changed[0]!.n} Abweichungen)
              </button>
            </form>
          )}
        </div>
      </>,
    );
  });

  app.post('/einstellungen/rechte', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const actor = c.get('actor');
    const changes: string[] = [];
    await sql.begin(async (tx) => {
      for (const g of PERM_GROUPS)
        for (const a of g.areas)
          for (const r of PERM_ROLES) {
            const want = b[`p:${r}:${a.key}`] === '1';
            const def = defaultAreaAccess(r, a);
            const [old] = await tx<{ allowed: boolean }[]>`
              select allowed from app.role_permissions where role = ${r} and area = ${a.key}`;
            const before = old?.allowed ?? def;
            if (want === def)
              await tx`delete from app.role_permissions where role = ${r} and area = ${a.key}`;
            else
              await tx`insert into app.role_permissions (role, area, allowed, updated_by)
                       values (${r}, ${a.key}, ${want}, ${actor})
                       on conflict (role, area) do update set allowed = excluded.allowed,
                         updated_by = excluded.updated_by, updated_at = now()`;
            if (before !== want)
              changes.push(`${a.label} – ${ROLE_LABEL[r]}: ${want ? 'erlaubt' : 'gesperrt'}`);
            if (before !== want)
              await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
                       values (${actor}, 'role_permission', 'role', null,
                               ${tx.json({ role: r, area: a.key, allowed: want })})`;
          }
    });
    await loadRolePermissions(sql);
    const msg = changes.length
      ? `Rechte gespeichert – ${changes.length === 1 ? '1 Änderung' : `${changes.length} Änderungen`}, gelten sofort: ${changes.slice(0, 6).join('; ')}${changes.length > 6 ? ' …' : ''}`
      : 'Gespeichert – keine Änderung.';
    return ctx.back(c, '/einstellungen/rechte', { ok: msg });
  });

  app.post('/einstellungen/rechte/zuruecksetzen', async (c) => {
    await sql`delete from app.role_permissions`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${c.get('actor')}, 'role_permission_reset', 'role', null)`;
    await loadRolePermissions(sql);
    return ctx.back(c, '/einstellungen/rechte', { ok: 'Alle Rechte auf Vorgabe zurückgesetzt.' });
  });
}
