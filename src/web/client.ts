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
          apply(form, data);
          banner(form, 'Ihre nicht gespeicherten Eingaben wurden wiederhergestellt.', [
            { label: 'Verwerfen', run: function () { ss.removeItem(key); location.reload(); } },
          ]);
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
})();
`;
