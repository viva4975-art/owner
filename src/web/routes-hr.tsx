import { randomUUID } from 'node:crypto';
import { listWordTemplates } from '../services/word-templates.js';
import { WordTemplateBox } from './routes-word-templates.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import {
  DOC_CATEGORIES,
  DOC_CHECKLIST,
  DRAFT_CATEGORY,
  EMPLOYMENT_TYPES,
  type Employee,
  getEmployee,
  TEMPLATE_FIELDS,
  listEmployees,
  listTemplates,
  listWageLevels,
  saveTemplate,
  saveWageLevel,
} from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import {
  applyContractChange,
  type ContractChangeInput,
  contractChangeDocx,
  contractChangePdf,
  contractChangeRows,
  currentSites,
  payText,
} from '../services/contract-change.js';
import { createFromTemplate, serialLetter } from '../services/hr-docs.js';
import { OPTIONAL_PER_EMPLOYEE, setDocNotNeeded } from '../services/hr-required-docs.js';
import { requestsForEmployee } from '../services/sign-documents.js';
import { archiveLink, listFiles, unlinkFile } from '../services/uploads.js';
import { type Ctx, UUID } from './app.js';
import { DocFoldAll, FileArea, docOpen } from './files.js';
import { type Body, centsToInput, str } from './forms.js';
import { PageHead, euro, anz } from './layout.js';
import { EmployeeCalendarView } from './pages-employee-calendar.js';
import { employeeCalendarData } from './employee-calendar-data.js';
import { holidayName } from '../domain/time/holidays.js';
import { uploadConfig, zipHref } from './routes-files.js';

/** Personal wie Fortytools: Dokumente je Mitarbeiter, Vorlagen/Serienbrief, Lohnstufen, Einsatzkalender. */
/** Kategorien, die oben in der Hochlade-Auswahl stehen; die übrigen unter „Weitere“. */
const UPLOAD_MAIN = [
  'Arbeitsvertrag',
  'Vertragsänderung',
  'Personalunterlagen',
  'Unterweisung',
  'Arbeitskleidung',
  'Aufenthalts-/Arbeitserlaubnis',
  'Bescheinigung',
  'Sonstiges',
];
/** Kategorie wechseln ohne Neuladen (Seite springt nicht nach oben); Adresse merkt sie für das Neuladen nach dem Upload. */
const CATEGORY_JS = `var c=this.closest('.card'),u=c&&c.querySelector('[data-uploader]'),k=this.value;
if(u){u.dataset.category=k;var b=u.querySelector('.drop-zone b');if(b)b.textContent=k+' hierher ziehen';}
try{var q=new URLSearchParams(location.search);q.set('kategorie',k);history.replaceState(null,'',location.pathname+'?'+q+'#hochladen');}catch(e){}`;

export function registerHrRoutes(ctx: Ctx) {
  const { app, deps, page, back, shells } = ctx;
  const { sql, env } = deps;
  const cfg = uploadConfig(ctx);

  // ------------------------------------------------------------ Dokumente je Mitarbeiter
  app.get(`/personal/:id{${UUID}}/dokumente`, (c) =>
    shells.employee!(c, 'dokumente', async (e) => {
      const kat = c.req.query('kategorie');
      const category = kat && DOC_CATEGORIES.includes(kat) ? kat : 'Personalunterlagen';
      const [files, templates, signs, wordTemplates] = await Promise.all([
        listFiles(sql, { type: 'employee', id: e.id }),
        listTemplates(sql),
        requestsForEmployee(sql, e.id),
        listWordTemplates(sql, 'mitarbeiter'),
      ]);
      // vorne nur aktuelle Unterlagen, ältere Fassungen im Archiv je Kategorie (abrufbar, nie gelöscht)
      const current = files.filter((f) => !f.archived_at);
      const catOf = (f: (typeof files)[number]) =>
        f.category && DOC_CATEGORIES.includes(f.category) ? f.category : f.category ? 'Weitere' : 'Sonstiges';
      const groups = [...DOC_CATEGORIES, 'Weitere']
        .map((k) => ({
          k,
          now: current.filter((f) => catOf(f) === k),
          old: files
            .filter((f) => f.archived_at && catOf(f) === k)
            .sort((a, b) => +b.archived_at! - +a.archived_at!),
        }))
        .filter((g) => g.now.length || g.old.length);
      const canDelete = ['admin', 'personal'].includes(c.get('user').role);
      const archForm = (fileId: string, aktion: 'archivieren' | 'zurueck', label: string) => (
        <form method="post" action={`/personal/${e.id}/dokumente/archiv`} style="display:inline">
          <input type="hidden" name="file_id" value={fileId} />
          <input type="hidden" name="aktion" value={aktion} />
          <button class="btn sm sec">{label}</button>
        </form>
      );
      const handovers = await sql<{ kind: string; n: number }[]>`
        select kind, count(*)::int as n from app.handovers
         where employee_id = ${e.id} and status in ('unterschrieben', 'ohne_unterschrift') group by kind`;
      const [nn] = await sql<{ d: string[] }[]>`
        select docs_not_needed as d from app.employees where id = ${e.id}`;
      const notNeeded = nn?.d ?? [];
      const hoCount = (k: string) => handovers.find((h) => h.kind === k)?.n ?? 0;
      const [si] = await sql<{ n: number }[]>`
        select count(*)::int as n from app.sign_requests sr join app.sign_documents sd on sd.id = sr.document_id
         where sr.employee_id = ${e.id} and sr.status = 'unterschrieben' and sd.category = 'unterweisung'`;
      const has = (name: string) =>
        current.some((f) => f.category === name) ||
        (name === 'Unterweisung' && (si?.n ?? 0) > 0) ||
        (name === 'Arbeitskleidung' && hoCount('kleidung') > 0) ||
        (name === 'Schlüssel' && hoCount('schluessel') > 0);
      return (
        <>
          <div class="actions" style="margin-top:0">
            {files.length > 0 && (
              <a class="btn sm sec" href={zipHref('employee', e.id, `Personalakte_${e.personnel_no}`)}>
                Alle als ZIP herunterladen
              </a>
            )}
            <a class="btn sm sec" href={`/brief?an=mitarbeiter&id=${e.id}`}>
              Freien Brief schreiben
            </a>
          </div>
          <div class="cols">
            <div>
              <div class="card">
                <h3 style="margin-top:0">Personalakte – Checkliste</h3>
                <div class="doc-check">
                  {DOC_CHECKLIST.map((d) => {
                    const off = notNeeded.includes(d.name);
                    const req = d.required && !off;
                    return (
                      <a
                        href={`/personal/${e.id}/dokumente?kategorie=${encodeURIComponent(d.name)}#hochladen`}
                        class={`dc ${has(d.name) ? 'ok' : req ? 'missing' : 'open'}`}
                      >
                        <span class="dc-i">{has(d.name) ? '✓' : req ? '!' : '–'}</span>
                        <span>
                          <b>{d.name}</b>{' '}
                          {off ? (
                            <span class="badge">nicht nötig</span>
                          ) : d.required ? (
                            <span class="badge err">Pflicht</span>
                          ) : (
                            <span class="badge">optional</span>
                          )}
                          <div class="small mut">
                            {has(d.name) ? 'vorhanden' : off ? 'für diese Person nicht nötig' : d.hint}
                          </div>
                        </span>
                      </a>
                    );
                  })}
                </div>
                {OPTIONAL_PER_EMPLOYEE.some((d) => !has(d)) && (
                  <div class="actions" style="margin-top:8px">
                    {OPTIONAL_PER_EMPLOYEE.filter((d) => !has(d)).map((d) => {
                      const off = notNeeded.includes(d);
                      return (
                        <form
                          method="post"
                          action={`/personal/${e.id}/unterlage-noetig`}
                          style="display:inline"
                        >
                          <input type="hidden" name="unterlage" value={d} />
                          <input type="hidden" name="noetig" value={off ? '1' : '0'} />
                          <button class="btn sm sec">
                            {off ? `${d}: wieder Pflicht` : `${d} nicht nötig (z. B. hat keine)`}
                          </button>
                        </form>
                      );
                    })}
                  </div>
                )}
              </div>
              <div class="card">
                <h3>Dokumente ({current.length})</h3>
                <p class="small mut" style="margin-top:-4px">
                  Vorne stehen die aktuellen Unterlagen. Ändert sich etwas (z. B. neuer Vertrag, neuer
                  Aufenthaltstitel): neue Fassung hochladen und die alte „ins Archiv“ legen – sie bleibt
                  unverändert abrufbar.
                </p>
                {groups.length === 0 && <div class="empty">Noch keine Dokumente.</div>}
                {groups.length > 1 && (
                  <div style="margin:-2px 0 8px">
                    <DocFoldAll />
                  </div>
                )}
                {groups.map(({ k, now, old }) => (
                  <details
                    class="doc-cat"
                    open={docOpen(now.length) || (k === category && !!c.req.query('kategorie'))}
                  >
                    <summary>
                      <b>{k}</b>{' '}
                      <span class="mut small">
                        ({now.length}
                        {old.length ? ` + ${old.length} im Archiv` : ''})
                      </span>
                    </summary>
                    <div style="margin:4px 0">
                      {now.length > 1 && (
                        <form
                          method="post"
                          action={`/personal/${e.id}/dokumente/archiv`}
                          style="display:inline"
                        >
                          <input type="hidden" name="kategorie" value={k} />
                          <input type="hidden" name="aktion" value="aeltere" />
                          <button
                            class="btn sm sec"
                            onclick={`return confirm(${JSON.stringify(`Alle bis auf die neueste Datei in „${k}“ ins Archiv legen?`)})`}
                          >
                            ältere ins Archiv ({now.length - 1})
                          </button>
                        </form>
                      )}
                    </div>
                    {now.length > 0 ? (
                      <FileArea
                        link={{ type: 'employee', id: e.id }}
                        files={now}
                        maxBytes={0}
                        listOnly
                        action={(f) => (
                          <>
                            {archForm(f.id, 'archivieren', 'ins Archiv')}
                            {canDelete && (
                              <form
                                method="post"
                                action={`/personal/${e.id}/dokumente/archiv`}
                                style="display:inline"
                              >
                                <input type="hidden" name="file_id" value={f.id} />
                                <input type="hidden" name="aktion" value="loeschen" />
                                <button
                                  class="btn sm ghost"
                                  title="Dokument löschen"
                                  data-confirm={`„${f.original_name}“ aus der Personalakte löschen?`}
                                >
                                  Löschen
                                </button>
                              </form>
                            )}
                          </>
                        )}
                      />
                    ) : (
                      <div class="small mut">Keine aktuelle Fassung – nur Archiv.</div>
                    )}
                    {old.length > 0 && (
                      <details class="doc-archive">
                        <summary class="small">Archiv ({old.length})</summary>
                        <FileArea
                          link={{ type: 'employee', id: e.id }}
                          files={old}
                          maxBytes={0}
                          listOnly
                          action={(f) => (
                            <>
                              <span class="small mut" style="white-space:nowrap">
                                archiviert{' '}
                                {(f as (typeof old)[number]).archived_at!.toLocaleDateString('de-DE', {
                                  timeZone: 'Europe/Berlin',
                                })}
                              </span>
                              {archForm(f.id, 'zurueck', 'zurückholen')}
                              {canDelete && (
                                <form
                                  method="post"
                                  action={`/personal/${e.id}/dokumente/archiv`}
                                  style="display:inline"
                                >
                                  <input type="hidden" name="file_id" value={f.id} />
                                  <input type="hidden" name="aktion" value="loeschen" />
                                  <button
                                    class="btn sm ghost"
                                    data-confirm={`„${f.original_name}“ aus der Personalakte löschen?`}
                                  >
                                    Löschen
                                  </button>
                                </form>
                              )}
                            </>
                          )}
                        />
                      </details>
                    )}
                  </details>
                ))}
              </div>
              <div class="card" id="hochladen">
                <form
                  method="get"
                  action={`/personal/${e.id}/dokumente`}
                  class="actions"
                  style="margin-top:0"
                >
                  <label for="kategorie" class="small" style="margin:0">
                    Hochladen als
                  </label>
                  <select
                    id="kategorie"
                    name="kategorie"
                    data-combo
                    onchange={CATEGORY_JS}
                    style="max-width:260px"
                  >
                    <optgroup label="Häufig">
                      {UPLOAD_MAIN.map((k) => (
                        <option value={k} selected={k === category}>
                          {k}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Weitere">
                      {DOC_CATEGORIES.filter((k) => !UPLOAD_MAIN.includes(k) && k !== DRAFT_CATEGORY).map(
                        (k) => (
                          <option value={k} selected={k === category}>
                            {k}
                          </option>
                        ),
                      )}
                    </optgroup>
                  </select>
                  <noscript>
                    <button class="btn sm sec">Wählen</button>
                  </noscript>
                </form>
                <FileArea
                  link={{ type: 'employee', id: e.id }}
                  files={[]}
                  category={category}
                  title={`${category} hierher ziehen`}
                  hint="Kategorie oben wechseln – die Seite bleibt hier."
                  maxBytes={env.UPLOAD_MAX_BYTES}
                />
              </div>
            </div>
            <div>
              <form method="post" action={`/personal/${e.id}/dokumente/vorlage`} class="card">
                <h3>Neu aus Vorlage</h3>
                <input type="hidden" name="file_id" value={randomUUID()} />
                <select name="vorlage" required aria-label="Vorlage">
                  {templates.map((t) => (
                    <option value={t.id}>
                      {t.title} ({t.category})
                    </option>
                  ))}
                </select>
                <div class="actions" style="margin-bottom:0">
                  <button class="btn sm" disabled={!templates.length}>
                    Erstellen und ablegen
                  </button>
                  <a class="small" href="/personal/vorlagen">
                    Vorlagen bearbeiten
                  </a>
                </div>
              </form>
              <WordTemplateBox
                templates={wordTemplates.filter((t) => !/^VD-ZV-Nachtrag/i.test(t.code ?? ''))}
                target={{ type: 'employee', id: e.id }}
                extra={
                  ['admin', 'personal'].includes(c.get('user').role)
                    ? [
                        {
                          label: 'Vertragsänderung',
                          href: `/personal/${e.id}/vertragsaenderung`,
                          hint: 'nur was sich ändert · bisher → neu',
                        },
                      ]
                    : []
                }
              />
              <div class="card">
                <h3>Zur Unterschrift (App)</h3>
                {signs.length === 0 && (
                  <div class="small mut">Keine Dokumente zur digitalen Unterschrift.</div>
                )}
                {signs.map((r) => (
                  <div class="small" style="padding:3px 0">
                    <a href={`/personal/dokumente/${r.document_id}`}>{r.title}</a> –{' '}
                    {r.status === 'unterschrieben'
                      ? `unterschrieben ${r.signed_at!.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })}`
                      : 'offen'}
                  </div>
                ))}
                <div class="small" style="margin-top:6px">
                  <a href="/personal/dokumente">Dokument zur Unterschrift verteilen →</a>
                </div>
              </div>
            </div>
          </div>
        </>
      );
    }),
  );

  // Pflichtunterlage für diese Person nicht nötig (z. B. hat keinen Schlüssel) bzw. wieder Pflicht
  app.post(`/personal/:id{${UUID}}/unterlage-noetig`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const doc = str(b, 'unterlage') ?? '';
    const needed = str(b, 'noetig') === '1';
    await setDocNotNeeded(sql, id, doc, !needed, c.get('actor'));
    const to = str(b, 'zurueck');
    return back(
      c,
      to && /^\/personal\/unterlagen(\?[\w=&%.-]*)?$/.test(to) ? to : `/personal/${id}/dokumente`,
      {
        ok: needed ? `${doc} ist wieder Pflicht.` : `${doc} für diese Person als „nicht nötig“ vermerkt.`,
      },
    );
  });

  app.post(`/personal/:id{${UUID}}/dokumente/archiv`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const link = { type: 'employee', id } as const;
    const aktion = str(b, 'aktion');
    const actor = c.get('actor');
    if (aktion === 'aeltere') {
      const k = str(b, 'kategorie') ?? '';
      const files = (await listFiles(sql, link)).filter((f) => !f.archived_at);
      const inCat = files.filter((f) =>
        k === 'Weitere'
          ? f.category && !DOC_CATEGORIES.includes(f.category)
          : k === 'Sonstiges'
            ? (f.category ?? 'Sonstiges') === 'Sonstiges'
            : f.category === k,
      );
      // listFiles ist nach Fertigstellung absteigend sortiert → die erste ist die neueste
      for (const f of inCat.slice(1)) await archiveLink(sql, link, f.id, true, actor);
      return back(c, `/personal/${id}/dokumente`, {
        ok: `${anz(Math.max(inCat.length - 1, 0), 'ältere Datei', 'ältere Dateien')} in „${k}“ ins Archiv gelegt.`,
      });
    }
    const fileId = str(b, 'file_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(fileId) || !['archivieren', 'zurueck', 'loeschen'].includes(aktion ?? ''))
      throw new BusinessError('Ungültige Anfrage');
    if (aktion === 'loeschen') {
      if (!['admin', 'personal'].includes(c.get('user').role))
        throw new BusinessError('Löschen dürfen nur Geschäftsführung und Personal');
      const gone = await unlinkFile(sql, link, fileId, actor);
      return back(c, `/personal/${id}/dokumente`, {
        ok: gone ? 'Dokument aus der Personalakte gelöscht.' : 'Keine Änderung.',
      });
    }
    const done = await archiveLink(sql, link, fileId, aktion === 'archivieren', actor);
    return back(c, `/personal/${id}/dokumente`, {
      ok: done
        ? aktion === 'archivieren'
          ? 'Ins Archiv gelegt – weiter abrufbar unter „Archiv“.'
          : 'Aus dem Archiv zurückgeholt.'
        : 'Keine Änderung.',
    });
  });

  app.post(`/personal/:id{${UUID}}/dokumente/vorlage`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const fileId = str(b, 'file_id') ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new BusinessError('Ungültige Anfrage');
    const f = await createFromTemplate(deps, cfg, fileId, str(b, 'vorlage') ?? '', id, c.get('actor'));
    return back(c, `/personal/${id}/dokumente`, { ok: `„${f.original_name}“ erstellt und abgelegt.` });
  });

  // ------------------------------------------------------------ Vertragsänderung (einfach)
  const ccInput = async (b: Body, e: Employee): Promise<ContractChangeInput> => {
    const n = (k: string) => {
      const v = str(b, k)?.replace(',', '.');
      if (!v) return null;
      const x = Number(v);
      if (!Number.isFinite(x) || x < 0 || x > 60) throw new BusinessError(`Ungültige Zahl: ${v}`);
      return Math.round(x * 100) / 100;
    };
    const model = str(b, 'pay_model');
    let pay: ContractChangeInput['pay'] = null;
    if (model === 'tarif') {
      const l = str(b, 'wage_level_id');
      if (!l) throw new BusinessError('Bitte den neuen Tariflohn wählen');
      pay = { model: 'tarif', levelId: l };
    } else if (model === 'individuell') {
      const w = parseEuro(str(b, 'wage') ?? '');
      if (w <= 0n) throw new BusinessError('Bitte den neuen Stundenlohn eintragen');
      pay = { model: 'individuell', wageCents: w };
    } else if (model === 'festgehalt') {
      const w = parseEuro(str(b, 'salary') ?? '');
      if (w <= 0n) throw new BusinessError('Bitte das neue Monatsgehalt eintragen');
      pay = { model: 'festgehalt', salaryCents: w };
    }
    const days = n('days');
    if (days != null && (days < 0.5 || days > 7)) throw new BusinessError('Arbeitstage: 0,5 bis 7');
    return {
      validFrom: str(b, 'valid_from') ?? '',
      contractDate: str(b, 'contract_date'),
      weeklyHours: n('hours'),
      daysPerWeek: days,
      pay,
      siteOld: str(b, 'site_old') ?? (await currentSites(sql, e.id)),
      siteNew: str(b, 'site_new'),
      taskOld: str(b, 'task_old'),
      taskNew: str(b, 'task_new'),
      other: str(b, 'other'),
      signDate: str(b, 'sign_date'),
    };
  };
  const ccGuard = (c: { get: (k: 'user') => { role: string } }) => {
    if (!['admin', 'personal'].includes(c.get('user').role))
      throw new BusinessError('Nur Geschäftsführung und Personal');
  };

  app.get(`/personal/:id{${UUID}}/vertragsaenderung`, (c) =>
    shells.employee!(c, 'dokumente', async (head) => {
      ccGuard(c);
      const full = await getEmployee(sql, head.id);
      if (!full) throw new BusinessError('Mitarbeiter nicht gefunden');
      const e = full.employee;
      const [levels, sites, oldPay] = await Promise.all([
        listWageLevels(sql),
        currentSites(sql, e.id),
        payText(sql, null, e),
      ]);
      const first = (() => {
        const t = todayBerlin();
        const [y, m] = t.split('-').map(Number) as [number, number];
        return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      })();
      const task = e.tags.filter((t) => !Object.values(EMPLOYMENT_TYPES).includes(t as never)).join(', ');
      return (
        <div class="card" style="max-width:860px">
          <h3 style="margin-top:0">Vertragsänderung</h3>
          <p class="small mut" style="margin-top:-4px">
            Nur eintragen, was sich ändert – leere Felder bleiben wie bisher. Im PDF stehen nur die geänderten
            Punkte (bisher → neu). Ausdrucken, beide unterschreiben, Scan unter Dokumente → „Vertragsänderung“
            hochladen.
          </p>
          <form method="post" action={`/personal/${e.id}/vertragsaenderung`} target="_blank">
            <div class="grid">
              <label for="cc-from">Gilt ab</label>
              <input id="cc-from" type="date" name="valid_from" value={first} required />
              <label for="cc-contract">Arbeitsvertrag vom</label>
              <input id="cc-contract" type="date" name="contract_date" value={e.entry_date} />
            </div>
            <table class="keep" style="margin-top:12px">
              <thead>
                <tr>
                  <th>Was ändert sich</th>
                  <th>Bisher</th>
                  <th>Neu</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <label for="cc-h">Wochenstunden</label>
                  </td>
                  <td>
                    {e.weekly_hours != null
                      ? `${String(Number(e.weekly_hours)).replace('.', ',')} Std.`
                      : '–'}
                  </td>
                  <td>
                    <input
                      id="cc-h"
                      name="hours"
                      inputmode="decimal"
                      placeholder="unverändert"
                      style="max-width:140px"
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label for="cc-d">Arbeitstage / Woche</label>
                  </td>
                  <td>{String(Number(e.days_per_week || 5)).replace('.', ',')} Tage</td>
                  <td>
                    <input
                      id="cc-d"
                      name="days"
                      inputmode="decimal"
                      placeholder="unverändert"
                      style="max-width:140px"
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label for="cc-pay">Vergütung</label>
                  </td>
                  <td>{oldPay}</td>
                  <td>
                    <select
                      id="cc-pay"
                      name="pay_model"
                      onchange="var v=this.value;document.querySelectorAll('[data-pay]').forEach(function(x){x.hidden=x.dataset.pay!==v})"
                    >
                      <option value="">unverändert</option>
                      <option value="tarif">Tariflohn …</option>
                      <option value="individuell">Stundenlohn …</option>
                      <option value="festgehalt">Festgehalt …</option>
                    </select>
                    <div data-pay="tarif" hidden style="margin-top:6px">
                      <select name="wage_level_id" aria-label="Tariflohn">
                        {levels.map((l) => (
                          <option value={l.id}>
                            {l.name} – {euro(BigInt(l.hourly_wage_cents))} / Std.
                          </option>
                        ))}
                      </select>
                    </div>
                    <div data-pay="individuell" hidden style="margin-top:6px">
                      <input
                        name="wage"
                        inputmode="decimal"
                        placeholder="z. B. 16,00"
                        aria-label="Stundenlohn"
                        style="max-width:140px"
                      />{' '}
                      € / Std.
                    </div>
                    <div data-pay="festgehalt" hidden style="margin-top:6px">
                      <input
                        name="salary"
                        inputmode="decimal"
                        placeholder="z. B. 2.500,00"
                        aria-label="Monatsgehalt"
                        style="max-width:140px"
                      />{' '}
                      € / Monat
                    </div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <label for="cc-s">Einsatzort / Objekt</label>
                  </td>
                  <td>
                    <input name="site_old" value={sites} aria-label="Einsatzort bisher" />
                  </td>
                  <td>
                    <input id="cc-s" name="site_new" placeholder="unverändert" />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label for="cc-t">Tätigkeit</label>
                  </td>
                  <td>
                    <input name="task_old" value={task || 'Reinigungskraft'} aria-label="Tätigkeit bisher" />
                  </td>
                  <td>
                    <input id="cc-t" name="task_new" placeholder="unverändert" />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label for="cc-o">Weitere Änderung</label>
                  </td>
                  <td class="mut small">frei</td>
                  <td>
                    <textarea
                      id="cc-o"
                      name="other"
                      rows={2}
                      placeholder="z. B. Arbeitszeit Mo–Fr 17:00–20:00 Uhr"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="grid" style="margin-top:12px">
              <label for="cc-sign">Datum der Unterschrift</label>
              <input id="cc-sign" type="date" name="sign_date" value={todayBerlin()} />
            </div>
            <p class="small mut">
              Schriftlich mit Unterschrift (nicht nur per E-Mail): In der Gebäudereinigung muss der Nachweis
              über geänderte Arbeitsbedingungen auf Papier erfolgen (§ 3, § 2 Abs. 1 NachwG i. V. m. § 2a
              SchwarzArbG), spätestens am Tag, ab dem die Änderung gilt.
            </p>
            <div class="formfoot">
              <button class="btn" name="aktion" value="pdf">
                PDF erstellen
              </button>
              <button class="btn sec" name="aktion" value="word" formtarget="_self">
                Als Word herunterladen
              </button>
              <button
                class="btn sec"
                name="aktion"
                value="uebernehmen"
                formtarget="_self"
                data-confirm="Änderung in die Stammdaten übernehmen? Stunden/Arbeitstage gelten ab dem Stichtag, die Vergütung ab heute bzw. als Aufgabe zum Stichtag."
              >
                In Stammdaten übernehmen
              </button>
              <a class="btn ghost" href={`/personal/${e.id}/dokumente`}>
                Zurück
              </a>
            </div>
          </form>
        </div>
      );
    }),
  );

  app.post(`/personal/:id{${UUID}}/vertragsaenderung`, async (c) => {
    ccGuard(c);
    const id = c.req.param('id');
    const e = await getEmployee(sql, id);
    if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
    const b = await c.req.parseBody({ all: true });
    const input = await ccInput(b, e.employee);
    if (str(b, 'aktion') === 'uebernehmen') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom))
        throw new BusinessError('Bitte angeben, ab wann die Änderung gilt');
      const { hints } = await contractChangeRows(sql, e.employee, input);
      const done = await applyContractChange(sql, id, input, c.get('actor'));
      return back(c, `/personal/${id}`, {
        ok: done.length
          ? `${done.join(' · ')}.${hints.length ? ` ${hints.join(' ')}` : ''}`
          : 'Nichts zu übernehmen (Stunden, Arbeitstage, Vergütung unverändert).',
      });
    }
    if (str(b, 'aktion') === 'word') {
      const { data, name } = await contractChangeDocx(sql, id, input);
      await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
                values (${c.get('actor')}, 'contract_change_docx', 'employee', ${id}, ${sql.json({ valid_from: input.validFrom })})`;
      return new Response(data, {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'content-disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`,
          'cache-control': 'no-store',
        },
      });
    }
    const { pdf, name } = await contractChangePdf(sql, id, input);
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${c.get('actor')}, 'contract_change_pdf', 'employee', ${id}, ${sql.json({ valid_from: input.validFrom })})`;
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${name}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // ------------------------------------------------------------ Serienbrief
  app.get('/personal/serienbrief.pdf', async (c) => {
    const status = c.req.query('status') ?? 'aktiv';
    const q = c.req.query('q')?.trim() || null;
    const tag = c.req.query('tag')?.trim() || null;
    const rows = await listEmployees(sql, {
      ...(status === 'aktiv' || status === 'ausgetreten' ? { status } : {}),
      ...(q ? { q } : {}),
      ...(tag ? { tag } : {}),
    });
    const pdf = await serialLetter(
      deps,
      c.req.query('vorlage') ?? '',
      rows.map((r) => r.id),
    );
    await sql`insert into app.audit_log (actor, action, entity, details)
              values (${c.get('actor')}, 'serial_letter', 'employees', ${sql.json({ count: rows.length, tag, status })})`;
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Serienbrief_${todayBerlin()}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // ------------------------------------------------------------ Einsatzkalender
  app.get(`/personal/:id{${UUID}}/kalender`, (c) =>
    shells.employee!(c, 'kalender', async (e) => {
      const role = c.get('user').role;
      const d = await employeeCalendarData(sql, e.id, c.req.query(), { siteScope: c.get('sites') });
      return (
        <EmployeeCalendarView
          employeeId={e.id}
          today={todayBerlin()}
          holiday={holidayName}
          canEdit={['admin', 'personal', 'objektleitung'].includes(role)}
          canDeleteTime={['admin', 'personal'].includes(role)}
          confirmAction="/zeiterfassung/plan-als-ist"
          {...d}
        />
      );
    }),
  );

  // ------------------------------------------------------------ Lohnstufen
  app.get('/personal/lohnstufen', async (c) => {
    const levels = await listWageLevels(sql, true);
    return page(
      c,
      'Tariflöhne',
      'personal',
      <>
        <PageHead title="Tariflöhne" crumbs={[['Einstellungen', '/einstellungen']]} />
        <p class="mut" style="max-width:820px">
          Stundenlohn je Lohngruppe (Tarifvertrag Gebäudereinigung). Bei jedem Mitarbeiter wird unter
          „Vergütung“ ein Tariflohn, ein individueller Stundenlohn oder ein Festgehalt gewählt. Eine Änderung
          hier gilt sofort für alle Mitarbeitenden der Lohngruppe (Nachkalkulation, Mindestlohn-Prüfung) – bei
          Tariferhöhung „gültig ab“ eintragen.
        </p>
        <div class="tbl" style="max-width:900px">
          <table>
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th class="r">€/Std.</th>
                <th>gültig ab</th>
                <th class="r">Mitarbeitende</th>
                <th>aktiv</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...levels, null].map((w) => {
                const wid = w?.id ?? randomUUID();
                const f = `wl-${wid.slice(0, 8)}`;
                return (
                  <tr>
                    <td>
                      <form id={f} method="post" action={`/personal/lohnstufen/${wid}`}></form>
                      <input type="hidden" form={f} name="version" value={String(w?.version ?? '')} />
                      <input
                        form={f}
                        name="name"
                        value={w?.name ?? ''}
                        placeholder="neue Lohngruppe, z. B. Tariflohn 2"
                        aria-label="Bezeichnung"
                      />
                    </td>
                    <td style="width:120px">
                      <input
                        form={f}
                        name="wage"
                        class="right"
                        value={w ? centsToInput(w.hourly_wage_cents) : ''}
                        placeholder="14,25"
                        aria-label="Stundenlohn"
                      />
                    </td>
                    <td style="width:160px">
                      <input
                        form={f}
                        type="date"
                        name="valid_from"
                        value={w?.valid_from ?? ''}
                        aria-label="gültig ab"
                      />
                    </td>
                    <td class="r">{w?.employees ?? ''}</td>
                    <td style="width:60px">
                      <input
                        type="checkbox"
                        form={f}
                        name="active"
                        checked={w ? w.active : true}
                        aria-label="aktiv"
                      />
                    </td>
                    <td style="width:110px">
                      <button class="btn sm sec" form={f}>
                        {w ? 'Speichern' : 'Anlegen'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {levels.length > 0 && (
          <p class="small mut">
            Aktuell niedrigste Stufe:{' '}
            {euro(
              levels.reduce(
                (a, w) => (w.hourly_wage_cents < a ? w.hourly_wage_cents : a),
                levels[0]!.hourly_wage_cents,
              ),
            )}{' '}
            – mit dem Branchen-Mindestlohn abgleichen.
          </p>
        )}
      </>,
    );
  });

  app.post(`/personal/lohnstufen/:wid{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    let cents: bigint;
    try {
      cents = parseEuro(str(b, 'wage') ?? '');
    } catch {
      throw new BusinessError('Stundenlohn bitte als Betrag, z. B. 14,25');
    }
    await saveWageLevel(sql, c.req.param('wid'), {
      name: str(b, 'name') ?? '',
      wageCents: cents,
      validFrom: str(b, 'valid_from'),
      note: null,
      active: b.active === 'on',
      expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
    });
    return back(c, '/personal/lohnstufen', { ok: 'Tariflohn gespeichert.' });
  });

  // ------------------------------------------------------------ Dokumentvorlagen
  app.get('/personal/vorlagen', async (c) => {
    const list = await listTemplates(sql, true);
    const editId = c.req.query('bearbeiten');
    const t = list.find((x) => x.id === editId) ?? null;
    const formId = t?.id ?? randomUUID();
    return page(
      c,
      'Dokumentvorlagen',
      'personal',
      <>
        <PageHead title="Dokumentvorlagen" crumbs={[['Mitarbeiter', '/personal']]} />
        <div class="cols">
          <div class="card">
            <h3>Vorlagen</h3>
            {list.map((x) => (
              <div style="padding:4px 0;border-bottom:1px solid var(--line)">
                <a href={`/personal/vorlagen?bearbeiten=${x.id}`}>{x.title}</a>{' '}
                <span class="small mut">
                  {x.category}
                  {!x.active && ' · inaktiv'}
                </span>
              </div>
            ))}
            <p class="small mut">
              Kündigungen, Aufhebungsverträge und Befristungen brauchen die Schriftform: ausdrucken und
              eigenhändig unterschreiben – nicht per App oder E-Mail.
            </p>
          </div>
          <form
            method="post"
            action={`/personal/vorlagen/${formId}`}
            class="card"
            data-version={String(t?.version ?? '')}
          >
            <h3 style="margin-top:0">{t ? `„${t.title}“ bearbeiten` : 'Neue Vorlage'}</h3>
            <input type="hidden" name="version" value={String(t?.version ?? '')} />
            <label for="title">Titel (Betreff)</label>
            <input id="title" name="title" value={t?.title ?? ''} required />
            <label for="category">Kategorie</label>
            <select id="category" name="category">
              {DOC_CATEGORIES.map((k) => (
                <option value={k} selected={k === (t?.category ?? 'Sonstiges')}>
                  {k}
                </option>
              ))}
            </select>
            <label for="body">
              Text (Anrede und Gruß werden automatisch gesetzt; Leerzeile = neuer Absatz)
            </label>
            <textarea id="body" name="body" rows={12} required>
              {t?.body ?? ''}
            </textarea>
            <p class="small mut">
              Platzhalter:{' '}
              {TEMPLATE_FIELDS.map(([k, v]) => (
                <span title={v} style="margin-right:6px">
                  <code>{`{{${k}}}`}</code>
                </span>
              ))}
            </p>
            <div class="chk">
              <input type="checkbox" id="active" name="active" checked={t ? t.active : true} />
              <label for="active">aktiv</label>
            </div>
            <div class="formfoot">
              {t && (
                <a class="btn sec" href="/personal/vorlagen">
                  Neue Vorlage
                </a>
              )}
              <button class="btn">Speichern</button>
            </div>
          </form>
        </div>
      </>,
    );
  });

  app.post(`/personal/vorlagen/:tid{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const cat = str(b, 'category') ?? 'Sonstiges';
    await saveTemplate(sql, c.req.param('tid'), {
      title: str(b, 'title') ?? '',
      category: DOC_CATEGORIES.includes(cat) ? cat : 'Sonstiges',
      body: typeof b.body === 'string' ? b.body : '',
      active: b.active === 'on',
      expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
    });
    return back(c, `/personal/vorlagen?bearbeiten=${c.req.param('tid')}`, { ok: 'Vorlage gespeichert.' });
  });
}
