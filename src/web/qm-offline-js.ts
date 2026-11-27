/** Browser-Teil der Offline-Qualitätskontrolle (`/qm/offline`): IndexedDB, Ansichten, Fotos, Übertragung. */
/** Gemeinsamer Teil (IndexedDB, Objekt-Pakete, Übertragung) für die Offline-Seite und die normalen QM-Seiten. */
export const QM_OFF_CORE = String.raw`var $=function(s){return document.querySelector(s)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function uuid(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=[].map.call(b,function(x){return(x+256).toString(16).slice(1)}).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function de(iso){if(!iso)return'';var d=new Date(iso);return d.toLocaleDateString('de-DE')+' '+d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}
var DB;function db(){return DB||(DB=new Promise(function(res,rej){var o=indexedDB.open('viva-qm-offline',1);o.onupgradeneeded=function(){var d=o.result;d.createObjectStore('pkg',{keyPath:'id'});d.createObjectStore('audits',{keyPath:'id'});var p=d.createObjectStore('photos',{keyPath:'id'});p.createIndex('audit','auditId')};o.onsuccess=function(){res(o.result)};o.onerror=function(){rej(o.error)}}))}
function st(store,mode,fn){return db().then(function(d){return new Promise(function(res,rej){var t=d.transaction(store,mode);var q=fn(t.objectStore(store));t.oncomplete=function(){res(q&&'result'in q?q.result:undefined)};t.onerror=function(){rej(t.error)};t.onabort=function(){rej(t.error||new Error('Speicher voll?'))}})})}
var get=function(s,k){return st(s,'readonly',function(o){return o.get(k)})};
var all=function(s){return st(s,'readonly',function(o){return o.getAll()})};
var put=function(s,v){return st(s,'readwrite',function(o){return o.put(v)})};
var del=function(s,k){return st(s,'readwrite',function(o){return o.delete(k)})};
var photosOf=function(aid){return st('photos','readonly',function(o){return o.index('audit').getAll(aid)})};
function json(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')<0)throw new Error('Bitte in der App neu anmelden (Sitzung abgelaufen). Die Daten bleiben auf dem Handy.');return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||('Fehler '+r.status));return j})}
function loadPkg(id){return fetch('/qm/offline/paket/'+id,{credentials:'same-origin'}).then(json).then(function(p){p.id=p.site.id;return put('pkg',p)})}
var SYNCING=false;
function syncAll(){if(SYNCING||!navigator.onLine)return Promise.resolve(null);SYNCING=true;var done=0,errs=0;
  return all('audits').then(function(list){return list.reduce(function(pr,a){return pr.then(function(){return syncAudit(a).then(function(n){done+=n},function(e){errs++;a.error=e.message||String(e);return put('audits',a)})})},Promise.resolve())})
  .then(function(){return cleanMirrors()}).then(function(){SYNCING=false;return{done:done,errs:errs}},function(e){SYNCING=false;throw e})}
// nur online angesehene Audits (Spiegel ohne eigene Räume) nach einem Tag vom Handy entfernen
function cleanMirrors(){return all('audits').then(function(list){var old=Date.now()-86400000;return Promise.all(list.filter(function(a){return a.mirror&&a.created&&!Object.keys(a.rooms||{}).length&&Date.parse(a.seenAt||a.started)<old}).map(function(a){return del('audits',a.id)}))})}
function hdr(){return{'X-Offline-Sync':'1'}}
function syncAudit(a){var rooms=pendingRooms(a);if(!rooms.length&&a.created)return Promise.resolve(0);if(!rooms.length&&!Object.keys(a.rooms).length)return Promise.resolve(0);
  var p=Promise.resolve();
  if(!a.created){p=p.then(function(){var fd=new FormData();fd.append('id',a.id);fd.append('site_id',a.siteId);fd.append('datum',a.date);return fetch('/qm/audit/neu',{method:'POST',body:fd,headers:hdr(),credentials:'same-origin'}).then(json).then(function(){a.created=true;a.error='';return put('audits',a)})})}
  var n=0;
  rooms.forEach(function(rid){p=p.then(function(){return photosOf(a.id).then(function(ps){ps=ps.filter(function(x){return x.roomId===rid});var rr=a.rooms[rid];var fd=new FormData();
    Object.keys(rr.r).forEach(function(iid){var x=rr.r[iid];if(x.skip)fd.append('s_'+iid,'1');if(x.v!=null)fd.append('v_'+iid,String(x.v));if(x.note)fd.append('n_'+iid,x.note)});
    ps.forEach(function(x){if(!rr.r[x.itemId])return;fd.append('f_'+x.itemId,x.blob,'foto-'+x.id.slice(0,8)+'.jpg');fd.append('pid_'+x.itemId,x.id);fd.append('ft_'+x.itemId,x.takenAt)});
    var g=(ps[ps.length-1]&&ps[ps.length-1].geo)||rr.geo;if(g){fd.append('geo_lat',g.lat);fd.append('geo_lng',g.lng);fd.append('geo_acc',g.acc)}
    return fetch('/qm/audit/'+a.id+'/raum/'+rid,{method:'POST',body:fd,headers:hdr(),credentials:'same-origin'}).then(json).then(function(){a.synced=a.synced||{};a.synced[rid]=true;a.error='';n++;return put('audits',a).then(function(){return Promise.all(ps.map(function(x){return del('photos',x.id)}))})})})})});
  return p.then(function(){return n})}
`;

export const QM_OFFLINE_JS =
  '(function(){' +
  QM_OFF_CORE +
  String.raw`if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
if('serviceWorker'in navigator){navigator.serviceWorker.register('/qm/sw.js',{scope:'/qm/'}).then(function(){return navigator.serviceWorker.ready}).then(function(r){if(r.active)r.active.postMessage('cache-shell')}).catch(function(){})}
var flash='';
function net(){var n=$('#net');var on=navigator.onLine;n.className='net '+(on?'on':'off');n.textContent=on?'Online – Daten werden automatisch übertragen':'Offline – alles wird auf diesem Handy gespeichert und später übertragen'}
function pendingRooms(a){return Object.keys(a.rooms||{}).filter(function(r){return a.rooms[r].done&&!(a.synced||{})[r]})}
function roomScore(rr){var s=0,n=0;Object.keys(rr||{}).forEach(function(k){var x=rr[k];if(!x.skip&&x.pct!=null){s+=x.pct;n++}});return n?Math.round(s/n):null}
function setTitle(t,back){$('#ttl').textContent=t;$('#home').setAttribute('href',back||'/qm/qualitaet')}
function render(){net();var h=location.hash.replace(/^#/,'').split('/');var p;
  if(h[0]==='a'&&h[2]==='r')p=viewRoom(h[1],h[3]);else if(h[0]==='a')p=viewAudit(h[1]);else p=viewList();
  p.catch(function(e){$('#app').innerHTML='<div class="flash err">'+esc(e&&e.message||e)+'</div>'})}
window.addEventListener('hashchange',render);
window.addEventListener('online',function(){net();sync()});window.addEventListener('offline',net);

function viewList(){setTitle('Qualitätskontrolle offline','/qm/qualitaet');
  return Promise.all([all('audits'),all('pkg')]).then(function(r){var audits=r[0].sort(function(a,b){return a.started<b.started?1:-1}),pk=r[1];
    var h=(flash?'<div class="flash ok">'+esc(flash)+'</div>':'');flash='';
    h+='<p class="mut">Ihre Objekte werden mit Netz automatisch aufs Handy geladen. Ohne Empfang geht das Audit hier weiter; beim nächsten Netz wird alles automatisch übertragen. Abschließen (Unterschrift, Bericht) danach in der App mit Netz.</p>';
    if(audits.length){h+='<h2>Audits auf diesem Handy</h2><div class="card">';audits.forEach(function(a){var n=Object.keys(a.rooms||{}).filter(function(k){return a.rooms[k].done}).length,pend=pendingRooms(a).length;
      var pill=a.error?'<span class="pill err">Fehler</span>':pend?'<span class="pill wait">'+pend+' nicht übertragen</span>':n?'<span class="pill ok">übertragen</span>':'<span class="pill">begonnen</span>';
      h+='<div class="row"><a href="#a/'+a.id+'" style="flex:1;color:inherit;text-decoration:none"><div class="t">'+esc(a.siteNo+' - '+a.siteName)+'</div><div class="a">'+esc(a.date.split('-').reverse().join('.'))+' · '+n+' Räume bewertet</div>'+(a.error?'<div class="a" style="color:#b42318">'+esc(a.error)+'</div>':'')+'</a>'+pill+'</div>'});h+='</div>';
      if(navigator.onLine&&audits.some(function(a){return pendingRooms(a).length||(!a.created&&Object.keys(a.rooms||{}).length)}))h+='<button class="btn go" id="syncnow">Jetzt übertragen</button>'}
    h+='<h2>Objekte auf dem Handy</h2>';
    if(!pk.length)h+='<div class="card mut">Noch kein Objekt geladen.</div>';
    else{h+='<div class="card">';pk.forEach(function(p){h+='<div class="row"><div style="flex:1"><div class="t">'+esc(p.site.no+' - '+p.site.name)+'</div><div class="a">'+p.rooms.length+' Räume · geladen '+esc(de(p.loadedAt))+'</div></div><button class="btn sm go" data-start="'+p.id+'">Audit starten</button></div><div style="display:flex;gap:8px;justify-content:flex-end;margin:-4px 0 8px">'+(navigator.onLine?'<button class="btn sm" data-load="'+p.id+'">Aktualisieren</button>':'')+'<button class="btn sm del" data-rm="'+p.id+'">Entfernen</button></div>'});h+='</div>'}
    if(navigator.onLine)h+='<h2>Objekt für offline laden</h2><div class="card"><input type="search" id="osearch" placeholder="Objekt, Kunde, Ort …" aria-label="Objekt suchen"><div id="olist" class="mut" style="margin-top:8px">Liste wird geladen …</div></div>';
    else h+='<p class="mut">Weitere Objekte lassen sich nur mit Netz laden.</p>';
    $('#app').innerHTML=h;
    var sn=$('#syncnow');if(sn)sn.onclick=function(){sn.disabled=true;sn.textContent='Wird übertragen …';sync(true)};
    document.querySelectorAll('[data-start]').forEach(function(b){b.onclick=function(){startAudit(b.getAttribute('data-start'))}});
    document.querySelectorAll('[data-load]').forEach(function(b){b.onclick=function(){b.disabled=true;loadPkg(b.getAttribute('data-load')).then(function(){flash='Objekt aktualisiert.';render()},function(e){alert(e.message);b.disabled=false})}});
    document.querySelectorAll('[data-rm]').forEach(function(b){b.onclick=function(){if(confirm('Objekt vom Handy entfernen? (Begonnene Audits bleiben.)'))del('pkg',b.getAttribute('data-rm')).then(render)}});
    if(navigator.onLine)objectList(pk)})}

var OBJ=null;
function objectList(pk){var box=$('#olist'),inp=$('#osearch');if(!box)return;var have={};pk.forEach(function(p){have[p.id]=1});
  function show(){var q=(inp.value||'').toLowerCase().trim().split(/\s+/).filter(Boolean);var l=OBJ.filter(function(o){var t=(o.no+' '+o.name+' '+o.customer+' '+o.address).toLowerCase();return q.every(function(w){return t.indexOf(w)>=0})}).slice(0,40);
    box.innerHTML=l.length?l.map(function(o){return'<div class="row"><div style="flex:1"><div class="t">'+esc(o.no+' - '+o.name)+'</div><div class="a">'+esc(o.customer)+(o.address?' · '+esc(o.address):'')+' · '+o.rooms+' Räume</div></div>'+(have[o.id]?'<span class="pill ok">auf dem Handy</span>':o.rooms?'<button class="btn sm" data-get="'+o.id+'">Laden</button>':'<span class="pill">kein Raumbuch</span>')+'</div>'}).join(''):'<p class="mut">Nichts gefunden.</p>';
    box.querySelectorAll('[data-get]').forEach(function(b){b.onclick=function(){b.disabled=true;b.textContent='lädt …';loadPkg(b.getAttribute('data-get')).then(function(){flash='Objekt geladen – Audit geht jetzt auch ohne Netz.';render()},function(e){alert(e.message);b.disabled=false;b.textContent='Laden'})}})}
  inp.oninput=function(){if(OBJ)show()};
  (OBJ?Promise.resolve(OBJ):fetch('/qm/offline/objekte.json',{credentials:'same-origin'}).then(json).then(function(j){OBJ=j;return j})).then(show,function(e){box.textContent=e.message})}
function startAudit(siteId){get('pkg',siteId).then(function(p){var a={id:uuid(),siteId:siteId,siteNo:p.site.no,siteName:p.site.name,date:today(),started:new Date().toISOString(),rooms:{},synced:{},created:false,error:''};return put('audits',a).then(function(){location.hash='a/'+a.id})})}

function viewAudit(aid){return Promise.all([get('audits',aid)]).then(function(r){var a=r[0];if(!a){location.hash='';return}
  return get('pkg',a.siteId).then(function(p){setTitle(a.siteNo+' - '+a.siteName,'#');
    if(!p){$('#app').innerHTML='<div class="flash err">Objekt ist nicht mehr auf dem Handy – bitte neu laden.</div>';return}
    var q='';var h=(flash?'<div class="flash ok">'+esc(flash)+'</div>':'')+'<div class="card">';flash='';h+='<div class="mut">Audit vom '+esc(a.date.split('-').reverse().join('.'))+' · '+Object.keys(a.rooms).filter(function(k){return a.rooms[k].done}).length+(a.onlineRated?' (+ '+Object.keys(a.onlineRated).filter(function(k){return!(a.rooms[k]||{}).done}).length+' online)':'')+' von '+p.rooms.length+' Räumen</div>';
    if(a.error)h+='<div class="flash err" style="margin-top:8px">'+esc(a.error)+'</div>';
    if(a.created&&!pendingRooms(a).length&&(Object.keys(a.rooms).length||a.mirror)&&navigator.onLine)h+='<div class="flash ok" style="margin-top:8px">Alles übertragen.</div><a class="btn go" href="/qm/audit/'+a.id+'">Audit in der App öffnen &amp; abschließen</a>';
    h+='</div><input type="search" id="rq" placeholder="Raum, Etage, Nr. …" aria-label="Raum suchen"><div class="card" id="rl" style="margin-top:10px"></div>';
    h+='<button class="btn" id="back">Zur Übersicht (wird bei Netz übertragen)</button><button class="btn del" id="drop">Audit auf dem Handy verwerfen</button>';
    $('#app').innerHTML=h;
    function list(){var w=($('#rq').value||'').toLowerCase().trim().split(/\s+/).filter(Boolean);
      $('#rl').innerHTML=p.rooms.filter(function(x){var t=(x.name+' '+x.meta).toLowerCase();return w.every(function(s){return t.indexOf(s)>=0})}).map(function(x){var rr=a.rooms[x.id],sc=rr&&rr.done?roomScore(rr.r):null;
        var on=(a.onlineRated||{})[x.id];var tag=rr&&rr.done?((a.synced||{})[x.id]?'<span class="pill ok">'+(sc!=null?sc+' %':'✓')+'</span>':'<span class="pill wait">'+(sc!=null?sc+' %':'✓')+'</span>'):(on!==undefined?'<span class="pill ok">'+(on!=null?on+' %':'✓')+'</span>':'');
        return'<a class="row" href="#a/'+a.id+'/r/'+x.id+'"><div><div class="t">'+esc(x.name)+'</div><div class="a">'+esc(x.meta)+'</div></div>'+tag+'</a>'}).join('')||'<p class="mut">Keine Räume.</p>'}
    $('#rq').oninput=list;list();
    $('#back').onclick=function(){location.hash='';sync()};
    $('#drop').onclick=function(){if(!confirm('Audit und alle Fotos auf diesem Handy löschen? Bereits Übertragenes bleibt in der App.'))return;photosOf(a.id).then(function(ps){return Promise.all(ps.map(function(x){return del('photos',x.id)}))}).then(function(){return del('audits',a.id)}).then(function(){location.hash=''})}})})}

function resize(file){return new Promise(function(res){var img=new Image();var u=URL.createObjectURL(file);img.onload=function(){var m=1600,w=img.naturalWidth,h=img.naturalHeight,f=Math.min(1,m/Math.max(w,h));var c=document.createElement('canvas');c.width=Math.round(w*f);c.height=Math.round(h*f);c.getContext('2d').drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(function(b){res(b||file)},'image/jpeg',0.85)};img.onerror=function(){URL.revokeObjectURL(u);res(file)};img.src=u})}
var GEO=null;function geo(){if(!navigator.geolocation)return;navigator.geolocation.getCurrentPosition(function(p){GEO={lat:+p.coords.latitude.toFixed(5),lng:+p.coords.longitude.toFixed(5),acc:Math.round(p.coords.accuracy)}},function(){},{enableHighAccuracy:true,timeout:15000,maximumAge:60000})}

function viewRoom(aid,rid){return Promise.all([get('audits',aid),photosOf(aid)]).then(function(r){var a=r[0],photos=r[1].filter(function(x){return x.roomId===rid});if(!a){location.hash='';return}
  return get('pkg',a.siteId).then(function(p){var room=p&&p.rooms.find(function(x){return x.id===rid});if(!room){location.hash='a/'+aid;return}
    setTitle(room.name,'#a/'+aid);geo();var saved=(a.rooms[rid]||{}).r||{};
    var h='<div class="card"><div class="mut">'+esc(room.meta)+'</div><div style="display:flex;justify-content:space-between;margin-top:6px"><span>Gesamtnote</span><b id="gn">0 %</b></div></div><form id="f">';
    room.items.forEach(function(iid){var it=p.items[iid];if(!it)return;var e=saved[iid]||{};var ctl;
      if(it.kind==='janein'){ctl='<div class="yn">'+it.opts.map(function(o){return'<label class="'+(o[2]===0?'no':'')+'"><input type="radio" name="v_'+iid+'" value="'+o[0]+'" data-pct="'+o[2]+'"'+(e.v===o[0]?' checked':'')+'><span>'+esc(o[1])+'</span></label>'}).join('')+'</div>'}
      else{var idx=-1;it.opts.forEach(function(o,i){if(o[0]===e.v)idx=i});ctl='<div data-slide><div class="sv" data-out>'+(idx>=0?esc(it.opts[idx][1]):'–')+'</div><input type="range" min="0" max="'+(it.opts.length-1)+'" step="1" value="'+(idx>=0?idx:Math.floor((it.opts.length-1)/2))+'" class="'+(idx>=0?'set':'')+'" data-item="'+iid+'" aria-label="'+esc(it.name)+'"><div class="ends"><span>'+esc(it.opts[0][1])+'</span><span>'+esc(it.opts[it.opts.length-1][1])+'</span></div></div>'}
      h+='<div class="item'+(e.skip?' skipped':'')+'" data-i="'+iid+'"><div class="hd"><b>'+esc(it.name)+'</b></div><label class="skip"><input type="checkbox" name="s_'+iid+'"'+(e.skip?' checked':'')+'> Überspringen</label>'+ctl+'<textarea name="n_'+iid+'" rows="2" placeholder="Bemerkung (optional)">'+esc(e.note||'')+'</textarea><div class="ph" data-ph="'+iid+'"></div></div>'});
    h+='</form><button class="btn go" id="save">Speichern &amp; zur Raumliste</button><p class="mut">Fotos werden mit Aufnahmezeit und Standort gespeichert und bei Netz übertragen.</p>';
    $('#app').innerHTML=h;var f=$('#f');var val={};
    room.items.forEach(function(iid){var e=saved[iid]||{};if(e.v!=null)val[iid]=e.v});
    function pctOf(iid){var it=p.items[iid];var v=val[iid];if(v==null)return null;var o=it.opts.find(function(x){return x[0]===v});return o?o[2]:null}
    function upd(){var s=0,n=0;room.items.forEach(function(iid){var d=f.querySelector('[data-i="'+iid+'"]');if(!d)return;var sk=d.querySelector('input[type=checkbox]').checked;d.classList.toggle('skipped',sk);if(sk)return;var x=pctOf(iid);if(x!=null){s+=x;n++}});$('#gn').textContent=(n?Math.round(s/n):0)+' %'}
    f.querySelectorAll('[data-slide]').forEach(function(w){var sl=w.querySelector('input[type=range]'),out=w.querySelector('[data-out]'),iid=sl.getAttribute('data-item'),opts=p.items[iid].opts;function set(){var o=opts[Number(sl.value)];sl.classList.add('set');val[iid]=o[0];out.textContent=o[1];upd()}sl.addEventListener('input',set);sl.addEventListener('change',set);sl.addEventListener('pointerdown',function(){if(!sl.classList.contains('set'))setTimeout(set,0)})});
    f.querySelectorAll('input[type=radio]').forEach(function(rb){rb.addEventListener('change',function(){val[rb.name.slice(2)]=Number(rb.value);upd()})});
    f.addEventListener('change',upd);upd();
    function drawPh(iid){var box=f.querySelector('[data-ph="'+iid+'"]');var mine=photos.filter(function(x){return x.itemId===iid});
      box.innerHTML=mine.map(function(x){return'<span class="x"><img src="'+URL.createObjectURL(x.blob)+'" alt="Foto"><button type="button" data-delph="'+x.id+'" aria-label="Foto entfernen">×</button></span>'}).join('')+(mine.length<5?'<label title="Foto aufnehmen">+<input type="file" accept="image/*" capture="environment"></label>':'')+'<small class="mut">'+mine.length+'/5 Fotos</small>';
      var inp=box.querySelector('input[type=file]');if(inp)inp.onchange=function(){if(!inp.files.length)return;geo();resize(inp.files[0]).then(function(b){var ph={id:uuid(),auditId:aid,roomId:rid,itemId:iid,blob:b,type:'image/jpeg',takenAt:new Date().toISOString(),geo:GEO};return put('photos',ph).then(function(){photos.push(ph);drawPh(iid)})}).catch(function(e){alert('Foto konnte nicht gespeichert werden: '+(e&&e.message||e))})};
      box.querySelectorAll('[data-delph]').forEach(function(b){b.onclick=function(){var id=b.getAttribute('data-delph');del('photos',id).then(function(){photos=photos.filter(function(x){return x.id!==id});drawPh(iid)})}})}
    room.items.forEach(function(iid){if(p.items[iid])drawPh(iid)});
    $('#save').onclick=function(){var rr={},miss=[];room.items.forEach(function(iid){var it=p.items[iid];if(!it)return;var d=f.querySelector('[data-i="'+iid+'"]');var sk=d.querySelector('input[type=checkbox]').checked;var note=d.querySelector('textarea').value.trim();var hasPh=photos.some(function(x){return x.itemId===iid});var v=val[iid];
        if(!sk&&v==null&&!note&&!hasPh)return;if(!sk&&v==null){miss.push(it.name);return}rr[iid]={v:sk?null:v,skip:sk,note:note,pct:sk?null:pctOf(iid)}});
      if(miss.length){alert('Bitte bewerten oder überspringen: '+miss.join(', '));return}
      if(!Object.keys(rr).length){location.hash='a/'+aid;return}
      get('audits',aid).then(function(cur){cur.rooms[rid]={r:rr,geo:GEO,done:true,savedAt:new Date().toISOString()};cur.synced=cur.synced||{};delete cur.synced[rid];cur.error='';return put('audits',cur)}).then(function(){location.hash='a/'+aid;sync()})}})})}

function sync(show){return syncAll().then(function(r){if(!r)return;if(show||r.done||r.errs){flash=r.errs?'':(r.done?r.done+' Räume übertragen.':'Nichts zu übertragen.')}render()},function(){render()})}
// ohne Netz liefert der Service Worker diese Seite auch für /qm/audit/… – passende Ansicht öffnen
function route(){try{var fm=sessionStorage.getItem('vd_qm_flash');if(fm){flash=fm;sessionStorage.removeItem('vd_qm_flash')}}catch(e){}
  var m=location.pathname.match(/^\/qm\/audit\/([0-9a-f-]{36})(?:\/raum\/([0-9a-f-]{36}))?/);
  if(location.pathname==='/qm/offline')return;
  var h=m?('a/'+m[1]+(m[2]?'/r/'+m[2]:'')):'';
  if(!m)flash='Kein Netz – hier geht die Qualitätskontrolle trotzdem weiter.';
  history.replaceState(null,'','/qm/offline'+(h?'#'+h:''))}
route();render();if(navigator.onLine)sync();setInterval(function(){if(navigator.onLine)sync()},60000);
})();`;

/**
 * Auf allen QM-Seiten (Ahmed 27.11.: „Qualitätskontrolle funktioniert nicht ohne Empfang“): Service Worker anmelden,
 * Objekte im Hintergrund aufs Handy laden, offene Offline-Räume übertragen und im normalen Audit bei fehlendem
 * Netz (auch bei schwachem Empfang, Zeitlimit) auf das Handy speichern statt eine Fehlerseite zu zeigen.
 */
export const QM_GLUE_JS =
  '(function(){if(!window.indexedDB||!window.fetch)return;' +
  QM_OFF_CORE +
  String.raw`
if('serviceWorker'in navigator){navigator.serviceWorker.register('/qm/sw.js',{scope:'/qm/'}).then(function(){return navigator.serviceWorker.ready}).then(function(r){if(r.active)r.active.postMessage('cache-shell')}).catch(function(){})}
function tfetch(u,o,ms){return new Promise(function(res,rej){var ac=window.AbortController?new AbortController():null;var t=setTimeout(function(){if(ac)ac.abort();rej(new Error('timeout'))},ms);fetch(u,Object.assign({credentials:'same-origin',signal:ac?ac.signal:undefined},o||{})).then(function(r){clearTimeout(t);res(r)},function(e){clearTimeout(t);rej(e)})})}
function go(u,msg){try{if(msg)sessionStorage.setItem('vd_qm_flash',msg)}catch(e){}location.href=u}
function fresh(p,h){return p&&Date.now()-Date.parse(p.loadedAt)<h*3600000}
function ensurePkg(id,h){return get('pkg',id).then(function(p){return fresh(p,h)?p:loadPkg(id).then(function(){return get('pkg',id)},function(){return p})})}
// Objekte im Hintergrund laden (eigene bzw. zuletzt geprüfte), höchstens alle 6 Std.
function prefetch(){if(!navigator.onLine)return;var k='vd_qm_pf',last=0;try{last=+localStorage.getItem(k)||0}catch(e){}if(Date.now()-last<6*3600000)return;
  fetch('/qm/offline/objekte.json',{credentials:'same-origin'}).then(json).then(function(list){try{localStorage.setItem(k,String(Date.now()))}catch(e){}
    return all('pkg').then(function(pk){var have={};pk.forEach(function(p){have[p.id]=p});var ids=list.filter(function(o){return o.rooms&&(o.prefetch||have[o.id])&&!fresh(have[o.id],12)}).map(function(o){return o.id});
      return ids.reduce(function(pr,id){return pr.then(function(){return loadPkg(id).catch(function(){})})},Promise.resolve())})}).catch(function(){})}
function mirror(d){return get('audits',d.id).then(function(a){var now=new Date().toISOString();
  if(!a)a={id:d.id,siteId:d.siteId,siteNo:d.siteNo,siteName:d.siteName,date:d.date,started:now,rooms:{},synced:{},created:true,mirror:true,error:''};
  a.onlineRated=d.rated||{};a.seenAt=now;a.created=true;return put('audits',a)})}
function pctOfItem(d){var r=d.querySelector('input[type=radio]:checked');if(r)return Number(r.getAttribute('data-pct'));var sl=d.querySelector('[data-slide] input[type=range]');if(sl&&sl.classList.contains('set')){var o=JSON.parse(sl.getAttribute('data-opts'))[Number(sl.value)];return o?o[2]:null}return null}
function resize(file){return new Promise(function(res){var img=new Image();var u=URL.createObjectURL(file);img.onload=function(){var m=1600,w=img.naturalWidth,h=img.naturalHeight,f=Math.min(1,m/Math.max(w,h));var c=document.createElement('canvas');c.width=Math.round(w*f);c.height=Math.round(h*f);c.getContext('2d').drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(u);c.toBlob(function(b){res(b||file)},'image/jpeg',0.85)};img.onerror=function(){URL.revokeObjectURL(u);res(file)};img.src=u})}
// Raum aus dem normalen Formular auf dem Handy speichern (gleiches Format wie die Offline-Seite)
function saveLocal(f,d){var rr={},miss=[],files=[];
  f.querySelectorAll('[data-item]').forEach(function(box){var nm=(box.querySelector('textarea')||{}).name||'';var iid=nm.slice(2);if(!iid)return;
    var sk=box.querySelector('input[type=checkbox]');sk=!!(sk&&sk.checked);var note=(box.querySelector('textarea').value||'').trim();
    var vi=box.querySelector('input[type=radio]:checked')||box.querySelector('input[type=hidden][name="v_'+iid+'"]');var v=vi&&vi.value!==''?Number(vi.value):null;
    var fs=[];box.querySelectorAll('input[type=file]').forEach(function(i){for(var k=0;k<i.files.length;k++)fs.push(i.files[k])});
    if(!sk&&v==null&&!note&&!fs.length)return;if(!sk&&v==null){miss.push((box.querySelector('.hd b')||{}).textContent||'');return}
    rr[iid]={v:sk?null:v,skip:sk,note:note,pct:sk?null:pctOfItem(box)};fs.forEach(function(x){files.push({iid:iid,file:x})})});
  if(miss.length){alert('Bitte bewerten oder überspringen: '+miss.join(', '));return Promise.resolve(false)}
  var g=f.geo_lat&&f.geo_lat.value?{lat:+f.geo_lat.value,lng:+f.geo_lng.value,acc:+f.geo_acc.value}:null;
  return get('audits',d.audit).then(function(a){a=a||{id:d.audit,siteId:d.site,siteNo:d.siteNo,siteName:d.siteName,date:d.date,started:new Date().toISOString(),rooms:{},synced:{},created:true,mirror:true,error:''};
    return files.reduce(function(pr,x){return pr.then(function(){return resize(x.file).then(function(b){return put('photos',{id:uuid(),auditId:a.id,roomId:d.room,itemId:x.iid,blob:b,type:'image/jpeg',takenAt:new Date().toISOString(),geo:g})})})},Promise.resolve()).then(function(){
      if(Object.keys(rr).length){a.rooms[d.room]={r:rr,geo:g,done:true,savedAt:new Date().toISOString()};a.synced=a.synced||{};delete a.synced[d.room]}a.error='';return put('audits',a)})}).then(function(){return true})}
function dataOf(id){var el=document.getElementById(id);if(!el)return null;try{return JSON.parse(el.getAttribute('data-json'))}catch(e){return null}}
var AUD=dataOf('qm-audit-data'),ROOM=dataOf('qm-room-data');
if(AUD){mirror(AUD).catch(function(){});ensurePkg(AUD.siteId,12)}
if(ROOM)ensurePkg(ROOM.site,24);
var f=ROOM&&document.getElementById('qmf');
if(f)f.addEventListener('submit',function(e){e.preventDefault();var btns=f.querySelectorAll('button');btns.forEach(function(b){b.disabled=true});
  function local(){return saveLocal(f,ROOM).then(function(ok){if(ok)go('/qm/offline#a/'+ROOM.audit,'Kein Netz – Raum auf dem Handy gespeichert. Wird automatisch übertragen.');else btns.forEach(function(b){b.disabled=false})},function(er){alert('Speichern auf dem Handy fehlgeschlagen: '+(er&&er.message||er));btns.forEach(function(b){b.disabled=false})})}
  if(!navigator.onLine)return local();
  var fd=new FormData(f);if(e.submitter&&e.submitter.name)fd.append(e.submitter.name,e.submitter.value);
  tfetch(f.action,{method:'POST',body:fd},45000).then(function(r){if(r.redirected||r.ok&&r.url!==f.action){location.replace(r.url);return}return r.text().then(function(t){document.open();document.write(t);document.close()})},local)});
// Audit starten ohne Netz: lokal anlegen, wenn das Objekt auf dem Handy ist
document.querySelectorAll('form[action="/qm/audit/neu"]').forEach(function(sf){sf.addEventListener('submit',function(e){if(sf.dataset.sent)return;e.preventDefault();var id=sf.querySelector('[name=id]').value,site=sf.querySelector('[name=site_id]').value;
  function local(){get('pkg',site).then(function(p){if(!p){alert('Kein Netz und dieses Objekt ist noch nicht auf dem Handy gespeichert. Bitte einmal mit Netz öffnen.');return}
    var a={id:id,siteId:site,siteNo:p.site.no,siteName:p.site.name,date:today(),started:new Date().toISOString(),rooms:{},synced:{},created:false,error:''};return put('audits',a).then(function(){go('/qm/offline#a/'+id,'Kein Netz – Audit auf dem Handy begonnen.')})})}
  if(!navigator.onLine)return local();
  tfetch('/qm/audit/neu',{method:'POST',body:new FormData(sf)},20000).then(function(r){location.replace(r.url)},local)})});
// offene Offline-Räume übertragen, Objekte nachladen
if(navigator.onLine){syncAll().catch(function(){});setTimeout(prefetch,1500)}
window.addEventListener('online',function(){syncAll().catch(function(){})});
})();`;
