#Requires -Version 5.0
<#
.SYNOPSIS
    Neusis Code Setup — installs the engine and configures the provider.
.DESCRIPTION
    Downloads the Neusis Code engine binary and writes the provider
    configuration file. Run once per machine before installing the extension.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir  = Join-Path $env:USERPROFILE '.opencode\bin'
$BinaryPath  = Join-Path $InstallDir 'opencode.exe'
$ConfigDir   = Join-Path $env:USERPROFILE '.opencode'
$ConfigPath  = Join-Path $ConfigDir 'opencode.json'
$BaseURL     = 'https://litellm-proxy-1074011666170.us-central1.run.app/v1'

# ── Validate environment ──────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Write-Host "Error: USERPROFILE environment variable is not set." -ForegroundColor Red
    exit 1
}

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Neusis Code Setup" -ForegroundColor White
Write-Host ("─" * 40)
Write-Host ""

# ── Detect arch ──────────────────────────────────────────────────────────────
$archTag = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default {
        Write-Host "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" -ForegroundColor Red
        exit 1
    }
}

$assetName   = "opencode-win32-${archTag}.exe"
$downloadUrl = "https://github.com/sst/opencode/releases/latest/download/${assetName}"

# ── Install engine binary ────────────────────────────────────────────────────
# Check if a local copy of the binary was placed next to this script (offline install)
$LocalBinary = Join-Path $PSScriptRoot 'opencode.exe'

if (Test-Path $BinaryPath) {
    Write-Host ("Neusis Code engine already installed...".PadRight(42)) -NoNewline
    Write-Host "skipped" -ForegroundColor Green
} elseif (Test-Path $LocalBinary) {
    Write-Host ("Installing Neusis Code engine (local)...".PadRight(42)) -NoNewline
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Copy-Item -Path $LocalBinary -Destination $BinaryPath
    Write-Host "done" -ForegroundColor Green
} else {
    Write-Host ("Downloading Neusis Code engine...".PadRight(42)) -NoNewline
    try {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Invoke-WebRequest -Uri $downloadUrl -OutFile $BinaryPath -UseBasicParsing
        Write-Host "done" -ForegroundColor Green
    } catch {
        Write-Host "failed" -ForegroundColor Red
        Write-Host "Could not download the Neusis Code engine."
        Write-Host "For offline installs: place opencode.exe next to this script and run again."
        exit 1
    }
}

# ── Prompt for API key ───────────────────────────────────────────────────────
Write-Host ""
$apiKey = (Read-Host "Enter your Neusis Code API key").Trim()

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "API key cannot be empty." -ForegroundColor Red
    exit 1
}

# ── Write configuration ──────────────────────────────────────────────────────
Write-Host ("Writing configuration...".PadRight(42)) -NoNewline

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

$config = @"
{
  "`$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Neusis Code",
      "options": {
        "baseURL": "$BaseURL",
        "apiKey": "$apiKey"
      },
      "models": {
        "gemini-flash-lite-latest": {
          "name": "gemini-flash-lite-latest",
          "maxTokens": "200000"
        }
      }
    }
  },
  "disabled_providers": ["opencode"]
}
"@

[System.IO.File]::WriteAllText($ConfigPath, $config, [System.Text.Encoding]::UTF8)
Write-Host "done" -ForegroundColor Green

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Setup complete!" -ForegroundColor White
Write-Host ""
Write-Host "Install the Neusis Code extension with:"
Write-Host ""
Write-Host "  code --install-extension neusis-code-x.x.x.vsix"
Write-Host ""
Write-Host "Or drag-and-drop the .vsix file into VS Code's Extensions panel."
Write-Host ""
