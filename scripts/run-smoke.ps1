# run-smoke.ps1 — 安装前冒烟彩排（固化自 INSTALL.md「安装前冒烟彩排」一节）
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\lib\index.js'
$dstDir = 'D:\DSH-dev\smoke\node_modules\@deepseek-ai\dsh-llm-failover\lib'
$bin = 'D:\DSH-dev\smoke\node_modules\@deepseek-ai\dsh\lib\bin.js'
if ((-not (Test-Path $bin)) -or (-not (Test-Path 'D:\DSH-dev\smoke\home')) -or (-not (Test-Path $dstDir))) {
  Write-Host @'
SMOKE SKIP: 彩排树缺失。搭建提示：
 1) 把真实 Harness 安装的 node_modules 复制为 D:\DSH-dev\smoke\node_modules（约200MB副本，须含 @deepseek-ai/dsh）
 2) New-Item -ItemType Directory -Force 'D:\DSH-dev\smoke\node_modules\@deepseek-ai\dsh-llm-failover\lib'
 3) New-Item -ItemType Directory -Force 'D:\DSH-dev\smoke\home'，并在其 profiles/headless/cordis.patch.yml 写入与未来生产行一致的 llm-failover 配置（详见 INSTALL.md「安装前冒烟彩排」）
'@
  exit 2
}
Copy-Item (Resolve-Path $src).Path (Join-Path $dstDir 'index.js') -Force
$env:DSH_HOME = 'D:\DSH-dev\smoke\home'
# 彩排预期以 MISSING_CREDENTIAL 收场（无头环境无凭据属正常），故此处不能让 stderr 中断判定
$ErrorActionPreference = 'Continue'
$out = (node $bin --profile headless 'reply ok' 2>&1 | Out-String)
$pass = ($out -match 'MISSING_CREDENTIAL') -and ($out -notmatch 'failed to load') -and ($out -notmatch 'invalid config')
if ($pass) { Write-Host 'SMOKE PASS' } else { Write-Host 'SMOKE FAIL'; Write-Host '---- 输出尾部 ----'; ($out -split "\r?\n" | Select-Object -Last 30) | ForEach-Object { Write-Host $_ } }
exit $(if ($pass) { 0 } else { 1 })
