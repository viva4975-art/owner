import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import { getCustomer, getSite, listCustomers, listSites } from '../services/masterdata.js';
import {
  type OfferRow,
  type OfferStatus,
  OFFER_STATUS,
  acceptIntoSite,
  copyOffer,
  getOffer,
  listOffers,
  offerInvoices,
  offerToInvoiceDraft,
  renderOfferPdf,
  saveOffer,
  setOfferStatus,
} from '../services/offers.js';
import { orderFromOffer } from '../services/orders.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { arr, parseLines, str } from './forms.js';
import { OfferDetail, OfferEditor, OfferList, toOfferEditorLine } from './pages-offers.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);

export function registerOfferRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  app.get('/angebote', async (c) => {
    const all = await listOffers(sql);
    const view = c.req.query('ansicht');
    const status = c.req.query('status');
    let rows = [...all];
    let active = 'offen';
    let title = 'Angebote';
    if (view === 'fristen') {
      active = 'fristen';
      title = 'Abgabefristen';
      rows = all
        .filter((o) => o.status === 'entwurf' && o.submission_deadline)
        .sort((a, b) => a.submission_deadline!.getTime() - b.submission_deadline!.getTime());
    } else if (status === 'alle') {
      active = 'alle';
    } else if (status && status in OFFER_STATUS) {
      active = status;
      rows = all.filter((o) => o.status === status);
    } else {
      rows = all.filter((o) => o.status === 'entwurf' || o.status === 'versendet');
    }
    return page(c, title, 'angebote', <OfferList rows={rows} all={all} active={active} title={title} />);
  });

  app.get(`/angebote/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getOffer(sql, id);
    if (data && data.offer.status !== 'entwurf') {
      return back(c, `/angebote/${id}`, {
        fehler: 'Abgegebene Angebote sind nicht mehr änderbar – bitte kopieren.',
      });
    }
    const o: Partial<OfferRow> = data?.offer ?? { offer_date: todayBerlin() };
    const q = c.req.query();
    if (q.kunde !== undefined) o.customer_id = q.kunde;
    if (q.objekt !== undefined) o.site_id = q.objekt || null;
    const customers = (await listCustomers(sql)).filter((x) => x.active);
    const sites = o.customer_id ? await listSites(sql, o.customer_id) : [];
    if (o.site_id && !sites.some((s) => s.id === o.site_id)) o.site_id = null;
    return page(
      c,
      data ? `Angebot ${data.offer.number}` : 'Neues Angebot',
      'angebote',
      <OfferEditor
        id={id}
        o={o}
        lines={(data?.lines ?? []).map(toOfferEditorLine)}
        customers={customers}
        sites={sites}
        isNew={!data}
      />,
    );
  });

  app.post(`/angebote/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody({ all: true });
    const rec = arr(body, 'rec');
    const desc = arr(body, 'desc');
    // „wiederkehrend“ gehört zur gleichen Zeile wie die Beschreibung; leere Zeilen fallen in parseLines raus.
    const keep = desc.map((d, i) => d.trim() !== '' || (arr(body, 'price')[i] ?? '').trim() !== '');
    const recurring = rec.filter((_, i) => keep[i]).map((v) => v === '1');
    const lines = parseLines(body).map((l, i) => ({ ...l, recurring: recurring[i] ?? false }));
    const offerDate = str(body, 'offer_date');
    if (!offerDate) throw new BusinessError('Angebotsdatum fehlt');
    const deadline = str(body, 'submission_deadline');
    if (deadline && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline))
      throw new BusinessError('Abgabefrist ungültig');
    await saveOffer(
      sql,
      id,
      {
        customerId: str(body, 'customer_id') ?? '',
        siteId: str(body, 'site_id'),
        title: str(body, 'title') ?? '',
        tenderReference: str(body, 'tender_reference'),
        tenderPlatform: str(body, 'tender_platform'),
        submissionDeadline: deadline,
        offerDate,
        validUntil: str(body, 'valid_until'),
        introText: str(body, 'intro_text'),
        closingText: str(body, 'closing_text'),
        lines,
        expectedVersion: versionOf(body.version),
      },
      c.get('actor'),
    );
    return back(c, `/angebote/${id}`, { ok: 'Angebot gespeichert.' });
  });

  app.get(`/angebote/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getOffer(sql, id);
    if (!data) return c.redirect(`/angebote/${id}/bearbeiten`);
    const { offer: o, lines } = data;
    const [customer, site, sites, files, history, invoices] = await Promise.all([
      getCustomer(sql, o.customer_id),
      o.site_id ? getSite(sql, o.site_id) : Promise.resolve(undefined),
      listSites(sql, o.customer_id),
      listFiles(sql, { type: 'offer', id }),
      sql<{ at: Date; actor: string; action: string; details: unknown }[]>`
        select at, actor, action, details from app.audit_log where entity = 'offer' and entity_id = ${id} order by at desc limit 30`,
      offerInvoices(sql, id),
    ]);
    return page(
      c,
      `Angebot ${o.number}`,
      'angebote',
      <OfferDetail
        o={o}
        lines={lines}
        customer={customer!}
        site={site ?? null}
        sites={sites}
        fileCount={files.length}
        files={
          <FileArea
            link={{ type: 'offer', id }}
            files={files}
            category="Ausschreibungsunterlagen"
            title="Ausschreibungsunterlagen hierher ziehen"
            maxBytes={env.UPLOAD_MAX_BYTES}
          />
        }
        history={history}
        invoices={invoices}
        today={todayBerlin()}
      />,
    );
  });

  app.get(`/angebote/:id{${UUID}}/angebot.pdf`, async (c) => {
    const { pdf, filename } = await renderOfferPdf(sql, c.req.param('id'));
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.post(`/angebote/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const status = String((await c.req.parseBody()).status ?? '') as OfferStatus;
    if (!(status in OFFER_STATUS)) throw new BusinessError('Ungültiger Status');
    await setOfferStatus(sql, id, status, c.get('actor'));
    const msg: Record<string, string> = {
      versendet: 'Angebot als abgegeben markiert.',
      angenommen: 'Zuschlag erfasst – jetzt ins Objekt übernehmen oder Rechnungsentwurf erstellen.',
      abgelehnt: 'Absage erfasst.',
      zurueckgezogen: 'Angebot zurückgezogen.',
    };
    return back(c, `/angebote/${id}`, { ok: msg[status] ?? 'Status geändert.' });
  });

  app.post(`/angebote/:id{${UUID}}/kopieren`, async (c) => {
    const newId = await copyOffer(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/angebote/${newId}/bearbeiten`, { ok: 'Kopie als neuer Entwurf angelegt.' });
  });

  app.post(`/angebote/:id{${UUID}}/objekt`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody({ all: true });
    const siteId = str(body, 'site_id');
    const from = str(body, 'valid_from');
    if (!siteId || !from) throw new BusinessError('Bitte Objekt und Leistungsbeginn wählen');
    const n = await acceptIntoSite(sql, id, siteId, from, c.get('actor'));
    // Interessent mit Zuschlag wird Kunde
    await sql`update app.customers set status = 'kunde'
               where id = (select customer_id from app.offers where id = ${id}) and status = 'interessent'`;
    return back(c, `/objekte/${siteId}/leistungen`, {
      ok: n
        ? `${n} Leistung(en) aus dem Angebot übernommen.`
        : 'Leistungen waren bereits übernommen – nichts doppelt angelegt.',
    });
  });

  app.post(`/angebote/:id{${UUID}}/auftrag`, async (c) => {
    const orderId = await orderFromOffer(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/auftraege/${orderId}`, { ok: 'Auftrag aus dem Angebot angelegt.' });
  });

  app.post(`/angebote/:id{${UUID}}/rechnung`, async (c) => {
    const invId = await offerToInvoiceDraft(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/rechnungen/${invId}`, { ok: 'Rechnungsentwurf aus dem Angebot erstellt.' });
  });
}
