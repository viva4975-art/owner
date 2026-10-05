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

const SECTIONS: { title: string; items: [string, string, string][] }[] = [
  {
    title: 'Firma',
    items: [
      [
        'Firmendaten & Bankverbindungen',
        '/einstellungen/firma',
        'Adresse, Steuernummer, Register, Konten auf Rechnungen',
      ],
      ['Benutzer & Rechte', '/benutzer', 'Zugänge, Rollen, Objekte der Objektleitung'],
    ],
  },
  {
    title: 'Rechnungen & Mahnwesen',
    items: [
      ['Leistungsarten', '/einstellungen/leistungsarten', 'Stammliste mit Lohnkostenanteil'],
      ['Mahnstufen & Gebühren', '/mahnungen/einstellungen', 'Stufen, Fristen, Mahngebühren'],
      ['Briefvorlagen für Kunden', '/kunden/vorlagen', 'Serienbriefe, Schriftverkehr'],
      [
        'SEPA-Lastschrift: Gläubiger-ID',
        '/transfer/lastschriften',
        'für Einzüge und Hinweis auf der Rechnung',
      ],
    ],
  },
  {
    title: 'Buchhaltung & Kalkulation',
    items: [
      [
        'DATEV-Konten & Nachkalkulation',
        '/datev',
        'Berater-/Mandantennr., Konten, Lohnzuschlag, Ziel-Deckungsbeitrag',
      ],
    ],
  },
  {
    title: 'Personal',
    items: [
      ['Lohnstufen', '/personal/lohnstufen', 'Stundenlöhne je Stufe'],
      ['Dokumentvorlagen Mitarbeiter', '/personal/vorlagen', 'Bescheinigungen, Serienbriefe'],
      ['Zeiterfassung & Mindestlohn', '/zeiterfassung/einstellungen', 'Branchen-Mindestlohn, Prüfungen'],
    ],
  },
  {
    title: 'Disposition & Inventar',
    items: [
      ['Leistungswerte je Raumart', '/raumbuch/leistungswerte', 'm²/h für die Stundenvorgabe'],
      ['Arbeitskleidung: Artikel & Größen', '/arbeitskleidung', 'Preise, PSA, Mindestbestand'],
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
  const { sql } = deps;

  app.get('/einstellungen', (c) => {
    const role = c.get('user').role as Role;
    const sections = SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter(([, href]) => canOpen(role, href)),
    })).filter((s) => s.items.length);
    return page(
      c,
      'Einstellungen',
      '',
      <>
        <PageHead title="Einstellungen" />
        <p class="mut" style="margin-top:-8px;max-width:760px">
          Stammlisten und Vorgaben, die selten geändert werden. Änderungen gelten für neue Vorgänge;
          ausgestellte Rechnungen und abgeschlossene Belege bleiben unverändert.
        </p>
        <div class="settings-grid">
          {sections.map((s) => (
            <div class="card">
              <h3>{s.title}</h3>
              {s.items.map(([label, href, hint]) => (
                <a class="set" href={href}>
                  <div>
                    <b>{label}</b>
                    <div>
                      <span>{hint}</span>
                    </div>
                  </div>
                  <span>›</span>
                </a>
              ))}
            </div>
          ))}
        </div>
      </>,
    );
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
