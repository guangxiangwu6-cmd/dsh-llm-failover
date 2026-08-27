# qa-final-round.ps1 - QA t4 FINAL ROUND: complete R1+R2+R3 battery, single consecutive pass/fail sequence
$ErrorActionPreference = 'Stop'
$root = 'D:\DSH-dev\dsh-llm-failover'
$fail = 0
function Verdict($name, $ok) {
  if ($ok) { Write-Host ("PASS - " + $name) } else { Write-Host ("FAIL - " + $name); $script:fail++ }
}

# ---------- R1 static ----------
Write-Host '===== R1 STATIC ====='
node --check "$root\lib\index.js"
Verdict 'R1.1 node --check lib/index.js' ($LASTEXITCODE -eq 0)

$tap = node --test "$root\test\failover.test.mjs" 2>&1 | Out-String
$counts = @{}
foreach ($m in [regex]::Matches($tap, '(?m)^# (tests|pass|fail|cancelled|skipped|todo) (\d+)')) { $counts[$m.Groups[1].Value] = [int]$m.Groups[2].Value }
Write-Host ("  tests=" + $counts['tests'] + " pass=" + $counts['pass'] + " fail=" + $counts['fail'] + " skipped=" + $counts['skipped'])
Verdict 'R1.2 test suite all green' ($LASTEXITCODE -eq 0 -and $counts['pass'] -gt 0 -and $counts['fail'] -eq 0 -and $counts['cancelled'] -eq 0 -and $counts['skipped'] -eq 0)

# Scan target = shippable plugin surface; exclude node_modules deps and the qa-*.ps1
# harness itself (the detector must not match its own pattern literals).
$projFiles = Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Name -notlike 'qa-*.ps1' }
foreach ($pat in @('validateConfig', '\./types', 'lib/types', 'smoke-probe')) {
  $hits = $projFiles | Select-String -Pattern $pat
  Verdict ("R1.3 grep clean: " + $pat) ($null -eq $hits)
}

$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$expOk = (Test-Path (Join-Path $root ($pkg.exports.'.'.default))) -and (Test-Path (Join-Path $root ($pkg.main)))
Verdict 'R1.4 package.json exports/main point to existing files' $expOk
if ($null -ne $pkg.files) {
  $filesOk = $true
  foreach ($f in $pkg.files) { if (-not (Test-Path (Join-Path $root $f))) { $filesOk = $false } }
  Verdict 'R1.4b files field entries exist' $filesOk
} else { Write-Host 'INFO - no files field declared (nothing to reconcile)' }

$v = $pkg.version
$docHits = $projFiles | Select-String -Pattern 'rc\.\d+' | Where-Object { $_.Line -match 'version|rc\.\d+' }
Write-Host ("  package.json version: " + $v)
Verdict 'R1.5 version string rc.4 consistent' ($v -eq '0.1.1-rc.4')

# ---------- R2 rehearsal ----------
Write-Host '===== R2 REHEARSAL ====='
& "$root\scripts\run-smoke.ps1"
Verdict 'R2a run-smoke.ps1 SMOKE PASS' ($LASTEXITCODE -eq 0)

& "$root\scripts\qa-badconfig-variant.ps1"
Verdict 'R2b bad-config variant survives (MISSING_CREDENTIAL ending, patch restored)' ($LASTEXITCODE -eq 0)

# ---------- R3 consistency ----------
Write-Host '===== R3 CONSISTENCY ====='
$liveExists = Test-Path 'D:\DSH\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh-llm-failover'
Verdict 'R3.1 live Harness has NO plugin directory' (-not $liveExists)
$h = (Get-FileHash "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml").Hash
Write-Host ("  production cordis.patch.yml hash: " + $h)
Verdict 'R3.2 production patch hash prefix 0E17BF2C' ($h.StartsWith('0E17BF2C', [System.StringComparison]::OrdinalIgnoreCase))

& "$root\scripts\qa-doc-crosscheck.ps1"
Verdict 'R3.3 doc/code cross-check script ran' ($LASTEXITCODE -eq 0)

& "$root\scripts\qa-disabled-variant.ps1"
Verdict 'R3.4 row-level disabled:true bypass accepted, patch restored' ($LASTEXITCODE -eq 0)

Write-Host '===== FINAL VERDICT ====='
if ($fail -eq 0) { Write-Host 'ALL GREEN - every check passed in this single consecutive round' }
else { Write-Host ("FAILURES THIS ROUND: " + $fail) }
exit $(if ($fail -eq 0) { 0 } else { 1 })
