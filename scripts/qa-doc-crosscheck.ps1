# qa-doc-crosscheck.ps1 - QA t4/R3a: mechanical README<->code consistency evidence
$ErrorActionPreference = 'Stop'
$lib = 'D:\DSH-dev\dsh-llm-failover\lib\index.js'
$rd  = 'D:\DSH-dev\dsh-llm-failover\README.md'

Write-Host '=== event kinds appended by code:'
Select-String -Path $lib -Pattern 'kind: "\w+"' | ForEach-Object {
  Write-Host ("  lib/index.js:{0}: {1}" -f $_.LineNumber, $_.Line.Trim())
}
Write-Host '=== README claims about decision kinds:'
Select-String -Path $rd -Pattern 'switched|exhausted' | ForEach-Object {
  Write-Host ("  README.md:{0}: {1}" -f $_.LineNumber, $_.Line.Trim())
}

Write-Host '=== DEFAULTS block in code:'
$src = Get-Content $lib -Raw
if ($src -match '(?s)const DEFAULTS = \{(.*?)\};') {
  ($Matches[1] -split "\r?\n" | Where-Object { $_ -match ':' }) | ForEach-Object {
    Write-Host ("  " + $_.Trim())
  }
}

Write-Host '=== README yaml config block (keys + claimed defaults):'
$inBlock = $false
$fenceYaml = [string][char]96 + [string][char]96 + [string][char]96 + 'yaml'
$fenceEnd  = [string][char]96 + [string][char]96 + [string][char]96
foreach ($line in (Get-Content $rd)) {
  if (-not $inBlock -and $line.Trim() -eq $fenceYaml) { $inBlock = $true; continue }
  if ($inBlock -and $line.Trim() -eq $fenceEnd) { break }
  if ($inBlock -and $line -match '^\s+[A-Za-z_]+:') { Write-Host ("  " + $line.Trim()) }
}
