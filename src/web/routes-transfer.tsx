import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { accountOverview, feedConfigInfo, feedStatus } from '../services/bank-feed.js';
import {
  assignDebitRun,
  assignIncoming,
  assignInvoices,
  assignParty,
  assignPaymentRun,
  assignReturn,
  type BankTx,
  closeBefore,
  EXPENSE_CATEGORY,
  quickSupplier,
  getTransaction,
  incomingForSupplier,
  type Suggestion,
  type SuggestionCache,
  type TxFilter,
  ignoreTransaction,
  importStatement,
  listImports,
  listTransactions,
  reopenTransaction,
  suggestions,
} from '../services/bank.js';
import {
  assignInboxFile,
  INBOX_ID,
  INBOX_TARGETS,
  type InboxTarget,
  inboxFiles,
  outbox,
} from '../services/documents.js';
import { BusinessError } from '../services/errors.js';
import { listLegacyOpenItems, listOpenItems } from '../services/payments.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { arr, str } from './forms.js';
import { PageHead, dateDe, euro, anz } from './layout.js';
import { canAccess } from './permissions.js';

const TX_STATUS: Record<string, string> = {
  offen: 'offen',
  zugeordnet: 'zugeordnet',
  ignoriert: 'ignoriert',
};
const TX_CSS = `
.tx-top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:10px 14px}
.tx-accts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tx-n{display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:#e9a23b;color:#fff;font-size:11px;font-weight:700;text-align:center;margin-left:4px}
.tx-list{padding:0}
.tx-row{display:grid;grid-template-columns:minmax(0,1.35fr) 110px 24px minmax(0,1.3fr) 230px;gap:14px;align-items:start;padding:14px 18px;border-bottom:1px solid var(--line,#e5e5e5)}
.tx-row:last-child{border-bottom:0}
.tx-iban{color:#9a9a9a;font-size:12.5px}
.tx-purpose{white-space:pre-wrap;word-break:break-word;font-size:13px;margin-top:2px}
.tx-amt{text-align:right;font-weight:600;padding-top:20px;white-space:nowrap}
.tx-amt.neg{color:#c0392b}.tx-amt.pos{color:#2e7d32}
.tx-arrow{color:#aaa;padding-top:20px}
.tx-btns{display:flex;flex-wrap:wrap;gap:4px}
.tx-sugg .tx-mini{margin-top:4px;font-size:13px;border-collapse:collapse}
.tx-sugg .tx-mini td{padding:1px 10px 1px 0;border:0;background:none}
.tx-act{display:flex;gap:6px;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap}
.tx-skip{margin:0;flex-basis:100%;text-align:right}.tx-skip .btn{font-size:12px;padding:2px 8px}
.tx-sugg .lbl{font-size:12.5px;color:#555;margin-top:2px}
.btn.ok,.tx-go{background:#a8dba8;color:#1d4d1d;border-color:#8cc98c}
.tx-go{width:100%}
.tx-head{margin-bottom:12px}
.tx-row.inl-open .tx-match{grid-column:4/-1}.tx-row.inl-open .tx-act{display:none}
.inl{border:1px solid var(--line,#ddd);border-radius:8px;padding:10px 12px;background:#fff}
.inl-tabs{display:flex;gap:6px;align-items:center;margin-bottom:8px}.inl-x{margin-left:auto;font-size:20px;text-decoration:none;color:#888}
.inl-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}.inl-row select,.inl-row input[name=note],.inl-row input[name=name]{flex:1;min-width:200px}
.inl-small{border-top:1px dashed #ddd;padding-top:8px;margin-top:10px}
.inl-sum{display:grid;grid-template-columns:auto auto auto auto 1fr;gap:4px 14px;align-items:center;margin:8px 0}
.inl-full{grid-column:1/-1;font-size:13px}
.inl-h{font-weight:600;margin:8px 0 4px}
.inl-item{display:grid;grid-template-columns:22px 110px 1fr 90px auto;gap:8px;align-items:center;padding:3px 0;cursor:pointer}
.inl-item .r{text-align:right;font-weight:600}
@media (max-width:900px){.tx-row{grid-template-columns:1fr auto}.tx-arrow{display:none}.tx-match,.tx-act{grid-column:1/-1}.tx-amt{padding-top:0}.tx-act{justify-content:flex-start}}
`;

// Zuordnen direkt in der Zeile (wie Fortytools): Kunde/Lieferant/Mitarbeiter öffnen sich in der Zeile, Auswahl lädt die
// offenen Rechnungen nach, Summe/Saldo werden beim Ankreuzen mitgerechnet. Ohne JavaScript führen die Links auf eigene Seiten.
const INLINE_JS = `(function(){
  function eur(c){var n=Number(c)/100;return n.toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';}
  function calc(f){var amt=Number(f.getAttribute('data-amount'));var sum=0;
    f.querySelectorAll('input[data-cents]').forEach(function(i){if(i.checked)sum+=Number(i.getAttribute('data-cents'));});
    var s=f.querySelector('[data-sum]'),d=f.querySelector('[data-saldo]');if(!s)return;
    s.textContent=eur(sum);var saldo=amt-sum;d.textContent=(saldo>0?'+':'')+eur(saldo)+(sum&&saldo?' ('+(Math.round(-saldo/sum*10000)/100).toLocaleString('de-DE')+' %)':'');
    d.style.color=saldo===0?'#2e7d32':'#c0392b';}
  function load(row,url){var box=row.querySelector('.tx-match');if(!row._orig)row._orig=box.innerHTML;row.classList.add('inl-open');
    box.innerHTML='<div class="mut small">lädt …</div>';
    fetch(url,{credentials:'same-origin',headers:{'X-Requested-With':'fetch'}}).then(function(r){return r.text();}).then(function(h){
      box.innerHTML=h;box.querySelectorAll('form.inl-pick').forEach(calc);});}
  document.addEventListener('click',function(e){
    var a=e.target.closest('[data-inline]');var x=e.target.closest('[data-inline-close]');
    if(x){e.preventDefault();var r=x.closest('.tx-row');var b=r.querySelector('.tx-match');b.innerHTML=r._orig||'';r.classList.remove('inl-open');return;}
    if(!a)return;var row=a.closest('.tx-row');if(!row)return;e.preventDefault();load(row,a.getAttribute('data-inline'));});
  document.addEventListener('change',function(e){
    var s=e.target.closest('select[data-inline-pick]');if(s){load(s.closest('.tx-row'),s.getAttribute('data-inline-pick')+encodeURIComponent(s.value));return;}
    var f=e.target.closest('form.inl-pick');if(f)calc(f);});
})();`;
const CategorySelect = ({ id }: { id: string }) => (
  <div style="min-width:220px">
    <label for={id}>Kostenart (für die Ausgaben-Statistik)</label>
    <select id={id} name="kategorie">
      <option value="">– ohne –</option>
      {Object.entries(EXPENSE_CATEGORY).map(([k, v]) => (
        <option value={k}>{v}</option>
      ))}
    </select>
  </div>
);
const isDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const at = (d: Date) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });

export function registerTransferRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  const shell = (c: Context<AppEnv>, active: string, title: string, body: Child) => {
    void active; // Bereiche stehen links im Menü (keine doppelte Reiterzeile)
    return page(
      c,
      title,
      'transfer',
      <>
        <PageHead title={title} crumbs={[['Transfer', '/transfer/kontoumsaetze']]} />
        {body}
      </>,
    );
  };

  // ================================================================ Kontoumsätze (wie Fortytools „Neue Umsätze zuordnen“)
  const PAGE = 40;
  const BACK = '/transfer/kontoumsaetze';
  const ibanShort = (i: string) => i.replace(/(.{4})/g, '$1 ').trim();

  app.get('/transfer/kontoumsaetze', async (c) => {
    const raw = c.req.query('status') ?? 'offen';
    const status: TxFilter = (['offen', 'erledigt', 'alle'] as const).includes(raw as 'offen')
      ? (raw as TxFilter)
      : 'offen';
    const konto = c.req.query('konto') ?? '';
    const seite = Math.max(1, Number(c.req.query('seite') ?? 1) || 1);
    const role = c.get('user').role;
    const [rows, accounts, feed, cfg, imports] = await Promise.all([
      listTransactions(sql, { status, account: konto || null, limit: PAGE, offset: (seite - 1) * PAGE }),
      accountOverview(sql),
      feedStatus(sql),
      feedConfigInfo(sql),
      listImports(sql),
    ]);
    const cache: SuggestionCache = {};
    const sugg = await Promise.all(
      rows.map((t) =>
        t.status === 'offen' ? suggestions(sql, t, cache) : Promise.resolve([] as Suggestion[]),
      ),
    );
    const sure = rows.filter(
      (t, i) => sugg[i]![0] && 'confidence' in sugg[i]![0]! && sugg[i]![0]!.confidence === 'sicher',
    );
    const totalOpen = accounts.reduce((a, b) => a + b.open, 0);
    const soon = feed.connections.filter(
      (x) => x.status === 'aktiv' && x.valid_until && x.valid_until.getTime() - Date.now() < 14 * 86400_000,
    );
    const expired = feed.connections.filter((x) => x.status === 'abgelaufen');
    const lastFetch = feed.accounts
      .map((a) => a.last_fetch_at)
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const q = (o: Record<string, string | number>) => {
      const p = new URLSearchParams({
        status,
        ...(konto ? { konto } : {}),
        ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])),
      });
      return `${BACK}?${p}`;
    };
    const pages = Math.max(1, Math.ceil(rows.total / PAGE));
    return shell(
      c,
      'konto',
      status === 'offen' ? 'Neue Umsätze zuordnen' : 'Kontoumsätze',
      <>
        <style>{TX_CSS}</style>
        <div class="card tx-top">
          <div class="tx-accts">
            <a class={`chip ${konto ? '' : 'on'}`} href={`${BACK}?status=${status}`}>
              Alle Konten {totalOpen > 0 && <span class="tx-n">{totalOpen}</span>}
            </a>
            {accounts.map((a) => (
              <a
                class={`chip ${konto === a.iban ? 'on' : ''}`}
                href={`${BACK}?status=${status}&konto=${a.iban}`}
              >
                {a.name} ··{a.iban.slice(-6)} {a.open > 0 && <span class="tx-n">{a.open}</span>}
              </a>
            ))}
            <a href={`/transfer/kontoauszug${konto ? `?konto=${konto}` : ''}`} style="margin-left:6px">
              Zum Kontoauszug
            </a>
          </div>
          <div class="tx-feed">
            {cfg && feed.accounts.length > 0 ? (
              <form
                method="post"
                action="/transfer/bank/abrufen"
                style="margin:0;display:flex;gap:8px;align-items:center"
              >
                <span class="small mut">
                  {lastFetch ? `zuletzt abgerufen ${at(lastFetch)}` : 'noch nicht abgerufen'} · automatisch
                  bis 4× täglich
                </span>
                <button class="btn sm">⟳ Umsätze abrufen</button>
              </form>
            ) : (
              <span class="small mut">
                Bankabruf noch nicht verbunden
                {canAccess(role, '/einstellungen/bankabruf') && (
                  <>
                    {' '}
                    – <a href="/einstellungen/bankabruf">jetzt einrichten</a>
                  </>
                )}
              </span>
            )}
          </div>
        </div>
        {(soon.length > 0 || expired.length > 0) && (
          <div class={`notice ${expired.length ? 'err' : 'warn'}`}>
            {expired.length > 0
              ? `Freigabe abgelaufen: ${expired.map((x) => x.aspsp_name).join(', ')} – Bank neu verbinden (Online-Banking-Login + TAN).`
              : `Freigabe läuft bald ab: ${soon.map((x) => `${x.aspsp_name} (${at(x.valid_until!)})`).join(', ')} – rechtzeitig neu verbinden.`}{' '}
            {canAccess(role, '/einstellungen/bankabruf') && <a href="/einstellungen/bankabruf">Bankabruf</a>}
          </div>
        )}
        {accounts.some((a) => a.notInCompany) && (
          <div class="notice warn">
            Konto aus der Bank steht nicht unter Firmendaten:{' '}
            {accounts
              .filter((a) => a.notInCompany)
              .map((a) => `${a.name} ${ibanShort(a.iban)}`)
              .join(', ')}
            . Bitte die Bankverbindungen unter Einstellungen → Firmendaten prüfen – sie stehen auf jeder
            Rechnung.
          </div>
        )}
        {feed.accounts.some((a) => a.last_fetch_error) && (
          <div class="notice warn">
            Letzter Abruf mit Fehler:{' '}
            {feed.accounts
              .filter((a) => a.last_fetch_error)
              .map((a) => `${a.iban}: ${a.last_fetch_error}`)
              .join(' · ')}
          </div>
        )}
        <div class="actions" style="align-items:center">
          {(
            [
              ['offen', 'Neu zuzuordnen'],
              ['erledigt', 'Erledigt'],
              ['alle', 'Alle'],
            ] as const
          ).map(([s, l]) => (
            <a
              class={`btn sm ${s === status ? '' : 'sec'}`}
              href={`${BACK}?status=${s}${konto ? `&konto=${konto}` : ''}`}
            >
              {l}
            </a>
          ))}
          <span class="small mut">{rows.total} Umsätze</span>
          {status === 'offen' && rows.total > 0 && (
            <form method="post" action="/transfer/kontoumsaetze/alle-nicht" style="margin:0 0 0 auto">
              <input type="hidden" name="konto" value={konto} />
              <button
                class="btn sm sec"
                data-confirm={`Alle ${rows.total} offenen Umsätze${konto ? ' dieses Kontos' : ''} als „nicht zugeordnet“ abhaken? Es wird nichts gebucht; einzelne lassen sich unter „Erledigt“ wieder öffnen.`}
              >
                Alle {rows.total} nicht zuordnen
              </button>
            </form>
          )}
          {status === 'offen' && sure.length > 0 && (
            <form method="post" action="/transfer/kontoumsaetze/sicher" style="margin:0">
              {sure.map((t) => (
                <input type="hidden" name="tx" value={t.id} />
              ))}
              <button
                class="btn sm ok"
                data-confirm={`${sure.length} sichere Vorschläge (Rechnungsnummer + Betrag passen) zuordnen?`}
              >
                ✓ {sure.length} sichere Vorschläge zuordnen
              </button>
            </form>
          )}
        </div>
        <script dangerouslySetInnerHTML={{ __html: INLINE_JS }} />
        <div class="card tx-list">
          {rows.map((t, i) => (
            <TxRow t={t} s={sugg[i]!} />
          ))}
          {rows.length === 0 && (
            <p class="mut" style="padding:14px">
              {status === 'offen' ? 'Keine neuen Umsätze – alles zugeordnet.' : 'Keine Umsätze.'}
            </p>
          )}
        </div>
        {pages > 1 && (
          <div class="actions">
            {seite > 1 && (
              <a class="btn sm sec" href={q({ seite: seite - 1 })}>
                ← zurück
              </a>
            )}
            <span class="small mut">
              Seite {seite} von {pages}
            </span>
            {seite < pages && (
              <a class="btn sm sec" href={q({ seite: seite + 1 })}>
                weiter →
              </a>
            )}
          </div>
        )}
        {status === 'offen' && rows.total > 0 && (
          <details class="card">
            <summary>Ältere Umsätze auf einmal abhaken (vor der Umstellung in Fortytools zugeordnet)</summary>
            <form method="post" action="/transfer/kontoumsaetze/bis" class="actions" style="align-items:end">
              <div>
                <label for="bis">alle offenen Umsätze bis einschließlich</label>
                <input id="bis" type="date" name="bis" value="2026-10-07" required />
              </div>
              <input type="hidden" name="konto" value={konto} />
              <button
                class="btn sec"
                data-confirm="Alle offenen Umsätze bis zu diesem Tag als erledigt abhaken? (Es wird nichts gebucht, wieder öffnen geht.)"
              >
                Abhaken{konto ? ' (nur dieses Konto)' : ''}
              </button>
              <span class="small mut">
                Bucht nichts – Zahlungen vor dem Umstieg sind in Fortytools schon erfasst. Einzelne lassen
                sich wieder öffnen.
              </span>
            </form>
          </details>
        )}
        <details class="card">
          <summary>Kontoauszug-Datei einlesen (CAMT.053 oder CSV – falls ohne Bankabruf)</summary>
          <form method="post" action="/transfer/kontoumsaetze/import" enctype="multipart/form-data">
            <input type="hidden" name="id" value={randomUUID()} />
            <div class="grid">
              <div>
                <label for="datei">Datei (CAMT.053 als XML oder CSV aus dem Online-Banking)</label>
                <input id="datei" type="file" name="datei" accept=".xml,.csv,.txt" required />
              </div>
              <div>
                <label for="konto">Konto (nur nötig, wenn die CSV-Datei kein Konto enthält)</label>
                <select id="konto" name="konto">
                  {accounts.map((b) => (
                    <option value={b.iban}>
                      {b.name} – {ibanShort(b.iban)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div class="actions" style="margin-bottom:0">
              <button class="btn">Einlesen</button>
              <span class="small mut">
                Mehrfach oder überlappend einlesen ist unschädlich – jeder Umsatz wird nur einmal übernommen.
              </span>
            </div>
          </form>
          {imports.length > 0 && (
            <ul class="small" style="margin-top:10px">
              {imports.slice(0, 15).map((i) => (
                <li>
                  {at(i.created_at)} · {i.filename} (
                  {i.format === 'camt053' ? 'CAMT.053' : i.format === 'api' ? 'Bankabruf' : 'CSV'}) ·{' '}
                  {i.line_count} Umsätze, davon neu {i.new_count} · {i.created_by}
                </li>
              ))}
            </ul>
          )}
        </details>
      </>,
    );
  });

  const TxRow = ({ t, s }: { t: BankTx; s: Suggestion[] }) => {
    const first = s[0];
    return (
      <div class="tx-row" id={`u-${t.id}`}>
        <div class="tx-who">
          <b>{t.counterparty_name ?? '–'}</b>
          {t.counterparty_iban && <div class="tx-iban">{ibanShort(t.counterparty_iban)}</div>}
          <div>{dateDe(t.booking_date)}</div>
          <div class="tx-purpose">{t.purpose}</div>
        </div>
        <div class={`tx-amt ${t.amount_cents < 0n ? 'neg' : 'pos'}`}>{euro(t.amount_cents)}</div>
        <div class="tx-arrow">→</div>
        <div class="tx-match">
          {t.status !== 'offen' ? (
            <div>
              <span class={`badge ${t.status === 'zugeordnet' ? 'ok' : ''}`}>
                {t.status === 'zugeordnet'
                  ? 'zugeordnet'
                  : t.assigned_kind
                    ? 'zugeordnet (ohne Buchung)'
                    : 'nicht zugeordnet'}
              </span>{' '}
              {t.note}
              {t.matched_by && (
                <div class="small mut">
                  {t.matched_by}
                  {t.matched_at ? `, ${at(t.matched_at)}` : ''}
                </div>
              )}
            </div>
          ) : first ? (
            <SuggestionBox s={first} />
          ) : (
            <div class="tx-btns">
              <a class="btn sm sec" href={`${BACK}/${t.id}`} data-inline={`${BACK}/${t.id}/inline?art=kunde`}>
                Kunde
              </a>
              <a
                class="btn sm sec"
                href={`${BACK}/${t.id}/lieferant`}
                data-inline={`${BACK}/${t.id}/inline?art=lieferant`}
              >
                Lieferant
              </a>
              <a
                class="btn sm sec"
                href={`${BACK}/${t.id}/mitarbeiter`}
                data-inline={`${BACK}/${t.id}/inline?art=mitarbeiter`}
              >
                Mitarbeiter
              </a>
            </div>
          )}
        </div>
        <div class="tx-act">
          {t.status === 'offen' && first ? (
            <>
              <form method="post" action={`${BACK}/${t.id}/vorschlag`} style="margin:0;flex:1">
                <input type="hidden" name="n" value="0" />
                <button class="btn ok tx-go">✓ Zuordnen</button>
              </form>
              <a
                class="btn sm sec"
                href={`${BACK}/${t.id}`}
                data-inline={`${BACK}/${t.id}/inline?art=${t.amount_cents > 0n ? 'kunde' : 'lieferant'}`}
                title="Andere Zuordnung"
                aria-label="Andere Zuordnung"
              >
                ✎
              </a>
              <form method="post" action={`${BACK}/${t.id}/ignorieren`} class="tx-skip">
                <button class="btn sm ghost">Nicht zuordnen</button>
              </form>
            </>
          ) : t.status === 'offen' ? (
            <form method="post" action={`${BACK}/${t.id}/ignorieren`} style="margin:0">
              <button class="btn sm sec">Nicht zuordnen</button>
            </form>
          ) : t.status === 'ignoriert' ? (
            <form method="post" action={`${BACK}/${t.id}/oeffnen`} style="margin:0">
              <button class="btn sm sec">wieder öffnen</button>
            </form>
          ) : null}
        </div>
      </div>
    );
  };

  const SuggestionBox = ({ s }: { s: Suggestion }) => {
    if (s.kind === 'invoices') {
      const c0 = s.items[0]!;
      return (
        <div class="tx-sugg">
          <div>
            <b>
              {c0.customer_no} {c0.customer_name}
            </b>{' '}
            <span
              class={`badge ${s.confidence === 'sicher' ? 'ok' : s.confidence === 'prüfen' ? 'warn' : 'info'}`}
            >
              {s.confidence}
            </span>
          </div>
          {(s.items.length > 1 || s.items[0]!.skonto > 0n || s.confidence !== 'sicher') && (
            <div class="lbl">{s.label}</div>
          )}
          <table class="tx-mini">
            {s.items.map((it) => (
              <tr>
                <td class="r">{euro(it.amount)}</td>
                <td>{it.number}</td>
                <td>{it.issue_date ? dateDe(it.issue_date) : ''}</td>
                <td class="small mut">
                  {it.skonto > 0n
                    ? `+ Skonto ${euro(it.skonto)}`
                    : it.amount < it.open_cents
                      ? `Teilzahlung, offen ${euro(it.open_cents)}`
                      : ''}
                </td>
              </tr>
            ))}
          </table>
        </div>
      );
    }
    if (s.kind === 'incoming') {
      return (
        <div class="tx-sugg">
          <div>
            <b>{s.supplierName}</b>{' '}
            <span
              class={`badge ${s.confidence === 'sicher' ? 'ok' : s.confidence === 'prüfen' ? 'warn' : 'info'}`}
            >
              {s.confidence}
            </span>
          </div>
          <div class="lbl">{s.label}</div>
          <table class="tx-mini">
            {s.items.map((it) => (
              <tr>
                <td class="r">{euro(it.amount)}</td>
                <td>
                  {it.amount < 0n ? 'Korrektur' : 'Eingangsrechnung'} {it.invoice_no}
                  {it.unapproved && (
                    <span class="badge warn" title="Wird beim Zuordnen mit freigegeben">
                      noch nicht freigegeben
                    </span>
                  )}
                </td>
                <td>{dateDe(it.invoice_date)}</td>
                <td class="small mut">{it.skonto > 0n ? `Skonto ${euro(it.skonto)}` : ''}</td>
              </tr>
            ))}
          </table>
        </div>
      );
    }
    return (
      <div class="tx-sugg">
        <b>{s.label}</b>
      </div>
    );
  };

  app.post('/transfer/kontoumsaetze/import', async (c) => {
    const b = await c.req.parseBody();
    const file = b.datei;
    if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte eine Datei auswählen');
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const r = await importStatement(deps, {
      id,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      accountIban: typeof b.konto === 'string' ? b.konto : null,
      actor: c.get('actor'),
    });
    return back(c, BACK, {
      ok: `${r.lines} Umsätze gelesen, davon ${r.created} neu${r.lines > r.created ? ` (${r.lines - r.created} schon vorhanden)` : ''}.`,
    });
  });

  app.post('/transfer/kontoumsaetze/alle-nicht', async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    const n = await closeBefore(
      sql,
      todayBerlin(),
      str(b, 'konto') || null,
      c.get('actor'),
      'nicht zugeordnet (alle auf einmal)',
    );
    return back(c, BACK, {
      ok: `${n} Umsätze als „nicht zugeordnet“ abgehakt – unter „Erledigt“ wieder zu öffnen.`,
    });
  });

  app.post('/transfer/kontoumsaetze/bis', async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    const day = str(b, 'bis');
    if (!isDate(day)) throw new BusinessError('Bitte ein Datum wählen');
    const n = await closeBefore(sql, day, str(b, 'konto') || null, c.get('actor'));
    return back(c, BACK, { ok: `${n} Umsätze bis ${dateDe(day)} abgehakt.` });
  });

  /** Alle sicheren Vorschläge der Seite (Nummer + Betrag passen) auf einmal zuordnen. */
  app.post('/transfer/kontoumsaetze/sicher', async (c) => {
    const ids = arr(await c.req.parseBody({ all: true }), 'tx');
    let ok = 0;
    const errs: string[] = [];
    for (const id of ids) {
      const t = await getTransaction(sql, id);
      if (!t || t.status !== 'offen') continue;
      const s = (await suggestions(sql, t))[0];
      if (!s || !('confidence' in s) || s.confidence !== 'sicher') continue;
      try {
        await applySuggestion(id, s, c.get('actor'));
        ok++;
      } catch (e) {
        errs.push(`${dateDe(t.booking_date)} ${euro(t.amount_cents)}: ${(e as Error).message}`);
      }
    }
    return back(
      c,
      BACK,
      errs.length
        ? { fehler: `${ok} zugeordnet. Nicht zugeordnet: ${errs.join(' · ')}` }
        : { ok: `${ok} Umsätze zugeordnet.` },
    );
  });

  const applySuggestion = async (id: string, s: Suggestion, actor: string) => {
    if (s.kind === 'invoices')
      await assignInvoices(
        sql,
        id,
        s.items.map((i) => ({
          invoiceId: i.invoice_id,
          amount: i.amount,
          skonto: i.skonto,
          legacy: !!i.legacy,
          free: !!i.free,
        })),
        actor,
      );
    else if (s.kind === 'incoming')
      await assignIncoming(
        sql,
        id,
        s.items.map((i) => ({ id: i.id, skonto: i.skonto })),
        actor,
      );
    else if (s.kind === 'party')
      await assignParty(sql, id, { kind: s.party, id: s.partyId, note: null }, actor);
    else if (s.kind === 'debit_run') await assignDebitRun(sql, id, s.runId, actor);
    else if (s.kind === 'payment_run') await assignPaymentRun(sql, id, s.runId, actor);
    else await assignReturn(sql, id, s.runId, s.invoiceId, actor);
  };

  // ---------------------------------------------------------------- Zuordnen direkt in der Zeile (wie Fortytools)
  type Pick = { id: string; no: string; date: string; cents: bigint; legacy?: boolean; note?: string };
  const custOpen = async (customerId: string): Promise<Pick[]> => {
    const [own, legacy] = await Promise.all([
      listOpenItems(sql, customerId),
      listLegacyOpenItems(sql, customerId),
    ]);
    return [
      ...own
        .filter((o) => o.open_cents > 0n)
        .map((o) => ({ id: o.invoice_id, no: o.number, date: o.issue_date, cents: o.open_cents })),
      ...legacy
        .filter((o) => o.open_cents > 0n)
        .map((o) => ({
          id: `L:${o.invoice_id}`,
          no: o.number,
          date: o.issue_date,
          cents: o.open_cents,
          legacy: true,
        })),
    ].sort((a, b) => b.date.localeCompare(a.date));
  };
  const normNo = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');

  app.get(`/transfer/kontoumsaetze/:id{${UUID}}/inline`, async (c) => {
    const t = await getTransaction(sql, c.req.param('id'));
    if (!t) return c.html(<div class="notice err">Umsatz nicht gefunden</div>);
    const art =
      (['kunde', 'lieferant', 'mitarbeiter'] as const).find((a) => a === c.req.query('art')) ?? 'kunde';
    const base = `${BACK}/${t.id}/inline`;
    let p = c.req.query('p') ?? '';
    const purpose = normNo(t.purpose);
    const amount = t.amount_cents < 0n ? -t.amount_cents : t.amount_cents;
    const tabs = (
      <div class="inl-tabs">
        {(['kunde', 'lieferant', 'mitarbeiter'] as const).map((a) => (
          <a class={`chip ${a === art ? 'on' : ''}`} href="#" data-inline={`${base}?art=${a}`}>
            {a === 'kunde' ? 'Kunde' : a === 'lieferant' ? 'Lieferant' : 'Mitarbeiter'}
          </a>
        ))}
        <a class="inl-x" href="#" data-inline-close="1" title="Abbrechen" aria-label="Abbrechen">
          ×
        </a>
      </div>
    );
    const cp = (t.counterparty_iban ?? '').toUpperCase();
    if (art === 'mitarbeiter') {
      const emps = await sql<{ id: string; personnel_no: string; name: string; iban: string | null }[]>`
        select e.id, e.personnel_no, trim(coalesce(e.first_name, '') || ' ' || e.last_name) as name,
               upper(replace(coalesce(p.iban, ''), ' ', '')) as iban
          from app.employees e left join app.employee_private p on p.employee_id = e.id
         where e.status <> 'ausgetreten' order by e.last_name, e.first_name`;
      const guess = emps.find((e) => cp && e.iban === cp)?.id ?? '';
      return c.html(
        <div class="inl">
          {tabs}
          <form method="post" action={`${BACK}/${t.id}/partei`} class="inl-row">
            <input type="hidden" name="art" value="mitarbeiter" />
            <select name="partei" required>
              <option value="">Mitarbeiter auswählen</option>
              {emps.map((e) => (
                <option value={e.id} selected={e.id === guess}>
                  {e.personnel_no} - {e.name}
                </option>
              ))}
            </select>
            <select name="note">
              {['Lohn/Gehalt', 'Vorschuss', 'Auslagenerstattung', 'Rückzahlung', 'Sonstiges'].map((k) => (
                <option>{k}</option>
              ))}
            </select>
            <button class="btn">Zuordnen</button>
          </form>
        </div>,
      );
    }
    if (art === 'kunde') {
      const custs = await sql<{ id: string; customer_no: string; name: string }[]>`
        select id, customer_no, name from app.customers where status <> 'interessent' and not is_internal order by name`;
      if (!p && cp) {
        const [g] = await sql<{ customer_id: string }[]>`
          select customer_id from app.customer_bank_accounts where iban = ${cp} limit 1`;
        p = g?.customer_id ?? '';
      }
      if (!p && t.amount_cents > 0n) {
        // Rechnungsnummer im Verwendungszweck → Kunde
        const [g] = await sql<{ customer_id: string }[]>`
          select customer_id from (
            select customer_id, number from app.open_items where open_cents > 0
            union all select customer_id, number from app.legacy_open_items where open_cents > 0) x
           where length(number) >= 5 and ${purpose} like '%' || upper(regexp_replace(number, '[^A-Za-z0-9]', '', 'g')) || '%'
           limit 1`;
        p = g?.customer_id ?? '';
      }
      const items = p && t.amount_cents > 0n ? await custOpen(p) : [];
      const pre = new Set(
        items.filter((i) => normNo(i.no).length >= 5 && purpose.includes(normNo(i.no))).map((i) => i.id),
      );
      return c.html(
        <div class="inl">
          {tabs}
          <div class="inl-row">
            <select data-inline-pick={`${base}?art=kunde&p=`}>
              <option value="">Kunde auswählen</option>
              {custs.map((k) => (
                <option value={k.id} selected={k.id === p}>
                  {k.customer_no} - {k.name}
                </option>
              ))}
            </select>
          </div>
          {p && t.amount_cents > 0n && (
            <form
              method="post"
              action={`${BACK}/${t.id}/auswahl`}
              class="inl-pick"
              data-amount={String(amount)}
            >
              <PickList items={items} pre={pre} title="Offene Rechnungen" amount={amount} />
              <div class="inl-row">
                <button class="btn">Zuordnen</button>
                <a class="btn sec" href="#" data-inline-close="1">
                  Abbrechen
                </a>
              </div>
            </form>
          )}
          {p && (
            <form method="post" action={`${BACK}/${t.id}/partei`} class="inl-row inl-small">
              <input type="hidden" name="art" value="kunde" />
              <input type="hidden" name="partei" value={p} />
              <input name="note" placeholder="Notiz, z. B. Vorauszahlung, Erstattung" />
              <button class="btn sm sec">Ohne Rechnung dem Kunden zuordnen</button>
            </form>
          )}
        </div>,
      );
    }
    // Lieferant
    const sups = await sql<
      { id: string; supplier_no: string; name: string; iban: string | null; kind: string }[]
    >`
      select id, supplier_no, name, upper(replace(coalesce(iban, ''), ' ', '')) as iban, kind
        from app.suppliers where active order by name`;
    if (!p) p = sups.find((x) => cp && x.iban === cp)?.id ?? '';
    const inv = p ? await incomingForSupplier(sql, p) : [];
    const items: Pick[] = inv.map((i) => ({
      id: i.id,
      no: i.invoice_no,
      date: i.invoice_date,
      cents: i.status === 'bezahlt' ? (i.paid_amount_cents ?? i.gross_cents) : i.gross_cents,
      note: i.status === 'bezahlt' ? 'schon bezahlt' : i.status === 'erfasst' ? 'nicht freigegeben' : '',
    }));
    const pre = new Set(
      items.filter((i) => normNo(i.no).length >= 4 && purpose.includes(normNo(i.no))).map((i) => i.id),
    );
    return c.html(
      <div class="inl">
        {tabs}
        <div class="inl-row">
          <select data-inline-pick={`${base}?art=lieferant&p=`}>
            <option value="">Lieferant auswählen</option>
            {sups.map((x) => (
              <option value={x.id} selected={x.id === p}>
                {x.supplier_no} - {x.name}
                {x.kind === 'nachunternehmer' ? ' (NU)' : ''}
              </option>
            ))}
          </select>
        </div>
        {!p && (
          <form method="post" action={`${BACK}/${t.id}/lieferant-neu`} class="inl-row inl-small">
            <input type="hidden" name="zurueck" value="liste" />
            <input
              name="name"
              value={t.counterparty_name ?? ''}
              required
              aria-label="Name des neuen Lieferanten"
            />
            <button class="btn sm sec">+ als neuen Lieferanten anlegen</button>
          </form>
        )}
        {p && t.amount_cents < 0n && items.length > 0 && (
          <form
            method="post"
            action={`${BACK}/${t.id}/eingang`}
            class="inl-pick"
            data-amount={String(amount)}
          >
            <PickList items={items} pre={pre} title="Eingangsrechnungen" amount={amount} field="ein" />
            <div class="inl-row">
              <button class="btn">Zuordnen</button>
              <a class="btn sec" href="#" data-inline-close="1">
                Abbrechen
              </a>
            </div>
          </form>
        )}
        {p && (
          <form method="post" action={`${BACK}/${t.id}/partei`} class="inl-row inl-small">
            <input type="hidden" name="art" value="lieferant" />
            <input type="hidden" name="partei" value={p} />
            <input name="note" placeholder="Notiz (ohne Rechnung)" />
            {t.amount_cents < 0n && (
              <select name="kategorie" aria-label="Kostenart">
                <option value="">Kostenart: automatisch</option>
                {Object.entries(EXPENSE_CATEGORY).map(([k, v]) => (
                  <option value={k}>{v}</option>
                ))}
              </select>
            )}
            <button class="btn sm sec">Ohne Rechnung zuordnen</button>
            {t.amount_cents < 0n && (
              <button
                class="btn sm sec"
                name="vorschuss"
                value="1"
                title="später mit der Rechnung verrechnen"
              >
                Als Vorschuss erfassen
              </button>
            )}
          </form>
        )}
      </div>,
    );
  });

  /** Ankreuzliste mit Summe/Saldo (rechnet im Browser mit) und „Komplett bezahlt“. */
  const PickList = ({
    items,
    pre,
    title,
    amount,
    field = 'inv',
  }: {
    items: Pick[];
    pre: Set<string>;
    title: string;
    amount: bigint;
    field?: string;
  }) => (
    <>
      <div class="inl-sum">
        <span>Summe</span>
        <b data-sum>0,00 €</b>
        <span>Saldo</span>
        <b data-saldo>{euro(amount)}</b>
        <label class="inl-full">
          <input type="checkbox" name="komplett" value="1" /> Komplett bezahlt (Differenz als Skonto)
        </label>
      </div>
      <div class="inl-h">{title}</div>
      {items.map((i) => (
        <label class="inl-item">
          <input
            type="checkbox"
            name={field}
            value={i.id}
            data-cents={String(i.cents)}
            checked={pre.has(i.id)}
          />
          <span class="r">{euro(i.cents)}</span>
          <span>{i.no}</span>
          <span class="mut">{dateDe(i.date)}</span>
          <span class="mut small">{i.note ?? ''}</span>
        </label>
      ))}
      {items.length === 0 && <div class="mut small">Keine offenen Rechnungen.</div>}
    </>
  );

  /** Kunde: angekreuzte Rechnungen der Reihe nach bezahlen; „Komplett bezahlt“ = Rest der letzten als Skonto. */
  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/auswahl`, async (c) => {
    const id = c.req.param('id');
    const t = await getTransaction(sql, id);
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    const b = await c.req.parseBody({ all: true });
    const picked = arr(b, 'inv');
    if (!picked.length) throw new BusinessError('Bitte mindestens eine Rechnung ankreuzen');
    const komplett = str(b as Record<string, string>, 'komplett') === '1';
    const own = picked.filter((x) => !x.startsWith('L:'));
    const leg = picked.filter((x) => x.startsWith('L:')).map((x) => x.slice(2));
    const open = new Map<string, bigint>();
    for (const r of await sql<{ id: string; c: bigint }[]>`
        select invoice_id as id, open_cents as c from app.open_items where invoice_id = any(${own}::uuid[])
        union all select invoice_id, open_cents from app.legacy_open_items where invoice_id = any(${leg}::uuid[])`)
      open.set(r.id, r.c);
    let rest = t.amount_cents;
    const items: { invoiceId: string; legacy: boolean; free: boolean; amount: bigint; skonto: bigint }[] = [];
    for (const x of picked) {
      const legacy = x.startsWith('L:');
      const invoiceId = legacy ? x.slice(2) : x;
      const o = open.get(invoiceId);
      if (o == null) throw new BusinessError('Eine Rechnung ist nicht mehr offen – bitte neu laden');
      const pay = rest < o ? rest : o;
      if (pay <= 0n) throw new BusinessError('Der Betrag reicht nicht für alle angekreuzten Rechnungen');
      rest -= pay;
      items.push({ invoiceId, legacy, free: true, amount: pay, skonto: 0n });
    }
    if (rest > 0n)
      throw new BusinessError(
        `Überzahlung: ${euro(rest)} mehr als die angekreuzten Rechnungen – weitere ankreuzen`,
      );
    const last = items[items.length - 1]!;
    const lastOpen = open.get(last.invoiceId)!;
    if (komplett && last.amount < lastOpen) {
      const diff = lastOpen - last.amount;
      if (diff * 10_000n > lastOpen * 500n)
        throw new BusinessError(
          `Differenz ${euro(diff)} ist mehr als 5 % – als Teilzahlung buchen (Haken „Komplett bezahlt“ weg)`,
        );
      last.skonto = diff;
    }
    await assignInvoices(sql, id, items, c.get('actor'));
    return back(c, BACK, { ok: `Zugeordnet: ${anz(items.length, 'Rechnung', 'Rechnungen')}.` });
  });

  // ---------------------------------------------------------------- Zuordnen: Kunde (Rechnungen)
  app.get(`/transfer/kontoumsaetze/:id{${UUID}}`, async (c) => {
    const t = await getTransaction(sql, c.req.param('id'));
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    const custs = await sql<{ id: string; customer_no: string; name: string }[]>`
      select id, customer_no, name from app.customers where status <> 'interessent' order by name`;
    const [byIban] = t.counterparty_iban
      ? await sql<{ customer_id: string }[]>`
          select customer_id from app.customer_bank_accounts where iban = ${t.counterparty_iban} limit 1`
      : [];
    const kunde = c.req.query('kunde') ?? byIban?.customer_id ?? '';
    const [sugg, own, legacy] = await Promise.all([
      suggestions(sql, t),
      t.amount_cents > 0n ? listOpenItems(sql, kunde || undefined) : Promise.resolve([]),
      t.amount_cents > 0n ? listLegacyOpenItems(sql, kunde || undefined) : Promise.resolve([]),
    ]);
    const positive = [
      ...own.filter((o) => o.open_cents > 0n).map((o) => ({ ...o, legacy: false })),
      ...legacy.filter((o) => o.open_cents > 0n),
    ].sort(
      (a, b) =>
        a.customer_name.localeCompare(b.customer_name, 'de') || a.issue_date.localeCompare(b.issue_date),
    );
    return shell(
      c,
      'konto',
      `Umsatz ${dateDe(t.booking_date)} · ${euro(t.amount_cents)}`,
      <>
        <style>{TX_CSS}</style>
        <TxHead t={t} />
        {sugg.length > 0 && t.status === 'offen' && (
          <div class="card">
            <h3 style="margin-top:0">Vorschläge</h3>
            {sugg.map((s, n) => (
              <form
                method="post"
                action={`${BACK}/${t.id}/vorschlag`}
                class="actions"
                style="align-items:center"
              >
                <input type="hidden" name="n" value={String(n)} />
                <span>{s.label}</span>
                <button class="btn sm ok">✓ Zuordnen</button>
              </form>
            ))}
          </div>
        )}
        {t.status === 'offen' && (
          <>
            <form method="get" class="card actions" style="align-items:end">
              <div style="flex:1;min-width:240px">
                <label for="kunde">Kunde</label>
                <select id="kunde" name="kunde" onchange="this.form.submit()">
                  <option value="">– alle Kunden mit offenen Rechnungen –</option>
                  {custs.map((k) => (
                    <option value={k.id} selected={k.id === kunde}>
                      {k.customer_no} {k.name}
                    </option>
                  ))}
                </select>
              </div>
              <noscript>
                <button class="btn sec">Anzeigen</button>
              </noscript>
              <a class="btn sec" href={`${BACK}/${t.id}/lieferant`}>
                Lieferant
              </a>
              <a class="btn sec" href={`${BACK}/${t.id}/mitarbeiter`}>
                Mitarbeiter
              </a>
            </form>
            {t.amount_cents > 0n && (
              <form method="post" action={`${BACK}/${t.id}/zuordnen`} class="card">
                <h3 style="margin-top:0">Auf Rechnungen verteilen</h3>
                <p class="small mut" style="margin-top:0">
                  Betrag je Rechnung eintragen (Summe = {euro(t.amount_cents)}). Skonto nur, wenn der Kunde
                  berechtigt Skonto abgezogen hat – wird als eigene Buchung „Skonto-Abzug“ erfasst.
                </p>
                <div class="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th>Rechnung</th>
                        <th>Kunde</th>
                        <th>Datum</th>
                        <th>fällig</th>
                        <th class="r">offen</th>
                        <th class="r">Zahlung</th>
                        <th class="r">Skonto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positive.map((o) => (
                        <tr>
                          <td>
                            <a
                              href={o.legacy ? `/rechnungen/${o.invoice_id}` : `/rechnungen/${o.invoice_id}`}
                            >
                              {o.number}
                            </a>
                          </td>
                          <td>
                            {o.customer_no} {o.customer_name}
                          </td>
                          <td>{dateDe(o.issue_date)}</td>
                          <td>{dateDe(o.due_date)}</td>
                          <td class="r">{euro(o.open_cents)}</td>
                          <td class="r">
                            <input
                              type="hidden"
                              name="inv"
                              value={o.legacy ? `L:${o.invoice_id}` : o.invoice_id}
                            />
                            <input
                              name="amount"
                              inputmode="decimal"
                              style="max-width:120px;text-align:right"
                              aria-label={`Zahlung ${o.number}`}
                            />
                          </td>
                          <td class="r">
                            <input
                              name="skonto"
                              inputmode="decimal"
                              style="max-width:100px;text-align:right"
                              aria-label={`Skonto ${o.number}`}
                            />
                          </td>
                        </tr>
                      ))}
                      {positive.length === 0 && (
                        <tr>
                          <td colspan={7} class="mut">
                            Keine offenen Rechnungen{kunde ? ' bei diesem Kunden' : ''}.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div class="formfoot">
                  <button class="btn">Zahlungen buchen</button>
                </div>
              </form>
            )}
            {kunde && (
              <form
                method="post"
                action={`${BACK}/${t.id}/partei`}
                class="card actions"
                style="align-items:end"
              >
                <input type="hidden" name="art" value="kunde" />
                <input type="hidden" name="partei" value={kunde} />
                <div style="flex:1">
                  <label for="nk">Ohne Rechnung dem Kunden zuordnen (z. B. Vorauszahlung, Erstattung)</label>
                  <input id="nk" name="note" placeholder="Notiz" />
                </div>
                <button class="btn sec">Dem Kunden zuordnen</button>
              </form>
            )}
            <form
              method="post"
              action={`${BACK}/${t.id}/ignorieren`}
              class="card actions"
              style="align-items:end"
            >
              <div style="flex:1">
                <label for="ni">Nicht zuordnen (z. B. Bankgebühr, Steuer, Miete, Kartenzahlung)</label>
                <input id="ni" name="note" placeholder="Notiz" />
              </div>
              {t.amount_cents < 0n && <CategorySelect id="kat-i" />}
              <button class="btn sec">Nicht zuordnen</button>
            </form>
          </>
        )}
        {t.status === 'ignoriert' && (
          <form method="post" action={`${BACK}/${t.id}/oeffnen`} class="actions">
            <button class="btn sec">Wieder öffnen</button>
          </form>
        )}
      </>,
    );
  });

  const TxHead = ({ t }: { t: BankTx }) => (
    <div class="card tx-row tx-head">
      <div class="tx-who">
        <b>{t.counterparty_name ?? '–'}</b>
        {t.counterparty_iban && <div class="tx-iban">{ibanShort(t.counterparty_iban)}</div>}
        <div>
          {dateDe(t.booking_date)} · Konto {t.account_iban ? ibanShort(t.account_iban) : '–'}
        </div>
        <div class="tx-purpose">{t.purpose || '–'}</div>
      </div>
      <div class={`tx-amt ${t.amount_cents < 0n ? 'neg' : 'pos'}`}>{euro(t.amount_cents)}</div>
      <div class="tx-match">
        {t.status !== 'offen' && (
          <>
            <span class={`badge ${t.status === 'zugeordnet' ? 'ok' : ''}`}>{TX_STATUS[t.status]}</span>{' '}
            {t.note}
            {t.matched_by ? ` (${t.matched_by}, ${at(t.matched_at!)})` : ''}
          </>
        )}
      </div>
      <div class="tx-act">
        <a class="btn sm sec" href={BACK}>
          ← zur Liste
        </a>
      </div>
    </div>
  );

  // ---------------------------------------------------------------- Zuordnen: Lieferant
  app.get(`/transfer/kontoumsaetze/:id{${UUID}}/lieferant`, async (c) => {
    const t = await getTransaction(sql, c.req.param('id'));
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    const sups = await sql<{ id: string; supplier_no: string; name: string; iban: string | null }[]>`
      select id, supplier_no, name, iban from app.suppliers where active order by name`;
    const guess = sups.find(
      (s) => t.counterparty_iban && (s.iban ?? '').replace(/\s/g, '').toUpperCase() === t.counterparty_iban,
    );
    const lief = c.req.query('l') ?? guess?.id ?? '';
    const inv = lief ? await incomingForSupplier(sql, lief) : [];
    return shell(
      c,
      'konto',
      `Umsatz ${dateDe(t.booking_date)} · ${euro(t.amount_cents)} → Lieferant`,
      <>
        <style>{TX_CSS}</style>
        <TxHead t={t} />
        {!lief && t.status === 'offen' && (
          <form
            method="post"
            action={`${BACK}/${t.id}/lieferant-neu`}
            class="card actions"
            style="align-items:end"
          >
            <div style="flex:1;min-width:240px">
              <label for="ln">Lieferant gibt es noch nicht? Schnell anlegen – nur mit Namen</label>
              <input id="ln" name="name" value={t.counterparty_name ?? ''} required />
            </div>
            <button class="btn">+ Lieferant anlegen</button>
            <span class="small mut" style="flex-basis:100%">
              IBAN wird übernommen{t.counterparty_iban ? ` (${ibanShort(t.counterparty_iban)})` : ''} –
              künftige Zahlungen erkennt die App dann selbst. Anschrift usw. später unter Lieferanten
              ergänzen.
            </span>
          </form>
        )}
        <form method="get" class="card actions" style="align-items:end">
          <div style="flex:1;min-width:240px">
            <label for="l">Lieferant / Nachunternehmer</label>
            <select id="l" name="l" onchange="this.form.submit()">
              <option value="">– wählen –</option>
              {sups.map((s) => (
                <option value={s.id} selected={s.id === lief}>
                  {s.supplier_no} {s.name}
                </option>
              ))}
            </select>
          </div>
          <noscript>
            <button class="btn sec">Anzeigen</button>
          </noscript>
        </form>
        {lief && t.status === 'offen' && (
          <>
            {t.amount_cents < 0n && (
              <form method="post" action={`${BACK}/${t.id}/eingang`} class="card">
                <h3 style="margin-top:0">Eingangsrechnungen</h3>
                <p class="small mut" style="margin-top:0">
                  Ankreuzen, was mit dieser Zahlung beglichen wurde – Rechnungen werden als bezahlt
                  festgehalten (Datum = Buchungstag), Korrekturen (Minusbeträge) verrechnet. Summe ={' '}
                  {euro(-t.amount_cents)}; bei einer einzelnen Rechnung gilt eine Differenz bis 5 % als
                  Skonto.
                </p>
                <div class="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Rechnung</th>
                        <th>Datum</th>
                        <th>Status</th>
                        <th class="r">Betrag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.map((i) => (
                        <tr>
                          <td>
                            <input type="checkbox" name="ein" value={i.id} aria-label={i.invoice_no} />
                          </td>
                          <td>
                            <a href={`/rechnungseingang/${i.id}`}>{i.invoice_no}</a>
                          </td>
                          <td>{dateDe(i.invoice_date)}</td>
                          <td>
                            {i.status === 'bezahlt'
                              ? `bezahlt ${i.paid_at ? dateDe(i.paid_at) : ''}`
                              : i.status === 'erfasst'
                                ? 'erfasst (noch nicht freigegeben)'
                                : 'freigegeben'}
                            {i.gross_cents < 0n && ' · Korrektur'}
                          </td>
                          <td class="r">
                            {euro(
                              i.status === 'bezahlt' ? (i.paid_amount_cents ?? i.gross_cents) : i.gross_cents,
                            )}
                          </td>
                        </tr>
                      ))}
                      {inv.length === 0 && (
                        <tr>
                          <td colspan={5} class="mut">
                            Keine offenen Eingangsrechnungen – unten ohne Rechnung zuordnen oder die Rechnung
                            unter Rechnungseingang erfassen.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {inv.length > 0 && (
                  <div class="formfoot">
                    <button class="btn">Zuordnen</button>
                  </div>
                )}
              </form>
            )}
            <form
              method="post"
              action={`${BACK}/${t.id}/partei`}
              class="card actions"
              style="align-items:end"
            >
              <input type="hidden" name="art" value="lieferant" />
              <input type="hidden" name="partei" value={lief} />
              <div style="flex:1">
                <label for="nl">Ohne Rechnung zuordnen (z. B. Kartenzahlung, Abschlag, Lastschrift)</label>
                <input id="nl" name="note" placeholder="Notiz" />
              </div>
              {t.amount_cents < 0n && <CategorySelect id="kat-l" />}
              <button class="btn sec">Dem Lieferanten zuordnen</button>
              {t.amount_cents < 0n && (
                <button class="btn sec" name="vorschuss" value="1" title="später mit der Rechnung verrechnen">
                  Als Vorschuss erfassen
                </button>
              )}
            </form>
          </>
        )}
      </>,
    );
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/lieferant-neu`, async (c) => {
    const id = c.req.param('id');
    const t = await getTransaction(sql, id);
    const b = (await c.req.parseBody()) as Record<string, string>;
    const sid = await quickSupplier(sql, str(b, 'name') ?? '', t ?? null, c.get('actor'));
    if (str(b, 'zurueck') === 'liste')
      return back(c, BACK, {
        ok: 'Lieferant angelegt – IBAN gemerkt. Jetzt „Lieferant“ wählen und zuordnen.',
      });
    return back(c, `${BACK}/${id}/lieferant?l=${sid}`, { ok: 'Lieferant angelegt.' });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/eingang`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = arr(b, 'ein');
    const komplett = str(b as Record<string, string>, 'komplett') === '1';
    let items: { id: string; skonto?: bigint }[] = ids.map((id) => ({ id }));
    if (komplett && ids.length > 1) {
      // Differenz (bis 5 %) als Skonto auf die größte offene Rechnung
      const t = await getTransaction(sql, c.req.param('id'));
      const rows = await sql<
        { id: string; gross_cents: bigint; status: string; paid_amount_cents: bigint | null }[]
      >`
        select id, gross_cents, status, paid_amount_cents from app.incoming_invoices where id = any(${ids}::uuid[])`;
      const sum = rows.reduce(
        (a, r) => a + (r.status === 'bezahlt' ? (r.paid_amount_cents ?? r.gross_cents) : r.gross_cents),
        0n,
      );
      const diff = sum + (t?.amount_cents ?? 0n);
      const big = rows
        .filter((r) => r.status !== 'bezahlt')
        .sort((x, y) => (y.gross_cents > x.gross_cents ? 1 : -1))[0];
      if (diff > 0n && big) items = items.map((x) => (x.id === big.id ? { ...x, skonto: diff } : x));
    }
    await assignIncoming(sql, c.req.param('id'), items, c.get('actor'));
    return back(c, BACK, { ok: `Zugeordnet: ${ids.length} Eingangsrechnung(en) als bezahlt.` });
  });

  // ---------------------------------------------------------------- Zuordnen: Mitarbeiter
  const EMP_KINDS = ['Lohn/Gehalt', 'Vorschuss', 'Auslagenerstattung', 'Rückzahlung', 'Sonstiges'];
  app.get(`/transfer/kontoumsaetze/:id{${UUID}}/mitarbeiter`, async (c) => {
    const t = await getTransaction(sql, c.req.param('id'));
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    const emps = await sql<{ id: string; personnel_no: string; name: string; active: boolean }[]>`
      select id, personnel_no, trim(coalesce(first_name, '') || ' ' || last_name) as name, status <> 'ausgetreten' as active
        from app.employees order by last_name, first_name`;
    const [byIban] = t.counterparty_iban
      ? await sql<{ employee_id: string }[]>`
          select employee_id from app.employee_private
           where upper(replace(coalesce(iban, ''), ' ', '')) = ${t.counterparty_iban} limit 1`
      : [];
    return shell(
      c,
      'konto',
      `Umsatz ${dateDe(t.booking_date)} · ${euro(t.amount_cents)} → Mitarbeiter`,
      <>
        <style>{TX_CSS}</style>
        <TxHead t={t} />
        {t.status === 'offen' && (
          <form method="post" action={`${BACK}/${t.id}/partei`} class="card">
            <input type="hidden" name="art" value="mitarbeiter" />
            <div class="grid">
              <div>
                <label for="m">Mitarbeiter</label>
                <select id="m" name="partei" required>
                  <option value="">– wählen –</option>
                  {emps.map((e) => (
                    <option value={e.id} selected={e.id === byIban?.employee_id}>
                      {e.personnel_no} {e.name}
                      {e.active ? '' : ' (ausgetreten)'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="art2">Art</label>
                <select id="art2" name="note">
                  {EMP_KINDS.map((k) => (
                    <option>{k}</option>
                  ))}
                </select>
              </div>
            </div>
            <p class="small mut">
              Bucht nichts (Lohn läuft über Lexware/Steuerberater) – der Umsatz ist danach erledigt und dem
              Mitarbeiter zugeordnet. Wieder öffnen geht.
            </p>
            <div class="formfoot">
              <button class="btn">Zuordnen</button>
            </div>
          </form>
        )}
      </>,
    );
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/partei`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    const kind = str(b, 'art') as 'kunde' | 'lieferant' | 'mitarbeiter';
    if (!['kunde', 'lieferant', 'mitarbeiter'].includes(kind)) throw new BusinessError('Art fehlt');
    const id = str(b, 'partei');
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new BusinessError('Bitte aus der Liste wählen');
    await assignParty(
      sql,
      c.req.param('id'),
      {
        kind,
        id,
        note: str(b, 'note') || null,
        category: str(b, 'kategorie') || null,
        advance: kind === 'lieferant' && str(b, 'vorschuss') === '1',
      },
      c.get('actor'),
    );
    return back(c, BACK, {
      ok:
        kind === 'lieferant' && str(b, 'vorschuss') === '1'
          ? 'Als Vorschuss erfasst – mit der späteren Rechnung verrechnen (Rechnungseingang → Vorschuss verrechnen).'
          : 'Zugeordnet.',
    });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/vorschlag`, async (c) => {
    const id = c.req.param('id');
    const t = await getTransaction(sql, id);
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    if (t.status === 'zugeordnet') return back(c, BACK, { ok: 'War schon zugeordnet.' });
    const n = Number((await c.req.parseBody()).n ?? 0);
    const s = (await suggestions(sql, t))[n];
    if (!s) throw new BusinessError('Vorschlag nicht mehr gültig – bitte neu laden');
    await applySuggestion(id, s, c.get('actor'));
    return back(c, BACK, { ok: `Zugeordnet: ${s.label}` });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/zuordnen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const inv = arr(b, 'inv');
    const amounts = arr(b, 'amount');
    const skontos = arr(b, 'skonto');
    const items = inv
      .map((invoiceId, i) => ({ invoiceId, a: amounts[i]?.trim() ?? '', s: skontos[i]?.trim() ?? '' }))
      .filter((x) => x.a !== '')
      .map((x) => {
        const legacy = x.invoiceId.startsWith('L:');
        try {
          return {
            invoiceId: legacy ? x.invoiceId.slice(2) : x.invoiceId,
            legacy,
            free: true, // von Hand eingetragener Skonto: gleicht die Rechnung aus, höchstens 5 %
            amount: parseEuro(x.a),
            skonto: x.s ? parseEuro(x.s) : 0n,
          };
        } catch {
          throw new BusinessError(`Betrag nicht lesbar: ${x.a} ${x.s}`);
        }
      });
    await assignInvoices(sql, id, items, c.get('actor'));
    return back(c, BACK, { ok: `${items.length} Zahlung(en) gebucht.` });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/ignorieren`, async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    await ignoreTransaction(
      sql,
      c.req.param('id'),
      str(b, 'note') || 'nicht zugeordnet',
      c.get('actor'),
      str(b, 'kategorie') || null,
    );
    return back(c, BACK, { ok: 'Umsatz abgehakt.' });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/oeffnen`, async (c) => {
    await reopenTransaction(sql, c.req.param('id'), c.get('actor'));
    return back(c, `${BACK}/${c.req.param('id')}`, { ok: 'Wieder offen.' });
  });

  // SEPA-Lastschriften (Einzug bei Kunden) entfernt (Ahmed, 06.10.2026) – Daten bleiben in der Datenbank.
  app.get('/transfer/lastschriften', (c) => c.redirect('/transfer/kontoumsaetze'));

  // ================================================================ Dokumentenversand
  app.get('/transfer/dokumentenversand', async (c) => {
    const today = todayBerlin();
    const from = isDate(c.req.query('von')) ? c.req.query('von')! : `${today.slice(0, 7)}-01`;
    const to = isDate(c.req.query('bis')) ? c.req.query('bis')! : today;
    const kind = c.req.query('art') || null;
    const q = c.req.query('q')?.trim() || null;
    const rows = await outbox(sql, { from: from > to ? to : from, to, kind, q });
    const STATUS: Record<string, [string, string]> = {
      sent: ['versendet', 'ok'],
      pending: ['offen', 'info'],
      failed: ['fehlgeschlagen', 'err'],
    };
    return shell(
      c,
      'versand',
      'Dokumentenversand',
      <>
        <form method="get" class="actions" style="margin-top:0">
          <input type="date" name="von" value={from} style="max-width:170px" aria-label="von" />
          <input type="date" name="bis" value={to} style="max-width:170px" aria-label="bis" />
          <select name="art" style="max-width:180px" aria-label="Art">
            <option value="">Alle Dokumente</option>
            <option value="rechnung" selected={kind === 'rechnung'}>
              Rechnungen
            </option>
            <option value="mahnung" selected={kind === 'mahnung'}>
              Mahnungen
            </option>
          </select>
          <input name="q" value={q ?? ''} placeholder="Nr., Kunde, E-Mail" style="max-width:220px" />
          <button class="btn sm sec">Anzeigen</button>
          <span class="small mut">{rows.length} Einträge</span>
        </form>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Zeitpunkt</th>
                  <th>Dokument</th>
                  <th>Kunde</th>
                  <th>Empfänger</th>
                  <th class="r">Dateien</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const [label, cls] = STATUS[r.status] ?? [r.status, ''];
                  const testOnly = r.recipients.join() !== r.intended.join();
                  return (
                    <tr>
                      <td>{at(r.at)}</td>
                      <td>
                        <a
                          href={r.kind === 'rechnung' ? `/rechnungen/${r.doc_id}` : `/mahnungen/${r.doc_id}`}
                        >
                          {r.kind === 'rechnung' ? 'Rechnung' : 'Mahnung'} {r.doc_no}
                        </a>
                      </td>
                      <td>
                        <a href={`/kunden/${r.customer_id}`}>{r.customer_name}</a>
                      </td>
                      <td class="small">
                        {r.intended.join(', ') || '–'}
                        {testOnly && <div class="mut">tatsächlich an: {r.recipients.join(', ')} (Test)</div>}
                      </td>
                      <td class="r">{r.files}</td>
                      <td>
                        <span class={`badge ${cls}`}>{label}</span>
                        {r.error && (
                          <div class="small" style="color:var(--err)">
                            {r.error}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={6} class="mut">
                      Im Zeitraum wurde nichts versendet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>,
    );
  });

  // ================================================================ Dokumenteneingang
  app.get('/transfer/dokumenteneingang', async (c) => {
    const role = c.get('user').role;
    const hr = canAccess(role, '/personal/x');
    const [files, customers, suppliers, sites, employees, incoming] = await Promise.all([
      inboxFiles(sql),
      sql<
        { id: string; label: string }[]
      >`select id, customer_no || ' · ' || name as label from app.customers where active order by name`,
      sql<
        { id: string; label: string }[]
      >`select id, supplier_no || ' · ' || name as label from app.suppliers order by name`,
      sql<
        { id: string; label: string }[]
      >`select id, site_no || ' · ' || name as label from app.sites where active order by name`,
      hr
        ? sql<
            { id: string; label: string }[]
          >`select id, personnel_no || ' · ' || last_name || ', ' || first_name as label from app.employees order by last_name`
        : Promise.resolve([]),
      sql<{ id: string; label: string }[]>`
        select i.id, s.name || ' – ' || i.invoice_no || ' (' || to_char(i.invoice_date, 'DD.MM.YYYY') || ')' as label
          from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
         order by i.created_at desc limit 200`,
    ]);
    const groups: [InboxTarget, { id: string; label: string }[]][] = [
      ['customer', customers],
      ['supplier', suppliers],
      ['site', sites],
      ['incoming_invoice', incoming],
      ...(hr ? ([['employee', employees]] as [InboxTarget, { id: string; label: string }[]][]) : []),
    ];
    return shell(
      c,
      'eingang',
      'Dokumenteneingang',
      <>
        <div class="card">
          <p class="small mut" style="margin-top:0">
            Post, Scans und E-Mail-Anhänge hier ablegen und danach dem Kunden, Lieferanten, Objekt, der
            Eingangsrechnung oder der Personalakte zuordnen. Die Datei bleibt unverändert (SHA-256), nur die
            Zuordnung wechselt.
          </p>
          <FileArea
            link={{ type: 'inbox', id: INBOX_ID }}
            files={[]}
            category="Eingang"
            title="Dokumente hierher ziehen"
            maxBytes={env.UPLOAD_MAX_BYTES}
          />
        </div>
        <div class="card">
          <h3 style="margin-top:0">Noch nicht zugeordnet ({files.length})</h3>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Datei</th>
                  <th>Eingang</th>
                  <th>Zuordnen zu</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr>
                    <td>
                      <a href={`/dateien/${f.id}`} target="_blank">
                        {f.original_name}
                      </a>
                      {/\.(xml|pdf)$/i.test(f.original_name) && (
                        <div class="small">
                          <a href={`/rechnungseingang/e-rechnung/${f.id}`}>
                            {f.category === 'E-Rechnung'
                              ? 'E-Rechnung prüfen und übernehmen'
                              : 'als E-Rechnung lesen'}
                          </a>
                        </div>
                      )}
                    </td>
                    <td class="small">
                      {at(f.created_at)} · {f.uploaded_by}
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/transfer/dokumenteneingang/${f.id}`}
                        class="actions"
                        style="margin:0;flex-wrap:nowrap"
                      >
                        <select name="target" required style="min-width:260px" aria-label="Ziel">
                          <option value="">– wählen –</option>
                          {groups.map(([type, list]) => (
                            <optgroup label={INBOX_TARGETS[type]}>
                              {list.map((x) => (
                                <option value={`${type}:${x.id}`}>{x.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <input name="category" placeholder="Kategorie" style="max-width:140px" />
                        <button class="btn sm">Zuordnen</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {files.length === 0 && (
                  <tr>
                    <td colspan={3} class="mut">
                      Eingang ist leer.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </>,
    );
  });

  app.post(`/transfer/dokumenteneingang/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const [type, id] = (str(b, 'target') ?? '').split(':') as [InboxTarget, string | undefined];
    if (!type || !id || !(type in INBOX_TARGETS) || !/^[0-9a-f-]{36}$/.test(id))
      throw new BusinessError('Bitte ein Ziel wählen');
    if (type === 'employee' && !canAccess(c.get('user').role, `/personal/${id}`)) {
      throw new BusinessError('Personalakten nur für Personal/Admin');
    }
    await assignInboxFile(sql, c.req.param('id'), { type, id, category: str(b, 'category') }, c.get('actor'));
    return back(c, '/transfer/dokumenteneingang', { ok: `Zugeordnet (${INBOX_TARGETS[type]}).` });
  });
}
