param(
    [ValidateRange(1024, 65532)][int]$Port = 18443,
    [ValidateRange(10, 180)][int]$Seconds = 180,
    [string]$PublicIP,
    [switch]$SkipUdpCheck,
    [switch]$SkipTcpCheck,
    [switch]$Application
)

# Windows PowerShell 5.1+, no installer, Node.js or administrator rights required.
# Only finite UPnP leases are used. Existing mappings are never replaced.
function Get-UPnPService([string]$Location) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Location -TimeoutSec 4
    $document = New-Object System.Xml.XmlDocument
    $document.XmlResolver = $null
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    $document.LoadXml($content)
    $base = [Uri]$Location
    $urlBase = $document.SelectSingleNode('//*[local-name()="URLBase"]')
    if ($urlBase -and $urlBase.InnerText) { $base = [Uri]$urlBase.InnerText }
    foreach ($service in $document.SelectNodes('//*[local-name()="service"]')) {
        $type = $service.SelectSingleNode('*[local-name()="serviceType"]').InnerText
        if ($type -match '^urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:[12]$') {
            $control = $service.SelectSingleNode('*[local-name()="controlURL"]').InnerText
            $uri = New-Object Uri($base, $control)
            if ($uri.Scheme -notin @('http', 'https')) { continue }
            return @{ Type = $type; Url = $uri.AbsoluteUri }
        }
    }
    throw 'No UPnP WAN connection service in router description.'
}

function Find-UPnPService([string]$LocalIP) {
    $udp = New-Object Net.Sockets.UdpClient
    $locations = New-Object 'Collections.Generic.HashSet[string]'
    try {
        $udp.Client.Bind((New-Object Net.IPEndPoint([Net.IPAddress]::Parse($LocalIP), 0)))
        $udp.Client.ReceiveTimeout = 500
        $message = "M-SEARCH * HTTP/1.1`r`nHOST: 239.255.255.250:1900`r`nMAN: `"ssdp:discover`"`r`nMX: 2`r`nST: ssdp:all`r`n`r`n"
        $bytes = [Text.Encoding]::ASCII.GetBytes($message)
        $destination = New-Object Net.IPEndPoint([Net.IPAddress]::Parse('239.255.255.250'), 1900)
        [void]$udp.Send($bytes, $bytes.Length, $destination)
        $deadline = [DateTime]::UtcNow.AddSeconds(4)
        while ([DateTime]::UtcNow -lt $deadline) {
            $remote = New-Object Net.IPEndPoint([Net.IPAddress]::Any, 0)
            try { $reply = [Text.Encoding]::ASCII.GetString($udp.Receive([ref]$remote)) }
            catch [Net.Sockets.SocketException] { continue }
            if ($reply -match '(?im)^location:\s*(https?://[^\r\n]+)') { [void]$locations.Add($Matches[1].Trim()) }
        }
    } finally { $udp.Dispose() }
    foreach ($location in $locations) {
        try { return Get-UPnPService $location } catch { }
    }
    throw 'UPnP discovery failed. Manual forwarding may still work; NAT-PMP is not tested.'
}

function Invoke-UPnPAction($Service, [string]$Action, [System.Collections.IDictionary]$Values) {
    $arguments = ''
    foreach ($name in $Values.Keys) {
        $value = [Security.SecurityElement]::Escape([string]$Values[$name])
        $arguments += "<$name>$value</$name>"
    }
    $body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:' + $Action + ' xmlns:u="' + $Service.Type + '">' + $arguments + '</u:' + $Action + '></s:Body></s:Envelope>'
    $response = $null
    try {
        # Read SOAP faults ourselves: Invoke-WebRequest can consume/transform the
        # HTTP 500 body differently in Windows PowerShell and PowerShell 7.
        $request = [Net.HttpWebRequest]::Create($Service.Url)
        $request.Method = 'POST'
        $request.Timeout = 4000
        $request.ReadWriteTimeout = 4000
        $request.ContentType = 'text/xml; charset="utf-8"'
        $request.Headers['SOAPAction'] = '"' + $Service.Type + '#' + $Action + '"'
        $bytes = [Text.Encoding]::UTF8.GetBytes($body)
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        try { $response = $request.GetResponse() }
        catch [Net.WebException] {
            if (-not $_.Exception.Response) { throw }
            $response = $_.Exception.Response
        }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $xml = New-Object Xml.XmlDocument
        $xml.XmlResolver = $null
        try { $xml.LoadXml($content) }
        catch { throw "${Action}: HTTP $([int]$response.StatusCode); router returned no readable SOAP XML." }
        $code = $xml.SelectSingleNode('//*[local-name()="UPnPError"]/*[local-name()="errorCode"]')
        if ($code) {
            $description = $xml.SelectSingleNode('//*[local-name()="UPnPError"]/*[local-name()="errorDescription"]')
            throw "UPNP_$($code.InnerText.Trim()): $Action - $($description.InnerText)"
        }
        if ([int]$response.StatusCode -ge 400 -or $xml.SelectSingleNode('//*[local-name()="Fault"]')) {
            throw "${Action}: HTTP $([int]$response.StatusCode); router rejected the SOAP request without a UPnP error code."
        }
        return $xml
    } catch {
        if ($_.Exception.Message -match '^UPNP_\d+:') { throw }
        throw "${Action}: $($_.Exception.Message)"
    }
    finally { if ($response) { $response.Dispose() } }
}

function Add-TestMapping($Service, [int]$TestPort, [string]$LocalIP, [string]$Description, [ValidateSet('TCP', 'UDP')][string]$Protocol = 'TCP') {
    $query = [ordered]@{ NewRemoteHost = ''; NewExternalPort = $TestPort; NewProtocol = $Protocol }
    try { $null = Invoke-UPnPAction $Service 'GetSpecificPortMappingEntry' $query }
    catch {
        if ($_.Exception.Message -notmatch '^UPNP_714:') { throw }
        # 714 = NoSuchEntryInArray. Every other response is treated as unknown/occupied.
        $null = Invoke-UPnPAction $Service 'AddPortMapping' ([ordered]@{
            NewRemoteHost = ''; NewExternalPort = $TestPort; NewProtocol = $Protocol
            NewInternalPort = $TestPort; NewInternalClient = $LocalIP; NewEnabled = 1
            NewPortMappingDescription = $Description; NewLeaseDuration = 300
        })
        return
    }
    throw "Existing $Protocol mapping for $TestPort was left unchanged. Choose another -Port."
}

function Remove-TestMapping($Service, [int]$TestPort, [string]$LocalIP, [string]$Description, [ValidateSet('TCP', 'UDP')][string]$Protocol = 'TCP') {
    $query = [ordered]@{ NewRemoteHost = ''; NewExternalPort = $TestPort; NewProtocol = $Protocol }
    $entry = Invoke-UPnPAction $Service 'GetSpecificPortMappingEntry' $query
    $owner = $entry.SelectSingleNode('//*[local-name()="NewPortMappingDescription"]')
    $client = $entry.SelectSingleNode('//*[local-name()="NewInternalClient"]')
    if ($owner.InnerText -ne $Description -or $client.InnerText -ne $LocalIP) {
        throw "Mapping $TestPort changed ownership; it was left unchanged."
    }
    $null = Invoke-UPnPAction $Service 'DeletePortMapping' $query
}

function Test-PublicIPv4([string]$Address) {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $b = $ip.GetAddressBytes()
    return -not ($b[0] -eq 0 -or $b[0] -eq 10 -or $b[0] -eq 127 -or $b[0] -ge 224 -or
        ($b[0] -eq 169 -and $b[1] -eq 254) -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or
        ($b[0] -eq 192 -and $b[1] -eq 168) -or ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127))
}

function New-PortProbe([string]$Address, [int]$TestPort, [ValidateSet('TCP', 'UDP')][string]$Protocol, [string]$ApiBase = 'https://check-host.net') {
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.MaxConnectionsPerServer = 6
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(12)
    $client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
    try {
        # Fetch checker IPs BEFORE dispatch: UDP probes can arrive before the
        # dispatch HTTP response, and some nodes wait only one second for an echo.
        $phase = 'nodes'
        if ($Protocol -eq 'TCP') {
            $target = [Uri]::EscapeDataString("${Address}:$TestPort")
            $task = $client.GetAsync("$ApiBase/check-tcp?host=$target&max_nodes=2")
            $phase = 'submit'
        } else { $task = $client.GetAsync("$ApiBase/nodes/ips") }
        return @{ Client = $client; Task = $task; Address = $Address; Port = $TestPort; Protocol = $Protocol; Nodes = @{}; AllowedIPs = @()
            ApiBase = $ApiBase; Phase = $phase; Started = [DateTime]::UtcNow; NextPoll = [DateTime]::UtcNow; Id = ''; Received = $false
            Confirmed = $false; Echoes = 0; RemoteSuccess = $false; Error = ''; Finished = $false }
    } catch { $client.Dispose(); throw }
}

function New-UdpProbe([string]$Address, [int]$TestPort, [string]$ApiBase = 'https://check-host.net') {
    return New-PortProbe $Address $TestPort UDP $ApiBase
}

function New-TcpProbe([string]$Address, [int]$TestPort, [string]$ApiBase = 'https://check-host.net') {
    return New-PortProbe $Address $TestPort TCP $ApiBase
}

function Receive-UdpProbe($Socket, $Probe) {
    # Echo short probes only from known checker nodes; no amplification.
    # A bounded batch keeps TCP handling and Q responsive under unrelated traffic.
    for ($i = 0; $i -lt 16 -and $Socket.Available -gt 0; $i++) {
        $remote = New-Object Net.IPEndPoint([Net.IPAddress]::Any, 0)
        $packet = $Socket.Receive([ref]$remote)
        if (-not $Probe -or $Probe.Finished -or $Probe.Echoes -ge 16 -or $packet.Length -gt 256) { continue }
        if ($remote.Address.ToString() -notin $Probe.AllowedIPs -or -not (Test-PublicIPv4 $remote.Address.ToString())) { continue }
        $Probe.Received = $true
        $Probe.Echoes++
        try {
            [void]$Socket.Send($packet, $packet.Length, $remote)
            Write-Host "UDP checker probe received on $($Probe.Port); echo sent. Waiting for external acknowledgement."
        } catch { Write-Warning "UDP probe received, but reply failed: $($_.Exception.Message)" }
    }
}

function Test-PortReport($Report, $Probe) {
    foreach ($node in $Report.PSObject.Properties) {
        if (-not $Probe.Nodes.ContainsKey($node.Name)) { continue }
        foreach ($check in $node.Value) {
            # A UDP timeout/open-or-filtered result is NOT a successful reply.
            if ($null -ne $check.time -and $check.time -ge 0 -and -not $check.error -and -not $check.timeout -and $check.address -eq $Probe.Address) { return $true }
        }
    }
    return $false
}

function Update-PortProbe($Probe) {
    if ($Probe.Finished) { return }
    try {
        $protocol = $Probe.Protocol
        if (([DateTime]::UtcNow - $Probe.Started).TotalSeconds -ge 45) { throw "$protocol probe timed out on $($Probe.Port); external availability is not confirmed." }
        if ($Probe.Task -and $Probe.Task.IsCompleted) {
            $response = $Probe.Task.GetAwaiter().GetResult()
            try {
                if (-not $response.IsSuccessStatusCode) { throw "$protocol checker HTTP $([int]$response.StatusCode) on $($Probe.Port); availability is not confirmed." }
                $json = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
            } finally { $response.Dispose() }
            $Probe.Task = $null
            if ($Probe.Phase -eq 'nodes') {
                $Probe.AllowedIPs = @($json.nodes | Where-Object { Test-PublicIPv4 ([string]$_) })
                if ($Probe.AllowedIPs.Count -eq 0) { throw 'UDP checker returned no known IPv4 nodes.' }
                $target = [Uri]::EscapeDataString("$($Probe.Address):$($Probe.Port)")
                $Probe.Task = $Probe.Client.GetAsync("$($Probe.ApiBase)/check-udp?host=$target&max_nodes=2")
                $Probe.Phase = 'submit'
            } elseif ($Probe.Phase -eq 'submit') {
                if ($json.ok -ne 1 -or $json.request_id -notmatch '^[a-zA-Z0-9_-]{1,80}$') { throw "$protocol checker returned no valid request ID." }
                foreach ($node in $json.nodes.PSObject.Properties) {
                    if ($node.Value.Count -ge 4 -and (Test-PublicIPv4 $node.Value[3])) { $Probe.Nodes[$node.Name] = [string]$node.Value[3] }
                }
                if ($Probe.Nodes.Count -eq 0) { throw "$protocol checker returned no IPv4 probe nodes." }
                $Probe.AllowedIPs = @($Probe.Nodes.Values)
                $Probe.Id = $json.request_id
                $Probe.Phase = 'poll'
                Write-Host "$protocol $($Probe.Port) report: https://check-host.net/check-report/$($Probe.Id)"
            } else { $Probe.RemoteSuccess = Test-PortReport $json $Probe }
            $Probe.NextPoll = [DateTime]::UtcNow.AddSeconds(2)
        }
        if ($Probe.RemoteSuccess -and ($protocol -eq 'TCP' -or $Probe.Received)) {
            $Probe.Confirmed = $true
            $Probe.Finished = $true
            if ($protocol -eq 'UDP') { Write-Host "PASS: UDP $($Probe.Port) round trip confirmed by an external checker." -ForegroundColor Green }
            else { Write-Host "PASS: TCP $($Probe.Port) confirmed by an external checker." -ForegroundColor Green }
        } elseif (-not $Probe.Task -and $Probe.Phase -eq 'poll' -and [DateTime]::UtcNow -ge $Probe.NextPoll) {
            $Probe.Task = $Probe.Client.GetAsync("$($Probe.ApiBase)/check-result/$($Probe.Id)")
        }
    } catch {
        $Probe.Error = "$($Probe.Protocol) $($Probe.Port): $($_.Exception.GetBaseException().Message)"
        $Probe.Finished = $true
        Write-Warning $Probe.Error
    }
}

function Update-UdpProbe($Probe) { Update-PortProbe $Probe }

function Get-PreflightVerdict([bool]$TCPConfirmed, [bool]$UDPReceived, [bool]$UDPConfirmed) {
    if ($TCPConfirmed -and $UDPConfirmed) { return 'SUCCESS: both TCP ports and UDP round trip confirmed. Ready for a real Voicecord voice test.' }
    if ($TCPConfirmed -and $UDPReceived) { return 'PARTIAL SUCCESS: both TCP ports and inbound UDP confirmed; UDP return path NOT CONFIRMED.' }
    if ($TCPConfirmed) { return 'PARTIAL SUCCESS: both TCP ports confirmed; UDP round trip NOT CONFIRMED.' }
    if ($UDPConfirmed) { return 'PARTIAL SUCCESS: UDP round trip confirmed; both TCP ports NOT CONFIRMED.' }
    if ($UDPReceived) { return 'PARTIAL SUCCESS: inbound UDP probe received; return path and both TCP ports NOT CONFIRMED.' }
    return 'NOT CONFIRMED: no complete external TCP/UDP test. This does not prove hosting is impossible.'
}

function Start-SelfHostCheck {
    $ErrorActionPreference = 'Stop'
    $listeners = @()
    $udp = $null
    $service = $null
    $mapped = @()
    $probe = $null
    $tcpProbes = @()
    $tcpSeen = @{}
    $tcpConfirmed = $false
    $wan = ''
    $cancelled = $false
    $checkError = $false
    $cancelRead = $null
    if ($Application) {
        $cancelBuffer = New-Object byte[] 1
        $cancelRead = [Console]::OpenStandardInput().ReadAsync($cancelBuffer, 0, 1)
    }
    $tag = 'Voicecord check ' + [Guid]::NewGuid().ToString('N')
    try {
        Write-Host 'Voicecord self-host preflight (IPv4 / Windows)'
        Write-Host 'No firewall rules are changed. Allow the Windows firewall prompt if shown.'
        $configurations = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address })
        if ($configurations.Count -gt 1) { Write-Warning 'Multiple IPv4 gateways detected (possibly VPN). Reply traffic may take a different route. Disable VPN for a conclusive test.' }
        $configuration = $configurations | Select-Object -First 1
        if (-not $configuration) { throw 'No IPv4 interface with a default gateway found.' }
        $localIP = $configuration.IPv4Address[0].IPAddress
        Write-Host "LAN address: $localIP (disable VPN for this test)"
        foreach ($number in @($Port, ($Port + 1), ($Port + 3))) {
            $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $number)
            $listener.Server.ExclusiveAddressUse = $true
            $listeners += $listener
            $listener.Start()
        }
        $udp = New-Object Net.Sockets.UdpClient
        $udp.Client.ExclusiveAddressUse = $true
        # Replies must use the same LAN source address as the router mapping.
        $udp.Client.Bind((New-Object Net.IPEndPoint([Net.IPAddress]::Parse($localIP), ($Port + 2))))
        Write-Host "PASS: TCP $Port, $($Port+1), $($Port+3) and UDP $($Port+2) are free locally."
        Write-Host 'Looking for a UPnP router...'
        try {
            $service = Find-UPnPService $localIP
            $external = Invoke-UPnPAction $service 'GetExternalIPAddress' ([ordered]@{})
            $wan = $external.SelectSingleNode('//*[local-name()="NewExternalIPAddress"]').InnerText
            Write-Host "Router WAN IPv4: $wan"
            Write-Host 'Using router WAN IPv4. If upstream NAT/VPN changes your public IP, rerun with -PublicIP <IPv4>.'
        } catch { Write-Warning $_.Exception.Message }
        if ($cancelRead -and $cancelRead.IsCompleted) { $cancelled = $true; return }
        if ($service) {
            foreach ($mapping in @(@{ Port = $Port; Protocol = 'TCP' }, @{ Port = $Port + 1; Protocol = 'TCP' }, @{ Port = $Port + 2; Protocol = 'UDP' })) {
                # Record intent first: a lost HTTP response may hide a successful mapping.
                $mapped += $mapping
                try {
                    Add-TestMapping $service $mapping.Port $localIP $tag $mapping.Protocol
                    Write-Host "PASS: temporary $($mapping.Protocol) $($mapping.Port) forwarding created (300-second lease)."
                } catch {
                    Write-Warning $_.Exception.Message
                    if ($_.Exception.Message -match '^UPNP_725:') { Write-Host 'Router accepts permanent leases only; this test does not create permanent mappings.' }
                    Write-Host "You can manually forward $($mapping.Protocol) $($mapping.Port) to $localIP while this test runs."
                }
            }
        } else { Write-Host "Automatic forwarding unavailable. Manually forward TCP $Port, TCP $($Port+1) and UDP $($Port+2) to $localIP if needed." }
        Write-Host ''
        Write-Host 'TCP and UDP are checked automatically via check-host.net; no browser is needed.'
        Write-Host 'The service receives your public IP and ports, and creates public reports.'
        Write-Host 'Manual TCP fallback: https://2ip.io/ru/check-port/ (press T only if BOTH ports are open there).'
        $address = $wan
        if ($PublicIP) { $address = $PublicIP }
        if (Test-PublicIPv4 $address) {
            if (-not $SkipTcpCheck) {
                foreach ($number in @($Port, ($Port + 1))) {
                    try { $tcpProbes += New-TcpProbe $address $number } catch { Write-Warning "TCP checker unavailable on $number`: $($_.Exception.Message)" }
                }
            } else { Write-Host 'External TCP check skipped (-SkipTcpCheck).' }
            if (-not $SkipUdpCheck) {
                try { $probe = New-UdpProbe $address ($Port + 2) } catch { Write-Warning "UDP checker unavailable: $($_.Exception.Message)" }
            } else { Write-Host 'External UDP check skipped (-SkipUdpCheck).' }
        } elseif (-not $SkipTcpCheck -or -not $SkipUdpCheck) { Write-Warning 'External checks need a public IPv4. Rerun with -PublicIP <your public IPv4>.' }
        Write-Host "Waiting up to $Seconds seconds; finishes automatically on full success. Press Q to finish and clean up (or Ctrl+C)."
        $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($cancelRead -and $cancelRead.IsCompleted) { $cancelled = $true; break }
            foreach ($listener in $listeners[0..1]) {
                for ($i = 0; $i -lt 16 -and $listener.Pending(); $i++) {
                    $connection = $listener.AcceptTcpClient()
                    try {
                        $number = $listener.LocalEndpoint.Port
                        $remote = $connection.Client.RemoteEndPoint.Address.ToString()
                        Write-Host "TCP connection accepted on $number."
                        if ((Test-PublicIPv4 $remote) -and $remote -ne $wan -and $remote -ne $PublicIP) { $tcpSeen[$number] = $true }
                    }
                    finally { $connection.Dispose() }
                }
            }
            foreach ($tcpProbe in $tcpProbes) { Update-PortProbe $tcpProbe }
            $tcpApiConfirmed = $tcpProbes.Count -eq 2 -and @($tcpProbes | Where-Object { -not $_.Confirmed }).Count -eq 0
            if (-not $tcpConfirmed -and (($tcpSeen[$Port] -and $tcpSeen[$Port + 1]) -or $tcpApiConfirmed)) {
                $tcpConfirmed = $true
                Write-Host (Get-PreflightVerdict $true ([bool]($probe -and $probe.Received)) ([bool]($probe -and $probe.Confirmed))) -ForegroundColor Green
            }
            Receive-UdpProbe $udp $probe
            if ($probe) { Update-UdpProbe $probe }
            if (-not [Console]::IsInputRedirected -and [Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true).Key
                if ($key -eq 'Q') { break }
                if ($key -eq 'T') {
                    $tcpConfirmed = $true
                    Write-Host 'PASS: both TCP ports confirmed by you on 2ip.' -ForegroundColor Green
                    Write-Host (Get-PreflightVerdict $true ([bool]($probe -and $probe.Received)) ([bool]($probe -and $probe.Confirmed))) -ForegroundColor Green
                }
            }
            if ($tcpConfirmed -and $probe -and $probe.Confirmed) { break }
            Start-Sleep -Milliseconds 100
        }
    } catch { $checkError = $true; Write-Warning $_.Exception.Message }
    finally {
        Write-Host ''
        Write-Host '=== RESULT ===' -ForegroundColor Cyan
        Write-Host (Get-PreflightVerdict $tcpConfirmed ([bool]($probe -and $probe.Received)) ([bool]($probe -and $probe.Confirmed))) -ForegroundColor Cyan
        Write-Host 'This checks port reachability, not actual Voicecord audio quality or application firewall permissions.'
        if ($probe) { $probe.Client.Dispose() }
        foreach ($tcpProbe in $tcpProbes) { $tcpProbe.Client.Dispose() }
        foreach ($listener in $listeners) { $listener.Stop() }
        if ($udp) { $udp.Dispose() }
        foreach ($mapping in $mapped) {
            try { Remove-TestMapping $service $mapping.Port $localIP $tag $mapping.Protocol; Write-Host "Removed test $($mapping.Protocol) $($mapping.Port) forwarding." }
            catch {
                if ($_.Exception.Message -notmatch '^UPNP_714:') {
                    Write-Warning "Could not remove test mapping on $($mapping.Protocol) $($mapping.Port): $($_.Exception.Message). Finite test leases expire within 300 seconds of creation."
                }
            }
        }
        Write-Host 'Listeners closed. Any manual forwarding/firewall permissions must be removed manually.'
        if ($Application) {
            $state = 'unconfirmed'
            $udpConfirmed = [bool]($probe -and $probe.Confirmed)
            if ($tcpConfirmed -and $udpConfirmed) { $state = 'internet' }
            elseif ($checkError -or ($probe -and $probe.Error) -or @($tcpProbes | Where-Object { $_.Error }).Count -gt 0) { $state = 'error' }
            if ($cancelled) { $state = 'cancelled' }
            $tcpResults = @($Port, ($Port + 1)) | ForEach-Object {
                $testPort = $_
                [bool]($tcpConfirmed -or $tcpSeen[$testPort] -or @($tcpProbes | Where-Object { $_.Port -eq $testPort -and $_.Confirmed }).Count -gt 0)
            }
            Write-Output ('VOICECORD_PREFLIGHT_RESULT:' + (@{ state = $state; tcp = @($tcpResults); udp = $udpConfirmed } | ConvertTo-Json -Compress))
        }
    }
}

# Dot-sourcing exposes functions for synthetic tests without touching the router.
if ($MyInvocation.InvocationName -ne '.') { Start-SelfHostCheck }
