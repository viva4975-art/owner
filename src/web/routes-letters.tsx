import { randomUUID } from 'node:crypto';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { type LetterTarget, letterRecipient, writeLetter } from '../services/letters.js';
import { type Ctx, assertSite } from './app.js';
import { str } from './forms.js';
import { PageHead } from './layout.js';
import { canAccess } from './permissions.js';
import { uploadConfig } from './routes-files.js';

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
          <p class="small mut" style="margin-top:0">
            An: {b.name}
            {b.contactName ? `, ${b.contactName}` : ''} · {b.street}, {b.postalCode} {b.city}
            {!b.street || !b.city ? ' – Anschrift unvollständig, bitte zuerst ergänzen' : ''}
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
              <input
                id="greeting"
                name="greeting"
                value={
                  t === 'mitarbeiter' ? `Hallo ${b.name.split(' ')[0]},` : 'Sehr geehrte Damen und Herren,'
                }
              />
            </div>
          </div>
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
      subject: str(b, 'subject') ?? '',
      greeting: str(b, 'greeting') ?? '',
      body: typeof b.body === 'string' ? b.body : '',
      date: str(b, 'date'),
      actor: c.get('actor'),
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Brief_${todayBerlin()}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });
}
