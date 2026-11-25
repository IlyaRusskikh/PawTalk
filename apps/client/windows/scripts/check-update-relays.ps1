[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Server,
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$')]
    [string] $Version = '0.15.2'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
if (-not ('PawTalkRelayProbe' -as [type])) {
    $references = @([System.Net.Http.HttpClient].Assembly.Location,
        [System.Net.Security.SslPolicyErrors].Assembly.Location,
        [System.Security.Cryptography.X509Certificates.X509Certificate2].Assembly.Location,
        [System.Security.Cryptography.SHA256].Assembly.Location) | Select-Object -Unique
    Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Net.Http;
using System.Security.Cryptography;

public static class PawTalkRelayProbe {
    public static HttpClient Create(string fingerprint, bool allowRedirects) {
        var handler = new HttpClientHandler { AllowAutoRedirect = allowRedirects, UseCookies = false };
        if (!String.IsNullOrEmpty(fingerprint)) {
            handler.ServerCertificateCustomValidationCallback = (request, certificate, chain, errors) => {
                if (certificate == null) return false;
                using (var sha256 = SHA256.Create()) {
                    var actual = BitConverter.ToString(sha256.ComputeHash(certificate.RawData)).Replace("-", "");
                    return String.Equals(actual, fingerprint, StringComparison.OrdinalIgnoreCase);
                }
            };
        }
        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15), MaxResponseContentBufferSize = 8 * 1024 * 1024 };
    }
}
'@
}

function Test-RelayRequest($Client, [string] $Label, [string] $Url, [string] $Kind) {
    $response = $null
    try {
        $response = $Client.GetAsync($Url).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if (-not $response.IsSuccessStatusCode) {
            Write-Output "$Label ${Kind}: HTTP $status"
            return
        }
        $data = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        if ($Kind -eq 'releases') {
            $release = @($data | Where-Object { $_.tag_name -eq "client-v$Version" -and -not $_.draft })
            if ($release.Count) { Write-Output "$Label ${Kind}: HTTP $status, client-v$Version listed" }
            else { Write-Output "$Label ${Kind}: HTTP $status, client-v$Version absent from first page" }
        } elseif ($Kind -eq 'manifest') {
            $manifest = $data.keyId -and $data.payload -and $data.signature
            if ($manifest) { Write-Output "$Label ${Kind}: HTTP $status, signed envelope present" }
            else { Write-Output "$Label ${Kind}: HTTP $status, invalid envelope" }
        } else {
            Write-Output "$Label ${Kind}: HTTP $status, API $($data.apiProtocolVersion)"
        }
    } catch {
        # Keep room addresses, certificate fingerprints and response bodies out of shared logs.
        $failure = $_.Exception.GetBaseException()
        Write-Output "$Label ${Kind}: $($failure.GetType().Name)"
    } finally {
        if ($response) { $response.Dispose() }
    }
}

$tag = "client-v$Version"
$repo = 'IlyaRusskikh/PawTalk'
$direct = [PawTalkRelayProbe]::Create('', $true)
try {
    $direct.DefaultRequestHeaders.UserAgent.ParseAdd('PawTalk')
    Test-RelayRequest $direct 'GitHub' "https://api.github.com/repos/$repo/releases?per_page=100&page=1" 'releases'
    Test-RelayRequest $direct 'GitHub' "https://github.com/$repo/releases/download/$tag/update-manifest.json" 'manifest'
} finally { $direct.Dispose() }

for ($index = 0; $index -lt $Server.Count; $index++) {
    $label = "Server $($index + 1)"
    $address = $Server[$index].Trim()
    if ($address.Contains('#')) {
        Write-Output "$label : use a saved server address without an invitation fragment"
        continue
    }
    if (-not $address.Contains('://')) { $address = "https://$address" }
    $uri = $null
    if (-not [uri]::TryCreate($address, [UriKind]::Absolute, [ref]$uri) -or -not $uri.Host -or $uri.UserInfo -or $uri.Query) {
        Write-Output "$label : invalid server address"
        continue
    }
    $pin = ''
    if ($uri.Scheme -eq 'pawtalk' -and $uri.Port -gt 0 -and $uri.AbsolutePath -cmatch '^/([a-f0-9]{64})(/v3)?$') {
        $pin = $Matches[1]
    } elseif ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/') {
        Write-Output "$label : invalid server address"
        continue
    }
    $base = "https://$($uri.Authority)"
    $client = [PawTalkRelayProbe]::Create($pin, $false)
    try {
        $client.DefaultRequestHeaders.UserAgent.ParseAdd('PawTalk')
        Test-RelayRequest $client $label "$base/api/config" 'config'
        Test-RelayRequest $client $label "$base/api/updates/releases?per_page=100&page=1" 'releases'
        Test-RelayRequest $client $label "$base/api/updates/assets/$tag/update-manifest.json" 'manifest'
    } finally { $client.Dispose() }
}
