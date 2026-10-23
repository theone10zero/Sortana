<#
.SYNOPSIS
  Bullet-proof packager: uses .NET ZipFile to preserve folders.

.DESCRIPTION
  • Reads version from manifest.json (no comments allowed)  
  • Gathers all files under the project (excludes .sln, .ps1, release/, .vs/, .git/)  
  • Creates a .zip with each entry’s name set to its relative path  
  • Renames .zip → .xpi  
#>

# 1) Locate
$ScriptDir  = Split-Path $MyInvocation.MyCommand.Path
$ReleaseDir = Join-Path $ScriptDir 'release'
$Manifest   = Join-Path $ScriptDir 'manifest.json'

# 2) Prep release folder
if (-not (Test-Path $ReleaseDir)) {
  New-Item -ItemType Directory -Path $ReleaseDir | Out-Null
}

# 3) Read manifest.json (must be pure JSON)
$version = (Get-Content $Manifest -Raw | ConvertFrom-Json).version
if (-not $version) {
  Write-Error "No version found in manifest.json"; exit 1
}

# 4) Define output names & clean up
$xpiName = "sortana-$version.xpi"
$zipPath = Join-Path $ReleaseDir "ai-filter-$version.zip"
$xpiPath = Join-Path $ReleaseDir $xpiName

Remove-Item -Path $zipPath,$xpiPath -Force -ErrorAction SilentlyContinue

# 5) Collect files to include
$allFiles = Get-ChildItem -Path $ScriptDir -Recurse -File |
  Where-Object {
    $_.Extension -notin '.sln','.ps1' -and
    $_.Name -ne 'build-xpi.mjs' -and
    $_.FullName -notmatch '\\release\\' -and
    $_.FullName -notmatch '\\.vs\\'     -and
    $_.FullName -notmatch '\\.git\\'    -and
    $_.FullName -notmatch '\\.claude\\'
  }

foreach ($file in $allFiles) {
  $size = (Get-Item $file.FullName).Length
  Write-Host "Zipping: $entryName ← $($file.FullName) ($size bytes)"
}

if ($allFiles.Count -eq 0) {
  Write-Warning "No files found to package."; exit 0
}

# 6) Load .NET ZipFile
Add-Type -AssemblyName System.IO.Compression.FileSystem

# 7) Create zip and add each file with its relative path
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
foreach ($file in $allFiles) {
  # Compute entry name (relative, forward-slashed)
  $rel = $file.FullName.Substring($ScriptDir.Length + 1).TrimStart('\')
  $entryName = $rel.Replace('\', '/')

  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip,
    $file.FullName,
    $entryName,
    [System.IO.Compression.CompressionLevel]::Optimal
  )
}
$zip.Dispose()

# 8) Rename zip → xpi
Rename-Item -Path $zipPath -NewName $xpiName -Force

Write-Host "✅ Built XPI at: $xpiPath"
