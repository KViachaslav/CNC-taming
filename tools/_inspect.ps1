$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки tools)
$enc  = New-Object System.Text.UTF8Encoding($false)

$out = New-Object System.Collections.ArrayList
$files = @('src\_tpl.html', 'src\_shell.js') + (Get-ChildItem (Join-Path $root 'src\windows\_win_*.html') | Sort-Object Name | ForEach-Object { 'src\windows\' + $_.Name })
foreach ($f in $files) {
  $t = [System.IO.File]::ReadAllText((Join-Path $root $f), [System.Text.Encoding]::UTF8)
  $lines = $t -split "`n"
  $marks = @()
  foreach ($p in @('__BL_CSS__', '__BL_ICONS__', '__WINDOWS__', '<!--END', '<!--ENDM', '__END__', '__JS_', '__IMPORTMAP')) {
    $c = ([regex]::Matches($t, [regex]::Escape($p))).Count
    if ($c -gt 0) { $marks += ($p + ' x' + $c) }
  }
  [void]$out.Add(('{0,-22} lines={1,-5} bytes={2,-7} marks: {3}' -f $f, $lines.Count, $t.Length, ($marks -join '; ')))
}

[void]$out.Add('')
[void]$out.Add('=== _tpl.html tail (190..end) ===')
$tpl = [System.IO.File]::ReadAllLines((Join-Path $root 'src\_tpl.html'), [System.Text.Encoding]::UTF8)
for ($i = 189; $i -lt $tpl.Count; $i++) { [void]$out.Add(($i + 1).ToString() + ': ' + $tpl[$i]) }

[void]$out.Add('')
[void]$out.Add('=== _tpl.html head (1..60) ===')
for ($i = 0; $i -lt 60; $i++) { [void]$out.Add(($i + 1).ToString() + ': ' + $tpl[$i]) }

[System.IO.File]::WriteAllLines((Join-Path $root '_inspect.txt'), $out, $enc)
Write-Output 'inspect done'
