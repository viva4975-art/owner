import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { BusinessError } from '../services/errors.js';
import { employeesOfSites } from '../services/first-aid.js';
import {
  FIELD_TYPES,
  TARGET_LABEL,
  cleanSchema,
  getFormTemplate,
  listFormTemplates,
  listSubmissions,
  normalizePhoto,
  saveFormTemplate,
  submitForm,
  type Answers,
  type FormField,
} from '../services/forms.js';
import type { AppEnv, Ctx } from './app.js';
import { UUID, assertSite } from './app.js';
import { Icon } from './icons.js';
import { PageHead } from './layout.js';
import { uploadConfig } from './routes-files.js';

/*
 * Formular-Baukasten (Ahmed 13.11., Vorbild Blink Check). Vorlagen pflegt das Büro (Admin, Buchhaltung, Personal),
 * ausfüllen dürfen alle Büro-Rollen und die Objektleitung (nur ihre Objekte bzw. ihre Leute).
 */

const OFFICE = ['admin', 'buchhaltung', 'personal'];
const ICON: Record<string, string> = { mitarbeiter: 'users', objekt: 'building', keins: 'form' };

// Editor: Seiten und Felder im Browser bearbeiten, beim Speichern als JSON senden
const EDITOR_JS = `
(function(){
  var root=document.getElementById('fb'), out=document.getElementById('fb-schema'), data=JSON.parse(document.getElementById('fb-data').textContent);
  var TYPES=JSON.parse(document.getElementById('fb-types').textContent);
  function el(t,a,c){var e=document.createElement(t);for(var k in a||{}){if(k==='text')e.textContent=a[k];else if(k==='cls')e.className=a[k];else e.setAttribute(k,a[k]);}(c||[]).forEach(function(x){e.appendChild(x)});return e}
  function render(){root.innerHTML='';data.pages.forEach(function(p,pi){
    var head=el('div',{cls:'fb-ph'});var title=el('input',{value:p.title||'','aria-label':'Seitentitel',placeholder:'Seitentitel'});title.oninput=function(){p.title=title.value};
    var up=el('button',{type:'button',cls:'btn sm ghost',title:'Seite nach oben',text:'↑'});up.onclick=function(){if(pi>0){data.pages.splice(pi-1,0,data.pages.splice(pi,1)[0]);render()}};
    var del=el('button',{type:'button',cls:'btn sm ghost danger',title:'Seite löschen',text:'Seite löschen'});del.onclick=function(){if(confirm('Seite mit allen Feldern löschen?')){data.pages.splice(pi,1);render()}};
    head.appendChild(el('span',{cls:'fb-pn',text:'Seite '+(pi+1)}));head.appendChild(title);head.appendChild(up);head.appendChild(del);
    var box=el('div',{cls:'card fb-page'},[head]);
    p.fields.forEach(function(f,fi){
      var row=el('div',{cls:'fb-row'});
      var lab=el('input',{value:f.label||'',placeholder:'Frage / Bezeichnung','aria-label':'Bezeichnung'});lab.oninput=function(){f.label=lab.value};
      var ty=el('select',{'aria-label':'Feldart'});Object.keys(TYPES).forEach(function(k){var o=el('option',{value:k,text:TYPES[k]});if(k===f.type)o.selected=true;ty.appendChild(o)});
      var opts=el('textarea',{rows:'2',placeholder:'Auswahlmöglichkeiten – eine je Zeile','aria-label':'Auswahlmöglichkeiten'});opts.value=(f.options||[]).join('\\n');opts.oninput=function(){f.options=opts.value.split('\\n')};
      function showOpts(){opts.hidden=!(f.type==='select'||f.type==='multi')}
      ty.onchange=function(){f.type=ty.value;showOpts();req.parentNode.hidden=f.type==='info'};showOpts();
      var req=el('input',{type:'checkbox'});req.checked=!!f.required;req.onchange=function(){f.required=req.checked};
      var reqL=el('label',{cls:'chk fb-req'},[req,document.createTextNode(' Pflicht')]);reqL.hidden=f.type==='info';
      var u=el('button',{type:'button',cls:'btn sm ghost',title:'nach oben',text:'↑'});u.onclick=function(){if(fi>0){p.fields.splice(fi-1,0,p.fields.splice(fi,1)[0]);render()}};
      var x=el('button',{type:'button',cls:'btn sm ghost danger',title:'Feld löschen',text:'×'});x.onclick=function(){p.fields.splice(fi,1);render()};
      row.appendChild(el('span',{cls:'fb-drag',text:'⋮⋮'}));row.appendChild(el('div',{cls:'fb-main'},[lab,opts]));row.appendChild(ty);row.appendChild(reqL);row.appendChild(u);row.appendChild(x);
      box.appendChild(row);
    });
    var add=el('button',{type:'button',cls:'btn sm sec',text:'+ Feld'});add.onclick=function(){p.fields.push({type:'text',label:''});render();var ins=root.querySelectorAll('.fb-page')[pi].querySelectorAll('.fb-main input');ins[ins.length-1].focus()};
    box.appendChild(add);root.appendChild(box);
  });}
  document.getElementById('fb-addpage').onclick=function(){data.pages.push({title:'',fields:[{type:'text',label:''}]});render()};
  root.closest('form').addEventListener('submit',function(){out.value=JSON.stringify(data)},true);
  render();
})();`;

// Ausfüllen: mehrere Unterschriftsfelder, Fotos vorab verkleinern
const FILL_JS = `
(function(){
  document.querySelectorAll('canvas.ff-sig').forEach(function(c){
    var ctx=c.getContext('2d'),drawn=false,last=null,inp=document.getElementById(c.dataset.target);
    function size(){var r=c.getBoundingClientRect(),d=window.devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;ctx.setTransform(d,0,0,d,0,0);ctx.lineWidth=2.4;ctx.lineCap='round';ctx.strokeStyle='#111'}
    size();
    function pos(e){var r=c.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}
    c.addEventListener('pointerdown',function(e){e.preventDefault();c.setPointerCapture(e.pointerId);last=pos(e);drawn=true});
    c.addEventListener('pointermove',function(e){if(!last)return;var p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p});
    ['pointerup','pointercancel','pointerleave'].forEach(function(t){c.addEventListener(t,function(){last=null;if(drawn)inp.value=c.toDataURL('image/png')})});
    var clr=document.querySelector('[data-clear="'+c.id+'"]');if(clr)clr.onclick=function(){ctx.clearRect(0,0,c.width,c.height);drawn=false;inp.value=''};
  });
})();`;

export function registerFormRoutes(ctx: Ctx) {
  const { app, deps, page, back } = ctx;
  const { sql } = deps;
  const cfg = uploadConfig(ctx);
  const isOffice = (c: Context<AppEnv>) => OFFICE.includes(c.get('user').role);
  const assertOffice = (c: Context<AppEnv>) => {
    if (!isOffice(c)) throw new BusinessError('Vorlagen pflegt das Büro');
  };

  app.get('/formulare', async (c) => {
    const office = isOffice(c);
    const [tpls, subs] = await Promise.all([
      listFormTemplates(sql, office),
      listSubmissions(sql, { limit: 30 }),
    ]);
    const mine = office ? subs : subs.filter((s) => s.created_by === c.get('actor'));
    return page(
      c,
      'Formulare',
      'formulare',
      <>
        <PageHead title="Formulare">
          {office && (
            <a class="btn" href={`/formulare/${randomUUID()}/bearbeiten`}>
              + Formularvorlage
            </a>
          )}
        </PageHead>
        <p class="mut small" style="max-width:760px;margin-top:0">
          Eigene Formulare zum Ausfüllen am PC oder Handy – z. B. Führerscheinkontrolle, Objektbegehung,
          Umfragen. Das Ergebnis wird als PDF in der Akte des Mitarbeiters bzw. beim Objekt abgelegt. Feste
          Abläufe (Arbeitsschein, Qualitätskontrolle, Übergaben, Unterweisungen, Personalbogen) bleiben, wo
          sie sind.
        </p>
        <div class="card fb-list">
          {tpls.map((t) => (
            <div class={`fb-item${t.active ? '' : ' off'}`}>
              <span class="ib-dot" style="background:#F7EDF1;color:#811D40">
                <Icon name={ICON[t.target] ?? 'form'} size={17} />
              </span>
              <div style="flex:1;min-width:0">
                <a class="ib-title" href={`/formulare/${t.id}/ausfuellen`}>
                  {t.name}
                </a>
                <div class="ib-sub">
                  <span>{TARGET_LABEL[t.target]}</span>
                  <span>
                    {t.schema.pages.reduce((a, p) => a + p.fields.length, 0)} Felder ·{' '}
                    {t.n === 1 ? '1 Eintrag' : `${t.n} Einträge`}
                  </span>
                  {!t.active && <span class="ib-tag">inaktiv</span>}
                </div>
              </div>
              <div class="ib-act">
                <a class="btn sm" href={`/formulare/${t.id}/ausfuellen`}>
                  Ausfüllen
                </a>
                {office && (
                  <a class="btn sm sec" href={`/formulare/${t.id}/bearbeiten`}>
                    Bearbeiten
                  </a>
                )}
                {office && (
                  <form method="post" action={`/formulare/${t.id}/kopieren`}>
                    <input type="hidden" name="new_id" value={randomUUID()} />
                    <button class="btn sm ghost" title="Als neue Vorlage kopieren">
                      Kopieren
                    </button>
                  </form>
                )}
              </div>
            </div>
          ))}
        </div>
        <div class="card" style="margin-top:16px">
          <h2 style="margin-top:0">Zuletzt ausgefüllt</h2>
          {mine.length === 0 ? (
            <div class="empty">Noch nichts ausgefüllt.</div>
          ) : (
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Formular</th>
                    <th>Mitarbeiter / Objekt</th>
                    <th>von</th>
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((s) => (
                    <tr>
                      <td>{s.created_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}</td>
                      <td>{s.template_name}</td>
                      <td>{s.employee_name ?? s.site_name ?? '–'}</td>
                      <td class="small">{s.created_by}</td>
                      <td>
                        {s.file_id ? (
                          <a href={`/dateien/${s.file_id}`} target="_blank">
                            PDF
                          </a>
                        ) : (
                          '–'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>,
    );
  });

  app.get(`/formulare/:id{${UUID}}/bearbeiten`, async (c) => {
    assertOffice(c);
    const id = c.req.param('id');
    const t = await getFormTemplate(sql, id);
    const schema = t?.schema ?? { pages: [{ title: 'Seite 1', fields: [{ type: 'text', label: '' }] }] };
    return page(
      c,
      t ? `Formular: ${t.name}` : 'Neue Formularvorlage',
      'formulare',
      <>
        <PageHead title={t ? t.name : 'Neue Formularvorlage'} crumbs={[['Formulare', '/formulare']]} />
        <form method="post" action={`/formulare/${id}`} class="fb-form" data-noskip>
          <input type="hidden" name="version" value={String(t?.version ?? '')} />
          <input type="hidden" name="schema" id="fb-schema" />
          <div class="card">
            <div class="grid">
              <div>
                <label for="name">Name *</label>
                <input id="name" name="name" value={t?.name ?? ''} required maxlength={80} />
              </div>
              <div>
                <label for="target">Ausgefüllt für</label>
                <select id="target" name="target">
                  {Object.entries(TARGET_LABEL).map(([k, v]) => (
                    <option value={k} selected={(t?.target ?? 'mitarbeiter') === k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="file_category">Ablage in der Akte (Kategorie)</label>
                <input
                  id="file_category"
                  name="file_category"
                  value={t?.file_category ?? ''}
                  placeholder="z. B. Personalunterlagen, Protokolle"
                  list="fb-cats"
                />
                <datalist id="fb-cats">
                  {['Personalunterlagen', 'Unterweisung', 'Protokolle', 'Sonstiges'].map((x) => (
                    <option value={x} />
                  ))}
                </datalist>
              </div>
              <div style="grid-column:1/-1">
                <label for="description">Kurzbeschreibung</label>
                <input id="description" name="description" value={t?.description ?? ''} maxlength={500} />
              </div>
            </div>
            <label class="chk" style="margin-top:8px">
              <input type="checkbox" name="active" checked={t ? t.active : true} /> aktiv (zum Ausfüllen
              angeboten)
            </label>
          </div>
          <div id="fb" />
          <div class="actions">
            <button type="button" class="btn sec" id="fb-addpage">
              + Seite
            </button>
          </div>
          <div class="formfoot">
            <a class="btn sec" href="/formulare">
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
          <script
            type="application/json"
            id="fb-data"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}
          />
          <script
            type="application/json"
            id="fb-types"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(FIELD_TYPES) }}
          />
        </form>
        <script dangerouslySetInnerHTML={{ __html: EDITOR_JS }} />
      </>,
    );
  });

  app.post(`/formulare/:id{${UUID}}`, async (c) => {
    assertOffice(c);
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    let raw: unknown;
    try {
      raw = JSON.parse(String(b.schema ?? ''));
    } catch {
      throw new BusinessError('Formular konnte nicht gelesen werden – bitte neu laden');
    }
    await saveFormTemplate(
      sql,
      id,
      {
        name: String(b.name ?? ''),
        description: typeof b.description === 'string' ? b.description : null,
        target: String(b.target ?? 'keins'),
        fileCategory: typeof b.file_category === 'string' ? b.file_category : null,
        schema: cleanSchema(raw),
        active: b.active === 'on',
        expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
      },
      c.get('actor'),
    );
    return back(c, '/formulare', { ok: 'Vorlage gespeichert.' });
  });

  app.post(`/formulare/:id{${UUID}}/kopieren`, async (c) => {
    assertOffice(c);
    const t = await getFormTemplate(sql, c.req.param('id'));
    if (!t) return c.notFound();
    const b = await c.req.parseBody();
    const nid = /^[0-9a-f-]{36}$/.test(String(b.new_id)) ? String(b.new_id) : randomUUID();
    await saveFormTemplate(
      sql,
      nid,
      {
        name: `${t.name} (Kopie)`.slice(0, 80),
        description: t.description,
        target: t.target,
        fileCategory: t.file_category,
        schema: t.schema,
        active: true,
        expectedVersion: null,
      },
      c.get('actor'),
    );
    return c.redirect(`/formulare/${nid}/bearbeiten`, 303);
  });

  // ---- Ausfüllen
  app.get(`/formulare/:id{${UUID}}/ausfuellen`, async (c) => {
    const t = await getFormTemplate(sql, c.req.param('id'));
    if (!t || !t.active) return c.notFound();
    const scope = c.get('sites');
    const emps =
      t.target === 'mitarbeiter'
        ? scope
          ? (await employeesOfSites(sql, scope)).map((e) => ({ id: e.id, label: `${e.name}` }))
          : (
              await sql<{ id: string; label: string }[]>`
                select id, last_name || ', ' || first_name || ' (' || personnel_no || ')' as label
                  from app.employees where status = 'aktiv' order by last_name, first_name`
            ).map((e) => e)
        : [];
    const sites =
      t.target === 'objekt'
        ? await sql<{ id: string; label: string }[]>`
            select id, name || ' (' || site_no || ')' as label from app.sites
             where active and ${scope ? sql`id = any(${scope}::uuid[])` : sql`true`} order by name`
        : [];
    const pre = { m: c.req.query('mitarbeiter') ?? '', o: c.req.query('objekt') ?? '' };
    const field = (f: FormField) => {
      const name = `f_${f.id}`;
      const req = !!f.required;
      const lab = (
        <label for={name}>
          {f.label}
          {req ? ' *' : ''}
        </label>
      );
      switch (f.type) {
        case 'info':
          return <p class="ff-info">{f.label}</p>;
        case 'textarea':
          return (
            <div class="ff">
              {lab}
              <textarea id={name} name={name} rows={3} required={req} maxlength={2000} />
            </div>
          );
        case 'number':
          return (
            <div class="ff">
              {lab}
              <input id={name} name={name} inputmode="decimal" required={req} maxlength={30} />
            </div>
          );
        case 'date':
          return (
            <div class="ff">
              {lab}
              <input id={name} type="date" name={name} required={req} />
            </div>
          );
        case 'select':
          return (
            <div class="ff">
              {lab}
              <select id={name} name={name} required={req}>
                <option value="">– bitte wählen –</option>
                {(f.options ?? []).map((o) => (
                  <option value={o}>{o}</option>
                ))}
              </select>
            </div>
          );
        case 'multi':
          return (
            <div class="ff">
              <div class="ff-l">
                {f.label}
                {req ? ' *' : ''}
              </div>
              <div class="ff-opts">
                {(f.options ?? []).map((o) => (
                  <label class="chk">
                    <input type="checkbox" name={name} value={o} /> {o}
                  </label>
                ))}
              </div>
            </div>
          );
        case 'yesno':
          return (
            <div class="ff">
              <div class="ff-l">
                {f.label}
                {req ? ' *' : ''}
              </div>
              <div class="ff-opts">
                <label class="chk">
                  <input type="radio" name={name} value="ja" required={req} /> Ja
                </label>
                <label class="chk">
                  <input type="radio" name={name} value="nein" /> Nein
                </label>
              </div>
            </div>
          );
        case 'check':
          return (
            <label class="chk ff">
              <input type="checkbox" name={name} value="1" required={req} /> {f.label}
            </label>
          );
        case 'photo':
          return (
            <div class="ff">
              {lab}
              <input
                id={name}
                type="file"
                name={`p_${f.id}`}
                accept="image/*"
                capture="environment"
                multiple
              />
            </div>
          );
        case 'signature':
          return (
            <div class="ff">
              <div class="ff-l">
                {f.label}
                {req ? ' *' : ''}
              </div>
              <canvas id={`sig_${f.id}`} class="ff-sig" data-target={`s_${f.id}`} />
              <input type="hidden" id={`s_${f.id}`} name={`s_${f.id}`} />
              <button type="button" class="btn sm ghost" data-clear={`sig_${f.id}`}>
                Unterschrift löschen
              </button>
            </div>
          );
        default:
          return (
            <div class="ff">
              {lab}
              <input id={name} name={name} required={req} maxlength={300} />
            </div>
          );
      }
    };
    return page(
      c,
      t.name,
      'formulare',
      <>
        <PageHead title={t.name} crumbs={[['Formulare', '/formulare']]} />
        {t.description && (
          <p class="mut" style="margin-top:0">
            {t.description}
          </p>
        )}
        <form
          method="post"
          action={`/formulare/${t.id}/ausfuellen`}
          enctype="multipart/form-data"
          class="ff-form"
          data-noskip
        >
          <input type="hidden" name="sub_id" value={randomUUID()} />
          {t.target !== 'keins' && (
            <div class="card">
              {t.target === 'mitarbeiter' ? (
                <>
                  <label for="employee_id">Mitarbeiter/in *</label>
                  <select id="employee_id" name="employee_id" required>
                    <option value="">– bitte wählen –</option>
                    {emps.map((e) => (
                      <option value={e.id} selected={e.id === pre.m}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label for="site_id">Objekt *</label>
                  <select id="site_id" name="site_id" required>
                    <option value="">– bitte wählen –</option>
                    {sites.map((s) => (
                      <option value={s.id} selected={s.id === pre.o}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          {t.schema.pages.map((p, i) => (
            <div class="card ff-page">
              <h2 style="margin-top:0">
                {t.schema.pages.length > 1 && <span class="mut">{i + 1} · </span>}
                {p.title}
              </h2>
              {p.fields.map(field)}
            </div>
          ))}
          <div class="formfoot">
            <a class="btn sec" href="/formulare">
              Abbrechen
            </a>
            <button class="btn">Speichern & PDF ablegen</button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: FILL_JS }} />
      </>,
    );
  });

  app.post(`/formulare/:id{${UUID}}/ausfuellen`, async (c) => {
    const t = await getFormTemplate(sql, c.req.param('id'));
    if (!t || !t.active) return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const answers: Answers = {};
    const photos: Record<string, Uint8Array[]> = {};
    const sigs: Record<string, Uint8Array> = {};
    for (const p of t.schema.pages)
      for (const f of p.fields) {
        if (f.type === 'photo') {
          const v = b[`p_${f.id}`];
          const files = (Array.isArray(v) ? v : [v]).filter(
            (x): x is File =>
              typeof x === 'object' && x !== null && 'arrayBuffer' in x && (x as File).size > 0,
          );
          if (files.length > 10) throw new BusinessError(`„${f.label}“: höchstens 10 Fotos`);
          photos[f.id] = await Promise.all(
            files.map(async (x) => normalizePhoto(new Uint8Array(await x.arrayBuffer()))),
          );
        } else if (f.type === 'signature') {
          const v = String(b[`s_${f.id}`] ?? '');
          const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(v);
          if (m) sigs[f.id] = new Uint8Array(Buffer.from(m[1]!, 'base64'));
        } else if (f.type !== 'info') {
          const v = b[`f_${f.id}`];
          answers[f.id] =
            f.type === 'multi'
              ? (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).slice(0, 100))
              : String(Array.isArray(v) ? v[0] : (v ?? '')).slice(0, 2000);
        }
      }
    const employeeId = t.target === 'mitarbeiter' ? String(b.employee_id ?? '') || null : null;
    const siteId = t.target === 'objekt' ? String(b.site_id ?? '') || null : null;
    if (siteId) assertSite(c, siteId);
    if (employeeId && c.get('sites')) {
      const ok = (await employeesOfSites(sql, c.get('sites'))).some((e) => e.id === employeeId);
      if (!ok) throw new BusinessError('Kein Zugriff auf diese Person');
    }
    const sid = /^[0-9a-f-]{36}$/.test(String(b.sub_id)) ? String(b.sub_id) : randomUUID();
    await submitForm(
      sql,
      cfg,
      {
        id: sid,
        template: t,
        employeeId,
        siteId,
        answers,
        photos,
        sigs,
        filledBy: c.get('user').name || c.get('actor'),
      },
      c.get('actor'),
    );
    return back(c, '/formulare', { ok: `„${t.name}“ gespeichert – PDF liegt in der Akte.` });
  });
}
