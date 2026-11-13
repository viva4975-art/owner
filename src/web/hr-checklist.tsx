import { randomUUID } from 'node:crypto';
import type { FC } from 'hono/jsx';
import { HR_STAGE, HR_STAGE_SELECTABLE, type CheckItem, type HrStage } from '../services/hr-stage.js';
import { Icon } from './icons.js';

/** Status-Schild wie Blink (Kopf und Liste) */
export const StagePill: FC<{ stage: HrStage }> = ({ stage }) => (
  <span class={`stage-pill st-${HR_STAGE[stage].tone}`}>{HR_STAGE[stage].label}</span>
);

/** „Aktionen ▾“ im Kopf des Mitarbeiters (neue Oberfläche) */
export const EmployeeActions: FC<{ id: string; stage: HrStage; canHr: boolean }> = ({ id, stage, canHr }) => {
  const base = `/personal/${id}`;
  return (
    <details class="dd emp-actions">
      <summary class="btn">
        Aktionen <Icon name="chevron" size={14} />
      </summary>
      <div class="drop right">
        <a href={`${base}/kalender`}>
          <Icon name="clock" size={15} /> Zeit erfassen
        </a>
        <a href={`${base}/abwesenheiten`}>
          <Icon name="sun" size={15} /> Abwesenheit erfassen
        </a>
        <a href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${id}&zurueck=${encodeURIComponent(base)}`}>
          <Icon name="calendar" size={15} /> Einsatz planen
        </a>
        <a href={`${base}/dokumente`}>
          <Icon name="file" size={15} /> Dokument erstellen …
        </a>
        <a href={`${base}/uebergaben`}>
          <Icon name="clipboard" size={15} /> Übergabe (Kleidung, Schlüssel)
        </a>
        <a href={`${base}/bearbeiten`}>
          <Icon name="pencil" size={15} /> Stammdaten bearbeiten
        </a>
        {canHr && stage !== 'ausgeschieden' && (
          <>
            <div class="sep" />
            <form method="post" action={`${base}/status`} class="stage-form">
              <label for="hrst">Status ändern</label>
              <select id="hrst" name="stage" data-autosubmit>
                {HR_STAGE_SELECTABLE.map((s) => (
                  <option value={s} selected={s === stage}>
                    {HR_STAGE[s].label}
                  </option>
                ))}
              </select>
            </form>
            <a href={`${base}#austritt`} class="danger">
              <Icon name="alert" size={15} /> Austritt erfassen
            </a>
          </>
        )}
      </div>
    </details>
  );
};

/** Checkliste Ein- bzw. Austritt */
export const ChecklistCard: FC<{
  id: string;
  phase: 'ein' | 'aus';
  items: CheckItem[];
  canEdit: boolean;
}> = ({ id, phase, items, canEdit }) => {
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return (
    <div class="card cl-card accent" id={phase === 'ein' ? 'checkliste' : 'austritt-checkliste'}>
      <div class="cl-head">
        <h2 style="margin:0">
          <Icon name="check2" size={18} />{' '}
          {phase === 'ein' ? 'Einstellung – Checkliste' : 'Austritt – Checkliste'}
        </h2>
        <span class="mut">
          {done} von {items.length}
        </span>
      </div>
      <div class="cl-bar">
        <i style={`width:${pct}%`} />
      </div>
      <ul class="cl-list">
        {items.map((i) => (
          <li class={i.done ? 'ok' : ''}>
            {i.auto || !canEdit ? (
              <span class="cl-box" aria-hidden="true">
                {i.done ? <Icon name="check" size={14} /> : null}
              </span>
            ) : (
              <form method="post" action={`/personal/${id}/checkliste`} class="cl-f">
                <input type="hidden" name="phase" value={phase} />
                <input type="hidden" name="key" value={i.key} />
                <input type="hidden" name="done" value={i.done ? '0' : '1'} />
                <button class="cl-box" title={i.done ? 'wieder offen' : 'als erledigt abhaken'}>
                  {i.done ? <Icon name="check" size={14} /> : null}
                </button>
              </form>
            )}
            <span class="cl-l">{i.label}</span>
            <span class="cl-i">{i.done ? (i.info ?? (i.auto ? 'automatisch' : '')) : ''}</span>
            {!i.done && i.href && (
              <a class="btn sm sec" href={i.href}>
                {i.hrefLabel ?? 'Öffnen'}
              </a>
            )}
            {i.own && canEdit && (
              <form method="post" action={`/personal/${id}/checkliste/loeschen`} class="cl-f">
                <input type="hidden" name="key" value={i.key} />
                <button class="btn sm ghost" title="Punkt löschen" data-confirm="Eigenen Punkt löschen?">
                  ×
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form method="post" action={`/personal/${id}/checkliste/neu`} class="cl-new">
          <input type="hidden" name="phase" value={phase} />
          <input type="hidden" name="new_id" value={randomUUID()} />
          <input name="label" placeholder="Neuen Punkt erfassen …" aria-label="Neuer Punkt" maxlength={200} />
          <button class="btn sm sec">Hinzufügen</button>
        </form>
      )}
      {phase === 'ein' && (
        <p class="small mut" style="margin:8px 0 0">
          Ist alles erledigt, wird der Status automatisch „Aktiv“. Grüne Punkte erkennt die App selbst (Akte,
          Übergaben, Planung).
        </p>
      )}
    </div>
  );
};
