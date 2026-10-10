import { randomUUID } from 'node:crypto';
import type { Child } from 'hono/jsx';
import { isMailRedirected } from '../config/env.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import {
  buildSignature,
  composeMail,
  loadSignature,
  loadSignatureSettings,
  type SignatureSettings,
} from '../mail/compose.js';
import { MAILER_MISSING, resolveRecipients } from '../mail/mailer.js';
import { sendInvoiceTestMail } from '../services/workflow.js';
import { storedChecks, watch } from '../services/watchdog.js';
import { replicaSummary, replicate, s3FromEnv } from '../services/archive-replica.js';
import { collectReminders, getReminderSettings, saveReminderSettings } from '../services/reminders.js';
import type { Ctx } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';

/** Erinnerungen: alle Fristen an einer Stelle + tägliche Sammel-Mail (Einstellungen → Erinnerungen). */
export function registerReminderRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  app.get('/erinnerungen', async (c) => {
    const [list, s] = await Promise.all([collectReminders(sql), getReminderSettings(sql)]);
    const areas = [...new Set(list.map((r) => r.area))];
    return page(
      c,
      'Erinnerungen',
      'home',
      <>
        <PageHead title="Erinnerungen">
          <a class="btn sec" href="/einstellungen/erinnerungen" style="margin-left:auto">
            Tägliche E-Mail {s.enabled ? 'an' : 'aus'}
          </a>
        </PageHead>
        <p class="small mut" style="margin-top:0">
          {list.filter((r) => r.level === 'rot').length} dringend · {list.length} gesamt · Stand{' '}
          {todayBerlin().split('-').reverse().join('.')}
        </p>
        {list.length === 0 && <div class="empty">Keine offenen Fristen – alles erledigt.</div>}
        {areas.map((a) => (
          <div class="card">
            <h3 style="margin-top:0">{a}</h3>
            <ul class="list" style="margin:0">
              {list
                .filter((r) => r.area === a)
                .map((r) => (
                  <li style="display:flex;gap:10px;align-items:center">
                    <span class={`badge ${r.level === 'rot' ? 'err' : 'warn'}`}>
                      {r.level === 'rot' ? 'dringend' : 'bald'}
                    </span>
                    <a href={r.href}>{r.text}</a>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </>,
    );
  });

  // Systemwächter: Stand aller Prüfungen, „jetzt prüfen“, Hinweis auf den externen Wächter
  app.get('/einstellungen/system', async (c) => {
    const rows = await storedChecks(sql);
    const fmt = (t: string) =>
      new Date(t).toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        dateStyle: 'short',
        timeStyle: 'short',
      });
    const base = (deps.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, '');
    return page(
      c,
      'Systemzustand',
      'einstellungen',
      <>
        <PageHead title="Systemzustand & Ausfallmeldung" crumbs={[['Einstellungen', '/einstellungen']]}>
          <form method="post" action="/einstellungen/system" style="margin-left:auto">
            <button class="btn sec">Jetzt prüfen</button>
          </form>
        </PageHead>
        <div class="card">
          {rows.length === 0 && (
            <div class="empty">Noch nicht geprüft – „Jetzt prüfen“ oder 5 Minuten warten.</div>
          )}
          {rows.length > 0 && (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Prüfung</th>
                    <th>Zustand</th>
                    <th>Einzelheiten</th>
                    <th>seit</th>
                    <th>geprüft</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr>
                      <td>{r.label}</td>
                      <td>
                        <span class={`badge ${r.ok ? 'ok' : r.level === 'rot' ? 'err' : 'warn'}`}>
                          {r.ok ? 'in Ordnung' : r.level === 'rot' ? 'Störung' : 'Hinweis'}
                        </span>
                      </td>
                      <td>{r.detail}</td>
                      <td class="nowrap">{fmt(r.since)}</td>
                      <td class="nowrap">{fmt(r.checked_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p class="small mut">
            Geprüft wird alle 5 Minuten. Bei einer Störung geht eine E-Mail an{' '}
            {deps.env.ALERT_EMAIL ??
              'die Empfänger unter „Erinnerungen per E-Mail“ (sonst die Firmen-E-Mail)'}{' '}
            – höchstens einmal am Tag je Störung, bei Behebung eine Entwarnung.
          </p>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Wenn der ganze Server ausfällt</h3>
          <p>
            Ein ausgefallener Server kann sich nicht selbst melden. Dafür einmal einen kostenlosen externen
            Wächter einrichten (z. B. UptimeRobot), der alle 5 Minuten diese Adresse aufruft:
          </p>
          <p>
            <code>{base}/health/voll</code>
          </p>
          <p class="small mut">
            Antwortet sie nicht mit „ok“, meldet der Wächter per E-Mail/App. Anleitung:
            docs/anleitung-ueberwachung.pdf.
          </p>
        </div>
      </>,
    );
  });

  app.post('/einstellungen/system', async (c) => {
    await watch(deps);
    return back(c, '/einstellungen/system', { ok: 'Geprüft.' });
  });

  // Revisionssichere Archiv-Kopie: Stand, Fehler, „jetzt sichern“
  app.get('/einstellungen/archiv', async (c) => {
    const e = deps.env;
    const client = s3FromEnv(e);
    let lock: string;
    try {
      lock = client ? (await client.lockStatus()).detail : '–';
    } catch (err) {
      lock = `nicht erreichbar (${err instanceof Error ? err.message : String(err)})`;
    }
    const s = await replicaSummary(sql, e);
    const fmt = (d: Date | null) =>
      d
        ? d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })
        : '–';
    const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
    return page(
      c,
      'Revisionssicheres Archiv',
      'einstellungen',
      <>
        <PageHead
          title="Revisionssicheres Archiv (S3 Object Lock)"
          crumbs={[['Einstellungen', '/einstellungen']]}
        >
          {client && (
            <form method="post" action="/einstellungen/archiv" style="margin-left:auto">
              <button class="btn sec">Jetzt sichern</button>
            </form>
          )}
        </PageHead>
        {!client && (
          <div class="flash warn">
            <span>
              Noch nicht eingerichtet. Auf dem Server in <code>.env.live</code> S3_ENDPOINT, S3_REGION,
              S3_BUCKET, S3_ACCESS_KEY und S3_SECRET_KEY eintragen (Anleitung docs/anleitung-archiv.pdf). Bis
              dahin liegen die Belege nur write-once auf dem Server und in der Sicherung.
            </span>
          </div>
        )}
        <div class="card">
          <dl class="kv">
            <dt>Speicher</dt>
            <dd>{client ? `${e.S3_ENDPOINT} · Bucket ${e.S3_BUCKET} · Region ${e.S3_REGION}` : '–'}</dd>
            <dt>Object Lock im Bucket</dt>
            <dd>{lock}</dd>
            <dt>Gesperrt gesichert</dt>
            <dd>
              {s.ok} Datei(en), {mb(s.bytes)} · zuletzt {fmt(s.last)}
            </dd>
            <dt>Noch ohne Kopie</dt>
            <dd>
              {s.open} Datei(en){s.oldest ? ` · älteste vom ${fmt(s.oldest)}` : ''}
            </dd>
            <dt>Mit Fehler</dt>
            <dd>{s.fehler}</dd>
          </dl>
          <p class="small mut">
            Kopiert wird alle 10 Minuten: das ganze Belegarchiv (Rechnungen, E-Rechnungen, Storno, Mahnungen,
            Kasse, Kontoauszüge, Arbeitsscheine, unterschriebene Dokumente) und Belege aus dem
            Rechnungseingang, Rechnungsanhänge und Lohnabrechnungen. Sperre im Compliance-Modus bis 31.12. des
            10. Folgejahres – in dieser Zeit kann niemand die Kopie löschen oder ändern, auch wir nicht.
          </p>
        </div>
        {s.errors.length > 0 && (
          <div class="card">
            <h3 style="margin-top:0">Fehler (werden alle 30 Min. wiederholt)</h3>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Datei</th>
                    <th>Versuche</th>
                    <th>Fehler</th>
                    <th>zuletzt</th>
                  </tr>
                </thead>
                <tbody>
                  {s.errors.map((r) => (
                    <tr>
                      <td>{r.key}</td>
                      <td>{r.attempts}</td>
                      <td>{r.last_error}</td>
                      <td class="nowrap">{fmt(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </>,
    );
  });

  app.post('/einstellungen/archiv', async (c) => {
    const r = await replicate(deps);
    return back(c, '/einstellungen/archiv', {
      [r.failed || r.skipped ? 'fehler' : 'ok']: r.skipped
        ? `Nicht gesichert: ${r.skipped}`
        : `${r.copied} Datei(en) gesichert, ${r.failed} Fehler, ${r.pending} noch offen.`,
    });
  });

  // E-Mail-Versand prüfen (Ahmed 09.10.: „wie kann ich es testen“) – zeigt den Stand ohne Passwort, sendet eine Test-Mail
  app.get('/einstellungen/email', async (c) => {
    const e = deps.env;
    const { company, settings: sg } = await loadSignatureSettings(sql);
    const sig = buildSignature(company, sg);
    const [lastInv] = await sql<{ number: string }[]>`
      select number from app.invoices where status = 'issued' order by issued_at desc nulls last limit 1`;
    const preview = composeMail({
      body: 'Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere Rechnung 1038316 vom 09.10.2026.\n\nBetrag: 1.234,56 €, zahlbar bis 23.10.2026.',
      signature: sig,
    }).html!.replace(/cid:([^"]+)/g, (m, cid: string) => {
      const im = sig.inline.find((i) => i.cid === cid);
      return im ? `data:${im.contentType};base64,${Buffer.from(im.content).toString('base64')}` : m;
    });
    const redirected = isMailRedirected(e);
    const row = (k: string, v: Child) => (
      <>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </>
    );
    return page(
      c,
      'E-Mail-Versand',
      'einstellungen',
      <>
        <PageHead title="E-Mail-Versand prüfen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <div class="card">
          <dl class="kv">
            {row(
              'Mail-Zugang (SMTP)',
              deps.mailer.configured === false ? (
                <span class="badge err">fehlt – in .env.live eintragen</span>
              ) : (
                <span class="badge ok">eingetragen</span>
              ),
            )}
            {row('Server', e.SMTP_HOST ? `${e.SMTP_HOST}:${e.SMTP_PORT}` : '–')}
            {row('Benutzer', e.SMTP_USER ?? '–')}
            {row('Passwort', e.SMTP_PASS ? 'hinterlegt (wird nicht angezeigt)' : '–')}
            {row('Absender', e.MAIL_FROM)}
            {row('Betrieb', e.APP_ENV === 'live' ? 'live' : `${e.APP_ENV} (Testbetrieb)`)}
            {row(
              'Empfänger',
              redirected ? (
                <span class="badge warn">
                  Alle Mails gehen nur an die Testadresse {e.MAIL_TEST_RECIPIENT ?? '(fehlt)'}
                </span>
              ) : (
                <span class="badge ok">echte Empfänger (Kunden bekommen Rechnungen)</span>
              ),
            )}
          </dl>
        </div>
        <form method="post" action="/einstellungen/email" class="card">
          <h3 style="margin-top:0">Test-E-Mail senden</h3>
          <div class="grid">
            <div>
              <label for="to">an</label>
              <input id="to" name="to" type="email" required value={e.MAIL_TEST_RECIPIENT ?? ''} />
            </div>
            <div>
              <label for="art">Inhalt</label>
              <select id="art" name="art">
                <option value="rechnung">wie an Kunden: Rechnung mit Anhängen und Signatur</option>
                <option value="einfach">nur kurzer Verbindungstest</option>
              </select>
            </div>
            <div>
              <label for="nr">Rechnungsnummer (leer = zuletzt ausgestellte)</label>
              <input id="nr" name="nr" placeholder={lastInv?.number ?? 'noch keine ausgestellt'} />
            </div>
          </div>
          <p class="small mut">
            {redirected
              ? `Im Testbetrieb geht auch diese Mail an ${e.MAIL_TEST_RECIPIENT ?? 'die Testadresse'}.`
              : 'Geht nur an die eingetragene Adresse – nie an den Kunden.'}{' '}
            „Wie an Kunden“ schickt Betreff, Text, Signatur und Anhänge (PDF/ZUGFeRD/XRechnung je
            Rechnungsformat) genau so, wie der Kunde sie bekommt; die Rechnung gilt dadurch nicht als
            versendet. Fehlermeldung „Invalid login“ = Benutzer/Passwort falsch, „timeout“ = Server/Port
            falsch.
          </p>
          <div class="formfoot">
            <button class="btn">Test-E-Mail senden</button>
          </div>
        </form>
        <form method="post" action="/einstellungen/email/signatur" class="card">
          <h3 style="margin-top:0">E-Mail-Signatur</h3>
          <p class="small mut" style="margin-top:0">
            Steht unter jeder Mail an Kunden (Rechnungen, Mahnungen) – mit Logo und Siegeln, wie die
            Outlook-Signatur. Pflichtangaben einer GmbH (§ 35a GmbHG: Rechtsform, Sitz, Registergericht + HRB,
            alle Geschäftsführer) stehen immer in der Fußzeile.
          </p>
          <h4>Person (oben in der Signatur)</h4>
          <div class="grid">
            <div>
              <label for="person_name">Name</label>
              <input id="person_name" name="person_name" value={sg.person_name} />
            </div>
            <div>
              <label for="person_title">Funktion</label>
              <input id="person_title" name="person_title" value={sg.person_title} />
            </div>
            <div>
              <label for="person_mobile">Mobil</label>
              <input id="person_mobile" name="person_mobile" value={sg.person_mobile} />
            </div>
            <div>
              <label for="person_email">E-Mail</label>
              <input id="person_email" name="person_email" value={sg.person_email} />
            </div>
          </div>
          <h4>Niederlassung (leer = keine)</h4>
          <div class="grid">
            <div>
              <label for="branch_title">Bezeichnung</label>
              <input id="branch_title" name="branch_title" value={sg.branch_title} />
            </div>
            <div>
              <label for="branch_address">Anschrift</label>
              <input id="branch_address" name="branch_address" value={sg.branch_address} />
            </div>
            <div>
              <label for="branch_email">E-Mail</label>
              <input id="branch_email" name="branch_email" value={sg.branch_email} />
            </div>
          </div>
          <h4>Weiteres</h4>
          <label>
            <input type="checkbox" name="show_badges" checked={sg.show_badges} /> Siegel „Zertifiziert &amp;
            Mitglied“
          </label>
          <label>
            <input type="checkbox" name="eco_note" checked={sg.eco_note} /> Umwelt-Hinweis
          </label>
          <label>
            <input type="checkbox" name="disclaimer" checked={sg.disclaimer} /> Vertraulichkeitshinweis
            (deutsch/englisch)
          </label>
          <p class="small mut">
            Zentrale (Anschrift, Telefon, E-Mail, Web) und die Pflichtangaben unten kommen aus Einstellungen →
            Firmendaten.
          </p>
          <div class="formfoot">
            <button class="btn">Signatur speichern</button>
          </div>
        </form>
        <div class="card">
          <h3 style="margin-top:0">Vorschau (so sieht der Kunde die Mail)</h3>
          <iframe
            title="Vorschau"
            srcdoc={preview}
            sandbox=""
            style="width:100%;height:420px;border:1px solid var(--line,#ddd);border-radius:6px;background:#fff"
          ></iframe>
        </div>
      </>,
    );
  });

  app.post('/einstellungen/email', async (c) => {
    const body = (await c.req.parseBody()) as Record<string, string>;
    const to = str(body, 'to') ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
      return back(c, '/einstellungen/email', { fehler: 'Bitte E-Mail-Adresse angeben' });
    if (deps.mailer.configured === false) return back(c, '/einstellungen/email', { fehler: MAILER_MISSING });
    try {
      const { actual } = isMailRedirected(deps.env) ? resolveRecipients(deps.env, [to]) : { actual: [to] };
      if (str(body, 'art') !== 'einfach') {
        const nr = (str(body, 'nr') ?? '').replace(/\s+/g, '');
        const [inv] = await sql<{ id: string; number: string }[]>`
          select id, number from app.invoices where status = 'issued'
             and ${nr ? sql`replace(number, ' ', '') = ${nr}` : sql`true`}
           order by issued_at desc nulls last limit 1`;
        if (!inv)
          return back(c, '/einstellungen/email', {
            fehler: nr
              ? `Ausgestellte Rechnung ${nr} nicht gefunden`
              : 'Noch keine ausgestellte Rechnung vorhanden',
          });
        const r = await sendInvoiceTestMail(deps, inv.id, actual[0]!, c.get('actor'));
        return back(c, '/einstellungen/email', {
          ok: `Test-E-Mail mit Rechnung ${inv.number} (${r.files.join(', ')}) an ${actual.join(', ')} gesendet – bitte Postfach prüfen. Beim echten Versand ginge sie an: ${r.intended.join(', ') || '(keine Rechnungs-E-Mail hinterlegt)'}.`,
        });
      }
      await deps.mailer.send({
        from: deps.env.MAIL_FROM,
        to: actual,
        subject: 'Test-E-Mail aus der Viva-Deluxe-App',
        ...composeMail({
          body: `Diese Test-E-Mail wurde am ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} aus der App gesendet.\nDer E-Mail-Versand funktioniert.\n\nGewünschter Empfänger: ${to}`,
          signature: await loadSignature(sql),
        }),
        attachments: [],
        messageId: `<test-${randomUUID()}@viva-deluxe-reinigung.de>`,
      });
      return back(c, '/einstellungen/email', {
        ok: `Test-E-Mail an ${actual.join(', ')} gesendet – bitte Postfach prüfen.`,
      });
    } catch (err) {
      return back(c, '/einstellungen/email', {
        fehler: `Versand fehlgeschlagen: ${(err as Error).message}`,
      });
    }
  });

  app.post('/einstellungen/email/signatur', async (c) => {
    const b = (await c.req.parseBody()) as Record<string, string>;
    const t = (k: string) => (str(b, k) ?? '').trim().slice(0, 200);
    const sg: SignatureSettings = {
      person_name: t('person_name'),
      person_title: t('person_title'),
      person_mobile: t('person_mobile'),
      person_email: t('person_email'),
      branch_title: t('branch_title'),
      branch_address: t('branch_address'),
      branch_email: t('branch_email'),
      show_badges: b.show_badges === 'on',
      eco_note: b.eco_note === 'on',
      disclaimer: b.disclaimer === 'on',
    };
    for (const e of [sg.person_email, sg.branch_email])
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
        return back(c, '/einstellungen/email', { fehler: `E-Mail-Adresse „${e}“ ungültig` });
    await sql`update app.company set mail_signature = ${JSON.stringify(sg)}, updated_at = now() where id = 1`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${c.get('actor')}, 'mail_signature', 'company', '1', ${sql.json({ ...sg })})`;
    return back(c, '/einstellungen/email', { ok: 'Signatur gespeichert' });
  });

  app.get('/einstellungen/erinnerungen', async (c) => {
    const s = await getReminderSettings(sql);
    return page(
      c,
      'Erinnerungen',
      'einstellungen',
      <>
        <PageHead title="Erinnerungen per E-Mail" crumbs={[['Einstellungen', '/einstellungen']]} />
        <form method="post" action="/einstellungen/erinnerungen" class="card">
          <p class="small mut" style="margin-top:0">
            Einmal täglich eine Sammel-Mail mit allen Fristen: Aufenthaltstitel/Arbeitserlaubnis (60 Tage),
            Nachunternehmer-Nachweise, HU/Inspektion (30 Tage), Ausschreibungen (7 Tage), Eigen-Compliance,
            fällige Aufgaben, Skonto im Rechnungseingang (3 Tage) und Einsätze von gestern ohne erfasste Zeit.
            Ohne Fristen keine Mail. Im Testbetrieb geht die Mail nur an die Testadresse.
          </p>
          <div class="grid">
            <div class="chk">
              <input type="checkbox" id="enabled" name="enabled" checked={s.enabled} />
              <label for="enabled">Tägliche Erinnerung senden</label>
            </div>
            <div>
              <label for="emails">an (mehrere mit Komma)</label>
              <input
                id="emails"
                name="emails"
                value={s.emails.join(', ')}
                placeholder="buchhaltung@viva-deluxe-reinigung.de"
              />
            </div>
            <div>
              <label for="hour">ab Uhrzeit</label>
              <select id="hour" name="hour">
                {[5, 6, 7, 8, 9, 10, 12, 14, 16].map((h) => (
                  <option value={String(h)} selected={h === s.send_hour}>
                    {String(h).padStart(2, '0')}:00 Uhr
                  </option>
                ))}
              </select>
            </div>
          </div>
          {s.last_sent && (
            <p class="small mut">Zuletzt gesendet: {s.last_sent.split('-').reverse().join('.')}</p>
          )}
          <div class="actions form-foot">
            <button class="btn">Speichern</button>
            <a class="btn sec" href="/erinnerungen">
              Erinnerungen ansehen
            </a>
          </div>
        </form>
      </>,
    );
  });

  app.post('/einstellungen/erinnerungen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    await saveReminderSettings(
      sql,
      {
        enabled: str(b, 'enabled') != null,
        emails: (str(b, 'emails') ?? '')
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        sendHour: Number(str(b, 'hour') ?? 7),
      },
      c.get('actor'),
    );
    return back(c, '/einstellungen/erinnerungen', { ok: 'Gespeichert.' });
  });
}
