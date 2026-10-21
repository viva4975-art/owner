import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { readFile } from 'node:fs/promises';
import { type LetterTarget, letterRecipient, listLetters, writeLetter } from '../services/letters.js';
import { filePath } from '../services/uploads.js';
import { AddressBlock } from './address-block.js';
import { SiteOptions } from './site-options.js';
import { type Ctx, assertSite } from './app.js';
import { str } from './forms.js';
import { dateDe, PageHead } from './layout.js';
import { canAccess } from './permissions.js';
import { uploadConfig } from './routes-files.js';
import { fullName } from '../services/users.js';

/** Kürzel aus dem Namen („Ahmed Chomontek“ → „AC“) als Vorschlag für „Unser Zeichen“. */
const initials = (name: string) =>
  name
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
    .slice(0, 4);

/** Unser Zeichen / Ihr Zeichen / Ansprechpartner – mit dem eigenen Namen vorbelegt, änderbar. */
function RefFields({ name }: { name: string }) {
  return (
    <div class="grid" style="margin-top:10px">
      <div>
        <label for="our_ref">Unser Zeichen</label>
        <input id="our_ref" name="our_ref" value={initials(name)} maxlength={60} />
      </div>
      <div>
        <label for="your_ref">Ihr Zeichen</label>
        <input id="your_ref" name="your_ref" maxlength={60} placeholder="optional" />
      </div>
      <div>
        <label for="sender">Ansprechpartner (Name unter dem Gruß)</label>
        <input id="sender" name="sender" value={name} maxlength={120} />
      </div>
    </div>
  );
}
const refsFromBody = (b: Record<string, unknown>) => ({
  ourRef: str(b as Parameters<typeof str>[0], 'our_ref'),
  yourRef: str(b as Parameters<typeof str>[0], 'your_ref'),
  sender: str(b as Parameters<typeof str>[0], 'sender'),
});

const BACK: Record<LetterTarget, (id: string) => string> = {
  kunde: (id) => `/kunden/${id}/dokumente`,
  objekt: (id) => `/objekte/${id}/dokumente`,
  lieferant: (id) => `/lieferanten/${id}/dokumente`,
  mitarbeiter: (id) => `/personal/${id}/dokumente`,
};
const GATE: Record<LetterTarget, string> = {
  kunde: '/kunden',
  objekt: '/objekte',
  lieferant: '/lieferanten',
  mitarbeiter: '/personal/x',
};

/** Anschrift aus dem Formularfeld to_block (bereits in to_name, to_street … zerlegt, siehe address-block.tsx). */
const addressFromBody = (b: Record<string, unknown>) => {
  const t = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  if (!t('to_name')) return null;
  return {
    name: t('to_name'),
    name2: t('to_name2') || null,
    contactName: t('to_contact') || null,
    street: t('to_street'),
    postalCode: t('to_postal_code'),
    city: t('to_city'),
  };
};

/** Schriftverkehr: freier Brief auf Briefpapier (Kunde, Lieferant, Mitarbeiter). */
export function registerLetterRoutes(ctx: Ctx) {
  const { app, deps, page } = ctx;
  const { sql } = deps;
  const target = (v: string | undefined | null): LetterTarget => {
    if (v === 'kunde' || v === 'objekt' || v === 'lieferant' || v === 'mitarbeiter') return v;
    throw new BusinessError('Empfänger ungültig');
  };

  app.get('/brief', async (c) => {
    const t = target(c.req.query('an'));
    const id = c.req.query('id') ?? '';
    if (!canAccess(c.get('user').role, GATE[t])) throw new BusinessError('Keine Berechtigung');
    if (t === 'objekt') assertSite(c, id);
    const r = await letterRecipient(sql, t, id);
    const b = r.buyer;
    return page(
      c,
      'Brief schreiben',
      t === 'mitarbeiter' ? 'personal' : t === 'lieferant' ? 'lieferanten' : 'kunden',
      <>
        <PageHead title={`Brief an ${r.label}`} crumbs={[['zurück', BACK[t](id)]]} />
        <form method="post" action="/brief" target="_blank" class="card" style="max-width:860px">
          <input type="hidden" name="form" value={randomUUID()} />
          <input type="hidden" name="an" value={t} />
          <input type="hidden" name="id" value={id} />
          <AddressBlock id="to_block" name="to_block" value={b} required label="Anschrift *" />
          <p class="small mut" style="margin:2px 0 10px">
            Vorbelegt aus den Stammdaten – hier nur für diesen Brief änderbar.
          </p>
          <div class="grid">
            <div>
              <label for="subject">Betreff *</label>
              <input id="subject" name="subject" required />
            </div>
            <div>
              <label for="date">Datum</label>
              <input id="date" type="date" name="date" value={todayBerlin()} />
            </div>
            <div>
              <label for="greeting">Anrede</label>
              <input id="greeting" name="greeting" value={r.greeting} />
            </div>
          </div>
          <RefFields name={fullName(c.get('user'))} />
          <label for="body" style="margin-top:12px">
            Text * (Absätze mit Leerzeile trennen; Gruß wird angefügt)
          </label>
          <textarea id="body" name="body" rows={14} required></textarea>
          {t === 'mitarbeiter' && (
            <p class="small" style="color:var(--warn)">
              Kündigung, Aufhebungsvertrag, Befristung: ausdrucken und eigenhändig unterschreiben (Schriftform
              § 623 BGB, § 14 Abs. 4 TzBfG) – E-Mail/Scan reicht nicht.
            </p>
          )}
          <div class="actions form-foot">
            <button class="btn">PDF erstellen und in der Akte ablegen</button>
            <a class="btn sec" href={BACK[t](id)}>
              Zurück
            </a>
          </div>
        </form>
      </>,
    );
  });

  app.post('/brief', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const t = target(str(b, 'an'));
    if (!canAccess(c.get('user').role, GATE[t])) throw new BusinessError('Keine Berechtigung');
    if (t === 'objekt') assertSite(c, str(b, 'id') ?? '');
    const formId = str(b, 'form') ?? randomUUID();
    const { pdf } = await writeLetter(sql, uploadConfig(ctx), {
      formId,
      target: t,
      id: str(b, 'id') ?? '',
      address: addressFromBody(b),
      subject: str(b, 'subject') ?? '',
      greeting: str(b, 'greeting') ?? '',
      body: typeof b.body === 'string' ? b.body : '',
      date: str(b, 'date'),
      actor: c.get('actor'),
      ...refsFromBody(b),
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Brief_${todayBerlin()}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // ------------------------------------------------- Verwaltung → Briefe (Ahmed 21.10.)
  // Freier Brief an Kunde, Objekt oder frei eingegebene Anschrift; jeder Brief bleibt im Briefarchiv.
  const pdfResponse = (pdf: Uint8Array, name: string) =>
    new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${name}"`,
        'Cache-Control': 'private, no-store',
      },
    });

  app.get('/verwaltung/briefe', async (c) => {
    const q = c.req.query('q') ?? '';
    const rows = await listLetters(sql, q || null);
    return page(
      c,
      'Briefe',
      'verwaltung',
      <>
        <PageHead title="Briefe" />
        <div class="ls-bar">
          <form method="get" style="display:flex;gap:8px;flex:1">
            <input
              class="search-input"
              name="q"
              value={q}
              placeholder="Suchen: Betreff, Empfänger, Zeichen, Text …"
              aria-label="Suche"
            />
            <button class="btn sec sm">Suchen</button>
          </form>
          <a class="btn" href="/verwaltung/briefe/neu">
            + Neuer Brief
          </a>
        </div>
        {rows.length === 0 ? (
          <div class="empty">{q ? 'Keine Briefe gefunden.' : 'Noch keine Briefe.'}</div>
        ) : (
          <div class="tablewrap card" style="padding:0">
            <table class="stack-m">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>An</th>
                  <th>Betreff</th>
                  <th>Zu</th>
                  <th>Unser Zeichen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <td data-label="Datum">{dateDe(r.letter_date)}</td>
                    <td data-label="An" class="small" style="white-space:pre-line">
                      {r.recipient.split('\n').slice(0, 2).join('\n')}
                    </td>
                    <td data-label="Betreff">{r.subject}</td>
                    <td data-label="Zu" class="small">
                      {r.site_id ? (
                        <a href={`/objekte/${r.site_id}/dokumente`}>
                          Objekt {r.site_name} ({r.site_no})
                        </a>
                      ) : r.customer_id ? (
                        <a href={`/kunden/${r.customer_id}/dokumente`}>Kunde {r.customer_no}</a>
                      ) : r.target === 'lieferant' ? (
                        'Lieferant'
                      ) : (
                        <span class="mut">frei</span>
                      )}
                    </td>
                    <td data-label="Unser Zeichen" class="small">
                      {[r.our_ref, r.sender].filter(Boolean).join(' · ') || '–'}
                    </td>
                    <td>
                      <a class="btn sm sec" href={`/verwaltung/briefe/${r.id}/pdf`} target="_blank">
                        PDF
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="small mut">
          Alle Briefe aus Verwaltung → Briefe sowie die freien Briefe bei Kunde, Objekt und Lieferant. Briefe
          an Mitarbeitende liegen nur in der Personalakte. Die PDFs sind unveränderbar archiviert.
        </p>
      </>,
    );
  });

  app.get('/verwaltung/briefe/neu', async (c) => {
    const an = c.req.query('an') === 'objekt' ? 'objekt' : c.req.query('an') === 'frei' ? 'frei' : 'kunde';
    const id = c.req.query('id') ?? '';
    const customers = await sql<{ id: string; customer_no: string; name: string }[]>`
      select id, customer_no, name from app.customers where not coalesce(is_internal, false) order by name`;
    const sites = await sql<
      {
        id: string;
        site_no: string;
        name: string;
        customer_name: string;
        street: string | null;
        city: string | null;
      }[]
    >`select s.id, s.site_no, s.name, c.name as customer_name, s.street, s.city
        from app.sites s join app.customers c on c.id = s.customer_id
       where s.active order by c.name, s.site_no`;
    const r = an !== 'frei' && /^[0-9a-f-]{36}$/.test(id) ? await letterRecipient(sql, an, id) : null;
    return page(
      c,
      'Neuer Brief',
      'verwaltung',
      <>
        <PageHead title="Neuer Brief" crumbs={[['Briefe', '/verwaltung/briefe']]} />
        <form method="get" class="card" style="max-width:860px" id="brief-an">
          <label>Empfänger</label>
          <div class="chips" style="margin:4px 0 10px">
            {(
              [
                ['kunde', 'Kunde'],
                ['objekt', 'Objekt'],
                ['frei', 'Frei eingeben'],
              ] as const
            ).map(([k, l]) => (
              <a class={an === k ? 'on' : ''} href={`/verwaltung/briefe/neu?an=${k}`}>
                {l}
              </a>
            ))}
          </div>
          <input type="hidden" name="an" value={an} />
          {an === 'kunde' && (
            <>
              <label for="an-id">Kunde</label>
              <select id="an-id" name="id" onchange="this.form.submit()">
                <option value="">– Kunde wählen –</option>
                {customers.map((k) => (
                  <option value={k.id} selected={k.id === id}>
                    {k.customer_no} · {k.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {an === 'objekt' && (
            <>
              <label for="an-id">Objekt</label>
              <select id="an-id" name="id" onchange="this.form.submit()">
                <option value="">– Objekt wählen –</option>
                <SiteOptions sites={sites} selected={id} />
              </select>
              <p class="small mut" style="margin:4px 0 0">
                Der Brief geht an die Rechnungsanschrift des Objekts und wird beim Objekt abgelegt.
              </p>
            </>
          )}
          <noscript>
            <button class="btn sec sm">Übernehmen</button>
          </noscript>
        </form>
        {(an === 'frei' || r) && (
          <form
            method="post"
            action="/verwaltung/briefe"
            target="_blank"
            class="card"
            style="max-width:860px"
          >
            <input type="hidden" name="form" value={randomUUID()} />
            <input type="hidden" name="an" value={an} />
            <input type="hidden" name="id" value={an === 'frei' ? '' : id} />
            <AddressBlock
              id="to_block"
              name="to_block"
              value={r?.buyer ?? null}
              required
              label="Anschrift *"
            />
            <div class="grid" style="margin-top:10px">
              <div>
                <label for="subject">Betreff *</label>
                <input id="subject" name="subject" required />
              </div>
              <div>
                <label for="date">Datum</label>
                <input id="date" type="date" name="date" value={todayBerlin()} />
              </div>
              <div>
                <label for="greeting">Anrede</label>
                <input
                  id="greeting"
                  name="greeting"
                  value={r?.greeting ?? 'Sehr geehrte Damen und Herren,'}
                />
              </div>
            </div>
            <RefFields name={fullName(c.get('user'))} />
            <label for="body" style="margin-top:12px">
              Text * (Absätze mit Leerzeile trennen; Gruß wird angefügt)
            </label>
            <textarea id="body" name="body" rows={14} required></textarea>
            <div class="actions form-foot">
              <button class="btn">PDF erstellen und archivieren</button>
              <a class="btn sec" href="/verwaltung/briefe">
                Zurück
              </a>
            </div>
            <p class="small mut">
              Das PDF öffnet sich in einem neuen Fenster und steht danach unter Briefe
              {an === 'kunde'
                ? ' und beim Kunden unter Dokumente'
                : an === 'objekt'
                  ? ' und beim Objekt unter Dokumente'
                  : ''}
              .
            </p>
          </form>
        )}
      </>,
    );
  });

  app.post('/verwaltung/briefe', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const an = str(b, 'an');
    const t = an === 'kunde' || an === 'objekt' ? an : 'frei';
    const { pdf } = await writeLetter(sql, uploadConfig(ctx), {
      formId: str(b, 'form') ?? randomUUID(),
      target: t,
      id: t === 'frei' ? null : (str(b, 'id') ?? ''),
      address: addressFromBody(b),
      subject: str(b, 'subject') ?? '',
      greeting: str(b, 'greeting') ?? '',
      body: typeof b.body === 'string' ? b.body : '',
      date: str(b, 'date'),
      actor: c.get('actor'),
      ...refsFromBody(b),
    });
    return pdfResponse(pdf, `Brief_${str(b, 'date') ?? todayBerlin()}.pdf`);
  });

  app.get('/verwaltung/briefe/:id/pdf', async (c) => {
    const [f] = await sql<Parameters<typeof filePath>[1][]>`
      select f.* from app.letters l join app.files f on f.id = l.file_id where l.id = ${c.req.param('id')}`;
    if (!f) return c.notFound();
    return pdfResponse(new Uint8Array(await readFile(filePath(uploadConfig(ctx), f))), f.original_name);
  });
}
