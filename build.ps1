[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [ValidateSet('auto', 'msvc', 'llvm')][string]$NativeToolchain = 'auto',
    [string]$CompilerRoot = $env:VOICECORD_LLVM_ROOT,
    [string]$NodeHeaders = $env:VOICECORD_NODE_HEADERS,
    [string]$NodeImportLibrary = $env:VOICECORD_NODE_LIB
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-BuildStep {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Build stopped: $Program $($Arguments -join ' ') (exit $LASTEXITCODE)"
    }
}

$transcriptStarted = $false
$buildLog = Join-Path $PSScriptRoot 'build-transcript.log'
$savedPath = $env:Path
Push-Location $PSScriptRoot
try {
    Start-Transcript -LiteralPath $buildLog -Force | Out-Null
    $transcriptStarted = $true
    if ($env:OS -ne 'Windows_NT') { throw 'The installer must be built on Windows x64.' }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $node = $nodeCommand.Source
    } else {
        $nodeCandidates = @(
            (Join-Path $env:ProgramFiles 'nodejs/node.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs/nodejs/node.exe'),
            (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
        )
        $node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (!$node) { throw 'Node.js was not found. Install Node.js x64 with npm, then run the build again.' }
    }
    $runtime = & $node -p 'JSON.stringify({version:process.versions.node,arch:process.arch})' | ConvertFrom-Json
    if ([version]$runtime.version -lt [version]'24.22.1' -or $runtime.arch -ne 'x64') {
        throw 'Install Node.js 24.22.1 or newer (x64), then run the build again.'
    }

    $tools = Join-Path $env:TEMP 'voicecord-tools'
    # npm can be installed alongside Node even when neither is in the user's PATH.
    $env:Path = "$(Split-Path -Parent $node);$savedPath"
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) {
        $npm = $npmCommand.Source
    } elseif (Test-Path -LiteralPath (Join-Path $tools 'package/npm.cmd')) {
        # Reuse the portable tools from this development machine, if present.
        $npm = Join-Path $tools 'package/npm.cmd'
    } else {
        throw 'npm.cmd was not found. Install Node.js with npm and reopen the terminal.'
    }
    $env:Path = "$(Split-Path -Parent $node);$(Split-Path -Parent $npm);$savedPath"
    Write-Host "Node.js $($runtime.version): $node"
    Write-Host "npm: $npm"

    if ($InstallDependencies -or !(Test-Path -LiteralPath 'node_modules/electron-builder/cli.js')) {
        Invoke-BuildStep $npm @('ci')
    }

    # Prefer explicitly supplied LLVM paths; otherwise reuse the existing local
    # portable toolchain. Other machines use the standard MSVC/node-gyp build.
    if ($NativeToolchain -eq 'auto' -and !$CompilerRoot) {
        $cachedCompiler = Join-Path $tools 'llvm/llvm-mingw-20261020-ucrt-x86_64'
        if (Test-Path -LiteralPath (Join-Path $cachedCompiler 'bin/clang++.exe')) {
            $CompilerRoot = $cachedCompiler
        }
    }
    if ($NativeToolchain -eq 'llvm' -or ($NativeToolchain -eq 'auto' -and $CompilerRoot)) {
        if (!$NodeHeaders) { $NodeHeaders = Join-Path $tools "node-v$($runtime.version)/include/node" }
        if (!$NodeImportLibrary) { $NodeImportLibrary = Join-Path $tools 'node.lib' }
        if (!$CompilerRoot) { throw 'LLVM requires -CompilerRoot (or VOICECORD_LLVM_ROOT).' }
        foreach ($required in @((Join-Path $CompilerRoot 'bin/clang++.exe'), (Join-Path $NodeHeaders 'node_api.h'), $NodeImportLibrary)) {
            if (!(Test-Path -LiteralPath $required)) { throw "Missing native build input: $required" }
        }
        & ./scripts/native-build-llvm.ps1 -CompilerRoot $CompilerRoot -NodeHeaders $NodeHeaders -NodeImportLibrary $NodeImportLibrary
    } else {
        Invoke-BuildStep $npm @('run', 'native:build')
    }

    Invoke-BuildStep $node @('scripts/native-smoke.cjs')
    Invoke-BuildStep $node @('scripts/prepare-server.mjs')
    Invoke-BuildStep $node @('scripts/generate-icons.cjs')
    Invoke-BuildStep $npm @('run', 'build')
    Invoke-BuildStep $npm @('test')
    Invoke-BuildStep $node @('scripts/ui-flow-smoke.mjs', '--built')
    # Never publish from a local build, even if CI publishing credentials exist.
    Invoke-BuildStep $node @('node_modules/electron-builder/cli.js', '--win', 'nsis', '--x64', '--publish', 'never')

    $package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
    $installer = Join-Path $PSScriptRoot "release/Voicecord Setup $($package.version).exe"
    if (!(Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }
    Write-Host "`nInstaller ready: $installer" -ForegroundColor Green
} finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
    $env:Path = $savedPath
    Pop-Location
}
