import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { listFiles } from '../services/uploads.js';
import {
  FUEL,
  OWNERSHIP,
  getVehicle,
  listHandoverObjects,
  listVehicles,
  saveHandoverObject,
  saveVehicle,
  vehicleDeadlines,
  type Vehicle,
} from '../services/vehicles.js';
import { type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, dateDe, anz } from './layout.js';

/** Inventar → Fahrzeuge; Einstellungen → Gegenstände für Übergaben. */
export function registerVehicleRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const versionOf = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

  app.get('/fahrzeuge', async (c) => {
    const all = c.req.query('alle') === '1';
    const list = await listVehicles(sql, all);
    const today = todayBerlin();
    return page(
      c,
      'Fahrzeuge',
      'inventar',
      <>
        <PageHead title="Fahrzeuge">
          <a class="btn" href={`/fahrzeuge/${randomUUID()}`}>
            + Fahrzeug anlegen
          </a>
        </PageHead>
        <div class="chips" style="margin-bottom:12px">
          <a href="/fahrzeuge" class={all ? '' : 'on'}>
            Aktive
          </a>
          <a href="/fahrzeuge?alle=1" class={all ? 'on' : ''}>
            Alle (auch abgemeldet)
          </a>
        </div>
        <div class="tbl card stack-m" style="padding:0">
          <table>
            <thead>
              <tr>
                <th>Kennzeichen</th>
                <th>Fahrzeug</th>
                <th>Fahrer/in</th>
                <th>HU (TÜV)</th>
                <th>Inspektion</th>
                <th class="r">km</th>
                <th>Unterlagen</th>
              </tr>
            </thead>
            <tbody>
              {list.map((v) => {
                const dl = vehicleDeadlines(v, today);
                const due = (d: string | null) =>
                  d ? (
                    <span class={d < today ? 'badge err' : dl.some((x) => x.date === d) ? 'badge warn' : ''}>
                      {dateDe(d)}
                    </span>
                  ) : (
                    '–'
                  );
                return (
                  <tr class={v.active ? '' : 'mut'}>
                    <td>
                      <a href={`/fahrzeuge/${v.id}`} class="plate">
                        {v.plate}
                      </a>
                      {!v.active && <span class="badge">abgemeldet</span>}
                    </td>
                    <td data-l="Fahrzeug">
                      {[v.make, v.model].filter(Boolean).join(' ') || '–'}
                      {v.first_registration && <div class="small mut">EZ {dateDe(v.first_registration)}</div>}
                    </td>
                    <td data-l="Fahrer/in">{v.driver_name ?? '–'}</td>
                    <td data-l="HU">{due(v.hu_due)}</td>
                    <td data-l="Inspektion">{due(v.service_due)}</td>
                    <td class="r" data-l="km">
                      {v.mileage != null ? v.mileage.toLocaleString('de-DE') : '–'}
                    </td>
                    <td data-l="Unterlagen">
                      {v.files ? (
                        anz(v.files, 'Datei', 'Dateien')
                      ) : (
                        <span class="badge warn">Fahrzeugschein fehlt</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!list.length && (
                <tr>
                  <td colspan={7}>
                    <div class="empty">Noch keine Fahrzeuge erfasst.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <style dangerouslySetInnerHTML={{ __html: PLATE_CSS }} />
      </>,
    );
  });

  app.get(`/fahrzeuge/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const v = await getVehicle(sql, id);
    const [emps, files] = await Promise.all([
      sql<{ id: string; personnel_no: string; first_name: string; last_name: string }[]>`
        select id, personnel_no, first_name, last_name from app.employees where status = 'aktiv'
         order by last_name, first_name`,
      v ? listFiles(sql, { type: 'vehicle', id }) : Promise.resolve([]),
    ]);
    const d = (v ?? {}) as Partial<Vehicle>;
    const deadlines = v ? vehicleDeadlines(v) : [];
    const scheine = files.filter((f) => (f as { category?: string | null }).category === 'Fahrzeugschein');
    const other = files.filter((f) => (f as { category?: string | null }).category !== 'Fahrzeugschein');
    const title = v ? v.plate : 'Neues Fahrzeug';
    return page(
      c,
      title,
      'inventar',
      <>
        <PageHead title={title} crumbs={[['Fahrzeuge', '/fahrzeuge']]} />
        {deadlines.map((x) => (
          <div class={`flash ${x.overdue ? 'err' : 'warn'}`}>
            {x.label} {x.overdue ? 'überfällig seit' : 'fällig am'} {dateDe(x.date)}
          </div>
        ))}
        <div class="cols">
          <form
            method="post"
            action={`/fahrzeuge/${id}`}
            class="card form-card"
            data-autosave
            data-version={String(d.version ?? '')}
          >
            <input type="hidden" name="version" value={String(d.version ?? '')} />
            <h3>Fahrzeug</h3>
            <div class="grid">
              <div>
                <label for="plate">Kennzeichen *</label>
                <input id="plate" name="plate" required value={d.plate ?? ''} placeholder="M-VD 1234" />
              </div>
              <div>
                <label for="make">Marke</label>
                <input id="make" name="make" value={d.make ?? ''} list="makes" placeholder="z. B. VW" />
              </div>
              <div>
                <label for="model">Modell</label>
                <input id="model" name="model" value={d.model ?? ''} placeholder="z. B. Caddy" />
              </div>
              <div>
                <label for="vin">Fahrgestellnummer (FIN)</label>
                <input
                  id="vin"
                  name="vin"
                  value={d.vin ?? ''}
                  maxlength={17}
                  placeholder="17 Zeichen, Feld E im Fahrzeugschein"
                  style="text-transform:uppercase"
                />
              </div>
              <div>
                <label for="ez">Erstzulassung</label>
                <input id="ez" type="date" name="first_registration" value={d.first_registration ?? ''} />
              </div>
              <div>
                <label for="fuel">Kraftstoff</label>
                <select id="fuel" name="fuel" data-nosearch>
                  <option value="">–</option>
                  {Object.entries(FUEL).map(([k, l]) => (
                    <option value={k} selected={d.fuel === k}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="own">Eigentum / Leasing</label>
                <select id="own" name="ownership" data-nosearch>
                  {Object.entries(OWNERSHIP).map(([k, l]) => (
                    <option value={k} selected={(d.ownership ?? 'eigentum') === k}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="lc">Leasing-/Mietgeber</label>
                <input id="lc" name="leasing_company" value={d.leasing_company ?? ''} />
              </div>
              <div>
                <label for="lu">Leasing/Miete bis</label>
                <input id="lu" type="date" name="leasing_until" value={d.leasing_until ?? ''} />
              </div>
            </div>
            <h3>Fristen &amp; Versicherung</h3>
            <div class="grid">
              <div>
                <label for="hu">Nächste HU (TÜV)</label>
                <input id="hu" type="month" name="hu_due" value={d.hu_due?.slice(0, 7) ?? ''} />
              </div>
              <div>
                <label for="sv">Nächste Inspektion</label>
                <input id="sv" type="date" name="service_due" value={d.service_due ?? ''} />
              </div>
              <div>
                <label for="ins">Versicherung</label>
                <input id="ins" name="insurer" value={d.insurer ?? ''} />
              </div>
              <div>
                <label for="insno">Versicherungsschein-Nr.</label>
                <input id="insno" name="insurance_no" value={d.insurance_no ?? ''} />
              </div>
            </div>
            <h3>Nutzung</h3>
            <div class="grid">
              <div>
                <label for="drv">Fahrer/in</label>
                <select id="drv" name="driver_employee_id">
                  <option value="">– Pool-Fahrzeug –</option>
                  {emps.map((e) => (
                    <option value={e.id} selected={e.id === d.driver_employee_id}>
                      {e.last_name}, {e.first_name} ({e.personnel_no})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="km">Kilometerstand</label>
                <input
                  id="km"
                  name="mileage"
                  inputmode="numeric"
                  value={d.mileage != null ? String(d.mileage) : ''}
                />
              </div>
              <div>
                <label for="kmd">Stand vom</label>
                <input id="kmd" type="date" name="mileage_date" value={d.mileage_date ?? todayBerlin()} />
              </div>
              <div>
                <label for="fc">Tankkarte</label>
                <input id="fc" name="fuel_card" value={d.fuel_card ?? ''} placeholder="z. B. DKV …1234" />
              </div>
              <div>
                <label for="note">Bemerkung</label>
                <textarea id="note" name="note" rows={2}>
                  {d.note ?? ''}
                </textarea>
              </div>
              <div>
                <label for="act">im Bestand (angemeldet)</label>
                <input id="act" type="checkbox" name="active" checked={d.active ?? true} />
              </div>
            </div>
            <datalist id="makes">
              {[
                'VW',
                'Mercedes-Benz',
                'Ford',
                'Renault',
                'Opel',
                'Peugeot',
                'Citroën',
                'Fiat',
                'Toyota',
                'Skoda',
                'BMW',
                'Audi',
                'Dacia',
                'Hyundai',
                'Kia',
                'Nissan',
                'Tesla',
              ].map((m) => (
                <option value={m} />
              ))}
            </datalist>
            <div class="formfoot">
              <a class="btn ghost" href="/fahrzeuge">
                Zurück
              </a>
              <button class="btn">Speichern</button>
            </div>
          </form>
          <div>
            <div class="card">
              <h3>
                <Icon name="file" size={16} /> Fahrzeugschein
              </h3>
              {v ? (
                <FileArea
                  link={{ type: 'vehicle', id }}
                  files={scheine}
                  category="Fahrzeugschein"
                  hint="Zulassungsbescheinigung Teil I – Foto oder Scan (PDF), Vorder- und Rückseite."
                  maxBytes={deps.env.UPLOAD_MAX_BYTES}
                />
              ) : (
                <p class="mut">Bitte das Fahrzeug zuerst speichern, dann den Fahrzeugschein einscannen.</p>
              )}
            </div>
            {v && (
              <div class="card">
                <h3>Weitere Unterlagen</h3>
                <FileArea
                  link={{ type: 'vehicle', id }}
                  files={other}
                  category="Fahrzeugunterlagen"
                  hint="Leasingvertrag, Versicherung, HU-Bericht, Schadensfotos …"
                  maxBytes={deps.env.UPLOAD_MAX_BYTES}
                />
              </div>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.post(`/fahrzeuge/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const hu = str(b, 'hu_due');
    await saveVehicle(sql, id, {
      plate: str(b, 'plate') ?? '',
      make: str(b, 'make'),
      model: str(b, 'model'),
      vin: str(b, 'vin'),
      first_registration: str(b, 'first_registration'),
      fuel: str(b, 'fuel'),
      ownership: str(b, 'ownership') ?? 'eigentum',
      leasing_company: str(b, 'leasing_company'),
      leasing_until: str(b, 'leasing_until'),
      insurer: str(b, 'insurer'),
      insurance_no: str(b, 'insurance_no'),
      // HU wird im Monat fällig (Plakette) → letzter Tag des Monats
      hu_due: hu && /^\d{4}-\d{2}$/.test(hu) ? lastOfMonth(hu) : hu,
      service_due: str(b, 'service_due'),
      mileage: str(b, 'mileage'),
      mileage_date: str(b, 'mileage_date'),
      driver_employee_id: str(b, 'driver_employee_id'),
      fuel_card: str(b, 'fuel_card'),
      note: str(b, 'note'),
      active: b.active === 'on',
      expectedVersion: versionOf(b.version),
    });
    return back(c, `/fahrzeuge/${id}`, { ok: 'Fahrzeug gespeichert.' });
  });

  // ------------------------------------------------------------ Einstellungen: Gegenstände für Übergaben
  app.get('/einstellungen/uebergabe-gegenstaende', async (c) => {
    const list = await listHandoverObjects(sql, true);
    return page(
      c,
      'Gegenstände für Übergaben',
      'einstellungen',
      <>
        <PageHead title="Gegenstände für Übergaben" crumbs={[['Einstellungen', '/einstellungen']]} />
        <p class="mut" style="max-width:780px">
          Auswahlliste bei Übergaben der Art „Sonstiges“ (Diensthandy, Tankkarte …). Fahrzeuge aus der
          Fahrzeugliste stehen dort automatisch zur Auswahl.
        </p>
        <div class="tbl card" style="max-width:640px;padding:0">
          <table>
            <thead>
              <tr>
                <th>Gegenstand</th>
                <th>aktiv</th>
                <th class="acts"></th>
              </tr>
            </thead>
            <tbody>
              {[...list, null].map((o) => {
                const oid = o?.id ?? randomUUID();
                const f = `ho-${oid.slice(0, 8)}`;
                return (
                  <tr>
                    <td>
                      <form id={f} method="post" action={`/einstellungen/uebergabe-gegenstaende/${oid}`} />
                      <input
                        form={f}
                        name="name"
                        value={o?.name ?? ''}
                        placeholder="neuer Gegenstand"
                        aria-label="Gegenstand"
                      />
                    </td>
                    <td style="width:60px">
                      <input
                        type="checkbox"
                        form={f}
                        name="active"
                        checked={o ? o.active : true}
                        aria-label="aktiv"
                      />
                    </td>
                    <td class="acts">
                      <button class="btn sm sec" form={f}>
                        {o ? 'Speichern' : 'Anlegen'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.post(`/einstellungen/uebergabe-gegenstaende/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveHandoverObject(sql, c.req.param('id'), {
      name: str(b, 'name') ?? '',
      active: b.active === 'on',
    });
    return back(c, '/einstellungen/uebergabe-gegenstaende', { ok: 'Gespeichert.' });
  });
}

function lastOfMonth(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, 0));
  return d.toISOString().slice(0, 10);
}

const PLATE_CSS = `.plate{display:inline-block;font-weight:700;letter-spacing:.04em;border:2px solid #1c1a19;border-radius:4px;padding:1px 8px 1px 14px;background:#fff linear-gradient(90deg,#1f4fbf 0,#1f4fbf 8px,#fff 8px);color:#1c1a19;text-decoration:none;white-space:nowrap}`;
