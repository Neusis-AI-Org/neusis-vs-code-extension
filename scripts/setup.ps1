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

# ── UI Helpers ───────────────────────────────────────────────────────────────

$Script:StepNumber = 0

function Write-Banner {
    Write-Host ""
    Write-Host "  ███╗   ██╗███████╗██╗   ██╗███████╗██╗███████╗" -ForegroundColor Cyan
    Write-Host "  ████╗  ██║██╔════╝██║   ██║██╔════╝██║██╔════╝" -ForegroundColor Cyan
    Write-Host "  ██╔██╗ ██║█████╗  ██║   ██║███████╗██║███████╗" -ForegroundColor Cyan
    Write-Host "  ██║╚██╗██║██╔══╝  ██║   ██║╚════██║██║╚════██║" -ForegroundColor Cyan
    Write-Host "  ██║ ╚████║███████╗╚██████╔╝███████║██║███████║" -ForegroundColor Cyan
    Write-Host "  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚══════╝╚═╝╚══════╝" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  C O D E   S E T U P" -ForegroundColor White
    Write-Host "  ─────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Step {
    param([string]$Label)
    $Script:StepNumber++
    Write-Host "  [" -ForegroundColor DarkGray -NoNewline
    Write-Host "$($Script:StepNumber)" -ForegroundColor White -NoNewline
    Write-Host "] " -ForegroundColor DarkGray -NoNewline
    Write-Host "$Label" -ForegroundColor White -NoNewline
}

function Write-Status {
    param(
        [string]$Text,
        [string]$Type = 'success'  # success | warn | fail | info | skip
    )
    $colorMap = @{
        success = 'Green'
        warn    = 'Yellow'
        fail    = 'Red'
        info    = 'Cyan'
        skip    = 'DarkGray'
    }
    $symMap = @{
        success = [char]0x2713   # ✓
        warn    = '!'
        fail    = [char]0x2717   # ✗
        info    = [char]0x2192   # →
        skip    = [char]0x2013   # –
    }
    $color = $colorMap[$Type]
    $sym   = $symMap[$Type]
    Write-Host "  $sym $Text" -ForegroundColor $color
}

function Write-Detail {
    param([string]$Text)
    Write-Host "      $Text" -ForegroundColor DarkGray
}

function Write-SectionDivider {
    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────────" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Fatal {
    param([string]$Message)
    Write-Host ""
    Write-Host "  $([char]0x2717) ERROR: $Message" -ForegroundColor Red
    Write-Host ""
    exit 1
}

function Write-Completion {
    Write-SectionDivider
    Write-Host "  $([char]0x2713) Setup complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host ""
    Write-Host "  Install the extension:" -ForegroundColor DarkGray
    Write-Host "    code --install-extension neusis-code-x.x.x.vsix" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Or drag-and-drop the .vsix into the VS Code Extensions panel." -ForegroundColor DarkGray
    Write-Host ""
}

# ── Validate environment ────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Write-Fatal "USERPROFILE environment variable is not set."
}

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Banner

# ── Detect arch ──────────────────────────────────────────────────────────────
$archTag = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Write-Fatal "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
}

# Asset names from https://github.com/anomalyco/opencode/releases
$archiveName  = "opencode-windows-${archTag}.zip"
$downloadUrl  = "https://github.com/anomalyco/opencode/releases/latest/download/${archiveName}"
$localArchive = Join-Path $PSScriptRoot $archiveName

# ── Install engine binary ────────────────────────────────────────────────────

Write-Step "Engine Binary"

if (Test-Path $BinaryPath) {
    Write-Status "Already installed" -Type skip
    Write-Detail $BinaryPath
} elseif (Test-Path $localArchive) {
    Write-Host ""  # newline after step header
    Write-Detail "Source: local archive"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -Path $localArchive -DestinationPath $InstallDir -Force
    $extracted = Get-ChildItem -Path $InstallDir -Recurse -Filter 'opencode.exe' | Select-Object -First 1
    if ($extracted -and $extracted.FullName -ne $BinaryPath) {
        Move-Item -Path $extracted.FullName -Destination $BinaryPath -Force
    }
    Write-Status "Installed from local archive" -Type success
    Write-Detail $BinaryPath
} else {
    Write-Host ""  # newline after step header
    Write-Detail "Downloading from GitHub..."
    $tmpArchive = Join-Path $env:TEMP "opencode-setup-$([System.IO.Path]::GetRandomFileName()).zip"
    try {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpArchive -UseBasicParsing
        Expand-Archive -Path $tmpArchive -DestinationPath $InstallDir -Force
        $extracted = Get-ChildItem -Path $InstallDir -Recurse -Filter 'opencode.exe' | Select-Object -First 1
        if ($extracted -and $extracted.FullName -ne $BinaryPath) {
            Move-Item -Path $extracted.FullName -Destination $BinaryPath -Force
        }
        Write-Status "Downloaded and installed" -Type success
        Write-Detail $BinaryPath
    } catch {
        Write-Status "Download failed" -Type fail
        Write-Host ""
        Write-Detail "For offline installs, place $archiveName"
        Write-Detail "next to this script and run again."
        Write-Host ""
        exit 1
    } finally {
        Remove-Item -Path $tmpArchive -ErrorAction SilentlyContinue
    }
}

# ── Migrate old config if present ────────────────────────────────────────────
$OldConfigPath = Join-Path $env:USERPROFILE '.opencode\opencode.json'
if ((Test-Path $OldConfigPath) -and -not (Test-Path $ConfigPath)) {
    Write-Step "Configuration"
    Write-Host ""  # newline after step header
    Write-Detail "Migrating from legacy location..."
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    Copy-Item -Path $OldConfigPath -Destination $ConfigPath -Force
    Write-Status "Configuration migrated" -Type success
    Write-Detail $ConfigPath
    Write-Completion
    exit 0
}

# ── Prompt for API key ───────────────────────────────────────────────────────
Write-SectionDivider

Write-Host "  Authentication" -ForegroundColor White
Write-Host ""
Write-Host "  API Key " -ForegroundColor DarkGray -NoNewline
Write-Host "$([char]0x25B8) " -ForegroundColor Cyan -NoNewline
$apiKey = (Read-Host).Trim()

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Fatal "API key cannot be empty."
}

Write-Host ""

# ── Fetch available models ────────────────────────────────────────────────────
Write-Step "Models"
Write-Host ""  # newline after step header
Write-Detail "Fetching available models..."

function ConvertTo-DisplayName {
    param([string]$ModelId)
    $name = $ModelId -replace '[-_/]', ' ' -replace '\s+', ' '
    return (Get-Culture).TextInfo.ToTitleCase($name.ToLower())
}

$modelsLines  = @()
$fetchFailed  = $false

try {
    $headers   = @{ 'accept' = 'application/json'; 'x-litellm-api-key' = $apiKey }

    # Fetch context/output limits from model/info
    $limitsMap = @{}
    try {
        $infoResp = Invoke-RestMethod -Uri "$BaseURL/model/info" -Headers $headers -UseBasicParsing
        foreach ($entry in $infoResp.data) {
            $ctx = $entry.model_info.max_input_tokens
            $out = $entry.model_info.max_output_tokens
            if ($ctx -and $out) {
                $limitsMap[$entry.model_name] = @{ context = $ctx; output = $out }
            }
        }
    } catch {
        # limits unavailable, skip
    }

    $modelsUri = "$BaseURL/models?return_wildcard_routes=false&include_model_access_groups=false&only_model_access_groups=false&include_metadata=false"
    $resp = Invoke-RestMethod -Uri $modelsUri -Headers $headers -UseBasicParsing
    foreach ($model in $resp.data) {
        $id     = $model.id
        $name   = ConvertTo-DisplayName $id
        $limits = $limitsMap[$id]
        if ($limits) {
            $modelsLines += "        `"$id`": {`n          `"name`": `"$name`",`n          `"limit`": {`n            `"context`": $($limits.context),`n            `"output`": $($limits.output)`n          }`n        }"
        } else {
            $modelsLines += "        `"$id`": {`n          `"name`": `"$name`"`n        }"
        }
    }
    if ($modelsLines.Count -gt 0) {
        Write-Status "$($modelsLines.Count) models loaded" -Type success
    } else {
        $fetchFailed = $true
    }
} catch {
    $fetchFailed = $true
}

if ($fetchFailed) {
    Write-Status "Using default model list" -Type warn
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
Write-Step "Configuration"
Write-Host ""  # newline after step header

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
Write-Status "Configuration saved" -Type success
Write-Detail $ConfigPath

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Completion
