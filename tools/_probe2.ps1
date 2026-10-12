$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки tools)
Set-Location $root
$enc = New-Object System.Text.UTF8Encoding($false)

$html = [System.IO.File]::ReadAllText((Join-Path $root 'cnc_suite.html'), [System.Text.Encoding]::UTF8)

$early = @'
<script>
window.__ERR__ = [];
window.addEventListener('error', function (e) {
  window.__ERR__.push('error: ' + (e.message || '') + ' @' + (e.filename || '?') + ':' + (e.lineno || 0));
}, true);
window.addEventListener('unhandledrejection', function (e) {
  window.__ERR__.push('rejection: ' + (e.reason && (e.reason.message || e.reason)));
});
</script>
'@

$pA = @'
<script>
(function () {
  var REP = [];
  function R(s) { REP.push('__P|' + s); }
  function $(s) { return document.querySelector(s); }
  function el(id) { return document.getElementById(id); }
  function shown() { return Array.prototype.map.call(document.querySelectorAll('.bl-win.show'), function (w) { return w.id; }).join(',') || '(none)'; }
  function clickId(id) { var e = el(id); if (!e) { R('MISSING:' + id); return false; } e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; }
  function menu(name) {
    var t = $('[data-menu="' + name + '"]');
    if (!t) { R('menu-missing:' + name); return -1; }
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    var b = $('.bl-menu');
    return b ? b.querySelectorAll('.bl-menu-item').length : -2;
  }
  function item(i) {
    var b = $('.bl-menu'), r = b && b.querySelectorAll('.bl-menu-item');
    if (!r || !r[i]) { R('menu-item-missing:' + i); return; }
    r[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  function errs() { return window.__ERR__.length ? window.__ERR__.slice(0, 6).join(' || ') : '(none)'; }
  function info(id) { var e = el(id); return e ? String(e.textContent).replace(/\s+/g, ' ').trim().slice(0, 140) : 'MISSING'; }
  function dis(id) { var e = el(id); return e ? ('disabled=' + e.disabled) : 'MISSING'; }
  function wh(e) { return e ? Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height) : 'n/a'; }
  function at(t, f) { setTimeout(f, t); }

  at(400, function () {
    R('THREE=' + (typeof THREE) + ' OrbitControls=' + (typeof THREE !== 'undefined' && !!THREE.OrbitControls) +
      ' ClipperLib=' + (typeof window.ClipperLib) +
      ' ClipperCtor=' + (window.ClipperLib && typeof window.ClipperLib.Clipper) +
      ' OffsetCtor=' + (window.ClipperLib && typeof window.ClipperLib.ClipperOffset));
    R('genHost=' + wh(el('canvas-container')) + ' canvases=' + document.querySelectorAll('#canvas-container canvas').length);
    R('errs=' + errs());
  });

  at(600, function () {
    var dxf = ['0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0',
      '0', 'LINE', '8', '0', '10', '100', '20', '0', '11', '100', '21', '50',
      '0', 'CIRCLE', '8', 'L1', '10', '50', '20', '25', '40', '5',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    try {
      var inp = el('dxf-file-input');
      var dt = new DataTransfer();
      dt.items.add(new File([dxf], 'probe.dxf', { type: 'application/dxf' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      R('dxf-injected size=' + inp.files[0].size);
    } catch (e) { R('dxf-inject-failed: ' + e.message); }
  });

  at(1700, function () {
    R('layers=' + (el('layers-list') ? el('layers-list').children.length : 'n/a') + ' stats=' + info('stats'));
    clickId('cnc-generate');
  });
  at(3600, function () { R('MILL: ' + dis('cnc-download') + ' info=' + info('cnc-info')); R('errs=' + errs()); });

  at(3800, function () { menu('winGen'); });
  at(3900, function () { item(1); R('win-laser shown=' + shown()); clickId('laser-generate'); });
  at(5600, function () { R('LASER: ' + dis('laser-download') + ' info=' + info('laser-info')); });

  at(5750, function () { menu('winGen'); });
  at(5850, function () { item(2); R('win-drill shown=' + shown()); clickId('drill-generate'); });
  at(7300, function () { R('DRILL: ' + dis('drill-download') + ' info=' + info('drill-info')); });

  at(7450, function () { menu('winGen'); });
  at(7550, function () { item(3); R('win-drc shown=' + shown()); clickId('drc-generate'); });
  at(8900, function () { R('DRC: ' + info('drc-info')); });

  at(9050, function () { menu('winGen'); });
  at(9150, function () { item(4); R('win-measure shown=' + shown()); clickId('measure-btn'); });
  at(9400, function () { R('MEASURE: ' + info('measure-info')); R('errs=' + errs()); });

  at(9600, function () {
    $('[data-menu="winSend"]');
    document.querySelector('#workspaces .bl-ws[data-ws="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    R('ws=' + document.body.dataset.ws + ' shown=' + shown());
  });
  at(10000, function () {
    R('sendHost=' + wh(el('canvas3dContainer')) + ' canvas=' + wh($('#canvas3dContainer canvas')) +
      ' children=' + el('canvas3dContainer').children.length);
    R('gcode len=' + (el('gcode') ? el('gcode').value.length : 'n/a') + ' total=' + info('totalCount') + ' bb=' + info('bbInfo'));
    R('errs=' + errs());
  });
  at(10200, function () { menu('winSend'); });
  at(10300, function () { item(1); R('win-gcode shown=' + shown()); clickId('btnPreview'); });
  at(10800, function () { R('afterPreview total=' + info('totalCount') + ' g1=' + info('g1SegInfo') + ' g0=' + info('g0SegInfo') + ' sendBtn=' + dis('btnSend')); });

  at(11000, function () {
    var t = $('.bl-header [data-tip]');
    if (t) { t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); R('tip-hover-dispatched'); }
    else { R('no tip trigger'); }
  });
  at(11700, function () { var tip = el('tip'); R('tip-show=' + tip.classList.contains('show') + ' text=' + tip.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)); });

  at(12000, function () {
    // .bl-panel живут в правой колонке (#panelGen / #panelSend), а не в плавающих окнах
    [['panelSend', 'Слои/Консоль (send)'], ['panelGen', 'Лухтая (gen)']].forEach(function (pair) {
      var h = $('#' + pair[0] + ' .bl-panel-head');
      if (!h) { R('no #' + pair[0] + ' .bl-panel-head'); return; }
      var p = h.closest('.bl-panel');
      h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      var c1 = p.classList.contains('collapsed');
      h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      R(pair[0] + '-collapse=' + c1 + ' expand=' + !p.classList.contains('collapsed'));
    });
    var ta = $('#gcode'), x = $('.bl-win.show .bl-win-head .x');
    R('win-gcode-textarea=' + wh(ta) + ' closeX=' + wh(x));
    if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true })); R('afterClose shown=' + shown()); }
  });

  at(12400, function () {
    R('errs-final=' + errs());
    var pre = document.createElement('pre');
    pre.id = '__probe';
    pre.textContent = '\n' + REP.join('\n') + '\n';
    document.body.appendChild(pre);
  });
})();
</script>
'@

$i = $html.IndexOf('</head>')
if ($i -lt 0) { throw 'no </head>' }
$html2 = $html.Substring(0, $i) + $early + "`r`n" + $html.Substring($i)
$j = $html2.LastIndexOf('</body>')
if ($j -lt 0) { throw 'no </body>' }
$html2 = $html2.Substring(0, $j) + $pA + "`r`n" + $html2.Substring($j)

[System.IO.File]::WriteAllText((Join-Path $root '_probe2.html'), $html2, $enc)
Write-Output ('probe2 page: ' + $html2.Length + ' chars')
