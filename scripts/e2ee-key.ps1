param([string]$Invitation)

# Run on a trusted participant's computer, not on the relay VPS.
$ErrorActionPreference = 'Stop'

try {
    $uri = $null
    if ($Invitation -and (-not [Uri]::TryCreate($Invitation, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'voicecord')) {
        throw 'Expected a voicecord:// invitation from the VPS.'
    }

    $keyBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
    $key = [BitConverter]::ToString($keyBytes).Replace('-', '').ToLowerInvariant()

    $sha = [Security.Cryptography.SHA256]::Create()
    try { $keyId = [BitConverter]::ToString($sha.ComputeHash($keyBytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }

    $invitationWithKey = $null
    if ($Invitation) {
        $parts = $Invitation -split '#', 2
        $fields = @()
        if ($parts.Count -eq 2 -and $parts[1]) {
            $fields = @($parts[1] -split '&' | Where-Object {
                $name = ($_ -split '=', 2)[0]
                [Uri]::UnescapeDataString($name.Replace('+', ' ')) -cne 'e2ee'
            })
        }
        $fields += "e2ee=$key"
        $invitationWithKey = $parts[0] + '#' + ($fields -join '&')
    }

    Write-Output "Client key (SECRET): $key"
    Write-Output 'VOICECORD_E2EE=true'
    Write-Output "VOICECORD_E2EE_KEY_ID=$keyId"
    if ($invitationWithKey) { Write-Output "Invitation with key (SECRET): $invitationWithKey" }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
