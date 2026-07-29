<#
.SYNOPSIS
  Package MTAdev Action Recorder for distribution.
  Creates a ZIP that can be shared across computers.
#>

$root   = Split-Path -Parent $PSCommandPath
$name   = "MTAdev-Action-Recorder"
$ver    = "1.0.0"
$output = Join-Path $root "dist"

# Clean & create output
if (Test-Path $output) { Remove-Item -Recurse -Force $output }
New-Item -ItemType Directory -Path $output -Force | Out-Null

# Files to include
$include = @(
    "install_ext.ps1",
    "manifest.json",
    "popup.html",
    "popup.css",
    "popup.js",
    "content_recorder.js",
    "bg_service_worker.js",
    "icons\icon16.png",
    "icons\icon48.png",
    "icons\icon128.png"
)

# Create a staging folder for clean ZIP
$stage = Join-Path $output "MTAdev-Action-Recorder-v1"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($f in $include) {
    $src  = Join-Path $root $f
    $dest = Join-Path $stage $f
    $dir  = Split-Path -Parent $dest
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Copy-Item -Path $src -Destination $dest
}

# Create ZIP
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = Join-Path $output "${name}-v${ver}.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath)

# Clean up staging
Remove-Item -Recurse -Force $stage

Write-Output "`n=============================="
Write-Output "Package created!"
Write-Output "=============================="
Write-Output "ZIP:  $zipPath"
Write-Output ""
Write-Output "To install on any computer:"
Write-Output "  1. Unzip the file"
Write-Output "  2. Open chrome://extensions"
Write-Output "  3. Enable 'Developer mode'"
Write-Output "  4. Click 'Load unpacked'"
Write-Output "  5. Select the unzipped folder"
Write-Output "=============================="
