#Requires -Version 5.1
#Requires -RunAsAdministrator
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$stateDirectory = Split-Path $PSScriptRoot -Parent
$settings = Get-Content -LiteralPath (Join-Path $stateDirectory 'settings.json') -Raw | ConvertFrom-Json
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$statusFile = Join-Path $stateDirectory 'runtime-status.json'
$bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')

function Write-RuntimeStatus {
    param([bool] $Ready, [string] $Message, [string] $Address = '')
    $status = @{
        Ready = $Ready
        Message = $Message
        WslAddress = $Address
        UpdatedAt = [DateTime]::UtcNow.ToString('o')
        WindowsBootTime = $bootTime
        SessionId = (Get-Process -Id $PID).SessionId
    }
    $temporary = "$statusFile.next"
    $status | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $statusFile -Force
}

function Set-DamaForwarding {
    param([string] $Address)
    Set-Service -Name iphlpsvc -StartupType Automatic
    Start-Service -Name iphlpsvc
    foreach ($port in @(80, 443)) {
        & $netsh interface portproxy add v4tov4 "listenaddress=$($settings.ListenAddress)" "listenport=$port" "connectaddress=$Address" "connectport=$port"
        if ($LASTEXITCODE -ne 0) { throw "Could not configure HTTPS/HTTP forwarding on port $port." }
        $ruleName = "Dama-WSL-TCP-$port"
        $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
        if (-not $rule) {
            $localAddress = $settings.ListenAddress
            if ($localAddress -eq '0.0.0.0') { $localAddress = 'Any' }
            New-NetFirewallRule -Name $ruleName -DisplayName "Dama WSL TCP $port" -Direction Inbound `
                -Action Allow -Protocol TCP -LocalPort $port -LocalAddress $localAddress | Out-Null
        }
    }
}

function Test-DamaHttps {
    param([string] $Domain)
    $probeAddress = $settings.ListenAddress
    if ($probeAddress -eq '0.0.0.0') { $probeAddress = '127.0.0.1' }
    $response = & $curl --fail --silent --show-error --max-time 10 --noproxy '*' `
        --resolve "${Domain}:443:$probeAddress" "https://$Domain/_dama/ready"
    if ($LASTEXITCODE -ne 0 -or ($response -join "`n").Trim() -ne 'dama-nginx-ready') {
        throw 'Windows HTTPS forwarding did not return the verified Dama readiness response.'
    }
}

$child = $null
$lastAddress = ''
Start-Transcript -Path (Join-Path $stateDirectory 'runtime.log') -Append | Out-Null
try {
    Write-RuntimeStatus -Ready $false -Message 'Waiting for installation'
    while (-not (Test-Path -LiteralPath (Join-Path $stateDirectory 'installed'))) { Start-Sleep -Seconds 10 }
    while ($true) {
        try {
            if ($null -eq $child -or $child.HasExited) {
                Write-RuntimeStatus -Ready $false -Message 'Starting Linux services'
                $child = Start-Process -FilePath $wsl -ArgumentList @('-d', 'Dama', '-u', 'root', '--exec', 'bash', '/opt/dama/source/scripts/start-wsl-services.sh') `
                    -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDirectory 'linux-startup.log') `
                    -RedirectStandardError (Join-Path $stateDirectory 'linux-startup-errors.log')
                $lastAddress = ''
            }
            $addressOutput = & $wsl -d Dama -u root --exec ip -4 -o addr show dev eth0
            if ($LASTEXITCODE -ne 0) { throw 'Could not read the WSL network address.' }
            $match = [regex]::Match(($addressOutput -join "`n"), '\binet ([0-9.]+)/')
            if (-not $match.Success) { throw 'WSL has no IPv4 address on eth0.' }
            $address = $match.Groups[1].Value
            if ($address -ne $lastAddress) {
                Set-DamaForwarding -Address $address
                $lastAddress = $address
            }
            & $wsl -d Dama -u root --exec bash /opt/dama/source/scripts/start-wsl-services.sh --check
            if ($LASTEXITCODE -ne 0) { throw 'Linux services or the recovery worker are not ready.' }
            $deploymentDomain = if ($settings.PSObject.Properties['DeploymentDomain'] -and $settings.DeploymentDomain) {
                $settings.DeploymentDomain
            } else {
                $output = & $wsl -d Dama -u root --exec bash /opt/dama/source/scripts/start-wsl-services.sh --domain
                if ($LASTEXITCODE -ne 0) { throw 'Could not read the installed deployment domain.' }
                ($output -join "`n").Trim()
            }
            if ($deploymentDomain -notmatch '^(?:[a-z0-9-]+\.)+[a-z0-9-]+$') { throw 'The installed deployment domain is invalid.' }
            Test-DamaHttps -Domain $deploymentDomain
            Write-RuntimeStatus -Ready $true -Message 'Services and Windows HTTPS forwarding verified' -Address $address
            Start-Sleep -Seconds 30
        } catch {
            Write-RuntimeStatus -Ready $false -Message $_.Exception.Message
            Write-Warning $_.Exception.Message
            $lastAddress = ''
            Start-Sleep -Seconds 10
        }
    }
} finally {
    if ($null -ne $child -and -not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
    Write-RuntimeStatus -Ready $false -Message 'Boot supervisor stopped'
    Stop-Transcript | Out-Null
}
