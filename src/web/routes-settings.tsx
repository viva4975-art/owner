import { packageInfo, savePackage } from '../services/site-folder.js';
import { listRanges, raiseRange, rangeLabel } from '../services/number-ranges.js';
import { z } from 'zod';
import { BusinessError } from '../services/errors.js';
import type { Role } from '../services/users.js';
import { type Ctx } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';
import { canOpen } from './permissions.js';

/*
 * Einstellungen: alle Stammlisten und Vorgaben an einer Stelle (Ahmed: „diese Daten separat in den Einstellungen“).
 * Die einzelnen Seiten bleiben, wo sie sind; hier nur der Einstieg, gefiltert nach Rolle.
 */

/** Aufbau wie Fortytools: Gruppen mit Beschreibung je Eintrag, rechts Inhaltsverzeichnis. */
const SECTIONS: { id: string; title: string; items: [string, string, string][] }[] = [
  {
    id: 'meine-daten',
    title: 'Meine Daten',
    items: [['Mein Konto & Passwort', '/konto', 'Eigenes Passwort ändern, Anmeldedaten.']],
  },
  {
    id: 'mandantendaten',
    title: 'Mandantendaten',
    items: [
      [
        'Firmendaten & Bankverbindungen',
        '/einstellungen/firma',
        'Anschrift, Steuernummer, USt-ID, Handelsregister, Kontakt und Bankkonten – erscheinen auf Rechnungen, Mahnungen und in der E-Rechnung.',
      ],
      [
        'E-Mail-Versand prüfen',
        '/einstellungen/email',
        'Zeigt, ob der Mail-Zugang (SMTP) eingerichtet ist und ob Test- oder Echtbetrieb gilt; Test-E-Mail senden.',
      ],
      [
        'Erinnerungen per E-Mail',
        '/einstellungen/erinnerungen',
        'Tägliche Sammel-Mail mit allen Fristen (Aufenthaltstitel, NU-Nachweise, HU, Ausschreibungen, Aufgaben, Skonto, fehlende Zeiten).',
      ],
      [
        'Bankabruf (Enable Banking)',
        '/einstellungen/bankabruf',
        'Münchner Bank und Targobank verbinden: Umsätze und Kontostand automatisch abrufen (statt Kontoauszug hochladen).',
      ],
      [
        'Nummernkreise',
        '/einstellungen/nummernkreise',
        'Nächste Rechnungs-, Angebots- und Mahnungsnummer anzeigen und vor dem Umstieg anheben (nie senken).',
      ],
    ],
  },
  {
    id: 'benutzer',
    title: 'Benutzer & Gruppen',
    items: [
      [
        'Benutzer & Rechte',
        '/benutzer',
        'Zugänge anlegen und sperren, Rollen (Admin, Buchhaltung, Personal, Objektleitung), Objekte der Objektleitung.',
      ],
    ],
  },
  {
    id: 'grundeinstellungen',
    title: 'Grundeinstellungen',
    items: [
      [
        'DATEV-Konten & Nachkalkulation',
        '/datev',
        'Berater-/Mandantennummer, Kontenrahmen, Erlös- und Aufwandskonten, Lohnzuschläge je Beschäftigungsart, Ziel-Deckungsbeitrag.',
      ],
      [
        'Kostenstellen',
        '/einstellungen/kostenstellen',
        'Allgemeine Kostenstellen (Verwaltung, Fahrzeuge, Lager …) neben den Objekten.',
      ],
    ],
  },
  {
    id: 'vorgaben',
    title: 'Vorgaben & Einstellungen',
    items: [
      [
        'Leistungsarten',
        '/einstellungen/leistungsarten',
        'Stammliste der Leistungen am Objekt mit Lohnkostenanteil-Vorgabe.',
      ],
      [
        'Mahnstufen & Gebühren',
        '/mahnungen/einstellungen',
        'Zahlungserinnerung und Mahnstufen, Fristen, Mahngebühren und Verzugspauschale.',
      ],
      [
        'Tariflöhne',
        '/personal/lohnstufen',
        'Tariflohn je Lohngruppe (z. B. Tariflohn 1 = 15,00 €, Tariflohn 6 Glasreiniger = 18,40 €); bei jedem Mitarbeiter auswählbar.',
      ],
      [
        'Zuschläge & Lohnarten',
        '/zeiterfassung/lohnarten/einstellungen',
        'Nacht-, Sonntags- und Feiertagszuschläge (RTV Gebäudereinigung) und Lohnart-Nummern für den Lohnexport.',
      ],
      [
        'Zeiterfassung & Mindestlohn',
        '/zeiterfassung/einstellungen',
        'Branchen-Mindestlohn, Prüfungen nach MiLoG/ArbZG, Regeln für Nachträge.',
      ],
    ],
  },
  {
    id: 'dokumente',
    title: 'Dokumenteneinstellungen',
    items: [
      [
        'Briefvorlagen für Kunden',
        '/kunden/vorlagen',
        'Vorlagen für Serienbriefe und Schriftverkehr an Kunden.',
      ],
      [
        'Dokumentvorlagen Mitarbeiter',
        '/personal/vorlagen',
        'Bescheinigungen, Unterweisungen und Serienbriefe mit Platzhaltern.',
      ],
      [
        'Word-Vorlagen',
        '/einstellungen/word-vorlagen',
        'Arbeitsverträge, Nutzungsüberlassungen, Protokolle als Word-Datei mit Platzhaltern (wie Fortytools) – ZIP hochladen, beim Mitarbeiter/Kunden/Objekt ausfüllen.',
      ],
      [
        'Vorlagen ausfüllen (Word)',
        '/vorlagen',
        'Person, Kunde oder Objekt wählen und eine Word-Vorlage ausfüllen (zuletzt erstellte Dokumente).',
      ],
      [
        'Objektordner-Vorlagen',
        '/einstellungen/objektordner',
        'Paket „Objektordner-Komplettpaket“ (ZIP) – wird je Objekt automatisch mit den Objektdaten ausgefüllt.',
      ],
    ],
  },
  {
    id: 'disposition',
    title: 'Disposition-Einstellungen',
    items: [
      [
        'Nutzungsarten (Raumarten)',
        '/einstellungen/nutzungsarten',
        'Raumarten für das Raumbuch und welche Kontrollgegenstände je Nutzungsart im Audit geprüft werden.',
      ],
      [
        'Kontrollgegenstände',
        '/einstellungen/kontrollgegenstaende',
        'Was im Audit bewertet wird: Note 1 bis 6, Gut/Mittel/Schlecht, Ja/Nein oder Punkte 1 bis 5.',
      ],
      [
        'Arbeitskleidung: Bestand, Artikel & Größen',
        '/arbeitskleidung',
        'Bestand je Artikel und Größe (Zugang, Inventur), Preise, PSA-Kennzeichen und Mindestbestand.',
      ],
      [
        'Gegenstände für Übergaben',
        '/einstellungen/uebergabe-gegenstaende',
        'Auswahlliste für Übergaben: Diensthandy, Tankkarte, Transponder …',
      ],
    ],
  },
  {
    id: 'import-export',
    title: 'Import & Export',
    items: [
      [
        'Import aus Fortytools',
        '/transfer/import',
        'Kunden, Objekte, Leistungen und Mitarbeiter aus den Fortytools-Exporten übernehmen.',
      ],
      [
        'Import aus der alten App',
        '/transfer/altdaten',
        'Backup der alten App hochladen: Kassenbuch, Eigen-Compliance und weitere Bereiche übernehmen.',
      ],
      ['DATEV-Export', '/datev', 'Buchungsstapel für den Steuerberater.'],
      ['Export Lexware Lohn', '/personal/export.csv', 'Mitarbeiter-Stammdaten als CSV für Lexware Lohn.'],
    ],
  },
];

const companyInput = z.object({
  legal_name: z.string().trim().min(1, 'Firmenname fehlt'),
  street: z.string().trim().min(1, 'Straße fehlt'),
  postal_code: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'PLZ muss 5-stellig sein'),
  city: z.string().trim().min(1, 'Ort fehlt'),
  vat_id: z
    .string()
    .trim()
    .regex(/^DE\d{9}$/, 'USt-ID: DE + 9 Ziffern'),
  tax_number: z.string().trim().nullable(),
  register_court: z.string().trim().nullable(),
  register_number: z.string().trim().nullable(),
  managing_director: z.string().trim().nullable(),
  phone: z.string().trim().nullable(),
  fax: z.string().trim().nullable(),
  email: z.email('E-Mail ungültig'),
  website: z.string().trim().nullable(),
  job_whatsapp: z.string().trim().nullable(),
});

const ibanOk = (iban: string) => {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let m = 0;
  for (const d of r) m = (m * 10 + Number(d)) % 97;
  return m === 1;
};

export function registerSettingsRoutes({ app, deps, page, back }: Ctx) {
  app.get('/einstellungen/objektordner', async (c) => {
    const p = await packageInfo(deps.sql);
    return page(
      c,
      'Objektordner-Vorlagen',
      '',
      <>
        <PageHead title="Objektordner-Vorlagen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <form
          method="post"
          action="/einstellungen/objektordner"
          enctype="multipart/form-data"
          class="card"
          style="max-width:760px"
        >
          <p style="margin-top:0">
            {p ? (
              <>
                Aktuell: <b>{p.file_name}</b> (hochgeladen {p.uploaded_at.toLocaleDateString('de-DE')} von{' '}
                {p.uploaded_by})
              </>
            ) : (
              'Noch kein Paket hochgeladen.'
            )}
          </p>
          <p class="small mut">
            ZIP mit den Ordnern 01_Aushang-Putzraum … 06_Nachweise-im-Objekt und dem Inhaltsverzeichnis. In
            den Word-Dateien werden Lücken wie „Objektleitung: ____“ und Tabellenfelder neben „Objekt“,
            „Kunde“, „Objektleitung“, „Bereichsleitung“, „Ansprechpartner Kunde“, „Ersthelfer im Objekt“,
            „Tel“ je Objekt ausgefüllt. Neue Fassung hochladen ersetzt die alte (die alte bleibt im Archiv).
          </p>
          <input type="file" name="datei" accept=".zip" required aria-label="ZIP-Datei" />
          <div class="formfoot">
            <button class="btn">Hochladen</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/einstellungen/objektordner', async (c) => {
    const b = await c.req.parseBody();
    const f = b.datei;
    if (!(f instanceof File) || !f.size) throw new BusinessError('Bitte ZIP-Datei wählen');
    const n = await savePackage(deps, new Uint8Array(await f.arrayBuffer()), f.name, c.get('actor'));
    return back(c, '/einstellungen/objektordner', { ok: `Paket gespeichert (${n} Dateien).` });
  });

  const { sql } = deps;

  app.get('/einstellungen', async (c) => {
    const role = c.get('user').role as Role;
    const sections = SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter(([, href]) => canOpen(role, href)),
    })).filter((s) => s.items.length);
    const [co] = await sql<{ legal_name: string }[]>`select legal_name from app.company where id = 1`;
    return page(
      c,
      'Einstellungen',
      '',
      <>
        <PageHead title={`Einstellungen für ${co?.legal_name ?? 'die Firma'}`} />
        <div class="set-wrap">
          <div class="set-main">
            {sections.map((s) => (
              <section id={s.id} class="set-sec">
                <h2>{s.title}</h2>
                {s.items.map(([label, href, hint]) => (
                  <a class="set-item" href={href}>
                    <b>{label}</b>
                    <span>{hint}</span>
                  </a>
                ))}
              </section>
            ))}
          </div>
          <aside class="set-toc" aria-label="Inhalt">
            <div class="set-toc-t">Inhalt</div>
            {sections.map((s) => (
              <a href={`#${s.id}`}>{s.title}</a>
            ))}
          </aside>
        </div>
      </>,
    );
  });

  app.get('/einstellungen/nummernkreise', async (c) => {
    const rows = await listRanges(sql);
    return page(
      c,
      'Nummernkreise',
      'einstellungen',
      <>
        <PageHead title="Nummernkreise" crumbs={[['Einstellungen', '/einstellungen']]} />
        <div class="flash warn">
          <span>
            Jede Rechnungsnummer darf nur einmal vergeben werden (§ 14 Abs. 4 Nr. 4 UStG). Nummernkreise
            lassen sich deshalb nur <b>anheben</b>. Vor dem Umstieg: in Fortytools die „nächste Nummer“
            ablesen, hier eintragen – danach in Fortytools keine Rechnungen oder Angebote mehr schreiben.
          </span>
        </div>
        <div class="card">
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Nummernkreis</th>
                  <th>Präfix</th>
                  <th class="r">höchste vergebene</th>
                  <th class="r">nächste Nummer</th>
                  <th>anheben auf</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td>
                      {rangeLabel(r.key)}
                      <div class="small faint">{r.key}</div>
                    </td>
                    <td>{r.prefix || '–'}</td>
                    <td class="r">{r.used_max != null ? String(r.used_max) : '–'}</td>
                    <td class="r">
                      <b>
                        {r.prefix}
                        {String(r.next_value)}
                      </b>
                    </td>
                    <td>
                      <form
                        method="post"
                        action="/einstellungen/nummernkreise"
                        class="actions"
                        style="margin:0;flex-wrap:nowrap"
                        onsubmit="return confirm('Nummernkreis anheben? Das lässt sich nicht rückgängig machen.')"
                      >
                        <input type="hidden" name="key" value={r.key} />
                        <input
                          name="next"
                          inputmode="numeric"
                          pattern="[0-9]+"
                          style="max-width:140px"
                          placeholder={String(r.next_value + 1n)}
                          aria-label="neue nächste Nummer"
                        />
                        <button class="btn sec sm">Anheben</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>,
    );
  });

  app.post('/einstellungen/nummernkreise', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const key = str(b, 'key') ?? '';
    const next = str(b, 'next') ?? '';
    if (!/^\d{1,15}$/.test(next)) throw new BusinessError('Bitte eine ganze Zahl eintragen');
    await raiseRange(sql, key, BigInt(next), c.get('actor'));
    return back(c, '/einstellungen/nummernkreise', { ok: `Nächste Nummer ist jetzt ${next}.` });
  });

  app.get('/einstellungen/firma', async (c) => {
    const [co] = await sql<Record<string, unknown>[]>`select * from app.company where id = 1`;
    const accts = (
      (co?.bank_accounts as { name: string; iban: string; bic: string; primary?: boolean }[]) ?? []
    ).concat([{ name: '', iban: '', bic: '' }]);
    const v = (k: string) => (co?.[k] as string | null) ?? '';
    const field = (k: string, label: string, req = false) => (
      <div>
        <label for={k}>{label}</label>
        <input id={k} name={k} value={v(k)} required={req} />
      </div>
    );
    return page(
      c,
      'Firmendaten',
      '',
      <>
        <PageHead title="Firmendaten & Bankverbindungen" crumbs={[['Einstellungen', '/einstellungen']]} />
        <form method="post" action="/einstellungen/firma" class="card" style="max-width:980px">
          <div class="group-title">Anschrift (Absender auf Rechnungen, Mahnungen, E-Rechnung)</div>
          <div class="grid">
            {field('legal_name', 'Firmenname', true)}
            {field('street', 'Straße', true)}
            {field('postal_code', 'PLZ', true)}
            {field('city', 'Ort', true)}
          </div>
          <div class="group-title">Steuer & Register</div>
          <div class="grid">
            {field('vat_id', 'USt-ID', true)}
            {field('tax_number', 'Steuernummer')}
            {field('register_court', 'Registergericht')}
            {field('register_number', 'Handelsregister-Nr.')}
            {field('managing_director', 'Geschäftsführung')}
          </div>
          <div class="group-title">Kontakt</div>
          <div class="grid">
            {field('phone', 'Telefon')}
            {field('fax', 'Fax')}
            {field('email', 'E-Mail', true)}
            {field('website', 'Website')}
            {field('job_whatsapp', 'Handy-/WhatsApp-Nummer für Stellenplakate')}
          </div>
          <div class="group-title">Bankverbindungen (erste = Hauptkonto, steht im GiroCode)</div>
          {accts.map((a, i) => (
            <div class="grid" style="margin-bottom:10px">
              <div>
                <label>Bank</label>
                <input name="bank_name" value={a.name} aria-label={`Bank ${i + 1}`} />
              </div>
              <div>
                <label>IBAN</label>
                <input name="bank_iban" value={a.iban} aria-label={`IBAN ${i + 1}`} />
              </div>
              <div>
                <label>BIC</label>
                <input name="bank_bic" value={a.bic} aria-label={`BIC ${i + 1}`} />
              </div>
            </div>
          ))}
          <p class="small mut">
            Hinweis: Das Briefpapier (Kopf/Fuß der PDFs) ist ein Bild und enthält die Adresse selbst – bei
            Umzug bitte auch das neue Briefpapier hinterlegen (Grafiker, 300 dpi). Leere Bankzeile = Konto
            entfernen.
          </p>
          <div class="formfoot">
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/einstellungen/firma', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const opt = (k: string) => str(b, k);
    const parsed = companyInput.safeParse({
      legal_name: opt('legal_name') ?? '',
      street: opt('street') ?? '',
      postal_code: opt('postal_code') ?? '',
      city: opt('city') ?? '',
      vat_id: (opt('vat_id') ?? '').replace(/\s/g, '').toUpperCase(),
      tax_number: opt('tax_number'),
      register_court: opt('register_court'),
      register_number: opt('register_number'),
      managing_director: opt('managing_director'),
      phone: opt('phone'),
      fax: opt('fax'),
      email: opt('email') ?? '',
      website: opt('website'),
      job_whatsapp: opt('job_whatsapp'),
    });
    if (!parsed.success)
      return back(c, '/einstellungen/firma', {
        fehler: parsed.error.issues.map((i) => i.message).join('\n'),
      });
    const all = (k: string) => ([] as unknown[]).concat(b[k] ?? []).map((x) => String(x).trim());
    const names = all('bank_name');
    const ibans = all('bank_iban');
    const bics = all('bank_bic');
    const accounts: { name: string; iban: string; bic: string; primary: boolean }[] = [];
    try {
      ibans.forEach((iban, i) => {
        if (!iban && !names[i]) return;
        const clean = iban.replace(/\s/g, '').toUpperCase();
        if (!ibanOk(clean)) throw new BusinessError(`IBAN ungültig: ${iban}`);
        if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test((bics[i] ?? '').toUpperCase()))
          throw new BusinessError(`BIC ungültig bei ${names[i] || iban}`);
        accounts.push({
          name: names[i] || 'Bank',
          iban: clean.replace(/(.{4})/g, '$1 ').trim(),
          bic: bics[i]!.toUpperCase(),
          primary: accounts.length === 0,
        });
      });
      if (!accounts.length) throw new BusinessError('Mindestens eine Bankverbindung angeben');
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/einstellungen/firma', { fehler: e.message });
      throw e;
    }
    await sql.begin(async (tx) => {
      await tx`update app.company set ${tx({ ...parsed.data, bank_accounts: tx.json(accounts as never) } as Record<string, unknown>)},
                      updated_at = now() where id = 1`;
      await tx`insert into app.audit_log (actor, action, entity, details)
               values (${c.get('actor')}, 'update', 'company', ${tx.json({ ...parsed.data, bank_accounts: accounts } as never)})`;
    });
    return back(c, '/einstellungen/firma', { ok: 'Firmendaten gespeichert. Gilt für neue Rechnungen.' });
  });
}
