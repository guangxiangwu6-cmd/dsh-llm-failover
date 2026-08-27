# qa-disabled-variant.ps1 - QA t4/R3: verify INSTALL.md claim that row-level disabled:true bypasses the plugin
$ErrorActionPreference = 'Stop'
$patch = 'D:\DSH-dev\smoke\home\profiles\headless\cordis.patch.yml'
$bak = Join-Path $env:TEMP 'cordis.patch.smoke.bak2.yml'
Copy-Item $patch $bak -Force
$origHash = (Get-FileHash $patch).Hash
Write-Host ("ORIGINAL-HASH: " + $origHash)

# --- mutate: add disabled: true at plugin-row level (sibling of config) ---
$lines = Get-Content $patch
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  if ($line -match '^\s+config:\s*$') {
    $indent = ($line -replace 'config:.*$', '')
    $out.Add($indent + 'disabled: true')
  }
  $out.Add($line)
}
Set-Content -Path $patch -Value ($out -join [Environment]::NewLine) -Encoding UTF8
Write-Host '=== mutated patch:'
Get-Content $patch

# --- run real loader chain; stderr must not abort judgment ---
$ErrorActionPreference = 'Continue'
$env:DSH_HOME = 'D:\DSH-dev\smoke\home'
$outText = (node 'D:\DSH-dev\smoke\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile headless 'reply ok' 2>&1 | Out-String)
Write-Host '=== output tail (last 15 lines):'
($outText -split "\r?\n" | Select-Object -Last 15) | ForEach-Object { Write-Host $_ }
$hasCred = $outText -match 'MISSING_CREDENTIAL'
$hasLoad = $outText -match 'failed to load'
$hasInv  = $outText -match 'invalid config'
Write-Host ("has-MISSING_CREDENTIAL: $hasCred  has-'failed to load': $hasLoad  has-'invalid config': $hasInv")
$pass = $hasCred -and (-not $hasLoad) -and (-not $hasInv)
Write-Host ("DISABLED-VARIANT-VERDICT: " + $(if ($pass) { 'PASS (row-level disabled:true accepted, startup healthy)' } else { 'FAIL' }))

# --- restore & verify byte-exact ---
Copy-Item $bak $patch -Force
$restoredHash = (Get-FileHash $patch).Hash
Write-Host ("RESTORE-MATCH: " + ($restoredHash -eq $origHash))
Remove-Item $bak -Force
exit $(if ($pass -and $restoredHash -eq $origHash) { 0 } else { 1 })
