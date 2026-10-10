import {
  isPreset,
  type PaymentTerms,
  TERMS_PRESETS,
  termsKey,
  termsLabel,
} from '../domain/invoice/payment-terms.js';

/**
 * Zahlungsbedingung als Auswahl (Standard 10 Tage netto ohne Skonto). „andere …“ blendet die Einzelfelder ein –
 * die Feldnamen bleiben die bisherigen, der Server übersetzt die Auswahl (applyTermsChoice).
 */
export function PaymentTermsField(p: {
  id: string;
  name: string;
  value: PaymentTerms | null;
  names: { days: string; percent: string; skontoDays: string };
  label?: string;
}) {
  const v = p.value;
  const other = !!v && !isPreset(v);
  const sel = v && !other ? termsKey(v) : other ? 'andere' : termsKey(TERMS_PRESETS[0]!);
  return (
    <>
      <div>
        <label for={p.id}>{p.label ?? 'Zahlungsbedingung'} *</label>
        <select id={p.id} name={p.name} data-reveal={`#${p.id}-x`}>
          {TERMS_PRESETS.map((t, i) => (
            <option value={termsKey(t)} selected={sel === termsKey(t)}>
              {termsLabel(t)}
              {i === 0 ? ' (Standard)' : ''}
            </option>
          ))}
          <option value="andere" selected={sel === 'andere'}>
            andere …{other && v ? ` (bisher: ${termsLabel(v)})` : ''}
          </option>
        </select>
      </div>
      <div id={`${p.id}-x`} hidden={!other} class="grid" style="grid-column:1/-1">
        <div>
          <label for={`${p.id}-d`}>Zahlungsziel (Tage)</label>
          <input
            id={`${p.id}-d`}
            name={p.names.days}
            type="number"
            min={0}
            max={365}
            value={String(v?.days ?? 10)}
          />
        </div>
        <div>
          <label for={`${p.id}-p`}>Skonto % (leer = kein Skonto)</label>
          <input
            id={`${p.id}-p`}
            name={p.names.percent}
            placeholder="z. B. 3"
            value={v?.skontoBp ? String(v.skontoBp / 100).replace('.', ',') : ''}
          />
        </div>
        <div>
          <label for={`${p.id}-s`}>Skonto innerhalb (Tage)</label>
          <input
            id={`${p.id}-s`}
            name={p.names.skontoDays}
            type="number"
            min={1}
            max={90}
            value={v?.skontoDays ? String(v.skontoDays) : ''}
          />
        </div>
      </div>
    </>
  );
}
