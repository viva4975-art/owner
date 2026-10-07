/**
 * Kleines Browser-Skript (ohne Framework). Aufgaben:
 *
 * 1. Eingaben nie verlieren: alle Eingabeformulare (POST) werden bei jeder Eingabe im
 *    sessionStorage des Tabs gesichert und beim erneuten Öffnen / Zurück-Navigieren wiederhergestellt.
 *    sessionStorage gehört genau einem Tab → zwei Tabs stören sich nicht.
 *    Gespeichert wird zusammen mit der Datensatz-Version; nach erfolgreichem Speichern wird verworfen.
 * 2. Zurück/Vor: Seiten bleiben bfcache-fähig (kein unload-Handler, kein no-store); Erfolgs-/Fehler-
 *    meldungen werden nach dem Anzeigen aus der URL entfernt, damit „Zurück“ sie nicht erneut zeigt.
 * 3. Menüs: Dropdowns (details) schließen sich gegenseitig, Klick daneben / Esc schließt.
 * 4. Taste „/“ springt in die Suche (wie Fortytools).
 * 6. Tabellen: Klick auf die Spaltenüberschrift sortiert auf/ab (Zahl, Betrag, Datum, Text).
 * 5. Auswahllisten ab 8 Einträgen (Kunden, Objekte, Mitarbeiter …) werden zum Feld zum Reintippen (wie Fortytools): Tippen filtert
 *    die Liste (Nummer oder Name, ohne Umlaut-/Groß-Klein-Unterschied), Enter übernimmt den ersten Treffer.
 *    Die Liste selbst bleibt die echte Auswahl (Formulare, Prüfungen und Tests unverändert).
 */
export const CLIENT_JS = String.raw`
(function () {
  var PREFIX = 'vd-form:';
  var MAX_AGE = 7 * 24 * 3600 * 1000;
  function store() { try { return window.sessionStorage; } catch (e) { return null; } }
  var ss = store();
  var url = new URL(location.href);

  // ---- Meldungen aus der URL entfernen (Zurück zeigt sie nicht erneut) ----
  var hadOk = url.searchParams.has('ok');
  var hadErr = url.searchParams.has('fehler');
  if (hadOk || hadErr) {
    url.searchParams.delete('ok');
    url.searchParams.delete('fehler');
    history.replaceState(history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }

  // ---- Nach Absenden: bei Erfolg Entwurf verwerfen, bei Fehler behalten ----
  if (ss) {
    var pending = ss.getItem('vd-pending');
    if (pending) {
      ss.removeItem('vd-pending');
      if (hadOk) ss.removeItem(pending);
    }
  }

  // Schlüssel: data-autosave, sonst Seitenadresse + Nummer des Formulars (Neu-Formulare haben zufällige IDs in action)
  function keyOf(form) {
    var k = form.getAttribute('data-autosave');
    if (k) return PREFIX + k;
    var i = Array.prototype.indexOf.call(document.forms, form);
    return PREFIX + location.pathname + location.search + ':' + i;
  }
  function fieldsOf(form) {
    return Array.prototype.filter.call(form.elements, function (el) {
      if (!el.name || el.disabled || el.closest('[data-lines]') || el.closest('template')) return false;
      var t = (el.type || '').toLowerCase();
      return ['hidden', 'file', 'submit', 'button', 'reset', 'password'].indexOf(t) < 0;
    });
  }
  function serialize(form) {
    var data = { v: form.getAttribute('data-version') || '', t: Date.now(), f: [], lines: null };
    var seen = {};
    fieldsOf(form).forEach(function (el) {
      var idx = seen[el.name] = (seen[el.name] || 0) + 1;
      var val = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '0') : el.value;
      data.f.push([el.name, idx, val]);
    });
    var lines = form.querySelector('[data-lines]');
    if (lines) {
      data.lines = Array.prototype.map.call(lines.querySelectorAll('tbody tr'), function (tr) {
        var row = {};
        Array.prototype.forEach.call(tr.querySelectorAll('input,select,textarea'), function (el) { if (el.name) row[el.name] = el.value; });
        return row;
      });
    }
    return data;
  }
  function apply(form, data) {
    var seen = {};
    var byKey = {};
    data.f.forEach(function (x) { byKey[x[0] + '#' + x[1]] = x[2]; });
    fieldsOf(form).forEach(function (el) {
      var idx = seen[el.name] = (seen[el.name] || 0) + 1;
      var v = byKey[el.name + '#' + idx];
      if (v === undefined) return;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = v === '1';
      else el.value = v;
    });
    // aufgeklappte „abweichend“-Bereiche wiederherstellen (danach Werte darin erneut setzen)
    var revealed = Array.prototype.filter.call(form.querySelectorAll('input[data-reveal]'), function (cb) { return cb.checked; });
    revealed.forEach(function (cb) { cb.dispatchEvent(new Event('change')); });
    if (revealed.length) fieldsOf(form).forEach(function (el) {
      var v = byKey[el.name + '#1'];
      if (v !== undefined && el.type !== 'checkbox' && el.type !== 'radio' && !el.value) el.value = v;
    });
    if (data.lines && window.vdLines && form.querySelector('[data-lines]')) window.vdLines.set(data.lines);
    form.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function banner(form, text, actions) {
    var b = document.createElement('div');
    b.className = 'restore';
    b.innerHTML = '<span></span>';
    b.firstChild.textContent = text;
    actions.forEach(function (a) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn sm ' + (a.cls || 'sec'); btn.textContent = a.label;
      btn.addEventListener('click', function () { a.run(); b.remove(); });
      b.appendChild(btn);
    });
    form.parentNode.insertBefore(b, form);
  }

  function setupForm(form) {
    if (!ss) return;
    var key = keyOf(form);
    var raw = ss.getItem(key);
    if (raw) {
      try {
        var data = JSON.parse(raw);
        if (Date.now() - data.t > MAX_AGE) { ss.removeItem(key); }
        else if (data.v === (form.getAttribute('data-version') || '')) {
          // still wiederherstellen (Ahmed: kein Hinweisbalken); nur bei Konflikten mit neuerem Stand fragen
          apply(form, data);
        } else {
          banner(form, 'Es gibt nicht gespeicherte Eingaben zu einem älteren Stand dieses Datensatzes (in einem anderen Tab oder von jemand anderem geändert).', [
            { label: 'Meine Eingaben übernehmen', cls: '', run: function () { apply(form, data); } },
            { label: 'Verwerfen', run: function () { ss.removeItem(key); } },
          ]);
        }
      } catch (e) { ss.removeItem(key); }
    }
    var t = null;
    function save() { try { ss.setItem(key, JSON.stringify(serialize(form))); } catch (e) {} }
    form.addEventListener('input', function () { clearTimeout(t); t = setTimeout(save, 250); });
    form.addEventListener('change', save);
    form.addEventListener('submit', function () { save(); ss.setItem('vd-pending', key); });
    // vor dem Verlassen der Seite (auch bei Zurück über bfcache) noch einmal sichern
    window.addEventListener('pagehide', save);
  }
  // Alle Eingabeformulare sichern (nicht nur markierte): POST-Formulare mit mindestens einem Eingabefeld,
  // außer Anmeldung/Passwort und ausdrücklich ausgenommene (data-no-autosave).
  // ---- „abweichend“-Häkchen: Felder erst zeigen, wenn angehakt; versteckte Felder werden nicht gesendet ----
  Array.prototype.forEach.call(document.querySelectorAll('input[type=checkbox][data-reveal]'), function (cb) {
    var target = document.querySelector(cb.getAttribute('data-reveal'));
    if (!target) return;
    function sync() {
      target.hidden = !cb.checked;
      Array.prototype.forEach.call(target.querySelectorAll('input,select,textarea'), function (el) { el.disabled = !cb.checked; });
    }
    cb.addEventListener('change', function () { sync(); if (cb.checked) { var f = target.querySelector('input,select,textarea'); if (f) f.focus(); } });
    sync();
  });

  Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
    if (f.hasAttribute('data-no-autosave')) return;
    if (!f.hasAttribute('data-autosave')) {
      if ((f.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
      if (f.querySelector('input[type=password]')) return;
      var editable = fieldsOf(f).filter(function (el) {
        var t = (el.type || '').toLowerCase();
        return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || ['text', 'email', 'number', 'date', 'time', 'tel', 'url', 'month', 'datetime-local', ''].indexOf(t) >= 0;
      });
      if (!editable.length) return;
    }
    setupForm(f);
  });

  // ---- Doppelklick-Schutz: Formular nur einmal absenden ----
  // Bubble-Phase: läuft nach den Prüfungen des Formulars (z. B. confirm(), Unterschrift fehlt) –
  // ein abgebrochenes Absenden sperrt das Formular nicht.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (e.defaultPrevented) return;
    if (f.dataset.sent === '1') { e.preventDefault(); return; }
    if (f.method && f.method.toLowerCase() === 'post') {
      f.dataset.sent = '1';
      setTimeout(function () { f.dataset.sent = ''; }, 8000);
    }
  });
  // Beim Zurückkommen aus dem bfcache Formulare wieder freigeben
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) Array.prototype.forEach.call(document.forms, function (f) { f.dataset.sent = ''; });
  });

  // ---- Auswahlfelder zum Reintippen (wie Fortytools): ins Feld klicken, tippen, Liste filtert sich ----
  // Das echte <select> bleibt im Formular (Absenden, Pflichtfeld-Prüfung, Tests); darüber liegt ein Knopf mit Liste.
  function norm(x) {
    return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  }
  var openBox = null;
  function closeOpen() { if (openBox) { openBox.close(); openBox = null; } }
  document.addEventListener('mousedown', function (e) { if (openBox && !openBox.wrap.contains(e.target)) closeOpen(); });
  function combo(sel) {
    if (sel.multiple || sel.dataset.combo === 'done' || sel.hasAttribute('data-nosearch') || sel.closest('[data-nosearch]') || sel.closest('template')) return;
    if (sel.options.length < 8 && !sel.hasAttribute('data-combo')) return;
    sel.dataset.combo = 'done';
    var wrap = document.createElement('div');
    wrap.className = 'cbx';
    if (sel.style.width) wrap.style.width = sel.style.width;
    if (sel.style.maxWidth) wrap.style.maxWidth = sel.style.maxWidth;
    sel.parentNode.insertBefore(wrap, sel);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cbx-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    if (sel.id) { var lab = document.querySelector('label[for="' + sel.id + '"]'); if (lab) btn.setAttribute('aria-label', lab.textContent.trim()); }
    wrap.appendChild(btn);
    wrap.appendChild(sel);
    sel.classList.add('cbx-native');
    sel.tabIndex = -1;
    var pop = null, input, list, rows = [], active = -1;
    function label() {
      var o = sel.options[sel.selectedIndex];
      var g = o && o.parentNode && o.parentNode.tagName === 'OPTGROUP' && o.parentNode.hasAttribute('data-cust') ? o.parentNode : null;
      btn.textContent = o ? o.textContent.trim() + (g ? ' – ' + g.label : '') : '';
      btn.classList.toggle('ph', !o || o.value === '');
      btn.disabled = sel.disabled;
    }
    function build() {
      pop = document.createElement('div');
      pop.className = 'cbx-pop';
      input = document.createElement('input');
      input.type = 'search'; input.autocomplete = 'off'; input.className = 'cbx-q';
      input.placeholder = 'Suchen …';
      list = document.createElement('div');
      list.className = 'cbx-list'; list.setAttribute('role', 'listbox');
      pop.appendChild(input); pop.appendChild(list);
      wrap.appendChild(pop);
      input.addEventListener('input', render);
      input.addEventListener('keydown', key);
      list.addEventListener('mousedown', function (e) {
        var r = e.target.closest('.cbx-opt'); if (!r) return;
        e.preventDefault(); pick(rows[Number(r.dataset.i)].o);
      });
    }
    function render() {
      var words = norm(input.value).split(/\s+/).filter(Boolean);
      list.innerHTML = ''; rows = []; active = -1;
      var lastGroup = null;
      Array.prototype.forEach.call(sel.options, function (o) {
        var g = o.parentNode.tagName === 'OPTGROUP' ? o.parentNode : null;
        var text = norm(o.textContent + ' ' + (g ? g.label : '') + ' ' + o.value);
        if (words.length && (o.value === '' || !words.every(function (w) { return text.indexOf(w) >= 0; }))) return;
        if (g && g !== lastGroup) {
          var h = document.createElement('div'); h.className = 'cbx-grp'; h.textContent = g.label; list.appendChild(h);
        }
        lastGroup = g;
        var d = document.createElement('div');
        d.className = 'cbx-opt' + (g ? ' in' : '') + (o.value === sel.value ? ' sel' : '') + (o.disabled ? ' dis' : '');
        d.setAttribute('role', 'option');
        d.dataset.i = String(rows.length);
        d.textContent = o.textContent.replace(/^\s*↳\s*/, '').trim();
        list.appendChild(d);
        rows.push({ o: o, el: d });
        if (o.value === sel.value && active < 0) active = rows.length - 1;
      });
      if (words.length) active = rows.findIndex(function (r) { return !r.o.disabled; });
      if (!rows.length) { var n = document.createElement('div'); n.className = 'cbx-none'; n.textContent = 'Keine Treffer'; list.appendChild(n); }
      mark();
    }
    function mark() {
      rows.forEach(function (r, i) { r.el.classList.toggle('act', i === active); });
      if (rows[active]) rows[active].el.scrollIntoView({ block: 'nearest' });
    }
    function key(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) pick(rows[active].o); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'Tab') { close(); }
    }
    function pick(o) {
      if (o.disabled) return;
      var changed = sel.value !== o.value;
      sel.value = o.value;
      label(); close(); btn.focus();
      if (changed) {
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    function open(initial) {
      if (sel.disabled) return;
      closeOpen();
      if (!pop) build();
      pop.hidden = false; wrap.classList.add('open');
      input.value = initial || '';
      render(); input.focus();
      openBox = { wrap: wrap, close: close };
    }
    function close() { if (pop) pop.hidden = true; wrap.classList.remove('open'); if (openBox && openBox.wrap === wrap) openBox = null; }
    btn.addEventListener('click', function () { if (pop && !pop.hidden) close(); else open(''); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(''); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(e.key); }
    });
    sel.addEventListener('change', label);
    sel.addEventListener('invalid', function () { wrap.classList.add('bad'); });
    sel._cbLabel = label;
    label();
  }
  function comboAll(root) { Array.prototype.forEach.call((root || document).querySelectorAll('select'), combo); }
  comboAll();
  // nur Anzeige auffrischen (z. B. Zurück-Taste) – kein change-Ereignis, sonst lösen onchange-Formulare neu aus
  window.addEventListener('pageshow', function () { Array.prototype.forEach.call(document.querySelectorAll('select.cbx-native'), function (s) { if (s._cbLabel) s._cbLabel(); }); });
  // nachträglich eingefügte Auswahlfelder (z. B. „Weiteren Mitarbeiter hinzufügen“)
  new MutationObserver(function (ms) {
    ms.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { if (n.tagName === 'SELECT') combo(n); else comboAll(n); } }); });
  }).observe(document.body, { childList: true, subtree: true });

  // ---- Tabellen sortieren: Klick auf die Spaltenüberschrift (auf/ab), wie Fortytools (Ahmed 07.10.) ----
  // Gilt für alle Listen mit Kopfzeile; Summenzeilen bleiben unten. Exporte (Links mit data-export) bekommen die
  // Sortierung mit (?sort=<Spalte>&dir=asc|desc). Zahlen, Beträge (1.234,56 €), Datum (TT.MM.JJJJ) und Zeiten richtig.
  function sortKey(td) {
    var t = (td ? td.innerText || td.textContent || '' : '').trim();
    var d = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(t);
    if (d) return [0, Number(d[3] + d[2] + d[1])];
    var h = /^(\d{1,2}):(\d{2})(?!\d)/.exec(t);
    if (h && t.length <= 13) return [0, Number(h[1]) * 60 + Number(h[2])];
    var n = t.replace(/[€%\s\u00a0]/g, '').replace(/^(T\.|Std\.)/, '');
    if (/^[-−]?[\d.]*\d(,\d+)?$/.test(n)) return [0, Number(n.replace(/−/, '-').replace(/\./g, '').replace(',', '.'))];
    return [1, t.toLowerCase()];
  }
  function cmp(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[0] === 0 ? a[1] - b[1] : String(a[1]).localeCompare(String(b[1]), 'de', { numeric: true });
  }
  function sortable(table, ti) {
    if (table.hasAttribute('data-nosort') || !table.tHead || !table.tBodies.length || table.tBodies.length > 1) return;
    var body = table.tBodies[0];
    if (body.rows.length < 2) return;
    var head = table.tHead.rows[table.tHead.rows.length - 1];
    if (Array.prototype.some.call(head.cells, function (c) { return c.colSpan > 1; })) return;
    var cols = head.cells.length;
    // nur gleichförmige Tabellen (keine Gruppenzeilen mit colspan)
    var grouped = Array.prototype.some.call(body.rows, function (r) { return r.cells.length !== cols && !/^\s*(Summe|Gesamt)/i.test(r.textContent); });
    if (grouped) return;
    var key = 'vd-sort:' + location.pathname + ':' + ti;
    function apply(i, dir) {
      var rows = Array.prototype.slice.call(body.rows);
      var fixed = rows.filter(function (r) { return r.cells.length !== cols || /^\s*(Summe|Gesamt)/i.test(r.cells[0] ? r.cells[0].textContent : '') || r.classList.contains('nosort'); });
      var data = rows.filter(function (r) { return fixed.indexOf(r) < 0; });
      data.sort(function (a, b) { return cmp(sortKey(a.cells[i]), sortKey(b.cells[i])) * dir; });
      data.concat(fixed).forEach(function (r) { body.appendChild(r); });
      Array.prototype.forEach.call(head.cells, function (c, j) { c.classList.remove('asc', 'desc'); if (j === i) c.classList.add(dir > 0 ? 'asc' : 'desc'); });
      var label = (head.cells[i].textContent || '').trim();
      Array.prototype.forEach.call(document.querySelectorAll('a[data-export]'), function (a) {
        var u = new URL(a.href, location.href); u.searchParams.set('sort', label); u.searchParams.set('dir', dir > 0 ? 'asc' : 'desc'); a.href = u.pathname + u.search;
      });
    }
    Array.prototype.forEach.call(head.cells, function (th, i) {
      if (!th.textContent.trim() || th.querySelector('input,button,select')) return;
      th.classList.add('sortable');
      th.title = 'Sortieren';
      th.addEventListener('click', function () {
        var dir = th.classList.contains('asc') ? -1 : 1;
        apply(i, dir);
        try { ss && ss.setItem(key, JSON.stringify([i, dir])); } catch (e) {}
      });
    });
    try { var saved = ss && JSON.parse(ss.getItem(key) || 'null'); if (saved && saved[0] < cols) apply(saved[0], saved[1]); } catch (e) {}
  }
  Array.prototype.forEach.call(document.querySelectorAll('table'), sortable);

  // ---- Listen filtern: <input data-filter-list="CSS-Selektor"> blendet nicht passende Einträge aus ----
  document.querySelectorAll('[data-filter-list]').forEach(function (inp) {
    if (inp.dataset.filterWired) return;
    inp.dataset.filterWired = '1';
    var sel = inp.getAttribute('data-filter-list');
    inp.addEventListener('input', function () {
      var t = inp.value.toLowerCase().trim();
      document.querySelectorAll(sel).forEach(function (l) {
        l.hidden = !!t && l.textContent.toLowerCase().indexOf(t) < 0;
      });
    });
  });

  // ---- Dropdown-Menüs ----
  var menus = document.querySelectorAll('details.dd');
  Array.prototype.forEach.call(menus, function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) Array.prototype.forEach.call(menus, function (o) { if (o !== d && !o.contains(d)) o.open = false; });
    });
  });
  document.addEventListener('click', function (e) {
    Array.prototype.forEach.call(menus, function (d) { if (d.open && !d.contains(e.target)) d.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') Array.prototype.forEach.call(menus, function (d) { d.open = false; });
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag)) {
      var s = document.getElementById('q'); if (s) { e.preventDefault(); s.focus(); }
    }
  });
  // Tags/Sprachen als Buttons („Chips“) wie Fortytools: Enter oder Auswahl fügt hinzu, × entfernt
  Array.prototype.forEach.call(document.querySelectorAll('[data-chips]'), function (box) {
    var name = box.getAttribute('data-chips'), inp = box.querySelector('input:not([type=hidden])');
    var strict = box.hasAttribute('data-strict'), list = inp && inp.list;
    function has(v) { return Array.prototype.some.call(box.querySelectorAll('input[type=hidden]'), function (h) { return h.value.toLowerCase() === v.toLowerCase(); }); }
    function add(v) {
      v = (v || '').trim().replace(/[,;]+$/, ''); if (!v || has(v)) { inp.value = ''; return; }
      if (strict && list && !Array.prototype.some.call(list.options, function (o) { return o.value === v; })) return;
      var c = document.createElement('span'); c.className = 'chip'; c.textContent = v;
      var b = document.createElement('button'); b.type = 'button'; b.textContent = '×'; b.setAttribute('aria-label', v + ' entfernen');
      var h = document.createElement('input'); h.type = 'hidden'; h.name = name; h.value = v;
      c.appendChild(b); c.appendChild(h); box.insertBefore(c, inp); inp.value = '';
      box.closest('form') && box.closest('form').dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!inp) return;
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(inp.value); }
      else if (e.key === 'Backspace' && !inp.value) { var l = box.querySelectorAll('.chip:not(.fixed)'); if (l.length) l[l.length - 1].remove(); }
    });
    inp.addEventListener('change', function () { add(inp.value); });
    inp.addEventListener('blur', function () { if (!strict) add(inp.value); });
    box.addEventListener('click', function (e) {
      if (e.target.tagName === 'BUTTON' && e.target.parentNode.classList.contains('chip')) e.target.parentNode.remove();
      else if (e.target === box) inp.focus();
    });
  });
  // Globale Suche: Vorschau unter dem Suchfeld (wie Fortytools), je Bereich bis 5 Treffer
  (function () {
    var q = document.getElementById('q'); if (!q) return;
    var form = q.closest('form'); var drop = document.createElement('div'); drop.className = 'sdrop'; drop.hidden = true;
    form.appendChild(drop); q.setAttribute('autocomplete', 'off');
    var timer = null, seq = 0, links = [], act = -1;
    function esc(t) { var d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }
    function mark(t, words) {
      var low = String(t).toLowerCase(), out = '', i = 0;
      while (i < t.length) {
        var best = -1, len = 0;
        words.forEach(function (w) { var p = low.indexOf(w, i); if (p >= 0 && (best < 0 || p < best)) { best = p; len = w.length; } });
        if (best < 0) { out += esc(t.slice(i)); break; }
        out += esc(t.slice(i, best)) + '<mark>' + esc(t.slice(best, best + len)) + '</mark>'; i = best + len;
      }
      return out;
    }
    function render(res) {
      var words = res.q.toLowerCase().split(' ').filter(Boolean);
      if (!res.groups.length) { drop.innerHTML = '<div class="sd-none">Nichts gefunden</div>'; drop.hidden = false; links = []; return; }
      var h = '';
      res.groups.forEach(function (g) {
        h += '<div class="sd-grp">';
        g.hits.forEach(function (x, i) {
          h += '<a class="sd-row" href="' + esc(x.href) + '"><span class="sd-type">' + (i === 0 ? esc(g.type) : '') + '</span>' +
            '<span class="sd-main"><b>' + mark(x.label, words) + '</b>' + (x.sub ? ' <span class="sd-sub">' + esc(x.sub) + '</span>' : '') +
            '<span class="sd-snip">' + mark(x.snippet, words) + '</span></span></a>';
        });
        if (g.more) h += '<a class="sd-more" href="/suche?q=' + encodeURIComponent(res.q) + '&typ=' + encodeURIComponent(g.type) + '">… und einige weitere</a>';
        h += '</div>';
      });
      h += '<a class="sd-all" href="/suche?q=' + encodeURIComponent(res.q) + '">Alle Ergebnisse anzeigen (Enter)</a>';
      drop.innerHTML = h; drop.hidden = false; links = [].slice.call(drop.querySelectorAll('a')); act = -1;
    }
    function run() {
      var v = q.value.trim(); if (v.length < 2) { drop.hidden = true; return; }
      var my = ++seq;
      fetch('/suche.json?q=' + encodeURIComponent(v), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) { if (res && my === seq && document.activeElement === q) render(res); }).catch(function () {});
    }
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 180); });
    q.addEventListener('focus', function () { if (q.value.trim().length >= 2) run(); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { drop.hidden = true; return; }
      if (drop.hidden || !links.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); act = e.key === 'ArrowDown' ? Math.min(links.length - 1, act + 1) : Math.max(-1, act - 1);
        links.forEach(function (l, i) { l.classList.toggle('act', i === act); }); if (links[act]) links[act].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && act >= 0) { e.preventDefault(); location.href = links[act].href; }
    });
    document.addEventListener('click', function (e) { if (!form.contains(e.target)) drop.hidden = true; });
  })();
  // Beschäftigungsart-Chip folgt der Auswahl
  var emp = document.getElementById('employment_type'), ec = document.querySelector('[data-emp-chip]');
  if (emp && ec) emp.addEventListener('change', function () { ec.textContent = emp.options[emp.selectedIndex].text; });
})();
`;
