import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import {
  articleMoves,
  bookStock,
  closeHandoverWithoutSignature,
  declaration,
  deleteDraft,
  type Direction,
  getHandover,
  HANDOVER_KIND,
  HANDOVER_STATUS,
  handoverPdf,
  type HandoverItem,
  type HandoverKind,
  type HandoverRow,
  type HandoverStatus,
  holdings,
  listArticles,
  listHandovers,
  saveArticle,
  saveHandover,
  signHandover,
  stock,
  WAGE_DEDUCTION_TEXT,
} from '../services/handovers.js';
import { listHandoverObjects } from '../services/vehicles.js';
import { type AppEnv, assertSite, type Ctx, UUID } from './app.js';
import { arr, centsToInput, str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';
import { SIGN_JS } from './routes-orders.js';

const STATUS_CLASS: Record<HandoverStatus, string> = {
  entwurf: 'warn',
  unterschrieben: 'ok',
  ohne_unterschrift: 'info',
  storniert: 'err',
};
const KINDS = Object.keys(HANDOVER_KIND) as HandoverKind[];
/** Neu anlegbar: Schlüssel laufen über das Schlüsselbuch (Objekt → Schlüssel), nicht über Übergaben. */
const NEW_KINDS = KINDS.filter((k) => k !== 'schluessel');
const berlin = (d: Date) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });

// Größen-Auswahl folgt dem gewählten Artikel (Datalist je Artikel)
const SIZE_JS = `
document.querySelectorAll('select[name=item_article]').forEach(function(s){
  s.addEventListener('change',function(){
    var z=s.closest('tr').querySelector('select[name=item_size]'); if(!z) return;
    var o=s.options[s.selectedIndex], sizes=(o&&o.getAttribute('data-sizes')||'').split('|').filter(Boolean), cur=z.value;
    z.innerHTML='<option value="">–</option>';
    sizes.forEach(function(v){var x=document.createElement('option');x.value=v;x.textContent=v;if(v===cur)x.selected=true;z.appendChild(x)});
  });
});`;
// „anderer Gegenstand …“ / „andere Person …“ blendet das Eingabefeld ein
const OTHER_JS = `
document.querySelectorAll('select[data-other-row]').forEach(function(s){
  var i=s.closest('td').querySelector('input[name=item_label]');
  function upd(){ if(!i) return; var o=s.value==='__andere'; i.hidden=!o; if(!o) i.value=''; else i.focus(); }
  s.addEventListener('change',upd);
});
document.querySelectorAll('select[data-other]').forEach(function(s){
  var box=document.getElementById(s.getAttribute('data-other'));
  s.addEventListener('change',function(){ if(box){ box.hidden = s.value!=='__andere'; } });
});`;

export const HandoverTable: FC<{ rows: HandoverRow[]; showSite?: boolean }> = ({ rows, showSite = true }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Nr.</th>
          <th>Datum</th>
          <th>Art</th>
          <th>Empfänger</th>
          {showSite && <th>Objekt</th>}
          <th>Inhalt</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr>
            <td>
              <a href={`/uebergaben/${h.id}`} style="white-space:nowrap">
                {h.number}
              </a>
            </td>
            <td>{dateDe(h.handover_date)}</td>
            <td>
              <span class="badge kind">
                {h.direction === 'rueckgabe' ? 'Rückgabe' : 'Ausgabe'} · {HANDOVER_KIND[h.kind]}
              </span>
            </td>
            <td>{h.recipient_name}</td>
            {showSite && <td class="small">{h.site_name ?? '–'}</td>}
            <td class="small">
              {h.kind === 'dokument'
                ? h.title
                : h.items
                    .map((i) => `${i.qty}× ${i.label}${i.size ? ` (${i.size})` : ''}`)
                    .join(', ')
                    .slice(0, 90)}
            </td>
            <td>
              <span class={`badge ${STATUS_CLASS[h.status]}`}>{HANDOVER_STATUS[h.status]}</span>
            </td>
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <td colspan={7}>
              <div class="empty">Keine Übergaben.</div>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

export function registerHandoverRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql } = deps;
  const stockRole = (role: string) => ['admin', 'buchhaltung', 'personal'].includes(role);

  /** Mitarbeitende zur Auswahl: Objektleitung nur die ihrer Objekte. */
  async function employeesFor(c: Context<AppEnv>) {
    const scope = c.get('sites');
    return sql<{ id: string; personnel_no: string; first_name: string; last_name: string }[]>`
      select e.id, e.personnel_no, e.first_name, e.last_name from app.employees e
       where e.status = 'aktiv'
         and (${scope === null} or exists (select 1 from app.employee_sites es
                                            where es.employee_id = e.id and es.site_id = any(${scope ?? []}::uuid[])))
       order by e.last_name, e.first_name`;
  }
  async function sitesFor(c: Context<AppEnv>) {
    const scope = c.get('sites');
    return (
      await sql<{ id: string; site_no: string; name: string }[]>`
        select id, site_no, name from app.sites where active order by name`
    ).filter((s) => !scope || scope.includes(s.id));
  }
  async function load(c: Context<AppEnv>, id: string) {
    const h = await getHandover(sql, id);
    if (h && c.get('sites')) assertSite(c, h.site_id);
    return h;
  }

  // ------------------------------------------------------------------ Liste
  app.get('/uebergaben', async (c) => {
    const kq = c.req.query('art');
    const kind = kq && kq in HANDOVER_KIND ? (kq as HandoverKind) : null;
    const sq = c.req.query('status');
    const status = sq && sq in HANDOVER_STATUS ? (sq as HandoverStatus) : null;
    const q = c.req.query('q') ?? '';
    const rows = await listHandovers(sql, { scope: c.get('sites'), kind, status, q });
    const role = c.get('user').role;
    return page(
      c,
      'Übergaben',
      'inventar',
      <>
        <PageHead title="Übergaben mit Unterschrift" />
        <p class="mut" style="max-width:900px;margin-top:0">
          Arbeitskleidung, Geräte, Dokumente/Unterweisungen und sonstige Gegenstände (Diensthandy, Tankkarte
          …) an Mitarbeitende oder Nachunternehmer übergeben und direkt am Handy/Tablet unterschreiben lassen.
          Erst mit der Unterschrift wird der Bestand gebucht; danach ist das Protokoll unveränderbar.
          Schlüssel gibt es im <a href="/schluessel">Schlüsselbuch</a> bzw. am Objekt unter „Schlüssel“.
          {stockRole(role) && (
            <>
              {' '}
              Kleidungsbestand und Artikel: <a href="/arbeitskleidung">Einstellungen → Arbeitskleidung</a>.
            </>
          )}
        </p>
        <div class="actions" style="margin-top:0">
          {NEW_KINDS.map((k) => (
            <a class="btn sm" href={`/uebergaben/${randomUUID()}?art=${k}`}>
              + {HANDOVER_KIND[k]}
            </a>
          ))}
        </div>
        <form method="get" class="actions">
          <select name="art" onchange="this.form.submit()" aria-label="Art" style="max-width:220px">
            <option value="">Alle Arten</option>
            {KINDS.map((k) => (
              <option value={k} selected={k === kind}>
                {HANDOVER_KIND[k]}
              </option>
            ))}
          </select>
          <select name="status" onchange="this.form.submit()" aria-label="Status" style="max-width:220px">
            <option value="">Alle Status</option>
            {(Object.keys(HANDOVER_STATUS) as HandoverStatus[])
              .filter((s) => s !== 'storniert')
              .map((s) => (
                <option value={s} selected={s === status}>
                  {HANDOVER_STATUS[s]}
                </option>
              ))}
          </select>
          <input name="q" value={q} placeholder="Name, Nr., Titel" style="max-width:240px" />
          <button class="btn sec sm">Suchen</button>
          <span class="small mut">{rows.length} Einträge</span>
        </form>
        <div class="card">
          <HandoverTable rows={rows} />
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Anlegen / Bearbeiten / Ansicht
  app.get(`/uebergaben/:id{${UUID}}`, async (c) => {
    // Objektleitung sieht keine Preise/Werte
    const showPrice = c.get('user').role !== 'objektleitung';
    const id = c.req.param('id');
    const h = await load(c, id);
    if (h && h.status !== 'entwurf') return detail(c, h);

    // Vorbelegung: neu, Rückgabe zu einer Ausgabe, oder Wechsel von Art/Objekt (GET-Auswahl oben)
    const rel = c.req.query('zu') ? await load(c, c.req.query('zu')!) : undefined;
    const kq = c.req.query('art');
    const kind: HandoverKind =
      kq && kq in HANDOVER_KIND ? (kq as HandoverKind) : (h?.kind ?? rel?.kind ?? 'kleidung');
    const direction: Direction =
      (c.req.query('richtung') as Direction | undefined) === 'rueckgabe' || rel
        ? 'rueckgabe'
        : c.req.query('richtung') === 'ausgabe'
          ? 'ausgabe'
          : (h?.direction ?? 'ausgabe');
    const siteId = c.req.query('objekt') ?? h?.site_id ?? rel?.site_id ?? '';
    if (siteId && c.get('sites')) assertSite(c, siteId);
    const employeeId = c.req.query('mitarbeiter') ?? h?.employee_id ?? rel?.employee_id ?? '';
    const supplierId = c.req.query('nachunternehmer') ?? h?.supplier_id ?? rel?.supplier_id ?? '';
    const items: HandoverItem[] = h?.kind === kind ? h.items : rel?.kind === kind ? rel.items : [];
    // Empfänger: eigener Mitarbeiter oder Nachunternehmer (dann Person aus dessen Ansprechpartnern)
    const to: 'ma' | 'nu' =
      c.req.query('an') === 'nu' || (c.req.query('an') !== 'ma' && supplierId) ? 'nu' : 'ma';

    const [emps, sites, suppliers, articles, objects, vehicles, contacts] = await Promise.all([
      employeesFor(c),
      sitesFor(c),
      sql<{ id: string; supplier_no: string; name: string }[]>`
        select id, supplier_no, name from app.suppliers where kind = 'nachunternehmer' and active order by name`,
      listArticles(sql),
      listHandoverObjects(sql),
      sql<{ plate: string; label: string }[]>`
        select plate, trim(plate || ' ' || coalesce(make, '') || ' ' || coalesce(model, '')) as label
          from app.vehicles where active order by plate`,
      to === 'nu' && supplierId
        ? sql<{ name: string; role: string | null }[]>`
            select name, role from app.supplier_contacts where supplier_id = ${supplierId}
             order by is_primary desc, name`
        : Promise.resolve([] as { name: string; role: string | null }[]),
    ]);
    const objectNames = [...objects.map((o) => o.name), ...vehicles.map((v) => `Fahrzeug ${v.label}`)];
    const recipientPerson = h && !h.employee_id ? h.recipient_name.replace(/ \([^)]*\)$/, '') : '';
    const keys =
      kind === 'schluessel' && siteId
        ? await sql<{ id: string; key_no: string; description: string; holder: string | null }[]>`
            select k.id, k.key_no, k.description,
                   case when e.id is null then null else e.last_name || ', ' || e.first_name end as holder
              from app.keys k left join app.employees e on e.id = k.holder_employee_id
             where k.site_id = ${siteId} order by k.key_no`
        : [];
    const devices =
      kind === 'geraet'
        ? await sql<{ id: string; inventory_no: string; name: string }[]>`
            select id, inventory_no, name from app.devices
             where active and (${siteId || null}::uuid is null or site_id = ${siteId || null} or site_id is null)
             order by inventory_no`
        : [];
    const chosen = new Set(items.map((i) => i.key_id ?? i.device_id).filter(Boolean));
    const user = c.get('user');
    const title = h ? `${h.number} (Entwurf)` : `Neue ${direction === 'rueckgabe' ? 'Rückgabe' : 'Übergabe'}`;
    const freeRows =
      kind === 'kleidung' || kind === 'sonstiges'
        ? [...items, ...Array(Math.max(3, 6 - items.length)).fill(null)]
        : [];

    return page(
      c,
      title,
      'inventar',
      <>
        <PageHead title={title} crumbs={[['Übergaben', '/uebergaben']]} />
        <form method="get" class="actions card" style="margin-top:0">
          {rel && <input type="hidden" name="zu" value={rel.id} />}
          <label class="small" for="sel-art" style="margin:0">
            Art
          </label>
          <select id="sel-art" name="art" onchange="this.form.submit()" style="max-width:220px">
            {(kind === 'schluessel' ? KINDS : NEW_KINDS).map((k) => (
              <option value={k} selected={k === kind}>
                {HANDOVER_KIND[k]}
              </option>
            ))}
          </select>
          <select name="richtung" onchange="this.form.submit()" aria-label="Richtung" style="max-width:160px">
            <option value="ausgabe" selected={direction === 'ausgabe'}>
              Ausgabe
            </option>
            <option value="rueckgabe" selected={direction === 'rueckgabe'}>
              Rückgabe
            </option>
          </select>
          <label class="small" for="sel-site" style="margin:0">
            Objekt
          </label>
          <select id="sel-site" name="objekt" onchange="this.form.submit()" style="max-width:300px">
            <option value="">{c.get('sites') ? '– bitte wählen –' : '– ohne Objekt –'}</option>
            {sites.map((s) => (
              <option value={s.id} selected={s.id === siteId}>
                {s.site_no} · {s.name}
              </option>
            ))}
          </select>
          <label class="small" for="sel-an" style="margin:0">
            an
          </label>
          <select id="sel-an" name="an" onchange="this.form.submit()" style="max-width:200px" data-nosearch>
            <option value="ma" selected={to === 'ma'}>
              eigenen Mitarbeiter
            </option>
            {kind !== 'schluessel' && (
              <option value="nu" selected={to === 'nu'}>
                Nachunternehmer
              </option>
            )}
          </select>
          {to === 'nu' && (
            <select
              name="nachunternehmer"
              onchange="this.form.submit()"
              aria-label="Nachunternehmer"
              style="max-width:300px"
            >
              <option value="">– Nachunternehmer wählen –</option>
              {suppliers.map((x) => (
                <option value={x.id} selected={x.id === supplierId}>
                  {x.name} ({x.supplier_no})
                </option>
              ))}
            </select>
          )}
          {employeeId && to === 'ma' && <input type="hidden" name="mitarbeiter" value={employeeId} />}
          <noscript>
            <button class="btn sec sm">Übernehmen</button>
          </noscript>
        </form>

        <form
          method="post"
          action={`/uebergaben/${id}`}
          enctype="multipart/form-data"
          class="card"
          data-autosave
          data-version={String(h?.version ?? '')}
        >
          <input type="hidden" name="version" value={String(h?.version ?? '')} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="direction" value={direction} />
          <input type="hidden" name="site_id" value={siteId} />
          {rel && <input type="hidden" name="related_id" value={rel.id} />}
          {rel && (
            <p class="small mut" style="margin-top:0">
              Rückgabe zu {rel.number} vom {dateDe(rel.handover_date)} – Positionen übernommen, nicht
              Zurückgegebenes bitte entfernen.
            </p>
          )}
          <div class="grid">
            {to === 'ma' ? (
              <div>
                <label for="employee">Mitarbeiter/in *</label>
                <select id="employee" name="employee_id" required>
                  <option value="">– bitte wählen –</option>
                  {emps.map((e) => (
                    <option value={e.id} selected={e.id === employeeId}>
                      {e.last_name}, {e.first_name} ({e.personnel_no})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <>
                <input type="hidden" name="supplier_id" value={supplierId} />
                <div>
                  <label for="recipient">Person beim Nachunternehmer *</label>
                  {!supplierId ? (
                    <p class="mut" style="margin:0">
                      Bitte oben zuerst den Nachunternehmer wählen.
                    </p>
                  ) : (
                    <select id="recipient" name="recipient_name" data-other="recipient-other">
                      <option value="">– bitte wählen –</option>
                      {contacts.map((p) => (
                        <option value={p.name} selected={p.name === recipientPerson}>
                          {p.name}
                          {p.role ? ` (${p.role})` : ''}
                        </option>
                      ))}
                      <option
                        value="__andere"
                        selected={!!recipientPerson && !contacts.some((p) => p.name === recipientPerson)}
                      >
                        andere Person …
                      </option>
                    </select>
                  )}
                </div>
                {supplierId && (
                  <div
                    id="recipient-other"
                    hidden={!recipientPerson || contacts.some((p) => p.name === recipientPerson)}
                  >
                    <label for="recipient-o">Name der Person</label>
                    <input
                      id="recipient-o"
                      name="recipient_other"
                      value={contacts.some((p) => p.name === recipientPerson) ? '' : recipientPerson}
                      placeholder="z. B. Vorarbeiter des Nachunternehmers"
                    />
                  </div>
                )}
              </>
            )}
            <div>
              <label for="date">Datum</label>
              <input
                id="date"
                type="date"
                name="handover_date"
                value={h?.handover_date ?? todayBerlin()}
                max={todayBerlin()}
                required
              />
            </div>
            <div>
              <label for="title">Titel</label>
              <input
                id="title"
                name="title"
                value={h?.title ?? ''}
                placeholder="wird sonst automatisch gesetzt"
              />
            </div>
          </div>
          <input type="hidden" name="issuer_name" value={h?.issuer_name ?? user.name} />

          {kind === 'kleidung' && (
            <>
              <h3>Arbeitskleidung</h3>
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      <th>Größe</th>
                      <th>Menge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freeRows.map((it: HandoverItem | null) => (
                      <tr>
                        <td>
                          <select name="item_article" aria-label="Artikel">
                            <option value="">–</option>
                            {articles.map((a) => (
                              <option
                                value={a.id}
                                selected={a.id === it?.article_id}
                                data-sizes={a.sizes.join('|')}
                              >
                                {a.name}
                                {a.is_ppe ? ' (PSA)' : ''}
                                {showPrice && ` · ${euro(a.unit_price_cents)}`}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select name="item_size" aria-label="Größe" style="max-width:140px" data-nosearch>
                            <option value="">–</option>
                            {[
                              ...new Set([
                                ...(articles.find((a) => a.id === it?.article_id)?.sizes ?? []),
                                ...(it?.size ? [it.size] : []),
                              ]),
                            ].map((z) => (
                              <option value={z} selected={z === it?.size}>
                                {z}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            name="item_qty"
                            type="number"
                            min={1}
                            max={99}
                            value={String(it?.qty ?? 1)}
                            aria-label="Menge"
                            style="max-width:90px"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {direction === 'ausgabe' && (
                <label class="chk" style="margin-top:12px">
                  <input
                    type="checkbox"
                    name="wage_deduction"
                    value="1"
                    checked={h?.wage_deduction ?? false}
                  />
                  Lohnabzug bei Nichtrückgabe vereinbaren (nicht bei PSA)
                </label>
              )}
              <p class="small mut">
                PSA (Sicherheitsschuhe, Warnweste …) zahlt immer der Arbeitgeber (§ 3 Abs. 3 ArbSchG). Eine
                Verrechnung mit dem Lohn nur mit ausdrücklicher Vereinbarung und nur oberhalb der
                Pfändungsfreigrenze/des Mindestlohns.
              </p>
              <script dangerouslySetInnerHTML={{ __html: SIZE_JS }} />
            </>
          )}

          {kind === 'schluessel' && (
            <>
              <h3>Schlüssel {direction === 'rueckgabe' ? '(Rückgabe)' : ''}</h3>
              {!siteId && <p class="mut">Bitte oben zuerst das Objekt wählen.</p>}
              {siteId && !keys.length && (
                <p class="mut">
                  Für dieses Objekt sind keine Schlüssel erfasst – <a href="/schluessel">Schlüsselbuch</a>.
                </p>
              )}
              {keys.map((k) => {
                const blocked = direction === 'ausgabe' ? !!k.holder : !k.holder;
                return (
                  <label class="chk" style={blocked ? 'opacity:.55' : ''}>
                    <input
                      type="checkbox"
                      name="item_key"
                      value={k.id}
                      checked={chosen.has(k.id)}
                      disabled={blocked && !chosen.has(k.id)}
                    />
                    {k.key_no} – {k.description}{' '}
                    <span class="small mut">{k.holder ? `bei ${k.holder}` : 'im Büro/Tresor'}</span>
                  </label>
                );
              })}
            </>
          )}

          {kind === 'geraet' && (
            <>
              <h3>Geräte</h3>
              {!devices.length && (
                <p class="mut">
                  Keine Geräte erfasst – <a href="/geraete">Geräte &amp; Prüftermine</a>.
                </p>
              )}
              {devices.map((d) => (
                <label class="chk">
                  <input type="checkbox" name="item_device" value={d.id} checked={chosen.has(d.id)} />
                  {d.inventory_no} – {d.name}
                </label>
              ))}
            </>
          )}

          {kind === 'sonstiges' && (
            <>
              <h3>Gegenstände</h3>
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Gegenstand</th>
                      <th>Größe/Nr.</th>
                      <th>Menge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freeRows.map((it: HandoverItem | null) => (
                      <tr>
                        <td>
                          <select name="item_pick" aria-label="Gegenstand" data-other-row>
                            <option value="">–</option>
                            <optgroup label="Gegenstände">
                              {objects.map((o) => (
                                <option value={o.name} selected={it?.label === o.name}>
                                  {o.name}
                                </option>
                              ))}
                            </optgroup>
                            {vehicles.length > 0 && (
                              <optgroup label="Fahrzeuge">
                                {vehicles.map((v) => (
                                  <option
                                    value={`Fahrzeug ${v.label}`}
                                    selected={it?.label === `Fahrzeug ${v.label}`}
                                  >
                                    {v.label}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <option
                              value="__andere"
                              selected={!!it?.label && !objectNames.includes(it.label)}
                            >
                              anderer Gegenstand …
                            </option>
                          </select>
                          <input
                            name="item_label"
                            value={it?.label && !objectNames.includes(it.label) ? it.label : ''}
                            aria-label="anderer Gegenstand"
                            placeholder="Bezeichnung"
                            hidden={!(it?.label && !objectNames.includes(it.label))}
                            style="margin-top:6px"
                          />
                        </td>
                        <td>
                          <input
                            name="item_size"
                            value={it?.size ?? ''}
                            aria-label="Größe oder Nummer"
                            style="max-width:140px"
                          />
                        </td>
                        <td>
                          <input
                            name="item_qty"
                            type="number"
                            min={1}
                            value={String(it?.qty ?? 1)}
                            aria-label="Menge"
                            style="max-width:90px"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {kind === 'dokument' && (
            <>
              <h3>Dokument / Unterweisung</h3>
              <div class="grid">
                <div>
                  <label for="doc">
                    PDF (max. 20 MB){h?.document_name ? ` – vorhanden: ${h.document_name}` : ''}
                  </label>
                  <input id="doc" name="document" type="file" accept="application/pdf,.pdf" />
                </div>
              </div>
            </>
          )}
          <label for="body">
            {kind === 'dokument'
              ? 'Text (z. B. Inhalt der Unterweisung)'
              : 'Zusätzliche Erklärung (optional)'}
          </label>
          <textarea id="body" name="body_text" rows={kind === 'dokument' ? 6 : 2}>
            {h?.body_text ?? ''}
          </textarea>
          <label for="note">Bemerkung (z. B. Zustand)</label>
          <input id="note" name="note" value={h?.note ?? ''} />
          <p class="small mut">Erklärung über der Unterschrift: „{declaration(kind, direction)}“</p>
          <script dangerouslySetInnerHTML={{ __html: OTHER_JS }} />
          <div class="formfoot">
            <a class="btn sec" href="/uebergaben">
              Zurück
            </a>
            <button class="btn">Speichern und zur Unterschrift</button>
          </div>
        </form>
        {h && (
          <div class="card actions">
            <a class="btn" href={`/uebergaben/${id}/unterschrift`}>
              Jetzt unterschreiben lassen
            </a>
            <a class="btn sec" href={`/uebergaben/${id}/protokoll.pdf`} target="_blank">
              Vorschau PDF
            </a>
            <form
              method="post"
              action={`/uebergaben/${id}/ohne-unterschrift`}
              class="actions"
              style="margin:0"
            >
              <input
                name="reason"
                placeholder="Grund, falls ohne Unterschrift"
                required
                style="max-width:280px"
              />
              <button
                class="btn sec sm"
                onclick="return confirm('Ohne Unterschrift abschließen? Bestand/Schlüsselbuch werden gebucht.')"
              >
                Ohne Unterschrift abschließen
              </button>
            </form>
            <form method="post" action={`/uebergaben/${id}/loeschen`} style="margin:0 0 0 auto">
              <button class="btn sec sm" onclick="return confirm('Entwurf löschen?')">
                Entwurf löschen
              </button>
            </form>
          </div>
        )}
      </>,
    );
  });

  function detail(c: Context<AppEnv>, h: HandoverRow) {
    // Objektleitung sieht keine Preise/Werte
    const showPrice = c.get('user').role !== 'objektleitung';
    const total = showPrice
      ? h.items.reduce((s, i) => s + BigInt(i.unit_price_cents ?? 0) * BigInt(i.qty), 0n)
      : 0n;
    const canReturn =
      h.direction === 'ausgabe' && ['kleidung', 'schluessel', 'geraet', 'sonstiges'].includes(h.kind);
    return page(
      c,
      h.number,
      'inventar',
      <>
        <PageHead title={`${h.title}`} no={h.number} crumbs={[['Übergaben', '/uebergaben']]} />
        <div class="card">
          <p style="margin-top:0">
            <span class={`badge ${STATUS_CLASS[h.status]}`}>{HANDOVER_STATUS[h.status]}</span>{' '}
            <span class="badge kind">
              {h.direction === 'rueckgabe' ? 'Rückgabe' : 'Ausgabe'} · {HANDOVER_KIND[h.kind]}
            </span>
          </p>
          <dl class="kv">
            <dt>Empfänger</dt>
            <dd>
              {h.employee_id ? (
                <a href={`/personal/${h.employee_id}/uebergaben`}>{h.recipient_name}</a>
              ) : (
                h.recipient_name
              )}
            </dd>
            <dt>Datum</dt>
            <dd>{dateDe(h.handover_date)}</dd>
            {h.site_name && (
              <>
                <dt>Objekt</dt>
                <dd>
                  {h.site_name} ({h.site_no})
                </dd>
              </>
            )}
            {h.related_number && (
              <>
                <dt>zu Ausgabe</dt>
                <dd>
                  <a href={`/uebergaben/${h.related_id}`}>{h.related_number}</a>
                </dd>
              </>
            )}
            <dt>{h.status === 'unterschrieben' ? 'Unterschrieben' : 'Abgeschlossen'}</dt>
            <dd>
              {h.status === 'unterschrieben'
                ? `${h.signed_name}, ${berlin(h.signed_at!)} Uhr`
                : `ohne Unterschrift: ${h.no_signature_reason}`}
            </dd>
            {h.issuer_name && (
              <>
                <dt>Übergeben durch</dt>
                <dd>{h.issuer_name}</dd>
              </>
            )}
          </dl>
          {h.items.length > 0 && (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Gegenstand</th>
                    <th>Größe</th>
                    <th class="r">Menge</th>
                    {total > 0n && <th class="r">Wert</th>}
                  </tr>
                </thead>
                <tbody>
                  {h.items.map((i) => (
                    <tr>
                      <td>
                        {i.label}
                        {i.ppe ? ' (PSA)' : ''}
                      </td>
                      <td>{i.size ?? ''}</td>
                      <td class="r">{i.qty}</td>
                      {total > 0n && (
                        <td class="r">
                          {showPrice ? euro(BigInt(i.unit_price_cents ?? 0) * BigInt(i.qty)) : ''}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {h.wage_deduction && <p class="small">{WAGE_DEDUCTION_TEXT}</p>}
          {h.body_text && <p style="white-space:pre-line">{h.body_text}</p>}
          {h.note && <p class="small mut">Bemerkung: {h.note}</p>}
          <div class="actions">
            <a class="btn" href={`/uebergaben/${h.id}/protokoll.pdf`} target="_blank">
              Protokoll (PDF)
            </a>
            {canReturn && (
              <a class="btn sec" href={`/uebergaben/${randomUUID()}?zu=${h.id}`}>
                Rückgabe erfassen
              </a>
            )}
          </div>
          <p class="small mut">
            Abgeschlossen und unveränderbar. PDF write-once archiviert
            {h.pdf_sha256 ? ` (SHA-256 ${h.pdf_sha256.slice(0, 16)}…)` : ''}.
          </p>
        </div>
      </>,
    );
  }

  app.post(`/uebergaben/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const cur = await load(c, id);
    const b = await c.req.parseBody({ all: true });
    const kind = (str(b, 'kind') ?? 'kleidung') as HandoverKind;
    const siteId = str(b, 'site_id');
    if (c.get('sites')) assertSite(c, siteId); // Objektleitung: nur eigene Objekte, Objekt Pflicht
    const employeeId = str(b, 'employee_id');
    if (employeeId && c.get('sites')) {
      const ok = (await employeesFor(c)).some((e) => e.id === employeeId);
      if (!ok) throw new BusinessError('Mitarbeiter/in ist keinem Ihrer Objekte zugeordnet');
    }
    const items: HandoverItem[] = [];
    if (kind === 'kleidung') {
      const a = arr(b, 'item_article');
      const s = arr(b, 'item_size');
      const q = arr(b, 'item_qty');
      a.forEach(
        (art, i) =>
          art && items.push({ label: '', article_id: art, size: s[i] ?? '', qty: Number(q[i] ?? 1) }),
      );
    } else if (kind === 'sonstiges') {
      const pick = arr(b, 'item_pick');
      const l = arr(b, 'item_label');
      const s = arr(b, 'item_size');
      const q = arr(b, 'item_qty');
      pick.forEach((p, i) => {
        const label = (p === '__andere' ? (l[i] ?? '') : p).trim();
        if (label) items.push({ label, size: s[i] ?? '', qty: Number(q[i] ?? 1) });
      });
    } else if (kind === 'schluessel') {
      for (const k of arr(b, 'item_key')) items.push({ label: '', key_id: k, qty: 1 });
    } else if (kind === 'geraet') {
      for (const d of arr(b, 'item_device')) items.push({ label: '', device_id: d, qty: 1 });
    }
    const file = b.document;
    const doc =
      file instanceof File && file.size > 0
        ? { name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
        : null;
    const v = str(b, 'version');
    try {
      await saveHandover(
        deps,
        id,
        {
          kind,
          direction: str(b, 'direction') === 'rueckgabe' ? 'rueckgabe' : 'ausgabe',
          employeeId,
          supplierId: kind === 'schluessel' ? null : str(b, 'supplier_id'),
          recipientName:
            str(b, 'recipient_name') === '__andere' ? str(b, 'recipient_other') : str(b, 'recipient_name'),
          siteId,
          date: str(b, 'handover_date') ?? '',
          title: str(b, 'title'),
          items,
          bodyText: str(b, 'body_text'),
          wageDeduction: str(b, 'wage_deduction') === '1',
          relatedId: str(b, 'related_id') ?? cur?.related_id ?? null,
          note: str(b, 'note'),
          issuerName: str(b, 'issuer_name'),
          document: doc,
          version: v ? Number(v) : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) {
        const q = new URLSearchParams({ art: kind });
        if (str(b, 'supplier_id')) q.set('nachunternehmer', str(b, 'supplier_id')!);
        else if (employeeId) q.set('mitarbeiter', employeeId);
        if (siteId) q.set('objekt', siteId);
        if (str(b, 'related_id')) q.set('zu', str(b, 'related_id')!);
        return back(c, `/uebergaben/${id}?${q}`, { fehler: e.message });
      }
      throw e;
    }
    return back(c, `/uebergaben/${id}/unterschrift`, {
      ok: 'Gespeichert – bitte jetzt unterschreiben lassen.',
    });
  });

  app.post(`/uebergaben/:id{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    if (!(await load(c, id))) return c.notFound();
    await deleteDraft(sql, id, c.get('actor'));
    return back(c, '/uebergaben', { ok: 'Entwurf gelöscht.' });
  });

  // ------------------------------------------------------------------ Unterschrift vor Ort
  app.get(`/uebergaben/:id{${UUID}}/unterschrift`, async (c) => {
    const id = c.req.param('id');
    const h = await load(c, id);
    if (!h) return c.notFound();
    if (h.status !== 'entwurf') return c.redirect(`/uebergaben/${id}`);
    const isReturn = h.direction === 'rueckgabe';
    return page(
      c,
      'Unterschrift',
      'inventar',
      <div style="max-width:720px;margin:0 auto">
        <h1 style="margin-bottom:6px">
          {isReturn ? 'Rückgabe' : 'Übergabe'} {HANDOVER_KIND[h.kind]} · {h.number}
        </h1>
        <p class="mut" style="margin-top:0">
          {h.recipient_name} · {dateDe(h.handover_date)} {h.site_name && `· ${h.site_name}`}
        </p>
        <div class="card" style="font-size:16px">
          {h.document_name && (
            <p style="margin-top:0">
              Dokument:{' '}
              <a href={`/uebergaben/${id}/protokoll.pdf`} target="_blank">
                {h.document_name} (öffnen)
              </a>
            </p>
          )}
          {h.items.map((i) => (
            <div>
              <b>{i.qty}×</b> {i.label}
              {i.size ? ` (${i.size})` : ''}
              {i.ppe ? ' – PSA' : ''}
            </div>
          ))}
          {h.body_text && <p style="white-space:pre-line">{h.body_text}</p>}
          <p>
            <b>{declaration(h.kind, h.direction)}</b>
          </p>
          {h.wage_deduction && <p class="small">{WAGE_DEDUCTION_TEXT}</p>}
        </div>
        <form method="post" action={`/uebergaben/${id}/unterschrift`} class="card">
          <label for="name">Name des Unterzeichners</label>
          <input
            id="name"
            name="name"
            required
            value={h.employee_id ? h.recipient_name : ''}
            style="font-size:18px;height:46px"
          />
          <label style="margin-top:14px">Unterschrift</label>
          <canvas
            id="sig"
            style="width:100%;height:200px;border:1.5px dashed var(--line-2);border-radius:var(--r);background:#fff;touch-action:none;display:block"
          ></canvas>
          <input type="hidden" id="sig-png" name="png" />
          <div class="actions">
            <button type="button" class="btn sec sm" id="sig-clear">
              Löschen
            </button>
            <span class="small" id="sig-hint" style="color:var(--err)" hidden>
              Bitte im Feld unterschreiben.
            </span>
          </div>
          <p class="small mut">
            Das Protokoll wird danach als PDF unveränderbar gespeichert
            {h.kind === 'kleidung' ? ', der Bestand wird gebucht' : ''}
            {h.kind === 'schluessel' ? ', das Schlüsselbuch wird gebucht' : ''}.
          </p>
          <div class="formfoot">
            <a class="btn sec" href={`/uebergaben/${id}`}>
              Zurück
            </a>
            <button class="btn">Unterschreiben</button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />
      </div>,
    );
  });

  app.post(`/uebergaben/:id{${UUID}}/unterschrift`, async (c) => {
    const id = c.req.param('id');
    if (!(await load(c, id))) return c.notFound();
    const b = await c.req.parseBody();
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png ?? ''));
    if (!m) throw new BusinessError('Unterschrift fehlt – bitte im Feld unterschreiben');
    try {
      await signHandover(
        deps,
        id,
        { name: String(b.name ?? ''), png: new Uint8Array(Buffer.from(m[1]!, 'base64')) },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/uebergaben/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/uebergaben/${id}`, { ok: 'Unterschrieben. Das Protokoll ist gespeichert.' });
  });

  app.post(`/uebergaben/:id{${UUID}}/ohne-unterschrift`, async (c) => {
    const id = c.req.param('id');
    if (!(await load(c, id))) return c.notFound();
    const b = await c.req.parseBody();
    try {
      await closeHandoverWithoutSignature(deps, id, String(b.reason ?? ''), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/uebergaben/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/uebergaben/${id}`, { ok: 'Ohne Unterschrift abgeschlossen.' });
  });

  app.get(`/uebergaben/:id{${UUID}}/protokoll.pdf`, async (c) => {
    const id = c.req.param('id');
    const h = await load(c, id);
    if (!h) return c.notFound();
    const pdf = await handoverPdf(deps, id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Protokoll_${h.number}.pdf"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  // ------------------------------------------------------------------ Mitarbeiter: Reiter „Übergaben“
  app.get(`/personal/:id{${UUID}}/uebergaben`, (c) =>
    shells.employee!(c, 'uebergaben', async (e) => {
      const [held, rows] = await Promise.all([
        holdings(sql, e.id),
        listHandovers(sql, { scope: null, employeeId: e.id }),
      ]);
      return (
        <>
          <div class="actions" style="margin-top:0">
            {KINDS.map((k) => (
              <a class="btn sm" href={`/uebergaben/${randomUUID()}?art=${k}&mitarbeiter=${e.id}`}>
                + {HANDOVER_KIND[k]}
              </a>
            ))}
          </div>
          <div class="card">
            <h3 style="margin-top:0">
              Derzeit bei {e.first_name} {e.last_name}
            </h3>
            {!held.keys.length && !held.clothing.length && !held.devices.length && (
              <p class="mut">Nichts ausgegeben.</p>
            )}
            {held.keys.map((k) => (
              <div>
                Schlüssel {k.key_no} – {k.description}{' '}
                <span class="small mut">
                  ({k.site_name}, seit {dateDe(k.issued_at)})
                </span>
              </div>
            ))}
            {held.clothing.map((k) => (
              <div>
                {k.qty}× {k.name} {k.size && `(${k.size})`}{' '}
                <span class="small mut">Wert {euro(k.unit_price_cents * BigInt(k.qty))}</span>
              </div>
            ))}
            {held.devices.map((d) => (
              <div>Gerät {d.label}</div>
            ))}
            <p class="small mut">
              Beim Austritt: Rückgabe je Ausgabe erfassen („Rückgabe erfassen“ in der Übergabe).
            </p>
          </div>
          <div class="card">
            <HandoverTable rows={rows} />
          </div>
        </>
      );
    }),
  );

  // ------------------------------------------------------------------ Arbeitskleidung: Bestand und Artikel
  app.get('/arbeitskleidung', async (c) => {
    const [rows, articles] = await Promise.all([stock(sql), listArticles(sql, false)]);
    return page(
      c,
      'Arbeitskleidung',
      'einstellungen',
      <>
        <PageHead title="Arbeitskleidung: Bestand" crumbs={[['Einstellungen', '/einstellungen']]}>
          <a class="btn sec" href={`/arbeitskleidung/artikel/${randomUUID()}`} style="margin-left:auto">
            Artikel anlegen
          </a>
        </PageHead>
        <div class="cols">
          <div class="card">
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Artikel</th>
                    <th>Größe</th>
                    <th class="r">Bestand</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr>
                      <td>
                        <a href={`/arbeitskleidung/artikel/${r.article_id}`}>{r.name}</a>
                        {r.is_ppe && (
                          <span class="badge info" style="margin-left:6px">
                            PSA
                          </span>
                        )}
                      </td>
                      <td>{r.size || '–'}</td>
                      <td
                        class="r"
                        style={
                          r.qty < 0
                            ? 'color:var(--err);font-weight:600'
                            : r.qty < r.min_stock
                              ? 'color:var(--warn);font-weight:600'
                              : ''
                        }
                      >
                        {r.qty}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p class="small mut">
              Ausgaben/Rückgaben bucht die Übergabe beim Unterschreiben. Orange = unter Mindestbestand, rot =
              ohne Bestand ausgegeben (Zugang nachbuchen).
            </p>
          </div>
          <form method="post" action="/arbeitskleidung/buchung" class="card" style="align-self:start">
            <h3 style="margin-top:0">Zugang / Korrektur buchen</h3>
            <input type="hidden" name="id" value={randomUUID()} />
            <label for="article">Artikel</label>
            <select id="article" name="article_id" required>
              {articles
                .filter((a) => a.active)
                .map((a) => (
                  <option value={a.id}>{a.name}</option>
                ))}
            </select>
            <label for="size">Größe</label>
            <input id="size" name="size" placeholder="z. B. M oder 42" />
            <label for="delta">Menge (Korrektur auch negativ)</label>
            <input id="delta" name="delta" type="number" required />
            <label for="reason">Art</label>
            <select id="reason" name="reason">
              <option value="zugang">Zugang (Lieferung)</option>
              <option value="korrektur">Korrektur</option>
              <option value="inventur">Inventur</option>
            </select>
            <label for="note">Notiz / Grund</label>
            <input id="note" name="note" />
            <div class="formfoot">
              <button class="btn">Buchen</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post('/arbeitskleidung/buchung', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const reason = str(b, 'reason');
    try {
      await bookStock(
        sql,
        {
          id: str(b, 'id') ?? randomUUID(),
          articleId: str(b, 'article_id') ?? '',
          size: str(b, 'size') ?? '',
          delta: Number(str(b, 'delta') ?? '0'),
          reason: reason === 'korrektur' || reason === 'inventur' ? reason : 'zugang',
          note: str(b, 'note'),
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/arbeitskleidung', { fehler: e.message });
      throw e;
    }
    return back(c, '/arbeitskleidung', { ok: 'Gebucht.' });
  });

  app.get(`/arbeitskleidung/artikel/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [a] = (await listArticles(sql, false)).filter((x) => x.id === id);
    const moves = a ? await articleMoves(sql, id) : [];
    return page(
      c,
      a?.name ?? 'Neuer Artikel',
      'einstellungen',
      <>
        <PageHead title={a?.name ?? 'Neuer Artikel'} crumbs={[['Arbeitskleidung', '/arbeitskleidung']]} />
        <form
          method="post"
          action={`/arbeitskleidung/artikel/${id}`}
          class="card"
          data-autosave
          data-version={String(a?.version ?? '')}
          style="max-width:760px"
        >
          <input type="hidden" name="version" value={String(a?.version ?? '')} />
          <div class="grid">
            <div>
              <label for="name">Bezeichnung</label>
              <input id="name" name="name" value={a?.name ?? ''} required />
            </div>
            <div>
              <label for="price">Wert je Stück (€)</label>
              <input
                id="price"
                name="price"
                inputmode="decimal"
                value={a ? centsToInput(a.unit_price_cents) : '0,00'}
              />
            </div>
            <div>
              <label for="sizes">Größen (mit Komma)</label>
              <input id="sizes" name="sizes" value={a?.sizes.join(', ') ?? 'S, M, L, XL, XXL'} />
            </div>
            <div>
              <label for="min">Mindestbestand je Größe</label>
              <input id="min" name="min_stock" type="number" min={0} value={String(a?.min_stock ?? 2)} />
            </div>
          </div>
          <label class="chk">
            <input type="checkbox" name="is_ppe" value="1" checked={a?.is_ppe ?? false} /> Persönliche
            Schutzausrüstung (nie Lohnabzug)
          </label>
          <label class="chk">
            <input type="checkbox" name="active" value="1" checked={a?.active ?? true} /> aktiv
          </label>
          <div class="formfoot">
            <a class="btn sec" href="/arbeitskleidung">
              Zurück
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
        {moves.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Bewegungen</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Zeit</th>
                    <th>Größe</th>
                    <th class="r">Menge</th>
                    <th>Art</th>
                    <th>Notiz</th>
                    <th>von</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr>
                      <td class="small">{berlin(m.created_at)}</td>
                      <td>{m.size || '–'}</td>
                      <td class="r">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                      <td>{m.reason}</td>
                      <td class="small">
                        {m.handover_id ? <a href={`/uebergaben/${m.handover_id}`}>{m.note}</a> : m.note}
                      </td>
                      <td class="small mut">{m.created_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>,
    );
  });

  app.post(`/arbeitskleidung/artikel/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const v = str(b, 'version');
    try {
      await saveArticle(
        sql,
        id,
        {
          name: str(b, 'name') ?? '',
          priceCents: parseEuro(str(b, 'price') ?? '0'),
          isPpe: str(b, 'is_ppe') === '1',
          sizes: (str(b, 'sizes') ?? '').split(','),
          minStock: Number(str(b, 'min_stock') ?? '0'),
          active: str(b, 'active') === '1',
          version: v ? Number(v) : null,
        },
        c.get('actor'),
      );
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/arbeitskleidung/artikel/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, '/arbeitskleidung', { ok: 'Artikel gespeichert.' });
  });
}
