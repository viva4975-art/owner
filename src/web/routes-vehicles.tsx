import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { listFiles } from '../services/uploads.js';
import {
  DOCS,
  PAYMENT,
  REGISTRATION,
  TAX_MODES,
  WARRANTY,
  cancelVehicleSale,
  checkSale,
  completeVehicleSale,
  currentSale,
  listVehicleSales,
  renderSalePdf,
  type SaleInput,
  type SaleRow,
} from '../services/vehicle-sales.js';
import {
  FUEL,
  OWNERSHIP,
  getVehicle,
  listHandoverObjects,
  listVehicles,
  saveHandoverObject,
  saveVehicle,
  autoEstimate,
  vehicleDeadlines,
  vehicleValue,
  type Vehicle,
} from '../services/vehicles.js';
import { type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, dateDe, anz, euro } from './layout.js';

/** Inventar → Fahrzeuge; Einstellungen → Gegenstände für Übergaben. */
export function registerVehicleRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const versionOf = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

  app.get('/fahrzeuge', async (c) => {
    const f =
      c.req.query('alle') === '1' ? 'alle' : c.req.query('status') === 'inaktiv' ? 'inaktiv' : 'aktiv';
    const everything = await listVehicles(sql, true);
    const list = everything.filter((v) => (f === 'alle' ? true : f === 'inaktiv' ? !v.active : v.active));
    const nAct = everything.filter((v) => v.active).length;
    const nSold = everything.filter((v) => v.sold_on).length;
    const today = todayBerlin();
    return page(
      c,
      'Fahrzeuge',
      'inventar',
      <>
        <PageHead title={`Fahrzeuge (${nAct})`}>
          <a class="btn" href={`/fahrzeuge/${randomUUID()}`}>
            + Fahrzeug anlegen
          </a>
        </PageHead>
        <div class="chips" style="margin-bottom:12px">
          <a href="/fahrzeuge" class={f === 'aktiv' ? 'on' : ''}>
            Aktive ({nAct})
          </a>
          <a href="/fahrzeuge?status=inaktiv" class={f === 'inaktiv' ? 'on' : ''}>
            Inaktiv / verkauft ({everything.length - nAct})
          </a>
          <a href="/fahrzeuge?alle=1" class={f === 'alle' ? 'on' : ''}>
            Alle ({everything.length})
          </a>
        </div>
        {(() => {
          const act = everything.filter((v) => v.active);
          const sum = (xs: (bigint | null)[]) => xs.reduce<bigint>((a, b) => a + (b ?? 0n), 0n);
          const sold = everything.filter((v) => v.sold_on);
          const vals = act.map((v) => vehicleValue(v, today));
          const missingEst = vals.filter((x) => x == null).length;
          const autoN = vals.filter((x) => x?.auto).length;
          return (
            <div class="kpis kpis-sm">
              <div class="kpi">
                <div class="l">Fahrzeuge im Bestand</div>
                <div class="v">{act.length}</div>
                <div class="s">
                  {anz(everything.length, 'Fahrzeug', 'Fahrzeuge')} insgesamt
                  {nSold > 0 && ` · ${nSold} verkauft`}
                </div>
              </div>
              <div class="kpi">
                <div class="l">Kaufpreis gesamt (Bestand)</div>
                <div class="v">{euro(sum(act.map((v) => v.purchase_price_cents)))}</div>
                {act.some((v) => v.purchase_price_cents == null) && (
                  <div class="s">
                    {anz(act.filter((v) => v.purchase_price_cents == null).length, 'Fahrzeug', 'Fahrzeuge')}{' '}
                    ohne Kaufpreis
                  </div>
                )}
              </div>
              <div class="kpi">
                <div class="l">Geschätzter Wert heute (Bestand)</div>
                <div class="v">{euro(sum(vals.map((x) => x?.cents ?? null)))}</div>
                {(autoN > 0 || missingEst > 0) && (
                  <div class="s">
                    {[
                      autoN > 0 && `davon ${autoN} automatisch geschätzt`,
                      missingEst > 0 &&
                        `${anz(missingEst, 'Fahrzeug', 'Fahrzeuge')} ohne Wert (Kaufpreis fehlt)`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
              </div>
              {f !== 'aktiv' && sold.length > 0 && (
                <div class="kpi">
                  <div class="l">Verkaufserlöse ({sold.length})</div>
                  <div class="v">{euro(sum(sold.map((v) => v.sale_price_cents)))}</div>
                </div>
              )}
            </div>
          );
        })()}
        <div class="tbl card stack-m" style="padding:0">
          <table>
            <thead>
              <tr>
                <th>Kennzeichen</th>
                <th>Fahrzeug</th>
                <th>Fahrer/in</th>
                <th>HU (TÜV)</th>
                <th>Inspektion</th>
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
                      {!v.active && <span class="badge">{v.sold_on ? 'verkauft' : 'inaktiv'}</span>}
                    </td>
                    <td data-l="Fahrzeug">
                      {[v.make, v.model].filter(Boolean).join(' ') || '–'}
                      {v.first_registration && <div class="small mut">EZ {dateDe(v.first_registration)}</div>}
                      {(v.purchase_price_cents != null || v.estimated_value_cents != null) && (
                        <div class="small mut">
                          {[
                            v.purchase_price_cents != null && `Kaufpreis ${euro(v.purchase_price_cents)}`,
                            (() => {
                              const x = vehicleValue(v, today);
                              return x && `Wert ca. ${euro(x.cents)}${x.auto ? ' (automatisch)' : ''}`;
                            })(),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      )}
                      {v.sold_on && (
                        <div class="small mut">
                          verkauft {dateDe(v.sold_on)}
                          {v.sale_price_cents != null && ` für ${euro(v.sale_price_cents)}`}
                        </div>
                      )}
                    </td>
                    <td data-l="Fahrer/in">{v.driver_name ?? '–'}</td>
                    <td data-l="HU">{due(v.hu_due)}</td>
                    <td data-l="Inspektion">{due(v.service_due)}</td>
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
                  <td colspan={6}>
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
    const other = files.filter(
      (f) => !['Fahrzeugschein', 'Verkauf'].includes((f as { category?: string | null }).category ?? ''),
    );
    const sales = v ? await listVehicleSales(sql, id) : [];
    const sale = v ? await currentSale(sql, id) : null;
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
                <label for="note">Bemerkung</label>
                <textarea id="note" name="note" rows={2}>
                  {d.note ?? ''}
                </textarea>
              </div>
            </div>
            <h3>Kauf &amp; Wert</h3>
            <div class="grid">
              <div>
                <label for="pd">Kaufdatum</label>
                <input id="pd" type="date" name="purchase_date" value={d.purchase_date ?? ''} />
              </div>
              <div>
                <label for="pp">Kaufpreis (€)</label>
                <input
                  id="pp"
                  name="purchase_price"
                  inputmode="decimal"
                  placeholder="z. B. 18.500,00"
                  value={d.purchase_price_cents != null ? centsText(d.purchase_price_cents) : ''}
                />
              </div>
              <div>
                <label for="ev">Geschätzter Wert heute (€)</label>
                <input
                  id="ev"
                  name="estimated_value"
                  inputmode="decimal"
                  placeholder="z. B. 12.000,00"
                  value={d.estimated_value_cents != null ? centsText(d.estimated_value_cents) : ''}
                />
                {d.estimated_on && <div class="small mut">geschätzt am {dateDe(d.estimated_on)}</div>}
                {v && autoEstimate(v) != null && (
                  <div class="small mut">
                    Automatisch geschätzt: <b>{euro(autoEstimate(v)!)}</b> (aus Kaufpreis und Alter –
                    Faustregel){' '}
                    {d.estimated_value_cents == null
                      ? '· gilt, solange hier nichts eingetragen ist'
                      : '· leeren, um sie zu verwenden'}
                  </div>
                )}
              </div>
              <div>
                <label for="act">aktiv (im Bestand)</label>
                <input
                  id="act"
                  type="checkbox"
                  name="active"
                  checked={d.active ?? true}
                  disabled={!!d.sold_on}
                />
                {d.sold_on && <div class="small mut">verkauft – nicht mehr im Bestand</div>}
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
            {v && <SaleCard v={v} sale={sale} sales={sales} />}
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
    const cur = await getVehicle(sql, id);
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
      // Kilometerstand und Tankkarte stehen nicht mehr im Formular (Ahmed 27.10.) – alte Werte bleiben gespeichert
      mileage: cur?.mileage != null ? String(cur.mileage) : null,
      mileage_date: cur?.mileage_date ?? null,
      driver_employee_id: str(b, 'driver_employee_id'),
      fuel_card: cur?.fuel_card ?? null,
      note: str(b, 'note'),
      purchase_date: str(b, 'purchase_date'),
      purchase_price: str(b, 'purchase_price'),
      // Verkauf nur über „Fahrzeug verkaufen“ (Kaufvertrag + Rechnung) – hier unverändert lassen
      sold_on: cur?.sold_on ?? null,
      sale_price: cur?.sale_price_cents != null ? centsText(cur.sale_price_cents) : null,
      buyer: cur?.buyer ?? null,
      estimated_value: str(b, 'estimated_value'),
      active: cur?.sold_on ? false : b.active === 'on',
      expectedVersion: versionOf(b.version),
    });
    return back(c, `/fahrzeuge/${id}`, { ok: 'Fahrzeug gespeichert.' });
  });

  // ------------------------------------------------------------ Verkauf (Kaufvertrag + Rechnung als PDF)
  const saleInput = (b: Record<string, unknown>): SaleInput => {
    const one = (k: string) => str(b as never, k);
    const docs = b.docs == null ? [] : Array.isArray(b.docs) ? b.docs.map(String) : [String(b.docs)];
    return {
      saleDate: one('sale_date') ?? '',
      handoverDate: one('handover_date') ?? '',
      handoverTime: one('handover_time'),
      buyerType: one('buyer_type') === 'unternehmen' ? 'unternehmen' : 'privat',
      buyerName: one('buyer_name') ?? '',
      buyerAddress: one('buyer_address') ?? '',
      buyerCountry: one('buyer_country') ?? 'DE',
      buyerVatId: one('buyer_vat_id'),
      buyerId: one('buyer_id'),
      buyerPhone: one('buyer_phone'),
      buyerEmail: one('buyer_email'),
      mileage: one('mileage') ?? '',
      keys: one('keys') ?? '',
      docs,
      accessories: one('accessories'),
      accidentFree: (['ja', 'nein', 'unbekannt'].includes(one('accident') ?? '')
        ? one('accident')
        : 'unbekannt') as SaleInput['accidentFree'],
      damages: one('damages'),
      defects: one('defects'),
      priceInput: one('price') ?? '',
      priceIs: one('price_is') === 'netto' ? 'netto' : 'brutto',
      taxMode: (one('tax_mode') ?? 'ust19') as SaleInput['taxMode'],
      payment: (one('payment') ?? 'ueberweisung') as SaleInput['payment'],
      warranty: (one('warranty') ?? 'einjahr') as SaleInput['warranty'],
      registration: (one('registration') ?? 'abgemeldet') as SaleInput['registration'],
      reregisterDays: one('reregister_days'),
      note: one('note'),
    };
  };

  app.get(`/fahrzeuge/:id{${UUID}}/verkauf`, async (c) => {
    const id = c.req.param('id');
    const v = await getVehicle(sql, id);
    if (!v) return c.notFound();
    const sale = await currentSale(sql, id);
    if (sale)
      return back(c, `/fahrzeuge/${id}`, { fehler: `Schon verkauft (${sale.sale_no}) – erst stornieren.` });
    const today = todayBerlin();
    const formId = randomUUID();
    const sel = (name: string, opts: Record<string, string>, value: string, id2 = name) => (
      <select id={id2} name={name} data-nosearch>
        {Object.entries(opts).map(([k, l]) => (
          <option value={k} selected={k === value}>
            {l}
          </option>
        ))}
      </select>
    );
    return page(
      c,
      `Verkauf ${v.plate}`,
      'inventar',
      <>
        <PageHead
          title={`Fahrzeug verkaufen – ${v.plate}`}
          crumbs={[
            ['Fahrzeuge', '/fahrzeuge'],
            [v.plate, `/fahrzeuge/${id}`],
          ]}
        />
        <p class="mut" style="max-width:820px">
          Punkte ausfüllen → <b>PDF-Vorschau</b> prüfen → <b>Verkauf abschließen</b>. Es entsteht ein PDF mit
          Kaufvertrag (inkl. Übergabe) und Rechnung mit Nummer FV-JJJJ-NNN; es liegt danach unter Unterlagen →
          „Verkauf“, das Fahrzeug ist verkauft.
        </p>
        {v.ownership !== 'eigentum' && (
          <div class="flash err">
            Das Fahrzeug ist {OWNERSHIP[v.ownership]} – verkaufen kann nur der Eigentümer.
            Leasing-/Mietfahrzeuge gehen an den Geber zurück.
          </div>
        )}
        <form method="post" action={`/fahrzeuge/${id}/verkauf`} class="card form-card" data-autosave>
          <input type="hidden" name="form_id" value={formId} />
          <h3>1. Käufer</h3>
          <div class="grid">
            <div>
              <label for="bt">Käufer ist</label>
              {sel('buyer_type', { privat: 'Privatperson', unternehmen: 'Unternehmen' }, 'privat', 'bt')}
            </div>
            <div>
              <label for="bn">Name / Firma *</label>
              <input id="bn" name="buyer_name" required />
            </div>
            <div>
              <label for="ba">Anschrift * (Straße, PLZ Ort)</label>
              <textarea
                id="ba"
                name="buyer_address"
                rows={3}
                required
                placeholder={'Musterstr. 1\n80331 München'}
              />
            </div>
            <div>
              <label for="bc">Land (Kürzel)</label>
              <input id="bc" name="buyer_country" value="DE" maxlength={2} style="text-transform:uppercase" />
            </div>
            <div>
              <label for="bv">USt-IdNr. (bei Unternehmen)</label>
              <input id="bv" name="buyer_vat_id" placeholder="z. B. ATU12345678" />
            </div>
            <div>
              <label for="bid">Ausweis-/Pass-Nr.</label>
              <input id="bid" name="buyer_id" />
            </div>
            <div>
              <label for="bp">Telefon</label>
              <input id="bp" name="buyer_phone" />
            </div>
            <div>
              <label for="be">E-Mail</label>
              <input id="be" name="buyer_email" type="email" />
            </div>
          </div>
          <h3>2. Fahrzeug &amp; Übergabe</h3>
          <p class="small mut">
            {[v.make, v.model].filter(Boolean).join(' ') || 'Fahrzeug'} · {v.plate}
            {v.vin ? ` · FIN ${v.vin}` : ' · FIN fehlt (im Fahrzeug eintragen)'}
            {v.first_registration ? ` · EZ ${dateDe(v.first_registration)}` : ''}
          </p>
          <div class="grid">
            <div>
              <label for="sd">Verkaufsdatum *</label>
              <input id="sd" type="date" name="sale_date" value={today} max={today} required />
            </div>
            <div>
              <label for="hd">Übergabe am *</label>
              <input id="hd" type="date" name="handover_date" value={today} required />
            </div>
            <div>
              <label for="ht">Uhrzeit Übergabe</label>
              <input id="ht" type="time" name="handover_time" />
            </div>
            <div>
              <label for="km">km-Stand bei Übergabe *</label>
              <input id="km" name="mileage" inputmode="numeric" required />
            </div>
            <div>
              <label for="keys">Anzahl Schlüssel *</label>
              <input id="keys" name="keys" inputmode="numeric" value="2" required />
            </div>
            <div>
              <label>Übergebene Unterlagen</label>
              <div>
                {Object.entries(DOCS).map(([k, l]) => (
                  <label class="chk" style="display:block;font-weight:normal">
                    <input type="checkbox" name="docs" value={k} checked={k === 'zb1' || k === 'zb2'} /> {l}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label for="acc">Zubehör</label>
              <input id="acc" name="accessories" placeholder="z. B. Winterreifen auf Felgen, Dachträger" />
            </div>
            <div>
              <label for="reg">Zulassung</label>
              {sel('registration', REGISTRATION, 'abgemeldet', 'reg')}
            </div>
            <div>
              <label for="rd">Ummelden binnen (Tagen)</label>
              <input id="rd" name="reregister_days" inputmode="numeric" value="7" />
              <div class="small mut">nur bei „zugelassen übergeben“</div>
            </div>
          </div>
          <h3>3. Zustand</h3>
          <div class="grid">
            <div>
              <label for="acc2">Unfallschäden</label>
              {sel(
                'accident',
                {
                  ja: 'keine bekannt (unfallfrei soweit bekannt)',
                  nein: 'ja – siehe Beschreibung',
                  unbekannt: 'nicht bekannt',
                },
                'ja',
                'acc2',
              )}
            </div>
            <div>
              <label for="dmg">Beschreibung Unfallschäden</label>
              <textarea id="dmg" name="damages" rows={2} />
            </div>
            <div>
              <label for="def">Bekannte Mängel / Schäden</label>
              <textarea
                id="def"
                name="defects"
                rows={2}
                placeholder="z. B. Kratzer Heckklappe, Klima ohne Funktion"
              />
            </div>
            <div>
              <label for="war">Gewährleistung</label>
              {sel('warranty', WARRANTY, 'einjahr', 'war')}
              <div class="small mut">
                An Privatpersonen darf eine GmbH die Gewährleistung nicht ausschließen, nur auf 1 Jahr
                verkürzen – und nur, wenn das gesondert vereinbart wird (§ 476 BGB; eigene Unterschrift im
                Vertrag).
              </div>
            </div>
          </div>
          <h3>4. Preis &amp; Steuer</h3>
          <div class="grid">
            <div>
              <label for="pr">Kaufpreis (€) *</label>
              <input id="pr" name="price" inputmode="decimal" required placeholder="z. B. 6.000,00" />
            </div>
            <div>
              <label for="pi">Betrag ist</label>
              {sel(
                'price_is',
                { brutto: 'Endpreis (inkl. USt)', netto: 'netto (zzgl. USt)' },
                'brutto',
                'pi',
              )}
            </div>
            <div>
              <label for="tm">Umsatzsteuer</label>
              {sel('tax_mode', TAX_MODES, 'ust19', 'tm')}
              <div class="small mut">
                Der Verkauf eines Firmenfahrzeugs ist <b>immer umsatzsteuerpflichtig (19 %)</b> – auch wenn es
                von privat ohne Vorsteuer gekauft wurde. Ohne Steuer nur: an ein Unternehmen in einem anderen
                EU-Land mit USt-IdNr. (Gelangensbestätigung aufbewahren), Ausfuhr außerhalb der EU
                (Ausfuhrnachweis) oder § 4 Nr. 28 UStG (bei uns praktisch nie). Differenzbesteuerung gibt es
                nur für Händler.
              </div>
            </div>
            <div>
              <label for="pay">Zahlung</label>
              {sel('payment', PAYMENT, 'ueberweisung', 'pay')}
            </div>
            <div>
              <label for="nt">Sonstige Vereinbarungen</label>
              <textarea id="nt" name="note" rows={2} />
            </div>
          </div>
          <div class="formfoot">
            <a class="btn ghost" href={`/fahrzeuge/${id}`}>
              Abbrechen
            </a>
            <button
              class="btn sec"
              formaction={`/fahrzeuge/${id}/verkauf/vorschau.pdf`}
              formtarget="_blank"
              data-noback
            >
              PDF-Vorschau
            </button>
            <button
              class="btn"
              data-noback
              data-confirm="Verkauf abschließen? Danach ist die Rechnung fest (nur noch Storno möglich)."
            >
              Verkauf abschließen
            </button>
          </div>
        </form>
      </>,
    );
  });

  app.post(`/fahrzeuge/:id{${UUID}}/verkauf/vorschau.pdf`, async (c) => {
    const v = await getVehicle(sql, c.req.param('id'));
    if (!v) return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const { data, amounts } = checkSale(v, saleInput(b));
    const pdf = await renderSalePdf(sql, { no: null, data, amounts });
    return c.body(pdf as never, 200, {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="Fahrzeugverkauf_Vorschau.pdf"',
    });
  });

  app.post(`/fahrzeuge/:id{${UUID}}/verkauf`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const fid = str(b, 'form_id');
    const row = await completeVehicleSale(
      sql,
      { dir: deps.env.FILES_DIR, maxBytes: deps.env.UPLOAD_MAX_BYTES },
      { id: fid && /^[0-9a-f-]{36}$/.test(fid) ? fid : randomUUID(), vehicleId: id, input: saleInput(b) },
      c.get('actor'),
    );
    return back(c, `/fahrzeuge/${id}`, {
      ok: `Verkauf ${row.sale_no} abgeschlossen – Kaufvertrag und Rechnung liegen unter „Verkauf“.`,
    });
  });

  app.post(`/fahrzeuge/:id{${UUID}}/verkauf/:sid{${UUID}}/storno`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const fid = str(b, 'form_id');
    const row = await cancelVehicleSale(
      sql,
      { dir: deps.env.FILES_DIR, maxBytes: deps.env.UPLOAD_MAX_BYTES },
      {
        id: fid && /^[0-9a-f-]{36}$/.test(fid) ? fid : randomUUID(),
        saleId: c.req.param('sid'),
        reason: str(b, 'reason') ?? '',
      },
      c.get('actor'),
    );
    return back(c, `/fahrzeuge/${id}`, {
      ok: `Storno ${row.sale_no} erstellt – Fahrzeug wieder im Bestand.`,
    });
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

const centsText = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')}`;
};

function lastOfMonth(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, 0));
  return d.toISOString().slice(0, 10);
}

const PLATE_CSS = `.plate{display:inline-block;font-weight:700;letter-spacing:.04em;border:2px solid #1c1a19;border-radius:4px;padding:1px 8px 1px 14px;background:#fff linear-gradient(90deg,#1f4fbf 0,#1f4fbf 8px,#fff 8px);color:#1c1a19;text-decoration:none;white-space:nowrap}`;

/** Kasten „Verkauf“ am Fahrzeug */
function SaleCard({ v, sale, sales }: { v: Vehicle; sale: SaleRow | null; sales: SaleRow[] }) {
  return (
    <div class="card">
      <h3>Verkauf</h3>
      {sale ? (
        <>
          <p style="margin:0 0 6px">
            <b>{sale.sale_no}</b> · verkauft am {dateDe(sale.sale_date)} an {sale.buyer_name}
          </p>
          <p class="small mut" style="margin:0 0 8px">
            {sale.vat_cents !== 0n
              ? `${euro(sale.gross_cents)} brutto (netto ${euro(sale.net_cents)} + 19 % USt ${euro(sale.vat_cents)})`
              : `${euro(sale.gross_cents)} · ${TAX_MODES[sale.tax_mode]}`}
          </p>
          {sale.file_id && (
            <a class="btn sm" href={`/dateien/${sale.file_id}`} target="_blank">
              Kaufvertrag &amp; Rechnung (PDF)
            </a>
          )}
          <details style="margin-top:10px">
            <summary>Verkauf stornieren …</summary>
            <form method="post" action={`/fahrzeuge/${v.id}/verkauf/${sale.id}/storno`}>
              <input type="hidden" name="form_id" value={randomUUID()} />
              <label for="sr">Grund *</label>
              <input id="sr" name="reason" required placeholder="z. B. Käufer ist vom Kauf zurückgetreten" />
              <button
                class="btn sm danger"
                data-confirm="Stornorechnung erstellen? Das Fahrzeug ist danach wieder im Bestand."
              >
                Stornorechnung erstellen
              </button>
            </form>
          </details>
        </>
      ) : (
        <>
          {v.sold_on && (
            <p class="small mut">
              Als verkauft eingetragen am {dateDe(v.sold_on)}
              {v.sale_price_cents != null && ` für ${euro(v.sale_price_cents)}`}
              {v.buyer && ` an ${v.buyer}`} (ohne Kaufvertrag aus der App).
            </p>
          )}
          <p class="small mut" style="margin-top:0">
            Kaufvertrag mit Übergabeangaben und Rechnung (mit 19 % USt oder steuerfrei) als PDF.
          </p>
          <a class="btn" href={`/fahrzeuge/${v.id}/verkauf`}>
            Fahrzeug verkaufen
          </a>
        </>
      )}
      {sales.length > (sale ? 1 : 0) && (
        <details style="margin-top:10px">
          <summary>Belege ({sales.length})</summary>
          <ul class="small" style="margin:6px 0 0;padding-left:18px">
            {sales.map((x) => (
              <li>
                {x.file_id ? (
                  <a href={`/dateien/${x.file_id}`} target="_blank">
                    {x.sale_no}
                  </a>
                ) : (
                  x.sale_no
                )}{' '}
                · {x.kind === 'storno' ? `Storno – ${x.reason ?? ''}` : `Verkauf an ${x.buyer_name}`} ·{' '}
                {dateDe(x.sale_date)} · {euro(x.gross_cents)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
