/*
 * Ansichten der Nach- und Plan-Kalkulation (Ahmed 16.11.): je Objekt (wie bisher), je Kunde und je Auftragsgruppe –
 * Gruppenzeile mit Summen, Objekte darunter aufklappbar.
 */

export type CostView = 'objekt' | 'kunde' | 'gruppe';

export const costView = (q: string | undefined): CostView => (q === 'kunde' || q === 'gruppe' ? q : 'objekt');

export interface CostGroup<T> {
  key: string;
  name: string;
  href: string | null;
  rows: T[];
}

/** Zeilen gruppieren; Reihenfolge nach Name, „ohne Auftragsgruppe“ zuletzt. */
export function groupCostRows<
  T extends { site_id: string; customer_id: string; customer_name: string; customer_no?: string | null },
>(rows: T[], view: CostView, groupOf: Map<string, { id: string; name: string }>): CostGroup<T>[] {
  const out = new Map<string, CostGroup<T>>();
  for (const r of rows) {
    let key: string, name: string, href: string | null;
    if (view === 'kunde') {
      key = r.customer_id;
      name = r.customer_no ? `${r.customer_no} · ${r.customer_name}` : r.customer_name;
      href = `/kunden/${r.customer_id}`;
    } else {
      const g = groupOf.get(r.site_id);
      key = g ? g.id : '~ohne';
      name = g ? g.name : 'ohne Auftragsgruppe';
      href = g ? `/auswertungen/auftragsgruppen/${g.id}` : null;
    }
    const x = out.get(key) ?? { key, name, href, rows: [] };
    x.rows.push(r);
    out.set(key, x);
  }
  return [...out.values()].sort((a, b) =>
    a.key === '~ohne' ? 1 : b.key === '~ohne' ? -1 : a.name.localeCompare(b.name, 'de'),
  );
}

export const ViewChips = (p: { view: CostView; href: (v: CostView) => string }) => (
  <div class="chips" style="margin:0 0 10px;align-items:center">
    <span class="small mut" style="margin-right:4px">
      Ansicht:
    </span>
    {(
      [
        ['objekt', 'je Objekt'],
        ['kunde', 'je Kunde'],
        ['gruppe', 'je Auftragsgruppe'],
      ] as [CostView, string][]
    ).map(([v, l]) => (
      <a href={p.href(v)} class={p.view === v ? 'on' : ''}>
        {l}
      </a>
    ))}
    {p.view === 'gruppe' && (
      <a href="/auswertungen/auftragsgruppen" class="small" style="margin-left:8px">
        Auftragsgruppen verwalten
      </a>
    )}
    {p.view !== 'objekt' && (
      <button type="button" class="btn ghost sm" data-grp-all style="margin-left:auto">
        Alle aufklappen
      </button>
    )}
  </div>
);

export const GROUP_CSS = `tr.grp-head{cursor:pointer;background:#fafafb}tr.grp-head:hover{background:#f3eef0}
tr.grp-head td:first-child b::before{content:'▸ ';color:var(--brand,#7D1435)}tr.grp-head.open td:first-child b::before{content:'▾ '}
tr.grp-child td:first-child{padding-left:28px}`;

export const GROUP_JS = `(function(){
  function set(h,open){h.classList.toggle('open',open);document.querySelectorAll('tr.grp-child[data-grp="'+h.getAttribute('data-grp-head')+'"]').forEach(function(r){r.hidden=!open})}
  document.addEventListener('click',function(e){
    var a=e.target.closest('[data-grp-all]');
    if(a){var hs=document.querySelectorAll('tr.grp-head');var open=!(hs[0]&&hs[0].classList.contains('open'));hs.forEach(function(h){set(h,open)});a.textContent=open?'Alle zuklappen':'Alle aufklappen';return}
    var h=e.target.closest('tr.grp-head'); if(!h||e.target.closest('a')) return;
    set(h,!h.classList.contains('open'));
  });
})();`;

/** Adresse der Seite mit anderer Ansicht (Filter bleiben, Zeitraum als von/bis). */
export function viewHref(url: string, v: CostView, von: string, bis: string) {
  const u = new URL(url);
  u.searchParams.set('von', von);
  u.searchParams.set('bis', bis);
  u.searchParams.delete('monat');
  if (v === 'objekt') u.searchParams.delete('ansicht');
  else u.searchParams.set('ansicht', v);
  return `${u.pathname}?${u.searchParams.toString()}`;
}
