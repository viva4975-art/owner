import type { FC } from 'hono/jsx';
import { Icon } from './icons.js';
import { INBOX_KIND, type InboxItem, type InboxKind } from './routes-inbox.js';

/*
 * Cockpit-Zeile der Übersicht (neue Oberfläche, Ahmed 13.11.): Eingang, Personal, Objekte mit großen Zahlen bzw.
 * Ringen. Jede Zahl führt auf die passende Liste.
 */

export interface CockpitData {
  inbox: InboxItem[];
  personal?: { absent: number; sick: number; noShift: number; permits: number; missing: number } | undefined;
  objects?: { uncovered: number; tickets: number; auditDue: number } | undefined;
}

const Ring: FC<{ n: number; of?: number; color: string; label: string; sub?: string; href: string }> = ({
  n,
  of,
  color,
  label,
  sub,
  href,
}) => {
  const p = of ? Math.min(100, Math.round((n / of) * 100)) : n > 0 ? 35 : 0;
  return (
    <a class="ck-r" href={href}>
      <span class="ring" style={`--p:${p};--c:${color}`}>
        <span>{n}</span>
      </span>
      <span>
        {label}
        {sub && <small>{sub}</small>}
      </span>
    </a>
  );
};

const TONE: Record<string, string> = {
  g: 'background:#E3F4EA;color:#1F9D55',
  y: 'background:#FDF2DC;color:#9A6400',
  b: 'background:#E6EEFB;color:#2F6FDB',
  n: 'background:#F7EDF1;color:#811D40',
  r: 'background:#FBE5E5;color:#D23B3B',
};

export const CockpitRow: FC<{ d: CockpitData }> = ({ d }) => {
  const kinds = (Object.keys(INBOX_KIND) as InboxKind[])
    .map((k) => ({ k, n: d.inbox.filter((i) => i.kind === k).length }))
    .filter((x) => x.n > 0);
  const urgent = d.inbox.filter((i) => i.tags.some((t) => t.tone === 'err')).length;
  return (
    <div class="ck-row">
      <section class="ck">
        <h3>
          <Icon name="inbox" size={17} /> Eingang
          <a class="go" href="/eingang" aria-label="Zum Eingang">
            <Icon name="arrowRight" size={16} />
          </a>
        </h3>
        {kinds.length === 0 ? (
          <div class="small mut">Nichts offen – alles erledigt.</div>
        ) : (
          <div class="ck-list">
            {kinds.map(({ k, n }) => (
              <a href={`/eingang?art=${k}`}>
                <span class="ck-dot" style={TONE[INBOX_KIND[k].tone]}>
                  <Icon name={INBOX_KIND[k].icon} size={15} />
                </span>
                {INBOX_KIND[k].label}
                <span class="n">{n}</span>
              </a>
            ))}
          </div>
        )}
        {urgent > 0 && (
          <div class="small" style="margin-top:8px;color:#B42323">
            {urgent} davon dringend bzw. überfällig
          </div>
        )}
      </section>
      {d.personal && (
        <section class="ck">
          <h3>
            <Icon name="users" size={17} /> Personal
            <a class="go" href="/personal" aria-label="Zum Personal">
              <Icon name="arrowRight" size={16} />
            </a>
          </h3>
          <div class="ck-rings">
            <Ring
              n={d.personal.absent}
              color="#E8A317"
              label="abwesend heute"
              sub={`${d.personal.sick} krank`}
              href="/urlaub/kalender"
            />
            <Ring
              n={d.personal.noShift}
              color="#D23B3B"
              label="ohne Einsatz"
              href="/personal?status=aktiv&einsatz=ohne"
            />
            <Ring
              n={d.personal.permits}
              color="#D23B3B"
              label="Aufenthalt"
              sub="läuft ab / fehlt"
              href="/eingang?art=personal"
            />
            <Ring
              n={d.personal.missing}
              color="#E8A317"
              label="Unterlagen"
              sub="fehlen"
              href="/personal/unterlagen"
            />
          </div>
        </section>
      )}
      {d.objects && (
        <section class="ck">
          <h3>
            <Icon name="building" size={17} /> Objekte
            <a class="go" href="/objekte" aria-label="Zu den Objekten">
              <Icon name="arrowRight" size={16} />
            </a>
          </h3>
          <div class="ck-tiles">
            <a class="ck-t" href="/einsatzplanung/vertretungen">
              <b style={d.objects.uncovered ? 'color:#D23B3B' : ''}>{d.objects.uncovered}</b>
              <small>Vertretung fehlt (7 Tage)</small>
            </a>
            <a class="ck-t" href="/qm/tickets">
              <b style={d.objects.tickets ? 'color:#9A6400' : ''}>{d.objects.tickets}</b>
              <small>Tickets offen</small>
            </a>
            <a class="ck-t" href="/qualitaet">
              <b>{d.objects.auditDue}</b>
              <small>Audit fällig (60 Tage)</small>
            </a>
          </div>
        </section>
      )}
    </div>
  );
};
