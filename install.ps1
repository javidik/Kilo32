# Kilo32 installer: verify SHA-256, unpack, run embedded installer.
# This script is intentionally English-only so it works under any locale
# (PowerShell 5.1 default encoding is ANSI/Windows-1251, which breaks
# UTF-8 Cyrillic in scripts that don't start with a UTF-8 BOM).

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$dist = Join-Path $root 'kilo-cli-x86\dist'
$archive = Join-Path $dist 'Kilo-CLI-7.8.17-win32-ia32-TUI-Tor.zip'
$sumFile = Join-Path $dist 'SHA256SUM'

if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Build archive not found: $archive"
}
if (-not (Test-Path -LiteralPath $sumFile -PathType Leaf)) {
    throw "SHA256SUM file not found: $sumFile"
}

$expected = (Get-Content -LiteralPath $sumFile -Raw).Trim().ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') {
    throw "Invalid SHA256SUM content: $expected"
}
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    throw "SHA-256 mismatch. Expected $expected, got $actual."
}

Write-Host "SHA-256 verified: $actual"
Write-Host "Unpacking build archive..."

$temp = Join-Path $env:TEMP ('Kilo32-Install-' + [guid]::NewGuid().ToString('N'))
try {
    [IO.Directory]::CreateDirectory($temp) | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force

    $embedded = Join-Path $temp 'install.ps1'
    if (-not (Test-Path -LiteralPath $embedded -PathType Leaf)) {
        throw "Embedded installer not found in archive: install.ps1"
    }
    Write-Host "Running embedded installer..."
    & $embedded
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Embedded installer exited with code $LASTEXITCODE."
    }
} finally {
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
