// Nahrávání fotek do galerie: zmenšení v prohlížeči, odeslání do Supabase funkce.
(function () {
  'use strict';

  var FUNCTION_URL = 'https://zwbaziqhcgikylvqmqrf.supabase.co/functions/v1/florbal-upload';
  var LARGE = 1600, THUMB = 600, BATCH = 6, MAX_FILES = 50;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('form'), statusEl = $('status'), bar = $('bar'), send = $('send');

  function status(text, kind) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
    statusEl.className = 'box' + (kind ? ' ' + kind : '');
  }
  function progress(done, total) {
    bar.hidden = !total;
    bar.firstElementChild.style.width = total ? Math.round(done / total * 100) + '%' : '0';
  }
  function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; } }

  // Nastavení (vypínač, rozsah ročníků)
  fetch('../upload-settings.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (!s.enabled) { $('closed').hidden = false; return; }
      var sel = $('year');
      for (var y = s.toYear; y >= s.fromYear; y--) {
        var o = document.createElement('option');
        o.value = o.textContent = String(y);
        sel.append(o);
      }
      var lastYear = store('florbal-year') || String(new Date().getFullYear());
      if (sel.querySelector('option[value="' + lastYear + '"]')) sel.value = lastYear;
      $('code').value = store('florbal-code') || '';
      $('name').value = store('florbal-name') || '';
      form.hidden = false;
    })
    .catch(function () { $('closed').textContent = 'Stránku se nepodařilo načíst. Zkuste to prosím znovu.'; $('closed').hidden = false; });

  // Náhledy vybraných fotek
  $('files').addEventListener('change', function () {
    var box = $('previews');
    box.textContent = '';
    status('');
    var files = Array.prototype.slice.call(this.files, 0, MAX_FILES);
    if (this.files.length > MAX_FILES) status('Vybrali jste ' + this.files.length + ' fotek, nahraje se prvních ' + MAX_FILES + '.', 'warn');
    files.forEach(function (f) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = URL.createObjectURL(f);
      img.onload = function () { URL.revokeObjectURL(img.src); };
      box.append(img);
    });
  });

  // Zmenšení fotky v prohlížeči (otočení podle EXIF, odstranění metadat)
  function loadImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('decode')); };
      img.src = URL.createObjectURL(file);
    });
  }
  function resize(source, max, quality) {
    var w = source.width, h = source.height;
    var scale = Math.min(1, max / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, cw, ch);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve({ blob: b, w: cw, h: ch }) : reject(new Error('encode')); }, 'image/jpeg', quality);
    });
  }
  function prepare(file) {
    return loadImage(file).then(function (img) {
      return resize(img, LARGE, 0.82).then(function (big) {
        return resize(img, THUMB, 0.75).then(function (thumb) {
          if (img.close) img.close();
          return { big: big, thumb: thumb };
        });
      });
    });
  }

  function upload(batch, code, year, name, index, total) {
    var fd = new FormData();
    fd.append('code', code);
    fd.append('year', year);
    fd.append('name', name);
    fd.append('count', String(batch.length));
    fd.append('batch', String(index));
    fd.append('total', String(total));
    batch.forEach(function (p, i) {
      fd.append('photo' + i, p.big.blob, 'photo' + i + '.jpg');
      fd.append('thumb' + i, p.thumb.blob, 'thumb' + i + '.jpg');
    });
    return fetch(FUNCTION_URL, { method: 'POST', body: fd }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) { var e = new Error(body.error || 'http'); e.status = r.status; e.detail = body.detail; throw e; }
        return body;
      });
    });
  }

  function errorText(err) {
    switch (err.message) {
      case 'bad_code': return 'Kód pro nahrávání není správný.';
      case 'closed': return 'Nahrávání fotek je teď vypnuté.';
      case 'bad_year': return 'Pro tento ročník teď nahrávat nejde.';
      case 'year_full': return 'Galerie tohoto ročníku je už plná.';
      case 'too_many': return 'Najednou se dá poslat jen pár fotek. Zkuste to znovu.';
      case 'bad_image': return 'Některá fotka má nepodporovaný formát.';
      case 'busy': return 'Teď nahrává někdo jiný. Zkuste to za chvilku znovu.';
      default: return 'Nahrávání se nepovedlo. Zkontrolujte připojení a zkuste to znovu.';
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('code').value.trim();
    var year = $('year').value;
    var name = $('name').value.trim().slice(0, 40);
    var files = Array.prototype.slice.call($('files').files, 0, MAX_FILES);
    if (!code) { status('Zadejte kód pro nahrávání.', 'error'); return; }
    if (!files.length) { status('Vyberte aspoň jednu fotku.', 'error'); return; }

    store('florbal-code', code); store('florbal-year', year); store('florbal-name', name);
    send.disabled = true;
    var total = files.length, done = 0, skipped = 0, sent = 0;
    status('Připravuji fotky… 0 z ' + total);
    progress(0, total);

    // Dávky: zatímco se jedna odesílá, další se už zmenšuje
    var slices = [];
    for (var i = 0; i < files.length; i += BATCH) slices.push(files.slice(i, i + BATCH));
    function prepSlice(slice) {
      return Promise.all(slice.map(function (f) {
        return prepare(f).catch(function () { skipped++; return null; });
      })).then(function (list) { return list.filter(Boolean); });
    }

    var batchNo = 0, timings = [], tStart = Date.now(), tWait = tStart;
    var nextPrep = prepSlice(slices[0]);
    var chain = Promise.resolve();
    slices.forEach(function (slice, k) {
      chain = chain.then(function () { tWait = Date.now(); return nextPrep; }).then(function (prepared) {
        if (k + 1 < slices.length) nextPrep = prepSlice(slices[k + 1]);
        if (!prepared.length) return;
        var tUp = Date.now();
        return upload(prepared, code, year, name, batchNo++, total).then(function (res) {
          sent += res.added || prepared.length;
          timings.push({ photos: prepared.length, waitPrepMs: tUp - tWait, uploadMs: Date.now() - tUp, server: res.timing });
        });
      }).then(function () {
        done += slice.length;
        progress(done, total);
        status('Nahrávám… ' + done + ' z ' + total);
      });
    });

    chain.then(function () {
      progress(0, 0);
      var msg = sent ? 'Hotovo! Nahráno ' + sent + ' ' + (sent === 1 ? 'fotka' : sent < 5 ? 'fotky' : 'fotek') + '. Nahrání fotek může pár minut trvat. Pokud se vaše fotky neobjeví v galerii, počkejte a poté znovu načtěte stránku.' : 'Žádná fotka se nenahrála.';
      if (skipped) msg += ' ' + skipped + ' souborů se nepodařilo otevřít (nejsou to fotky?).';
      status(msg, sent ? 'ok' : 'error');
      if (sent) { $('files').value = ''; $('previews').textContent = ''; }
      var link = document.createElement('a');
      link.href = '../galerie.html'; link.textContent = ' Otevřít galerii →';
      if (sent) statusEl.append(link);
      var report = { totalMs: Date.now() - tStart, batches: timings };
      if (window.console) console.log('upload timing', JSON.stringify(report));
      if (/[?&]debug\b/.test(location.search)) {
        var pre = document.createElement('pre');
        pre.className = 'hint';
        pre.style.whiteSpace = 'pre-wrap';
        pre.textContent = JSON.stringify(report);
        statusEl.append(pre);
      }
    }, function (err) {
      progress(0, 0);
      var msg = errorText(err);
      if (err.detail) msg += ' [' + err.detail + ']';
      if (sent) msg = 'Nahráno ' + sent + ' fotek, pak nastala chyba: ' + msg;
      status(msg, 'error');
    }).then(function () { send.disabled = false; });
  });
})();
