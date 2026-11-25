#Requires -Version 5.1
#Requires -RunAsAdministrator
param([ValidateSet('Menu','Install','Remove')][string]$Action = 'Menu')
$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'Dama\setup'
$settingsPath = Join-Path $state 'settings.json'
$installed = Join-Path $state 'installed'
$sourceInstaller = Join-Path $PSScriptRoot 'payload\scripts\install-windows.ps1'
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'

function Stop-Dama {
    if (-not (Test-Path -LiteralPath $settingsPath)) { return }
    foreach ($name in @('Dama-Install-Resume','Dama-WSL')) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Disable-ScheduledTask -TaskName $name | Out-Null
            Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath (Join-Path $state 'distribution-owned')) {
        & $wsl --terminate Dama
    } elseif (Test-Path -LiteralPath $installed) {
        & $wsl --terminate Dama
    }
}

function Install-Dama {
    if (Test-Path -LiteralPath $installed) {
        & $sourceInstaller -RepairStartup
    } elseif (Test-Path -LiteralPath $settingsPath) {
        & $sourceInstaller -Resume
    } else {
        & $sourceInstaller
    }
}

if ($Action -eq 'Install') { Install-Dama; return }
if ($Action -eq 'Remove') {
    Stop-Dama
    if (Test-Path -LiteralPath $settingsPath) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        if ($settings.NetworkReserved -and $settings.ListenAddress) {
            foreach ($port in @(80,443)) {
                $rule = "Dama-WSL-TCP-$port"
                if (Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue) {
                    & $netsh interface portproxy delete v4tov4 "listenaddress=$($settings.ListenAddress)" "listenport=$port" | Out-Null
                    Remove-NetFirewallRule -Name $rule
                }
            }
        }
        foreach ($name in @('Dama-Install-Resume','Dama-WSL')) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
            }
        }
        $settings | Add-Member -NotePropertyName BootTasksRegistered -NotePropertyValue $false -Force
        $settings | Add-Member -NotePropertyName NetworkReserved -NotePropertyValue $false -Force
        $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    }
    return
}

do {
    $task = Get-ScheduledTask -TaskName 'Dama-WSL' -ErrorAction SilentlyContinue
    $status = if ($task) { $task.State } else { 'Not registered' }
    Write-Host "`nDama boot task: $status"
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/api/health' -TimeoutSec 2
        if ($health.ok -eq $true) { Write-Host 'Dashboard is responding.' }
    } catch { Write-Host 'Dashboard is stopped or starting.' }
    $runtime = Join-Path $state 'runtime-status.json'
    if (Test-Path -LiteralPath $runtime) {
        $runtimeStatus = Get-Content -LiteralPath $runtime -Raw | ConvertFrom-Json
        Write-Host "$($runtimeStatus.Message) ($($runtimeStatus.UpdatedAt))"
    }
    Write-Host '1. Open dashboard and settings'
    Write-Host '2. Start Dama and enable startup'
    Write-Host '3. Stop Dama and disable startup'
    Write-Host '4. Repair or resume installation'
    Write-Host '5. Open setup logs'
    Write-Host '0. Exit'
    $choice = Read-Host 'Choose an option'
    switch ($choice) {
        '1' { Start-Process 'http://127.0.0.1:3100/' }
        '2' {
            if ($task -and (Test-Path -LiteralPath $installed)) {
                Enable-ScheduledTask -TaskName 'Dama-WSL' | Out-Null
                Start-ScheduledTask -TaskName 'Dama-WSL'
            } else { Install-Dama }
        }
        '3' { Stop-Dama }
        '4' { Install-Dama }
        '5' { if (Test-Path -LiteralPath $state) { Invoke-Item -LiteralPath $state } }
    }
} while ($choice -ne '0')
