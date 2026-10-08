import { randomUUID } from 'node:crypto';
import { listCostCenters, saveCostCenter } from '../services/cost-centers.js';
import { BusinessError } from '../services/errors.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';

/** Kostenstellen: Auswertung (Eingangsrechnungen je Kostenstelle) und Pflege der allgemeinen Kostenstellen. */
export function registerCostCenterRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  // Kostenstellen-Auswertung ist in der Nachkalkulation aufgegangen (Ahmed 09.10.)
  app.get('/auswertungen/kostenstellen', (c) => {
    const q = new URLSearchParams();
    if (c.req.query('von')) q.set('von', c.req.query('von')!);
    if (c.req.query('bis')) q.set('bis', c.req.query('bis')!);
    return c.redirect(`/auswertungen/nachkalkulation${q.size ? `?${q}` : ''}`, 301);
  });

  app.get('/einstellungen/kostenstellen', async (c) => {
    const list = await listCostCenters(sql, true);
    const edit = list.find((x) => x.id === c.req.query('bearbeiten')) ?? null;
    return page(
      c,
      'Kostenstellen',
      '',
      <>
        <PageHead title="Allgemeine Kostenstellen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <p class="mut" style="margin-top:-8px;max-width:760px">
          Jedes Objekt ist automatisch eine Kostenstelle (Objektnummer). Hier die übrigen Kostenstellen für
          Gemeinkosten, z. B. Büro, Fahrzeuge, Lager.
        </p>
        <div class="cols">
          <div class="card">
            <div class="list" style="border-top:0;margin-top:-22px;margin-bottom:-22px">
              {list.map((x) => (
                <div class="row" style={x.active ? '' : 'opacity:.55'}>
                  <span class="no" style="width:70px;font-weight:600;color:var(--mut)">
                    {x.number}
                  </span>
                  <div class="main">
                    <a href={`/einstellungen/kostenstellen?bearbeiten=${x.id}`}>
                      <b style="color:var(--ink)">{x.name}</b>
                    </a>
                    {!x.active && <span class="small faint"> · inaktiv</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <form
            method="post"
            action={`/einstellungen/kostenstellen/${edit?.id ?? randomUUID()}`}
            class="card"
          >
            <h3>{edit ? `„${edit.name}“ bearbeiten` : 'Neue Kostenstelle'}</h3>
            <input type="hidden" name="version" value={String(edit?.version ?? '')} />
            <label for="number">Nummer</label>
            <input id="number" name="number" value={edit?.number ?? ''} required placeholder="z. B. 9500" />
            <label for="name" style="margin-top:10px">
              Bezeichnung
            </label>
            <input id="name" name="name" value={edit?.name ?? ''} required />
            <div class="chk" style="margin-top:10px">
              <input type="checkbox" id="active" name="active" checked={edit ? edit.active : true} />
              <label for="active">aktiv</label>
            </div>
            <div class="formfoot">
              {edit && (
                <a class="btn sec" href="/einstellungen/kostenstellen">
                  Neue
                </a>
              )}
              <button class="btn">Speichern</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/einstellungen/kostenstellen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const v = str(b, 'version');
    try {
      await saveCostCenter(
        sql,
        id,
        {
          number: str(b, 'number') ?? '',
          name: str(b, 'name') ?? '',
          active: b.active === 'on',
          version: v ? Number(v) : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/einstellungen/kostenstellen?bearbeiten=${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, '/einstellungen/kostenstellen', { ok: 'Kostenstelle gespeichert.' });
  });
}
