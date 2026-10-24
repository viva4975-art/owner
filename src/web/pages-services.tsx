import { AddressBlock } from './address-block.js';
import type { FC } from 'hono/jsx';
import {
  type BillingCycle,
  CYCLE_LABEL,
  billsInMonthlyRun,
  isPeriodic,
  monthBounds,
  monthLabelDe,
  serviceQuantity,
  todayBerlin,
} from '../domain/invoice/calc.js';
import type { Cents, Quantity, VatRate } from '../domain/money/money.js';
import { workDaysLabel } from '../services/subcontract-days.js';
import { UNIT_LABELS, unitLabel } from '../domain/invoice/types.js';
import type { InvoiceGroupRow } from '../services/invoice-groups.js';
import type { ServiceType, SiteService, SiteServiceRow } from '../services/masterdata.js';
import { centsToInput, milliToInput } from './forms.js';
import { Icon } from './icons.js';
import { dateDe, euro } from './layout.js';
import { TypeSelect } from './pages-invoices.js';

/*
 * Leistungen am Objekt wie die Fortytools-„Aufträge“: Liste aktiver Leistungen, Bearbeiten je Leistung
 * (Abrechnung, Ausführung) und „Regelmäßige Leistung(en) abrechnen“ mit Abrechnungsmonat und Rechnungsdatum.
 */

const target = (sv: SiteServiceRow) =>
  (sv.separate_invoice ? 'eigene Rechnung' : sv.group_name ? `Gruppe: ${sv.group_name}` : 'wie Objekt') +
  (sv.bill_address ? ` · Rechnung an ${sv.bill_address.name}` : '');

/** Menge im laufenden Monat (bei „nach Arbeitstagen“ berechnet) */
const qtyNow = (sv: SiteServiceRow): bigint => {
  if (!sv.work_days?.length) return sv.quantity_milli;
  const m = monthBounds(todayBerlin().slice(0, 7));
  return serviceQuantity(
    {
      ...sv,
      id: sv.id,
      kind: 'monthly_flat',
      unitCode: sv.unit_code,
      quantity: sv.quantity_milli as Quantity,
      unitPrice: sv.unit_price_cents as Cents,
      vatRate: sv.vat_rate_bp as VatRate,
      validFrom: sv.valid_from,
      validTo: sv.valid_to,
      workDays: sv.work_days,
      hoursPerDay: sv.hours_per_day_milli as Quantity | null,
    },
    m.start,
    m.end,
  );
};
const lineTotal = (sv: SiteServiceRow) => (qtyNow(sv) * sv.unit_price_cents + 500n) / 1000n;

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
          <div class="svc-line">
            <a class="svc-row" href={`/objekte/${siteId}/leistungen/${sv.id}`}>
              <div class="svc-main">
                <b>{sv.description}</b>
                <div class="small mut">
                  {[
                    sv.type_name,
                    sv.always_unfinished ? 'immer unfertig' : null,
                    sv.attach_timesheet ? 'mit Stundennachweis' : null,
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
                <div>
                  {CYCLE_LABEL[sv.billing_cycle]}
                  {sv.kind !== 'monthly_flat' && isPeriodic(sv.billing_cycle) && ' · nach Ausführung'}
                </div>
                <div class="mut">
                  ab {dateDe(sv.valid_from)}
                  {sv.valid_to ? ` bis ${dateDe(sv.valid_to)}` : ''}
                </div>
                {sv.last_billed_month && <div class="mut">zuletzt {monthLabelDe(sv.last_billed_month)}</div>}
              </div>
              <div class="svc-qty small">
                {milliToInput(qtyNow(sv))} {unitLabel(sv.unit_code, qtyNow(sv))} × {euro(sv.unit_price_cents)}
                {!!sv.work_days?.length && (
                  <div class="mut">
                    {workDaysLabel(sv.work_days)}
                    {sv.unit_code === 'HUR' && sv.hours_per_day_milli
                      ? ` × ${milliToInput(sv.hours_per_day_milli)} Std.`
                      : ''}{' '}
                    · diesen Monat
                  </div>
                )}
              </div>
              <div class="svc-total">{euro(lineTotal(sv))}</div>
            </a>
            <a
              class="svc-copy"
              href={`/objekte/${siteId}/leistungen/kopieren?von=${sv.id}&ziel=${siteId}`}
              title="Leistung kopieren (auch in ein anderes Objekt des Kunden)"
            >
              <Icon name="copy" /> <span>Kopieren</span>
            </a>
            <form method="post" action={`/leistungen/${sv.id}/aktiv`} class="svc-copy svc-act">
              <input type="hidden" name="site_id" value={siteId} />
              <input type="hidden" name="active" value={sv.active ? 'false' : 'true'} />
              <button
                type="submit"
                title={
                  sv.active
                    ? 'Leistung inaktiv setzen (wird nicht mehr abgerechnet)'
                    : 'Leistung wieder aktiv setzen'
                }
                data-confirm={
                  sv.active
                    ? `„${sv.description}“ inaktiv setzen? Sie wird nicht mehr abgerechnet und steht unter „Inaktive Leistungen“.`
                    : undefined
                }
              >
                <Icon name={sv.active ? 'x' : 'undo'} /> <span>{sv.active ? 'Inaktiv' : 'Aktivieren'}</span>
              </button>
            </form>
          </div>
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
  const isRun = (s: SiteServiceRow) => !billsInMonthlyRun(s.kind, s.billing_cycle);
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
      <ServiceGroup title="Nach Ausführung (je Ausführung, einmalig, Zyklus)" rows={perRun} siteId={siteId} />
      {inactive.length > 0 && (
        <details class="svc-old">
          <summary>Inaktive Leistungen ({inactive.length})</summary>
          <ServiceGroup title="" rows={inactive} siteId={siteId} />
        </details>
      )}
      {hours > 0n && (
        <p class="small mut">Stundenvorgabe laut Leistungen: {milliToInput(hours)} Std. je Monat</p>
      )}

      <div class="card" style="margin-top:14px">
        <h3>Regelmäßige Leistungen abrechnen</h3>
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
            Leistungen abrechnen ({open.length})
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
  /** Vorbelegung der abweichenden Rechnungsanschrift (Anschrift laut Objekt/Gruppe/Kunde) */
  defaultAddress?: NonNullable<SiteService['bill_address']> | undefined;
}> = ({ siteId, id, sv: src, types, groups, today, siteNo, copy, copyTargets, defaultAddress }) => {
  const sv = src && copy ? { ...src, version: null, cost_center: siteNo ?? src.cost_center } : src;
  const existing = !!src && !copy;
  const tgt = sv?.separate_invoice ? 'separat' : (sv?.invoice_group_id ?? 'objekt');
  return (
    <>
      {copy && src && (copyTargets ?? []).length > 1 && (
        <form
          method="get"
          action={`/objekte/${siteId}/leistungen/kopieren`}
          class="card actions"
          style="max-width:900px;margin-bottom:12px"
        >
          <input type="hidden" name="von" value={src.id} />
          <b>Kopie anlegen in Objekt</b>
          <select name="ziel" style="max-width:420px" data-nosearch onchange="this.form.submit()">
            {(copyTargets ?? []).map((t) => (
              <option value={t.id} selected={t.id === siteId}>
                {t.site_no} · {t.name}
              </option>
            ))}
          </select>
          <noscript>
            <button class="btn sec sm">Wechseln</button>
          </noscript>
        </form>
      )}
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
            <label for="service_type_id">Leistungsart (Titel auf der Rechnung) *</label>
            <TypeSelect
              id="service_type_id"
              name="service_type_id"
              descName="description"
              types={types}
              typeId={sv?.service_type_id}
              desc={sv?.description}
              required
              onchange="var o=this.options[this.selectedIndex],d=this.form.querySelector('[name=description]');if(d)d.value=o&&(o.value||o.hasAttribute('data-keep'))?o.text:'';var l=document.getElementById('labor_share');if(l&&!l.value.trim()&&o&&o.dataset.labor)l.value=o.dataset.labor"
            />
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
          <div style="grid-column:1/-1">
            <div class="chk">
              <input
                type="checkbox"
                id="bill_custom"
                name="bill_custom"
                data-reveal="#bill-fields"
                checked={!!sv?.bill_address}
              />
              <label for="bill_custom">
                Andere Rechnungsanschrift für diese Leistung (z. B. andere Gesellschaft oder Hausverwaltung)
              </label>
            </div>
            <div id="bill-fields" hidden={!sv?.bill_address} style="margin-top:6px">
              <AddressBlock
                id="bill_block"
                value={sv?.bill_address ?? defaultAddress}
                label="Rechnungsanschrift *"
              />
              <p class="small mut" style="margin:6px 0 0">
                Die Leistung kommt dann auf eine eigene Rechnung an diese Anschrift (Leistungen mit gleicher
                Anschrift am selben Objekt zusammen). Format, E-Mail, Zahlungsziel und Leitweg-ID bleiben wie
                in der Rechnungsgruppe – für einen anderen Empfänger mit eigenen Angaben besser eine eigene
                Rechnungsgruppe anlegen.
              </p>
            </div>
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
            <label for="bill_mode">Abrechnung bei 2-monatlich … jährlich</label>
            <select id="bill_mode" name="bill_mode">
              <option value="ausfuehrung" selected={!sv || sv.kind !== 'monthly_flat'}>
                nach Ausführung (Leistungen verrichten)
              </option>
              <option value="automatisch" selected={!!sv && sv.kind === 'monthly_flat'}>
                automatisch im Monatslauf (im Voraus je Zyklus)
              </option>
            </select>
            <div class="small mut">
              Nach Ausführung: Die Leistung wird erst abgerechnet, wenn sie unter „Leistungen verrichten“ als
              erledigt eingetragen ist; der Zyklus zeigt nur an, wann sie wieder fällig ist. Monatlich wird
              immer automatisch abgerechnet.
            </div>
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
          <div
            id="qty-fixed"
            hidden={!!sv?.work_days?.length && (sv.unit_code === 'DAY' || sv.unit_code === 'HUR')}
          >
            <label for="quantity">Menge *</label>
            <input id="quantity" name="quantity" value={sv ? milliToInput(sv.quantity_milli) : '1'} />
          </div>
          {/* Ahmed 24.10.: je Tag / je Stunde – Menge je Monat aus den Arbeitstagen ohne Feiertage */}
          <div
            id="svc-days"
            style="grid-column:1/-1"
            hidden={(sv?.unit_code ?? 'LS') !== 'DAY' && (sv?.unit_code ?? 'LS') !== 'HUR'}
          >
            <div class="chk">
              <input
                type="checkbox"
                id="days_auto"
                checked={!!sv?.work_days?.length}
                data-reveal="#svc-days-f"
              />
              <label for="days_auto">
                Menge automatisch nach Arbeitstagen berechnen (je Abrechnungszeitraum)
              </label>
            </div>
            <div id="svc-days-f" class="ln-days" hidden={!sv?.work_days?.length}>
              <span class="small mut">Tage:</span>
              {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d, i) => (
                <label class="ln-wd">
                  <input
                    type="checkbox"
                    name="work_days"
                    value={String(i + 1)}
                    checked={sv?.work_days?.length ? sv.work_days.includes(i + 1) : i < 5}
                  />
                  {d}
                </label>
              ))}
              <label class="ln-wd" id="svc-hpd" hidden={sv?.unit_code !== 'HUR'}>
                Std. je Tag
                <input
                  name="hours_per_day"
                  inputmode="decimal"
                  style="width:70px"
                  value={sv?.hours_per_day_milli ? milliToInput(sv.hours_per_day_milli) : ''}
                  placeholder="2,5"
                />
              </label>
              <span class="small mut">
                Menge = Arbeitstage im Abrechnungszeitraum (ohne Feiertage Bayern, nur innerhalb Beginn/Ende){' '}
                × Std. je Tag – im Monatslauf je Monat neu berechnet.
              </span>
            </div>
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){var u=document.getElementById('unit_code'),box=document.getElementById('svc-days'),a=document.getElementById('days_auto'),f=document.getElementById('svc-days-f'),q=document.getElementById('qty-fixed'),h=document.getElementById('svc-hpd');if(!u||!box)return;
function sync(){var on=u.value==='DAY'||u.value==='HUR';box.hidden=!on;h.hidden=u.value!=='HUR';var auto=on&&a.checked;f.hidden=!auto;q.hidden=auto;f.querySelectorAll('input').forEach(function(i){i.disabled=!auto;});}
u.addEventListener('change',sync);a.addEventListener('change',sync);sync();})();`,
            }}
          />
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
        <div class="chk" style="margin-top:6px">
          <input type="hidden" name="attach_timesheet_field" value="1" />
          <input
            type="checkbox"
            id="attach_timesheet"
            name="attach_timesheet"
            checked={sv?.attach_timesheet ?? false}
          />
          <label for="attach_timesheet">
            Geschwärzten Stundennachweis an die Rechnung anhängen (erfasste Zeiten des Objekts im
            Leistungszeitraum, Namen geschwärzt – z. B. für die Unterhaltsreinigung)
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
    </>
  );
};
