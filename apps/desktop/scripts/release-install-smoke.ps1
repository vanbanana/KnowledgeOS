param(
  [string]$InstallerPath = "E:\NOTE\apps\desktop\src-tauri\target\release\bundle\nsis\KnowFlow_1.0.0_x64-setup.exe",
  [string]$InstallDir = "E:\NOTE\.runlogs\install-test\KnowFlow",
  [switch]$SkipLaunch
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $InstallerPath)) {
  throw "安装包不存在: $InstallerPath"
}

if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}

$parent = Split-Path -Parent $InstallDir
if (-not (Test-Path $parent)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

& $InstallerPath /S /D=$InstallDir
Start-Sleep -Seconds 2

$exePath = Join-Path $InstallDir "knowledgeos-desktop.exe"
$parserMainPath = Join-Path $InstallDir "resources\workers\parser\main.py"
$parserModulePath = Join-Path $InstallDir "resources\workers\parser\parsers\pdf_parser.py"
$migrationPath = Join-Path $InstallDir "resources\migrations\0001_core.sql"
$promptPath = Join-Path $InstallDir "resources\prompt-templates\agent_planner_system.md"

if (-not (Test-Path $exePath)) {
  throw "安装失败：缺少主程序 $exePath"
}

if (-not (Test-Path $parserMainPath)) {
  throw "安装失败：缺少 parser 入口文件 $parserMainPath"
}

if (-not (Test-Path $parserModulePath)) {
  throw "安装失败：缺少 parser 模块文件 $parserModulePath"
}

if (-not (Test-Path $migrationPath)) {
  throw "安装失败：缺少 migrations 文件 $migrationPath"
}

if (-not (Test-Path $promptPath)) {
  throw "安装失败：缺少 prompt 模板文件 $promptPath"
}

$dataDir = Join-Path $InstallDir ".knowledgeos"
if (-not $SkipLaunch) {
  $process = Start-Process -FilePath $exePath -PassThru
  Start-Sleep -Seconds 5
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}

if (-not (Test-Path $dataDir)) {
  throw "安装后未在安装目录创建数据目录: $dataDir"
}

$blockedMatches = Get-ChildItem -Recurse -File $InstallDir | Where-Object {
  $_.FullName -match "\\fixtures\\|test_worker\.py$|__pycache__|\\.pytest_cache|\\\.research\\"
}

if ($blockedMatches.Count -gt 0) {
  $paths = $blockedMatches | ForEach-Object { $_.FullName }
  throw "安装目录存在测试数据痕迹:`n$($paths -join "`n")"
}

Write-Output "安装冒烟测试通过：主程序与 parser 资源完整，未检测到测试数据污染。"
