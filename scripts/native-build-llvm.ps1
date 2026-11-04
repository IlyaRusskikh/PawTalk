param(
    [Parameter(Mandatory=$true)][string]$CompilerRoot,
    [Parameter(Mandatory=$true)][string]$NodeHeaders,
    [Parameter(Mandatory=$true)][string]$NodeImportLibrary
)
# Optional portable llvm-mingw build; standard npm run native:build uses MSVC.
$ErrorActionPreference = 'Stop'
$voiceRoot = Split-Path -Parent $PSScriptRoot
Push-Location $voiceRoot
try {
    New-Item -ItemType Directory -Force 'native/build/Release' | Out-Null
    & (Join-Path $CompilerRoot 'bin/clang++.exe') -std=c++17 -shared -static `
        -DNAPI_CPP_EXCEPTIONS -DNOMINMAX -DWIN32_LEAN_AND_MEAN -D_WIN32_WINNT=0x0A00 `
        -I 'node_modules/node-addon-api' -I $NodeHeaders `
        'native/voicecord.cc' $NodeImportLibrary '-Wl,--delayload,node.exe' `
        -lole32 -luuid -luser32 -o 'native/build/Release/voicecord.node'
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
} finally { Pop-Location }
