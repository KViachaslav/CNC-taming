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

$probeA = @'
<script>
(function () {
  var REP = [];
  function R(s) { REP.push('__P|' + s); }
  function $(s) { return document.querySelector(s); }
  function ids(cls) { return Array.prototype.map.call(document.querySelectorAll(cls), function (w) { return w.id || w.className; }).join(','); }
  function shown() { return Array.prototype.map.call(document.querySelectorAll('.bl-win.show'), function (w) { return w.id; }).join(',') || '(none)'; }
  function menu(name) {
    var t = document.querySelector('[data-menu="' + name + '"]');
    if (!t) { R('menu-missing:' + name); return -1; }
    t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    var b = $('.bl-menu');
    if (!b) { R('menu-not-opened:' + name); return -2; }
    return b.querySelectorAll('.bl-menu-item').length;
  }
  function item(i) {
    var b = $('.bl-menu'), r = b && b.querySelectorAll('.bl-menu-item');
    if (!r || !r[i]) { R('menu-item-missing:' + i); return false; }
    var lbl = r[i].querySelector('.mi-label');
    R('menu-item[' + i + ']=' + (lbl ? lbl.textContent : '?'));
    r[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }
  function errs() { return window.__ERR__.length ? window.__ERR__.slice(0, 8).join(' || ') : '(none)'; }

  setTimeout(function () {
    R('readyState=' + document.readyState);
    R('THREE=' + (typeof THREE) + ' OrbitControls=' + (typeof THREE !== 'undefined' && !!THREE.OrbitControls) + ' Clipper=' + (typeof Clipper));
    R('ids=' + document.querySelectorAll('[id]').length + ' blWin=' + document.querySelectorAll('.bl-win').length);
    R('ws=' + document.body.dataset.ws + ' shown=' + shown());
    R('wsViews=' + ids('.ws-view') + ' wsTabs=' + ids('#workspaces .bl-ws'));
    R('view3d=' + Math.round($('#view3d').getBoundingClientRect().width) + 'x' + Math.round($('#view3d').getBoundingClientRect().height));
    R('canvasInView3d=' + document.querySelectorAll('#view3d canvas').length + ' canvas3dChildren=' + $('#canvas3dContainer').children.length);
    R('errs=' + errs());
  }, 400);
'@

$probeB = @'

  setTimeout(function () {
    var dxf = ['0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0',
      '0', 'LINE', '8', '0', '10', '100', '20', '0', '11', '100', '21', '50',
      '0', 'CIRCLE', '8', 'L1', '10', '50', '20', '25', '40', '5',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    try {
      var inp = document.getElementById('dxf-file-input');
      var dt = new DataTransfer();
      dt.items.add(new File([dxf], 'probe.dxf', { type: 'application/dxf' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      R('dxf-injected=' + inp.files.length + ' file=' + inp.files[0].name + ' size=' + inp.files[0].size);
    } catch (e) { R('dxf-inject-failed: ' + e.message); }
  }, 600);

  setTimeout(function () {
    var ll = document.getElementById('layers-list');
    R('layers-list children=' + (ll ? ll.children.length : 'n/a') + ' text=' + (ll ? ll.textContent.replace(/\s+/g, ' ').slice(0, 90) : ''));
    R('layers-count=' + (document.getElementById('layers-count') || {}).textContent);
    ['cnc-download', 'laser-download', 'drill-download'].forEach(function (id) {
      var b = document.getElementById(id);
      R('btn[' + id + ']=' + (b ? ('disabled=' + b.disabled) : 'MISSING'));
    });
    R('errs=' + errs());
  }, 1900);

  setTimeout(function () { R('menuGen items=' + menu('winGen')); }, 2100);
  setTimeout(function () { item(1); R('afterWinLaser ws=' + document.body.dataset.ws + ' shown=' + shown()); }, 2250);

  setTimeout(function () {
    var t = document.querySelector('.bl-leftcol [data-tip], .bl-header [data-tip]');
    if (t) {
      t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      var tip = document.getElementById('tip');
      R('tip-show=' + tip.classList.contains('show') + ' text=' + tip.textContent.slice(0, 40));
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      R('tip-hidden=' + !tip.classList.contains('show'));
    } else { R('tip: no trigger found'); }
  }, 2400);

  setTimeout(function () {
    var h = document.querySelector('.bl-win.show .bl-panel-head');
    if (h) {
      var p = h.closest('.bl-panel');
      h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      R('panel-collapsed=' + p.classList.contains('collapsed'));
      h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      R('panel-expanded=' + !p.classList.contains('collapsed'));
    } else { R('no panel in shown window'); }
  }, 2550);

  setTimeout(function () {
    var tab = document.querySelector('#workspaces .bl-ws[data-ws="send"]');
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    R('sendClick ws=' + document.body.dataset.ws + ' shown=' + shown() +
      ' panelGenHidden=' + document.getElementById('panelGen').hidden +
      ' panelSendHidden=' + document.getElementById('panelSend').hidden +
      ' wsSendActive=' + document.getElementById('wsSendView').classList.contains('active') +
      ' wsGenActive=' + document.getElementById('wsGenView').classList.contains('active') +
      ' hdr=' + document.getElementById('hdrWsLabel').textContent +
      ' status=' + document.getElementById('statusWs').textContent);
    R('canvas3dChildren=' + document.getElementById('canvas3dContainer').children.length);
  }, 2700);

  setTimeout(function () { R('menuSend items=' + menu('winSend')); }, 2850);
  setTimeout(function () { item(2); R('afterWinMachine ws=' + document.body.dataset.ws + ' shown=' + shown()); }, 3000);

  setTimeout(function () {
    var x = document.querySelector('.bl-win.show .bl-win-head .x');
    if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true })); R('xClicked shown=' + shown()); }
    else R('no X button');
  }, 3150);

  setTimeout(function () {
    var g = document.getElementById('gcode');
    R('gcode len=' + (g ? g.value.length : 'n/a'));
    R('totalCount=' + (document.getElementById('totalCount') || {}).textContent + ' sentCount=' + (document.getElementById('sentCount') || {}).textContent);
    R('bbInfo=' + (document.getElementById('bbInfo') || {}).textContent + ' toolPos=' + (document.getElementById('toolPos') || {}).textContent);
    R('errs-final=' + errs());
    var pre = document.createElement('pre');
    pre.id = '__probe';
    pre.textContent = '\n' + REP.join('\n') + '\n';
    document.body.appendChild(pre);
  }, 3400);
})();
</script>
'@

$i = $html.IndexOf('</head>')
if ($i -lt 0) { throw 'no </head>' }
$html2 = $html.Substring(0, $i) + $early + "`r`n" + $html.Substring($i)
$j = $html2.LastIndexOf('</body>')
if ($j -lt 0) { throw 'no </body>' }
$html2 = $html2.Substring(0, $j) + $probeA + $probeB + "`r`n" + $html2.Substring($j)

[System.IO.File]::WriteAllText((Join-Path $root '_probe.html'), $html2, $enc)
Write-Output ('probe page: ' + $html2.Length + ' chars')
