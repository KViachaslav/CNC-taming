$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки build)
Set-Location $root
$enc = New-Object System.Text.UTF8Encoding($false)

function ReadU8([string]$p) { return [System.IO.File]::ReadAllText((Join-Path $root $p), [System.Text.Encoding]::UTF8) }
function WriteU8([string]$p, [string]$t) { [System.IO.File]::WriteAllText((Join-Path $root $p), $t, $enc) }

$log = New-Object System.Collections.ArrayList
function Say($s) { [void]$log.Add($s); Write-Output $s }

# ---------------------------------------------------------------- 1. Blender CSS + спрайт иконок
$bl = ReadU8 'originals\blender_view.html'

$i0 = $bl.IndexOf('<style>'); $i1 = $bl.IndexOf('</style>')
if ($i0 -lt 0 -or $i1 -lt 0) { throw 'originals/blender_view.html: <style> не найден' }
$blCss = $bl.Substring($i0 + 7, $i1 - $i0 - 7)

$k0 = $bl.IndexOf('<svg class="bl-icons"')
$k1 = $bl.IndexOf('</svg>', $k0)
if ($k0 -lt 0 -or $k1 -lt 0) { throw 'originals/blender_view.html: спрайт .bl-icons не найден' }
$blIcons = $bl.Substring($k0, $k1 + 6 - $k0)
Say ("blender css : {0} символов" -f $blCss.Length)
Say ("blender icons: {0} символов" -f $blIcons.Length)

# ---------------------------------------------------------------- 2. окна (фрагменты по номеру)
$winFiles = Get-ChildItem (Join-Path $root 'src\windows\_win_*.html') |
  Sort-Object { [int]([regex]::Match($_.Name, '^_win_(\d+)_').Groups[1].Value) }
$wins = @()
foreach ($f in $winFiles) { $wins += (ReadU8 ('src\windows\' + $f.Name)).TrimEnd() }
$winsHtml = $wins -join "`r`n`r`n"
Say ("windows     : {0} шт. -> {1} символов" -f $winFiles.Count, $winsHtml.Length)

# ---------------------------------------------------------------- 3. шаблон
$out = ReadU8 'src\_tpl.html'
$out = $out.Replace('/*__BL_CSS__*/', $blCss)
$out = $out.Replace('<!--__BL_ICONS__-->', $blIcons)
$out = $out.Replace('<!--__WINDOWS__-->', $winsHtml)

# ---------------------------------------------------------------- 4. скрипты
$jsGen     = (ReadU8 'src\_js_gen.js').TrimEnd()
$importmap = (ReadU8 'src\_importmap.html').TrimEnd()
$jsPreview = (ReadU8 'src\_js_send_preview.js').TrimEnd()
$jsSender  = (ReadU8 'src\_js_send_sender.js').TrimEnd()
$jsShell   = (ReadU8 'src\_shell.js').TrimEnd()

$libs = @'
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script src="https://cdn.jsdelivr.net/npm/clipper-lib@6.4.2/clipper.js"></script>
'@

$tail = @()
$tail += ''
$tail += '<!-- ===================== библиотеки (three r128 + OrbitControls + clipper) ===================== -->'
$tail += $libs.TrimEnd()
$tail += ''
$tail += '<!-- ===================== генерация G-code: DXF -> mill / laser / drill / DRC / измерение ===================== -->'
$tail += '<script>'
$tail += $jsGen
$tail += '</script>'
$tail += ''
$tail += '<!-- ===================== отправка G-code: importmap, 3D-превью, WebSocket-клиент GRBL ===================== -->'
$tail += $importmap
$tail += $jsPreview
$tail += $jsSender
$tail += ''
$tail += '<!-- ===================== оболочка CNC Suite: рабочие области, окна, меню, Ctrl+S ===================== -->'
$tail += '<script>'
$tail += $jsShell
$tail += '</script>'
$tail += ''
$tail += '</body>'
$tail += '</html>'
$tailText = ($tail -join "`r`n")

if ($out.IndexOf('<!--END-->') -lt 0) { throw 'src/_tpl.html: не найден маркер <!--END-->' }
$out = $out.Replace('<!--END-->', $tailText)
WriteU8 'cnc_suite.html' $out
Say ("cnc_suite.html: {0} символов, {1} строк" -f $out.Length, ($out -split "`n").Count)

# ---------------------------------------------------------------- 5. проверки
foreach ($p in @('__BL_CSS__', '__BL_ICONS__', '__WINDOWS__', '<!--END', '__JS_', '__IMPORTMAP')) {
    $n = ([regex]::Matches($out, [regex]::Escape($p))).Count
    if ($n -gt 0) { Say ("ВНИМАНИЕ: в результате остался маркер {0} x{1}" -f $p, $n) }
}

$symbols = @{}
[regex]::Matches($blIcons, '<symbol id="([^"]+)"') | ForEach-Object { $symbols[$_.Groups[1].Value] = $true }
$refs = @{}
[regex]::Matches($out, 'href="#(i-[A-Za-z0-9_\-]+)"') | ForEach-Object { $refs[$_.Groups[1].Value] = $true }
$missIcons = @($refs.Keys | Where-Object { -not $symbols.ContainsKey($_) } | Sort-Object)
$unusedIcons = @($symbols.Keys | Where-Object { -not $refs.ContainsKey($_) } | Sort-Object)
Say ("иконки      : символов {0}, используется {1}, НЕ найденных ссылок {2}" -f $symbols.Count, $refs.Count, $missIcons.Count)
if ($missIcons.Count) { Say ('  missing: ' + ($missIcons -join ', ')) }
Say ("иконки неиспользованные ({0}): {1}" -f $unusedIcons.Count, ($unusedIcons -join ', '))

WriteU8 'build_report.txt' ($log -join "`r`n")
