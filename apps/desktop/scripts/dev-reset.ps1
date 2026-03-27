$ErrorActionPreference = "SilentlyContinue"

Get-Process knowledgeos-desktop | Stop-Process -Force

$owners = Get-NetTCPConnection -LocalPort 1420 | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($owner in $owners) {
  if ($owner -gt 4) {
    Stop-Process -Id $owner -Force
  }
}

Write-Output "开发环境已清理：已释放 1420 端口并关闭旧版桌面进程。"
