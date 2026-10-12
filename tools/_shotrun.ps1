param([string]$Mode = 'a')
$ErrorActionPreference = 'Stop'
$root   = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки tools)
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
Set-Location $root

# 1. пересобрать инъекционную страницу (_shot_<mode>.html) из свежего cnc_suite.html
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '_shot.ps1') -Mode $Mode

# 2. отрендерить скриншот
$png   = Join-Path $root ('docs\screenshots\_shot_' + $Mode + '.png')
$page  = Join-Path $root ('_shot_' + $Mode + '.html')
$prof  = Join-Path $env:TEMP ('cnc_shot_' + $Mode)
if (Test-Path $png) { Remove-Item $png -Force }

$argStr = @(
  '--headless'
  '--disable-gpu'
  '--hide-scrollbars'
  '--no-first-run'
  '--no-default-browser-check'
  '--window-size=1600,1000'
  '--virtual-time-budget=12000'
  ('--user-data-dir="' + $prof + '"')
  ('--screenshot="' + $png + '"')
  ('"file:///' + ($page -replace '\\', '/') + '"')
) -join ' '

Start-Process -FilePath $chrome -ArgumentList $argStr -NoNewWindow -Wait `
  -RedirectStandardOutput (Join-Path $root ('_chrome_' + $Mode + '_out.txt')) `
  -RedirectStandardError  (Join-Path $root ('_chrome_' + $Mode + '_err.txt'))

if (Test-Path $png) {
  $f = Get-Item $png
  Write-Output ('PNG OK {0} bytes {1:HH:mm:ss}' -f $f.Length, $f.LastWriteTime)
} else {
  Write-Output 'PNG MISSING'
}
