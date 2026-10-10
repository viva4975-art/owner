import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import {
  accountOverview,
  disconnect,
  feedConfigInfo,
  feedStatus,
  fetchAll,
  finishConnect,
  listBanks,
  saveFeedConfig,
  startConnect,
  statement,
  testFeed,
} from '../services/bank-feed.js';
import { BusinessError } from '../services/errors.js';
import { type Ctx, UUID } from './app.js';
import { str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';

/*
 * Bankabruf (Enable Banking): Einrichtung unter Einstellungen (nur Admin), Rückkehr aus dem Bank-Fenster, Abruf,
 * Kontoauszug je Konto mit errechnetem Saldo und Verlauf (wie Fortytools).
 */
const at = (d: Date) =>
  d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
const isDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
const ibanShort = (i: string) => i.replace(/(.{4})/g, '$1 ').trim();
const STATUS: Record<string, string> = {
  angefragt: 'angefragt',
  aktiv: 'aktiv',
  abgelaufen: 'abgelaufen',
  getrennt: 'getrennt',
  fehler: 'Fehler',
};

export function registerBankRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const redirectUrl = (c: { req: { url: string; header: (n: string) => string | undefined } }) => {
    if (env.PUBLIC_URL) return `${env.PUBLIC_URL.replace(/\/$/, '')}/transfer/bank/rueckkehr`;
    const u = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') ?? u.protocol.replace(':', '');
    return `${proto}://${c.req.header('host') ?? u.host}/transfer/bank/rueckkehr`;
  };

  // ---------------------------------------------------------------- Einstellungen → Bankabruf
  app.get('/einstellungen/bankabruf', async (c) => {
    const [cfg, feed] = await Promise.all([feedConfigInfo(sql), feedStatus(sql)]);
    let banks: string[] = [];
    let bankErr: string | null = null;
    if (cfg) {
      try {
        banks = (await listBanks(deps)).map((b) => b.name);
      } catch (e) {
        bankErr = (e as Error).message;
      }
    }
    const pref = ['Münchner Bank', 'Targobank', 'TARGOBANK'];
    const sorted = [
      ...banks.filter((b) => pref.some((p) => b.toLowerCase().includes(p.toLowerCase()))),
      ...banks.filter((b) => !pref.some((p) => b.toLowerCase().includes(p.toLowerCase()))),
    ];
    return page(
      c,
      'Bankabruf',
      'einstellungen',
      <>
        <PageHead title="Bankabruf (Enable Banking)" crumbs={[['Einstellungen', '/einstellungen']]} />
        <div class="card">
          <h3 style="margin-top:0">1. Zugang zu Enable Banking</h3>
          {cfg ? (
            <p>
              <span class="badge ok">eingerichtet</span> Application ID <code>{cfg.app_id}</code> · Schlüssel{' '}
              <code>{cfg.key_fingerprint}</code> · {cfg.updated_by}, {at(cfg.updated_at)}
            </p>
          ) : (
            <p class="mut">Noch nicht eingerichtet.</p>
          )}
          <form method="post" action="/einstellungen/bankabruf" enctype="multipart/form-data">
            <div class="grid">
              <div>
                <label for="app_id">Application ID (aus dem Enable-Banking-Portal, „Applications“)</label>
                <input id="app_id" name="app_id" value={cfg?.app_id ?? ''} required autocomplete="off" />
              </div>
              <div>
                <label for="pem">
                  Privater Schlüssel (.pem-Datei, beim Anlegen der Anwendung heruntergeladen)
                </label>
                <input id="pem" type="file" name="pem" accept=".pem,.key,.txt" required />
              </div>
            </div>
            <p class="small mut">
              Der Schlüssel wird nur auf unserem Server gespeichert (verschlüsselt) und nie wieder angezeigt.
              Nicht per E-Mail oder Chat weitergeben. Nach dem Hochladen die Datei auf dem eigenen Rechner
              sicher aufbewahren oder löschen.
            </p>
            <div class="formfoot">
              <button class="btn">Speichern</button>
            </div>
          </form>
          {cfg && (
            <form method="post" action="/einstellungen/bankabruf/test" style="margin-top:8px">
              <button class="btn sm sec">Verbindung testen</button>
            </form>
          )}
        </div>

        {cfg && (
          <div class="card">
            <h3 style="margin-top:0">2. Bank verbinden</h3>
            <p class="small mut" style="margin-top:0">
              Sie werden zum Online-Banking Ihrer Bank weitergeleitet (Login + TAN). Die Zugangsdaten zur Bank
              sieht weder die App noch Enable Banking. Freigabe gilt bis zu 180 Tage, danach hier neu
              verbinden. Zurück kommen Sie automatisch auf diese Seite.
            </p>
            {bankErr ? (
              <div class="notice err">{bankErr}</div>
            ) : (
              <form
                method="post"
                action="/einstellungen/bankabruf/verbinden"
                class="actions"
                style="align-items:end"
              >
                <div style="flex:1;min-width:260px">
                  <label for="bank">Bank</label>
                  <select id="bank" name="bank" required>
                    <option value="">– Bank wählen –</option>
                    {sorted.map((b) => (
                      <option>{b}</option>
                    ))}
                  </select>
                </div>
                <button class="btn">Bank verbinden →</button>
              </form>
            )}
            <p class="small mut">
              Weiterleitungsadresse (muss im Enable-Banking-Portal eingetragen sein):{' '}
              <code>{redirectUrl(c)}</code>
            </p>
          </div>
        )}

        {feed.connections.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Verbindungen</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Bank</th>
                    <th>Status</th>
                    <th>gültig bis</th>
                    <th>Konten</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {feed.connections.map((x) => {
                    const accs = feed.accounts.filter((a) => a.connection_id === x.id);
                    return (
                      <tr>
                        <td>{x.aspsp_name}</td>
                        <td>
                          <span
                            class={`badge ${x.status === 'aktiv' ? 'ok' : x.status === 'angefragt' ? '' : 'err'}`}
                          >
                            {STATUS[x.status] ?? x.status}
                          </span>
                          {x.error && <div class="small mut">{x.error}</div>}
                        </td>
                        <td>{x.valid_until ? at(x.valid_until) : '–'}</td>
                        <td class="small">
                          {accs.map((a) => (
                            <div>
                              {a.iban ? ibanShort(a.iban) : a.uid}
                              {a.balance_cents != null && <> · {euro(a.balance_cents)}</>}
                              {a.last_fetch_at && <span class="mut"> · abgerufen {at(a.last_fetch_at)}</span>}
                              {a.last_fetch_error && <div class="err">{a.last_fetch_error}</div>}
                            </div>
                          ))}
                        </td>
                        <td>
                          {x.status === 'aktiv' && (
                            <form
                              method="post"
                              action={`/einstellungen/bankabruf/${x.id}/trennen`}
                              style="margin:0"
                            >
                              <button class="btn sm sec" data-confirm="Freigabe für diese Bank beenden?">
                                Trennen
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {feed.accounts.length > 0 && (
              <form method="post" action="/transfer/bank/abrufen" class="actions">
                <button class="btn">⟳ Umsätze jetzt abrufen</button>
                <span class="small mut">
                  Automatisch zwischen 6 und 21 Uhr etwa alle 4½ Stunden (PSD2: höchstens 4 Abrufe je Tag ohne
                  TAN). Beim ersten Abruf werden die letzten 90 Tage geholt.
                </span>
              </form>
            )}
            {feed.accounts.length > 0 && (
              <form method="post" action="/transfer/bank/nachladen" class="actions" style="margin-top:8px">
                <label for="hist-from" class="small">
                  Ältere Umsätze nachladen ab
                </label>
                <input
                  id="hist-from"
                  name="from"
                  type="date"
                  required
                  value={`${todayBerlin().slice(0, 4)}-01-01`}
                  style="max-width:170px"
                />
                <button class="btn sec">Nachladen</button>
                <span class="small mut">
                  Viele Banken geben Umsätze älter als 90 Tage nur in der ersten Stunde nach der TAN-Freigabe
                  heraus – dann vorher „Bank verbinden“ neu ausführen. Sonst: Kontoauszug als CAMT/CSV aus dem
                  Online-Banking einlesen (nichts wird doppelt angelegt).
                </span>
              </form>
            )}
          </div>
        )}
        <div class="card small mut">
          Nur Konten, die unter Firmendaten als eigene Bankverbindung hinterlegt sind, werden abgerufen.
          Datenschutz: Enable Banking ist ein von der Finnischen Finanzaufsicht zugelassener
          Kontoinformationsdienst (PSD2) – im Verzeichnis der Verarbeitungstätigkeiten aufnehmen.
        </div>
      </>,
    );
  });

  app.post('/einstellungen/bankabruf', async (c) => {
    const b = await c.req.parseBody();
    const file = b.pem;
    if (!(file instanceof File) || !file.size) throw new BusinessError('Bitte die .pem-Datei wählen');
    if (file.size > 20_000)
      throw new BusinessError('Datei zu groß – bitte nur die .pem-Datei mit dem Schlüssel');
    const fp = await saveFeedConfig(deps, {
      appId: typeof b.app_id === 'string' ? b.app_id : '',
      pem: await file.text(),
      actor: c.get('actor'),
    });
    return back(c, '/einstellungen/bankabruf', { ok: `Gespeichert (Schlüssel ${fp}).` });
  });

  app.post('/einstellungen/bankabruf/test', async (c) => {
    const r = await testFeed(deps);
    return back(c, '/einstellungen/bankabruf', {
      ok: `Verbindung in Ordnung${r.name ? `: Anwendung „${r.name}“` : ''}${r.environment ? ` (${r.environment})` : ''}${r.active === false ? ' – noch nicht aktiviert' : ''}.`,
    });
  });

  app.post('/einstellungen/bankabruf/verbinden', async (c) => {
    const bank = str(await c.req.parseBody(), 'bank');
    if (!bank) throw new BusinessError('Bitte eine Bank wählen');
    const url = await startConnect(deps, { aspsp: bank, redirectUrl: redirectUrl(c), actor: c.get('actor') });
    if (!/^https:\/\//.test(url)) throw new BusinessError('Unerwartete Adresse von Enable Banking');
    return c.redirect(url, 303);
  });

  app.post(`/einstellungen/bankabruf/:id{${UUID}}/trennen`, async (c) => {
    await disconnect(deps, c.req.param('id'), c.get('actor'));
    return back(c, '/einstellungen/bankabruf', { ok: 'Verbindung getrennt.' });
  });

  // Rückkehr aus dem Bank-Fenster (GET, Code nur einmal verwendbar)
  app.get('/transfer/bank/rueckkehr', async (c) => {
    const state = c.req.query('state') ?? '';
    try {
      const r = await finishConnect(deps, {
        state,
        code: c.req.query('code') ?? null,
        error: c.req.query('error')
          ? `${c.req.query('error')} ${c.req.query('error_description') ?? ''}`.trim()
          : null,
        actor: c.get('actor'),
      });
      if (!r.already) {
        const f = await fetchAll(deps, { actor: c.get('actor') });
        return back(c, '/transfer/kontoumsaetze', {
          ok: `${r.bank} verbunden (${r.accounts} Konto/Konten). ${f.created} neue Umsätze abgerufen.${f.errors.length ? ` Hinweis: ${f.errors.join(' · ')}` : ''}`,
        });
      }
      return back(c, '/einstellungen/bankabruf', { ok: `${r.bank} ist verbunden.` });
    } catch (e) {
      return back(c, '/einstellungen/bankabruf', { fehler: (e as Error).message });
    }
  });

  app.post('/transfer/bank/nachladen', async (c) => {
    const b = await c.req.parseBody();
    const from = typeof b.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.from) ? b.from : null;
    if (!from) throw new BusinessError('Bitte ein Datum wählen');
    if (from > todayBerlin()) throw new BusinessError('Datum liegt in der Zukunft');
    const r = await fetchAll(deps, { actor: c.get('actor'), historyFrom: from });
    const msg = `Ab ${from.split('-').reverse().join('.')}: ${r.accounts} Konto/Konten abgerufen, ${r.created} neue Umsätze.`;
    return back(
      c,
      '/transfer/kontoumsaetze',
      r.errors.length
        ? {
            fehler: `${msg} ${r.errors.join(' · ')} – Ältere Umsätze gibt die Bank oft nur direkt nach einer neuen TAN-Freigabe („Bank verbinden“) heraus; sonst Kontoauszug als CAMT/CSV einlesen.`,
          }
        : { ok: msg },
    );
  });

  app.post('/transfer/bank/abrufen', async (c) => {
    const r = await fetchAll(deps, { actor: c.get('actor') });
    const msg = `${r.accounts} Konto/Konten abgerufen, ${r.created} neue Umsätze.`;
    return back(
      c,
      '/transfer/kontoumsaetze',
      r.errors.length ? { fehler: `${msg} ${r.errors.join(' · ')}` } : { ok: msg },
    );
  });

  // ---------------------------------------------------------------- Kontoauszug
  app.get('/transfer/kontoauszug', async (c) => {
    const accounts = await accountOverview(sql);
    if (!accounts.length) throw new BusinessError('Keine eigenen Bankkonten unter Firmendaten hinterlegt');
    const konto = accounts.find((a) => a.iban === c.req.query('konto'))?.iban ?? accounts[0]!.iban;
    const today = todayBerlin();
    const from = isDate(c.req.query('von')) ? c.req.query('von')! : `${today.slice(0, 7)}-01`;
    const to = isDate(c.req.query('bis'))
      ? c.req.query('bis')!
      : addDays(`${addDays(`${today.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
    const q = c.req.query('q') ?? '';
    const st = await statement(sql, { iban: konto, from, to, q });
    const acc = accounts.find((a) => a.iban === konto)!;
    return page(
      c,
      'Kontoauszug',
      'transfer',
      <>
        <PageHead
          title={`Kontoauszug: ${ibanShort(konto)}`}
          crumbs={[['Kontoumsätze', '/transfer/kontoumsaetze']]}
        />
        <div class="actions">
          {accounts.map((a) => (
            <a
              class={`chip ${a.iban === konto ? 'on' : ''}`}
              href={`/transfer/kontoauszug?konto=${a.iban}&von=${from}&bis=${to}`}
            >
              {a.name} ··{a.iban.slice(-6)}
              {a.balance_cents != null && <> · {euro(a.balance_cents)}</>}
            </a>
          ))}
        </div>
        <div class="card">
          <form method="get" class="actions no-print" style="align-items:end">
            <input type="hidden" name="konto" value={konto} />
            <div>
              <label for="von">von</label>
              <input id="von" type="date" name="von" value={from} />
            </div>
            <div>
              <label for="bis">bis</label>
              <input id="bis" type="date" name="bis" value={to} />
            </div>
            <div style="flex:1;min-width:200px">
              <label for="q">Filtern</label>
              <input id="q" name="q" value={q} placeholder="Name, Verwendungszweck, Betrag" />
            </div>
            <button class="btn">Aktualisieren</button>
            <button type="button" class="btn sec" onclick="window.print()">
              Drucken / PDF
            </button>
          </form>
          <dl class="kv" style="margin-top:12px">
            <dt>{dateDe(from)} errechneter Anfangs-Saldo</dt>
            <dd class="r">
              <b>{st.start != null ? euro(st.start) : '–'}</b>
            </dd>
            <dt>Eingänge / Ausgänge</dt>
            <dd class="r">
              <span style="color:#2e7d32">{euro(st.income)}</span> /{' '}
              <span style="color:#c0392b">{euro(st.outgo)}</span>
            </dd>
            <dt>{dateDe(to)} errechneter End-Saldo</dt>
            <dd class="r">
              <b>{st.end != null ? euro(st.end) : '–'}</b>
            </dd>
          </dl>
          {!st.hasBalance && (
            <p class="small mut">
              Salden erscheinen, sobald das Konto über den Bankabruf verbunden ist (Kontostand der Bank,
              rückwärts über die Umsätze errechnet).
            </p>
          )}
          {acc.balance_at && (
            <p class="small mut">
              Kontostand laut Bank {euro(acc.balance_cents!)} (abgerufen {at(acc.balance_at)}).
            </p>
          )}
          {st.trend.length > 30 && <Trend points={st.trend} />}
        </div>
        <div class="card" style="padding:0">
          {st.rows.map((t) => (
            <div style="display:flex;gap:16px;padding:12px 18px;border-bottom:1px solid var(--line,#e5e5e5)">
              <div style="flex:1;min-width:0">
                <b>{t.counterparty_name ?? '–'}</b>
                {t.counterparty_iban && (
                  <div style="color:#9a9a9a;font-size:12.5px">{ibanShort(t.counterparty_iban)}</div>
                )}
                <div>{dateDe(t.booking_date)}</div>
                <div style="white-space:pre-wrap;word-break:break-word;font-size:13px">{t.purpose}</div>
                {t.status !== 'offen' && t.note && <div class="small mut">→ {t.note}</div>}
              </div>
              <div
                style={`white-space:nowrap;font-weight:600;color:${t.amount_cents < 0n ? '#c0392b' : '#2e7d32'}`}
              >
                {euro(t.amount_cents)}
                {t.status === 'offen' && (
                  <div>
                    <a class="small" href={`/transfer/kontoumsaetze/${t.id}`}>
                      zuordnen
                    </a>
                  </div>
                )}
              </div>
            </div>
          ))}
          {st.rows.length === 0 && (
            <p class="mut" style="padding:14px">
              Keine Umsätze im Zeitraum.
            </p>
          )}
        </div>
      </>,
    );
  });
}

/** Saldo-Verlauf (30-Tage-Durchschnitt) als einfache Linie. */
const Trend = ({ points }: { points: { date: string; avg: bigint }[] }) => {
  const W = 900;
  const H = 180;
  const vals = points.map((p) => Number(p.avg) / 100);
  const min = Math.min(0, ...vals);
  const max = Math.max(...vals, 1);
  const x = (i: number) => (i / (points.length - 1)) * (W - 70) + 60;
  const y = (v: number) => H - 20 - ((v - min) / (max - min || 1)) * (H - 35);
  const path = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [min, (min + max) / 2, max];
  const months = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }, k) => p.date.endsWith('-01') && k % 1 === 0)
    .filter((_, k, a) => a.length <= 7 || k % 2 === 0);
  const fmt = (v: number) => Math.round(v).toLocaleString('de-DE');
  return (
    <figure style="margin:14px 0 0">
      <figcaption class="small" style="font-weight:600">
        Saldo-Verlauf (30-Tage-Durchschnitt)
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} style="width:100%;height:auto" role="img" aria-label="Saldo-Verlauf">
        {ticks.map((t) => (
          <>
            <line x1="60" x2={W - 10} y1={y(t)} y2={y(t)} stroke="#e6e6e6" />
            <text x="54" y={y(t) + 4} text-anchor="end" font-size="11" fill="#777">
              {fmt(t)}
            </text>
          </>
        ))}
        {min < 0 && <line x1="60" x2={W - 10} y1={y(0)} y2={y(0)} stroke="#bbb" />}
        <path d={path} fill="none" stroke="#7D1435" stroke-width="2" />
        {months.map(({ p, i }) => (
          <text x={x(i)} y={H - 4} text-anchor="middle" font-size="11" fill="#777">
            {
              ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'][
                Number(p.date.slice(5, 7)) - 1
              ]
            }{' '}
            {p.date.slice(2, 4)}
          </text>
        ))}
      </svg>
    </figure>
  );
};
