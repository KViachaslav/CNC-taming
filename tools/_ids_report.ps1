$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки tools)
$out = New-Object System.Collections.ArrayList
$t = Get-Content (Join-Path $root 'originals\dxf_to_gcode.html') -Raw
[void]$out.Add('=== DXF getElementById ===')
([regex]::Matches($t,"getElementById\('([^']+)'\)") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) | ForEach-Object { [void]$out.Add($_) }
[void]$out.Add('=== DXF domNum ===')
([regex]::Matches($t,"domNum\('([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) | ForEach-Object { [void]$out.Add($_) }
[void]$out.Add('=== DXF markup ids ===')
([regex]::Matches($t,'id="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) | ForEach-Object { [void]$out.Add($_) }
$g = Get-Content (Join-Path $root 'originals\GcodeAir.html') -Raw
[void]$out.Add('=== GA $("id") ===')
([regex]::Matches($g,'\$\("([A-Za-z0-9_\-]+)"\)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) | ForEach-Object { [void]$out.Add($_) }
[void]$out.Add('=== GA markup ids ===')
([regex]::Matches($g,'id="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) | ForEach-Object { [void]$out.Add($_) }
[void]$out.Add('=== DXF window. refs ===')
(Select-String -Path (Join-Path $root 'originals\dxf_to_gcode.html') -Pattern 'window\.[A-Za-z]' | ForEach-Object { $_.LineNumber.ToString() + ': ' + $_.Line.Trim() }) | ForEach-Object { [void]$out.Add($_) }
[void]$out.Add('=== GA module (929-1470) sizing refs ===')
(Select-String -Path (Join-Path $root 'originals\GcodeAir.html') -Pattern 'clientWidth|clientHeight|innerWidth|innerHeight|addEventListener\("resize|addEventListener\(.resize' | ForEach-Object { $_.LineNumber.ToString() + ': ' + $_.Line.Trim() }) | ForEach-Object { [void]$out.Add($_) }
$out | Set-Content -Encoding UTF8 (Join-Path $root 'ids_report.txt')
Write-Output 'done'
