/* =====================================================================
   CNC Suite — оболочка рабочего пространства:
   рабочие области, меню-бар, плавающие окна, тултипы, статусбар и Ctrl+S
   ===================================================================== */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function svg(id, cls) { return '<svg class="ic ' + (cls || '') + '"><use href="#' + id + '"/></svg>'; }

  /* ---------------------------- данные окон ---------------------------- */
  var WS_LABEL = { gen: 'Генерация G-code', send: 'Отправка G-code' };
  var WINDOWS = {
    gen: [
      { id: 'win-mill', label: 'Фрезер', save: 'cnc-download', file: 'mill.nc' },
      { id: 'win-laser', label: 'Лазер', save: 'laser-download', file: 'laser.gcode' },
      { id: 'win-drill', label: 'Сверловка', save: 'drill-download', file: 'drill.nc' },
      { id: 'win-drc', label: 'Анализ зазоров', save: null },
      { id: 'win-measure', label: 'Измерение', save: null }
    ],
    send: [
      { id: 'win-connect', label: 'Подключение' },
      { id: 'win-gcode', label: 'G-code' },
      { id: 'win-machine', label: 'Пульт' },
      { id: 'win-hm', label: 'Карта высот' },
      { id: 'win-view', label: 'Вид' }
    ]
  };
  var openWin = { gen: 'win-mill', send: 'win-connect' };

  function winMeta(id) {
    var all = WINDOWS.gen.concat(WINDOWS.send);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ---------------------------- статусбар / хинты ---------------------------- */
  var HINT = document.getElementById('statusHint');
  var HINT0 = HINT ? HINT.innerHTML : '';
  var hintTimer = 0;
  function setHint(html, ms) {
    if (!HINT) return;
    HINT.innerHTML = html;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { HINT.innerHTML = HINT0; }, ms || 3400);
  }

  /* ---------------------------- тултипы ---------------------------- */
  var TIP = document.getElementById('tip');
  var tipEl = null, tipTimer = 0;
  function placeTip() {
    if (!TIP || !tipEl) return;
    var r = tipEl.getBoundingClientRect(), t = TIP.getBoundingClientRect();
    var x = r.left + 2, y = r.bottom + 6;
    if (y + t.height > window.innerHeight - 30) y = r.top - t.height - 6;
    if (x + t.width > window.innerWidth - 6) x = window.innerWidth - t.width - 6;
    TIP.style.left = Math.round(Math.max(4, x)) + 'px';
    TIP.style.top = Math.round(Math.max(4, y)) + 'px';
  }
  function tipShow(el) {
    if (!TIP) return;
    var title = el.getAttribute('data-tip');
    if (!title) return;
    var key = el.getAttribute('data-tip-key'), desc = el.getAttribute('data-tip-desc');
    TIP.innerHTML = '<span class="tt-title">' + title + '</span>' +
      (key ? '<span class="tt-key">(' + key + ')</span>' : '') +
      (desc ? '<span class="tt-desc">' + desc + '</span>' : '');
    tipEl = el;
    TIP.classList.add('show');
    placeTip();
  }
  function tipHide() {
    clearTimeout(tipTimer);
    tipEl = null;
    if (TIP) TIP.classList.remove('show');
  }
  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) { tipHide(); return; }
    if (el === tipEl) return;
    tipHide();
    tipTimer = setTimeout(function () { tipShow(el); }, 420);
  });
  document.addEventListener('mousemove', function () {
    if (tipEl && TIP && TIP.classList.contains('show')) placeTip();
  });
  document.addEventListener('mouseout', function (e) {
    if (e.target.closest && e.target.closest('[data-tip]')) tipHide();
  });
  document.addEventListener('mousedown', function () { tipHide(); }, true);
  window.addEventListener('resize', tipHide);

  /* ---------------------------- рабочие области и окна ---------------------------- */
  var relayoutTimer = 0;
  function relayout() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 40);
  }
  function showOnly(id) {
    $$('.bl-win').forEach(function (w) { w.classList.toggle('show', w.id === id); });
  }
  function setWorkspace(name, silent) {
    if (name !== 'gen' && name !== 'send') return;
    document.body.dataset.ws = name;
    $$('#workspaces .bl-ws').forEach(function (t) { t.classList.toggle('active', t.dataset.ws === name); });
    $$('.ws-view').forEach(function (v) { v.classList.toggle('active', v.dataset.ws === name); });
    var pg = document.getElementById('panelGen'), ps = document.getElementById('panelSend');
    if (pg) pg.hidden = (name !== 'gen');
    if (ps) ps.hidden = (name !== 'send');
    var hl = document.getElementById('hdrWsLabel');
    if (hl) hl.textContent = WS_LABEL[name];
    var st = document.getElementById('statusWs');
    if (st) st.textContent = 'Рабочая область: ' + WS_LABEL[name];
    var pt = document.getElementById('propsTitle');
    if (pt) pt.textContent = (name === 'gen') ? 'Слои и легенда' : 'Консоль GRBL';
    showOnly(openWin[name]);
    if (!silent) setHint('Рабочая область: <b>' + WS_LABEL[name] + '</b>');
    relayout();
  }
  function openWindow(id) {
    var m = winMeta(id), el = document.getElementById(id);
    if (!m || !el) return;
    var space = el.getAttribute('data-ws') || 'gen';
    openWin[space] = id;
    if (document.body.dataset.ws !== space) setWorkspace(space, true); else showOnly(id);
    showOnly(id);
    setHint('<b>' + m.label + '</b> — окно открыто' + (m.file ? ' · файл ' + m.file : ''));
    relayout();
  }
  function closeWindow(id) {
    var el = document.getElementById(id), m = winMeta(id);
    if (!el) return;
    el.classList.remove('show');
    setHint('Окно <b>' + (m ? m.label : '') + '</b> закрыто');
  }
  function toggleWindow(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.classList.contains('show')) closeWindow(id); else openWindow(id);
  }

  /* ---------------------------- сохранение файла ---------------------------- */
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function canSave() {
    if (document.body.dataset.ws === 'send') {
      var ta = document.getElementById('gcode');
      return !!(ta && ta.value && ta.value.trim());
    }
    var m = winMeta(openWin.gen);
    if (!m || !m.save) return false;
    var b = document.getElementById(m.save);
    return !!(b && !b.disabled);
  }
  function saveActive() {
    if (document.body.dataset.ws === 'send') {
      var ta = document.getElementById('gcode');
      var txt = (ta && ta.value) || '';
      if (!txt.trim()) { setHint('<b>Нечего сохранять</b> — поле G-code пустое'); return; }
      download('program.gcode', txt);
      setHint('Сохранён файл: <b>program.gcode</b>');
      return;
    }
    var m = winMeta(openWin.gen);
    if (!m || !m.save) {
      setHint('<b>Нечего сохранять</b> — окно «' + (m ? m.label : '—') + '» не генерирует G-code');
      return;
    }
    var b = document.getElementById(m.save);
    if (!b || b.disabled) { setHint('<b>Нечего сохранять</b> — сначала сгенерируйте G-code'); return; }
    b.click();
    setHint('Сохранён файл: <b>' + m.file + '</b>');
  }

  /* ---------------------------- меню ---------------------------- */
  var MENUS = {};
  MENUS.file = function () {
    var isSend = document.body.dataset.ws === 'send';
    var can = canSave();
    var emptyHint = isSend
      ? '<b>Нечего сохранять</b> — поле G-code пустое'
      : '<b>Нечего сохранять</b> — сначала сгенерируйте G-code';
    return [
      { label: 'Открыть DXF…', icon: 'i-folder', action: function () { document.getElementById('dxf-file-input').click(); } },
      { label: 'Открыть G-code…', icon: 'i-file', action: function () { document.getElementById('fileInput').click(); } },
      '-',
      { label: 'Сохранить G-code', key: 'Ctrl+S', icon: 'i-check', dis: !can, disHint: emptyHint, action: saveActive },
      '-',
      { label: 'Рабочая область: генерация', chk: !isSend, action: function () { setWorkspace('gen'); } },
      { label: 'Рабочая область: отправка', chk: isSend, action: function () { setWorkspace('send'); } },
      '-',
      { label: 'О программе CNC Suite', action: function () {
        setHint('<b>CNC Suite</b> — DXF → G-code (фрезер / лазер / сверловка) и отправка на ESP8266 (GRBL) по WebSocket.');
      } }
    ];
  };
  MENUS.winGen = function () {
    return WINDOWS.gen.map(function (w) {
      return { label: w.label, chk: openWin.gen === w.id, action: function () { toggleWindow(w.id); } };
    });
  };
  MENUS.winSend = function () {
    return WINDOWS.send.map(function (w) {
      return { label: w.label, chk: openWin.send === w.id, action: function () { toggleWindow(w.id); } };
    });
  };
  MENUS.editorType = function () {
    return [
      { label: 'Генерация G-code (3D)', chk: document.body.dataset.ws === 'gen', action: function () { setWorkspace('gen'); } },
      { label: 'Отправка G-code (3D)', chk: document.body.dataset.ws === 'send', action: function () { setWorkspace('send'); } }
    ];
  };
  MENUS.app = function () {
    return [
      { label: 'CNC Suite — о программе', action: function () {
        setHint('<b>CNC Suite</b> — DXF → G-code (фрезер / лазер / сверловка) и отправка на ESP8266 (GRBL) по WebSocket.');
      } },
      '-',
      { label: 'Рабочая область: генерация', chk: document.body.dataset.ws === 'gen', action: function () { setWorkspace('gen'); } },
      { label: 'Рабочая область: отправка', chk: document.body.dataset.ws === 'send', action: function () { setWorkspace('send'); } },
      '-',
      { label: 'Перезагрузить страницу', action: function () { location.reload(); } }
    ];
  };

  var LAYER = document.getElementById('menuLayer');
  var openMenus = [], trig = null;

  function buildLevel(items) {
    var box = document.createElement('div');
    box.className = 'bl-menu';
    items.forEach(function (it) {
      if (it === '-' || it.sep) {
        var s = document.createElement('div');
        s.className = 'bl-menu-sep';
        box.appendChild(s);
        return;
      }
      var row = document.createElement('div');
      row.className = 'bl-menu-item' + (it.dis ? ' disabled' : '');
      row.innerHTML = (it.chk !== undefined ? '<span class="chk">' + (it.chk ? svg('i-check', 'ic-12') : '') + '</span>' : '') +
        (it.icon ? '<span class="mi-icon">' + svg(it.icon, 'ic-14') + '</span>' : '') +
        '<span class="mi-label">' + it.label + '</span>' +
        (it.key ? '<span class="mi-key">' + it.key + '</span>' : '');
      row.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (it.dis) { setHint(it.disHint || ('<b>' + it.label + '</b> — недоступно')); return; }
        closeMenus();
        if (it.action) it.action(); else setHint('<b>' + it.label + '</b> — команда-заглушка');
      });
      box.appendChild(row);
    });
    LAYER.appendChild(box);
    openMenus.push(box);
    return box;
  }
  function placeMenu(box, x, y) {
    box.style.left = '0px';
    box.style.top = '0px';
    var r = box.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 4) x = window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight - 4) y = window.innerHeight - r.height - 4;
    box.style.left = Math.round(Math.max(4, x)) + 'px';
    box.style.top = Math.round(Math.max(4, y)) + 'px';
  }
  function closeMenus() {
    openMenus.forEach(function (b) { if (b.parentNode) b.parentNode.removeChild(b); });
    openMenus = [];
    if (trig) { trig.classList.remove('open'); trig = null; }
  }
  function openMenu(trigger) {
    var name = trigger.getAttribute('data-menu');
    if (!name) return;
    var items = MENUS[name];
    if (typeof items === 'function') items = items();
    if (!items) items = [{ label: name, dis: true }];
    closeMenus();
    var box = buildLevel(items);
    var r = trigger.getBoundingClientRect();
    placeMenu(box, r.left + 2, r.bottom + 1);
    trig = trigger;
    trigger.classList.add('open');
  }

  /* ---------------------------- события оболочки ---------------------------- */
  document.addEventListener('mousedown', function (e) {
    var t = e.target;
    if (t.closest && t.closest('.bl-menu')) return;
    var tr = t.closest ? t.closest('[data-menu]') : null;
    if (tr) { e.preventDefault(); openMenu(tr); return; }
    closeMenus();
  });
  document.addEventListener('mouseover', function (e) {
    if (!trig) return;
    var t = e.target.closest ? e.target.closest('[data-menu]') : null;
    if (!t || t === trig) return;
    if (openMenus.some(function (b) { return b.contains(t); })) return;
    openMenu(t);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenus();
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveActive(); }
  });
  document.addEventListener('click', function (e) {
    var x = e.target.closest ? e.target.closest('.bl-win-head .x') : null;
    if (x) { var w = x.closest('.bl-win'); if (w) closeWindow(w.id); return; }
    var h = e.target.closest ? e.target.closest('.bl-panel-head') : null;
    if (h) { var p = h.closest('.bl-panel'); if (p) p.classList.toggle('collapsed'); }
  });
  var WSTABS = document.getElementById('workspaces');
  if (WSTABS) WSTABS.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.bl-ws') : null;
    if (t) setWorkspace(t.dataset.ws);
  });

  /* ---------------------------- старт ---------------------------- */
  setWorkspace('gen', true);
  setHint('CNC Suite готов: «Файл» — открыть DXF/G-code, «Окно. Генератор» — модули, Ctrl+S — сохранить G-code.');
})();




