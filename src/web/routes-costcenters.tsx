import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addMonths, costCenterReport, listCostCenters, saveCostCenter } from '../services/cost-centers.js';
import { BusinessError } from '../services/errors.js';
import { COST_CATEGORY, type CostCategory } from '../services/purchasing.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';

/** Kostenstellen: Auswertung (Eingangsrechnungen je Kostenstelle) und Pflege der allgemeinen Kostenstellen. */
export function registerCostCenterRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/auswertungen/kostenstellen', async (c) => {
    const cur = todayBerlin().slice(0, 7);
    const from = /^\d{4}-\d{2}$/.test(c.req.query('von') ?? '') ? c.req.query('von')! : addMonths(cur, -2);
    const to = /^\d{4}-\d{2}$/.test(c.req.query('bis') ?? '') ? c.req.query('bis')! : cur;
    const { rows, unallocated } = await costCenterReport(sql, from, to);
    const cats = Object.keys(COST_CATEGORY) as CostCategory[];
    const used = cats.filter((k) => rows.some((r) => r.byCat[k]));
    const total = rows.reduce((a, r) => a + r.total, 0n);
    return page(
      c,
      'Kostenstellen',
      'auswertungen',
      <>
        <PageHead title="Kosten je Kostenstelle" crumbs={[['Auswertungen', '/auswertungen']]} />
        <form method="get" class="actions" style="margin-top:0">
          <label class="small" style="margin:0">
            von
          </label>
          <input type="month" name="von" value={from} style="max-width:170px" />
          <label class="small" style="margin:0">
            bis
          </label>
          <input type="month" name="bis" value={to} style="max-width:170px" />
          <button class="btn sec sm">Anzeigen</button>
          <span class="small mut" style="margin-left:auto">
            Eingangsrechnungen netto nach Leistungsmonat (auch Nachunternehmer). Lohn je Objekt siehe{' '}
            <a href="/auswertungen/nachkalkulation">Nachkalkulation</a>.
          </span>
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Kostenstelle</th>
                  {used.map((k) => (
                    <th class="r">{COST_CATEGORY[k]}</th>
                  ))}
                  <th class="r">Summe</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      {r.site_id ? <a href={`/objekte/${r.site_id}`}>{r.label}</a> : <b>{r.label}</b>}
                      <div class="small faint">{r.kind === 'objekt' ? 'Objekt' : 'allgemein'}</div>
                    </td>
                    {used.map((k) => (
                      <td class="r">{r.byCat[k] ? euro(r.byCat[k]!) : '–'}</td>
                    ))}
                    <td class="r">
                      <b>{euro(r.total)}</b>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colspan={used.length + 2} class="mut">
                      Keine zugeordneten Kosten im Zeitraum.
                    </td>
                  </tr>
                )}
                {rows.length > 0 && (
                  <tr>
                    <td>
                      <b>Gesamt</b>
                    </td>
                    {used.map((k) => (
                      <td class="r">
                        <b>{euro(rows.reduce((a, r) => a + (r.byCat[k] ?? 0n), 0n))}</b>
                      </td>
                    ))}
                    <td class="r">
                      <b>{euro(total)}</b>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h3>
            Nicht (vollständig) zugeordnet <span class="cnt">({unallocated.length})</span>
          </h3>
          {!unallocated.length && <p class="mut small">Alles zugeordnet.</p>}
          <div class="list">
            {unallocated.map((u) => (
              <div class="row">
                <span class="dot warn" />
                <div class="main">
                  <a href={`/rechnungseingang/${u.id}`}>
                    <b style="color:var(--ink)">
                      {u.supplier_name} · {u.invoice_no}
                    </b>
                  </a>
                  <div class="small mut">{dateDe(u.invoice_date)}</div>
                </div>
                <div class="side">
                  <span class="when">
                    {euro(u.allocated)} von {euro(u.net_cents)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </>,
    );
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
