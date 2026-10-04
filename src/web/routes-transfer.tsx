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
  createDebitRun,
  debitProposal,
  debitRunItems,
  debitRunXml,
  earliestCollectionDate,
  listDebitRuns,
  listMandates,
  type Mandate,
  saveMandate,
  settleDebitRun,
  validCreditorId,
} from '../services/direct-debit.js';
import {
  assignInboxFile,
  INBOX_ID,
  INBOX_TARGETS,
  type InboxTarget,
  inboxFiles,
  outbox,
} from '../services/documents.js';
import { BusinessError } from '../services/errors.js';
import { getSeller, listCustomers } from '../services/masterdata.js';
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
      { key: 'lastschrift', label: 'Lastschriften', href: '/transfer/lastschriften' },
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

  // ================================================================ Lastschriften
  app.get('/transfer/lastschriften', async (c) => {
    const [mandates, runs, proposal, seller, [co]] = await Promise.all([
      listMandates(sql),
      listDebitRuns(sql),
      debitProposal(sql),
      getSeller(sql),
      sql<{ creditor_id: string | null }[]>`select creditor_id from app.company`,
    ]);
    const earliest = earliestCollectionDate();
    return shell(
      c,
      'lastschrift',
      'SEPA-Lastschriften',
      <>
        {!co?.creditor_id && (
          <div class="warnbox">
            Für Lastschriften braucht die GmbH eine Gläubiger-Identifikationsnummer der Bundesbank (Antrag
            online, kostenlos). Bitte unten eintragen.
          </div>
        )}
        <form method="post" action="/transfer/lastschriften" class="card">
          <h3 style="margin-top:0">Neuer Einzug</h3>
          <input type="hidden" name="id" value={randomUUID()} />
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="alle"
                      onclick="this.closest('table').querySelectorAll('tbody input[type=checkbox]').forEach(function(x){x.checked=this.checked}.bind(this))"
                    />
                  </th>
                  <th>Rechnung</th>
                  <th>Kunde</th>
                  <th>Mandat</th>
                  <th>fällig</th>
                  <th class="r">Betrag</th>
                </tr>
              </thead>
              <tbody>
                {proposal.map((p) => (
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        name="inv"
                        value={p.invoice_id}
                        checked={p.due_date <= earliest}
                        aria-label={p.number}
                      />
                    </td>
                    <td>
                      <a href={`/rechnungen/${p.invoice_id}`}>{p.number}</a>
                    </td>
                    <td>{p.customer_name}</td>
                    <td class="small">
                      {p.mandate_ref} ({p.scheme})
                    </td>
                    <td>{dateDe(p.due_date)}</td>
                    <td class="r">{euro(p.open_cents)}</td>
                  </tr>
                ))}
                {proposal.length === 0 && (
                  <tr>
                    <td colspan={6} class="mut">
                      Keine offenen Rechnungen von Kunden mit aktivem Mandat.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div class="grid">
            <div>
              <label for="datum">Fälligkeit (Einzugstag)</label>
              <input id="datum" type="date" name="datum" value={earliest} min={earliest} required />
            </div>
            <div>
              <label for="konto2">Gutschrift auf Konto</label>
              <select id="konto2" name="konto">
                {seller.bankAccounts.map((b) => (
                  <option value={b.iban.replace(/\s/g, '')}>
                    {b.name ?? 'Konto'} – {b.iban}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="actions" style="margin-bottom:0">
            <button class="btn" disabled={!proposal.length}>
              Lastschriftdatei erstellen
            </button>
            <span class="small mut">
              Vorher Vorabankündigung (Pre-Notification) an den Kunden – z. B. Hinweis auf der Rechnung mit
              Mandatsreferenz, Gläubiger-ID und Einzugstag (Frist laut Mandat/AGB, sonst 14 Tage).
            </span>
          </div>
        </form>

        <div class="card">
          <h3 style="margin-top:0">Einzüge</h3>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Einzugstag</th>
                  <th class="r">Posten</th>
                  <th class="r">Summe</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr>
                    <td>
                      <a href={`/transfer/lastschriften/${r.id}`}>{r.number}</a>
                    </td>
                    <td>{dateDe(r.collection_date)}</td>
                    <td class="r">{r.item_count}</td>
                    <td class="r">{euro(r.total_cents)}</td>
                    <td>
                      <span class={`badge ${r.status === 'eingezogen' ? 'ok' : 'info'}`}>{r.status}</span>
                    </td>
                    <td>
                      <a href={`/transfer/lastschriften/${r.id}/datei.xml`}>XML</a>
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td colspan={6} class="mut">
                      Noch keine Einzüge.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div class="cols">
          <div class="card">
            <h3 style="margin-top:0">Mandate</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th>Referenz</th>
                    <th>IBAN</th>
                    <th>Art</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {mandates.map((m) => (
                    <tr style={m.active ? '' : 'opacity:.55'}>
                      <td>{m.customer_name}</td>
                      <td>{m.mandate_ref}</td>
                      <td class="small">{m.iban}</td>
                      <td>
                        {m.scheme}
                        {m.active ? '' : ' (inaktiv)'}
                      </td>
                      <td>
                        <a href={`/transfer/mandate/${m.id}`}>Bearbeiten</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="actions" style="margin-bottom:0">
              <a class="btn sm" href={`/transfer/mandate/${randomUUID()}`}>
                Mandat erfassen
              </a>
            </div>
          </div>
          <form method="post" action="/transfer/glaeubiger-id" class="card">
            <h3 style="margin-top:0">Gläubiger-Identifikationsnummer</h3>
            <input
              name="creditor_id"
              value={co?.creditor_id ?? ''}
              placeholder="DE98ZZZ09999999999"
              aria-label="Gläubiger-ID"
            />
            <div class="actions" style="margin-bottom:0">
              <button class="btn sm sec">Speichern</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post('/transfer/glaeubiger-id', async (c) => {
    const id = (str(await c.req.parseBody(), 'creditor_id') ?? '').replace(/\s/g, '').toUpperCase();
    if (id && !validCreditorId(id)) throw new BusinessError('Gläubiger-ID ungültig (Prüfziffer)');
    await sql`update app.company set creditor_id = ${id || null}, updated_at = now() where id = 1`;
    await sql`insert into app.audit_log (actor, action, entity, details) values (${c.get('actor')}, 'creditor_id', 'company', ${sql.json({ creditor_id: id })})`;
    return back(c, '/transfer/lastschriften', { ok: 'Gläubiger-ID gespeichert.' });
  });

  app.post('/transfer/lastschriften', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const id = str(b, 'id');
    const runId = id && /^[0-9a-f-]{36}$/.test(id) ? id : randomUUID();
    const datum = str(b, 'datum');
    if (!isDate(datum)) throw new BusinessError('Einzugstag fehlt');
    await createDebitRun(deps, {
      id: runId,
      invoiceIds: arr(b, 'inv'),
      collectionDate: datum,
      creditorIban: str(b, 'konto') ?? '',
      actor: c.get('actor'),
    });
    return back(c, `/transfer/lastschriften/${runId}`, {
      ok: 'Lastschriftdatei erstellt – jetzt herunterladen und im Online-Banking hochladen.',
    });
  });

  app.get(`/transfer/lastschriften/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [runs, items] = await Promise.all([listDebitRuns(sql), debitRunItems(sql, id)]);
    const r = runs.find((x) => x.id === id);
    if (!r) throw new BusinessError('Einzug nicht gefunden');
    return shell(
      c,
      'lastschrift',
      `Lastschrifteinzug ${r.number}`,
      <>
        <div class="card">
          <p style="margin-top:0">
            Einzugstag <b>{dateDe(r.collection_date)}</b> · {r.item_count} Posten ·{' '}
            <b>{euro(r.total_cents)}</b> ·{' '}
            <span class={`badge ${r.status === 'eingezogen' ? 'ok' : 'info'}`}>{r.status}</span>
          </p>
          <div class="actions">
            <a class="btn" href={`/transfer/lastschriften/${id}/datei.xml`}>
              SEPA-Datei (pain.008) herunterladen
            </a>
            <span class="small mut">SHA-256 {r.xml_sha256?.slice(0, 16)}… (archiviert, unveränderbar)</span>
          </div>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Rechnung</th>
                  <th>Kunde</th>
                  <th>Mandat</th>
                  <th>Art</th>
                  <th class="r">Betrag</th>
                  <th>Rückgabe</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr>
                    <td>
                      <a href={`/rechnungen/${i.invoice_id}`}>{i.number}</a>
                    </td>
                    <td>{i.customer_name}</td>
                    <td class="small">{i.mandate_ref}</td>
                    <td>{i.sequence_type === 'FRST' ? 'Erst' : 'Folge'}</td>
                    <td class="r">{euro(i.amount_cents)}</td>
                    <td class="small">
                      {i.returned_at ? `${dateDe(i.returned_at)} ${i.return_reason ?? ''}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.status === 'erstellt' && (
            <form
              method="post"
              action={`/transfer/lastschriften/${id}/eingezogen`}
              class="actions"
              style="margin-bottom:0"
            >
              <label for="paid" style="margin:0">
                Gutschrift erhalten am
              </label>
              <input
                id="paid"
                type="date"
                name="datum"
                value={todayBerlin()}
                max={todayBerlin()}
                style="max-width:170px"
              />
              <button class="btn sec">Als eingezogen buchen</button>
              <span class="small mut">
                Besser: Kontoauszug einlesen – die Sammelgutschrift wird dann vorgeschlagen.
              </span>
            </form>
          )}
        </div>
      </>,
    );
  });

  app.get(`/transfer/lastschriften/:id{${UUID}}/datei.xml`, async (c) => {
    const id = c.req.param('id');
    const [r] = await sql<{ number: string; xml_path: string | null }[]>`
      select number, xml_path from app.direct_debit_runs where id = ${id}`;
    if (!r) throw new BusinessError('Einzug nicht gefunden');
    // archivierte Datei ausliefern (genau die eingereichte), sonst neu erzeugen
    const body = r.xml_path
      ? await deps.archive.get(r.xml_path)
      : new TextEncoder().encode(await debitRunXml(sql, id));
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="Lastschrift_${r.number}.xml"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  app.post(`/transfer/lastschriften/:id{${UUID}}/eingezogen`, async (c) => {
    const d = str(await c.req.parseBody(), 'datum');
    if (!isDate(d)) throw new BusinessError('Datum fehlt');
    await settleDebitRun(sql, c.req.param('id'), d, c.get('actor'));
    return back(c, `/transfer/lastschriften/${c.req.param('id')}`, { ok: 'Zahlungen gebucht.' });
  });

  // ---------------------------------------------------------------- Mandate
  app.get(`/transfer/mandate/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [all, customers] = await Promise.all([listMandates(sql), listCustomers(sql)]);
    const m: Partial<Mandate> = all.find((x) => x.id === id) ?? {
      active: true,
      scheme: 'CORE',
      customer_id: c.req.query('kunde') ?? '',
    };
    const isNew = !all.some((x) => x.id === id);
    return shell(
      c,
      'lastschrift',
      isNew ? 'Neues SEPA-Mandat' : `Mandat ${m.mandate_ref}`,
      <form
        method="post"
        action={`/transfer/mandate/${id}`}
        class="card"
        data-autosave
        data-version={String(m.version ?? '')}
      >
        <input type="hidden" name="version" value={String(m.version ?? '')} />
        <div class="grid">
          <div>
            <label for="kunde">Kunde</label>
            <select id="kunde" name="customer_id" required>
              <option value="">– bitte wählen –</option>
              {customers
                .filter((x) => x.active)
                .map((x) => (
                  <option value={x.id} selected={x.id === m.customer_id}>
                    {x.customer_no} · {x.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label for="ref">Mandatsreferenz</label>
            <input id="ref" name="mandate_ref" value={m.mandate_ref ?? ''} maxlength={35} required />
          </div>
          <div>
            <label for="signed">Unterschrieben am</label>
            <input
              id="signed"
              type="date"
              name="signed_on"
              value={m.signed_on ?? ''}
              max={todayBerlin()}
              required
            />
          </div>
          <div>
            <label for="scheme">Art</label>
            <select id="scheme" name="scheme">
              <option value="CORE" selected={m.scheme === 'CORE'}>
                Basis-Lastschrift (CORE)
              </option>
              <option value="B2B" selected={m.scheme === 'B2B'}>
                Firmenlastschrift (B2B)
              </option>
            </select>
          </div>
          <div>
            <label for="holder">Kontoinhaber</label>
            <input id="holder" name="account_holder" value={m.account_holder ?? ''} required />
          </div>
          <div>
            <label for="iban">IBAN</label>
            <input id="iban" name="iban" value={m.iban ?? ''} required />
          </div>
          <div>
            <label for="bic">BIC (optional)</label>
            <input id="bic" name="bic" value={m.bic ?? ''} />
          </div>
          <div>
            <label>
              <input type="checkbox" name="active" checked={m.active !== false} /> aktiv (ein aktives Mandat
              je Kunde)
            </label>
          </div>
        </div>
        <label for="note">Notiz</label>
        <input
          id="note"
          name="note"
          value={m.note ?? ''}
          placeholder="z. B. Original im Ordner Lastschriftmandate"
        />
        <p class="small mut">
          Das unterschriebene Mandat (Papier oder PDF) aufbewahren – bis 14 Monate nach dem letzten Einzug.
          B2B-Mandate muss der Kunde zusätzlich seiner Bank bestätigen.
        </p>
        <div class="formfoot">
          <button class="btn">Speichern</button>
        </div>
      </form>,
    );
  });

  app.post(`/transfer/mandate/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const v = str(b, 'version');
    await saveMandate(
      sql,
      c.req.param('id'),
      {
        customerId: str(b, 'customer_id') ?? '',
        mandateRef: str(b, 'mandate_ref') ?? '',
        signedOn: str(b, 'signed_on') ?? '',
        accountHolder: str(b, 'account_holder') ?? '',
        iban: str(b, 'iban') ?? '',
        bic: str(b, 'bic'),
        scheme: str(b, 'scheme') === 'B2B' ? 'B2B' : 'CORE',
        active: b.active === 'on',
        note: str(b, 'note'),
        expectedVersion: v ? Number(v) : null,
      },
      c.get('actor'),
    );
    return back(c, '/transfer/lastschriften', { ok: 'Mandat gespeichert.' });
  });

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
