param([string]$Invitation)

# Run on a trusted participant's computer, not on the relay VPS.
$ErrorActionPreference = 'Stop'
# Keep Cyrillic output readable when invoked through CMD or captured by tooling.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $uri = $null
    if ($Invitation -and (-not [Uri]::TryCreate($Invitation, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'pawtalk')) {
        throw 'Expected a pawtalk:// invitation from the VPS.'
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

    Write-Output "Секретный ключ (не публикуйте; только для участников комнаты): $key"
    Write-Output "Публичный отпечаток (SHA-256 key ID, для сервера): $keyId"
    if ($invitationWithKey) { Write-Output "Invitation with key (SECRET): $invitationWithKey" }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
