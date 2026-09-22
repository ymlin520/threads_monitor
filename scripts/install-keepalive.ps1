# 讓看門狗（keep-alive.mjs）在「登入 Windows 時」由工作排程啟動（背景執行、不開視窗）。
# 由工作排程啟動的程式不受 Claude 等終端機關閉影響；直接從終端機開的會跟著被關掉。
#
#   安裝並立刻啟動:  powershell -ExecutionPolicy Bypass -File scripts\install-keepalive.ps1
#   移除:            powershell -ExecutionPolicy Bypass -File scripts\install-keepalive.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$script = Join-Path $here 'keep-alive.mjs'
$name = 'threads-monitor-keepalive'
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'threads-monitor.vbs'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "已移除 $name"
    } else { Write-Host "$name 不存在" }
    return
}

$node = (Get-Command node.exe).Source
# conhost --headless：不開命令列視窗，程式仍歸工作排程管理
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument ('--headless "{0}" --no-warnings "{1}"' -f $node, $script) -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Register-ScheduledTask -TaskName $name -Description 'Threads 監測系統看門狗：伺服器與 Cloudflare 通道掛掉自動重開' `
    -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME | Out-Null
Write-Host "已建立 $name（登入時自動啟動）"

# 舊做法（啟動資料夾）會跟排程重複開兩個看門狗
if (Test-Path $vbs) { Remove-Item $vbs -Force; Write-Host "已移除舊的啟動資料夾捷徑" }

Start-ScheduledTask -TaskName $name
Write-Host "已啟動。目前的公開網址會寫在 data\logs\current_url.txt"
