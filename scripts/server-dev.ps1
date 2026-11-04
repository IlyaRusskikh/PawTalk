$ErrorActionPreference = 'Stop'
$voiceRoot = Split-Path -Parent $PSScriptRoot
$voiceEnvFile = Join-Path $voiceRoot 'deploy/generated/api.dev.env'
if (-not (Test-Path -LiteralPath $voiceEnvFile)) { throw 'Run npm run configure first' }
foreach ($voiceLine in Get-Content -LiteralPath $voiceEnvFile) {
    if ($voiceLine -match '^([A-Z_]+)=(.*)$') {
        $voiceValue = $Matches[2].Trim("'")
        [Environment]::SetEnvironmentVariable($Matches[1], $voiceValue, 'Process')
    }
}
Push-Location (Join-Path $voiceRoot 'server')
try { go run . } finally { Pop-Location }
