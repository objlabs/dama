#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string] $CertDirectory,
    [string] $Route53Email,
    [string] $AwsCredentialsFile,
    [ValidatePattern('^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$')]
    [string] $ListenAddress = '0.0.0.0',
    [switch] $Resume,
    [switch] $RepairStartup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$distribution = 'Dama'
$stateDirectory = Join-Path $env:LOCALAPPDATA 'Dama\setup'
$stateFile = Join-Path $stateDirectory 'settings.json'
$resumeTask = 'Dama-Install-Resume'
$startTask = 'Dama-WSL'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Invoke-Wsl {
    param([string[]] $Arguments)
    & $wsl @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL failed ($LASTEXITCODE). See the preceding output." }
}

function ConvertTo-LinuxPath {
    param([string] $Path)
    $output = Invoke-Wsl -Arguments @('--distribution', $distribution, '--user', 'root', '--exec', 'wslpath', '-a', '-u', $Path)
    return ($output -join "`n").Trim()
}

function Register-DamaTask {
    param([string] $Name, [string] $Script, [pscredential] $Credential)
    $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Password -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $Name -InputObject $task -User $identity `
        -Password ($Credential.GetNetworkCredential().Password) -Force | Out-Null
}

$os = Get-CimInstance Win32_OperatingSystem
if ([int]$os.BuildNumber -lt 19041) { throw 'Dama WSL installation requires Windows 10 build 19041 or later.' }
$processor = @(Get-CimInstance Win32_Processor)[0]
if (-not $processor.VirtualizationFirmwareEnabled -and -not (Get-CimInstance Win32_ComputerSystem).HypervisorPresent) {
    throw 'Enable CPU virtualization in BIOS/UEFI, then run this installer again.'
}

if ($Resume -or $RepairStartup) {
    $configuration = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $CertDirectory = $configuration.CertDirectory
    $Route53Email = $configuration.Route53Email
    $AwsCredentialsFile = $configuration.AwsCredentialsFile
    if ($configuration.PSObject.Properties['ListenAddress']) { $ListenAddress = $configuration.ListenAddress }
} else {
    if (Test-Path -LiteralPath $stateFile) {
        throw 'An installation is already staged. Run this script with -Resume to continue it.'
    }
    if (-not $CertDirectory -and -not $Route53Email) {
        $CertDirectory = Read-Host 'Folder containing fullchain.pem and privkey.pem (Windows path)'
    }
    if ($CertDirectory -and $Route53Email) { throw 'Choose CertDirectory or Route53Email.' }
    if ($Route53Email) {
        if ($Route53Email -notmatch '^[^\s@]+@[^\s@]+$') { throw 'Enter a valid Route53Email.' }
        if (-not $AwsCredentialsFile) { $AwsCredentialsFile = Read-Host 'AWS credentials file for Route 53 DNS validation' }
        $AwsCredentialsFile = (Resolve-Path -LiteralPath $AwsCredentialsFile).ProviderPath
        if (-not (Test-Path -LiteralPath $AwsCredentialsFile -PathType Leaf)) { throw 'AWS credentials file required.' }
    } else {
        $CertDirectory = (Resolve-Path -LiteralPath $CertDirectory).ProviderPath
        foreach ($name in @('fullchain.pem', 'privkey.pem')) {
            if (-not (Test-Path -LiteralPath (Join-Path $CertDirectory $name) -PathType Leaf)) {
                throw "$name is missing in $CertDirectory."
            }
        }
    }
    $source = Split-Path $PSScriptRoot -Parent
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    foreach ($name in @('src', 'public', 'scripts', 'test', 'deploy', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.browser.json')) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $stateDirectory -Recurse -Force
    }
    @{
        CertDirectory = $CertDirectory
        Route53Email = $Route53Email
        AwsCredentialsFile = $AwsCredentialsFile
    } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

# Stage every file needed by a noninteractive boot before registering the tasks.
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $stateDirectory /inheritance:r /grant:r "*$($userSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the setup directory.' }
$networkReserved = $false
$saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ($saved.PSObject.Properties['NetworkReserved']) { $networkReserved = $saved.NetworkReserved }
if (-not $networkReserved) {
    $address = [Net.IPAddress]::Parse($ListenAddress)
    if ($address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'ListenAddress must be IPv4.' }
    foreach ($port in @(80, 443)) {
        $proxy = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp' `
            -Name "$ListenAddress/$port" -ErrorAction SilentlyContinue
        if ($proxy) { throw "An existing port proxy owns $ListenAddress port $port. Choose a free ListenAddress." }
        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object {
            $ListenAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' -or $_.LocalAddress -eq $ListenAddress
        })
        if ($listeners.Count) { throw "Port $port is in use on Windows. Choose a free -ListenAddress before installing Dama." }
        if (Get-NetFirewallRule -Name "Dama-WSL-TCP-$port" -ErrorAction SilentlyContinue) {
            throw "A firewall rule named Dama-WSL-TCP-$port already exists. Resolve this name conflict before installing."
        }
    }
    $networkReserved = $true
}
$inputDirectory = Join-Path $stateDirectory 'inputs'
New-Item -ItemType Directory -Path $inputDirectory -Force | Out-Null
if ($CertDirectory -and $CertDirectory -ne $inputDirectory) {
    foreach ($name in @('fullchain.pem', 'privkey.pem')) {
        Copy-Item -LiteralPath (Join-Path $CertDirectory $name) -Destination (Join-Path $inputDirectory $name) -Force
    }
    $CertDirectory = $inputDirectory
}
if ($AwsCredentialsFile -and $AwsCredentialsFile -ne (Join-Path $inputDirectory 'aws-credentials')) {
    Copy-Item -LiteralPath $AwsCredentialsFile -Destination (Join-Path $inputDirectory 'aws-credentials') -Force
    $AwsCredentialsFile = Join-Path $inputDirectory 'aws-credentials'
}
# Refresh the staged scripts when resuming from a newer checkout.
$stagedScripts = Join-Path $stateDirectory 'scripts'
if ($PSScriptRoot -ne $stagedScripts) {
    Get-ChildItem -LiteralPath $PSScriptRoot -File | Copy-Item -Destination $stagedScripts -Force
}
$acceptTerms = $false
if ($Route53Email) {
    if (Test-Path -LiteralPath $stateFile) {
        $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ($saved.PSObject.Properties['AcceptAcmeTerms']) { $acceptTerms = $saved.AcceptAcmeTerms }
    }
    if (-not $acceptTerms) {
        $answer = Read-Host "Accept the Let's Encrypt subscriber agreement at https://letsencrypt.org/repository/ for automatic issuance? Type YES"
        if ($answer -cne 'YES') { throw 'Certificate issuance requires agreement to the ACME terms.' }
        $acceptTerms = $true
    }
}
$bootTasksRegistered = $false
$saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ($saved.PSObject.Properties['BootTasksRegistered']) { $bootTasksRegistered = $saved.BootTasksRegistered }
$resumeScript = Join-Path $stateDirectory 'resume.ps1'
Set-Content -LiteralPath $resumeScript -Encoding UTF8 -Value '$ErrorActionPreference = "Stop"; & "$PSScriptRoot\scripts\install-windows.ps1" -Resume'
if (-not $bootTasksRegistered -or $RepairStartup) {
    Write-Host "Enter the Windows account password for $identity once to allow startup before sign-in. Use the account password, not the Windows Hello PIN."
    $securePassword = Read-Host 'Windows account password' -AsSecureString
    if ($securePassword.Length -eq 0) { throw 'A Windows account password is required for unattended startup.' }
    $credential = New-Object System.Management.Automation.PSCredential($identity, $securePassword)
    try {
        Stop-ScheduledTask -TaskName $startTask -ErrorAction SilentlyContinue
        Register-DamaTask -Name $resumeTask -Script $resumeScript -Credential $credential
        Register-DamaTask -Name $startTask -Script (Join-Path $stagedScripts 'start-windows.ps1') -Credential $credential
    } finally {
        $credential = $null
        $securePassword.Dispose()
    }
    $bootTasksRegistered = $true
}
@{
    CertDirectory = $CertDirectory
    Route53Email = $Route53Email
    AwsCredentialsFile = $AwsCredentialsFile
    ListenAddress = $ListenAddress
    AcceptAcmeTerms = $acceptTerms
    BootTasksRegistered = $bootTasksRegistered
    NetworkReserved = $networkReserved
} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
if ($RepairStartup) {
    Start-ScheduledTask -TaskName $startTask
    if (Test-Path -LiteralPath (Join-Path $stateDirectory 'installed')) {
        Unregister-ScheduledTask -TaskName $resumeTask -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Host 'Boot task credentials updated.'
    return
}
Start-Transcript -Path (Join-Path $stateDirectory 'install.log') -Append | Out-Null
try {
    $restart = $false
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $current = Get-WindowsOptionalFeature -Online -FeatureName $feature
        if ($current.State -eq 'EnablePending') { $restart = $true }
        elseif ($current.State -ne 'Enabled') {
            $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
            if ($result.RestartNeeded) { $restart = $true }
        }
    }
    if ($restart) {
        Write-Host 'WSL features are prepared. Restart Windows when convenient. The boot task resumes installation before sign-in.'
        return
    }

    Write-Host '[Dama] Installing/updating WSL'
    & $wsl --version *> $null
    if ($LASTEXITCODE -ne 0) { Invoke-Wsl -Arguments @('--install', '--no-distribution', '--web-download') }
    Invoke-Wsl -Arguments @('--update', '--web-download')
    Invoke-Wsl -Arguments @('--version')
    $installed = @((Invoke-Wsl -Arguments @('--list', '--quiet')) | ForEach-Object { ($_ -replace "`0", '').Trim() })
    $ownership = Join-Path $stateDirectory 'distribution-owned'
    if ($installed -contains $distribution) {
        if (-not (Test-Path -LiteralPath $ownership)) { throw 'A WSL distribution named Dama already exists. Its owner must resolve the name conflict.' }
    } else {
        Write-Host '[Dama] Downloading and verifying the Ubuntu 24.04 WSL image'
        $architecture = switch ([int]$processor.Architecture) {
            9 { 'amd64' }
            12 { 'arm64' }
            default { throw 'Supported Windows architectures are x64 and arm64.' }
        }
        $base = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current'
        $imageName = "ubuntu-noble-wsl-$architecture-wsl.rootfs.tar.gz"
        $archive = Join-Path $stateDirectory $imageName
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $hashes = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
        if ($hashes -is [byte[]]) { $hashes = [Text.Encoding]::UTF8.GetString($hashes) }
        $match = [regex]::Match($hashes, "(?m)^([a-fA-F0-9]{64})\s+\*?$([regex]::Escape($imageName))\r?$")
        if (-not $match.Success) { throw 'The official Ubuntu checksum list does not contain this image.' }
        if (-not (Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $match.Groups[1].Value) {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$imageName" -OutFile $archive
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $match.Groups[1].Value) {
            throw 'Ubuntu image checksum mismatch. Run with -Resume to retry.'
        }
        $installDirectory = Join-Path $env:LOCALAPPDATA 'Dama\wsl'
        New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
        # This reservation also lets a retry recover an interrupted import.
        New-Item -ItemType File -Path $ownership -Force | Out-Null
        Invoke-Wsl -Arguments @('--import', $distribution, $installDirectory, $archive, '--version', '2')
        Remove-Item -LiteralPath $archive
    }

    $linuxSource = ConvertTo-LinuxPath $stateDirectory
    Write-Host '[Dama] Preparing systemd'
    Invoke-Wsl -Arguments @('-d', $distribution, '-u', 'root', '--exec', 'bash', "$linuxSource/scripts/setup-wsl.sh", 'prepare')
    Invoke-Wsl -Arguments @('--terminate', $distribution)
    Start-Sleep -Seconds 3
    Invoke-Wsl -Arguments @('-d', $distribution, '-u', 'root', '--exec', 'bash', '-c', 'for attempt in {1..60}; do test -d /run/systemd/system && exit 0; sleep 1; done; exit 1')

    $installArguments = @('-d', $distribution, '-u', 'root', '--exec', 'bash', "$linuxSource/scripts/setup-wsl.sh", 'install', $linuxSource)
    if ($Route53Email) {
        $installArguments += @('route53', $Route53Email, (ConvertTo-LinuxPath $AwsCredentialsFile))
    } else {
        $installArguments += @('certificate', (ConvertTo-LinuxPath $CertDirectory))
    }
    Invoke-Wsl -Arguments $installArguments

    New-Item -ItemType File -Path (Join-Path $stateDirectory 'installed') -Force | Out-Null
    Start-ScheduledTask -TaskName $startTask
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/api/health' -TimeoutSec 5
            if ($health.ok -eq $true) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'The Windows-to-WSL dashboard health check failed.' }
    $networkReady = $false
    $expectedBootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $statusFile = Join-Path $stateDirectory 'runtime-status.json'
        try {
            $status = Get-Content -LiteralPath $statusFile -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($status.Ready -and $status.SessionId -eq 0 -and ([DateTime]$status.WindowsBootTime).ToUniversalTime() -eq $expectedBootTime) {
                $networkReady = $true
                break
            }
        } catch { Write-Verbose 'Waiting for the current boot task status.' }
        Start-Sleep -Seconds 2
    }
    if (-not $networkReady) { throw 'The boot supervisor did not verify HTTPS forwarding. See runtime.log.' }
    Unregister-ScheduledTask -TaskName $resumeTask -Confirm:$false
    Write-Host 'Dama is ready at http://127.0.0.1:3100. The boot task is configured to start WSL and HTTPS before Windows sign-in. Verify it with a Windows reboot.'
    Write-Host "Setup log: $stateDirectory\install.log"
} finally {
    Stop-Transcript | Out-Null
}
