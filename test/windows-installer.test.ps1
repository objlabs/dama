# Run with pwsh -NoProfile -File test/windows-installer.test.ps1.
# Windows commands are substituted so this test never changes host configuration.
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('dama-boot-test-' + [guid]::NewGuid())
$originalLocal = $env:LOCALAPPDATA
$originalRoot = $env:SystemRoot
$originalCommands = $env:DAMA_TEST_COMMANDS
$global:DamaTestEvents = [Collections.Generic.List[string]]::new()
$global:DamaTestPendingReboot = $true
$global:DamaTestFailWsl = $false
$global:DamaTestConflict = $false
$global:DamaTestPasswordPrompts = 0
$global:DamaTestSessionId = 0
$global:DamaTestRuntime = $false
$global:DamaTestReadyPolls = 0
$global:DamaTestErrorPolls = 0
$global:DamaTestIpCalls = 0
$global:DamaTestProxyFailure = $true

function Get-CimInstance {
    param($ClassName)
    switch ($ClassName) {
        Win32_OperatingSystem { @{ BuildNumber = '19045'; LastBootUpTime = [DateTime]::Today } }
        Win32_Processor { @{ VirtualizationFirmwareEnabled = $true; Architecture = 9 } }
        Win32_ComputerSystem { @{ HypervisorPresent = $true } }
    }
}
function Get-WindowsOptionalFeature {
    param([switch]$Online, $FeatureName)
    @{ State = $(if ($global:DamaTestPendingReboot) { 'EnablePending' } else { 'Enabled' }) }
}
function New-ScheduledTaskAction { param($Execute,$Argument) @{ Execute=$Execute; Argument=$Argument } }
function New-ScheduledTaskTrigger {
    param([switch]$AtStartup)
    if (-not $AtStartup) { throw 'Boot recovery must use a startup trigger.' }
    @{ Startup=$true }
}
function New-ScheduledTaskPrincipal {
    param($UserId,$LogonType,$RunLevel)
    if ($LogonType -ne 'Password' -or $RunLevel -ne 'Highest') { throw 'Task requires password batch logon and elevation.' }
    @{ User=$UserId; LogonType=$LogonType }
}
function New-ScheduledTaskSettingsSet {
    param([switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$RestartCount,$RestartInterval,$MultipleInstances)
    if ($ExecutionTimeLimit -ne [TimeSpan]::Zero -or $MultipleInstances -ne 'IgnoreNew') { throw 'Unexpected runtime lifecycle.' }
    @{}
}
function New-ScheduledTask {
    param($Action,$Trigger,$Principal,$Settings)
    if ($Action.Argument -notmatch '-NonInteractive') { throw 'Boot action must be noninteractive.' }
    @{ Action=$Action; Trigger=$Trigger; Principal=$Principal }
}
function Register-ScheduledTask {
    param($TaskName,$InputObject,$User,$Password,[switch]$Force)
    if ($User -ne 'DamaTest' -or $Password -ne 'synthetic-test-password') { throw 'Credentials were not supplied for batch logon.' }
    $global:DamaTestEvents.Add("register $TaskName")
}
function Start-ScheduledTask {
    param($TaskName)
    $global:DamaTestEvents.Add("start $TaskName")
    if ($TaskName -eq 'Dama-WSL') {
        @{ Ready=$true; SessionId=$global:DamaTestSessionId; WindowsBootTime=[DateTime]::Today.ToUniversalTime().ToString('o') } | ConvertTo-Json |
            Set-Content (Join-Path $env:LOCALAPPDATA 'Dama/setup/runtime-status.json')
    }
}
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) $global:DamaTestEvents.Add("remove $TaskName") }
function Stop-ScheduledTask { param($TaskName,$ErrorAction) }
function Start-Transcript { param($Path,[switch]$Append) }
function Stop-Transcript {}
function Start-Sleep {
    param($Seconds)
    if ($global:DamaTestRuntime) {
        if ($Seconds -eq 30) {
            $global:DamaTestReadyPolls++
            if ($global:DamaTestReadyPolls -ge 2) { throw 'end-runtime-test' }
        } else {
            $global:DamaTestErrorPolls++
            if ($global:DamaTestErrorPolls -ge 2) { throw 'end-runtime-test' }
        }
    }
}
function Invoke-RestMethod { param($Uri,$TimeoutSec) @{ok=$true} }
function Get-NetTCPConnection {
    param($LocalPort,$State,$ErrorAction)
    if ($global:DamaTestConflict) { @{LocalAddress='0.0.0.0'} }
}
function Get-NetFirewallRule { param($Name,$ErrorAction) }
function Get-ItemProperty { param($Path,$Name,$ErrorAction) }
function icacls.exe { $global:LASTEXITCODE=0 }
function Read-Host {
    param($Prompt,[switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'Unexpected interactive prompt during setup.' }
    $global:DamaTestPasswordPrompts++
    ConvertTo-SecureString 'synthetic-test-password' -AsPlainText -Force
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Uri,$OutFile)
    if ($OutFile) { [IO.File]::WriteAllText($OutFile, 'fake image'); return }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('fake image'))).Replace('-','').ToLowerInvariant()
        # The official endpoint returns bytes, including on PowerShell 7.
        @{ Content = [Text.Encoding]::UTF8.GetBytes("$hash *ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz`n") }
    } finally { $sha.Dispose() }
}
function wsl.exe {
    $arguments = @($args)
    $global:LASTEXITCODE = 0
    if ($global:DamaTestFailWsl) { $global:LASTEXITCODE=7; return }
    Add-Content $env:DAMA_TEST_COMMANDS ($arguments -join '|')
    if ($arguments -contains 'wslpath') { '/mnt/c/Dama setup' }
    if ($arguments -contains 'eth0') {
        $global:DamaTestIpCalls++
        if ($global:DamaTestIpCalls -le 2) { '2: eth0 inet 172.20.0.2/20' }
        else { '2: eth0 inet 172.20.0.3/20' }
    }
}

function Set-Service { param($Name,$StartupType) }
function Start-Service { param($Name) }
function New-NetFirewallRule { param($Name,$DisplayName,$Direction,$Action,$Protocol,$LocalPort,$LocalAddress) }
function Start-Process { param($FilePath,$ArgumentList,[switch]$PassThru,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError) @{ HasExited=$false; Id=999 } }
function Stop-Process { param($Id,$ErrorAction) }
function netsh.exe {
    $global:DamaTestEvents.Add('proxy ' + ($args -join '|'))
    $global:LASTEXITCODE=0
    if ($global:DamaTestProxyFailure -and $args -contains 'listenport=443') {
        $global:DamaTestProxyFailure=$false
        $global:LASTEXITCODE=1
    }
}
function curl.exe {
    if ($args -notcontains 'apps.example.test:443:127.0.0.1' -or
        $args -notcontains 'https://apps.example.test/_dama/ready') {
        throw 'HTTPS readiness did not use the configured domain.'
    }
    $global:LASTEXITCODE=0
    'dama-nginx-ready'
}

try {
    New-Item -ItemType Directory "$fixture/scripts", "$fixture/cert" -Force > $null
    foreach ($name in @('src','public','test','deploy')) { New-Item -ItemType Directory "$fixture/$name" > $null }
    foreach ($name in @('package.json','package-lock.json','tsconfig.json','tsconfig.base.json','tsconfig.browser.json')) { Set-Content "$fixture/$name" '{}' }
    Set-Content "$fixture/cert/fullchain.pem" 'test certificate'
    Set-Content "$fixture/cert/privkey.pem" 'test key'
    $env:LOCALAPPDATA = "$fixture/local"
    $env:SystemRoot = "$fixture/windows"
    $env:DAMA_TEST_COMMANDS = "$fixture/commands"
    foreach ($file in @('install-windows.ps1','start-windows.ps1')) {
        $source = Get-Content "$repository/scripts/$file" -Raw
        $tokens=$null; $parseErrors=$null
        [System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors) > $null
        if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
        if ($file -eq 'install-windows.ps1') {
            $source = $source -replace '(?m)^#Requires.*\r?\n', ''
            $source = $source.Replace('$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name', '$identity = "DamaTest"')
            $source = $source.Replace('$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value', '$userSid = "S-1-5-21-123"')
            $source = $source.Replace("Join-Path $" + "env:SystemRoot 'System32\wsl.exe'", "'wsl.exe'")
        }
        foreach ($name in @('wsl','netsh','curl')) {
            $source = $source.Replace("Join-Path $" + "env:SystemRoot 'System32\$name.exe'", "'$name.exe'")
        }
        [IO.File]::WriteAllText("$fixture/scripts/$file", $source)
    }
    & "$fixture/scripts/install-windows.ps1" -DeploymentDomain 'Apps.Example.Test' -CertDirectory "$fixture/cert"
    if (Test-Path $env:DAMA_TEST_COMMANDS) { throw 'WSL launched before the required reboot.' }
    if ($global:DamaTestEvents -notcontains 'register Dama-WSL' -or $global:DamaTestEvents -notcontains 'register Dama-Install-Resume') { throw 'Both boot tasks must be registered before reboot.' }
    $settingsPath = Join-Path $env:LOCALAPPDATA 'Dama/setup/settings.json'
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($settings.DeploymentDomain -ne 'apps.example.test') { throw 'Deployment domain must be normalized and staged before reboot.' }
    if (-not (Test-Path (Join-Path $settings.CertDirectory 'privkey.pem'))) { throw 'Certificate must be staged before reboot.' }
    if ((Get-Content $settingsPath -Raw) -match 'synthetic-test-password') { throw 'Windows password leaked into settings.' }
    'PASS boot tasks and local inputs are prepared before the required reboot'

    $global:DamaTestPendingReboot=$false
    & "$fixture/scripts/install-windows.ps1" -Resume
    if ($global:DamaTestPasswordPrompts -ne 1) { throw 'Resume must run without a password prompt.' }
    $commands = Get-Content $env:DAMA_TEST_COMMANDS -Raw
    if ($commands -notmatch '--import\|Dama' -or $commands -notmatch '--version\|2') { throw 'WSL 2 import is missing.' }
    if ($commands -notmatch 'install\|/mnt/c/Dama setup\|apps\.example\.test\|certificate\|/mnt/c/Dama setup') {
        throw 'The deployment domain and spaced paths were not preserved as arguments.'
    }
    if ($global:DamaTestEvents -notcontains 'remove Dama-Install-Resume') { throw 'Setup continuation was not removed after verified completion.' }
    'PASS noninteractive boot resume imports WSL 2 and completes without further credentials'

    $global:DamaTestEvents.Clear()
    $global:DamaTestSessionId=1
    $failed=$false
    try { & "$fixture/scripts/install-windows.ps1" -Resume } catch { $failed=$true }
    if (-not $failed -or $global:DamaTestEvents -contains 'remove Dama-Install-Resume') { throw 'An interactive ready response must not count as verified boot startup.' }
    'PASS interactive-session readiness cannot complete unattended boot installation'
    $global:DamaTestSessionId=0

    $global:DamaTestEvents.Clear()
    $global:DamaTestFailWsl=$true
    $failed=$false
    try { & "$fixture/scripts/install-windows.ps1" -Resume } catch { $failed=$true }
    if (-not $failed -or $global:DamaTestEvents -contains 'remove Dama-Install-Resume') { throw 'WSL failure was ignored.' }
    'PASS WSL errors stop setup and preserve continuation'

    $global:DamaTestFailWsl=$false
    $global:DamaTestConflict=$true
    $settings.NetworkReserved=$false
    $settings | ConvertTo-Json | Set-Content $settingsPath
    $failed=$false
    try { & "$fixture/scripts/install-windows.ps1" -Resume } catch { $failed=$true }
    if (-not $failed) { throw 'Existing Windows HTTP service must cause a port conflict.' }
    'PASS existing Windows HTTP listeners are preserved'

    $global:DamaTestRuntime=$true
    $global:DamaTestConflict=$false
    $settings | ConvertTo-Json | Set-Content "$fixture/settings.json"
    New-Item -ItemType File "$fixture/installed" > $null
    try { & "$fixture/scripts/start-windows.ps1" } catch {
        if ($_.Exception.Message -ne 'end-runtime-test') { throw }
    }
    $proxyCalls = @($global:DamaTestEvents | Where-Object { $_ -like 'proxy *' })
    if ($proxyCalls.Count -ne 6 -or $global:DamaTestReadyPolls -ne 2) { throw 'Supervisor failed to recover forwarding and observe both ready states.' }
    if ($proxyCalls[-1] -notmatch 'connectaddress=172.20.0.3') { throw 'Forwarding did not follow the changed WSL address.' }
    'PASS boot supervisor retries failed forwarding and refreshes it after a WSL IP change'
} finally {
    $env:LOCALAPPDATA=$originalLocal
    $env:SystemRoot=$originalRoot
    $env:DAMA_TEST_COMMANDS=$originalCommands
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
