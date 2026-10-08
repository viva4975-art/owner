import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { parseEuro } from '../domain/money/money.js';
import {
  MIN_GAP_DAYS,
  batchCandidates,
  createDunningBatch,
  createDunning,
  getDunning,
  getSettings,
  listDunnings,
  proposals,
  saveSettings,
  sendDunning,
  previewDunnings,
} from '../services/dunning.js';
import { BusinessError } from '../services/errors.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { arr, centsToInput } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';

const LEVEL_CLASS = ['', 'info', 'warn', 'err'];

export function registerDunningRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  const shell = async (c: Context<AppEnv>, active: string, title: string, body: Child) => {
    const [{ proposals: p }, list] = await Promise.all([proposals(sql), listDunnings(sql)]);
    const tabs: Tab[] = [
      { key: 'vorschlag', label: 'Mahnvorschläge', href: '/mahnungen', count: p.length },
      { key: 'stapel', label: 'Stapelverarbeitung', href: '/mahnungen/stapel' },
      { key: 'liste', label: 'Erstellte Mahnungen', href: '/mahnungen/liste', count: list.length },
      { key: 'einstellungen', label: 'Mahnstufen & Texte', href: '/mahnungen/einstellungen' },
    ];
    return page(
      c,
      title,
      'rechnungen',
      <>
        <PageHead
          title="Mahnwesen"
          crumbs={[
            ['Rechnungen', '/rechnungen'],
            ['Offene Posten', '/offene-posten'],
          ]}
        />
        <Tabs tabs={tabs} active={active} />
        {body}
      </>,
    );
  };

  app.get('/mahnungen', async (c) => {
    const [{ proposals: list, blocked }, settings] = await Promise.all([proposals(sql), getSettings(sql)]);
    const title = (l: number) => settings.find((s) => s.level === l)?.title ?? `Stufe ${l}`;
    return shell(
      c,
      'vorschlag',
      'Mahnvorschläge',
      <>
        <p class="mut" style="margin-top:0">
          Überfällige offene Posten nach Mahnstufen (
          {settings.map((s) => `${s.title} ab ${s.min_days_overdue} Tagen`).join(', ')}). Zwischen zwei
          Mahnungen zur selben Rechnung liegen mindestens {MIN_GAP_DAYS} Tage. Kunden mit Mahnsperre
          erscheinen nicht.
        </p>
        {list.length === 0 && <div class="empty">Keine Mahnvorschläge – alles im grünen Bereich.</div>}
        {list.map((p) => (
          <form method="post" action="/mahnungen" class="card">
            <input type="hidden" name="id" value={randomUUID()} />
            <input type="hidden" name="customer_id" value={p.customer_id} />
            <div class="actions" style="margin-top:0">
              <h3 style="margin:0">
                <a href={`/kunden/${p.customer_id}`}>{p.customer_name}</a>{' '}
                <span class="mut small">{p.customer_no}</span>
              </h3>
              <span class={`badge ${LEVEL_CLASS[p.level]}`}>{title(p.level)}</span>
              <span style="margin-left:auto" class="sum">
                {euro(p.open_cents)}
              </span>
            </div>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th style="width:36px"></th>
                    <th>Rechnung</th>
                    <th>fällig am</th>
                    <th class="r">Tage überfällig</th>
                    <th>Bisher</th>
                    <th class="r">offen</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((i) => (
                    <tr>
                      <td>
                        <input
                          type="checkbox"
                          name="invoice"
                          value={i.invoice_id}
                          checked
                          aria-label={`Rechnung ${i.number} mahnen`}
                        />
                      </td>
                      <td>
                        <a href={`/rechnungen/${i.invoice_id}`}>{i.number}</a>
                        <div class="small mut">vom {dateDe(i.issue_date)}</div>
                      </td>
                      <td>{dateDe(i.due_date)}</td>
                      <td class="r">{i.overdue_days}</td>
                      <td class="small">
                        {i.last_level ? `${title(i.last_level)} am ${dateDe(i.last_dunning_date)}` : '–'}
                      </td>
                      <td class="r">{euro(i.open_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="actions" style="margin-bottom:0;justify-content:flex-end">
              <a class="btn sec" href={`/kunden/${p.customer_id}/offene-posten`}>
                Offene Posten
              </a>
              <button class="btn">
                <Icon name="file" /> {title(p.level)} erstellen
              </button>
            </div>
          </form>
        ))}
        {blocked.length > 0 && (
          <div class="card">
            <h3>Mahnsperre gesetzt</h3>
            {blocked.map((b) => (
              <div class="small">
                <a href={`/kunden/${b.customer_id}/bearbeiten`}>{b.customer_name}</a> – {euro(b.open_cents)}{' '}
                überfällig
              </div>
            ))}
          </div>
        )}
      </>,
    );
  });

  // Stapelverarbeitung wie Fortytools: alle überfälligen Rechnungen, Auswahl je Kunde/Rechnung, ein Lauf
  app.get('/mahnungen/stapel', async (c) => {
    const [customers, settings] = await Promise.all([batchCandidates(sql), getSettings(sql)]);
    const title = (l: number) => settings.find((s) => s.level === l)?.title ?? `Stufe ${l}`;
    const eligibleCount = customers.reduce((a, cu) => a + cu.items.filter((i) => i.eligible).length, 0);
    return shell(
      c,
      'stapel',
      'Mahnwesen – Stapelverarbeitung',
      <>
        <p class="mut" style="margin-top:0">
          Alle überfälligen Rechnungen je Kunde. Vorausgewählt ist, was die nächste Mahnstufe erreicht hat;
          grau = noch nicht mahnbar (Grund steht daneben). Je ausgewähltem Kunden entsteht eine Mahnung mit
          allen markierten Rechnungen.
        </p>
        {customers.length === 0 && <div class="empty">Keine überfälligen Rechnungen.</div>}
        {customers.length > 0 && (
          <form method="post" action="/mahnungen/stapel" id="batch">
            <div class="card flush">
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th style="width:36px">
                        <input type="checkbox" id="all" aria-label="alle auswählen" />
                      </th>
                      <th>Empfänger / Rechnung</th>
                      <th>Rechnungsdatum</th>
                      <th>Fällig</th>
                      <th class="r">Überfällig</th>
                      <th class="r">Bisherige Mahnungen</th>
                      <th>Nächste Stufe</th>
                      <th class="r">Offen brutto</th>
                    </tr>
                  </thead>
                  {customers.map((cu) => {
                    const any = cu.items.some((i) => i.eligible);
                    return (
                      <tbody class="grp" data-c={cu.customer_id}>
                        <tr style="background:var(--bg)">
                          <td>
                            {any && (
                              <input
                                type="checkbox"
                                class="cu"
                                checked
                                aria-label={`${cu.customer_name} auswählen`}
                              />
                            )}
                            <input type="hidden" name={`id_${cu.customer_id}`} value={randomUUID()} />
                          </td>
                          <td colspan={6}>
                            <b>
                              {cu.customer_no}{' '}
                              <a href={`/kunden/${cu.customer_id}/offene-posten`}>{cu.customer_name}</a>
                            </b>
                            {cu.dunning_block && (
                              <>
                                {' '}
                                <span class="badge err">Mahnsperre</span>
                              </>
                            )}
                          </td>
                          <td class="r">
                            <b>{euro(cu.open_cents)}</b>
                          </td>
                        </tr>
                        {cu.items.map((i) => (
                          <tr style={i.eligible ? '' : 'opacity:.55'}>
                            <td>
                              <input
                                type="checkbox"
                                name={`inv_${cu.customer_id}`}
                                value={i.invoice_id}
                                checked={i.eligible}
                                disabled={!i.eligible}
                                aria-label={`Rechnung ${i.number}`}
                              />
                            </td>
                            <td>
                              <a href={`/rechnungen/${i.invoice_id}`}>Re {i.number}</a>
                              {i.reason && <div class="small mut">{i.reason}</div>}
                            </td>
                            <td>{dateDe(i.issue_date)}</td>
                            <td>{dateDe(i.due_date)}</td>
                            <td class="r" style="color:var(--err);font-weight:600">
                              {i.overdue_days}
                            </td>
                            <td class="r">{i.dunning_count}</td>
                            <td>
                              {i.last_level >= 3 ? (
                                '–'
                              ) : (
                                <span class={`badge ${LEVEL_CLASS[i.next_level]}`}>
                                  {title(i.next_level)}
                                </span>
                              )}
                            </td>
                            <td class="r">{euro(i.open_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    );
                  })}
                </table>
              </div>
            </div>
            <div class="card actions" style="justify-content:flex-end">
              <label class="chk" style="margin:0 auto 0 0">
                <input type="checkbox" name="send" value="1" /> gleich per E-Mail an die Rechnungsadressen
                senden
              </label>
              <button
                class="btn sec"
                disabled={eligibleCount === 0}
                formaction="/mahnungen/stapel/vorschau"
                formtarget="_blank"
              >
                Vorschau als PDF (Entwurf)
              </button>
              <button class="btn" disabled={eligibleCount === 0}>
                <Icon name="file" /> Mahnungen erstellen
              </button>
            </div>
            <script
              dangerouslySetInnerHTML={{
                __html: `(function(){
  var f=document.getElementById('batch');
  function sync(){f.querySelectorAll('tbody.grp').forEach(function(g){var cu=g.querySelector('.cu');if(!cu)return;var b=g.querySelectorAll('input[name^=inv_]:not(:disabled)');var n=0;b.forEach(function(x){if(x.checked)n++});cu.checked=n>0;cu.indeterminate=n>0&&n<b.length;});var a=f.querySelectorAll('input[name^=inv_]:not(:disabled)'),k=0;a.forEach(function(x){if(x.checked)k++});var al=document.getElementById('all');if(al){al.checked=a.length>0&&k===a.length;al.indeterminate=k>0&&k<a.length;}}
  f.addEventListener('change',function(e){var t=e.target;
    if(t.id==='all'){f.querySelectorAll('input[name^=inv_]:not(:disabled)').forEach(function(x){x.checked=t.checked});}
    else if(t.classList.contains('cu')){t.closest('tbody').querySelectorAll('input[name^=inv_]:not(:disabled)').forEach(function(x){x.checked=t.checked});}
    sync();});
  sync();
})();`,
              }}
            />
          </form>
        )}
      </>,
    );
  });

  // Vorschau aller markierten Mahnungen als ein PDF (nichts wird angelegt)
  app.post('/mahnungen/stapel/vorschau', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const entries = Object.keys(body)
      .filter((k) => /^inv_[0-9a-f-]{36}$/.test(k))
      .map((k) => ({
        customerId: k.slice(4),
        invoiceIds: arr(body, k).filter((x) => /^[0-9a-f-]{36}$/.test(x)),
      }));
    if (!entries.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
    const pdf = await previewDunnings(sql, entries);
    return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="Mahnungen_Entwurf.pdf"',
    });
  });

  app.post('/mahnungen/stapel', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const entries = Object.keys(body)
      .filter((k) => /^inv_[0-9a-f-]{36}$/.test(k))
      .map((k) => {
        const customerId = k.slice(4);
        const id = body[`id_${customerId}`];
        return {
          id: typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : randomUUID(),
          customerId,
          invoiceIds: arr(body, k).filter((x) => /^[0-9a-f-]{36}$/.test(x)),
        };
      });
    if (!entries.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
    const r = await createDunningBatch(deps, entries, body.send === '1', c.get('actor'));
    const msg = [
      `${r.created.length} Mahnung(en) erstellt${body.send === '1' ? ' und versendet' : ''}: ${r.created
        .map((x) => `${x.number} (${x.customer})`)
        .join(', ')}`,
      ...r.failed.map((f) => `Nicht erstellt – ${f.customer}: ${f.error}`),
    ].join('\n');
    return back(c, '/mahnungen/liste', r.failed.length && !r.created.length ? { fehler: msg } : { ok: msg });
  });

  app.post('/mahnungen', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : randomUUID();
    const customerId = typeof body.customer_id === 'string' ? body.customer_id : '';
    await createDunning(deps, id, customerId, arr(body, 'invoice'), c.get('actor'));
    return back(c, `/mahnungen/${id}`, { ok: 'Mahnung erstellt. Bitte PDF prüfen und versenden.' });
  });

  app.get('/mahnungen/liste', async (c) => {
    const list = await listDunnings(sql);
    return shell(
      c,
      'liste',
      'Mahnungen',
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Nr.</th>
              <th>Stufe</th>
              <th>Kunde</th>
              <th>Datum</th>
              <th>Zahlbar bis</th>
              <th class="r">Rechnungen</th>
              <th class="r">Betrag</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colspan={8}>
                  <div class="empty">Noch keine Mahnungen.</div>
                </td>
              </tr>
            )}
            {list.map((d) => (
              <tr>
                <td>
                  <a href={`/mahnungen/${d.id}`}>
                    <b>{d.number}</b>
                  </a>
                </td>
                <td>
                  <span class={`badge ${LEVEL_CLASS[d.level]}`}>{d.title}</span>
                </td>
                <td>
                  <a href={`/kunden/${d.customer_id}`}>{d.customer_name}</a>
                </td>
                <td>{dateDe(d.issue_date)}</td>
                <td>{dateDe(d.pay_until)}</td>
                <td class="r">{d.items}</td>
                <td class="r">{euro(d.total_cents)}</td>
                <td>
                  {d.status === 'versendet' ? (
                    <span class="badge sent">Versendet</span>
                  ) : (
                    <span class="badge draft">Erstellt</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
  });

  app.get(`/mahnungen/:id{${UUID}}`, async (c) => {
    const data = await getDunning(sql, c.req.param('id'));
    if (!data) return c.notFound();
    const { dunning: d, items } = data;
    const [cust] = await sql<
      { name: string; invoice_emails: string[] }[]
    >`select name, invoice_emails from app.customers where id = ${d.customer_id}`;
    return page(
      c,
      `${d.title} ${d.number}`,
      'rechnungen',
      <>
        <PageHead
          title={d.title}
          no={d.number}
          crumbs={[
            ['Mahnwesen', '/mahnungen'],
            ['Erstellte Mahnungen', '/mahnungen/liste'],
          ]}
        >
          {d.status === 'versendet' ? (
            <span class="badge sent">Versendet</span>
          ) : (
            <span class="badge draft">Erstellt</span>
          )}
        </PageHead>
        <div class="actions" style="margin-top:-8px">
          <a class="btn sec" href={`/mahnungen/${d.id}/mahnung.pdf`} target="_blank">
            <Icon name="pdf" /> PDF ansehen
          </a>
          {d.status === 'erstellt' && (
            <form
              method="post"
              action={`/mahnungen/${d.id}/versenden`}
              onsubmit="return confirm('Mahnung jetzt per E-Mail versenden?')"
            >
              <button class="btn">
                <Icon name="mail" /> Per E-Mail versenden
              </button>
            </form>
          )}
        </div>
        <div class="cols">
          <div class="card flush">
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Rechnung</th>
                    <th>Rechnungsdatum</th>
                    <th>fällig am</th>
                    <th class="r">Tage überfällig</th>
                    <th class="r">offen</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr>
                      <td>
                        <a href={`/rechnungen/${i.invoice_id}`}>{i.number}</a>
                      </td>
                      <td>{dateDe(i.issue_date)}</td>
                      <td>{dateDe(i.due_date)}</td>
                      <td class="r">{i.days_overdue}</td>
                      <td class="r">{euro(i.open_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <table class="totals" style="margin:8px 0 12px auto">
              <tbody>
                {d.fee_cents > 0n && (
                  <tr>
                    <td>Mahngebühr (ohne USt)</td>
                    <td class="r">{euro(d.fee_cents)}</td>
                  </tr>
                )}
                <tr class="sum">
                  <td>Zu zahlen bis {dateDe(d.pay_until)}</td>
                  <td class="r">{euro(d.total_cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="card">
            <h3>Angaben</h3>
            <dl class="kv">
              <dt>Kunde</dt>
              <dd>
                <a href={`/kunden/${d.customer_id}`}>{cust?.name}</a>
              </dd>
              <dt>Datum</dt>
              <dd>{dateDe(d.issue_date)}</dd>
              <dt>Empfänger</dt>
              <dd>{cust?.invoice_emails.join(', ') || '–'}</dd>
              <dt>Erstellt von</dt>
              <dd>{d.created_by}</dd>
              {d.sent_at && (
                <>
                  <dt>Versendet</dt>
                  <dd>
                    {d.sent_at.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} an{' '}
                    {(d.sent_to ?? []).join(', ')}
                  </dd>
                </>
              )}
              <dt>PDF (SHA-256)</dt>
              <dd class="small" style="word-break:break-all">
                {d.pdf_sha256 ?? '–'}
              </dd>
            </dl>
          </div>
        </div>
      </>,
    );
  });

  app.get(`/mahnungen/:id{${UUID}}/mahnung.pdf`, async (c) => {
    const data = await getDunning(sql, c.req.param('id'));
    if (!data?.dunning.pdf_path) return c.notFound();
    const pdf = await deps.archive.get(data.dunning.pdf_path);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Mahnung_${data.dunning.number}.pdf"`,
        'Cache-Control': 'private, max-age=0',
      },
    });
  });

  app.post(`/mahnungen/:id{${UUID}}/versenden`, async (c) => {
    const id = c.req.param('id');
    const r = await sendDunning(deps, id, c.get('actor'));
    return back(c, `/mahnungen/${id}`, {
      ok: r.alreadySent
        ? 'War bereits versendet – nicht erneut gesendet.'
        : `Versendet an ${r.to.join(', ')}.`,
    });
  });

  app.get('/mahnungen/einstellungen', async (c) => {
    const settings = await getSettings(sql);
    return shell(
      c,
      'einstellungen',
      'Mahnstufen',
      <form
        method="post"
        action="/mahnungen/einstellungen"
        class="card"
        data-autosave="/mahnungen/einstellungen"
      >
        <div class="hint" style="margin-bottom:16px">
          <b>Rechtlicher Hinweis:</b> Mahngebühren sind Schadensersatz und daher ohne Umsatzsteuer. Gerichte
          erkennen meist nur die tatsächlichen Kosten (Porto/Material, ca. 1–3 €) an, die erste
          verzugsbegründende Mahnung gar nicht. Bei Geschäftskunden ist alternativ die Verzugspauschale von 40
          € (§ 288 Abs. 5 BGB) möglich, zuzüglich Verzugszinsen von 9 Prozentpunkten über dem Basiszinssatz.
          Höhe bitte mit dem Steuerberater/Anwalt abstimmen.
          <br />
          <b>Verzugspauschale:</b> 40 € je Rechnung, nur einmal, nicht bei Privatkunden (Kunde → „Privatkunde
          (Verbraucher)“). Sie wird auf die Mahngebühren angerechnet (§ 288 Abs. 5 S. 3 BGB) – enthält eine
          Mahnung die Pauschale (jetzt oder früher), entfällt deren Mahngebühr.
        </div>
        {settings.map((s) => (
          <>
            <h2 style={s.level === 1 ? 'margin-top:0' : ''}>Stufe {s.level}</h2>
            <input type="hidden" name="level" value={String(s.level)} />
            <div class="grid">
              <div>
                <label>Bezeichnung</label>
                <input name="title" value={s.title} required />
              </div>
              <div>
                <label>ab Tagen nach Fälligkeit</label>
                <input
                  name="min_days_overdue"
                  type="number"
                  min="1"
                  value={String(s.min_days_overdue)}
                  required
                />
              </div>
              <div>
                <label>Zahlungsfrist (Tage)</label>
                <input name="payment_days" type="number" min="1" value={String(s.payment_days)} required />
              </div>
              <div>
                <label>Gebühr € (ohne USt)</label>
                <input name="fee" value={centsToInput(s.fee_cents)} />
              </div>
              <div class="chk">
                <input
                  type="checkbox"
                  id={`late_fee_${s.level}`}
                  name={`late_fee_${s.level}`}
                  checked={s.late_fee}
                />
                <label for={`late_fee_${s.level}`}>
                  Verzugspauschale 40 € (§ 288 Abs. 5 BGB) ab dieser Stufe
                </label>
              </div>
            </div>
            <div style="margin-top:10px">
              <label>Text</label>
              <textarea name="text" rows={3}>
                {s.text}
              </textarea>
            </div>
          </>
        ))}
        <div class="formfoot">
          <button class="btn">Speichern</button>
        </div>
      </form>,
    );
  });

  app.post('/mahnungen/einstellungen', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const level = arr(body, 'level');
    const title = arr(body, 'title');
    const days = arr(body, 'min_days_overdue');
    const pay = arr(body, 'payment_days');
    const fee = arr(body, 'fee');
    const text = arr(body, 'text');
    const rows = level.map((l, i) => {
      let fee_cents: bigint;
      try {
        fee_cents = parseEuro(fee[i] || '0');
      } catch {
        throw new BusinessError(`Stufe ${l}: Gebühr „${fee[i]}“ ist ungültig`);
      }
      if (fee_cents < 0n) throw new BusinessError(`Stufe ${l}: Gebühr darf nicht negativ sein`);
      return {
        level: Number(l),
        title: title[i] ?? '',
        fee_cents,
        min_days_overdue: Math.max(1, Number(days[i]) || 1),
        payment_days: Math.max(1, Number(pay[i]) || 1),
        text: text[i] ?? '',
        late_fee: body[`late_fee_${l}`] === 'on',
      };
    });
    await saveSettings(sql, rows, c.get('actor'));
    return back(c, '/mahnungen/einstellungen', { ok: 'Mahnstufen gespeichert.' });
  });
}
