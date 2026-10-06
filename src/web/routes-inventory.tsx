import { LEGAL_FORMS } from '../services/subcontractors.js';
import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseQuantity } from '../domain/money/money.js';
import { listEmployees } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import {
  type Supplier,
  bookStock,
  getArticle,
  getDevice,
  getKey,
  getSupplier,
  keyAction,
  keyLog,
  listArticles,
  listDevices,
  listKeys,
  listMovements,
  listSuppliers,
  saveArticle,
  saveDevice,
  saveKey,
  saveSupplier,
  suggestArticleNo,
  suggestInventoryNo,
  suggestSupplierNo,
} from '../services/inventory.js';
import { listSites } from '../services/masterdata.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID, assertSite, inScope } from './app.js';
import { FileArea } from './files.js';
import { centsToInput, milliToInput } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';
import { Field } from './pages-masterdata.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);

/** Ablaufdatum mit Ampel: abgelaufen rot, ≤ 30 Tage gelb. */
const Expiry: FC<{ date: string | null; days: number | null; missing?: string }> = ({
  date,
  days,
  missing = 'fehlt',
}) =>
  !date ? (
    <span class="badge err">{missing}</span>
  ) : days !== null && days < 0 ? (
    <span class="badge err">abgelaufen {dateDe(date)}</span>
  ) : days !== null && days <= 30 ? (
    <span class="badge warn">bis {dateDe(date)}</span>
  ) : (
    <span class="badge ok">bis {dateDe(date)}</span>
  );

const Check = ({ name, label, checked }: { name: string; label: string; checked: boolean }) => (
  <div class="chk" style="align-self:end;height:38px">
    <input type="checkbox" id={name} name={name} checked={checked} />
    <label for={name}>{label}</label>
  </div>
);

/** Rücksprung auf die Schlüssel-Seite eines Objekts (nur diese Adresse wird akzeptiert). */
const siteBack = (v: unknown) =>
  typeof v === 'string' && /^\/objekte\/[0-9a-f-]{36}\/schluessel$/.test(v) ? v : null;

export function registerInventoryRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  // ================================================================== Lieferanten & Nachunternehmer

  app.get('/lieferanten', async (c) => {
    const kind = c.req.query('art');
    const all = await listSuppliers(sql);
    let rows = [...all];
    if (kind === 'lieferant' || kind === 'nachunternehmer') rows = rows.filter((r) => r.kind === kind);
    const tabs: Tab[] = [
      { key: '', label: 'Alle', href: '/lieferanten', count: all.length },
      {
        key: 'lieferant',
        label: 'Lieferanten',
        href: '/lieferanten?art=lieferant',
        count: all.filter((r) => r.kind === 'lieferant').length,
      },
      {
        key: 'nachunternehmer',
        label: 'Nachunternehmer',
        href: '/lieferanten?art=nachunternehmer',
        count: all.filter((r) => r.kind === 'nachunternehmer').length,
      },
    ];
    return page(
      c,
      'Lieferanten',
      'lieferanten',
      <>
        <PageHead title="Lieferanten & Nachunternehmer">
          <a class="btn" href={`/lieferanten/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            <Icon name="plus" /> Neu anlegen
          </a>
        </PageHead>
        <Tabs tabs={tabs} active={kind ?? ''} />
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Name</th>
                <th>Art</th>
                <th>Kontakt</th>
                <th>Freistellung § 48b</th>
                <th>Unbedenklichkeit</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={6}>
                    <div class="empty">Noch keine Einträge.</div>
                  </td>
                </tr>
              )}
              {rows.map((s) => (
                <tr style={s.active ? '' : 'opacity:.55'}>
                  <td>{s.supplier_no}</td>
                  <td>
                    <a href={`/lieferanten/${s.id}`}>
                      <b>{s.name}</b>
                    </a>
                    <div class="small mut">{[s.postal_code, s.city].filter(Boolean).join(' ')}</div>
                  </td>
                  <td>
                    {s.kind === 'nachunternehmer' ? (
                      <span class="badge kind">Nachunternehmer</span>
                    ) : (
                      <span class="badge">Lieferant</span>
                    )}
                  </td>
                  <td class="small">
                    {s.contact_name}
                    {s.phone && <div>{s.phone}</div>}
                  </td>
                  <td>
                    {s.kind === 'nachunternehmer' ? (
                      <Expiry date={s.exemption_valid_until} days={s.exemption_days} />
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {s.kind === 'nachunternehmer' ? (
                      <Expiry date={s.clearance_valid_until} days={s.clearance_days} />
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/lieferanten/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const s = await getSupplier(sql, id);
    if (!s) return c.redirect(`/lieferanten/${id}/bearbeiten`);
    const files = await listFiles(sql, { type: 'supplier', id });
    const articles = (await listArticles(sql)).filter((a) => a.supplier_id === id);
    const today = todayBerlin();
    const exp = (d: string | null) => (d ? Math.round((Date.parse(d) - Date.parse(today)) / 86400000) : null);
    return page(
      c,
      s.name,
      'lieferanten',
      <>
        <PageHead title={s.name} no={s.supplier_no} crumbs={[['Lieferanten', '/lieferanten']]}>
          <a class="btn sec" href={`/lieferanten/${id}/bearbeiten`} style="margin-left:auto">
            Bearbeiten
          </a>
        </PageHead>
        {s.kind === 'nachunternehmer' && (
          <div class="actions" style="margin-top:0">
            <a class="btn" href={`/lieferanten/${id}/nachweise`}>
              Nachweise, Aufträge, Portal, Kündigung
            </a>
          </div>
        )}
        {s.kind === 'nachunternehmer' &&
          (!s.exemption_valid_until || (exp(s.exemption_valid_until) ?? 0) < 0) && (
            <div class="flash err">
              <Icon name="alert" />
              <span>
                Keine gültige Freistellungsbescheinigung (§ 48b EStG): Von Zahlungen für Bauleistungen müssen
                15 % Bauabzugsteuer einbehalten und ans Finanzamt abgeführt werden. Gebäudereinigung gilt in
                der Regel nicht als Bauleistung – mit dem Steuerberater klären, welche Leistungen betroffen
                sind.
              </span>
            </div>
          )}
        <div class="cols">
          <div>
            <div class="card">
              <h3>Nachweise & Dokumente</h3>
              <p class="small mut" style="margin-top:0">
                Freistellungsbescheinigung, Unbedenklichkeitsbescheinigungen (Krankenkasse, BG, SOKA),
                Mindestlohnerklärung, Verträge.
              </p>
              <FileArea
                link={{ type: 'supplier', id }}
                files={files}
                category="Nachweis"
                maxBytes={env.UPLOAD_MAX_BYTES}
              />
            </div>
            {articles.length > 0 && (
              <div class="card">
                <h3>Artikel von diesem Lieferanten</h3>
                {articles.map((a) => (
                  <div class="small">
                    <a href={`/artikel/${a.id}`}>{a.name}</a> – Bestand {milliToInput(a.stock_milli)} {a.unit}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div class="card">
            <dl class="kv">
              <dt>Art</dt>
              <dd>{s.kind === 'nachunternehmer' ? 'Nachunternehmer' : 'Lieferant'}</dd>
              <dt>Anschrift</dt>
              <dd>
                {s.street}
                <br />
                {s.postal_code} {s.city}
              </dd>
              <dt>Ansprechpartner</dt>
              <dd>{s.contact_name ?? '–'}</dd>
              <dt>E-Mail</dt>
              <dd>{s.email ? <a href={`mailto:${s.email}`}>{s.email}</a> : '–'}</dd>
              <dt>Telefon</dt>
              <dd>{s.phone ?? '–'}</dd>
              <dt>USt-ID</dt>
              <dd>{s.vat_id ?? '–'}</dd>
              <dt>Bank</dt>
              <dd>{s.iban ? `${s.iban.replace(/(.{4})/g, '$1 ').trim()} ${s.bic ?? ''}` : '–'}</dd>
              <dt>Zahlungsziel</dt>
              <dd>{s.payment_terms_days} Tage</dd>
              {s.kind === 'nachunternehmer' && (
                <>
                  <dt>Freistellung § 48b</dt>
                  <dd>
                    <Expiry date={s.exemption_valid_until} days={exp(s.exemption_valid_until)} />
                  </dd>
                  <dt>Unbedenklichkeit</dt>
                  <dd>
                    <Expiry date={s.clearance_valid_until} days={exp(s.clearance_valid_until)} />
                  </dd>
                </>
              )}
              {s.notes && (
                <>
                  <dt>Notiz</dt>
                  <dd style="white-space:pre-line">{s.notes}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </>,
    );
  });

  app.get(`/lieferanten/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const found = await getSupplier(sql, id);
    const s: Partial<Supplier> = found ?? {
      supplier_no: await suggestSupplierNo(sql),
      kind: 'lieferant',
      payment_terms_days: 30,
      active: true,
    };
    const isNew = !found;
    return page(
      c,
      isNew ? 'Neuer Lieferant' : (s.name ?? ''),
      'lieferanten',
      <>
        <PageHead
          title={isNew ? 'Neuer Lieferant / Nachunternehmer' : `${s.name} bearbeiten`}
          crumbs={[['Lieferanten', '/lieferanten']]}
        />
        <form
          method="post"
          action={`/lieferanten/${id}`}
          class="card"
          data-autosave={`/lieferanten/${id}`}
          data-version={String(s.version ?? '')}
        >
          <input type="hidden" name="version" value={String(s.version ?? '')} />
          <div class="grid">
            <Field name="supplier_no" label="Nummer" value={s.supplier_no} required />
            <Field name="name" label="Name" value={s.name} required />
            <div>
              <label for="kind">Art</label>
              <select id="kind" name="kind">
                <option value="lieferant" selected={s.kind === 'lieferant'}>
                  Lieferant (Material, Geräte)
                </option>
                <option value="nachunternehmer" selected={s.kind === 'nachunternehmer'}>
                  Nachunternehmer (Leistungen)
                </option>
              </select>
            </div>
            <div>
              <label for="legal_form">Rechtsform</label>
              <select id="legal_form" name="legal_form">
                <option value="">–</option>
                {Object.entries(LEGAL_FORMS).map(([k, v]) => (
                  <option value={k} selected={k === s.legal_form}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <Field name="street" label="Straße" value={s.street} />
            <Field name="postal_code" label="PLZ" value={s.postal_code} />
            <Field name="city" label="Ort" value={s.city} />
            <Field name="contact_name" label="Ansprechpartner" value={s.contact_name} />
            <Field name="email" label="E-Mail" value={s.email} type="email" />
            <Field name="phone" label="Telefon" value={s.phone} />
            <Field name="vat_id" label="USt-ID" value={s.vat_id} />
            <Field name="iban" label="IBAN" value={s.iban} />
            <Field name="bic" label="BIC" value={s.bic} />
            <Field
              name="payment_terms_days"
              label="Zahlungsziel (Tage)"
              value={s.payment_terms_days}
              type="number"
            />
          </div>
          <h2>Nachunternehmer-Nachweise</h2>
          <p class="small mut" style="margin-top:0">
            Werden beim Hochladen/Prüfen der Nachweise (Reiter „Nachweise“) automatisch gesetzt.
          </p>
          <div class="grid">
            <Field
              name="exemption_valid_until"
              label="Freistellungsbescheinigung § 48b gültig bis"
              value={s.exemption_valid_until}
              type="date"
            />
            <Field
              name="clearance_valid_until"
              label="Unbedenklichkeitsbescheinigungen gültig bis"
              value={s.clearance_valid_until}
              type="date"
            />
            <Check name="active" label="Aktiv" checked={s.active !== false} />
          </div>
          <div style="margin-top:12px">
            <label for="notes">Notiz</label>
            <textarea id="notes" name="notes">
              {s.notes ?? ''}
            </textarea>
          </div>
          <div class="formfoot">
            <a class="btn sec" href={isNew ? '/lieferanten' : `/lieferanten/${id}`}>
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post(`/lieferanten/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    await saveSupplier(sql, id, body, versionOf(body.version), c.get('actor'));
    return back(c, `/lieferanten/${id}`, { ok: 'Gespeichert.' });
  });

  // ================================================================== Artikel & Nachbestellung

  app.get('/artikel', async (c) => {
    const reorder = c.req.query('ansicht') === 'nachbestellen';
    const all = await listArticles(sql);
    const low = all.filter((a) => a.active && a.stock_milli <= a.min_stock_milli);
    const rows = reorder ? low : all;
    return page(
      c,
      'Artikel',
      'inventar',
      <>
        <PageHead title="Artikel & Nachbestellung">
          <a class="btn" href={`/artikel/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            <Icon name="plus" /> Artikel anlegen
          </a>
        </PageHead>
        <Tabs
          tabs={[
            { key: 'alle', label: 'Alle Artikel', href: '/artikel', count: all.length },
            {
              key: 'nach',
              label: 'Nachbestellen',
              href: '/artikel?ansicht=nachbestellen',
              count: low.length,
            },
          ]}
          active={reorder ? 'nach' : 'alle'}
        />
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Bezeichnung</th>
                <th>Lieferant</th>
                <th class="r">Bestand</th>
                <th class="r">Mindestbestand</th>
                <th class="r">EK-Preis</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={6}>
                    <div class="empty">{reorder ? 'Nichts nachzubestellen.' : 'Noch keine Artikel.'}</div>
                  </td>
                </tr>
              )}
              {rows.map((a) => (
                <tr style={a.active ? '' : 'opacity:.55'}>
                  <td>{a.article_no}</td>
                  <td>
                    <a href={`/artikel/${a.id}`}>
                      <b>{a.name}</b>
                    </a>
                  </td>
                  <td>
                    {a.supplier_id ? <a href={`/lieferanten/${a.supplier_id}`}>{a.supplier_name}</a> : '–'}
                  </td>
                  <td class="r">
                    {a.stock_milli <= a.min_stock_milli && a.active ? (
                      <span class="badge err">
                        {milliToInput(a.stock_milli)} {a.unit}
                      </span>
                    ) : (
                      `${milliToInput(a.stock_milli)} ${a.unit}`
                    )}
                  </td>
                  <td class="r">
                    {milliToInput(a.min_stock_milli)} {a.unit}
                  </td>
                  <td class="r">{a.purchase_price_cents !== null ? euro(a.purchase_price_cents) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/artikel/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const a = await getArticle(sql, id);
    if (!a) return c.redirect(`/artikel/${id}/bearbeiten`);
    const [moves, sites] = await Promise.all([listMovements(sql, id), listSites(sql)]);
    return page(
      c,
      a.name,
      'inventar',
      <>
        <PageHead title={a.name} no={a.article_no} crumbs={[['Artikel', '/artikel']]}>
          <a class="btn sec" href={`/artikel/${id}/bearbeiten`} style="margin-left:auto">
            Bearbeiten
          </a>
          <a class="btn" href={`/bestellungen/${randomUUID()}/bearbeiten?artikel=${id}`}>
            Nachbestellen
          </a>
        </PageHead>
        <div class="kpis">
          <div class="kpi">
            <div class="l">Bestand</div>
            <div class="v" style={a.stock_milli <= a.min_stock_milli ? 'color:var(--err)' : ''}>
              {milliToInput(a.stock_milli)} {a.unit}
            </div>
            <div class="s">
              Mindestbestand {milliToInput(a.min_stock_milli)} {a.unit}
            </div>
          </div>
          <div class="kpi">
            <div class="l">Lagerwert (EK)</div>
            <div class="v">
              {a.purchase_price_cents !== null ? euro((a.purchase_price_cents * a.stock_milli) / 1000n) : '–'}
            </div>
          </div>
        </div>
        <div class="cols">
          <div class="card flush">
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Zeitpunkt</th>
                    <th>Grund</th>
                    <th>Objekt</th>
                    <th class="r">Menge</th>
                    <th>von</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.length === 0 && (
                    <tr>
                      <td colspan={5}>
                        <div class="empty">Noch keine Buchungen.</div>
                      </td>
                    </tr>
                  )}
                  {moves.map((m) => (
                    <tr>
                      <td class="small">
                        {m.created_at.toLocaleString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </td>
                      <td>{m.reason}</td>
                      <td>{m.site_name ?? '–'}</td>
                      <td class="r" style={m.delta_milli < 0n ? 'color:var(--err)' : 'color:var(--ok)'}>
                        {m.delta_milli > 0n ? '+' : ''}
                        {milliToInput(m.delta_milli)}
                      </td>
                      <td class="small">{m.created_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <form method="post" action={`/artikel/${id}/buchen`} class="card">
            <h3>Bestand buchen</h3>
            <input type="hidden" name="move_id" value={randomUUID()} />
            <div class="grid">
              <div>
                <label for="dir">Art</label>
                <select id="dir" name="dir">
                  <option value="in">Zugang (Lieferung)</option>
                  <option value="out">Abgang (Ausgabe an Objekt)</option>
                  <option value="fix">Inventurkorrektur (±)</option>
                </select>
              </div>
              <div>
                <label for="qty">Menge ({a.unit})</label>
                <input id="qty" name="qty" required placeholder="z. B. 12" />
              </div>
              <div>
                <label for="site_id">Objekt (bei Ausgabe)</label>
                <select id="site_id" name="site_id">
                  <option value="">–</option>
                  {sites.map((s) => (
                    <option value={s.id}>
                      {s.site_no} · {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="reason">Grund / Beleg</label>
                <input id="reason" name="reason" placeholder="z. B. Lieferschein 4711" />
              </div>
            </div>
            <div class="formfoot">
              <button class="btn">Buchen</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/artikel/:id{${UUID}}/buchen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    let qty: bigint;
    try {
      qty = parseQuantity(String(b.qty ?? ''));
    } catch {
      throw new BusinessError('Menge ungültig');
    }
    const dir = String(b.dir);
    if (dir !== 'fix' && qty < 0n) throw new BusinessError('Menge bitte ohne Vorzeichen angeben');
    const delta = dir === 'out' ? -qty : qty;
    const reason =
      String(b.reason ?? '').trim() ||
      (dir === 'in' ? 'Zugang' : dir === 'out' ? 'Ausgabe' : 'Inventurkorrektur');
    const moveId =
      typeof b.move_id === 'string' && /^[0-9a-f-]{36}$/.test(b.move_id) ? b.move_id : randomUUID();
    await bookStock(
      sql,
      moveId,
      id,
      delta,
      reason,
      typeof b.site_id === 'string' && b.site_id ? b.site_id : null,
      c.get('actor'),
    );
    return back(c, `/artikel/${id}`, { ok: 'Gebucht.' });
  });

  app.get(`/artikel/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const a = await getArticle(sql, id);
    const suppliers = (await listSuppliers(sql)).filter((s) => s.active && s.kind === 'lieferant');
    const no = a?.article_no ?? (await suggestArticleNo(sql));
    return page(
      c,
      a ? a.name : 'Neuer Artikel',
      'inventar',
      <>
        <PageHead title={a ? `${a.name} bearbeiten` : 'Neuer Artikel'} crumbs={[['Artikel', '/artikel']]} />
        <form
          method="post"
          action={`/artikel/${id}`}
          class="card"
          data-autosave={`/artikel/${id}`}
          data-version={String(a?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(a?.version ?? '')} />
          <div class="grid">
            <Field name="article_no" label="Artikelnummer" value={no} required />
            <Field name="name" label="Bezeichnung" value={a?.name} required />
            <Field
              name="unit"
              label="Einheit"
              value={a?.unit ?? 'Stk.'}
              placeholder="Stk., Kanister, Karton"
            />
            <Field
              name="min_stock"
              label="Mindestbestand"
              value={a ? milliToInput(a.min_stock_milli) : '0'}
            />
            <div>
              <label for="supplier_id">Lieferant</label>
              <select id="supplier_id" name="supplier_id">
                <option value="">–</option>
                {suppliers.map((s) => (
                  <option value={s.id} selected={s.id === a?.supplier_id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Field
              name="purchase_price"
              label="Einkaufspreis € (netto)"
              value={a?.purchase_price_cents != null ? centsToInput(a.purchase_price_cents) : ''}
            />
            <Check name="active" label="Aktiv" checked={a?.active !== false} />
          </div>
          {!a && <p class="small mut">Anfangsbestand nach dem Speichern über „Bestand buchen“ erfassen.</p>}
          <div class="formfoot">
            <a class="btn sec" href={a ? `/artikel/${id}` : '/artikel'}>
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post(`/artikel/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    await saveArticle(sql, id, body, versionOf(body.version), c.get('actor'));
    return back(c, `/artikel/${id}`, { ok: 'Artikel gespeichert.' });
  });

  // ================================================================== Geräte & Prüftermine

  app.get('/geraete', async (c) => {
    const rows = inScope(c, await listDevices(sql));
    const due = rows.filter((d) => d.active && d.days !== null && d.days <= 30);
    return page(
      c,
      'Geräte',
      'inventar',
      <>
        <PageHead title="Geräte & Prüftermine">
          <a class="btn" href={`/geraete/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            <Icon name="plus" /> Gerät anlegen
          </a>
        </PageHead>
        {due.length > 0 && (
          <div class="warnbox">
            <h3>Prüfung fällig (≤ 30 Tage)</h3>
            {due.map((d) => (
              <div>
                <a href={`/geraete/${d.id}/bearbeiten`}>{d.name}</a> ({d.inventory_no}) –{' '}
                {dateDe(d.next_inspection)}
              </div>
            ))}
            <p class="small" style="margin:8px 0 0">
              Elektrische Geräte (Sauger, Scheuersaugmaschinen) regelmäßig nach DGUV V3 prüfen lassen.
            </p>
          </div>
        )}
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Inv.-Nr.</th>
                <th>Gerät</th>
                <th>Hersteller / Serien-Nr.</th>
                <th>Standort</th>
                <th>Nächste Prüfung</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={5}>
                    <div class="empty">Noch keine Geräte.</div>
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr style={d.active ? '' : 'opacity:.55'}>
                  <td>{d.inventory_no}</td>
                  <td>
                    <a href={`/geraete/${d.id}/bearbeiten`}>
                      <b>{d.name}</b>
                    </a>
                  </td>
                  <td class="small">
                    {d.manufacturer ?? '–'}
                    {d.serial_no && <div class="mut">SN {d.serial_no}</div>}
                  </td>
                  <td>{d.site_id ? <a href={`/objekte/${d.site_id}`}>{d.site_name}</a> : 'Lager'}</td>
                  <td>{d.next_inspection ? <Expiry date={d.next_inspection} days={d.days} /> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/geraete/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const d = await getDevice(sql, id);
    const sites = await listSites(sql);
    const no = d?.inventory_no ?? (await suggestInventoryNo(sql));
    return page(
      c,
      d ? d.name : 'Neues Gerät',
      'inventar',
      <>
        <PageHead title={d ? d.name : 'Neues Gerät'} no={d?.inventory_no} crumbs={[['Geräte', '/geraete']]} />
        <form
          method="post"
          action={`/geraete/${id}`}
          class="card"
          data-autosave={`/geraete/${id}`}
          data-version={String(d?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(d?.version ?? '')} />
          <div class="grid">
            <Field name="inventory_no" label="Inventarnummer" value={no} required />
            <Field
              name="name"
              label="Bezeichnung"
              value={d?.name}
              required
              placeholder="z. B. Scheuersaugmaschine"
            />
            <Field name="manufacturer" label="Hersteller / Modell" value={d?.manufacturer} />
            <Field name="serial_no" label="Seriennummer" value={d?.serial_no} />
            <div>
              <label for="site_id">Standort</label>
              <select id="site_id" name="site_id">
                <option value="">Lager / Büro</option>
                {sites.map((s) => (
                  <option value={s.id} selected={s.id === d?.site_id}>
                    {s.site_no} · {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Field name="purchase_date" label="Anschaffung" value={d?.purchase_date} type="date" />
            <Field
              name="next_inspection"
              label="Nächste Prüfung (DGUV V3)"
              value={d?.next_inspection}
              type="date"
            />
            <Check name="active" label="Aktiv" checked={d?.active !== false} />
          </div>
          <div style="margin-top:12px">
            <label for="notes">Notiz</label>
            <textarea id="notes" name="notes">
              {d?.notes ?? ''}
            </textarea>
          </div>
          <div class="formfoot">
            <a class="btn sec" href="/geraete">
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post(`/geraete/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    await saveDevice(sql, id, body, versionOf(body.version), c.get('actor'));
    return back(c, '/geraete', { ok: 'Gerät gespeichert.' });
  });

  // ================================================================== Schlüsselbuch

  app.get('/schluessel', async (c) => {
    const rows = inScope(c, await listKeys(sql));
    const out = rows.filter((k) => k.holder_employee_id).length;
    return page(
      c,
      'Schlüsselbuch',
      'inventar',
      <>
        <PageHead title="Schlüsselbuch">
          <a class="btn" href={`/schluessel/${randomUUID()}`} style="margin-left:auto">
            <Icon name="plus" /> Schlüssel erfassen
          </a>
        </PageHead>
        <p class="mut" style="margin-top:-8px">
          {rows.length} Schlüssel, davon {out} ausgegeben. Jede Ausgabe und Rückgabe wird unveränderbar
          protokolliert.
        </p>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Objekt</th>
                <th>Beschreibung</th>
                <th class="r">Anzahl</th>
                <th>Bei</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={5}>
                    <div class="empty">Noch keine Schlüssel erfasst.</div>
                  </td>
                </tr>
              )}
              {rows.map((k) => (
                <tr>
                  <td>
                    <a href={`/schluessel/${k.id}`}>
                      <b>{k.key_no}</b>
                    </a>
                  </td>
                  <td>
                    <a href={`/objekte/${k.site_id}`}>{k.site_name}</a>
                    <div class="small mut">{k.site_no}</div>
                  </td>
                  <td>{k.description}</td>
                  <td class="r">{k.quantity}</td>
                  <td>
                    {k.holder_name ? (
                      <>
                        <span class="badge warn">{k.holder_name}</span>
                        <div class="small mut">seit {dateDe(k.issued_at)}</div>
                      </>
                    ) : (
                      <span class="badge ok">im Büro</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/schluessel/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [k, sites, employees, log] = await Promise.all([
      getKey(sql, id),
      listSites(sql).then((l) => l.filter((s) => !c.get('sites') || c.get('sites')!.includes(s.id))),
      listEmployees(sql, { status: 'aktiv' }),
      keyLog(sql, id),
    ]);
    if (k) assertSite(c, k.site_id);
    const holder = k?.holder_employee_id ? employees.find((e) => e.id === k.holder_employee_id) : undefined;
    return page(
      c,
      k ? `Schlüssel ${k.key_no}` : 'Neuer Schlüssel',
      'inventar',
      <>
        <PageHead
          title={k ? k.description : 'Neuer Schlüssel'}
          no={k?.key_no}
          crumbs={[['Schlüsselbuch', '/schluessel']]}
        />
        <div class="cols">
          <form
            method="post"
            action={`/schluessel/${id}`}
            class="card"
            data-autosave={`/schluessel/${id}`}
            data-version={String(k?.version ?? '')}
          >
            <input type="hidden" name="version" value={String(k?.version ?? '')} />
            <div class="grid">
              <Field
                name="key_no"
                label="Schlüsselnummer"
                value={k?.key_no}
                required
                placeholder="z. B. S-2990101-01"
              />
              <div>
                <label for="site_id">Objekt</label>
                <select id="site_id" name="site_id" required>
                  <option value="">– bitte wählen –</option>
                  {sites.map((s) => (
                    <option value={s.id} selected={s.id === k?.site_id}>
                      {s.site_no} · {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                name="description"
                label="Beschreibung"
                value={k?.description}
                required
                placeholder="Haupteingang, Technikraum …"
              />
              <Field name="quantity" label="Anzahl" value={k?.quantity ?? 1} type="number" />
            </div>
            <div style="margin-top:12px">
              <label for="notes">Notiz</label>
              <textarea id="notes" name="notes">
                {k?.notes ?? ''}
              </textarea>
            </div>
            <div class="formfoot">
              <a class="btn sec" href="/schluessel">
                Zurück
              </a>
              <button class="btn">Speichern</button>
            </div>
          </form>
          {k && (
            <div>
              <form method="post" action={`/schluessel/${id}/buchen`} class="card">
                <h3>
                  {holder ? `Ausgegeben an ${holder.last_name}, ${holder.first_name ?? ''}` : 'Im Büro'}
                </h3>
                <div class="grid">
                  {!holder && (
                    <div>
                      <label for="employee_id">An Mitarbeiter</label>
                      <select id="employee_id" name="employee_id" required>
                        <option value="">– bitte wählen –</option>
                        {employees.map((e) => (
                          <option value={e.id}>
                            {e.last_name}, {e.first_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <Field name="at" label="Datum" value={todayBerlin()} type="date" required />
                  <Field name="note" label="Notiz" />
                </div>
                <div class="actions" style="margin-bottom:0">
                  {holder ? (
                    <>
                      <button class="btn" name="action" value="rueckgabe">
                        Rückgabe buchen
                      </button>
                      <button
                        class="btn danger"
                        name="action"
                        value="verlust"
                        onclick="return confirm('Schlüssel als verloren melden?')"
                      >
                        Verlust melden
                      </button>
                    </>
                  ) : (
                    <button class="btn" name="action" value="ausgabe">
                      Ausgabe buchen
                    </button>
                  )}
                </div>
              </form>
              <div class="card">
                <h3>Protokoll</h3>
                {log.length === 0 && <div class="mut small">Noch keine Bewegungen.</div>}
                {log.map((l) => (
                  <div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)">
                    <b>{dateDe(l.at)}</b> ·{' '}
                    {{ ausgabe: 'Ausgabe an', rueckgabe: 'Rückgabe von', verlust: 'Verlust bei' }[l.action]}{' '}
                    {l.employee_name}
                    {l.note && ` – ${l.note}`} <span class="mut">({l.created_by})</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </>,
    );
  });

  app.post(`/schluessel/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const cur = await getKey(sql, id);
    if (cur) assertSite(c, cur.site_id);
    assertSite(c, String(body.site_id ?? ''));
    await saveKey(sql, id, body, versionOf(body.version), c.get('actor'));
    return back(c, siteBack(body.back) ?? `/schluessel/${id}`, { ok: 'Schlüssel gespeichert.' });
  });

  app.post(`/schluessel/:id{${UUID}}/buchen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const action = String(b.action) as 'ausgabe' | 'rueckgabe' | 'verlust';
    if (!['ausgabe', 'rueckgabe', 'verlust'].includes(action)) throw new BusinessError('Ungültige Aktion');
    const at = typeof b.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.at) ? b.at : todayBerlin();
    assertSite(c, (await getKey(sql, id))?.site_id);
    await keyAction(
      sql,
      id,
      action,
      typeof b.employee_id === 'string' && b.employee_id ? b.employee_id : null,
      at,
      typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
      c.get('actor'),
    );
    return back(c, siteBack(b.back) ?? `/schluessel/${id}`, { ok: 'Gebucht.' });
  });
}
