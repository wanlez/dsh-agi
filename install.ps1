# Install dsh-agi into a DeepSeek Harness profile.
# Writes the koffi allowBuilds setting first, then runs the plugin add command.
param(
    [string]$Version = '0.5.5',
    [string]$Profile = 'desktop',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path -LiteralPath $dsh)) {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd -ne $null) { $dsh = $cmd.Source }
}
if (-not (Test-Path -LiteralPath $dsh)) {
    throw 'dsh CLI not found. Pass the path to dsh.cmd or run this from a machine with DeepSeek Harness installed.'
}

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile not found: $profileDir"
}

$workspace = Join-Path $profileDir 'pnpm-workspace.yaml'
$allow = "allowBuilds:`n  koffi: false`n"

if (Test-Path -LiteralPath $workspace) {
    $text = Get-Content -LiteralPath $workspace -Raw
    if ($text -match '(?m)^allowBuilds:') {
        if ($text -notmatch '(?m)^\s+koffi:') {
            $text = [regex]::Replace($text, '(?m)^(allowBuilds:)\s*$', "`$1`n  koffi: false", 1)
            if (-not $DryRun) { Set-Content -LiteralPath $workspace -Value $text -Encoding UTF8 }
            Write-Host "added koffi to allowBuilds in $workspace"
        } else {
            Write-Host "allowBuilds already mentions koffi in $workspace"
        }
    } else {
        if (-not $DryRun) { Add-Content -LiteralPath $workspace -Value "`n$allow" -Encoding UTF8 }
        Write-Host "appended allowBuilds to $workspace"
    }
} else {
    if (-not $DryRun) { Set-Content -LiteralPath $workspace -Value $allow -Encoding UTF8 }
    Write-Host "created $workspace"
}

$url = "https://github.com/wanlez/dsh-agi/releases/download/plugin-v$Version/dsh-agi-$Version.tgz"
Write-Host "installing $url"

if ($DryRun) {
    Write-Host 'dry run: skipping dsh plugin add'
    exit 0
}

& $dsh plugin --profile $Profile add $url
$code = $LASTEXITCODE

$installed = Join-Path $profileDir 'node_modules\dsh-agi\package.json'
if ($code -ne 0) {
    if (Test-Path -LiteralPath $installed) {
        Write-Warning "dsh plugin add exited with $code, but dsh-agi is present. This is usually the koffi build-script gate; the package still works."
    } else {
        throw "dsh plugin add exited with $code and dsh-agi was not installed."
    }
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. Add `"dsh-agi`" to dsh.profile.bundles in $profileDir\package.json"
Write-Host '  2. Restart DeepSeek Harness'
