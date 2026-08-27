# qa-badconfig-variant.ps1 - QA t4/R2b: bad-config survival variant (temp-mutates smoke home patch, restores after)
$ErrorActionPreference = 'Stop'
$patch = 'D:\DSH-dev\smoke\home\profiles\headless\cordis.patch.yml'
$bak = Join-Path $env:TEMP 'cordis.patch.smoke.bak.yml'
Copy-Item $patch $bak -Force
$origHash = (Get-FileHash $patch).Hash
Write-Host ("ORIGINAL-HASH: " + $origHash)

# --- mutate: unknown key + wrong type inside llm-failover config ---
$lines = Get-Content $patch
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  $out.Add($line)
  if ($line -match '^\s+enabled: true\s*$') {
    $indent = ($line -replace 'enabled: true.*$', '')
    $out.Add($indent + 'modles: not-a-list')
    $out.Add($indent + 'maxConsecutiveFailures: "five"')
  }
}
Set-Content -Path $patch -Value ($out -join [Environment]::NewLine) -Encoding UTF8
Write-Host '=== mutated patch:'
Get-Content $patch

# --- run real loader chain under bad config ---
# MISSING_CREDENTIAL arrives on stderr by design; must not abort judgment (same as run-smoke.ps1)
$ErrorActionPreference = 'Continue'
$env:DSH_HOME = 'D:\DSH-dev\smoke\home'
$outText = (node 'D:\DSH-dev\smoke\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile headless 'reply ok' 2>&1 | Out-String)
Write-Host '=== output tail (last 25 lines):'
($outText -split "\r?\n" | Select-Object -Last 25) | ForEach-Object { Write-Host $_ }
$hasCred = $outText -match 'MISSING_CREDENTIAL'
$hasLoad = $outText -match 'failed to load'
$hasInv  = $outText -match 'invalid config'
Write-Host ("has-MISSING_CREDENTIAL: $hasCred  has-'failed to load': $hasLoad  has-'invalid config': $hasInv")
$pass = $hasCred -and (-not $hasLoad) -and (-not $hasInv)
Write-Host ("BAD-CONFIG-VERDICT: " + $(if ($pass) { 'PASS (survived: MISSING_CREDENTIAL ending, no invalid config)' } else { 'FAIL' }))

# --- restore & verify byte-exact ---
Copy-Item $bak $patch -Force
$restoredHash = (Get-FileHash $patch).Hash
Write-Host ("RESTORED-HASH: " + $restoredHash)
Write-Host ("RESTORE-MATCH: " + ($restoredHash -eq $origHash))
Remove-Item $bak -Force
exit $(if ($pass -and $restoredHash -eq $origHash) { 0 } else { 1 })
