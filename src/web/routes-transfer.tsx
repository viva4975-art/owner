import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  assignDebitRun,
  assignInvoices,
  assignPaymentRun,
  assignReturn,
  type BankTx,
  getTransaction,
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
import { getSeller } from '../services/masterdata.js';
import { listOpenItems } from '../services/payments.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { arr, str } from './forms.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';
import { canAccess } from './permissions.js';

const TX_STATUS: Record<string, string> = {
  offen: 'offen',
  zugeordnet: 'zugeordnet',
  ignoriert: 'ignoriert',
};
const isDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const at = (d: Date) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });

export function registerTransferRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  const shell = (c: Context<AppEnv>, active: string, title: string, body: Child) => {
    const tabs: Tab[] = [
      { key: 'konto', label: 'Kontoumsätze', href: '/transfer/kontoumsaetze' },
      { key: 'versand', label: 'Dokumentenversand', href: '/transfer/dokumentenversand' },
      { key: 'eingang', label: 'Dokumenteneingang', href: '/transfer/dokumenteneingang' },
    ];
    return page(
      c,
      title,
      'transfer',
      <>
        <PageHead title={title} crumbs={[['Transfer', '/transfer/kontoumsaetze']]} />
        <Tabs tabs={tabs} active={active} />
        {body}
      </>,
    );
  };

  // ================================================================ Kontoumsätze
  app.get('/transfer/kontoumsaetze', async (c) => {
    const status = (c.req.query('status') ?? 'offen') as BankTx['status'] | 'alle';
    const [rows, seller, imports] = await Promise.all([
      listTransactions(sql, { status: status in TX_STATUS || status === 'alle' ? status : 'offen' }),
      getSeller(sql),
      listImports(sql),
    ]);
    const sugg = await Promise.all(
      rows.map((t) => (t.status === 'offen' ? suggestions(sql, t) : Promise.resolve([]))),
    );
    return shell(
      c,
      'konto',
      'Kontoumsätze',
      <>
        <form
          method="post"
          action="/transfer/kontoumsaetze/import"
          enctype="multipart/form-data"
          class="card"
        >
          <h3 style="margin-top:0">Kontoauszug einlesen</h3>
          <input type="hidden" name="id" value={randomUUID()} />
          <div class="grid">
            <div>
              <label for="datei">Datei (CAMT.053 als XML oder CSV aus dem Online-Banking)</label>
              <input id="datei" type="file" name="datei" accept=".xml,.csv,.txt" required />
            </div>
            <div>
              <label for="konto">Konto (nur nötig, wenn die CSV-Datei kein Konto enthält)</label>
              <select id="konto" name="konto">
                {seller.bankAccounts.map((b) => (
                  <option value={b.iban.replace(/\s/g, '')}>
                    {b.name ?? 'Konto'} – {b.iban}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="actions" style="margin-bottom:0">
            <button class="btn">Einlesen</button>
            <span class="small mut">
              Mehrfach oder überlappend einlesen ist unschädlich – jeder Umsatz wird nur einmal übernommen.
              Gebucht wird erst, wenn Sie einen Vorschlag bestätigen.
            </span>
          </div>
        </form>
        <div class="actions">
          {(['offen', 'zugeordnet', 'ignoriert', 'alle'] as const).map((s) => (
            <a class={`btn sm ${s === status ? '' : 'sec'}`} href={`/transfer/kontoumsaetze?status=${s}`}>
              {s === 'alle' ? 'Alle' : TX_STATUS[s]}
            </a>
          ))}
        </div>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Buchung</th>
                  <th>Auftraggeber / Empfänger</th>
                  <th>Verwendungszweck</th>
                  <th class="r">Betrag</th>
                  <th>Vorschlag / Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t, i) => {
                  const s = sugg[i]![0];
                  return (
                    <tr>
                      <td>{dateDe(t.booking_date)}</td>
                      <td>
                        {t.counterparty_name ?? '–'}
                        {t.counterparty_iban && <div class="small mut">{t.counterparty_iban}</div>}
                      </td>
                      <td class="small" style="max-width:360px">
                        {t.purpose}
                      </td>
                      <td class="r" style={t.amount_cents < 0n ? 'color:var(--err)' : 'color:var(--ok)'}>
                        <b>{euro(t.amount_cents)}</b>
                      </td>
                      <td>
                        {t.status !== 'offen' ? (
                          <span class={`badge ${t.status === 'zugeordnet' ? 'ok' : ''}`}>
                            {TX_STATUS[t.status]}
                            {t.note ? `: ${t.note}` : ''}
                          </span>
                        ) : s ? (
                          <form
                            method="post"
                            action={`/transfer/kontoumsaetze/${t.id}/vorschlag`}
                            style="margin:0"
                          >
                            <input type="hidden" name="n" value="0" />
                            <div class="small">
                              {s.kind === 'invoices' && (
                                <span
                                  class={`badge ${s.confidence === 'sicher' ? 'ok' : s.confidence === 'prüfen' ? 'warn' : 'info'}`}
                                >
                                  {s.confidence}
                                </span>
                              )}{' '}
                              {s.label}
                            </div>
                            <div class="actions" style="margin:4px 0 0">
                              <button class="btn sm">Übernehmen</button>
                              <a class="btn sm sec" href={`/transfer/kontoumsaetze/${t.id}`}>
                                Andere Zuordnung
                              </a>
                            </div>
                          </form>
                        ) : (
                          <a class="btn sm sec" href={`/transfer/kontoumsaetze/${t.id}`}>
                            Zuordnen …
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colspan={5} class="mut">
                      {status === 'offen' ? 'Keine offenen Umsätze – alles zugeordnet.' : 'Keine Umsätze.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {imports.length > 0 && (
          <details class="card">
            <summary>Eingelesene Auszüge ({imports.length})</summary>
            <ul class="small">
              {imports.map((i) => (
                <li>
                  {at(i.created_at)} · {i.filename} ({i.format === 'camt053' ? 'CAMT.053' : 'CSV'}) ·{' '}
                  {i.line_count} Umsätze, davon neu {i.new_count} · {i.created_by}
                </li>
              ))}
            </ul>
          </details>
        )}
      </>,
    );
  });

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
    return back(c, '/transfer/kontoumsaetze', {
      ok: `${r.lines} Umsätze gelesen, davon ${r.created} neu${r.lines > r.created ? ` (${r.lines - r.created} schon vorhanden)` : ''}.`,
    });
  });

  app.get(`/transfer/kontoumsaetze/:id{${UUID}}`, async (c) => {
    const t = await getTransaction(sql, c.req.param('id'));
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    const [sugg, open] = await Promise.all([
      suggestions(sql, t),
      t.amount_cents > 0n ? listOpenItems(sql) : Promise.resolve([]),
    ]);
    const positive = open.filter((o) => o.open_cents > 0n);
    return shell(
      c,
      'konto',
      `Umsatz ${dateDe(t.booking_date)} · ${euro(t.amount_cents)}`,
      <>
        <div class="cols">
          <div class="card">
            <dl class="kv">
              <dt>Buchungstag</dt>
              <dd>{dateDe(t.booking_date)}</dd>
              <dt>Betrag</dt>
              <dd>
                <b>{euro(t.amount_cents)}</b>
              </dd>
              <dt>{t.amount_cents > 0n ? 'Auftraggeber' : 'Empfänger'}</dt>
              <dd>
                {t.counterparty_name ?? '–'}{' '}
                {t.counterparty_iban && <span class="small mut">{t.counterparty_iban}</span>}
              </dd>
              <dt>Verwendungszweck</dt>
              <dd>{t.purpose || '–'}</dd>
              <dt>Konto</dt>
              <dd>{t.account_iban}</dd>
              <dt>Status</dt>
              <dd>
                {TX_STATUS[t.status]}
                {t.note ? ` – ${t.note}` : ''}
                {t.matched_by ? ` (${t.matched_by}, ${at(t.matched_at!)})` : ''}
              </dd>
            </dl>
            {t.status === 'offen' && (
              <form method="post" action={`/transfer/kontoumsaetze/${t.id}/ignorieren`} class="actions">
                <input name="note" placeholder="Notiz, z. B. Gehalt, Miete, Steuer" style="max-width:320px" />
                <button class="btn sm sec">Ohne Zuordnung abhaken</button>
              </form>
            )}
            {t.status === 'ignoriert' && (
              <form method="post" action={`/transfer/kontoumsaetze/${t.id}/oeffnen`} class="actions">
                <button class="btn sm sec">Wieder öffnen</button>
              </form>
            )}
          </div>
          <div class="card">
            <h3>Vorschläge</h3>
            {sugg.length === 0 && (
              <p class="mut small">Kein passender Vorschlag – unten von Hand zuordnen.</p>
            )}
            {sugg.map((s, n) => (
              <form
                method="post"
                action={`/transfer/kontoumsaetze/${t.id}/vorschlag`}
                class="actions"
                style="align-items:center"
              >
                <input type="hidden" name="n" value={String(n)} />
                <span>{s.label}</span>
                <button class="btn sm">Übernehmen</button>
              </form>
            ))}
          </div>
        </div>
        {t.status === 'offen' && t.amount_cents > 0n && (
          <form method="post" action={`/transfer/kontoumsaetze/${t.id}/zuordnen`} class="card">
            <h3 style="margin-top:0">Von Hand auf Rechnungen verteilen</h3>
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
                        <a href={`/rechnungen/${o.invoice_id}`}>{o.number}</a>
                      </td>
                      <td>{o.customer_name}</td>
                      <td>{dateDe(o.due_date)}</td>
                      <td class="r">{euro(o.open_cents)}</td>
                      <td class="r">
                        <input type="hidden" name="inv" value={o.invoice_id} />
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
                </tbody>
              </table>
            </div>
            <div class="formfoot">
              <button class="btn">Zahlungen buchen</button>
            </div>
          </form>
        )}
      </>,
    );
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/vorschlag`, async (c) => {
    const id = c.req.param('id');
    const t = await getTransaction(sql, id);
    if (!t) throw new BusinessError('Umsatz nicht gefunden');
    if (t.status === 'zugeordnet') return back(c, '/transfer/kontoumsaetze', { ok: 'War schon zugeordnet.' });
    const n = Number((await c.req.parseBody()).n ?? 0);
    const s = (await suggestions(sql, t))[n];
    if (!s) throw new BusinessError('Vorschlag nicht mehr gültig – bitte neu laden');
    const actor = c.get('actor');
    if (s.kind === 'invoices') {
      await assignInvoices(
        sql,
        id,
        s.items.map((i) => ({ invoiceId: i.invoice_id, amount: i.amount, skonto: i.skonto })),
        actor,
      );
    } else if (s.kind === 'debit_run') await assignDebitRun(sql, id, s.runId, actor);
    else if (s.kind === 'payment_run') await assignPaymentRun(sql, id, s.runId, actor);
    else await assignReturn(sql, id, s.runId, s.invoiceId, actor);
    return back(c, '/transfer/kontoumsaetze', { ok: `Zugeordnet: ${s.label}` });
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
        try {
          return { invoiceId: x.invoiceId, amount: parseEuro(x.a), skonto: x.s ? parseEuro(x.s) : 0n };
        } catch {
          throw new BusinessError(`Betrag nicht lesbar: ${x.a} ${x.s}`);
        }
      });
    await assignInvoices(sql, id, items, c.get('actor'));
    return back(c, '/transfer/kontoumsaetze', { ok: `${items.length} Zahlung(en) gebucht.` });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/ignorieren`, async (c) => {
    await ignoreTransaction(sql, c.req.param('id'), str(await c.req.parseBody(), 'note'), c.get('actor'));
    return back(c, '/transfer/kontoumsaetze', { ok: 'Umsatz abgehakt.' });
  });

  app.post(`/transfer/kontoumsaetze/:id{${UUID}}/oeffnen`, async (c) => {
    await reopenTransaction(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/transfer/kontoumsaetze/${c.req.param('id')}`, { ok: 'Wieder offen.' });
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
