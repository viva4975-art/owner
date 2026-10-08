import { randomUUID } from 'node:crypto';
import { CYCLE_LABEL, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { listCustomers, listServiceTypes } from '../services/masterdata.js';
import {
  adjustmentCandidates,
  adjustmentItems,
  adjustmentLetters,
  applyPriceAdjustment,
  effectiveBp,
  formatPercent,
  listAdjustments,
  servicesWithoutLaborShare,
  setLaborShares,
} from '../services/price-adjustment.js';
import { type Ctx, UUID } from './app.js';
import { arr, str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, dateDe, euro } from './layout.js';
import { uploadConfig } from './routes-files.js';

/** „3,5“ / „3.5“ → Basispunkte (350); ungültig → null */
const pctToBp = (s: string | null | undefined): number | null => {
  if (!s || !s.trim()) return null;
  const n = Number(s.trim().replace('%', '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

const nextMonthFirst = () => {
  const t = todayBerlin();
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/** Preisanpassung bei Tariflohnerhöhung je Leistung nach Lohnkostenanteil (Rechnungen → Preisanpassung). */
export function registerPriceAdjustmentRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;

  app.get('/preisanpassung', async (c) => {
    const q = c.req.query();
    const month = /^\d{4}-\d{2}$/.test(q.ab ?? '') ? q.ab! : nextMonthFirst().slice(0, 7);
    const from = `${month}-01`;
    const raiseBp = pctToBp(q.erhoehung) ?? 0;
    const otherBp = pctToBp(q.sachkosten) ?? 0;
    const defaultLaborBp = pctToBp(q.annahme);
    const valid =
      raiseBp >= 0 &&
      raiseBp <= 5000 &&
      otherBp >= 0 &&
      otherBp <= 5000 &&
      raiseBp + otherBp > 0 &&
      (defaultLaborBp == null || (defaultLaborBp >= 0 && defaultLaborBp <= 10000));
    const [missing, customers, types, runs] = await Promise.all([
      servicesWithoutLaborShare(sql),
      listCustomers(sql),
      listServiceTypes(sql),
      listAdjustments(sql),
    ]);
    const rows = valid
      ? await adjustmentCandidates(sql, {
          from,
          raiseBp,
          otherBp,
          defaultLaborBp,
          customerId: q.kunde || null,
          serviceTypeId: q.art || null,
        })
      : null;
    const ok = rows?.filter((r) => !r.blocked) ?? [];
    const oldSum = ok.reduce((a, r) => a + r.unit_price_cents, 0n);
    const newSum = ok.reduce((a, r) => a + (r.new_price_cents ?? 0n), 0n);
    const assumed = ok.filter((r) => r.labor_assumed).length;
    const byCustomer = new Map<string, NonNullable<typeof rows>>();
    for (const r of rows ?? []) byCustomer.set(r.customer_id, [...(byCustomer.get(r.customer_id) ?? []), r]);
    return page(
      c,
      'Preisanpassung',
      'rechnungen',
      <>
        <PageHead title="Preisanpassung" crumbs={[['Rechnungen', '/rechnungen']]} />
        <div class="flash warn">
          <span>
            Eine Preiserhöhung ist nur wirksam, wenn der Vertrag eine Preisgleit-/Lohngleitklausel enthält
            oder der Kunde zustimmt – bei öffentlichen Auftraggebern nach den Vertragsbedingungen (meist
            Antrag mit Nachweis).
          </span>
        </div>
        <form method="get" class="card">
          <h3 style="margin-top:0">1. Erhöhung eingeben</h3>
          <p class="small mut" style="margin-top:0">
            Neuer Preis = bisher + bisher × Lohnanteil × Lohnerhöhung + bisher × (100 % − Lohnanteil) ×
            Erhöhung der übrigen Kosten. Die Vorschau erscheint direkt darunter.
          </p>
          <div class="grid">
            <div>
              <label for="ab">gültig ab (Monat)</label>
              <input id="ab" type="month" name="ab" value={month} required />
            </div>
            <div>
              <label for="erhoehung">Tariflohnerhöhung in %</label>
              <input
                id="erhoehung"
                name="erhoehung"
                value={q.erhoehung ?? ''}
                placeholder="z. B. 3,5 (leer = 0)"
                inputmode="decimal"
              />
            </div>
            <div>
              <label for="sachkosten">Übrige Kosten erhöhen um %</label>
              <input
                id="sachkosten"
                name="sachkosten"
                value={q.sachkosten ?? ''}
                placeholder="z. B. 2 (leer = 0)"
                inputmode="decimal"
              />
            </div>
            <div>
              <label for="bezeichnung">Bezeichnung übrige Kosten</label>
              <input
                id="bezeichnung"
                name="bezeichnung"
                value={q.bezeichnung ?? ''}
                placeholder="Material- und Sachkosten"
                maxlength={80}
              />
            </div>
            <div>
              <label for="annahme">Lohnanteil annehmen, wo er fehlt (%)</label>
              <input
                id="annahme"
                name="annahme"
                value={q.annahme ?? ''}
                placeholder={missing.length ? `z. B. 80 – fehlt bei ${missing.length}` : 'nicht nötig'}
                inputmode="decimal"
              />
            </div>
            <div>
              <label for="kunde">Kunde</label>
              <select id="kunde" name="kunde">
                <option value="">alle Kunden</option>
                {customers
                  .filter((x) => x.active)
                  .map((x) => (
                    <option value={x.id} selected={x.id === q.kunde}>
                      {x.customer_no} · {x.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label for="art">Leistungsart</label>
              <select id="art" name="art">
                <option value="">alle</option>
                {types.map((t) => (
                  <option value={t.id} selected={t.id === q.art}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="actions form-foot">
            <button class="btn">Vorschau berechnen</button>
            {q.erhoehung !== undefined && !valid && (
              <span class="small" style="color:var(--err)">
                Bitte Lohn- und/oder Sachkostenerhöhung (0–50 %) und ggf. Lohnanteil (0–100 %) prüfen.
              </span>
            )}
          </div>
        </form>
        {rows && (
          <form method="post" action="/preisanpassung" class="card">
            <input type="hidden" name="run" value={randomUUID()} />
            <input type="hidden" name="ab" value={from} />
            <input type="hidden" name="erhoehung" value={String(raiseBp)} />
            <input type="hidden" name="sachkosten" value={String(otherBp)} />
            <input
              type="hidden"
              name="annahme"
              value={defaultLaborBp == null ? '' : String(defaultLaborBp)}
            />
            <input type="hidden" name="bezeichnung" value={q.bezeichnung ?? ''} />
            <h3 style="margin-top:0">
              2. Vorschau ab {dateDe(from)} · Lohn +{formatPercent(raiseBp)}
              {otherBp > 0 && ` · ${q.bezeichnung?.trim() || 'übrige Kosten'} +${formatPercent(otherBp)}`}
            </h3>
            {assumed > 0 && (
              <div class="flash warn">
                <span>
                  Bei {assumed} Leistungen ist kein Lohnanteil hinterlegt – gerechnet mit angenommenen{' '}
                  {formatPercent(defaultLaborBp!)} (gelb markiert). Besser unten unter „Lohnkostenanteil
                  fehlt“ dauerhaft nachtragen.
                </span>
              </div>
            )}
            <p class="small mut" style="margin-top:0">
              {ok.length} Leistungen anpassbar · Summe je Zeitraum {euro(oldSum)} → <b>{euro(newSum)}</b> (
              {newSum >= oldSum ? '+' : ''}
              {euro(newSum - oldSum)})
              {rows.length > ok.length && ` · ${rows.length - ok.length} nicht anpassbar (grau)`}
            </p>
            <div class="actions" style="margin-top:0">
              <label class="chk" style="margin:0">
                <input
                  type="checkbox"
                  checked
                  onchange="document.querySelectorAll('input[name=leistung]:not(:disabled)').forEach(function(i){i.checked=this.checked}.bind(this))"
                />{' '}
                alle
              </label>
            </div>
            {[...byCustomer.values()].map((list) => (
              <div class="tbl" style="margin-bottom:14px">
                <table>
                  <thead>
                    <tr>
                      <th colspan={7}>
                        {list[0]!.customer_no} · {list[0]!.customer_name}
                      </th>
                    </tr>
                    <tr>
                      <th></th>
                      <th>Objekt / Leistung</th>
                      <th>Zyklus</th>
                      <th class="r">Lohnanteil</th>
                      <th class="r">bisher</th>
                      <th class="r">neu</th>
                      <th class="r">+</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr style={r.blocked ? 'opacity:.55' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            name="leistung"
                            value={r.id}
                            checked={!r.blocked}
                            disabled={!!r.blocked}
                            aria-label="anpassen"
                          />
                        </td>
                        <td>
                          <span class="small mut">
                            {r.site_no} · {r.site_name}
                          </span>
                          <div>{r.description}</div>
                          {r.blocked && (
                            <div class="small" style="color:var(--err)">
                              {r.blocked}
                            </div>
                          )}
                        </td>
                        <td class="small">{CYCLE_LABEL[r.billing_cycle]}</td>
                        <td class="r">
                          {r.used_labor_bp != null ? (
                            <span class={r.labor_assumed ? 'badge gold' : ''}>
                              {formatPercent(r.used_labor_bp)}
                              {r.labor_assumed && ' angen.'}
                            </span>
                          ) : (
                            '–'
                          )}
                          {r.used_labor_bp != null && (
                            <div class="small mut">
                              = +{formatPercent(effectiveBp(r.used_labor_bp, raiseBp, otherBp))}
                            </div>
                          )}
                        </td>
                        <td class="r">{euro(r.unit_price_cents)}</td>
                        <td class="r">
                          <b>{r.new_price_cents != null ? euro(r.new_price_cents) : '–'}</b>
                        </td>
                        <td class="r small">
                          {r.new_price_cents != null ? euro(r.new_price_cents - r.unit_price_cents) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {rows.length === 0 && <div class="empty">Keine laufenden Leistungen für diese Auswahl.</div>}
            <label class="chk">
              <input type="checkbox" name="zusatztext" checked /> Hinweis in den Zusatztext der Leistung (wie
              Fortytools: „3.099,86 € + 4,00 % Tariflohnerhöhung ab {dateDe(from)}“)
            </label>
            <div class="actions form-foot">
              <button
                class="btn"
                disabled={ok.length === 0}
                onclick={`return confirm('Preise der markierten Leistungen ab ${dateDe(from)} ändern?')`}
              >
                <Icon name="check" /> Markierte Preise ab {dateDe(from)} übernehmen
              </button>
              <span class="small mut">
                Die bisherige Leistung endet am Vortag, die neue gilt ab dem Stichtag – frühere Rechnungen
                bleiben unverändert.
              </span>
            </div>
          </form>
        )}
        {missing.length > 0 && (
          <details class="card">
            <summary>
              <b>Lohnkostenanteil fehlt</b> <span class="badge err">{missing.length} Leistungen</span>{' '}
              <span class="small mut">– dauerhaft nachtragen (oder oben einen Anteil annehmen)</span>
            </summary>
            <form method="post" action="/preisanpassung/lohnanteil" style="margin-top:10px">
              <div class="actions" style="margin-top:0">
                <input id="la-all" placeholder="z. B. 80" inputmode="decimal" style="max-width:110px" />
                <button
                  type="button"
                  class="btn sec sm"
                  onclick="var v=document.getElementById('la-all').value;document.querySelectorAll('input[data-la]').forEach(function(i){if(!i.value)i.value=v})"
                >
                  in alle leeren Felder
                </button>
                <span class="small mut">
                  Vorgabe der Leistungsart ist bereits eingetragen (bitte prüfen).
                </span>
              </div>
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Kunde</th>
                      <th>Objekt</th>
                      <th>Leistung</th>
                      <th class="r">Preis</th>
                      <th>Lohnanteil %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {missing.slice(0, 300).map((m) => (
                      <tr>
                        <td class="small">{m.customer_name}</td>
                        <td class="small">
                          <a href={`/objekte/${m.site_id}/leistungen`}>
                            {m.site_no} · {m.site_name}
                          </a>
                        </td>
                        <td>
                          {m.description}
                          {m.type_name && <div class="small mut">{m.type_name}</div>}
                        </td>
                        <td class="r">{euro(m.unit_price_cents)}</td>
                        <td>
                          <input
                            name={`la_${m.id}`}
                            data-la
                            inputmode="decimal"
                            style="max-width:90px"
                            value={
                              m.type_labor_bp != null ? String(m.type_labor_bp / 100).replace('.', ',') : ''
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {missing.length > 300 && (
                <p class="small mut">
                  Erste 300 von {missing.length} – nach dem Speichern erscheinen die nächsten.
                </p>
              )}
              <div class="actions form-foot">
                <button class="btn">Lohnanteile speichern</button>
              </div>
            </form>
          </details>
        )}
        {runs.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Durchgeführte Anpassungen</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>ab</th>
                    <th>Erhöhung</th>
                    <th class="r">Leistungen</th>
                    <th class="r">Kunden</th>
                    <th class="r">bisher → neu</th>
                    <th>durch</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr>
                      <td>{dateDe(r.effective_from)}</td>
                      <td>
                        Lohn {formatPercent(r.raise_bp)}
                        {r.other_raise_bp > 0 && (
                          <div class="small mut">
                            {r.other_label || 'übrige Kosten'} {formatPercent(r.other_raise_bp)}
                          </div>
                        )}
                        {r.default_labor_bp != null && (
                          <div class="small mut">angen. Lohnanteil {formatPercent(r.default_labor_bp)}</div>
                        )}
                      </td>
                      <td class="r">{r.items}</td>
                      <td class="r">{r.customers}</td>
                      <td class="r">
                        {euro(r.old_sum)} → {euro(r.new_sum)}
                      </td>
                      <td class="small">
                        {r.created_by},{' '}
                        {r.created_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
                      </td>
                      <td>
                        {r.items > 0 && (
                          <form
                            method="post"
                            action={`/preisanpassung/${r.id}/briefe`}
                            target="_blank"
                            style="margin:0"
                          >
                            <button class="btn sec sm">Anschreiben (PDF)</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p class="small mut">
              Anschreiben: je Kunde ein Brief mit allen Leistungen (bisher/neu), wird zusätzlich in der
              Kundenakte unter „Schriftverkehr“ abgelegt.
            </p>
          </div>
        )}
      </>,
    );
  });

  app.post('/preisanpassung/lohnanteil', async (c) => {
    const b = await c.req.parseBody();
    const values: { id: string; bp: number }[] = [];
    for (const [k, v] of Object.entries(b)) {
      const m = /^la_([0-9a-f-]{36})$/.exec(k);
      if (!m || typeof v !== 'string' || !v.trim()) continue;
      const bp = pctToBp(v);
      if (bp == null || bp < 0 || bp > 10000)
        throw new BusinessError(`Lohnanteil „${v}“ ist keine Zahl von 0 bis 100`);
      values.push({ id: m[1]!, bp });
    }
    const n = await setLaborShares(sql, values, c.get('actor'));
    return back(c, '/preisanpassung', { ok: `${n} Lohnkostenanteile gespeichert.` });
  });

  app.post('/preisanpassung', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const run = str(b, 'run');
    const from = str(b, 'ab') ?? '';
    const raiseBp = Number(str(b, 'erhoehung') ?? 0);
    const otherBp = Number(str(b, 'sachkosten') ?? 0);
    const ann = str(b, 'annahme');
    if (!run || !/^[0-9a-f-]{36}$/.test(run)) throw new BusinessError('Formular ungültig – Seite neu laden');
    const r = await applyPriceAdjustment(sql, {
      runId: run,
      from,
      raiseBp,
      otherBp,
      otherLabel: str(b, 'bezeichnung'),
      defaultLaborBp: ann ? Number(ann) : null,
      serviceIds: arr(b, 'leistung').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
      noteText: str(b, 'zusatztext') != null,
      actor: c.get('actor'),
    });
    return back(c, '/preisanpassung', {
      ok: `${r.changed} Preise ab ${dateDe(from)} angepasst.${r.skipped.length ? ` Nicht angepasst: ${r.skipped.join('; ')}` : ''} Anschreiben unten unter „Durchgeführte Anpassungen“.`,
    });
  });

  app.post(`/preisanpassung/:id{${UUID}}/briefe`, async (c) => {
    const id = c.req.param('id');
    if (!(await adjustmentItems(sql, id)).length) throw new BusinessError('Keine Leistungen in diesem Lauf');
    const pdf = await adjustmentLetters(sql, uploadConfig(ctx), id, c.get('actor'));
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Preisanpassung_${todayBerlin()}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });
}
