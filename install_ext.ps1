<#
.SYNOPSIS
  Install MTAdev Action Recorder into Chrome on this computer.
  Run this from the unzipped extension folder.
#>

$scriptDir = Split-Path -Parent $PSCommandPath
$manifest  = Join-Path $scriptDir "manifest.json"

if (-not (Test-Path $manifest)) {
    Write-Output "ERROR: manifest.json not found in $scriptDir"
    Write-Output "Make sure you run this from the unzipped extension folder."
    exit 1
}

Write-Output "MTAdev Action Recorder - Installer"
Write-Output "=================================="
Write-Output ""

# Detect Chrome
$chromePaths = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)

$chrome = $null
foreach ($p in $chromePaths) {
    if (Test-Path $p) { $chrome = $p; break }
}

Write-Output "Extension path: $scriptDir"

if (-not $chrome) {
    Write-Output "Chrome not found at default locations."
    Write-Output ""
    Write-Output "Manual install:"
    Write-Output "  1. Open Chrome and go to: chrome://extensions"
    Write-Output "  2. Enable 'Developer mode' (top-right)"
    Write-Output "  3. Click 'Load unpacked'"
    Write-Output "  4. Select this folder:"
    Write-Output "     $scriptDir"
    exit 0
}

Write-Output "Chrome found at: $chrome"
Write-Output ""
Write-Output "This script will:"
Write-Output "  1. Copy extension to a stable location"
Write-Output "  2. Create a desktop shortcut to launch Chrome with the extension"
Write-Output ""

$choice = Read-Host "Continue? (Y/N)"
if ($choice -ne "Y" -and $choice -ne "y") {
    Write-Output "Install cancelled."
    exit 0
}

# Copy to a stable location
$targetDir = Join-Path $env:LOCALAPPDATA "MTAdev-Action-Recorder"
if (Test-Path $targetDir) {
    Remove-Item -Recurse -Force $targetDir
}
Write-Output "Copying extension to: $targetDir"
Copy-Item -Recurse -Path $scriptDir -Destination $targetDir

# Create a desktop shortcut
$desktop  = [Environment]::GetFolderPath("Desktop")
$shortcut = Join-Path $desktop "MTAdev Recorder (Chrome).lnk"

$shell = New-Object -ComObject WScript.Shell
$link  = $shell.CreateShortcut($shortcut)
$link.TargetPath = $chrome
$link.Arguments = "--load-extension=`"$targetDir`" --new-window chrome://extensions"
$link.Description = "Launch Chrome with MTAdev Action Recorder loaded"
$link.Save()

Write-Output ""
Write-Output "=============================="
Write-Output "Install complete!"
Write-Output "=============================="
Write-Output ""
Write-Output "Extension installed at: $targetDir"
Write-Output "Desktop shortcut created: $shortcut"
Write-Output ""
Write-Output "Next time, use the shortcut to open Chrome with the recorder."
Write-Output "Or manually load the extension via chrome://extensions -> Load unpacked"
Write-Output ""
Write-Output "Note: If Chrome is already running, close it first,"
Write-Output "then use the desktop shortcut."
