[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string]$NotesFile,

    [switch]$Publish,

    [string]$Repository = "xiaokanla/Batch-download-Bilibili-playlists"
)

$ErrorActionPreference = "Stop"

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Test-ZipPrivacy {
    param([string]$ArchivePath)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $forbidden = @(
            'userdata',
            'last_login_cookie.json',
            'bili_netscape_temp.txt',
            'error_log.txt',
            'bili_downloader.db',
            'download_records.json',
            'history.json',
            'eagle_integration/exports'
        )
        $hits = @(
            $archive.Entries | Where-Object {
                $entry = $_.FullName.Replace('\', '/').TrimEnd('/')
                $forbidden | Where-Object {
                    $pattern = [regex]::Escape($_.Replace('\', '/'))
                    $entry -match "(^|/)$pattern($|/)"
                }
            }
        )
        if ($hits.Count) {
            $names = ($hits | Select-Object -ExpandProperty FullName) -join "`n"
            throw "Privacy validation failed. Forbidden entries found:`n$names"
        }
    }
    finally {
        $archive.Dispose()
    }
}

Require-Command python
Require-Command git
if ($Publish) {
    Require-Command gh
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$sourceVersion = [regex]::Match(
    (Get-Content (Join-Path $root "web_app.py") -Raw),
    'APP_VERSION\s*=\s*"(?<version>\d+\.\d+\.\d+)(?:-[^"]+)?"'
)
if (-not $sourceVersion.Success) {
    throw "Could not read APP_VERSION from web_app.py."
}
if ($sourceVersion.Groups["version"].Value -ne $Version) {
    throw "Version mismatch: web_app.py is $($sourceVersion.Groups["version"].Value), requested $Version."
}

foreach ($required in @("ffmpeg.exe", "aria2c.exe", "build_release.spec")) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $required))) {
        throw "Required release file is missing: $required"
    }
}

$assetStem = "BiliDownloaderStudio-v$Version-windows-x64"
$releaseRoot = Join-Path $root "release\$assetStem"
$buildDir = Join-Path $releaseRoot "build"
$distDir = Join-Path $releaseRoot "dist"
$appDir = Join-Path $distDir "BiliDownloaderStudio"
$zipPath = Join-Path $releaseRoot "$assetStem.zip"
$hashPath = Join-Path $releaseRoot "$assetStem.sha256"

if (Test-Path -LiteralPath $releaseRoot) {
    throw "Release output already exists: $releaseRoot`nUse a new version or remove this specific generated directory first."
}

New-Item -ItemType Directory -Path $buildDir, $distDir -Force | Out-Null

Write-Host "Building $assetStem ..."
& python -m PyInstaller --noconfirm --clean `
    --workpath $buildDir `
    --distpath $distDir `
    (Join-Path $root "build_release.spec")
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath (Join-Path $appDir "BiliDownloaderStudio.exe"))) {
    throw "Expected executable was not created."
}

Compress-Archive -LiteralPath $appDir -DestinationPath $zipPath -CompressionLevel Optimal
Test-ZipPrivacy -ArchivePath $zipPath

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $hashPath -Value "$hash  $assetStem.zip" -Encoding ascii

Write-Host ""
Write-Host "Release package ready:"
Write-Host "  $zipPath"
Write-Host "  $hashPath"
Write-Host "Privacy validation: passed"

if (-not $Publish) {
    return
}

if (-not $NotesFile) {
    throw "Publishing requires -NotesFile. Start from docs\RELEASE_NOTES_TEMPLATE.md."
}

$notesPath = if ([IO.Path]::IsPathRooted($NotesFile)) {
    [IO.Path]::GetFullPath($NotesFile)
}
else {
    [IO.Path]::GetFullPath((Join-Path $root $NotesFile))
}
if (-not (Test-Path -LiteralPath $notesPath)) {
    throw "Release notes file not found: $notesPath"
}

$dirty = git status --porcelain
if ($dirty) {
    throw "Commit or stash all source changes before publishing."
}

$tag = "v$Version"
$existingTag = git tag --list $tag
if (-not $existingTag) {
    & git tag -a $tag -m "BiliDownloader Studio $tag"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create tag $tag."
    }
}

& git push origin main --follow-tags
if ($LASTEXITCODE -ne 0) {
    throw "Failed to push main and tags."
}

& gh release create $tag $zipPath $hashPath `
    --repo $Repository `
    --title "BiliDownloader Studio $tag" `
    --notes-file $notesPath
if ($LASTEXITCODE -ne 0) {
    throw "GitHub Release creation failed."
}

Write-Host "Published GitHub Release: $tag"
