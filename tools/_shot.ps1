param([string]$Mode = 'a')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки tools)
Set-Location $root
$enc = New-Object System.Text.UTF8Encoding($false)

$html = [System.IO.File]::ReadAllText((Join-Path $root 'cnc_suite.html'), [System.Text.Encoding]::UTF8)

$dxfJs = @'
  var DXF = ['0','SECTION','2','HEADER','0','ENDSEC','0','SECTION','2','ENTITIES',
    '0','LINE','8','0','10','0','20','0','11','100','21','0',
    '0','LINE','8','0','10','100','20','0','11','100','21','50',
    '0','LINE','8','0','10','100','20','50','11','0','21','50',
    '0','CIRCLE','8','L1','10','50','20','25','40','5',
    '0','CIRCLE','8','L1','10','25','20','60','40','3',
    '0','ENDSEC','0','EOF'].join('\n');
'@

if ($Mode -eq 'a') {
  $body = @"
<script>
$dxfJs
setTimeout(function(){
  var inp = document.getElementById('dxf-file-input');
  var dt = new DataTransfer();
  dt.items.add(new File([DXF], 'shot.dxf', { type: 'application/dxf' }));
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}, 200);
setTimeout(function(){ document.getElementById('cnc-generate').click(); }, 1200);
setTimeout(function(){
  var t = document.querySelector('[data-menu="winGen"]');
  t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  var b = document.querySelector('.bl-menu');
  if (b) b.querySelectorAll('.bl-menu-item')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, 3000);
</script>
"@
} else {
  $body = @"
<script>
setTimeout(function(){
  document.querySelector('#workspaces .bl-ws[data-ws="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, 1200);
setTimeout(function(){
  var t = document.querySelector('[data-menu="winSend"]');
  t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  var b = document.querySelector('.bl-menu');
  if (b) b.querySelectorAll('.bl-menu-item')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, 3000);
</script>
"@
}

$j = $html.LastIndexOf('</body>')
$out = $html.Substring(0, $j) + $body + "`r`n" + $html.Substring($j)
[System.IO.File]::WriteAllText((Join-Path $root ('_shot_' + $Mode + '.html')), $out, $enc)
Write-Output ('shot page ' + $Mode + ': ' + $out.Length + ' chars')
