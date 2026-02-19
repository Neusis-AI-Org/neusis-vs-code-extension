#Requires -Version 5.0
<#
.SYNOPSIS
    Neusis Code Setup — installs the engine and configures the provider.
.DESCRIPTION
    Downloads the Neusis Code engine binary and writes the provider
    configuration file. Run once per machine before installing the extension.
    For offline installs: place opencode-windows-x64.zip next to this script.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir  = Join-Path $env:USERPROFILE '.opencode\bin'
$BinaryPath  = Join-Path $InstallDir 'opencode.exe'
$ConfigDir   = Join-Path $env:USERPROFILE '.config\opencode'
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
Write-Host ("-" * 40)
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

# Asset names from https://github.com/anomalyco/opencode/releases
$archiveName = "opencode-windows-${archTag}.zip"
$downloadUrl = "https://github.com/anomalyco/opencode/releases/latest/download/${archiveName}"
$localArchive = Join-Path $PSScriptRoot $archiveName

# ── Install engine binary ────────────────────────────────────────────────────
# Priority: already installed → local archive next to script → download

if (Test-Path $BinaryPath) {
    Write-Host ("Neusis Code engine already installed...".PadRight(42)) -NoNewline
    Write-Host "skipped" -ForegroundColor Green
} elseif (Test-Path $localArchive) {
    Write-Host ("Installing Neusis Code engine (local)...".PadRight(42)) -NoNewline
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -Path $localArchive -DestinationPath $InstallDir -Force
    # The zip may extract into a subfolder — find the binary
    $extracted = Get-ChildItem -Path $InstallDir -Recurse -Filter 'opencode.exe' | Select-Object -First 1
    if ($extracted -and $extracted.FullName -ne $BinaryPath) {
        Move-Item -Path $extracted.FullName -Destination $BinaryPath -Force
    }
    Write-Host "done" -ForegroundColor Green
} else {
    Write-Host ("Downloading Neusis Code engine...".PadRight(42)) -NoNewline
    $tmpArchive = Join-Path $env:TEMP "opencode-setup-$([System.IO.Path]::GetRandomFileName()).zip"
    try {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpArchive -UseBasicParsing
        Expand-Archive -Path $tmpArchive -DestinationPath $InstallDir -Force
        # The zip may extract into a subfolder — find the binary
        $extracted = Get-ChildItem -Path $InstallDir -Recurse -Filter 'opencode.exe' | Select-Object -First 1
        if ($extracted -and $extracted.FullName -ne $BinaryPath) {
            Move-Item -Path $extracted.FullName -Destination $BinaryPath -Force
        }
        Write-Host "done" -ForegroundColor Green
    } catch {
        Write-Host "failed" -ForegroundColor Red
        Write-Host "Could not download the Neusis Code engine."
        Write-Host "For offline installs: place $archiveName next to this script and run again."
        exit 1
    } finally {
        Remove-Item -Path $tmpArchive -ErrorAction SilentlyContinue
    }
}

# ── Migrate old config if present ────────────────────────────────────────────
$OldConfigPath = Join-Path $env:USERPROFILE '.opencode\opencode.json'
if ((Test-Path $OldConfigPath) -and -not (Test-Path $ConfigPath)) {
    Write-Host ("Migrating existing configuration...".PadRight(42)) -NoNewline
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    Copy-Item -Path $OldConfigPath -Destination $ConfigPath -Force
    Write-Host "done" -ForegroundColor Green
    Write-Host ""
    Write-Host "Setup complete!" -ForegroundColor White
    Write-Host ""
    Write-Host "Install the Neusis Code extension with:"
    Write-Host ""
    Write-Host "  code --install-extension neusis-code-x.x.x.vsix"
    Write-Host ""
    Write-Host "Or drag-and-drop the .vsix file into VS Code's Extensions panel."
    Write-Host ""
    exit 0
}

# ── Prompt for API key ───────────────────────────────────────────────────────
Write-Host ""
$apiKey = (Read-Host "Enter your Neusis Code API key").Trim()

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "API key cannot be empty." -ForegroundColor Red
    exit 1
}

# ── Fetch available models ────────────────────────────────────────────────────
Write-Host ("Fetching available models...".PadRight(42)) -NoNewline

function ConvertTo-DisplayName {
    param([string]$ModelId)
    $name = $ModelId -replace '[-_/]', ' ' -replace '\s+', ' '
    return (Get-Culture).TextInfo.ToTitleCase($name.ToLower())
}

$modelsLines  = @()
$fetchFailed  = $false

try {
    $headers  = @{ 'accept' = 'application/json'; 'x-litellm-api-key' = $apiKey }
    $modelsUri = "$BaseURL/models?return_wildcard_routes=false&include_model_access_groups=false&only_model_access_groups=false&include_metadata=false"
    $resp = Invoke-RestMethod -Uri $modelsUri -Headers $headers -UseBasicParsing
    foreach ($model in $resp.data) {
        $id   = $model.id
        $name = ConvertTo-DisplayName $id
        $modelsLines += "        `"$id`": {`n          `"name`": `"$name`"`n        }"
    }
    if ($modelsLines.Count -gt 0) {
        Write-Host "done ($($modelsLines.Count) models)" -ForegroundColor Green
    } else {
        $fetchFailed = $true
    }
} catch {
    $fetchFailed = $true
}

if ($fetchFailed) {
    Write-Host "using defaults" -ForegroundColor Yellow
    $modelsLines = @(
        "        `"github_copilot/gpt-4`": {`n          `"name`": `"Github Copilot Gpt 4`"`n        }",
        "        `"github_copilot/gpt-5.1-codex`": {`n          `"name`": `"Github Copilot Gpt 5.1 Codex`"`n        }",
        "        `"gemini/gemini-pro-latest`": {`n          `"name`": `"Gemini Gemini Pro Latest`"`n        }",
        "        `"gemini-flash-latest`": {`n          `"name`": `"Gemini Flash Latest`"`n        }",
        "        `"gemini-flash-lite-latest`": {`n          `"name`": `"Gemini Flash Lite Latest`"`n        }"
    )
}

$modelsBlock = $modelsLines -join ",`n"

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
$modelsBlock
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
