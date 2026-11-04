[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status', 'trust', 'firewall')][string]$Action = 'start',
    [string]$ServerIP
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$generated = Join-Path $root 'deploy/generated'
$lanEnv = Join-Path $generated 'lan.env'
$certificate = Join-Path $generated 'voicecord-lan-root.crt'
$originalServerIP = $env:SERVER_IP
function Invoke-LanCommand {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)" }
}
function Save-LanText {
    param([string]$Name, [string]$Value)
    [IO.File]::WriteAllText((Join-Path $generated $Name), $Value, (New-Object Text.UTF8Encoding($false)))
}
Push-Location $root
try {
    if (!$ServerIP -and (Test-Path -LiteralPath $lanEnv)) {
        $ServerIP = ((Get-Content -LiteralPath $lanEnv | Where-Object { $_ -match '^SERVER_IP=' }) -replace '^SERVER_IP=', '').Trim()
    }
    if (!$ServerIP) { throw 'First run: .\lan.cmd start -ServerIP <LAN IPv4 address>' }
    $parsed = $null
    if (![Net.IPAddress]::TryParse($ServerIP, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'ServerIP must be an IPv4 address.'
    }
    $octets = $parsed.GetAddressBytes()
    if (!(($octets[0] -eq 10) -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168))) {
        throw 'Use a private LAN IPv4 address (10.x, 172.16-31.x or 192.168.x).'
    }
    $compose = @('compose', '--env-file', $lanEnv, '-f', 'compose.lan.yaml')
    $env:SERVER_IP = $ServerIP
    if ($Action -eq 'trust') {
        if (!(Test-Path -LiteralPath $certificate)) { throw 'Start the LAN server first to export its certificate.' }
        Invoke-LanCommand 'certutil.exe' @('-user', '-addstore', 'Root', $certificate)
        Write-Host 'LAN CA trusted for the current Windows user. Fully exit Voicecord via the tray and restart it.'
    } elseif ($Action -eq 'firewall') {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Open PowerShell as Administrator, then run .\lan.cmd firewall from the project folder.'
        }
        if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ServerIP -ErrorAction SilentlyContinue)) { throw 'ServerIP is not assigned to this computer.' }
        foreach ($rule in @(@{Name='Voicecord-LAN-TCP'; Protocol='TCP'; Ports=@(443,7881)}, @{Name='Voicecord-LAN-UDP'; Protocol='UDP'; Ports=@(7882)})) {
            # Refresh only our own named rules; never disable Windows Firewall.
            Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            New-NetFirewallRule -Name $rule.Name -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol $rule.Protocol -LocalPort $rule.Ports -LocalAddress $ServerIP -RemoteAddress LocalSubnet -Profile Any | Out-Null
        }
        Write-Host "LAN-only firewall rules installed for $ServerIP (TCP 443/7881, UDP 7882)."
    } elseif ($Action -eq 'start') {
        if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ServerIP -ErrorAction SilentlyContinue)) { throw 'ServerIP is not assigned to this computer.' }
        if (!(Test-Path -LiteralPath (Join-Path $generated 'api.env'))) { throw 'Create the base server configuration first (npm run configure).' }
        $values = @{}
        foreach ($line in Get-Content -LiteralPath (Join-Path $generated 'api.env')) {
            if ($line -match '^([A-Z_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim("'") }
        }
        foreach ($required in @('LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'VOICECORD_PASSWORD_HASH')) {
            if (!$values.ContainsKey($required) -or !$values[$required]) { throw "Missing server setting: $required" }
        }
        # Reuse existing secrets/hash. Do not rotate the user's password.
        Save-LanText 'lan.env' "SERVER_IP=$ServerIP`n"
        Save-LanText 'api.lan.env' "LISTEN_ADDR=127.0.0.1:8080`nLIVEKIT_URL=wss://$ServerIP/rtc`nLIVEKIT_API_KEY=$($values['LIVEKIT_API_KEY'])`nLIVEKIT_API_SECRET=$($values['LIVEKIT_API_SECRET'])`nVOICECORD_PASSWORD_HASH='$($values['VOICECORD_PASSWORD_HASH'])'`n"
        Save-LanText 'livekit.lan.yaml' "port: 7880`nbind_addresses: [0.0.0.0]`nrtc:`n  tcp_port: 7881`n  udp_port: 7882`n  use_external_ip: false`n  node_ip: $ServerIP`nkeys:`n  $($values['LIVEKIT_API_KEY']): $($values['LIVEKIT_API_SECRET'])`nroom:`n  auto_create: true`n  empty_timeout: 300`n  max_participants: 30`nlogging:`n  level: info`n"
        Invoke-LanCommand 'docker' @('info', '--format', '{{.OSType}}')
        Invoke-LanCommand 'docker' ($compose + @('config', '-q'))
        # These modes use the same media ports. Stopping preserves dev config.
        Invoke-LanCommand 'docker' @('compose', '-f', 'compose.dev.yaml', 'stop', 'livekit')
        Invoke-LanCommand 'docker' ($compose + @('up', '-d', '--build', '--force-recreate'))
        Invoke-LanCommand 'docker' ($compose + @('exec', '-T', 'proxy', 'sh', '-c', 'for i in $(seq 1 20); do if wget -q -O /dev/null http://127.0.0.1:8080/healthz && wget -q -O /dev/null http://livekit:7880; then exit 0; fi; sleep 1; done; exit 1'))
        $exported = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            & docker @compose cp 'proxy:/data/caddy/pki/authorities/local/root.crt' $certificate
            if ($LASTEXITCODE -eq 0) { $exported = $true; break }
            Start-Sleep -Seconds 1
        }
        if (!$exported) { throw 'Certificate export failed. Inspect: docker compose --env-file deploy/generated/lan.env -f compose.lan.yaml logs proxy' }
        $clientFolder = Join-Path $root 'release/lan-client'
        New-Item -ItemType Directory -Force -Path $clientFolder | Out-Null
        Copy-Item -LiteralPath $certificate -Destination (Join-Path $clientFolder 'voicecord-lan-root.crt') -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'trust-lan-certificate.cmd') -Destination (Join-Path $clientFolder 'trust-lan-certificate.cmd') -Force
        [IO.File]::WriteAllText((Join-Path $clientFolder 'README.txt'), "Voicecord LAN`r`nServer: https://$ServerIP`r`n`r`n1. Use the same local network as the server.`r`n2. Run trust-lan-certificate.cmd once under the Windows user who runs Voicecord.`r`n3. Fully exit Voicecord via the tray and restart it.`r`n4. Enter $ServerIP, your nickname and the server password.`r`n`r`nThis folder contains only the public LAN certificate. Obtain it directly from the server owner.`r`nNo administrator rights are required for certificate trust in the current user's store.`r`n", (New-Object Text.UTF8Encoding($false)))
        Compress-Archive -Path (Join-Path $clientFolder '*') -DestinationPath (Join-Path $root 'release/Voicecord-LAN-client.zip') -Force
        Write-Host "`nLAN address: https://$ServerIP" -ForegroundColor Green
        Write-Host 'Password unchanged. No host Go/Node process is needed for the server.'
        Write-Host 'On this PC: .\lan.cmd trust'
        Write-Host 'Once, in Administrator PowerShell: .\lan.cmd firewall'
        Write-Host 'For friends: share release/Voicecord-LAN-client.zip and the installer (never the deploy/generated folder).'
    } elseif ($Action -eq 'stop') {
        Invoke-LanCommand 'docker' ($compose + @('stop'))
    } else {
        Invoke-LanCommand 'docker' ($compose + @('ps'))
    }
} finally {
    $env:SERVER_IP = $originalServerIP
    Pop-Location
}
