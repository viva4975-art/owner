/**
 * Browser-Teil für große Uploads. Hängt sich an alle `[data-uploader]`-Bereiche.
 * - Dateien per Ziehen & Ablegen oder Auswahl, mehrere gleichzeitig
 * - 8-MiB-Stücke, 4 parallel, jedes Stück mit Zeitlimit und bis zu 10 Wiederholungen (Pause wächst)
 * - Verbindung weg → wartet auf „online“ und macht weiter
 * - Seite neu geladen → dieselbe Datei erneut wählen: es werden nur fehlende Stücke gesendet
 * - Fortschritt, Geschwindigkeit, Restzeit; Pause/Weiter
 */
export const UPLOADER_JS = String.raw`
(function () {
  if (window.__vdUploader) return; window.__vdUploader = true;
  var CONCURRENCY = 4, MAX_TRIES = 10, TIMEOUT = 120000;
  var active = 0;
  window.addEventListener('beforeunload', function (e) { if (active > 0) { e.preventDefault(); e.returnValue = ''; } });

  function fmt(b) { var u = ['B','KB','MB','GB'], i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return b.toLocaleString('de-DE', { maximumFractionDigits: i ? 1 : 0 }) + ' ' + u[i]; }
  function fmtTime(s) { if (!isFinite(s)) return ''; if (s < 60) return Math.ceil(s) + ' s'; return Math.floor(s / 60) + ' min ' + Math.ceil(s % 60) + ' s'; }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); })); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitOnline() { return navigator.onLine ? Promise.resolve() : new Promise(function (r) { window.addEventListener('online', function h() { window.removeEventListener('online', h); r(); }); }); }
  function icon(name) { var t = document.getElementById('vd-ic-' + name); return t ? t.innerHTML : ''; }

  function api(method, url, body, headers, timeout) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, timeout || 30000);
    return fetch(url, { method: method, body: body, headers: Object.assign({ 'X-Upload': '1' }, headers || {}), signal: ctrl.signal, credentials: 'same-origin' })
      .then(function (r) { clearTimeout(t); return r.text().then(function (txt) { var j = null; try { j = JSON.parse(txt); } catch (e) {} if (!r.ok) { var err = new Error((j && j.fehler) || ('HTTP ' + r.status)); err.status = r.status; throw err; } return j; }); },
            function (e) { clearTimeout(t); throw e; });
  }

  function setup(box) {
    if (box.dataset.ready) return; box.dataset.ready = '1';
    var input = box.querySelector('input[type=file]');
    var zone = box.querySelector('.drop-zone');
    var list = box.querySelector('.files');
    var link = { type: box.dataset.linkType, id: box.dataset.linkId };
    var category = box.dataset.category || '';
    var pending = 0;

    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { Array.prototype.forEach.call(e.dataTransfer.files, add); });
    input.addEventListener('change', function () { Array.prototype.forEach.call(input.files, add); input.value = ''; });

    function add(file) {
      var key = 'vd-up:' + link.type + ':' + link.id + ':' + file.name + ':' + file.size + ':' + file.lastModified;
      var id = null; try { id = localStorage.getItem(key); } catch (e) {}
      if (!id) { id = uuid(); try { localStorage.setItem(key, id); } catch (e) {} }

      var li = document.createElement('li');
      li.innerHTML = '<span class="fic">' + icon(/\.zip$/i.test(file.name) ? 'zip' : 'file') + '</span>' +
        '<div><div class="nm"></div><div class="meta"></div></div>' +
        '<div class="act"><button type="button" class="btn sm sec pz">Pause</button></div>' +
        '<div class="bar"><i></i></div>';
      li.querySelector('.nm').textContent = file.name;
      var meta = li.querySelector('.meta'), bar = li.querySelector('.bar>i'), pz = li.querySelector('.pz');
      list.appendChild(li);

      var paused = false, done = false, sent = 0, startT = Date.now(), lastT = Date.now(), lastSent = 0, speed = 0;
      pz.addEventListener('click', function () { paused = !paused; pz.textContent = paused ? 'Weiter' : 'Pause'; if (!paused) run(); });
      function show(text) {
        var pct = file.size ? Math.min(100, sent / file.size * 100) : 100;
        bar.style.width = pct.toFixed(1) + '%';
        meta.textContent = text || (fmt(sent) + ' von ' + fmt(file.size) + ' · ' + pct.toFixed(0) + ' %' + (speed > 0 ? ' · ' + fmt(speed) + '/s · noch ' + fmtTime((file.size - sent) / speed) : ''));
      }
      function tick(bytes) {
        sent += bytes; var now = Date.now();
        if (now - lastT > 700) { var s = (sent - lastSent) / ((now - lastT) / 1000); speed = speed ? speed * 0.6 + s * 0.4 : s; lastT = now; lastSent = sent; }
        show();
      }

      var info = null, queue = [], inflight = 0;
      active++; pending++;
      show('Wird vorbereitet …');
      api('POST', '/api/uploads', JSON.stringify({ id: id, name: file.name, size: file.size, type: file.type, linkType: link.type, linkId: link.id, category: category }), { 'Content-Type': 'application/json' })
        .then(function (j) {
          info = j;
          var have = {}; j.received.forEach(function (n) { have[n] = 1; });
          for (var i = 0; i < j.totalChunks; i++) {
            if (have[i]) sent += Math.min(j.chunkSize, file.size - i * j.chunkSize); else queue.push(i);
          }
          lastSent = sent;
          if (j.received.length) show('Setze fort bei ' + fmt(sent) + ' …');
          run();
        })
        .catch(fail);

      function run() {
        if (done || paused || !info) return;
        if (!queue.length && !inflight) return finish();
        while (inflight < CONCURRENCY && queue.length && !paused) send(queue.shift(), 1);
      }
      function send(n, attempt) {
        inflight++;
        var blob = file.slice(n * info.chunkSize, Math.min(file.size, (n + 1) * info.chunkSize));
        waitOnline()
          .then(function () { return api('PUT', '/api/uploads/' + id + '/teile/' + n, blob, { 'Content-Type': 'application/octet-stream' }, TIMEOUT); })
          .then(function () { inflight--; tick(blob.size); run(); },
            function (e) {
              inflight--;
              if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return fail(e);
              if (attempt >= MAX_TRIES) return fail(new Error('Verbindung instabil – bitte später erneut versuchen (der Fortschritt bleibt erhalten).'));
              show('Verbindung unterbrochen – neuer Versuch (' + attempt + '/' + MAX_TRIES + ') …');
              sleep(Math.min(30000, 1000 * Math.pow(2, attempt - 1))).then(function () { if (paused) { queue.unshift(n); } else { send(n, attempt + 1); } });
            });
      }
      function finish() {
        if (done) return; done = true;
        show('Wird geprüft und gespeichert …');
        api('POST', '/api/uploads/' + id + '/abschluss', null, null, 600000)
          .then(function (j) {
            try { localStorage.removeItem(key); } catch (e) {}
            li.classList.add('done'); bar.style.width = '100%';
            var secs = (Date.now() - startT) / 1000;
            meta.textContent = fmt(file.size) + ' · hochgeladen in ' + fmtTime(secs) + ' · SHA-256 ' + j.sha256.slice(0, 12) + '…';
            li.querySelector('.act').innerHTML = '<a class="btn sm sec" href="/dateien/' + id + '">Öffnen</a>';
            end();
          }, function (e) { done = false; fail(e); });
      }
      function fail(e) {
        li.classList.add('error');
        meta.textContent = 'Fehler: ' + (e && e.message ? e.message : e);
        pz.textContent = 'Erneut'; paused = true;
        pz.onclick = function () { ended = false; active++; pending++; li.classList.remove('error'); paused = false; pz.textContent = 'Pause'; pz.onclick = null; if (!info) { location.reload(); } else { api('GET', '/api/uploads/' + id).then(function (j) { var have = {}; j.received.forEach(function (n) { have[n] = 1; }); queue = []; sent = 0; for (var i = 0; i < j.totalChunks; i++) { if (have[i]) sent += Math.min(j.chunkSize, file.size - i * j.chunkSize); else queue.push(i); } run(); }); } };
        end(true);
      }
      var ended = false;
      function end(err) {
        if (ended) return; ended = true; active--; pending--;
        if (!err && pending === 0 && box.dataset.reload !== 'no') setTimeout(function () { if (active === 0) location.reload(); }, 900);
      }
    }
  }
  function setupAll() { Array.prototype.forEach.call(document.querySelectorAll('[data-uploader]'), setup); }
  setupAll();
  // weitere Upload-Bereiche weiter unten auf der Seite (Skript läuft schon beim ersten Bereich)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupAll);
})();
`;
