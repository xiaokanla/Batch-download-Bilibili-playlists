[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pluginRoot = Join-Path $root "eagle_plugin_tag_graph"
$manifestPath = Join-Path $pluginRoot "manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Plugin manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$pluginVersion = if ($Version) { $Version } else { [string]$manifest.version }
if ($pluginVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Plugin version must use X.Y.Z format."
}
if ([string]$manifest.version -ne $pluginVersion) {
    throw "Version mismatch: manifest.json is $($manifest.version), requested $pluginVersion."
}

$assetStem = "BiliDownloader-TagGraph-v$pluginVersion"
$releaseRoot = Join-Path $root "release\$assetStem"
$packagePath = Join-Path $releaseRoot "$assetStem.eagleplugin"

if (Test-Path -LiteralPath $releaseRoot) {
    throw "Plugin output already exists: $releaseRoot`nUse a new version or remove this specific generated directory first."
}

New-Item -ItemType Directory -Path $releaseRoot | Out-Null

$files = Get-ChildItem -LiteralPath $pluginRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/](node_modules|\.git|__pycache__)[\\/]'
}
Compress-Archive -LiteralPath $files.FullName -DestinationPath $packagePath -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    if (-not ($archive.Entries.FullName -contains "manifest.json")) {
        throw "Plugin archive is missing manifest.json."
    }
}
finally {
    $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashPath = Join-Path $releaseRoot "$assetStem.sha256"
Set-Content -LiteralPath $hashPath -Value "$hash  $assetStem.eagleplugin" -Encoding ascii

Write-Host "Eagle plugin package ready:"
Write-Host "  $packagePath"
Write-Host "  $hashPath"
