// Správa galerie: mazání, pořadí a popisky fotek přes Supabase funkci (heslo ADMIN_CODE).
(function () {
  'use strict';

  var FUNCTION_URL = 'https://zwbaziqhcgikylvqmqrf.supabase.co/functions/v1/florbal-upload';
  var KEY = 'florbal-admin';

  var $ = function (id) { return document.getElementById(id); };
  var code = '';
  var data = null;      // { head, repo, years, settings }
  var year = null;      // vybraný ročník (číslo)
  var orig = null;      // původní stav ročníku { title, photos: [{file, alt}] }
  var items = [];       // pracovní kopie [{ file, alt, by, removed }]
  var title = '';

  function store(val) {
    try {
      if (val === undefined) return localStorage.getItem(KEY) || '';
      if (val === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, val);
    } catch (e) { return ''; }
  }
  function status(text, kind) {
    var s = $('status');
    s.textContent = text || '';
    s.hidden = !text;
    s.className = 'box' + (kind ? ' ' + kind : '');
  }
  var ERRORS = {
    bad_code: 'Špatné heslo.',
    admin_off: 'Správa galerie není zapnutá (v Supabase chybí ADMIN_CODE).',
    busy: 'Někdo zrovna nahrává fotky. Zkuste to za chvíli znovu.',
    origin: 'Správa funguje jen na www.florbaljivova.cz.',
  };

  function call(body) {
    body.code = code;
    return fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok || !b.ok) { var e = new Error(b.error || 'http'); e.code = b.error; throw e; }
        return b;
      });
    });
  }
  function errText(e) {
    return ERRORS[e.code] || 'Něco se pokazilo (' + (e.code || e.message) + '). Zkuste to znovu.';
  }

  // ---------- Přihlášení ----------

  function load(keepYear) {
    status('Načítám…');
    return call({ action: 'list' }).then(function (d) {
      data = d;
      status('');
      $('login').hidden = true;
      $('app').hidden = false;
      renderUploads();
      var sel = $('year');
      sel.textContent = '';
      var years = d.years.slice().sort(function (a, b) { return b.year - a.year; });
      years.forEach(function (y) {
        var o = document.createElement('option');
        o.value = String(y.year);
        o.textContent = y.year + ' (' + y.photos.length + ' ' + plural(y.photos.length) + ')';
        sel.append(o);
      });
      var pick = keepYear && years.some(function (y) { return y.year === keepYear; }) ? keepYear : (years[0] && years[0].year);
      if (pick) { sel.value = String(pick); selectYear(pick); }
    });
  }

  $('login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    code = $('code').value;
    load().then(function () {
      if ($('remember').checked) store(code);
    }).catch(function (e) {
      code = '';
      status(errText(e), 'error');
    });
  });

  $('logout').addEventListener('click', function () {
    if (dirty() && !confirm('Máte neuložené změny. Opravdu odhlásit?')) return;
    store(null); code = ''; data = null;
    $('app').hidden = true; $('savebar').hidden = true; $('login').hidden = false; $('code').value = '';
    status('');
  });

  var saved = store();
  if (saved) {
    code = saved;
    $('remember').checked = true;
    load().catch(function (e) { code = ''; store(null); status(errText(e), 'error'); });
  }

  // ---------- Vypínač nahrávání ----------

  function renderUploads() {
    var on = !!(data.settings && data.settings.enabled);
    $('uplState').textContent = on ? 'zapnuto' : 'vypnuto';
    $('uplState').className = on ? 'on' : 'off';
    $('uplToggle').textContent = on ? 'Vypnout' : 'Zapnout';
    $('uplToggle').className = 'btn btn-small ' + (on ? '' : 'btn-blue');
  }
  $('uplToggle').addEventListener('click', function () {
    var btn = this, on = !!data.settings.enabled;
    if (on && !confirm('Vypnout nahrávání fotek pro všechny?')) return;
    btn.disabled = true;
    call({ action: 'settings', enabled: !on }).then(function (r) {
      data.settings = r.settings;
      renderUploads();
      status('Nahrávání je ' + (r.settings.enabled ? 'zapnuté' : 'vypnuté') + '. Projeví se do 1–2 minut.', 'ok');
    }).catch(function (e) { status(errText(e), 'error'); })
      .then(function () { btn.disabled = false; });
  });

  // ---------- Ročník ----------

  function plural(n) { return n === 1 ? 'fotka' : (n >= 2 && n <= 4) ? 'fotky' : 'fotek'; }

  function selectYear(y) {
    var entry = data.years.filter(function (e) { return e.year === y; })[0];
    year = y;
    orig = { title: entry.title || '', photos: entry.photos.map(function (p) { return { file: p.file, alt: p.alt || '' }; }) };
    items = entry.photos.map(function (p) { return { file: p.file, alt: p.alt || '', by: p.by || '', removed: false }; });
    title = orig.title;
    $('title').value = title;
    render();
  }

  $('year').addEventListener('change', function () {
    if (dirty() && !confirm('Máte neuložené změny v ročníku ' + year + '. Zahodit je?')) { this.value = String(year); return; }
    selectYear(Number(this.value));
  });
  $('title').addEventListener('input', function () { title = this.value; updateBar(); });

  function thumbUrl(file) {
    return 'https://raw.githubusercontent.com/' + data.repo + '/' + data.head + '/img/' + year + '/nahledy/' + file;
  }

  function render() {
    var grid = $('grid');
    grid.textContent = '';
    var visible = 0;
    items.forEach(function (it, i) {
      if (!it.removed) visible++;
      var card = document.createElement('div');
      card.className = 'pcard' + (it.removed ? ' removed' : '');

      var pic = document.createElement('div');
      pic.className = 'pic';
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = thumbUrl(it.file);
      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = (i + 1) + '';
      pic.append(img, num);
      if (it.by) {
        var by = document.createElement('span');
        by.className = 'by';
        by.textContent = 'Foto: ' + it.by;
        pic.append(by);
      }

      var alt = document.createElement('input');
      alt.type = 'text';
      alt.maxLength = 200;
      alt.placeholder = 'Popisek fotky';
      alt.value = it.alt;
      alt.disabled = it.removed;
      alt.setAttribute('aria-label', 'Popisek fotky ' + (i + 1));
      alt.addEventListener('input', function () { it.alt = alt.value; updateBar(); });

      var acts = document.createElement('div');
      acts.className = 'acts';
      var up = button('↑', 'Posunout dopředu', i === 0 || it.removed, function () { move(i, -1); });
      var down = button('↓', 'Posunout dozadu', i === items.length - 1 || it.removed, function () { move(i, 1); });
      var del = button(it.removed ? 'Vrátit' : 'Smazat', it.removed ? 'Vrátit fotku' : 'Smazat fotku', false, function () {
        it.removed = !it.removed; render();
      });
      del.className = 'del';
      acts.append(up, down, del);

      card.append(pic, alt, acts);
      grid.append(card);
    });
    $('count').textContent = 'V galerii: ' + visible + ' ' + plural(visible) + '. Šipkami měníte pořadí, popisek se ukáže při zvětšení fotky.';
    if (!items.length) $('count').textContent = 'Tento ročník zatím nemá žádné fotky.';
    updateBar();
  }

  function button(text, label, disabled, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function move(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= items.length) return;
    var t = items[i]; items[i] = items[j]; items[j] = t;
    render();
  }

  // ---------- Změny a uložení ----------

  function summary() {
    var removed = items.filter(function (it) { return it.removed; }).length;
    var kept = items.filter(function (it) { return !it.removed; });
    var origKept = orig.photos.filter(function (p) { return kept.some(function (k) { return k.file === p.file; }); });
    var moved = kept.some(function (k, i) { return origKept[i].file !== k.file; });
    var captions = kept.filter(function (k) {
      return orig.photos.filter(function (p) { return p.file === k.file; })[0].alt !== k.alt;
    }).length;
    var titleChanged = title.trim() !== orig.title.trim();
    return { removed: removed, moved: moved, captions: captions, title: titleChanged };
  }
  function dirty() {
    if (!orig) return false;
    var s = summary();
    return !!(s.removed || s.moved || s.captions || s.title);
  }
  function updateBar() {
    var s = summary(), parts = [];
    if (s.removed) parts.push('smazat ' + s.removed);
    if (s.moved) parts.push('nové pořadí');
    if (s.captions) parts.push('popisky ' + s.captions);
    if (s.title) parts.push('nadpis');
    $('savebar').hidden = !parts.length;
    $('changes').textContent = 'Změny: ' + parts.join(', ');
  }

  $('discard').addEventListener('click', function () { selectYear(year); status(''); });

  $('save').addEventListener('click', function () {
    var s = summary();
    if (s.removed && !confirm('Opravdu smazat ' + s.removed + ' ' + plural(s.removed) + '? Z webu zmizí natrvalo.')) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Ukládám…';
    call({
      action: 'save',
      year: year,
      title: title,
      known: orig.photos.map(function (p) { return p.file; }),
      photos: items.filter(function (it) { return !it.removed; }).map(function (it) { return { file: it.file, alt: it.alt }; }),
    }).then(function (r) {
      return load(year).then(function () {
        status('Uloženo.' + (r.removed ? ' Smazáno ' + r.removed + ' ' + plural(r.removed) + '.' : '') +
          ' Na webu se změny projeví do 1–2 minut.', 'ok');
      });
    }).catch(function (e) { status(errText(e), 'error'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Uložit změny'; });
  });

  window.addEventListener('beforeunload', function (ev) {
    if (dirty()) { ev.preventDefault(); ev.returnValue = ''; }
  });
})();
