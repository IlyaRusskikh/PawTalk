param([string]$Invitation)
$ErrorActionPreference = 'Stop'
if (-not $Invitation) { $Invitation = Read-Host 'Paste the current voicecord:// invitation' }
$report = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); stage = 'input'; ok = $false }
$tcp = $null
$stream = $null
try {
    $uri = [Uri]$Invitation.Trim()
    if ($uri.Scheme -ne 'voicecord' -or $uri.Port -lt 1 -or $uri.AbsolutePath -notmatch '^/[a-f0-9]{64}$' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'Invalid Voicecord invitation' }
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($uri.Host, [ref]$ip)) { throw 'Expected an IP address' }
    $report.server = $uri.Authority
    $report.stage = 'tcp'
    $tcp = New-Object System.Net.Sockets.TcpClient
    $task = $tcp.ConnectAsync($uri.Host, $uri.Port)
    if (-not $task.Wait(7000)) { throw 'TCP_TIMEOUT: server is unreachable from this network' }
    $report.tcp = 'connected'
    $report.stage = 'tls'
    $stream = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, { param($sender,$cert,$chain,$errors) return $true })
    $stream.ReadTimeout = 7000
    $stream.WriteTimeout = 7000
    $stream.AuthenticateAsClient($uri.Host)
    $report.tls = $stream.SslProtocol.ToString()
    $report.stage = 'certificate'
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream.RemoteCertificate.GetRawCertData()))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($actual -cne $uri.AbsolutePath.Substring(1)) { throw 'CERTIFICATE_MISMATCH: copy a new invitation from the running room' }
    $report.certificate = 'matched'
    # Send no HTTP data until the room certificate has been checked. No password is used.
    $report.stage = 'health'
    $request = [Text.Encoding]::ASCII.GetBytes("GET /healthz HTTP/1.1`r`nHost: $($uri.Authority)`r`nConnection: close`r`n`r`n")
    $stream.Write($request, 0, $request.Length)
    $reader = New-Object System.IO.StreamReader($stream)
    $status = $reader.ReadLine()
    $report.http = $status
    if ($status -notmatch '^HTTP/1\.[01] 200 ') { throw 'Server health endpoint failed' }
    $report.stage = 'complete'
    $report.ok = $true
    $report.note = 'TCP, TLS, current certificate and API are reachable. Password and voice transport were not tested.'
} catch { $report.error = $_.Exception.GetBaseException().Message }
finally { if ($stream) { $stream.Dispose() }; if ($tcp) { $tcp.Dispose() } }
$json = $report | ConvertTo-Json
$json
$reportPath = Join-Path $PSScriptRoot 'connection-report.json'
[IO.File]::WriteAllText($reportPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Host "Report saved: $reportPath"
if (-not $report.ok) { exit 1 }
