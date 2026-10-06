import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import type { Context } from 'hono';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  type CashKind,
  MONTH_RE,
  cancelEntry,
  cashMonths,
  closeMonth,
  getEntry,
  listCardReceipts,
  monthCsv,
  monthLabel,
  monthPdf,
  monthView,
  overview,
  saveCardReceipt,
  saveEntry,
  setOpening,
} from '../services/cashbook.js';
import { BusinessError } from '../services/errors.js';
import type { AppEnv } from './app.js';
import { type Ctx, UUID } from './app.js';
import { centsToInput, str } from './forms.js';
import { dateDe, euro } from './layout.js';

const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const dayLabel = (d: string) => {
  const dt = new Date(`${d}T12:00:00Z`);
  return `${WD[dt.getUTCDay()]}, ${dt.getUTCDate()}. ${monthLabel(d.slice(0, 7))}`;
};
const money = (raw: string | null, what = 'Betrag') => {
  try {
    return parseEuro(raw ?? '');
  } catch {
    throw new BusinessError(`${what} ist ungültig`);
  }
};
async function fileOf(b: Record<string, unknown>, key: string) {
  const f = b[key];
  if (!(f instanceof File) || !f.size) return null;
  return {
    bytes: new Uint8Array(await f.arrayBuffer()),
    name: f.name || 'beleg',
    type: f.type || 'application/octet-stream',
  };
}

const KbTabs = ({ active, month }: { active: string; month: string }) => (
  <div class="tabs">
    <a href={`/kassenbuch?monat=${month}`} class={active === 'kasse' ? 'on' : ''}>
      Kasse
    </a>
    <a href="/kassenbuch/kartenbelege" class={active === 'karten' ? 'on' : ''}>
      Karten-Belege
    </a>
    <a href="/kassenbuch/auswertung" class={active === 'auswertung' ? 'on' : ''}>
      Auswertung
    </a>
  </div>
);

/** Kassenbuch wie die alte App (Kasse / Karten-Belege / Auswertung), GoBD-fest. */
export function registerCashbookRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const curMonth = () => todayBerlin().slice(0, 7);
  const monthQ = (c: Context<AppEnv>) => {
    const m = c.req.query('monat') ?? '';
    return MONTH_RE.test(m) ? m : curMonth();
  };

  // ------------------------------------------------------------------ Kasse
  app.get('/kassenbuch', async (c) => {
    const month = monthQ(c);
    const q = (c.req.query('q') ?? '').trim();
    const typ =
      c.req.query('typ') === 'einnahme' || c.req.query('typ') === 'ausgabe' ? c.req.query('typ')! : '';
    const [v, months] = await Promise.all([monthView(sql, month), cashMonths(sql)]);
    if (!months.includes(month)) months.unshift(month);
    const ql = q.toLowerCase();
    const rows = v.rows
      .filter((r) => !typ || r.kind === typ)
      .filter(
        (r) =>
          !ql ||
          r.description.toLowerCase().includes(ql) ||
          (r.receipt_ref ?? '').toLowerCase().includes(ql) ||
          String(r.entry_no) === ql,
      )
      .slice()
      .reverse();
    const days = new Map<string, typeof rows>();
    for (const r of rows) days.set(r.entry_date, [...(days.get(r.entry_date) ?? []), r]);
    // Tagesendsaldo = Saldo der letzten (gültigen) Buchung des Tages, unabhängig vom Filter
    const daySaldo = new Map<string, bigint>();
    for (const r of v.rows) if (r.saldo !== null) daySaldo.set(r.entry_date, r.saldo);
    const isPast = month < curMonth();
    return page(
      c,
      'Kassenbuch',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Buchhaltung</div>
            <h1>Kasse</h1>
            <div class="sub">Bargeld-Buchungen pro Monat · {monthLabel(month)}</div>
          </div>
          <div class="acts">
            <form method="get" action="/kassenbuch">
              <select
                name="monat"
                data-nosearch
                onchange="this.form.submit()"
                style="min-width:180px"
                aria-label="Monat"
              >
                {months.map((m) => (
                  <option value={m} selected={m === month}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </form>
            <details class="pop">
              <summary class="btn sec">+ Anderer Monat</summary>
              <div class="panel">
                <form method="get" action="/kassenbuch">
                  <input type="month" name="monat" required aria-label="Monat" />
                  <button class="btn sm">Öffnen</button>
                </form>
              </div>
            </details>
          </div>
        </div>
        <KbTabs active="kasse" month={month} />
        {v.closed && (
          <div class="due-banner ok">
            <span class="ico">✓</span>
            <span>
              {monthLabel(month)} ist abgeschlossen ({v.closed.closed_by},{' '}
              {v.closed.closed_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}) – keine
              Änderungen mehr möglich.
            </span>
          </div>
        )}
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-num">{euro(v.opening)}</div>
            <div class="stat-lbl">Anfangsbestand{v.openingManual ? '' : ' (Übertrag Vormonat)'}</div>
            {!v.closed && (
              <details class="pop">
                <summary class="btn sm sec" style="margin-top:6px;align-self:flex-start">
                  {v.openingManual ? 'Ändern' : 'Festlegen'}
                </summary>
                <div class="panel">
                  <form method="post" action={`/kassenbuch/anfangsbestand/${month}`}>
                    <label for="ab">Anfangsbestand {monthLabel(month)} in €</label>
                    <input
                      id="ab"
                      name="betrag"
                      inputmode="decimal"
                      value={centsToInput(v.opening)}
                      required
                    />
                    <button class="btn sm">Speichern</button>
                  </form>
                </div>
              </details>
            )}
          </div>
          <div class="stat-card tone-ok">
            <div class="stat-num">+{euro(v.income)}</div>
            <div class="stat-lbl">Einnahmen · {v.incomeCount}</div>
          </div>
          <div class="stat-card tone-err">
            <div class="stat-num">−{euro(v.expense)}</div>
            <div class="stat-lbl">Ausgaben · {v.expenseCount}</div>
          </div>
          <div class="stat-card tone-brand on">
            <div class="stat-num">{euro(v.closing)}</div>
            <div class="stat-lbl">Endbestand</div>
          </div>
        </div>
        <form class="toolbar" method="get" action="/kassenbuch">
          <input type="hidden" name="monat" value={month} />
          <input
            class="search-input"
            type="search"
            name="q"
            value={q}
            placeholder="Suche in Beschreibung, Beleg-Nr …"
          />
          <select
            name="typ"
            data-nosearch
            onchange="this.form.submit()"
            aria-label="Typ"
            style="max-width:160px"
          >
            <option value="">Alle</option>
            <option value="einnahme" selected={typ === 'einnahme'}>
              Einnahmen
            </option>
            <option value="ausgabe" selected={typ === 'ausgabe'}>
              Ausgaben
            </option>
          </select>
          <a class="btn sec" href={`/kassenbuch/${month}.pdf`}>
            PDF-Export
          </a>
          <a class="btn sec" href={`/kassenbuch/${month}.csv`}>
            CSV-Export
          </a>
          {!v.closed && (
            <a class="btn" href={`/kassenbuch/buchung/${randomUUID()}?monat=${month}`}>
              + Buchung
            </a>
          )}
        </form>
        {rows.length === 0 ? (
          <div class="empty">
            {v.rows.length ? 'Keine Buchungen passen zum Filter.' : 'Keine Buchungen in diesem Monat.'}
          </div>
        ) : (
          <div class="kb-list">
            {[...days.entries()].map(([d, list]) => {
              const inn = list
                .filter((r) => r.kind === 'einnahme' && !r.cancelled_at)
                .reduce((a, r) => a + r.amount_cents, 0n);
              const out = list
                .filter((r) => r.kind === 'ausgabe' && !r.cancelled_at)
                .reduce((a, r) => a + r.amount_cents, 0n);
              return (
                <>
                  <div class="kb-day">
                    <div class="kb-day-t">{dayLabel(d)}</div>
                    <div class="kb-day-s">
                      {inn > 0n && <span class="kb-pos">+{euro(inn)}</span>}
                      {out > 0n && <span class="kb-neg">−{euro(out)}</span>}
                      <span>
                        Saldo Tagesende: <b>{euro(daySaldo.get(d) ?? v.opening)}</b>
                      </span>
                    </div>
                  </div>
                  {list.map((r) => (
                    <a
                      class={`kb-row${r.cancelled_at ? ' storno' : ''}`}
                      href={`/kassenbuch/buchung/${r.id}`}
                    >
                      <div class="kb-date">
                        <b>{dateDe(r.entry_date).slice(0, 6)}</b>
                        <span>Nr. {r.entry_no}</span>
                      </div>
                      <div class="kb-main">
                        <div class="kb-desc">{r.description}</div>
                        <div class="kb-meta">
                          {r.cancelled_at && <span class="badge err">storniert</span>}
                          {r.receipt_ref && <span>Beleg-Nr {r.receipt_ref}</span>}
                          {r.receipt_path && <span class="kb-has">Beleg-Foto</span>}
                          {r.note && <span>{r.note}</span>}
                        </div>
                      </div>
                      <div class="kb-amt">
                        <div class={r.kind === 'einnahme' ? 'kb-pos' : 'kb-neg'}>
                          {r.kind === 'einnahme' ? '+' : '−'}
                          {euro(r.amount_cents)}
                        </div>
                        {r.saldo !== null && (
                          <div class="kb-saldo">
                            Saldo: <b>{euro(r.saldo)}</b>
                          </div>
                        )}
                      </div>
                    </a>
                  ))}
                </>
              );
            })}
          </div>
        )}
        {isPast && !v.closed && (
          <details class="card" style="margin-top:18px">
            <summary>
              <b>Monat abschließen (Kassensturz)</b>
            </summary>
            <form method="post" action={`/kassenbuch/abschluss/${month}`} style="margin-top:10px">
              <p class="small mut">
                Bargeld zählen und eintragen. Stimmt der gezählte Bestand mit dem Buchbestand (
                {euro(v.closing)}) überein, wird {monthLabel(month)} abgeschlossen – danach sind Buchungen
                dieses Monats nicht mehr änderbar (GoBD).
              </p>
              <div class="grid">
                <div>
                  <label for="gezaehlt">Gezählter Bestand in €</label>
                  <input id="gezaehlt" name="gezaehlt" inputmode="decimal" required />
                </div>
              </div>
              <div class="formfoot">
                <button class="btn" data-confirm={`${monthLabel(month)} endgültig abschließen?`}>
                  Abschließen
                </button>
              </div>
            </form>
          </details>
        )}
      </div>,
    );
  });

  app.post('/kassenbuch/anfangsbestand/:m', async (c) => {
    const m = c.req.param('m');
    const b = await c.req.parseBody({ all: true });
    await setOpening(sql, m, money(str(b, 'betrag'), 'Anfangsbestand'), c.get('actor'));
    return back(c, `/kassenbuch?monat=${m}`, { ok: 'Anfangsbestand gespeichert.' });
  });

  app.post('/kassenbuch/abschluss/:m', async (c) => {
    const m = c.req.param('m');
    const b = await c.req.parseBody({ all: true });
    await closeMonth(sql, m, money(str(b, 'gezaehlt'), 'Gezählter Bestand'), c.get('actor'));
    return back(c, `/kassenbuch?monat=${m}`, { ok: `${monthLabel(m)} abgeschlossen.` });
  });

  // ------------------------------------------------------------------ Buchung
  app.get(`/kassenbuch/buchung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getEntry(sql, id);
    const e = data?.entry;
    const month = e ? e.entry_date.slice(0, 7) : monthQ(c);
    const today = todayBerlin();
    const defDate = month === curMonth() ? today : `${month}-01`;
    const [closed] = await sql`select 1 from app.cash_closings where month = ${month}`;
    const locked = !!e?.cancelled_at || !!closed;
    const kind: CashKind = e?.kind ?? (c.req.query('typ') === 'einnahme' ? 'einnahme' : 'ausgabe');
    return page(
      c,
      e ? `Kassenbuchung Nr. ${e.entry_no}` : 'Neue Kassenbuchung',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">
              <a href={`/kassenbuch?monat=${month}`}>Kasse · {monthLabel(month)}</a>
            </div>
            <h1>{e ? `Buchung Nr. ${e.entry_no}` : 'Neue Buchung'}</h1>
            {e?.cancelled_at && (
              <div class="sub">
                <span class="badge err">storniert</span> {e.cancel_reason}
              </div>
            )}
          </div>
        </div>
        <div class="cols">
          <form method="post" action={`/kassenbuch/buchung/${id}`} enctype="multipart/form-data" class="card">
            <input type="hidden" name="version" value={String(e?.version ?? '')} />
            <fieldset disabled={locked} style="border:0;padding:0;margin:0">
              <label>Typ</label>
              <div class="seg big" style="margin-bottom:10px">
                <label>
                  <input type="radio" name="typ" value="ausgabe" checked={kind === 'ausgabe'} />
                  <span>Ausgabe</span>
                </label>
                <label>
                  <input type="radio" name="typ" value="einnahme" checked={kind === 'einnahme'} />
                  <span>Einnahme</span>
                </label>
              </div>
              <div class="grid">
                <div>
                  <label for="datum">Datum</label>
                  <input
                    id="datum"
                    type="date"
                    name="datum"
                    max={today}
                    value={e?.entry_date ?? defDate}
                    required
                  />
                </div>
                <div>
                  <label for="beschreibung">Beschreibung</label>
                  <input
                    id="beschreibung"
                    name="beschreibung"
                    value={e?.description ?? ''}
                    placeholder="z. B. Reinigungsmittel Metro"
                    required
                  />
                </div>
                <div>
                  <label for="betrag">Betrag (€)</label>
                  <input
                    id="betrag"
                    name="betrag"
                    inputmode="decimal"
                    value={e ? centsToInput(e.amount_cents) : ''}
                    placeholder="0,00"
                    required
                  />
                </div>
                <div>
                  <label for="beleg">Beleg-Nr</label>
                  <input id="beleg" name="beleg" value={e?.receipt_ref ?? ''} placeholder="optional" />
                </div>
                <div>
                  <label for="datei">Beleg (Foto oder PDF)</label>
                  <div>
                    {e?.receipt_path && (
                      <p class="small" style="margin:0 0 6px">
                        <a href={`/kassenbuch/beleg/${e.id}`} target="_blank">
                          {e.receipt_name ?? 'Beleg'} öffnen
                        </a>
                      </p>
                    )}
                    <input
                      id="datei"
                      type="file"
                      name="datei"
                      accept="image/*,application/pdf"
                      capture="environment"
                    />
                  </div>
                </div>
                <div>
                  <label for="notiz">Notiz</label>
                  <textarea id="notiz" name="notiz" rows={2}>
                    {e?.note ?? ''}
                  </textarea>
                </div>
              </div>
            </fieldset>
            {!locked && (
              <div class="formfoot">
                <button class="btn">{e ? 'Speichern' : 'Buchen'}</button>
                <a class="btn sec" href={`/kassenbuch?monat=${month}`}>
                  Abbrechen
                </a>
              </div>
            )}
          </form>
          <div>
            {e && !locked && (
              <details class="card">
                <summary>
                  <b>Buchung stornieren</b>
                </summary>
                <form method="post" action={`/kassenbuch/buchung/${id}/storno`} style="margin-top:10px">
                  <p class="small mut">
                    Kassenbuchungen werden nicht gelöscht (GoBD). Das Storno bleibt mit Grund sichtbar und
                    zählt nicht mehr im Bestand.
                  </p>
                  <label for="grund">Grund</label>
                  <input id="grund" name="grund" required placeholder="z. B. doppelt erfasst" />
                  <div class="formfoot">
                    <button class="btn danger" data-confirm="Buchung stornieren?">
                      Stornieren
                    </button>
                  </div>
                </form>
              </details>
            )}
            <div class="card">
              <h3>Protokoll</h3>
              {!data?.log.length ? (
                <p class="small mut">
                  Jede Buchung bekommt eine fortlaufende Nummer. Änderungen werden mit altem und neuem Stand
                  protokolliert, abgeschlossene Monate sind gesperrt.
                </p>
              ) : (
                <ul class="small" style="padding-left:18px;margin:0">
                  {data.log.map((l) => (
                    <li>
                      {l.created_at.toLocaleString('de-DE', {
                        timeZone: 'Europe/Berlin',
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}{' '}
                      · {l.action} · {l.actor}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>,
    );
  });

  app.post(`/kassenbuch/buchung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const date = str(b, 'datum') ?? '';
    await saveEntry(
      deps,
      id,
      {
        kind: str(b, 'typ') === 'einnahme' ? 'einnahme' : 'ausgabe',
        date,
        description: str(b, 'beschreibung') ?? '',
        amountCents: money(str(b, 'betrag')),
        receiptRef: str(b, 'beleg'),
        note: str(b, 'notiz'),
        file: await fileOf(b, 'datei'),
        expectedVersion: str(b, 'version') ? Number(str(b, 'version')) : null,
      },
      c.get('actor'),
    );
    return back(c, `/kassenbuch?monat=${date.slice(0, 7)}`, { ok: 'Buchung gespeichert.' });
  });

  app.post(`/kassenbuch/buchung/:id{${UUID}}/storno`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    await cancelEntry(sql, id, str(b, 'grund') ?? '', c.get('actor'));
    const d = await getEntry(sql, id);
    return back(c, `/kassenbuch?monat=${d!.entry.entry_date.slice(0, 7)}`, { ok: 'Buchung storniert.' });
  });

  const serve = async (path: string, name: string | null, type: string | null) =>
    new Response(await deps.archive.get(path), {
      headers: {
        'Content-Type': type ?? 'application/octet-stream',
        'Content-Disposition': `inline; filename="${(name ?? 'beleg').replace(/[^\w.\- ]/g, '_')}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });

  app.get(`/kassenbuch/beleg/:id{${UUID}}`, async (c) => {
    const d = await getEntry(sql, c.req.param('id'));
    if (!d?.entry.receipt_path) return c.notFound();
    return serve(d.entry.receipt_path, d.entry.receipt_name, d.entry.receipt_type);
  });

  app.get('/kassenbuch/:file{\\d{4}-\\d{2}\\.[a-z]+}', async (c) => {
    const [m, ext] = c.req.param('file').split('.') as [string, string];
    if (ext === 'csv')
      return new Response(monthCsv(await monthView(sql, m)), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="Kassenbuch_${m}.csv"`,
        },
      });
    if (ext !== 'pdf') return c.notFound();
    return new Response(await monthPdf(sql, m), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Kassenbuch_${m}.pdf"` },
    });
  });

  // ------------------------------------------------------------------ Karten-Belege
  app.get('/kassenbuch/kartenbelege', async (c) => {
    const m = MONTH_RE.test(c.req.query('monat') ?? '') ? c.req.query('monat')! : '';
    const [all, items] = await Promise.all([listCardReceipts(sql), listCardReceipts(sql, m || undefined)]);
    const months = [...new Set(all.map((k) => k.receipt_date.slice(0, 7)))].sort().reverse();
    const sum = items.reduce((a, k) => a + k.amount_cents, 0n);
    const edit = c.req.query('beleg');
    const cur = edit ? all.find((k) => k.id === edit) : undefined;
    const formId = cur?.id ?? randomUUID();
    return page(
      c,
      'Karten-Belege',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Buchhaltung · Archiv</div>
            <h1>Karten-Belege</h1>
            <div class="sub">
              Eingescannte Belege von EC- oder Kreditkartenzahlungen – werden nicht in den Kassenbestand
              eingerechnet.
            </div>
          </div>
          <form class="acts" method="get" action="/kassenbuch/kartenbelege">
            <select
              name="monat"
              data-nosearch
              onchange="this.form.submit()"
              style="min-width:160px"
              aria-label="Monat"
            >
              <option value="">Alle Monate</option>
              {months.map((x) => (
                <option value={x} selected={x === m}>
                  {monthLabel(x)}
                </option>
              ))}
            </select>
            {items.length > 0 && (
              <a class="btn sec" href={`/kassenbuch/kartenbelege.zip${m ? `?monat=${m}` : ''}`}>
                ↓ Export
              </a>
            )}
            <a class="btn" href="#kb-form">
              + Karten-Beleg
            </a>
          </form>
        </div>
        <KbTabs active="karten" month={curMonth()} />
        <div class="stat-grid" style="max-width:600px">
          <div class="stat-card">
            <div class="stat-num">{items.length}</div>
            <div class="stat-lbl">Archivierte Belege</div>
          </div>
          <div class="stat-card tone-brand">
            <div class="stat-num">{euro(sum)}</div>
            <div class="stat-lbl">Summe (Brutto)</div>
          </div>
        </div>
        {items.length === 0 ? (
          <div class="empty">Keine Karten-Belege.</div>
        ) : (
          <div class="kb-grid">
            {items.map((k) => (
              <a
                class="kb-card"
                href={`/kassenbuch/kartenbelege?${m ? `monat=${m}&` : ''}beleg=${k.id}#kb-form`}
              >
                <div class="kb-thumb">
                  {k.receipt_type?.startsWith('image/') ? (
                    <img src={`/kassenbuch/kartenbeleg/${k.id}`} alt="Beleg" loading="lazy" />
                  ) : (
                    <span>PDF</span>
                  )}
                </div>
                <div class="kb-info">
                  <div class="small mut">{dateDe(k.receipt_date)}</div>
                  <b>{euro(k.amount_cents)}</b>
                  {k.note && <div class="small mut">{k.note}</div>}
                </div>
              </a>
            ))}
          </div>
        )}
        <form
          id="kb-form"
          method="post"
          action={`/kassenbuch/kartenbelege/${formId}`}
          enctype="multipart/form-data"
          class="card"
          style="margin-top:18px;max-width:640px"
        >
          <h3>{cur ? 'Karten-Beleg bearbeiten' : 'Karten-Beleg archivieren'}</h3>
          <input type="hidden" name="version" value={String(cur?.version ?? '')} />
          <input type="hidden" name="monat" value={m} />
          <div class="grid">
            <div>
              <label for="k-datum">Datum</label>
              <input
                id="k-datum"
                type="date"
                name="datum"
                value={cur?.receipt_date ?? todayBerlin()}
                required
              />
            </div>
            <div>
              <label for="k-betrag">Betrag brutto (€)</label>
              <input
                id="k-betrag"
                name="betrag"
                inputmode="decimal"
                value={cur ? centsToInput(cur.amount_cents) : ''}
                required
              />
            </div>
            <div>
              <label for="k-datei">Beleg (Foto oder PDF)</label>
              <div>
                {cur && (
                  <p class="small" style="margin:0 0 6px">
                    <a href={`/kassenbuch/kartenbeleg/${cur.id}`} target="_blank">
                      {cur.receipt_name ?? 'Beleg'} öffnen
                    </a>
                  </p>
                )}
                <input
                  id="k-datei"
                  type="file"
                  name="datei"
                  accept="image/*,application/pdf"
                  capture="environment"
                  required={!cur}
                />
              </div>
            </div>
            <div>
              <label for="k-notiz">Notiz</label>
              <input
                id="k-notiz"
                name="notiz"
                value={cur?.note ?? ''}
                placeholder="z. B. Tankstelle, Fahrzeug M-VD 123"
              />
            </div>
          </div>
          <div class="formfoot">
            <button class="btn">Speichern</button>
            {cur && (
              <a class="btn sec" href={`/kassenbuch/kartenbelege${m ? `?monat=${m}` : ''}`}>
                Abbrechen
              </a>
            )}
          </div>
        </form>
      </div>,
    );
  });

  app.post(`/kassenbuch/kartenbelege/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveCardReceipt(
      deps,
      c.req.param('id'),
      {
        date: str(b, 'datum') ?? '',
        amountCents: money(str(b, 'betrag')),
        note: str(b, 'notiz'),
        file: await fileOf(b, 'datei'),
        expectedVersion: str(b, 'version') ? Number(str(b, 'version')) : null,
      },
      c.get('actor'),
    );
    const m = str(b, 'monat');
    return back(c, `/kassenbuch/kartenbelege${m && MONTH_RE.test(m) ? `?monat=${m}` : ''}`, {
      ok: 'Karten-Beleg gespeichert.',
    });
  });

  app.get(`/kassenbuch/kartenbeleg/:id{${UUID}}`, async (c) => {
    const [k] = await sql<
      { receipt_path: string; receipt_name: string | null; receipt_type: string | null }[]
    >`
      select receipt_path, receipt_name, receipt_type from app.card_receipts where id = ${c.req.param('id')}`;
    if (!k) return c.notFound();
    return serve(k.receipt_path, k.receipt_name, k.receipt_type);
  });

  app.get('/kassenbuch/kartenbelege.zip', async (c) => {
    const m = MONTH_RE.test(c.req.query('monat') ?? '') ? c.req.query('monat')! : '';
    const items = await listCardReceipts(sql, m || undefined);
    const files: Record<string, Uint8Array> = {};
    const lines = ['Datum;Betrag;Notiz;Datei'];
    for (const [i, k] of items.entries()) {
      const ext = k.receipt_path.split('.').pop() ?? 'bin';
      const name = `${k.receipt_date}_${String(i + 1).padStart(3, '0')}_${centsToInput(k.amount_cents)}EUR.${ext}`;
      files[name] = await deps.archive.get(k.receipt_path);
      lines.push(
        [
          dateDe(k.receipt_date),
          centsToInput(k.amount_cents),
          `"${(k.note ?? '').replace(/"/g, '""')}"`,
          name,
        ].join(';'),
      );
    }
    files['Uebersicht.csv'] = new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}\r\n`);
    return new Response(zipSync(files, { level: 0 }), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="Kartenbelege_${m || 'alle'}.zip"`,
      },
    });
  });

  // ------------------------------------------------------------------ Auswertung
  app.get('/kassenbuch/auswertung', async (c) => {
    const rows = await overview(sql);
    const inc = rows.reduce((a, r) => a + r.income, 0n);
    const exp = rows.reduce((a, r) => a + r.expense, 0n);
    return page(
      c,
      'Kassenbuch – Auswertung',
      'verwaltung',
      <div class="portal">
        <div class="page-head">
          <div>
            <div class="eyebrow">Buchhaltung · Übersicht</div>
            <h1>Auswertung</h1>
            <div class="sub">Monatsbilanz über alle Kassen-Buchungen</div>
          </div>
        </div>
        <KbTabs active="auswertung" month={curMonth()} />
        <div class="stat-grid">
          <div class="stat-card tone-ok">
            <div class="stat-num">+{euro(inc)}</div>
            <div class="stat-lbl">Einnahmen gesamt</div>
          </div>
          <div class="stat-card tone-err">
            <div class="stat-num">−{euro(exp)}</div>
            <div class="stat-lbl">Ausgaben gesamt</div>
          </div>
          <div class="stat-card tone-brand">
            <div class="stat-num">{euro(inc - exp)}</div>
            <div class="stat-lbl">Saldo</div>
          </div>
        </div>
        <div class="card">
          <h3>Monatsübersicht</h3>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Monat</th>
                  <th class="r">Anfang</th>
                  <th class="r">Einnahmen</th>
                  <th class="r">Ausgaben</th>
                  <th class="r">Endbestand</th>
                  <th class="r">Buchungen</th>
                  <th>Abschluss</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      <a href={`/kassenbuch?monat=${r.month}`}>{monthLabel(r.month)}</a>
                    </td>
                    <td class="r">{euro(r.opening)}</td>
                    <td class="r kb-pos">+{euro(r.income)}</td>
                    <td class="r kb-neg">−{euro(r.expense)}</td>
                    <td class="r">
                      <b>{euro(r.closing)}</b>
                    </td>
                    <td class="r">{r.count}</td>
                    <td>
                      {r.closed ? (
                        <span class="badge ok">abgeschlossen</span>
                      ) : (
                        <span class="badge">offen</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>,
    );
  });
}
