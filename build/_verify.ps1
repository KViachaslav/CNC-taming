$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки build)
$enc  = New-Object System.Text.UTF8Encoding($false)

$target = Join-Path $root 'cnc_suite.html'
if (Test-Path $target) {
  $html = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
  $source = 'cnc_suite.html'
} else {
  $html = [System.IO.File]::ReadAllText((Join-Path $root 'src\_tpl.html'), [System.Text.Encoding]::UTF8)
  Get-ChildItem (Join-Path $root 'src\windows\_win_*.html') | Sort-Object Name | ForEach-Object {
    $html += [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
  }
  $source = '_tpl.html + _win_*.html'
}

# --- ids present in the assembled page ---
$have = @{}
$idList = @()
[regex]::Matches($html, 'id="([^"]+)"') | ForEach-Object {
  $v = $_.Groups[1].Value
  $idList += $v
  $have[$v] = $true
}

# --- ids required by the JS of the original pages ---
$dxf = [System.IO.File]::ReadAllText((Join-Path $root 'originals\dxf_to_gcode.html'), [System.Text.Encoding]::UTF8)
$ga  = [System.IO.File]::ReadAllText((Join-Path $root 'originals\GcodeAir.html'),      [System.Text.Encoding]::UTF8)

$req = @{}
[regex]::Matches($dxf, "getElementById\('([^']+)'\)") | ForEach-Object { $req[$_.Groups[1].Value] = $true }
[regex]::Matches($dxf, "domNum\('([^']+)'")           | ForEach-Object { $req[$_.Groups[1].Value] = $true }
[regex]::Matches($ga,  '\$\("([A-Za-z0-9_\-]+)"\)')   | ForEach-Object { $req[$_.Groups[1].Value] = $true }
# containers of the old markup that were replaced by CNC Suite windows
'ui-container', 'cnc-panel', 'laser-panel', 'drill-panel', 'drc-panel', 'measure-panel' | ForEach-Object { $req.Remove($_) }

$missing = @($req.Keys | Where-Object { -not $have.ContainsKey($_) } | Sort-Object)
$dupes   = @($idList | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name + ' x' + $_.Count } | Sort-Object)

$out = New-Object System.Collections.ArrayList
[void]$out.Add("=== verify: $source ===")
[void]$out.Add("required ids: " + $req.Count + " | present ids: " + $have.Count)
[void]$out.Add("--- MISSING (" + $missing.Count + ") ---")
$missing | ForEach-Object { [void]$out.Add($_) }
[void]$out.Add("--- DUPLICATES (" + $dupes.Count + ") ---")
$dupes   | ForEach-Object { [void]$out.Add($_) }
[System.IO.File]::WriteAllLines((Join-Path $root 'verify_report.txt'), $out, $enc)
$out | ForEach-Object { Write-Output $_ }
