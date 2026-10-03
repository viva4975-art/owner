import type { FC } from 'hono/jsx';
import { type BillingCycle, CYCLE_LABEL, monthLabelDe } from '../domain/invoice/calc.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import type { InvoiceGroupRow } from '../services/invoice-groups.js';
import type { ServiceType, SiteService, SiteServiceRow } from '../services/masterdata.js';
import { centsToInput, milliToInput } from './forms.js';
import { SERVICE_KIND_LABEL, dateDe, euro } from './layout.js';

/*
 * Leistungen am Objekt wie die Fortytools-„Aufträge“: Liste aktiver Leistungen, Bearbeiten je Leistung
 * (Abrechnung, Ausführung) und „Regelmäßige Leistung(en) abrechnen“ mit Abrechnungsmonat und Rechnungsdatum.
 */

const target = (sv: SiteServiceRow) =>
  sv.separate_invoice ? 'eigene Rechnung' : sv.group_name ? `Gruppe: ${sv.group_name}` : 'wie Objekt';

export const ServicesPanel: FC<{
  siteId: string;
  services: SiteServiceRow[];
  newServiceId: string;
  siteGroup: string | null;
  month: string;
  invoiceDate: string;
  preview: {
    service: { description: string };
    line: { detail?: string | null; quantity: bigint; unitPrice: bigint };
    billedInvoice: string | null;
    billedNumber: string | null;
  }[];
}> = ({ siteId, services, newServiceId, siteGroup, month, invoiceDate, preview }) => {
  const active = services.filter((s) => s.active);
  const inactive = services.filter((s) => !s.active);
  const open = preview.filter((p) => !p.billedInvoice);
  const hours = active.reduce((a, s) => a + (s.hours_target_milli ?? 0n), 0n);
  return (
    <>
      <div class="actions" style="margin-top:0">
        <a class="btn sm" href={`/objekte/${siteId}/leistungen/${newServiceId}`}>
          + Leistung anlegen
        </a>
        <a class="btn sm ghost" href="/einstellungen/leistungsarten">
          Leistungsarten
        </a>
        {siteGroup && <span class="small mut">Rechnungsgruppe des Objekts: {siteGroup}</span>}
      </div>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Leistung</th>
              <th>Beginn – Ende</th>
              <th>Zyklus</th>
              <th class="r">Menge</th>
              <th>Einheit</th>
              <th class="r">Preis</th>
              <th class="r">Gesamt</th>
              <th>Rechnung</th>
              <th>zuletzt</th>
            </tr>
          </thead>
          <tbody>
            {active.length === 0 && (
              <tr>
                <td colspan={9} class="mut">
                  Noch keine aktiven Leistungen.
                </td>
              </tr>
            )}
            {[...active, ...inactive].map((sv) => (
              <tr style={sv.active ? '' : 'opacity:.5'}>
                <td>
                  <a href={`/objekte/${siteId}/leistungen/${sv.id}`}>
                    <b>{sv.description}</b>
                  </a>
                  <div class="small mut">
                    {[
                      sv.type_name,
                      SERVICE_KIND_LABEL[sv.kind],
                      sv.always_unfinished ? 'immer unfertig' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {sv.note && <div class="small">{sv.note}</div>}
                </td>
                <td class="small">
                  {dateDe(sv.valid_from)}
                  <br />
                  {sv.valid_to ? dateDe(sv.valid_to) : 'unbefristet'}
                </td>
                <td class="small">{sv.kind === 'monthly_flat' ? CYCLE_LABEL[sv.billing_cycle] : '–'}</td>
                <td class="r">{milliToInput(sv.quantity_milli)}</td>
                <td>{UNIT_LABELS[sv.unit_code] ?? sv.unit_code}</td>
                <td class="r">{euro(sv.unit_price_cents)}</td>
                <td class="r">
                  <b>{euro((sv.quantity_milli * sv.unit_price_cents + 500n) / 1000n)}</b>
                </td>
                <td class="small">{target(sv)}</td>
                <td class="small">{sv.last_billed_month ? monthLabelDe(sv.last_billed_month) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hours > 0n && (
        <p class="small mut">Stundenvorgabe laut Leistungen: {milliToInput(hours)} Std. je Monat</p>
      )}

      <div class="card" style="margin-top:14px">
        <h3>Regelmäßige Leistung(en) abrechnen</h3>
        <form method="get" action={`/objekte/${siteId}/leistungen`} class="grid" style="align-items:end">
          <div>
            <label for="monat">Abrechnungsmonat</label>
            <input id="monat" type="month" name="monat" value={month} onchange="this.form.submit()" />
          </div>
          <div>
            <label for="datum_vorschau">Rechnungsdatum</label>
            <input
              id="datum_vorschau"
              type="date"
              name="datum"
              value={invoiceDate}
              onchange="this.form.submit()"
            />
          </div>
        </form>
        <div class="tbl" style="margin-top:10px">
          <table>
            <thead>
              <tr>
                <th>fällig in {monthLabelDe(month)}</th>
                <th>Zeitraum</th>
                <th class="r">Betrag</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.length === 0 && (
                <tr>
                  <td colspan={4} class="mut">
                    In diesem Monat ist keine regelmäßige Leistung fällig.
                  </td>
                </tr>
              )}
              {preview.map((p) => (
                <tr>
                  <td>{p.service.description}</td>
                  <td class="small">{(p.line.detail ?? '').split('\n').pop()}</td>
                  <td class="r">{euro((p.line.quantity * p.line.unitPrice + 500n) / 1000n)}</td>
                  <td>
                    {p.billedInvoice ? (
                      <a href={`/rechnungen/${p.billedInvoice}`} class="badge ok">
                        abgerechnet {p.billedNumber ?? '(Entwurf)'}
                      </a>
                    ) : (
                      <span class="badge warn">offen</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form method="post" action={`/objekte/${siteId}/abrechnen`} class="actions">
          <input type="hidden" name="monat" value={month} />
          <input type="hidden" name="datum" value={invoiceDate} />
          <button class="btn" disabled={open.length === 0}>
            Leistung(en) abrechnen ({open.length})
          </button>
          <span class="small mut">
            Erzeugt Rechnungsentwürfe (je Rechnungsgruppe bzw. eigene Rechnung). Alle Objekte auf einmal:
            Rechnungen → Monatslauf.
          </span>
        </form>
      </div>
    </>
  );
};

const CYCLES = Object.entries(CYCLE_LABEL) as [BillingCycle, string][];

export const ServiceForm: FC<{
  siteId: string;
  id: string;
  sv: SiteService | null;
  types: ServiceType[];
  groups: InvoiceGroupRow[];
  today: string;
}> = ({ siteId, id, sv, types, groups, today }) => {
  const tgt = sv?.separate_invoice ? 'separat' : (sv?.invoice_group_id ?? 'objekt');
  return (
    <form
      method="post"
      action={`/objekte/${siteId}/leistungen/${id}`}
      class="card svcform"
      style="max-width:900px"
      data-autosave={`/objekte/${siteId}/leistungen/${id}`}
      data-version={String(sv?.version ?? '')}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: '.svcform h3{margin:24px 0 8px;padding-top:14px;border-top:1px solid var(--line)}',
        }}
      />
      <input type="hidden" name="version" value={String(sv?.version ?? '')} />
      <h2 style="margin-top:0">{sv ? `Leistung „${sv.description}“` : 'Neue Leistung'}</h2>

      <h3>Leistung</h3>
      <div class="grid">
        <div>
          <label for="valid_from">Anfang *</label>
          <input id="valid_from" type="date" name="valid_from" value={sv?.valid_from ?? today} required />
        </div>
        <div>
          <label for="valid_to">Ende</label>
          <input id="valid_to" type="date" name="valid_to" value={sv?.valid_to ?? ''} />
        </div>
      </div>

      <h3>Details</h3>
      <div class="grid">
        <div style="grid-column:span 2">
          <label for="description">Titel / Text auf der Rechnung *</label>
          <input
            id="description"
            name="description"
            value={sv?.description ?? ''}
            required
            placeholder="Unterhaltsreinigung"
          />
        </div>
        <div>
          <label for="service_type_id">Leistungsart</label>
          <select id="service_type_id" name="service_type_id">
            <option value="">– keine –</option>
            {types.map((t) => (
              <option value={t.id} selected={t.id === sv?.service_type_id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div style="grid-column:1/-1">
          <label for="note">Beschreibung (Zusatztext auf der Rechnung)</label>
          <input
            id="note"
            name="note"
            value={sv?.note ?? ''}
            placeholder="z. B. 3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026"
          />
        </div>
        <div>
          <label for="cost_center">Kostenstelle</label>
          <input id="cost_center" name="cost_center" value={sv?.cost_center ?? ''} placeholder="keine" />
        </div>
      </div>

      <h3>Abrechnung</h3>
      <div class="grid">
        <div>
          <label for="kind">Art</label>
          <select id="kind" name="kind">
            {Object.entries(SERVICE_KIND_LABEL).map(([k, v]) => (
              <option value={k} selected={k === (sv?.kind ?? 'monthly_flat')}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="invoice_target">Rechnungsgruppe</label>
          <select id="invoice_target" name="invoice_target">
            <option value="objekt" selected={tgt === 'objekt'}>
              wie Objekt
            </option>
            <option value="separat" selected={tgt === 'separat'}>
              eigene Rechnung für diese Leistung
            </option>
            {groups
              .filter((g) => g.active || g.id === sv?.invoice_group_id)
              .map((g) => (
                <option value={g.id} selected={tgt === g.id}>
                  Gruppe: {g.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label for="billing_cycle">Abrechnungszyklus</label>
          <select id="billing_cycle" name="billing_cycle">
            {CYCLES.map(([k, v]) => (
              <option value={k} selected={k === (sv?.billing_cycle ?? 'monatlich')}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="unit_code">Einheit</label>
          <select id="unit_code" name="unit_code">
            {Object.entries(UNIT_LABELS).map(([k, v]) => (
              <option value={k} selected={k === (sv?.unit_code ?? 'LS')}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="quantity">Menge *</label>
          <input id="quantity" name="quantity" value={sv ? milliToInput(sv.quantity_milli) : '1'} required />
        </div>
        <div>
          <label for="unit_price">Betrag je Zeitraum (netto, €) *</label>
          <input
            id="unit_price"
            name="unit_price"
            value={sv ? centsToInput(sv.unit_price_cents) : ''}
            placeholder="3.257,05"
            required
          />
        </div>
        <div>
          <label for="vat_rate_bp">USt</label>
          <select id="vat_rate_bp" name="vat_rate_bp">
            <option value="1900" selected={(sv?.vat_rate_bp ?? 1900) === 1900}>
              19 %
            </option>
            <option value="700" selected={sv?.vat_rate_bp === 700}>
              7 %
            </option>
          </select>
        </div>
        <div>
          <label for="labor_share">Lohnkostenanteil (%)</label>
          <input
            id="labor_share"
            name="labor_share"
            value={sv?.labor_share_bp != null ? String(sv.labor_share_bp / 100).replace('.', ',') : ''}
            placeholder="wie Leistungsart"
          />
        </div>
      </div>
      <div class="chk" style="margin-top:10px">
        <input
          type="checkbox"
          id="always_unfinished"
          name="always_unfinished"
          checked={sv?.always_unfinished ?? false}
        />
        <label for="always_unfinished">
          Immer unfertig – Rechnungen mit dieser Leistung müssen vor dem Ausstellen geprüft werden (z. B.
          Mengen nach Aufmaß)
        </label>
      </div>

      <h3>Ausführung</h3>
      <div class="grid">
        <div>
          <label for="hours_target">Stundenvorgabe (Std. je Monat)</label>
          <input
            id="hours_target"
            name="hours_target"
            value={sv?.hours_target_milli != null ? milliToInput(sv.hours_target_milli) : ''}
            placeholder="124,00"
          />
        </div>
        <div style="grid-column:span 2">
          <label for="execution_notes">Ausführungshinweise (erscheinen auf dem Arbeitsschein)</label>
          <textarea id="execution_notes" name="execution_notes" rows={3}>
            {sv?.execution_notes ?? ''}
          </textarea>
        </div>
      </div>

      <div class="formfoot">
        <a class="btn sec" href={`/objekte/${siteId}/leistungen`}>
          ← Zurück zur Übersicht
        </a>
        <button class="btn">{sv ? 'Leistung aktualisieren' : 'Leistung anlegen'}</button>
      </div>
    </form>
  );
};
