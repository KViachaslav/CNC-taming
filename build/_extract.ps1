$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # корень репозитория (родитель папки build)
$enc  = New-Object System.Text.UTF8Encoding($false)

function Get-Block($path, $from, $to) {
  $all = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
  return $all[($from - 1)..($to - 1)]
}

$gen = Get-Block "$root\originals\dxf_to_gcode.html" 243 3420
[System.IO.File]::WriteAllLines("$root\src\_js_gen.js", $gen, $enc)

$prev = Get-Block "$root\originals\GcodeAir.html" 929 1470
[System.IO.File]::WriteAllLines("$root\src\_js_send_preview.js", $prev, $enc)

$send = Get-Block "$root\originals\GcodeAir.html" 1475 2938
[System.IO.File]::WriteAllLines("$root\src\_js_send_sender.js", $send, $enc)

$map = Get-Block "$root\originals\GcodeAir.html" 920 927
[System.IO.File]::WriteAllLines("$root\src\_importmap.html", $map, $enc)

Write-Output ("gen lines   : " + $gen.Count)
Write-Output ("prev lines  : " + $prev.Count)
Write-Output ("sender lines: " + $send.Count)
