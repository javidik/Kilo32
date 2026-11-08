$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$dist = Join-Path $root 'kilo-cli-x86\dist'
$archive = Join-Path $dist 'Kilo-CLI-7.8.17-win32-ia32-TUI-Tor.zip'
$sumFile = Join-Path $dist 'SHA256SUM'
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Не найден архив сборки: $archive" }
$expected = (Get-Content -LiteralPath $sumFile -Raw).Trim().ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') { throw 'Некорректный SHA256SUM.' }
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 не совпадает. Ожидался $expected, получен $actual" }
$temp = Join-Path $env:TEMP ('Kilo32-Tor-Install-' + [guid]::NewGuid().ToString('N'))
try {
  [IO.Directory]::CreateDirectory($temp) | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $temp
  $embedded = Join-Path $temp 'install.ps1'
  if (-not (Test-Path -LiteralPath $embedded -PathType Leaf)) { throw 'В архиве отсутствует встроенный установщик.' }
  & $embedded
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Встроенный установщик завершился с кодом $LASTEXITCODE." }
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
