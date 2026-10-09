import type { FC } from 'hono/jsx';
import { type BillingCycle, CYCLE_LABEL, monthLabelDe } from '../domain/invoice/calc.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import type { InvoiceGroupRow } from '../services/invoice-groups.js';
import type { ServiceType, SiteService, SiteServiceRow } from '../services/masterdata.js';
import { centsToInput, milliToInput } from './forms.js';
import { dateDe, euro } from './layout.js';

/*
 * Leistungen am Objekt wie die Fortytools-„Aufträge“: Liste aktiver Leistungen, Bearbeiten je Leistung
 * (Abrechnung, Ausführung) und „Regelmäßige Leistung(en) abrechnen“ mit Abrechnungsmonat und Rechnungsdatum.
 */

const target = (sv: SiteServiceRow) =>
  sv.separate_invoice ? 'eigene Rechnung' : sv.group_name ? `Gruppe: ${sv.group_name}` : 'wie Objekt';

const lineTotal = (sv: SiteServiceRow) => (sv.quantity_milli * sv.unit_price_cents + 500n) / 1000n;

/** Leistungen als ruhige Zeilen (Ahmed 08.10.: „übersichtlicher“): Titel + Art, Zeitraum/Zyklus, Menge × Preis, Gesamt. */
const ServiceGroup: FC<{ title: string; rows: SiteServiceRow[]; siteId: string }> = ({
  title,
  rows,
  siteId,
}) =>
  rows.length === 0 ? null : (
    <div class="svc-group">
      {title && (
        <div class="svc-head">
          {title} <span class="mut">({rows.length})</span>
        </div>
      )}
      {rows.map((sv) => {
        const lines = (sv.note ?? '').split('\n').filter((x) => x.trim());
        return (
          <a class="svc-row" href={`/objekte/${siteId}/leistungen/${sv.id}`}>
            <div class="svc-main">
              <b>{sv.description}</b>
              <div class="small mut">
                {[
                  sv.type_name,
                  sv.always_unfinished ? 'immer unfertig' : null,
                  sv.order_reference ? `Bestellnr. ${sv.order_reference}` : null,
                  target(sv) === 'wie Objekt' ? null : target(sv),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {lines.length > 0 && (
                <div class="svc-note small" title={sv.note ?? ''}>
                  {lines.slice(0, 2).join(' · ')}
                  {lines.length > 2 && <span class="mut"> … (+{lines.length - 2} Zeilen)</span>}
                </div>
              )}
            </div>
            <div class="svc-when small">
              <div>{CYCLE_LABEL[sv.billing_cycle]}</div>
              <div class="mut">
                ab {dateDe(sv.valid_from)}
                {sv.valid_to ? ` bis ${dateDe(sv.valid_to)}` : ''}
              </div>
              {sv.last_billed_month && <div class="mut">zuletzt {monthLabelDe(sv.last_billed_month)}</div>}
            </div>
            <div class="svc-qty small">
              {milliToInput(sv.quantity_milli)} {UNIT_LABELS[sv.unit_code] ?? sv.unit_code} ×{' '}
              {euro(sv.unit_price_cents)}
            </div>
            <div class="svc-total">{euro(lineTotal(sv))}</div>
          </a>
        );
      })}
    </div>
  );

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
  const isRun = (s: SiteServiceRow) => s.billing_cycle === 'je_ausfuehrung' || s.billing_cycle === 'einmalig';
  const regular = active.filter((s) => !isRun(s));
  const perRun = active.filter(isRun);
  const monthly = regular
    .filter((s) => s.billing_cycle === 'monatlich')
    .reduce((a, s) => a + lineTotal(s), 0n);
  return (
    <>
      <div class="actions" style="margin-top:0">
        <a class="btn sm" href={`/objekte/${siteId}/leistungen/${newServiceId}`}>
          + Leistung anlegen
        </a>
        {siteGroup && <span class="small mut">Rechnungsgruppe des Objekts: {siteGroup}</span>}
        {monthly > 0n && (
          <span class="svc-sum">
            regelmäßig je Monat: <b>{euro(monthly)}</b> netto
          </span>
        )}
      </div>
      {active.length === 0 && <div class="empty">Noch keine aktiven Leistungen.</div>}
      <ServiceGroup title="Regelmäßige Leistungen" rows={regular} siteId={siteId} />
      <ServiceGroup title="Je Ausführung / einmalig" rows={perRun} siteId={siteId} />
      {inactive.length > 0 && (
        <details class="svc-old">
          <summary>Beendete Leistungen ({inactive.length})</summary>
          <ServiceGroup title="" rows={inactive} siteId={siteId} />
        </details>
      )}
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
  siteNo?: string;
  /** Kopie: Felder aus `sv` vorbelegt, wird als neue Leistung gespeichert */
  copy?: boolean;
  /** Objekte des Kunden für „Kopieren in …“ */
  copyTargets?: { id: string; site_no: string; name: string }[];
}> = ({ siteId, id, sv: src, types, groups, today, siteNo, copy, copyTargets }) => {
  const sv = src && copy ? { ...src, version: null, cost_center: siteNo ?? src.cost_center } : src;
  const existing = !!src && !copy;
  const tgt = sv?.separate_invoice ? 'separat' : (sv?.invoice_group_id ?? 'objekt');
  return (
    <>
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
        <h2 style="margin-top:0">
          {copy && src
            ? `Kopie von „${src.description}“`
            : sv
              ? `Leistung „${sv.description}“`
              : 'Neue Leistung'}
        </h2>
        {copy && (
          <div class="banner" style="margin-bottom:10px">
            Kopie – prüfen und mit „Leistung anlegen“ speichern. Die ursprüngliche Leistung bleibt
            unverändert.
          </div>
        )}

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
            <label for="description">Leistung (Titel auf der Rechnung) *</label>
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
            <select
              id="service_type_id"
              name="service_type_id"
              onchange="var d=document.getElementById('description');if(d&&!d.value.trim()&&this.value)d.value=this.options[this.selectedIndex].text;var l=document.getElementById('labor_share'),o=this.options[this.selectedIndex];if(l&&!l.value.trim()&&o.dataset.labor)l.value=o.dataset.labor"
            >
              <option value="">– keine –</option>
              {types.map((t) => (
                <option
                  value={t.id}
                  selected={t.id === sv?.service_type_id}
                  data-labor={
                    t.labor_share_bp != null ? String(t.labor_share_bp / 100).replace('.', ',') : ''
                  }
                >
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div style="grid-column:1/-1">
            <label for="note">Beschreibung (Zusatztext auf der Rechnung)</label>
            <textarea
              id="note"
              name="note"
              rows={3}
              placeholder="z. B. 3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026 (Enter = neue Zeile)"
            >
              {sv?.note ?? ''}
            </textarea>
          </div>
          <div>
            <label for="cost_center">Kostenstelle</label>
            <input
              id="cost_center"
              name="cost_center"
              value={sv?.cost_center ?? siteNo ?? ''}
              placeholder={siteNo ?? ''}
            />
          </div>
        </div>

        <h3>Abrechnung</h3>
        <div class="grid">
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
            <label for="order_reference">Bestellnummer des Kunden</label>
            <input
              id="order_reference"
              name="order_reference"
              value={sv?.order_reference ?? ''}
              maxlength={100}
              placeholder="z. B. 4500123456"
            />
            <div class="small mut">
              Erscheint auf der Rechnung (E-Rechnung BT-13). Mehrere Leistungen mit verschiedenen Nummern auf
              einer Rechnung: je Position im Text.
            </div>
          </div>
          <div>
            <label for="billing_cycle">Abrechnungszyklus (Einheit Stunde = je Ausführung)</label>
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
            <input
              id="quantity"
              name="quantity"
              value={sv ? milliToInput(sv.quantity_milli) : '1'}
              required
            />
          </div>
          <div>
            <label for="unit_price">Preis (netto, €, zzgl. 19 % USt) *</label>
            <input
              id="unit_price"
              name="unit_price"
              value={sv ? centsToInput(sv.unit_price_cents) : ''}
              placeholder="3.257,05"
              required
            />
          </div>
          <div>
            <label for="labor_share">Lohnkostenanteil (%) *</label>
            <input
              id="labor_share"
              name="labor_share"
              value={sv?.labor_share_bp != null ? String(sv.labor_share_bp / 100).replace('.', ',') : ''}
              placeholder="z. B. 80"
              inputmode="decimal"
              required
            />
            <div class="small mut">
              Anteil der Lohnkosten am Preis – Grundlage für Preisanpassungen bei Tariflohnerhöhungen.
            </div>
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
          <button class="btn">{existing ? 'Leistung aktualisieren' : 'Leistung anlegen'}</button>
        </div>
      </form>
      {existing && src && (
        <form
          method="get"
          action={`/objekte/${siteId}/leistungen/kopieren`}
          class="card actions"
          style="max-width:900px"
        >
          <input type="hidden" name="von" value={src.id} />
          <b>Leistung kopieren</b>
          <span class="small mut">in Objekt</span>
          <select name="ziel" style="max-width:420px" data-nosearch>
            {(copyTargets ?? []).map((t) => (
              <option value={t.id} selected={t.id === siteId}>
                {t.site_no} · {t.name}
                {t.id === siteId ? ' (dieses Objekt)' : ''}
              </option>
            ))}
          </select>
          <button class="btn sec">Kopieren</button>
        </form>
      )}
    </>
  );
};
