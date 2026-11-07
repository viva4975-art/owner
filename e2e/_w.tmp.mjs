import { chromium } from 'playwright-core';
const B='http://127.0.0.1:3002';
const auth={Authorization:`Basic ${Buffer.from('ahmed:prototyp2026').toString('base64')}`};
const pages=['/lieferanten/00000000-0000-4000-8000-000000000221','/einsatzplanung/e1ef1c99-618f-415b-ac79-58156eb899da','/einstellungen/email','/einstellungen/rechte','/einstellungen/objektordner/aushaenge','/objekte/00000000-0000-4000-8000-000000000011/einsaetze','/objekte/00000000-0000-4000-8000-000000000011/stundenvorgabe','/mahnungen/b0a17246-a033-408d-b0fa-5a448caf5e89','/personal/b2e20e11-dbb1-4884-bb7e-45774819be88/zeiten','/personal/lohnabrechnungen/mail-vorschau','/rechnungen/kuerzungen'];
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const ctx = await b.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, extraHTTPHeaders:auth });
const p = await ctx.newPage();
for (const u of pages) {
await p.goto(B+u,{waitUntil:'networkidle'});
const r = await p.evaluate(()=>{const out=[];for(const el of document.querySelectorAll('main *, .mainc *')){const r=el.getBoundingClientRect();if(r.right<=392||r.width>3000)continue;let sc=false;for(let q=el.parentElement;q;q=q.parentElement){const ox=getComputedStyle(q).overflowX;if(ox==='auto'||ox==='scroll'||ox==='hidden'){sc=true;break}}if(sc)continue;const par=el.parentElement;const pr=par&&par.getBoundingClientRect();if(pr&&pr.right>392)continue;out.push(el.tagName.toLowerCase()+'.'+[...el.classList].join('.')+' w'+Math.round(r.width)+' "'+(el.innerText||'').slice(0,40).replace(/\s+/g,' ')+'"')}return [innerWidth,out.slice(0,3)]});
console.log(u.slice(0,60), JSON.stringify(r));
}
await b.close();
