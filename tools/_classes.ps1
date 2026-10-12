$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки tools)
$out = New-Object System.Collections.ArrayList
foreach ($f in (Join-Path $root 'originals\dxf_to_gcode.html'), (Join-Path $root 'originals\GcodeAir.html')) {
  $lines = Get-Content $f
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "class=") {
      [void]$out.Add($f + ':' + ($i + 1) + ': ' + $lines[$i].Trim())
    }
  }
}
$out | Set-Content -Encoding UTF8 (Join-Path $root 'classes_report.txt')
Write-Output ('lines=' + $out.Count)
