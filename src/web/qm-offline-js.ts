/** Browser-Teil der Offline-Qualitätskontrolle (`/qm/offline`): IndexedDB, Ansichten, Fotos, Übertragung. */
export const QM_OFFLINE_JS = String.raw`(function(){
var $=function(s){return document.querySelector(s)};
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
if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
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
    h+='<p class="mut">Objekte vorher im WLAN/mit Netz aufs Handy laden. Danach geht das Audit auch ohne Netz; beim nächsten Netz wird es automatisch übertragen. Abschließen (Unterschrift, Bericht) danach in der App mit Netz.</p>';
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
function json(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')<0)throw new Error('Bitte in der App neu anmelden (Sitzung abgelaufen). Die Daten bleiben auf dem Handy.');return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||('Fehler '+r.status));return j})}
function loadPkg(id){return fetch('/qm/offline/paket/'+id,{credentials:'same-origin'}).then(json).then(function(p){p.id=p.site.id;return put('pkg',p)})}
function startAudit(siteId){get('pkg',siteId).then(function(p){var a={id:uuid(),siteId:siteId,siteNo:p.site.no,siteName:p.site.name,date:today(),started:new Date().toISOString(),rooms:{},synced:{},created:false,error:''};return put('audits',a).then(function(){location.hash='a/'+a.id})})}

function viewAudit(aid){return Promise.all([get('audits',aid)]).then(function(r){var a=r[0];if(!a){location.hash='';return}
  return get('pkg',a.siteId).then(function(p){setTitle(a.siteNo+' - '+a.siteName,'#');
    if(!p){$('#app').innerHTML='<div class="flash err">Objekt ist nicht mehr auf dem Handy – bitte neu laden.</div>';return}
    var q='';var h='<div class="card"><div class="mut">Audit vom '+esc(a.date.split('-').reverse().join('.'))+' · '+Object.keys(a.rooms).filter(function(k){return a.rooms[k].done}).length+' von '+p.rooms.length+' Räumen</div>';
    if(a.error)h+='<div class="flash err" style="margin-top:8px">'+esc(a.error)+'</div>';
    if(a.created&&!pendingRooms(a).length&&Object.keys(a.rooms).length)h+='<div class="flash ok" style="margin-top:8px">Alles übertragen.</div><a class="btn go" href="/qm/audit/'+a.id+'">Audit in der App öffnen &amp; abschließen</a>';
    h+='</div><input type="search" id="rq" placeholder="Raum, Etage, Nr. …" aria-label="Raum suchen"><div class="card" id="rl" style="margin-top:10px"></div>';
    h+='<button class="btn" id="back">Zur Übersicht (wird bei Netz übertragen)</button><button class="btn del" id="drop">Audit auf dem Handy verwerfen</button>';
    $('#app').innerHTML=h;
    function list(){var w=($('#rq').value||'').toLowerCase().trim().split(/\s+/).filter(Boolean);
      $('#rl').innerHTML=p.rooms.filter(function(x){var t=(x.name+' '+x.meta).toLowerCase();return w.every(function(s){return t.indexOf(s)>=0})}).map(function(x){var rr=a.rooms[x.id],sc=rr&&rr.done?roomScore(rr.r):null;
        var tag=rr&&rr.done?((a.synced||{})[x.id]?'<span class="pill ok">'+(sc!=null?sc+' %':'✓')+'</span>':'<span class="pill wait">'+(sc!=null?sc+' %':'✓')+'</span>'):'';
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

var SYNCING=false;
function sync(show){if(SYNCING||!navigator.onLine)return Promise.resolve();SYNCING=true;var done=0,errs=0;
  return all('audits').then(function(list){return list.reduce(function(pr,a){return pr.then(function(){return syncAudit(a).then(function(n){done+=n},function(e){errs++;a.error=e.message||String(e);return put('audits',a)})})},Promise.resolve())}).then(function(){SYNCING=false;if(show||done||errs){flash=errs?'':(done?done+' Räume übertragen.':'Nichts zu übertragen.')}render()},function(){SYNCING=false;render()})}
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
render();if(navigator.onLine)sync();setInterval(function(){if(navigator.onLine)sync()},60000);
})();`;
