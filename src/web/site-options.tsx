import type { FC } from 'hono/jsx';

/** Objekt für Auswahllisten: Kunde immer dabei (gruppiert), damit gleich benannte Objekte unterscheidbar sind. */
export interface SiteOpt {
  id: string;
  site_no: string;
  name: string;
  customer_name?: string | null | undefined;
}

/**
 * <option>s je Kunde in einer <optgroup> („Kunde“), Text „Nr. · Objekt“. Die Such-Auswahl (client.ts) zeigt den Kunden
 * als Überschrift, findet ihn bei der Suche und zeigt ihn im geschlossenen Feld hinter dem Objekt.
 */
export const SiteOptions: FC<{ sites: SiteOpt[]; selected?: string | null | undefined }> = ({
  sites,
  selected,
}) => {
  // Ohne Kundennamen (z. B. Objekte eines bereits gewählten Kunden): einfache Liste
  if (!sites.some((s) => s.customer_name))
    return (
      <>
        {sites.map((s) => (
          <option value={s.id} selected={!!selected && s.id === selected}>
            {s.site_no} · {s.name}
          </option>
        ))}
      </>
    );
  const groups = new Map<string, SiteOpt[]>();
  for (const s of sites) {
    const k = s.customer_name?.trim() || 'ohne Kunde';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  return (
    <>
      {[...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], 'de'))
        .map(([k, list]) => (
          <optgroup label={k} data-cust="1">
            {list.map((s) => (
              <option value={s.id} selected={!!selected && s.id === selected}>
                {s.site_no} · {s.name}
              </option>
            ))}
          </optgroup>
        ))}
    </>
  );
};
